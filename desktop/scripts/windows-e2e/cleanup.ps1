# Remove only a newly created account's recorded SID, processes, tasks and profile. Shared state stays.
param([Parameter(Mandatory)][string]$User, [Parameter(Mandatory)][string]$RunId)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'ownership.ps1')
$owner = Read-Owner $User $RunId -AllowMissingAccount

function Get-OwnedProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
    try { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop).Sid -eq $owner.sid } catch { $false }
  })
}
function Task-Sid($Task) {
  $id = $Task.Principal.UserId
  if ($id -match '^S-1-') { return $id }
  return (New-Object Security.Principal.NTAccount($id)).Translate([Security.Principal.SecurityIdentifier]).Value
}

# The account did not exist before this run. Record exact process identities before any logoff/stop.
$processes = @(Get-OwnedProcesses)
$owner | Add-Member -NotePropertyName cleanup_processes -NotePropertyValue @($processes | Select-Object ProcessId, CreationDate, SessionId, Name) -Force
Save-Owner $owner
if (-not ('HxOwnedLogoff' -as [type])) {
  Add-Type -Namespace HxOwnedLogoff -Name Native -MemberDefinition '[DllImport("wtsapi32.dll")] public static extern bool WTSLogoffSession(IntPtr server, int session, bool wait);'
}
foreach ($session in @($processes | Where-Object { $_.Name -eq 'explorer.exe' } | ForEach-Object { $_.SessionId } | Sort-Object -Unique)) {
  if ($session -eq 0) { throw 'refusing to log off a noninteractive session' }
  if (-not [HxOwnedLogoff.Native]::WTSLogoffSession([IntPtr]::Zero, $session, $true)) { throw 'owned test session logoff failed' }
}
foreach ($recorded in $processes) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($recorded.ProcessId)"
  if ($p -and $p.CreationDate -eq $recorded.CreationDate -and
      (Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid).Sid -eq $owner.sid) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
  }
}
if (@(Get-OwnedProcesses).Count) { throw 'owned processes remain; receipts retained, do not remove the profile yet' }
Write-Output "processes of $User left: 0"

# Scheduler records identify tooling tasks. The CLI's task is additionally accepted only if absent at creation
# and its current principal is this new SID; a matching-looking preexisting task is never adopted.
$cliTask = "Harness harnessd ($User)"
$task = Get-ScheduledTask -TaskName $cliTask -ErrorAction SilentlyContinue
if ($task -and @($owner.baseline_tasks) -notcontains ($task.TaskPath + $task.TaskName)) {
  if ((Task-Sid $task) -eq $owner.sid) {
    $owner.tasks = @($owner.tasks) + @(@{name=$cliTask;script='owned-cli-service';created=$true})
    Save-Owner $owner
  }
}
foreach ($item in @($owner.tasks)) {
  $task = Get-ScheduledTask -TaskName $item.name -ErrorAction SilentlyContinue
  if (-not $task) { continue }
  if ($item.created -ne $true) { throw "task creation outcome needs inspection: $($item.name); left untouched" }
  if ((Task-Sid $task) -ne $owner.sid) { throw "recorded task principal changed: $($item.name); left untouched" }
  Stop-ScheduledTask -InputObject $task
  Unregister-ScheduledTask -InputObject $task -Confirm:$false
  Write-Output "removed owned task $($item.name)"
}
$sidHive = 'Registry::HKEY_USERS\' + $owner.sid
$classesHive = $sidHive + '_Classes'
$profile = Get-CimInstance Win32_UserProfile -Filter "SID='$($owner.sid)'"
if ($profile) {
  if ($profile.SID -ne $owner.sid) { throw 'profile SID changed; left untouched' }
  if (-not [string]::Equals($profile.LocalPath, $owner.profile, [StringComparison]::OrdinalIgnoreCase)) { throw 'profile path changed; left untouched' }
  if ($profile.Special -isnot [bool] -or $profile.Special) { throw 'owned profile is special or its status is unknown; account and receipts retained' }
  # Zero visible processes does not prove native profile readiness. Null RefCount is unknown,
  # not zero; require the actual Loaded flag and exact hive absence instead of a blind wait.
  if ($profile.Loaded -isnot [bool] -or $profile.Loaded) { throw 'owned profile is not explicitly unloaded; account and receipts retained; inspect the exact owned profile before retrying' }
}
if ((Test-Path -LiteralPath $sidHive) -or (Test-Path -LiteralPath $classesHive)) { throw 'owned profile hive is still present; account and receipts retained; inspect the exact owned SID before retrying' }
# Keep the account available if the provider still fails after the readiness check.
if ($profile) { $profile | Remove-CimInstance }
if (Test-Path -LiteralPath $owner.profile) { throw 'owned profile directory remains; inspect before retrying cleanup' }
if (Get-CimInstance Win32_UserProfile -Filter "SID='$($owner.sid)'") { throw 'owned profile registration remains' }
if ((Test-Path -LiteralPath $sidHive) -or (Test-Path -LiteralPath $classesHive)) { throw 'owned profile hive remains after deletion; account and receipts retained' }
$accounts = @(Get-LocalUser -ErrorAction Stop)
$account = $accounts | Where-Object { [string]::Equals($_.Name, $User, [StringComparison]::OrdinalIgnoreCase) }
if ($account) {
  if ($account.SID.Value -ne $owner.sid) { throw 'account was replaced; leave it alone' }
  Remove-LocalUser -Name $User
  Write-Output "user $User deleted"
}
$accounts = @(Get-LocalUser -ErrorAction Stop)
if ($accounts | Where-Object { [string]::Equals($_.Name, $User, [StringComparison]::OrdinalIgnoreCase) }) { throw 'account remains or was recreated; receipts retained for inspection' }
$owner | Add-Member -NotePropertyName cleaned -NotePropertyValue $true -Force
Save-Owner $owner
Write-Output 'owned profile removed; Winlogon, shared listeners, DNS/CA, services and unrelated accounts preserved'
