# parse-check.ps1: every .ps1 beside this one parses in this machine's Windows PowerShell 5.1, or its errors are listed.
$failed = 0
foreach ($f in Get-ChildItem -LiteralPath $PSScriptRoot -Filter *.ps1) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count) { $failed++; foreach ($e in $errors) { Write-Output "FAIL $($f.Name):$($e.Extent.StartLineNumber) $($e.Message)" } }
  else { Write-Output "ok   $($f.Name)" }
}
Write-Output "$failed file(s) with parse errors"
exit $failed
