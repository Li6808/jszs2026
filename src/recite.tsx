/* ============================================================
   古诗文背诵统计模块
   - 班级名单可直接复用「作业收缴」里已录好的名单
   - 内置部编版初中(七上~九下) + 统编版高中(必修/选择性必修)篇目库，
     并标出课标「背诵推荐篇目」(初中60 / 高中72)
   - 进度矩阵: 学生 × 篇目, 点格子标记过关状态, 支持撤销
   - 四档状态: 未背 / 已背 / 已默写 / 待补背
   - 错字本: 记录默写写错的字, 自动汇总高频错字榜
   - 计划进度: 篇目设定截止日期, 到期未达标自动预警
   - 学籍异动: 免检 / 转出学生不计入统计分母
   - 快速抽查: 列表模式 + 手机单列模式 + 加权随机点名
   - 默写卷: 用名句题库自动生成 A4 默写试卷
   - 导出: CSV / 打印PDF / 登记表大图 / 催办名单
   ============================================================ */

import { useState, useMemo, useRef } from 'react';
import {
  getReciteRecords, saveReciteRecord, deleteReciteRecord,
  getHomeworkClassRoster, importStudentsFromText, importPoemsFromText, parseQuizText,
  buildPoemsFromPreset, genId, isCounted, pickWeightedStudent,
  getUndoStack, pushUndo, popUndo, clearUndo, mutateRecite, DEFAULT_PLAN_RATE,
  getRedoStack, pushRedo, popRedo, buildRedoEntry, planRedo, writeMarkValues,
} from './storage';
import type { UndoChange } from './storage';
import {
  PRESET_VOLUMES, RECITE_AI_PROMPT, RECITE_STUDENT_PROMPT, RECITE_QUIZ_PROMPT,
  ALL_PRESET_COUNT, KEBIAO_STATS, QUIZ_COUNT, QUIZ_POEM_COUNT, volumeKebiaoCount,
} from './reciteData';
import type { ReciteRecord, ReciteStudent, RecitePoem, ReciteStatus, ReciteMark, ReciteStudentStatus } from './types';
import { exportCSV } from './export';

interface Props {
  toast: (msg: string) => void;
  openQr: (url: string) => void;
}

export const STATUS_META: { value: ReciteStatus; label: string; short: string; color: string; bg: string }[] = [
  { value: 'todo', label: '未背', short: '未', color: '#8E8E93', bg: 'rgba(142,142,147,0.18)' },
  { value: 'recited', label: '已背', short: '背', color: '#007AFF', bg: 'rgba(0,122,255,0.16)' },
  { value: 'written', label: '已默写', short: '默', color: '#34C759', bg: 'rgba(52,199,89,0.18)' },
  { value: 'redo', label: '待补背', short: '补', color: '#FF3B30', bg: 'rgba(255,59,48,0.16)' },
];

const STUDENT_STATUS_META: Record<ReciteStudentStatus, { label: string; short: string; color: string }> = {
  active: { label: '在读', short: '在', color: '#8E8E93' },
  exempt: { label: '免检', short: '免', color: '#FF9500' },
  left: { label: '已转出', short: '转', color: '#8E8E93' },
};

const meta = (s: ReciteStatus | undefined) => STATUS_META.find(m => m.value === (s || 'todo'))!;
/** 是否算「过关」(背诵或默写任一通过) */
const isPassed = (s: ReciteStatus | undefined) => s === 'recited' || s === 'written';
const today = () => new Date().toISOString().slice(0, 10);
const stuStatus = (s: ReciteStudent): ReciteStudentStatus => s.status || 'active';

/** 把输入框里的文字拆成「错字」数组,只保留单个汉字 */
function parseTypos(text: string): string[] {
  const chars = Array.from(text.replace(/[^\u4e00-\u9fa5]/g, ''));
  return Array.from(new Set(chars));
}

function copyText(text: string, ok: string, toast: Props['toast']) {
  navigator.clipboard?.writeText(text)
    .then(() => toast(ok))
    .catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta); toast(ok);
    });
}

/** 计划滞后预警:已到截止日期但过关率没达标的篇目 */
interface PlanWarn { p: RecitePoem; due: string; days: number; passed: number; total: number; rate: number; need: number }
function getPlanWarnings(r: ReciteRecord, counted: ReciteStudent[], poems: RecitePoem[]): PlanWarn[] {
  const target = r.planRate ?? DEFAULT_PLAN_RATE;
  const t = today();
  const out: PlanWarn[] = [];
  for (const p of poems) {
    if (!p.dueDate) continue;
    let passed = 0;
    for (const st of counted) if (isPassed(r.marks[st.id]?.[p.id]?.status)) passed++;
    const n = counted.length || 1;
    const rate = Math.round((passed / n) * 100);
    const days = Math.round((new Date(t + 'T00:00:00').getTime() - new Date(p.dueDate + 'T00:00:00').getTime()) / 86400000);
    if (days >= 0 && rate < target) {
      const need = Math.max(0, Math.ceil(n * (target / 100)) - passed);
      out.push({ p, due: p.dueDate, days, passed, total: counted.length, rate, need });
    }
  }
  return out.sort((a, b) => b.days - a.days);
}

/** 高频错字汇总 */
interface TypoStat { ch: string; count: number; students: Set<string>; poems: Set<string> }
function collectTypos(r: ReciteRecord, counted: ReciteStudent[], poems: RecitePoem[]): TypoStat[] {
  const map = new Map<string, TypoStat>();
  for (const st of counted) {
    const row = r.marks[st.id];
    if (!row) continue;
    for (const p of poems) {
      const list = row[p.id]?.typos;
      if (!list || !list.length) continue;
      for (const ch of list) {
        let e = map.get(ch);
        if (!e) { e = { ch, count: 0, students: new Set(), poems: new Set() }; map.set(ch, e); }
        e.count++; e.students.add(st.id); e.poems.add(p.id);
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count || a.ch.localeCompare(b.ch));
}

/* ============================================================
   根组件
   ============================================================ */

export function RecitePage({ toast, openQr }: Props) {
  const [records, setRecords] = useState<ReciteRecord[]>(getReciteRecords);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const refresh = () => setRecords(getReciteRecords());

  if (activeId) {
    const rec = records.find(r => r.id === activeId);
    if (rec) {
      return (
        <ClassDetail
          record={rec}
          onClose={() => setActiveId(null)}
          onChanged={refresh}
          toast={toast}
          openQr={openQr}
        />
      );
    }
  }

  if (editingId !== null) {
    return (
      <ClassEditor
        recordId={editingId === '__new__' ? null : editingId}
        onClose={() => setEditingId(null)}
        onSaved={(id) => { refresh(); setEditingId(null); setActiveId(id); toast('✅ 已保存'); }}
        toast={toast}
        openQr={openQr}
      />
    );
  }

  return (
    <div className="page">
      <div className="card">
        <div className="card-header"><span className="header-icon">📖</span><span>古诗文背诵统计</span></div>
        <div className="card-body">
          <p className="hint" style={{ marginBottom: 12 }}>
            按班级登记每位学生的古诗文背诵/默写过关情况。内置部编版初中 + 统编版高中篇目共 {ALL_PRESET_COUNT} 篇，
            其中<b>课标必背</b>初中 {KEBIAO_STATS.cz.covered}/{KEBIAO_STATS.cz.total}、高中 {KEBIAO_STATS.gz.covered}/{KEBIAO_STATS.gz.total}，
            可一键导入，也可手工增删。
          </p>

          <button className="btn btn-primary btn-block" onClick={() => setEditingId('__new__')}>
            ➕ 新建背诵登记表
          </button>

          {records.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="section-title">📋 班级列表({records.length})</div>
              {records.map(r => {
                const counted = r.students.filter(isCounted);
                const enabled = r.poems.filter(p => p.active);
                const totalCells = counted.length * enabled.length;
                let passedCells = 0, writtenCells = 0;
                for (const p of enabled) {
                  for (const st of counted) {
                    const s = r.marks[st.id]?.[p.id]?.status;
                    if (isPassed(s)) passedCells++;
                    if (s === 'written') writtenCells++;
                  }
                }
                const rate = totalCells > 0 ? Math.round((passedCells / totalCells) * 100) : 0;
                const writeRate = totalCells > 0 ? Math.round((writtenCells / totalCells) * 100) : 0;
                const warn = getPlanWarnings(r, counted, enabled);
                const special = r.students.length - counted.length;
                return (
                  <div key={r.id} className="rc-class-card">
                    <div className="rc-class-info" onClick={() => setActiveId(r.id)}>
                      <div className="rc-class-title">
                        <strong>{r.classFullName}</strong>
                        <span className="rc-badge">👥 {counted.length}人</span>
                        <span className="rc-badge">📖 {enabled.length}篇</span>
                        {special > 0 && <span className="rc-badge gray">{special}人免检/转出</span>}
                      </div>
                      <div className="rc-class-meta">
                        背诵过关 <b style={{ color: '#007AFF' }}>{rate}%</b> · 默写过关 <b style={{ color: '#34C759' }}>{writeRate}%</b>
                      </div>
                      {warn.length > 0 && (
                        <div className="rc-warn-line">⚠️ {warn.length} 篇已过截止日期仍未达标</div>
                      )}
                      <div className="rc-mini-bar">
                        <div style={{ width: `${rate}%`, background: '#007AFF' }} />
                        <div style={{ width: '0%', background: 'transparent' }} />
                      </div>
                    </div>
                    <div className="rc-class-actions">
                      <button className="btn btn-small btn-secondary" onClick={() => setEditingId(r.id)}>✏️</button>
                      <button className="btn btn-small btn-danger" onClick={() => {
                        if (confirm(`确定删除「${r.classFullName}」的背诵登记表?该班所有过关记录会一并删除。`)) {
                          clearUndo(r.id);
                          deleteReciteRecord(r.id); refresh(); toast('已删除');
                        }
                      }}>🗑️</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {records.length === 0 && (
            <div className="empty" style={{ marginTop: 24 }}>
              <div className="empty-icon">📖</div>
              <p>还没有登记表，点上方按钮创建吧</p>
              <p className="hint" style={{ marginTop: 8 }}>
                如果「作业收缴」里已经录过班级名单，新建时可直接一键导入
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   班级编辑：基本信息 + 学生名单 + 篇目库
   ============================================================ */

function ClassEditor({ recordId, onClose, onSaved, toast, openQr, initialTab = 'base' }: {
  recordId: string | null;
  onClose: () => void;
  onSaved: (id: string) => void;
  toast: Props['toast'];
  openQr: Props['openQr'];
  initialTab?: 'base' | 'students' | 'poems';
}) {
  const existing = recordId ? getReciteRecords().find(r => r.id === recordId) : undefined;

  const [classFullName, setClassFullName] = useState(existing?.classFullName || '');
  const [classShortName, setClassShortName] = useState(existing?.classShortName || '');
  const [grade, setGrade] = useState(existing?.grade || '');
  const [planRate, setPlanRate] = useState(existing?.planRate ?? DEFAULT_PLAN_RATE);
  const [students, setStudents] = useState<ReciteStudent[]>(existing?.students || []);
  const [poems, setPoems] = useState<RecitePoem[]>(existing?.poems || []);

  const [tab, setTab] = useState<'base' | 'students' | 'poems'>(initialTab);
  const roster = useMemo(getHomeworkClassRoster, []);

  const counted = students.filter(isCounted);
  const kbPoems = poems.filter(p => p.kebiao);

  return (
    <div className="page">
      <div className="card">
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span><span className="header-icon">✏️</span>{recordId ? '编辑登记表' : '新建背诵登记表'}</span>
          <button className="btn btn-small btn-secondary" onClick={onClose}>← 返回</button>
        </div>
        <div className="card-body">
          <div className="rc-tabs">
            {([['base', '🏫 班级信息'], ['students', `👥 学生名单(${students.length})`], ['poems', `📖 背诵篇目(${poems.length})`]] as const).map(([k, label]) => (
              <div key={k} className={`rc-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</div>
            ))}
          </div>

          {tab === 'base' && (
            <div>
              <div className="form-group">
                <label>班级名称 <span className="required">*</span></label>
                <input className="form-input" value={classFullName} onChange={e => {
                  const v = e.target.value;
                  setClassFullName(v);
                  const g = v.match(/(高一|高二|高三|初一|初二|初三)/);
                  if (g && !grade) setGrade(g[1]);
                  const s = v.match(/(\d+班|\([\d]+\)班|[一二三四五六七八九十]+班)/);
                  if (s && !classShortName) setClassShortName(s[1]);
                }} placeholder="如：初二(4)班 / 高一5班" />
              </div>
              <div className="form-row">
                <div className="form-group flex1">
                  <label>年级</label>
                  <input className="form-input" value={grade} onChange={e => setGrade(e.target.value)} placeholder="初二" />
                </div>
                <div className="form-group flex1">
                  <label>班级简称</label>
                  <input className="form-input" value={classShortName} onChange={e => setClassShortName(e.target.value)} placeholder="4班" />
                </div>
              </div>
              <div className="form-group">
                <label>计划目标过关率（%）</label>
                <div className="rc-rate-row">
                  <input type="range" min={50} max={100} step={5} value={planRate}
                    onChange={e => setPlanRate(Number(e.target.value))} className="rc-rate-range" />
                  <b className="rc-rate-val">{planRate}%</b>
                </div>
                <p className="hint">篇目设了截止日期后，到期达不到这个比例就会在统计里报警。</p>
              </div>
              <div className="info-box">
                <div>📖 已选篇目：{poems.filter(p => p.active).length} 篇（共 {poems.length} 篇，其中课标必背 {kbPoems.length} 篇）</div>
                <div>👥 在读学生：{counted.length} 人{students.length !== counted.length ? `（另有 ${students.length - counted.length} 人免检/转出，不计入统计）` : ''}</div>
                <div className="hint" style={{ marginTop: 4 }}>
                  一次登记可覆盖整册或整学期，建议按册次导入篇目。
                </div>
              </div>
            </div>
          )}

          {tab === 'students' && (
            <StudentRosterEditor
              students={students}
              setStudents={setStudents}
              roster={roster}
              classShortName={classShortName}
              toast={toast}
            />
          )}

          {tab === 'poems' && (
            <PoemLibraryEditor poems={poems} setPoems={setPoems} toast={toast} />
          )}

          <div className="btn-row" style={{ marginTop: 18 }}>
            <button className="btn btn-primary" onClick={() => {
              if (!classFullName.trim()) { toast('请填写班级名称'); setTab('base'); return; }
              if (students.length === 0 && !confirm('还没有录入学生名单，确定保存吗？')) return;
              if (poems.length === 0 && !confirm('还没有选择背诵篇目，确定保存吗？')) return;
              const id = recordId || genId('rec');
              const record: ReciteRecord = {
                id,
                classFullName: classFullName.trim(),
                classShortName: classShortName.trim() || classFullName.trim(),
                grade: grade.trim(),
                students: students.map((s, i) => ({ ...s, no: i + 1 })),
                poems: poems.map((p, i) => ({ ...p, order: i + 1 })),
                marks: existing?.marks || {},
                planRate,
                createdAt: existing?.createdAt || new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              };
              saveReciteRecord(record);
              onSaved(id);
            }}>💾 保存登记表</button>
            <button className="btn btn-secondary" onClick={onClose}>取消</button>
          </div>

          <button className="btn btn-outline btn-block" style={{ marginTop: 8 }}
            onClick={() => openQr(window.location.origin + window.location.pathname)}>
            📱 二维码分享本工具
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- 学生名单录入 ---------- */

function StudentRosterEditor({ students, setStudents, roster, classShortName, toast }: {
  students: ReciteStudent[];
  setStudents: (fn: (prev: ReciteStudent[]) => ReciteStudent[]) => void;
  classShortName: string;
  roster: { id: string; classFullName: string; classShortName: string; students: ReciteStudent[] }[];
  toast: Props['toast'];
}) {
  const [mode, setMode] = useState<'' | 'hw' | 'paste' | 'ai' | 'manual'>('');
  const [importText, setImportText] = useState('');
  const [newName, setNewName] = useState('');
  const [newGender, setNewGender] = useState<'男' | '女'>('男');

  const addAll = (list: ReciteStudent[]) => {
    setStudents(prev => [...prev, ...list].map((s, i) => ({ ...s, no: i + 1 })));
  };

  const doPasteImport = () => {
    const list = importStudentsFromText(importText, classShortName || '本班');
    if (!list.length) { toast('未识别到有效数据'); return; }
    addAll(list.map(s => ({ id: genId('stu'), no: 0, name: s.name, gender: s.gender, className: s.className || classShortName })));
    setImportText(''); setMode('');
    toast(`✅ 已导入 ${list.length} 位学生`);
  };

  const removeStudent = (idx: number) => {
    setStudents(prev => prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, no: i + 1 })));
  };
  const updateStudent = (idx: number, patch: Partial<ReciteStudent>) => {
    setStudents(prev => prev.map((s, i) => i === idx ? { ...s, ...patch } : s));
  };

  /** 点状态徽章循环切换:在读 → 免检 → 已转出 → 在读 */
  const cycleStatus = (idx: number) => {
    const s = students[idx];
    const cur = stuStatus(s);
    const next: ReciteStudentStatus = cur === 'active' ? 'exempt' : cur === 'exempt' ? 'left' : 'active';
    if (next === 'active') { updateStudent(idx, { status: 'active', reason: '', leftAt: undefined }); return; }
    const label = STUDENT_STATUS_META[next].label;
    const reason = prompt(`把「${s.name}」标记为「${label}」，请填写原因（可留空）：\n例如：体育特长生免检 / 转学到XX中学`, s.reason || '') ?? '';
    updateStudent(idx, {
      status: next,
      reason,
      leftAt: next === 'left' ? today() : undefined,
    });
  };

  const counted = students.filter(isCounted).length;

  return (
    <div>
      <div className="btn-row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        <button className="btn btn-small btn-primary" onClick={() => setMode(mode === 'hw' ? '' : 'hw')}>📚 从作业收缴导入</button>
        <button className="btn btn-small btn-secondary" onClick={() => setMode(mode === 'paste' ? '' : 'paste')}>📋 批量粘贴</button>
        <button className="btn btn-small btn-secondary" onClick={() => setMode(mode === 'ai' ? '' : 'ai')}>🤖 AI 识别名单</button>
        <button className="btn btn-small btn-secondary" onClick={() => setMode(mode === 'manual' ? '' : 'manual')}>➕ 手工添加</button>
      </div>

      <p className="hint" style={{ marginBottom: 10 }}>
        点姓名旁边的「在 / 免 / 转」徽章可切换学籍状态 —— 免检和转出的学生<b>不计入过关率分母</b>，但历史记录会保留。
        当前计入统计 {counted} 人。
      </p>

      {mode === 'hw' && (
        <div className="rc-panel">
          {roster.length === 0 ? (
            <p className="hint">「作业收缴」里还没有录入班级名单。可以去那边先建一个班，或改用「批量粘贴」。</p>
          ) : (
            <>
              <p className="hint" style={{ marginBottom: 8 }}>选择要复用的班级名单（会追加到当前名单）</p>
              {roster.map(r => (
                <div key={r.id} className="rc-row-item">
                  <span>{r.classFullName} · {r.students.length} 人</span>
                  <button className="btn btn-small btn-primary" onClick={() => {
                    addAll(r.students.map(s => ({ ...s, id: genId('stu'), no: 0 })));
                    setMode('');
                    toast(`✅ 已导入 ${r.students.length} 位学生`);
                  }}>导入</button>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {mode === 'paste' && (
        <div className="rc-panel">
          <textarea className="form-textarea" rows={6} value={importText} onChange={e => setImportText(e.target.value)}
            placeholder={'每行一位学生，支持：\n1 张×× 男\n李×× 女\n王××'} />
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button className="btn btn-small btn-primary" onClick={doPasteImport}>识别并导入</button>
            <button className="btn btn-small btn-secondary" onClick={() => { setImportText(''); setMode(''); }}>取消</button>
          </div>
        </div>
      )}

      {mode === 'ai' && (
        <div className="rc-panel">
          <p className="hint" style={{ marginBottom: 8 }}>复制提示词 → 发给豆包并附上名单图片 → 把返回文字粘到「批量粘贴」里</p>
          <div className="copy-box" onClick={() => copyText(RECITE_STUDENT_PROMPT, '✅ 提示词已复制', toast)}>
            <div className="copy-badge">点击复制</div>
            <pre>{RECITE_STUDENT_PROMPT}</pre>
          </div>
        </div>
      )}

      {mode === 'manual' && (
        <div className="rc-panel">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input className="form-input" style={{ flex: 2 }} value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && newName.trim()) {
                  addAll([{ id: genId('stu'), no: 0, name: newName.trim(), gender: newGender, className: classShortName }]);
                  setNewName('');
                }
              }}
              placeholder="学生姓名" />
            <div className="rc-seg">
              {(['男', '女'] as const).map(g => (
                <div key={g} className={`rc-seg-item ${newGender === g ? 'active' : ''}`} onClick={() => setNewGender(g)}>{g}</div>
              ))}
            </div>
            <button className="btn btn-small btn-primary" onClick={() => {
              if (!newName.trim()) return;
              addAll([{ id: genId('stu'), no: 0, name: newName.trim(), gender: newGender, className: classShortName }]);
              setNewName('');
            }}>添加</button>
          </div>
        </div>
      )}

      <div className="rc-student-grid">
        {students.map((s, idx) => {
          const st = stuStatus(s);
          const m = STUDENT_STATUS_META[st];
          return (
            <div key={s.id} className={`rc-student-chip ${st !== 'active' ? 'off' : ''}`} title={s.reason || ''}>
              <span className="rc-chip-no">{s.no}</span>
              <input className="rc-chip-name" value={s.name} onChange={e => updateStudent(idx, { name: e.target.value })} />
              <span className={`rc-chip-gender ${s.gender === '女' ? 'f' : 'm'}`}
                onClick={() => updateStudent(idx, { gender: s.gender === '男' ? '女' : '男' })}>{s.gender}</span>
              <span className="rc-chip-status" style={{ color: m.color, borderColor: m.color }}
                onClick={() => cycleStatus(idx)} title={`点击切换学籍状态（当前：${m.label}）`}>{m.short}</span>
              <span className="rc-chip-del" onClick={() => removeStudent(idx)}>×</span>
            </div>
          );
        })}
      </div>
      {students.length === 0 && <p className="hint" style={{ marginTop: 10 }}>还没有学生，用上面的按钮录入</p>}
    </div>
  );
}

/* ---------- 篇目库编辑 ---------- */

function PoemLibraryEditor({ poems, setPoems, toast }: {
  poems: RecitePoem[];
  setPoems: (fn: (prev: RecitePoem[]) => RecitePoem[]) => void;
  toast: Props['toast'];
}) {
  const [mode, setMode] = useState<'' | 'preset' | 'ai' | 'manual'>('preset');
  const [openVolume, setOpenVolume] = useState<string>('cz-8s');
  const [importText, setImportText] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newAuthor, setNewAuthor] = useState('');
  const [newVolume, setNewVolume] = useState('自定义');
  const [onlyKebiao, setOnlyKebiao] = useState(false);
  const [quizEditId, setQuizEditId] = useState<string>('');
  const [quizText, setQuizText] = useState('');

  const importVolume = (volId: string, kbOnly: boolean) => {
    const vol = PRESET_VOLUMES.find(v => v.id === volId);
    if (!vol) return;
    const have = new Set(poems.map(p => p.title));
    const src = kbOnly ? vol.poems.filter(p => p.kebiao) : vol.poems;
    const add = buildPoemsFromPreset(src.filter(p => !have.has(p.title)), vol.name, poems.length + 1);
    if (!add.length) { toast('该册篇目已全部导入'); return; }
    setPoems(prev => [...prev, ...add]);
    toast(`✅ 已导入《${vol.name}》${add.length} 篇`);
  };

  const doAiImport = () => {
    const list = importPoemsFromText(importText, newVolume || '自定义');
    if (!list.length) { toast('未识别到有效篇目'); return; }
    setPoems(prev => [...prev, ...list.map((p, i) => ({ ...p, order: prev.length + i + 1 }))]);
    setImportText('');
    toast(`✅ 已导入 ${list.length} 篇`);
  };

  const move = (idx: number, dir: -1 | 1) => {
    const to = idx + dir;
    if (to < 0 || to >= poems.length) return;
    setPoems(prev => {
      const next = [...prev];
      [next[idx], next[to]] = [next[to], next[idx]];
      return next.map((p, i) => ({ ...p, order: i + 1 }));
    });
  };

  const groups = useMemo(() => {
    const g: Record<string, RecitePoem[]> = {};
    for (const p of poems) (g[p.volume] ||= []).push(p);
    return g;
  }, [poems]);

  /** 给整册批量设截止日期 */
  const batchDue = (vol: string) => {
    const d = prompt(`给「${vol}」下的所有篇目设定计划完成日期（格式 2026-10-20，留空清除）：`, '');
    if (d === null) return;
    const v = d.trim();
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { toast('日期格式应为 2026-10-20'); return; }
    setPoems(prev => prev.map(p => p.volume === vol ? { ...p, dueDate: v || undefined } : p));
    toast(v ? `✅ ${vol} 截止日期已设为 ${v}` : `已清除 ${vol} 的截止日期`);
  };

  const saveQuiz = (poemId: string) => {
    const items: { p: string; a: string }[] = [];
    for (const raw of quizText.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split(/[|｜]/).map(s => s.trim());
      if (parts.length < 2) continue;
      items.push({ p: parts[0], a: parts.slice(1).join('|') });
    }
    setPoems(prev => prev.map(x => x.id === poemId ? { ...x, quiz: items.length ? items : undefined } : x));
    setQuizEditId('');
    setQuizText('');
    toast(`✅ 已保存 ${items.length} 道默写题`);
  };

  const kbTotal = poems.filter(p => p.kebiao).length;

  return (
    <div>
      <div className="btn-row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        <button className={`btn btn-small ${mode === 'preset' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('preset')}>📚 内置篇目库</button>
        <button className={`btn btn-small ${mode === 'ai' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('ai')}>🤖 AI 识别导入</button>
        <button className={`btn btn-small ${mode === 'manual' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('manual')}>➕ 手工添加</button>
      </div>

      {mode === 'preset' && (
        <div>
          <p className="hint" style={{ marginBottom: 8 }}>
            共 {ALL_PRESET_COUNT} 篇，按册导入（已导入的会自动跳过）。
            课本里的古诗文比课标必背多，勾选下方开关可<b>只导入课标必背篇目</b>。
          </p>
          <label className="rc-check" style={{ marginBottom: 10 }}>
            <input type="checkbox" checked={onlyKebiao} onChange={e => setOnlyKebiao(e.target.checked)} />
            只看 / 只导入课标必背篇目（初中 {KEBIAO_STATS.cz.covered}/{KEBIAO_STATS.cz.total} · 高中 {KEBIAO_STATS.gz.covered}/{KEBIAO_STATS.gz.total}）
          </label>
          {(['初中', '高中'] as const).map(stage => (
            <div key={stage} style={{ marginBottom: 10 }}>
              <div className="rc-stage-title">{stage}</div>
              <div className="rc-vol-list">
                {PRESET_VOLUMES.filter(v => v.stage === stage).map(v => {
                  const open = openVolume === v.id;
                  const kb = volumeKebiaoCount(v);
                  const list = onlyKebiao ? v.poems.filter(p => p.kebiao) : v.poems;
                  if (onlyKebiao && list.length === 0) return null;
                  const have = list.filter(p => poems.some(x => x.title === p.title)).length;
                  return (
                    <div key={v.id} className="rc-vol-item">
                      <div className="rc-vol-head" onClick={() => setOpenVolume(open ? '' : v.id)}>
                        <span>{open ? '▼' : '▶'} {v.name}{kb > 0 && <em className="rc-kb-tag">课标{kb}</em>}</span>
                        <span className="rc-vol-count">{have}/{list.length}</span>
                      </div>
                      {open && (
                        <div className="rc-vol-body">
                          <div className="btn-row" style={{ flexWrap: 'wrap' }}>
                            <button className="btn btn-small btn-primary" onClick={() => importVolume(v.id, false)}>
                              ⬇️ 导入本册（{v.poems.length - v.poems.filter(p => poems.some(x => x.title === p.title)).length} 篇待导入）
                            </button>
                            {kb > 0 && (
                              <button className="btn btn-small btn-success" onClick={() => importVolume(v.id, true)}>
                                ⭐ 只导入课标必背
                              </button>
                            )}
                            <button className="btn btn-small btn-secondary" onClick={() => batchDue(v.name)}>📅 整册设截止日</button>
                          </div>
                          <div className="rc-poem-preview">
                            {list.map(p => (
                              <span key={p.title} className={`rc-poem-tag ${poems.some(x => x.title === p.title) ? 'on' : ''} ${p.kebiao ? 'kb' : ''}`}>
                                {p.title}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {KEBIAO_STATS.missing.cz.length + KEBIAO_STATS.missing.gz.length > 0 && (
            <details className="rc-kb-missing">
              <summary>课标里本库还没收录的篇目（可自行添加）</summary>
              <p className="hint">初中：{KEBIAO_STATS.missing.cz.join('、')}</p>
              <p className="hint">高中：{KEBIAO_STATS.missing.gz.join('、')}</p>
            </details>
          )}
        </div>
      )}

      {mode === 'ai' && (
        <div>
          <div className="copy-box" onClick={() => copyText(RECITE_AI_PROMPT.replace('%N%', '40'), '✅ 提示词已复制', toast)}>
            <div className="copy-badge">点击复制提示词</div>
            <pre>{RECITE_AI_PROMPT.replace('%N%', '40')}</pre>
          </div>
          <div className="form-group" style={{ marginTop: 12 }}>
            <label>归属册次（会显示在篇目上）</label>
            <input className="form-input" value={newVolume} onChange={e => setNewVolume(e.target.value)} placeholder="如：八年级上册 / 校本补充" />
          </div>
          <div className="form-group">
            <label>粘贴 AI 返回的文字</label>
            <textarea className="form-textarea" rows={6} value={importText} onChange={e => setImportText(e.target.value)}
              placeholder={'三峡|郦道元|文|both\n春望|杜甫|诗|both'} />
          </div>
          <button className="btn btn-primary btn-block" onClick={doAiImport}>识别并导入</button>
        </div>
      )}

      {mode === 'manual' && (
        <div className="rc-panel">
          <div className="form-group">
            <label>篇名</label>
            <input className="form-input" value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="如：赤壁" />
          </div>
          <div className="form-row">
            <div className="form-group flex1">
              <label>作者/出处</label>
              <input className="form-input" value={newAuthor} onChange={e => setNewAuthor(e.target.value)} placeholder="杜牧" />
            </div>
            <div className="form-group flex1">
              <label>册次</label>
              <input className="form-input" value={newVolume} onChange={e => setNewVolume(e.target.value)} />
            </div>
          </div>
          <button className="btn btn-primary btn-block" onClick={() => {
            if (!newTitle.trim()) { toast('请填写篇名'); return; }
            setPoems(prev => [...prev, {
              id: genId('poem'), title: newTitle.trim(), author: newAuthor.trim() || '',
              type: /·|词/.test(newTitle) ? '词' : '诗', req: 'both',
              volume: newVolume.trim() || '自定义', order: prev.length + 1, active: true,
            }]);
            setNewTitle(''); setNewAuthor('');
            toast('✅ 已添加');
          }}>➕ 添加到篇目列表</button>
        </div>
      )}

      {poems.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="section-title">
            已选篇目（{poems.length}，课标必背 {kbTotal}）· 点「停用」可暂时不统计
          </div>
          {Object.entries(groups).map(([vol, list]) => (
            <div key={vol} style={{ marginBottom: 10 }}>
              <div className="rc-stage-title">{vol}</div>
              {list.map(p => {
                const idx = poems.findIndex(x => x.id === p.id);
                return (
                  <div key={p.id} className={`rc-poem-row ${p.active ? '' : 'off'}`}>
                    <span className="rc-poem-idx">{p.order}</span>
                    <span className="rc-poem-name" onClick={() => setPoems(prev => prev.map(x => x.id === p.id ? { ...x, kebiao: !x.kebiao } : x))}
                      title="点一下可切换「课标必背」标记">
                      {p.kebiao && <em className="rc-kb-star">⭐</em>}
                      {p.title}
                      <em>{p.author ? ' · ' + p.author : ''}</em>
                    </span>
                    <span className="rc-poem-type" title="默写题库题数"
                      onClick={() => { setQuizEditId(quizEditId === p.id ? '' : p.id); setQuizText((p.quiz || []).map(q => `${q.p}|${q.a}`).join('\n')); }}>
                      {p.quiz?.length ? `题${p.quiz.length}` : '＋题'}
                    </span>
                    <span className="rc-poem-due" title="计划完成日期"
                      onClick={() => {
                        const d = prompt(`《${p.title}》的计划完成日期（2026-10-20，留空清除）：`, p.dueDate || '');
                        if (d === null) return;
                        const v = d.trim();
                        if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { toast('日期格式应为 2026-10-20'); return; }
                        setPoems(prev => prev.map(x => x.id === p.id ? { ...x, dueDate: v || undefined } : x));
                      }}>
                      {p.dueDate ? p.dueDate.slice(5) : '设期限'}
                    </span>
                    <span className="rc-poem-req" onClick={() => setPoems(prev => prev.map(x => x.id === p.id ? { ...x, req: x.req === 'both' ? 'recite' : 'both' } : x))}>
                      {p.req === 'both' ? '背+默' : '仅背'}
                    </span>
                    <span className="rc-poem-type" onClick={() => setPoems(prev => prev.map(x => x.id === p.id ? { ...x, active: !x.active } : x))}>
                      {p.active ? '停用' : '启用'}
                    </span>
                    <span className="rc-poem-move">
                      <button disabled={idx === 0} onClick={() => move(idx, -1)}>↑</button>
                      <button disabled={idx === poems.length - 1} onClick={() => move(idx, 1)}>↓</button>
                    </span>
                    <span className="rc-chip-del" onClick={() => setPoems(prev => prev.filter(x => x.id !== p.id))}>×</span>
                    {quizEditId === p.id && (
                      <div className="rc-quiz-edit">
                        <p className="hint" style={{ margin: '4px 0' }}>每行一题，格式：<b>给出的一句 | 要求默写的一句</b></p>
                        <textarea className="form-textarea" rows={4} value={quizText}
                          onChange={e => setQuizText(e.target.value)}
                          placeholder={'自非亭午夜分|不见曦月\n素湍绿潭|回清倒影'} />
                        <div className="btn-row" style={{ marginTop: 6 }}>
                          <button className="btn btn-small btn-primary" onClick={() => saveQuiz(p.id)}>保存题库</button>
                          <button className="btn btn-small btn-secondary" onClick={() => { setQuizEditId(''); setQuizText(''); }}>取消</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   班级详情：进度矩阵 / 篇目视角 / 学生档案 / 错字本 / 默写卷 / 统计
   ============================================================ */

type DetailTab = 'matrix' | 'poem' | 'student' | 'typo' | 'quiz' | 'stats';

function ClassDetail({ record, onClose, onChanged, toast, openQr, initialTab = 'matrix' }: {
  record: ReciteRecord;
  onClose: () => void;
  onChanged: () => void;
  toast: Props['toast'];
  openQr: Props['openQr'];
  initialTab?: DetailTab;
}) {
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [brush, setBrush] = useState<ReciteStatus>('recited');
  const [volFilter, setVolFilter] = useState<string>('all');
  const [onlyKebiao, setOnlyKebiao] = useState(false);
  const [onlyWeak, setOnlyWeak] = useState(false);
  const [quickPoemId, setQuickPoemId] = useState<string | null>(null);
  const [undoDepth, setUndoDepth] = useState(() => getUndoStack(record.id).length);
  const [redoDepth, setRedoDepth] = useState(() => getRedoStack(record.id).length);
  const [typoTarget, setTypoTarget] = useState<{ studentId: string; poemId: string } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [showImage, setShowImage] = useState(false);

  const countedStudents = useMemo(() => record.students.filter(isCounted), [record.students]);

  const activePoems = useMemo(
    () => record.poems.filter(p => p.active
      && (volFilter === 'all' || p.volume === volFilter)
      && (!onlyKebiao || p.kebiao)),
    [record.poems, volFilter, onlyKebiao],
  );
  const volumes = useMemo(() => Array.from(new Set(record.poems.filter(p => p.active).map(p => p.volume))), [record.poems]);

  /** 取一份最新数据(不是 props 里的那份),用于计算「原值」 */
  const fresh = () => getReciteRecords().find(x => x.id === record.id) || record;

  const persist = (mutator: (r: ReciteRecord) => ReciteRecord) => {
    mutateRecite(record.id, mutator);
    onChanged();
  };

  const syncDepths = () => {
    setUndoDepth(getUndoStack(record.id).length);
    setRedoDepth(getRedoStack(record.id).length);
  };

  const pushChanges = (label: string, changes: UndoChange[]) => {
    if (!changes.length) return;
    pushUndo(record.id, { at: new Date().toISOString(), label, changes });
    // 注意:这里**不**清恢复栈。撤销之后你又标了几格,那些格子由 planRedo
    // 逐格比对后自动跳过,不该因为「你又动手了」就把整条恢复记录作废。
    syncDepths();
  };

  /** 把若干格写成目标状态 */
  const applyStatus = (marks: ReciteRecord['marks'], changes: UndoChange[], status: ReciteStatus) => {
    const next = { ...marks };
    for (const c of changes) {
      const cur = next[c.studentId]?.[c.poemId] || {};
      const m: ReciteMark = { ...cur, status, checkedAt: today() };
      if (status === 'recited' && !cur.reciteDate) m.reciteDate = today();
      if (status === 'written' && !cur.writeDate) m.writeDate = today();
      if (status === 'todo') { m.reciteDate = undefined; m.writeDate = undefined; m.typos = undefined; }
      next[c.studentId] = { ...(next[c.studentId] || {}), [c.poemId]: m };
    }
    return next;
  };

  /** 标记单个格子 */
  const setMark = (studentId: string, poemId: string, status: ReciteStatus) => {
    const prev: ReciteMark | null = fresh().marks[studentId]?.[poemId] || null;
    if (prev && prev.status === status) return;
    const changes: UndoChange[] = [{ studentId, poemId, prev }];
    pushChanges(`标记 1 格为「${meta(status).label}」`, changes);
    persist(r => ({ ...r, marks: applyStatus(r.marks, changes, status) }));
  };

  /** 批量标记单个学生的若干篇(矩阵整行 / 抽查) */
  const bulkSet = (studentId: string, poemIds: string[], status: ReciteStatus) => {
    const src = fresh().marks[studentId] || {};
    const changes: UndoChange[] = poemIds.map(poemId => ({ studentId, poemId, prev: src[poemId] || null }));
    if (!changes.length) return;
    pushChanges(`批量标记 ${changes.length} 格为「${meta(status).label}」`, changes);
    persist(r => ({ ...r, marks: applyStatus(r.marks, changes, status) }));
  };

  /** 全班一次性标记(合并为单条撤销记录,免得要按几十次撤销) */
  const markAll = (poemIds: string[], status: ReciteStatus) => {
    const src = fresh();
    const changes: UndoChange[] = [];
    for (const st of src.students.filter(isCounted)) {
      for (const pid of poemIds) changes.push({ studentId: st.id, poemId: pid, prev: src.marks[st.id]?.[pid] || null });
    }
    if (!changes.length) { toast('没有可标记的学生'); return; }
    const stuCount = new Set(changes.map(c => c.studentId)).size;
    pushChanges(`全班 ${stuCount} 人 × ${poemIds.length} 篇标为「${meta(status).label}」`, changes);
    persist(r => ({ ...r, marks: applyStatus(r.marks, changes, status) }));
  };

  /**
   * 撤销上一步。
   * 撤销的同时把「撤销前的样子」记进恢复栈(见 storage.ts 的说明),
   * 误点了就在下面点「↷ 恢复」放回来 —— 这是用户明确要求的安全网。
   */
  const undo = () => {
    const entry = popUndo(record.id);
    if (!entry) { toast('没有可撤销的操作了'); return; }
    const before = fresh().marks;
    pushRedo(record.id, buildRedoEntry(before, entry));
    persist(r => ({
      ...r,
      marks: writeMarkValues(r.marks, entry.changes.map(c => ({ studentId: c.studentId, poemId: c.poemId, value: c.prev }))),
    }));
    syncDepths();
    toast(`↶ 已撤销：${entry.label}　→ 点「↷ 恢复」可放回来`);
  };

  /**
   * 恢复被撤销掉的那一步。
   * 只把「仍然停在撤销后状态」的格子放回去:撤销之后你又重新标记过的格子保持不动,
   * 宁可少恢复几格,也不覆盖你后来的操作。
   */
  const redo = () => {
    const entry = popRedo(record.id);
    if (!entry) { toast('没有可恢复的操作了'); return; }
    const cur = fresh().marks;
    const { items, skipped } = planRedo(cur, entry);
    if (!items.length) {
      syncDepths();
      toast(skipped ? `这 ${skipped} 格你后来重新标过，就保持现在的` : '没有可恢复的内容了');
      return;
    }
    // 恢复 = 把撤销再倒回去,所以顺手压一条新的撤销记录,还能再撤回来
    pushUndo(record.id, {
      at: new Date().toISOString(),
      label: entry.label,
      changes: items.map(it => ({ studentId: it.studentId, poemId: it.poemId, prev: cur[it.studentId]?.[it.poemId] || null })),
    });
    persist(r => ({ ...r, marks: writeMarkValues(r.marks, items) }));
    syncDepths();
    toast(skipped
      ? `↷ 已恢复：${entry.label}（${skipped} 格你后来改过，保持现状）`
      : `↷ 已恢复：${entry.label}`);
  };

  /** 保存某格的错字 */
  const saveTypos = (studentId: string, poemId: string, chars: string[]) => {
    const prev: ReciteMark | null = fresh().marks[studentId]?.[poemId] || null;
    const changes: UndoChange[] = [{ studentId, poemId, prev }];
    pushChanges(chars.length ? `记录错字「${chars.join('')}」` : '清除错字', changes);
    persist(r => {
      const cur = r.marks[studentId]?.[poemId] || { status: 'todo' as ReciteStatus };
      const next: ReciteMark = { ...cur, typos: chars.length ? chars : undefined };
      return { ...r, marks: { ...r.marks, [studentId]: { ...(r.marks[studentId] || {}), [poemId]: next } } };
    });
    setTypoTarget(null);
    toast(chars.length ? `✅ 已记录错字：${chars.join(' ')}` : '已清除该题错字');
  };

  /** 学生统计（只算在读学生） */
  const studentStats = useMemo(() => record.students.map(st => {
    let passed = 0, written = 0, redo = 0;
    for (const p of activePoems) {
      const s = record.marks[st.id]?.[p.id]?.status;
      if (isPassed(s)) passed++;
      if (s === 'written') written++;
      if (s === 'redo') redo++;
    }
    const counted = isCounted(st);
    return { st, passed, written, redo, total: activePoems.length, left: activePoems.length - passed, counted };
  }), [record, activePoems]);

  /** 篇目统计（分母只算在读学生） */
  const poemStats = useMemo(() => activePoems.map(p => {
    let passed = 0, written = 0, redo = 0;
    const missing: ReciteStudent[] = [];
    for (const st of countedStudents) {
      const s = record.marks[st.id]?.[p.id]?.status;
      if (isPassed(s)) passed++;
      if (s === 'written') written++;
      if (s === 'redo') redo++;
      if (!isPassed(s)) missing.push(st);
    }
    const n = countedStudents.length || 1;
    return { p, passed, written, redo, missing, rate: Math.round((passed / n) * 100), writeRate: Math.round((written / n) * 100) };
  }), [record, activePoems, countedStudents]);

  const overall = useMemo(() => {
    const activeStats = studentStats.filter(x => x.counted);
    const cells = activeStats.length * activePoems.length;
    const passed = activeStats.reduce((s, x) => s + x.passed, 0);
    const written = activeStats.reduce((s, x) => s + x.written, 0);
    const doneStudents = activeStats.filter(x => x.total > 0 && x.passed === x.total).length;
    const writeDoneStudents = activeStats.filter(x => x.total > 0 && x.written === x.total).length;
    return {
      cells,
      rate: cells ? Math.round((passed / cells) * 100) : 0,
      writeRate: cells ? Math.round((written / cells) * 100) : 0,
      doneStudents,
      writeDoneStudents,
      count: activeStats.length,
      lag: [...activeStats].sort((a, b) => b.left - a.left).filter(x => x.left > 0).slice(0, 8),
    };
  }, [studentStats, activePoems]);

  const planWarnings = useMemo(
    () => getPlanWarnings(record, countedStudents, activePoems),
    [record, countedStudents, activePoems],
  );
  const typoStats = useMemo(
    () => collectTypos(record, countedStudents, activePoems),
    [record, countedStudents, activePoems],
  );

  const shownStudents = onlyWeak
    ? [...studentStats].sort((a, b) => b.left - a.left).filter(x => x.left > 0 || !x.counted)
    : studentStats;

  /* ---------- 导出 ---------- */

  const buildMatrix = () => {
    const headers = ['序号', '姓名', '学籍', ...activePoems.map(p => p.title), '未过关数'];
    const rows = record.students.map(st => {
      const row = [String(st.no), st.name, STUDENT_STATUS_META[stuStatus(st)].label];
      let left = 0;
      for (const p of activePoems) {
        const s = record.marks[st.id]?.[p.id]?.status;
        const m = meta(s);
        const ty = record.marks[st.id]?.[p.id]?.typos;
        row.push(ty?.length ? `${m.label}(错:${ty.join('')})` : m.label);
        if (!isPassed(s)) left++;
      }
      row.push(String(left));
      return row;
    });
    return { headers, rows };
  };

  const exportCSVFile = () => {
    const { headers, rows } = buildMatrix();
    exportCSV(`${record.classFullName}_古诗文背诵`, headers, rows);
    toast('📥 已导出 CSV');
  };

  const drawCanvas = () => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext('2d'); if (!ctx) return;
    const N = record.students.length;
    if (!N) return;
    const cellH = 24, headerH = 96, sideCol = 40, nameCol = 84;
    const poemCol = Math.max(52, Math.min(76, 660 / Math.max(1, activePoems.length)));
    const totalW = sideCol + nameCol + poemCol * Math.max(1, activePoems.length) + 76;
    const totalH = headerH + cellH * N + 56;
    c.width = totalW; c.height = totalH;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, totalW, totalH);

    ctx.fillStyle = '#000'; ctx.font = 'bold 19px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`${record.classFullName} 古诗文背诵过关登记表`, totalW / 2, 30);
    ctx.font = '12px "Microsoft YaHei", sans-serif'; ctx.fillStyle = '#666'; ctx.textAlign = 'left';
    ctx.fillText(`共 ${overall.count} 人 · ${activePoems.length} 篇 · 背诵过关率 ${overall.rate}% · 默写过关率 ${overall.writeRate}%`, 18, 52);
    ctx.textAlign = 'right';
    ctx.fillText(`导出：${new Date().toLocaleDateString()}`, totalW - 18, 52);

    let lx = 18; const ly = 72;
    ctx.font = '11px "Microsoft YaHei", sans-serif';
    for (const m of STATUS_META) {
      ctx.fillStyle = m.color;
      ctx.fillRect(lx, ly - 9, 11, 11);
      ctx.fillStyle = '#555';
      ctx.textAlign = 'left';
      ctx.fillText(m.label, lx + 15, ly);
      lx += 15 + ctx.measureText(m.label).width + 18;
    }

    const y0 = headerH;
    const drawCell = (x: number, y: number, w: number, h: number, text: string, color: string, bg: string, bold = false) => {
      ctx.fillStyle = bg; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 1; ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = color;
      ctx.font = `${bold ? 'bold ' : ''}12px "Microsoft YaHei", sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, x + w / 2, y + h / 2);
      ctx.textBaseline = 'alphabetic';
    };

    let x = 0;
    drawCell(x, y0, sideCol, cellH, '序号', '#333', '#fdf0f2', true); x += sideCol;
    drawCell(x, y0, nameCol, cellH, '姓名', '#333', '#fdf0f2', true); x += nameCol;
    activePoems.forEach(p => {
      drawCell(x, y0, poemCol, cellH, p.title.length > 4 ? p.title.slice(0, 4) : p.title, '#333', '#fdf0f2', true);
      x += poemCol;
    });
    drawCell(x, y0, 76, cellH, '未过关', '#333', '#fde8eb', true);

    record.students.forEach((st, i) => {
      const y = y0 + cellH * (i + 1);
      const inactive = !isCounted(st);
      const rowBg = inactive ? '#f0f0f0' : (i % 2 ? '#fff' : '#fafafa');
      let rx = 0;
      drawCell(rx, y, sideCol, cellH, String(st.no), '#666', rowBg); rx += sideCol;
      drawCell(rx, y, nameCol, cellH, st.name + (inactive ? '·' + STUDENT_STATUS_META[stuStatus(st)].short : ''), '#111', rowBg); rx += nameCol;
      let left = 0;
      for (const p of activePoems) {
        const s = record.marks[st.id]?.[p.id]?.status;
        const m = meta(s);
        const ty = record.marks[st.id]?.[p.id]?.typos;
        if (!isPassed(s)) left++;
        drawCell(rx, y, poemCol, cellH, ty?.length ? m.short + '✎' : m.short, m.color, m.bg);
        rx += poemCol;
      }
      drawCell(rx, y, 76, cellH, inactive ? '—' : String(left),
        inactive ? '#999' : (left > 0 ? '#c41e3a' : '#999'),
        inactive ? '#eee' : (left > 0 ? '#ffe4e4' : rowBg), !inactive && left > 0);
    });

    ctx.fillStyle = '#999'; ctx.font = '11px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('教师助手 · 古诗文背诵统计', totalW - 18, totalH - 16);
  };

  const shareImage = () => {
    drawCanvas();
    const c = canvasRef.current; if (!c) return;
    c.toBlob(async blob => {
      if (!blob) { toast('生成失败'); return; }
      const file = new File([blob], `${record.classFullName}_古诗文背诵.png`, { type: 'image/png' });
      if ((navigator as any).canShare?.({ files: [file] })) {
        try { await (navigator as any).share({ files: [file], title: `${record.classFullName}古诗文背诵`, text: '教师助手生成' }); toast('✅ 已分享'); }
        catch { /* 取消 */ }
      } else {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          toast('✅ 已复制到剪贴板，去聊天窗口粘贴');
        } catch {
          const a = document.createElement('a');
          a.download = `${record.classFullName}_古诗文背诵.png`;
          a.href = c.toDataURL('image/png');
          a.click();
          toast('已下载图片');
        }
      }
    }, 'image/png');
  };

  const exportPDF = () => {
    drawCanvas();
    setTimeout(() => {
      const c = canvasRef.current; if (!c) return;
      const win = window.open('', '_blank');
      if (!win) { toast('请允许弹窗'); return; }
      win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${record.classFullName}古诗文背诵</title><style>body{display:flex;flex-direction:column;align-items:center;margin:0;background:#f5f5f5;font-family:sans-serif;padding:30px;}img{max-width:95%;box-shadow:0 4px 20px rgba(0,0,0,0.15);background:white;}.back-btn{position:fixed;top:20px;left:20px;padding:10px 20px;background:#c62828;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;z-index:1000;box-shadow:0 2px 8px rgba(0,0,0,0.2);}@media print{body{background:white;padding:0;}img{box-shadow:none;max-width:100%;}.back-btn{display:none!important;}}</style></head><body><button class="back-btn" onclick="window.close()">← 返回</button><img src="${c.toDataURL('image/png')}" /><script>setTimeout(()=>window.print(),300);</script></body></html>`);
      win.document.close();
      toast('已打开，另存为 PDF 即可');
    }, 120);
  };

  /* ---------- 渲染 ---------- */

  const kbInView = activePoems.filter(p => p.kebiao).length;

  return (
    <div className="page">
      <div className="card">
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span><span className="header-icon">📊</span>{record.classFullName} 背诵统计</span>
          <button className="btn btn-small btn-secondary" onClick={onClose}>← 返回</button>
        </div>
        <div className="card-body">
          <div className="rc-tabs">
            {([['matrix', '🔲 进度矩阵'], ['poem', '📖 篇目视角'], ['student', '👤 学生档案'], ['typo', '✍️ 错字本'], ['quiz', '📝 默写卷'], ['stats', '📈 统计']] as const).map(([k, label]) => (
              <div key={k} className={`rc-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k as DetailTab)}>{label}</div>
            ))}
          </div>

          {record.students.length === 0 && (
            <div className="empty" style={{ margin: '16px 0' }}>
              <div className="empty-icon">👥</div>
              <p>这个班还没有学生名单，请先点「编辑」录入</p>
            </div>
          )}
          {record.poems.filter(p => p.active).length === 0 && (
            <div className="empty" style={{ margin: '16px 0' }}>
              <div className="empty-icon">📖</div>
              <p>还没有选择背诵篇目，请先点「编辑」从内置篇目库导入</p>
            </div>
          )}

          {tab !== 'stats' && tab !== 'quiz' && tab !== 'typo' && (
            <div className="rc-toolbar">
              <select className="form-select rc-select" value={volFilter} onChange={e => setVolFilter(e.target.value)}>
                <option value="all">全部册次（{record.poems.filter(p => p.active).length} 篇）</option>
                {volumes.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
              <label className="rc-check">
                <input type="checkbox" checked={onlyKebiao} onChange={e => setOnlyKebiao(e.target.checked)} />
                只看课标必背（{kbInView} 篇）
              </label>
              <label className="rc-check">
                <input type="checkbox" checked={onlyWeak} onChange={e => setOnlyWeak(e.target.checked)} />
                只看未过关学生
              </label>
            </div>
          )}

          {tab !== 'stats' && tab !== 'quiz' && (undoDepth > 0 || redoDepth > 0) && (
            <div className="rc-undo-bar">
              <span>
                {redoDepth > 0
                  ? `↷ 刚撤销过 ${redoDepth} 步 —— 点「恢复」就能原样放回来，不会丢数据`
                  : `💡 连点错了？可以逐步撤销（还可撤销 ${undoDepth} 步），撤销后也能恢复`}
              </span>
              <span className="rc-undo-pair">
                <button className="btn btn-small btn-outline" disabled={undoDepth === 0} onClick={undo}>
                  ↶ 撤销一步{undoDepth > 0 ? `(${undoDepth})` : ''}
                </button>
                {redoDepth > 0 && (
                  <button className="btn btn-small btn-primary" onClick={redo}>↷ 恢复一步</button>
                )}
              </span>
            </div>
          )}

          {planWarnings.length > 0 && tab === 'stats' && (
            <div className="rc-plan-warn">
              <div className="rc-plan-warn-title">⚠️ 计划进度预警（目标 {record.planRate ?? DEFAULT_PLAN_RATE}%）</div>
              {planWarnings.slice(0, 8).map(w => (
                <div key={w.p.id} className="rc-lag-row">
                  <span className="rc-lag-name">《{w.p.title}》</span>
                  <span className="rc-lag-info">
                    截止 {w.due}（已过 <b style={{ color: '#c41e3a' }}>{w.days}</b> 天）· 过关 <b style={{ color: '#c41e3a' }}>{w.rate}%</b>
                    （{w.passed}/{w.total} 人，还差 {w.need} 人过关）
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* ----- 进度矩阵 ----- */}
          {tab === 'matrix' && record.students.length > 0 && activePoems.length > 0 && (
            <MatrixView
              record={record}
              poems={activePoems}
              students={shownStudents}
              brush={brush}
              setBrush={setBrush}
              onSetMark={setMark}
              onBulkSet={bulkSet}
              onQuickCheck={setQuickPoemId}
              onEditTypo={(studentId, poemId) => setTypoTarget({ studentId, poemId })}
              onUndo={undo}
              undoDepth={undoDepth}
              onRedo={redo}
              redoDepth={redoDepth}
              toast={toast}
            />
          )}

          {/* ----- 篇目视角 ----- */}
          {tab === 'poem' && activePoems.length > 0 && (
            <PoemView
              record={record}
              poemStats={poemStats}
              counted={countedStudents}
              onSetMark={setMark}
              onQuickCheck={setQuickPoemId}
              onEditTypo={(studentId, poemId) => setTypoTarget({ studentId, poemId })}
              toast={toast}
            />
          )}

          {/* ----- 学生档案 ----- */}
          {tab === 'student' && record.students.length > 0 && (
            <StudentView
              record={record}
              activePoems={activePoems}
              studentStats={studentStats}
              onSetMark={setMark}
              onEditTypo={(studentId, poemId) => setTypoTarget({ studentId, poemId })}
              toast={toast}
            />
          )}

          {/* ----- 错字本 ----- */}
          {tab === 'typo' && (
            <TypoView
              record={record}
              poems={activePoems}
              stats={typoStats}
              counted={countedStudents}
              onEditTypo={(studentId, poemId) => setTypoTarget({ studentId, poemId })}
              toast={toast}
            />
          )}

          {/* ----- 默写卷 ----- */}
          {tab === 'quiz' && (
            <QuizView record={record} poems={activePoems} toast={toast} />
          )}

          {/* ----- 统计 ----- */}
          {tab === 'stats' && record.students.length > 0 && activePoems.length > 0 && (
            <div>
              <div className="rc-metric-grid">
                <div className="rc-metric"><span>背诵过关率</span><b style={{ color: '#007AFF' }}>{overall.rate}%</b></div>
                <div className="rc-metric"><span>默写过关率</span><b style={{ color: '#34C759' }}>{overall.writeRate}%</b></div>
                <div className="rc-metric"><span>全篇过关人数</span><b>{overall.doneStudents} / {overall.count}</b></div>
                <div className="rc-metric"><span>全篇默写人数</span><b>{overall.writeDoneStudents} / {overall.count}</b></div>
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                统计分母为在读学生 {overall.count} 人
                {record.students.length !== overall.count && `（另有 ${record.students.length - overall.count} 人免检/转出，不计入）`}。
              </p>

              <div className="section-title" style={{ marginTop: 18 }}>📖 篇目过关率（红色为需要重点补的）</div>
              {[...poemStats].sort((a, b) => a.rate - b.rate).map(ps => (
                <div key={ps.p.id} className="rc-rank-row">
                  <span className="rc-rank-name" title={ps.p.title}>
                    {ps.p.kebiao && <em className="rc-kb-star">⭐</em>}{ps.p.title}
                  </span>
                  <span className="rc-rank-bar">
                    <span style={{ width: `${ps.rate}%`, background: ps.rate >= 80 ? '#34C759' : ps.rate >= 50 ? '#FF9500' : '#FF3B30' }} />
                  </span>
                  <span className="rc-rank-num">{ps.rate}%</span>
                  <span className="rc-rank-sub">{ps.missing.length ? `缺${ps.missing.length}人` : '全班过关'}</span>
                </div>
              ))}

              {overall.lag.length > 0 && (
                <>
                  <div className="section-title" style={{ marginTop: 18 }}>⚠️ 需要重点关注的学生</div>
                  {overall.lag.map(x => (
                    <div key={x.st.id} className="rc-lag-row">
                      <span className="rc-lag-name">{x.st.no}. {x.st.name}</span>
                      <span className="rc-lag-info">
                        未过关 <b style={{ color: '#c41e3a' }}>{x.left}</b> 篇
                        {x.redo > 0 && <> · 待补背 <b style={{ color: '#FF3B30' }}>{x.redo}</b> 篇</>}
                      </span>
                      <button className="btn btn-small btn-secondary" onClick={() => {
                        const titles = activePoems.filter(p => !isPassed(record.marks[x.st.id]?.[p.id]?.status)).map(p => p.title);
                        copyText(`【${record.classFullName}】${x.st.name} 未过关篇目：${titles.join('、')}`, '✅ 已复制', toast);
                      }}>复制</button>
                    </div>
                  ))}
                </>
              )}

              {typoStats.length > 0 && (
                <>
                  <div className="section-title" style={{ marginTop: 18 }}>✍️ 高频错字 TOP10（考前重点提醒）</div>
                  <div className="rc-typo-mini">
                    {typoStats.slice(0, 10).map(t => (
                      <span key={t.ch} className="rc-typo-chip">{t.ch}<em>{t.count}</em></span>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {(record.students.length > 0 && activePoems.length > 0) && (
            <div className="btn-row" style={{ marginTop: 18, flexWrap: 'wrap' }}>
              <button className="btn btn-small btn-outline" onClick={exportCSVFile}>📊 导出CSV</button>
              <button className="btn btn-small btn-outline" onClick={exportPDF}>📄 打印/PDF</button>
              <button className="btn btn-small btn-success" onClick={() => { drawCanvas(); setShowImage(true); }}>🖼️ 预览大图</button>
              <button className="btn btn-small btn-primary" onClick={shareImage}>🔗 分享图片</button>
              <button className="btn btn-small btn-outline" onClick={() => openQr(window.location.origin + window.location.pathname)}>📱 二维码</button>
            </div>
          )}
        </div>
      </div>

      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {showImage && (
        <div className="modal-overlay" onClick={() => setShowImage(false)}>
          <button className="modal-close" onClick={() => setShowImage(false)}>×</button>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <canvas ref={el => {
              if (el && canvasRef.current) {
                const src = canvasRef.current;
                if (el.width !== src.width || el.height !== src.height) {
                  el.width = src.width; el.height = src.height;
                  el.getContext('2d')?.drawImage(src, 0, 0);
                }
              }
            }} style={{ maxWidth: '95vw', maxHeight: '85vh', background: 'white', borderRadius: 4 }} />
          </div>
          <div className="modal-hint">长按可保存图片 · 点空白处关闭</div>
        </div>
      )}

      {quickPoemId && (() => {
        const p = record.poems.find(x => x.id === quickPoemId);
        if (!p) return null;
        return (
          <QuickCheck
            record={record}
            poem={p}
            onClose={() => setQuickPoemId(null)}
              onSetMark={setMark}
              onBulkSet={bulkSet}
              onMarkAll={markAll}
              onEditTypo={(studentId) => setTypoTarget({ studentId, poemId: p.id })}
              toast={toast}
            />
        );
      })()}

      {typoTarget && (() => {
        const st = record.students.find(s => s.id === typoTarget.studentId);
        const p = record.poems.find(x => x.id === typoTarget.poemId);
        if (!st || !p) return null;
        return (
          <TypoDialog
            student={st}
            poem={p}
            initial={record.marks[st.id]?.[p.id]?.typos || []}
            onClose={() => setTypoTarget(null)}
            onSave={(chars) => saveTypos(st.id, p.id, chars)}
          />
        );
      })()}
    </div>
  );
}

/* ============================================================
   进度矩阵
   ============================================================ */

function MatrixView({ record, poems, students, brush, setBrush, onSetMark, onBulkSet, onQuickCheck, onEditTypo, onUndo, undoDepth, onRedo, redoDepth, toast }: {
  record: ReciteRecord;
  poems: RecitePoem[];
  students: { st: ReciteStudent; passed: number; redo: number; left: number; total: number; counted: boolean }[];
  brush: ReciteStatus;
  setBrush: (s: ReciteStatus) => void;
  onSetMark: (studentId: string, poemId: string, s: ReciteStatus) => void;
  onBulkSet: (studentId: string, poemIds: string[], s: ReciteStatus) => void;
  onQuickCheck: (poemId: string) => void;
  onEditTypo: (studentId: string, poemId: string) => void;
  onUndo: () => void;
  undoDepth: number;
  onRedo: () => void;
  redoDepth: number;
  toast: Props['toast'];
}) {
  return (
    <div>
      <div className="rc-brush-bar">
        {/* 四个状态包进一个 nowrap 容器（v31）：换行只可能发生在「整组之前 / 之后」，
            不会再把「待补背」单独挤到第二行。极窄屏（≤360px）由 CSS 切成单字「未/背/默/补」。 */}
        <span className="rc-brush-label">标记为</span>
        <span className="rc-brush-group">
          {STATUS_META.map(m => {
            // 选中的那个做成实心色块 + 白字 + 光环，和没选中的拉开对比，
            // 免得老师点完不确定现在到底选的是哪个状态。
            const on = brush === m.value;
            return (
              <div key={m.value}
                className={`rc-brush-chip ${on ? 'active' : ''}`}
                style={on
                  ? {
                    color: '#fff', background: m.color, borderColor: m.color,
                    boxShadow: `0 0 0 2.5px var(--glass-light), 0 0 0 5.5px ${m.color}55, 0 3px 12px rgba(0,0,0,0.20)`,
                  }
                  : { color: m.color, background: m.bg, borderColor: m.color }}
                onClick={() => setBrush(m.value)}>
                {on && <i className="rc-brush-ck">✓</i>}
                <span className="rc-brush-t">{m.label}</span>
                <span className="rc-brush-s">{m.short}</span>
              </div>
            );
          })}
        </span>
        {/* 撤销 / 恢复成对出现：成对包在一个 nowrap 容器里，窄屏只会整组换行，不会把两个按钮拆散。
            「恢复」只在真的撤销过东西之后才出现，平时不占地方。 */}
        <span className="rc-undo-pair">
          <button className="btn btn-small btn-outline rc-undo-inline" disabled={undoDepth === 0} onClick={onUndo}>
            ↶ 撤销{undoDepth > 0 ? `(${undoDepth})` : ''}
          </button>
          {redoDepth > 0 && (
            <button className="btn btn-small btn-primary rc-redo-inline" onClick={onRedo}>↷ 恢复</button>
          )}
        </span>
      </div>
      <p className="hint" style={{ marginBottom: 10 }}>
        先选状态，再点格子标记。点学生姓名可把该生整行标为所选状态；点篇名进入快速抽查；
        格子右上角有 <b>✎</b> 说明记过错字，<b>长按格子</b>（手机上按住 0.5 秒）可记录错字。
        往下翻学生时，顶上的篇名表头会一直钉住不动。
      </p>

      {/* tbl-scroll：表头（篇名）固定在上沿；首列（学生姓名）也固定，横向找篇目时不会迷路 */}
      <div className="rc-matrix-wrap tbl-scroll">
        <table className="rc-matrix">
          <thead>
            <tr>
              <th className="rc-sticky-col rc-th-name">学生</th>
              {poems.map(p => (
                <th key={p.id} className="rc-th-poem" title={`${p.title}${p.author ? ' · ' + p.author : ''}（点进入快速抽查）`}
                  onClick={() => onQuickCheck(p.id)}>
                  <span>{p.kebiao ? '⭐' : ''}{p.title.replace(/[（(].*?[)）]/g, '').slice(0, 4)}</span>
                </th>
              ))}
              <th className="rc-th-left">未过</th>
            </tr>
          </thead>
          <tbody>
            {students.map(({ st, left, counted }) => {
              const sm = STUDENT_STATUS_META[stuStatus(st)];
              return (
                <tr key={st.id} className={counted ? '' : 'rc-row-off'}>
                  <td className="rc-sticky-col rc-td-name" title="点一下：整行标为所选状态"
                    onClick={() => {
                      if (!counted) { toast(`${st.name} 已标记为「${sm.label}」，不参与统计`); }
                      if (confirm(`把「${st.name}」的 ${poems.length} 篇全部标为「${meta(brush).label}」？`)) {
                        onBulkSet(st.id, poems.map(p => p.id), brush);
                        toast('✅ 已整行标记（可撤销）');
                      }
                    }}>
                    <span className="rc-td-no">{st.no}</span>{st.name}
                    {!counted && <em className="rc-td-status" style={{ color: sm.color }}>{sm.short}</em>}
                  </td>
                  {poems.map(p => {
                    const s = record.marks[st.id]?.[p.id]?.status || 'todo';
                    const m = meta(s);
                    const ty = record.marks[st.id]?.[p.id]?.typos;
                    return (
                      <td key={p.id} className="rc-td-cell">
                        <div className={`rc-cell ${ty?.length ? 'has-typo' : ''}`}
                          style={{ background: m.bg, color: m.color, borderColor: s === 'todo' ? 'rgba(0,0,0,0.08)' : m.color }}
                          title={`${st.name} · ${p.title} · ${m.label}${ty?.length ? ' · 错字：' + ty.join('') : ''}\n点一下标记为「${meta(brush).label}」，长按记错字`}
                          onClick={() => onSetMark(st.id, p.id, brush)}
                          onContextMenu={e => { e.preventDefault(); onEditTypo(st.id, p.id); }}
                          onPointerDown={() => {
                            const timer = window.setTimeout(() => onEditTypo(st.id, p.id), 550);
                            const clear = () => { window.clearTimeout(timer); window.removeEventListener('pointerup', clear); window.removeEventListener('pointercancel', clear); };
                            window.addEventListener('pointerup', clear);
                            window.addEventListener('pointercancel', clear);
                          }}>
                          {s === 'todo' ? '' : m.short}
                          {ty?.length ? <i className="rc-typo-dot" /> : null}
                        </div>
                      </td>
                    );
                  })}
                  <td className="rc-td-left" style={{ color: counted && left > 0 ? '#c41e3a' : '#c7c7cc', fontWeight: counted && left > 0 ? 700 : 400 }}>
                    {counted ? left : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============================================================
   篇目视角
   ============================================================ */

function PoemView({ record, poemStats, counted, onSetMark, onQuickCheck, onEditTypo, toast }: {
  record: ReciteRecord;
  poemStats: { p: RecitePoem; passed: number; written: number; redo: number; missing: ReciteStudent[]; rate: number; writeRate: number }[];
  counted: ReciteStudent[];
  onSetMark: (studentId: string, poemId: string, s: ReciteStatus) => void;
  onQuickCheck: (poemId: string) => void;
  onEditTypo: (studentId: string, poemId: string) => void;
  toast: Props['toast'];
}) {
  const [poemId, setPoemId] = useState(poemStats[0]?.p.id || '');
  const cur = poemStats.find(x => x.p.id === poemId) || poemStats[0];
  if (!cur) return null;

  const passedList = counted.filter(st => isPassed(record.marks[st.id]?.[cur.p.id]?.status));
  const redoList = counted.filter(st => record.marks[st.id]?.[cur.p.id]?.status === 'redo');

  const buildCallText = () => {
    const names = cur.missing.map((st, i) => `${i + 1}.${st.name}`).join('  ');
    return `【${record.classFullName}·古诗文背诵】\n篇目：《${cur.p.title}》${cur.p.author ? '（' + cur.p.author + '）' : ''}\n已过关 ${cur.passed}/${counted.length} 人，还有 ${cur.missing.length} 人未过关：\n${names || '无'}\n请以上同学抽时间找老师过关。`;
  };

  return (
    <div>
      <select className="form-select rc-select" style={{ marginBottom: 12 }} value={poemId} onChange={e => setPoemId(e.target.value)}>
        {poemStats.map(x => (
          <option key={x.p.id} value={x.p.id}>{x.p.kebiao ? '⭐' : ''}{x.p.title} · 过关率 {x.rate}%</option>
        ))}
      </select>

      <div className="info-box">
        <div style={{ fontSize: 15, fontWeight: 700 }}>
          《{cur.p.title}》{cur.p.author && <span style={{ fontWeight: 400, color: 'var(--text-3)' }}> · {cur.p.author}</span>}
          {cur.p.kebiao && <span className="rc-kb-badge">课标必背</span>}
        </div>
        <div style={{ marginTop: 6 }}>
          背诵过关 <b style={{ color: '#007AFF' }}>{cur.passed}</b> 人 ·
          默写过关 <b style={{ color: '#34C759' }}>{cur.written}</b> 人 ·
          未过关 <b style={{ color: '#c41e3a' }}>{cur.missing.length}</b> 人
          {cur.redo > 0 && <> · 待补背 <b style={{ color: '#FF3B30' }}>{cur.redo}</b> 人</>}
        </div>
        {cur.p.dueDate && (
          <div className="hint" style={{ marginTop: 4 }}>
            📅 计划完成日期 {cur.p.dueDate}
            {cur.p.dueDate < today() && cur.rate < (record.planRate ?? DEFAULT_PLAN_RATE)
              ? <b style={{ color: '#c41e3a' }}> · 已滞后</b>
              : <b style={{ color: '#34C759' }}> · 正常</b>}
          </div>
        )}
      </div>

      <div className="btn-row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
        <button className="btn btn-small btn-primary" onClick={() => onQuickCheck(cur.p.id)}>⚡ 快速抽查</button>
        <button className="btn btn-small btn-outline" onClick={() => copyText(buildCallText(), '✅ 催办文案已复制，可发家长群', toast)}>📋 生成催办清单</button>
        <button className="btn btn-small btn-outline" onClick={() => {
          const list = cur.missing.flatMap(st => (record.marks[st.id]?.[cur.p.id]?.typos || []).map(c => `${st.name}：${c}`));
          if (!list.length) { toast('这一篇还没有记录错字'); return; }
          copyText(`【${record.classFullName}·《${cur.p.title}》错字清单】\n${list.join('\n')}`, '✅ 错字清单已复制', toast);
        }}>✍️ 复制本篇错字</button>
      </div>

      {redoList.length > 0 && (
        <div className="rc-lag-row" style={{ background: 'rgba(255,59,48,0.08)', marginTop: 12 }}>
          <span className="rc-lag-name">🔴 待补背名单</span>
          <span className="rc-lag-info">{redoList.map(s => s.name).join('、')}</span>
        </div>
      )}

      <div className="section-title" style={{ marginTop: 16 }}>❌ 未过关名单（{cur.missing.length}人）</div>
      {cur.missing.length === 0 ? (
        <p className="hint">🎉 全班都已过关！</p>
      ) : (
        <div className="rc-student-grid">
          {cur.missing.map(st => (
            <div key={st.id} className="rc-miss-chip">
              <span className="rc-chip-no">{st.no}</span>
              <span className="rc-miss-name">{st.name}</span>
              {(record.marks[st.id]?.[cur.p.id]?.typos?.length || 0) > 0 && (
                <span className="rc-miss-typo" title="已记录的错字" onClick={() => onEditTypo(st.id, cur.p.id)}>
                  {record.marks[st.id]![cur.p.id].typos!.join('')}
                </span>
              )}
              <button className="rc-mini-btn" title="记错字" onClick={() => onEditTypo(st.id, cur.p.id)}>✎</button>
              <button className="rc-mini-btn" title="标为已背" onClick={() => onSetMark(st.id, cur.p.id, 'recited')}>背</button>
              <button className="rc-mini-btn g" title="标为已默写" onClick={() => onSetMark(st.id, cur.p.id, 'written')}>默</button>
            </div>
          ))}
        </div>
      )}

      <div className="section-title" style={{ marginTop: 16 }}>✅ 已过关名单（{passedList.length}人）</div>
      <div className="rc-passed-list">
        {passedList.length === 0 ? <span className="hint">还没有人过关</span> :
          passedList.map(st => {
            const s = record.marks[st.id]?.[cur.p.id]?.status;
            const ty = record.marks[st.id]?.[cur.p.id]?.typos;
            return (
              <span key={st.id} className="rc-passed-chip" style={{ borderColor: meta(s).color, color: meta(s).color }}
                title={ty?.length ? `错字：${ty.join('')}` : ''}
                onClick={() => onSetMark(st.id, cur.p.id, s === 'written' ? 'recited' : 'todo')}>
                {st.name}·{meta(s).label}{ty?.length ? `(✎${ty.join('')})` : ''}
              </span>
            );
          })}
      </div>
    </div>
  );
}

/* ============================================================
   学生档案
   ============================================================ */

function StudentView({ record, activePoems, studentStats, onSetMark, onEditTypo, toast }: {
  record: ReciteRecord;
  activePoems: RecitePoem[];
  studentStats: { st: ReciteStudent; passed: number; written: number; redo: number; total: number; left: number; counted: boolean }[];
  onSetMark: (studentId: string, poemId: string, s: ReciteStatus) => void;
  onEditTypo: (studentId: string, poemId: string) => void;
  toast: Props['toast'];
}) {
  const [sid, setSid] = useState(studentStats[0]?.st.id || '');
  const target = studentStats.find(x => x.st.id === sid) || studentStats[0];
  if (!target) return null;

  const groups: Record<string, RecitePoem[]> = {};
  for (const p of activePoems) (groups[p.volume] ||= []).push(p);

  const myTypos: { poem: RecitePoem; chars: string[] }[] = [];
  for (const p of activePoems) {
    const t = record.marks[target.st.id]?.[p.id]?.typos;
    if (t?.length) myTypos.push({ poem: p, chars: t });
  }

  const buildReport = () => {
    const lines: string[] = [`【${record.classFullName}·古诗文背诵情况反馈】`, `学生：${target.st.name}`, `进度：已过关 ${target.passed}/${target.total} 篇，其中默写过关 ${target.written} 篇。`];
    const miss = activePoems.filter(p => !isPassed(record.marks[target.st.id]?.[p.id]?.status));
    if (miss.length) lines.push(`待过关篇目：${miss.map(p => p.title).join('、')}`);
    else lines.push('全部篇目均已过关，表现优秀！');
    if (myTypos.length) lines.push(`默写易错字：${myTypos.map(x => `${x.poem.title}「${x.chars.join('')}」`).join('；')}`);
    return lines.join('\n');
  };

  const sm = STUDENT_STATUS_META[stuStatus(target.st)];

  return (
    <div>
      <select className="form-select rc-select" style={{ marginBottom: 12 }} value={sid} onChange={e => setSid(e.target.value)}>
        {studentStats.map(x => (
          <option key={x.st.id} value={x.st.id}>
            {x.st.no}. {x.st.name} · 已过 {x.passed}/{x.total}{x.counted ? '' : `〔${STUDENT_STATUS_META[stuStatus(x.st)].label}〕`}
          </option>
        ))}
      </select>

      <div className="rc-student-card">
        <div className="rc-sc-head">
          <div className="rc-sc-avatar">{target.st.name.slice(0, 1)}</div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>
              {target.st.name}
              {!target.counted && <span className="rc-kb-badge" style={{ marginLeft: 8 }}>{sm.label}</span>}
            </div>
            <div className="hint" style={{ margin: 0 }}>{record.classFullName} · {target.st.gender}{target.st.reason ? ` · ${target.st.reason}` : ''}</div>
          </div>
        </div>
        <div className="rc-sc-stats">
          <div><span>已过关</span><b style={{ color: '#007AFF' }}>{target.passed}/{target.total}</b></div>
          <div><span>已默写</span><b style={{ color: '#34C759' }}>{target.written}</b></div>
          <div><span>待补背</span><b style={{ color: '#FF3B30' }}>{target.redo}</b></div>
        </div>
      </div>

      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn btn-small btn-outline" onClick={() => copyText(buildReport(), '✅ 反馈文案已复制，可发家长', toast)}>📋 生成家长反馈</button>
      </div>

      {myTypos.length > 0 && (
        <div className="rc-typo-self">
          <div className="section-title" style={{ marginTop: 16, marginBottom: 6 }}>✍️ 该生的易错字（{myTypos.length} 篇）</div>
          {myTypos.map(x => (
            <div key={x.poem.id} className="rc-lag-row">
              <span className="rc-lag-name">{x.poem.title}</span>
              <span className="rc-lag-info">
                {x.chars.map(c => <span key={c} className="rc-typo-chip small">{c}</span>)}
              </span>
              <button className="btn btn-small btn-secondary" onClick={() => onEditTypo(target.st.id, x.poem.id)}>编辑</button>
            </div>
          ))}
        </div>
      )}

      {Object.entries(groups).map(([vol, list]) => (
        <div key={vol} style={{ marginTop: 14 }}>
          <div className="rc-stage-title">{vol}</div>
          <div className="rc-poem-progress">
            {list.map(p => {
              const s = record.marks[target.st.id]?.[p.id]?.status || 'todo';
              const mark = record.marks[target.st.id]?.[p.id];
              return (
                <div key={p.id} className="rc-pp-row">
                  <span className="rc-pp-title" title={mark?.typos?.length ? `错字：${mark.typos.join('')}` : ''}>
                    {p.kebiao ? '⭐' : ''}{p.title}{mark?.typos?.length ? <i className="rc-typo-dot" /> : null}
                  </span>
                  <span className="rc-pp-date">
                    {mark?.writeDate ? `默写 ${mark.writeDate}` : mark?.reciteDate ? `背诵 ${mark.reciteDate}` : ''}
                  </span>
                  <div className="rc-pp-btns">
                    <div className="rc-pp-btn" title="记录错字" onClick={() => onEditTypo(target.st.id, p.id)}>✎</div>
                    {STATUS_META.map(o => {
                      const on = s === o.value;
                      return (
                        <div key={o.value}
                          className={`rc-pp-btn ${on ? 'active' : ''}`}
                          style={{ color: on ? '#fff' : o.color, background: on ? o.color : o.bg, borderColor: o.color }}
                          onClick={() => onSetMark(target.st.id, p.id, o.value)}>
                          {on ? '✓ ' : ''}{o.label}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ============================================================
   错字本：高频错字榜 + 逐人逐篇清单
   ============================================================ */

function TypoView({ record, poems, stats, counted, onEditTypo, toast }: {
  record: ReciteRecord;
  poems: RecitePoem[];
  stats: TypoStat[];
  counted: ReciteStudent[];
  onEditTypo: (studentId: string, poemId: string) => void;
  toast: Props['toast'];
}) {
  const [groupBy, setGroupBy] = useState<'char' | 'poem' | 'student'>('char');

  const titleOf = (id: string) => record.poems.find(p => p.id === id)?.title || '';

  const totalTypo = stats.reduce((s, x) => s + x.count, 0);
  const totalChars = stats.length;

  const buildReviewSheet = () => {
    const lines: string[] = [`【${record.classFullName}·默写易错字复习单】`, `统计范围：${poems.length} 篇 · ${counted.length} 人`, ''];
    lines.push('一、高频易错字排行');
    stats.slice(0, 30).forEach((t, i) => lines.push(`${i + 1}. ${t.ch}（${t.count} 次，${t.students.size} 人写错）`));
    lines.push('', '二、分篇错字清单');
    for (const p of poems) {
      const rows: string[] = [];
      for (const st of counted) {
        const ty = record.marks[st.id]?.[p.id]?.typos;
        if (ty?.length) rows.push(`${st.name}：${ty.join('')}`);
      }
      if (rows.length) { lines.push(`《${p.title}》`); rows.forEach(r => lines.push('  ' + r)); }
    }
    return lines.join('\n');
  };

  const exportTypoCSV = () => {
    const headers = ['错字', '写错次数', '涉及人数', '涉及篇目'];
    const rows = stats.map(t => [t.ch, String(t.count), String(t.students.size), Array.from(t.poems).map(titleOf).join('、')]);
    exportCSV(`${record.classFullName}_默写错字统计`, headers, rows);
    toast('📥 已导出错字统计 CSV');
  };

  if (!stats.length) {
    return (
      <div className="empty" style={{ margin: '16px 0' }}>
        <div className="empty-icon">✍️</div>
        <p>还没有记录任何错字</p>
        <p className="hint" style={{ marginTop: 8 }}>
          在「进度矩阵」里<b>长按格子</b>（电脑上右键），或在「篇目视角」点学生旁边的 <b>✎</b>，就能把他写错的字记下来。
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="rc-metric-grid">
        <div className="rc-metric"><span>不同错字</span><b style={{ color: '#c41e3a' }}>{totalChars}</b></div>
        <div className="rc-metric"><span>错字总次数</span><b>{totalTypo}</b></div>
        <div className="rc-metric"><span>最常错字</span><b style={{ color: '#c41e3a' }}>{stats[0].ch}</b></div>
        <div className="rc-metric"><span>涉及学生</span><b>{stats.reduce((s, x) => Math.max(s, x.students.size), 0)} 人</b></div>
      </div>

      <div className="rc-toolbar" style={{ marginTop: 12 }}>
        <div className="rc-seg">
          {([['char', '按错字'], ['poem', '按篇目'], ['student', '按学生']] as const).map(([k, l]) => (
            <div key={k} className={`rc-seg-item ${groupBy === k ? 'active' : ''}`} onClick={() => setGroupBy(k)}>{l}</div>
          ))}
        </div>
        <button className="btn btn-small btn-primary" onClick={() => copyText(buildReviewSheet(), '✅ 复习单已复制，可直接打印或发群', toast)}>📋 生成复习单</button>
        <button className="btn btn-small btn-outline" onClick={exportTypoCSV}>📊 导出CSV</button>
      </div>

      {groupBy === 'char' && (
        <>
          <div className="section-title" style={{ marginTop: 16 }}>🔥 高频错字榜</div>
          {stats.slice(0, 40).map((t, i) => (
            <div key={t.ch} className="rc-typo-row">
              <span className="rc-typo-rank">{i + 1}</span>
              <span className="rc-typo-char">{t.ch}</span>
              <span className="rc-typo-bar">
                <span style={{ width: `${Math.round((t.count / stats[0].count) * 100)}%` }} />
              </span>
              <span className="rc-typo-num">{t.count} 次 · {t.students.size} 人</span>
              <span className="rc-typo-poems" title="点开可看涉及篇目">
                {Array.from(t.poems).slice(0, 2).map(titleOf).join('、')}
                {t.poems.size > 2 ? ` 等${t.poems.size}篇` : ''}
              </span>
            </div>
          ))}
        </>
      )}

      {groupBy === 'poem' && poems.map(p => {
        const rows = counted.filter(st => (record.marks[st.id]?.[p.id]?.typos?.length || 0) > 0);
        if (!rows.length) return null;
        return (
          <div key={p.id} style={{ marginTop: 14 }}>
            <div className="rc-stage-title">
              {p.kebiao ? '⭐' : ''}{p.title}
              <span style={{ fontWeight: 400, marginLeft: 6, fontSize: 12, opacity: 0.7 }}>{rows.length} 人写错</span>
            </div>
            {rows.map(st => {
              const ty = record.marks[st.id]![p.id].typos!;
              return (
                <div key={st.id} className="rc-lag-row">
                  <span className="rc-lag-name">{st.no}. {st.name}</span>
                  <span className="rc-lag-info">{ty.map(c => <span key={c} className="rc-typo-chip small">{c}</span>)}</span>
                  <button className="btn btn-small btn-secondary" onClick={() => onEditTypo(st.id, p.id)}>编辑</button>
                </div>
              );
            })}
          </div>
        );
      })}

      {groupBy === 'student' && counted.map(st => {
        const rows = poems.filter(p => (record.marks[st.id]?.[p.id]?.typos?.length || 0) > 0);
        if (!rows.length) return null;
        return (
          <div key={st.id} style={{ marginTop: 14 }}>
            <div className="rc-stage-title">
              {st.no}. {st.name}
              <span style={{ fontWeight: 400, marginLeft: 6, fontSize: 12, opacity: 0.7 }}>{rows.length} 篇有错字</span>
            </div>
            {rows.map(p => {
              const ty = record.marks[st.id]![p.id].typos!;
              return (
                <div key={p.id} className="rc-lag-row">
                  <span className="rc-lag-name">{p.title}</span>
                  <span className="rc-lag-info">{ty.map(c => <span key={c} className="rc-typo-chip small">{c}</span>)}</span>
                  <button className="btn btn-small btn-secondary" onClick={() => onEditTypo(st.id, p.id)}>编辑</button>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- 错字录入弹层 ---------- */

function TypoDialog({ student, poem, initial, onClose, onSave }: {
  student: ReciteStudent;
  poem: RecitePoem;
  initial: string[];
  onClose: () => void;
  onSave: (chars: string[]) => void;
}) {
  const [text, setText] = useState(initial.join(' '));
  const chars = parseTypos(text);
  const qs = poem.quiz || [];

  return (
    <div className="rc-typo-overlay" onClick={onClose}>
      <div className="rc-typo-dialog" onClick={e => e.stopPropagation()}>
        <div className="rc-typo-dialog-head">
          <b>✍️ 记录错字</b>
          <span>{student.name} · 《{poem.title}》</span>
        </div>
        <p className="hint" style={{ margin: '0 0 8px' }}>
          把学生默写时写错的字敲进去，多个字直接连着写就行（会自动去重，只保留汉字）。
        </p>
        <textarea className="form-textarea" rows={3} value={text} autoFocus
          onChange={e => setText(e.target.value)}
          placeholder="例如：曾滥拂阙" />
        <div className="rc-typo-preview">
          {chars.length === 0 ? <span className="hint">还没有识别到错字</span> :
            chars.map(c => <span key={c} className="rc-typo-chip">{c}</span>)}
        </div>
        {qs.length > 0 && (
          <div className="rc-typo-quiz">
            <div className="hint" style={{ marginBottom: 4 }}>点下面的句子可把该句的易错字加进去：</div>
            {qs.slice(0, 6).map((q, i) => (
              <div key={i} className="rc-typo-quiz-line" onClick={() => setText(t => (t + ' ' + parseTypos(q.a).join('')).trim())}>
                {q.p} <b>{q.a}</b>
              </div>
            ))}
          </div>
        )}
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn btn-primary" onClick={() => onSave(chars)}>保存（{chars.length} 个字）</button>
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   默写卷生成
   ============================================================ */

interface PaperQ { title: string; printed: string; answer: string }

function QuizView({ record, poems, toast }: {
  record: ReciteRecord;
  poems: RecitePoem[];
  toast: Props['toast'];
}) {
  const [scope, setScope] = useState<'withQuiz' | 'all'>('withQuiz');
  const [mode, setMode] = useState<'forward' | 'reverse' | 'mix' | 'blank'>('forward');
  const [count, setCount] = useState(15);
  const [withAnswer, setWithAnswer] = useState(true);
  const [shuffle, setShuffle] = useState(true);
  const [pick, setPick] = useState<Record<string, boolean>>({});
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');

  const poemsWithQuiz = poems.filter(p => (p.quiz?.length || 0) > 0);
  const scopePoems = scope === 'withQuiz' ? poemsWithQuiz : poems;

  const pool: PaperQ[] = useMemo(() => {
    const out: PaperQ[] = [];
    for (const p of scopePoems) {
      if (pick[p.id] === false) continue;
      for (const q of p.quiz || []) {
        if (mode === 'forward') out.push({ title: p.title, printed: q.p, answer: q.a });
        else if (mode === 'reverse') out.push({ title: p.title, printed: q.a, answer: q.p });
        else if (mode === 'mix') {
          const rev = Math.random() < 0.5;
          out.push(rev ? { title: p.title, printed: q.a, answer: q.p } : { title: p.title, printed: q.p, answer: q.a });
        }
      }
    }
    if (shuffle) {
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
    }
    return out;
  }, [scopePoems, pick, mode, shuffle]);

  const questions = useMemo(() => pool.slice(0, Math.max(1, count)), [pool, count]);

  const openPaper = () => {
    if (mode === 'blank') {
      const list = scopePoems.filter(p => pick[p.id] !== false);
      if (!list.length) { toast('请先选择要考的篇目'); return; }
      const html = blankPaperHtml(record, list);
      const w = window.open('', '_blank');
      if (!w) { toast('请允许弹窗'); return; }
      w.document.write(html); w.document.close();
      return;
    }
    if (!questions.length) { toast('没有可用的题目，请先给篇目录入默写题库'); return; }
    const html = paperHtml(record, questions, withAnswer);
    const w = window.open('', '_blank');
    if (!w) { toast('请允许弹窗'); return; }
    w.document.write(html); w.document.close();
    toast('已打开试卷，可直接打印');
  };

  const doImportQuiz = () => {
    const list = parseQuizText(importText);
    if (!list.length) { toast('未识别到有效题目'); return; }
    const byTitle = new Map<string, { p: string; a: string }[]>();
    for (const item of list) {
      const arr = byTitle.get(item.title) || [];
      arr.push({ p: item.p, a: item.a });
      byTitle.set(item.title, arr);
    }
    let matched = 0; const unmatched: string[] = [];
    const updated = poems.map(p => {
      const add = byTitle.get(p.title);
      if (!add) return p;
      matched++;
      const existing = p.quiz || [];
      const merged = [...existing];
      for (const q of add) if (!merged.some(x => x.p === q.p && x.a === q.a)) merged.push(q);
      return { ...p, quiz: merged };
    });
    for (const t of byTitle.keys()) if (!poems.some(p => p.title === t)) unmatched.push(t);
    if (!matched) { toast('篇名都对不上，请检查第一段是否与篇目库里的篇名完全一致'); return; }
    saveReciteRecord({ ...record, poems: updated, updatedAt: new Date().toISOString() });
    setImportOpen(false); setImportText('');
    toast(`✅ 已为 ${matched} 篇导入题目${unmatched.length ? `，${unmatched.length} 个篇名未匹配：${unmatched.slice(0, 3).join('、')}` : ''}`);
    setTimeout(() => window.location.reload(), 700);
  };

  const copyQuizPrompt = () => {
    const list = scopePoems.map(p => p.title).join('\n');
    copyText(RECITE_QUIZ_PROMPT.replace('%LIST%', list || '（请先选择篇目）'), '✅ 出题提示词已复制，发给豆包即可', toast);
  };

  return (
    <div>
      <div className="info-box">
        <div>📝 题库现状：<b>{QUIZ_POEM_COUNT}</b> 篇共 <b>{QUIZ_COUNT}</b> 道名句默写题（内置）</div>
        <div>当前范围：<b>{scopePoems.length}</b> 篇有题库，可出 <b>{pool.length}</b> 道题</div>
        {poems.length > poemsWithQuiz.length && (
          <div className="hint" style={{ marginTop: 4 }}>
            还有 {poems.length - poemsWithQuiz.length} 篇没录题库，可以用下面的「AI 生成题目」批量补。
          </div>
        )}
      </div>

      <div className="rc-panel" style={{ marginTop: 14 }}>
        <div className="form-group">
          <label>出题范围</label>
          <div className="rc-seg">
            {([['withQuiz', `只用有题库的(${poemsWithQuiz.length})`], ['all', `全部篇目(${poems.length})`]] as const).map(([k, l]) => (
              <div key={k} className={`rc-seg-item ${scope === k ? 'active' : ''}`} onClick={() => setScope(k)}>{l}</div>
            ))}
          </div>
        </div>
        <div className="form-group">
          <label>题型</label>
          <div className="rc-seg">
            {([['forward', '给上句填下句'], ['reverse', '给下句填上句'], ['mix', '混合'], ['blank', '整篇默写']] as const).map(([k, l]) => (
              <div key={k} className={`rc-seg-item ${mode === k ? 'active' : ''}`} onClick={() => setMode(k)}>{l}</div>
            ))}
          </div>
          {mode === 'blank' && <p className="hint">整篇默写会按所选篇目打印「篇名 + 作者 + 空白格」，不依赖题库。</p>}
        </div>
        {mode !== 'blank' && (
          <div className="form-row">
            <div className="form-group flex1">
              <label>题量</label>
              <input type="number" className="form-input" min={5} max={100} value={count}
                onChange={e => setCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
            </div>
            <div className="form-group flex1">
              <label>选项</label>
              <div style={{ paddingTop: 8 }}>
                <label className="rc-check"><input type="checkbox" checked={withAnswer} onChange={e => setWithAnswer(e.target.checked)} />附答案页</label>
                <label className="rc-check"><input type="checkbox" checked={shuffle} onChange={e => setShuffle(e.target.checked)} />打乱顺序</label>
              </div>
            </div>
          </div>
        )}
        <button className="btn btn-primary btn-block" onClick={openPaper}>🖨️ 生成试卷并打印</button>
      </div>

      <div className="section-title" style={{ marginTop: 18 }}>📚 选题（默认全选，点一下可排除某篇）</div>
      <div className="rc-quiz-pick">
        {poems.map(p => (
          <span key={p.id}
            className={`rc-poem-tag ${pick[p.id] === false ? '' : 'on'} ${p.kebiao ? 'kb' : ''}`}
            onClick={() => setPick(prev => ({ ...prev, [p.id]: prev[p.id] === false }))}>
            {p.title}{p.quiz?.length ? `(${p.quiz.length})` : ''}
          </span>
        ))}
      </div>

      <div className="section-title" style={{ marginTop: 18 }}>🤖 给这些篇目生成题库</div>
      <div className="btn-row" style={{ flexWrap: 'wrap' }}>
        <button className="btn btn-small btn-primary" onClick={copyQuizPrompt}>📋 复制出题提示词</button>
        <button className="btn btn-small btn-secondary" onClick={() => setImportOpen(!importOpen)}>⬇️ 粘贴导入题目</button>
      </div>
      <p className="hint" style={{ marginTop: 6 }}>
        把提示词发给豆包/DeepSeek，它会按「篇名|上句|下句」的格式出题，粘回来即可入库。
      </p>

      {importOpen && (
        <div className="rc-panel" style={{ marginTop: 10 }}>
          <textarea className="form-textarea" rows={6} value={importText} onChange={e => setImportText(e.target.value)}
            placeholder={'三峡|自非亭午夜分|不见曦月\n春望|感时花溅泪|恨别鸟惊心'} />
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button className="btn btn-small btn-primary" onClick={doImportQuiz}>识别并入库</button>
            <button className="btn btn-small btn-secondary" onClick={() => { setImportOpen(false); setImportText(''); }}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}

function paperHtml(record: ReciteRecord, qs: PaperQ[], withAnswer: boolean): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const qHtml = qs.map((q, i) => `
    <div class="q"><span class="no">${i + 1}.</span>
      <span class="body">${esc(q.printed)}<span class="blank"></span><span class="src">《${esc(q.title)}》</span></span>
    </div>`).join('');
  const aHtml = withAnswer ? `
    <div class="page-break"></div>
    <h2>参考答案</h2>
    <div class="answers">${qs.map((q, i) => `<div class="a"><b>${i + 1}.</b> ${esc(q.answer)} <span class="src">《${esc(q.title)}》</span></div>`).join('')}</div>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${record.classFullName}古诗文默写</title><style>
  *{box-sizing:border-box;}
  body{font-family:"Songti SC","SimSun","Microsoft YaHei",serif;margin:0;padding:28px 34px;color:#111;}
  h1{font-size:20px;text-align:center;margin:0 0 6px;letter-spacing:2px;}
  .meta{text-align:center;font-size:12px;color:#555;margin-bottom:6px;}
  .fill{display:flex;justify-content:space-between;font-size:12px;color:#333;border-top:1px solid #bbb;border-bottom:1px solid #bbb;padding:6px 0;margin-bottom:16px;}
  .tip{font-size:12px;color:#666;margin-bottom:12px;}
  .q{display:flex;gap:6px;font-size:15px;line-height:2.1;margin-bottom:10px;}
  .no{min-width:24px;color:#333;}
  .body{flex:1;}
  .blank{display:inline-block;min-width:170px;border-bottom:1px solid #333;margin:0 6px;height:1.2em;vertical-align:-2px;}
  .src{font-size:12px;color:#888;margin-left:6px;}
  h2{font-size:16px;margin:0 0 10px;}
  .answers{font-size:14px;line-height:1.9;}
  .a{margin-bottom:4px;}
  .page-break{page-break-before:always;height:24px;}
  @media print{@page{margin:14mm;} body{padding:0;} .noprint{display:none!important;}}
  .noprint{position:fixed;top:14px;right:14px;display:flex;gap:8px;}
  .noprint button{padding:8px 16px;border-radius:8px;border:1px solid #ccc;background:#fff;font-size:13px;cursor:pointer;}
  .noprint button.pri{background:#c62828;color:#fff;border-color:#c62828;}
  </style></head><body>
  <div class="noprint"><button class="pri" onclick="window.print()">打印 / 存PDF</button><button onclick="window.close()">关闭</button></div>
  <h1>${esc(record.classFullName)} 古诗文默写小卷</h1>
  <div class="meta">共 ${qs.length} 题 · 生成时间 ${new Date().toLocaleDateString()}</div>
  <div class="fill"><span>姓名：____________</span><span>班级：____________</span><span>得分：__________</span></div>
  <div class="tip">要求：在横线上填写上/下句，注意不写错别字。</div>
  ${qHtml}${aHtml}
  </body></html>`;
}

function blankPaperHtml(record: ReciteRecord, list: RecitePoem[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = 8;
  const body = list.map(p => `
    <div class="p"><div class="pt">${esc(p.title)}${p.author ? `　<span class="au">${esc(p.author)}</span>` : ''}</div>
    <div class="lines">${'<div class="ln"></div>'.repeat(rows)}</div></div>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${record.classFullName}古诗文默写</title><style>
  body{font-family:"Songti SC","SimSun","Microsoft YaHei",serif;margin:0;padding:28px 34px;color:#111;}
  h1{font-size:20px;text-align:center;margin:0 0 6px;letter-spacing:2px;}
  .meta{text-align:center;font-size:12px;color:#555;margin-bottom:14px;}
  .p{margin-bottom:18px;page-break-inside:avoid;}
  .pt{font-size:15px;font-weight:700;margin-bottom:6px;}
  .au{font-weight:400;font-size:12px;color:#777;}
  .ln{border-bottom:1px dashed #ccc;height:1.9em;}
  @media print{@page{margin:14mm;} body{padding:0;} .noprint{display:none!important;}}
  .noprint{position:fixed;top:14px;right:14px;display:flex;gap:8px;}
  .noprint button{padding:8px 16px;border-radius:8px;border:1px solid #ccc;background:#fff;font-size:13px;cursor:pointer;}
  .noprint button.pri{background:#c62828;color:#fff;border-color:#c62828;}
  </style></head><body>
  <div class="noprint"><button class="pri" onclick="window.print()">打印 / 存PDF</button><button onclick="window.close()">关闭</button></div>
  <h1>${esc(record.classFullName)} 古诗文默写（整篇）</h1>
  <div class="meta">共 ${list.length} 篇 · 生成时间 ${new Date().toLocaleDateString()}</div>
  ${body}
  </body></html>`;
}

/* ============================================================
   快速抽查（上课抽背用）
   ============================================================ */

function QuickCheck({ record, poem, onClose, onSetMark, onBulkSet, onMarkAll, onEditTypo, toast }: {
  record: ReciteRecord;
  poem: RecitePoem;
  onClose: () => void;
  onSetMark: (studentId: string, poemId: string, s: ReciteStatus) => void;
  onBulkSet: (studentId: string, poemIds: string[], s: ReciteStatus) => void;
  onMarkAll?: (poemIds: string[], s: ReciteStatus) => void;
  onEditTypo: (studentId: string) => void;
  toast: Props['toast'];
}) {
  const [hideDone, setHideDone] = useState(false);
  const [single, setSingle] = useState<boolean>(() => typeof window !== 'undefined' && window.innerWidth < 620);
  const [cursor, setCursor] = useState(() => {
    const i = record.students.findIndex(st => isCounted(st) && !isPassed(record.marks[st.id]?.[poem.id]?.status));
    return i < 0 ? 0 : i;
  });
  const [picked, setPicked] = useState<Record<string, number>>({});

  const pool = record.students.filter(isCounted);
  const done = pool.filter(st => isPassed(record.marks[st.id]?.[poem.id]?.status)).length;
  const list = hideDone ? pool.filter(st => !isPassed(record.marks[st.id]?.[poem.id]?.status)) : pool;

  const cur = pool[cursor] || pool[0];

  const roll = () => {
    const target = pickWeightedStudent(record, [poem.id], picked);
    if (!target) { toast('没有可抽取的学生'); return; }
    setPicked(p => ({ ...p, [target.id]: (p[target.id] || 0) + 1 }));
    const idx = pool.findIndex(s => s.id === target.id);
    setCursor(idx < 0 ? 0 : idx);
    setSingle(true);
    setHideDone(false);
    toast(`🎲 抽到：${target.name}`);
  };

  const step = (d: number) => {
    if (!pool.length) return;
    setCursor(c => (c + d + pool.length) % pool.length);
  };

  return (
    <div className="rc-quick-overlay">
      <div className="rc-quick-head">
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>⚡ 快速抽查 · {poem.title}</div>
          <div className="hint" style={{ margin: 0 }}>已过关 {done}/{pool.length} 人{record.students.length !== pool.length ? `（${record.students.length - pool.length} 人免检/转出）` : ''}</div>
        </div>
        <button className="btn btn-small btn-secondary" onClick={onClose}>完成</button>
      </div>

      <div className="rc-quick-tools">
        <button className="btn btn-small btn-success" onClick={roll}>🎲 随机点名</button>
        <button className="btn btn-small btn-secondary" onClick={() => setSingle(!single)}>
          {single ? '📋 列表模式' : '📱 单列模式'}
        </button>
        <label className="rc-check" style={{ color: '#fff' }}>
          <input type="checkbox" checked={hideDone} onChange={e => setHideDone(e.target.checked)} />
          只看未过关
        </label>
        <button className="btn btn-small btn-primary" onClick={() => {
          if (!confirm(`把全班（${pool.length} 人）都标为「已背」？`)) return;
          if (onMarkAll) onMarkAll([poem.id], 'recited');
          else for (const st of pool) onBulkSet(st.id, [poem.id], 'recited');
          toast('✅ 全班已标为已背（一次撤销即可回退）');
        }}>全班标已背</button>
      </div>

      {single && cur ? (
        <div className="rc-quick-single">
          <div className="rc-qs-counter">{cursor + 1} / {pool.length}</div>
          <div className="rc-qs-name">{cur.name}</div>
          <div className="rc-qs-meta">
            {cur.no} 号 · {cur.gender} ·
            <span style={{ color: meta(record.marks[cur.id]?.[poem.id]?.status).color }}>
              {meta(record.marks[cur.id]?.[poem.id]?.status).label}
            </span>
          </div>
          {(record.marks[cur.id]?.[poem.id]?.typos?.length || 0) > 0 && (
            <div className="rc-qs-typo">错字：{record.marks[cur.id]![poem.id].typos!.join(' ')}</div>
          )}
          <div className="rc-qs-actions">
            <button className="rc-qb big ok" onClick={() => { onSetMark(cur.id, poem.id, 'recited'); step(1); }}>已背<br /><em>下一个</em></button>
            {poem.req === 'both' && (
              <button className="rc-qb big wr" onClick={() => { onSetMark(cur.id, poem.id, 'written'); step(1); }}>默对<br /><em>下一个</em></button>
            )}
            <button className="rc-qb big bd" onClick={() => { onSetMark(cur.id, poem.id, 'redo'); onEditTypo(cur.id); }}>待补<br /><em>记错字</em></button>
          </div>
          <div className="rc-qs-nav">
            <button className="btn btn-small btn-secondary" onClick={() => step(-1)}>← 上一个</button>
            <button className="btn btn-small btn-secondary" onClick={() => onEditTypo(cur.id)}>✎ 记错字</button>
            <button className="btn btn-small btn-secondary" onClick={() => step(1)}>下一个 →</button>
          </div>
        </div>
      ) : (
        <div className="rc-quick-list">
          {list.map(st => {
            const s = record.marks[st.id]?.[poem.id]?.status;
            const m = meta(s);
            const ok = isPassed(s);
            const ty = record.marks[st.id]?.[poem.id]?.typos;
            return (
              <div key={st.id} className={`rc-quick-row ${ok ? 'ok' : ''}`}>
                <span className="rc-quick-no">{st.no}</span>
                <span className="rc-quick-name" onClick={() => { setCursor(pool.findIndex(x => x.id === st.id)); setSingle(true); }}>
                  {st.name}{ty?.length ? <i className="rc-typo-dot" /> : null}
                </span>
                <span className="rc-quick-state" style={{ color: m.color }}>{m.label}</span>
                <div className="rc-quick-actions">
                  <button className="rc-qb ty" onClick={() => onEditTypo(st.id)}>错字</button>
                  <button className="rc-qb ok" onClick={() => onSetMark(st.id, poem.id, 'recited')}>已背</button>
                  {poem.req === 'both' && <button className="rc-qb wr" onClick={() => onSetMark(st.id, poem.id, 'written')}>默对</button>}
                  <button className="rc-qb bd" onClick={() => onSetMark(st.id, poem.id, 'redo')}>待补</button>
                </div>
              </div>
            );
          })}
          {list.length === 0 && <p className="hint" style={{ color: '#fff' }}>🎉 全班都已过关</p>}
        </div>
      )}
    </div>
  );
}

/* 便于集成/冒烟测试直接引用子视图 */
export { ClassEditor, ClassDetail, MatrixView, PoemView, StudentView, TypoView, QuizView, QuickCheck, TypoDialog, isPassed };
