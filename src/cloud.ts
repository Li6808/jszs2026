/* ============================================================
   云端同步 —— 前端客户端
   ------------------------------------------------------------
   【默认不启用】这个模块不影响任何本地功能。
   没有填写服务器地址时，应用完全按原来那样跑（数据只在 localStorage）。

   启用后它做的是「整包搬运」：
     上传 = 把当前全部数据打包成一份备份 JSON，交给服务器存着
     拉取 = 从服务器取回那份 JSON，直接走已有的 parseBackup + applyBackup

   配置项单独存放，不混进 AppData —— 否则换台设备导入备份时
   会把别人的服务器地址和登录态一起带过去。
   ============================================================ */

import { buildBackup, parseBackup } from './backup';
import type { BackupFile } from './backup';

const K_SERVER = 'teacher_cloud_server';
const K_TOKEN = 'teacher_cloud_token';
const K_USER = 'teacher_cloud_user';
const K_META = 'teacher_cloud_meta';

/** 普通请求超时 */
const TIMEOUT_MS = 20000;
/** 上传/下载超时（数据包可能有好几 MB，手机流量下要留足） */
const TRANSFER_TIMEOUT_MS = 90000;

export interface CloudUser {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface CloudBlobMeta {
  savedAt: string;
  bytes: number;
  summary: string;
  exportedAt: string;
}

export interface CloudStatus {
  user: CloudUser;
  blob: CloudBlobMeta | null;
  sessionTtlDays: number;
}

export interface CloudLocalMeta {
  lastUploadAt: string | null;
  lastDownloadAt: string | null;
  lastSummary: string;
  lastBytes: number;
}

/** 网络 / 服务端错误，message 已经是可直接展示给用户的中文 */
export class CloudError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
  }
}

/* ============================ 配置读写 ============================ */

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* 隐私模式下忽略 */ }
}
function remove(key: string) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

/** 从地址里取出主机名（去掉协议、路径、端口） */
function hostOf(input: string): string {
  return String(input || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^\/+/, '')
    .split('/')[0]
    .split(':')[0]
    .toLowerCase();
}

/**
 * 是不是「局域网 / 本机」地址。
 * 这类地址用 http 就行（数据不出内网），其它地址一律按 https 处理。
 */
export function isLanAddress(input: string): boolean {
  const host = hostOf(input);
  if (!host) return false;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
    || host.endsWith('.local')
    || /^192\.168\./.test(host)
    || /^10\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

/**
 * 把用户随手输入的地址规整成可用的形式。
 * 只写 IP/域名时补协议：局域网/本机用 http，其余一律 https
 * —— 公网上跑明文 http 会把密码暴露在网络里。
 */
export function normalizeServerUrl(input: string): string {
  let s = String(input || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  s = s.replace(/^\/+/, '');
  return `${isLanAddress(s) ? 'http' : 'https'}://${s}`;
}

/* -------------------- 同源服务器自动探测 -------------------- */

export interface SameOriginInfo {
  origin: string;
  version: string;
  registrationOpen: boolean;
  /** 服务端自己是局域网监听（自己电脑当服务器） */
  lan: boolean;
}

/**
 * 探测「当前这个页面是不是由一台教师助手服务器托管的」。
 *
 * 典型场景：老师双击启动脚本后，浏览器打开的就是自己电脑上的服务
 * （形如 http://192.168.1.8:8787），手机连同一个 Wi-Fi 打开也是同一个地址。
 * 这时前端和后端同源，不需要填任何地址，点一下就能用。
 *
 * 判定必须严格：静态托管平台常把不存在的路径回落成 index.html 并返回 200，
 * 只要看到 200 就认定「有服务器」会误判成别人的静态站。
 * 所以这里要求响应体确实是本服务端的 health 结构。
 */
export async function probeSameOrigin(): Promise<SameOriginInfo | null> {
  if (typeof window === 'undefined' || typeof fetch === 'undefined') return null;
  const { protocol, origin } = window.location;
  // file:// 打开（直接把 html 双击打开）没有同源服务器可言
  if (protocol !== 'http:' && protocol !== 'https:') return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${origin}/api/health`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null) as
      { app?: string; version?: string; registrationOpen?: boolean; lan?: boolean } | null;
    if (!data || data.app !== 'teacher-assistant-cloud') return null;
    return {
      origin,
      version: String(data.version || ''),
      registrationOpen: !!data.registrationOpen,
      lan: !!data.lan,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function getCloudServer(): string {
  return read(K_SERVER) || '';
}

export function setCloudServer(url: string) {
  const norm = normalizeServerUrl(url);
  if (norm) write(K_SERVER, norm);
  else remove(K_SERVER);
}

export function isCloudConfigured(): boolean {
  return !!getCloudServer();
}

export function getCloudUser(): CloudUser | null {
  const raw = read(K_USER);
  if (!raw) return null;
  try { return JSON.parse(raw) as CloudUser; } catch { return null; }
}

export function isCloudLoggedIn(): boolean {
  return !!read(K_TOKEN) && !!getCloudUser();
}

export function getCloudMeta(): CloudLocalMeta {
  const raw = read(K_META);
  const fallback: CloudLocalMeta = { lastUploadAt: null, lastDownloadAt: null, lastSummary: '', lastBytes: 0 };
  if (!raw) return fallback;
  try { return { ...fallback, ...(JSON.parse(raw) as Partial<CloudLocalMeta>) }; } catch { return fallback; }
}

function patchCloudMeta(patch: Partial<CloudLocalMeta>) {
  write(K_META, JSON.stringify({ ...getCloudMeta(), ...patch }));
}

/** 断开云端（清掉登录态；服务器上的数据不动） */
export function clearCloudSession() {
  remove(K_TOKEN);
  remove(K_USER);
}

/** 彻底忘掉云端（含服务器地址） */
export function forgetCloud() {
  clearCloudSession();
  remove(K_SERVER);
  remove(K_META);
}

/* ============================ 请求封装 ============================ */

interface ReqOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  timeout?: number;
  base?: string;
}

async function request<T>(path: string, opts: ReqOptions = {}): Promise<T> {
  const base = opts.base || getCloudServer();
  if (!base) throw new CloudError('还没有填写云端服务器地址。');

  const headers: Record<string, string> = {};
  const token = opts.token !== undefined ? opts.token : read(K_TOKEN);
  if (token) headers.Authorization = `Bearer ${token}`;

  let payload: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout ?? TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(base + path, {
      method: opts.method || 'GET',
      headers,
      body: payload,
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = (e as { name?: string })?.name === 'AbortError';
    if (aborted) throw new CloudError('连接超时。请检查服务器地址是否正确、服务器是否在运行。');
    throw new CloudError('连不上服务器。请确认地址填对、服务器已启动、手机与服务器网络互通。');
  }
  clearTimeout(timer);

  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { /* 可能是反向代理返回的 HTML 错误页 */ }
  }

  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error;
    if (msg) throw new CloudError(msg, res.status);
    if (res.status === 404) {
      throw new CloudError('服务器上找不到这个接口。请确认地址填的是服务器根地址（不要带 /api）。', 404);
    }
    if (res.status >= 500) throw new CloudError(`服务器出错了（${res.status}）。稍后再试。`, res.status);
    throw new CloudError(`请求失败（${res.status}）。`, res.status);
  }

  return data as T;
}

/* ============================ 接口 ============================ */

/** 测试连通性：不登录也能调，用来验证地址是否填对 */
export async function cloudPing(serverUrl?: string): Promise<{ version: string; registrationOpen: boolean }> {
  const r = await request<{ ok: boolean; version: string; registrationOpen: boolean }>(
    '/api/health', { base: serverUrl ? normalizeServerUrl(serverUrl) : undefined, token: null },
  );
  return { version: r.version, registrationOpen: !!r.registrationOpen };
}

export async function cloudRegister(username: string, password: string, invite: string): Promise<CloudUser> {
  const r = await request<{ token: string; user: CloudUser }>('/api/register', {
    method: 'POST',
    token: null,
    body: { username, password, invite },
  });
  write(K_TOKEN, r.token);
  write(K_USER, JSON.stringify(r.user));
  return r.user;
}

export async function cloudLogin(username: string, password: string): Promise<CloudUser> {
  const r = await request<{ token: string; user: CloudUser }>('/api/login', {
    method: 'POST',
    token: null,
    body: { username, password },
  });
  write(K_TOKEN, r.token);
  write(K_USER, JSON.stringify(r.user));
  return r.user;
}

export async function cloudLogout(): Promise<void> {
  try { await request('/api/logout', { method: 'POST' }); } catch { /* 服务器不通也要能本地登出 */ }
  clearCloudSession();
}

/** 当前登录状态 + 服务器上那份数据的概览 */
export async function cloudStatus(): Promise<CloudStatus> {
  const r = await request<CloudStatus>('/api/me');
  write(K_USER, JSON.stringify(r.user));
  return r;
}

/** 把当前全部数据上传到云端 */
export async function cloudUpload(): Promise<CloudBlobMeta> {
  const bak: BackupFile = buildBackup();
  const r = await request<{ savedAt: string; bytes: number }>('/api/blob', {
    method: 'PUT',
    timeout: TRANSFER_TIMEOUT_MS,
    body: { payload: bak },
  });
  patchCloudMeta({
    lastUploadAt: r.savedAt,
    lastSummary: bak.summary,
    lastBytes: r.bytes,
  });
  return { savedAt: r.savedAt, bytes: r.bytes, summary: bak.summary, exportedAt: bak.exportedAt };
}

/** 从云端取回数据包（已校验格式，可直接交给 applyBackup） */
export async function cloudDownload(): Promise<{ file: BackupFile; savedAt: string }> {
  const r = await request<{ savedAt: string; payload: unknown }>('/api/blob', {
    timeout: TRANSFER_TIMEOUT_MS,
  });
  const parsed = parseBackup(JSON.stringify(r.payload));
  if (!parsed.ok || !parsed.file) {
    throw new CloudError(`云端那份数据无法识别：${parsed.error || '格式不正确'}`);
  }
  patchCloudMeta({ lastDownloadAt: new Date().toISOString() });
  return { file: parsed.file, savedAt: r.savedAt };
}

/* ---------------------- 管理员：汇总查看 ---------------------- */

export interface AdminUserRow {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  blob: CloudBlobMeta | null;
}

/** 管理员列出所有账号与各自数据概览（服务器没给管理员权限时会抛错） */
export async function cloudAdminUsers(): Promise<AdminUserRow[]> {
  const r = await request<{ users: AdminUserRow[] }>('/api/admin/users');
  return r.users;
}

/** 管理员导出某位老师的完整数据包 */
export async function cloudAdminFetchBlob(userId: string): Promise<BackupFile> {
  const r = await request<{ payload: unknown }>(`/api/admin/blob/${encodeURIComponent(userId)}`, {
    timeout: TRANSFER_TIMEOUT_MS,
  });
  const parsed = parseBackup(JSON.stringify(r.payload));
  if (!parsed.ok || !parsed.file) {
    throw new CloudError(`该账号的数据无法识别：${parsed.error || '格式不正确'}`);
  }
  return parsed.file;
}

/* ============================ 展示用工具 ============================ */

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 距离上次上传的天数；没上传过返回 null */
export function daysSinceUpload(): number | null {
  const { lastUploadAt } = getCloudMeta();
  if (!lastUploadAt) return null;
  return Math.floor((Date.now() - new Date(lastUploadAt).getTime()) / 86400000);
}
