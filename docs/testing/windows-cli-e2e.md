# Windows CLI: end-to-end results

Date: 2026-10-18. Branch `feat/windows-native-cli` (run from `235d90535`; fixes `e3c28f981`, `6617af96c` and
`dbeca9ff8` made during the run). Build `0.4.18-dev.win1` from staging
(`https://cdn.autonomous.ai/harness/staging/cli/install.ps1`, published 2026-10-18; CLI built at `808483702`, terminal
host from [Actions run 39082479868](https://github.com/autonomous-ai/openharness/actions/runs/39082479868)). Because a
`-dev` build never updates itself (`selfUpdate.ts` `isLocalDevBuild`), scenarios 3 and 4 ran on a non-dev N,
`0.4.19-e2e.1`, installed with the same `irm` line from the fake HTTPS CDN (B5.13), with updates `0.4.20-e2e.1`,
`0.4.21-e2e.1` (canary-failing) and `0.4.22-e2e.1` (failing on probation) served from the Mac. This is Task B5.14 of the
plan; the spec's testing section is
[§6 of the design](../superpowers/specs/2026-10-16-windows-native-cli-design.md#6-testing).

**How it was driven.** The UTM VM: Windows 11 Home ARM64, build 10.0.26100.9711, 8 logical CPUs, computer name
`WIN-TESTVM`. Two new standard users, `hxe2e` and `hxe2e2` (in `Users`, not in `Administrators`), were reached
over SSH by key. The PTY driver (`cli/scripts/windows-pty-e2e`, through `run.cmd`) used hxe2e's loopback on port
18474. The Mac's update server (`serve-updates.sh`, `192.168.65.1:8799`) served the updates, and the fake HTTPS CDN
(`fake-cdn.sh` + `vm-cdn.ps1`) was enabled for scenarios 3 and 4 only. The Mac's CLI (signed in to the same account)
read the VM as a remote machine for scenario 5; the desktop app was not driven (no computer use in this session; see
Known limits). Checks that need WMI as a standard user (`check-install.ps1`, the uninstall's last step) ran in a
one-shot scheduled task with the user's password (a batch logon), as B5.12 did: an SSH key logon is a network logon,
which WMI refuses. `C:\work\e2e`'s daemon was not running before or after the run (nothing listened on 1847x).

**Evidence.** [`cli/scripts/windows-cli-e2e/evidence/`](../../cli/scripts/windows-cli-e2e/evidence/), one log per step:
`preflight`, `users`, `s1-*`, `s2-*`, `s3-*`, `s4-*`, `s5-*`, `s6-*`, `rf4-reinstall`, `s7-*`, `mac-*`, `linux-*`,
`cleanup`. No password, token or credential is in them; the Mac's paths are written `~` and `$SCR`.

**Time (Mac clock, +07).** Preflight and users 07:44–07:47. Validation on the VM 07:47–09:13, of which about 21
minutes (08:00–08:21) were the VM hung in UTM's firmware after a warm reboot (waiting), and about 15 minutes were the
reboots and the 5-minute trigger windows (waiting). Implementation of the three fixes, inside that window, about 15
minutes. macOS and Linux 09:13–09:25. Clean-up 09:25–09:27. Writing this document and the report about 25 minutes.
No merge or publication.

## Summary

| # | Scenario | Result | Time |
|---|---|---|---|
| 1 | Install from staging with `irm`, as a new standard user | **Pass** (after fix `e3c28f981` to the check) | install 82 s; 07:47–07:56 |
| 2 | Reboot: back at logon; a dead master back within the 5-minute trigger; with nobody signed in | **Pass** at logon (84 s from boot) and by the trigger (1 min 38 s); stop honoured past a 5-minute mark; **not up with nobody signed in (G1)** | 07:56–08:37 (21 min of it the VM hung) |
| 3 | Update to N+1 with a terminal and Claude Code running: both survive | **Pass** (Claude Code not signed in, carries) | update 23 s after the offer; 08:40–08:45 |
| 4 | Canary-failing N+2 never used; N+3 failing on probation rolled back | **Pass** | rollback 32 s after the offer; 08:45–08:50 |
| 5 | Claude Code, Codex, OpenCode and Kilo hooks report to the Mac desktop (remote) | **Partial**: Kilo bound and seen from the Mac; Claude Code and Codex not verified (not signed in); OpenCode refused on Arm; desktop tiles not driven | 08:50–08:53 |
| 6 | Another local user: no file readable, no trusted call accepted | Files and named pipes: **Pass** (after fix `6617af96c` to the check). Loopback TCP: see the note under Scenario 6, out of scope for this run | 08:53–08:57 |
| 7 | Uninstall: no task, no PATH entry, no files, no process, no hook; --keep-data keeps the data; a half install repaired, then uninstalled | **Pass**, with G2 (engine harnesses refused to stop over SSH) | 08:59–09:13 |
| RF4 | Reinstall over a live install: one restart onto the new build, agents keep running; the same version restarts nothing | **Pass** | run 1 24 s; 08:57–08:59 |
| — | Uninstall on macOS (launchd, or no service when a Harness job is loaded) and Linux | **Pass** after fix `dbeca9ff8` (macOS: no service; Linux: container with an init). The launchd half ran once and is unsafe in a throwaway home (G7) | 09:13–09:25 |
| — | Windows workflow run (`windows.yml`, install job) | [run 39086071140](https://github.com/autonomous-ai/openharness/actions/runs/39086071140) at `7bdeef21a`: both install jobs **success** (the run before, [39083518767](https://github.com/autonomous-ai/openharness/actions/runs/39083518767), failed on the check bug `e3c28f981` fixes) | — |

## Setup recipe

1. Preflight: the staging `install.ps1` names `…/harness/staging/`; nothing listens on 18473/18475; the VM's build.
2. Users: `New-LocalUser -PasswordNeverExpires` (as admin; `net user … /add` asks a Y/N question for a password over
   14 characters and fails over SSH), `Users` group; `first-login.sh` for each (profile and key). hxe2e: `setx PORT
   18474`, `setx ADAPTER_UPDATE_URL http://192.168.65.1:8799/cli/metadata.json`; hxe2e2: `PORT=18476`,
   `ADAPTER_UPDATE_DISABLE=true`. Passwords stayed in the session scratchpad.
3. Batch logon for WMI: `SeBatchLogonRight` for both users (LsaAddAccountRights, removed at the end), and a one-shot
   `schtasks /Create /RU <user> /RP …` running the script with its output to a file.
4. Autologon (scenario 2 only): Winlogon values saved, set for hxe2e, restored exactly by an EXIT trap.
5. Fake CDN (scenarios 3–4 only): `fake-cdn.sh make-ca` (in the scratchpad, `FAKE_CDN_DIR`), `stage 0.4.19-e2e.1` with
   the staging publish's own pty payload (`PTY_VERSION=0.4.18`, the run 39082479868 artifacts; the arm64 zip is
   byte-identical to staging's), `serve`; `vm-cdn.ps1 -Enable` as admin. The staged `install.ps1` is byte-identical to
   the published one (sha256 `042b2a3f…`). `NODE_EXTRA_CA_CERTS` was not needed: the updates came over plain HTTP.
6. Updates: `serve-updates.sh build 0.4.20-e2e.1`, `break-canary 0.4.21-e2e.1`, `break-core 0.4.22-e2e.1`; each
   `notify.mjs` got a `// release <version>` line so its hash names its build.
7. Engines for hxe2e: `%APPDATA%\npm` and `%USERPROFILE%\.local\bin` added raw to the user PATH (REG_EXPAND_SZ), Claude
   Code 2.1.302 (`irm https://claude.ai/install.ps1 | iex`), Codex 0.163.0, OpenCode 1.19.3, Kilo 7.8.12 (npm). No
   engine was signed in.
8. Sign-in for scenario 5: `approve-qr.mts hxe2e@192.168.65.3` (prod), machine `7e92c45a…`, deleted at the end.
9. Warm reboots hang this VM in UTM's firmware ("Start boot option"); every reboot after the first was
   `shutdown /s` and `utmctl start Windows`.
10. macOS uninstall. **Do not** run the launchd/service half (`harness service install`) on a developer's real Mac
    account, even with `HOME` pointed at a throwaway folder: launchd gives the job the account's real `HOME`, and that
    daemon works on the person's real `~/.harness` and engine settings (G7, what run 1 did). Safe recipe: in the
    throwaway `HOME`, run `harness start` (no service), as run 2 did. To test launchd itself, use a separate macOS user
    or a macOS VM, or load a hand-made plist whose `EnvironmentVariables` set `HOME` to the throwaway home.

## Scenario results

### Scenario 1: install from staging

`irm https://cdn.autonomous.ai/harness/staging/cli/install.ps1 | iex` as hxe2e over SSH, exit 0 in 82.3 s
([`s1-install.log`](../../cli/scripts/windows-cli-e2e/evidence/s1-install.log)): Node v22.23.2 (13 s), Harness
`0.4.18-dev.win1`, terminal host 0.4.18, PATH, then about 62 s in `harness service install` waiting for a task that
cannot start over SSH, then `Harness starts when you sign in to Windows; it is not running now: run 'harness start'.`
and the guide. The line before it still says `✗ Task Scheduler has harnessd, but it did not come up…` (G4).

`harness start` took 15.2 s (`Task Scheduler did not start harnessd … — starting it directly`). A new SSH connection
read `● running`, same pid 7500: the daemon survived the session.

`check-install.ps1 -Version 0.4.18-dev.win1`
([`s1-check.log`](../../cli/scripts/windows-cli-e2e/evidence/s1-check.log)):
- over SSH: version, task and PATH `ok`, then `FAIL could not list processes through WMI (Access denied )`, as B5.12
  recorded;
- in a batch logon, twice: `FAIL no harness-pty.exe runs after creating a terminal` with harness-pty 6932 running. A bug
  in the check, fixed in `e3c28f981` (below);
- after the fix: `ok version`, `ok task Harness harnessd (hxe2e)`, `ok PATH has c:\users\hxe2e\.harness\bin`,
  `ok terminal 297854ec… on harness-pty pid 6932 (4 shell(s) under it)`, exit 0.

Process tree (`procs.ps1`): master `node.exe` 7500 whose parent 9744 is gone (`harness-launch.exe` exited), so not under
`sshd`; core 9652 and updater 1004 under it; `harness-pty.exe` 6932 under the core, with OpenConsole and a PowerShell per
terminal. Defender: no 1116/1117 event in the last 30; no SmartScreen event. Layout
([`s1-layout.log`](../../cli/scripts/windows-cli-e2e/evidence/s1-layout.log)): `bin\harness.exe`,
`bin\harness-launch.exe`, `cli\0.4.18-dev.win1\{cli.js,notify.mjs,package.json}`, `cli\current` = `0.4.18-dev.win1`,
`cli\notify.mjs`, `cli\data\`, `runtime\node-v22.23.2-win32-arm64`, `runtime\pty\0.4.18`.

### Scenario 2: reboot, the 5-minute trigger, the stop marker, nobody signed in

The task is `\Harness harnessd (hxe2e)`, Logon Mode `Interactive only` (InteractiveToken), logon trigger plus a
5-minute repetition, action `harness-launch.exe --root … -- start --if-down`. Winlogon before: `AutoAdminLogon '0'`,
`DefaultUserName 'admin'`, `DefaultDomainName '.'`, no `DefaultPassword`; restored exactly (`restored exactly: True`,
[`s2-winlogon.log`](../../cli/scripts/windows-cli-e2e/evidence/s2-winlogon.log)).

- **Autologon reboot** ([`s2-reboot.log`](../../cli/scripts/windows-cli-e2e/evidence/s2-reboot.log)). The first warm
  reboot hung in UTM's firmware for 21 minutes; the VM was power-cycled. Boot 18:21:47 (VM clock), task ran 18:22:14
  (result 0), master 18:22:35, core ready 18:23:03, `● running` read at 18:23:11: **84 s from boot**. Master 7356,
  parent gone.
- **The 5-minute trigger** ([`s2-trigger.log`](../../cli/scripts/windows-cli-e2e/evidence/s2-trigger.log)). Admin
  `taskkill /PID 7356 /F` at 18:23:26; status `○ stopped`; the task ran at 18:25:01, core ready 18:25:04, new master
  7892: **1 min 38 s**. The terminal host 9672 lived through it.
- **The stop marker** ([`s2-stopped.log`](../../cli/scripts/windows-cli-e2e/evidence/s2-stopped.log)). `harness stop`
  at 18:25:14 wrote `{"boot":1792286507337}`. The task ran at 18:30:01 (result 0) and started nothing: at 18:31:56
  still `○ stopped`. Reboot with the marker in place: boot 18:32:23, core ready 18:33:23 (60 s): a marker from an
  earlier boot is not honoured. B3.21's deferred steps 5 and 6 are covered.
- **Nobody signed in** ([`s2-nologon.log`](../../cli/scripts/windows-cli-e2e/evidence/s2-nologon.log)). Autologon
  restored, then a reboot: boot 18:33:57; three minutes later no hxe2e process, the task's last run still 18:32:51
  (before the shutdown), status `○ stopped`. With `Interactive only` the task never runs without a session: **the
  remote machine is not back after a reboot with nobody signed in (G1)**.

### Scenario 3: update to N+1 while harnesses run

First the brief's flow on the staging build
([`s3-dev-check.log`](../../cli/scripts/windows-cli-e2e/evidence/s3-dev-check.log)): with `0.4.20-e2e.1` offered,
`0.4.18-dev.win1` fetched the Mac's `metadata.json` at 08:40:45 and 08:41:45 and staged nothing; its log says only
`self-update on · v0.4.18-dev.win1 · every 60s` (G5). So the carries' path was used: the fake CDN on, and the same
`irm` line installed `0.4.19-e2e.1` over the live daemon in 19.6 s, printing `Moving the running Harness from
0.4.18-dev.win1 to 0.4.19-e2e.1 (your agents keep running)...`
([`s3-install-n.log`](../../cli/scripts/windows-cli-e2e/evidence/s3-install-n.log),
[`s3-cdn.log`](../../cli/scripts/windows-cli-e2e/evidence/s3-cdn.log)).

Before ([`s3-before.log`](../../cli/scripts/windows-cli-e2e/evidence/s3-before.log)): terminal `c66db6da…` answered
`BEFORE_42`; Claude Code `47324568…` showed its first-run theme picker (not signed in). Master 2312, core and updater
3344/5656, `harness-pty.exe` 5028 started 18:40:04.

`0.4.20-e2e.1` offered at 08:43:30 ([`s3-offer.log`](../../cli/scripts/windows-cli-e2e/evidence/s3-offer.log));
`harness version` said it 23 s later. The log: `staged 0.4.20-e2e.1` 18:43:47, `handed over to the new master (pid
2952)` 18:43:49, `the update stayed up — keeping it` 18:44:20. After
([`s3-after.log`](../../cli/scripts/windows-cli-e2e/evidence/s3-after.log)): `harness version` and `harness status`
`0.4.20-e2e.1`, `cli\current` = `0.4.20-e2e.1`, `cli\` holds `0.4.19-e2e.1` and `0.4.20-e2e.1`; the stable
`cli\notify.mjs` hash `a177f39f…` is N+1's; the same two ids and panes (`%3001`, `%3002`); `AFTER_42`; Claude's screen
unchanged; master 2952, core/updater 3276/4368; `harness-pty.exe` 5028, start 18:40:04, unchanged. **Pass.** The
terminal's row read `"status":"offline"` after the update while its shell answered (G3).

### Scenario 4: a failing build is rolled back

- **Canary** ([`s4-canary.log`](../../cli/scripts/windows-cli-e2e/evidence/s4-canary.log)): `0.4.21-e2e.1` offered;
  `18:45:45 newer build available` and `18:45:47 0.4.21-e2e.1 failed its canary (exit 3) — not trying it again for
  120 s`. 180 s later `cli\current` = `0.4.20-e2e.1`, no `0.4.21-e2e.1` folder, master 2952 unchanged.
- **Probation** ([`s4-probation.log`](../../cli/scripts/windows-cli-e2e/evidence/s4-probation.log)): `0.4.22-e2e.1`
  offered; staged 18:48:47, `took over from the master before it (pid 2952)` 18:48:51, `the updated core failed
  (code 1) — rolled back to the previous bundle; restarting` 18:48:52. Seen **32 s after the offer**. Then
  `harness status` `0.4.20-e2e.1` (master 6704), `cli\current` = `0.4.20-e2e.1`, `update-rejected.json` =
  `["0.4.22-e2e.1"]`, `cli\` = `0.4.19-e2e.1`, `0.4.20-e2e.1` (the two newest good builds; the rolled-back folder gone),
  both harnesses listed, `ROLLBACK_42`, `harness-pty.exe` 5028 unchanged. **Pass.** After the rollback the updater
  logged `self-update on · v0.4.22-e2e.1` (G5).

The fake CDN was then disabled: hosts sha256 back to `2d6bdfb3…` (byte-identical) and the CA gone from Root.

### Scenario 5: engine hooks, and the Mac reading the VM

Sign-in: `approve-qr.mts` → `result success`, `machine registered: 7e92c45a…`
([`s5-login.log`](../../cli/scripts/windows-cli-e2e/evidence/s5-login.log)). After `harness stop` / `harness start`:
`● started · connecting to the backend`, then `backend connected`. The Mac's `harness machines --json` lists
`WIN-TESTVM` `running`; the Mac's `harness ps --machine 7e92c45a… --all --json`
([`s5-remote.log`](../../cli/scripts/windows-cli-e2e/evidence/s5-remote.log)) lists the VM's harnesses with Kilo
`"state": "idle"`, `"asks": ["Reply with only the number: what is 6 times 7?"]`, `"about": "42"`.

| Engine | Result | Hook runner (B4), from [`s5-hookfiles.log`](../../cli/scripts/windows-cli-e2e/evidence/s5-hookfiles.log) |
|---|---|---|
| Claude Code 2.1.302 | not verified: needs Claude Code sign-in (it stays on its first-run screen) | `command` = the managed `node.exe`, `args` = `notify.mjs …` (no shell) |
| Codex 0.163.0 | not verified: needs Codex sign-in (its sign-in screen) | a PowerShell line, `& '…\node.exe' '…\notify.mjs' --port 18474 … --engine codex` |
| OpenCode 1.19.3 | refused: `ENGINE_LAUNCH_REFUSED OpenCode does not run on Windows on Arm yet: its Arm build stops before its screen opens. Use another engine on this computer.` | plugins `C:\Users\hxe2e\.config\opencode\plugin\launcher-register.js`, `…\plugins\launcher-register\tui.js` |
| Kilo 7.8.12 | **bound**: answered `42` (free model), row `sessionId` `ses_eb34…`, log `[hooks] ses_eb34 session-start · engine=kilo · isNew=true` | plugin `C:\Users\hxe2e\.config\kilo\plugin\launcher-register.js` |

Command Code's hooks went to `C:\Users\hxe2e\.commandcode\settings.json` (COMMANDCODE_HOME unset), as B4.13/B4.15
expect. Copilot, Pi and Amp files were written too. The Claude Code resume check (A's F6) was not run: there is no
Claude session without a sign-in. The desktop tiles were not driven (Known limits).

### Scenario 6: a second user

[`s6-second-user.log`](../../cli/scripts/windows-cli-e2e/evidence/s6-second-user.log): hxe2e2 installed
`0.4.18-dev.win1` and started on 18476. `check-install` first passed while naming **hxe2e's** host (`pid 5028`): it
matched every user's `harness-pty.exe` by name. Fixed in `6617af96c`; again: `ok terminal 2541c62a… on harness-pty pid
7076`, exit 0. `schtasks` lists `\Harness harnessd (hxe2e)` and `\Harness harnessd (hxe2e2)`.

Trust ([`s6-other-user.log`](../../cli/scripts/windows-cli-e2e/evidence/s6-other-user.log)), as hxe2e2 against hxe2e:
- `daemon-18474.json`, `daemon-token`, `hook-credential`: each `refused EPERM`;
- pipes hxe2e2 could list: `harness-41b22efa…` (hxe2e's daemon), `harness-pty-bddfac6e…`, `harness-claim-6ae5b773…`:
  each `error EPERM` (cannot open), with and without a forged proof; hxe2e2's own pipes answered `401
  PIPE_AUTH_REQUIRED` or reset;
- hxe2e's own `harness status` through its pipe: `● running · backend connected`.

hxe2e2's uninstall over SSH: every step, then `✗ Harness is only partly uninstalled: · Windows did not start the step
that removes Harness's files once this command has ended. (Access denied) Windows refused to start it, as it does for a
standard user signed in over SSH; run harness uninstall at the desktop, or delete C:\Users\hxe2e2\.harness yourself.`
Terminal hosts by pid and start: before `5028 18:40:04.889 hxe2e`, `7076 18:54:38.625 hxe2e2`; after, only
`5028 18:40:04.889 hxe2e`. Run again from a batch logon: `Harness is uninstalled.`, exit 0 in 2.1 s;
`check-uninstall`: `clean`. hxe2e's daemon (pid 6100) still ran and its task was still registered.

Note: a security observation from S6 was reported to the maintainers; details are not kept here.

### Reinstall over a live install

[`rf4-reinstall.log`](../../cli/scripts/windows-cli-e2e/evidence/rf4-reinstall.log). With hxe2e on `0.4.20-e2e.1`
(signed in) and the update server stopped, a COUNTER terminal `b5c7e44b…` printed `COUNT_n` each second.

- **Run 1**, staging's `0.4.18-dev.win1` over the live `0.4.20-e2e.1`, 24.4 s: `Moving the running Harness from
  0.4.20-e2e.1 to 0.4.18-dev.win1 (your agents keep running)...`, `machine stopped (pid 6100)`, started directly,
  `harnessd is registered with Task Scheduler already … nothing to change`. After: `harness version` and status
  `0.4.18-dev.win1`; master 6100 → 7156, core/updater 7128/5356 → 2840/2848 (once); `harness-pty.exe` 5028, started
  18:40:04, unchanged; `cli\` holds `0.4.18-dev.win1` and `0.4.20-e2e.1` (N+1 kept as the build to go back to,
  `0.4.19-e2e.1` retired); COUNTER `COUNT_43`/`COUNT_44`, then `COUNT_51`/`COUNT_52` five seconds later; same id;
  `check-install` all `ok` (one PATH entry). No "being used by another process".
- **Run 2**, the same version: no `Moving` line, master 7156 before and after.

**Pass.**

### Scenario 7: uninstall

**Round 1** ([`s7-uninstall.log`](../../cli/scripts/windows-cli-e2e/evidence/s7-uninstall.log),
[`s7-check.log`](../../cli/scripts/windows-cli-e2e/evidence/s7-check.log)). Before: user PATH `[ExpandString]
%USERPROFILE%\AppData\Local\Microsoft\WindowsApps;C:\Users\hxe2e\.harness\bin;%APPDATA%\npm;%USERPROFILE%\.local\bin`.
A Claude harness made 3 s before (not bound, B5.10), and `cli\data\harnessd-task.xml` deleted first (the task still
registered). Over SSH, `harness uninstall --yes`: `✓ stopped 4 harnesses`, `✓ removed the Harness daemon from Task
Scheduler`, `✓ stopped the Harness daemon (pid 7156)`, `✓ ended 3 terminals in the Harness terminal host`, the hooks of
Claude Code, Codex (and its `config.toml` record), Copilot, Command Code, the Kilo, Pi, Amp and both OpenCode plugin
files, `✓ removed ~\.harness\bin from your PATH`; then exit 1 with three harnesses that `did not stop
(IDENTITY_UNAVAILABLE: Conversation identity is held: the native ps probe did not complete.)` (both Claude harnesses,
including the unbound one, and Codex; G2) and the WMI sentence above. No hxe2e process was left (the host's end took
them). From a batch logon: `~\.harness goes once this command has exited (…harness-uninstall-1464-….log)`,
`Harness is uninstalled.`, exit 0 in 1.7 s.

Checks: `check-uninstall -HookFiles <the six plugin and hook files>`: `clean: nothing of Harness is left … and 6 hook
file(s) named by -HookFiles`. `procs.ps1`: nothing. PATH after: `[ExpandString]
%USERPROFILE%\AppData\Local\Microsoft\WindowsApps;%APPDATA%\npm;%USERPROFILE%\.local\bin`: only Harness's entry gone,
kind and `%VAR%` kept (B5.3). Claude, Codex and Command Code settings hold `"hooks": {}`; `rules\harness.rules`
absent. No `~\.harness`, no `harness.exe~RF*.TMP`, no `harness-uninstall-*` in `%TEMP%` (B5.9). The task, its file
deleted first, was removed (B5.9). The test variables were then deleted.

**Round 2, --keep-data** ([`s7-keepdata.log`](../../cli/scripts/windows-cli-e2e/evidence/s7-keepdata.log)): install,
`harness start` (pid 5240), a reboot (nobody signed in, so `adapter.pid` names 5240, no process), then
`harness uninstall --yes --keep-data` from a batch logon: exit 0 in 21.2 s, `Harness is uninstalled. Your sign-in and
history are kept for the next install.`, and no problem about the stale pid (B5.9). Kept: `cli\data` (registry, logs,
`daemon-18474.json` …), `computer-id`, `agent-messages`, `connections`, `dsh`, `hook-routes`. Gone: `bin`, `runtime`,
`cli\<version>`, `cli\current`. `auth` did not exist: round 1 had removed it and this install was not signed in, so
the sign-in's survival was not shown here. With no `harness.exe` left, the full uninstall of that data is round 3's.

**Round 3, a half install** ([`s7-half.log`](../../cli/scripts/windows-cli-e2e/evidence/s7-half.log)): install over the
kept data; `del cli\current`; `harness version` → `Harness is not installed completely; to install it again, open
PowerShell and run: irm https://cdn.autonomous.ai/harness/cli/install.ps1 | iex`, exit 3 (B1.8's code; the brief's
pass line says 1). The installer again: `cli\current` = `0.4.18-dev.win1`. From a batch logon `harness uninstall
--yes`: exit 0 in 12 s. `check-uninstall`: `clean` (its first run in the log is the run's own mistake, a list mangled
by zsh's `echo`). **Pass.**

### Uninstall on macOS and Linux

**macOS** ([`mac-launchd.log`](../../cli/scripts/windows-cli-e2e/evidence/mac-launchd.log)). No Harness job was loaded,
so run 1 took the launchd half ([`mac-run.log`](../../cli/scripts/windows-cli-e2e/evidence/mac-run.log)). `harness
service install` in the throwaway home printed `✗ launchd has harnessd, but it did not come up`, and the launchd-started
daemon ran with the **person's real home**: launchd gives the job the account's `HOME`, which the plist does not set,
so it used the real `~/.harness/cli/data` and rewrote the real engine hook files (G7; repaired, see Clean-up). The
uninstall then removed the launchd job (`launchctl print` afterwards: not found), both launchers and the `~/.zshrc`
line, but ended `could not remove ~/.harness/runtime`, exit 1: the managed grid's `bin` folder is read-only (0555).
Fixed in `dbeca9ff8`. Run 2 ([`mac-run-2.log`](../../cli/scripts/windows-cli-e2e/evidence/mac-run-2.log)), with no
service (`harness start` inside the throwaway home) and the fix: `✓ stopped 1 harness`, `✓ stopped the Harness daemon
(pid 75875)`, every hook file, `~/.local/bin/harness` and `hn`, the `~/.zshrc` line, `✓ removed ~/.harness`,
`Harness is uninstalled.`, exit 0 in 1 s. No `~/.harness`, `~/.local/bin` empty, no installer line, no LaunchAgents,
no process. The real daemon was not stopped or restarted by either run. **Do not** repeat run 1 on a developer's
Mac: use the no-service recipe (Setup recipe, step 10), a separate macOS user or a VM.

**Linux** (Ubuntu 24.04 container, user `hx`). `install.sh` needs tmux and the user has no sudo, so tmux was installed
as root first ([`linux-install.log`](../../cli/scripts/windows-cli-e2e/evidence/linux-install.log)). Run 1, a container
with no init ([`linux-run-1-noinit.log`](../../cli/scripts/windows-cli-e2e/evidence/linux-run-1-noinit.log)): `✗ The
Harness daemon (pid 2857) did not stop. None of Harness's files were deleted.`, exit 1; `ps` shows 2857 as a zombie of
PID 1 (G6). Run 2 with `docker run --init`
([`linux-run.log`](../../cli/scripts/windows-cli-e2e/evidence/linux-run.log)): `✓ stopped 1 harness`, `✓ stopped the
Harness daemon (pid 2818)`, every hook file, both launchers, the `~/.bashrc` and `~/.profile` lines, `✓ removed
~/.harness` (the managed grid included), `Harness is uninstalled.`, exit 0 in 1 s; nothing left, `no process`.

## Fixes made during the run

Each is its own commit with a test that fails without it.

1. **`e3c28f981` fix(windows): check-install counts a lone terminal host.** With one `harness-pty.exe` on the machine,
   `$hosts = Processes …` held one CimInstance (a function's array is unrolled), and Windows PowerShell 5.1 gives a
   CimInstance no `.Count`: the check waited 30 s and failed with the host running. It is also why
   [run 39083518767](https://github.com/autonomous-ai/openharness/actions/runs/39083518767) failed. Test:
   `windowsCiChecks.spec.ts` (every `Processes` result kept an array; on Windows, one process counts as one). Scenario 1
   ran again: pass. [Run 39086071140](https://github.com/autonomous-ai/openharness/actions/runs/39086071140), with it:
   both install jobs pass.
2. **`6617af96c` fix(windows): check-install counts only this install's terminal hosts.** WMI lists every user's
   `harness-pty.exe`; a second user's check named the first user's host and counted its shell, so it would pass with
   its own host missing. Hosts now must run from `$root\`. Test: `windowsCiChecks.spec.ts`. Scenario 6's check ran
   again: pass, naming 7076.
3. **`dbeca9ff8` fix(cli): harness uninstall removes a read-only folder, as the managed grid installs one.** `removeNow`
   makes the target's folders writable when the first removal fails (links never followed) and removes it again. Test:
   `removal.spec.ts` (a 0555 `runtime/grid-…/bin` with a 0555 file and a link to a 0555 folder outside: the tree goes,
   the outside folder keeps its mode). macOS and Linux ran again: pass.

## Findings not fixed

After the final review, G4, G5, G6 and the closing-guide half of G8 are fixed; G1, G2, G3 and G7 are in the
spec's Known limits. That review also split the task in two (the five-minute task, and a logon task that forgets
a `harness stop`) and set the tasks to normal priority. This run predates those changes and did not exercise them.

- **G1. With nobody signed in, the daemon does not come back after a reboot.** The task's logon type is
  InteractiveToken (`Logon Mode: Interactive only`, `harnessd/platform.ts` task XML), so Task Scheduler runs it only in
  a signed-in session; the spec wants a remote machine back after a reboot with nobody signed in. (Running without a
  session needs a stored password or S4U, which B3 chose not to.)
- **G2. Over SSH, the uninstall cannot stop engine harnesses.** For Claude Code and Codex harnesses (bound or not)
  `agent_delete` answered `IDENTITY_UNAVAILABLE … the native ps probe did not complete` in a daemon started over SSH,
  where WMI refuses the user (`lib/uninstall/agents.ts` → the core's identity hold). The terminal host's end then
  closed them, so nothing was left, but the summary said they `may still be running` and exited 1. From a batch logon
  (as at the desktop) it was not seen.
- **G3. Terminal rows read `offline` after a daemon restart** (update, reinstall) while their shell keeps answering
  (`lib/agentFrame.ts`, `status: s.active ? 'active' : 'offline'`). Claude, Codex and Kilo rows stayed `active`.
- **G4. install.ps1 prints `✗ Task Scheduler has harnessd, but it did not come up…`** on every install over SSH, then the
  corrected sentence, and waits about 62 s for the task first (`harness service install`). B5.12 fixed the exit code;
  the ✗ line still prints.
- **G5. The updater's log misleads.** A `-dev` install logs `self-update on · v… · every 60s` and polls every minute,
  but never takes an update (`isLocalDevBuild`), and says nothing about why. After a rollback it logs `self-update on ·
  v<the rolled-back version>`.
- **G6. A zombie daemon counts as alive.** In a container with no init, the stopped master stays a zombie of PID 1;
  `isAlive` (`kill -0`) says alive, and `harness uninstall` removes nothing (`The Harness daemon … did not stop`). The
  help text names containers as a supported place to run.
- **G7. `harness service install` under another HOME starts a daemon on the real home (macOS).** The plist carries
  `CARRIED_ENV` but not `HOME`, and launchd gives the job the account's home. A person's HOME is the account's, so this
  matters for tests (the brief's Step 10 launchd half), not for users. That half must not run on a developer's Mac;
  Setup recipe step 10 gives the safe way.
- **G8. Minor copy.** The installer's closing guide says `harness login # 1. sign in` on a machine already signed in;
  `net user … /add` with a password over 14 characters fails over SSH with `No valid response was provided`.

## Known limits

- The Mac desktop app was not driven: this session had no computer use. The desktop tiles (working, then idle with
  `42`) and their screenshots are not recorded; the Mac's CLI read the same remote rows instead.
- No engine was signed in on hxe2e (carries): Claude Code and Codex bindings, the Claude resume check, and scenario 3's
  "Claude answering" are not verified. OpenCode is refused on Arm; its binding is the x64 CI job's.
- Scenarios 3 and 4 used a non-dev N from the fake CDN; the published staging build itself never updates.
- `--keep-data` was not shown keeping `auth` (none existed in that round).
- The VM's warm reboot hangs in UTM's firmware; reboots were a shutdown and a power-on.
- WMI-dependent checks over SSH need a batch logon (B5.12).

## Clean-up done

- VM ([`cleanup.log`](../../cli/scripts/windows-cli-e2e/evidence/cleanup.log)): `SeBatchLogonRight` removed from both
  users; both users deleted; hxe2e2's profile removed; hxe2e's after a forced unload of its two hives (as in B3.21):
  no `C:\Users\hxe2e*`, no ProfileList key. No `Harness harnessd (…)` task and no `HxE2ERun-*` task left. User variables
  `PORT`, `ADAPTER_UPDATE_URL`, `ADAPTER_UPDATE_DISABLE` deleted before the users went; `NODE_EXTRA_CA_CERTS` was never
  set. hosts sha256 `2d6bdfb341be3a6234b24742377f93aa7c7cfb0d9fd64efa9282c87852e57085`, identical to before; no fake CDN
  CA in Root; `C:\ProgramData\harness-fake-cdn` gone. Winlogon restored exactly, no `DefaultPassword`. The admin
  helper folders (`C:\Users\admin\e2e`, `e2e-b514`) removed. `C:\work\e2e` untouched (its daemon not running before or
  after; nothing on 1847x).
- Account: machine `7e92c45a…` (the only one this run registered) deleted and gone from
  `harness machines`. An older `WIN-TESTVM` row (`5d96588a…`, 2026-10-15) is not this run's and was left.
- Mac: the update server and the fake CDN stopped (8799 and 443 free); both throwaway homes removed; the scratchpad's
  password file, CA and keys, staged CDN and update builds removed. The macOS run 1 repair (G7): in the real
  `~/.harness/cli/data`, `adapter.pid` written back with the running master's pid (19304) and the stray
  `daemon-18491.json` removed; in 16 real engine files (Claude, Codex, Copilot, Command Code, Gemini, Cursor, Grok,
  Hermes, Devin, the OpenCode, Kilo, Pi and Amp plugins, and `~/.harness/hook-routes`) the throwaway `notify.mjs` path
  and port 18491 replaced with the real ones, and Codex's `config.toml` review records for Harness's hooks recomputed.
  `harness status` reads `● running` (pid 19304). Originals kept in the session scratchpad.
- Linux: container `hx-uninstall` removed.


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
  `WIN-TESTVM\hb3`, which is hb3's SID in the file written; `<Interval>PT5M</Interval>`;
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
  because its processes ended when its console closed. Fixed in B3.22: the signaller ends the tree with
  TerminateProcess over the host's process table (`lib/windows/treeKill.ts`); see "B3.22" below.
- **F2. On Windows every service runs in the core's process, and the log gives the wrong reason.** `masterEnv`
  gets no socket path on win32, sets `HARNESSD_SERVICES=none`, and logs the Unix-socket line at every start. Only
  the updater, which belongs to the master, ran in a process of its own. Fixed in B3.22: the line says `on Windows the services run in the core's process`.
- **F3. Engine hooks are never installed on Windows.** At every core start, `[hooks] failed to write …:
  HookPreparationHeld: Hook preparation is waiting: the configuration directory exceeds its path limit` is logged
  with a stack trace, for 12 engines' files (over 100 lines per start). `nativeHookFiles.ts` `directoryPath` and
  `syncDirectoryChain` walk up to `/`. This is outside B3.
- **F4. Minor.**
  - A core ended by TerminateProcess is logged as `code 4294967295`, which is -1 read as unsigned. Fixed in B3.22.
  - `harness service install` warns that `PORT` is "set only here" even when it is set for the Windows user with
    `setx` (the code says it cannot tell the two apart). Fixed in B3.22 for `PORT`.
  - B1.9's concern did not come back: no `harness service install exited 1` under `-NoService`.

## B3.22: an agent's tree ended without taskkill

Date: 2026-10-17. Branch `feat/windows-native-cli` on `a5339f101` with B3.22's changes. Same VM. The pty host is the
release build B3.21 made (0.4.91); the CLI bundle `0.4.95-b22` was built on the Mac from this tree and installed from
a local manifest (`windows-install-manifest.mjs`, the B1 payload's `conpty.dll` and `OpenConsole.exe`).

**Who ran it.** A fresh standard user `hb22`, made as in B3 (`New-LocalUser -PasswordNeverExpires`, `Users`,
userenv `CreateProfile`, the admin key copied). Over SSH its token is a network logon (`NT AUTHORITY\NETWORK`), not an
administrator's. It set `PORT=18622` and `ADAPTER_UPDATE_DISABLE=1` with `setx`. Install: `install.ps1 -Manifest …
-NoService`.

**F1 reproduced, then gone.**
- As `hb22`, `taskkill /PID <its own ping> /T /F` gave `ERROR: Access denied` (exit 1); `Stop-Process` ended it.
- As `hb22`, over SSH, with the real pty host: `treeKill.real.spec.ts`, `processControl.real.spec.ts` (a pane's
  engine ended through `signalAgentProcess`, and a restart that respawns in the same pane) and
  `terminate.real.spec.ts`: **4 passed (3 files)**.
- The control: the same `processControl.real.spec.ts` from `a5339f101` (the taskkill signaller), run as `hb22`:
  **2 failed**, each with `[terminal] ptyhost: taskkill could not end pid … (SIGKILL|SIGTERM)` and the engine still
  running after 30 s.
- As admin: `treeKill.real.spec.ts` (node → cmd → ping: ping, then cmd, then node; a bystander lives),
  `terminate.real.spec.ts`, `taskScheduler.real.spec.ts` (with its new disabled control) and
  `processControl.real.spec.ts`: all passed.

**The daemon, as `hb22`.** `harness start` came up on 18622. Its master's first line was
`[harnessd] on Windows the services run in the core's process`. A PowerShell agent was made over the local
WebSocket and ran `ping -t`. `agent_restart` ended the shell and its ping (`[restart] … terminal · fresh shell`) and
`agent_delete` left no ping. A terminal agent's restart and delete go through the host's respawn and pane kill (the
pane's Job), not the agent signaller: the signaller is for engine agents, which the real specs above cover on the
same host. An engine agent through the daemon was not reached: a stand-in `opencode.exe` was held at create with
`NATIVE_LAUNCH_HELD` ("Waiting for the selected engine executable to stop changing"), not looked into further.

**F4.** `Stop-Process` on the core, as `hb22`: `[harnessd] core exited (code -1, crashed) — restarting in 500 ms`,
then `core started … restart 1` and `core ready`. `harness service install` with this shell's `PORT` the same as the
user's: no `PORT` warning; with `PORT=18623` in the shell: `PORT, ADAPTER_UPDATE_DISABLE set only here do not reach
it`. `ADAPTER_UPDATE_DISABLE`, also set with `setx`, is still warned of: only `PORT` is read back.

**Clean-up.** As `hb22`: `harness service uninstall`, `harness stop`, its pty host ended, `PORT` and
`ADAPTER_UPDATE_DISABLE` deleted. As admin: the user removed; its profile removed after a forced unload of its two
hives (a service held them, as in B3); `C:\work\b22` removed. Afterwards: no `hb22`, no `C:\Users\hb22`, no
ProfileList key, no Harness or `HarnessTest` task, no Harness process. `C:\work\e2e` and the admin profile were not
touched.
