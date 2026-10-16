# The Harness CLI on native Windows: end-to-end results

## B3 lifecycle

Date: 2026-10-16. Branch `feat/windows-native-cli` at `ff0705990`, with the two real specs of Task B3.21 on top.
Machine: the UTM VM (Windows 11 ARM64, build 26100), `ssh admin@192.168.65.3`. The times in the log excerpts are
the VM's clock.

**Build under test.**
- The pty binaries were built on the VM from this branch: `cargo +stable build --locked --release` with
  `HARNESS_PTY_VERSION=0.4.91`. This includes the `harness-launch.exe` that inherits no handles (`5a9c0c56c`).
- Four CLI bundles were built from this tree with `ADAPTER_VERSION`: N `0.4.91-b3`, N+1 `0.4.92-b3`,
  N+2 `0.4.93-b3` and N+3 `0.4.94-b3`. Each patch number is distinct because `semverGt` compares only
  major.minor.patch. None is a `-dev` build, which an automatic update would leave alone.
- N+2 is the same build with `if(process.argv[2]==="__run")process.exit(3);` put first in `cli.js` and in its lean
  entries (`withFault`, `e2e/harness/release.ts`). It passes the updater's canary (`cli.js version`) and its core
  exits at start.
- Each `notify.mjs` ends with `// release <version>`, so the copy in place shows which build it came from.
- The install manifest came from `cli/scripts/windows-install-manifest.mjs`, using N, the payload above and Node
  v22.23.2's official zip (sha256 `fec025a6…5ef3`).

**Who ran it.** A fresh local user, `hb3`, ran everything. It was made as admin with `New-LocalUser` (the parameter
is `-PasswordNeverExpires`) and added to `Users`. Its profile came from userenv's `CreateProfile`, with no sign-in.
The key in `C:\ProgramData\ssh\administrators_authorized_keys` was copied to `C:\Users\hb3\.ssh\authorized_keys`
(the admin profile has no `.ssh` folder). `hb3` set `PORT=18621` with `setx`, so its daemon never takes 18473,
the port of the daemon in `C:\work\e2e`. The agent was driven over `ws://127.0.0.1:18621/api/local-ws` with a
throwaway script built on `cli/scripts/windows-pty-e2e/driver.mts`. Nothing was signed in. `C:\work\e2e` and the
admin profile were not touched.

Install: `install.ps1 -Manifest C:\work\b3\manifest\install-manifest.json -NoService`, run as `hb3`, took 14 s.

```
  OK Harness 0.4.91-b3 -> C:\Users\hb3\.harness\cli\0.4.91-b3
  OK terminal host 0.4.91 -> C:\Users\hb3\.harness\runtime\pty\0.4.91
  OK harness 0.4.91-b3 installed.
```

### Real specs

`terminate.real.spec.ts` and `taskScheduler.real.spec.ts` were run on the VM as admin, beside A's
`launch.real.spec.ts`: **4 passed (3 files)**. The first run found three things the specs had to say differently:

- **The child in the TerminateProcess spec is detached.** A plain Node child sits in libuv's kill-on-close job
  object, so it ended with its parent. The first run failed at `expect(processExists(childPid)).toBe(true)`.
  TerminateProcess did not end that child; the job did. The core starts the pty host with `detached: true`
  (`lib/ptyHost/launch.ts`), and the spec now does the same.
- **The task spec passes the user's SID and writes the file as UTF-16LE with a BOM**, as
  `PlatformService.write` does. `taskSchedulerXml` takes `sid` since B3.12.
- **"Enabled" is the absence of `<Enabled>false</Enabled>`.** `schtasks /Query /XML` leaves out every setting that
  has its default value, so `<Enabled>true</Enabled>` never appears. `PlatformService.inspect` reads it by the same
  rule. The registered XML also showed that schtasks adds `<UserId>S-1-5-21-…-1001</UserId>` to the principal,
  and shows the logon trigger's SID as the account name.

### Steps

| # | Step | Result |
|---|---|---|
| 1 | `harness start`, launcher, survives the SSH session | **Pass** |
| 2 | `harness stop` by message, agent survives | **Pass** |
| 3 | The core alone ended, master restarts it, agent reattached | **Pass** (with `Stop-Process`, not `taskkill`: see F1) |
| 4 | `harness service install`, `/Run` refused over SSH, "starting it directly" | **Pass** |
| 5 | Console sign-in, the task brings an ended master back | **Deferred to B5.14 (needs a console sign-in and a reboot)**. The parts that need neither passed. |
| 6 | Stop honoured past the 5-minute mark; back at logon after a reboot | **Deferred to B5.14 (needs a console sign-in and a reboot)**. The part that needs neither passed. |
| 7 | Self-update, handover, rollback, retirement | **Pass** |
| 8 | Clean up | **Done** |

**1. `harness start`.** It returned in 6.0 s over SSH (2.9 s on later starts). The master's parent is gone, because
the launcher started it and exited. The core and the updater are the master's children, and the pty host is the
core's child. The command ran in one SSH session and the processes were listed from the next one, after that
session had closed: all of them were still running.

```
  1220 node.exe  parent  7684 <gone>   ~h\runtime\node-v22.23.2-win32-arm64\node.exe ~h\cli\0.4.91-b3\cli.js __harnessd
  8656 node.exe  parent  1220 node.exe ... ~h\cli\0.4.91-b3\cli.js __run
 11368 node.exe  parent  1220 node.exe ... ~h\cli\0.4.91-b3\cli.js __service updater
 11984 harness-pty.exe parent 8656 node.exe  ~h\runtime\pty\0.4.91\harness-pty.exe serve --home ~h\pty
```

**2. `harness stop`.** A PowerShell agent (`terminal`, pid 1888) answered `B3_42`. `harness stop` printed
`machine stopped (pid 1220).` in 1.4 s. After the stop, `harness-pty` (11984), its `OpenConsole.exe` and
`powershell.exe` 1888 were still running.

```
2026-10-16 03:35:58.795 [harnessd] the core asked to stop (harness stop) — stopping
2026-10-16 03:35:58.800 [cli] the harnessd master asked this core to stop — shutting down
2026-10-16 03:35:58.849 [harnessd] service updater stopped (code 0)
2026-10-16 03:35:58.886 [harnessd] core stopped (code 0)
```

**3. The core ended alone.** After `harness start`, `harness status` showed `agents 1 available`, and the agent
answered `AFTER_STOP_1888`. Run as `hb3` over SSH, `taskkill /PID <core> /F` failed with `ERROR: Access denied`
(F1). The core was then ended with `Stop-Process -Id <core> -Force`, which is TerminateProcess on that one pid, as
`taskkill /F` without `/T` would be. The master restarted it, and the same agent answered `AFTER_CRASH_1888`.

```
2026-10-16 03:38:28.362 [harnessd] core exited (code 4294967295, crashed) — restarting in 500 ms
2026-10-16 03:38:29.024 [harnessd] core started (pid 10204) · restart 1
2026-10-16 03:38:29.848 [harnessd] core ready (pid 10204)
```

**4. `harness service install`.** It registered `\Harness harnessd (hb3)`: `Run As User: hb3`,
`Logon Mode: Interactive only`, `Scheduled Task State: Enabled`, both triggers.

```
✓ Task Scheduler starts the Harness daemon when you sign in to Windows, and again within 5 minutes if it stops (pid 5496 runs now).
  task   Harness harnessd (hb3)
```

Then `harness stop` wrote `harnessd-stopped.json` (`{"boot":1792115627718}`). `harness start` took 12.8 s and
printed:

```
  Task Scheduler did not start harnessd (it runs the task only in a signed-in Windows session) — starting it directly
```

The task's `Last Run Time` stayed `11/30/1999`, so it never ran. The start removed the stop marker.

**5 and 6, the parts with no console and no reboot.**
- The registered task, as `schtasks /Query /XML` shows it, has everything the steps rely on: logon trigger user
  `WIN-2R12E0MUJKC\hb3`, which is hb3's SID in the file written; `<Interval>PT5M</Interval>`;
  `IgnoreNew`; `InteractiveToken`; and the action `C:\Users\hb3\.harness\bin\harness-launch.exe --root
  "C:\Users\hb3\.harness" -- start --if-down`.
- The task's action was run by hand while the daemon was up. It exited 0 at once and the pid file did not change.
- The master was ended with `Stop-Process`. Its core and updater ended with it, through Node's job object. The pty
  host and the agent lived on, and `harness status` said `stopped`. The task's action was run by hand again, and
  the daemon was back 2 s later, with the agent reattached (`AFTER_IFDOWN_1888`):

  ```
  2026-10-16 03:50:11.838 [harnessd] core started (pid 9148)
  2026-10-16 03:50:13.254 [harnessd] core ready (pid 9148)
  ```

- After `harness stop`, the task's action run by hand started nothing: no new log line, and status `stopped`.
  `harnessd-stopped.json` was honoured.

**7. Self-update.** A Node server on `127.0.0.1:8765` served `C:\work\b3\updates`, holding the builds and
`metadata.json` (`{ "cli": … }` with absolute http URLs). `hb3` ran `setx ADAPTER_UPDATE_URL
http://127.0.0.1:8765/metadata.json`, then `harness stop` and `harness start`. The updater's next check staged
N+1 and handed over:

```
2026-10-16 03:41:45.057 [update] newer build available: 0.4.91-b3 → 0.4.92-b3
2026-10-16 03:41:49.939 [harnessd] the updater staged 0.4.92-b3 — asking the core to hand over
2026-10-16 03:41:51.785 [harnessd] the bundle on disk is not this master's code — re-executing on it
2026-10-16 03:41:53.520 [harnessd] took over from the master before it (pid 5948)
2026-10-16 03:41:53.758 [harnessd] handed over to the new master (pid 8908) — leaving
2026-10-16 03:41:55.562 [harnessd] core ready (pid 7036)
2026-10-16 03:42:25.654 [harnessd] the update stayed up — keeping it
```

After the handover:
- `cli\0.4.92-b3\` was there and `cli\current` read `0.4.92-b3`.
- The sha256 of `cli\notify.mjs` was N+1's (`33724a3d…`).
- `adapter.pid` held `8908`, the new master, which runs from `cli\0.4.92-b3\cli.js`.
- The agent answered `AFTER_UPDATE_1888`.

N+2's core exits at start. The master rolled it back and went back with it:

```
2026-10-16 03:44:04.753 [harnessd] took over from the master before it (pid 8908)
2026-10-16 03:44:05.918 [harnessd] the updated core failed (code 3) — rolled back to the previous bundle; restarting
2026-10-16 03:44:09.106 [harnessd] took over from the master before it (pid 3412)
2026-10-16 03:44:10.618 [harnessd] core ready (pid 6964)
2026-10-16 03:44:45.086 [update] 0.4.93-b3 was rolled back on this machine — waiting for a newer build (`harness update` installs it anyway)
```

After the rollback:
- `cli\current` read `0.4.92-b3` and `update-rejected.json` read `["0.4.93-b3"]`.
- `cli\0.4.93-b3\` had been removed.
- `adapter.pid` held `9740`, the master on 0.4.92-b3.
- The agent answered `AFTER_ROLLBACK_1888`.

**Retirement.** After a master restart, `cli\0.4.91-b3\` stayed. That is by design: the retirement keeps the
build in use and the newest other build that was not rolled back, which is the build a rollback would go back to
(`buildsToKeep`, B3.17). So N was removed only once N+3 (`0.4.94-b3`) had been staged and kept. Nothing ran from
N by then, and its folder was gone when the updater of N+3's master started: `cli\` held `0.4.92-b3` and
`0.4.94-b3`. The agent answered `AFTER_N3_1888`.

**8. Clean up.**
- As `hb3`: `harness service uninstall` (`✓ removed ~\.harness\cli\data\harnessd-task.xml: Task Scheduler no
  longer runs harnessd.`), `harness stop`, `PORT` and `ADAPTER_UPDATE_URL` deleted from `HKCU\Environment`, and the
  pty host ended. The agent had been deleted first (`deleted: true`), and its `powershell.exe` and
  `OpenConsole.exe` were gone 4 s later.
- As admin: the update server stopped, the empty `\HarnessTest` task folder removed, the `hb3` profile and user
  removed, and `C:\work\b3` removed.
- The profile at first failed to go, because a service still had hb3's registry hive loaded after every hb3
  process had ended. It went after a forced unload of the hive (`NtUnloadKey2`, `REG_FORCE_UNLOAD`). Afterwards no
  `hb3` user, no `C:\Users\hb3`, no ProfileList key, no Harness task and no listener on 8765 were left.

### Watched

1. **One log for the whole daemon.** The master's own `[harnessd]` lines and its children's (`[cli]`, `[update]`,
   `[terminal]`, `[hooks]`) are all in `cli\data\harness.log`. No master crash by exception was forced: that needs
   a build that throws. A master ended by TerminateProcess leaves no line, as expected.
2. **"this data folder is too deep for the daemon's local socket — the services run in the core's process"** is
   logged at every Windows master start that was looked at (03:34:09, 03:36:15, 03:40:51 and 03:50:11). See F2.
3. **Log trimming while the file is held open.** The master, the core and the updater all held the file open.
   Filler was appended to make it 11.5 MB. At the next trim tick, within 20 s, it logged
   `[log] trimmed — dropped the oldest 6 MB (cap 10 MB)` and the file was 5.2 MB. There was no EBUSY or EPERM, no
   NUL gap, and the next master and core lines (a core restart 30 s later) landed after the header.
4. **`harness stop` during a handover.** Not seen. No stop was run in a handover window, and each handover took
   about 4 s from staged to handed over.
5. **`ssh hb3@vm "harness start"` returns at once:** 6.0 s on the first start, 2.9 s later, and 12.8 s with the
   task installed (it waits for the task first).
6. **Retirement and decision files.** An old version folder was removed once nothing ran from it: N+2 after its
   rollback, and N after N+3 was kept. The `<marker>.<token>.handover` files were swept. After the N+2 rollback only
   the newest `harnessd-reexec.json.<token>.handover` was left, and after a fresh master start there were none.

### Findings

- **F1. `taskkill` is refused to a standard user in an SSH session, even for that user's own processes.**
  `taskkill /PID <pid> /F` and `/T /F` gave `ERROR: Access denied` (exit 1) as `hb3`, even on a `ping` it had just
  started. `Stop-Process`, which is TerminateProcess, worked. `tasklist /V` and `Get-CimInstance Win32_Process`
  are refused the same way: an SSH key logon is a network logon, and WMI turns down a network-logon token that is
  not an administrator's. `lib/windows/taskkill.ts` `taskkillTree` (the agent signaller in `ptyHostBackend.ts`)
  will therefore fail in a daemon a standard user started over SSH. Deleting a PowerShell agent still worked here,
  because its processes ended when its console closed.
- **F2. On Windows every service runs in the core's process, and the log gives the wrong reason.** `masterEnv`
  gets no socket path on win32, sets `HARNESSD_SERVICES=none`, and logs the Unix-socket line at every start. Only
  the updater, which belongs to the master, ran in a process of its own.
- **F3. Engine hooks are never installed on Windows.** At every core start, `[hooks] failed to write …:
  HookPreparationHeld: Hook preparation is waiting: the configuration directory exceeds its path limit` is logged
  with a stack trace, for 12 engines' files (over 100 lines per start). `nativeHookFiles.ts` `directoryPath` and
  `syncDirectoryChain` walk up to `/`. This is outside B3.
- **F4. Minor.**
  - A core ended by TerminateProcess is logged as `code 4294967295`, which is -1 read as unsigned.
  - `harness service install` warns that `PORT` is "set only here" even when it is set for the Windows user with
    `setx` (the code says it cannot tell the two apart).
  - B1.9's concern did not come back: no `harness service install exited 1` under `-NoService`.
