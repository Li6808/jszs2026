#!/usr/bin/env node
/**
 * 构建「分享版」产物（给同事用的那一份，站点标识 lite）。
 *
 * 与 V41.2 完全相同，只有一处差别：**不含「💳 支付截图」模块**。
 *
 * 两条并行的线（互不覆盖）：
 *   - 自己用：仓库 Li6808/jszs2026     → https://li6808.github.io/jszs2026/      （9 模块，V41）
 *   - 给同事：仓库 Li6808/jszs2026-lite  → https://li6808.github.io/jszs2026-lite/ （8 模块，V41 通用版）
 *
 * 为什么要单独一个脚本，而不是直接删源码里的模块？
 *   - 老师自己用的那一版（V41）必须原封不动，不能为了分享版去动它；
 *   - 这个脚本把源码复制到临时目录再动手，主源码一个字节都不改；
 *   - 摘除的位置全部用「精确锚点」，锚点对不上就报错退出（绝不会默默少删一处，
 *     留下一个引用了不存在模块的页面）。
 *
 * 摘掉的 6 处（全部核对过，没有第七处）：
 *   1. src/App.tsx     Page 联合类型里的 'payment'
 *   2. src/App.tsx     MODULE_CONFIG 里的 payment 卡片定义
 *   3. src/App.tsx     路由那一行 {page === 'payment' && <PaymentPage …/>}
 *   4. src/App.tsx     整个 PaymentPage 组件块（含 PaymentEntry 类型）
 *   5. src/storage.ts  DEFAULT_MODULE_ORDER 里的 'payment'
 *   6. src/payment.ts  整个文件（只被上面那块引用）
 * 另外把版本号改成「V41 通用版」，更新记录里插一条说明。
 *
 * 用法：
 *   cd /Users/apple/Downloads/OKComputer_请假条功能优化/app
 *   node tools/build-lite.mjs          # 产出 dist-lite/
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-lite');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jszs-lite-'));

const log = (...a) => console.log(...a);

/* ---------- 1. 把源码复制到临时目录（node_modules 用软链，不复制 278M） ---------- */
const COPY = [
  'src', 'public', 'index.html', 'vite.config.ts', 'package.json',
  'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json',
  'postcss.config.js', 'tailwind.config.js', 'components.json',
];
for (const f of COPY) {
  const from = path.join(ROOT, f);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(TMP, f), { recursive: true });
}
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(TMP, 'node_modules'));
log(`① 已复制源码到临时目录：${TMP}`);

/* ---------- 2. 摘掉「支付截图」模块 ---------- */
function edit(rel, fn) {
  const p = path.join(TMP, rel);
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`改动没生效（锚点没匹配上）：${rel}`);
  fs.writeFileSync(p, after, 'utf8');
}
/** 精确替换一次，找不到就抛错 */
function cutOnce(s, anchor, replacement) {
  const n = s.split(anchor).length - 1;
  if (n !== 1) throw new Error(`锚点出现 ${n} 次（应为 1 次）：${JSON.stringify(anchor.slice(0, 70))}`);
  return s.replace(anchor, replacement);
}

edit('src/App.tsx', s => {
  // 1) Page 联合类型
  s = cutOnce(s, "'substitute' | 'payment' | 'homework'", "'substitute' | 'homework'");
  // 2) 首页卡片定义
  s = cutOnce(
    s,
    "  payment: { icon: '💳', iconClass: 'orange', name: '支付截图', desc: '截图处理工具' },\n",
    '',
  );
  // 3) 路由
  s = cutOnce(
    s,
    "        {page === 'payment' && <PaymentPage toast={toast} openQr={openQr} />}\n",
    '',
  );
  // 4) 整个组件块（区块标记之间）
  const START = '/* ============ 支付截图处理（差旅报销助手）- 带裁剪+纯图排版 ============ */';
  const END = '/* ============ Parse Schedule ============ */';
  const i = s.indexOf(START);
  const j = s.indexOf(END);
  if (i < 0 || j < 0 || j <= i) throw new Error('找不到 PaymentPage 区块的起止标记');
  s = s.slice(0, i) + s.slice(j);
  return s;
});

edit('src/storage.ts', s =>
  cutOnce(s, "'substitute', 'payment', 'settings'", "'substitute', 'settings'"),
);

edit('src/version.ts', s => {
  s = cutOnce(s, "export const APP_VERSION = 'V41.2';", "export const APP_VERSION = 'V41.2 通用版';");
  s = cutOnce(
    s,
    'export const CHANGELOG: Release[] = [\n',
    `export const CHANGELOG: Release[] = [
  {
    version: 'V41.2 通用版',
    date: '2026-09-16',
    items: [
      '这是分享给同事用的通用版，界面与用法和之前的版本一样，一共 8 个模块：请假条 / 我的课表 / 作业收缴 / 古诗文背诵 / 工资统计 / 值班统计 / 代课统计 / 个人设置',
      '数据全部只存在你自己的手机（或电脑）里，不上传任何服务器；换手机时用「个人设置 → 数据备份」导出一份文件搬过去即可',
      '首页可以自己排序、也可以把用不上的模块收起来（个人设置 → 首页模块显示与排序），收起来只是不显示，记录一条都不会丢',
    ],
  },
`,
  );
  return s;
});

// 7) 静态文案里的模块清单（PWA 描述 / 页面 meta），别漏
for (const f of ['index.html', 'public/manifest.json']) {
  edit(f, s => cutOnce(s, '、支付截图', ''));
}

fs.rmSync(path.join(TMP, 'src/payment.ts'));
log('② 已摘除「支付截图」模块（App.tsx 4 处 + storage.ts 1 处 + payment.ts 整个文件 + index.html/manifest 文案）');

/* ---------- 3. 类型检查（防止留下引用了已删模块的残骸） ---------- */
try {
  execFileSync(path.join(ROOT, 'node_modules/.bin/tsc'), ['-b'], { cwd: TMP, stdio: 'pipe' });
  log('③ 类型检查通过');
} catch (e) {
  console.error('❌ 类型检查失败：\n' + (e.stdout?.toString() || e.message));
  process.exit(1);
}

/* ---------- 4. 构建 ---------- */
execFileSync(path.join(ROOT, 'node_modules/.bin/vite'),
  ['build', '--outDir', 'dist', '--emptyOutDir'], { cwd: TMP, stdio: 'inherit' });
fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(TMP, 'dist'), OUT, { recursive: true });
log(`④ 产物已生成：${OUT}`);

/* ---------- 5. 自检：产物里不许再出现支付截图的任何痕迹 ---------- */
// ⚠️ 判别词要挑「只有支付截图模块才会有」的。
// 别拿「豆包」当判别词 —— 作业收缴 / 课表 / 背诵出题那几处本来就有
// 「把截图发给豆包识别」的正常用法，会误报（第一次跑就踩了）。
const FORBIDDEN = ['支付截图', 'PaymentPage', 'PaymentEntry', 'generateDoubaoPrompt',
                   'cropImageBottom', 'exportA4PureImages', 'openPrintWindow',
                   '差旅', '零钱明细', '看不出来修改过'];
// 顺带确认「别的模块还在」（防止删多了）：这些词必须仍然出现
const MUST_KEEP = ['古诗文背诵', '作业收缴', '值班统计', '代课统计', '工资统计',
                   '我的课表', '请假条', '个人设置'];
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|css|html|json|txt)$/i.test(e.name)) files.push(p);
  }
})(OUT);
const all = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
let bad = 0;
for (const k of FORBIDDEN) {
  const n = all.split(k).length - 1;
  if (n > 0) { console.error(`❌ 产物里还有「${k}」×${n}`); bad++; }
}
for (const k of MUST_KEEP) {
  if (!all.includes(k)) { console.error(`❌ 产物里缺少「${k}」—— 可能删多了`); bad++; }
}
if (bad) {
  console.error('\n❌ 产物里残留了支付截图模块的内容，不能发布。');
  process.exit(1);
}
log(`⑤ 自检通过：${files.join(' / ')} 中不含支付截图模块的任何痕迹`);
log(`\n✅ 通用版（lite）构建完成。临时目录（可删）：${TMP}`);
