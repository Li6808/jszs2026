#!/bin/bash
# 教师助手 一键部署脚本
# 用法：在项目根目录运行  ./deploy.sh
# 效果：构建 -> 推送到 gh-pages 分支 -> GitHub Pages 自动更新
set -e

cd "$(dirname "$0")"

echo "==> 1/3 检查依赖..."
if [ ! -d node_modules ]; then
  echo "    未发现 node_modules，开始安装依赖..."
  npm install
fi

echo "==> 2/3 构建生产版本..."
npm run build

echo "==> 3/3 部署到 gh-pages 分支..."
cd dist
if [ ! -d .git ]; then
  git init -q
  git remote add origin https://github.com/Li6808/jszs2026.git
fi
git add -A
git commit -m "deploy: $(date '+%Y-%m-%d %H:%M:%S')" || echo "    （无内容变更，跳过提交）"
git push -f origin gh-pages

echo ""
echo "✅ 部署完成！"
echo "   访问地址：https://li6808.github.io/jszs2026/"
echo "   （更新后 1-2 分钟自动生效）"
