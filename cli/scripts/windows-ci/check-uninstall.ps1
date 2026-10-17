# Run as the user who installed Harness, after `harness uninstall --yes` (the Windows workflow's install job; the VM
# end to end, docs/testing/windows-cli-e2e.md scenario 7). Waits for the last step, the cmd.exe that removes ~\.harness
# once the CLI has exited, then lists everything of Harness's that is left, and exits 1 when anything is.
# -HookFiles: engine files Harness wrote outside ~\.harness (plugins), comma-separated, which must be gone.
param([int]$WaitSeconds = 120, [string]$HookFiles = '')
$root = Join-Path $env:USERPROFILE '.harness'
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Test-Path $root) -and (Get-Date) -lt $deadline) { Start-Sleep 1 }
$left = @()
if (Test-Path $root) { $left += "files: $root holds " + ((Get-ChildItem -Force -Recurse $root | Select-Object -First 20 | ForEach-Object FullName) -join ', ') }
$task = "Harness harnessd ($env:USERNAME)"   # harnessd/platform.ts taskName
schtasks.exe /Query /TN $task 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { $left += "task: $task is still registered" }
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
$raw = if ($k) { $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') } else { '' }
$bin = (Join-Path $root 'bin').ToLower()
foreach ($entry in ($raw -split ';')) {
  if ([Environment]::ExpandEnvironmentVariables($entry).Trim('"').TrimEnd('\').ToLower() -eq $bin) { $left += "PATH: $entry is still on the user PATH" }
}
foreach ($p in Get-CimInstance Win32_Process) {
  if ($p.ExecutablePath -and $p.ExecutablePath.ToLower().StartsWith($root.ToLower())) { $left += "process: $($p.Name) $($p.ProcessId) runs from $($p.ExecutablePath)" }
}
foreach ($f in Get-ChildItem -Path $env:TEMP -Filter 'harness-uninstall-*' -ErrorAction SilentlyContinue) {
  $left += "temp: $($f.FullName)" + $(if ($f.Extension -eq '.log') { ': ' + (Get-Content $f.FullName -Raw) } else { '' })
}
foreach ($settings in @('.claude\settings.json', '.codex\hooks.json') | ForEach-Object { Join-Path $env:USERPROFILE $_ }) {
  if ((Test-Path $settings) -and ((Get-Content $settings -Raw) -match 'notify\.mjs')) { $left += "hooks: $settings still runs notify.mjs" }
}
foreach ($file in ($HookFiles -split ',' | Where-Object { $_ })) { if (Test-Path $file) { $left += "hooks: $file is still there" } }
if ($left.Count) { $left | ForEach-Object { Write-Host "LEFT $_" }; exit 1 }
Write-Host 'clean: no file, task, PATH entry, process or hook of Harness is left'
