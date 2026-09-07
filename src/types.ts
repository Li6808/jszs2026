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
