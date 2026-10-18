@echo off
chcp 65001 >nul
title 素材台
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo [错误] 没找到 Python。请先安装 Python 3.11 或更新版本，安装时勾选 Add to PATH。
  echo.
  pause
  exit /b 1
)

python run.py
if errorlevel 1 (
  echo.
  echo 服务异常退出，把上面的报错截图发我看看。
  pause
)
