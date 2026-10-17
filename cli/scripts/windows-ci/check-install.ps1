# Run as the user who installed Harness with install.ps1 (the Windows workflow's install job; the VM end to end,
# docs/testing/windows-cli-e2e.md scenario 1). Checks what the install promises: the version, the scheduled task, the
# user PATH entry, a running daemon, and a PowerShell harness on the terminal host. Prints each check; exits 1 on the first that fails.
param([Parameter(Mandatory)][string]$Version, [string]$Project = (Join-Path $env:TEMP 'harness-check-proj'))
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:USERPROFILE '.harness'
$harness = Join-Path $root 'bin\harness.exe'
function Fail([string]$message) { Write-Host "FAIL $message"; exit 1 }

$v = ((& $harness version) | Select-Object -First 1).Trim()
if ($v -ne $Version) { Fail "harness version says '$v', expected '$Version'" }
Write-Host "ok   version $v"

# This user's own task, in the root folder (harnessd/platform.ts taskName: the account name without its domain).
$task = "Harness harnessd ($env:USERNAME)"
schtasks.exe /Query /TN $task /FO LIST /V | Out-Host
if ($LASTEXITCODE -ne 0) { Fail "the task '$task' is not registered" }
Write-Host "ok   task $task"

$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
$raw = $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$bin = (Join-Path $root 'bin').ToLower()
$onPath = @($raw -split ';' | Where-Object { [Environment]::ExpandEnvironmentVariables($_).Trim('"').TrimEnd('\').ToLower() -eq $bin })
if ($onPath.Count -ne 1) { Fail "the user PATH names $bin $($onPath.Count) times: $raw" }
Write-Host "ok   PATH has $bin"

# The status row, not the word anywhere: the block ends with "running in background - stop with: harness stop" even when
# the daemon is stopped (seen on the VM), and Windows PowerShell reads the row's dot in its console code page, as three
# other characters. (This file stays ASCII: Windows PowerShell reads a .ps1 without a BOM in the ANSI code page.)
$running = '(?m)^\s*status\s+\S+\s+running'
$deadline = (Get-Date).AddSeconds(90)
do { $status = (& $harness status) -join "`n"; if ($status -match $running) { break }; Start-Sleep 2 } while ((Get-Date) -lt $deadline)
if ($status -notmatch $running) { Fail "the daemon is not running:`n$status" }
Write-Host $status

New-Item -ItemType Directory -Force $Project | Out-Null
$created = (& $harness new terminal $Project --json) -join "`n" | ConvertFrom-Json
if (-not $created.ok -or -not $created.agent.id) { Fail "harness new terminal answered: $($created | ConvertTo-Json -Compress)" }
$deadline = (Get-Date).AddSeconds(30)
do { $hosts = @(Get-CimInstance Win32_Process -Filter "Name='harness-pty.exe'"); if ($hosts.Count) { break }; Start-Sleep 1 } while ((Get-Date) -lt $deadline)
if (-not $hosts.Count) { Fail 'no harness-pty.exe runs after creating a terminal' }
$shells = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(powershell|pwsh)\.exe$' -and $_.ParentProcessId -in $hosts.ProcessId })
Write-Host "ok   terminal $($created.agent.id) on harness-pty pid $($hosts[0].ProcessId) ($($shells.Count) shell(s) under it)"
