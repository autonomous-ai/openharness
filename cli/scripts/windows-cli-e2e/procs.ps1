# procs.ps1 -User <name>: the Harness processes of one local user (master, core, services, terminal host, ConPTY, shells,
# engines): pid, parent, start time and command line, oldest first.
param([Parameter(Mandatory)][string]$User)
$ProgressPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|harness-pty|harness-launch|OpenConsole|powershell|pwsh|claude|codex|opencode|kilo)\.exe$' } |
  Where-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq $User } |
  Sort-Object CreationDate |
  Select-Object ProcessId, ParentProcessId, Name, @{ n = 'Start'; e = { $_.CreationDate.ToString('HH:mm:ss') } }, @{ n = 'Cmd'; e = { $c = $_.CommandLine; if ($c.Length -gt 110) { $c.Substring(0, 110) } else { $c } } } |
  Format-Table -AutoSize | Out-String -Width 220
