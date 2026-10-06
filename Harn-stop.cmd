@echo off
rem Fermer Harn en un clic : arret propre (moteur compris). Si quelque chose est en cours
rem (installation, banc, reponse...), la liste s'affiche et on peut arreter quand meme ou renoncer.
setlocal
title Harn
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js est introuvable : Harn ne peut pas tourner sur cette machine.
  pause
  exit /b 1
)

node src\ctl.mjs stop
if not errorlevel 1 goto done

echo.
choice /c ON /n /m " Arreter quand meme ? [O]ui / [N]on : "
if errorlevel 2 exit /b 1
node src\ctl.mjs stop --force
if errorlevel 1 (
  pause
  exit /b 1
)

:done
timeout /t 3 >nul
