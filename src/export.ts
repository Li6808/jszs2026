// 导出工具函数 - 纯原生实现

// 导出CSV（可用Excel打开）
export function exportCSV(filename: string, headers: string[], rows: string[][]) {
  const escape = (val: string) => {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      return '"' + val.replace(/"/g, '""') + '"';
    }
    return val;
  };
  const lines = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))];
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

// 导出为可打印HTML（在新窗口打开，用户可打印为PDF）
export function exportPrintableHTML(title: string, tableHTML: string) {
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
body { font-family: "Microsoft YaHei", sans-serif; padding: 40px; max-width: 900px; margin: 0 auto; }
h2 { text-align: center; color: #c41e3a; border-bottom: 2px solid #c41e3a; padding-bottom: 10px; }
.meta { text-align: center; color: #999; font-size: 13px; margin-bottom: 20px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 16px; }
th { background: #fde8eb; color: #c41e3a; padding: 10px 8px; text-align: left; font-weight: 600; border: 1px solid #e0e0e0; }
td { padding: 10px 8px; border: 1px solid #e0e0e0; }
tr:nth-child(even) { background: #fafafa; }
.total { margin-top: 16px; font-size: 16px; font-weight: 600; color: #c41e3a; }
.back-btn { position: fixed; top: 20px; left: 20px; padding: 10px 20px; background: #c62828; color: #fff; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; z-index: 1000; box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
@media print { body { padding: 20px; } .no-print, .back-btn { display: none !important; } }
</style></head><body>
<button class="back-btn" onclick="window.close()">← 返回</button>
<h2>${title}</h2>
<div class="meta">导出时间：${new Date().toLocaleString()}</div>
${tableHTML}
<div class="no-print" style="margin-top:30px;text-align:center;">
<button onclick="window.print()" style="padding:12px 30px;font-size:16px;background:#c41e3a;color:white;border:none;border-radius:8px;cursor:pointer;">🖨️ 打印 / 另存为PDF</button>
<p style="color:#999;font-size:13px;">提示：点击打印后，目标选择"另存为PDF"即可导出</p>
</div>
</body></html>`);
  win.document.close();
}

// 导出工资统计为CSV
export function exportSalaryCSV(records: Array<{ date: string; description: string; category: string; amount: number }>) {
  const headers = ['日期', '描述', '类别', '金额'];
  const rows = records.map(r => [r.date, r.description || '-', r.category, r.amount.toFixed(2)]);
  const total = records.reduce((s, r) => s + r.amount, 0);
  rows.push(['', '', '合计', total.toFixed(2)]);
  exportCSV('工资统计', headers, rows);
}

// 导出值班统计为CSV
export function exportDutyCSV(records: Array<{ date: string; description?: string; type: string }>) {
  const headers = ['序号', '日期', '类型', '备注'];
  const rows = records.map((r, i) => [String(i + 1), r.date, r.type, r.description || '-']);
  exportCSV('值班统计', headers, rows);
}

// 导出代课统计为CSV
export function exportSubCSV(records: Array<{ date: string; substituteFor?: string; period?: string; classSubject?: string; description?: string }>) {
  const headers = ['序号', '日期', '替谁代课', '节次', '班级科目', '备注'];
  const rows = records.map((r, i) => [String(i + 1), r.date, r.substituteFor || '-', r.period || '-', r.classSubject || '-', r.description || '-']);
  exportCSV('代课统计', headers, rows);
}

// 工资统计打印HTML
export function exportSalaryHTML(records: Array<{ date: string; description: string; category: string; amount: number }>) {
  const total = records.reduce((s, r) => s + r.amount, 0);
  const byCat: Record<string, number> = {};
  for (const r of records) byCat[r.category] = (byCat[r.category] || 0) + r.amount;

  let html = '<table><thead><tr><th>日期</th><th>描述</th><th>类别</th><th>金额（元）</th></tr></thead><tbody>';
  for (const r of records) {
    html += `<tr><td>${r.date}</td><td>${r.description || '-'}</td><td>${r.category}</td><td style="color:#07c160;font-weight:600;">+${r.amount.toFixed(2)}</td></tr>`;
  }
  html += '</tbody></table>';
  html += '<div class="total">💰 总收入：' + total.toFixed(2) + ' 元</div>';
  html += '<h3 style="margin-top:24px;color:#666;">按类别汇总</h3><table><thead><tr><th>类别</th><th>金额（元）</th></tr></thead><tbody>';
  for (const [cat, amt] of Object.entries(byCat)) {
    html += `<tr><td>${cat}</td><td style="color:#07c160;font-weight:600;">${amt.toFixed(2)}</td></tr>`;
  }
  html += '</tbody></table>';
  exportPrintableHTML('工资统计报表', html);
}

// 值班统计打印HTML
export function exportDutyHTML(records: Array<{ date: string; description?: string; type: string }>) {
  let html = '<table><thead><tr><th>序号</th><th>日期</th><th>类型</th><th>备注</th></tr></thead><tbody>';
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    html += `<tr><td>${i + 1}</td><td>${r.date}</td><td>${r.type}</td><td>${r.description || '-'}</td></tr>`;
  }
  html += '</tbody></table>';
  html += '<div class="total">📅 共 ' + records.length + ' 条记录</div>';
  exportPrintableHTML('值班统计报表', html);
}

// 代课统计打印HTML
export function exportSubHTML(records: Array<{ date: string; substituteFor?: string; period?: string; classSubject?: string; description?: string }>) {
  let html = '<table><thead><tr><th>序号</th><th>日期</th><th>替谁代课</th><th>节次</th><th>班级科目</th><th>备注</th></tr></thead><tbody>';
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    html += `<tr><td>${i + 1}</td><td>${r.date}</td><td>${r.substituteFor || '-'}</td><td>${r.period || '-'}</td><td>${r.classSubject || '-'}</td><td>${r.description || '-'}</td></tr>`;
  }
  html += '</tbody></table>';
  html += '<div class="total">📊 共 ' + records.length + ' 条代课记录</div>';
  exportPrintableHTML('代课统计报表', html);
}
