# invoke.ps1 -Script <file beside this one> [-ArgsB64 <base64 JSON object>]: run a script of this folder with the
# parameters desktop-e2e.sh encoded (e2e_tools.py args-b64), so no value passes through cmd's or ssh's quoting: a
# path with a space, an apostrophe, & or % reaches the script as it was typed. "true" and "false" become booleans
# (switches); a JSON array becomes an array parameter.
param([Parameter(Mandatory)][string]$Script, [string]$ArgsB64 = '', [Parameter(Mandatory)][string]$RunId)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
if ($Script -notmatch '^[a-z][a-z0-9-]*\.ps1$') { throw 'a script must be a file beside invoke.ps1' }
. (Join-Path $PSScriptRoot 'ownership.ps1')
$userReceipt = Join-Path $PSScriptRoot 'ownership.json'
if (Test-Path -LiteralPath $userReceipt) {
  $owner = Assert-OwnedUser
  if ($owner.run_id -cne $RunId) { throw 'test user belongs to another run' }
} else {
  $run = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'run.json') -Raw | ConvertFrom-Json
  if ($RunId -cnotmatch '^[0-9a-f]{32}$' -or $run.run_id -cne $RunId) { throw 'admin tools do not belong to this run' }
}
$target = Join-Path $PSScriptRoot $Script
if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { Write-Output "no script $target"; exit 2 }
$params = @{}
if ($ArgsB64) {
  $object = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgsB64)) | ConvertFrom-Json
  foreach ($p in $object.PSObject.Properties) {
    $value = $p.Value
    if ($value -is [string] -and $value -eq 'true') { $value = $true }
    elseif ($value -is [string] -and $value -eq 'false') { $value = $false }
    $params[$p.Name] = $value
  }
}
$global:LASTEXITCODE = 0
& $target @params
exit $LASTEXITCODE
