# desktop-logs.ps1 [-Log app|cli|errors|launch|daemon] [-Match <regex>] [-Tail 150]: the newest lines of one log the
# Harness desktop app or its daemon writes for this user, read-only (over SSH or in the session):
#   app     %USERPROFILE%\.harness\logs\app-YYYYMMDD.log, the app's narrative (app, ws, api, flutter)
#   cli     %USERPROFILE%\.harness\logs\cli-YYYYMMDD.log, every child process the app ran, as a person reads it
#   errors  %USERPROFILE%\.harness\desktop-app*\errors.log, what threw
#   launch  %LOCALAPPDATA%\Programs\Harness\launch.log, the launcher's starts and rollbacks
#   daemon  %USERPROFILE%\.harness\cli\data\harness.log, the CLI daemon's own log
# The app's state.json holds credentials and is never read here.
param([ValidateSet('app', 'cli', 'errors', 'launch', 'daemon')][string]$Log = 'app', [string]$Match, [int]$Tail = 150)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ownership.ps1')
Assert-OwnedUser | Out-Null
$h = Join-Path $env:USERPROFILE '.harness'
$logs = Join-Path $h 'logs'
$file = switch ($Log) {
  'app' { Get-ChildItem -LiteralPath $logs -Filter 'app-*.log' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1 }
  'cli' { Get-ChildItem -LiteralPath $logs -Filter 'cli-*.log' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1 }
  'errors' {
    Get-ChildItem -LiteralPath $h -Directory -Filter 'desktop-app*' -ErrorAction SilentlyContinue |
      ForEach-Object { Get-Item -LiteralPath (Join-Path $_.FullName 'errors.log') -ErrorAction SilentlyContinue } |
      Sort-Object LastWriteTime | Select-Object -Last 1
  }
  'launch' { Get-Item -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs\Harness\launch.log') -ErrorAction SilentlyContinue }
  'daemon' { Get-Item -LiteralPath (Join-Path $h 'cli\data\harness.log') -ErrorAction SilentlyContinue }
}
if ($env:HOME) { Write-Output "note: HOME is set ('$env:HOME'); the app must still use USERPROFILE ($env:USERPROFILE)" }
if (-not $file) { Write-Output "no $Log log yet"; exit 1 }
Write-Output "## $($file.FullName) ($($file.Length) bytes, written $($file.LastWriteTime.ToString('HH:mm:ss')))"
$lines = @(Get-Content -LiteralPath $file.FullName -Encoding UTF8)
if ($Match) { $lines = @($lines | Select-String -Pattern $Match | ForEach-Object { $_.Line }) }
$lines | Select-Object -Last $Tail
