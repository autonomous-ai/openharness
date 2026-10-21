# desktop-procs.ps1 -User <name>: the Harness processes of one local user, oldest first: the desktop app
# (harness-desktop.exe) and its launcher (Harness.exe), the CLI (harness.exe, node.exe), the terminal host with its
# consoles and shells, and engines. Run as an administrator: WMI answers a standard user only in a desktop or batch
# logon, never over SSH (B5.12).
param([Parameter(Mandatory)][string]$User, [Parameter(Mandatory)][string]$RunId)
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'ownership.ps1')
$owner = Read-Owner $User $RunId
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match '^(harness-desktop|harness|node|harness-pty|harness-launch|OpenConsole|conhost|powershell|pwsh|cmd|kilo)\.exe$' } |
  Where-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $owner.sid } |
  Sort-Object CreationDate |
  Select-Object ProcessId, ParentProcessId, Name, @{ n = 'Start'; e = { $_.CreationDate.ToString('HH:mm:ss') } }, @{ n = 'Cmd'; e = { $c = [string]$_.CommandLine; if ($c.Length -gt 120) { $c.Substring(0, 120) } else { $c } } } |
  Format-Table -AutoSize | Out-String -Width 240
