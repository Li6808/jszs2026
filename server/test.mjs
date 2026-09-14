/* ============================================================
   教师助手 · 云端同步服务 —— 端到端测试
   ------------------------------------------------------------
   在进程内起一个真实服务，走真实 HTTP，把安全边界全验一遍：
   邀请码、鉴权、越权、数据隔离、体积上限、重启后数据仍在。

   运行：node server/test.mjs
   ============================================================ */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './index.mjs';

const INVITE = 'test-invite-8899';

let pass = 0;
let fail = 0;
const failures = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ok   ${name}${detail ? `  — ${detail}` : ''}`);
    pass++;
  } catch (err) {
    console.log(`  FAIL ${name}\n         ${err?.message || err}`);
    failures.push(name);
    fail++;
  }
}

function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg || '不相等'}\n         实际: ${JSON.stringify(a)}\n         期望: ${JSON.stringify(b)}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

/* ---------------- 启动环境 ---------------- */

const root = mkdtempSync(join(tmpdir(), 'ta-cloud-'));
const dataDir = join(root, 'data');
const staticDir = join(root, 'www');
mkdirSync(staticDir, { recursive: true });
writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>教师助手</title><p>app</p>', 'utf8');
writeFileSync(join(root, 'secret.txt'), 'TOP SECRET', 'utf8');

let app = await startServer({
  port: 0,
  host: '127.0.0.1',
  dataDir,
  staticDir,
  inviteCode: INVITE,
  adminUser: '',
  allowedOrigins: '',
  maxBlobMB: 1,
  logRequests: false,
});
let base = `http://127.0.0.1:${app.port}`;

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, headers, body: payload });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, body: json };
}

/** 一份仿真的备份包，结构对齐前端 backup.ts 的 BackupFile */
function makePayload(names, studentCount) {
  const students = Array.from({ length: studentCount }, (_, i) => ({
    id: `stu_${i}`, no: i + 1, name: `学生${i + 1}`, gender: '男', className: '4班',
  }));
  return {
    app: 'teacher-assistant-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    summary: `背诵 1 个班 / ${studentCount} 名学生`,
    data: {
      settings: { name: names },
      history: [], salaries: [], duties: [], homeworkRecords: [],
      reciteRecords: [{
        id: 'rec_1', classFullName: '初二(4)班', classShortName: '4班', grade: '初二',
        poems: [], students, marks: {}, createdAt: '', updatedAt: '',
      }],
    },
  };
}

console.log('\n══════ 教师助手 · 云端同步服务 端到端测试 ══════\n');

/* ============================ [1] 健康检查 ============================ */

console.log('[1] 健康检查与静态托管');

await check('GET /api/health 返回服务信息', async () => {
  const r = await api('/api/health');
  eq(r.status, 200, '状态码');
  assert(r.body.ok === true, 'ok 应为 true');
  eq(r.body.app, 'teacher-assistant-cloud', 'app 标识');
  return `v${r.body.version} · 注册${r.body.registrationOpen ? '开启' : '关闭'}`;
});

await check('GET / 托管前端入口', async () => {
  const res = await fetch(base + '/');
  const text = await res.text();
  eq(res.status, 200, '状态码');
  assert(text.includes('教师助手'), '应返回 index.html 内容');
  return 'index.html 正常';
});

await check('未知路径回落到 index.html（单页应用行为）', async () => {
  const res = await fetch(base + '/some/deep/route');
  const text = await res.text();
  eq(res.status, 200, '状态码');
  assert(text.includes('教师助手'), '应回落');
  return '回落成功';
});

await check('目录穿越被拦截，读不到上级文件', async () => {
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/a/../../secret.txt']) {
    const res = await fetch(base + p, { redirect: 'manual' });
    const text = await res.text();
    assert(!text.includes('TOP SECRET'), `路径 ${p} 泄漏了上级文件`);
  }
  return '4 种穿越写法均被挡';
});

/* ============================ [2] 注册校验 ============================ */

console.log('\n[2] 注册与邀请码');

await check('邀请码错误 → 403', async () => {
  const r = await api('/api/register', { method: 'POST', body: { username: 'wang', password: 'abc123456', invite: 'wrong' } });
  eq(r.status, 403, '状态码');
  return r.body.error;
});

await check('密码过短 → 400', async () => {
  const r = await api('/api/register', { method: 'POST', body: { username: 'wang', password: '123', invite: INVITE } });
  eq(r.status, 400, '状态码');
  return r.body.error;
});

await check('账号含非法字符 → 400', async () => {
  const r = await api('/api/register', { method: 'POST', body: { username: 'a b/c', password: 'abc123456', invite: INVITE } });
  eq(r.status, 400, '状态码');
  return r.body.error;
});

await check('非法 JSON → 400 而非崩溃', async () => {
  const r = await api('/api/register', { method: 'POST', body: '{这不是json', });
  assert(r.status === 400 || r.status === 403, `状态码应为 400/403，实际 ${r.status}`);
  return '优雅降级';
});

let tokenA = '';
let userA = null;

await check('首个账号注册成功，并自动成为管理员', async () => {
  const r = await api('/api/register', { method: 'POST', body: { username: '李老师', password: 'abc123456', invite: INVITE } });
  eq(r.status, 201, '状态码');
  assert(typeof r.body.token === 'string' && r.body.token.length === 64, 'token 应为 64 位十六进制');
  tokenA = r.body.token;
  userA = r.body.user;
  eq(userA.isAdmin, true, '首个账号应为管理员');
  return `账号 ${userA.username} · 管理员`;
});

await check('同名账号重复注册 → 400', async () => {
  const r = await api('/api/register', { method: 'POST', body: { username: '李老师', password: 'abc123456', invite: INVITE } });
  eq(r.status, 400, '状态码');
  return r.body.error;
});

await check('不落盘明文密码', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(join(dataDir, 'users.json'), 'utf8');
  assert(!raw.includes('abc123456'), 'users.json 里出现了明文密码！');
  const u = JSON.parse(raw).users[userA.id];
  assert(u.salt && u.hash && u.hash.length === 128, '应有 salt 与 128 位 scrypt 哈希');
  return '仅存 salt + scrypt 哈希';
});

/* ============================ [3] 登录与鉴权 ============================ */

console.log('\n[3] 登录与令牌鉴权');

let tokenA2 = '';

await check('密码错误 → 401', async () => {
  const r = await api('/api/login', { method: 'POST', body: { username: '李老师', password: 'wrong-password' } });
  eq(r.status, 401, '状态码');
  return r.body.error;
});

await check('账号不存在 → 401（不暴露账号是否存在）', async () => {
  const r = await api('/api/login', { method: 'POST', body: { username: '查无此人', password: 'whatever123' } });
  eq(r.status, 401, '状态码');
  eq(r.body.error, '账号或密码不正确。', '错误文案应与密码错误一致');
  return '文案与密码错误一致';
});

await check('正确登录 → 200 并签发新令牌', async () => {
  const r = await api('/api/login', { method: 'POST', body: { username: '李老师', password: 'abc123456' } });
  eq(r.status, 200, '状态码');
  assert(r.body.token && r.body.token !== tokenA, '应签发不同令牌');
  tokenA2 = r.body.token;
  return '令牌已轮换';
});

await check('无令牌访问受保护接口 → 401', async () => {
  const r = await api('/api/me');
  eq(r.status, 401, '状态码');
  return r.body.error;
});

await check('伪造令牌 → 401', async () => {
  const r = await api('/api/me', { token: 'f'.repeat(64) });
  eq(r.status, 401, '状态码');
  return '无效令牌被拒';
});

await check('GET /api/me 返回账号信息，尚无数据包', async () => {
  const r = await api('/api/me', { token: tokenA2 });
  eq(r.status, 200, '状态码');
  eq(r.body.user.username, '李老师', '账号');
  eq(r.body.blob, null, '未上传时 blob 应为 null');
  return `令牌有效期 ${r.body.sessionTtlDays} 天`;
});

/* ============================ [4] 数据包往返 ============================ */

console.log('\n[4] 数据包上传 / 下载往返');

const payloadA = makePayload('李老师', 24);

await check('未上传时下载 → 404', async () => {
  const r = await api('/api/blob', { token: tokenA2 });
  eq(r.status, 404, '状态码');
  return r.body.error;
});

await check('上传 24 名学生的数据包 → 200', async () => {
  const r = await api('/api/blob', { method: 'PUT', token: tokenA2, body: { payload: payloadA } });
  eq(r.status, 200, '状态码');
  assert(r.body.bytes > 0, '应返回字节数');
  return `${(r.body.bytes / 1024).toFixed(1)} KB`;
});

await check('下载回来与原包逐字节一致', async () => {
  const r = await api('/api/blob', { token: tokenA2 });
  eq(r.status, 200, '状态码');
  eq(r.body.payload, payloadA, '数据包内容');
  return '深比较通过';
});

await check('/api/me 能拿到数据包概览', async () => {
  const r = await api('/api/me', { token: tokenA2 });
  assert(r.body.blob && r.body.blob.savedAt, '应有 savedAt');
  assert(r.body.blob.summary.includes('24 名学生'), `概览应含学生数，实际「${r.body.blob.summary}」`);
  return r.body.blob.summary;
});

await check('覆盖上传后内容随之更新', async () => {
  const payload2 = makePayload('李老师', 45);
  await api('/api/blob', { method: 'PUT', token: tokenA2, body: { payload: payload2 } });
  const r = await api('/api/blob', { token: tokenA2 });
  eq(r.body.payload.data.reciteRecords[0].students.length, 45, '学生数应为 45');
  return '整包替换生效';
});

await check('空 payload 被拒 → 400', async () => {
  const r = await api('/api/blob', { method: 'PUT', token: tokenA2, body: { payload: null } });
  eq(r.status, 400, '状态码');
  return r.body.error;
});

/* ============================ [5] 用户隔离与越权 ============================ */

console.log('\n[5] 用户隔离与越权防护');

let tokenB = '';
let userB = null;

await check('第二个账号注册成功，且不是管理员', async () => {
  const r = await api('/api/register', { method: 'POST', body: { username: '王老师', password: 'def456789', invite: INVITE } });
  eq(r.status, 201, '状态码');
  tokenB = r.body.token;
  userB = r.body.user;
  eq(userB.isAdmin, false, '第二个账号不应是管理员');
  return `${userB.username} · 普通账号`;
});

await check('B 读自己的数据包 → 404（拿不到 A 的）', async () => {
  const r = await api('/api/blob', { token: tokenB });
  eq(r.status, 404, '状态码');
  return '看不到别人的数据';
});

await check('B 上传自己的包后，A 的内容不受影响', async () => {
  const payloadB = makePayload('王老师', 38);
  await api('/api/blob', { method: 'PUT', token: tokenB, body: { payload: payloadB } });
  const ra = await api('/api/blob', { token: tokenA2 });
  const rb = await api('/api/blob', { token: tokenB });
  eq(ra.body.payload.data.settings.name, '李老师', 'A 的包应仍是自己的');
  eq(rb.body.payload.data.settings.name, '王老师', 'B 的包应是自己的');
  return '两人数据互不串台';
});

await check('B 访问管理员接口 → 403', async () => {
  const r = await api('/api/admin/users', { token: tokenB });
  eq(r.status, 403, '状态码');
  return r.body.error;
});

await check('B 不能通过管理员接口偷看 A 的包 → 403', async () => {
  const r = await api(`/api/admin/blob/${userA.id}`, { token: tokenB });
  eq(r.status, 403, '状态码');
  return '越权被拦';
});

await check('管理员能列出全部账号与数据概览', async () => {
  const r = await api('/api/admin/users', { token: tokenA2 });
  eq(r.status, 200, '状态码');
  eq(r.body.users.length, 2, '账号数');
  const names = r.body.users.map(u => u.username);
  // 不假设排序规则（中文按 UTF-16 码位排，不是拼音），只校验集合成员
  assert(names.includes('李老师') && names.includes('王老师'), `账号集合应含李老师与王老师，实际 ${JSON.stringify(names)}`);
  const wang = r.body.users.find(u => u.username === '王老师');
  assert(wang.blob && wang.blob.bytes > 0, '应带数据包概览');
  assert(wang.blob.summary.includes('38 名学生'), '概览应含学生数');
  return `2 个账号 · 王老师 ${(wang.blob.bytes / 1024).toFixed(1)} KB`;
});

await check('管理员能取到指定账号的完整数据包', async () => {
  const r = await api(`/api/admin/blob/${userA.id}`, { token: tokenA2 });
  eq(r.status, 200, '状态码');
  eq(r.body.username, '李老师', '账号');
  eq(r.body.payload.data.settings.name, '李老师', '内容归属');
  return '汇总查看可用';
});

await check('GET /api/admin/stats 返回磁盘概览', async () => {
  const r = await api('/api/admin/stats', { token: tokenA2 });
  eq(r.status, 200, '状态码');
  eq(r.body.users, 2, '用户数');
  eq(r.body.blobCount, 2, '数据包数');
  return `${r.body.users} 账号 · ${r.body.blobCount} 包 · ${(r.body.blobBytes / 1024).toFixed(1)} KB`;
});

await check('访问不存在的用户数据包 → 404', async () => {
  const r = await api('/api/admin/blob/00000000-0000-0000-0000-000000000000', { token: tokenA2 });
  eq(r.status, 404, '状态码');
  return r.body.error;
});

/* ============================ [6] 体积与登出 ============================ */

console.log('\n[6] 体积上限与登出');

await check('超过单包上限 → 413 且有友好提示', async () => {
  const huge = { payload: { padding: 'x'.repeat(2 * 1024 * 1024) } };
  const r = await api('/api/blob', { method: 'PUT', token: tokenA2, body: huge });
  eq(r.status, 413, '状态码');
  assert(r.body.error.includes('1 MB'), `提示应含上限值，实际：${r.body.error}`);
  return r.body.error;
});

await check('超限被拒后，原数据包完好无损', async () => {
  const r = await api('/api/blob', { token: tokenA2 });
  eq(r.status, 200, '状态码');
  eq(r.body.payload.data.reciteRecords[0].students.length, 45, '应仍是 45 人那版');
  return '未被打坏';
});

await check('登出后令牌立即失效 → 401', async () => {
  const out = await api('/api/logout', { method: 'POST', token: tokenB });
  eq(out.status, 200, '登出状态码');
  const after = await api('/api/me', { token: tokenB });
  eq(after.status, 401, '登出后状态码');
  return '令牌已吊销';
});

await check('登出 A 的旧令牌，不影响 A 的新令牌', async () => {
  await api('/api/logout', { method: 'POST', token: tokenA });
  eq((await api('/api/me', { token: tokenA })).status, 401, '旧令牌应失效');
  eq((await api('/api/me', { token: tokenA2 })).status, 200, '新令牌应仍有效');
  return '多设备互不影响';
});

/* ============================ [7] 重启后数据仍在 ============================ */

console.log('\n[7] 重启后数据仍在（模拟服务器重启）');

await check('关闭服务后用同一数据目录重启', async () => {
  await new Promise(r => app.server.close(r));
  app = await startServer({
    port: 0, host: '127.0.0.1', dataDir, staticDir,
    inviteCode: INVITE, maxBlobMB: 1, logRequests: false,
  });
  base = `http://127.0.0.1:${app.port}`;
  const h = await api('/api/health');
  eq(h.status, 200, '新实例健康检查');
  return `新端口 ${app.port}`;
});

await check('账号与密码在重启后依然可用', async () => {
  const r = await api('/api/login', { method: 'POST', body: { username: '李老师', password: 'abc123456' } });
  eq(r.status, 200, '状态码');
  return '账号持久化正常';
});

await check('重启后数据包内容完好', async () => {
  const r = await api('/api/login', { method: 'POST', body: { username: '李老师', password: 'abc123456' } });
  const blob = await api('/api/blob', { token: r.body.token });
  eq(blob.status, 200, '状态码');
  eq(blob.body.payload.data.reciteRecords[0].students.length, 45, '学生数');
  eq(blob.body.payload.data.settings.name, '李老师', '归属');
  return '45 名学生数据完整还原';
});

await check('重启后旧令牌仍有效（会话也持久化）', async () => {
  const r = await api('/api/me', { token: tokenA2 });
  eq(r.status, 200, '状态码');
  eq(r.body.user.username, '李老师', '账号');
  return '会话跨重启保留';
});

await check('重启后管理员身份不丢', async () => {
  const r = await api('/api/admin/users', { token: tokenA2 });
  eq(r.status, 200, '状态码');
  return '管理员权限保留';
});

/* ============================ 收尾 ============================ */

console.log('\n[8] 关闭注册后的行为');

await check('清空 INVITE_CODE 后注册被关闭，老账号仍可登录', async () => {
  await new Promise(r => app.server.close(r));
  app = await startServer({
    port: 0, host: '127.0.0.1', dataDir, staticDir,
    inviteCode: '', maxBlobMB: 1, logRequests: false,
  });
  base = `http://127.0.0.1:${app.port}`;

  const reg = await api('/api/register', { method: 'POST', body: { username: '新老师', password: 'xyz123456', invite: '' } });
  eq(reg.status, 403, '注册状态码');
  const login = await api('/api/login', { method: 'POST', body: { username: '李老师', password: 'abc123456' } });
  eq(login.status, 200, '老账号登录状态码');
  return '注册关闭 · 登录正常';
});

await new Promise(r => app.server.close(r));
rmSync(root, { recursive: true, force: true });

console.log('\n──────────────────────────────────────────────');
if (fail === 0) {
  console.log(`✅ 全部通过（${pass} 项）\n`);
} else {
  console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`);
  for (const f of failures) console.log(`   · ${f}`);
  console.log('');
}
process.exit(fail === 0 ? 0 : 1);
