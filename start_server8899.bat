@echo off
if "%1"=="min" goto run
start /min cmd /c "%~f0" min
exit

:run
cd /d %~dp0
echo Server starting on http://127.0.0.1:8787
echo Close this window with Ctrl+C to stop.
py -m http.server 8787 --directory "%~dp0public"
echo.
echo Server stopped. Cleaning up...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8787 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
)
pause