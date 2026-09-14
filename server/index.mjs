/* ============================================================
   教师助手 · 数据同步服务（本机 / 局域网 / 公网通用）—— HTTP 层
   ------------------------------------------------------------
   零 npm 依赖，只用 node: 内置模块。

   它做两件事：
     1) 提供 /api/* 接口 —— 账号注册登录 + 每人一整包数据的存取
     2) 可选地顺带托管前端静态文件（STATIC_DIR），
        这样一台服务器一个端口就够了，也不用操心跨域。

   本地跑：
     node server/index.mjs
   常用环境变量见 server/README.md（也可写 server/config.json）。
   ============================================================ */

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, SESSION_TTL_MS, validateUsername, validatePassword } from './store.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PKG_VERSION = '1.2.0';

/**
 * 这个网卡名有没有可能是「手机连得上」的真实网卡。
 * 隧道类（VPN / 代理 TUN / AirDrop / 虚拟机）一律排除 ——
 * 它们在本机看着正常，手机上根本不可达，把地址给老师只会让人一直打不开。
 */
export function isShareableIface(name) {
  return !/^(utun|ipsec|ppp|tun|tap|gif|stf|awdl|llw|bridge|vmnet|vboxnet|docker)/i.test(String(name || ''));
}

/**
 * 这个 IPv4 地址能不能发给手机用。
 * 抽成纯函数是为了能单独测 —— 机器上有没有虚拟网卡，测试结果会不一样。
 */
export function isShareableAddress(addr) {
  const a = String(addr || '');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) return false;
  if (/^(127|0)\./.test(a)) return false;                              // 回环 / 无效
  if (a.startsWith('169.254.')) return false;                          // link-local，不可路由
  if (/^198\.1[89]\./.test(a)) return false;                           // 198.18.0.0/15：代理软件 TUN 占用的保留段
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)) return false; // 100.64/10：CGNAT（Tailscale 等）
  return true;
}

/**
 * 本机所有可供局域网访问的 IPv4 地址（排除回环、虚拟网卡与不可路由段）。
 * 给「自己电脑当服务器」这种用法用 —— 手机要连的就是这几个地址之一。
 */
export function lanIPv4List() {
  const out = [];
  const nis = networkInterfaces();
  for (const name of Object.keys(nis)) {
    if (!isShareableIface(name)) continue;
    for (const ni of nis[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (!isShareableAddress(ni.address)) continue;
      out.push({ iface: name, address: ni.address });
    }
  }
  // 家用/办公最常见的 192.168 排前面，其次 10.x、172.16-31.x，最后才是其它
  const rank = a => (/^192\.168\./.test(a) ? 0
    : /^10\./.test(a) ? 1
      : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3);
  return out.sort((a, b) => rank(a.address) - rank(b.address) || a.address.localeCompare(b.address));
}

/** 监听地址是否为「仅本机」 */
export function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/* ============================== 配置 ============================== */

const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  dataDir: join(HERE, 'data'),
  staticDir: '',
  inviteCode: '',
  adminUser: '',
  allowedOrigins: '',
  maxBlobMB: 24,
};

function loadConfig(overrides = {}) {
  let fromFile = {};
  const cfgPath = join(HERE, 'config.json');
  if (existsSync(cfgPath)) {
    try { fromFile = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { /* ignore */ }
  }
  const env = process.env;
  const envCfg = {};
  if (env.PORT) envCfg.port = Number(env.PORT);
  if (env.HOST) envCfg.host = env.HOST;
  if (env.DATA_DIR) envCfg.dataDir = env.DATA_DIR;
  if (env.STATIC_DIR) envCfg.staticDir = env.STATIC_DIR;
  if (env.INVITE_CODE) envCfg.inviteCode = env.INVITE_CODE;
  if (env.ADMIN_USER) envCfg.adminUser = env.ADMIN_USER;
  if (env.ALLOWED_ORIGINS) envCfg.allowedOrigins = env.ALLOWED_ORIGINS;
  if (env.MAX_BLOB_MB) envCfg.maxBlobMB = Number(env.MAX_BLOB_MB);

  const cfg = { ...DEFAULTS, ...fromFile, ...envCfg, ...overrides };
  cfg.staticDir = cfg.staticDir ? resolve(cfg.staticDir) : '';
  cfg.dataDir = resolve(cfg.dataDir);
  cfg.maxBlobBytes = Math.max(1, Number(cfg.maxBlobMB) || 24) * 1024 * 1024;
  cfg.origins = String(cfg.allowedOrigins || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return cfg;
}

/* ============================== 工具 ============================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'SAMEORIGIN',
  };
}

/**
 * 读取请求体，超过上限即拒绝。
 * 注意：超限时不能立刻 req.destroy() —— 那会把 socket 一起干掉，
 * 结果就是 413 响应根本发不出去，客户端只看到「连接被重置」。
 * 正确做法是先丢弃后续内容（继续 drain），等请求结束后再回 413。
 * 只有超出上限 4 倍以上才真的断连，避免被巨包空耗带宽。
 */
function readBody(req, limitBytes) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    let done = false;
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > limitBytes) {
        tooLarge = true;
        chunks.length = 0;
        if (size > limitBytes * 4) {
          done = true;
          rejectPromise(Object.assign(new Error('请求体过大'), { code: 'TOO_LARGE' }));
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (tooLarge) rejectPromise(Object.assign(new Error('请求体过大'), { code: 'TOO_LARGE' }));
      else resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', err => {
      if (done) return;
      done = true;
      rejectPromise(err);
    });
  });
}

function parseJsonBody(text) {
  if (!text || !text.trim()) return {};
  try {
    const obj = JSON.parse(text);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch {
    throw Object.assign(new Error('JSON 格式错误'), { code: 'BAD_JSON' });
  }
}

/** 简易滑动窗口限流：只用于登录/注册这类敏感入口 */
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return {
    /** 返回 true 表示已超限 */
    hit(key) {
      const now = Date.now();
      const rec = hits.get(key);
      if (!rec || now > rec.resetAt) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return false;
      }
      rec.count++;
      return rec.count > max;
    },
    reset(key) { hits.delete(key); },
    cleanup() {
      const now = Date.now();
      for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
    },
    size() { return hits.size; },
  };
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    isAdmin: !!u.isAdmin,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

/* ============================ 应用构建 ============================ */

export function createApp(overrides = {}) {
  const cfg = loadConfig(overrides);
  const store = new Store(cfg.dataDir, { adminUser: cfg.adminUser });
  const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });

  const cleanupTimer = setInterval(() => {
    authLimiter.cleanup();
    store.purgeExpired();
  }, 10 * 60 * 1000);
  cleanupTimer.unref?.();

  function applyCors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return;
    const allowed = cfg.origins.length === 0
      ? []                       // 未配置 → 仅同源（不返回 CORS 头）
      : cfg.origins.includes('*') ? ['*'] : cfg.origins;
    if (allowed.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else {
      return;
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  function bearerToken(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1].trim() : '';
  }

  function clientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
  }

  /* ------------------------ 静态文件托管 ------------------------ */

  function serveStatic(req, res, pathname) {
    if (!cfg.staticDir) return false;
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const target = normalize(join(cfg.staticDir, rel));
    // 防目录穿越：解析后的路径必须仍在 staticDir 内
    if (target !== cfg.staticDir && !target.startsWith(cfg.staticDir + sep)) return false;

    let filePath = target;
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      // 单页应用：找不到的路径回落到 index.html
      const fallback = join(cfg.staticDir, 'index.html');
      if (!existsSync(fallback)) return false;
      filePath = fallback;
    }
    const body = readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
      ...securityHeaders(),
    });
    res.end(body);
    return true;
  }

  /* ---------------------------- 路由 ---------------------------- */

  async function handleApi(req, res, pathname) {
    const method = req.method || 'GET';
    const ip = clientIp(req);

    /* ---------- 健康检查 ---------- */
    if (pathname === '/api/health' && method === 'GET') {
      const lan = !isLoopbackHost(cfg.host);
      /**
       * 手机该访问哪个地址。
       * 只监听回环（默认）时没有局域网地址，返回空数组 ——
       * 前端会退回「用当前页面地址」，那种情况本来就只能本机用。
       */
      const urls = lan
        ? lanIPv4List().map(n => `http://${n.address}:${cfg.port}`)
        : [];
      return sendJson(res, 200, {
        ok: true,
        app: 'teacher-assistant-cloud',
        version: PKG_VERSION,
        registrationOpen: !!cfg.inviteCode,
        // 前端据此知道「这是局域网里的自己人服务器」，而不是公网服务器
        lan,
        // 手机可用的访问地址（按家用网段优先排序）
        urls,
        time: new Date().toISOString(),
      });
    }

    /* ---------- 注册 ---------- */
    if (pathname === '/api/register' && method === 'POST') {
      if (authLimiter.hit(`reg:${ip}`)) {
        return sendJson(res, 429, { error: '尝试过于频繁，请 15 分钟后再试。' });
      }
      if (!cfg.inviteCode) {
        return sendJson(res, 403, { error: '本服务器已关闭注册。' });
      }
      let body;
      try {
        body = parseJsonBody(await readBody(req, cfg.maxBlobBytes));
      } catch (e) {
        return sendJson(res, e.code === 'TOO_LARGE' ? 413 : 400, { error: e.message });
      }
      if (String(body.invite || '') !== cfg.inviteCode) {
        return sendJson(res, 403, { error: '邀请码不正确。' });
      }
      const uErr = validateUsername(body.username);
      if (uErr) return sendJson(res, 400, { error: uErr });
      const pErr = validatePassword(body.password);
      if (pErr) return sendJson(res, 400, { error: pErr });

      const r = store.createUser(body.username, body.password);
      if (r.error) return sendJson(res, 400, { error: r.error });
      authLimiter.reset(`reg:${ip}`);
      const token = store.issueSession(r.user.id);
      return sendJson(res, 201, { token, user: publicUser(r.user) });
    }

    /* ---------- 登录 ---------- */
    if (pathname === '/api/login' && method === 'POST') {
      if (authLimiter.hit(`login:${ip}`)) {
        return sendJson(res, 429, { error: '尝试过于频繁，请 15 分钟后再试。' });
      }
      let body;
      try {
        body = parseJsonBody(await readBody(req, 64 * 1024));
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      const user = store.verifyPassword(body.username, body.password);
      if (!user) return sendJson(res, 401, { error: '账号或密码不正确。' });
      authLimiter.reset(`login:${ip}`);
      const token = store.issueSession(user.id);
      return sendJson(res, 200, { token, user: publicUser(user) });
    }

    /* ---------- 以下均需登录 ---------- */
    const token = bearerToken(req);
    const user = store.resolveSession(token);
    if (!user) {
      return sendJson(res, 401, { error: '登录已过期，请重新登录。' });
    }

    if (pathname === '/api/logout' && method === 'POST') {
      store.revokeSession(token);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/me' && method === 'GET') {
      return sendJson(res, 200, {
        user: publicUser(user),
        blob: store.readBlobMeta(user.id),
        sessionTtlDays: Math.round(SESSION_TTL_MS / 86400000),
      });
    }

    /* ---------- 上传 / 下载自己的数据包 ---------- */
    if (pathname === '/api/blob' && method === 'PUT') {
      let body;
      try {
        body = parseJsonBody(await readBody(req, cfg.maxBlobBytes));
      } catch (e) {
        return sendJson(res, e.code === 'TOO_LARGE' ? 413 : 400, {
          error: e.code === 'TOO_LARGE'
            ? `数据包超过服务器上限（${cfg.maxBlobMB} MB），请联系管理员调高。`
            : e.message,
        });
      }
      if (!body || typeof body !== 'object' || !body.payload) {
        return sendJson(res, 400, { error: '数据包内容为空，请确认是「教师助手」导出的备份。' });
      }
      const r = store.saveBlob(user.id, body.payload);
      return sendJson(res, 200, { ok: true, savedAt: r.savedAt, bytes: r.bytes });
    }

    if (pathname === '/api/blob' && method === 'GET') {
      const blob = store.readBlob(user.id);
      if (!blob) return sendJson(res, 404, { error: '服务器上还没有你的数据，请先上传一次。' });
      return sendJson(res, 200, blob);
    }

    /* ---------- 管理员 ---------- */
    if (pathname === '/api/admin/users' && method === 'GET') {
      if (!user.isAdmin) return sendJson(res, 403, { error: '需要管理员权限。' });
      return sendJson(res, 200, { users: store.listUsers() });
    }

    if (pathname === '/api/admin/stats' && method === 'GET') {
      if (!user.isAdmin) return sendJson(res, 403, { error: '需要管理员权限。' });
      return sendJson(res, 200, store.stats());
    }

    const adminBlob = /^\/api\/admin\/blob\/([0-9a-fA-F-]{36})$/.exec(pathname);
    if (adminBlob && method === 'GET') {
      if (!user.isAdmin) return sendJson(res, 403, { error: '需要管理员权限。' });
      const target = store.findById(adminBlob[1]);
      if (!target) return sendJson(res, 404, { error: '没有这个账号。' });
      const blob = store.readBlob(target.id);
      if (!blob) return sendJson(res, 404, { error: '该账号还没有上传过数据。' });
      return sendJson(res, 200, { username: target.username, ...blob });
    }

    return sendJson(res, 404, { error: '接口不存在。' });
  }

  const server = createServer(async (req, res) => {
    const started = Date.now();
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch { /* ignore */ }

    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, securityHeaders());
      return res.end();
    }

    try {
      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname);
      } else if (!serveStatic(req, res, pathname)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders() });
        res.end(cfg.staticDir ? '未找到该文件' : '教师助手数据同步服务运行中。接口在 /api/ 下。');
      }
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: '服务器内部错误。' });
      }
      console.error('[error]', pathname, err?.message || err);
    } finally {
      if (pathname.startsWith('/api/') && cfg.logRequests !== false) {
        console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  });

  return { server, store, cfg };
}

export function startServer(overrides = {}) {
  const app = createApp(overrides);
  return new Promise((res, rej) => {
    app.server.once('error', rej);
    app.server.listen(app.cfg.port, app.cfg.host, () => {
      const addr = app.server.address();
      // 传 port:0 时系统会随机分配端口，此时 cfg.port 仍是 0 —— 回填真实端口，
      // 否则 /api/health 给出的「手机该用哪个地址」会带一个 :0
      if (addr && typeof addr === 'object') app.cfg.port = addr.port;
      res({ ...app, port: app.cfg.port });
    });
  });
}

/* ============================== 启动日志 ============================== */

/**
 * 打印启动横幅。这个函数被 start.mjs（命令行入口）调用。
 *
 * 注意：这里刻意不做「是否被直接运行」的自动判断。
 * 之前用 import.meta.url === process.argv[1] 判断，一旦这个模块被打包器
 * 拼进别的产物，import.meta.url 会变成产物自身的路径，于是 import 一下
 * 就会莫名其妙多起一个服务。所以入口单独放在 start.mjs，职责分明。
 */
export function printBanner(cfg) {
  const loopback = isLoopbackHost(cfg.host);
  const lan = lanIPv4List();
  console.log('');
  console.log(loopback
    ? '  📚 教师助手 · 本机服务（只给这台电脑用）'
    : '  📚 教师助手 · 自己电脑当服务器（手机可接入）');
  console.log('  ─────────────────────────────────────────');
  console.log(`  本机访问  http://127.0.0.1:${cfg.port}`);
  if (!loopback) {
    if (lan.length) {
      for (const n of lan) {
        console.log(`  局域网    http://${n.address}:${cfg.port}`);
      }
    } else {
      console.log('  局域网    （没检测到局域网地址 —— 请先连上 Wi-Fi 或插上网线）');
    }
  }
  console.log(`  数据目录  ${cfg.dataDir}`);
  console.log(`  静态托管  ${cfg.staticDir || '（未开启，只提供接口）'}`);
  console.log(`  注册状态  ${cfg.inviteCode ? '开启（需邀请码）' : '已关闭'}`);
  if (cfg.inviteCode) {
    console.log(`  邀请码    ${cfg.inviteCode}`);
  }
  console.log(`  单包上限  ${cfg.maxBlobMB} MB`);
  console.log('');

  if (!loopback && cfg.staticDir) {
    console.log('  📱 手机同步怎么用：');
    console.log('     1. 手机连上和这台电脑【同一个 Wi-Fi】');
    console.log('     2. 手机浏览器打开上面那个【局域网】地址');
    console.log('     3. 在应用里注册账号，然后点「上传当前全部数据到服务器」');
    console.log('');
    console.log('     手机上改完的数据，回到电脑打开同一个地址就能看到。');
    console.log('');
    console.log('     ※ 关掉这个窗口、电脑睡眠或合盖，手机就打不开了。');
    console.log('       结束使用请按 Ctrl+C 停止。（数据已落盘，不会丢）');
    console.log('');
  }

  if (loopback && cfg.staticDir) {
    console.log('  ✅ 数据只存在这台电脑上，不经过任何外部服务器。');
    console.log('     想让手机也能连，请用「启动服务器（Mac/Windows）」脚本，');
    console.log('     或在启动命令里加上 --lan 参数。');
    console.log('');
  }

  if (!loopback && !cfg.staticDir) {
    console.log('  ⚠️  正监听对外地址。若不经过 HTTPS 反向代理，');
    console.log('      密码与数据将以明文在网络上传输 —— 公网部署请务必配好 Caddy / Nginx。');
    console.log('');
  }
  if (!cfg.inviteCode) {
    console.log('  ⚠️  未设置 INVITE_CODE，注册接口已关闭（老账号仍可登录）。');
    console.log('');
  }
}
