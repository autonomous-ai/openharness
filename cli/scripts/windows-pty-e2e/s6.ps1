$ProgressPreference='SilentlyContinue'
$log = 'C:\work\e2e\s6.log'
function Say($m) { $l = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; $l | Tee-Object -FilePath $log -Append }
Remove-Item $log -ErrorAction SilentlyContinue
& C:\work\e2e\run.cmd s6snap before | Tee-Object -FilePath $log -Append
$reg = 'C:\work\e2e\data\registry.json'
$before = (Get-Content -Raw $reg | ConvertFrom-Json) | ? { $_.active } | % { "$($_.agentId.Substring(0,8)) $($_.processIdentity.pid) $($_.processIdentity.startMarker)" }
Say "identities before: $($before -join '; ')"
$sw = [Diagnostics.Stopwatch]::StartNew()
try {
  Set-Date (Get-Date).AddHours(3) | Out-Null
  Say "clock moved +3h"
  Start-Sleep 20
  & C:\work\e2e\run.cmd s6snap plus3h | Tee-Object -FilePath $log -Append
  $after = (Get-Content -Raw $reg | ConvertFrom-Json) | ? { $_.active } | % { "$($_.agentId.Substring(0,8)) $($_.processIdentity.pid) $($_.processIdentity.startMarker)" }
  Say "identities at +3h: $($after -join '; ')"
} finally {
  # Back by the hours moved, plus nothing for the elapsed time (the stopwatch keeps real time).
  Set-Date (Get-Date).AddHours(-3) | Out-Null
  Say "clock moved back (-3h); stopwatch $([int]$sw.Elapsed.TotalSeconds) s"
}
Start-Sleep 15
& C:\work\e2e\run.cmd s6snap back | Tee-Object -FilePath $log -Append
$back = (Get-Content -Raw $reg | ConvertFrom-Json) | ? { $_.active } | % { "$($_.agentId.Substring(0,8)) $($_.processIdentity.pid) $($_.processIdentity.startMarker)" }
Say "identities after: $($back -join '; ')"
Say "now: $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))"
