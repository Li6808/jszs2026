#!/usr/bin/env python3
"""
教师助手 · 图标生成器
=====================

把一张**方形母图**（AI 生成的三维图标、或自己画的图）一刀切成应用需要的整套图标。

为什么需要它
------------
AI 出的图通常不是「干净的图标文件」：四周有渐变背景、角落有阴影或水印、图的中心
是一块圆角方形图标。直接用会带上背景。本脚本做四件事：

1. **自动找到那块圆角方形的四条边**（逐行/逐列扫最外侧的第一个显著梯度，取中位数）
2. **裁成正方形**（长短边取大者，居中）—— 图标必须是正方形
3. **把四个角补平**（用同一行内侧的颜色往外抹），因为手机系统会自己再切圆角，
   留着原图的灰蓝背景会在圆角处露出脏边
4. **导出全套尺寸**（PWA 64/192/512、iOS 180、favicon 32、安卓 maskable 512）

用法
----
    PY=~/.workbuddy/binaries/python/envs/default/bin/python   # 需要 Pillow + numpy
    $PY tools/make-icons.py --src assets-src/icon-source.jpg --probe    # 只报检测到的边界
    $PY tools/make-icons.py --src assets-src/icon-source.jpg --out public

`--out` 会**覆盖** public/ 里同名文件（旧的会先备份到 public/.icon-backup/）。
发版后记得把 public/ 的图标同步到三个交付包（见技能文件里的「一次构建同步 4 处」）。
"""

from __future__ import annotations

import argparse
import math
import shutil
import sys
from pathlib import Path

try:
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:  # pragma: no cover
    sys.exit(
        "缺少依赖。请用隔离 venv 跑：\n"
        "  ~/.workbuddy/binaries/python/envs/default/bin/python tools/make-icons.py ...\n"
        "（没装的话：该 venv 的 pip install Pillow numpy）"
    )

# 输出清单：(文件名, 边长, 中心裁切比例)
#   比例 < 1 表示先裁掉四周再缩 —— 只给 32px 的 favicon 用：
#   三维渲染图缩到 32px 细节全糊，把中间的钟表和日历放大反而更认得出来。
SIZES = [
    ("pwa-icon-64.png", 64, 1.0),
    ("pwa-icon-192.png", 192, 1.0),
    ("pwa-icon-512.png", 512, 1.0),
    ("apple-touch-icon.png", 180, 1.0),   # iOS 主屏图标
    ("favicon-32.png", 32, 0.78),         # 浏览器页签（放大内容版）
]
MASKABLE = ("pwa-icon-maskable-512.png", 512)  # 安卓自适应图标（会被系统裁成圆形/水滴）
MASKABLE_SCALE = 0.86                          # 内容缩到 86%，让开安卓的裁切安全区
SHARPEN_BELOW = 64                             # 小于等于这个边长补一道轻微锐化


# ---------------------------------------------------------------- 1. 找边界

def _first_jump(vals, thresh):
    """从外往里的第一个亮度跳变（vals 的 index 0 必须是画布最外侧）。"""
    d = np.abs(np.diff(vals))
    for i in range(len(d)):
        if d[i] >= thresh:
            return i + 1
    return None


def _snap(vals, rough, thresh=12, window=34):
    """二次吸附：在粗估位置附近找**梯度最大**的那个点。

    为什么要两遍：AI 出的图在图标外面还有一层柔光，柔光会让「第一个跳变」
    晚 10px 左右出现（边缘被抹平了）。而真正的图标边缘是整段里最陡的地方，
    所以在 ±window 里取最大梯度能把边钉准。
    """
    lo = max(0, rough - window)
    hi = min(len(vals) - 1, rough + window)
    d = np.abs(np.diff(vals[lo:hi]))
    if d.size == 0 or d.max() < thresh:
        return rough
    return lo + int(np.argmax(d)) + 1


def detect_bbox(im: Image.Image, band=(0.30, 0.70), thresh=18, verbose=False):
    """扫出圆角方形图标的四条边。

    做法：在中心带（默认 30%~70% 的高度/宽度范围，避开圆角）逐行逐列地
    **从画布外侧往里扫**，先取第一个显著跳变做粗估，再在附近取最大梯度吸附。
    必须是「从外往里」：图标内部还有一圈蓝色描边，它的梯度比外边界还大，
    一上来就取全局最大梯度会误抓到那圈描边。
    """
    g = np.asarray(im.convert("L")).astype(np.int16)
    H, W = g.shape
    KX, KY = int(W * 0.45), int(H * 0.45)

    def scan_rows(reverse: bool):
        """每行给一段「从外往里」的一维亮度序列 + 它到绝对 x 的换算。"""
        out = []
        for y in range(int(H * band[0]), int(H * band[1]), 6):
            row = g[y]
            out.append(row[W - KX:][::-1] if reverse else row[:KX])
        return out

    def scan_cols(reverse: bool):
        out = []
        for x in range(int(W * band[0]), int(W * band[1]), 6):
            col = g[:, x]
            out.append(col[H - KY:][::-1] if reverse else col[:KY])
        return out

    def edge(samples, reverse: bool, limit: int):
        roughs = [i for i in (_first_jump(s, thresh) for s in samples) if i is not None]
        if not roughs:
            return None
        rough = int(np.median(roughs))
        snapped = [_snap(s, rough, window=34) for s in samples]
        idx = int(np.median(snapped))
        return (limit - 1 - idx) if reverse else idx

    left = edge(scan_rows(False), False, W)
    right = edge(scan_rows(True), True, W)
    top = edge(scan_cols(False), False, H)
    bottom = edge(scan_cols(True), True, H)

    if None in (left, right, top, bottom):
        raise SystemExit("边界检测失败：这张图可能已经是干净的图标，请手动传 --box l,t,r,b")

    box = (left, top, right, bottom)
    if verbose:
        print(f"  四条边：left {left}  right {right}  top {top}  bottom {bottom}"
              f"  → {right - left}×{bottom - top}")
    return box


def squareify(im: Image.Image, box):
    """按边界裁剪，再**拉伸**成正方形。

    AI 出的图标常常不是严格正方（这张母图 993×982，差 1% 上下）。
    直接按大边去裁，两条边里必有一条会多收进一条背景色带；
    **拉伸 1% 肉眼完全看不出来**，却能保证图标正好铺满、四边不留脏边。
    """
    l, t, r, b = box
    w, h = r - l, b - t
    side = max(w, h)
    return im.crop((l, t, r, b)).resize((side, side), Image.LANCZOS), (w, h)


# ---------------------------------------------------------------- 2. 补平四角

def _inset_per_row(side: int, radius: float):
    """圆角矩形每一行的左右内边界（圆心到边的距离）。"""
    for y in range(side):
        dy = max(0.0, radius - y, y - (side - 1 - radius))
        dx = radius - math.sqrt(max(0.0, radius * radius - dy * dy)) if dy else 0.0
        yield int(round(dx))


INSET = 6  # 补角取样时往内侧躲几像素：别把边缘高光、底部暖光一起抹到角上


def fill_corners(im: Image.Image, radius_ratio=0.24):
    """四个圆角外面用「同一行内侧的像素」横向抹平。

    手机/iOS 会自己把图标切成圆角，所以我们不需要保留原图的圆角，
    但**必须**把圆角外的区域填掉 —— 否则系统切圆角时会露出原图的灰蓝背景。
    半径取 0.24 略大于图标本身的圆角（约 0.19），确保不残留。
    """
    side = im.width
    a = np.asarray(im).astype(np.uint8).copy()
    radius = radius_ratio * side
    for y, dx in enumerate(_inset_per_row(side, radius)):
        if dx <= 0:
            continue
        a[y, :dx] = a[y, min(dx + INSET, side // 2)]
        a[y, side - dx:] = a[y, max(side - 1 - dx - INSET, side // 2)]
    return Image.fromarray(a)


def corner_color(im: Image.Image, radius_ratio=0.24):
    """取圆角区域的颜色（≈ 图标自己的底色），用来铺满 maskable 的画布。"""
    side = im.width
    radius = radius_ratio * side
    a = np.asarray(im).astype(np.uint8)
    ys, xs = [], []
    for y, dx in enumerate(_inset_per_row(side, radius)):
        if dx > 0 and y < radius:
            ys.append(y)
            xs.append(min(dx + INSET, side // 2))
    if not ys:
        return (255, 255, 255)
    px = a[np.array(ys), np.array(xs)]
    return tuple(int(v) for v in np.median(px, axis=0))


# ---------------------------------------------------------------- 3. 导出

def build_maskable(master: Image.Image, side: int, bg):
    """安卓自适应图标：内容缩到 86% 居中，四周用图标底色铺满。"""
    canvas = Image.new("RGB", (side, side), bg)
    inner = int(side * MASKABLE_SCALE)
    canvas.paste(master.resize((inner, inner), Image.LANCZOS), ((side - inner) // 2,) * 2)
    return canvas


def fit(master: Image.Image, s: int, zoom: float = 1.0) -> Image.Image:
    """缩到指定边长，可选先按 zoom 比例裁中心；小尺寸补轻微锐化。

    三维渲染图缩到 32/64px 一定发糊，这是细节量的问题，不是缩放算法的问题。
    加一点 UnsharpMask 能让它在浏览器页签里精神一些（不改变 192 以上的观感）。
    """
    src = master
    if zoom < 1.0:
        w = int(master.width * zoom)
        l = (master.width - w) // 2
        src = master.crop((l, l, l + w, l + w))
    img = src.resize((s, s), Image.LANCZOS)
    if s <= SHARPEN_BELOW:
        img = img.filter(ImageFilter.UnsharpMask(radius=0.9, percent=90, threshold=2))
    return img


def preview_sheet(master: Image.Image, out: Path):
    """拼一张检查图：各尺寸横排 + 末尾一个「安卓裁成圆形」的预览。"""
    items = SIZES + [(MASKABLE[0], MASKABLE[1], 1.0)]
    pad, gap = 14, 10
    H = max(s for _, s, _ in items) + pad * 2
    W = pad * 2 + sum(s for _, s, _ in items) + gap * (len(items) - 1)
    sheet = Image.new("RGB", (W, H), (235, 235, 240))
    x = pad
    for _, s, z in items:
        sheet.paste(fit(master, s, z), (x, pad + (H - pad * 2 - s) // 2))
        x += s + gap
    # 末尾再画一个「系统裁成圆形」的预览（108px）
    circ = build_maskable(master, 512, corner_color(master)).resize((108, 108), Image.LANCZOS)
    mask = Image.new("L", (108, 108), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, 107, 107), fill=255)
    sheet.paste(circ, (x, pad + (H - pad * 2 - 108) // 2), mask)
    sheet.save(out)


def main():
    ap = argparse.ArgumentParser(description="教师助手图标生成器")
    ap.add_argument("--src", required=True, help="方形母图（jpg/png 都行）")
    ap.add_argument("--out", help="输出目录（通常是 app/public）；不传则只检测不写")
    ap.add_argument("--box", help="跳过检测，直接给 l,t,r,b")
    ap.add_argument("--radius", type=float, default=0.24, help="补角半径比例，默认 0.24")
    ap.add_argument("--probe", action="store_true", help="只打印检测结果")
    ap.add_argument("--preview", help="顺便写一张各尺寸检查图到指定路径")
    args = ap.parse_args()

    src = Path(args.src).expanduser()
    if not src.exists():
        sys.exit(f"找不到母图：{src}")
    im = Image.open(src).convert("RGB")
    print(f"母图：{src}  {im.width}×{im.height}")

    if args.box:
        box = tuple(int(v) for v in args.box.split(","))
    else:
        box = detect_bbox(im, verbose=True)
    l, t, r, b = box
    print(f"检测到的图标边界：({l}, {t}) → ({r}, {b})   宽 {r - l} 高 {b - t}")

    sq, (w, h) = squareify(im, box)
    print(f"裁成正方形：{sq.width}×{sq.height}"
          f"（检测到的图标 {w}×{h}，纵向拉伸 {(max(w, h) / min(w, h) - 1) * 100:.1f}% 归正）")
    master = fill_corners(sq, args.radius)
    print(f"四角已补平，底色 ≈ {corner_color(master, args.radius)}")

    if args.preview:
        preview_sheet(master, Path(args.preview))
        print(f"检查图：{args.preview}")

    if args.probe or not args.out:
        print("（没有传 --out，只检测不写文件）")
        return

    out = Path(args.out)
    if not out.is_dir():
        sys.exit(f"输出目录不存在：{out}")
    # 旧图标备份到 public/ 的**外面** —— 放 public 里会被打进 dist 产物
    backup = out.parent / (out.name + "-icons-backup")
    backup.mkdir(exist_ok=True)
    for name, *_ in SIZES + [MASKABLE]:
        old = out / name
        if old.exists():
            shutil.copy2(old, backup / name)

    bg = corner_color(master, args.radius)
    for name, s, z in SIZES:
        fit(master, s, z).save(out / name, optimize=True)
        print(f"  ✓ {name}  {s}×{s}" + (f"（中心 {int(z * 100)}%）" if z < 1 else ""))
    mname, ms = MASKABLE
    build_maskable(master, ms, bg).save(out / mname, optimize=True)
    print(f"  ✓ {mname}  {ms}×{ms}（内容 {int(MASKABLE_SCALE * 100)}% 居中）")
    print(f"\n完成。旧图标已备份到 {backup}/")


if __name__ == "__main__":
    main()
