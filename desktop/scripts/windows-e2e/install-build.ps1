# install-build.ps1 -Zip <file>: install a zipped local manifest build into the owned profile (E5).
# Relative zip paths are under USERPROFILE. Disable updates to keep the measured build in place.
param([Parameter(Mandatory)][string]$Zip)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'ownership.ps1')
Assert-OwnedUser | Out-Null
$zipPath = if ([IO.Path]::IsPathRooted($Zip)) { $Zip } else { Join-Path $env:USERPROFILE $Zip }
if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) { throw 'build zip not found' }
$dir = Join-Path $env:USERPROFILE 'e2e\dial-build'
if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
Expand-Archive -LiteralPath $zipPath -DestinationPath $dir
$installer = Join-Path $dir 'install.ps1'
$manifest = Join-Path $dir 'install-manifest.json'
if (-not (Test-Path -LiteralPath $installer -PathType Leaf) -or -not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
  throw 'zip must contain install.ps1 and install-manifest.json at its root'
}
[Environment]::SetEnvironmentVariable('ADAPTER_UPDATE_DISABLE', 'true', 'User')
$env:ADAPTER_UPDATE_DISABLE = 'true'
# Windows PowerShell 5.1 can turn native stderr into error records; preserve the child's exit code.
$ErrorActionPreference = 'Continue'
$global:LASTEXITCODE = 1
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Manifest $manifest
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
"install.ps1 exited $code"
# Running version after a failed install would report the old build and mask the installer failure.
if ($code -ne 0) { exit $code }
$harness = Join-Path $env:USERPROFILE '.harness\bin\harness.exe'
if (-not (Test-Path -LiteralPath $harness -PathType Leaf)) { throw 'installed CLI not found' }
$ErrorActionPreference = 'Continue'
$global:LASTEXITCODE = 1
& $harness version
$code = $LASTEXITCODE
exit $code
