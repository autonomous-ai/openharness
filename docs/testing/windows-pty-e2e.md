# Windows PTY host: end-to-end results and performance baseline

Date: 2026-10-15. Branch `feat/windows-native-pty`. Base `f30915019`; four fixes found by this run are committed
on top of it (see [Fixes made during the run](#fixes-made-during-the-run)). The final runs used build
`v0.4.9-dev.c71364a8e`.

This is Task 23 of the Windows native PTY plan. The spec's testing section (§5, "End to end") is in
[the design](../superpowers/specs/2026-10-14-windows-native-pty-host-design.md).

**How it was driven.** Everything ran on the VM against the VM daemon's loopback WebSocket
(`ws://127.0.0.1:18473/api/local-ws`). No account was signed in. The driver uses the same transport and frames as
the desktop app: `machine_select`, `agent_create`, `terminal_open` with `protocolVersion: 3`, binary input, paste and
keyframe frames, `terminal_resize` and `terminal_resync`. It lives in
[`cli/scripts/windows-pty-e2e/`](../../cli/scripts/windows-pty-e2e/). One check needs the user's account and was
**not run**: the Mac desktop app as a remote client of the VM (see
[Not run](#not-run-the-mac-desktop-as-a-remote-client)).

**Evidence.** Each run's output is committed as
[`cli/scripts/windows-pty-e2e/evidence/<run>.log`](../../cli/scripts/windows-pty-e2e/evidence/), named after the
`run.cmd` command or step that produced it: `s1` (the first scenario 1 run), `s1ps`, `s1b`, `s1c`, `codex-emoji`,
`s2` and `s2-rerun`, `s3-two-binary`, `s3-live` and `s3-live-close`, `s4`, `s4-resume`, `s4-setup` and `s4-rerun`,
`s5`, `s6`, `s7`, `perf-vm`, `perf-stream-driver`, `perf-mac-tmux` and `bg-start`. They hold no account
credential (nothing was signed in) and no host token.

## Summary

| # | Scenario | Result |
|---|---|---|
| 1 | Claude Code, Codex and PowerShell agents: create, type, 30 KB paste, Vietnamese/CJK/emoji, resize | **Pass** for the Harness side. Engine caveat: Codex drops emoji and splits large pastes (F13). |
| 1b | The same, from the Mac desktop as a remote client | **Not run**: needs the user's sign-in |
| 2 | Daemon restart: ids kept, streams reattach | **Pass** |
| 3 | Protocol bump drain: two-binary test, and live on the running daemon | **Pass** (both). The live run used the production `shutdown` op path for the first time. |
| 4 | `taskkill /F` the host: agents stop, resume relaunches | **Pass after fix F4.** Before the fix, resumed and new engines were archived within seconds. Resume starts a fresh conversation, because hooks are off (F6). |
| 5 | Child of a PowerShell agent is gone after the agent closes | **Pass** |
| 6 | `Set-Date +3h`, then back: identities unchanged | **Pass**. The clock was set back and checked. |
| 7 | Every other engine in `cli/src/engines` | See the [engine table](#scenario-7-other-engines) |
| — | Performance baseline (VM host vs Mac tmux) | See the [tables](#performance-baseline) |

Four bugs blocked the run and were fixed, each in its own commit with a test (F1–F4). The other findings are
recorded below and were not fixed.

## Setup recipe

**VM.** A Windows 11 ARM64 VM in UTM (build 10.0.26100.4349, 8 logical CPUs), reached as `ssh admin@192.168.65.3`.
The SSH session is an elevated admin running `cmd.exe`. Installed beforehand:

- Node v24.20.0, Git for Windows, Rust (aarch64-msvc) and MSVC;
- Claude Code 2.1.300 and Codex 0.162.1, both signed in;
- OpenCode 1.19.0.

1. **Sync the tree.** Copy the sources to `C:\work\oh` (it excludes the `target` folders and `cli/node_modules`):
   [`cli/scripts/windows-pty-e2e/vm-sync.sh --cli`](../../cli/scripts/windows-pty-e2e/vm-sync.sh). `VM_SSH` and
   `VM_DIR` name another machine or folder (defaults `admin@192.168.65.3`, `C:/work/oh`).
2. **Build the host on the VM.**
   - Run `ssh admin@192.168.65.3 "cd /d C:\work\oh\pty && cargo build --release"`.
   - The result was `harness-pty.exe` at 1,299,456 bytes, sha256 `6106543D…D696`, reporting
     `{"version":"0.1.0","protocol":2}`.
   - The ConPTY payload is `pty/vendor/conpty/arm64/` from `pty/scripts/fetch-conpty.ps1`, with ConPTY
     1.25.260930003: `conpty.dll` (116,024 bytes) and `OpenConsole.exe` (1,149,752 bytes).
3. **Build the CLI bundle on the Mac.**
   - Run `cd cli && . scripts/lib/build-label.sh && ADAPTER_VERSION="$(harness_build_label "$PWD")" npm run bundle`.
   - Copy `dist/cli.js` and `dist/notify.mjs` to `C:\work\e2e\dist\`, for example with `tar -cf - -C dist . | ssh … "tar -xf - -C C:/work/e2e/dist"`.
   - Copy `harness-pty.exe`, `conpty.dll` and `OpenConsole.exe` to `C:\work\e2e\dist\pty\`.
4. **Copy the scripts.** Copy the scripts in `cli/scripts/windows-pty-e2e/` to `C:\work\e2e\`:
   - `env.cmd`, `start.cmd`, `stop.cmd`, `launch.ps1`, `run.cmd` and `cli.cmd`;
   - `procs.ps1`, `psl.ps1`, `perf.ps1` and `s6.ps1`.
5. **Build the driver.** Run `cli/scripts/windows-pty-e2e/build.sh <dir>` and copy `e2e.mjs` to `C:\work\e2e\`.
6. **Start the daemon outside the SSH session.**
   - Run `powershell -NoProfile -ExecutionPolicy Bypass -File C:\work\e2e\launch.ps1`.
   - This uses WMI `Win32_Process.Create` to run `start.cmd`. That runs `node dist\cli.js start -f` in the
     foreground, with output to `C:\work\e2e\daemon.log`.
   - Why: OpenSSH for Windows kills every process of a session when the session ends (F16). A plain background
     `harness start` from SSH died with the session.
   - Stop it with `C:\work\e2e\stop.cmd` (`harness stop`).
7. **Isolate the daemon.** `env.cmd` sets:
   - `ADAPTER_DATA_DIR`, `HARNESS_PTY_DIR`, `ADAPTER_COMPUTER_ID_FILE`, `HARNESS_LOGS_DIR`,
     `HARNESS_HOOK_ROUTES_DIR`, `HARNESS_AGENT_MESSAGES_DIR`, `DSH_DIR` and `HARNESS_DEVICES_DIR`, all under
     `C:\work\e2e`;
   - `DISABLE_GRID_INSTALL=true`. The value has to be `true`; `1` is read as off (F9). Engine hooks stay on (B4.15);
   - With hooks on, the daemon writes the running user's real engine homes (`~\.claude\settings.json`,
     `~\.codex\hooks.json` and `config.toml`, the OpenCode, Kilo, Pi, Amp, Copilot and Command Code hook files). Back
     them up with their sha256 before the first start, and verify the restore afterwards: the procedure and the list are
     in [`evidence/hooks.log`](../../cli/scripts/windows-pty-e2e/evidence/hooks.log), section 10;
   - `HARNESS_PTY_BIN=C:\work\e2e\dist\pty\harness-pty.exe`. This one is required, because the "beside the bundle"
     lookup does not work under `start -f` (F8).
8. **Drive the scenarios.**
   - Run `C:\work\e2e\run.cmd <command> [args]`, for example `run.cmd s1` or `run.cmd list`.
   - The commands are in `scenarios.mts`. Evidence was captured from their output.
   - The driver selects the machine id the daemon serves, as the CLI's own clients do: the sign-in's machine id when
     the daemon is signed in, otherwise the isolated `computer-id` file. A signed-in core serves under its account's
     machine id, so the computer id alone was refused with `NO_PEER_LINK`. The loopback API needs no account.

## Scenario results

### Scenario 1: create, type, paste, Unicode, resize

`run.cmd s1` created three agents in `C:\work\e2e\proj`:

| Agent | Pane | Ready after |
|---|---|---|
| PowerShell (`terminal`) | `%8` | 58 ms |
| Claude Code | `%9` | 1.1 s |
| Codex | `%10` | 1.7 s |

Each was opened at 120×40. Some first-run checks failed because of the driver, not Harness, and were run again
(`s1ps`, `s1b`, `s1c`):

- a wrap-sensitive assertion;
- Claude's one-time "Try the new fullscreen renderer?" dialog swallowing the typed prompt;
- Codex's slow paste, given too short a timeout.

**PowerShell 5.1.** All 7 checks pass (`s1ps`, 7/7):

- **Prompt.** It appears on the stream about 3 s after create.
- **Typed command.** `Write-Output ('E2E_' + (40+2))` printed `E2E_42`.
- **30 KB paste.** 300 lines of 100 characters (30,299 bytes) were pasted into a `[Console]::In.ReadLine()` loop.
  PowerShell counted `TOTAL=30000 HASH=333713715`, which matches the checksum the driver computed. Every byte arrived
  in order, in 1–3 s.
- **Unicode paste.** `Tiếng Việt: Xin chào thế giới — 中文：你好世界 — 日本語：こんにちは — 한국어: 안녕하세요 — 🎉🚀👍`
  went in through `Write-Output '…'`. The output line is exactly the pasted text.
- **Typed Unicode.** `gõ tiếng Việt 汉字 ✓`, sent 3 characters at a time, came back intact.
- **Resize.** At 120×40 → 100×30 the keyframe had 30 rows, and `$Host.UI.RawUI.WindowSize` said `100x30`. Back to
  120×40, it said `120x40`.

**Claude Code 2.1.300.** All 6 checks pass (`s1b`, 6/6):

- **Folder trust prompt.** It is answered. The selection starts on "No, exit" in this build.
- **Prompt.** "What is 6 times 7? Reply with only the number." was answered `● 42`.
- **30 KB paste.** It showed `[Pasted text #2 +299 lines]`, settled after about 7.6 s, then was cleared.
- **Unicode paste.** The whole string showed in the input box, emoji included.
- **Resize.** At 100×30 the keyframe had 30 rows and the widest line was 100. Back to 40 rows.

**Codex 0.162.1.** Harness passes all its checks; Codex's own handling of input has caveats (`s1c`, 5/6, plus the
`emoji` probe):

- **Answer.** `• 42`.
- **30 KB paste.** It showed as `[Pasted Content 5952 chars][Pasted Content 1122 chars]`, settled after about 23 s.
  In the first run it showed as `[Pasted Content 5125 chars][Pasted Content 25241 chars]`, and later lines leaked
  into the composer as typed text.
- **Unicode.** CJK and Vietnamese arrive. Every emoji is dropped, whether typed or pasted:
  `P1 🎉🚀 中文 Việt` → `P1  中文 Việt` and `a🎉b` → `ab`.
- **Resize.** At 100×30 the keyframe had 30 rows. Codex redraws its inline UI.

The same bytes reach PowerShell and Claude intact, so this is Codex's console input on Windows, not the host (F13).

**Tile size.** Resize is covered by `terminal_resize`. A "tile" is a desktop concept, and the desktop was not part
of this run.

### Not run: the Mac desktop as a remote client

This check needs the VM signed in to the user's account, which this run must not do. The VM has since been signed
in (2026-10-15, after this run), so the check can now be run as below; its result is still **not run**. To run it:

1. On the VM, start the daemon as in the recipe. Then sign it in with the same account as the Mac desktop:
   - `C:\work\e2e\cli.cmd login --qr`, which a signed-in phone scans; or
   - `cli.cmd login --google` in a browser in the VM's desktop session.
2. Restart the daemon (`stop.cmd`, then `launch.ps1`). Check that `C:\work\e2e\cli.cmd status` shows it signed in.
3. On the Mac, open the Harness desktop app. The VM appears as a remote machine. Create a Claude Code, a Codex and a terminal
   (PowerShell) tile on it. Type, paste about 30 KB, paste the Unicode line above, and resize the tile. Check that the
   tile's screen matches.
4. Sign the VM out afterwards (`C:\work\e2e\cli.cmd logout`), if it should not stay linked.

### Scenario 2: daemon restart

`s2before`, then `stop.cmd`, then `launch.ps1`, then `s2after` (evidence in `s2-rerun`, 7/7):

- **Timing.** The daemon stopped at 12:22:51 and listened again by 12:22:59.
- **Agents.** The three live agents kept their ids, panes (`%8`, `%9`, `%12`) and engines. No new rows appeared.
- **Streams.** All three reattached:
  - PowerShell answered `AFTER_42`;
  - Claude's screen still showed the earlier `● 42`;
  - Codex's TUI was back.
- **Processes.** The process table before and after is identical for the host (pid 12232, started at 03:32 and alive
  through 7 daemon restarts), `claude.exe`, the Codex `node.exe` and `powershell.exe`.
- **Status.** A terminal row's `status` reads `offline` after a restart (F11). That is cosmetic: its stream
  reattaches.

### Scenario 3: drain on a protocol bump

**Two-binary test on the VM.** `vitest run src/lib/ptyHost/drain.spec.ts`, with:

- `RUN_TERMINAL_CONTRACT=1`;
- `HARNESS_PTY_BIN_PREV` = the protocol-1 debug build at `C:\work\oh-p1`;
- `HARNESS_PTY_BIN` = the protocol-2 release host.

All 23 tests pass, including "streams the old host's pane, makes new panes on the new host, and lets the old one go
once its pane closes" (3.7 s).

**Live, against the running daemon.** This bumps from 2 to 3. It is the first time the production `shutdown` path
ran, because Task 21's live drain could only ever be 1 → 2.

1. A protocol-3 build was made for the test only:
   - the host was built with `PROTOCOL = 3` in a copy of the tree;
   - the bundle was built with `PTY_PROTOCOL = 3`, into a scratch folder;
   - the source edit was reverted at once;
   - both were installed at `C:\work\e2e\dist-p3`.
2. With a Claude, a Codex and a PowerShell agent on the p2 host, the p2 daemon was stopped and the p3 daemon started.
   The log shows `ptyhost: available (p2, draining)` and `ptyhost: available (p3)`.
3. Old agents keep working (`s3check`, 6/6):
   - all three are still listed on instance `p2`;
   - Claude's and Codex's screens stream;
   - PowerShell on p2 answered `DRAIN_42`.
4. New agents go to the new host. A new terminal landed on `p3` (pane `%1`) and answered `NEW_42`.
5. The old host exits once its panes close:
   - the old agents were closed (engines exited, terminal rows deleted);
   - the log shows `draining p2 has gone (shut down with no panes left (pid 2936))`, then
     `ptyhost:p2 drained and removed`;
   - pid 2936 exited, `pty-host-2.json` was removed, and the p3 host was untouched.
6. Afterwards the p3 agent was deleted, the p3 host ended and the p2 daemon restored.

### Scenario 4: kill the host, then resume

`s4setup`, then `taskkill /F /PID <host>`, then `s4after` (evidence in `s4-rerun`, 9/9, after fix F4):

- **Job kill.** Within 3 s of the `taskkill`, every pane process was gone: `claude.exe`, Codex's `node.exe`,
  `powershell.exe` and each pane's `OpenConsole.exe`. That is the Job's kill-on-close.
- **Reconnect.** The daemon logged `ptyhost: lost the connection to the host; reconnecting`. About 1 s later it logged
  `reconnected (p2, a new host: its panes are gone)`.
- **Rows.** The three rows went `stopped` with no pane, `removed · terminal runtime absent after 2 confirmed scans`.
- **Resume.** `agent_resume` on each:
  - the terminal came back with `resumed: true` on `%2001`;
  - Claude (`%2002`) and Codex (`%2003`) came back with `resumed: false`. The log says `[resume] … hook=no · fresh`,
    because no conversation was bound with hooks off (F6).
- **15 s later.** All three still have their engine, and their screens are the engine's UI.

**Before fix F4.** The first run (`s4`, `s4-resume`) failed. The resumed Claude and Codex were archived 8 s after
resume (`retained · engine process absent after 2 confirmed scans`) while `claude.exe` and Codex ran in their panes.
Their panes then turned into terminal rows. A brand-new Claude agent made then failed the same way within 1 s. See F4.

### Scenario 5: no leftover after closing a PowerShell agent

In a PowerShell agent:
`Start-Process powershell -ArgumentList '-c','Start-Sleep 600'; … Get-CimInstance … 'Sleep 600'`. It listed the child
`5932` with parent `13104`, the pane's `powershell.exe`.

After `agent_delete` (`deleted: true`), 3 s later, neither 13104 nor 5932 exists. The six `powershell.exe` the person
had open in the desktop session beforehand (parent 9628) were untouched (evidence in `s5`).

### Scenario 6: clock change

`s6.ps1` does the following:

1. It records the live rows and the registry's process identities (pid and `w:` start marker).
2. It runs `Set-Date (Get-Date).AddHours(3)` and waits 20 s, which is four reconcile passes.
3. It checks again.
4. In a `finally`, it runs `Set-Date (Get-Date).AddHours(-3)` and waits 15 s.
5. It checks a third time.

Results (evidence in `s6`):

- At +3h and after the clock was set back, there are the same 3 ids, panes and engines, and no new rows (4/4 and 4/4).
- The identities are unchanged, for example `20d8966b 9456 w:134365409702318334`.
- After the run the VM clock read 12:31:49Z against the Mac's 12:31:55Z (the end of the SSH call). That is the same
  offset of a few seconds as before the scenario. The VM has no time service running (`w32tm`: the service has not
  been started).

### Scenario 7: other engines

`run.cmd s7` ran `agent_create` for each engine in `cli/src/engines`. Four npm-installable engines were installed for
this test with their recipe's command, and uninstalled afterwards. Nothing was signed in.

| Engine | Version | Result |
|---|---|---|
| Claude Code | 2.1.300 | **Works** (scenarios 1–6). Stop is refused (F5). Resume is fresh (F6). |
| Codex | 0.162.1 | **Works with caveat**: emoji dropped and large pastes split (F13). Stop is refused (F5). Resume is fresh (F6). |
| PowerShell (`terminal`) | 5.1 | **Works** |
| OpenCode | 1.19.0 | **Does not run on Windows ARM64**: the TUI exits (`bun:ffi` unavailable in the ARM64 build, known). The pane hands on to PowerShell and the row stops. |
| Pi | 1.2.0, `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` | **Works with caveat**: the TUI is up (it downloads `fd` and `rg`), then says "No models available. Use /login". The launch stayed `starting` (no readiness without hooks). |
| Kilo | 7.8.12, `npm install -g @kilocode/cli` | **Works**: the TUI is up and the launch is ready. npm 11 blocked the postinstall until `--allow-scripts=@kilocode/cli` was given. |
| GitHub Copilot CLI | 1.0.98, `npm install -g @github/copilot` | **Works with caveat**: the TUI is up at its folder-trust prompt. It needs a GitHub sign-in to be used, which was not done. |
| Command Code | 1.82.3, `npm i -g command-code` | **Does not run on Windows**: its binary is `cmd`, which resolves to `C:\Windows\System32\cmd.exe`. The pane runs Windows cmd and the launch stays `starting` (F7). **Fixed** (B4.13): 1.84.0, installed with `npm i --prefix`, starts as `command-code` and shows its sign-in screen; the launch is `ready`. |
| Cursor, Hermes, Devin, Muse, Amp, Grok, Antigravity (`agy`) | — | **Not installed.** Their recipes are `curl … \| bash`. Create is refused with `NATIVE_LAUNCH_HELD`, "`<engine>` is not installed. Installing engines is not supported on Windows yet: install it, then try again" (the F2 fix). |

## Performance baseline

All CPU figures are percent of one core, as `% Processor Time` and `ps %cpu` both report. Each figure is an average
over 60 s.

The idle agents are plain shells with nothing running: PowerShell on the VM, `zsh -f` on the Mac. "Streaming" is one
agent printing continuously with a client reading its output:

- **VM:** `while ($true) { Get-ChildItem -Recurse C:\Windows }`, with the driver's WebSocket stream open. About
  24,000 characters per second reached the client.
- **Mac:** `while true; do find /System/Library -print; done`, with a tmux control-mode client attached. It prints much
  faster.

### VM: Windows 11 ARM64 in UTM, 8 vCPUs (`perf.ps1`)

`Get-Counter '\Process(harness-pty)\% Processor Time' -SampleInterval 1 -MaxSamples 60`, with the working set read at
the end. Each pane also has its own `OpenConsole.exe`, the bundled ConPTY, shown separately. The daemon's core is shown
for context.

| Agents | Host CPU avg (max) | Host working set | Host private | OpenConsole CPU / working set (all panes) | Daemon core CPU / WS |
|---|---|---|---|---|---|
| 0 idle | 0.67 % (6.2) | 9.8 MB | 1.7 MB | — | 1.07 % / 97.7 MB |
| 4 idle | 0.67 % (4.7) | 13.8 MB | 21.0 MB | 0 % / 54.3 MB | 1.04 % / 97.4 MB |
| 8 idle | 0.83 % (6.2) | 18.3 MB | 41.4 MB | 0 % / 108.6 MB | 1.38 % / 98.6 MB |
| 1 streaming | 7.36 % (34.2) | 18.6 MB | 12.7 MB | 40.5 % / 13.6 MB | 8.93 % / 99.2 MB |

Per idle pane, that is about 1.1 MB of host working set, about 5 MB of host private memory (the grid and its
scrollback) and about 13.5 MB for its OpenConsole. The idle host CPU (about 0.7 %) is the daemon's periodic
inventory, process table and capture calls, and it hardly grows with panes.

### Mac: tmux 3.8, M2 Max, 12 cores (`tmux-perf.sh`)

This uses a private server (`-L e2eperf -f /dev/null`, its own `TMUX_TMPDIR`), never the user's. CPU is the server's
`ps -o %cpu` sampled each second, and its CPU-time delta over the 60 s. RSS is from `ps -o rss`.

| Agents | tmux CPU (ps avg / CPU time) | tmux RSS |
|---|---|---|
| 0 idle (`exit-empty off`) | 0.00 % / 0.00 % | 1.5 MB |
| 4 idle | 0.00 % / 0.00 % | 1.6 MB |
| 8 idle | 0.00 % / 0.00 % | 2.3 MB |
| 1 streaming | 42.6 % / 43.5 % | 4.6 MB |

**Not directly comparable.**

- The VM is ARM64 under virtualization, while the Mac is bare metal, and it was loaded by other work (load average
  7–12).
- The streaming workloads print at very different rates.
- tmux has no per-pane ConPTY process. On Windows the console host is a separate process per pane: tmux's grid work is
  split between `harness-pty.exe` and `OpenConsole.exe`.
- The idle Windows host is not at zero, because the daemon polls it. The tmux server is polled through `tmux`
  commands, whose CPU lands in short-lived clients and not in the server.

## Fixes made during the run

Each fix is a separate commit with a test that fails without it. Each was verified on the VM.

- **F1 · `10a40058d` — the hook credential is reused on Windows.**
  - `readHookCredential` required file mode `0o600`, but NTFS reports `0o666`.
  - So the second start of a daemon on the same data folder failed `EEXIST: file already exists, open
    '…\hook-credential'` and stayed in safe mode ("Nothing else on this machine works").
  - Now the mode is checked only off Windows. The folder's location check (`secureState`) protects it on Windows.
  - Test: `hookAuth.spec.ts`.
- **F2 · `3fd2c4d8a` — the native install history is not consulted on Windows.**
  - `NativePaths` walks POSIX paths only, so every install-history read threw ("Unconfirmed missing installation
    route").
  - So every `agent_create`, a terminal's included, answered `NATIVE_LAUNCH_HELD` "Waiting to confirm durable engine
    installation ownership".
  - On win32, `status` now reports no obligation, and `ensure` holds with "is not installed. Installing engines is not
    supported on Windows yet". Install-first is sub-project B.
  - Test: `nativeInstall.spec.ts`.
- **F3 · `33fd3c11c` — the profile is HOME for native launches.**
  - Windows sets no `HOME`. OpenSSH does, which is why earlier VM runs, all over SSH, had one.
  - A daemon started any other way (WMI here; a service, a scheduled task or the desktop later) held every Claude and
    Codex launch at "Waiting to read the engine's launch environment".
  - Now `os.homedir()` is used when `HOME` is unset on win32.
  - Test: `launchExecutable.spec.ts`.
- **F4 · `c71364a8e` — engines in panes of a host the daemon started are found.**
  - Discovery excludes the daemon's own descendants. Windows does not reparent, so a `harness-pty.exe` the current
    daemon started keeps it as parent. Every engine in every pane then read as the daemon's own process.
  - When it happens: after a host crash, after a reboot, or on a machine's first start, every new or resumed engine
    agent was archived within seconds and its pane turned into a terminal row, until the daemon restarted.
  - A pane's root now ends the exclusion. A tmux server daemonizes, so Unix is unchanged.
  - Test: `terminalAgentDiscovery.spec.ts`.
  - Scenario 4 shows it fixed on the VM.

**Checks run.**

- `tsc --noEmit` is clean.
- `vitest` on `src/lib/terminalAgent*`, `hookAuth`, `src/engines/kit`, `prepareNativeLaunch`,
  `core/agents/discovery` and `registry.spec`: 877 passed and 8 failed. The 8 failures are in
  `exactTranscript.spec.ts` and `storePool.spec.ts`, and they fail the same way with the four source files reverted to
  `f30915019` (pre-existing on this Mac).
- `nativeInstall.spec.ts` has existing tests that fail intermittently under the Mac's load: a different 2–5 of 38 on
  each run, with or without the fix. The new test passes.

## Findings not fixed

- **F5 — Stop is refused for Claude Code and Codex on Windows.**
  - `agent_delete` answers `IDENTITY_UNAVAILABLE` "Conversation identity is held: the native ps probe did not
    complete" (`held`, `retryable`).
  - The path: `stopAgentService` calls `captureResumeIdentity`, which calls `readProcessEvidence`, which runs
    `nativeProbe('ps', …)`. There is no `ps` on Windows. It is reached because no `sessionId` is bound with hooks off.
  - This follows the spec's rule that "we could not look" is not "nothing is there", so it is left for B: hooks, or a
    Windows process-evidence reader.
  - Workaround used here: end the engine inside its pane (`/exit` or Ctrl+C). The row is archived and the pane becomes
    a terminal row, which can then be deleted.
  - With hooks on (B4.15, `evidence/hooks.log`): stop is accepted for Claude Code, Codex and Kilo once the pane's
    conversation is bound (`deleted: true`). A pane with no bound conversation is still refused this way.
- **F6 — Resume reopens no conversation for Claude Code or Codex** (`resumed: false`, "fresh"). Hooks are off, so no
  conversation is ever bound (sub-project B).
  - With hooks on (B4.15, `evidence/hooks.log`): resume answers `resumed: true` for Claude Code and Codex, keeps the
    `sessionId`, and the new pane shows the earlier prompt and answer.
- **F7 — Command Code did not start on Windows.** Fixed (B4.13).
  - `ENGINE_CLI_COMMANDS.commandcode` is `cmd`, which resolved to `C:\Windows\System32\cmd.exe` before npm's `cmd.cmd`.
    Every Command Code pane opened the command processor instead.
  - Fix: on win32 Command Code starts as `command-code`, from the same package (`engineBin`), and a launch never
    searches PATH for a program named `cmd` there (`launchSearchNames`). macOS and Linux still start `cmd`.
  - Verified on the VM with Command Code 1.84.0 (B4 install, hooks off): the pane shows Command Code's own sign-in
    screen and `launch` is `ready`. The engine is `node.exe …\command-code\dist\index.mjs`, a direct child of the pty
    host, with no `cmd.exe` (`cli/scripts/windows-pty-e2e/evidence/commandcode.log`).
  - Hooks not verified: needs a Command Code sign-in. Hooks were off in this run; they are verified in B4.15.
  - Command Code 1.84.0 does not read `COMMANDCODE_HOME`: it puts its files under `HOME`, or `USERPROFILE` when `HOME`
    is unset, plus `.commandcode`. It also always writes `telemetry-install-id` and `updates.json` to
    `%USERPROFILE%\.commandcode`, even when `HOME` is set.
- **F8 — The "beside the bundle" host lookup misses under `harness start -f`.**
  - The master runs the core from `data\lean\<hash>\`, so `ptyHostBinary()` looks for `data\lean\<hash>\pty\` and logs
    `ptyhost: unavailable (harness-pty is not installed)`, although `dist\pty\` has it.
  - This only affects local testing. Releases use `runtime\pty\current-pty` (B). `HARNESS_PTY_BIN` was used here.
- **F9 — `DISABLE_HOOK_INSTALL=1` does not disable hooks**, because `flag()` accepts only `true`.
  - With hooks not disabled on Windows, every engine's hook install fails with "the configuration directory exceeds its
    path limit" (B).
- **F10 — The master's startup log on Windows is misleading** (cosmetic).
  - It logs that `process.execve` is unavailable, and "this data folder is too deep for the daemon's local socket".
  - The second reason is wrong on win32, which has no local socket at all (`localSocketPath` returns null).
- **F11 — Terminal rows read `status: offline` after a daemon restart** until something touches them.
  - By code reading this is not Windows-specific. The reconciler reactivates only rows with an observed engine
    process, and a shell has none.
  - Streams reattach normally.
- **F12 — Lock inspection is a risk on Windows** (not observed).
  - `registry.ts:445` (registry lock) and `daemonSpawnLock.ts:142` (spawn lock) check POSIX modes 0700/0600 when they
    meet an existing lock.
  - On Windows that check would throw "unsafe owner, mode, or type" for a stale or contended lock. A daemon killed
    while it holds the registry lock would then block registry writes until someone removes the lock by hand.
- **F13 — Codex on Windows** (engine, not Harness):
  - non-BMP characters (emoji) are dropped, typed or pasted;
  - a 30 KB paste arrives as two or more `[Pasted Content …]` chunks (some lines as typed text) and takes 15–23 s to
    settle;
  - a `?` was once lost in fast typing, and was not reproduced in a later probe.
  - PowerShell and Claude get the same bytes intact.
- **F14 — OpenCode's ARM64 build has no `bun:ffi`**, so its TUI exits (known since Task 20). Measured again in Task B4.12
  (`cli/scripts/windows-pty-e2e/evidence/opencode-arm64.log`), outcome C:
  - OpenCode 1.19.3, the latest, still stops: `Failed to initialize OpenTUI render library: bun:ffi dlopen() is not
    available in this build`.
  - Its x64 build crashes (access violation) under emulation before OpenCode's screen shows.
    `npm i opencode-ai --cpu=x64` fails in OpenCode's install script and leaves no program. Only the x64 baseline
    build drew, unpacked by hand.
  - Harness now refuses the Arm build before a pane opens. `create opencode` answers `ENGINE_LAUNCH_REFUSED` with
    "OpenCode does not run on Windows on Arm yet: its Arm build stops before its screen opens. Use another engine on
    this computer."
- **F15 — Side effect on the VM's Claude Code settings.**
  - Claude's one-time "Try the new fullscreen renderer?" dialog was answered by typed text in the first run, which
    turned the fullscreen renderer on.
  - It was set back with `/tui default`, and the feedback form was skipped. `~\.claude\settings.json` now contains
    `"tui": "default"`.
- **F16 — Background start from SSH.** `harness start` (background) from an SSH session reported "started", but the
  daemon died when the session ended, because OpenSSH kills the session's job. The host survived, because it breaks
  away. The service and autostart story on Windows is B.
- **F17 — A product-root write outside the isolated folders.** `~\.harness\connections\projections.json` was written
  even though the data folders were redirected. It was removed afterwards.
- **F18 — Pane ids jump by 1000 at each new host** (`%1001`, `%2001`, …). This is how the counter keeps ids unique
  across hosts. It is noted because it is visible in `tmuxPane`.

## Known limits (by design, sub-project B or later)

- Hooks are on (sub-project B, Phase B4); see `evidence/hooks.log`.
- Engine install-first is not carried on Windows (F2 refuses with a reason).
- There is no named-pipe trust for the daemon socket and no local socket, so services run in the core's process.
- The clients (desktop, mobile, `hn`) do not yet word `PTY_HOST_UNAVAILABLE` or `ENGINE_LAUNCH_REFUSED`.
- The host version is still `0.1.0` across protocol builds. Version folders and the `current-pty` pointer are the
  installer's job (B).
- OpenCode does not run on Windows on Arm (F14; measured with 1.19.3). Harness says so when an OpenCode agent is
  created, and no pane opens.

## Clean-up done on the VM

- The daemons and every `harness-pty.exe` this run started were stopped, and no process from `C:\work\e2e` is left.
- The four npm engines were uninstalled, and the state they created was removed:
  - `~\.pi`, `~\.copilot`, `~\.commandcode`;
  - `~\.config\kilo`, `~\.local\share\kilo`;
  - `AppData\Local\copilot`.
- Also removed: `~\.harness`, the test project's Claude history (`~\.claude\projects\C--work-e2e-proj`), and the p3
  build folders.
- Left in place: `C:\work\e2e`, with the bundles, scripts, logs and isolated state, for a rerun.
- Claude Code (`loggedIn: true`) and Codex ("Logged in using ChatGPT") are still signed in.
