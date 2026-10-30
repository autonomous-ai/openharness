@echo off
call C:\work\e2e\env.cmd
cd /d C:\work\e2e
echo ==== start %DATE% %TIME% >> C:\work\e2e\daemon.log
"C:\Program Files\nodejs\node.exe" C:\work\e2e\dist\cli.js start -f >> C:\work\e2e\daemon.log 2>&1
echo ==== exit %ERRORLEVEL% %DATE% %TIME% >> C:\work\e2e\daemon.log
