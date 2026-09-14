import qrcode from './vendor/qrcode.js';

/**
 * 在本地生成二维码的 data URL。
 *
 * 原先这里请求 api.qrserver.com 的在线接口 —— 离线、对方服务异常或网络受限时
 * 二维码直接显示不出来，而且等于把本应用的访问地址发给了第三方服务器。
 * 改成纯前端生成后，断网也能正常扫码。
 *
 * @param text 要编码的内容（通常是分享链接）
 * @param cellSize 每个码元的像素尺寸，越大越清晰
 * @returns data URL；内容为空或生成失败时返回空字符串
 */
export function makeQrDataUrl(text: string, cellSize = 6): string {
  if (!text) return '';
  try {
    // typeNumber 传 0 表示按内容长度自动选择二维码版本
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createDataURL(cellSize);
  } catch {
    return '';
  }
}
