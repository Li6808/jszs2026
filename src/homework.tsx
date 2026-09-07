/* ============================================================
   作业收缴模块
   - 参考「高一5班作业收缴登记表」
   - 学生名单录入: 手动 / 批量粘贴 / AI 识别提示词
   - 收缴会话: 每位学生 4 种状态(已交/未交/迟交/请假)
   - 自动统计未交次数;导出图片/PDF/CSV
   ============================================================ */

import { useState, useEffect, useRef } from 'react';
import {
  getHomeworkRecords, saveHomeworkRecord, deleteHomeworkRecord,
  importStudentsFromText, genId,
} from './storage';
import type { HomeworkRecord, HomeworkStudent, HomeworkSession, HomeworkStatus } from './types';

interface Props {
  toast: (msg: string) => void;
  openQr: (url: string) => void;
}

const STATUS_OPTIONS: { value: HomeworkStatus; label: string; emoji: string; color: string; bg: string }[] = [
  { value: 'submitted', label: '已交', emoji: '✅', color: '#07c160', bg: '#e6f7e6' },
  { value: 'missing', label: '未交', emoji: '❌', color: '#c41e3a', bg: '#fde8eb' },
  { value: 'late', label: '迟交', emoji: '⏰', color: '#faad14', bg: '#fff7e6' },
  { value: 'excused', label: '请假', emoji: '📋', color: '#1890ff', bg: '#e6f4ff' },
];

const HW_PROMPT = `请识别这张「学生作业登记表格」图片,严格按以下格式逐行输出每位学生:

【输出格式】(每行一位学生,字段间用空格分隔)
序号 姓名 性别 班级

【示例】
1 张三 男 5班
2 李四 女 5班
3 王五 男 5班

【要求】
1. 严格按图中实际内容输出,不要猜测
2. 性别只能写「男」或「女」,班级只写简称(如「5班」)
3. 序号按图片中的顺序从 1 开始递增
4. 不要输出标题行(如「序号」「姓名」等字段名)
5. 跳过空行
6. 只输出学生名单数据,不要任何解释或表格

【性别识别重点 ⭐】(这一步最关键,务必仔细!)
- 如果图片中表格的「性别」列已经清晰标出「男/女」,直接按图填写
- 如果图片中没有性别列,需要根据「中文姓名规律」判断性别,以下规律优先级高:
  · 名字末尾字是常见女性用字(秀/丽/红/婷/芳/娜/敏/娟/梅/燕/华/萍/玲/丽/艳/英/静/慧/洁/倩/欣/怡/雯/雪/璐/瑶/莹/蓉/莉/菊/兰/莲/凤/莺/婷/媛/妮/莎/娅/娇/婉/婵/娥/嫦/娴/嫣/芸/荷/菲/彩/露/霜/颖/巧/美/贤/淑/惠/珠/翠/碧/凝/冰/寒/秋/春/夏/冬/云/雨/风/雪/梅/兰/菊/竹/莲/桂/杏/桃/李/柳/杨/槐/榆/桐/樱/荷/菱/茜/薇/芬/芝/花/草/叶/苗/芽/苗/枝/根/苗/果)→ 判为「女」
  · 名字末尾字是常见男性用字(强/伟/刚/勇/军/涛/鹏/龙/虎/彪/健/康/辉/煌/亮/明/辉/耀/光/辉/俊/杰/豪/爽/毅/坚/强/猛/锐/锋/钢/铁/石/岩/峰/岭/山/川/海/河/江/湖/涛/波/浪/潮/云/天/宇/宙/洪/荒/原/野/草/木/林/森/松/柏/杨/柳/桐/梓/楠/栋/梁/柱/梁/才/华/文/武/斌/斌/武/成/功/业/志/雄/飞/腾/达/通/顺/利/安/宁/平/和/福/寿/喜/乐/康/健/宁/祥/瑞/福/安/吉/祥)→ 判为「男」
  · 如果名字看不出明显规律(中性名),看整列是否有共同特征(比如所有名字风格相近可能是同一性别)
  · 如果实在无法判断,先填「男」(教师通常需要确认,默认值不要随机)

7. 输出格式务必:每行一个学生,字段顺序固定为「序号 姓名 性别 班级」,中间用单个空格分隔`;

export function HomeworkPage({ toast, openQr }: Props) {
  const [records, setRecords] = useState<HomeworkRecord[]>(getHomeworkRecords);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeRecordId, setActiveRecordId] = useState<string | null>(null);

  const refresh = () => setRecords(getHomeworkRecords());

  return (
    <div className="page">
      <div className="card">
        <div className="card-header">
          <span className="header-icon">📚</span>
          <span>作业收缴</span>
        </div>
        <div className="card-body">
          <p className="hint" style={{ marginBottom: 12 }}>
            参考「高一5班作业收缴登记表」的设计。每个班级一份登记表,可创建多次「收缴会话」(每周多次)记录每位学生的提交情况。
          </p>

          {/* 新建班级按钮 */}
          <button className="btn btn-primary btn-block" onClick={() => setEditingId('__new__')}>
            ➕ 新建班级登记表
          </button>

          {/* 班级列表 */}
          {records.length > 0 && !editingId && !activeRecordId && (
            <div style={{ marginTop: 16 }}>
              <div className="section-title">📋 班级列表({records.length})</div>
              {records.map(r => {
                const sessionsCount = r.sessions.length;
                const studentsCount = r.students.length;
                return (
                  <div key={r.id} className="hw-class-card">
                    <div className="hw-class-info" onClick={() => setActiveRecordId(r.id)}>
                      <div className="hw-class-title">
                        <strong>{r.classFullName}</strong>
                        <span className="hw-badge">👤 {r.classTeacher || '未填班主任'}</span>
                        {r.teacherPhone && <span className="hw-badge">📞 {r.teacherPhone}</span>}
                      </div>
                      <div className="hw-class-meta">
                        👨‍🎓 {studentsCount} 人 · 📋 {sessionsCount} 次收缴 · 🔄 每周{r.homeworksPerWeek}次
                      </div>
                    </div>
                    <div className="hw-class-actions">
                      <button className="btn btn-small btn-secondary" onClick={() => setEditingId(r.id)}>✏️ 编辑</button>
                      <button className="btn btn-small btn-danger" onClick={() => {
                        if (confirm(`确定删除「${r.classFullName}」?该班级所有收缴记录会一起被删除。`)) {
                          deleteHomeworkRecord(r.id); refresh();
                          toast('已删除');
                        }
                      }}>🗑️</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {records.length === 0 && !editingId && (
            <div className="empty" style={{ marginTop: 24 }}>
              <div className="empty-icon">📚</div>
              <p>还没有班级,点上方按钮创建吧!</p>
              <p className="hint" style={{ marginTop: 8 }}>示例: 高一5班、高二3班、初二(1)班</p>
            </div>
          )}
        </div>
      </div>

      {/* 班级编辑(创建/修改基本信息 + 名单) */}
      {editingId && (
        <ClassEditor
          recordId={editingId === '__new__' ? null : editingId}
          onClose={() => setEditingId(null)}
          onSaved={() => { refresh(); setEditingId(null); toast('✅ 已保存'); }}
          onDeleted={() => { refresh(); setEditingId(null); toast('已删除'); }}
          toast={toast}
        />
      )}

      {/* 收缴会话视图(查看某班的收缴历史 + 发起新会话) */}
      {activeRecordId && (() => {
        const rec = records.find(r => r.id === activeRecordId);
        if (!rec) return null;
        return (
          <ClassSessionsView
            record={rec}
            onClose={() => setActiveRecordId(null)}
            onChanged={refresh}
            toast={toast}
            openQr={openQr}
          />
        );
      })()}
    </div>
  );
}

/* ---------- 班级编辑(基本信息 + 名单录入) ---------- */

function ClassEditor({ recordId, onClose, onSaved, onDeleted, toast }: {
  recordId: string | null;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
  toast: Props['toast'];
}) {
  const existing: HomeworkRecord | undefined = recordId ? getHomeworkRecords().find(r => r.id === recordId) : undefined;

  const [classFullName, setClassFullName] = useState(existing?.classFullName || '');
  const [classShortName, setClassShortName] = useState(existing?.classShortName || '');
  const [grade, setGrade] = useState(existing?.grade || '');
  const [classTeacher, setClassTeacher] = useState(existing?.classTeacher || '');
  const [teacherPhone, setTeacherPhone] = useState(existing?.teacherPhone || '');
  const [homeworksPerWeek, setHomeworksPerWeek] = useState<number>(existing?.homeworksPerWeek ?? 3);

  const [students, setStudents] = useState<HomeworkStudent[]>(existing?.students || []);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [showAiHint, setShowAiHint] = useState(false);

  /** 同步班级简称:从「高一5班」自动提取年级+5班 */
  useEffect(() => {
    if (!classFullName) return;
    // 高一 / 高二 / 高三 / 初一 / 初二 / 初三
    const m = classFullName.match(/(高一|高二|高三|初一|初二|初三)/);
    if (m && !grade) setGrade(m[1]);
    const shortM = classFullName.match(/(\d+班|\([\d]+\)班|[一二三四五六七八九十]+班)/);
    if (shortM && !classShortName) setClassShortName(shortM[1]);
  }, [classFullName]);

  const addStudent = (s: Omit<HomeworkStudent, 'id' | 'no'>) => {
    setStudents(prev => [...prev, { ...s, id: genId('stu'), no: prev.length + 1 }]);
  };

  const removeStudent = (idx: number) => {
    setStudents(prev => prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, no: i + 1 })));
  };

  const updateStudent = (idx: number, patch: Partial<HomeworkStudent>) => {
    setStudents(prev => prev.map((s, i) => i === idx ? { ...s, ...patch } : s));
  };

  const doImport = () => {
    const list = importStudentsFromText(importText, classShortName || '本班');
    if (list.length === 0) { toast('未识别到有效数据'); return; }
    const newStudents: HomeworkStudent[] = list.map(s => ({
      id: genId('stu'), no: students.length + s.no, name: s.name, gender: s.gender, className: s.className || classShortName,
    }));
    setStudents(prev => [...prev, ...newStudents].map((s, i) => ({ ...s, no: i + 1 })));
    setImportText('');
    setShowImport(false);
    toast(`✅ 已导入 ${list.length} 位学生`);
  };

  const save = () => {
    if (!classFullName) { toast('请填写完整班级名(如:高一5班)'); return; }
    if (students.length === 0) { if (!confirm('当前班级还没有学生,确定保存吗?')) return; }
    const id = recordId || genId('rec');
    const record: HomeworkRecord = {
      id,
      classFullName,
      classShortName: classShortName || classFullName,
      grade: grade || '',
      classTeacher,
      teacherPhone,
      homeworksPerWeek,
      students,
      sessions: existing?.sessions || [],
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveHomeworkRecord(record);
    onSaved();
  };

  const copyPrompt = () => {
    navigator.clipboard?.writeText(HW_PROMPT).then(() => toast('✅ 提示词已复制')).catch(() => {
      const ta = document.createElement('textarea'); ta.value = HW_PROMPT; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta); toast('✅ 已复制');
    });
  };

  const renderStudents = () => (
    <div className="hw-student-list">
      {students.length === 0 && (
        <div className="empty" style={{ padding: 20 }}>
          <div className="empty-icon">👨‍🎓</div>
          <p style={{ fontSize: 13 }}>暂无学生,通过下方按钮录入</p>
        </div>
      )}
      {students.map((s, idx) => (
        <div key={s.id} className="hw-student-row">
          <div className="hw-student-no">{s.no}</div>
          <input
            className="form-input hw-student-name"
            value={s.name}
            onChange={e => updateStudent(idx, { name: e.target.value })}
            placeholder="姓名"
          />
          <div className="hw-gender-toggle">
            {(['男', '女'] as const).map(g => (
              <div
                key={g}
                className={`hw-gender-btn ${s.gender === g ? 'selected' : ''}`}
                onClick={() => updateStudent(idx, { gender: g })}
              >
                {g}
              </div>
            ))}
          </div>
          <div className="hw-student-del" onClick={() => removeStudent(idx)} title="删除该学生">×</div>
        </div>
      ))}
    </div>
  );

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span><span className="header-icon">✏️</span>{recordId ? '编辑班级' : '新建班级'}</span>
        <button className="btn btn-small btn-secondary" onClick={onClose}>← 返回</button>
      </div>
      <div className="card-body">
        {/* 基本信息 */}
        <div className="form-group">
          <label>完整班级名 <span className="required">*</span></label>
          <input
            className="form-input"
            value={classFullName}
            onChange={e => setClassFullName(e.target.value)}
            placeholder="如:高一5班 / 初二(1)班 / 高二(3)班"
          />
        </div>
        <div className="form-row">
          <div className="form-group flex1">
            <label>年级(可选)</label>
            <input className="form-input" value={grade} onChange={e => setGrade(e.target.value)} placeholder="高一/高二/..." />
          </div>
          <div className="form-group flex1">
            <label>班级简称(可选)</label>
            <input className="form-input" value={classShortName} onChange={e => setClassShortName(e.target.value)} placeholder="5班" />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group flex1">
            <label>班主任</label>
            <input className="form-input" value={classTeacher} onChange={e => setClassTeacher(e.target.value)} placeholder="姓名" />
          </div>
          <div className="form-group flex1">
            <label>班主任电话</label>
            <input className="form-input" value={teacherPhone} onChange={e => setTeacherPhone(e.target.value)} placeholder="如:15213605001" />
          </div>
        </div>
        <div className="form-group">
          <label>每周作业次数</label>
          <div className="num-btns">
            {[1, 2, 3, 4, 5, 6, 7].map(n => (
              <div key={n} className={`num-btn ${homeworksPerWeek === n ? 'selected' : ''}`} onClick={() => setHomeworksPerWeek(n)}>{n}</div>
            ))}
          </div>
          <p className="hint">默认 3 次,可按学科作业量调整</p>
        </div>

        {/* 学生名单 - 三种录入方式 */}
        <div className="settings-section" style={{ marginTop: 16 }}>
          <div className="section-title" style={{ marginBottom: 10 }}>
            👨‍🎓 学生名单({students.length} 人)
          </div>

          <div className="btn-row" style={{ marginBottom: 12 }}>
            <button className="btn btn-small btn-secondary" onClick={() => setShowImport(s => !s)}>
              📋 批量粘贴
            </button>
            <button className="btn btn-small btn-secondary" onClick={() => setShowAiHint(s => !s)}>
              🤖 AI 识别(豆包)
            </button>
          </div>

          {/* 手动添加 */}
          <ManualAddRow onAdd={(s) => addStudent(s)} />

          {/* 批量粘贴 */}
          {showImport && (
            <div style={{ background: '#fafafa', borderRadius: 8, padding: 12, marginTop: 10 }}>
              <div className="form-group">
                <label>粘贴名单(每行一位学生)</label>
                <textarea
                  className="form-textarea"
                  value={importText}
                  onChange={e => setImportText(e.target.value)}
                  rows={6}
                  placeholder={`1 张三 男 5班\n2 李四 女 5班\n3 王五 男 5班\n\n(也可省略序号、班级,只填姓名)`}
                />
                <p className="hint">支持格式:「张三 男」、「1 张三 男 5班」、「张三,男,5班」等</p>
              </div>
              <div className="btn-row">
                <button className="btn btn-primary btn-small" onClick={doImport}>📥 导入</button>
                <button className="btn btn-secondary btn-small" onClick={() => setImportText('')}>清空</button>
              </div>
            </div>
          )}

          {/* AI 识别 */}
          {showAiHint && (
            <div style={{ background: '#fffbe6', borderRadius: 8, padding: 12, marginTop: 10, border: '1px solid #ffe58f' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <strong>🤖 用豆包识别登记图片</strong>
                <button className="btn btn-small btn-primary" onClick={copyPrompt}>📋 复制提示词</button>
              </div>
              <p className="hint" style={{ marginBottom: 8 }}>
                <strong>使用步骤</strong>:<br />
                1️⃣ 点击「复制提示词」 → 2️⃣ 发给豆包 → 3️⃣ 上传登记图片 → 4️⃣ 把豆包返回的文字粘贴到上面的「批量粘贴」框 → 5️⃣ 点「导入」
              </p>
              <details>
                <summary style={{ cursor: 'pointer', fontSize: 13 }}>📄 查看完整提示词</summary>
                <pre style={{ background: 'white', padding: 10, borderRadius: 6, fontSize: 12, marginTop: 6, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{HW_PROMPT}</pre>
              </details>
            </div>
          )}

          {/* 学生列表 */}
          {renderStudents()}
        </div>

        <div className="btn-row" style={{ marginTop: 16 }}>
          <button className="btn btn-primary" onClick={save}>💾 保存班级</button>
          {recordId && (
            <button className="btn btn-danger" onClick={() => {
              if (confirm('确定删除整个班级及所有收缴记录?')) {
                deleteHomeworkRecord(recordId);
                onDeleted();
              }
            }}>🗑️ 删除班级</button>
          )}
        </div>
      </div>
    </div>
  );
}

function ManualAddRow({ onAdd }: { onAdd: (s: Omit<HomeworkStudent, 'id' | 'no'>) => void }) {
  const [name, setName] = useState('');
  const [gender, setGender] = useState<'男' | '女'>('男');
  const [className, setClassName] = useState('');
  const submit = () => {
    if (!name.trim()) return;
    onAdd({ name: name.trim(), gender, className: className.trim() });
    setName(''); setGender('男'); setClassName('');
  };
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
      <input
        className="form-input"
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder="学生姓名"
        style={{ flex: 2 }}
      />
      <div style={{ display: 'flex', border: '1.5px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        {(['男', '女'] as const).map(g => (
          <div key={g} className={`hw-gender-btn ${gender === g ? 'selected' : ''}`} onClick={() => setGender(g)} style={{ borderRadius: 0 }}>{g}</div>
        ))}
      </div>
      <input
        className="form-input"
        value={className}
        onChange={e => setClassName(e.target.value)}
        placeholder="班级(可选)"
        style={{ flex: 1 }}
      />
      <button className="btn btn-primary btn-small" onClick={submit}>➕ 添加</button>
    </div>
  );
}

/* ---------- 单个班级的「收缴会话」视图 ---------- */

function ClassSessionsView({ record, onClose, onChanged, toast, openQr }: {
  record: HomeworkRecord;
  onClose: () => void;
  onChanged: () => void;
  toast: Props['toast'];
  openQr: Props['openQr'];
}) {
  const [showNew, setShowNew] = useState(false);
  const [newDate, setNewDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [newTitle, setNewTitle] = useState('');
  const [newDefaultStatus, setNewDefaultStatus] = useState<HomeworkStatus>('submitted');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showImage, setShowImage] = useState(false);

  const sessions = [...record.sessions].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));

  // 跨会话统计:每位学生未交 / 迟交 / 请假次数
  const stats: Record<string, { submitted: number; missing: number; late: number; excused: number }> = {};
  for (const s of record.students) {
    stats[s.id] = { submitted: 0, missing: 0, late: 0, excused: 0 };
    for (const sess of record.sessions) {
      const st = sess.submissions[s.id];
      if (st && stats[s.id]) stats[s.id][st]++;
    }
  }

  const persistRecord = (mutator: (r: HomeworkRecord) => HomeworkRecord) => {
    const updated = mutator({ ...record });
    saveHomeworkRecord(updated);
    onChanged();
  };

  const createSession = () => {
    if (record.students.length === 0) { toast('请先在班级编辑中录入学生'); return; }
    const submissions: Record<string, HomeworkStatus> = {};
    for (const s of record.students) submissions[s.id] = newDefaultStatus;
    const sess: HomeworkSession = {
      id: genId('sess'),
      date: newDate,
      title: newTitle.trim() || '作业',
      submissions,
    };
    persistRecord(r => ({ ...r, sessions: [sess, ...r.sessions] }));
    setShowNew(false);
    setNewTitle('');
    setActiveSessionId(sess.id);
    toast('✅ 已创建收缴会话');
  };

  const updateSubmission = (sessionId: string, studentId: string, status: HomeworkStatus) => {
    persistRecord(r => ({
      ...r,
      sessions: r.sessions.map(s => s.id === sessionId ? {
        ...s,
        submissions: { ...s.submissions, [studentId]: status },
      } : s),
    }));
  };

  const setAllForSession = (sessionId: string, status: HomeworkStatus) => {
    persistRecord(r => ({
      ...r,
      sessions: r.sessions.map(s => s.id === sessionId ? {
        ...s,
        submissions: Object.fromEntries(record.students.map(st => [st.id, status])),
      } : s),
    }));
    toast('已批量更新');
  };

  const deleteSession = (sessionId: string) => {
    if (!confirm('确定删除这次收缴记录?')) return;
    persistRecord(r => ({ ...r, sessions: r.sessions.filter(s => s.id !== sessionId) }));
    if (activeSessionId === sessionId) setActiveSessionId(null);
    toast('已删除');
  };

  // Canvas 渲染收缴登记表(仿照用户给的图)
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawCanvas = () => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext('2d'); if (!ctx) return;
    const N = record.students.length;
    if (N === 0) return;
    const cellH = 22, headerH = 64, sideCol = 40, nameCol = 100, sexCol = 50, clsCol = 70;
    const sessionCol = Math.max(70, Math.min(110, 700 / Math.max(1, record.sessions.length + 1)));
    const totalW = sideCol + nameCol + sexCol + clsCol + sessionCol * Math.max(1, record.sessions.length) + 90;
    const totalH = headerH + cellH * N + 50;
    c.width = totalW; c.height = totalH;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, totalW, totalH);

    // 标题
    ctx.fillStyle = '#000'; ctx.font = 'bold 18px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`${record.classFullName} 作业收缴登记表`, totalW / 2, 26);
    ctx.font = '12px "Microsoft YaHei", sans-serif'; ctx.fillStyle = '#666';
    ctx.textAlign = 'left';
    const meta = `班主任:${record.classTeacher || '-'}    电话:${record.teacherPhone || '-'}`;
    ctx.fillText(meta, 20, 48);
    ctx.textAlign = 'right';
    ctx.fillText(`共 ${record.sessions.length} 次收缴 · 未交次数`, totalW - 20, 48);

    // 表头
    let x = 0; const y = headerH;
    const drawHeaderCell = (xx: number, w: number, text: string, fill: string = '#fff8dc') => {
      ctx.fillStyle = fill; ctx.fillRect(xx, y, w, cellH);
      ctx.strokeStyle = '#999'; ctx.strokeRect(xx, y, w, cellH);
      ctx.fillStyle = '#000'; ctx.font = 'bold 12px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(text, xx + w / 2, y + cellH / 2 + 4);
    };

    drawHeaderCell(x, sideCol, '序号'); x += sideCol;
    drawHeaderCell(x, nameCol, '姓名'); x += nameCol;
    drawHeaderCell(x, sexCol, '性别'); x += sexCol;
    drawHeaderCell(x, clsCol, '班级'); x += clsCol;
    sessions.forEach(sess => {
      drawHeaderCell(x, sessionCol, sess.title + '\n' + sess.date);
      x += sessionCol;
    });
    drawHeaderCell(x, 90, '未交次数', '#ffe4e4');

    // 学生行
    record.students.forEach((st, i) => {
      const ry = y + cellH + i * cellH;
      ctx.fillStyle = i % 2 === 0 ? '#fafafa' : '#fff';
      ctx.fillRect(0, ry, totalW, cellH);

      let rx = 0;
      const drawCell = (rrx: number, w: number, text: string, color: string = '#000', bg?: string) => {
        if (bg) { ctx.fillStyle = bg; ctx.fillRect(rrx, ry, w, cellH); }
        ctx.strokeStyle = '#ddd'; ctx.strokeRect(rrx, ry, w, cellH);
        ctx.fillStyle = color; ctx.font = '12px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(text, rrx + w / 2, ry + cellH / 2 + 4);
      };
      drawCell(rx, sideCol, String(st.no)); rx += sideCol;
      drawCell(rx, nameCol, st.name); rx += nameCol;
      drawCell(rx, sexCol, st.gender); rx += sexCol;
      drawCell(rx, clsCol, st.className || record.classShortName); rx += clsCol;

      sessions.forEach(sess => {
        const st2 = sess.submissions[st.id];
        const opt = STATUS_OPTIONS.find(o => o.value === st2);
        if (opt) {
          drawCell(rx, sessionCol, opt.emoji, opt.color, opt.bg);
        } else {
          ctx.strokeStyle = '#ddd'; ctx.strokeRect(rx, ry, sessionCol, cellH);
        }
        rx += sessionCol;
      });
      // 未交次数
      const miss = (record.sessions.reduce((s, sess) => s + ((sess.submissions[st.id] === 'missing') ? 1 : 0), 0));
      drawCell(rx, 90, String(miss), miss > 0 ? '#c41e3a' : '#999', miss > 0 ? '#ffe4e4' : undefined);
    });

    // 底部签名
    ctx.fillStyle = '#666'; ctx.font = '11px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(`导出时间:${new Date().toLocaleString()}`, totalW - 20, totalH - 18);
  };

  const shareImage = async () => {
    drawCanvas();
    const c = canvasRef.current; if (!c) return;
    c.toBlob(async (blob) => {
      if (!blob) { toast('生成失败'); return; }
      const file = new File([blob], `${record.classFullName}_作业收缴.png`, { type: 'image/png' });
      if ((navigator as any).canShare?.({ files: [file] })) {
        try { await (navigator as any).share({ files: [file], title: `${record.classFullName} 作业收缴`, text: '教师助手生成' }); toast('✅ 已分享'); }
        catch { /* 用户取消 */ }
      } else {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          toast('✅ 已复制到剪贴板,长按图片或去聊天粘贴');
        } catch {
          const a = document.createElement('a'); a.download = `${record.classFullName}_作业收缴.png`; a.href = c.toDataURL('image/png'); a.click();
          toast('当前浏览器不支持分享,已下载');
        }
      }
    }, 'image/png');
  };

  const exportCSV = () => {
    const headers = ['序号', '姓名', '性别', '班级', ...sessions.map(s => `${s.title}(${s.date})`), '未交次数'];
    const rows = record.students.map((st) => {
      const row = [String(st.no), st.name, st.gender, st.className || record.classShortName];
      for (const sess of sessions) {
        const opt = STATUS_OPTIONS.find(o => o.value === sess.submissions[st.id]);
        row.push(opt ? opt.label : '-');
      }
      const miss = sessions.reduce((s, sess) => s + ((sess.submissions[st.id] === 'missing') ? 1 : 0), 0);
      row.push(String(miss));
      return row;
    });
    import('./export').then(({ exportCSV }) => {
      exportCSV(`${record.classFullName}_作业收缴`, headers, rows);
      toast('📥 已导出 CSV');
    });
  };

  const exportPDF = () => {
    drawCanvas();
    setTimeout(() => {
      const c = canvasRef.current; if (!c) return;
      const win = window.open('', '_blank');
      if (!win) { toast('请允许弹窗'); return; }
      win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${record.classFullName}作业收缴</title><style>body{display:flex;flex-direction:column;align-items:center;margin:0;background:#f5f5f5;font-family:sans-serif;padding:30px;}img{max-width:95%;box-shadow:0 4px 20px rgba(0,0,0,0.15);background:white;}.back-btn{position:fixed;top:20px;left:20px;padding:10px 20px;background:#c62828;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;z-index:1000;box-shadow:0 2px 8px rgba(0,0,0,0.2);}@media print{body{background:white;padding:0;}img{box-shadow:none;max-width:100%;}.back-btn{display:none!important;}}</style></head><body><button class="back-btn" onclick="window.close()">← 返回</button><img src="${c.toDataURL('image/png')}" /><script>setTimeout(()=>window.print(),300);</script></body></html>`);
      win.document.close();
      toast('已打开,另存为 PDF 即可');
    }, 100);
  };

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <span><span className="header-icon">📊</span>{record.classFullName} 收缴记录</span>
        <button className="btn btn-small btn-secondary" onClick={onClose}>← 返回班级列表</button>
      </div>
      <div className="card-body">
        <div className="info-box" style={{ marginBottom: 12 }}>
          <div>👨‍🎓 {record.students.length} 位学生 · 📋 {record.sessions.length} 次收缴 · 🔄 每周{record.homeworksPerWeek}次</div>
          <div>👤 班主任:{record.classTeacher || '-'} {record.teacherPhone && `· 📞 ${record.teacherPhone}`}</div>
        </div>

        <div className="btn-row">
          <button className="btn btn-primary btn-small" onClick={() => setShowNew(s => !s)}>➕ 新建收缴会话</button>
          {record.sessions.length > 0 && (
            <>
              <button className="btn btn-outline btn-small" onClick={exportCSV}>📊 导出CSV</button>
              <button className="btn btn-outline btn-small" onClick={exportPDF}>📄 导出PDF</button>
              <button className="btn btn-success btn-small" onClick={() => { drawCanvas(); setShowImage(true); }}>🖼️ 预览大图</button>
              <button className="btn btn-primary btn-small" onClick={shareImage} title="分享收缴表">🔗 分享图片</button>
              <button className="btn btn-outline btn-small" onClick={() => openQr?.(window.location.origin + window.location.pathname)} title="生成二维码,扫码分享 PWA">📱 二维码</button>
            </>
          )}
        </div>

        {showNew && (
          <div style={{ background: '#fafafa', borderRadius: 10, padding: 12, marginTop: 12, border: '1.5px solid var(--border)' }}>
            <div className="form-row">
              <div className="form-group flex1">
                <label>收缴日期</label>
                <input type="date" className="form-input" value={newDate} onChange={e => setNewDate(e.target.value)} />
              </div>
              <div className="form-group flex1">
                <label>作业标题</label>
                <input className="form-input" value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="如:第3单元练习卷" />
              </div>
            </div>
            <div className="form-group">
              <label>默认状态(全部学生先标记)</label>
              <div className="hw-status-row">
                {STATUS_OPTIONS.map(o => (
                  <div
                    key={o.value}
                    className={`hw-status-chip ${newDefaultStatus === o.value ? 'selected' : ''}`}
                    style={{ background: newDefaultStatus === o.value ? o.bg : 'white', color: o.color, borderColor: o.color }}
                    onClick={() => setNewDefaultStatus(o.value)}
                  >
                    <span>{o.emoji}</span>{o.label}
                  </div>
                ))}
              </div>
            </div>
            <div className="btn-row">
              <button className="btn btn-primary btn-small" onClick={createSession}>✅ 创建并开始登记</button>
              <button className="btn btn-secondary btn-small" onClick={() => setShowNew(false)}>取消</button>
            </div>
          </div>
        )}

        {/* 收缴会话列表 */}
        {record.sessions.length === 0 ? (
          <div className="empty" style={{ marginTop: 16 }}>
            <div className="empty-icon">📋</div>
            <p>还没有收缴会话,点「新建收缴会话」开始登记吧</p>
          </div>
        ) : (
          <div style={{ marginTop: 16 }}>
            <div className="section-title">📅 收缴历史({record.sessions.length} 次)</div>
            {sessions.map(sess => {
              const subm = sess.submissions;
              const cnt = STATUS_OPTIONS.map(o => ({ ...o, n: Object.values(subm).filter(v => v === o.value).length }));
              return (
                <div key={sess.id} className="hw-session-card">
                  <div className="hw-session-header" onClick={() => setActiveSessionId(activeSessionId === sess.id ? null : sess.id)}>
                    <div>
                      <strong>📅 {sess.date} · {sess.title}</strong>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {cnt.map(c => c.n > 0 ? (
                        <span key={c.value} className="hw-status-mini" style={{ background: c.bg, color: c.color }}>
                          {c.emoji}{c.n}
                        </span>
                      ) : null)}
                      <span style={{ transform: activeSessionId === sess.id ? 'rotate(90deg)' : 'none', transition: '0.2s' }}>▶</span>
                    </div>
                  </div>
                  {activeSessionId === sess.id && (
                    <div className="hw-session-body">
                      <div className="btn-row" style={{ marginBottom: 8 }}>
                        {STATUS_OPTIONS.map(o => (
                          <button key={o.value} className="btn btn-small btn-secondary" style={{ background: o.bg, color: o.color }} onClick={() => setAllForSession(sess.id, o.value)}>
                            {o.emoji} 全标{o.label}
                          </button>
                        ))}
                        <button className="btn btn-small btn-danger" onClick={() => deleteSession(sess.id)}>🗑️ 删除</button>
                      </div>
                      <div className="hw-student-list">
                        {record.students.map(st => {
                          const cur = subm[st.id];
                          return (
                            <div key={st.id} className="hw-student-row hw-fill-row">
                              <div className="hw-student-no">{st.no}</div>
                              <div
                                className="hw-student-gender-chip"
                                style={{ background: st.gender === '女' ? '#fce4ec' : '#e3f2fd', color: st.gender === '女' ? '#c2185b' : '#1565c0' }}
                                title={st.gender}
                              >
                                {st.gender}
                              </div>
                              <div className="hw-student-name" style={{ background: 'transparent', border: 'none' }}>{st.name}</div>
                              <div className="hw-status-row" style={{ flexShrink: 0 }}>
                                {STATUS_OPTIONS.map(o => (
                                  <div
                                    key={o.value}
                                    className={`hw-status-toggle ${cur === o.value ? 'selected' : ''}`}
                                    style={{ background: cur === o.value ? o.color : 'white', color: cur === o.value ? 'white' : o.color, borderColor: o.color }}
                                    onClick={() => updateSubmission(sess.id, st.id, o.value)}
                                    title={o.label}
                                  >
                                    {o.emoji}
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {record.students.length === 0 && <p className="hint">该班级还没有学生,请先在班级编辑中添加</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* 累计未交次数表 */}
        {record.students.length > 0 && record.sessions.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div className="section-title">📈 累计统计</div>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead><tr><th>序号</th><th>姓名</th><th>已交</th><th>未交</th><th>迟交</th><th>请假</th><th>未交率</th></tr></thead>
                <tbody>
                  {record.students.map(st => {
                    const s = stats[st.id] || { submitted: 0, missing: 0, late: 0, excused: 0 };
                    const total = s.submitted + s.missing + s.late + s.excused;
                    const missRate = total > 0 ? ((s.missing / total) * 100).toFixed(0) : '0';
                    return (
                      <tr key={st.id}>
                        <td>{st.no}</td>
                        <td>{st.name}</td>
                        <td style={{ color: '#07c160' }}>{s.submitted}</td>
                        <td style={{ color: s.missing > 0 ? '#c41e3a' : '#999', fontWeight: s.missing > 0 ? 600 : 400 }}>{s.missing}</td>
                        <td style={{ color: '#faad14' }}>{s.late}</td>
                        <td style={{ color: '#1890ff' }}>{s.excused}</td>
                        <td>
                          {total > 0 ? (
                            <span style={{ color: s.missing > 0 ? '#c41e3a' : '#999' }}>{missRate}%</span>
                          ) : '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Canvas(隐藏,用于生成图) */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* 大图预览 */}
      {showImage && (
        <div className="modal-overlay" onClick={() => setShowImage(false)}>
          <button className="modal-close" onClick={() => setShowImage(false)}>×</button>
          <div className="modal-content" onClick={(e: any) => e.stopPropagation()}>
            <canvas ref={(el) => {
              if (el && canvasRef.current) {
                const src = canvasRef.current;
                if (el.width !== src.width || el.height !== src.height) {
                  el.width = src.width; el.height = src.height;
                  el.getContext('2d')?.drawImage(src, 0, 0);
                }
              }
            }} style={{ maxWidth: '95vw', maxHeight: '85vh', background: 'white', borderRadius: 4, boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }} />
          </div>
          <div className="modal-hint">长按可保存图片 · 点空白处关闭</div>
        </div>
      )}
    </div>
  );
}
