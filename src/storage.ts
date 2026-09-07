import type { AppData, Settings, LeaveRecord, SalaryRecord, DutyRecord, HomeworkRecord } from './types';

const KEY = 'teacher_assistant_v3';

export function getData(): AppData {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {
    settings: null,
    history: [],
    salaries: [],
    duties: [],
    homeworkRecords: [],
  };
}

export const DEFAULT_MODULE_ORDER = ['leave', 'schedule', 'homework', 'salary', 'duty', 'substitute', 'payment', 'settings'];

export const DEFAULT_SALARY_CATEGORIES = ['工资', '绩效', '补贴', '奖金', '其他'];

export function getModuleOrder(): string[] {
  const d = getData();
  return d.settings?.moduleOrder || DEFAULT_MODULE_ORDER;
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

export function setData(data: AppData) {
  localStorage.setItem(KEY, JSON.stringify(data));
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

export function clearAll() {
  localStorage.removeItem(KEY);
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
 *   1 张三 男
 *   张三 男 5班
 *   张三
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

export { type AppData };
