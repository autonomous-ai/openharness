@echo off
rem The PTY driver (cli\scripts\windows-pty-e2e) against THIS user's installed daemon: run.cmd <command> [args].
rem E2E_PORT and E2E_MACHINE_ID may be set by the caller; the defaults are the install's.
if not defined E2E_PORT set E2E_PORT=18474
set E2E_STATE=%USERPROFILE%\e2e\state.json
set E2E_PROJECT=%USERPROFILE%\proj
set ADAPTER_COMPUTER_ID_FILE=%USERPROFILE%\.harness\computer-id
if not exist "%E2E_PROJECT%" mkdir "%E2E_PROJECT%"
"C:\Program Files\nodejs\node.exe" "%USERPROFILE%\e2e\e2e.mjs" %*
