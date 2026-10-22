# Run as the user who installed Harness with install.ps1 (the Windows workflow's install job; the VM end to end,
# docs/testing/windows-cli-e2e.md scenario 1). Checks what the install promises: the version, the scheduled task, the
# user PATH entry, a running daemon, and a PowerShell harness on the terminal host. Prints each check; exits 1 on the first that fails.
param([Parameter(Mandatory)][string]$Version, [string]$Project = (Join-Path $env:TEMP 'harness-check-proj'))
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:USERPROFILE '.harness'
$harness = Join-Path $root 'bin\harness.exe'
# On a FAIL, what says why, in the job's own output: the daemon's status, what its local API says of the terminal backend
# and the sessions, the Harness processes, the terminal host's discovery file, and each log's tail. Run 39083518767 failed
# with none of it: its log artifact came out empty, and the FAIL line alone could not tell a host that never started from
# one the check did not count. Nothing here may end the script or call Processes/Fail (whose WMI failure calls Fail).
function Show-Diagnosis {
  $ErrorActionPreference = 'Continue'
  Write-Host '--- diagnosis: harness status'
  $text = ''
  try { $text = (& $harness status 2>&1 | Out-String); Write-Host $text } catch { Write-Host "harness status: $($_.Exception.Message)" }
  Write-Host '--- diagnosis: the local API /api/status (terminal backend, sessions)'
  # The address status names, never a guessed port: a daemon there may be another one's.
  $api = if ($text -match '(?m)^\s*local api\s+(http://\S+)') { $Matches[1] } else { $null }
  if (-not $api) { Write-Host 'harness status names no local api' }
  else { try {
    $s = Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 "$api/api/status"
    $s | Select-Object version, pid, discoveryReady, discoveryError, harnessd, @{ n = 'terminalTargets'; e = { $_.config.terminalTargets } } |
      ConvertTo-Json -Depth 6 | Write-Host
    $sessions = @($s.sessions)
    Write-Host "$($sessions.Count) session(s)"
    foreach ($one in $sessions) { $one | Select-Object id, engine, cwd, terminal | ConvertTo-Json -Depth 6 -Compress | Write-Host }
    if ($script:created) { Write-Host "the terminal created here, $($script:created.agent.id): $(if ($sessions.id -contains $script:created.agent.id) { 'listed' } else { 'NOT listed' })" }
  } catch { Write-Host "$api/api/status: $($_.Exception.Message)" } }
  Write-Host '--- diagnosis: processes'
  Get-Process -Name 'harness*', 'node', 'OpenConsole', 'conhost', 'powershell', 'pwsh' -ErrorAction SilentlyContinue |
    Format-Table Id, ProcessName, SessionId, StartTime, Path -AutoSize | Out-String -Width 300 | Write-Host
  try {
    # The master and the core run as node.exe on Windows (harnessd/processName.ts): their command lines say which.
    Get-CimInstance Win32_Process -Filter "Name LIKE 'harness%' OR Name = 'node.exe'" -ErrorAction Stop |
      Format-List ProcessId, ParentProcessId, Name, CommandLine | Out-String -Width 300 | Write-Host
  } catch { Write-Host "WMI: $($_.Exception.Message)" }
  Write-Host '--- diagnosis: the terminal host (current-pty, its version folders, its discovery file without the token)'
  $runtimePty = Join-Path $root 'runtime\pty'
  try { Write-Host "current-pty: $((Get-Content (Join-Path $runtimePty 'current-pty') -ErrorAction Stop) -join ' ')" } catch { Write-Host "current-pty: $($_.Exception.Message)" }
  Get-ChildItem $runtimePty -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $($_.Name)" }
  foreach ($found in @(Get-ChildItem (Join-Path $root 'pty\run') -Filter 'pty-host-*.json' -ErrorAction SilentlyContinue)) {
    try { Write-Host "$($found.Name): $(Get-Content $found.FullName -Raw | ConvertFrom-Json | Select-Object protocol, pid, version, endpoint | ConvertTo-Json -Compress)" }
    catch { Write-Host "$($found.Name): $($_.Exception.Message)" }
  }
  # The master and the core write cli\data\harness.log, harness-launch.exe cli\data\logs\launch.log, the host
  # pty\logs\pty-host-<instance>.log (pty/src/logfile.rs), the dial logs\dial-*.log.
  foreach ($tree in @('cli\data', 'pty\logs', 'logs')) {
    $dir = Join-Path $root $tree
    $files = @(Get-ChildItem $dir -Filter '*.log' -Recurse -File -Force -ErrorAction SilentlyContinue)
    if (-not $files.Count) { Write-Host "--- diagnosis: no *.log under $dir$(if (-not (Test-Path $dir)) { ' (it does not exist)' })"; continue }
    foreach ($file in $files) {
      Write-Host "--- diagnosis: $($file.FullName) ($($file.Length) bytes, written $($file.LastWriteTime.ToString('o'))), its last 80 lines"
      try { Get-Content $file.FullName -Tail 80 -ErrorAction Stop | Write-Host } catch { Write-Host "  $($_.Exception.Message)" }
    }
  }
}
function Fail([string]$message) { Write-Host "FAIL $message"; Show-Diagnosis; exit 1 }

$v = ((& $harness version) | Select-Object -First 1).Trim()
if ($v -ne $Version) { Fail "harness version says '$v', expected '$Version'" }
Write-Host "ok   version $v"

# This user's own task, in the root folder (harnessd/platform.ts taskName: the account name without its domain).
$task = "Harness harnessd ($env:USERNAME)"
schtasks.exe /Query /TN $task /FO LIST /V | Out-Host
if ($LASTEXITCODE -ne 0) { Fail "the task '$task' is not registered" }
# Normal priority, as Task Scheduler has it registered: whether or not it is the task that started the daemon here.
# Joined by lines and without NULs, as harnessd/platform.ts reads it: in a pipe schtasks's XML may come as UTF-16.
$registered = (@(schtasks.exe /Query /TN $task /XML) -join "`n") -replace "`0", ''
if ($registered -notmatch '<Priority>4</Priority>') { Fail "the task '$task' does not run at normal priority (Priority 4):`n$registered" }
Write-Host "ok   task $task"
# The logon task beside it (harnessd/platform.ts logonTaskName): the start at sign-in, which forgets a harness stop.
$logonTask = "Harness harnessd at sign-in ($env:USERNAME)"
$logon = (@(schtasks.exe /Query /TN $logonTask /XML) -join "`n") -replace "`0", ''
if ($LASTEXITCODE -ne 0) { Fail "the task '$logonTask' is not registered" }
if ($logon -notmatch '--at-logon</Arguments>' -or $logon -notmatch '<Priority>4</Priority>') { Fail "the task '$logonTask' does not run harness start --if-down --at-logon at normal priority:`n$logon" }
Write-Host "ok   task $logonTask"

$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
$raw = $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$bin = (Join-Path $root 'bin').ToLower()
$onPath = @($raw -split ';' | Where-Object { [Environment]::ExpandEnvironmentVariables($_).Trim('"').TrimEnd('\').ToLower() -eq $bin })
if ($onPath.Count -ne 1) { Fail "the user PATH names $bin $($onPath.Count) times: $raw" }
Write-Host "ok   PATH has $bin"

# The status row, not the word anywhere: it is what states the daemon's state (the footer said "running in background"
# even when stopped until d127faded, seen on the VM), and Windows PowerShell reads the row's dot in its console code page,
# as three other characters. (This file stays ASCII: Windows PowerShell reads a .ps1 without a BOM in the ANSI code page.)
$running = '(?m)^\s*status\s+\S+\s+running'
$deadline = (Get-Date).AddSeconds(90)
do { $status = (& $harness status) -join "`n"; if ($status -match $running) { break }; Start-Sleep 2 } while ((Get-Date) -lt $deadline)
if ($status -notmatch $running) { Fail "the daemon is not running:`n$status" }
Write-Host $status

New-Item -ItemType Directory -Force $Project | Out-Null
$created = (& $harness new terminal $Project --json) -join "`n" | ConvertFrom-Json
if (-not $created.ok -or -not $created.agent.id) { Fail "harness new terminal answered: $($created | ConvertTo-Json -Compress)" }
$deadline = (Get-Date).AddSeconds(30)
# WMI gives the parent pids the shell check needs; a standard user signed in over SSH is refused it, which is a FAIL here.
function Processes([string]$filter) {
  try { if ($filter) { @(Get-CimInstance Win32_Process -Filter $filter) } else { @(Get-CimInstance Win32_Process) } }
  catch { Fail "could not list processes through WMI ($($_.Exception.Message)); run this at the desktop or as a batch logon" }
}
# @( ): a function's array comes back unrolled, and one CimInstance has no .Count in Windows PowerShell 5.1, so a lone
# host would never count (seen on the VM, task B5.14).
# Only this install's hosts: WMI lists every user's harness-pty.exe by name, and another Windows user's host (and its
# shells) passed the check for this one on the VM (task B5.14). Another user's process shows no ExecutablePath here.
do { $hosts = @(Processes "Name='harness-pty.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith("$root\", 'OrdinalIgnoreCase') }); if ($hosts.Count) { break }; Start-Sleep 1 } while ((Get-Date) -lt $deadline)
if (-not $hosts.Count) { Fail "no harness-pty.exe from $root runs after creating a terminal" }
# The dial's watch (sub-project E): a stale payload or an open/probe child under this install root must not satisfy
# this check. Require the selected payload's binary and its watch command, even with no dial plugged in.
$ptyVersion = (Get-Content -LiteralPath (Join-Path $root 'runtime\pty\current-pty') -Raw).Trim()
$serialBinary = "$root\runtime\pty\$ptyVersion\harness-serial.exe"
$watchCommand = '^(?:"' + [regex]::Escape($serialBinary) + '"|' + [regex]::Escape($serialBinary) + ')\s+watch\s*$'
$deadline = (Get-Date).AddSeconds(30)
do { $watch = @(Processes "Name='harness-serial.exe'" | Where-Object { [string]::Equals($_.ExecutablePath, $serialBinary, 'OrdinalIgnoreCase') -and $_.CommandLine -match $watchCommand }); if ($watch.Count) { break }; Start-Sleep 1 } while ((Get-Date) -lt $deadline)
if (-not $watch.Count) { Fail "no harness-serial.exe watch from $serialBinary runs 30 s after the daemon started" }
if ($watch.Count -ne 1) { Fail "$($watch.Count) harness-serial.exe watches from $serialBinary run; one watch was expected" }
Write-Host "ok   the dial watch runs: $($watch[0].CommandLine)"
# The PowerShell the terminal runs, a child of the host: what the install promises, so none is a failure.
$deadline = (Get-Date).AddSeconds(30)
do {
  $shells = @(Processes '' | Where-Object { $_.Name -match '^(powershell|pwsh)\.exe$' -and $_.ParentProcessId -in $hosts.ProcessId })
  if ($shells.Count) { break }; Start-Sleep 1
} while ((Get-Date) -lt $deadline)
if (-not $shells.Count) { Fail "no PowerShell runs under harness-pty.exe (pid $($hosts.ProcessId -join ', ')) 30 s after creating terminal $($created.agent.id)" }
Write-Host "ok   terminal $($created.agent.id) on harness-pty pid $($hosts[0].ProcessId) ($($shells.Count) shell(s) under it)"
# Normal priority: Task Scheduler starts a task at its default priority 7, below normal, unless the task says otherwise,
# and the daemon, the terminal host and every shell in it inherit it (harnessd/platform.ts taskSchedulerXml, Priority 4;
# final review R1b-1). Get-Process, not WMI: these are this user's own processes, and it is what gives the class.
$ids = @($hosts.ProcessId) + @($shells.ProcessId)
$mine = @(Get-Process -Name 'harness-pty', 'node' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith("$root\", 'OrdinalIgnoreCase') })
$mine += @(Get-Process -Id $ids -ErrorAction SilentlyContinue | Where-Object { $mine.Id -notcontains $_.Id })
if (-not @($mine | Where-Object { $_.ProcessName -eq 'node' }).Count) { Fail "no node.exe from $root runs, so the daemon's priority cannot be read" }
$slow = @($mine | Where-Object { "$($_.PriorityClass)" -ne 'Normal' })
if ($slow.Count) { Fail "not at normal priority: $(($slow | ForEach-Object { "$($_.ProcessName) $($_.Id) $($_.PriorityClass)" }) -join ', ')" }
Write-Host "ok   priority Normal for $($mine.Count) process(es): $(($mine | ForEach-Object { "$($_.ProcessName) $($_.Id)" }) -join ', ')"
