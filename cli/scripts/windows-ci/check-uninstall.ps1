# Run as the user who installed Harness, after `harness uninstall --yes` (the Windows workflow's install job; the VM
# end to end, docs/testing/windows-cli-e2e.md scenario 7). Waits for the last step, the cmd.exe that removes ~\.harness
# once the CLI has exited, then lists everything of Harness's that is left, and exits 1 when anything is.
# -HookFiles: engine files Harness wrote outside ~\.harness (plugins), comma-separated, which must be gone.
# What it reads is said on its last line; a check that could not look is a LEFT line, never a clean one. It expects a
# profile where Codex has not run (the runner's, a fresh user's): there any [hooks.state] record is Harness's.
param([int]$WaitSeconds = 120, [string]$HookFiles = '')
# Stop: an error in a check ends the script with exit 1 instead of passing over what it did not read. schtasks, which
# answers a missing task with exit 1 and stderr, runs under Continue; the listings that can fail become LEFT lines.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:USERPROFILE '.harness'
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Test-Path $root) -and (Get-Date) -lt $deadline) { Start-Sleep 1 }
$left = @()
if (Test-Path $root) { $left += "files: $root holds " + ((Get-ChildItem -Force -Recurse $root | Select-Object -First 20 | ForEach-Object FullName) -join ', ') }
$task = "Harness harnessd ($env:USERNAME)"   # harnessd/platform.ts taskName
# schtasks exits 1 for a task that is not there, and writes that to stderr, which Stop must not turn into a failure.
$ErrorActionPreference = 'Continue'
schtasks.exe /Query /TN $task 2>$null | Out-Null
$found = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($found -eq 0) { $left += "task: $task is still registered" }
$logonTask = "Harness harnessd at sign-in ($env:USERNAME)"   # harnessd/platform.ts logonTaskName
$ErrorActionPreference = 'Continue'
schtasks.exe /Query /TN $logonTask 2>$null | Out-Null
$found = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($found -eq 0) { $left += "task: $logonTask is still registered" }
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
$raw = if ($k) { $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') } else { '' }
$bin = (Join-Path $root 'bin').ToLower()
foreach ($entry in ($raw -split ';')) {
  if ([Environment]::ExpandEnvironmentVariables($entry).Trim('"').TrimEnd('\').ToLower() -eq $bin) { $left += "PATH: $entry is still on the user PATH" }
}
# Get-Process, not WMI: WMI refuses a standard user signed in over SSH (task-B3.21 F1). The user's own processes have a
# Path; `$root\` so that a C:\Users\u\.harness-old does not count.
try {
  foreach ($p in @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase) })) {
    $left += "process: $($p.Name) $($p.Id) runs from $($p.Path)"
  }
} catch { $left += "process: could not list processes ($($_.Exception.Message))" }
try {
  foreach ($f in @(Get-ChildItem -Path $env:TEMP -Filter 'harness-uninstall-*')) {
    $left += "temp: $($f.FullName)" + $(if ($f.Extension -eq '.log') { ': ' + (Get-Content $f.FullName -Raw) } else { '' })
  }
} catch { $left += "temp: could not list $env:TEMP ($($_.Exception.Message))" }
# The settings files Harness edits rather than writes whole (engines/*/contract.ts): none may still run notify.mjs.
$copilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE '.copilot' }
$settingsFiles = @(@('.claude\settings.json', '.codex\hooks.json', '.commandcode\settings.json') | ForEach-Object { Join-Path $env:USERPROFILE $_ }) +
  (Join-Path $copilotHome 'hooks\harness.json')
foreach ($settings in $settingsFiles) {
  if ((Test-Path $settings) -and ((Get-Content $settings -Raw) -match 'notify\.mjs')) { $left += "hooks: $settings still runs notify.mjs" }
}
# Codex's record of the hooks Harness recorded as reviewed (engines/codex/hookContract.ts `reviewed`: [hooks.state."<key>"]
# with trusted_hash). Codex has not run in this profile, so any such record left is Harness's.
$codexConfig = Join-Path $env:USERPROFILE '.codex\config.toml'
if (Test-Path $codexConfig) {
  # "$(...)": Get-Content -Raw gives $null for an empty file, which the uninstall leaves when Harness's record was all,
  # and a [string] cast of $null still reaches the .NET call as null (seen on the VM).
  $text = "$(Get-Content $codexConfig -Raw)"
  $records = [regex]::Matches($text, '(?ms)^\[hooks\.state\.("[^"\r\n]*")\][^\[]*?^\s*trusted_hash\s*=')
  foreach ($record in $records) { $left += "hooks: $codexConfig still holds a reviewed-hook record $($record.Groups[1].Value)" }
}
$hookFileList = @($HookFiles -split ',' | Where-Object { $_ })
foreach ($file in $hookFileList) { if (Test-Path $file) { $left += "hooks: $file is still there" } }
if ($left.Count) { $left | ForEach-Object { Write-Host "LEFT $_" }; exit 1 }
Write-Host ("clean: nothing of Harness is left. Checked: $root, the tasks '$task' and '$logonTask', the user PATH, the processes running " +
  "from $root\, the uninstall's temp files, notify.mjs in $($settingsFiles.Count) settings files, the [hooks.state] records " +
  "in $codexConfig, and $($hookFileList.Count) hook file(s) named by -HookFiles")
