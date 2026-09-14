/* 一次性体检脚本：测数据体量、写回耗时、渲染耗时（不参与构建） */
const store = {};
let writeCount = 0;
let writeBytes = 0;
globalThis.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => {
    const s = String(v);
    writeCount++;
    writeBytes += s.length;
    if (s.length > QUOTA) {
      const e = new Error('QuotaExceededError');
      e.name = 'QuotaExceededError';
      throw e;
    }
    store[k] = s;
  },
  removeItem: k => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
};
// 模拟 Safari/移动端收紧后的配额（5MB 字符）
const QUOTA = 5 * 1024 * 1024;

const { setData, getData, buildPoemsFromPreset } = await import('./src/storage.ts');
const { PRESET_VOLUMES } = await import('./src/reciteData.ts');

const allPoems = [];
let order = 0;
for (const v of PRESET_VOLUMES) {
  const built = buildPoemsFromPreset(v.poems, v.name, order);
  order += built.length;
  allPoems.push(...built);
}

function makeRecord(idx, studentCount, poems) {
  const students = Array.from({ length: studentCount }, (_, i) => ({
    id: `stu_${idx}_${i}`, no: i + 1, name: `学生姓名${i + 1}`, gender: i % 2 ? '女' : '男', className: `${idx}班`,
  }));
  const marks = {};
  for (const st of students) {
    marks[st.id] = {};
    for (const p of poems) {
      marks[st.id][p.id] = { status: 'recited', checkedAt: '2026-09-14', reciteDate: '2026-09-14' };
    }
  }
  return {
    id: `rec_${idx}`, classFullName: `初二(${idx})班`, classShortName: `${idx}班`, grade: '初二',
    poems, students, marks, createdAt: '2026-09-01', updatedAt: '2026-09-14',
  };
}

const scenario = (label, classCount, studentCount, poemCount) => {
  const poems = allPoems.slice(0, poemCount);
  const records = Array.from({ length: classCount }, (_, i) => makeRecord(i + 1, studentCount, poems));
  const data = { settings: null, history: [], salaries: [], duties: [], homeworkRecords: [], reciteRecords: records };

  const json = JSON.stringify(data);
  const kb = json.length / 1024;

  // 清空后真实写入一次，看是否超配额
  for (const k of Object.keys(store)) delete store[k];
  let quotaError = null;
  const t0 = performance.now();
  try { setData(data); } catch (e) { quotaError = e.name; }
  const t1 = performance.now();

  // 再测连续 5 次写回（模拟连点格子），取单次均值
  const t2 = performance.now();
  let n = 0;
  for (let i = 0; i < 5; i++) {
    try { setData(data); n++; } catch { /* ignore */ }
  }
  const t3 = performance.now();
  const perWrite = n ? (t3 - t2) / n : NaN;

  const cells = classCount * studentCount * poemCount;
  console.log(
    `${label}\n` +
    `  班级 ${classCount} · 每班 ${studentCount} 人 · 每班 ${poemCount} 篇 = ${cells.toLocaleString()} 格\n` +
    `  JSON 体积 : ${kb.toFixed(0)} KB (${(kb / 1024).toFixed(2)} MB)${quotaError ? '  ❌ 超配额 ' + quotaError : '  ✅ 未超 5MB'}\n` +
    `  首次写回  : ${(t1 - t0).toFixed(1)} ms\n` +
    `  连续写回  : 单次 ${perWrite.toFixed(1)} ms\n`,
  );
  return kb;
};

console.log('=== 数据体量与写回性能 ===\n');
scenario('【场景 A】单班 45 人 · 一学期 45 篇（八年级上下册）', 1, 45, 45);
scenario('【场景 B】4 个班 × 45 人 · 45 篇', 4, 45, 45);
scenario('【场景 C】4 个班 × 45 人 · 整册 126 篇（初中三年全背）', 4, 45, 126);
scenario('【场景 D】6 个班 × 50 人 · 整册 187 篇（极端）', 6, 50, 187);

/* ---- 渲染耗时 ---- */
console.log('=== 进度矩阵渲染耗时（react-dom/server 真实渲染）===');
const React = await import('react');
const { renderToString } = await import('react-dom/server');
const { ClassDetail } = await import('./src/recite.tsx');

for (const [sc, students, poems] of [['45 人 × 45 篇', 45, 45], ['45 人 × 126 篇', 45, 126]]) {
  const poemsArr = allPoems.slice(0, poems);
  const rec = makeRecord(1, students, poemsArr);
  const t0 = performance.now();
  const html = renderToString(React.createElement(ClassDetail, {
    record: rec, onClose: () => {}, onChanged: () => {}, toast: () => {}, openQr: () => {},
  }));
  const t1 = performance.now();
  const cellCount = (html.match(/rc-cell/g) || []).length;
  console.log(`${sc}: 首次渲染 ${(t1 - t0).toFixed(0)} ms · ${(html.length / 1024).toFixed(0)} KB HTML · ${cellCount} 个格子`);
}
