# harness-cli.ps1 -Arguments <array>: run start/stop/flash/uninstall in the owned desktop session (E5).
# A daemon started over SSH is outside the console session and must not take the dial.
param([Parameter(Mandatory)][ValidateNotNullOrEmpty()][string[]]$Arguments)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'ownership.ps1')
Assert-OwnedSession | Out-Null
if ($Arguments[0] -cnotin @('start', 'stop', 'flash', 'uninstall')) { throw 'this tool runs start, stop, flash or uninstall' }
$harness = Join-Path $env:USERPROFILE '.harness\bin\harness.exe'
if (-not (Test-Path -LiteralPath $harness -PathType Leaf)) { throw 'CLI not installed' }
# Native stderr must remain captured output on Windows PowerShell 5.1, including flash progress.
$ErrorActionPreference = 'Continue'
$global:LASTEXITCODE = 1
$out = & $harness @Arguments 2>&1
$code = $LASTEXITCODE
"harness $($Arguments -join ' ') exited $code"
$out | Select-Object -Last 15
exit $code
