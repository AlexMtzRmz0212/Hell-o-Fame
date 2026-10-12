@echo off
title Music Hub Launcher
setlocal

:: --- Configuration ---
set BACKEND_PORT=8002
set FRONTEND_PORT=5175

echo ============================================
echo   MUSIC HUB - DEV ENVIRONMENT
echo ============================================

echo [1/3] Clearing ports %BACKEND_PORT% and %FRONTEND_PORT%...
for %%p in (%BACKEND_PORT% %FRONTEND_PORT%) do (
  for /f "tokens=5" %%a in ('netstat -aon ^| findstr :%%p ^| findstr LISTENING') do (
    powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=%%a' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
    taskkill /f /t /pid %%a >nul 2>&1
  )
)

echo [2/3] Validating environment...
if not exist .venv goto :FAIL_MSG
if not exist frontend\node_modules goto :FAIL_MSG

echo [3/3] Launching terminals...
wt -w 0 nt --title "API" -d "." cmd /k ".venv\Scripts\python.exe -m uvicorn backend.main:app --reload --port %BACKEND_PORT%" ; ^
split-pane -V --title "Web" -d ".\frontend" cmd /k "npm run dev"
if %ERRORLEVEL% neq 0 goto :FAIL_MSG

timeout /t 4 /nobreak > NUL
start "" "http://localhost:%FRONTEND_PORT%"
goto :EOF

:FAIL_MSG
echo.
echo Setup needed (once):
echo   python -m venv .venv ^&^& .venv\Scripts\activate ^&^& pip install -r requirements-dev.txt
echo   cd frontend ^&^& npm install
pause
