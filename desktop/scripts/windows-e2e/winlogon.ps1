# Read-only Winlogon diagnostic. Shared VM session setup belongs to root's observed console transaction.
param([switch]$Enable, [switch]$Disable, [switch]$Status, [string]$User, [string]$PasswordB64, [string]$StateDir)
$ErrorActionPreference = 'Stop'
if ($Enable -or $Disable -or -not $Status) {
  Write-Error 'unavailable: this tooling preserves global Winlogon; establish the owned active unlocked desktop without reboot or admin signout'
  exit 3
}
$key = Get-Item -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
foreach ($name in 'AutoAdminLogon', 'DefaultUserName', 'DefaultDomainName', 'AutoLogonCount', 'ForceAutoLogon') {
  if ($key.GetValueNames() -contains $name) { Write-Output "$name : $($key.GetValue($name))" }
  else { Write-Output "$name : (absent)" }
}
# Never read or echo an existing autologon password.
Write-Output "DefaultPassword present: $($key.GetValueNames() -contains 'DefaultPassword')"
