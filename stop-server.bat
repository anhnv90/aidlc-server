@echo off
setlocal

set "APP_DIR=%~dp0"
set "PID_FILE=%APP_DIR%aidlc-server.pid"

if exist "%PID_FILE%" (
  set /p SERVER_PID=<"%PID_FILE%"
)

if "%SERVER_PID%"=="" (
  for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3003" ^| findstr "LISTENING"') do (
    set "SERVER_PID=%%P"
    goto :found_pid
  )
)

:found_pid

if "%SERVER_PID%"=="" (
  echo aidlc-server is not listening on port 3003.
  exit /b 0
)

tasklist /FI "PID eq %SERVER_PID%" 2>nul | find "%SERVER_PID%" >nul
if errorlevel 1 (
  del "%PID_FILE%" >nul 2>nul
  echo aidlc-server process was not running. Removed stale PID file.
  exit /b 0
)

taskkill /PID %SERVER_PID% /F >nul
if errorlevel 1 (
  echo Failed to stop aidlc-server. PID: %SERVER_PID%
  exit /b 1
)

del "%PID_FILE%" >nul 2>nul
echo aidlc-server stopped. PID: %SERVER_PID%

exit /b 0
