@echo off
setlocal

set "APP_DIR=%~dp0"
set "PID_FILE=%APP_DIR%aidlc-server.pid"
set "OUT_LOG=%APP_DIR%logs\server-process.out.log"
set "ERR_LOG=%APP_DIR%logs\server-process.err.log"

if not exist "%APP_DIR%logs" mkdir "%APP_DIR%logs"

if /I "%~1"=="--run" (
  cd /d "%APP_DIR%"
  node dist/server/main.js >> "%OUT_LOG%" 2>> "%ERR_LOG%"
  exit /b %ERRORLEVEL%
)

if exist "%PID_FILE%" (
  set /p OLD_PID=<"%PID_FILE%"
  if not "%OLD_PID%"=="" (
    tasklist /FI "PID eq %OLD_PID%" 2>nul | find "%OLD_PID%" >nul
    if not errorlevel 1 (
      echo aidlc-server is already running. PID: %OLD_PID%
      exit /b 0
    )
  )
  del "%PID_FILE%" >nul 2>nul
)

for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3003" ^| findstr "LISTENING"') do (
  echo %%P>"%PID_FILE%"
  echo aidlc-server is already listening on port 3003. PID: %%P
  exit /b 0
)

pushd "%APP_DIR%"

start "aidlc-server" /min "%~f0" --run

for /l %%I in (1,1,20) do (
  for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3003" ^| findstr "LISTENING"') do (
    set "NEW_PID=%%P"
    goto :server_started
  )
  timeout /t 1 /nobreak >nul
)

:server_started

popd

if "%NEW_PID%"=="" (
  echo Failed to start aidlc-server.
  exit /b 1
)

echo %NEW_PID%>"%PID_FILE%"
echo aidlc-server started. PID: %NEW_PID%
echo Dashboard: http://localhost:3003
echo Graph scan: http://localhost:3003/scan.html
echo Graph viewer: http://localhost:3003/graph-viewer.html
echo MCP endpoint: http://localhost:3003/mcp
echo Logs:
echo   %APP_DIR%logs\server.log
echo   %OUT_LOG%

exit /b 0
