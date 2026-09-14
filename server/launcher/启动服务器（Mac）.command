#!/bin/bash
# ============================================================
#  教师助手 · 自己电脑当服务器 —— Mac 一键启动
#  ------------------------------------------------------------
#  双击本文件即可。会弹出一个终端窗口，那就是服务器，别关它。
#  停止：在这个窗口里按 Control + C
# ============================================================

cd "$(dirname "$0")" || exit 1

echo ""
echo "  📚 教师助手 · 自己电脑当服务器"
echo "  ─────────────────────────────────────────"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  ❌ 没找到 Node.js。"
  echo ""
  echo "     请先到 https://nodejs.org 下载并安装「LTS 版本」，"
  echo "     一路点「继续 / 下一步」装完，然后再双击本文件。"
  echo ""
  read -n 1 -s -r -p "  按任意键关闭这个窗口…"
  exit 1
fi

echo "  Node.js 版本：$(node -v)"
echo ""

node server/start.mjs --lan --static-dir www --data-dir data

echo ""
echo "  服务已停止。数据都在 data 文件夹里，不会丢。"
read -n 1 -s -r -p "  按任意键关闭这个窗口…"
