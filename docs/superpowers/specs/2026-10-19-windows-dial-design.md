# Windows native: the Harness dial on Windows (sub-project E)

Date: 2026-10-19
Status: implemented; the E5.2 scenario/evidence report is **COMPLETE WITH LIMITS** in the
[E2E report](../../testing/windows-dial-e2e.md): all eleven dispositions are documented, and the owner explicitly
waived the remaining blocked cleanup on 2026-10-20. The whole-E review and final I1/M1 follow-up review passed.
Ships in the Windows PR with the recorded limits; full hardware acceptance is not claimed.

## Goal

On a Windows 10/11 PC (x64 or arm64) with the Harness CLI installed, a Harness dial plugged in by USB works the
way it does on a Mac:

- the daemon finds the dial, talks the cable protocol to it, and shows this computer's agents on it;
- the desktop's Devices tab lists it, changes its settings and pets, and shows it connected or not;
- the daemon updates its firmware over the cable when a newer release is published;
- `harness flash`, and Flash firmware in the app, re-flash it from scratch.

Everything is per user, with no administrator rights, no driver install and no UAC prompt. macOS is the reference:
it works today. Linux is not touched.

## Decomposition

| | Sub-project | Depends on |
|---|---|---|
| A | PTY host, terminal backend and Windows process control (done) | — |
| B | CLI on Windows (done; merge pending) | A |
| C | Desktop on Windows (in progress) | B |
| D | Code signing, winget (later; not in this PR) | A–C, F |
| **E** | The dial on Windows (this spec; combined Windows PR) | B, C |
| F | `harness-install.exe`, Windows in the desktop release, the website's Windows download | C |

E ships in the same Windows PR as A, B, C and F. B's spec listed "serial/USB cables (planned separately)" as out of scope: this is that plan.

## Current state

**The dial.** An ESP32-S3 whose own USB peripheral (USB-Serial/JTAG) is the only USB function it exposes: VID `303A`,
PID `1001`, a composite device with a CDC serial interface (`MI_00`) and a JTAG interface (`MI_02`). The composite node
carries the USB serial number (the dial's MAC, `28:84:85:…`). On Windows 11 the in-box `usbser.sys` binds `MI_00` and
names it `USB Serial Device (COMn)`: no driver to install. Measured on the x64 test PC (a Dell Latitude 7440,
Windows 11 build 26200): COM3, status OK.

**Who talks to it.** The CLI daemon, only. The desktop app never opens a serial port:

| Job | Owner |
|---|---|
| Find the dial, open the port, run the cable protocol (agents, chime, settings, pets, firmware over the cable) | the daemon's `devices` service, `cli/src/cable/` |
| The Devices tab | the desktop, through `harness_devices_list` and the other `DEVICES_REQUESTS`, and the `harness_devices_changed` push |
| Re-flash from scratch | the desktop runs `harness flash`; the CLI fetches `flash-circle.ps1` on Windows or `flash-circle.sh` on Unix, which runs esptool |
| Keep the daemon off the port while flashing | the script runs `harness stop`/`harness start`; the desktop's `SerialPortLease` pauses its own daemon supervision |

**What stops it on Windows.** Everything above the byte stream is platform-free. Below it, `cli/src/cable/serial.ts`
has a macOS branch (`ioreg`, `O_EXLOCK`, `stty -f`) and a Linux branch (`/sys/class/tty`, `stty -F`), and nothing for
Windows:

- `findDialPorts()` returns `[]` on `win32`, so the fleet never sees a dial;
- `SerialLink.open()` needs `stty` and a tty `portStream` can wrap;
- `portInUse()` runs `lsof`;
- `isUsbConsoleUser()` answers true off macOS, so two signed-in users' daemons would race for the port;
- `harness flash` runs `bash`, which Windows does not have.

`serial.ts` takes no native dependency, on purpose (its header): the CLI is one bundled JavaScript file. E keeps that.

## Decisions

1. **A small Windows-only binary, `harness-serial.exe`, does the serial I/O.** Its own crate, `serial/`, beside
   `term/` and `pty/`. Not a subcommand of `harness-pty`: that is the terminal host, and one binary doing two jobs is
   confusing to read and to debug (owner, 2026-10-19). Node cannot do it alone: a read on a COM handle through `fs`
   blocks a libuv pool thread and cannot be cancelled, and `portStream` cannot wrap a COM handle. A PowerShell/.NET
   bridge was rejected for its ~1 s start, ~60 MB per port, and `SerialPort`'s known DTR quirks.
2. **The CLI keeps the cable protocol.** `serial.ts` grows a `win32` branch with the same exports; `cableFleet`,
   `cableSession`, `fwPush` and the services do not change.
3. **Full parity with macOS, flash included** (owner, 2026-10-19). Re-flash runs a PowerShell twin of the flasher,
   `flash-circle.ps1`, that prints the same lines, so the desktop's flasher needs no parser change.
4. **The bash flasher does not change.** It works on macOS. The flash geometry is kept in step by a test that reads
   both scripts, not by moving it.
5. **No administrator rights.** Opening a COM port, enumerating devices, and reading the console session need none.
   The test PC's account is an administrator; E's code must not rely on it, and E2E scenario 9 runs a standard user.

## 1. `harness-serial.exe`

A console program, built for `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc`, on `windows-sys` only (SetupAPI
or CfgMgr32, `CreateFileW` with overlapped I/O, WTS, `ProcessIdToSessionId`). No third-party serial crate. It writes
nothing to disk, takes no lock files, and is started with `windowsHide`.

Both long-running modes **exit when their stdin reaches end of file**. That is how they end with the daemon, however
the daemon ends: a killed parent closes the pipe. No orphan can keep holding the port.

### 1.1 `harness-serial watch`

Prints one JSON line at start and one each time the answer changes:

```json
{"console":true,"ports":[{"path":"COM3","serialNumber":"28:84:85:…","session":"133731234567890000"}]}
```

- **`ports`**: every present device interface on a device whose hardware id is `USB\VID_303A&PID_1001&MI_00`,
  with its `PortName` (`Device Parameters`). Matched by id and nothing else, as on macOS: never by friendly name,
  never "the only COM port". The order is stable (by `path`).
- **`serialNumber`**: the last segment of the parent composite device's instance id (`USB\VID_303A&PID_1001\<serial>`),
  when the parent is that device. Omitted otherwise.
- **`session`**: the composite device's `DEVPKEY_Device_LastArrivalDate`, as a decimal FILETIME. It changes when the
  dial is unplugged and plugged back in, and stays put across a reset or a reflash over USB-Serial/JTAG (which keep the
  USB device enumerated) — the same contract as macOS's `sessionID` (`DialPort.session`). E2E scenario 4 measures
  both halves. If the property is missing, `session` is omitted: verdicts on that port are then short-lived, as on
  Linux without `busnum`.
- **`console`**: whether this process's session (`ProcessIdToSessionId`) is the active console session
  (`WTSGetActiveConsoleSessionId`). A session connected over Remote Desktop is not the console.

When it looks again: on a `CM_Register_Notification` arrival or removal of `GUID_DEVINTERFACE_COMPORT`, and every
5 minutes, as a safety net. Arrival notifications can come before `PortName` is written, so an arrival is
looked at again 500 ms later. `console` is read every 2 s (`WTSGetActiveConsoleSessionId` is one call into the kernel;
a session notification would need a window). Idle, it costs a wake-up every 2 s and no enumeration.

Exit codes: 0 at end of stdin; 2 when enumeration itself fails (the line `error: <reason>` on stderr).

### 1.2 `harness-serial open COMn`

- Opens `\\.\COMn` with `GENERIC_READ | GENERIC_WRITE`, share mode 0 (Windows COM ports are exclusive), overlapped.
  `ERROR_ACCESS_DENIED` or `ERROR_SHARING_VIOLATION`: stderr `busy`, exit 3. `ERROR_FILE_NOT_FOUND`,
  `ERROR_PATH_NOT_FOUND` or `ERROR_DEVICE_NOT_CONNECTED`: stderr `gone`, exit 4. Any other failure: stderr
  `error: <reason>`, exit 5.
- Once the port is open and configured, stderr says `open`. The CLI waits for that line before it hands the link to
  the session (stdout carries only the dial's bytes, so the signal cannot ride there).
- Sets the DCB raw: 115200 8N1 (the baud rate is ignored by USB-Serial/JTAG, and set for drivers that check it),
  `fBinary`, no parity check, no XON/XOFF, no CTS/DSR flow control, `fAbortOnError` off. `COMMTIMEOUTS` so a read
  returns as soon as any byte is there (`ReadIntervalTimeout = MAXDWORD`, `ReadTotalTimeoutMultiplier = MAXDWORD`,
  `ReadTotalTimeoutConstant` 1000 ms, then reads again).
- **DTR and RTS must not reset the dial.** `open` releases both in one `SetCommState` call
  (`DTR_CONTROL_DISABLE`, `RTS_CONTROL_DISABLE`, `DCB_RAW=1`) and changes them at no other time: the E1.3 Step 5
  fallback. On the test PC (2026-10-20), both asserted-lines attempts received an ESP-ROM banner. The first
  released-lines read also contained one; the next three were banner-free, including the final consecutive pair
  (3822 and 1975 bytes). Every open held for 10 s, exited 0 at stdin EOF and kept the USB attachment session.
  The final pair passes E1.3's automated gate; the controller defers Person screen observation and heartbeat
  verification to E5. The exact reset edge and the initial banner's origin remain unproven: an unchanged USB
  session does not itself prove no reboot. Full measurements and cleanup are recorded in
  `desktop/scripts/windows-e2e/evidence/dial-e1.3-serial-check.log`.
- Then copies bytes both ways: port → stdout, stdin → port, writing each chunk whole before the next. No framing:
  the cable protocol's frames pass through untouched.
- Ends: end of stdin → close the port, exit 0. The port fails (unplug: `ERROR_GRACEFUL_DISCONNECT`,
  `ERROR_DEVICE_NOT_CONNECTED`, `ERROR_OPERATION_ABORTED`, …) → stderr `closed: <reason>`, exit 5. A write that
  fails ends it the same way.

### 1.3 `harness-serial probe COMn`

Opens the port as `open` does (share mode 0, the same DTR/RTS), closes it at once, and exits 0 when it could, 3 when
it is busy, 4 when it is gone. It reads and writes nothing. This is `portInUse` on Windows (§2).

`harness-serial version` prints `{"version":"<v>","protocol":1}`, like `harness-pty version`.

## 2. `serial.ts` on Windows

The exports keep their signatures. On `win32`:

- **Finding the binary**: `HARNESS_SERIAL_BIN`, as it is; else `<runtime>/pty/<version>/harness-serial.exe` for the
  version `current-pty` names; else `pty/harness-serial.exe` beside the bundle. The same order as `ptyHostBinary()`,
  and the same shared helper where one exists. None found: `findDialPorts()` returns `[]` and logs once
  `cable: harness-serial is not installed`.
- **`findDialPorts()`** returns the last `watch` line's `ports`, as `DialPort`s with `vendorId`/`productId` set. The
  first call starts `watch`; until its first line it waits up to 2 s, then returns `[]`. If `watch` exits, it is
  started again on the next call, no more than once every 5 s, and the reason is logged once per change. The fleet's
  2 s scan stays; on Windows each scan is a read of memory, not a process.
- **`SerialLink.open(path, onData, onClosed)`** spawns `harness-serial open <path>` with pipes and wraps them. The
  serialised `write` queue, `isOpen` and the `close()` contract are the same code. `onData` gets stdout's chunks.
  `close(why)` ends stdin and waits for the exit (killing the child after 2 s). An exit the link did not ask for
  calls `onClosed` with the child's stderr reason. `open` rejects with `code: 'EBUSY'` on exit 3 and `'ENOENT'` on
  exit 4, before `onClosed` can be called, as an `openSync` failure does today.
- **`portInUse(path)`** runs `harness-serial probe <path>` (3 s timeout): true on exit 3, false otherwise. As with
  `lsof`, "cannot tell" reads as free. The fleet calls it only for boards ruled out, every 8 s (`watchEveryMs`).
- **`isUsbConsoleUser()`** on `win32` returns the last `watch` line's `console` (false before the first line). The
  fleet already releases the port when this turns false (`waitingForConsole`); nothing there changes.

The macOS and Linux branches are not touched. On Windows the services currently run in the core's process
(B, Known limits): `core/main.ts` starts the `devices` service with the core, unconditionally
(`serviceHost.start('devices', …)`). E also implements the explicit Windows startup path in `devicesWake.ts`:
if devices are configured outside the core and cable support is enabled, the wake requests them once at
startup, without `/dev` polling. `dialPortThere()` remains a Unix port check; its false answer on Windows
does not prevent discovery. The Windows wake path exists; separate service processes on Windows remain
part of B's architecture limit.

## 3. Re-flash on Windows

### 3.1 `flash-circle.ps1`

Lives at `website/src/app/flash-circle.ps1/flash-circle.ps1`, served at `/flash-circle.ps1` by a `route.ts` like the
`.sh` one (`text/plain; charset=utf-8`, `no-store`), and listed under `outputFileTracingIncludes`. Its first line is
`# flash-circle.ps1` (the marker the CLI checks, §3.2). Windows PowerShell 5.1, no modules. Output is UTF-8.
**Its source is ASCII only**: Windows PowerShell 5.1 reads a file without a BOM in the ANSI code page, so the `✓` and
`→` the bash flasher prints are written as `[char]` codes.

It is the bash flasher, step for step, with the same flags (`--detect-only`, `--no-flash`, `--version`, `--port COMn`,
`--yes`, `--erase-nvs`, `--no-verify`, `--version-info`), the same environment overrides, the same cache folder
(`HARNESS_FLASHER_CACHE`, default `~\.harness\flasher`), and the same output lines: `>> ` for a step, three spaces
for a detail, `error: ` on stderr for a failure. The lines the desktop reads (`>> board: `, `more than one ESP32-S3`,
`no permission`, `error: `) are byte-identical.

| Step | Bash | PowerShell |
|---|---|---|
| esptool | `esptool-v5.3.1-<os>-<arch>.tar.gz` | `esptool-v5.3.1-windows-amd64.zip`, sha256 `2b4a73c45db27426685896f64ce3e557f63a64f43cc100cb65c0cc3486af96d3` (the vendor's release digest), mirror first, then the release, then an `esptool`/`esptool.py` on PATH. Espressif publishes no arm64 build; on arm64 Windows the x64 build runs emulated |
| Candidate ports | `/dev/cu.usbmodem*`, … | `[System.IO.Ports.SerialPort]::GetPortNames()` |
| Detecting while Harness runs | `--detect-only` does not stop Harness; on macOS esptool opens the port the daemon holds | a COM port is exclusive, so esptool cannot. A busy port that is the dial by its USB id (`Enum\USB\VID_303A&PID_1001&MI_00\…\PortName`) is reported as the board (`in use by Harness (a dial, by its USB id)`, then `>> board: COM3`). The flash run stops Harness first and asks the chip before it writes, so the ESP32-S3 check still guards every write |
| Running esptool | in the foreground, or in the background for the probe | `Start-Process -NoNewWindow` with its output to files that are copied to the script's own output as they grow, so esptool's `\r` progress reaches the app byte for byte. Every run is bounded and checks for a cancel each second. A run is ended with `taskkill /T /F`: the standalone esptool is two processes (its bootloader and the program), and killing the first leaves the second holding the port |
| Probe | `esptool chip_id`, 25 s bound, process-group kill | the same command, the same 25 s bound |
| Firmware | sha256, size, first byte `0xe9` | the same (`Get-FileHash`) |
| Daemon | writes `flashing`, `harness stop`, `sleep 1`, `trap` → `harness start` | writes a timestamp lease (`flashing.<runId>` for an updated app, otherwise shared `flashing`), `harness stop`, waits up to 5 s for this user's `harness-serial` processes to end (they end with the daemon, §1), `try/finally` removes its lease and runs `harness start` |
| Running version | `stty` + `cat` 15 s, `App version:` | .NET `SerialPort` at 115200 for 15 s, the same `App version:` match |
| Confirm | `/dev/tty` prompt | `[Console]::ReadLine()` when stdin is a console; otherwise `--yes` is required, the same message |

**Cancel.** The desktop cannot send a signal that runs a `finally` on Windows. While it waits on esptool, the script
checks every second for `<cache>\cancel`. When it is there, the script removes it, stops esptool's tree, runs its
`finally` (removes its timestamp lease, `harness start`) and exits 130. The cancel file is removed at the script's start too, so an
old one cannot cancel a new run.

**One set of numbers.** `CHIP`, `APP_OFFSET`, `OTADATA_OFFSET`, `OTADATA_SIZE`, `NVS_OFFSET`, `NVS_SIZE`,
`FLASH_MODE`, `FLASH_FREQ`, `FLASH_SIZE`, `ESPTOOL_VERSION`, `OTA_KEY`, `METADATA_PATH`, `FIRMWARE_PATH_PREFIX`,
`GCS_BUCKET`, `FLASHER_VERSION` and the esptool command lines (`--before`, `--after`, `-b`) appear in both scripts.
`flash-circle.spec.ts` reads both and fails on any difference. Bumping esptool means both pins:
`upload-flasher.sh --mirror-esptool` prints the Windows one beside the others.

### 3.2 `harness flash` on Windows

`cli/src/lib/flash.ts` on `win32`:

- fetches `<WEB_URL>/flash-circle.ps1` with the same timeout and `no-cache` header;
- accepts it only when its first line is `# flash-circle.ps1` (the `.sh` check is `#!`);
- caches it as `~\.harness\flasher\flash-circle.ps1`, falling back to the cached copy as the `.sh` path does;
- runs `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script> <args, verbatim>` with
  `stdio: 'inherit'`, and returns its exit code.

A file `fetch` writes carries no Mark of the Web, so `Bypass` is about policy, not SmartScreen. macOS and Linux keep
the bash path unchanged.

### 3.3 The desktop

`Flasher.cancel()` on Windows writes `<flasher cache>\cancel` (the same folder `SerialPortLease` reads), then,
if the run has not ended 15 s later, requests `taskkill /T /F` for its process tree. A hard kill skips the
script's `finally`, including `harness start`.

The updated app supplies a new 128-bit lowercase-hex `HARNESS_FLASH_RUN_ID` and the resolved cache path only
to the CLI child. The CLI forwards them to PowerShell, which accepts exactly 32 lowercase hex characters,
freezes its lease path as `flashing.<runId>`, then clears the identity from its environment before spawning
any child. Standalone/older-app calls and invalid identities retain the shared `flashing` path. Each marker
still contains epoch seconds; `SerialPortLease` reads both protocols with the existing ten-minute stale bound.
CLI age alone does not choose the marker: an older CLI that inherits the app's identity can pass it to the
updated script and use a per-run lease. An old cached script still uses the shared marker.

Forced cleanup waits for both successful tree termination and the owned parent exit, then removes only
that run's exact persisted lease before the flash future resolves and the in-process lease releases.
Failed termination or cleanup retains the persisted guard. A foreign per-run or shared marker is never
selected for deletion, even with identical timestamps. Once the guards permit it, supervision can restart
the daemon on its next eligible tick; this is not a measured restart deadline. The stopped message says
`Stopped.` without claiming an observed restart. macOS and Linux keep SIGTERM and the bash flasher.

The Flash firmware dialog says "this Mac" twice (`Checking the USB ports on this Mac.`, `Plug the dial into this Mac
…`); on Windows it says "this computer", and on macOS and Linux it is unchanged. The output heading names
`flash-circle.ps1` on Windows and retains `flash-circle.sh` on Unix. The ports come from the script.
The in-window menu's `flashFirmware`, About's Flash button and the Devices tab share this implementation;
the E2E report records the actual GUI coverage and remaining hardware observations.

## 4. Packaging and lifecycle

- `.github/workflows/windows.yml` builds `serial/` for x64 and arm64 beside `pty/`, runs `cargo test` for it, and
  hands `harness-serial.exe` to the payload step.
- The payload's file list grows from five to six wherever it is written: `install.ps1` (`$HarnessPtyFiles`, which
  `Test-HarnessPtyFolder` requires), `windows-install-manifest.mjs` (`PTY_FILES`), `publish-pty-payload.sh`
  (`FILES`), `scripts/lib/ptyPayload.mjs` (beside the bundle, for local testing) and `windows.yml`'s collect step.
  The payload's sha256 and size checks, the staging publish and `promote-pty-payload.sh` cover it with no new step.
  The install unpacks it into `<runtime>/pty/<version>/`.
- A version folder per release means an update never overwrites a running `harness-serial.exe`, as for
  `harness-pty.exe`; old version folders are handled exactly as B handles them for `harness-pty.exe`.
- **Stop, update and uninstall.** `harness-serial` processes are the daemon's children and end at end of stdin (§1),
  however the daemon ends, so `harness stop`, the core's update handoff and `harness uninstall` (which stops the
  daemon before it removes files) leave none running. No uninstall change: a Windows CI test kills a parent and
  checks that its `harness-serial` ends, and E2E scenario 11 checks the uninstall.

## 5. Testing

### 5.1 Linux and macOS CI (PR CI)

- `serial.spec.ts`, `win32` injected: a fake `harness-serial` (a Node script speaking §1's stdio and exit codes)
  drives `findDialPorts`, `SerialLink.open` (data both ways, a frame larger than one pipe write, `busy`, `gone`,
  unplug mid-stream, `close` during a write), `portInUse`, `isUsbConsoleUser`, binary lookup order, and `watch`
  restarts.
- `flash.spec.ts`, `win32` injected: URL, marker check, cache fallback, PowerShell argv.
- `flash-circle.spec.ts`: the two scripts' numbers match (§3.1).
- `flasher_test.dart`: Windows cooperative cancellation, forced-tree/parent-exit ordering, real per-run lease
  retirement, failed-kill and foreign-marker preservation, and real child exit through both daemon startup paths;
  Unix SIGTERM remains covered. Dialog widget tests cover both output headings and the stopped message.

### 5.2 Windows CI (x64 and arm64)

- `cargo test` in `serial/`: hardware-id and instance-id parsing, choosing `MI_00`, the JSON line, exit codes.
- `harness-serial watch` with no dial prints `{"console":…,"ports":[]}` and exits at end of stdin.
- `harness-serial open COM250` exits 4 with `gone`; `probe` likewise.
- A `harness-serial watch` whose parent is killed ends within 5 s (its stdin closes).
- `serial.spec.ts`'s fake-binary cases, on Windows itself.
- `flash-circle.ps1 --version-info`, and `--no-flash` against the real public manifest (downloads and verifies a
  firmware image; no board needed).

### 5.3 End to end on the x64 test PC, with a real dial

Rules: touch nothing E did not install; remove all of it at the end; screenshots and logs carry no full serials or
ids. The dial sits in the console session of the PC's own account, so most scenarios run there; scenario 9 creates
a throwaway standard user and removes it after. Install: the branch's CI artifact (bundle with `pty/`) by scp, and C's
staging desktop build (published in C5.2 with the owner's OK). The flasher is served from a local Node HTTP server on
the PC (`WEB_URL=http://127.0.0.1:<port>`), so no website deploy is needed. Results go to
`docs/testing/windows-dial-e2e.md`.

| # | Scenario | Pass |
|---|---|---|
| 1 | Plug in, daemon already running | `harness_devices_list` shows `attached`, `fw`, `id` within 5 s; the dial shows this PC's agents (**Person**, photo) |
| 2 | Open does not reset | Measured first (plan E1.3), with no daemon: `harness-serial open COM3` on a running dial leaves `watch`'s `session` as it was and the port open for 10 s, with no `ESP-ROM:` in what it reads. Then, with the daemon: across two daemon restarts, the firmware's minute heartbeat (`alive up=<s>` in `~\.harness\logs\dial-*.log`) keeps counting up |
| 3 | Devices tab | The dial is listed as Connected; a settings change and a pet change are reported back by the dial; screenshot |
| 4 | Unplug and replug | Once by `pnputil /restart-device`, once by hand (**Person**): `session` changes; reconnect within 5 s; the daemon stays up. A reset by esptool's `--after hard_reset` leaves `session` as it was |
| 5 | Port held by another program | A PowerShell `SerialPort` holds COM3: the daemon logs it once and leaves it; once released, the daemon takes the dial within 10 s |
| 6 | Firmware over the cable | Flash an older release (`harness flash --version <older>`); the daemon offers the newest over the cable; the dial reboots on it and reconnects |
| 7 | Flash from the app | `--detect-only` finds COM3; Flash writes the newest; `running <v> ✓`; daemon and dial back |
| 8 | Cancel a flash | Cancel during the write: the daemon is back within 10 s; a second flash succeeds |
| 9 | Two users | A throwaway standard user signs in with fast user switching: its daemon takes the dial and the first releases it; switching back reverses it (**Person**) |
| 10 | Idle cost | CPU and RSS of the daemon and `harness-serial` over 10 minutes, with and without a dial; recorded, no threshold |
| 11 | Uninstall | No `harness-serial` running, no files left; the dial goes back to its waiting screen |

## Release

E ships in the Windows PR. After it merges, at the owner's go, each:

1. promote E's CLI payload carrying `harness-serial.exe` through the CLI's production steps;
2. a website deploy, so `/flash-circle.ps1` is live;
3. optionally, `upload-flasher.sh --mirror-esptool` for the Windows esptool zip (without it, the script takes the
   vendor's release, checked against its pin).

## Out of scope for E

Linux changes; a dial reached over the network; the Harness Pro (ESP32-P4) flasher, which the bash flasher does not
do either; first-time flashing of a virgin board (bootloader and partition table), which the bash flasher does not do
either; a Windows driver for other USB-serial chips.

## Known limits

- **One `harness-serial watch` per running daemon**, dial or not. The plugged idle sample below includes
  the private test backend and loopback server; it does not isolate E's incremental cost.
- **Arm64 flashing runs esptool emulated**, as Espressif ships no arm64 Windows build.
- **`harness-serial.exe` is updated by `install.ps1`, not by the CLI's self-update**, exactly as `harness-pty.exe`
  is: on Windows only `install.ps1` writes `runtime\pty\current-pty`. Its stdio contract (§1) therefore only grows:
  a newer CLI must work with the `harness-serial.exe` an older install laid down.
- **Older cached PowerShell flasher.** A new app cannot prove ownership of an old script's shared `flashing`
  marker. Forced cancellation preserves it conservatively, so daemon suppression can remain for the old
  ten-minute stale interval. The updated script's child-environment clearing also does not apply to old scripts.
- **Standard-user uninstall over SSH** hit C's documented Windows helper-cleanup restriction: the attempt
  exited 1 with AccessDenied. This does not establish the desktop uninstall result.

### Validation results and limits (E5.2 complete with limits)

The [E2E report](../../testing/windows-dial-e2e.md) owns the current acceptance verdicts. Scenario 5 passed;
scenarios 2 and 6 passed their Script checks, with Person screen observations NOT RUN. Scenarios 1 and 3
are partial. Scenario 7 has successful app flashing, a fresh hello and unchanged attachment session, but
its native-writer-exit timing does not measure the required CLI-return bound.

Scenario 8 has a scoped PASS for actual GUI cancellation at Writing 17% followed by normal CLI3 recovery.
The two writers were gone in 1,317 ms and none remained at 15 s. The daemon opened the dial log after
4.615 s; that proves daemon activity, while first IPC-response timing remains unmeasured. The earlier
`4c3def3c` and `c95e86208` recovery failures remain historical FAIL results. The exact 13:02 negative
verdict survived the CLI3 upgrade unchanged, without detection, PnP or manual clearing. From that baseline,
normal `flash --yes --port COM3` on CLI `4fe12de12` / `0.9.0-dev.dial3` exited 0 in 62.960 s, reported
`running 0.0.92` without a completion warning, cleared the selected negative verdict, and left both markers
false. A fresh hello and attachment followed with the same USB session, 2.7990 s after CLI exit. The existing
app stayed on its prior Done screen; no new dev3 GUI flash was performed.

The tested mixed inputs are app/native `4c3def3c`, PowerShell `c95e86208`, and CLI `4fe12de12`. The latter
passed the actual Windows native bundle-entry fixture (selected A cleared, sibling B preserved), the focused
103/103 suite, TypeScript typecheck and independent scoped review. Native workflow
[39412223533](https://github.com/autonomous-ai/openharness/actions/runs/39412223533) passed all four
x64/ARM64 jobs; its evidence applies to the unchanged native and PowerShell inputs, not a new whole-runtime build.

The final forced-cancellation/output-heading fix is `444139f69`. The whole-E review and its focused follow-up
found no remaining E Critical or Important issue after I1/M1 were resolved. Its final Desktop evidence is
84 passing tests and one existing platform skip assembled from completed selected files, plus scoped analyzer,
CLI wrapper, website and typecheck results. Seven actual Windows PowerShell 5.1 function fixtures passed against
the updated PS1. These establish the updated marker protocol and function behavior; they are not a new GUI build,
actual Windows taskkill/USB run or replacement for the mixed hardware inputs above.

Scenario 10's plugged interval retained the same five process identities. Native same-vector derived
postprocessing (`3907ce22`, `verified=true`, `postprocessing_only=true`) passed with 20.953125 CPU seconds,
including the test loopback server; the core used 20.8125 seconds and both serial helpers together used
0.0625 seconds. The actual snapshots at `13:53:12.1757386Z` and `14:03:13.5336234Z` span 601.3578848 seconds.
The collector's stored 601.7609357 seconds is stopwatch elapsed at failure: its catch block overwrites the
earlier elapsed field after the final probe and failed comparison, so it includes that later work. It is not
the clean snapshot interval. The original failed OrderedDictionary comparison remains a separate FAIL, not
relabeled as a passing collection. The E2E report contains all five role-only CPU and working-set rows.
No 600-second rerun, disconnected sample, performance threshold or clock-adjustment explanation is claimed.

Scenario 4's Windows PnP simulation was blocked with exit 3010, requiring a reboot; no reboot, physical unplug
or hard reset was performed. Fast user switching (9), a second dial, pet changes and physical screen observations
are NOT RUN. Disconnected idle measurements remain NOT RUN. Scenario 11's standard-user SSH uninstall failed
partially: the read-only audit found zero owned processes, one serial-helper file and the launcher still present.
A second, tools-only account's read-only audit passed (zero owned processes/files, no launcher), with no product
uninstall there. Standard-user desktop uninstall remains NOT RUN. E5.3 records the implemented behavior,
scoped evidence, owner-waived residual cleanup and remaining limits. E ships with
these limits, not full hardware acceptance.

### Recorded cleanup and owner waiver

The owner-portable process/task phase (`ecf33caf`) passed: normal CLI3 stop, exact PTY and loopback-server
stops, and 24 completed owned NoWait tasks unregistered. Final owned-root process/task counts were both zero.
It ran `2026-10-20T14:35:20.8387298Z` → `2026-10-20T14:37:27.2000336Z` (receipt elapsed 126.472 s;
SHA256 `0a3b13b17ea4bbfcd57ae33e784746e1bea597bdfc7f6b98bd345ecb7f53ed68`). This phase deleted no paths,
accounts or profiles, and is not a product-uninstall result or a global process count.

Existing private proofs were manifested on the Mac before the process/task stop. After that stop and before
any path/account deletion, the five-proof native ZIP was built, downloaded and verified on the Mac:
whole ZIP, all five entries and CRC (11,830 bytes; SHA256
`b9dd06eecfe2348b65076dd3e998421c0657f0775906f5937e6acddc11963fe9`). Both public test-account cleanup
attempts were blocked by the loaded-profile guard despite zero owned processes; neither user nor profile was
deleted. Each exact-identity native audit took 31 snapshots: both profiles remained loaded with both hives
present, RefCount could not be determined, and no exact-identity logon or WTS session was available for a safe
logoff. Their positive ownership receipts remain retained.

No direct hive unload or shared-host reboot was attempted, and no legitimate original loader handle was
available. The owner explicitly waived the remaining cleanup: no further cleanup, hive unload, reboot or
deletion attempts will be made. Both test profiles, dedicated keys, the isolated portable E root and marked
shared/administrative scratch with ownership receipts remain retained. The remover was prepared only, not run;
the original kit's planned final scratch cleanup was also not run. The earlier S11
SSH-uninstall FAIL remains independent of the process/task teardown PASS and blocked account cleanup.

The fresh preservation comparison (`1b6b91b3`) is NOT PASS: three old process identities and three old
listeners are absent, while the original two tasks are both retained. Cause is unproven; C/shared work ran
concurrently, without establishing causation. No C restoration or baseline overwrite was attempted. Full
preexisting-state preservation is not certified by this comparison.

### Carried review follow-ups

- **I2: inherited summary ordering.** The asynchronous summary/next-turn issue in `cli/src/services/devices.ts`
  is owned by the notification/C follow-up; it is outside E and was not closed by the final fix.
- **M2: native test deadline.** The unbounded initial `read_line` in `serial/tests/windows.rs` remains deferred
  to the combined Windows owner. Passing native runs do not establish bounded failure for that test.

## Risks

- **DTR/RTS.** The wrong line state on open resets the dial, or holds it in its bootloader. Scenario 2 measures it
  before `open` is written; it is the first step of the plan.
- **`usbser` and a reboot.** After a firmware update the dial re-enumerates; the COM number usually stays, but can
  change. `watch` reports what is there, so the fleet follows; scenario 6 checks it.
- **Two sources of truth for the flasher.** Mitigated by the matching test, not removed.
