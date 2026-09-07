import { wday } from './utils';
import type { SubRow } from './types';

interface LeaveData {
  name: string;
  reason: string;
  type: string;
  days: number;
  start: Date;
  end: Date;
  sp: string;
  ep: string;
  sw: number;
  ew: number;
  subs: SubRow[];
  schoolName: string;
  semesterText: string;
}

interface TextFrag {
  text: string;
  ul?: boolean;
  ulW?: number; // 下划线固定宽度
  nowrap?: boolean;
}

interface Line {
  frags: Array<{ frag: TextFrag; x: number }>;
  y: number;
}

function measure(ctx: CanvasRenderingContext2D, text: string): number {
  return ctx.measureText(text).width;
}

function layoutLines(
  ctx: CanvasRenderingContext2D,
  frags: TextFrag[],
  startX: number,
  lm: number,
  rm: number,
  lineH: number,
  startY: number
): Line[] {
  const lines: Line[] = [];
  let cy = startY;
  let cx = startX;
  let currentFrags: Array<{ frag: TextFrag; x: number }> = [];

  for (const frag of frags) {
    const fragW = frag.ulW ? Math.max(measure(ctx, frag.text), frag.ulW) : measure(ctx, frag.text);

    if (frag.nowrap && cx + fragW > rm && cx > startX + 2) {
      if (currentFrags.length > 0) {
        lines.push({ frags: currentFrags, y: cy });
        currentFrags = [];
      }
      cy += lineH;
      cx = lm;
    }

    if (frag.nowrap) {
      currentFrags.push({ frag, x: cx });
      cx += fragW;
      continue;
    }

    const chars = frag.text.split('');
    let lineText = '';

    for (let i = 0; i < chars.length; i++) {
      const test = lineText + chars[i];
      const testW = measure(ctx, test);
      const totalW = cx + testW;

      if (totalW > rm && lineText.length > 0) {
        currentFrags.push({ frag: { ...frag, text: lineText }, x: cx });
        lines.push({ frags: currentFrags, y: cy });
        cy += lineH;
        cx = lm;
        currentFrags = [];
        lineText = chars[i];
      } else {
        lineText = test;
      }
    }

    if (lineText.length > 0) {
      currentFrags.push({ frag: { ...frag, text: lineText }, x: cx });
      // 下划线用 ulW 占宽，否则用文本宽度
      cx += frag.ulW ? frag.ulW : measure(ctx, lineText);
    }
  }

  if (currentFrags.length > 0) {
    lines.push({ frags: currentFrags, y: cy });
  }

  return lines;
}

function drawLines(ctx: CanvasRenderingContext2D, lines: Line[], lineH: number): number {
  for (const line of lines) {
    for (const item of line.frags) {
      const ly = line.y;
      if (item.frag.ul && item.frag.ulW) {
        // 用 textAlign=center 确保文字绝对居中在下划线中间
        const centerX = item.x + item.frag.ulW / 2;
        const savedAlign = ctx.textAlign;
        ctx.textAlign = 'center';
        ctx.fillText(item.frag.text, centerX, ly);
        ctx.textAlign = savedAlign;
        ctx.beginPath();
        ctx.moveTo(item.x, ly + 4);
        ctx.lineTo(item.x + item.frag.ulW, ly + 4);
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        const tw = measure(ctx, item.frag.text);
        ctx.fillText(item.frag.text, item.x, ly);
        if (item.frag.ul) {
          ctx.beginPath();
          ctx.moveTo(item.x, ly + 4);
          ctx.lineTo(item.x + tw, ly + 4);
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }
  }
  return lines.length > 0 ? lines[lines.length - 1].y + lineH : 0;
}

// ========== A4版 1400px ==========
export function drawLeaveCanvasA4(canvas: HTMLCanvasElement, d: LeaveData) {
  const W = 1400;
  const lm = 100;
  const rm = W - 100;
  const fontSize = 32;
  const titleSize = 48;
  const semesterSize = 28;
  const lineH = 58;

  const sm = d.start.getMonth() + 1;
  const sdt = d.start.getDate();
  const em = d.end.getMonth() + 1;
  const edt = d.end.getDate();
  const daysStr = d.days % 1 === 0 ? String(d.days) : d.days.toFixed(1);
  const year = d.start.getFullYear();

  const types = ['公假', '事假', '病假', '婚假', '丧假', '产假', '护理假'];
  let typeStr = '';
  for (let i = 0; i < types.length; i++) {
    const mark = types[i] === d.type ? '☑' : '□';
    typeStr += mark + types[i];
    if (i < types.length - 1) typeStr += '、';
  }

  // ===== 预计算 =====
  const tempC = document.createElement('canvas');
  tempC.width = W; tempC.height = 100;
  const tctx = tempC.getContext('2d')!;
  tctx.font = `${fontSize}px "Microsoft YaHei", "SimSun", sans-serif`;

  const indent = 64;
  const bx = lm + indent;

  // 正文frags（下划线加宽，内容居中）
  const bodyFrags: TextFrag[] = [
    { text: '本人确因 ' },
    { text: d.reason, ul: true, ulW: Math.max(measure(tctx, d.reason) + 40, 200) },
    { text: ' ，特请（' + typeStr + '）假 ' },
    { text: daysStr, ul: true, ulW: Math.max(measure(tctx, daysStr) + 30, 60) },
    { text: ' 天。' },
  ];

  const bodyLines = layoutLines(tctx, bodyFrags, bx, lm, rm, lineH, 0);

  // 时间frags（首行缩进，所有填值都带下划线）
  const timeFrags: TextFrag[] = [
    { text: '请假 ' },
    { text: String(sm), ul: true, ulW: measure(tctx, String(sm)) + 40 },
    { text: ' 月 ' },
    { text: String(sdt), ul: true, ulW: measure(tctx, String(sdt)) + 40 },
    { text: ' 日 ' },
    { text: d.sp, ul: true, ulW: measure(tctx, d.sp) + 40 },
    { text: `（第${d.sw}周星期${wday(d.start)}）`, nowrap: true },
    { text: ' 至 ' },
    { text: String(em), ul: true, ulW: measure(tctx, String(em)) + 40 },
    { text: ' 月 ' },
    { text: String(edt), ul: true, ulW: measure(tctx, String(edt)) + 40 },
    { text: ' 日 ' },
    { text: d.ep, ul: true, ulW: measure(tctx, d.ep) + 40 },
    { text: `（第${d.ew}周星期${wday(d.end)}）`, nowrap: true },
    { text: '止。望准假！' },
  ];

  const timeLines = layoutLines(tctx, timeFrags, bx, lm, rm, lineH, 0);

  // 提示
  const hint = '（住院病必须提供住院相关依据，请假人自己安排好班级代课老师，出现缺代记请假人的旷课。）';
  tctx.font = `24px "Microsoft YaHei", "SimSun", sans-serif`;
  const hintLines = layoutLines(tctx, [{ text: hint }], bx, lm, rm, lineH, 0);

  // 计算高度（A4比例 1979px）
  const A4H = Math.round(W * 1.414); // 1979
  let contentH = 0;
  contentH += 130; // 顶部留白
  contentH += titleSize + 16; // 标题
  contentH += semesterSize + 24; // 学期
  contentH += fontSize + 20; // 学校领导
  contentH += bodyLines.length * lineH + 16; // 正文
  contentH += timeLines.length * lineH + 16; // 时间行
  contentH += hintLines.length * lineH + 28; // 提示
  contentH += fontSize + 24; // 教务处签字
  contentH += fontSize + 24; // 请假人
  contentH += fontSize + 16; // 代课表标题
  contentH += 56; // 表头
  contentH += Math.max(d.subs.length, 1) * 56; // 表体
  contentH += 80; // 底部留白

  // 如果内容超过A4高度，用内容高度；否则用A4高度（留白在底部）
  const H = Math.max(A4H, contentH);

  // ===== 绘制 =====
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  let y = 130;

  // 标题
  ctx.font = `bold ${titleSize}px "SimHei", "Microsoft YaHei", sans-serif`;
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.fillText(d.schoolName + '请假条', W / 2, y);
  y += titleSize + 16;

  // 学期
  ctx.font = `${semesterSize}px "SimSun", "Songti SC", serif`;
  ctx.fillText(d.semesterText, W / 2, y);
  y += semesterSize + 24;

  // 学校领导
  ctx.textAlign = 'left';
  ctx.font = `${fontSize}px "Microsoft YaHei", "SimSun", sans-serif`;
  ctx.fillText('学校领导：', lm, y);
  y += fontSize + 20;

  // 正文（首行缩进）
  const bodyLines2 = layoutLines(ctx, bodyFrags, bx, lm, rm, lineH, y);
  y = drawLines(ctx, bodyLines2, lineH);
  y += 16;

  // 时间行（首行缩进）
  const timeLines2 = layoutLines(ctx, timeFrags, bx, lm, rm, lineH, y);
  y = drawLines(ctx, timeLines2, lineH);
  y += 16;

  // 提示
  ctx.font = `24px "Microsoft YaHei", "SimSun", sans-serif`;
  ctx.fillStyle = '#333';
  const hintLines2 = layoutLines(ctx, [{ text: hint }], bx, lm, rm, lineH, y);
  y = drawLines(ctx, hintLines2, lineH);
  y += 28;

  // 教务处签字（长横线）
  ctx.fillStyle = '#000';
  ctx.font = `${fontSize}px "Microsoft YaHei", "SimSun", sans-serif`;
  ctx.fillText('教务处签字：', lm, y);
  const signX = lm + ctx.measureText('教务处签字：').width + 10;
  ctx.beginPath();
  ctx.moveTo(signX, y + 4);
  ctx.lineTo(signX + 260, y + 4);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  y += fontSize + 24;

  // 请假人（所有值都带下划线，居中）
  ctx.fillText('请假人：', lm, y);
  let nx = lm + ctx.measureText('请假人：').width + 10;
  // 姓名
  const nameW = Math.max(measure(ctx, d.name) + 40, 120);
  ctx.fillText(d.name, nx + (nameW - measure(ctx, d.name)) / 2, y);
  ctx.beginPath(); ctx.moveTo(nx, y + 4); ctx.lineTo(nx + nameW, y + 4); ctx.stroke();
  nx += nameW + 60;
  // 年
  ctx.fillText(`${year} 年 `, nx, y);
  nx += ctx.measureText(`${year} 年 `).width;
  // 月
  const mW = measure(ctx, String(sm)) + 24;
  ctx.fillText(String(sm), nx + (mW - measure(ctx, String(sm))) / 2, y);
  ctx.beginPath(); ctx.moveTo(nx, y + 4); ctx.lineTo(nx + mW, y + 4); ctx.stroke();
  nx += mW;
  ctx.fillText(' 月 ', nx, y);
  nx += ctx.measureText(' 月 ').width;
  // 日
  const dW = measure(ctx, String(sdt)) + 24;
  ctx.fillText(String(sdt), nx + (dW - measure(ctx, String(sdt))) / 2, y);
  ctx.beginPath(); ctx.moveTo(nx, y + 4); ctx.lineTo(nx + dW, y + 4); ctx.stroke();
  nx += dW;
  ctx.fillText(' 日', nx, y);
  y += fontSize + 24;

  // 代课表
  ctx.fillText('请假人代课人员安排表：第 ' + d.sw + ' 周', lm, y);
  y += fontSize + 16;

  const cw = [170, 170, 380, 380];
  const tw2 = cw.reduce((a, b) => a + b, 0);
  const tableX = (W - tw2) / 2;
  const rh2 = 56;

  ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;

  const headers = ['星期', '节次', '班级科目', '代课教师'];
  ctx.font = `bold 26px "Microsoft YaHei", "SimSun", sans-serif`;
  let hx = tableX;
  for (let i = 0; i < headers.length; i++) {
    ctx.strokeRect(hx, y, cw[i], rh2);
    ctx.textAlign = 'center';
    ctx.fillText(headers[i], hx + cw[i] / 2, y + rh2 / 2 + 9);
    hx += cw[i];
  }

  ctx.font = `26px "Microsoft YaHei", "SimSun", sans-serif`;
  let ry = y + rh2;
  if (d.subs.length === 0) {
    for (let i = 0; i < 2; i++) {
      let cx2 = tableX;
      for (let j = 0; j < cw.length; j++) { ctx.strokeRect(cx2, ry, cw[j], rh2); cx2 += cw[j]; }
      ry += rh2;
    }
  } else {
    for (const sub of d.subs) {
      let cx2 = tableX;
      const cells = [sub.day, sub.period, sub.classSubject || '', sub.teacher || ''];
      for (let j = 0; j < cells.length; j++) {
        ctx.strokeRect(cx2, ry, cw[j], rh2);
        ctx.textAlign = 'center';
        ctx.fillText(cells[j], cx2 + cw[j] / 2, ry + rh2 / 2 + 9);
        cx2 += cw[j];
      }
      ry += rh2;
    }
  }
}

export function drawLeaveCanvas(canvas: HTMLCanvasElement, d: LeaveData) {
  drawLeaveCanvasA4(canvas, d);
}
