#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  换图标（Mac）— 把自己的图变成「教师助手」的全套图标
#
#  怎么用：
#   1. 把想用的图存成一张**正方形**图片（png / jpg 都行），
#      改名为「我的图标」，放进本文件夹（就是这几个文件所在的位置）
#   2. 双击本文件
#   3. 手机上把原来那个图标删掉，重新「添加到主屏幕」才会看到新图标
#
#  用的是 macOS 自带的 sips，不需要装任何东西。
#  Windows 用户：没有对应的命令行工具，请按「说明.md」里的尺寸表自己导出后同名覆盖。
# ─────────────────────────────────────────────────────────────

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 1

# 图标文件到底在哪一层？两种交付包布局不同：
#   静态部署版：  包根/index.html              （本文件夹放在包根 → 上一级就是）
#   自己电脑做服务器：包根/www/index.html        （本文件夹放在包根 → 上一级的 www 才是）
ROOT=""
for cand in ".." "../www"; do
  if [ -f "$cand/index.html" ]; then ROOT="$cand"; break; fi
done

# 安卓「自适应图标」铺的底色：图标内容会缩到 86%，四周用这个颜色填。
# 想换就把下面这行的十六进制改成你的颜色（不要写 # 号）。
BG="FBF3E6"

say() { printf '%s\n' "$1"; }
pause() { read -r -p "按回车键关闭这个窗口…" _; }

say "================================"
say " 教师助手 · 换图标"
say "================================"
say ""

# ── 1. 找图 ──────────────────────────────────────────────
SRC=""
for f in 我的图标.png 我的图标.jpg 我的图标.jpeg 我的图标.webp 我的图标.PNG 我的图标.JPG; do
  [ -f "$f" ] && SRC="$f" && break
done

if [ -z "$SRC" ]; then
  say "✗ 没找到你的图。"
  say ""
  say "  请把图片存到本文件夹（$(basename "$HERE")），并命名为「我的图标.png」"
  say "  当前文件夹里有："
  ls -1 | sed 's/^/    /'
  say ""
  pause
  exit 1
fi
say "找到：$SRC"

# 检查能否找到应用本体
if [ -z "$ROOT" ]; then
  say "✗ 找不到应用文件（index.html）。"
  say "  请把「图标」这个文件夹和 index.html 放在同一个包里再用，别单独挪出来。"
  say "  当前这一层的上一级有："
  ls -1 .. | sed 's/^/    /'
  say ""
  pause
  exit 1
fi

# ── 2. 归正成正方形（居中裁） ──────────────────────────────
W=$(sips -g pixelWidth "$SRC" 2>/dev/null | awk '/pixelWidth/{print $2}')
H=$(sips -g pixelHeight "$SRC" 2>/dev/null | awk '/pixelHeight/{print $2}')
if [ -z "${W:-}" ] || [ -z "${H:-}" ]; then
  say "✗ 读不出图片尺寸，确认它是 png / jpg 图片。"
  pause
  exit 1
fi

if [ "$W" -eq "$H" ]; then
  SIDE="$W"
  say "尺寸 ${W}×${H} → 本来就是正方形，直接用"
else
  SIDE=$(( W < H ? W : H ))
  say "尺寸 ${W}×${H} → 不是正方形，居中裁成 ${SIDE}×${SIDE}"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! sips -c "$SIDE" "$SIDE" "$SRC" --out "$TMP/sq.png" >/dev/null 2>&1; then
  say "✗ 处理失败，这张图可能不是标准图片格式（比如后缀是 png 其实是别的格式）。"
  pause
  exit 1
fi

emit() {   # emit 边长 文件名 [额外 sips 参数...]
  local size="$1" name="$2"; shift 2
  if sips -z "$size" "$size" "$TMP/sq.png" "$@" --out "$ROOT/$name" >/dev/null 2>&1; then
    say "  ✓ $name  ${size}×${size}"
  else
    say "  ✗ $name 生成失败"
  fi
}

# ── 3. 生成整套图标 ──────────────────────────────────────
say ""
say "开始生成…"
emit 64  pwa-icon-64.png
emit 192 pwa-icon-192.png
emit 512 pwa-icon-512.png
emit 180 apple-touch-icon.png

# 浏览器页签用的小图标：先把中心 78% 放大再缩到 32，小图上才看得清内容
Z=$(( SIDE * 78 / 100 ))
if sips -c "$Z" "$Z" "$TMP/sq.png" --out "$TMP/zoom.png" >/dev/null 2>&1 \
   && sips -z 32 32 "$TMP/zoom.png" --out "$ROOT/favicon-32.png" >/dev/null 2>&1; then
  say "  ✓ favicon-32.png  32×32（内容放大版）"
else
  emit 32 favicon-32.png
fi

# 安卓自适应图标：内容缩到 86%，四周铺底色（系统会把它裁成圆形/水滴形）
IN=$(( 512 * 86 / 100 ))
if sips -z "$IN" "$IN" "$TMP/sq.png" --out "$TMP/in.png" >/dev/null 2>&1 \
   && sips -p 512 512 --padColor "$BG" "$TMP/in.png" --out "$ROOT/pwa-icon-maskable-512.png" >/dev/null 2>&1; then
  say "  ✓ pwa-icon-maskable-512.png  512×512（安卓用）"
else
  say "  ! pwa-icon-maskable-512.png 没生成（不影响使用）"
fi

# ── 4. 收尾 ──────────────────────────────────────────────
say ""
say "完成！新图标已经写进：$(cd "$ROOT" && pwd)"
say ""
say "⚠️ 手机上要看到新图标，必须这样做："
say "   ① 长按主屏幕上旧的那个图标 → 删除"
say "   ② 用 Safari 重新打开这个应用 → 分享 → 添加到主屏幕"
say "   （已经装好的图标不会自动变，系统把图标缓存在安装那一刻）"
say ""
pause
