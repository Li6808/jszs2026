import type { AppData, Settings, LeaveRecord, SalaryRecord, DutyRecord, HomeworkRecord, ReciteRecord, ReciteStudent, RecitePoem, ReciteStatus, ReciteMark } from './types';

const KEY = 'teacher_assistant_v3';
/** 数据损坏时抢救出的原始内容,留档供用户下载 */
const CORRUPT_KEY = 'teacher_assistant_v3_corrupt';
/** 只读保护锁:数据损坏后置上,阻止用空数据覆盖原文件 */
const READONLY_KEY = 'teacher_assistant_v3_readonly';
/** 接近浏览器配额时的预警线(字符数,约 4MB) */
const SOFT_LIMIT = 4 * 1024 * 1024;

/**
 * 存储层问题上报。
 * 关键原则:任何写入失败都必须让用户知道,绝不静默丢数据。
 */
export interface StorageIssue {
  kind: 'corrupt' | 'quota' | 'near-limit' | 'unavailable';
  message: string;
  /** 抢救出的原始内容长度(corrupt 时) */
  rescuedChars?: number;
}

let sessionIssue: StorageIssue | null = null;
const issueHandlers = new Set<(i: StorageIssue) => void>();

/** 读取当前会话的存储问题(供 UI 启动时检查) */
export function getStorageIssue(): StorageIssue | null {
  return sessionIssue;
}

/** 订阅存储问题;返回取消订阅函数 */
export function onStorageIssue(fn: (i: StorageIssue) => void): () => void {
  issueHandlers.add(fn);
  return () => { issueHandlers.delete(fn); };
}

function emitIssue(issue: StorageIssue) {
  // 同样的内容只通知一次，避免渲染期间反复触发状态更新
  const duplicated = sessionIssue?.kind === issue.kind && sessionIssue?.message === issue.message;
  sessionIssue = issue;
  if (duplicated) return;
  issueHandlers.forEach(h => { try { h(issue); } catch { /* ignore */ } });
}

function emptyData(): AppData {
  return {
    settings: null,
    history: [],
    salaries: [],
    duties: [],
    homeworkRecords: [],
    reciteRecords: [],
  };
}

/** 是否处于「数据损坏,暂停写入」的保护状态 */
export function isReadOnly(): boolean {
  try { return localStorage.getItem(READONLY_KEY) !== null; } catch { return false; }
}

/**
 * 读取全量数据。
 * 注意:解析失败时**绝不能**静默返回空数据 —— 那样下一次写入就会
 * 把损坏但可能还能抢救的原始内容彻底覆盖。这里改为留档 + 上只读锁。
 */
export function getData(): AppData {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    emitIssue({
      kind: 'unavailable',
      message: '浏览器禁用了本地存储（可能是无痕模式），本次录入的内容关掉页面后会丢失。',
    });
    return emptyData();
  }
  if (!raw) return emptyData();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('数据结构异常');
    }
    try { localStorage.removeItem(READONLY_KEY); } catch { /* ignore */ }
    sessionIssue = null;
    return parsed as AppData;
  } catch {
    // 已经抢救过就不再重复处理：否则每次渲染都会重新上报，
    // 触发 UI 更新 → 重新渲染 → 再次上报，形成死循环
    if (sessionIssue?.kind !== 'corrupt') rescueCorrupt(raw);
    return emptyData();
  }
}

/** 数据损坏时的抢救流程:留档原始内容 + 上只读锁 */
function rescueCorrupt(raw: string) {
  let rescued = 0;
  try {
    localStorage.setItem(CORRUPT_KEY, raw);
    localStorage.setItem(READONLY_KEY, String(Date.now()));
    rescued = raw.length;
  } catch { /* 留档失败也要提示,只是没有可下载的副本 */ }
  emitIssue({
    kind: 'corrupt',
    message: '本地数据文件已损坏。已自动留存原始内容并暂停写入，避免被空数据覆盖。',
    rescuedChars: rescued,
  });
}

/** 抢救出的损坏数据原始内容(供用户下载留存) */
export function getCorruptBackup(): string | null {
  try { return localStorage.getItem(CORRUPT_KEY); } catch { return null; }
}

/** 用户确认已下载/不再需要后，解除保护并清掉损坏文件 */
export function discardCorruptBackup() {
  try {
    localStorage.removeItem(CORRUPT_KEY);
    localStorage.removeItem(READONLY_KEY);
  } catch { /* ignore */ }
  sessionIssue = null;
}

/**
 * 用户确认放弃损坏数据后的重置：清掉损坏文件、只读锁与主数据。
 * 注意：这一步之后抢救留档也会被删除，
 * 调用前应先引导用户下载原始内容。
 */
export function resetAfterCorruption() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(CORRUPT_KEY);
    localStorage.removeItem(READONLY_KEY);
  } catch { /* ignore */ }
  sessionIssue = null;
}

export const DEFAULT_MODULE_ORDER = ['leave', 'schedule', 'homework', 'recite', 'salary', 'duty', 'substitute', 'payment', 'settings'];

export const DEFAULT_SALARY_CATEGORIES = ['工资', '绩效', '补贴', '奖金', '其他'];

/**
 * 取首页模块顺序。
 * 关键:老用户 localStorage 里存的是旧顺序(没有新模块),
 * 这里会把新增模块自动补进去,否则升级后新模块在首页不显示。
 */
export function getModuleOrder(): string[] {
  const d = getData();
  const saved = d.settings?.moduleOrder;
  if (!saved || saved.length === 0) return [...DEFAULT_MODULE_ORDER];
  const merged = saved.filter(k => DEFAULT_MODULE_ORDER.includes(k));
  for (const k of DEFAULT_MODULE_ORDER) if (!merged.includes(k)) merged.push(k);
  return merged;
}

export function saveModuleOrder(order: string[]) {
  const d = getData();
  if (!d.settings) return;
  d.settings.moduleOrder = order;
  setData(d);
}

export function getSalaryCategories(): string[] {
  const d = getData();
  return d.settings?.salaryCategories || DEFAULT_SALARY_CATEGORIES;
}

export function saveSalaryCategories(categories: string[]) {
  const d = getData();
  if (!d.settings) return;
  d.settings.salaryCategories = categories;
  setData(d);
}

/** 判断是否为存储配额超限错误 */
function isQuotaError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.name === 'QuotaExceededError'
    || e.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || /quota/i.test(e.message);
}

let nearLimitWarned = false;

/**
 * 写入全量数据。
 * 原来这里是裸的 setItem —— 配额写满会抛异常,用户点一下格子
 * 操作就凭空消失且毫无提示。现在失败一律上报,让 UI 说清楚「没保存」。
 */
export function setData(data: AppData) {
  if (isReadOnly()) {
    if (!sessionIssue) {
      emitIssue({
        kind: 'corrupt',
        message: '数据文件损坏后处于保护状态，本次修改未保存。请到「个人设置」处理。',
      });
    }
    return;
  }
  let raw: string;
  try {
    raw = JSON.stringify(data);
  } catch {
    emitIssue({ kind: 'unavailable', message: '数据无法序列化，本次修改未保存。' });
    return;
  }
  try {
    localStorage.setItem(KEY, raw);
  } catch (e) {
    if (isQuotaError(e)) {
      const sizeText = raw.length >= 1024 * 1024
        ? `${(raw.length / 1024 / 1024).toFixed(1)} MB`
        : `${Math.max(1, Math.round(raw.length / 1024))} KB`;
      emitIssue({
        kind: 'quota',
        message: `存储空间已满（本次需写入约 ${sizeText}），修改未保存。请先导出备份，再清理不再维护的班级。`,
      });
    } else {
      emitIssue({
        kind: 'unavailable',
        message: '数据写入失败，本次修改未保存。若在无痕模式或存储被禁用，请更换浏览器后重试。',
      });
    }
    return;
  }
  if (!nearLimitWarned && raw.length > SOFT_LIMIT) {
    nearLimitWarned = true;
    emitIssue({
      kind: 'near-limit',
      message: `本地数据已接近浏览器上限（约 ${(raw.length / 1024 / 1024).toFixed(1)} MB），建议尽快导出备份并归档旧数据。`,
    });
  }
}

export function saveSettings(settings: Settings) {
  const d = getData();
  d.settings = settings;
  setData(d);
}

export function saveHistory(record: LeaveRecord) {
  const d = getData();
  d.history.unshift(record);
  if (d.history.length > 100) d.history = d.history.slice(0, 100);
  setData(d);
}

export function deleteHistory(index: number) {
  const d = getData();
  d.history.splice(index, 1);
  setData(d);
}

export function clearHistory() {
  const d = getData();
  d.history = [];
  setData(d);
}

/**
 * 清空全部数据。
 * 除了主数据,还要一并清掉撤销栈、备份元数据、损坏留档与只读锁,
 * 否则「重置」之后旧状态会残留在下一次使用里。
 */
export function clearAll() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(BACKUP_META_KEY);
    localStorage.removeItem(CORRUPT_KEY);
    localStorage.removeItem(READONLY_KEY);
    // 用规范 API 遍历(length + key)，比 Object.keys(localStorage) 更可靠
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(UNDO_PREFIX)) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch { /* ignore */ }
  sessionIssue = null;
}

export function saveSalary(record: SalaryRecord) {
  const d = getData();
  const idx = d.salaries.findIndex(s => s.id === record.id);
  if (idx >= 0) d.salaries[idx] = record;
  else d.salaries.unshift(record);
  setData(d);
}

export function deleteSalary(id: string) {
  const d = getData();
  d.salaries = d.salaries.filter(s => s.id !== id);
  setData(d);
}

export function saveDuty(record: DutyRecord) {
  const d = getData();
  const idx = d.duties.findIndex(x => x.id === record.id);
  if (idx >= 0) d.duties[idx] = record;
  else d.duties.unshift(record);
  setData(d);
}

export function deleteDuty(id: string) {
  const d = getData();
  d.duties = d.duties.filter(x => x.id !== id);
  setData(d);
}

export function importSalariesFromText(text: string): SalaryRecord[] {
  const records: SalaryRecord[] = [];
  const lines = text.split('\n').filter(l => l.trim());
  for (const line of lines) {
    // Try formats:
    // 2025-01-15 基本工资 工资 4500.50
    // 2025/01/15,基本工资,工资,4500.50
    // 2025年1月15日 绩效奖金 绩效 1200
    const parts = line.split(/[\s,，|]+/).filter(p => p.trim());
    if (parts.length >= 3) {
      const dateStr = parts[0].replace(/年|月/g, '-').replace(/日/g, '').replace(/\//g, '-');
      const amount = parseFloat(parts[parts.length - 1]);
      if (!isNaN(amount) && amount > 0) {
        const category = parts.length >= 4 ? parts[parts.length - 2] : '工资';
        const description = parts.slice(1, parts.length - (parts.length >= 4 ? 2 : 1)).join(' ');
        records.push({
          id: 'sal_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          date: dateStr,
          description,
          category,
          amount,
        });
      }
    }
  }
  return records;
}

/* ===== 作业收缴数据访问 ===== */

export function getHomeworkRecords(): HomeworkRecord[] {
  return getData().homeworkRecords || [];
}

export function getHomeworkById(id: string): HomeworkRecord | undefined {
  return getHomeworkRecords().find(r => r.id === id);
}

export function saveHomeworkRecord(record: HomeworkRecord) {
  const d = getData();
  if (!d.homeworkRecords) d.homeworkRecords = [];
  const idx = d.homeworkRecords.findIndex(r => r.id === record.id);
  if (idx >= 0) d.homeworkRecords[idx] = record;
  else d.homeworkRecords.unshift(record);
  setData(d);
}

export function deleteHomeworkRecord(id: string) {
  const d = getData();
  if (!d.homeworkRecords) return;
  d.homeworkRecords = d.homeworkRecords.filter(r => r.id !== id);
  setData(d);
}

/**
 * 从粘贴文本解析学生名单。
 * 支持格式:
 *   1 张×× 男
 *   张×× 男 5班
 *   张××
 *  多种分隔符(空格/逗号/Tab),自动推断性别和班级。
 */
export interface ImportedStudent {
  no: number;
  name: string;
  gender: '男' | '女';
  className: string;
}

export function importStudentsFromText(
  text: string,
  fallbackClassName: string = '',
): ImportedStudent[] {
  const result: ImportedStudent[] = [];
  // 先把 markdown 表格管道符和回车清理掉
  const cleanedText = text
    .replace(/\|/g, ' ')
    .replace(/\r/g, '');
  const lines = cleanedText.split('\n').map(l => l.trim()).filter(Boolean);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // 跳过表头 / 标题 / markdown 分隔符
    if (/^[\s\-:|]+$/.test(line)) continue;                          // 全是 - : | 空格
    if (line.includes('姓名') && line.includes('性别')) continue;   // 表头含姓名+性别
    if (line.match(/^#+\s/)) continue;                              // markdown 标题
    if (line.startsWith('>')) continue;                             // markdown 引用

    // 一次性 regex 提取(容忍各种序号格式:1./1、/1/(1)/① + 半全角逗号/空格分隔)
    const m = line.match(
      /^(?:[\(（]\d+[\)）]\s*)?(?:[\d]+[\s.、:：\u3000]*)?([^\s,,，\t\u3001]+?)(?:\s*[,，\s\u3001]\s*([男女]))?(?:\s*[,，\s\u3001]\s*(\S*?班))?$/,
    );
    if (!m) continue;
    const name = m[1] ? m[1].trim() : '';
    const gender = (m[2] as '男' | '女' | undefined) || '男';
    const className = m[3] || fallbackClassName;
    if (!name) continue;
    // 安全过滤:名字里如果不小心夹了"男/女"字(误识别时),去掉
    const cleanName = name.replace(/[男女]\s*$/, '').trim();
    if (!cleanName) continue;

    result.push({ no: result.length + 1, name: cleanName, gender, className });
  }
  return result;
}

/** 生成简短随机 ID(供新学生/会话使用) */
export function genId(prefix: string = 'hw'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/* ===== 古诗文背诵数据访问 ===== */

export function getReciteRecords(): ReciteRecord[] {
  return getData().reciteRecords || [];
}

export function getReciteById(id: string): ReciteRecord | undefined {
  return getReciteRecords().find(r => r.id === id);
}

export function saveReciteRecord(record: ReciteRecord) {
  const d = getData();
  if (!d.reciteRecords) d.reciteRecords = [];
  const idx = d.reciteRecords.findIndex(r => r.id === record.id);
  if (idx >= 0) d.reciteRecords[idx] = record;
  else d.reciteRecords.unshift(record);
  setData(d);
}

export function deleteReciteRecord(id: string) {
  const d = getData();
  if (!d.reciteRecords) return;
  d.reciteRecords = d.reciteRecords.filter(r => r.id !== id);
  setData(d);
}

/**
 * 从「作业收缴」模块已有的班级读取学生名单,供背诵模块一键复用。
 * 返回按班级名分组的名单。
 */
export function getHomeworkClassRoster(): { id: string; classFullName: string; classShortName: string; grade: string; students: ReciteStudent[] }[] {
  return getHomeworkRecords()
    .filter(r => r.students && r.students.length > 0)
    .map(r => ({
      id: r.id,
      classFullName: r.classFullName,
      classShortName: r.classShortName || r.classFullName,
      grade: r.grade || '',
      students: r.students.map((s, i) => ({
        id: genId('stu'),
        no: i + 1,
        name: s.name,
        gender: s.gender,
        className: s.className || r.classShortName || '',
      })),
    }));
}

/** 从粘贴文本解析篇目清单(支持 AI 返回的「篇名|作者|文体|要求」格式) */
export interface ImportedPoem {
  title: string;
  author: string;
  type: string;
  req: 'both' | 'recite';
}

export function importPoemsFromText(text: string, volume: string): RecitePoem[] {
  const out: RecitePoem[] = [];
  const cleaned = text.replace(/\r/g, '').replace(/\|/g, '\u0001');
  for (const raw of cleaned.split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    // AI 有时仍会输出 markdown 表格线
    if (/^[\s\-:]+$/.test(line.replace(/\u0001/g, ''))) continue;
    line = line.replace(/^>\s*/, '').replace(/^#+\s*/, '');
    const parts = line.split('\u0001').map(s => s.trim()).filter(Boolean);
    let title = '', author = '', type = '', req = '';

    if (parts.length >= 2) {
      [title, author, type, req] = parts;
    } else {
      // 兼容「1 三峡 郦道元」这类空格分隔,以及只有篇名的行
      const pieces = line.split(/[\s,，\t]+/).filter(Boolean);
      if (pieces.length >= 3 && /^[\d.、]+$/.test(pieces[0])) {
        [, title, author] = pieces;
        req = pieces[3] || '';
      } else if (pieces.length >= 2) {
        [title, author] = pieces;
        req = pieces[2] || '';
      } else {
        title = pieces[0] || '';
      }
    }

    title = title.replace(/^[\d.、)）\]]+\s*/, '').trim();
    if (!title) continue;
    // 跳过表头
    if (title.includes('篇名') || title.includes('序号')) continue;

    const typeOk = ['诗', '词', '曲', '文', '现代诗'];
    const finalType = typeOk.includes(type) ? type : (/词/.test(title) ? '词' : '诗');
    const finalReq: 'both' | 'recite' =
      /recite|仅背|只背|^背$/.test(req) ? 'recite' : 'both';

    out.push({
      id: genId('poem'),
      title,
      author: author || '',
      type: finalType,
      req: finalReq,
      volume,
      order: out.length + 1,
      active: true,
    });
  }
  return out;
}

/** 从粘贴文本解析默写题(篇名|给出的一句|要求默写的一句) */
export function parseQuizText(text: string): { title: string; p: string; a: string }[] {
  const out: { title: string; p: string; a: string }[] = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line || /^[\s\-:|]+$/.test(line)) continue;
    if (line.includes('篇名') && line.includes('默写')) continue;
    const clean = line.replace(/^>\s*/, '').replace(/^#+\s*/, '');
    const parts = clean.split('|').map(s => s.trim());
    if (parts.length < 3) continue;
    const [title, p, a] = parts;
    if (!title || !p || !a) continue;
    out.push({ title, p, a });
  }
  return out;
}

/** 新建一份背诵登记表 */
export function createReciteRecord(params: {
  classFullName: string;
  classShortName?: string;
  grade?: string;
  students?: ReciteStudent[];
  poems?: RecitePoem[];
}): ReciteRecord {
  const id = genId('rec');
  const record: ReciteRecord = {
    id,
    classFullName: params.classFullName,
    classShortName: params.classShortName || params.classFullName,
    grade: params.grade || '',
    poems: params.poems || [],
    students: (params.students || []).map((s, i) => ({ ...s, no: i + 1 })),
    marks: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveReciteRecord(record);
  return record;
}

/** 把 PRESET_VOLUMES 中的某一册解析为 RecitePoem[] */
export function buildPoemsFromPreset(
  poems: { title: string; author: string; type: string; req: 'both' | 'recite'; kebiao?: boolean; quiz?: { p: string; a: string }[] }[],
  volumeName: string,
  startOrder: number,
): RecitePoem[] {
  return poems.map((p, i) => ({
    id: genId('poem'),
    title: p.title,
    author: p.author,
    type: p.type,
    req: p.req,
    volume: volumeName,
    order: startOrder + i,
    active: true,
    kebiao: p.kebiao || undefined,
    quiz: p.quiz && p.quiz.length ? p.quiz : undefined,
  }));
}

/** 状态机顺序:点击单元格时按 未背 → 已背 → 已默写 → 待补背 → 未背 循环 */
export const STATUS_CYCLE: ReciteStatus[] = ['todo', 'recited', 'written', 'redo'];
export const STATUS_NEXT: Record<ReciteStatus, ReciteStatus> = {
  todo: 'recited',
  recited: 'written',
  written: 'todo',
  redo: 'recited',
};

export function nextStatus(cur: ReciteStatus | undefined): ReciteStatus {
  if (!cur) return 'recited';
  return STATUS_NEXT[cur] || 'recited';
}

/** 计划目标过关率默认值(%) */
export const DEFAULT_PLAN_RATE = 80;

/** 是否计入统计分母:转出和免检的学生不计入 */
export function isCounted(s: ReciteStudent): boolean {
  return (s.status || 'active') === 'active';
}

/* ===== 背诵模块 · 撤销栈(按班级分别持久化,刷新不丢) ===== */

const UNDO_PREFIX = 'teacher_recite_undo_';
const UNDO_MAX = 40;

export interface UndoChange {
  studentId: string;
  poemId: string;
  /** 原值(null 表示原来没有记录,撤销时应删除) */
  prev: ReciteMark | null;
}

export interface UndoEntry {
  at: string;                        // 操作时间
  label: string;                     // 操作说明,如「批量标记 12 格」
  changes: UndoChange[];
}

/**
 * 在一份「最新」数据上执行变更并写回。
 * 关键:每次都从 localStorage 重新读,否则同一帧内连续调用多次
 * (例如「全班标已背」逐个学生循环)会都基于同一份过期数据计算,后写的覆盖前面的。
 */
export function mutateRecite(recordId: string, fn: (r: ReciteRecord) => ReciteRecord): ReciteRecord | null {
  const cur = getReciteRecords().find(r => r.id === recordId);
  if (!cur) return null;
  const next = { ...fn(cur), updatedAt: new Date().toISOString() };
  saveReciteRecord(next);
  return next;
}

export function getUndoStack(recordId: string): UndoEntry[] {
  try {
    const raw = localStorage.getItem(UNDO_PREFIX + recordId);
    if (raw) return JSON.parse(raw) as UndoEntry[];
  } catch { /* ignore */ }
  return [];
}

function writeUndoStack(recordId: string, stack: UndoEntry[]) {
  try {
    if (!stack.length) localStorage.removeItem(UNDO_PREFIX + recordId);
    else localStorage.setItem(UNDO_PREFIX + recordId, JSON.stringify(stack.slice(-UNDO_MAX)));
  } catch { /* ignore */ }
}

export function pushUndo(recordId: string, entry: UndoEntry) {
  const stack = getUndoStack(recordId);
  stack.push(entry);
  writeUndoStack(recordId, stack);
}

export function popUndo(recordId: string): UndoEntry | undefined {
  const stack = getUndoStack(recordId);
  const last = stack.pop();
  writeUndoStack(recordId, stack);
  return last;
}

export function clearUndo(recordId: string) {
  writeUndoStack(recordId, []);
}

/* ===== 背诵模块 · 加权随机点名 ===== */

/**
 * 加权随机抽一位学生。
 * 权重设计:待补背最该被抽(6) > 未背(4) > 仅背诵过关(2) > 已默写(1);
 * 另外把「最近抽到次数少」的学生权重抬高,保证一轮内人人有机会。
 */
export function pickWeightedStudent(
  record: ReciteRecord,
  poemIds: string[],
  pickedCount: Record<string, number> = {},
): ReciteStudent | null {
  const pool = record.students.filter(isCounted);
  if (!pool.length || !poemIds.length) return null;
  const weights = pool.map(st => {
    let w = 0;
    for (const pid of poemIds) {
      const s = record.marks[st.id]?.[pid]?.status;
      if (s === 'redo') w += 6;
      else if (s === 'recited') w += 2;
      else if (s === 'written') w += 1;
      else w += 4;                       // todo / 无记录
    }
    const times = pickedCount[st.id] || 0;
    w = w / (1 + times * 0.8);           // 已抽过的降权
    return Math.max(0.01, w);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/* ===== 备份 / 恢复 ===== */

const BACKUP_META_KEY = 'teacher_backup_meta';

export function getBackupMeta(): { lastBackupAt: string | null; count: number } {
  try {
    const raw = localStorage.getItem(BACKUP_META_KEY);
    if (raw) return { count: 0, ...(JSON.parse(raw) as any) };
  } catch { /* ignore */ }
  return { lastBackupAt: null, count: 0 };
}

export function markBackedUp() {
  const meta = getBackupMeta();
  try {
    localStorage.setItem(BACKUP_META_KEY, JSON.stringify({
      lastBackupAt: new Date().toISOString(),
      count: (meta.count || 0) + 1,
    }));
  } catch { /* ignore */ }
}

export { type AppData };
