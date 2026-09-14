/**
 * qrcode-generator (MIT, Kazuhiko Arase) 的最小类型声明。
 * 只声明本项目实际用到的接口。
 */
export interface QrCodeInstance {
  addData(data: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
  /** 生成 GIF 格式的 data URL；margin 省略时默认 cellSize * 4 */
  createDataURL(cellSize?: number, margin?: number): string;
  createSvgTag(cellSize?: number, margin?: number): string;
}

declare function qrcode(
  typeNumber: number,
  errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H',
): QrCodeInstance;

export default qrcode;
