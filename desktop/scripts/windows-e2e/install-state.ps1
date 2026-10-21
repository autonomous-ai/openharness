# install-state.ps1 [-Lines 12] [-Downloaded <path under the profile>]: the Harness desktop install as this user has
# it, read-only (installer plan F4.2). What harness-install.exe and Harness.exe --install leave: the version folders
# and pointers, the shortcut, the harness:// and uninstall keys, how many installed files carry a Zone.Identifier (none:
# the installer writes its downloads itself), the browser's mark on the downloaded installer, the installer's temp
# folders, the running app, and the installer log's last lines.
param([int]$Lines = 12, [string]$Downloaded = 'Downloads\harness-install.exe')
$ErrorActionPreference = 'Stop'
$install = Join-Path $env:LOCALAPPDATA 'Programs\Harness'
"install: $install exists=$(Test-Path -LiteralPath $install)"
foreach ($name in 'current', 'previous') {
  $pointer = Join-Path $install $name
  if (Test-Path -LiteralPath $pointer) { "${name}: $((Get-Content -LiteralPath $pointer -Raw).Trim())" }
}
$apps = Join-Path $install 'app'
if (Test-Path -LiteralPath $apps) { "versions: $(@(Get-ChildItem -LiteralPath $apps -Directory | ForEach-Object Name) -join ', ')" }
"shortcut: $(Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'Harness.lnk'))"
"harness:// key: $(Test-Path -LiteralPath 'HKCU:\Software\Classes\harness\shell\open\command')"
$entry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Harness'
"uninstall entry: $(if (Test-Path -LiteralPath $entry) { (Get-ItemProperty -LiteralPath $entry).DisplayVersion } else { 'none' })"
$marked = @(if (Test-Path -LiteralPath $install) {
  Get-ChildItem -LiteralPath $install -Recurse -File | Where-Object { Get-Item -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue }
})
"installed files marked as downloaded: $($marked.Count)"
$download = Join-Path $env:USERPROFILE $Downloaded
if (Test-Path -LiteralPath $download) {
  $zone = @(Get-Content -LiteralPath $download -Stream Zone.Identifier -ErrorAction SilentlyContinue) -match '^ZoneId='
  "downloaded installer: $(if ($zone) { $zone -join ' ' } else { 'not marked' })"
} else { 'downloaded installer: none' }
"temp folders left: $(@(Get-ChildItem -LiteralPath $env:TEMP -Directory -Force -Filter '.harness-desktop-staging-*' -ErrorAction SilentlyContinue).Count)"
$running = @(Get-CimInstance Win32_Process -Filter "Name='harness-desktop.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith("$install\", 'OrdinalIgnoreCase') })
"running app: $(if ($running) { @($running | ForEach-Object { $_.ExecutablePath.Substring($install.Length + 1) }) -join ', ' } else { 'none' })"
$log = Join-Path $env:TEMP 'harness-install.log'
# The installer writes UTF-8 without a BOM, which Windows PowerShell 5.1 would read in the ANSI code page.
if (Test-Path -LiteralPath $log) { '--- harness-install.log'; Get-Content -LiteralPath $log -Tail $Lines -Encoding UTF8 }
