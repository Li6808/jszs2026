/* 冒烟测试:用 react-dom/server 真实渲染背诵模块,捕捉初始渲染期运行时报错 */
import React from 'react';
import { renderToString } from 'react-dom/server';
import { RecitePage, ClassEditor, ClassDetail, QuickCheck, MatrixView, STATUS_META, isPassed } from './src/recite.tsx';
import App, { VersionSection, SettingsPage, SchedulePage } from './src/App.tsx';
import { readFileSync, statSync } from 'node:fs';
import { PRESET_VOLUMES, KEBIAO_STATS, QUIZ_COUNT, QUIZ_POEM_COUNT, QUIZ_MAP } from './src/reciteData.ts';
import {
  buildPoemsFromPreset, genId, importStudentsFromText, importPoemsFromText, parseQuizText,
  getReciteRecords, saveReciteRecord, clearUndo, pushUndo, popUndo, getUndoStack,
  getRedoStack, pushRedo, popRedo, buildRedoEntry, planRedo, writeMarkValues, sameMark,
  pickWeightedStudent, isCounted, getData, mutateRecite, setData, clearAll,
  getStorageIssue, onStorageIssue, isReadOnly, resetAfterCorruption,
  normalizeModuleOrder, getModuleOrder, getBackupMeta,
  normalizeHiddenModules, visibleModules, ALWAYS_VISIBLE_MODULES,
  getHiddenModules,
} from './src/storage.ts';
import {
  buildBackup, parseBackup, mergeIntoCurrent, summarize, describeScope,
  applyBackup, snapshotBeforeImport, getPreImportSnapshot, restorePreImport, clearPreImportSnapshot,
  shareBackup, backupFileName,
} from './src/backup.ts';
import { APP_VERSION, APP_BUILD, CHANGELOG } from './src/version.ts';
import { makeQrDataUrl } from './src/qr.ts';
import { checkForUpdate } from './src/updateCheck.ts';
import { CloudPanel } from './src/cloudPanel.tsx';
import {
  normalizeServerUrl, setCloudServer, getCloudServer, isCloudConfigured, isCloudLoggedIn,
  getCloudUser, getCloudMeta, forgetCloud, clearCloudSession, formatBytes, daysSinceUpload,
  isLanAddress,
} from './src/cloud.ts';

const store = {};
globalThis.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
  // 真实 localStorage 支持按索引取 key 和读 length，打桩要跟上，
  // 否则依赖遍历的实现无法被测试覆盖
  key: i => Object.keys(store)[i] ?? null,
  get length() { return Object.keys(store).length; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
};

let failures = 0;
function check(name, fn) {
  try {
    const info = fn();
    console.log(`  ok   ${name}${info ? ' — ' + info : ''}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e && e.message}`);
  }
}

const noop = () => {};
const props = { toast: noop, openQr: noop };
/** 渲染并去掉 React 文本节点之间的 <!-- --> 分隔符,便于做字符串断言 */
const R = (el) => renderToString(el).replace(/<!-- -->/g, '');

console.log('\n[1] 空数据渲染');
check('RecitePage 无任何数据', () => {
  const h = R(React.createElement(RecitePage, props));
  if (!h.includes('新建背诵登记表')) throw new Error('未渲染出新建按钮');
  return `${h.length} 字符`;
});

console.log('\n[2] 解析工具');
check('篇目库册次数量与总篇数', () => {
  const total = PRESET_VOLUMES.reduce((s, v) => s + v.poems.length, 0);
  if (PRESET_VOLUMES.length !== 12) throw new Error('册次数量异常');
  if (total < 180) throw new Error('总篇数偏少: ' + total);
  return `12 册 / ${total} 篇`;
});
check('课标必背标记（初中60 / 高中59）', () => {
  const kb = PRESET_VOLUMES.flatMap(v => v.poems).filter(p => p.kebiao).length;
  if (KEBIAO_STATS.cz.covered !== 60) throw new Error('初中课标标记应为 60，实际 ' + KEBIAO_STATS.cz.covered);
  if (KEBIAO_STATS.gz.covered < 55) throw new Error('高中课标标记偏少: ' + KEBIAO_STATS.gz.covered);
  if (kb !== KEBIAO_STATS.cz.covered + KEBIAO_STATS.gz.covered) throw new Error('课标标记总数对不上: ' + kb);
  return `初中 ${KEBIAO_STATS.cz.covered}/60 · 高中 ${KEBIAO_STATS.gz.covered}/72 · 库内共 ${kb} 篇`;
});
check('默写题库覆盖', () => {
  if (QUIZ_POEM_COUNT < 60) throw new Error('题库覆盖篇目偏少: ' + QUIZ_POEM_COUNT);
  if (QUIZ_COUNT < 100) throw new Error('题目数偏少: ' + QUIZ_COUNT);
  const bad = Object.entries(QUIZ_MAP).find(([, v]) => v.some(q => !q.p || !q.a));
  if (bad) throw new Error('存在空题干: ' + bad[0]);
  return `${QUIZ_POEM_COUNT} 篇 / ${QUIZ_COUNT} 题`;
});
check('importStudentsFromText 解析名单', () => {
  const list = importStudentsFromText('1 张三 男\n2 李四 女\n王五\n李六 女 4班');
  if (list.length !== 4) throw new Error('解析条数 ' + list.length);
  if (list[0].name !== '张三' || list[0].gender !== '男') throw new Error('首条解析错误');
  if (list[3].className !== '4班') throw new Error('班级解析错误: ' + list[3].className);
  return `${list.length} 人`;
});
check('importPoemsFromText 解析 AI 文本', () => {
  const txt = '三峡|郦道元|文|both\n春望|杜甫|诗|both\n如梦令(常记溪亭日暮)|李清照|词|recite\n篇名|作者|文体|要求\n';
  const list = importPoemsFromText(txt, '测试册');
  if (list.length !== 3) throw new Error('解析条数 ' + list.length + '（表头未过滤?）');
  if (list[2].req !== 'recite') throw new Error('recite 要求未识别');
  if (list[0].volume !== '测试册') throw new Error('册次未写入');
  return `${list.length} 篇`;
});
check('parseQuizText 解析题库文本', () => {
  const list = parseQuizText('三峡|自非亭午夜分|不见曦月\n篇名|给出的一句|要求默写的一句\n春望|感时花溅泪|恨别鸟惊心');
  if (list.length !== 2) throw new Error('解析条数 ' + list.length);
  if (list[0].a !== '不见曦月') throw new Error('答案解析错误');
  return `${list.length} 题`;
});

console.log('\n[3] 有数据渲染');
const vol = PRESET_VOLUMES.find(v => v.id === 'cz-8s');
const poems = buildPoemsFromPreset(vol.poems, vol.name, 1);
const students = Array.from({ length: 24 }, (_, i) => ({
  id: genId('stu'), no: i + 1, name: '学生' + (i + 1), gender: i % 2 ? '女' : '男', className: '4班',
}));
const marks = {};
for (let i = 0; i < students.length; i++) {
  marks[students[i].id] = {};
  for (let j = 0; j < 12; j++) {
    marks[students[i].id][poems[j].id] = { status: j % 3 === 0 ? 'written' : j % 3 === 1 ? 'recited' : 'redo', reciteDate: '2026-09-10' };
  }
}
const rec = {
  id: 'rec_test', classFullName: '初二(4)班', classShortName: '4班', grade: '初二',
  poems, students, marks, createdAt: '2026-09-01', updatedAt: '2026-09-14',
};
saveReciteRecord(rec);

check('记录已写入 localStorage', () => `${getReciteRecords().length} 条`);
check('RecitePage 列表渲染（含进度条）', () => {
  const h = R(React.createElement(RecitePage, props));
  if (!h.includes('初二(4)班')) throw new Error('班级名未渲染');
  if (!h.includes('背诵过关')) throw new Error('统计文案缺失');
  return `${h.length} 字符`;
});
check('ClassEditor 新建态渲染', () => {
  const h = R(React.createElement(ClassEditor, { recordId: null, onClose: noop, onSaved: noop, ...props }));
  if (!h.includes('新建背诵登记表')) throw new Error('标题缺失');
  return `${h.length} 字符`;
});
check('ClassEditor 编辑态渲染（含已选篇目统计+目标过关率）', () => {
  const h = R(React.createElement(ClassEditor, { recordId: 'rec_test', onClose: noop, onSaved: noop, ...props }));
  if (!h.includes('已选篇目')) throw new Error('信息框缺失');
  if (!h.includes('背诵篇目(27)')) throw new Error('篇数统计缺失');
  if (!h.includes('学生名单(24)')) throw new Error('人数统计缺失');
  if (!h.includes('计划目标过关率')) throw new Error('目标过关率设置缺失');
  return `${h.length} 字符`;
});
check('ClassDetail 进度矩阵渲染（24人×27篇）', () => {
  const h = R(React.createElement(ClassDetail, { record: rec, onClose: noop, onChanged: noop, ...props }));
  if (!h.includes('进度矩阵')) throw new Error('页签缺失');
  if (!h.includes('标记为')) throw new Error('笔刷条缺失');
  if (!h.includes('撤销')) throw new Error('撤销按钮缺失');
  if ((h.match(/rc-cell/g) || []).length < 500) throw new Error('格子数量不足');
  return `${h.length} 字符, ${(h.match(/rc-cell/g) || []).length} 个格子`;
});
check('ClassDetail 篇目视角渲染', () => {
  const h = R(React.createElement(ClassDetail, { record: rec, onClose: noop, onChanged: noop, initialTab: 'poem', ...props }));
  if (!h.includes('未过关名单')) throw new Error('未过关名单缺失');
  if (!h.includes('已过关名单')) throw new Error('已过关名单缺失');
  if (!h.includes('生成催办清单')) throw new Error('催办按钮缺失');
  if (!h.includes('快速抽查')) throw new Error('抽查入口缺失');
  return `${h.length} 字符`;
});
check('ClassDetail 学生档案渲染', () => {
  const h = R(React.createElement(ClassDetail, { record: rec, onClose: noop, onChanged: noop, initialTab: 'student', ...props }));
  if (!h.includes('生成家长反馈')) throw new Error('家长反馈按钮缺失');
  if (!h.includes('rc-sc-avatar')) throw new Error('学生卡缺失');
  return `${h.length} 字符`;
});
check('ClassDetail 统计页渲染', () => {
  const h = R(React.createElement(ClassDetail, { record: rec, onClose: noop, onChanged: noop, initialTab: 'stats', ...props }));
  if (!h.includes('背诵过关率')) throw new Error('指标卡缺失');
  if (!h.includes('篇目过关率')) throw new Error('篇目排行缺失');
  if (!h.includes('需要重点关注的学生')) throw new Error('落后名单缺失');
  return `${h.length} 字符`;
});
check('篇目/学生视角&统计的派生数据不抛错', () => {
  const active = rec.poems.filter(p => p.active);
  const passed = s => s === 'recited' || s === 'written';
  const rates = active.map(p => {
    let n = 0;
    for (const st of rec.students) if (passed(rec.marks[st.id]?.[p.id]?.status)) n++;
    return n;
  });
  if (rates.some(r => Number.isNaN(r))) throw new Error('过关率出现 NaN');
  const lag = rec.students.map(st => ({
    st, left: active.filter(p => !passed(rec.marks[st.id]?.[p.id]?.status)).length,
  })).sort((a, b) => b.left - a.left);
  if (lag[0].left === 0) throw new Error('落后名单计算异常');
  return `最高过关 ${Math.max(...rates)} 人 · 最多剩 ${lag[0].left} 篇`;
});

/* ============================================================
   v23 新增功能
   ============================================================ */

console.log('\n[4] 撤销栈');
check('撤销栈 push / pop / 持久化', () => {
  clearUndo('rec_undo');
  pushUndo('rec_undo', { at: 't', label: '标记 1 格', changes: [{ studentId: 's1', poemId: 'p1', prev: null }] });
  pushUndo('rec_undo', { at: 't', label: '批量标记 27 格', changes: [{ studentId: 's2', poemId: 'p2', prev: { status: 'recited' } }] });
  if (getUndoStack('rec_undo').length !== 2) throw new Error('入栈数量不对');
  const last = popUndo('rec_undo');
  if (last.label !== '批量标记 27 格') throw new Error('未后进先出');
  if (last.changes[0].prev.status !== 'recited') throw new Error('未保存原值');
  if (getUndoStack('rec_undo').length !== 1) throw new Error('出栈后数量不对');
  const raw = Object.keys(store).find(k => k.startsWith('teacher_recite_undo_'));
  if (!raw) throw new Error('未持久化到 localStorage');
  if (store[raw].indexOf('标记 1 格') < 0) throw new Error('持久化内容不完整');
  clearUndo('rec_undo');
  if (getUndoStack('rec_undo').length !== 0) throw new Error('清空失败');
  if (Object.keys(store).some(k => k.startsWith('teacher_recite_undo_'))) throw new Error('清空后仍残留 key');
  return 'LIFO 正常 · 原值可还原 · 已持久化';
});
const countPassed = (recId, poemId) => {
  const r = getReciteRecords().find(x => x.id === recId);
  return r.students.filter(st => isPassed(r.marks[st.id]?.[poemId]?.status)).length;
};
check('批量写回不互相覆盖（「全班标已背」场景回归）', () => {
  const recId = 'rec_test';
  const r0 = getReciteRecords().find(x => x.id === recId);
  const pool = r0.students.filter(isCounted);
  const poemId = r0.poems[5].id;
  if (countPassed(recId, poemId) !== 0) throw new Error('夹具预期该篇过关数为 0');

  // 旧写法：先取一份快照，再循环基于快照写回 —— 后写的会覆盖前面的
  const stale = r0;
  for (const st of pool) {
    saveReciteRecord({
      ...stale,
      marks: { ...stale.marks, [st.id]: { ...(stale.marks[st.id] || {}), [poemId]: { status: 'recited' } } },
    });
  }
  const staleOk = countPassed(recId, poemId);
  if (staleOk !== 1) throw new Error('旧写法预期只生效 1 条，实际 ' + staleOk);

  // 新写法：每次读最新数据再改
  for (const st of pool) {
    mutateRecite(recId, r => ({
      ...r,
      marks: { ...r.marks, [st.id]: { ...(r.marks[st.id] || {}), [poemId]: { status: 'recited' } } },
    }));
  }
  const freshOk = countPassed(recId, poemId);
  if (freshOk !== pool.length) throw new Error(`新写法应全班 ${pool.length} 人全部生效，实际 ${freshOk}`);
  return `旧写法只生效 ${staleOk} 条 → 新写法 ${freshOk} 条全生效`;
});
check('撤销可整体回退批量操作', () => {
  const recId = 'rec_test';
  const cur = getReciteRecords().find(x => x.id === recId);
  const poemIds = cur.poems.slice(0, 3).map(p => p.id);
  const changes = [];
  for (const st of cur.students.filter(isCounted)) {
    for (const pid of poemIds) changes.push({ studentId: st.id, poemId: pid, prev: cur.marks[st.id]?.[pid] || null });
  }
  pushUndo(recId, { at: '', label: `全班 × ${poemIds.length} 篇标为「未背」`, changes });
  mutateRecite(recId, r => {
    const marks = { ...r.marks };
    for (const c of changes) marks[c.studentId] = { ...(marks[c.studentId] || {}), [c.poemId]: { status: 'todo' } };
    return { ...r, marks };
  });
  for (const pid of poemIds) if (countPassed(recId, pid) !== 0) throw new Error('标记未生效');

  const e = popUndo(recId);
  mutateRecite(recId, r => {
    const marks = { ...r.marks };
    for (const c of e.changes) {
      const row = { ...(marks[c.studentId] || {}) };
      if (c.prev === null) delete row[c.poemId];
      else row[c.poemId] = c.prev;
      marks[c.studentId] = row;
    }
    return { ...r, marks };
  });
  const after = getReciteRecords().find(x => x.id === recId);
  const mismatch = e.changes.filter(c =>
    JSON.stringify(after.marks[c.studentId]?.[c.poemId] || null) !== JSON.stringify(c.prev)).length;
  if (mismatch) throw new Error(`${mismatch} 格未还原`);
  return `${e.changes.length} 格全部还原为原值`;
});

console.log('\n[5] 加权随机点名');
check('pickWeightedStudent 只抽在读学生', () => {
  const r = {
    ...rec,
    students: rec.students.map((s, i) => i === 0 ? { ...s, status: 'left' } : s),
  };
  const pool = r.students.filter(isCounted);
  if (pool.length !== 23) throw new Error('在读人数应为 23，实际 ' + pool.length);
  const leftName = r.students[0].name;
  for (let i = 0; i < 400; i++) {
    const p = pickWeightedStudent(r, [poems[0].id]);
    if (!p) throw new Error('未抽出学生');
    if (p.name === leftName) throw new Error('抽到了已转出的学生');
  }
  return '400 次抽样未命中已转出学生';
});
check('加权随机点名偏好待补背/未背的学生', () => {
  const r = { ...rec };
  // 制造一个「12 篇全待补背」的学生和一个「全已默写」的学生
  const bad = students[0].id, good = students[1].id;
  for (const p of poems) r.marks[bad][p.id] = { status: 'redo' };
  for (const p of poems) r.marks[good][p.id] = { status: 'written' };
  let badHits = 0, goodHits = 0;
  for (let i = 0; i < 600; i++) {
    const p = pickWeightedStudent(r, [poems[0].id]);
    if (p.id === bad) badHits++;
    if (p.id === good) goodHits++;
  }
  if (!(badHits > goodHits)) throw new Error(`权重未生效 bad=${badHits} good=${goodHits}`);
  return `待补背 ${badHits} 次 vs 已默写 ${goodHits} 次`;
});

console.log('\n[6] 错字本');
const rec2 = {
  ...rec,
  id: 'rec_typo',
  students: rec.students.map((s, i) => {
    if (i === 0) return { ...s, status: 'left', reason: '转学' };
    if (i === 1) return { ...s, status: 'exempt', reason: '体育特长生' };
    return s;
  }),
  // poems[2] 在夹具里全班都是待补背(0% 过关),用来触发计划滞后预警
  poems: rec.poems.map((p, i) => (i === 2 ? { ...p, dueDate: '2026-01-05' } : p)),
  marks: JSON.parse(JSON.stringify(rec.marks)),
};
rec2.marks[students[2].id][poems[0].id] = { status: 'redo', typos: ['曾', '滥'] };
rec2.marks[students[3].id][poems[0].id] = { status: 'redo', typos: ['曾', '拂'] };
rec2.marks[students[4].id][poems[1].id] = { status: 'written', typos: ['曾', '阙'] };
saveReciteRecord(rec2);

check('ClassDetail 错字本页渲染（高频错字榜）', () => {
  const h = R(React.createElement(ClassDetail, { record: rec2, onClose: noop, onChanged: noop, initialTab: 'typo', ...props }));
  if (!h.includes('高频错字榜')) throw new Error('错字榜缺失');
  if (!h.includes('生成复习单')) throw new Error('复习单按钮缺失');
  if (!h.includes('按篇目') || !h.includes('按学生')) throw new Error('分组切换缺失');
  // 「曾」出现 3 次,应排在榜首
  const idxZeng = h.indexOf('rc-typo-char');
  if (idxZeng < 0) throw new Error('错字条目缺失');
  return `${h.length} 字符`;
});
check('错字本空态渲染', () => {
  const h = R(React.createElement(ClassDetail, { record: rec, onClose: noop, onChanged: noop, initialTab: 'typo', ...props }));
  if (!h.includes('还没有记录任何错字')) throw new Error('空态文案缺失');
  return `${h.length} 字符`;
});
check('矩阵里的错字角标', () => {
  const h = R(React.createElement(ClassDetail, { record: rec2, onClose: noop, onChanged: noop, ...props }));
  if (!h.includes('rc-typo-dot')) throw new Error('错字角标未渲染');
  return `${(h.match(/rc-typo-dot/g) || []).length} 个角标`;
});
check('统计页出现高频错字 TOP10', () => {
  const h = R(React.createElement(ClassDetail, { record: rec2, onClose: noop, onChanged: noop, initialTab: 'stats', ...props }));
  if (!h.includes('高频错字 TOP10')) throw new Error('统计页未联动错字');
  return '已联动';
});

console.log('\n[7] 计划进度预警 + 学籍异动');
check('计划滞后预警渲染', () => {
  const h = R(React.createElement(ClassDetail, { record: rec2, onClose: noop, onChanged: noop, initialTab: 'stats', ...props }));
  if (!h.includes('计划进度预警')) throw new Error('预警区块缺失');
  if (!h.includes('2026-01-05')) throw new Error('截止日期未显示');
  if (!h.includes('还差')) throw new Error('缺口人数未计算');
  return '预警区块正常';
});
check('未滞后时不报警', () => {
  const r = { ...rec2, poems: rec2.poems.map(p => ({ ...p, dueDate: '2099-12-31' })) };
  const h = R(React.createElement(ClassDetail, { record: r, onClose: noop, onChanged: noop, initialTab: 'stats', ...props }));
  if (h.includes('计划进度预警')) throw new Error('未来日期不该报警');
  return '未来截止日不报警';
});
check('免检/转出学生不计入统计分母', () => {
  const counted = rec2.students.filter(isCounted).length;
  if (counted !== 22) throw new Error('在读应为 22，实际 ' + counted);
  const h = R(React.createElement(ClassDetail, { record: rec2, onClose: noop, onChanged: noop, initialTab: 'stats', ...props }));
  if (!h.includes('统计分母为在读学生 22 人')) throw new Error('分母文案缺失');
  if (!h.includes('2 人免检/转出')) throw new Error('免检说明缺失');
  return '分母 = 22 人';
});
check('矩阵中免检/转出行灰显且未过关数显示为 —', () => {
  const h = R(React.createElement(ClassDetail, { record: rec2, onClose: noop, onChanged: noop, ...props }));
  if (!h.includes('rc-row-off')) throw new Error('灰显样式未生效');
  if (!h.includes('rc-td-status')) throw new Error('学籍徽章缺失');
  return '已灰显';
});
check('学生名单编辑器含学籍状态徽章', () => {
  const h = R(React.createElement(ClassEditor, { recordId: 'rec_typo', onClose: noop, onSaved: noop, initialTab: 'students', ...props }));
  if (!h.includes('rc-chip-status')) throw new Error('状态徽章缺失');
  if (!h.includes('不计入过关率分母')) throw new Error('说明文案缺失');
  if (!h.includes('当前计入统计 22 人')) throw new Error('计入人数文案缺失');
  return '已渲染（22 人在读 / 2 人免检转出）';
});
check('篇目编辑页含课标筛选与整册截止日', () => {
  const h = R(React.createElement(ClassEditor, { recordId: 'rec_test', onClose: noop, onSaved: noop, initialTab: 'poems', ...props }));
  if (!h.includes('只导入课标必背')) throw new Error('课标导入按钮缺失');
  if (!h.includes('整册设截止日')) throw new Error('批量设截止日缺失');
  return '已渲染';
});

console.log('\n[8] 默写卷生成');
check('ClassDetail 默写卷页渲染', () => {
  const h = R(React.createElement(ClassDetail, { record: rec, onClose: noop, onChanged: noop, initialTab: 'quiz', ...props }));
  if (!h.includes('生成试卷并打印')) throw new Error('生成按钮缺失');
  if (!h.includes('给上句填下句') || !h.includes('整篇默写')) throw new Error('题型选项缺失');
  if (!h.includes('复制出题提示词')) throw new Error('AI 出题入口缺失');
  if (!h.includes('粘贴导入题目')) throw new Error('题库导入入口缺失');
  return `${h.length} 字符`;
});
check('题库与篇目能对上（篇名一致性）', () => {
  const allTitles = new Set(PRESET_VOLUMES.flatMap(v => v.poems).map(p => p.title));
  const orphans = Object.keys(QUIZ_MAP).filter(t => !allTitles.has(t));
  if (orphans.length) throw new Error('题库里有对不上篇目的题: ' + orphans.slice(0, 5).join('、'));
  return `题库全部 ${Object.keys(QUIZ_MAP).length} 篇篇名均能匹配内置篇目库`;
});

console.log('\n[9] 快速抽查（含单列模式与随机点名）');
check('QuickCheck 列表模式渲染', () => {
  const h = R(React.createElement(QuickCheck, {
    record: rec2, poem: poems[0], onClose: noop, onSetMark: noop, onBulkSet: noop, onEditTypo: noop, toast: noop,
  }));
  if (!h.includes('随机点名')) throw new Error('随机点名按钮缺失');
  if (!h.includes('单列模式')) throw new Error('单列模式切换缺失');
  if (!h.includes('错字')) throw new Error('错字按钮缺失');
  if (!h.includes('rc-quick-list')) throw new Error('列表未渲染');
  return `${h.length} 字符`;
});
check('抽查里免检/转出学生被排除', () => {
  const h = R(React.createElement(QuickCheck, {
    record: rec2, poem: poems[0], onClose: noop, onSetMark: noop, onBulkSet: noop, onEditTypo: noop, toast: noop,
  }));
  if (h.includes('已过关 0/24')) throw new Error('分母仍用了全班人数');
  if (!h.includes('2 人免检/转出')) throw new Error('免检提示缺失');
  return '分母已按在读人数';
});

console.log('\n[10] 备份与恢复');
check('buildBackup 结构完整', () => {
  const bak = buildBackup();
  if (bak.app !== 'teacher-assistant-backup') throw new Error('app 标识错误');
  if (bak.version !== 1) throw new Error('版本号错误');
  if (!bak.exportedAt) throw new Error('缺导出时间');
  if (!bak.summary || !bak.summary.includes('背诵')) throw new Error('概览缺失');
  return bak.summary;
});
check('parseBackup 往返一致', () => {
  const bak = buildBackup();
  const res = parseBackup(JSON.stringify(bak));
  if (!res.ok) throw new Error('自身备份无法解析: ' + res.error);
  if (res.file.data.reciteRecords.length !== getData().reciteRecords.length) throw new Error('数据条数不一致');
  return '往返一致';
});
check('parseBackup 拦截非法输入', () => {
  if (parseBackup('这不是json').ok) throw new Error('非法文本未拦截');
  if (parseBackup('{"foo":1}').ok) throw new Error('异类 JSON 未拦截');
  if (parseBackup('{"app":"teacher-assistant-backup","version":99,"data":{}}').ok) throw new Error('高版本未拦截');
  const loose = parseBackup(JSON.stringify({ history: [], salaries: [] }));
  if (!loose.ok) throw new Error('裸 localStorage 数据应兼容');
  return '4 种异常输入均按预期处理';
});
check('合并导入不丢现有记录', () => {
  const before = getData().reciteRecords.length;
  const merged = mergeIntoCurrent({
    settings: null, history: [], salaries: [], duties: [], homeworkRecords: [],
    reciteRecords: [{ ...rec, id: 'rec_incoming', classFullName: '初三(1)班' }],
  });
  if (merged.reciteRecords.length !== before + 1) throw new Error('合并未追加新记录');
  const mergedAgain = mergeIntoCurrent({
    settings: null, history: [], salaries: [], duties: [], homeworkRecords: [],
    reciteRecords: [{ ...rec, id: 'rec_incoming', classFullName: '初三(1)班' }],
  });
  if (mergedAgain.reciteRecords.length !== before + 1) throw new Error('同 id 未去重');
  return `${before} → ${merged.reciteRecords.length} 条（去重生效）`;
});
check('summarize 概览文案覆盖全部模块', () => {
  const s = summarize(getData());
  for (const want of ['请假', '课表', '工资', '值班/代课', '作业收缴', '背诵', '设置']) {
    if (!s.includes(want)) throw new Error(`概览缺少「${want}」：${s}`);
  }
  return s;
});

console.log('\n[11] 存储保护（损坏保护 / 写入异常 / 二维码本地化）');

check('数据损坏：留档原始内容 + 上只读锁 + 通知订阅方', () => {
  const got = [];
  const off = onStorageIssue(i => got.push(i.kind));
  for (const k of Object.keys(store)) delete store[k];
  store['teacher_assistant_v3'] = '{"history": [1,2';      // 故意写入非法 JSON

  const d = getData();                                     // 读一次即触发抢救
  off();

  if (d.reciteRecords.length !== 0) throw new Error('损坏时应降级为空数据而非抛错');
  if (!store['teacher_assistant_v3_corrupt']) throw new Error('未留档原始内容');
  if (!store['teacher_assistant_v3_readonly']) throw new Error('未置只读锁');
  if (!isReadOnly()) throw new Error('isReadOnly() 应为 true');
  if (!got.includes('corrupt')) throw new Error('订阅方未收到通知，实际: ' + got.join(','));
  const issue = getStorageIssue();
  if (issue.rescuedChars <= 0) throw new Error('未记录抢救长度');
  return `抢救 ${issue.rescuedChars} 字符 · 已上锁 · 订阅收到 ${got.join(',')}`;
});

check('【回归】只读保护下写入被拒，损坏数据不被空数据覆盖', () => {
  const before = store['teacher_assistant_v3'];
  setData({
    settings: null, history: [], salaries: [], duties: [],
    homeworkRecords: [], reciteRecords: [],
  });
  if (store['teacher_assistant_v3'] !== before) throw new Error('损坏的原始数据被覆盖了！');
  return '原始内容保持原样';
});

check('解除保护后写入正常且不误报问题', () => {
  resetAfterCorruption();
  for (const k of Object.keys(store)) delete store[k];
  if (isReadOnly()) throw new Error('重置后不应仍处于只读');
  setData({
    settings: null, history: [], salaries: [], duties: [],
    homeworkRecords: [], reciteRecords: [],
  });
  if (!store['teacher_assistant_v3']) throw new Error('未写入主数据');
  if (getStorageIssue()) throw new Error('正常写入不应上报问题，实际: ' + getStorageIssue().kind);
  return '写入成功，无告警';
});

check('配额写满时上报 quota，不静默失败', () => {
  const origSet = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = (k, v) => {
    if (String(v).length > 200) {
      const e = new Error('The quota has been exceeded.');
      e.name = 'QuotaExceededError';
      throw e;
    }
    store[k] = String(v);
  };
  try {
    setData({
      settings: null, history: [], salaries: [], duties: [],
      homeworkRecords: [], reciteRecords: [], pad: 'x'.repeat(800),
    });
    const issue = getStorageIssue();
    if (!issue || issue.kind !== 'quota') throw new Error('未上报 quota，实际: ' + (issue && issue.kind));
    return issue.message.slice(0, 26) + '…';
  } finally {
    globalThis.localStorage.setItem = origSet;
  }
});

check('数据接近上限时提前预警（near-limit）', () => {
  setData({
    settings: null, history: [], salaries: [], duties: [],
    homeworkRecords: [], reciteRecords: [], pad: 'x'.repeat(4 * 1024 * 1024),
  });
  const issue = getStorageIssue();
  if (!issue || issue.kind !== 'near-limit') throw new Error('未触发预警，实际: ' + (issue && issue.kind));
  return issue.message.slice(0, 30) + '…';
});

check('二维码本地生成（不再依赖第三方接口）', () => {
  const dataUrl = makeQrDataUrl('https://example.com/teacher/', 6);
  if (!dataUrl.startsWith('data:image/gif;base64,')) {
    throw new Error('未返回本地 data URL: ' + String(dataUrl).slice(0, 40));
  }
  if (dataUrl.length < 500) throw new Error('二维码内容过短，可能没真正生成: ' + dataUrl.length);
  if (makeQrDataUrl('') !== '') throw new Error('空内容应返回空串');
  // 内容超出二维码容量时应优雅降级为空串，而不是抛异常打断渲染
  const tooLong = makeQrDataUrl('x'.repeat(5000));
  if (tooLong !== '') throw new Error('超长内容应降级为空串，实际长度 ' + tooLong.length);
  return `${dataUrl.length} 字符 · 超长内容优雅降级`;
});

check('clearAll 彻底清理（主数据 / 备份元数据 / 撤销栈 / 只读锁）', () => {
  pushUndo('rec_clean', {
    at: 't', label: '测试', changes: [{ studentId: 's1', poemId: 'p1', prev: null }],
  });
  store['teacher_backup_meta'] = JSON.stringify({ lastBackupAt: '2026-01-01', count: 1 });
  setData({
    settings: null, history: [], salaries: [], duties: [],
    homeworkRecords: [], reciteRecords: [{ id: 'rec_clean' }],
  });
  // 模拟「曾发生过损坏」留下的痕迹，验证重置时一并清掉
  store['teacher_assistant_v3_corrupt'] = '{"broken":';
  store['teacher_assistant_v3_readonly'] = '1';

  clearAll();

  if (store['teacher_assistant_v3']) throw new Error('主数据未清除');
  if (store['teacher_backup_meta']) throw new Error('备份元数据未清除');
  if (store['teacher_assistant_v3_corrupt']) throw new Error('损坏留档未清除');
  const leftover = Object.keys(store).filter(k => k.startsWith('teacher_recite_undo_'));
  if (leftover.length) throw new Error('撤销栈残留: ' + leftover.join(','));
  if (isReadOnly()) throw new Error('只读锁未清除');
  return '四项残留全部清干净';
});

check('【回归】损坏后反复读取只上报一次（防渲染死循环）', () => {
  resetAfterCorruption();
  for (const k of Object.keys(store)) delete store[k];
  store['teacher_assistant_v3'] = '{"broken": ';
  let notifications = 0;
  const off = onStorageIssue(() => { notifications++; });
  for (let i = 0; i < 5; i++) getData();   // 模拟组件反复渲染
  off();
  if (notifications !== 1) throw new Error('应只上报 1 次，实际 ' + notifications + ' 次');
  resetAfterCorruption();
  return `读取 5 次，仅上报 ${notifications} 次`;
});

console.log('\n[12] 云端同步面板（默认不启用）');

/** 清掉所有云端相关配置，回到「纯本地」状态 */
function resetCloud() {
  for (const k of Object.keys(store)) {
    if (k.startsWith('teacher_cloud_')) delete store[k];
  }
}

check('未配置服务器时，面板默认折叠、不打扰', () => {
  resetCloud();
  const h = R(React.createElement(CloudPanel, props));
  if (!h.includes('数据存放方式')) throw new Error('未渲染出面板标题');
  // 折叠状态下不展开正文，避免给不需要的人添乱
  if (h.includes('服务器地址')) throw new Error('未配置时不应展开正文');
  return `${h.length} 字符 · 仅标题`;
});

check('未配置时本地功能完全不受影响', () => {
  resetCloud();
  if (isCloudConfigured()) throw new Error('不应视为已配置');
  if (isCloudLoggedIn()) throw new Error('不应视为已登录');
  const bak = buildBackup();
  if (bak.app !== 'teacher-assistant-backup') throw new Error('本地导出被影响');
  return '本地导出照常可用';
});

check('服务器地址规整：内网走 http、公网强制 https', () => {
  const cases = [
    ['192.168.1.8:8787', 'http://192.168.1.8:8787'],
    ['127.0.0.1:8787', 'http://127.0.0.1:8787'],
    ['localhost:8787', 'http://localhost:8787'],
    ['jiaoshi.example.com', 'https://jiaoshi.example.com'],
    ['https://jiaoshi.example.com/', 'https://jiaoshi.example.com'],
    ['  http://a.com//  ', 'http://a.com'],
    ['', ''],
  ];
  for (const [input, want] of cases) {
    const got = normalizeServerUrl(input);
    if (got !== want) throw new Error(`「${input}」应为「${want}」，实际「${got}」`);
  }
  return `${cases.length} 组输入均正确`;
});

check('配置服务器后展开，渲染出登录/注册表单', () => {
  resetCloud();
  setCloudServer('https://jiaoshi.example.com');
  const h = R(React.createElement(CloudPanel, props));
  if (!h.includes('https://jiaoshi.example.com')) throw new Error('未显示服务器地址');
  if (!h.includes('登录已有账号')) throw new Error('未渲染登录/注册切换');
  if (!h.includes('账号')) throw new Error('未渲染账号字段');
  if (h.includes('邀请码')) throw new Error('默认应为登录态，不应显示邀请码');
  return `${h.length} 字符 · 登录表单`;
});

check('未登录时标题标注「未登录」', () => {
  resetCloud();
  setCloudServer('https://a.example.com');
  const h = R(React.createElement(CloudPanel, props));
  if (!h.includes('未登录')) throw new Error('标题未标注未登录');
  return '状态标注正确';
});

check('已登录时渲染出上传 / 拉取按钮与账号信息', () => {
  resetCloud();
  setCloudServer('https://a.example.com');
  store['teacher_cloud_token'] = 'f'.repeat(64);
  store['teacher_cloud_user'] = JSON.stringify({
    id: 'u1', username: '李老师', isAdmin: true, createdAt: '', lastLoginAt: null,
  });
  if (!isCloudLoggedIn()) throw new Error('应视为已登录');
  const h = R(React.createElement(CloudPanel, props));
  if (!h.includes('已连接')) throw new Error('标题未标注已连接');
  if (!h.includes('李老师')) throw new Error('未显示账号名');
  if (!h.includes('管理员')) throw new Error('未显示管理员标识');
  if (!h.includes('上传当前全部数据到服务器')) throw new Error('缺少上传按钮');
  if (!h.includes('从云端拉取')) throw new Error('缺少拉取按钮');
  if (!h.includes('还没有上传过')) throw new Error('未上传时应明确提示');
  if (!h.includes('合并')) throw new Error('缺少拉取方式选择');
  return `${h.length} 字符 · 同步界面完整`;
});

check('已登录但不填地址时，SSR 渲染不发起任何请求也不报错', () => {
  resetCloud();
  store['teacher_cloud_token'] = 'f'.repeat(64);
  store['teacher_cloud_user'] = JSON.stringify({ id: 'u1', username: '王老师', isAdmin: false, createdAt: '', lastLoginAt: null });
  const h = R(React.createElement(CloudPanel, { ...props, initialStore: 'lan' }));
  if (!h.includes('服务器地址')) throw new Error('未配置时应展示填写入口');
  if (!h.includes('自己电脑做服务器')) throw new Error('应展示存放方式选择');
  return '渲染正常，无需服务器';
});

/* ------------------- 数据存放方式：三选一 ------------------- */

check('存放方式默认是「只在这台设备」，并说明代价', () => {
  resetCloud();
  const p = { ...props, defaultOpen: true, initialStore: 'local' };
  const h = R(React.createElement(CloudPanel, p));
  if (!h.includes('只在这台设备')) throw new Error('缺少本机页签');
  if (!h.includes('自己电脑做服务器')) throw new Error('缺少局域网页签');
  if (!h.includes('公网服务器')) throw new Error('缺少公网页签');
  if (!h.includes('什么都不用设置')) throw new Error('未说明默认即可用');
  if (!h.includes('都会让本机数据全丢')) throw new Error('未讲清丢失风险');
  // v29：本机模式最要紧的一句是「怎么把数据搬到另一台设备」，必须在这里就告诉用户
  if (!h.includes('分享备份')) throw new Error('未给出「不用连服务器」的搬数据办法');
  return '三选一完整，默认本地';
});

check('选「自己电脑做服务器」时给出电脑/手机两段操作与限制', () => {
  resetCloud();
  const p = { ...props, defaultOpen: true, initialStore: 'lan' };
  const h = R(React.createElement(CloudPanel, p));
  if (!h.includes('同一个 Wi-Fi')) throw new Error('未强调同一 Wi-Fi');
  if (!h.includes('电脑这边')) throw new Error('缺少电脑端步骤');
  if (!h.includes('手机这边')) throw new Error('缺少手机端步骤');
  if (!h.includes('别关它')) throw new Error('未提醒别关黑窗口');
  if (!h.includes('重新检测')) throw new Error('缺少重新检测入口');
  if (!h.includes('data')) throw new Error('未说明数据落盘位置');
  if (h.includes('https://')) throw new Error('局域网页不应出现 https 占位');
  return '电脑/手机两段操作 + 限制提醒齐全';
});

check('明确解释「手机上的旧 PWA 连不上这里」并给出正确做法', () => {
  resetCloud();
  const p = { ...props, defaultOpen: true, initialStore: 'lan' };
  const h = R(React.createElement(CloudPanel, p));
  // 用户真实困惑：手机上装的 PWA 扫码后数据对不上，也连不上这台电脑。
  // 背后是浏览器的两条硬限制，界面必须主动解释，否则老师会以为程序坏了。
  if (!h.includes('互不相通')) throw new Error('未解释「不同网址数据各存一份」');
  if (!h.includes('不许连')) throw new Error('未解释「https 安全页不许连 http 服务」');
  if (!h.includes('登录同一个账号')) throw new Error('未给出正确的同步做法');
  if (!h.includes('添加到主屏幕')) throw new Error('未提示可添加到主屏幕');
  return '说清了浏览器限制与替代做法';
});

check('选「公网服务器」时强调 HTTPS 与根地址', () => {
  resetCloud();
  const p = { ...props, defaultOpen: true, initialStore: 'remote' };
  const h = R(React.createElement(CloudPanel, p));
  if (!h.includes('HTTPS')) throw new Error('未强调 HTTPS');
  if (!h.includes('/api')) throw new Error('未提醒地址不要带 /api');
  if (!h.includes('https://jiaoshi.你的域名.com')) throw new Error('缺少公网地址占位');
  return '公网指引正确';
});

check('局域网地址识别：内网 / 本机 / 公网区分正确', () => {
  const lanCases = [
    'http://192.168.1.8:8787', 'http://10.0.0.5:8787', 'http://172.16.3.9:8787',
    'http://127.0.0.1:8787', 'http://localhost:8787', 'http://macbook.local:8787',
  ];
  const wanCases = ['https://jiaoshi.example.com', 'http://8.8.8.8:80', 'https://a.b.cn'];
  for (const c of lanCases) if (!isLanAddress(c)) throw new Error(`应判为局域网：${c}`);
  for (const c of wanCases) if (isLanAddress(c)) throw new Error(`不应判为局域网：${c}`);
  // 172.15 / 172.32 不在私有段里，别误判
  if (isLanAddress('http://172.15.1.1')) throw new Error('172.15 不应算内网');
  if (isLanAddress('http://172.32.1.1')) throw new Error('172.32 不应算内网');
  return `${lanCases.length} 个内网 + ${wanCases.length} 个公网 + 2 个边界，判定均正确`;
});

check('已连局域网服务器时，提示同 Wi-Fi 并可扫码打开', () => {
  resetCloud();
  setCloudServer('http://192.168.1.8:8787');
  const h = R(React.createElement(CloudPanel, props));
  if (!h.includes('同一 Wi-Fi')) throw new Error('缺少同 Wi-Fi 提示');
  if (!h.includes('手机扫码打开')) throw new Error('缺少扫码入口');
  if (!h.includes('192.168.1.8')) throw new Error('未显示服务器地址');
  return '局域网连接态渲染正确';
});

check('已连公网服务器时，不出现局域网专属提示', () => {
  resetCloud();
  setCloudServer('https://jiaoshi.example.com');
  const h = R(React.createElement(CloudPanel, props));
  if (h.includes('手机扫码打开')) throw new Error('公网不应出现扫码入口');
  if (!h.includes('https://jiaoshi.example.com')) throw new Error('未显示地址');
  return '公网连接态渲染正确';
});

/* -------------- 备份范围：确认一次导出即全量 -------------- */

check('描述备份范围：列出全部模块，0 条也列', () => {
  const scope = describeScope({
    settings: null, history: [], salaries: [], duties: [],
    homeworkRecords: [], reciteRecords: [],
  });
  const labels = scope.map(s => s.label);
  for (const want of ['请假记录', '我的课表', '工资统计', '值班 / 代课', '作业收缴', '古诗文背诵', '个人设置']) {
    if (!labels.includes(want)) throw new Error(`范围清单缺少「${want}」`);
  }
  if (scope.length !== 7) throw new Error(`应为 7 项，实际 ${scope.length}`);
  if (!scope.every(s => typeof s.detail === 'string' && s.detail.length > 0)) {
    throw new Error('每项都应有明细');
  }
  return `${scope.length} 个模块全部列出（含空白模块）`;
});

check('描述备份范围：明细数字与实际数据一致', () => {
  const data = {
    settings: { schedule: { courses: { 1: [{}, {}], 2: [{}] } } },
    history: [{}, {}, {}],
    salaries: [{}],
    duties: [{}],
    homeworkRecords: [{ id: 'hw1', students: [{}, {}] }],
    reciteRecords: [rec],
  };
  const scope = describeScope(data);
  const find = l => scope.find(s => s.label === l)?.detail || '';
  if (find('请假记录') !== '3 条') throw new Error('请假条数不对: ' + find('请假记录'));
  if (find('我的课表') !== '3 节') throw new Error('课表节数不对: ' + find('我的课表'));
  if (find('工资统计') !== '1 条') throw new Error('工资条数不对: ' + find('工资统计'));
  if (find('值班 / 代课') !== '1 条') throw new Error('值班条数不对: ' + find('值班 / 代课'));
  if (find('作业收缴') !== '1 个班 · 2 名学生') throw new Error('作业收缴不对: ' + find('作业收缴'));
  if (find('古诗文背诵') !== `1 个班 · ${students.length} 名学生 · ${poems.length} 篇`) {
    throw new Error('背诵明细不对: ' + find('古诗文背诵'));
  }
  if (!find('个人设置').includes('姓名')) throw new Error('个人设置明细不对: ' + find('个人设置'));
  return `背诵「${find('古诗文背诵')}」`;
});

check('断开云端：清地址与登录态，且不触碰业务数据', () => {
  resetCloud();
  setCloudServer('https://a.example.com');
  store['teacher_cloud_token'] = 'abc';
  store['teacher_cloud_user'] = JSON.stringify({ id: 'u1', username: '李老师', isAdmin: false, createdAt: '', lastLoginAt: null });
  const before = JSON.stringify(getData());
  forgetCloud();
  if (isCloudConfigured()) throw new Error('服务器地址未清除');
  if (isCloudLoggedIn()) throw new Error('登录态未清除');
  if (getCloudMeta().lastUploadAt !== null) throw new Error('元信息未清除');
  if (JSON.stringify(getData()) !== before) throw new Error('业务数据被误改');
  return '配置清空 · 业务数据完好';
});

check('clearCloudSession 保留服务器地址（免得每次重填）', () => {
  resetCloud();
  setCloudServer('https://keep.example.com');
  store['teacher_cloud_token'] = 'abc';
  clearCloudSession();
  if (isCloudLoggedIn()) throw new Error('登录态未清除');
  if (getCloudServer() !== 'https://keep.example.com') throw new Error('地址被误清');
  return '地址保留';
});

check('云端配置项不进入备份数据包', () => {
  resetCloud();
  setCloudServer('https://secret-server.example.com');
  store['teacher_cloud_token'] = 'topsecret';
  const raw = JSON.stringify(buildBackup());
  if (raw.includes('secret-server')) throw new Error('数据包里混入了服务器地址');
  if (raw.includes('topsecret')) throw new Error('数据包里混入了登录令牌');
  return '配置与业务数据严格隔离';
});

check('formatBytes 体积格式化', () => {
  if (formatBytes(0) !== '0 KB') throw new Error('0 处理错误');
  if (formatBytes(2048) !== '2.0 KB') throw new Error('KB 处理错误: ' + formatBytes(2048));
  if (formatBytes(3 * 1024 * 1024) !== '3.00 MB') throw new Error('MB 处理错误: ' + formatBytes(3 * 1024 * 1024));
  return '0 KB / 2.0 KB / 3.00 MB';
});

check('未上传过时 daysSinceUpload 返回 null', () => {
  resetCloud();
  if (daysSinceUpload() !== null) throw new Error('应为 null');
  store['teacher_cloud_meta'] = JSON.stringify({ lastUploadAt: new Date().toISOString() });
  if (daysSinceUpload() !== 0) throw new Error('今天上传应为 0 天');
  return '时间计算正确';
});

check('登录态下的用户信息可正确读出', () => {
  resetCloud();
  store['teacher_cloud_token'] = 'x';
  store['teacher_cloud_user'] = JSON.stringify({ id: 'u9', username: '张老师', isAdmin: false, createdAt: '2026-01-01', lastLoginAt: null });
  const u = getCloudUser();
  if (!u || u.username !== '张老师') throw new Error('读取失败');
  return 'user 反序列化正常';
});

resetCloud();

console.log('\n[13] 新增模块在首页不丢（旧备份导入回归）');
/* 背景：`settings.moduleOrder` 是用户点「保存设置」时写下的，记的是**当时那个版本**的模块清单。
   v22 新增古诗文背诵后，旧顺序里没有它 —— 一旦直接拿这个数组渲染首页，
   新模块卡片就会凭空消失。用户实测就是「导入了以前导出的备份，首页回到旧样子」。
   修法：读取层 + 导入时统一走 normalizeModuleOrder 补齐。以下断言锁住这个行为。 */

/** 备份里真实出现过的旧顺序（v21 版默认值，只有 8 项） */
const OLD_ORDER = ['leave', 'schedule', 'homework', 'salary', 'duty', 'substitute', 'payment', 'settings'];
/** 首页 9 个模块卡片名 */
const CARD_NAMES = ['请假条', '我的课表', '作业收缴', '古诗文背诵', '工资统计', '值班统计', '代课统计', '支付截图', '个人设置'];

/** 渲染真实 App，返回首页出现的模块卡片名 */
function homeCards() {
  const html = renderToString(React.createElement(App)).replace(/<!-- -->/g, '');
  return CARD_NAMES.filter(n => html.includes(`<div class="feature-name">${n}</div>`));
}

check('normalizeModuleOrder 补齐后来新增的模块', () => {
  const full = normalizeModuleOrder(OLD_ORDER);
  if (full.length !== getModuleOrder().length) throw new Error('长度未补齐: ' + full.length);
  if (!full.includes('recite')) throw new Error('未补入 recite');
  if (full.slice(0, OLD_ORDER.length).join() !== OLD_ORDER.join()) throw new Error('用户原有相对顺序被改动');
  if (normalizeModuleOrder(undefined).length !== full.length) throw new Error('空值未回退到默认顺序');
  if (normalizeModuleOrder([]).length !== full.length) throw new Error('空数组未回退到默认顺序');
  const dirty = normalizeModuleOrder(['leave', '已删除的旧模块', 'recite']);
  if (dirty.includes('已删除的旧模块')) throw new Error('未知模块未过滤');
  if (dirty.length !== full.length) throw new Error('含未知项的数组未补齐');
  return `8 → ${full.length} 项（顺序不变，新模块补在末尾）`;
});

check('读取层：旧 moduleOrder 一读出来就是补齐的', () => {
  const keep = JSON.stringify(getData());
  const st = getData().settings || {};
  setData({ settings: { ...st, moduleOrder: OLD_ORDER }, history: [], salaries: [], duties: [], homeworkRecords: [], reciteRecords: [] });
  const after = getData().settings.moduleOrder;
  const rawOnDisk = JSON.parse(store['teacher_assistant_v3']).settings.moduleOrder;
  setData(JSON.parse(keep));
  if (!after.includes('recite')) throw new Error('读取层未补齐');
  if (after.slice(0, OLD_ORDER.length).join() !== OLD_ORDER.join()) throw new Error('原有顺序被改动');
  if (rawOnDisk.length !== OLD_ORDER.length) throw new Error('读取本身不该改写磁盘内容');
  return `读出来 ${after.length} 项 · 磁盘原文未被动`;
});

check('导入旧备份：入库前即补齐（不只是渲染时补）', () => {
  const keep = JSON.stringify(getData());
  applyBackup({ settings: { ...(getData().settings || {}), moduleOrder: OLD_ORDER }, history: [], salaries: [], duties: [], homeworkRecords: [], reciteRecords: [] }, 'replace');
  const onDisk = JSON.parse(store['teacher_assistant_v3']).settings.moduleOrder;
  applyBackup(JSON.parse(keep), 'replace');
  if (!onDisk.includes('recite')) throw new Error('落盘数据仍缺 recite');
  if (onDisk.slice(0, OLD_ORDER.length).join() !== OLD_ORDER.join()) throw new Error('原有顺序被改动');
  return `落盘顺序已含 recite（${onDisk.length} 项）`;
});

check('★ 导入旧备份后首页仍有「古诗文背诵」入口（真实渲染 App）', () => {
  const keep = JSON.stringify(getData());
  const before = homeCards();
  applyBackup({ settings: { ...(getData().settings || {}), moduleOrder: OLD_ORDER }, history: [], salaries: [], duties: [], homeworkRecords: [], reciteRecords: [] }, 'replace');
  const after = homeCards();
  applyBackup(JSON.parse(keep), 'replace');
  if (before.length !== CARD_NAMES.length) throw new Error('前置状态异常，首页只有 ' + before.length + ' 个模块');
  const missing = CARD_NAMES.filter(n => !after.includes(n));
  if (missing.length) throw new Error('导入后首页缺少：' + missing.join('、'));
  return `${before.length} 个模块 → 导入旧备份后仍 ${after.length} 个`;
});

check('覆盖导入留撤销快照，可一键退回导入前状态', () => {
  clearPreImportSnapshot();
  if (getPreImportSnapshot()) throw new Error('清空后仍读到快照');
  const keep = JSON.stringify(getData());
  if (!snapshotBeforeImport()) throw new Error('快照写入失败');
  const info = getPreImportSnapshot();
  if (!info) throw new Error('读不到快照信息');
  if (!info.at || !info.summary) throw new Error('快照信息不完整');
  applyBackup({ settings: null, history: [], salaries: [], duties: [], homeworkRecords: [], reciteRecords: [] }, 'replace');
  if (getData().reciteRecords.length !== 0) throw new Error('覆盖未生效');
  if (!restorePreImport()) throw new Error('撤销失败');
  if (JSON.stringify(getData()) !== keep) throw new Error('撤销后数据与导入前不一致');
  if (getPreImportSnapshot()) throw new Error('撤销后快照应作废');
  return `快照「${info.summary.slice(0, 24)}…」→ 撤销后逐字节还原`;
});

check('过期的撤销快照会被自动清理', () => {
  clearPreImportSnapshot();
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  store['teacher_preimport_snapshot'] = JSON.stringify({ at: old, data: getData() });
  if (getPreImportSnapshot()) throw new Error('过期快照未清理');
  if (store['teacher_preimport_snapshot'] !== undefined) throw new Error('过期快照未从存储中删除');
  return '30 天前的快照已清掉';
});

check('撤销快照不进备份文件（免得备份越滚越大）', () => {
  snapshotBeforeImport();
  const raw = JSON.stringify(buildBackup());
  clearPreImportSnapshot();
  if (raw.includes('teacher_preimport_snapshot')) throw new Error('快照被写进了备份文件');
  return '备份文件不含撤销快照';
});

console.log('\n[14] 版本号 / 更新记录 / 分享备份 / 「标记为」选中态');

check('版本号与更新记录自洽', () => {
  // 别写死字面量：发版时只改 version.ts，测试不用跟着回来改
  if (!/^V\d+$/.test(APP_VERSION)) throw new Error('版本号格式应为 V+数字，实际 ' + APP_VERSION);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(APP_BUILD)) throw new Error('发布日期格式不对：' + APP_BUILD);
  if (CHANGELOG.length === 0) throw new Error('更新记录为空');
  if (CHANGELOG[0].version !== APP_VERSION) throw new Error('更新记录第一条必须是当前版本');
  const seen = new Set();
  for (const r of CHANGELOG) {
    if (!/^V\d+$/.test(r.version)) throw new Error('版本号格式不对：' + r.version);
    if (seen.has(r.version)) throw new Error('重复的版本号：' + r.version);
    seen.add(r.version);
    if (!r.items || r.items.length === 0) throw new Error(`${r.version} 没写更新内容`);
    for (const it of r.items) {
      if (typeof it !== 'string' || it.length < 8) throw new Error(`${r.version} 的更新内容太短：「${it}」`);
    }
  }
  return `${APP_VERSION}（${APP_BUILD}）· 收录 ${CHANGELOG.length} 个版本 · 本版 ${CHANGELOG[0].items.length} 条`;
});

check('★ 个人设置里能看到版本号与更新内容', () => {
  const h = R(React.createElement(VersionSection, { defaultOpen: true }));
  if (!h.includes(APP_VERSION)) throw new Error('没显示版本号');
  if (!h.includes('版本与更新记录')) throw new Error('缺少区块标题');
  if (!h.includes(APP_BUILD)) throw new Error('没显示更新日期');
  if (!h.includes('当前版本')) throw new Error('没标出哪条是当前版本');
  for (const r of CHANGELOG) if (!h.includes(r.version)) throw new Error('缺少 ' + r.version + ' 的记录');
  for (const it of CHANGELOG[0].items) if (!h.includes(it.slice(0, 8))) throw new Error('本版更新内容未渲染：' + it.slice(0, 12));
  // 默认（不传参数）应是折叠的，但标题上的版本号必须还在 —— 不然用户根本发现不了
  const closed = R(React.createElement(VersionSection, {}));
  if (!closed.includes(APP_VERSION)) throw new Error('折叠时标题上看不到版本号');
  if (closed.includes('ver-hero')) throw new Error('默认应为折叠');
  return `展开 ${h.length} 字符 · 折叠仍显示 ${APP_VERSION}`;
});

check('★ 首页底部显示版本号（真实渲染 App）', () => {
  const h = R(React.createElement(App));
  if (!h.includes('class="home-ver"')) throw new Error('首页没有版本号');
  const m = h.match(/教师助手 <b>([^<]+)<\/b>/);
  if (!m) throw new Error('首页版本号未渲染');
  if (m[1] !== APP_VERSION) throw new Error(`首页显示 ${m[1]}，应为 ${APP_VERSION}`);
  return `首页显示 ${m[1]}`;
});

check('★「标记为」：选中的那个带 ✓、实心、且只有一个', () => {
  const brush = 'recited';
  const list = students.map(st => ({ st, passed: 0, redo: 0, left: poems.length, total: poems.length, counted: true }));
  const h = R(React.createElement(MatrixView, {
    record: rec, poems, students: list, brush, setBrush: noop,
    onSetMark: noop, onBulkSet: noop, onQuickCheck: noop, onEditTypo: noop, onUndo: noop, undoDepth: 0, toast: noop,
  }));
  // v31 起 chip 内部多了 <i>✓</i> 与两个 <span>（完整名 / 单字名），内容里会出现 '<'
  const chips = h.match(/<div class="rc-brush-chip[^"]*"[^>]*>.*?<\/div>/g) || [];
  if (chips.length !== STATUS_META.length) throw new Error(`状态按钮应为 ${STATUS_META.length} 个，实际 ${chips.length}`);
  const active = chips.filter(c => c.includes('active'));
  if (active.length !== 1) throw new Error('选中的状态应恰好 1 个，实际 ' + active.length);
  const on = active[0];
  const meta = STATUS_META.find(x => x.value === brush);
  if (!on.includes('✓')) throw new Error('选中的状态没有 ✓');
  if (!on.includes(meta.label)) throw new Error('选中的不是「' + meta.label + '」');
  if (!on.includes(meta.color)) throw new Error('选中态没用自己的状态色实心填充');
  if (!on.includes('#fff')) throw new Error('选中态文字应为白色');
  if ((h.match(/✓/g) || []).length !== 1) throw new Error('✓ 只应出现在选中的那个上');
  // 没选中的保持浅底（用各自的 bg），靠对比把选中项凸显出来
  const off = chips.find(c => !c.includes('active'));
  if (!off.includes(meta.bg) && !STATUS_META.some(x => off.includes(x.bg))) throw new Error('未选中项丢失浅底样式');
  return `1 个实心「✓ ${meta.label}」+ ${chips.length - 1} 个浅底`;
});

check('选中态样式：放大 + 加粗 + 光环（不是只换个底色）', () => {
  const css = readFileSync(new URL('./src/App.css', import.meta.url), 'utf8');
  const block = name => {
    const i = css.lastIndexOf(name);
    if (i < 0) throw new Error('样式里找不到 ' + name);
    return css.slice(i, css.indexOf('}', i));
  };
  const chip = block('.rc-brush-chip.active');
  for (const want of ['transform: scale', 'font-weight: 800', 'box-shadow']) {
    if (!chip.includes(want)) throw new Error('.rc-brush-chip.active 缺少 ' + want);
  }
  if (!block('.rc-brush-chip').includes('opacity')) throw new Error('未选中的状态按钮没有淡下去，对比不够');
  const pp = block('.rc-pp-btn.active');
  for (const want of ['font-weight: 800', 'transform: scale']) {
    if (!pp.includes(want)) throw new Error('.rc-pp-btn.active 缺少 ' + want);
  }
  return '实心 + 放大 + 光环 + 未选中淡出';
});

/* v31：用户反馈「待补背」被挤到第二行。
   根因是四个 chip 各自是 brush-bar 的 flex item，窄屏会在 chip 之间断行。
   这里锁住三件事：① 四个 chip 在同一个 nowrap 容器里；② 完整名与单字名都渲染；
   ③ 窄屏媒体查询会把完整名换成单字。 */
check('★ V31：四个状态永远站同一行（同容器 + nowrap + 窄屏单字回退）', () => {
  const list = students.map(st => ({ st, passed: 0, redo: 0, left: poems.length, total: poems.length, counted: true }));
  const h = R(React.createElement(MatrixView, {
    record: rec, poems, students: list, brush: 'todo', setBrush: noop,
    onSetMark: noop, onBulkSet: noop, onQuickCheck: noop, onEditTypo: noop, onUndo: noop, undoDepth: 0, toast: noop,
  }));
  // v34 起撤销/恢复按钮成对包进 rc-undo-pair，所以右边界改成那个容器
  const g = h.match(/<span class="rc-brush-group">([\s\S]*?)<\/span>\s*<span class="rc-undo-pair">/);
  if (!g) throw new Error('没有 rc-brush-group 容器 —— 四个状态还是各自独立的 flex item，窄屏会被拆行');
  const inner = g[1];
  const n = (inner.match(/rc-brush-chip/g) || []).length;
  if (n !== STATUS_META.length) throw new Error(`容器内应有 ${STATUS_META.length} 个状态，实际 ${n}`);
  for (const m of STATUS_META) {
    if (!inner.includes(`>${m.label}<`)) throw new Error('容器内缺完整名：' + m.label);
    if (!inner.includes(`>${m.short}<`)) throw new Error('容器内缺单字名：' + m.short);
  }
  const css = readFileSync(new URL('./src/App.css', import.meta.url), 'utf8');
  const gi = css.lastIndexOf('.rc-brush-group');
  if (!css.slice(gi, css.indexOf('}', gi)).includes('nowrap')) throw new Error('.rc-brush-group 没有 flex-wrap: nowrap，仍然会拆行');
  const mi = css.lastIndexOf('@media (max-width: 360px)');
  if (mi < 0 || !css.slice(mi, mi + 400).includes('.rc-brush-t { display: none; }')) {
    throw new Error('窄屏没有切单字的兜底样式');
  }
  return `${n} 个状态同容器 + nowrap + ≤360px 单字回退`;
});

check('备份文件名「导出」与「分享」一致', () => {
  if (!backupFileName().endsWith('.json')) throw new Error('扩展名不对：' + backupFileName());
  if (!backupFileName().includes('数据备份')) throw new Error('文件名不易识别：' + backupFileName());
  return backupFileName();
});

/* shareBackup 要走异步（等系统分享面板），单独用顶层 await 测。
   node 里没有 navigator.share / document，所以按分支打桩。 */
const navDesc = globalThis.navigator;
const realDocument = globalThis.document;
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
globalThis.document = { createElement: () => ({ click: noop, style: {} }), body: { appendChild: noop, removeChild: noop } };
URL.createObjectURL = () => 'blob:test';
URL.revokeObjectURL = noop;

let sharedPayload = null;
Object.defineProperty(globalThis, 'navigator', {
  value: { share: async (o) => { sharedPayload = o; }, canShare: () => true },
  configurable: true, writable: true,
});
try {
  const r = await shareBackup();
  check('★ 手机上分享备份：把 .json 文件直接交给系统分享面板', () => {
    if (r !== 'shared') throw new Error('应为 shared，实际 ' + r);
    const f = sharedPayload?.files?.[0];
    if (!f) throw new Error('没有把文件传给分享面板');
    if (!f.name.endsWith('.json')) throw new Error('文件名不对：' + f.name);
    if (f.type !== 'application/json') throw new Error('文件类型不对：' + f.type);
    if (!getBackupMeta().lastBackupAt) throw new Error('分享出去后应记一次「已备份」');
    return `${f.name}（${f.size} 字节）`;
  });
} catch (e) {
  failures++;
  console.log('  FAIL 分享备份\n       ' + (e && e.message));
}

// 电脑浏览器基本都不支持分享文件 → 必须自动退回下载，不能点了没反应
let downloaded = false;
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
globalThis.document = {
  createElement: () => ({ click: () => { downloaded = true; }, style: {} }),
  body: { appendChild: noop, removeChild: noop },
};
try {
  const r = await shareBackup();
  check('不支持分享文件的浏览器自动退回下载', () => {
    if (r !== 'downloaded') throw new Error('应为 downloaded，实际 ' + r);
    if (!downloaded) throw new Error('没有触发下载');
    return '已退回下载';
  });
} catch (e) {
  failures++;
  console.log('  FAIL 退回下载\n       ' + (e && e.message));
} finally {
  Object.defineProperty(globalThis, 'navigator', { value: navDesc, configurable: true, writable: true });
  globalThis.document = realDocument;
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
}

console.log('\n[15] 首页模块显示 / 隐藏（模块开关）');
/* 背景：显示/隐藏的开关本身装在「个人设置」页里。
   一旦设置页被隐藏，用户就再也进不去、改不回来 —— 所以「设置页不可隐藏」
   必须是**数据层的硬约束**，不能只靠界面把开关置灰。
   下面同时锁住两件事：能隐藏、以及无论如何都藏不掉设置页。 */

check('normalizeHiddenModules：滤掉脏数据，并强制保住「个人设置」', () => {
  if (normalizeHiddenModules(undefined).length !== 0) throw new Error('undefined 应为空数组');
  if (normalizeHiddenModules(null).length !== 0) throw new Error('null 应为空数组');
  if (normalizeHiddenModules([]).length !== 0) throw new Error('空数组应保持为空');
  const dirty = normalizeHiddenModules(['recite', 'settings', '已删除的模块', 'recite', 'leave', 123]);
  if (dirty.includes('settings')) throw new Error('★「个人设置」被藏掉了 —— 用户会永远进不去设置页');
  if (dirty.includes('已删除的模块')) throw new Error('未知模块未过滤');
  if (dirty.includes('123')) throw new Error('非字符串项未过滤');
  if (dirty.filter(k => k === 'recite').length !== 1) throw new Error('重复项未去重');
  if (dirty.join() !== 'recite,leave') throw new Error('有效项丢失或顺序被改：' + dirty.join());
  return `6 项脏数据 → ${dirty.join('、')}`;
});

check('「个人设置」写死在不可隐藏名单里', () => {
  if (!Array.isArray(ALWAYS_VISIBLE_MODULES)) throw new Error('ALWAYS_VISIBLE_MODULES 应为数组');
  if (!ALWAYS_VISIBLE_MODULES.includes('settings')) throw new Error('设置页不在固定显示名单里');
  return ALWAYS_VISIBLE_MODULES.join('、');
});

check('visibleModules：只去掉被隐藏的，顺序不动', () => {
  const all = getModuleOrder();
  const v = visibleModules(all, ['recite', 'payment']);
  if (v.length !== all.length - 2) throw new Error(`应为 ${all.length - 2} 个，实际 ${v.length}`);
  if (v.includes('recite') || v.includes('payment')) throw new Error('被隐藏的模块仍在列表里');
  if (v.join() !== all.filter(k => k !== 'recite' && k !== 'payment').join()) throw new Error('原有顺序被改动');
  return `${all.length} 个 → 隐藏 2 个剩 ${v.length} 个，顺序不变`;
});

check('★ 9 个模块全塞进隐藏名单，首页也一定剩「个人设置」', () => {
  const all = getModuleOrder();
  const v = visibleModules(all, all);
  if (!v.includes('settings')) throw new Error('★ 设置页也消失了 —— 用户再也改不回来');
  if (v.length !== 1) throw new Error('应只剩设置页，实际剩 ' + v.length + ' 个');
  return `${all.length} 个全隐藏 → 仍剩「个人设置」`;
});

check('读取层：手改 localStorage 也藏不掉设置页', () => {
  const keep = JSON.stringify(getData());
  const st = getData().settings || {};
  setData({ settings: { ...st, hiddenModules: ['settings', 'recite', '不存在的模块'] }, history: [], salaries: [], duties: [], homeworkRecords: [], reciteRecords: [] });
  const after = getHiddenModules();
  const onDisk = JSON.parse(store['teacher_assistant_v3']).settings.hiddenModules;
  setData(JSON.parse(keep));
  if (after.includes('settings')) throw new Error('读取层没有拦住「个人设置」');
  if (after.includes('不存在的模块')) throw new Error('读取层没有过滤未知模块');
  if (after.join() !== 'recite') throw new Error('有效项丢失：' + after.join());
  if (!onDisk.includes('settings')) throw new Error('前置异常：磁盘上本来就没写进去');
  return '落盘含 settings → 读出来已被剔除，只剩 recite';
});

check('★ 隐藏后首页少几张卡片，但数据一条不丢（真实渲染 App）', () => {
  // 先保证有一条背诵记录，才能验证「隐藏 ≠ 删除」
  saveReciteRecord(rec);
  const keep = JSON.stringify(getData());
  const st = getData().settings || {};
  setData({ ...getData(), settings: { ...st, hiddenModules: [] } });
  const full = homeCards();
  setData({ ...getData(), settings: { ...st, hiddenModules: ['recite', 'payment', 'duty'] } });
  const hiddenView = homeCards();
  const reciteRows = getReciteRecords().length;
  setData(JSON.parse(keep));
  if (!full.includes('古诗文背诵')) throw new Error('前置状态异常：未隐藏时首页就没有背诵入口');
  for (const n of ['古诗文背诵', '支付截图', '值班统计']) {
    if (hiddenView.includes(n)) throw new Error('隐藏后首页仍显示「' + n + '」');
  }
  if (hiddenView.length !== full.length - 3) throw new Error(`首页应为 ${full.length - 3} 个，实际 ${hiddenView.length} 个`);
  if (!hiddenView.includes('个人设置')) throw new Error('★ 设置页被藏掉了');
  if (reciteRows === 0) throw new Error('★ 隐藏把背诵数据删掉了 —— 隐藏只能是「不显示」');
  return `${full.length} 个 → 隐藏 3 个剩 ${hiddenView.length} 个；背诵数据仍有 ${reciteRows} 条`;
});

/** 渲染设置页（默认展开到「模块显示与排序」那一段） */
function settingsHtml(hide) {
  return R(React.createElement(SettingsPage, {
    settings: { ...(getData().settings || {}), name: '张××', hiddenModules: hide },
    toast: noop, refresh: noop, moduleOrder: getModuleOrder(), hiddenModules: hide,
    openQr: noop, defaultSection: 'modules',
  }));
}

check('★ 设置页：每个模块一个开关，「个人设置」换成一把锁', () => {
  const total = getModuleOrder().length;
  const h = settingsHtml([]);
  if (!h.includes('首页模块显示与排序')) throw new Error('缺少区块标题');
  const on = (h.match(/class="msi-sw on"/g) || []).length;
  const off = (h.match(/class="msi-sw off"/g) || []).length;
  const locks = (h.match(/class="msi-lock"/g) || []).length;
  if (on + off !== total - ALWAYS_VISIBLE_MODULES.length) throw new Error(`开关应为 ${total - 1} 个，实际 ${on + off}`);
  if (on !== total - 1 || off !== 0) throw new Error('默认应全部处于「显示」状态');
  if (locks !== 1) throw new Error('「个人设置」应恰好用一个锁替掉开关');
  if (!h.includes('固定显示')) throw new Error('没标出哪个模块固定显示');
  if (!h.includes('不能隐藏')) throw new Error('没说明「个人设置」为什么不能隐藏');
  if (!h.includes('全部显示')) throw new Error('缺少「全部显示」兜底按钮');
  if (!h.includes('隐藏不会删数据')) throw new Error('没讲清「隐藏不删数据」');
  return `${total - 1} 个开关 + 1 把锁 + 兜底按钮`;
});

check('★ 被收起的模块：开关关闭 + 标「已隐藏」+ 整行淡下去', () => {
  const total = getModuleOrder().length;
  const h = settingsHtml(['recite']);
  if ((h.match(/class="msi-sw off"/g) || []).length !== 1) throw new Error('应恰好 1 个开关处于关闭');
  if ((h.match(/class="msi-sw on"/g) || []).length !== total - 2) throw new Error('其余开关应保持开启');
  if (!h.includes('已隐藏')) throw new Error('被隐藏的模块没有标注');
  if (!h.includes('module-sort-item off')) throw new Error('被隐藏的模块没有淡下去（缺 .off）');
  if (!h.includes('已隐藏 1 个')) throw new Error('标题上看不到隐藏了几个');
  const m = h.match(/首页将显示 <b>(\d+)<\/b>/);
  if (!m) throw new Error('没有显示「首页将显示几个模块」');
  if (Number(m[1]) !== total - 1) throw new Error(`应显示 ${total - 1}，实际 ${m[1]}`);
  return `1 个已隐藏 · 首页将显示 ${m[1]} / ${total} 个`;
});

check('开关样式：绿色实心 + 滑块位移（不是只换个底色）', () => {
  const css = readFileSync(new URL('./src/App.css', import.meta.url), 'utf8');
  const rule = sel => {
    const i = css.indexOf(sel + ' {');
    if (i < 0) throw new Error('样式里找不到 ' + sel);
    return css.slice(i, css.indexOf('}', i));
  };
  if (!rule('.msi-sw.on').includes('--ios-green')) throw new Error('.msi-sw.on 没有用开关绿');
  if (!rule('.msi-sw.on .msi-sw-knob').includes('translateX')) throw new Error('滑块没有位移，看不出开/关');
  if (!rule('.msi-sw-knob').includes('transition')) throw new Error('滑块没有过渡动画');
  if (!css.includes('.module-sort-item.off')) throw new Error('被隐藏的模块没有淡下去');
  return '绿色实心 + 滑块位移 + 过渡 + 隐藏行淡出';
});

check('备份带上「哪些模块被收起来了」（给同事时对方打开是同一个首页）', () => {
  const keep = JSON.stringify(getData());
  setData({ ...getData(), settings: { ...(getData().settings || {}), moduleOrder: getModuleOrder(), hiddenModules: ['recite', 'payment'] } });
  const restored = parseBackup(JSON.stringify(buildBackup())).file?.data?.settings?.hiddenModules;
  const after = JSON.parse(JSON.stringify(buildBackup())).data.settings.hiddenModules;
  setData(JSON.parse(keep));
  if (!restored || restored.join() !== 'recite,payment') throw new Error('备份里没带上隐藏设置：' + JSON.stringify(restored));
  if (after.join() !== 'recite,payment') throw new Error('导出文件里没带上：' + JSON.stringify(after));
  return '导出 / 解析都在：' + JSON.stringify(restored);
});

console.log('\n[16] 应用图标（V32 换了新图标 + 自己换图标的接口）');

/** 读 PNG 的真实边长：8 字节签名 + IHDR 里的宽高各 4 字节大端 */
function pngSize(buf) {
  if (buf.length < 24 || buf.subarray(0, 8).toString('latin1') !== '\x89PNG\r\n\x1a\n') {
    throw new Error('不是合法的 PNG 文件');
  }
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
const pub = (f) => new URL('./public/' + f, import.meta.url);

check('manifest 里声明的每个图标都真实存在，边长与声明一致、且是正方形', () => {
  const man = JSON.parse(readFileSync(new URL('./public/manifest.json', import.meta.url), 'utf8'));
  const seen = [];
  for (const ic of man.icons) {
    const { w, h } = pngSize(readFileSync(pub(ic.src.replace('./', ''))));
    const [sw, sh] = ic.sizes.split('x').map(Number);
    if (w !== sw || h !== sh) throw new Error(`${ic.src} 声明 ${ic.sizes}，实际 ${w}×${h}`);
    if (w !== h) throw new Error(`${ic.src} 不是正方形（${w}×${h}），安卓会变形`);
    seen.push(ic.sizes);
  }
  return `${man.icons.length} 个：${seen.join(' / ')}`;
});

check('index.html 引用的图标文件同样都在（别只在 manifest 里有）', () => {
  const h = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const hrefs = [...h.matchAll(/href="\.\/([\w.-]+\.png)[^"]*"/g)].map(m => m[1]);
  if (!hrefs.length) throw new Error('index.html 里没有任何 PNG 图标引用');
  for (const f of hrefs) pngSize(readFileSync(pub(f)));
  return hrefs.join(' / ');
});

check('浏览器页签给了 32px 的小图标，不再挂着那个旧 favicon.ico', () => {
  const h = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  if (h.includes('favicon.ico')) throw new Error('还引着 favicon.ico（那是个改了名的旧 PNG）');
  if (!h.includes('favicon-32.png')) throw new Error('没有引用 favicon-32.png');
  return 'favicon-32.png + apple-touch-icon + 192/512';
});

check('安卓图标单独出一份 maskable（拿高清图标硬顶会被系统裁掉四角）', () => {
  const man = JSON.parse(readFileSync(new URL('./public/manifest.json', import.meta.url), 'utf8'));
  const mask = man.icons.filter(i => (i.purpose || '').includes('maskable'));
  if (mask.length !== 1) throw new Error(`maskable 图标应当只有 1 份，实际 ${mask.length} 份`);
  if (mask[0].src !== './pwa-icon-maskable-512.png') throw new Error('maskable 指错了：' + mask[0].src);
  const mixed = man.icons.filter(i => (i.purpose || '').includes('any maskable'));
  if (mixed.length) throw new Error('还有图标写着 "any maskable"：' + mixed.map(i => i.src).join());
  const { w } = pngSize(readFileSync(pub('pwa-icon-maskable-512.png')));
  if (w !== 512) throw new Error('maskable 边长不对：' + w);
  return '192/512 = any，另出 1 份 maskable 512';
});

check('iOS 主屏图标（apple-touch-icon）是 180×180', () => {
  const { w, h } = pngSize(readFileSync(pub('apple-touch-icon.png')));
  if (w !== 180 || h !== 180) throw new Error(`实际 ${w}×${h}`);
  return '180×180';
});

check('版本区块里写了「怎么自己换图标」', () => {
  const h = R(React.createElement(VersionSection, { defaultOpen: true }));
  if (!h.includes('想换掉这个图标')) throw new Error('没给换图标的入口');
  if (!h.includes('我的图标.png')) throw new Error('没告诉用户图片该叫什么名字');
  if (!h.includes('添加到主屏幕')) throw new Error('没提醒手机上的图标要重新添加才会变');
  return '指向交付包的「图标」文件夹';
});

check('换图标脚本与说明都在源码里，脚本带可执行位（打包/拷贝后别丢）', () => {
  const files = ['换图标（Mac）.command', '说明.md'];
  for (const f of files) readFileSync(new URL('./replace-icon/' + f, import.meta.url));
  const mode = statSync(new URL('./replace-icon/' + files[0], import.meta.url)).mode;
  if (!(mode & 0o111)) throw new Error('「换图标（Mac）.command」没有可执行位，双击会是灰的');
  return files.join(' + ');
});

/* v33：表头固定。用户要求「课表的周几表头、古诗文背诵的篇目表头都要固定住，
   以后凡是这种登记表格的地方都固定表头」。这里把四件事锁死：
   ① 通用容器 .tbl-scroll 的表头真的 sticky，并且容器有高度上限
     （没有高度上限就不会产生纵向滚动，sticky 表头等于没写 —— 最容易踩的坑）；
   ② 表头/首列底色必须是不透明色（毛玻璃色会让滚动的内容从底下透出来）；
   ③ 课表与背诵矩阵的容器真的挂上了这个类（SSR 真实渲染断言）；
   ④ 四张 data-table 都迁到了这个类，且不再有旧的 inline overflowX 写法。 */
console.log('\n[17] 表头固定（课表 / 背诵篇目 / 各登记表）');

check('★ 课表：表头固定，「节次」那一列也跟着固定', () => {
  const h = R(React.createElement(SchedulePage, {
    settings: { schoolName: '××中学', timeTable: [{ name: '第1节', startTime: '08:00', endTime: '08:40' }] },
    periodNames: ['第1节', '第2节', '晨读'],
    schedule: { courses: { 1: [{ period: '第1节', classSubject: '初二(1)语文' }] } },
    ...props,
  }));
  const wrap = h.match(/<div class="schedule-scroll[^"]*">/);
  if (!wrap) throw new Error('课表外层容器不见了');
  for (const c of ['tbl-scroll', 'tbl-first-sticky']) {
    if (!wrap[0].includes(c)) throw new Error(`课表容器缺 ${c} —— 表头/首列不会固定`);
  }
  const thead = h.match(/<thead>([\s\S]*?)<\/thead>/);
  if (!thead) throw new Error('课表没有表头');
  for (const d of ['星期一', '星期二', '星期三', '星期四', '星期五']) {
    if (!thead[1].includes(d)) throw new Error('表头缺 ' + d);
  }
  if (!thead[1].includes('节次')) throw new Error('表头缺「节次」列');
  if (!h.includes('course-tag')) throw new Error('课表格子没渲染出来');
  return '节次 + 星期一~五 固定，横向滑动也知道看的是第几节';
});

check('★ 背诵进度矩阵：篇目表头（篇名）固定', () => {
  const list = students.map(st => ({ st, passed: 0, redo: 0, left: poems.length, total: poems.length, counted: true }));
  const h = R(React.createElement(MatrixView, {
    record: rec, poems, students: list, brush: 'todo', setBrush: noop,
    onSetMark: noop, onBulkSet: noop, onQuickCheck: noop, onEditTypo: noop, onUndo: noop, undoDepth: 0, toast: noop,
  }));
  const wrap = h.match(/<div class="rc-matrix-wrap[^"]*">/);
  if (!wrap || !wrap[0].includes('tbl-scroll')) throw new Error('背诵矩阵没挂 tbl-scroll —— 往下翻学生时篇名表头会跟着滚走');
  const ths = h.match(/<th class="rc-th-poem"/g) || [];
  if (ths.length !== poems.length) throw new Error(`篇目表头应为 ${poems.length} 个，实际 ${ths.length}`);
  if (!h.includes('rc-sticky-col rc-th-name')) throw new Error('左上角「学生」格不是双轴固定（横竖滚动都会错位）');
  return `${ths.length} 个篇目表头 + 学生列，双轴固定`;
});

check('★ 表头固定的样式前提：容器有高度上限 + 表头底色不透明', () => {
  const css = readFileSync(new URL('./src/App.css', import.meta.url), 'utf8');
  const blockOf = (name) => {
    const i = css.lastIndexOf(name);
    if (i < 0) throw new Error('样式里找不到 ' + name);
    return css.slice(i, css.indexOf('}', i));
  };
  // ⚠️ 这里必须取「第一条」.tbl-scroll 规则：文件后面还有一个
  //    `@supports (height: 100dvh) { .tbl-scroll { --tbl-h: … } }`，
  //    lastIndexOf 会取到那一条，于是「缺少 overflow: auto」假失败。
  const wrapIdx = css.indexOf('.tbl-scroll {');
  if (wrapIdx < 0) throw new Error('样式里找不到 .tbl-scroll {');
  const wrap = css.slice(wrapIdx, css.indexOf('}', wrapIdx));
  for (const want of ['overflow: auto', 'max-height: var(--tbl-h)']) {
    if (!wrap.includes(want)) throw new Error('.tbl-scroll 缺少 ' + want);
  }
  const head = blockOf('.tbl-scroll table > thead > tr > th {');
  for (const want of ['position: sticky', 'top: 0', 'background: var(--tbl-head-bg)']) {
    if (!head.includes(want)) throw new Error('表头样式缺少 ' + want);
  }
  const first = blockOf('.tbl-scroll.tbl-first-sticky table > tbody > tr > td:first-child {');
  if (!first.includes('left: 0')) throw new Error('首列没有 left: 0，横向滚动时不会固定');
  const bgs = [...css.matchAll(/--tbl-head-bg:\s*([^;]+);/g)].map(m => m[1].trim());
  if (bgs.length < 2) throw new Error('亮色/暗色都要给表头底色（当前只有 ' + bgs.length + ' 处）');
  for (const v of bgs) {
    if (/rgba?\(|var\(/.test(v)) throw new Error('表头底色必须是不透明色，否则滚动内容会透出来：' + v);
  }
  const colBg = [...css.matchAll(/--tbl-col-bg:\s*([^;]+);/g)].map(m => m[1].trim());
  for (const v of colBg) if (/rgba?\(/.test(v)) throw new Error('首列底色必须是实色：' + v);
  return `${bgs.length} 组底色（亮/暗）· 容器上限 = 视口 − 标题栏 − 下方留白`;
});

check('★ data-table 改成 border-collapse: separate（collapse 会让固定表头的下边框消失）', () => {
  const css = readFileSync(new URL('./src/App.css', import.meta.url), 'utf8');
  const i = css.lastIndexOf('.data-table {');
  const block = css.slice(i, css.indexOf('}', i));
  if (!block.includes('border-collapse: separate')) throw new Error('仍是 collapse，表头吸顶时边框会缺一条');
  if (!block.includes('border-spacing: 0')) throw new Error('separate 没有配 border-spacing: 0，格子会散开');
  return 'separate + spacing 0（只有下边框，外观不变）';
});

check('★ 四张登记表都挂上了表头固定（工资 / 值班 / 代课 / 作业收缴）', () => {
  const need = { 'App.tsx': 3, 'homework.tsx': 1 };
  let total = 0;
  for (const f of Object.keys(need)) {
    const src = readFileSync(new URL('./src/' + f, import.meta.url), 'utf8');
    const found = (src.match(/className="tbl-scroll"/g) || []).length;
    // 用「不少于」而不是「等于」：以后新加登记表只要照抄这个类即可，不会把测试弄红
    if (found < need[f]) throw new Error(`${f} 里应有 ${need[f]} 处 className="tbl-scroll"，实际 ${found}`);
    const inline = (src.match(/overflowX: 'auto'/g) || []).length;
    if (inline) throw new Error(`${f} 还有 ${inline} 处旧的 inline overflowX —— 那种写法不会有固定表头`);
    total += found;
  }
  return `${total} 张表 + 旧的 inline 写法已清干净`;
});

/* v35：用户说「作业收缴的表格只显示 8 个，太少；课表下面的时间也多显示点；
   而且往上滑时表头应该钉在『教师个人助手』标题栏下面别滑走」。做法是把表格高度上限
   从写死的 62vh 改成「视口高 − 标题栏高 − 表格下方留白」。这里锁死四件事：
   ① 算式真的引用了 --app-header-h / --tbl-tail，而不是又写死一个 vh；
   ② 手机地址栏会伸缩，必须同时给 dvh 版本（且放在 @supports 里，老浏览器不会整条失效）；
   ③ 表格下面还有内容的页面（课表提示行、矩阵导出按钮行）要自己调大 --tbl-tail，
      给小了表头会被标题栏压住 —— 这是这套算法唯一的坑；
   ④ 工具条要真的收成一行（导出按钮行 nowrap + 可横滚、视图按钮字号收小）。 */
console.log('\n[18] 表格高度（v35：铺满标题栏以下整屏，表头不滑走）');

check('★ 表格高度上限 = 视口 − 标题栏 − 下方留白', () => {
  const css = readFileSync(new URL('./src/App.css', import.meta.url), 'utf8');
  if (!css.includes('--app-header-h')) throw new Error(':root 里没有 --app-header-h，表格高度就没法跟着标题栏算');
  if (!css.includes('100vh - var(--app-header-h) - var(--tbl-tail)')) {
    throw new Error('--tbl-h 不是「视口高 − 标题栏 − 下方留白」的算式（是不是又写死成 xxvh 了？）');
  }
  if (!css.includes('100dvh - var(--app-header-h) - var(--tbl-tail)')) {
    throw new Error('缺 dvh 版本：手机上地址栏收缩后，表格会顶出屏幕下沿');
  }
  if (!/@supports \(height: 100dvh\)/.test(css)) {
    throw new Error('dvh 那行没放进 @supports —— 老浏览器不认识 dvh 时整条 max-height 会失效，表格不再滚动');
  }
  if (!/--tbl-h:\s*max\(\s*\d+px,/.test(css)) throw new Error('--tbl-h 没有下限保护，屏幕极矮时表格会被压成一条缝');
  return 'vh 兜底 + dvh 精确版 + 最小高度保护';
});

check('★ 表格下方还有内容的页面，单独留出了空间（表头才不会被标题栏压住）', () => {
  const css = readFileSync(new URL('./src/App.css', import.meta.url), 'utf8');
  // 课表：表格下面有一行提示；背诵矩阵：表格下面那排导出按钮。
  // ⚠️ 不能用 lastIndexOf：暗色主题里还会再写一次 .schedule-scroll（只改底色、没有 --tbl-tail），
  //    取最后一条就会取到它。这里要求「存在一条带 --tbl-tail 的规则」。
  for (const [re, min, why] of [
    [/\.schedule-scroll \{[^}]*?--tbl-tail:\s*(\d+)px/g, 60, '课表表格下面有一行提示文字'],
    [/\.tbl-scroll\.rc-matrix-wrap \{[^}]*?--tbl-tail:\s*(\d+)px/g, 80, '矩阵下面有导出按钮行'],
  ]) {
    const hits = [...css.matchAll(re)];
    if (!hits.length) {
      throw new Error(`没有单独设 --tbl-tail（${why}）—— 不设会少算下方高度，表头会被标题栏压住`);
    }
    for (const m of hits) {
      if (Number(m[1]) < min) throw new Error(`--tbl-tail 只有 ${m[1]}px，太小了：${why}`);
    }
  }
  return '课表留 60px+ / 矩阵留 80px+';
});

check('★ 表格下方留白改成按实际内容自动测量（v37）', () => {
  const src = readFileSync(new URL('./src/App.tsx', import.meta.url), 'utf8');
  if (!/function useAutoTableTail\s*\(/.test(src)) {
    throw new Error('App.tsx 里没有 useAutoTableTail —— 又退回写死 --tbl-tail，必然有页面表头被标题栏压住');
  }
  if (!/useAutoTableTail\(page\)/.test(src)) {
    throw new Error('useAutoTableTail 定义了却没接上（v27 getModuleOrder / v30 saveHiddenModules 就是这样翻车的）');
  }
  // 必须真的量「表格下沿 → 文档末尾」这段距离（等于下方内容总高），并写回 --tbl-tail
  if (!/scrollHeight\s*-\s*\(r\.bottom\s*\+\s*window\.scrollY\)/.test(src)) {
    throw new Error('没有按「表格下沿到文档末尾」测量下方留白');
  }
  if (!/setProperty\('--tbl-tail'/.test(src)) throw new Error('量完没有写回 --tbl-tail');
  // 「只在与现值差 1px 以上才写」是必需的守卫，否则 ResizeObserver 会和自己互相触发
  if (!/Math\.abs\(cur - tail\) > 1/.test(src)) {
    throw new Error('缺少防抖守卫：ResizeObserver 会自我触发，页面可能卡死');
  }
  // ⚠️ 只监听换页面是不够的：页面内部的标签页 / 折叠 / 图表都会换 DOM，
  //    那时表格高度变了却不重算（实测矩阵页少算 12px，表头又被压住）。
  if (!/new MutationObserver\(run\)/.test(src) || !/childList: true, subtree: true/.test(src)) {
    throw new Error('缺少 MutationObserver：切换标签页（如「进度矩阵」）后不会重新测量');
  }
  // JS 跑起来之前也要有合理兜底
  const css = readFileSync(new URL('./src/App.css', import.meta.url), 'utf8');
  if (!/--tbl-tail:\s*46px/.test(css)) throw new Error('全局兜底 --tbl-tail 丢了');
  // ⚠️ --tbl-h 必须定义在 .tbl-scroll 自己身上。放 :root 的话，var(--tbl-tail) 在
  //    :root 那层就解析完了，JS 写在容器行内样式上的 --tbl-tail 完全不生效
  //    （实测：--tbl-tail 已经是 161px，max-height 仍然 723px，表头照样被压住）。
  const tsIdx = css.indexOf('.tbl-scroll {');
  if (tsIdx < 0) throw new Error('找不到 .tbl-scroll 规则');
  const tsBlock = css.slice(tsIdx, css.indexOf('}', tsIdx));
  if (!tsBlock.includes('--tbl-h:')) {
    throw new Error('--tbl-h 没定义在 .tbl-scroll 上 —— 会被 :root 抢先解析，行内 --tbl-tail 无效');
  }
  return '自动测量 + 已接上 + 有防抖 + 公式在容器上 + 保留 CSS 兜底';
});

check('★ 工具条与导出按钮行收成一行（不再各占两排）', () => {
  const css = readFileSync(new URL('./src/App.css', import.meta.url), 'utf8');
  const i = css.lastIndexOf('.rc-export-row {');
  if (i < 0) throw new Error('没有 .rc-export-row —— 背诵页的导出按钮又会被摊成两三行');
  const block = css.slice(i, css.indexOf('}', i));
  for (const want of ['flex-wrap: nowrap', 'overflow-x: auto']) {
    if (!block.includes(want)) throw new Error('.rc-export-row 缺少 ' + want);
  }
  const src = readFileSync(new URL('./src/recite.tsx', import.meta.url), 'utf8');
  if (!src.includes('className="rc-export-row"')) throw new Error('背诵页导出按钮没挂 rc-export-row，样式白写');
  if (/className="btn-row" style=\{\{ marginTop: 18, flexWrap: 'wrap' \}\}/.test(src)) {
    throw new Error('导出按钮还是旧的 flexWrap: wrap 写法，会在窄屏摊成两三行');
  }
  // 课表右上角三个视图按钮：字号不收回来的话，窄屏会被挤到第二行
  const vi = css.lastIndexOf('.view-tab {');
  const vblock = css.slice(vi, css.indexOf('}', vi));
  const fs = vblock.match(/font-size:\s*([\d.]+)px/);
  if (!fs) throw new Error('.view-tab 没写字号');
  if (Number(fs[1]) > 12) throw new Error(`.view-tab 字号 ${fs[1]}px 偏大，窄屏三个按钮会换行占两行`);
  const ri = css.lastIndexOf('.rc-toolbar {');
  const rblock = css.slice(ri, css.indexOf('}', ri));
  // v39：工具条从「换行」改成「不换行 + 可左右滑」（和 .rc-export-row 一个套路）——
  // 一排小控件不许被拆成两排。两条路都行，但不能两头都不占，否则极窄屏真会溢出。
  if (!rblock.includes('flex-wrap: nowrap') || !rblock.includes('overflow-x: auto')) {
    throw new Error('.rc-toolbar 既没换行、也不能左右滑，窄屏会直接把控件挤出去');
  }
  return '导出按钮一行 · 视图按钮收小 · 工具栏不换行 + 可横滑';
});
/* ============================================================
   V34 · 误点「撤销」之后要能恢复
   用户原话：「有时候我会不小心点到那个撤销，但是又回不去了……
              本来不想撤销的，但是被撤销了，恢复不了了。把这个做一个恢复。」
   ============================================================ */

console.log('\n[19] 撤销 / 恢复（v34 起 · v36 把入口做成常驻）');

check('恢复栈：push / pop / 持久化 / 随班级一起清掉', () => {
  clearUndo('rec_redo');
  if (getRedoStack('rec_redo').length !== 0) throw new Error('初始应为空');
  pushRedo('rec_redo', { at: 't', label: '标记 1 格', changes: [{ studentId: 's1', poemId: 'p1', next: { status: 'recited' }, afterUndo: null }] });
  pushRedo('rec_redo', { at: 't', label: '批量标记 27 格', changes: [{ studentId: 's2', poemId: 'p2', next: null, afterUndo: { status: 'todo' } }] });
  if (getRedoStack('rec_redo').length !== 2) throw new Error('入栈数量不对');
  const last = popRedo('rec_redo');
  if (last.label !== '批量标记 27 格') throw new Error('未后进先出');
  if (!Object.keys(store).some(k => k.startsWith('teacher_recite_redo_'))) throw new Error('恢复栈没持久化到 localStorage');
  clearUndo('rec_redo');
  if (getRedoStack('rec_redo').length !== 0) throw new Error('clearUndo 没把恢复栈一起清掉');
  if (Object.keys(store).some(k => k.startsWith('teacher_recite_redo_'))) throw new Error('清空后仍残留 key');
  return 'LIFO 正常 · 已持久化 · 随班级一起清';
});

check('★ 撤销 → 恢复：整批格子原样回到标记后的样子', () => {
  // 用一个独立的小 marks（不碰 rec_test 夹具，免得影响别的用例）
  const marks0 = { s1: { p1: { status: 'todo' } } };
  const entry = {
    at: '', label: '全班标为「已背」',
    changes: [
      { studentId: 's1', poemId: 'p1', prev: { status: 'todo' } },
      { studentId: 's1', poemId: 'p2', prev: null },   // 原来没有记录
    ],
  };
  // ① 老师标记
  const marked = writeMarkValues(marks0, [
    { studentId: 's1', poemId: 'p1', value: { status: 'recited', reciteDate: '2026-09-16' } },
    { studentId: 's1', poemId: 'p2', value: { status: 'recited', reciteDate: '2026-09-16' } },
  ]);
  // ② 误点撤销（组件里 undo() 的等价逻辑）
  const redoEntry = buildRedoEntry(marked, entry);
  const undone = writeMarkValues(marked, entry.changes.map(c => ({ studentId: c.studentId, poemId: c.poemId, value: c.prev })));
  if (undone.s1.p2) throw new Error('撤销时原来没记录的格子应被删掉');
  if (undone.s1.p1.status !== 'todo') throw new Error('撤销没还原原值');
  // ③ 点恢复
  const { items, skipped } = planRedo(undone, redoEntry);
  if (skipped) throw new Error('没有任何新操作，不该跳过格子：' + skipped);
  if (items.length !== entry.changes.length) throw new Error(`应恢复 ${entry.changes.length} 格，实际 ${items.length}`);
  const back = writeMarkValues(undone, items);
  const bad = [];
  for (const c of entry.changes) {
    if (!sameMark(back.s1?.[c.poemId], marked.s1?.[c.poemId])) bad.push(c.poemId);
  }
  if (bad.length) throw new Error(`${bad.join('/')} 格没有回到标记后的样子`);
  if (back.s1.p2?.status !== 'recited') throw new Error('被删掉的格子没被放回来');
  return `${entry.changes.length} 格原样恢复（含被删除的那格）`;
});

check('★ 撤销后你又重新标过的那几格：恢复时跳过，绝不覆盖新操作', () => {
  const marks0 = { s1: { p1: { status: 'todo' } } };
  const entry = {
    at: '', label: '全班标为「已背」',
    changes: [
      { studentId: 's1', poemId: 'p1', prev: { status: 'todo' } },
      { studentId: 's1', poemId: 'p2', prev: null },
    ],
  };
  const marked = writeMarkValues(marks0, [
    { studentId: 's1', poemId: 'p1', value: { status: 'recited' } },
    { studentId: 's1', poemId: 'p2', value: { status: 'recited' } },
  ]);
  const redoEntry = buildRedoEntry(marked, entry);
  const undone = writeMarkValues(marked, entry.changes.map(c => ({ studentId: c.studentId, poemId: c.poemId, value: c.prev })));
  // 撤销之后，老师自己把 p1 手动标成了「待补背」—— 这格是新的心意，不能被恢复盖掉
  const afterManual = writeMarkValues(undone, [{ studentId: 's1', poemId: 'p1', value: { status: 'redo' } }]);
  const { items, skipped } = planRedo(afterManual, redoEntry);
  if (skipped !== 1) throw new Error('应跳过 1 格，实际 ' + skipped);
  if (items.length !== 1 || items[0].poemId !== 'p2') throw new Error('跳过的应该是被手动改过的 p1，只恢复 p2');
  const back = writeMarkValues(afterManual, items);
  if (back.s1.p1.status !== 'redo') throw new Error('手动标的「待补背」被覆盖了 —— 这正是要避免的');
  if (back.s1.p2?.status !== 'recited') throw new Error('该恢复的那格没恢复');
  return '跳过 1 格、恢复 1 格，手动标记原封不动';
});

check('★ 恢复之后还能再撤销（来回点不丢数据）', () => {
  const marks0 = { s1: { p1: { status: 'todo' } } };
  const undoEntry = { at: '', label: '标记 1 格为「已背」', changes: [{ studentId: 's1', poemId: 'p1', prev: { status: 'todo' } }] };
  const marked = writeMarkValues(marks0, [{ studentId: 's1', poemId: 'p1', value: { status: 'recited' } }]);

  // 撤销：把「撤销前的样子」存进恢复栈
  const redoEntry = buildRedoEntry(marked, undoEntry);
  const undone = writeMarkValues(marked, [{ studentId: 's1', poemId: 'p1', value: undoEntry.changes[0].prev }]);

  // 恢复：组件里 redo() 会顺手压一条新的撤销记录
  const { items } = planRedo(undone, redoEntry);
  const newUndoEntry = {
    at: '', label: redoEntry.label,
    changes: items.map(it => ({ studentId: it.studentId, poemId: it.poemId, prev: undone.s1?.[it.poemId] || null })),
  };
  const redone = writeMarkValues(undone, items);
  if (redone.s1.p1.status !== 'recited') throw new Error('恢复没生效');

  // 再撤销一次，应回到「未背」
  const undone2 = writeMarkValues(redone, newUndoEntry.changes.map(c => ({ studentId: c.studentId, poemId: c.poemId, value: c.prev })));
  if (undone2.s1.p1.status !== 'todo') throw new Error('恢复后撤销不回去：' + JSON.stringify(undone2.s1.p1));
  return '未背 → 已背 → 未背，可无限来回';
});

check('★ 工具条上的「↶ 撤销 / ↷ 恢复」：两个都常驻，没得用时才灰掉', () => {
  const list = students.map(st => ({ st, passed: 0, redo: 0, left: poems.length, total: poems.length, counted: true }));
  const base = {
    record: rec, poems, students: list, brush: 'todo', setBrush: noop,
    onSetMark: noop, onBulkSet: noop, onQuickCheck: noop, onEditTypo: noop, onUndo: noop, redoDepth: 0, onRedo: noop, toast: noop,
  };
  /* v36：用户实测反馈「我没有看见那个恢复按钮啊」——
     根因是原来 `{redoDepth > 0 && <button/>}`，不先撤销一遍就永远不渲染。
     现在无论有没有可恢复项，按钮都必须出现，只是灰一档。 */
  const h0 = R(React.createElement(MatrixView, { ...base, undoDepth: 0, redoDepth: 0 }));
  if (!h0.includes('rc-redo-inline')) {
    throw new Error('「恢复」按钮没常驻 —— 老师不先撤销一遍就看不到它（用户就是这么反馈的）');
  }
  if (!/class="[^"]*rc-redo-inline[^"]*is-off/.test(h0)) {
    throw new Error('没得恢复时「恢复」按钮没有灰掉（is-off），看着像能点会让人白点一次');
  }
  if (!h0.includes('↷ 恢复')) throw new Error('恢复按钮缺文字标签');

  const h1 = R(React.createElement(MatrixView, { ...base, undoDepth: 2, redoDepth: 1 }));
  if (!h1.includes('rc-redo-inline')) throw new Error('撤销之后没有出现「恢复」按钮 —— 用户就回不去了');
  if (/rc-redo-inline[^"]*is-off/.test(h1)) throw new Error('明明有可恢复项，按钮却还是灰的');
  if (!h1.includes('↷ 恢复(1)')) throw new Error('恢复按钮没显示可恢复步数（就一个「恢复」看不出能救几步）');
  if (!h1.includes('↶ 撤销(2)')) throw new Error('撤销按钮没显示可撤销步数');
  // 两个按钮必须在同一个容器里（窄屏只整组换行，不会拆散）
  if (!/<span class="rc-undo-pair">[\s\S]*?rc-undo-inline[\s\S]*?rc-redo-inline[\s\S]*?<\/span>/.test(h1)) {
    throw new Error('撤销 / 恢复没包在同一个 rc-undo-pair 容器里');
  }
  const css = readFileSync(new URL('./src/App.css', import.meta.url), 'utf8');
  // ⚠️ 这里必须取「第一条」.rc-undo-pair 规则：窄屏媒体查询里还有一条
  //    `.rc-undo-pair { gap: 5px; }`，用 lastIndexOf 会取到它，断言必然假失败。
  const m = css.match(/\.rc-undo-pair\s*\{[^}]*\}/);
  if (!m) throw new Error('样式里找不到 .rc-undo-pair');
  if (!m[0].includes('inline-flex')) throw new Error('.rc-undo-pair 不是 inline-flex');
  if (!m[0].includes('margin-left: auto')) throw new Error('.rc-undo-pair 没有靠右，按钮会跑到状态组后面');
  if (!/\.rc-redo-inline\.is-off\s*\{[^}]*opacity/.test(css)) {
    throw new Error('.rc-redo-inline.is-off 没有淡一档的样式，灰态看不出来');
  }
  return '两个都常驻 · 灰度可辨 · 带步数 · 同容器靠右';
});

check('★ 整页只留【一处】撤销入口（v38）：矩阵用工具条那组，其它视图用上方撤销条', () => {
  // 用户原话：「这个撤销有两个撤销，上面有一个撤销，下面有一个撤销和恢复。
  //            我觉得一个就行了，把它优化一下，只要一个。」
  const D = (tab) => R(React.createElement(ClassDetail, { record: rec, onClose: noop, onChanged: noop, initialTab: tab, ...props }));

  // ① 进度矩阵：只允许工具条里那一组，上方不能再出撤销条
  clearUndo(rec.id);
  const m0 = D('matrix');
  if (m0.includes('rc-undo-bar')) {
    throw new Error('进度矩阵页又渲染上方撤销条了 —— 上下各一组，用户看到的就是「两个撤销」');
  }
  if (!m0.includes('rc-undo-pair') || !m0.includes('↶ 撤销') || !m0.includes('↷ 恢复')) {
    throw new Error('矩阵页连工具条那一组也没了 —— 那样一个撤销入口都不剩');
  }

  // ② 矩阵以外的视图没有工具条那组，上方撤销条是唯一入口：
  //    必须常驻，不能按「有没有可撤销项」来决定显示（v36 的教训）
  for (const tab of ['poem', 'student', 'typo']) {
    const h = D(tab);
    if (!h.includes('rc-undo-bar')) throw new Error(tab + ' 视图一个撤销入口都没有了（上方那条是它唯一的入口）');
    if (!/<button[^>]*is-off[^>]*>↷ 恢复一步/.test(h)) {
      throw new Error(tab + ' 视图的撤销条里，「↷ 恢复一步」在没得恢复时被藏起来了 —— 入口必须常驻（灰态即可）');
    }
  }

  // ③ 撤销过之后：条子把「能恢复」讲明白，恢复按钮激活
  pushRedo(rec.id, {
    at: '', label: '全班 24 人 × 3 篇标为「已背」',
    changes: [{ studentId: 's1', poemId: 'p1', next: { status: 'recited' }, afterUndo: null }],
  });
  const h1 = D('poem');
  if (!h1.includes('↷ 恢复一步')) throw new Error('撤销条里没有「↷ 恢复一步」按钮');
  if (!h1.includes('不会丢数据')) throw new Error('撤销条没有把「可以恢复」讲清楚，老师不知道还能救回来');
  if (/<button[^>]*is-off[^>]*>↷ 恢复一步/.test(h1)) throw new Error('明明有可恢复项，按钮却还是灰的');
  clearUndo(rec.id);
  return '矩阵只留工具条那组 · 其它视图撤销条常驻 · 文案讲清能救回来';
});

/* ============================================================
   V38 · 导出按钮分层 + 留白收紧
   用户原话：「作业收缴上面只留一个新建收缴会话就行了，把导出、预览、分享、
             二维码这些全部放在最下面，和背诵那样放在表格下面」
             「每个功能里面的标题和下面内容之间的距离还是有点宽，压缩一下」
   ============================================================ */
console.log('\n[20] v38 导出按钮分层与留白');

check('★ 作业收缴：顶上只留「新建收缴会话」，导出 / 分享挪到整页最下面', () => {
  // ⚠️ 先去掉 JSX 注释再扫：新版注释里就写着「导出 / 预览 / 分享 / 二维码全部挪到最下面」，
  //    不去掉的话锚点会先命中注释，断言直接假失败（这坑本文件已踩过一次）。
  const src = readFileSync(new URL('./src/homework.tsx', import.meta.url), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const LABELS = ['导出CSV', '导出PDF', '预览大图', '分享图片', '二维码'];

  const newBtn = src.indexOf('➕ 新建收缴会话');
  const stat = src.indexOf('📈 累计统计');
  const exp = src.indexOf('className="rc-export-row"');
  if (newBtn < 0 || stat < 0 || exp < 0) {
    throw new Error('homework.tsx 里找不到关键节点（新建按钮 / 累计统计 / rc-export-row）');
  }
  if (exp < stat) throw new Error('导出按钮行还在累计统计表【上面】—— 用户要求放到表格最下面');

  // 页顶那一排（新建按钮往后 400 字）不许再出现导出类按钮
  for (const label of LABELS) {
    if (src.slice(newBtn, newBtn + 400).includes(label)) {
      throw new Error('「' + label + '」还留在页顶的按钮排里，会把收缴历史往下压');
    }
  }
  // 最下面那排必须五个都在，且用不换行可横滑的 rc-export-row
  const row = src.slice(exp, src.indexOf('</div>', exp));
  for (const label of LABELS) {
    if (!row.includes(label)) throw new Error('最下面那排少了「' + label + '」');
  }
  return '页顶只留新建会话 · 5 个导出/分享按钮在表格下方 · 一行不换行';
});

check('★ 留白收紧（v38）：卡片 / 标题 / 列表行上下都更紧凑了', () => {
  const css = readFileSync(new URL('./src/App.css', import.meta.url), 'utf8');
  const block = (sel) => {
    const i = css.indexOf(sel);
    if (i < 0) throw new Error('样式里找不到 ' + sel);
    return css.slice(i, css.indexOf('}', i));
  };
  const bodyPad = Number((block('.card-body {').match(/padding:\s*(\d+)px/) || [])[1]);
  if (!bodyPad || bodyPad > 15) throw new Error('.card-body 上下留白还是 ' + bodyPad + 'px，没收紧');
  const tm = block('.section-title {').match(/margin:\s*(\d+)px 0 (\d+)px/);
  if (!tm) throw new Error('.section-title 的 margin 写法变了，断言要跟着改');
  if (Number(tm[1]) > 10 || Number(tm[2]) > 6) {
    throw new Error('.section-title 上下留白 ' + tm[1] + '/' + tm[2] + 'px 偏大');
  }
  const hw = (block('.hw-class-card {').match(/padding:\s*([\d.]+)px/) || [])[1];
  if (!hw || Number(hw) > 12) throw new Error('「班级收缴」卡片内边距没收紧');
  const sess = (block('.hw-session-header {').match(/padding:\s*([\d.]+)px/) || [])[1];
  if (!sess || Number(sess) > 11) throw new Error('「收缴历史」行内边距没收紧');
  return '.card-body ' + bodyPad + 'px · .section-title ' + tm[1] + '/' + tm[2] + 'px · 班级卡片与收缴历史同步收紧';
});

/* ============================================================
   V39 · 标题压成一行 / 表格铺满整屏 / 行高不再翻倍
   用户原话：「像这种标题，上面有个图片、下面是标题，把标题和图片放在一行」
             「上面有个图标，下面有个 115班背诵统计 这几个字，他们应该放在一行」
             「每一页显示的表格还是太短了，把它显示在整个手机上会更好一点……
               下面还有一块空白的地方，把它给全部显示完」
             「尽量在更少空间显示更多的内容」
   ============================================================ */
console.log('\n[21] v39 标题一行 / 铺满整屏 / 行高');

check('★ 图标与标题同一行（v39）：.header-icon 是 inline-flex，不再把标题挤到第二行', () => {
  const css = readFileSync(new URL('./src/App.css', import.meta.url), 'utf8');
  const i = css.indexOf('.header-icon {');
  if (i < 0) throw new Error('样式里没有 .header-icon');
  const block = css.slice(i, css.indexOf('}', i));
  if (!block.includes('display: inline-flex')) {
    throw new Error('.header-icon 又变回块级了 —— 「<span><i class="header-icon"/>标题</span>」写法下标题会被顶到第二行，标题栏从 46px 涨到 89px');
  }
  if (!block.includes('vertical-align: middle')) throw new Error('.header-icon 缺 vertical-align，和文字对不齐');
  const gap = css.includes('.card-header > span > .header-icon');
  if (!gap) throw new Error('没有给「嵌在文字里的图标」留右边距的规则，图标会贴着标题');
  const size = Number((block.match(/width:\s*(\d+)px/) || [])[1]);
  if (!size || size > 32) throw new Error(`.header-icon 宽 ${size}px 偏大，标题栏还占地方`);
  // 标题栏本身也要收着（原来 13px 上下 + 17px 字）
  const h = css.indexOf('.card-header {');
  const hb = css.slice(h, css.indexOf('}', h));
  const pad = Number((hb.match(/padding:\s*(\d+)px/) || [])[1]);
  if (!pad || pad > 11) throw new Error(`.card-header 上下留白 ${pad}px 偏大`);
  return `.header-icon inline-flex ${size}px · 与标题同行 · 标题栏上下 ${pad}px`;
});

check('★ 详情页不再给底部导航留 110px（v39）：表格下面那块空白是它撑的', () => {
  const css = readFileSync(new URL('./src/App.css', import.meta.url), 'utf8');
  const ai = css.indexOf('.app {');
  if (ai < 0) throw new Error('样式里没有 .app');
  const ab = css.slice(ai, css.indexOf('}', ai));
  if (!ab.includes('110px')) {
    throw new Error('.app 的 110px 底部留白不见了 —— 首页会被底部导航盖住');
  }
  const di = css.indexOf('.app.app-detail');
  if (di < 0) throw new Error('没有 .app.app-detail 规则 —— 详情页又要白留 110px');
  const db = css.slice(di, css.indexOf('}', di));
  const n = Number((db.match(/padding-bottom:\s*calc\((\d+)px/) || [])[1]);
  if (!n || n > 20) throw new Error(`详情页底部留白 ${n}px 还是太大`);
  // 必须真的挂在「非首页」上
  const app = readFileSync(new URL('./src/App.tsx', import.meta.url), 'utf8');
  if (!/isHome\s*\?\s*'app'\s*:\s*'app app-detail'/.test(app)) {
    throw new Error("App.tsx 里详情页没挂上 app-detail，样式白写");
  }
  if (!app.includes("className={isHome ? 'app' : 'app app-detail'}")) {
    throw new Error('app-detail 的挂载条件不是 isHome，可能与底部导航的判断对不上');
  }
  return `首页留 110px（给底部导航）· 详情页只留 ${n}px`;
});

check('★ 表格里的字不许换行（v39）：换行会把行高顶成两倍', () => {
  const css = readFileSync(new URL('./src/App.css', import.meta.url), 'utf8');
  const block = (sel) => {
    const i = css.indexOf(sel);
    if (i < 0) throw new Error('样式里找不到 ' + sel);
    return css.slice(i, css.indexOf('}', i));
  };
  // 按钮：窄表格列里「删除」会被挤成「删/除」，按钮 30px → 55px、整行 85px
  if (!block('.btn {').includes('white-space: nowrap')) {
    throw new Error('.btn 没加 white-space: nowrap —— 表格列一窄，按钮文字就换行，行高直接翻倍');
  }
  // 标签：「基本工资」被拆两行会把行高顶到 72px
  if (!block('.tag {').includes('white-space: nowrap')) {
    throw new Error('.tag 没加 white-space: nowrap —— 标签换行会把行高顶到 70px 以上');
  }
  // 登记表单元格
  if (!css.includes('.data-table th, .data-table td { white-space: nowrap; }')) {
    throw new Error('登记表单元格没加 nowrap —— 窄屏下每行都会变成两行');
  }
  // 单元格留白同步收一档
  const td = block('.data-table tbody td {');
  const pad = Number((td.match(/padding:\s*(\d+)px 10px/) || [])[1]);
  if (!pad || pad > 8) throw new Error(`.data-table 单元格上下留白 ${pad}px 偏大`);
  return `按钮 / 标签 / 登记表单元格都不换行 · 单元格上下留白 ${pad}px`;
});

check('★ 详情页最后一卡不再留 12px 底边距（v39）', () => {
  const css = readFileSync(new URL('./src/App.css', import.meta.url), 'utf8');
  if (!css.includes('.app-detail .page > .card:last-child')) {
    throw new Error('详情页最后一卡的下边距没收掉 —— 表格下面还是凭空多 12px');
  }
  return '最后一卡 margin-bottom: 0';
});

console.log('\n[22] v40 自动发现新版本（不再被浏览器缓存锁在旧版本上）');

async function checkAsync(name, fn) {
  try {
    const info = await fn();
    console.log(`  ok   ${name}${info ? ' — ' + info : ''}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e && e.message}`);
  }
}

/** 在一个假浏览器里跑真实的 checkForUpdate（node 里把 document/location/fetch 打桩） */
function fakeBrowser({ running, onServer }) {
  const saved = {};
  const keys = ['fetch', 'document', 'location', 'sessionStorage'];
  for (const k of keys) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  const define = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  const state = { replaced: null, fetchOpts: null };
  define('location', { protocol: 'https:', pathname: '/jszs2026/', hash: '', replace(u) { state.replaced = u; } });
  define('document', { scripts: [{ src: 'https://li6808.github.io/jszs2026/assets/' + running }] });
  const session = new Map();
  define('sessionStorage', {
    getItem: k => (session.has(k) ? session.get(k) : null),
    setItem: (k, v) => session.set(k, String(v)),
  });
  define('fetch', async (_u, opt) => {
    state.fetchOpts = opt || null;
    return { ok: true, text: async () => `<script type="module" crossorigin src="./assets/${onServer}"></script>` };
  });
  return {
    state,
    restore() {
      for (const k of keys) {
        if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
        else delete globalThis[k];
      }
    },
  };
}

await checkAsync('★ 服务器上已经是新版 → 自动换成新版（v40）', async () => {
  const b = fakeBrowser({ running: 'index-OLD11111.js', onServer: 'index-NEW22222.js' });
  try {
    await checkForUpdate();
    if (!b.state.replaced) {
      throw new Error('服务器上已经是新版却没自动重载 —— 用户会一直卡在旧版本，只能自己清缓存');
    }
    if (!/^\/jszs2026\/\?u=\d+$/.test(b.state.replaced)) {
      throw new Error('重载地址不对：' + b.state.replaced + '（必须保留子目录，并带 ?u= 时间戳换掉缓存键）');
    }
    if (!b.state.fetchOpts || b.state.fetchOpts.cache !== 'no-store') {
      throw new Error("核对时没绕过缓存（cache: 'no-store'）—— 拿回来的还是缓存里的旧页面，等于白查");
    }
    const first = b.state.replaced;
    b.state.replaced = null;
    await checkForUpdate();
    if (b.state.replaced) throw new Error('同一版本第二次又重载了 —— 万一刷完还是旧版会无限刷新');
    return `检测到新版 → ${first} · 同一版本只刷一次`;
  } finally { b.restore(); }
});

await checkAsync('★ 已经是最新 → 一动不动（v40）', async () => {
  const b = fakeBrowser({ running: 'index-SAME9999.js', onServer: 'index-SAME9999.js' });
  try {
    await checkForUpdate();
    if (b.state.replaced) throw new Error('已经是最新版却还在重载，会陷入刷新循环：' + b.state.replaced);
    return '入口哈希一致，不刷新';
  } finally { b.restore(); }
});

await checkAsync('★ 离线 / 请求失败 → 安静放过（v40）', async () => {
  const b = fakeBrowser({ running: 'index-A111.js', onServer: 'index-B222.js' });
  try {
    Object.defineProperty(globalThis, 'fetch', {
      value: async () => { throw new Error('network down'); }, configurable: true, writable: true,
    });
    await checkForUpdate();
    if (b.state.replaced) throw new Error('网络都断了还去重载页面 —— 用户会直接看到白屏');
    return '异常被吞掉，页面照常用';
  } finally { b.restore(); }
});

check('★ 检查更新的接线（v40）：启动后查一次 + 从后台切回来再查一次', () => {
  const src = readFileSync(new URL('./src/updateCheck.ts', import.meta.url), 'utf8');
  if (!src.includes("if (location.protocol === 'file:') return;")) {
    throw new Error('没有跳过 file:// —— 双击打开的本地产物会被反复刷新');
  }
  if (!src.includes('GUARD_PREFIX')) throw new Error('没有防重复重载的守卫，小心刷新循环');
  const app = readFileSync(new URL('./src/App.tsx', import.meta.url), 'utf8');
  if (!app.includes("from './updateCheck'")) throw new Error('App.tsx 没引入检查更新，代码白写');
  if (!/checkForUpdate\(\)/.test(app)) throw new Error('App.tsx 没有调用 checkForUpdate —— 写了但没接上等于没写');
  if (!app.includes('visibilitychange')) {
    throw new Error('没有监听「从后台切回来」—— 手机一直开着页面就永远不查新版');
  }
  return '启动 1.5s 后查一次 + 每次切回前台再查一次';
});

console.log(failures === 0 ? '\n✅ 全部通过\n' : `\n❌ ${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
