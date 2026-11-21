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
# UTF-8 with no BOM, here and in the wrapper (which sets it its own way): Windows PowerShell reads a program's output,
# and writes its own, in the OEM code page, which turns a profile's Vietnamese letters into `?`.
$utf8 = New-Object Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
$dir = $PSScriptRoot
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
# Windows' folder as the system says, never a variable someone can set.
$system = [Environment]::GetFolderPath('System')
# The Task Scheduler's own COM object: its cmdlets go through CIM, which a network logon (SSH) is denied.
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$tasks = $service.GetFolder('\')

function Files([string]$Name) {
  @{ wrapper = Join-Path $dir "$Name.ps1"; call = Join-Path $dir "$Name.json"; log = Join-Path $dir "$Name.log"; done = Join-Path $dir "$Name.done"; doneTemp = Join-Path $dir "$Name.done.tmp"; pid = Join-Path $dir "$Name.pid" }
}

# A one-shot task under this account, started now: TASK_CREATE with TASK_LOGON_INTERACTIVE_TOKEN, no password, so it
# runs only in the session signed in.
function Start-Interactive([string]$Name, [string]$Program, [string]$Arguments, [TimeSpan]$Limit) {
  $task = $service.NewTask(0)
  $action = $task.Actions.Create(0) # TASK_ACTION_EXEC
  $action.Path = $Program
  $action.Arguments = $Arguments
  $task.Principal.RunLevel = 0 # TASK_RUNLEVEL_LUA
  $task.Settings.ExecutionTimeLimit = [Xml.XmlConvert]::ToString($Limit)
  $task.Settings.DisallowStartIfOnBatteries = $false
  $task.Settings.StopIfGoingOnBatteries = $false
  $task.Settings.MultipleInstances = 2 # TASK_INSTANCES_IGNORE_NEW
  $tasks.RegisterTaskDefinition($Name, $task, 2, $me.Name, $null, 3) | Out-Null
  $tasks.GetTask($Name).Run($null) | Out-Null
}

# The task, and what its script started: the task's PowerShell runs the wrapper, which writes its pid first, and a desk
# and its daemon run under it, whose tree taskkill ends while its parents still stand.
function End-Task([string]$Name) {
  $pidFile = (Files $Name).pid
  if (Test-Path -LiteralPath $pidFile) {
    $id = [int]"$(Get-Content -LiteralPath $pidFile -Raw)".Trim()
    $p = if ($id) { Get-Process -Id $id -ErrorAction SilentlyContinue }
    # A pid is reused once its process ends, by one started after the file was written: never that one's tree.
    if ($p -and $p.StartTime -le (Get-Item -LiteralPath $pidFile).LastWriteTime) {
      # taskkill lists a tree through WMI, which a network logon is denied (over SSH it says "Access denied" and ends
      # nothing): it runs in the session, as a task of its own with no window, and ends the wrapper last.
      $end = "$Name-end"
      $kill = '--headless "' + (Join-Path $system 'taskkill.exe') + '" /pid ' + $id + ' /t /f'
      try { Start-Interactive $end (Join-Path $system 'conhost.exe') $kill (New-TimeSpan -Minutes 1) } catch {}
      if (-not $p.WaitForExit(20000)) { Write-Output "the task's processes did not end" }
      try { $tasks.DeleteTask($end, 0) } catch {}
    }
  }
  # Gone already is no failure either.
  try { $tasks.GetTask($Name).Stop(0) } catch {}
  try { $tasks.DeleteTask($Name, 0) } catch {}
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
  Remove-Item -LiteralPath $files.wrapper, $files.call, $files.log, $files.done, $files.doneTemp, $files.pid -Force -ErrorAction SilentlyContinue
  Write-Output "exit $code"
  exit $code
}

if (-not $Script) { Write-Output 'usage: console.ps1 -Script <file.ps1> [-ArgsJson <json>] [-TimeoutSec 600] [-NoWait] | -Stop <name>'; exit 2 }
$path = if ([IO.Path]::IsPathRooted($Script)) { $Script } else { Join-Path $dir $Script }
if ($path -notmatch '\.ps1$' -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { Write-Output 'console.ps1: -Script names no .ps1 file'; exit 2 }
$words = @()
try { foreach ($word in (ConvertFrom-Json $ArgsJson)) { if ($word -isnot [string]) { throw 'not a string' }; $words += $word } }
catch { Write-Output 'console.ps1: -ArgsJson takes a JSON array of strings'; exit 2 }

$name = 'harness-dial-check-' + [guid]::NewGuid().ToString('N')
$files = Files $name
# The same for every task: it finds its files beside itself, by its own name.
$wrapper = @'
$ErrorActionPreference = 'Continue'
$global:LASTEXITCODE = 0
$code = 0
$base = $PSCommandPath -replace '\.ps1$', ''
# First: End-Task ends this PowerShell's tree by it.
[IO.File]::WriteAllText("$base.pid", "$PID")
$log = "$base.log"
[IO.File]::WriteAllText($log, '')
try {
  # A program's output is read in [Console]::OutputEncoding. In the task's headless conhost this PowerShell has no
  # console whose code page it can set: the setter throws, unseen, and the getter falls back to the ANSI page (the VM read
  # UTF-8 as Windows-1252 letters). So the encoding .NET Framework keeps for it, which its getter returns first, is set
  # itself, here, where a failure reaches the log. $OutputEncoding is what PowerShell writes to a program's input in
  # (ASCII by default).
  $utf8 = New-Object Text.UTF8Encoding $false
  [Console].GetField('_outputEncoding', [Reflection.BindingFlags]'NonPublic,Static').SetValue($null, $utf8)
  $OutputEncoding = $utf8
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
'@

$shell = Join-Path $system 'WindowsPowerShell\v1.0\powershell.exe'
$limit = if ($NoWait) { New-TimeSpan -Hours 8 } else { New-TimeSpan -Seconds ($TimeoutSec + 60) }
$keep = $false
$code = 124
# Opened before the first file is written: a registration the Task Scheduler refuses still deletes them.
try {
  # The script and its arguments are data the wrapper reads, never text in its code: a quote of any kind (straight,
  # curly, double) in a path or an argument cannot end a string there.
  [IO.File]::WriteAllText($files.call, (ConvertTo-Json -Compress -InputObject @{ script = $path; args = $words }), $utf8)
  $wrapper | Set-Content -LiteralPath $files.wrapper -Encoding utf8
  Start-Interactive $name (Join-Path $system 'conhost.exe') ('--headless "' + $shell + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $files.wrapper + '"') $limit
  # Whether this account is signed in, the task itself says, on every edition (Windows Home has no quser.exe): an
  # interactive task runs only in its account's session, and with none it stays "has not yet run"
  # (SCHED_S_TASK_HAS_NOT_RUN). The wrapper's first lines write the log.
  $startBy = (Get-Date).AddSeconds(20)
  while (-not (Test-Path -LiteralPath $files.log) -and (Get-Date) -lt $startBy) { Start-Sleep -Milliseconds 300 }
  if (-not (Test-Path -LiteralPath $files.log)) {
    $result = $tasks.GetTask($name).LastTaskResult
    if ($result -eq 0x41303) { Write-Output 'this account has no console session'; $code = 3 }
    else { Write-Output "the task did not start (last result $result)" }
  } elseif ($NoWait) { $keep = $true; Write-Output $name; $code = 0; return }
  else {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while (-not (Test-Path -LiteralPath $files.done)) {
      if ((Get-Date) -gt $deadline) { Write-Output "timed out after $TimeoutSec s"; break }
      Start-Sleep -Milliseconds 300
    }
    Get-Content -LiteralPath $files.log -Encoding UTF8
    $code = Exit-Code $files.done
  }
} finally {
  if (-not $keep) {
    End-Task $name
    Remove-Item -LiteralPath $files.wrapper, $files.call, $files.log, $files.done, $files.doneTemp, $files.pid -Force -ErrorAction SilentlyContinue
  }
}
Write-Output "exit $code"
exit $code
