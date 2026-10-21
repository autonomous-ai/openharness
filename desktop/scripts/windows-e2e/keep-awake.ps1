# keep-awake.ps1 [-Stop] [-Hours 8]: keep this owned session's display awake; it does not unlock a locked desktop. Run in the
# session with session-run.ps1 -NoWait (it keeps running). A locked screen would turn the screenshots black and drop
# the input. No power setting changes: SetThreadExecutionState holds only while this process lives. -Stop ends it,
# through a stop file beside this script.
param([switch]$Stop, [int]$Hours = 8)
. (Join-Path $PSScriptRoot 'ownership.ps1')
Assert-OwnedSession | Out-Null
$stopFile = Join-Path $PSScriptRoot 'keep-awake.stop'
if ($Stop) { Set-Content -LiteralPath $stopFile -Value 'stop' -Encoding ascii; Write-Output 'keep-awake asked to stop'; exit 0 }
Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
Add-Type -Namespace HxE2E -Name Awake -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
[HxE2E.Awake]::SetThreadExecutionState([uint32]2147483651) | Out-Null
$end = (Get-Date).AddHours($Hours)
while ((Get-Date) -lt $end -and -not (Test-Path -LiteralPath $stopFile)) { Start-Sleep -Seconds 5 }
Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
Write-Output 'keep-awake ended'
