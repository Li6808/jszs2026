/* ============================================================
   全量备份 / 恢复
   所有数据都存在浏览器 localStorage 里 —— 清缓存、换手机就等于全丢。
   这里提供一次性导出 JSON、以及导入恢复(覆盖 / 合并)两种模式。
   ============================================================ */

import { getData, setData, markBackedUp, getCorruptBackup, normalizeModuleOrder, normalizeHiddenModules } from './storage';
import type { AppData } from './types';

const APP_TAG = 'teacher-assistant-backup';
const FORMAT_VERSION = 1;

export interface BackupFile {
  app: string;
  version: number;
  exportedAt: string;
  summary: string;
  data: AppData;
}

function todayStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 课表总节数（schedule.courses 按星期几分组） */
function scheduleCount(st?: AppData['settings']): number {
  const courses = st?.schedule?.courses;
  if (!courses) return 0;
  return Object.values(courses).reduce((s, arr) => s + (arr?.length || 0), 0);
}

/** 生成一份可读的数据概览,导入时给用户确认 */
export function summarize(data: AppData): string {
  const parts: string[] = [];
  parts.push(`请假 ${data.history?.length || 0} 条`);
  parts.push(`课表 ${scheduleCount(data.settings)} 节`);
  parts.push(`工资 ${data.salaries?.length || 0} 条`);
  parts.push(`值班/代课 ${data.duties?.length || 0} 条`);
  parts.push(`作业收缴 ${data.homeworkRecords?.length || 0} 个班`);
  const rec = data.reciteRecords || [];
  const stu = rec.reduce((s, r) => s + (r.students?.length || 0), 0);
  parts.push(`背诵 ${rec.length} 个班 / ${stu} 名学生`);
  parts.push(data.settings ? '设置已含' : '设置未填');
  return parts.join(' · ');
}

export interface ScopeItem {
  icon: string;
  label: string;
  detail: string;
}

/**
 * 逐模块列出「这份备份里到底装了什么」。
 * 特意把 0 条的模块也列出来 —— 要回答的是「是不是全都导了」，
 * 而不是「哪些有内容」，缺项露出来反而更让人放心。
 */
export function describeScope(data: AppData): ScopeItem[] {
  const hw = data.homeworkRecords || [];
  const hwStu = hw.reduce((s, r) => s + (r.students?.length || 0), 0);
  const rec = data.reciteRecords || [];
  const recStu = rec.reduce((s, r) => s + (r.students?.length || 0), 0);
  const recPoem = rec.reduce((s, r) => s + (r.poems?.length || 0), 0);
  const st = data.settings;
  return [
    { icon: '📝', label: '请假记录', detail: `${data.history?.length || 0} 条` },
    { icon: '📋', label: '我的课表', detail: `${scheduleCount(st)} 节` },
    { icon: '💰', label: '工资统计', detail: `${data.salaries?.length || 0} 条` },
    { icon: '📅', label: '值班 / 代课', detail: `${data.duties?.length || 0} 条` },
    { icon: '📚', label: '作业收缴', detail: `${hw.length} 个班 · ${hwStu} 名学生` },
    { icon: '📖', label: '古诗文背诵', detail: `${rec.length} 个班 · ${recStu} 名学生 · ${recPoem} 篇` },
    { icon: '⚙️', label: '个人设置', detail: st ? '姓名／学校／学期／节次等' : '尚未填写' },
  ];
}

/** 备份包里**不包含**的东西,避免用户误以为「连登录态一起备份了」 */
export const BACKUP_EXCLUDES = '云端登录信息不包含在备份里（避免换设备时把账号带过去），需要在新设备上重新登录一次。';


/** 组装备份对象 */
export function buildBackup(): BackupFile {
  const data = getData();
  return {
    app: APP_TAG,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    summary: summarize(data),
    data,
  };
}

const PREF_KEY = 'teacher_backup_prefix';

/** 备份文件名（「导出」和「分享」共用同一套命名，用户拿到手认得出来） */
export function backupFileName(): string {
  let prefix = '教师助手';
  try { prefix = localStorage.getItem(PREF_KEY) || '教师助手'; } catch { /* ignore */ }
  return `${prefix}_数据备份_${todayStamp()}.json`;
}

/** 导出为文件(返回文件名);prefix 可在设置里改成教师姓名 */
export function exportBackup(): string {
  const bak = buildBackup();
  const name = backupFileName();
  const blob = new Blob([JSON.stringify(bak, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  markBackedUp();
  return name;
}

/**
 * 直接把备份**文件**丢给系统分享面板。
 * 手机上点一下就能选「微信 → 文件传输助手」或隔空投送，
 * 比「先下载到文件 App，再去微信里翻出来发」少好几步 —— 手机↔电脑搬数据靠它。
 *
 * 返回 'downloaded' 表示这台设备的浏览器不支持分享文件（多数电脑浏览器都不支持），
 * 此时内部已经自动退回「下载文件」，调用方只需提示用户。
 */
export async function shareBackup(): Promise<'shared' | 'downloaded' | 'failed'> {
  const nav = navigator as any;
  try {
    if (typeof File !== 'undefined' && typeof nav?.share === 'function' && typeof nav?.canShare === 'function') {
      const file = new File([JSON.stringify(buildBackup())], backupFileName(), { type: 'application/json' });
      if (nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: '教师助手数据备份' });
        markBackedUp();
        return 'shared';
      }
    }
  } catch (e: any) {
    // 用户在分享面板里点了「取消」—— 不算失败，也不要再偷偷下载一份
    if (e && e.name === 'AbortError') return 'shared';
    // 其它异常（没有可分享的 App 等）→ 落到下面的下载
  }
  try {
    exportBackup();
    return 'downloaded';
  } catch {
    return 'failed';
  }
}

/**
 * 导出损坏数据的原始内容。
 * 数据损坏时 getData 已把原始串留档，这里让用户下载留存，
 * 以便人工修复或交回分析 —— 而不是直接丢掉。
 */
export function exportCorruptRaw(): string | null {
  const raw = getCorruptBackup();
  if (!raw) return null;
  const name = `教师助手_损坏数据原始内容_${todayStamp()}.txt`;
  const blob = new Blob([raw], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return name;
}

export function setBackupPrefix(p: string) {
  try { localStorage.setItem(PREF_KEY, p || '教师助手'); } catch { /* ignore */ }
}
export function getBackupPrefix(): string {
  try { return localStorage.getItem(PREF_KEY) || '教师助手'; } catch { return '教师助手'; }
}

/** 复制备份内容到剪贴板(手机上不方便存文件时的退路) */
export function backupAsText(): string {
  return JSON.stringify(buildBackup());
}

export interface ParseResult {
  ok: boolean;
  error?: string;
  file?: BackupFile;
}

/** 解析并校验备份文件 */
export function parseBackup(text: string): ParseResult {
  let obj: any;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, error: '不是合法的 JSON 文件，请确认选的是本工具导出的 .json 备份。' };
  }
  if (!obj || typeof obj !== 'object') return { ok: false, error: '文件内容为空。' };
  // 兼容用户直接粘贴 localStorage 原始数据的情况
  if (!obj.app && (obj.history || obj.salaries || obj.reciteRecords)) {
    obj = { app: APP_TAG, version: FORMAT_VERSION, exportedAt: '', data: obj };
  }
  if (obj.app !== APP_TAG) return { ok: false, error: '这不是「教师助手」的备份文件。' };
  if (typeof obj.version === 'number' && obj.version > FORMAT_VERSION) {
    return { ok: false, error: `备份文件版本(v${obj.version})比当前应用更新，请先升级应用。` };
  }
  const d = obj.data;
  if (!d || typeof d !== 'object') return { ok: false, error: '备份文件里没有数据。' };
  return { ok: true, file: obj as BackupFile };
}

/* ---------- 合并模式:按 id 去重后合并,不丢现有数据 ---------- */

function mergeById<T extends { id: string }>(cur: T[] | undefined, inc: T[] | undefined): T[] {
  const out = [...(cur || [])];
  const have = new Set(out.map(x => x.id));
  for (const item of inc || []) {
    if (item && item.id && !have.has(item.id)) { out.push(item); have.add(item.id); }
  }
  return out;
}

export function mergeIntoCurrent(inc: AppData): AppData {
  const cur = getData();
  return {
    ...cur,
    history: [...(cur.history || []), ...(inc.history || [])].slice(0, 100),
    salaries: mergeById(cur.salaries, inc.salaries),
    duties: mergeById(cur.duties, inc.duties),
    homeworkRecords: mergeById(cur.homeworkRecords, inc.homeworkRecords),
    reciteRecords: mergeById(cur.reciteRecords, inc.reciteRecords),
    settings: cur.settings || inc.settings || null,
  };
}

export function applyBackup(data: AppData, mode: 'replace' | 'merge') {
  const incoming = normalizeIncoming(data);
  if (mode === 'merge') setData(mergeIntoCurrent(incoming));
  else setData(incoming);
}

/**
 * 入库前先补齐模块顺序、并清洗被隐藏的模块列表。
 * 旧备份里的 `settings.moduleOrder` 记的是它那会儿的模块清单，
 * 直接写进去会让后来新增的模块（古诗文背诵）在首页消失。
 * `hiddenModules` 同理 —— 旧备份可能带着已经不存在、或者不该隐藏的 key。
 */
function normalizeIncoming(data: AppData): AppData {
  if (!data.settings) return data;
  return {
    ...data,
    settings: {
      ...data.settings,
      moduleOrder: normalizeModuleOrder(data.settings.moduleOrder),
      hiddenModules: normalizeHiddenModules(data.settings.hiddenModules),
    },
  };
}

/* ---------- 导入前的「撤销快照」 ----------
   覆盖导入会把这台设备上的数据整体换掉，换错了就回不来。
   所以在覆盖前先把当前数据留一份（独立 key，不进备份文件），
   用户在设置页可以一键退回。合并模式不动现有数据，不需要快照。 */

const PREIMPORT_KEY = 'teacher_preimport_snapshot';
/** 快照保留天数：过期自动清掉，免得长期占着存储配额 */
const SNAPSHOT_TTL_DAYS = 7;

interface SnapshotRaw { at: string; data: AppData }

/** 覆盖导入前留一份当前数据；返回是否留成功（配额不足或数据过大时会失败） */
export function snapshotBeforeImport(): boolean {
  try {
    const payload: SnapshotRaw = { at: new Date().toISOString(), data: getData() };
    localStorage.setItem(PREIMPORT_KEY, JSON.stringify(payload));
    return true;
  } catch {
    // 快照失败不能阻断导入本身，但要如实告诉调用方
    return false;
  }
}

export interface PreImportSnapshot { at: string; summary: string }

/** 取撤销快照的信息（不含数据本身）；过期或不存在返回 null */
export function getPreImportSnapshot(): PreImportSnapshot | null {
  try {
    const raw = localStorage.getItem(PREIMPORT_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as SnapshotRaw;
    if (!obj || !obj.data || !obj.at) return null;
    const age = Date.now() - new Date(obj.at).getTime();
    if (!(age >= 0) || age > SNAPSHOT_TTL_DAYS * 86400000) {
      localStorage.removeItem(PREIMPORT_KEY);
      return null;
    }
    return { at: obj.at, summary: summarize(obj.data) };
  } catch { return null; }
}

/** 退回覆盖导入之前的数据；成功后快照即作废 */
export function restorePreImport(): boolean {
  try {
    const raw = localStorage.getItem(PREIMPORT_KEY);
    if (!raw) return false;
    const obj = JSON.parse(raw) as SnapshotRaw;
    if (!obj || !obj.data) return false;
    setData(obj.data);
    localStorage.removeItem(PREIMPORT_KEY);
    return true;
  } catch { return false; }
}

export function clearPreImportSnapshot() {
  try { localStorage.removeItem(PREIMPORT_KEY); } catch { /* ignore */ }
}

/** 距离上次备份的天数;从没备份过返回 Infinity */
export function daysSinceBackup(): number {
  const { lastBackupAt } = getBackupMetaLocal();
  if (!lastBackupAt) return Infinity;
  const ms = Date.now() - new Date(lastBackupAt).getTime();
  return Math.floor(ms / 86400000);
}

function getBackupMetaLocal(): { lastBackupAt: string | null } {
  try {
    const raw = localStorage.getItem('teacher_backup_meta');
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { lastBackupAt: null };
}

/** 数据体量估算(给用户一个「值不值得备份」的直觉) */
export function dataSizeKB(): number {
  try {
    return Math.round((localStorage.getItem('teacher_assistant_v3') || '').length / 1024);
  } catch { return 0; }
}
