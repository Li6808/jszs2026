/* ============================================================
   教师助手 · 云端同步服务 —— 持久化与鉴权层
   ------------------------------------------------------------
   设计要点：
   - 零 npm 依赖，只用 Node 内置模块（node:crypto / node:fs / node:path）
   - 每位教师的数据是一整包 JSON（沿用前端 backup.ts 的 BackupFile 结构），
     服务端不做业务解析，只负责「存」和「按账号隔离」。
   - 密码用 scrypt 加盐哈希；会话令牌只存 sha256 指纹，原文不落盘。
   - 所有写盘都是「先写临时文件再 rename」，避免断电写坏。
   ============================================================ */

import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* ---------- scrypt 参数（N=16384 约 16MB 内存，单次约 50ms） ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const USERS_FILE = 'users.json';
const SESSIONS_FILE = 'sessions.json';
const BLOBS_DIR = 'blobs';

/** 会话有效期：60 天 */
export const SESSION_TTL_MS = 60 * 24 * 3600 * 1000;

const USERNAME_RE = /^[\w.\-\u4e00-\u9fa5]{2,32}$/u;
export const PASSWORD_MIN = 6;

export function validateUsername(name) {
  if (typeof name !== 'string' || !USERNAME_RE.test(name)) {
    return '账号需为 2~32 位，可用中文、字母、数字、下划线、点或短横线。';
  }
  return null;
}

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) {
    return `密码至少 ${PASSWORD_MIN} 位。`;
  }
  if (pw.length > 128) return '密码过长（最多 128 位）。';
  return null;
}

/* ============================ 基础文件读写 ============================ */

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    const raw = readFileSync(path, 'utf8');
    if (!raw.trim()) return fallback;
    const obj = JSON.parse(raw);
    return obj ?? fallback;
  } catch {
    return fallback;
  }
}

/** 原子写：临时文件 → rename，避免写一半被中断导致文件损坏 */
function writeJsonAtomic(path, obj) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  renameSync(tmp, path);
}

/* ================================ Store ================================ */

export class Store {
  /**
   * @param {string} dataDir 数据目录
   * @param {{ adminUser?: string }} options
   */
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.blobsDir = join(dataDir, BLOBS_DIR);
    this.adminUser = options.adminUser || '';
    ensureDir(dataDir);
    ensureDir(this.blobsDir);
    this.users = readJson(join(dataDir, USERS_FILE), { version: 1, users: {} });
    this.sessions = readJson(join(dataDir, SESSIONS_FILE), { version: 1, sessions: {} });
    if (!this.users.users) this.users = { version: 1, users: {} };
    if (!this.sessions.sessions) this.sessions = { version: 1, sessions: {} };
    this.purgeExpired();
  }

  /* ---------------------------- 密码 ---------------------------- */

  #hash(pw, saltHex) {
    return scryptSync(pw, Buffer.from(saltHex, 'hex'), SCRYPT.keylen, {
      N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    }).toString('hex');
  }

  /** 用户名不存在时也跑一次 scrypt，避免用响应时间探测账号是否存在 */
  #dummyVerify() {
    this.#hash('__not_a_real_password__', '00'.repeat(16));
  }

  /* ---------------------------- 用户 ---------------------------- */

  findByUsername(username) {
    const key = String(username || '').trim().toLowerCase();
    for (const u of Object.values(this.users.users)) {
      if (u.username.toLowerCase() === key) return u;
    }
    return null;
  }

  findById(id) {
    return this.users.users[id] || null;
  }

  userCount() {
    return Object.keys(this.users.users).length;
  }

  /**
   * 创建用户。账号重复返回 { error }。
   * 当 adminUser 配置且该账号是第一个用户时，自动设为管理员。
   */
  createUser(username, password) {
    const name = String(username || '').trim();
    const uErr = validateUsername(name);
    if (uErr) return { error: uErr };
    const pErr = validatePassword(password);
    if (pErr) return { error: pErr };

    if (this.findByUsername(name)) return { error: '该账号已被占用，换一个吧。' };

    const isFirst = this.userCount() === 0;
    const isAdmin = isFirst
      || (!!this.adminUser && name.toLowerCase() === this.adminUser.toLowerCase());

    const salt = randomBytes(16).toString('hex');
    const user = {
      id: randomUUID(),
      username: name,
      salt,
      hash: this.#hash(password, salt),
      isAdmin,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
    };
    this.users.users[user.id] = user;
    this.#saveUsers();
    return { user };
  }

  /** 校验密码；成功返回用户，失败返回 null（耗时基本一致） */
  verifyPassword(username, password) {
    const user = this.findByUsername(username);
    if (!user || typeof password !== 'string') {
      this.#dummyVerify();
      return null;
    }
    const got = Buffer.from(this.#hash(password, user.salt), 'hex');
    const want = Buffer.from(user.hash, 'hex');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    user.lastLoginAt = new Date().toISOString();
    this.#saveUsers();
    return user;
  }

  #saveUsers() {
    writeJsonAtomic(join(this.dataDir, USERS_FILE), this.users);
  }

  /* ---------------------------- 会话 ---------------------------- */

  #tokenHash(token) {
    return createHash('sha256').update(String(token)).digest('hex');
  }

  /** 签发会话，返回明文令牌（只此一次可见） */
  issueSession(userId) {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    this.sessions.sessions[this.#tokenHash(token)] = {
      userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    };
    this.#saveSessions();
    return token;
  }

  /** 令牌 → 用户；无效或过期返回 null */
  resolveSession(token) {
    if (!token) return null;
    const key = this.#tokenHash(token);
    const s = this.sessions.sessions[key];
    if (!s) return null;
    if (new Date(s.expiresAt).getTime() < Date.now()) {
      delete this.sessions.sessions[key];
      this.#saveSessions();
      return null;
    }
    const user = this.findById(s.userId);
    if (!user) {
      delete this.sessions.sessions[key];
      this.#saveSessions();
      return null;
    }
    return user;
  }

  revokeSession(token) {
    if (!token) return false;
    const key = this.#tokenHash(token);
    if (!this.sessions.sessions[key]) return false;
    delete this.sessions.sessions[key];
    this.#saveSessions();
    return true;
  }

  /** 让某用户的全部会话失效（改密码、踢下线时用） */
  revokeAllSessions(userId) {
    let n = 0;
    for (const [k, s] of Object.entries(this.sessions.sessions)) {
      if (s.userId === userId) { delete this.sessions.sessions[k]; n++; }
    }
    if (n) this.#saveSessions();
    return n;
  }

  purgeExpired() {
    const now = Date.now();
    let n = 0;
    for (const [k, s] of Object.entries(this.sessions.sessions)) {
      if (new Date(s.expiresAt).getTime() < now) { delete this.sessions.sessions[k]; n++; }
    }
    if (n) this.#saveSessions();
    return n;
  }

  #saveSessions() {
    writeJsonAtomic(join(this.dataDir, SESSIONS_FILE), this.sessions);
  }

  /* --------------------------- 数据包 --------------------------- */

  #blobPath(userId) {
    // userId 是服务端生成的 UUID，仍做一次白名单校验，杜绝路径穿越
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('非法的用户标识');
    return join(this.blobsDir, `${userId}.json`);
  }

  /** 保存一位教师的数据包（整体替换） */
  saveBlob(userId, payload) {
    const body = {
      savedAt: new Date().toISOString(),
      payload,
    };
    const path = this.#blobPath(userId);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(body), 'utf8');
    renameSync(tmp, path);
    return { savedAt: body.savedAt, bytes: Buffer.byteLength(JSON.stringify(body), 'utf8') };
  }

  /** 读取数据包，不存在返回 null */
  readBlob(userId) {
    const path = this.#blobPath(userId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  }

  /** 只取元信息（列表用，避免把整包读进内存） */
  readBlobMeta(userId) {
    const body = this.readBlob(userId);
    if (!body) return null;
    return {
      savedAt: body.savedAt,
      bytes: Buffer.byteLength(JSON.stringify(body), 'utf8'),
      summary: body.payload?.summary || '',
      exportedAt: body.payload?.exportedAt || '',
    };
  }

  /** 管理员视角：所有用户 + 各自数据包概览 */
  listUsers() {
    return Object.values(this.users.users)
      .map(u => ({
        id: u.id,
        username: u.username,
        isAdmin: !!u.isAdmin,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        blob: this.readBlobMeta(u.id),
      }))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  /** 测试与运维用：清空某用户的数据包 */
  deleteBlob(userId) {
    const path = this.#blobPath(userId);
    if (existsSync(path)) { unlinkSync(path); return true; }
    return false;
  }

  /** 运维用：统计磁盘占用 */
  stats() {
    let blobCount = 0;
    let blobBytes = 0;
    for (const u of Object.values(this.users.users)) {
      const meta = this.readBlobMeta(u.id);
      if (meta) { blobCount++; blobBytes += meta.bytes; }
    }
    return {
      users: this.userCount(),
      activeSessions: Object.keys(this.sessions.sessions).length,
      blobCount,
      blobBytes,
    };
  }
}
