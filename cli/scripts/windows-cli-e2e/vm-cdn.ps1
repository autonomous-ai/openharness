# vm-cdn.ps1: point this Windows machine at the fake CDN on the Mac (fake-cdn.sh serve), and back again. Run it as an
# administrator (vm.sh admin vm-cdn.ps1 ...), because the hosts file and LocalMachine\Root are machine-wide.
#   vm-cdn.ps1 -Enable [-CaCert <pem>] [-Address 192.168.65.1]
#       adds one marked hosts line each for cdn.autonomous.ai and storage.googleapis.com, and imports the fake CA
#   vm-cdn.ps1 -Disable    removes exactly those lines (the hosts file is then byte-identical) and that CA, by thumbprint
#   vm-cdn.ps1 -Status     what is in place now
#   vm-cdn.ps1 -SelfTest   checks the hosts edit on bytes in memory; the real hosts file is not touched
# Enable records what it changed in C:\ProgramData\harness-fake-cdn (state.json, hosts.before) and refuses to run twice.
param(
  [switch]$Enable,
  [switch]$Disable,
  [switch]$Status,
  [switch]$SelfTest,
  [string]$CaCert = (Join-Path $PSScriptRoot 'fake-cdn-ca.pem'),
  [string]$Address = '192.168.65.1',
  [string]$StateDir = (Join-Path $env:ProgramData 'harness-fake-cdn'),
  [string]$HostsFile = (Join-Path $env:SystemRoot 'System32\drivers\etc\hosts')
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Marker = '# harness fake CDN (vm-cdn.ps1)'
$Names = @('cdn.autonomous.ai', 'storage.googleapis.com')
# ISO-8859-1 maps each byte to one character and back, so text operations never change a byte they do not touch.
$Latin1 = [Text.Encoding]::GetEncoding(28591)
$StatePath = Join-Path $StateDir 'state.json'
$BackupPath = Join-Path $StateDir 'hosts.before'

function Get-Sha256Hex([byte[]]$Bytes) {
  # .NET, not Get-FileHash: under a PowerShell 7 PSModulePath, 5.1 cannot find it (install.ps1 Get-HarnessSha256).
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
}

function Get-HostsBlock([byte[]]$Before, [string]$To) {
  # The bytes Enable appends: a line break first when the file does not end with one, then one marked line per name.
  $text = ''
  if ($Before.Length -gt 0 -and $Before[$Before.Length - 1] -ne 10) { $text = "`r`n" }
  foreach ($name in $Names) { $text += "$To $name $Marker`r`n" }
  return , $Latin1.GetBytes($text)
}

function Join-Bytes([byte[]]$First, [byte[]]$Second) {
  $out = New-Object byte[] ($First.Length + $Second.Length)
  [Array]::Copy($First, 0, $out, 0, $First.Length)
  [Array]::Copy($Second, 0, $out, $First.Length, $Second.Length)
  return , $out
}

function Remove-HostsBlock([byte[]]$After, [byte[]]$Block) {
  # The file without exactly what Enable appended, while it still ends with those bytes; $null once anything after
  # Enable has changed the end of the file.
  $n = $After.Length - $Block.Length
  if ($n -lt 0) { return $null }
  for ($i = 0; $i -lt $Block.Length; $i++) { if ($After[$n + $i] -ne $Block[$i]) { return $null } }
  $out = New-Object byte[] $n
  [Array]::Copy($After, 0, $out, 0, $n)
  return , $out
}

function Remove-MarkedLines([byte[]]$Bytes) {
  # The fallback when the file changed after Enable: every line carrying the marker goes, and nothing else.
  $pattern = '(?m)^[^\r\n]*' + [regex]::Escape($Marker) + '[^\r\n]*(\r?\n|$)'
  return , $Latin1.GetBytes(([regex]::Replace($Latin1.GetString($Bytes), $pattern, '')))
}

function Test-SameBytes([byte[]]$A, [byte[]]$B) {
  if ($null -eq $A -or $null -eq $B) { return $false }
  return (Get-Sha256Hex $A) -eq (Get-Sha256Hex $B)
}

function Get-RootStore([string]$Mode) {
  $store = New-Object Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine')
  $store.Open($Mode)
  return $store
}

function Test-CaPresent([string]$Thumbprint) {
  $store = Get-RootStore 'ReadOnly'
  try { return $store.Certificates.Find('FindByThumbprint', $Thumbprint, $false).Count -gt 0 } finally { $store.Close() }
}

function Write-State($State) { $State | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding ascii }

function Invoke-SelfTest {
  $script:failed = 0
  $check = {
    param([string]$What, [bool]$Ok)
    if ($Ok) { Write-Output "PASS $What" } else { Write-Output "FAIL $What"; $script:failed++ }
  }
  $cases = [ordered]@{
    'CRLF, ending in a line break' = "127.0.0.1 localhost`r`n# a comment`r`n"
    'CRLF, no final line break'   = "# Copyright`r`n127.0.0.1 localhost"
    'LF only'                     = "127.0.0.1 localhost`n"
    'empty'                       = ''
  }
  foreach ($case in $cases.Keys) {
    [byte[]]$before = $Latin1.GetBytes($cases[$case])
    [byte[]]$block = Get-HostsBlock $before '192.168.65.1'
    [byte[]]$after = Join-Bytes $before $block
    $text = $Latin1.GetString($after)
    & $check "${case}: Enable adds one marked line per name" (([regex]::Matches($text, [regex]::Escape($Marker))).Count -eq $Names.Count)
    & $check "${case}: the original bytes are a prefix of the result" ($text.StartsWith($cases[$case]))
    & $check "${case}: Disable restores the bytes exactly" (Test-SameBytes (Remove-HostsBlock $after $block) $before)
    [byte[]]$edited = Join-Bytes $after $Latin1.GetBytes("10.0.0.1 added.later`r`n")
    & $check "${case}: a file changed after Enable is not cut by length" ($null -eq (Remove-HostsBlock $edited $block))
    $fallback = $Latin1.GetString((Remove-MarkedLines $edited))
    & $check "${case}: the fallback removes only the marked lines" (-not $fallback.Contains($Marker) -and $fallback.EndsWith("10.0.0.1 added.later`r`n") -and $fallback.StartsWith($cases[$case]))
  }
  [byte[]]$high = 0..255 | ForEach-Object { [byte]$_ }
  & $check 'every byte value survives the text fallback' (Test-SameBytes (Remove-MarkedLines $high) $high)
  if ($script:failed) { Write-Output "$($script:failed) check(s) failed"; exit 1 }
  Write-Output 'self-test passed'
}

function Show-Status {
  [byte[]]$bytes = [IO.File]::ReadAllBytes($HostsFile)
  Write-Output "hosts sha256 $(Get-Sha256Hex $bytes) ($($bytes.Length) bytes)"
  $lines = @($Latin1.GetString($bytes) -split "`r?`n" | Where-Object { $_.Contains($Marker) })
  if ($lines.Count) { $lines | ForEach-Object { Write-Output "hosts line: $_" } } else { Write-Output 'hosts: no fake CDN line' }
  if (Test-Path -LiteralPath $StatePath) {
    $state = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
    Write-Output "enabled at $($state.enabledAt) for $($state.address); hosts before $($state.hostsBefore)"
    Write-Output "CA $($state.thumbprint) in LocalMachine\Root: $(Test-CaPresent $state.thumbprint)"
  } else {
    Write-Output 'not enabled (no state file)'
  }
  $store = Get-RootStore 'ReadOnly'
  try {
    $left = @($store.Certificates | Where-Object { $_.Subject -like 'CN=Harness fake CDN test CA*' })
    Write-Output "fake CDN CAs in LocalMachine\Root: $($left.Count)"
  } finally { $store.Close() }
}

function Enable-FakeCdn {
  if (Test-Path -LiteralPath $StatePath) { throw "The fake CDN is already enabled ($StatePath). Run vm-cdn.ps1 -Disable first." }
  [byte[]]$before = [IO.File]::ReadAllBytes($HostsFile)
  if ($Latin1.GetString($before).Contains($Marker)) { throw "$HostsFile already has fake CDN lines but there is no state file. Remove them by hand." }
  if (-not (Test-Path -LiteralPath $CaCert -PathType Leaf)) { throw "The CA certificate $CaCert does not exist. Copy it first: vm.sh admin fake-cdn-ca.pem" }
  $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList (Resolve-Path -LiteralPath $CaCert).ProviderPath
  if ($cert.Subject -notlike 'CN=Harness fake CDN test CA*') { throw "$CaCert is not the fake CDN's CA ($($cert.Subject))." }
  [byte[]]$block = Get-HostsBlock $before $Address
  [byte[]]$after = Join-Bytes $before $block
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  [IO.File]::WriteAllBytes($BackupPath, $before)
  # The state is written before anything changes, so -Disable can undo a run that stopped halfway.
  $state = [ordered]@{
    enabledAt = (Get-Date).ToString('s'); address = $Address; hostsFile = $HostsFile
    hostsBefore = (Get-Sha256Hex $before); hostsAfter = (Get-Sha256Hex $after); block = [Convert]::ToBase64String($block)
    thumbprint = $cert.Thumbprint; subject = $cert.Subject; caAdded = $false
  }
  Write-State $state
  [IO.File]::WriteAllBytes($HostsFile, $after)
  if (Test-CaPresent $cert.Thumbprint) {
    Write-Output "CA $($cert.Thumbprint) was already in LocalMachine\Root: -Disable leaves it"
  } else {
    # Intent first: the state says the CA is ours before it is added, so a run stopped between the two still has
    # -Disable remove it. -Disable removes it only when it is there, and a CA that was there before -Enable never
    # gets this mark.
    $state.caAdded = $true
    Write-State $state
    $store = Get-RootStore 'ReadWrite'
    try { $store.Add($cert) } finally { $store.Close() }
  }
  ipconfig.exe /flushdns | Out-Null
  Write-Output "hosts sha256 before $($state.hostsBefore)"
  Write-Output "hosts sha256 after  $($state.hostsAfter)"
  foreach ($name in $Names) { Write-Output "$name -> $Address" }
  Write-Output "CA $($cert.Thumbprint) ($($cert.Subject)) in LocalMachine\Root"
}

function Disable-FakeCdn {
  if (-not (Test-Path -LiteralPath $StatePath)) {
    if ($Latin1.GetString([IO.File]::ReadAllBytes($HostsFile)).Contains($Marker)) { throw "No state file, yet $HostsFile has fake CDN lines. Remove them by hand." }
    Write-Output 'The fake CDN is not enabled: nothing to do.'
    return
  }
  $state = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
  [byte[]]$current = [IO.File]::ReadAllBytes($HostsFile)
  [byte[]]$backup = [IO.File]::ReadAllBytes($BackupPath)
  [byte[]]$block = [Convert]::FromBase64String($state.block)
  $same = $false
  $fallback = $false
  if ((Get-Sha256Hex $current) -eq $state.hostsAfter -and (Get-Sha256Hex $backup) -eq $state.hostsBefore) {
    [IO.File]::WriteAllBytes($HostsFile, $backup)
  } elseif ((Get-Sha256Hex $current) -eq $state.hostsBefore) {
    Write-Output 'hosts was already back to its bytes before -Enable'
  } else {
    $restored = Remove-HostsBlock $current $block
    if ($null -eq $restored) {
      Write-Warning "$HostsFile changed after -Enable: only the marked lines are removed. The original is kept in $BackupPath."
      $restored = Remove-MarkedLines $current
      $fallback = $true
    }
    [IO.File]::WriteAllBytes($HostsFile, [byte[]]$restored)
  }
  $now = Get-Sha256Hex ([IO.File]::ReadAllBytes($HostsFile))
  $same = $now -eq $state.hostsBefore
  Write-Output "hosts sha256 before -Enable $($state.hostsBefore)"
  Write-Output "hosts sha256 now           $now"
  Write-Output "hosts byte-identical: $same"
  if ($state.caAdded -and (Test-CaPresent $state.thumbprint)) {
    $store = Get-RootStore 'ReadWrite'
    try {
      foreach ($cert in @($store.Certificates.Find('FindByThumbprint', $state.thumbprint, $false))) { $store.Remove($cert) }
    } finally { $store.Close() }
  }
  $present = Test-CaPresent $state.thumbprint
  Write-Output "CA $($state.thumbprint) in LocalMachine\Root: $present"
  ipconfig.exe /flushdns | Out-Null
  if ($same -and (-not $state.caAdded -or -not $present)) {
    Remove-Item -LiteralPath $StatePath, $BackupPath -Force
    if (-not (Get-ChildItem -LiteralPath $StateDir -Force)) { Remove-Item -LiteralPath $StateDir -Force }
    Write-Output 'disabled'
  } else {
    Write-Output "not fully restored: the state is kept in $StateDir"
    if ($fallback) {
      Write-Output "Compare $HostsFile with $BackupPath and fix it by hand. Then delete $StatePath and $BackupPath, or -Enable will refuse to run."
    }
    exit 1
  }
}

$chosen = @($Enable, $Disable, $Status, $SelfTest | Where-Object { $_ }).Count
if ($chosen -ne 1) { Write-Output 'usage: vm-cdn.ps1 -Enable [-CaCert <pem>] [-Address <ip>] | -Disable | -Status | -SelfTest'; exit 2 }
if ($SelfTest) { Invoke-SelfTest; exit 0 }
if ($Status) { Show-Status; exit 0 }
if ($Enable) { Enable-FakeCdn }
if ($Disable) { Disable-FakeCdn }
