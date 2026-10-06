@echo off
rem Harn en un clic : lance l'application, ou la relance proprement si elle tourne deja
rem (rien n'est coupe si une installation, un banc ou une reponse est en cours).
setlocal
title Harn
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js est introuvable : lancez d'abord Harn-install.cmd.
  pause
  exit /b 1
)

node src\ctl.mjs restart --open %*
if errorlevel 1 pause
