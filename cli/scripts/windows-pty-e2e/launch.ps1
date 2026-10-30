# Start the daemon outside the SSH session's job (WMI), so it outlives this connection.
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c C:\work\e2e\start.cmd'; CurrentDirectory = 'C:\work\e2e' }
"create rc=$($r.ReturnValue) pid=$($r.ProcessId)"
