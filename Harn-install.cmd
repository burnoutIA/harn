@echo off
rem Harn : double-cliquer suffit. Node.js est la seule dependance ; il est installe s'il manque.
setlocal
title Harn
cd /d "%~dp0"

where node >nul 2>nul
if not errorlevel 1 goto checkversion
echo  Installation de Node.js (une seule fois)...
winget install -e --id OpenJS.NodeJS.LTS --scope user --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
set "PATH=%LOCALAPPDATA%\Programs\nodejs;%ProgramFiles%\nodejs;%PATH%"

:checkversion
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)"
if errorlevel 1 (
  echo  Node.js 22.19 ou plus recent est necessaire : https://nodejs.org
  pause
  exit /b 1
)

node src\main.mjs %*
