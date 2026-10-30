# stage-zip.ps1 -Zip <zip> -To <folder> [-MarkOfTheWeb]: extract a Harness zip where a person would, as the test user
# (over SSH or in the session). The folder may hold a space, an apostrophe, &, % or ! (Review Focus 1): invoke.ps1
# hands it over unparsed. A relative path is under %USERPROFILE%. The folder is emptied first. -MarkOfTheWeb marks the
# zip and every program in it as downloaded from the internet (Zone.Identifier, ZoneId 3), as Explorer's Extract All
# does with a browser download, so SmartScreen sees them as it sees a person's download.
param([Parameter(Mandatory)][string]$Zip, [Parameter(Mandatory)][string]$To, [switch]$MarkOfTheWeb)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'ownership.ps1')
$owned = Assert-OwnedUser
$Zip = [Environment]::ExpandEnvironmentVariables($Zip)
$To = [Environment]::ExpandEnvironmentVariables($To)
if (-not [IO.Path]::IsPathRooted($Zip)) { $Zip = Join-Path $env:USERPROFILE $Zip }
if (-not [IO.Path]::IsPathRooted($To)) { $To = Join-Path $env:USERPROFILE $To }
if (-not (Test-Path -LiteralPath $Zip -PathType Leaf)) { Write-Output "no zip $Zip"; exit 1 }
$To = [IO.Path]::GetFullPath($To)
$profile = [IO.Path]::GetFullPath($owned.profile).TrimEnd('\') + '\'
if (-not $To.StartsWith($profile, [StringComparison]::OrdinalIgnoreCase)) { throw 'staging must stay inside the newly owned user profile' }
$marker = Join-Path $To '.harness-e2e-stage.json'
if (Test-Path -LiteralPath $To) {
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { throw 'existing staging destination is not owned by this run; left untouched' }
  $prior = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
  if ($prior.run_id -cne $owned.run_id -or $prior.sid -ne $owned.sid) { throw 'staging destination belongs to another run' }
}
$staged = $To + '.stage-' + [guid]::NewGuid().ToString('N')
$zone = "[ZoneTransfer]`r`nZoneId=3`r`n"
if ($MarkOfTheWeb) { Set-Content -LiteralPath $Zip -Stream Zone.Identifier -Value $zone }
Add-Type -AssemblyName System.IO.Compression.FileSystem
try {
  [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $staged)
  @{run_id=$owned.run_id;sid=$owned.sid} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $staged '.harness-e2e-stage.json') -Encoding ascii
  if (Test-Path -LiteralPath $To) { Remove-Item -LiteralPath $To -Recurse -Force }
  Move-Item -LiteralPath $staged -Destination $To
} finally {
  if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Recurse -Force }
}
if ($MarkOfTheWeb) {
  Get-ChildItem -LiteralPath $To -Recurse -File | Where-Object { $_.Extension -in '.exe', '.dll' } | ForEach-Object { Set-Content -LiteralPath $_.FullName -Stream Zone.Identifier -Value $zone }
}
Write-Output "extracted to $To"
Get-ChildItem -LiteralPath $To | ForEach-Object { "  $($_.Name)$(if ($_.PSIsContainer) { '\' })" }
$bytes = [IO.File]::ReadAllBytes((Join-Path $To 'current'))
$bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
Write-Output "current: '$([Text.Encoding]::UTF8.GetString($bytes).Trim())' ($($bytes.Length) bytes, BOM $bom)"
Write-Output "files: $(@(Get-ChildItem -LiteralPath $To -Recurse -File).Count); marked as downloaded: $([bool]$MarkOfTheWeb)"
