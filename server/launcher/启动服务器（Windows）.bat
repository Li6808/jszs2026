@echo off
chcp 65001 >nul
title 教师助手 - 自己电脑当服务器
cd /d "%~dp0"

echo.
echo   ==========================================
echo     教师助手 - 自己电脑当服务器
echo   ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [X] 没找到 Node.js。
  echo.
  echo       请先到 https://nodejs.org 下载并安装 LTS 版本，
  echo       一路点“下一步”装完，然后再双击本文件。
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do echo   Node.js 版本：%%v
echo.

node server\start.mjs --lan --static-dir www --data-dir data

echo.
echo   服务已停止。数据都在 data 文件夹里，不会丢。
pause
