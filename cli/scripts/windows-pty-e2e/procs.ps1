$ProgressPreference='SilentlyContinue'
Get-CimInstance Win32_Process | ? { ($_.Name -match 'harness-pty|claude|powershell|OpenConsole|node' -and $_.CommandLine -notmatch 'WindowsTerminal|EncodedCommand|mcp\\server|e2e\.mjs') } |
  Select ProcessId,ParentProcessId,Name,@{n='Start';e={$_.CreationDate.ToString('HH:mm:ss')}},@{n='Cmd';e={ $x=$_.CommandLine; if ($x.Length -gt 90) { $x.Substring(0,90) } else { $x } }} | Sort-Object ParentProcessId | Format-Table -AutoSize | Out-String -Width 200
