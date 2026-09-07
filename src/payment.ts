// 支付截图模块的辅助函数

export interface TimeEntry {
  id: string;
  date: string;
  timeSlot: '早上' | '中午' | '晚上';
  finalTime: string;
  editedSrc: string;
}

export function generateDoubaoPrompt(entries: TimeEntry[]): string {
  const timeList = entries.map((e, i) => {
    const timeStr = e.finalTime.trim() || autoGenerateTime(e.date, e.timeSlot);
    return `第${i + 1}张：${timeStr}（${e.timeSlot}）`;
  }).join('\n');

  return `你是一个专业的图片编辑助手。请帮我修改以下微信零钱明细截图中的支付时间/转账时间，其他所有内容保持不变。

【修改要求】
1. 只修改"支付时间"或"转账时间"后面的时间值，其他文字、图标、布局完全不动
2. 修改后的字体、大小、颜色、位置要和原图完全一致，看不出来修改过
3. 时间格式保持：XXXX年X月X日 XX:XX:XX
4. 如果原图有"转账时间"标签，就修改转账时间；如果是"支付时间"标签，就修改支付时间

【每张截图要修改的时间】
${timeList}

【输出要求】
- 直接输出修改后的图片
- 保持原图的分辨率和清晰度
- 不要添加任何水印、标记、边框或其他装饰`;
}

function autoGenerateTime(date: string, slot: '早上' | '中午' | '晚上'): string {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  let hour: number;
  if (slot === '早上') hour = 7 + Math.floor(Math.random() * 2);
  else if (slot === '中午') hour = 12 + Math.floor(Math.random() * 2);
  else hour = 17 + Math.floor(Math.random() * 2);
  const minute = Math.floor(Math.random() * 60).toString().padStart(2, '0');
  const second = Math.floor(Math.random() * 60).toString().padStart(2, '0');
  return `${year}年${month}月${day}日 ${hour.toString().padStart(2, '0')}:${minute}:${second}`;
}

// 裁剪图片底部（去除水印）
export function cropImageBottom(src: string, cropPercent: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const newH = img.height * (1 - cropPercent / 100);
      canvas.width = img.width;
      canvas.height = newH;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, img.width, newH, 0, 0, img.width, newH);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = src;
  });
}

// 纯图A4排版（无标题无页码）
export async function drawA4PurePage(
  canvas: HTMLCanvasElement,
  images: string[],
  colsPerRow: number,
  rowsPerPage: number,
  pageNum: number,
  _totalPages: number,
): Promise<void> {
  const A4_W = 1240;
  const A4_H = 1754;
  const MARGIN = 40;

  canvas.width = A4_W;
  canvas.height = A4_H;
  const ctx = canvas.getContext('2d')!;

  // 白色背景
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, A4_W, A4_H);

  const usableW = A4_W - MARGIN * 2;
  const usableH = A4_H - MARGIN * 2;
  const gap = 20;
  const cellW = (usableW - (colsPerRow - 1) * gap) / colsPerRow;
  const cellH = (usableH - (rowsPerPage - 1) * gap) / rowsPerPage;

  const startIdx = (pageNum - 1) * colsPerRow * rowsPerPage;
  const pageImages = images.slice(startIdx, startIdx + colsPerRow * rowsPerPage);

  for (let idx = 0; idx < pageImages.length; idx++) {
    const row = Math.floor(idx / colsPerRow);
    const col = idx % colsPerRow;
    const x = MARGIN + col * (cellW + gap);
    const y = MARGIN + row * (cellH + gap);
    try {
      await drawImageContain(ctx, pageImages[idx], x, y, cellW, cellH);
    } catch {
      // 占位
      ctx.fillStyle = '#f5f5f5';
      ctx.fillRect(x, y, cellW, cellH);
    }
  }
}

function drawImageContain(ctx: CanvasRenderingContext2D, src: string, x: number, y: number, w: number, h: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const imgRatio = img.width / img.height;
      const cellRatio = w / h;
      let dw: number, dh: number, dx: number, dy: number;
      if (imgRatio > cellRatio) {
        dw = w; dh = w / imgRatio; dx = x; dy = y + (h - dh) / 2;
      } else {
        dh = h; dw = h * imgRatio; dx = x + (w - dw) / 2; dy = y;
      }
      ctx.drawImage(img, dx, dy, dw, dh);
      resolve();
    };
    img.onerror = reject;
    img.src = src;
  });
}

// 导出多页A4为图片（纯图模式 - 无标题无页码）
export async function exportA4PureImages(
  images: string[],
  colsPerRow: number,
  rowsPerPage: number,
): Promise<string[]> {
  const perPage = colsPerRow * rowsPerPage;
  const totalPages = Math.ceil(images.length / perPage);
  const results: string[] = [];
  const canvas = document.createElement('canvas');
  for (let p = 1; p <= totalPages; p++) {
    await drawA4PurePage(canvas, images, colsPerRow, rowsPerPage, p, totalPages);
    results.push(canvas.toDataURL('image/png'));
  }
  return results;
}

// 打开打印窗口导出PDF
export function openPrintWindow(images: string[], colsPerRow: number, rowsPerPage: number) {
  const perPage = colsPerRow * rowsPerPage;
  const totalPages = Math.ceil(images.length / perPage);
  const win = window.open('', '_blank');
  if (!win) return;

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>差旅支付截图</title><style>
  body { margin: 0; background: #f5f5f5; font-family: sans-serif; }
  .page { width: 210mm; height: 297mm; margin: 10px auto; background: white; display: grid; padding: 15mm; box-sizing: border-box; }
  .page img { width: 100%; height: 100%; object-fit: contain; }
  .back-btn { position: fixed; top: 20px; left: 20px; padding: 10px 20px; background: #c62828; color: #fff; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; z-index: 1000; box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
  @media print { body { background: white; margin: 0; } .page { margin: 0; page-break-after: always; height: 100vh; } .no-print, .back-btn { display: none !important; } }
  </style></head><body><button class="back-btn" onclick="window.close()">← 返回</button>`;

  for (let p = 0; p < totalPages; p++) {
    const startIdx = p * perPage;
    const pageImages = images.slice(startIdx, startIdx + perPage);
    html += `<div class="page" style="grid-template-columns: repeat(${colsPerRow}, 1fr); grid-template-rows: repeat(${rowsPerPage}, 1fr); gap: 8mm;">`;
    for (const src of pageImages) {
      html += `<img src="${src}" />`;
    }
    // 填充空白格子
    const emptySlots = perPage - pageImages.length;
    for (let e = 0; e < emptySlots; e++) html += `<div></div>`;
    html += `</div>`;
  }

  html += `<div class="no-print" style="text-align:center;padding:20px;">
    <button onclick="window.print()" style="padding:12px 30px;font-size:16px;background:#c41e3a;color:white;border:none;border-radius:8px;cursor:pointer;">🖨️ 打印 / 另存为PDF</button>
    <p style="color:#999;font-size:13px;">提示：点击打印后，目标选择"另存为PDF"</p>
  </div></body></html>`;

  win.document.write(html);
  win.document.close();
}
