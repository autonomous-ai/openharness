# browser-link.ps1 -Url <harness://...>: a page holding that link, opened in Microsoft Edge in the desktop session
# (session-run.ps1), for the "a link opens from a browser" check. Clicking the link and Edge's "Open Harness?" prompt
# come next (uia.ps1 -Root All -Find 'Open in Harness' -Do Invoke, then -Find 'Open' -Type Button -Do Invoke), or a
# person does them. Edge's first-run pages are skipped where its flags allow.
param([Parameter(Mandatory)][string]$Url)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ownership.ps1')
Assert-OwnedSession | Out-Null
$page = Join-Path $PSScriptRoot 'link.html'
$safe = [Net.WebUtility]::HtmlEncode($Url)
"<!doctype html><meta charset=utf-8><title>Harness link</title><p><a id=hx href=`"$safe`">Open in Harness</a></p>" | Set-Content -LiteralPath $page -Encoding utf8
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edge) { Write-Output 'Microsoft Edge is not installed here'; exit 1 }
Start-Process -FilePath $edge -ArgumentList @('--no-first-run', '--no-default-browser-check', ('"' + ([Uri]$page).AbsoluteUri + '"'))
Write-Output "Edge opened $page, with a link to $Url"
