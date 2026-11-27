@rem The fake `harness` on Windows: fake-harness.ps1 in Windows PowerShell by its full path. Its arguments go in a
@rem variable: PowerShell's -File would read `--json` as a parameter's name.
@set "FAKE_HARNESS_ARGS=%*"
@"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0fake-harness.ps1"
@exit /b %ERRORLEVEL%
