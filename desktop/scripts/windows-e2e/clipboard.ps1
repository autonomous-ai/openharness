# clipboard.ps1 -Image [-AsPng] | -Files <path>... | -Text <text> | -Read: put something on the clipboard as a person
# would copy it, in the desktop session (session-run.ps1; the clipboard belongs to the session). -Image draws a 480x270
# picture with a marker and the time and copies it as a bitmap (CF_DIB); -AsPng also offers the registered "PNG"
# format, the one Harness reads first. The picture is saved as shots\paste-source.png for the evidence. -Files copies
# files as Explorer does (CF_HDROP). -Read lists the formats now on the clipboard, and its text if any.
param([switch]$Image, [switch]$AsPng, [string[]]$Files, [string]$Text, [switch]$Read)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ownership.ps1')
Assert-OwnedSession | Out-Null
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { Write-Output 'the clipboard needs an STA thread (Windows PowerShell 5.1 runs STA)'; exit 2 }
if ($Image) {
  $bitmap = New-Object System.Drawing.Bitmap 480, 270
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.Clear([System.Drawing.Color]::FromArgb(255, 32, 96, 160))
  $owned = Assert-OwnedUser
  $marker = 'HX_E2E_' + $owned.run_id + '_' + [guid]::NewGuid().ToString('N')
  $g.DrawString($marker, (New-Object System.Drawing.Font 'Segoe UI', 28), [System.Drawing.Brushes]::White, 24, 100)
  $g.Dispose()
  $png = Join-Path $PSScriptRoot 'shots\paste-source.png'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $png) | Out-Null
  $bitmap.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
  $data = New-Object System.Windows.Forms.DataObject
  $data.SetImage($bitmap)
  if ($AsPng) { $data.SetData('PNG', $false, (New-Object IO.MemoryStream (, [IO.File]::ReadAllBytes($png)))) }
  [System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
  Write-Output "clipboard: image '$marker' $(if ($AsPng) { '(PNG and bitmap)' } else { '(bitmap only)' })"
} elseif ($Files) {
  $list = New-Object System.Collections.Specialized.StringCollection
  foreach ($f in $Files) {
    $full = [Environment]::ExpandEnvironmentVariables($f)
    if (-not (Test-Path -LiteralPath $full)) { Write-Output "no file $full"; exit 1 }
    [void]$list.Add((Resolve-Path -LiteralPath $full).ProviderPath)
  }
  [System.Windows.Forms.Clipboard]::SetFileDropList($list)
  Write-Output "clipboard: $($list.Count) file(s), as Explorer copies them"
} elseif ($Text) {
  [System.Windows.Forms.Clipboard]::SetText($Text)
  Write-Output "clipboard: text, $($Text.Length) characters"
}
if ($Read -or -not ($Image -or $Files -or $Text)) {
  $now = [System.Windows.Forms.Clipboard]::GetDataObject()
  Write-Output "formats: $((@($now.GetFormats()) | Sort-Object) -join ', ')"
  if ($now.GetDataPresent('Text')) { Write-Output "text: $([System.Windows.Forms.Clipboard]::GetText().Length) characters (contents omitted)" }
}
