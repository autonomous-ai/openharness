# console.ps1 -Script <file.ps1> [-ArgsJson <json>] [-TimeoutSec 600] [-NoWait] | -Stop <name>
# Runs a script in this account's console session, from SSH (session 0): a one-shot scheduled task under this account
# with an interactive logon, so what it starts has the desktop the person sees (the desk's dial and its windows). No
# password is stored: an interactive task runs only in the session already signed in. The task starts the script through
# Windows' own conhost.exe with no window (`--headless`), so nothing flashes on the screen and nothing is compiled here:
# Smart App Control runs only signed programs (desktop/scripts/windows-e2e/session-run.ps1 does the same for the VM's
# test user with a program it builds). Its output goes to <this folder>\<name>.log in UTF-8 as it comes; the task is
# named harness-dial-check-<random>.
#   Waiting (the default): prints the output and `exit <code>` once the script ends, within -TimeoutSec, then deletes the
#     task and its files; a script still running then is ended with everything it started (exit 124).
#   -NoWait: prints the task's name and returns; the log grows as the script writes, to be read over SSH.
#   -Stop <name>: waits up to 90 s for that task to end (a desk's quit restores the dial's settings, stops its daemon and
#     looks at the dial once more), then ends what is left, prints its log and `exit <code>`, and deletes it all.
# -ArgsJson is a JSON array of strings, passed to the script as its arguments. Exit 3: this account has no console session.
param(
  [string]$Script,
  [string]$ArgsJson = '[]',
  [int]$TimeoutSec = 600,
  [switch]$NoWait,
  [string]$Stop
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# UTF-8 with no BOM, here and in the wrapper: Windows PowerShell reads a program's output, and writes its own, in the OEM
# code page, which turns a profile's Vietnamese letters into `?`.
$utf8 = New-Object Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
$dir = $PSScriptRoot
$me = [Security.Principal.WindowsIdentity]::GetCurrent()

function Files([string]$Name) {
  @{ wrapper = Join-Path $dir "$Name.ps1"; call = Join-Path $dir "$Name.json"; log = Join-Path $dir "$Name.log"; done = Join-Path $dir "$Name.done"; doneTemp = Join-Path $dir "$Name.done.tmp" }
}

# The task, and what its script started: the task's PowerShell runs the wrapper, and a desk and its daemon run under it,
# whose tree taskkill ends while its parents still stand.
function End-Task([string]$Name) {
  # taskkill says on stderr that a process has gone, which is no failure here.
  $ErrorActionPreference = 'Continue'
  $wrapper = (Files $Name).wrapper
  foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'")) {
    if ($p.CommandLine -and $p.CommandLine.Contains($wrapper)) { & taskkill.exe /pid $p.ProcessId /t /f 2>&1 | Out-Null }
  }
  Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
}

function Exit-Code([string]$Done) {
  if (Test-Path -LiteralPath $Done) { return [int](Get-Content -LiteralPath $Done -Raw).Trim() }
  return 124
}

if ($Stop) {
  if ($Stop -notmatch '^harness-dial-check-[0-9a-f]{32}$') { Write-Output 'usage: console.ps1 -Stop harness-dial-check-<32 hex>'; exit 2 }
  $files = Files $Stop
  $deadline = (Get-Date).AddSeconds(90)
  while (-not (Test-Path -LiteralPath $files.done) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
  $code = Exit-Code $files.done
  End-Task $Stop
  if (Test-Path -LiteralPath $files.log) { Get-Content -LiteralPath $files.log -Encoding UTF8 }
  Remove-Item -LiteralPath $files.wrapper, $files.call, $files.log, $files.done, $files.doneTemp -Force -ErrorAction SilentlyContinue
  Write-Output "exit $code"
  exit $code
}

if (-not $Script) { Write-Output 'usage: console.ps1 -Script <file.ps1> [-ArgsJson <json>] [-TimeoutSec 600] [-NoWait] | -Stop <name>'; exit 2 }
$path = if ([IO.Path]::IsPathRooted($Script)) { $Script } else { Join-Path $dir $Script }
if ($path -notmatch '\.ps1$' -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { Write-Output 'console.ps1: -Script names no .ps1 file'; exit 2 }
$words = @()
try { foreach ($word in (ConvertFrom-Json $ArgsJson)) { if ($word -isnot [string]) { throw 'not a string' }; $words += $word } }
catch { Write-Output 'console.ps1: -ArgsJson takes a JSON array of strings'; exit 2 }

# The account at the console, as Windows names it; the person's name is never printed.
$console = (Get-CimInstance Win32_ComputerSystem).UserName
if (-not $console -or -not [string]::Equals($console, $me.Name, [StringComparison]::OrdinalIgnoreCase)) { Write-Output 'this account has no console session'; exit 3 }

$name = 'harness-dial-check-' + [guid]::NewGuid().ToString('N')
$files = Files $name
# The script and its arguments are data the wrapper reads, never text in its code: a quote of any kind (straight,
# curly, double) in a path or an argument cannot end a string there.
[IO.File]::WriteAllText($files.call, (ConvertTo-Json -Compress -InputObject @{ script = $path; args = $words }), $utf8)
# The same for every task: it finds its files beside itself, by its own name.
@'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$ErrorActionPreference = 'Continue'
$global:LASTEXITCODE = 0
$code = 0
$base = $PSCommandPath -replace '\.ps1$', ''
$log = "$base.log"
[IO.File]::WriteAllText($log, '')
try {
  $call = [IO.File]::ReadAllText("$base.json") | ConvertFrom-Json
  $program = $call.script
  $words = @($call.args)
  & $program @words *>&1 | ForEach-Object { Add-Content -LiteralPath $log -Value "$_" -Encoding utf8 }
  if ($null -ne $LASTEXITCODE) { $code = $LASTEXITCODE }
} catch {
  Add-Content -LiteralPath $log -Value "$_" -Encoding utf8
  $code = 1
}
# Whole: a reader never finds the file empty.
[IO.File]::WriteAllText("$base.done.tmp", "$code")
[IO.File]::Move("$base.done.tmp", "$base.done")
'@ | Set-Content -LiteralPath $files.wrapper -Encoding utf8

$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction -Execute $conhost -Argument ('--headless "' + $shell + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $files.wrapper + '"')
$principal = New-ScheduledTaskPrincipal -UserId $me.User.Value -LogonType Interactive -RunLevel Limited
$limit = if ($NoWait) { New-TimeSpan -Hours 8 } else { New-TimeSpan -Seconds ($TimeoutSec + 60) }
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit $limit -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings | Out-Null
$keep = $false
$code = 124
try {
  Start-ScheduledTask -TaskName $name
  if ($NoWait) { $keep = $true; Write-Output $name; $code = 0; return }
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $startBy = (Get-Date).AddSeconds(20)
  while (-not (Test-Path -LiteralPath $files.done)) {
    if ((Get-Date) -gt $deadline) { Write-Output "timed out after $TimeoutSec s"; break }
    if ((Get-Date) -gt $startBy -and -not (Test-Path -LiteralPath $files.log)) {
      Write-Output "the task did not start (last result $((Get-ScheduledTaskInfo -TaskName $name).LastTaskResult))"
      break
    }
    Start-Sleep -Milliseconds 300
  }
  if (Test-Path -LiteralPath $files.log) { Get-Content -LiteralPath $files.log -Encoding UTF8 }
  $code = Exit-Code $files.done
} finally {
  if (-not $keep) {
    End-Task $name
    Remove-Item -LiteralPath $files.wrapper, $files.call, $files.log, $files.done, $files.doneTemp -Force -ErrorAction SilentlyContinue
  }
}
Write-Output "exit $code"
exit $code
