# Shared run receipts and session checks. Dot-source for functions; -Probe verifies this user's input desktop.
param([Alias('Probe')][switch]$OwnershipProbe)

function Read-Owner([string]$User, [string]$RunId, [switch]$AllowMissingAccount) {
  if ($User -notmatch '^hx[a-z0-9]+$' -or $RunId -cnotmatch '^[0-9a-f]{32}$') { throw 'invalid test run identity' }
  $path = Join-Path $PSScriptRoot "users\$User.json"
  $owner = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  if ($owner.run_id -cne $RunId -or $owner.user -cne $User -or $owner.created -ne $true -or
      $owner.sid -notmatch '^S-1-5-21-(\d+-){3}\d+$' -or -not $owner.profile) {
    throw 'no matching new-account receipt; never adopt an existing account'
  }
  $account = Get-LocalUser -Name $User -ErrorAction SilentlyContinue
  if (-not $account) {
    if (-not $AllowMissingAccount) { throw 'the owned test account no longer exists' }
  } elseif ($account.SID.Value -ne $owner.sid) { throw 'the account SID changed; leave the replacement account alone' }
  $admins = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop)
  if ($admins | Where-Object { $_.SID.Value -eq $owner.sid }) { throw 'refusing an administrator account' }
  return $owner
}

function Save-Owner($Owner) {
  $path = Join-Path $PSScriptRoot "users\$($Owner.user).json"
  $temp = "$path.new"
  $Owner | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temp -Encoding utf8
  Move-Item -LiteralPath $temp -Destination $path -Force
}

function Record-OwnedTask([string]$User, [string]$RunId, [string]$Name, [string]$Script, [bool]$Created) {
  # Watchers and input commands can be dispatched together; never lose a concurrent task's receipt.
  $mutex = New-Object Threading.Mutex($false, ('Local\HxDesktopE2EOwner-' + $RunId + '-' + $User))
  $locked = $false
  try {
    try { $locked = $mutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'timed out waiting for the owned task ledger' }
    $receipt = Read-Owner $User $RunId
    $receipt.tasks = @($receipt.tasks | Where-Object { $_.name -cne $Name }) + @(@{name=$Name;script=$Script;created=$Created})
    Save-Owner $receipt
  } finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

function Assert-OwnedUser {
  $path = Join-Path $PSScriptRoot 'ownership.json'
  $owner = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($owner.created -ne $true -or $owner.sid -ne $sid -or $owner.user -cne $env:USERNAME -or
      $owner.run_id -cnotmatch '^[0-9a-f]{32}$' -or
      -not [string]::Equals([IO.Path]::GetFullPath($owner.profile), [IO.Path]::GetFullPath($env:USERPROFILE), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'this process is not the newly created test user from the ownership receipt'
  }
  return $owner
}

function Assert-OwnedSession {
  $owner = Assert-OwnedUser
  if (-not ('HxOwnedDesktop' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class HxOwnedDesktop {
  [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder name, int length, out int needed);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  public static bool Unlocked() {
    IntPtr h = OpenInputDesktop(0, false, 0x101);
    if (h == IntPtr.Zero) return false;
    try {
      int needed;
      var name = new StringBuilder(512);
      return GetUserObjectInformation(h, 2, name, name.Capacity * 2, out needed) && name.ToString() == "Default";
    } finally { CloseDesktop(h); }
  }
}
'@
  }
  $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
  if ($session -eq 0 -or $session -ne [HxOwnedDesktop]::WTSGetActiveConsoleSessionId() -or -not [HxOwnedDesktop]::Unlocked()) {
    throw 'the owned test desktop must be active and unlocked; root must establish it without reboot or admin signout'
  }
  return $owner
}

if ($MyInvocation.InvocationName -ne '.') {
  $ErrorActionPreference = 'Stop'
  if (-not $OwnershipProbe) { throw 'use ownership.ps1 -Probe in the owned interactive session' }
  $owner = Assert-OwnedSession
  Write-Output "owned active unlocked desktop: $($owner.user), SID $($owner.sid), session $([Diagnostics.Process]::GetCurrentProcess().SessionId)"
}
