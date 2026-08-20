@echo off
cd /d "%~dp0"
echo.
echo  Spoustim CR Search...
echo  Otevri v prohlizeci: http://localhost:3000
echo.
node --watch server.js
pause
