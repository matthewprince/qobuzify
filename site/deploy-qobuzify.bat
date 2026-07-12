@echo off
cd /d "%~dp0"
echo === Building site ===
call npm run build
if errorlevel 1 ( echo BUILD FAILED & pause & exit /b 1 )
echo === Deploying to Cloudflare ===
call npx wrangler deploy
echo === Done ===
pause
