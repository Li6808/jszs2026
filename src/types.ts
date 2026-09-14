export interface Course {
  period: string;
  classSubject: string;
}

export interface Schedule {
  courses: Record<number, Course[]>;
}

export interface Settings {
  name: string;
  schoolName: string;
  semesterName: string;
  startSchoolDate: string;
  schedule: Schedule;
  periodNames: string[];
  timeTable: TimeSlot[];
  moduleOrder: string[];
  /**
   * 首页里被「收起来」的模块 key。
   * 只是不显示卡片 —— 数据一条不动，随时可以再显示出来。
   * 「个人设置」不允许出现在这里（见 storage.ts 的 ALWAYS_VISIBLE_MODULES），
   * 否则用户把自己锁在设置页之外就再也改不回来了。
   */
  hiddenModules?: string[];
  salaryCategories: string[];
}

export interface TimeSlot {
  name: string;
  startTime: string;
  endTime: string;
}

export interface SubRow {
  week: number;
  day: string;
  dayShort: string;
  dayNum: number;
  period: string;
  classSubject: string;
  teacher: string;
}

export interface LeaveRecord {
  name: string;
  reason: string;
  type: string;
  days: number;
  sd: string;
  ed: string;
  sp: string;
  ep: string;
  sw: number;
  ew: number;
  subs: SubRow[];
  time: string;
}

export interface SalaryRecord {
  id: string;
  date: string;
  description: string;
  category: string;
  amount: number;
}

export interface DutyRecord {
  id: string;
  date: string;
  type: '值班' | '代课' | '其他';
  description: string;
  substituteFor?: string;
  period?: string;
  classSubject?: string;
  amount?: number;
}

export interface AppData {
  settings: Settings | null;
  history: LeaveRecord[];
  salaries: SalaryRecord[];
  duties: DutyRecord[];
  homeworkRecords?: HomeworkRecord[];
  reciteRecords?: ReciteRecord[];
}

/* ===== 古诗文背诵统计(新增模块) ===== */

/** 过关状态:未背 / 已背(背诵过关) / 已默写(默写过关,最高级) / 待补背(抽查没过,需重来) */
export type ReciteStatus = 'todo' | 'recited' | 'written' | 'redo';

/** 默写题（名句填空）:prompt 是给考生的上句/提示,answer 是要求默写的部分 */
export interface ReciteQuiz {
  p: string;
  a: string;
}

export interface RecitePoem {
  id: string;
  title: string;
  author: string;                    // 作者或出处
  type: string;                      // 诗 / 词 / 曲 / 文 / 现代诗
  req: 'both' | 'recite';            // both=背诵+默写, recite=仅背诵
  volume: string;                    // 所属册次,如「八年级上册」
  order: number;                     // 排序
  active: boolean;                   // 是否纳入本班当前进度
  kebiao?: boolean;                  // 是否属于课标推荐背诵篇目(初中60/高中72)
  dueDate?: string;                  // 计划完成日期 YYYY-MM-DD
  quiz?: ReciteQuiz[];               // 默写题库
}

/** 学籍状态:在读 / 免检(免修、特长生等) / 已转出 */
export type ReciteStudentStatus = 'active' | 'exempt' | 'left';

export interface ReciteStudent {
  id: string;
  no: number;
  name: string;
  gender: '男' | '女';
  className: string;
  status?: ReciteStudentStatus;      // 省略视为 active
  reason?: string;                   // 免检原因 / 转出去向
  joinedAt?: string;                 // 转入日期
  leftAt?: string;                   // 转出日期
}

/** 某位学生在某篇目上的过关记录 */
export interface ReciteMark {
  status: ReciteStatus;
  reciteDate?: string;               // 背诵过关日期
  writeDate?: string;                // 默写过关日期
  note?: string;                     // 备注(抽背情况)
  typos?: string[];                  // 该篇默写写错的字
  checkedAt?: string;                // 最近一次抽查日期
}

export interface ReciteRecord {
  id: string;
  classFullName: string;             // 初二(4)班
  classShortName: string;            // 4班
  grade: string;                     // 初二
  poems: RecitePoem[];
  students: ReciteStudent[];
  /** studentId → poemId → 过关记录 */
  marks: Record<string, Record<string, ReciteMark>>;
  planRate?: number;                 // 计划目标过关率(%),默认 80
  createdAt: string;
  updatedAt: string;
}

/* ===== 作业收缴(新增模块 - 参考「高一5班作业收缴登记表」) ===== */

export type HomeworkStatus = 'submitted' | 'missing' | 'late' | 'excused';

export interface HomeworkStudent {
  id: string;
  no: number;                        // 序号
  name: string;
  gender: '男' | '女';
  className: string;                 // 所在班级(如 5班)
}

export interface HomeworkSession {
  id: string;
  date: string;                      // 收缴日期 YYYY-MM-DD
  title: string;                     // 本次作业名称(如「第3单元练习」)
  /** studentId → 当次收缴状态 */
  submissions: Record<string, HomeworkStatus>;
}

export interface HomeworkRecord {
  id: string;
  classFullName: string;             // 完整班级名:高一5班
  classShortName: string;            // 班级简称:5班
  grade: string;                     // 年级:高一
  classTeacher: string;              // 班主任
  teacherPhone: string;              // 班主任电话
  homeworksPerWeek: number;          // 每周作业次数
  students: HomeworkStudent[];
  sessions: HomeworkSession[];
  createdAt: string;
  updatedAt: string;
}
