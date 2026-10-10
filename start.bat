@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 18 or newer is required: https://nodejs.org & pause & exit /b 1)
echo Starting Sales Force Dashboard V2 on http://localhost:8080 ...
node server.js
pause
