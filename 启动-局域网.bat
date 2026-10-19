@echo off
chcp 65001 >nul
title 素材台 · 局域网
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo [错误] 没找到 Python。请先安装 Python 3.11 或更新版本，安装时勾选 Add to PATH。
  echo.
  pause
  exit /b 1
)

echo.
echo  手机 / 平板要和这台电脑连同一个网络。
echo  下面会打印 IPv4 和 IPv6 地址，复制其中一个到浏览器打开即可。
echo  如果打不开，检查 Windows 防火墙弹窗是不是点了「允许访问」。
echo.

python run.py --lan
if errorlevel 1 (
  echo.
  echo 服务异常退出，把上面的报错截图发我看看。
  pause
)
