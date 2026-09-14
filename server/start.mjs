/* ============================================================
   教师助手 · 云端同步服务 —— 命令行入口
   ------------------------------------------------------------
   两种典型用法：

   ① 自己电脑当服务器（手机 ↔ 电脑同步，同一个 Wi-Fi 下可用）
        node server/start.mjs --lan
      会自动：监听局域网、生成邀请码、托管前端、打开浏览器。

   ② 放到云服务器上（公网访问，需再配 HTTPS 反向代理）
        node server/start.mjs --port 8787 --host 127.0.0.1

   配置优先级（后者覆盖前者）：
     server/config.json → 环境变量 → 自动推断 → 命令行参数
   详见 server/README.md
   ============================================================ */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, lanIPv4List, printBanner } from './index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** server/ 的上一层 —— 「独立服务器包」的根目录 */
const ROOT = dirname(HERE);
const CFG_PATH = join(HERE, 'config.json');

const USAGE = `
  用法：node server/start.mjs [选项]

  选项：
    -p, --port <端口>        监听端口（默认 8787）
        --host <地址>        监听地址（默认 127.0.0.1）
        --lan                局域网模式：同一个 Wi-Fi 下的手机也能访问
                             （等价于 --host 0.0.0.0，并自动打开浏览器）
        --data-dir <路径>    数据目录
        --static-dir <路径>  顺带托管的前端目录
        --invite <邀请码>    指定注册邀请码（不给则自动生成并记住）
        --no-open            启动后不自动打开浏览器
    -h, --help               显示本帮助

  也可以写 server/config.json，或用环境变量（PORT / HOST / DATA_DIR /
  STATIC_DIR / INVITE_CODE / ADMIN_USER / ALLOWED_ORIGINS / MAX_BLOB_MB）。
`;

/** 解析命令行参数；未知参数给出提示而不是静默忽略 */
function parseCliArgs(argv) {
  const out = {};
  let wantLan = false;
  let noOpen = false;
  let explicitHost = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-p': case '--port': {
        const v = Number(next());
        if (!Number.isInteger(v) || v < 0 || v > 65535) {
          console.error(`  ❌ 端口不合法：${v}`);
          process.exit(1);
        }
        out.port = v;
        break;
      }
      case '--host': out.host = next(); explicitHost = true; break;
      case '--lan': wantLan = true; break;
      case '--data-dir': out.dataDir = next(); break;
      case '--static-dir': out.staticDir = next(); break;
      case '--invite': out.inviteCode = next(); break;
      case '--open': noOpen = false; break;
      case '--no-open': noOpen = true; break;
      case '-h': case '--help': console.log(USAGE); process.exit(0); break;
      default:
        console.warn(`  ⚠️  未知参数「${a}」，已忽略。用 --help 查看可用选项。`);
    }
  }

  // --lan 只在没显式指定 --host 时才改写监听地址，避免互相打架
  if (wantLan && !explicitHost) out.host = '0.0.0.0';
  // 局域网模式默认顺手打开浏览器；显式给了 --no-open 就不开
  const wantOpen = (wantLan || argv.includes('--open')) && !noOpen;

  return { args: out, wantOpen, wantLan };
}

/**
 * 「独立服务器包」布局自动推断。
 * 如果 server/ 的上一层有 www/index.html，说明这是发给老师的那个压缩包，
 * 于是前端用 ../www、数据放 ../data —— 这样整个文件夹拷走 = 把数据一起搬走。
 */
function autoLayout() {
  const www = join(ROOT, 'www');
  if (existsSync(join(www, 'index.html'))) {
    return { staticDir: www, dataDir: join(ROOT, 'data') };
  }
  return {};
}

/**
 * 没配邀请码就生成一个，并写回 config.json 记住。
 * 不记住的话每次重启都换码，之前约好的同事就登不进来了。
 */
function ensureInviteCode(app) {
  if (app.cfg.inviteCode) return false;
  const code = 'js-' + randomBytes(4).toString('hex');
  app.cfg.inviteCode = code;

  let file = {};
  if (existsSync(CFG_PATH)) {
    try { file = JSON.parse(readFileSync(CFG_PATH, 'utf8')); } catch { /* 坏了就重写 */ }
  }
  file.inviteCode = code;
  try {
    writeFileSync(CFG_PATH, JSON.stringify(file, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    console.log('  ⚠️  邀请码未能写入 config.json，重启后会换一个新的。');
    return false;
  }
}

/** 打开浏览器；打不开也无所谓，手动点地址一样用 */
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    execFile(cmd, args, { stdio: 'ignore', detached: true }, () => { /* ignore */ });
  } catch { /* ignore */ }
}

/* ------------------------------ 启动 ------------------------------ */

const { args, wantOpen, wantLan } = parseCliArgs(process.argv.slice(2));
const app = createApp({ ...autoLayout(), ...args });

ensureInviteCode(app);

printBanner(app.cfg);

app.server.listen(app.cfg.port, app.cfg.host, () => {
  console.log(`  ✅ 已就绪 · ${new Date().toLocaleString()}`);

  if (wantLan) {
    const lan = lanIPv4List();
    const phoneUrl = lan.length ? `http://${lan[0].address}:${app.cfg.port}` : `http://127.0.0.1:${app.cfg.port}`;
    console.log(`  🌐 在浏览器里打开：${phoneUrl}`);
    if (wantOpen && !process.env.CI) openBrowser(phoneUrl);
  }
  console.log('     按 Ctrl+C 停止');
  console.log('');
});

let closing = false;
const shutdown = (signal) => {
  if (closing) return;
  closing = true;
  console.log(`\n  收到 ${signal}，正在关闭…`);
  app.server.close(() => process.exit(0));
  // 兜底：有长连接挂着时，3 秒后强制退出
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('  ❌ 未捕获异常：', err?.stack || err);
});
process.on('unhandledRejection', (err) => {
  console.error('  ❌ 未处理的 Promise 拒绝：', err?.stack || err);
});

// 端口被占用是最常见的启动失败，给一句人话而不是堆栈
app.server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n  ❌ 端口 ${app.cfg.port} 已被占用。`);
    console.error('     可能是这个服务已经在运行了（看看有没有别的窗口开着），');
    console.error('     也可以换一个端口：node server/start.mjs --lan --port 8788\n');
    process.exit(1);
  }
  console.error('  ❌ 服务启动失败：', err?.message || err);
  process.exit(1);
});
