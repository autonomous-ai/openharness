# vm-cdn-user.ps1 -Enable [-CaCert <pem>] | -Disable | -Status: NODE_EXTRA_CA_CERTS for THIS user only
# (HKCU\Environment), so the installed CLI's own HTTPS fetches (the self-update of docs/testing/windows-cli-e2e.md,
# scenarios 3 and 4) trust the fake CDN's CA. Windows PowerShell trusts it through LocalMachine\Root (vm-cdn.ps1); Node
# reads only its own CA list and this variable. Run it as the test user, after copying the CA beside it:
#   vm.sh <user> .fake-cdn/ca/fake-cdn-ca.pem && vm.sh <user> vm-cdn-user.ps1 -Enable
# The value is read by processes started after it is set: a new SSH session, and the daemon it starts. -Disable puts
# back what was there before -Enable (usually nothing), and only if the value is still the one -Enable set.
param([switch]$Enable, [switch]$Disable, [switch]$Status, [string]$CaCert = (Join-Path $PSScriptRoot 'fake-cdn-ca.pem'))
$ErrorActionPreference = 'Stop'
$Name = 'NODE_EXTRA_CA_CERTS'
$Key = 'HKCU:\Environment'
$StatePath = Join-Path $PSScriptRoot 'fake-cdn-user.json'

function Get-UserValue {
  $item = Get-ItemProperty -Path $Key -Name $Name -ErrorAction SilentlyContinue
  if ($item) { return [string]$item.$Name }
  return $null
}

$chosen = @($Enable, $Disable, $Status | Where-Object { $_ }).Count
if ($chosen -ne 1) { Write-Output 'usage: vm-cdn-user.ps1 -Enable [-CaCert <pem>] | -Disable | -Status'; exit 2 }

if ($Status) {
  Write-Output "$env:USERNAME ${Name}: '$(Get-UserValue)'; state file: $(Test-Path -LiteralPath $StatePath)"
  exit 0
}

if ($Enable) {
  if (Test-Path -LiteralPath $StatePath) { throw "$Name is already set by this script ($StatePath). Run -Disable first." }
  if (-not (Test-Path -LiteralPath $CaCert -PathType Leaf)) { throw "The CA certificate $CaCert does not exist." }
  $value = (Resolve-Path -LiteralPath $CaCert).ProviderPath
  $previous = Get-UserValue
  @{ previous = $previous; value = $value } | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding ascii
  Set-ItemProperty -Path $Key -Name $Name -Value $value -Type String
  Write-Output "$env:USERNAME ${Name} = $value (before: '$previous')"
  exit 0
}

if (-not (Test-Path -LiteralPath $StatePath)) { Write-Output "$Name was not set by this script: nothing to do."; exit 0 }
$state = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
$current = Get-UserValue
if ($current -ne $state.value) {
  Write-Warning "$Name changed after -Enable ('$current'): it is left as it is."
} elseif ($state.previous) {
  Set-ItemProperty -Path $Key -Name $Name -Value $state.previous -Type String
} else {
  Remove-ItemProperty -Path $Key -Name $Name
}
Remove-Item -LiteralPath $StatePath -Force
Write-Output "$env:USERNAME ${Name}: '$(Get-UserValue)'"
