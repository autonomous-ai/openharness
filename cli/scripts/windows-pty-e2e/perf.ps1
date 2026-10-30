param([string]$Label, [int]$Seconds = 60)
$ProgressPreference='SilentlyContinue'
$hostProc = Get-Process harness-pty
$core = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -match 'harnessd-core|__run' } | Select -First 1
$coreProc = Get-Process -Id $core.ProcessId
$oc0 = @{}; Get-Process OpenConsole -ErrorAction SilentlyContinue | ? { $_.Path -like 'C:\work\e2e\*' } | % { $oc0[$_.Id] = $_.TotalProcessorTime.TotalMilliseconds }
$h0 = $hostProc.TotalProcessorTime.TotalMilliseconds; $c0 = $coreProc.TotalProcessorTime.TotalMilliseconds
$samples = Get-Counter '\Process(harness-pty)\% Processor Time' -SampleInterval 1 -MaxSamples $Seconds
$hostProc.Refresh(); $coreProc.Refresh()
$vals = $samples.CounterSamples | % { $_.CookedValue }
$avg = ($vals | Measure-Object -Average).Average; $max = ($vals | Measure-Object -Maximum).Maximum
$h1 = $hostProc.TotalProcessorTime.TotalMilliseconds; $c1 = $coreProc.TotalProcessorTime.TotalMilliseconds
$ocs = Get-Process OpenConsole -ErrorAction SilentlyContinue | ? { $_.Path -like 'C:\work\e2e\*' }
$ocCpu = 0; $ocWs = 0; foreach ($p in $ocs) { $ocCpu += $p.TotalProcessorTime.TotalMilliseconds - ($oc0[$p.Id] | ForEach-Object { $_ }); $ocWs += $p.WorkingSet64 }
$cpus = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
[pscustomobject]@{
  label = $Label; panes = $ocs.Count; seconds = $Seconds; logicalCpus = $cpus
  hostCounterAvgPct = [math]::Round($avg, 2); hostCounterMaxPct = [math]::Round($max, 2)
  hostCpuTimePct = [math]::Round(($h1 - $h0) / ($Seconds * 10), 2)
  hostWorkingSetMB = [math]::Round($hostProc.WorkingSet64 / 1MB, 1); hostPrivateMB = [math]::Round($hostProc.PrivateMemorySize64 / 1MB, 1)
  openConsoleCpuTimePct = [math]::Round($ocCpu / ($Seconds * 10), 2); openConsoleWorkingSetMB = [math]::Round($ocWs / 1MB, 1)
  daemonCoreCpuTimePct = [math]::Round(($c1 - $c0) / ($Seconds * 10), 2); daemonCoreWorkingSetMB = [math]::Round($coreProc.WorkingSet64 / 1MB, 1)
} | ConvertTo-Json -Compress
