@echo off
rem B driver, only this newly owned user's recorded actual port. Re-read on EVERY invocation.
setlocal
set "E2E_PORT="
for /f "delims=" %%P in ('powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0desktop-state.ps1" -DriverPort') do set "E2E_PORT=%%P"
if not defined E2E_PORT (
  echo No valid owned daemon port record. Start this test user's daemon first. 1>&2
  exit /b 3
)
call "%~dp0run.cmd" %*
exit /b %ERRORLEVEL%
