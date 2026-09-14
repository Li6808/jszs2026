/* ============================================================
   云端同步 —— 前后端联调测试
   ------------------------------------------------------------
   起一个真实的云端服务，然后让 src/cloud.ts 这个浏览器客户端
   走真实 HTTP 去连它，把「上传 → 换设备 → 拉取还原」全流程跑通。

   这一步能抓到单测抓不到的问题：地址拼接、字段名对不上、
   JSON 结构错位、数据包格式校验失败等。

   运行：
     npx esbuild cloud-smoke.mjs --bundle --platform=node --format=esm \
       --outfile=cloud-smoke.bundle.mjs --loader:.ts=ts --loader:.tsx=tsx \
       --jsx=automatic --packages=external
     node cloud-smoke.bundle.mjs
   ============================================================ */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './server/index.mjs';

/* ---- localStorage 打桩（要在调用任何函数前装好）---- */
const mem = new Map();
globalThis.localStorage = {
  get length() { return mem.size; },
  key: i => Array.from(mem.keys())[i] ?? null,
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: k => { mem.delete(k); },
  clear: () => mem.clear(),
};

const cloud = await import('./src/cloud.ts');
const { getData, setData } = await import('./src/storage.ts');
const { applyBackup, buildBackup } = await import('./src/backup.ts');

let pass = 0, fail = 0;
const failures = [];
async function check(name, fn) {
  try {
    const d = await fn();
    console.log(`  ok   ${name}${d ? `  — ${d}` : ''}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${name}\n         ${e?.message || e}`);
    failures.push(name);
    fail++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) {
  if (String(a) !== String(b)) throw new Error(`${msg || '不相等'}｜实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);
}
/** 断言某次调用抛出 CloudError 且文案包含关键字 */
async function expectError(fn, keyword) {
  try {
    await fn();
  } catch (e) {
    if (e.name !== 'CloudError') throw new Error(`应抛 CloudError，实际抛了 ${e.name}`);
    assert(e.message.includes(keyword), `错误文案应含「${keyword}」，实际「${e.message}」`);
    return e.message;
  }
  throw new Error('本应抛错，但正常返回了');
}

/* ---------------- 起真实服务 ---------------- */

const root = mkdtempSync(join(tmpdir(), 'ta-cloudclient-'));
const INVITE = 'invite-test-xyz';
const app = await startServer({
  port: 0, host: '127.0.0.1',
  dataDir: join(root, 'data'),
  inviteCode: INVITE,
  maxBlobMB: 8,
  logRequests: false,
});
const BASE = `http://127.0.0.1:${app.port}`;

/** 造一份有份量的真实数据：1 个班 / 30 人 / 20 篇，含背诵标记 */
function seedLocalData(teacherName, students, poems) {
  const stu = Array.from({ length: students }, (_, i) => ({
    id: `stu_${i}`, no: i + 1, name: `学生${i + 1}`, gender: i % 2 ? '女' : '男', className: '4班',
  }));
  const pms = Array.from({ length: poems }, (_, i) => ({
    id: `poem_${i}`, title: `篇目${i + 1}`, author: '佚名', type: '诗',
    req: 'both', volume: '八年级上册', order: i + 1, active: true,
  }));
  const marks = {};
  for (const s of stu) {
    marks[s.id] = {};
    for (let i = 0; i < 5; i++) marks[s.id][`poem_${i}`] = { status: 'recited', reciteDate: '2026-09-01' };
  }
  setData({
    settings: { name: teacherName, schoolName: '测试中学', moduleOrder: [], periodNames: [] },
    history: [], salaries: [], duties: [], homeworkRecords: [],
    reciteRecords: [{
      id: 'rec_cloud', classFullName: '初二(4)班', classShortName: '4班', grade: '初二',
      poems: pms, students: stu, marks, createdAt: '', updatedAt: '',
    }],
  });
}

console.log('\n══════ 云端同步 · 前后端联调测试 ══════\n');
console.log(`  服务已启动：${BASE}\n`);

/* ======================= [1] 地址规整 ======================= */

console.log('[1] 服务器地址规整（防止把 http 明文暴露到公网）');

await check('只填 IP:端口 → 自动补 http（内网）', () => {
  eq(cloud.normalizeServerUrl('192.168.1.8:8787'), 'http://192.168.1.8:8787');
  eq(cloud.normalizeServerUrl('127.0.0.1:8787'), 'http://127.0.0.1:8787');
  return '内网/本机走 http';
});

await check('只填域名 → 自动补 https', () => {
  eq(cloud.normalizeServerUrl('jiaoshi.example.com'), 'https://jiaoshi.example.com');
  eq(cloud.normalizeServerUrl('jiaoshi.example.com:8443'), 'https://jiaoshi.example.com:8443');
  return '公网默认强制 https';
});

await check('已带协议 / 结尾斜杠 / 多余空格都能容错', () => {
  eq(cloud.normalizeServerUrl('https://a.com/'), 'https://a.com');
  eq(cloud.normalizeServerUrl('  http://a.com//  '), 'http://a.com');
  eq(cloud.normalizeServerUrl(''), '');
  return '容错正常';
});

/* ======================= [2] 未配置时不影响本地 ======================= */

console.log('\n[2] 未配置服务器时，应完全不影响本地使用');

await check('未填地址时任何云端请求都给出明确提示', async () => {
  eq(cloud.isCloudConfigured(), false, '应视为未配置');
  return expectError(() => cloud.cloudPing(), '还没有填写云端服务器地址');
});

await check('未配置时 buildBackup 照常可用（本地功能不受影响）', () => {
  seedLocalData('李老师', 30, 20);
  const bak = buildBackup();
  eq(bak.app, 'teacher-assistant-backup');
  eq(bak.data.reciteRecords.length, 1);
  return `本地导出正常 · ${bak.summary}`;
});

/* ======================= [3] 配置与连通性 ======================= */

console.log('\n[3] 配置服务器并测试连通性');

await check('写入服务器地址并持久化', () => {
  cloud.setCloudServer(BASE);
  eq(cloud.getCloudServer(), BASE);
  eq(cloud.isCloudConfigured(), true);
  return cloud.getCloudServer();
});

await check('cloudPing 能读到服务版本与注册状态', async () => {
  const r = await cloud.cloudPing();
  // 不锁死具体版本号，否则每次发版都要回来改测试
  assert(/^\d+\.\d+\.\d+$/.test(r.version), `版本号格式不对：${r.version}`);
  eq(r.registrationOpen, true, '应显示注册开启');
  return `服务 v${r.version} · 注册开启`;
});

/* ---------- 同源服务器探测（自己电脑当服务器的自动识别） ---------- */

/** 临时把 window.location 换成指定来源，跑完还原 */
async function withOrigin(location, fn) {
  const prev = globalThis.window;
  globalThis.window = { location };
  try { return await fn(); } finally { globalThis.window = prev; }
}

await check('probeSameOrigin：识别出真服务端，并带回 lan 标识', async () => {
  const info = await withOrigin({ protocol: 'http:', origin: BASE }, () => cloud.probeSameOrigin());
  assert(info, '应识别出同源服务端');
  eq(info.origin, BASE, '来源地址');
  assert(/^\d+\.\d+\.\d+$/.test(info.version), `版本号异常：${info.version}`);
  // 测试服务监听 127.0.0.1，属于「仅本机」，所以不应标成局域网
  eq(info.lan, false, 'loopback 监听不应标为局域网');
  eq(info.registrationOpen, true, '注册状态');
  return `${info.origin} · v${info.version} · lan=${info.lan}`;
});

await check('probeSameOrigin：静态站回落到 index.html 时不误判', async () => {
  // 静态托管平台常把任何未知路径都返回 200 + HTML，
  // 只看状态码就会把别人的静态站当成自己的服务器 —— 这里专门锁住这个误判。
  const fake = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><body>这里不是教师助手服务端</body></html>');
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const port = fake.address().port;
  try {
    const info = await withOrigin(
      { protocol: 'http:', origin: `http://127.0.0.1:${port}` },
      () => cloud.probeSameOrigin(),
    );
    eq(info, null, '200 + HTML 不应被判为服务端');
  } finally {
    await new Promise(r => fake.close(r));
  }
  return '严格校验响应体，不误判静态站';
});

await check('probeSameOrigin：file:// 打开时直接跳过', async () => {
  const info = await withOrigin({ protocol: 'file:', origin: 'null' }, () => cloud.probeSameOrigin());
  eq(info, null, 'file:// 应跳过探测');
  return '本地文件打开不发起探测';
});

await check('probeSameOrigin：服务端结构对但 app 标识不符时也不认', async () => {
  const fake = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, app: 'some-other-app', version: '9.9.9' }));
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const port = fake.address().port;
  try {
    const info = await withOrigin(
      { protocol: 'http:', origin: `http://127.0.0.1:${port}` },
      () => cloud.probeSameOrigin(),
    );
    eq(info, null, 'app 标识不符不应认');
  } finally {
    await new Promise(r => fake.close(r));
  }
  return '靠 app 标识区分同名接口';
});

await check('地址填错时给出「连不上」而不是抛原始异常', async () => {
  return expectError(
    () => cloud.cloudPing('127.0.0.1:1'),
    '连不上服务器',
  );
});

/* ======================= [4] 注册与登录 ======================= */

console.log('\n[4] 注册 / 登录');

await check('注册成功后自动进入登录态', async () => {
  const u = await cloud.cloudRegister('李老师', 'abc123456', INVITE);
  eq(u.username, '李老师', '账号');
  eq(cloud.isCloudLoggedIn(), true, '应处于登录态');
  return `${u.username} · ${u.isAdmin ? '管理员' : '普通账号'}`;
});

await check('邀请码错误 → 友好中文提示', () => {
  return expectError(() => cloud.cloudRegister('张老师', 'abc123456', 'bad-code'), '邀请码不正确');
});

await check('登录状态能正确回报，且服务器上还没有数据', async () => {
  const s = await cloud.cloudStatus();
  eq(s.user.username, '李老师', '账号');
  eq(s.blob, null, '未上传时 blob 应为 null');
  return `令牌有效期 ${s.sessionTtlDays} 天`;
});

await check('密码错误 → 友好中文提示', () => {
  return expectError(() => cloud.cloudLogin('李老师', 'wrong-one'), '账号或密码不正确');
});

/* ======================= [5] 上传 ======================= */

console.log('\n[5] 上传：把本地 30 人 × 20 篇 的数据包送上云');

await check('cloudUpload 成功并回报体积', async () => {
  const meta = await cloud.cloudUpload();
  assert(meta.bytes > 0, '应返回字节数');
  eq(meta.summary, buildBackup().summary, '概览应与本地一致');
  return `${cloud.formatBytes(meta.bytes)} · ${meta.summary}`;
});

await check('上传时间与概览写入本地元信息', async () => {
  const m = cloud.getCloudMeta();
  assert(!!m.lastUploadAt, '应记录上传时间');
  assert(m.lastBytes > 0, '应记录体积');
  eq(cloud.daysSinceUpload(), 0, '距上次上传应为 0 天');
  return new Date(m.lastUploadAt).toLocaleString();
});

await check('服务器侧也能看到这份概览', async () => {
  const s = await cloud.cloudStatus();
  assert(s.blob, '服务器应已有数据包');
  assert(s.blob.summary.includes('30 名学生'), `概览应含学生数，实际「${s.blob.summary}」`);
  return `${cloud.formatBytes(s.blob.bytes)} · ${new Date(s.blob.savedAt).toLocaleString()}`;
});

await check('云端配置项没有被混进数据包（否则换设备会带过去）', async () => {
  const raw = JSON.stringify(buildBackup());
  assert(!raw.includes('teacher_cloud_server'), '数据包里出现了服务器地址！');
  assert(!raw.includes('teacher_cloud_token'), '数据包里出现了登录令牌！');
  return '配置与业务数据严格分离';
});

/* ======================= [6] 换设备：拉取还原 ======================= */

console.log('\n[6] 模拟「换了一台设备」：从云端拉回来');

await check('把本地数据清空，模拟新设备首次打开', () => {
  setData({
    settings: null, history: [], salaries: [], duties: [], homeworkRecords: [], reciteRecords: [],
  });
  const d = getData();
  eq((d.reciteRecords || []).length, 0, '本地应已清空');
  return '本地已置空';
});

await check('cloudDownload 取回并校验格式', async () => {
  const r = await cloud.cloudDownload();
  eq(r.file.app, 'teacher-assistant-backup', 'app 标识');
  eq(r.file.data.reciteRecords.length, 1, '应含 1 个班');
  return `${r.file.summary}`;
});

await check('applyBackup 还原后数据完整回到本地', async () => {
  const r = await cloud.cloudDownload();
  applyBackup(r.file.data, 'replace');
  const d = getData();
  const rec = d.reciteRecords?.[0];
  assert(rec, '应还原出班级');
  eq(rec.students.length, 30, '学生数');
  eq(rec.poems.length, 20, '篇目数');
  eq(rec.classFullName, '初二(4)班', '班级名');
  eq(d.settings?.name, '李老师', '设置里的姓名');
  // 标记也要回来
  const marked = Object.values(rec.marks).reduce((n, m) => n + Object.keys(m).length, 0);
  eq(marked, 30 * 5, '背诵标记数');
  return `30 人 · 20 篇 · ${marked} 个标记全部还原`;
});

await check('拉取时间被记录', () => {
  assert(!!cloud.getCloudMeta().lastDownloadAt, '应记录拉取时间');
  return new Date(cloud.getCloudMeta().lastDownloadAt).toLocaleString();
});

/* ======================= [7] 覆盖上传 ======================= */

console.log('\n[7] 改完数据再传一次，云端应整体替换');

await check('本地加一个班后再上传，云端只有一份且是最新的', async () => {
  seedLocalData('李老师', 45, 20);
  await cloud.cloudUpload();
  const r = await cloud.cloudDownload();
  eq(r.file.data.reciteRecords[0].students.length, 45, '应是最新那版（45 人）');
  return '整包替换，不会堆积多份';
});

/* ======================= [8] 多账号隔离 ======================= */

console.log('\n[8] 另一个老师的数据不会串台');

await check('王老师注册后看到的是空数据（不是李老师的）', async () => {
  const u = await cloud.cloudRegister('王老师', 'def456789', INVITE);
  eq(u.isAdmin, false, '第二个账号不应是管理员');
  const s = await cloud.cloudStatus();
  eq(s.blob, null, '新账号应无数据');
  return '数据互不可见';
});

await check('王老师上传自己的包，李老师的云端数据不受影响', async () => {
  seedLocalData('王老师', 38, 20);
  await cloud.cloudUpload();
  const s = await cloud.cloudStatus();
  assert(s.blob.summary.includes('38 名学生'), `应是王老师自己的（38 人），实际「${s.blob.summary}」`);
  await cloud.cloudLogin('李老师', 'abc123456');
  const s2 = await cloud.cloudStatus();
  assert(s2.blob.summary.includes('45 名学生'), `李老师应仍是 45 人，实际「${s2.blob.summary}」`);
  return '李 45 人 / 王 38 人，各归各的';
});

await check('普通账号调用管理员接口 → 明确被拒', async () => {
  await cloud.cloudLogin('王老师', 'def456789');
  return expectError(() => cloud.cloudAdminUsers(), '管理员权限');
});

await check('管理员能列出全部账号与概览（汇总查看可用）', async () => {
  await cloud.cloudLogin('李老师', 'abc123456');
  const rows = await cloud.cloudAdminUsers();
  eq(rows.length, 2, '账号数');
  const names = rows.map(r => r.username);
  assert(names.includes('李老师') && names.includes('王老师'), `账号集合应含两人，实际 ${JSON.stringify(names)}`);
  const withBlob = rows.filter(r => r.blob);
  eq(withBlob.length, 2, '两人都应已上传');
  return `2 个账号 · 均已有数据包`;
});

await check('管理员能取到某位老师的完整数据包', async () => {
  const rows = await cloud.cloudAdminUsers();
  const wang = rows.find(r => r.username === '王老师');
  const file = await cloud.cloudAdminFetchBlob(wang.id);
  eq(file.data.settings.name, '王老师', '内容归属');
  eq(file.data.reciteRecords[0].students.length, 38, '学生数');
  return '可导出他人数据用于汇总';
});

/* ======================= [9] 登出与令牌 ======================= */

console.log('\n[9] 登出与令牌失效');

await check('登出后本地不再视为已登录', async () => {
  await cloud.cloudLogout();
  eq(cloud.isCloudLoggedIn(), false, '应已登出');
  eq(cloud.getCloudServer(), BASE, '服务器地址应保留，免得每次重填');
  return '地址保留，登录态清空';
});

await check('登出后旧令牌在服务器侧也失效', async () => {
  return expectError(() => cloud.cloudStatus(), '登录已过期');
});

await check('重新登录即可恢复', async () => {
  const u = await cloud.cloudLogin('李老师', 'abc123456');
  eq(u.username, '李老师');
  const s = await cloud.cloudStatus();
  assert(s.blob, '数据仍在');
  return '数据没丢';
});

await check('forgetCloud 会连服务器地址一起忘掉', () => {
  cloud.forgetCloud();
  eq(cloud.isCloudConfigured(), false, '应清空地址');
  eq(cloud.isCloudLoggedIn(), false, '应清空登录态');
  eq(cloud.getCloudMeta().lastUploadAt, null, '应清空元信息');
  return '彻底重置';
});

/* ======================= 收尾 ======================= */

await new Promise(r => app.server.close(r));
rmSync(root, { recursive: true, force: true });

console.log('\n──────────────────────────────────────────────');
if (fail === 0) console.log(`✅ 全部通过（${pass} 项）\n`);
else {
  console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`);
  for (const f of failures) console.log(`   · ${f}`);
  console.log('');
}
process.exit(fail === 0 ? 0 : 1);
