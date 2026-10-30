@echo off
call C:\work\e2e\env.cmd
cd /d C:\work\e2e
"C:\Program Files\nodejs\node.exe" C:\work\e2e\e2e.mjs %*
