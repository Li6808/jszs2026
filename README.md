# 教师个人助手

一个专为教师设计的个人工作助手 Web 应用，支持 PWA（可安装到手机桌面离线使用）。

## 功能模块

| 模块 | 功能 |
|------|------|
| **请假条** | 生成标准格式请假条图片，支持代课安排表，可导出 PDF |
| **我的课表** | 查看个人课表（表格/图片双模式），支持学校作息时间表 |
| **工资统计** | 收入记录、分类统计、图表展示，可导出 CSV/PDF |
| **值班统计** | 值班记录与统计，可导出 CSV/PDF |
| **代课统计** | 替别人代课记录，可导出 CSV/PDF |
| **支付截图** | 差旅报销助手，豆包 P 图后的排版导出 |
| **个人设置** | 课表、学校信息、模块排序、PWA 安装引导 |

## 技术栈

- React 18 + TypeScript
- Vite
- Tailwind CSS
- PWA（Service Worker + Manifest）
- Canvas 2D API（请假条/课表图片生成）

## 安装到手机桌面

### iPhone (Safari)
1. 用 Safari 打开网页
2. 点击底部分享按钮
3. 选择「添加到主屏幕」

### 安卓 (Chrome)
1. 用 Chrome 打开网页
2. 点击右上角菜单
3. 选择「添加到主屏幕」或「安装应用」

安装后可离线使用，像原生 App 一样全屏打开。

## 开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build

# 预览构建结果
npm run preview
```

## GitHub Pages 部署

1. 将代码推送到 GitHub 仓库
2. 打开仓库 Settings -> Pages
3. Source 选择 "Deploy from a branch"
4. Branch 选择 "main"，文件夹选择 "/ (root)"
5. 等待 1-2 分钟后即可访问

## 数据存储

所有数据保存在浏览器本地（localStorage），不会上传到任何服务器。清除浏览器数据会导致数据丢失，建议定期导出备份。

## License

MIT
