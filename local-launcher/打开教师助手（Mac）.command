#!/bin/bash
# ============================================================
#  教师助手 · 在电脑上打开（Mac）
#  ------------------------------------------------------------
#  双击本文件即可：会自动起一个只给本机用的小服务，并打开浏览器。
#  停止：在这个窗口里按 Control + C
#
#  为什么不能直接双击 index.html？
#  浏览器出于安全策略，禁止以 file:// 方式加载本应用的模块脚本，
#  而且那种方式下数据存不住。必须走 http 才能正常使用。
# ============================================================

cd "$(dirname "$0")" || exit 1

echo ""
echo "  📚 教师助手 —— 正在启动…"

# ---- 优先用 Node.js ----
NODE=""
for c in /usr/local/bin/node /opt/homebrew/bin/node "$(command -v node 2>/dev/null)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done

if [ -n "$NODE" ]; then
  exec "$NODE" _local-server.mjs
fi

# ---- 没装 Node 就用系统自带的 Python ----
for PY in /usr/bin/python3 "$(command -v python3 2>/dev/null)"; do
  if [ -n "$PY" ] && [ -x "$PY" ]; then
    exec "$PY" _local-server.py
  fi
done

echo ""
echo "  ❌ 这台电脑上没找到可用的运行环境。"
echo ""
echo "     替代方案（任选其一）："
echo "     1. 直接用线上版：https://li6808.github.io/jszs2026/"
echo "     2. 装一个 Node.js（https://nodejs.org 选 LTS），再双击本文件"
echo ""
read -n 1 -s -r -p "  按任意键关闭这个窗口…"
exit 1
