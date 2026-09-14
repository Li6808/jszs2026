#!/usr/bin/env node
/**
 * 教师助手 · 在电脑上打开 —— 极简本机静态服务器
 * 零依赖，只用 Node 内置模块。由「双击打开」脚本自动调用，一般不用手动运行。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const START_PORT = Number(process.env.TA_PORT || 8790);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function freePort(from) {
  return new Promise((resolve, reject) => {
    let port = from;
    const attempt = () => {
      if (port > from + 20) return reject(new Error('找不到空闲端口'));
      const probe = net.createServer();
      probe.once('error', () => { port += 1; attempt(); });
      probe.once('listening', () => probe.close(() => resolve(port)));
      probe.listen(port, '127.0.0.1');
    };
    attempt();
  });
}

const server = http.createServer((req, res) => {
  const raw = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = raw === '/' ? 'index.html' : raw.replace(/^\/+/, '');
  const target = path.resolve(ROOT, rel);

  // 防目录穿越：解析后必须仍在本目录内
  const away = path.relative(ROOT, target);
  if (away.startsWith('..') || path.isAbsolute(away)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('禁止访问');
  }

  fs.stat(target, (err, st) => {
    const file = !err && st.isFile() ? target : path.join(ROOT, 'index.html');
    fs.readFile(file, (e, buf) => {
      if (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('未找到该文件');
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    });
  });
});

function openBrowser(url) {
  const map = {
    darwin: ['open', [url]],
    win32: ['cmd', ['/c', 'start', '', url]],
  };
  const [cmd, args] = map[process.platform] || ['xdg-open', [url]];
  execFile(cmd, args, () => {});
}

const port = await freePort(START_PORT);
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log('');
  console.log('  📚 教师助手 · 已在你的电脑上打开');
  console.log('  ─────────────────────────────────────────');
  console.log(`  地址      ${url}`);
  console.log('  数据位置  这个浏览器的本地存储里');
  console.log('  联网要求  不需要，断网照样用');
  console.log('');
  console.log('  ⚠️  这个窗口就是服务，别关它（最小化可以）。');
  console.log('      用完请按 Control + C 停止，数据不会丢。');
  console.log('');
  console.log('  💡 想换电脑带走数据：进「个人设置 → 数据备份」导出一份，');
  console.log('     在新电脑上导入即可。');
  console.log('');
  if (!process.env.TA_NO_OPEN) openBrowser(url);
});

server.on('error', (err) => {
  console.log('');
  console.log('  ❌ 启动失败：' + err.message);
  process.exit(1);
});
