@echo off
chcp 65001 >nul
rem ============================================================
rem  教师助手 · 在电脑上打开（Windows）
rem  ----------------------------------------------------------
rem  双击本文件即可：会自动起一个只给本机用的小服务，并打开浏览器。
rem  停止：在这个窗口里按 Ctrl + C
rem
rem  为什么不能直接双击 index.html？
rem  浏览器出于安全策略，禁止以 file:// 方式加载本应用的模块脚本，
rem  而且那种方式下数据存不住。必须走 http 才能正常使用。
rem ============================================================

cd /d "%~dp0"

echo.
echo   教师助手 —— 正在启动...

where node >nul 2>nul
if %errorlevel%==0 (
  node "_local-server.mjs"
  goto :done
)

where python >nul 2>nul
if %errorlevel%==0 (
  python "_local-server.py"
  goto :done
)

where py >nul 2>nul
if %errorlevel%==0 (
  py "_local-server.py"
  goto :done
)

echo.
echo   这台电脑上没找到 Node.js 或 Python。
echo.
echo   替代方案（任选其一）：
echo   1. 直接用线上版：https://li6808.github.io/jszs2026/
echo   2. 装一个 Node.js（https://nodejs.org 选 LTS 版），再双击本文件
echo.
pause
exit /b 1

:done
echo.
echo   服务已停止。数据还在浏览器里，不会丢。
pause
