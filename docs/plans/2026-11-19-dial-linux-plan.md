# The dial on Linux — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. A task with no red test is one commit. No task pushes or merges, and every task ends green.

**Goal:** On a Linux desktop the daemon is there after login, a dial the account cannot open says how to fix it, a tap brings the agent's window forward where the desktop allows it, app links open where the apps exist, and WezTerm, Zellij and kitty take the dial's words (Zellij and kitty on macOS too).

**Architecture:**
- **One pull request, one queue** (spec decision 9). Everything is in the devices component (`cli/src/cable/`, `cli/src/devices/`, one wiring file `cli/src/services/devices.ts`), the installer (`cli/scripts/install.sh`) and the hook (`cli/hook/notify.mjs`). Nothing in `cli/src/core/`.
- **Facts first.** Eight tasks record the real tools in disposable Ubuntu containers and commit only their output as fixtures under `cli/src/testing/`; every adapter and raise backend is built against its fixture.
- **The raise is two small modules with one interface each:** `linuxDesktop.ts` finds which desktop this login exposes, `linuxRaise.ts` raises a window through one backend file per desktop. `open.ts` calls it where macOS calls `open -b`.
- **Each host is one adapter file** (`adapter.ts`'s contract), named once in `services/devices.ts`.

**Tech Stack:** TypeScript (Node 24, vitest) in `cli/`; POSIX sh (`install.sh`); one Dart test in `desktop/`; GitHub Actions (`cli-e2e.yml`). Docker/OrbStack on this Mac for the recordings.

**Spec:** `docs/plans/2026-11-19-dial-linux-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` (Protect the core; rules 4-6), `cli/src/services/AGENTS.md` ("A service that drives hardware"), `docs/specs/2026-11-15-device-host-adapter.md` and `docs/validation-and-release.md` ("What PR CI does not run").

## Base

- `feat/dial-linux` at `6dcb285e7d` (`main` after #4480). The spec and this plan are untracked; the main session commits them, no task does.
- Line numbers below are the base's. A task follows the expression it names when a line has moved.
- A worktree with no `cli/node_modules` runs `npm ci` in `cli/` first. `docker` (OrbStack's engine) and `actionlint` are on this Mac.
- Two other branches touch files this one touches; whoever merges second rebases:
  - the Windows side: `devices/orcaHomes.ts`, `hosts/orca.ts`, `devices/dialSkill.ts`, `hosts/herdrClient.ts`, `cable/dialHomeSetup.ts`, `devices/claudePlugin.ts`, `deviceClaude/command.ts`. Here only `orcaHomes.ts` changes, by two lines (T17); `orca.ts` is imported, never edited.
  - `fix/dial-claude-app-idle-sessions`: `services/devices.ts`, `hosts/observed.ts`, `registry.ts`, `select.ts`, `appFilter.ts`, `cable/cableHost.ts`. Here: `devices.ts` in T23, T40, T46 (and T47), each a few lines at the adapter list and the opener; `observed.ts` gets one added method (T37). No listing source is added; one added later follows that branch's "ended" rule after the rebase (spec decision 10).

## Tasks at a glance

`H/` is `cli/src/cable/hosts/`, `T/` is `cli/src/testing/`, `E/` is `cli/e2e/`. A `.ts` named with "+ spec" is the file and its `.spec.ts` beside it.

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| **Recordings** | | | | |
| 1 Linux app packages | `T/recordedLinuxApps.ts` | none | high | none: fixture only |
| 2 wmctrl on X11 | `T/recordedWmctrl.ts` | none | high | none: fixture only |
| 3 sway | `T/recordedSway.ts` | none | high | none: fixture only |
| 4 Hyprland | `T/recordedHyprland.ts` | none | high | none: fixture only |
| 5 KWin scripting | `T/recordedKwin.ts` | none | high | none: fixture only |
| 6 GNOME Shell extension | `T/recordedGnomeShell.ts` | none | high | none: fixture only |
| 7 Zellij 0.44 | `T/recordedZellij.ts` | none | high | none: fixture only |
| 8 kitty | `T/recordedKitty.ts` | none | high | none: fixture only |
| **Part 1: base** | | | | |
| 9 The login entry | `cli/scripts/install.sh`, `cli/src/scripts/install.spec.ts` | none | high | `install.spec.ts` (new describe) |
| 10 Uninstall removes its own login entry | `cli/src/lib/uninstall/loginEntry.ts` + spec (new), `cli/src/lib/uninstall/command.ts` + spec, `cli/src/lib/uninstall/deps.ts` | 9 | high | `loginEntry.spec.ts`, `command.spec.ts` (new cases) |
| 11 Two starts at once leave one master | `E/cli.e2e.ts` | none | high | none: pins what the CLI does today, one commit |
| 12 A port the account cannot open is a typed error | `cli/src/cable/portAccess.ts` + spec (new), `cli/src/cable/serial.ts`, `cli/src/cable/serial.spec.ts` | none | high | `portAccess.spec.ts`, `serial.spec.ts` (new case) |
| 13 The session shows the problem, and says it once | `cli/src/cable/cableSession.ts` + spec | 12 | high | `cableSession.spec.ts` (new cases) |
| 14 The fleet keeps a row for a port that never opened | `cli/src/cable/cableFleet.ts` + spec | none | medium | `cableFleet.spec.ts` (new cases) |
| 15 Desktop draws the problem-only row | `desktop/test/devices_controller_test.dart` | none | medium | none: pins what Desktop does today, one commit |
| 16 Fast user switching on Linux | `cli/src/cable/usbConsoleUser.ts` + spec | none | high | `usbConsoleUser.spec.ts` (new cases) |
| 17 Orca's CLI on Linux | `cli/src/devices/orcaHomes.ts` + spec | none | medium | `orcaHomes.spec.ts` (new cases) |
| 18 WezTerm types | `H/wezterm.ts` + spec | none | high | `wezterm.spec.ts` |
| 19 Links open on Linux | `H/appLink.ts` + spec, `H/vscode.spec.ts`, `H/claudeApp.spec.ts`, `H/codexApp.spec.ts`, `H/cmuxApp.spec.ts`, `E/harness/daemon.ts` | none | high | `appLink.spec.ts`, `codexApp.spec.ts` (new cases) |
| 20 The Claude and ChatGPT apps' exe names | `H/frontApp.ts` + spec | 1 | medium | `frontApp.spec.ts` |
| 21 The extension's tab on Linux | `H/vscode.ts`, `H/vscode.spec.ts` | 19 | medium | `vscode.spec.ts` (new cases) |
| 22 The Claude app's session on Linux | `H/claudeApp.ts`, `H/claudeApp.spec.ts` | 19 | medium | `claudeApp.spec.ts` (new cases) |
| 23 Cursor's folder window on Linux | `H/cursorFolder.ts` + spec, `cli/src/devices/vscodeExtension.ts` + spec, `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts` | 1, 36 | high | `cursorFolder.spec.ts`, `vscodeExtension.spec.ts`, `devices.spec.ts` (new cases) |
| 24 `cli-e2e.yml` runs the dial's hosts | `.github/workflows/cli-e2e.yml`, `cli/vitest.e2e.ci.config.ts`, `cli/vitest.e2e.dialHosts.config.ts` (new), `E/harness/dialHosts.ts` (new), `E/harness/herdrServer.ts`, `E/deviceHerdr.e2e.ts`, `docs/validation-and-release.md` | 7 | high | none: workflow, one commit |
| 25 E2E: WezTerm takes the words | `E/dialHostWezterm.e2e.ts`, `E/harness/weztermMux.ts` (new) | 18, 24 | high | none: pins T18, one commit |
| 26 E2E: the port's problem and its copy | `E/dialHostPortAccess.e2e.ts` (new) | 13, 14, 24 | high | none: pins T12-T14, one commit |
| **Part 2: a tap raises the window** | | | | |
| 27 The session's sockets reach the daemon | `cli/src/lib/startEnvironment.ts` + spec | none | medium | `startEnvironment.spec.ts` |
| 28 Which desktop this login exposes | `H/linuxDesktop.ts` + spec (new) | 5, 6 | xhigh | `linuxDesktop.spec.ts` |
| 29 Each app's window class | `H/frontApp.ts` + spec | 1, 20 | medium | `frontApp.spec.ts` (new cases) |
| 30 The raise | `H/linuxRaise.ts` + spec (new) | 28 | high | `linuxRaise.spec.ts` |
| 31 sway | `H/linuxRaiseSway.ts` + spec (new) | 3, 30 | high | `linuxRaiseSway.spec.ts` |
| 32 Hyprland | `H/linuxRaiseHyprland.ts` + spec (new) | 4, 30 | high | `linuxRaiseHyprland.spec.ts` |
| 33 KDE | `H/linuxRaiseKwin.ts` + spec (new) | 5, 30 | xhigh | `linuxRaiseKwin.spec.ts` |
| 34 GNOME | `H/linuxRaiseGnome.ts` + spec (new) | 6, 30 | high | `linuxRaiseGnome.spec.ts` |
| 35 X11 | `H/linuxRaiseX11.ts` + spec (new) | 2, 30 | high | `linuxRaiseX11.spec.ts` |
| 36 tmux says which client it switched | `H/adapter.ts`, `H/tmux.ts`, `H/tmux.spec.ts`, `cli/src/services/devices.spec.ts` (its three fake `list-clients` lines, `:3035-3059`) | none | high | `tmux.spec.ts` (new cases) |
| 37 An agent's process and app, by id | `H/observed.ts`, `H/observed.spec.ts` | none | medium | `observed.spec.ts` (new case) |
| 38 The opener raises on Linux | `H/open.ts`, `H/open.spec.ts` | 30, 36 | xhigh | `open.spec.ts` (new cases) |
| 39 A terminal's tap raises its editor | `H/vscode.ts`, `H/vscode.spec.ts` | 21, 30 | medium | `vscode.spec.ts` (new cases) |
| 40 The devices use the raise | `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts`, `H/linuxRaise.ts` + spec | 23, 29, 31, 32, 33, 34, 35, 37, 38, 39 | high | `devices.spec.ts`, `linuxRaise.spec.ts` (new cases) |
| 41 E2E: X11 | `E/dialHostX11Raise.e2e.ts`, `E/harness/x11Desk.ts` (new) | 24, 40 | high | none: pins T35-T40, one commit |
| 42 E2E: sway | `E/dialHostSwayRaise.e2e.ts`, `E/harness/swayDesk.ts` (new) | 24, 40 | high | none: pins T31-T40, one commit |
| **Part 3: Zellij and kitty** | | | | |
| 43 The hook's new hints | `cli/hook/notify.mjs`, `cli/src/hookNotify.spec.ts` | none | high | `hookNotify.spec.ts` |
| 44 Zellij | `H/zellij.ts` + spec (new) | 7 | xhigh | `zellij.spec.ts` |
| 45 kitty | `H/kitty.ts` + spec (new) | 8 | xhigh | `kitty.spec.ts` |
| 46 Both in the devices' list | `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts` | 40, 44, 45 | high | `devices.spec.ts` (new cases) |
| 47 The dial follows Zellij's focus (only if T7 says `subscribe` reports it) | `H/zellijFollow.ts` + spec (new), `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts` | 7, 46 | xhigh | `zellijFollow.spec.ts`, `devices.spec.ts` |
| 48 E2E: Zellij | `E/dialHostZellij.e2e.ts`, `E/harness/zellijSession.ts` (new) | 24, 43, 46 | high | none: pins T43-T46, one commit |
| 49 E2E: kitty (only if T8 says kitty starts under Xvfb) | `E/dialHostKitty.e2e.ts`, `E/harness/kittyWindow.ts` (new), `.github/workflows/cli-e2e.yml` | 24, 43, 46 | high | none: pins T45-T46, one commit |
| **Docs** | | | | |
| 50 `docs/cli.md` | `docs/cli.md` | 7, 9, 10, 13, 27, 28, 45, 46 | medium | none: docs, one commit |
| 51 The component's own docs | `cli/AGENTS.md`, `docs/specs/2026-11-15-device-host-adapter.md`, `docs/specs/2026-11-14-dial-app-filter.md`, `docs/plans/2026-11-19-dial-linux-design.md` | 1, 7, 8, 16, 20, 40, 46 | medium | none: docs, one commit |

Longest chain: 5 → 28 → 30 → 33 → 40 → 46 → 48 (seven tasks; 47, 49, 50 and 51 end chains of the same length). Tasks 1-9, 11, 12, 14-19, 27, 36, 37 and 43 start at once. `services/devices.ts` is held in turn by 23 → 40 → 46 → 47, and `services/devices.spec.ts` by 36 first (so 23 waits for 36, which shares no code with it); `H/frontApp.ts` by 20 → 29; `H/vscode.ts` by 21 → 39; `H/vscode.spec.ts` and `H/claudeApp.spec.ts` by 19 first; `.github/workflows/cli-e2e.yml` by 24 → 49.

## Global Constraints

- **Platforms.** Linux for everything; macOS also for WezTerm's `type` (T18), Zellij and kitty (T43-T46). No other macOS behavior changes. Windows: no behavior change, and no Windows-only path is touched (the named pipe listener, `windowsSerial.ts`, Task Scheduler, `install.ps1`). `device-app/` is not touched: the Device app on Linux is another session's (spec decision 4).
- **The core.** Nothing under `cli/src/core/`; `cli/src/architecture.coreFiles.txt` is unchanged.
- **Exact copy** (byte for byte):
  - not in the group: `No access to the dial. Run: sudo usermod -aG <group> $USER, then log out and in.` (`$USER` is typed as it is; `<group>` is the device node's group)
  - in the group, this login without it: `No access to the dial yet. Log out and in.`
  - daemon log: `[device] raise · sway`, `· hyprland`, `· kwin`, `· gnome`, `· x11`, and `[device] raise · none · <why>`, `<why>` one of `no desktop session`, `gnome without the extension`, `unknown compositor`, `no swaymsg`, `no hyprctl`, `no wmctrl`
  - daemon log: `[device] kitty · remote control off`
  - the login entry, five lines: `[Desktop Entry]`, `Type=Application`, `Name=Harness`, `Exec="<launcher>" start`, `X-GNOME-Autostart-enabled=true` (no `NoDisplay=true`: GNOME's Startup Applications hides such an entry; changed in the final review)
  - the installer's step line, one of: `  ✓ Starts at login`, `  · Start at login is off`, `  · Start at login: set by another app`
  - the installer's guide line: `  Harness starts when you log in to the desktop.` ("to the desktop" since the final review: a server login never runs the entry)
- **Every command** runs with no shell, each value one argument, within `RUN_TIMEOUT_MS` (10 s, `H/orca.ts`). A pane id, pid, class, socket, session name or display is checked against its form in `paneOf` and again before the command (adapter rule 1). An adapter verb never throws.
- **No process reads another's environment.** The daemon reads its own, and what it reads is on the start allowlist (`lib/startEnvironment.ts`; `src/architecture.startEnvironment.spec.ts` fails otherwise).
- **No switch, flag or setting.** No udev rule. No new UI, no design-doc or gallery change: `desktop/design/desktop-design-system.md` and `test/elements_gallery_test.dart` list no dial problem (checked 2026-11-19).
- **Fixtures hold facts only:** made-up names (user `u`, uid 1000, host `box`, folders under `/work`), no home path, no account, no binary.
- **Tests:** no fixed sleep; a wait is `vi.waitFor` or the e2e `until`. No test reads the developer's own machine (cli/AGENTS.md rule 6). `npm run test:core` holds `services/devices.ts` to 100% per file: T23, T40, T46 and T47 cover every line and branch they add.
- **Logs** name an outcome or a fixed word, never a path, a pane, a session, a folder or a hint's value.

## Decided here, where the spec was silent

- **The access check is its own file** (`cable/portAccess.ts`), so `serial.ts` gains one call. It answers a typed error only when the device's group explains the refusal; otherwise the open fails and is logged as today (Review Focus 5). Only the access problem's line is logged once per change; other open failures log as today.
- **Uninstall removes only its own login entry:** `harness uninstall` removes `harnessd.desktop` when its first `Exec=` is the one install.sh writes, turned off or not; any other file is left (T10). A `X-GNOME-Autostart-enabled=false` or `X-MATE-Autostart-enabled=false` entry is left by the installer as a `Hidden=true` one is (Review Focus 3).
- **How the raise learns the window.** `OpenTarget` is unchanged. `createOpenActions` takes `raise` and `windowOf(agentId)`; `ObservedSource.windowOf` gives an agent's process and app; an adapter may name a nearer process with the new optional `windowPid(pane)` (tmux: the client it switched). The spec says `tmux.ts` already finds that client's pid: it finds its name, so T36 adds `#{client_pid}` to the one `list-clients` call.
- **A raise backend finds the window in the desktop's own listing** (the chain's pids first, nearest first; else a class, compared without case), then names it by pid or by the desktop's own id for it (sway `con_id`, Hyprland `address`, X11 window id). Nothing a window wrote reaches a command line. An app's classes are a short list of spellings (`Code`, `code`): GNOME's extension is asked each in turn.
- **X11 commands run through `env`** (`env DISPLAY=:0 XAUTHORITY=<file> wmctrl …`, each one argument): `OrcaDeps.run` takes no environment, and `orca.ts` is not edited.
- **KDE answers true once its script ran:** a KWin script cannot say whether it found a window.
- **A Wayland session with no known compositor is `none · unknown compositor`:** X11 is tried only when this login has no Wayland socket (the spec's order, made exact). GNOME Shell without the extension on X11 goes on to `x11`.
- **The discovery reads `$XDG_RUNTIME_DIR` only when it is set and absolute;** there is no `/run/user/<uid>` guess.
- **A link's handler is read at the first look at a pane of that app,** not at start: no `xdg-mime` runs for an app no agent is in.
- **Words go only to the agent's own pane.** WezTerm types when `place.host === 'wezterm'` and no `ORCA_TERMINAL_HANDLE` is set (so "WezTerm inside an Orca terminal still takes words through Orca", as today); kitty the same with `kitty`; Zellij when `place.host === 'zellij'` and no `TMUX_PANE` is set. Any other agent with that adapter's pane keeps its tap and gets no words there. The pane id carries it: `7` types, `held:7` only focuses.
- **Order in the devices' list:** herdr, Zellij, tmux, Herdr, cmux, kitty, WezTerm, Orca, … (as `detectHost` ranks them).
- **kitty's binary:** `kitten` on `PATH`, else on macOS `/Applications/kitty.app/Contents/MacOS/kitten`, else `kitty` on `PATH` run as `kitty +kitten`.
- **A Zellij session name is taken only in the form `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`;** another name gets no Zellij pane.
- **`cli-e2e.yml`:** one new job, `e2e (dial hosts)`, in every nightly and manual run, and alone with the new input `dial_hosts`. Its files are `E/dialHost*.e2e.ts` and `E/deviceHerdr.e2e.ts`, left out of the eight shards. With `E2E_DIAL_HOSTS=1` a missing host program fails the file instead of skipping it.
- **The seat is asked of `loginctl`, logind's public CLI** (`/run/systemd/seats/seat0` says "Do not parse"): two calls, `show-seat seat0 --property=ActiveSession --value`, then `show-session <id> --property=User --value` (systemd 255 has no one-call form for a seat's user; checked in `ubuntu:24.04`). No `loginctl`, no seat0, no active session, a session id out of form, a non-zero exit, a timeout or a user that is not a whole number answers true (today's behavior). The answer is kept: `isUsbConsoleUser` stays synchronous for its four callers (`cableFleet.ts:117/178/287/339`), answers the last reading (true before the first) and starts a new reading, one at a time, when the last started 8 s ago or more. The fleet's `reconcile` runs every 2 s with or without a dial, so reading on every call would be two processes every 2 s on every idle Linux daemon; 8 s is the fleet's own pace for `lsof` (`watchEveryMs`). A switch reaches the dial within about 10 s.
- **Cursor's CLI for a folder** is found by one new function beside the extension setup's finder (`devices/vscodeExtension.ts`); the extension setup's own finder is unchanged.

## Review Focus

1. **Words in another pane.** An agent in tmux, Zellij, herdr or Rex inside a WezTerm or kitty window, or in Zellij with tmux's variable, must get no words through the outer host: they would land in whichever pane it shows. Tests: T18, T44, T45 "types only into the agent's own pane".
2. **kitty reads backslash escapes in `send-text`.** Words holding `\n`, `\x1b` or `\\` reach the prompt as typed. Test: T45, against T8's recording.
3. **A login entry the person turned off, or a launcher path with a space, `$` or `%`.** Off the Cinnamon/MATE way stays off; the entry's `Exec=` still starts the launcher. Test: T9.
4. **A hint cut at 64 characters names something else.** `KITTY_LISTEN_ON`, `ZELLIJ_SESSION_NAME` or `ZELLIJ_PANE_ID` over 64 characters is left out, never cut. Test: T43.
5. **A refusal the group does not explain** (the group has no read/write, the gid has no line in `/etc/group`, the login already holds the group, the name is out of form): no advice, no row; the open fails as today. Test: T12.
6. **A socket that is not this account's.** A sway, Hyprland, session-bus or kitty socket owned by another uid is never used; an X socket only when root's or this account's. A stale sway socket beside a live one: the one that answers. Tests: T28, T45.
7. **A problem that outlives its cause.** The row clears when an open succeeds, when the failure becomes another one, when the port is unplugged and when USB passes to another account. Tests: T13, T14.
8. **Harness OS keeps its dial.** Its daemon is a user unit of the seat's own account (`os/root/usr/lib/systemd/user/harness-daemon.service`), so the user of seat0's active session is the daemon's. Test: T16 (same uid → true); a person's check, not a workflow.

---

## Recordings (Tasks 1-8)

Rules for all eight:

- **Where:** a disposable Ubuntu container on this Mac (`docker run --rm …`, OrbStack's engine). Nothing is installed on the Mac, nothing of its home is mounted, and no account is signed in anywhere. A package that exists only for x86-64 is unpacked under `--platform linux/amd64`.
- **What is committed:** one file under `cli/src/testing/`, exporting one `as const` object: the tool's version, each exact argv, its exit code and what it printed. Its header comment says the image, the package versions, the date and how each line was made. Each value says `source: 'recorded'`, or `source: 'published'` with the URL it was copied from where the tool would not run headless (spec § Testing).
- **Names are made up before recording:** user `u` (uid 1000), host `box`, folders under `/work`, window titles `agent` and `other`.
- **No red test.** `npm run typecheck` passes. One commit: `test(dial): <tool> as recorded on Ubuntu <release>`.
- **A recording that contradicts a command the spec names** (a flag, an output's shape) is said in the task's report; the task that consumes it follows the recording and says so in the PR.

### Task 1: Linux app packages

**Produces** `RECORDED_LINUX_APPS` in `T/recordedLinuxApps.ts`, one entry each for `vscode`, `cursor`, `claude` and `chatgpt`, or `null` for an app with no official Linux package that can be downloaded without an account:
`{ source: string /* download URL */, version, sha256, desktopFile /* its file name */, exec /* the Exec= line */, schemes: string[] /* each x-scheme-handler/<scheme> in MimeType= */, schemeDesktopFile /* the .desktop that carries them */, startupWmClass: string | null, comm: string | null /* the running process's name as ps -o comm= prints it, at most 15 characters */, commFrom: 'process' | 'exec name' }`, and for `cursor` also `cliBesideExec: string | null` (an executable `bin/cursor` in the folder of the `Exec=` binary) and `pathCommand: string | null` (what the package puts on `PATH`).

- [ ] **Step 1:** In the container, download each vendor's own Linux package (VS Code and Cursor: their `.deb`; the Claude desktop app's Linux beta and the ChatGPT desktop app's Linux preview: from the vendor's own download page). Read it without running it: `dpkg-deb -c`, `dpkg-deb -x`, then each `.desktop` file's `Exec=`, `MimeType=` and `StartupWMClass=`.
- [ ] **Step 2:** Try each app once under `xvfb-run` for its `comm` (`ps -o comm= -p <pid>`); where it does not start, take the `Exec=` binary's name cut to 15 characters and say `commFrom: 'exec name'`.
- [ ] **Step 3:** Write the fixture, typecheck, commit.

### Task 2: wmctrl on X11

**Produces** `RECORDED_WMCTRL` in `T/recordedWmctrl.ts`: `{ version, lpx: string /* wmctrl -lpx with two xterms under openbox */, pids: { agent: number, other: number }, activate: { args: string[], code: number }, activeBefore: string, activeAfter: string /* xprop -root _NET_ACTIVE_WINDOW */, missing: { args, code, stderr } /* -i -a of an id that is not there */, noDisplay: { code, stderr } }`.

- [ ] **Step 1:** `apt-get install xvfb openbox wmctrl xterm x11-utils`; start `Xvfb :99`, `openbox`, two `xterm -T agent` / `-T other`.
- [ ] **Step 2:** Record each line above; write the fixture, typecheck, commit.

### Task 3: sway

**Produces** `RECORDED_SWAY` in `T/recordedSway.ts`: `{ version, socketName: string /* as it is named in $XDG_RUNTIME_DIR */, tree: string /* swaymsg -t get_tree with two foot windows, one of them an XWayland xterm if it starts */, pids, focusByPid: { args, code, stdout }, focusByConId: { args, code, stdout }, focusNoMatch: { args, code, stdout }, staleSocket: { args, code, stderr } /* swaymsg -s <a socket nobody listens on> -t get_version */ }`.

- [ ] **Step 1:** `apt-get install sway foot`; run `WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 sway` under a private `XDG_RUNTIME_DIR`; two `foot` windows.
- [ ] **Step 2:** Record, write, typecheck, commit.

### Task 4: Hyprland

**Produces** `RECORDED_HYPRLAND` in `T/recordedHyprland.ts`: `{ version, source, runtimeLayout: string[] /* what is under $XDG_RUNTIME_DIR/hypr/<signature>/ */, clients: string /* hyprctl clients -j */, focusByPid: { args, code, stdout }, focusByAddress: { args, code, stdout }, focusNoMatch: { args, code, stdout } }`.

- [ ] **Step 1:** In an Ubuntu release whose archive has `hyprland`, try it headless; if it does not start in a container within the task, take each value from Hyprland's own documentation and source, `source: 'published'` with the URLs, and say in the report whether it "starts cheaply on a runner" (spec § Verification: no e2e then).
- [ ] **Step 2:** Write, typecheck, commit.

### Task 5: KWin scripting

**Produces** `RECORDED_KWIN` in `T/recordedKwin.ts`: `{ version, source, nameHasOwner: { args, stdout } /* dbus-send … NameHasOwner string:org.kde.KWin */, loadScript: { args, stdout }, run: { args, stdout }, unloadScript: { args, stdout }, scriptApi: { list: 'windowList' | 'clientList', active: 'activeWindow' | 'activeClient', pid: string, class: string } /* the property names a script reads, per Plasma version tried */, activated: boolean /* the script's window became the active one */ }`.

- [ ] **Step 1:** Try `kwin_wayland --virtual` under `dbus-run-session` (Plasma 6 where the image has it, Plasma 5 on Ubuntu 24.04), two windows, the spec's `loadScript`, run, unload over `dbus-send`; where KWin does not run headless, the published `org.kde.kwin.Scripting` interface, marked so.
- [ ] **Step 2:** Write, typecheck, commit.

### Task 6: GNOME Shell extension

**Produces** `RECORDED_GNOME_SHELL` in `T/recordedGnomeShell.ts`: `{ version, source, extension: { uuid, version }, shellOwned: { args, stdout }, introspect: { args, code, stdout } /* the extension's object */, introspectWithout: { args, code, stderr } /* the same with the extension off */, activateHit: { args, stdout }, activateMiss: { args, stdout }, wmClassOf: { wayland: string, xwayland: string } /* what the extension compares for a native and an XWayland window */ }`.

- [ ] **Step 1:** Try `gnome-shell --headless --wayland` under `dbus-run-session` with the Activate Window By Title extension from its own repository; else its published D-Bus interface, marked so.
- [ ] **Step 2:** Write, typecheck, commit.

### Task 7: Zellij 0.44

**Produces** `RECORDED_ZELLIJ` in `T/recordedZellij.ts`: `{ version /* exact, 0.44.x */, download: { url, sha256 } /* per architecture */, actionHelp: string, env: { ZELLIJ, ZELLIJ_PANE_ID, ZELLIJ_SESSION_NAME } /* as a pane's shell has them */, sessionNameRule: string /* what zellij accepts, in words */, listPanes: string /* action list-panes --json, a terminal pane and a plugin pane */, focusPaneId: { args, code }, writeChars: { args, code, landed: string /* dump-screen after */ }, sendKeys: { args, code }, missingPane: { args, code, stderr }, missingSession: { args, code, stderr }, subscribe: { help: string, lines: string[], reportsFocus: boolean, why: string } }`.

- [ ] **Step 1:** Install the release binary; `zellij attach --create-background s1`; a second pane; run each command of spec § 3.2 from outside the session.
- [ ] **Step 2:** Run `zellij subscribe` (its `--help`, then every form it offers) while focus moves between the two panes. `reportsFocus` is true only if a line names the newly focused pane without polling; `why` says it in a sentence. **This value decides T47 and two lines of T50 and T51.**
- [ ] **Step 3:** Write, typecheck, commit.

### Task 8: kitty

**Produces** `RECORDED_KITTY` in `T/recordedKitty.ts`: `{ version, startsUnderXvfb: boolean, how: string, env: { KITTY_WINDOW_ID, KITTY_LISTEN_ON } /* as a window's shell has them with listen_on set */, ls: string /* kitten @ --to … ls */, focusWindow: { args, code }, sendText: { args, code, landed: string }, sendTextBackslash: Array<{ sent: string, landed: string }> /* one each for 'a\\nb', '\\x1b[31m' and 'c:\\new' */, sendKey: { args, code }, remoteControlOff: { args, code, stderr }, noSocket: { args, code, stderr }, missingWindow: { args, code, stderr } }`.

- [ ] **Step 1:** `apt-get install kitty xvfb libgl1-mesa-dri`; start kitty under `Xvfb` with `LIBGL_ALWAYS_SOFTWARE=1`, `-o allow_remote_control=socket-only --listen-on unix:/tmp/kitty`. `startsUnderXvfb` says whether it came up; **this value decides T49.** Where it does not, the values come from kitty's remote-control documentation, marked so.
- [ ] **Step 2:** Write, typecheck, commit.

---

## Part 1: base

### Task 9: The login entry (§ 1.1)

**Files:** `cli/scripts/install.sh` (helpers before `# 1. Host requirements`; a new step `# 3d. Start at login (Linux)` between `# 3c. hn's binary` and `# 4. Ensure ~/.local/bin`; the comments at `# 5. Final verification` and above the guide; the guide), `cli/src/scripts/install.spec.ts` (`hnStepOf` ends at the new marker).

**Interfaces (sh):**
- `login_entry_file` prints `<config>/autostart/harnessd.desktop`, `<config>` being `$XDG_CONFIG_HOME` when it starts with `/`, else `$HOME/.config`.
- `login_entry_exec` prints `"<launcher>" start` for `$LAUNCHER`, quoted as the Desktop Entry spec quotes an argument: inside the quotes `\` is `\\\\`, and `"`, `` ` `` and `$` each get `\\` before them; `%` is `%%`.
- `login_entry_on` is true when that file is there, its first `Exec=` line is the launcher's own, and no line turns it off (below). `write_login_entry`: on Linux, in `standalone` and `desktop` mode, writes the five lines (Global Constraints) to a temp file in the same folder, then `mv -f` (mode 0644), **only when** the file is missing, or its first `Exec=` line is exactly `Exec=` + `login_entry_exec` and no line is `Hidden=true`, `X-GNOME-Autostart-enabled=false` or `X-MATE-Autostart-enabled=false`. Any other file is left byte for byte. A launcher path holding a control character writes nothing. It prints one step line: `  ✓ Starts at login` when it wrote or kept its own entry, `  · Start at login is off` for its own entry turned off, `  · Start at login: set by another app` for any other file (Global Constraints).

- [ ] **Step 1: Write the failing tests**, a new `describe("scripts/install.sh: the login entry")` that runs the constants, the helpers and step 3d under `/bin/sh` with a fake `uname` (as `layout` does):
  - `writes it on Linux in standalone and desktop mode`: the file is exactly the five lines with `Exec="<home>/.local/bin/harness" start`, mode `0o644`, and the autostart folder holds no other file; stdout has `  ✓ Starts at login`.
  - `takes XDG_CONFIG_HOME only when it is absolute`: `/x/cfg` → `/x/cfg/autostart/harnessd.desktop`; `cfg` and `""` → `~/.config/autostart/harnessd.desktop`.
  - `writes none on a Mac, and none in host mode`.
  - `leaves an entry the person turned off`, `it.each` over `Hidden=true`, `X-GNOME-Autostart-enabled=false`, `X-MATE-Autostart-enabled=false` added to its own five lines: bytes unchanged; stdout has `  · Start at login is off`.
  - `leaves an entry whose Exec is another program's`: a file with `Exec=/opt/harness-device/harness-device --login` is unchanged; stdout has `  · Start at login: set by another app`.
  - `writes it again once deleted, and rewrites its own`.
  - `quotes a launcher path with a space, a $ and a %`: home `…/a b$c%d` gives `Exec="…/a b\\$c%%d/.local/bin/harness" start`.
  - In `"what it says once it is done"`: on Linux in standalone mode, with its own entry in place (`login_entry_on`), the guide has `  Harness starts when you log in to the desktop.` after the three numbered commands; with no entry, one turned off or another program's, on a Mac, and in desktop mode, it does not.
- [ ] **Step 2:** `npx vitest run src/scripts/install.spec.ts` — FAIL (no entry written). Commit red.
- [ ] **Step 3: Implement** as in Interfaces. The two comments that say installation starts nothing now say: it starts nothing now; on Linux it leaves a login entry that runs `harness start` at the next login.
- [ ] **Step 4:** the same run passes on this Mac (`/bin/sh` is not dash here: the Linux run is PR CI's `cli-tests`).
- [ ] **Step 5: Commit** `Linux: the installer leaves a login entry that starts Harness`.

### Task 10: Uninstall removes its own login entry

**Interfaces:** `cli/src/lib/uninstall/loginEntry.ts`: `removeLoginEntry(deps: { platform, home, configHome?: string, launcher: string, read(path): string | null, remove(path): void }): string | { path: string; failed: string } | null`: on Linux, removes `<config>/autostart/harnessd.desktop` when its first `Exec=` line is exactly the one T9 writes for `launcher` (the same quoting; one exported function builds it), and answers its path; any other file, or none, answers `null`. `UninstallDeps.removeLoginEntry()` is called in the `!windows` step beside `removeLaunchers()`; its line is `✓ removed <path>`, its failure a problem clause as a launcher's.

- [ ] **Step 1: Failing tests:** `loginEntry.spec.ts` (own entry removed; a foreign `Exec=` kept; a `Hidden=true` own entry removed; macOS and Windows touch nothing; `XDG_CONFIG_HOME` absolute or not); `command.spec.ts` (the line is printed; a failure is a problem and the rest still runs).
- [ ] **Step 2:** `npx vitest run src/lib/uninstall` — FAIL. Commit red.
- [ ] **Step 3: Implement**; the real deps in `deps.ts`.
- [ ] **Step 4:** the run and `npm run typecheck` pass.
- [ ] **Step 5: Commit** `harness uninstall removes the login entry the installer wrote`.

### Task 11: Two starts at once leave one master (§ 1.1a)

**Files:** `E/cli.e2e.ts`, in `describe('harness start, stop and status from the installed bundle')`.

- [ ] **Step 1:** Add `it('two starts at once, as the login entry and Desktop: one master')`: `install()`, then `Promise.all([harness(m, 'start'), harness(m, 'start')])`; both exit 0; `pidOf(m)` is one live pid and exactly one process of this root's has a command ending ` __harnessd`; one of the two printed `already running` (after waiting, or not). Then, with `install('systemd')` and `harness service install` and a `harness stop`: two starts at once again leave one master, `platformPid(m)` is it, and no second ` __harnessd` runs beside it.
- [ ] **Step 2:** `npx vitest run --config vitest.e2e.config.ts e2e/cli.e2e.ts -t 'two starts at once'` — passes on this Mac. If it fails, stop and report: the spec says the CLI already holds this.
- [ ] **Step 3: Commit** `test(cli): two starts at once leave one master`.

### Task 12: A port the account cannot open is a typed error (§ 1.2)

**Files:** `cli/src/cable/portAccess.ts` + spec (new; Node built-ins only: `serial.ts` is bundled into the real-port fixtures), `cli/src/cable/serial.ts:290-312` (`SerialLink.open`: one call before the claim and `stty`), `cli/src/cable/serial.spec.ts`.

**Interfaces (produces):**
- `export const NO_ACCESS = (group: string) => \`No access to the dial. Run: sudo usermod -aG ${group} $USER, then log out and in.\``
- `export const NO_ACCESS_YET = 'No access to the dial yet. Log out and in.'`
- `export class PortAccessError extends Error { readonly code = 'EACCES'; constructor(readonly problem: string) }` (`message` is the problem).
- `export interface PortAccessDeps { platform: NodeJS.Platform; access(path: string): void /* accessSync R_OK | W_OK */; stat(path: string): { gid: number; mode: number }; groupFile(): string /* /etc/group */; groups(): readonly number[] /* process.getgroups() */; user: string }`
- `export function portAccessProblem(path: string, deps?: PortAccessDeps): PortAccessError | null`: `null` off Linux, when access is allowed, when it fails with anything but `EACCES`, and in each case of Review Focus 5 (the mode's group bits are not `rw`; no `/etc/group` line has that gid; the name is not `^[A-Za-z_][A-Za-z0-9_.-]{0,31}$`; `groups()` holds the gid). Else `NO_ACCESS_YET` when the gid's line lists `user`, and `NO_ACCESS(name)` when it does not. Any throw inside is `null`.
- `SerialLink.open`: `const denied = portAccessProblem(path); if (denied) throw denied`, first thing on the non-Windows path.

- [ ] **Step 1: Failing tests:** `portAccess.spec.ts`, fake deps, a group file `root:x:0:\ndialout:x:20:bob\nuucp:x:986:\n`:
  - gid 20, user `u`, groups `[1000]` → `problem` is `No access to the dial. Run: sudo usermod -aG dialout $USER, then log out and in.`; gid 986 → `… -aG uucp $USER, …`.
  - gid 20, user `bob`, groups `[1000]` → `No access to the dial yet. Log out and in.`
  - `it.each` Review Focus 5's cases, a non-`EACCES` failure, `darwin`, an `access` that passes, a `stat` that throws → `null`.
  - `serial.spec.ts`: with `./portAccess.js` mocked to answer an error, `SerialLink.open` rejects with it, `io.configure` (stty) and `io.open` are never called.
- [ ] **Step 2:** `npx vitest run src/cable/portAccess.spec.ts src/cable/serial.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the run and `npm run typecheck` pass; on this Mac also `npx vitest run src/cable/serial.real.spec.ts --maxWorkers=1` (the `cli-serial` gate).
- [ ] **Step 5: Commit** `Linux: a dial the account may not open is refused before stty, with what to do`.

### Task 13: The session shows the problem, and says it once (§ 1.2)

**Files:** `cli/src/cable/cableSession.ts:1119-1153` (`tryOpen`'s catch and the line after a port opened), spec.

**Interfaces:** consumes `PortAccessError`. `tryOpen`: on a `PortAccessError` whose `problem` differs from the one showing, log `cable: cannot open the dial: <problem>` and call `host.onDialStatus?.({ attached: false, problem })`; the same problem again logs and reports nothing. Any other failure logs as today and, if a problem was showing, reports `{ attached: false }`. A port that opens while a problem shows reports `{ attached: false }` before anything else.

- [ ] **Step 1: Failing tests** (`cableSession.spec.ts`, a `PortOpener` that rejects):
  - `a dial this account cannot open shows what to do, once`: three opens two seconds apart (fake timers) reject with `new PortAccessError(NO_ACCESS('dialout'))` → `onDialStatus` called once with `{ attached: false, problem: 'No access to the dial. Run: sudo usermod -aG dialout $USER, then log out and in.' }`; the log holds the line once.
  - `the problem changes with the login`: then `NO_ACCESS_YET` → one more status and one more line.
  - `the problem goes when the failure is another one, and when the port opens`: `new Error('busy')` → `{ attached: false }`; an opener that resolves a port → `{ attached: false }` before the greeting's status.
  - `another failure is logged each time, as before`.
- [ ] **Step 2:** `npx vitest run src/cable/cableSession.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.** Comment why: before this the line came every 2 s and nothing was shown.
- [ ] **Step 4:** the run and typecheck pass.
- [ ] **Step 5: Commit** `A dial that cannot be opened for want of access says so on its row, once`.

### Task 14: The fleet keeps a row for a port that never opened (§ 1.2)

**Files:** `cli/src/cable/cableFleet.ts:393-397` (`devices()`), spec.

- [ ] **Step 1: Failing tests** (`cableFleet.spec.ts`, a session whose `host.onDialStatus` the test calls):
  - `a port that never opened has a row carrying only its problem`: `{ attached: false, problem: 'P' }` → rows are `[{ id: <serial>, attached: false, problem: 'P' }]`.
  - `the row goes with the problem, with the port, and when USB passes to another account`: `{ attached: false }` → `[]`; the port leaving discovery → `[]`; `canUseUsb` false → `[]`.
- [ ] **Step 2:** `npx vitest run src/cable/cableFleet.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement:** `devices()` keeps a status that is attached, has settings, or has a problem.
- [ ] **Step 4:** passes; typecheck.
- [ ] **Step 5: Commit** `The fleet lists a dial it could not open, with why`.

### Task 15: Desktop draws the problem-only row

**Files:** `desktop/test/devices_controller_test.dart`.

- [ ] **Step 1:** Add `test('a dial this account cannot open is listed with how to fix it')`: a device Desktop has never seen, `DialStatus.fromJson({'id': 'E2E-DIAL', 'attached': false, 'problem': 'No access to the dial. Run: sudo usermod -aG dialout \$USER, then log out and in.'})` → `controller.devices` has one device whose `connectionLabel` is that sentence; then the same id attached with a mac → still one device, `Connected`.
- [ ] **Step 2:** `cd desktop && flutter pub get && flutter test --no-pub test/devices_controller_test.dart` — passes. If it fails, stop and report: the spec says Desktop needs no change.
- [ ] **Step 3: Commit** `test(desktop): a dial that cannot be opened is listed with what to do`.

### Task 16: Fast user switching on Linux (§ 1.3)

**Files:** `cli/src/cable/usbConsoleUser.ts`, spec. `cableFleet.ts` is not touched: the check stays synchronous (Decided here, "The seat is asked of `loginctl`").

**Interfaces (produces):**
- `export interface SeatDeps { run(file: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string }> /* may reject */; now(): number; uid: number | undefined }`
- `export function linuxSeatOwner(deps: SeatDeps): () => boolean`: the returned function answers the last reading, true before the first. When no reading is under way and none started in the last `SEAT_EVERY_MS` (8_000), it starts one and answers without waiting for it. A reading runs `loginctl ['show-seat','seat0','--property=ActiveSession','--value']`; an exit of 0 with a trimmed id in the form `^[A-Za-z0-9_-]{1,64}$` then runs `loginctl ['show-session',<id>,'--property=User','--value']`; an exit of 0 with a trimmed `^\d+$` answers `uid === Number(it)`. Anything else (a rejection, a non-zero exit, an empty or out-of-form id, a user that is not digits, `uid` undefined) answers true. Each run gets `10_000` ms (`RUN_TIMEOUT_MS`'s value as a local `SEAT_TIMEOUT_MS`: importing `hosts/orca.ts` would pull Orca's modules into the fleet).
- The real `run` is `execFile` (no shell) with that `timeout`; a spawn error (no `loginctl`) rejects.
- `isUsbConsoleUser` gains `linuxSeat?: () => boolean`, by default one module-level `linuxSeatOwner` built on the real deps the first time Linux asks. On Linux it answers `linuxSeat()`; `consoleUid` is never called there. macOS and Windows unchanged.
- The file's header comment says why: logind's seat file says not to parse it, `loginctl` is its public reader, and the reading is kept because the fleet asks every 2 s.

- [ ] **Step 1: Failing tests** (`usbConsoleUser.spec.ts`; a fake `run` answering by argv, a fake clock; `vi.waitFor` for a reading to land): replace `does not require a desktop login on Linux` with:
  - `on Linux the user of seat0's active session owns the dial`: `run` answers `{ code: 0, stdout: '2\n' }` then `{ code: 0, stdout: '1000\n' }`; the first call answers true; once the reading landed, uid 1000 answers true and a second owner built for uid 1001 answers false. The calls are exactly `['loginctl', ['show-seat','seat0','--property=ActiveSession','--value'], 10_000]` then `['loginctl', ['show-session','2','--property=User','--value'], 10_000]`.
  - `a computer with no seat, no logind or no active session keeps the dial`, `it.each`: `run` rejects (`ENOENT`); `show-seat` exits 1; `ActiveSession` is `''`; the id is `2;x`, `../2` or 65 characters (no `show-session` call); `show-session` exits 1; `User` is `''` or `u` → true after the reading lands.
  - `reads again only 8 s after the last reading began, one at a time`: calls within 8 s run nothing more; a call while a reading is pending starts none; at 8 s one more reading, and a switch (`User` now `1001`) makes uid 1000 answer false once it lands.
  - `isUsbConsoleUser on Linux answers the seat's owner, never the macOS console`: `linuxSeat: () => false` → false; `consoleUid` not called.
- [ ] **Step 2:** `npx vitest run src/cable/usbConsoleUser.spec.ts` — FAIL (`linuxSeatOwner` is not exported; Linux answers true). Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** passes, with `src/cable/cableFleet.spec.ts` and `src/cable/serialWindows.spec.ts` unchanged and green; typecheck.
- [ ] **Step 5: Commit** `Linux: a daemon left by a switched-away account lets the dial go`.

### Task 17: Orca's CLI on Linux (§ 1.4)

**Files:** `cli/src/devices/orcaHomes.ts:38` (`LAUNCHER`) and `:66-69` (`orcaBinary`), spec. Two lines change; the Windows side edits this file too.

**Interfaces:** `LAUNCHER` also takes `…/resources/bin/orca-ide`. `orcaBinary`: on Linux `deps.onPath('orca-ide', orcaLauncher) ?? deps.onPath('orca', orcaLauncher)`; elsewhere as today.

- [ ] **Step 1: Failing tests** (`orcaHomes.spec.ts`, real links in a temp folder as its launcher tests make them): on Linux `orca-ide` whose real path is `…/resources/bin/orca-ide` is found, before an `orca` launcher; `/usr/bin/orca` (the screen reader) with no `orca-ide` gives none; an `orca-ide` whose real path is elsewhere is passed over; on macOS `orca-ide` is never looked for.
- [ ] **Step 2:** `npx vitest run src/devices/orcaHomes.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** passes; typecheck.
- [ ] **Step 5: Commit** `Linux: Orca's CLI is orca-ide`.

### Task 18: WezTerm types (§ 1.5)

**Files:** `H/wezterm.ts`, spec.

**Interfaces:**
- Pane ids: `<n>` when `place.host === 'wezterm'` and `place.hints.ORCA_TERMINAL_HANDLE` is not set; else `held:<n>`. `focus` takes both; `type` and `canType` only the first.
- `canType(pane)`: the id is `<n>` and a `wezterm` binary is found (PATH, else the macOS app's, as `focus`).
- `type(pane, text)`: false for an empty text, one over `MAX_TEXT`, or a pane a send is under way in; control characters become spaces (`CONTROL`, `orca.ts`); then `wezterm cli send-text --pane-id <n> --no-paste -- <text>` and, only if it exited 0, `wezterm cli send-text --pane-id <n> --no-paste -- \r` (one carriage return); true when both exited 0.

- [ ] **Step 1: Failing tests** (`wezterm.spec.ts`): the existing "has no show and no type" case now expects `type`; new:
  - `types the words, then Enter on its own`: calls are exactly `['cli','send-text','--pane-id','7','--no-paste','--','hello there']` then `['cli','send-text','--pane-id','7','--no-paste','--','\r']`, each with `10_000`.
  - `types only into the agent's own pane`: places with host `tmux`, `zellij`, `herdr`, `rex`, `kitty`, and host `wezterm` with `ORCA_TERMINAL_HANDLE`, give `held:7`: `canType` false, `type` false with no call, `focus` still activates pane 7.
  - `one send at a time for a pane`; `a first command that fails sends no Enter`; `words starting with a dash, and with control characters`; `no wezterm found: canType is false`.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/wezterm.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** passes, with `src/cable/hosts/open.spec.ts`, `observed.spec.ts` and `src/services/devices.spec.ts` unchanged and green (WezTerm inside an Orca terminal still sends through Orca); typecheck.
- [ ] **Step 5: Commit** `WezTerm takes the dial's words in the agent's own pane`.

### Task 19: Links open on Linux (§ 1.6)

**Files:** `H/appLink.ts`, spec; one line in each of `H/vscode.spec.ts`, `H/claudeApp.spec.ts`, `H/codexApp.spec.ts` and `H/cmuxApp.spec.ts` (`onPath: () => null` in the recorder, wherever its deps' type comes from `AppLinkDeps` and has none) plus the new Codex cases; `E/harness/daemon.ts` (a fake `xdg-mime` in the daemon's bin that prints nothing, so a daemon under test never asks this computer's scheme handlers).

**Interfaces:**
- `AppLinkDeps = Pick<OrcaDeps, 'run' | 'platform' | 'onPath'> & { inFront(): boolean; bin?: string }`.
- On Linux, per link: the scheme is the URL's (`/^([a-z][a-z0-9+.-]{0,31}):/`); its app is `xdg-mime query default x-scheme-handler/<scheme>` printing a name in the form `^[A-Za-z0-9._-]{1,128}\.desktop$`, read at the first look and kept, and read again after an open that failed. The opener is `bin` when absolute (`HARNESS_OPEN_BIN`), else `xdg-open` on `PATH`; it gets the URL alone (no `-b`).
- `canFocus`: macOS as today; Linux true once the scheme's app is known (the first ask starts the read and answers false). `canShow`: that and `inFront()`. `focus`/`show`: no handler, no `xdg-mime`, no opener or a non-zero exit is `false`/`'failed'`. On Linux `link.forward` is never called (it is `open -b`): the opener's fallback decides (T38).

- [ ] **Step 1: Failing tests** (`appLink.spec.ts`): replace the Linux half of `canFocus is macOS only` and add:
  - `on Linux a link opens through xdg-open once its scheme has an app`: calls are `/fake/bin/xdg-mime ['query','default','x-scheme-handler/fake']` then `/fake/bin/xdg-open ['fake://open/s1']`.
  - `reads the scheme's app once, and again after an open that failed`.
  - `no app, no xdg-mime, no xdg-open or a failed open answers false, and runs no forward`.
  - `HARNESS_OPEN_BIN takes xdg-open's place`; `Windows runs nothing`.
  - `codexApp.spec.ts`: on Linux a failed link logs no fallback and runs no `open`.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/appLink.spec.ts src/cable/hosts/codexApp.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement**; update the file's header comment (the link is macOS's and Linux's).
- [ ] **Step 4:** `npx vitest run src/cable/hosts` and typecheck pass.
- [ ] **Step 5: Commit** `Linux: an app's session opens by its link where the app registered it`.

### Task 20: The Claude and ChatGPT apps' exe names (§ 1.6)

**Files:** `H/frontApp.ts:11-21` (`EXE_APPS`), spec.

- [ ] **Step 1: Failing tests:** for each of `RECORDED_LINUX_APPS.claude` and `.chatgpt` that is not `null` and whose `comm` names that app alone (not `electron` or another shared name): `frontAppId(<comm>)` is `'claude'` / `'codex'`. The existing "every id the table can give is an app id or none" still holds.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/frontApp.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement** one row per app, lower-cased, with the fixture named in its comment. An app with no usable name gets no row: say so in the report (T51 writes it into the spec's table).
- [ ] **Step 4:** passes; typecheck.
- [ ] **Step 5: Commit** `Linux: the Claude and ChatGPT apps are known by their process names`.

### Task 21: The extension's tab on Linux (§ 1.6)

**Files:** `H/vscode.ts:76-91` (`paneOf`), `H/vscode.spec.ts`.

**Interfaces:** the tab's pane: `place.engine === 'claude'`, `CLAUDE_CODE_ENTRYPOINT === 'claude-vscode'`, a session in form, and the editor named by its bundle id, or, on Linux with no bundle id, by `place.app === editor`.

- [ ] **Step 1: Failing tests:** on Linux a Claude Code session with the entrypoint, no bundle id and `app: 'vscode'` has the tab's pane; `app: 'cursor'` has Cursor's adapter's and not VS Code's; a bundle id of another app, another engine, or `app: 'terminal'` has none; its tap runs `xdg-open vscode://anthropic.claude-code/open?session=<id>` (`cursor://…` for Cursor) once the scheme has an app; macOS cases unchanged.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/vscode.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement**; update the header comment.
- [ ] **Step 4:** passes; typecheck.
- [ ] **Step 5: Commit** `Linux: a tap opens Claude Code's tab in VS Code and Cursor`.

### Task 22: The Claude app's session on Linux (§ 1.6)

**Files:** `H/claudeApp.ts:22-31`, `H/claudeApp.spec.ts`.

**Interfaces:** the hooked pane: `CLAUDE_CODE_HOST_SESSION_ID` in form and the Claude app named by its bundle id, or, on Linux with no bundle id, by `place.app === 'claude'`. The scanned pane is unchanged.

- [ ] **Step 1: Failing tests:** Linux, no bundle id, `app: 'claude'`, a session in form → the pane; `app: 'vscode'` → none; a tap runs `xdg-open claude://code/continue?session=<id>` once the scheme has an app.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/claudeApp.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** passes; typecheck.
- [ ] **Step 5: Commit** `Linux: a tap opens the Claude app on its session`.

### Task 23: Cursor's folder window on Linux (§ 1.6)

**Files:** `H/cursorFolder.ts:63-80`, spec; `cli/src/devices/vscodeExtension.ts` (one exported function beside `installed`), spec; `cli/src/services/devices.ts:493` (the adapter's line) and `:561` (the Cursor extension deps, built once above the list and used in both places); `devices.spec.ts`.

**Interfaces:**
- `vscodeExtension.ts`: `export function cursorFolderCli(deps: VscodeExtensionDeps): string | null` — `deps.bin` when absolute and executable (the tests' Cursor); else on Linux, when `RECORDED_LINUX_APPS.cursor.cliBesideExec` showed that layout, the executable `bin/cursor` beside the binary that `<dir>/applications/<desktopFile>`'s `Exec=` names, `<dir>` in turn `<home>/.local/share`, `/usr/local/share`, `/usr/share` (the file read up to 64 KiB; its first `Exec=` token absolute, at most 4096 characters, no control character); else `installed(deps)` (the `cursor` on `PATH` that is not cursor-agent's shim). `null` off Linux.
- `CursorFolderDeps` gains `cli(): string | null`. `canFocus`: macOS as today; on Linux the folder checks and `cli() !== null`. `focus` on Linux: `run(<cli>, [<folder>], RUN_TIMEOUT_MS)`, true on exit 0.

- [ ] **Step 1: Failing tests:** `vscodeExtension.spec.ts` (the three sources, in that order; the shim skipped; a relative or over-long `Exec=`; macOS → null); `cursorFolder.spec.ts` (Linux: `[<cli>, ['/work/api']]` runs; no CLI → `canFocus` false and nothing runs; the out-of-form folders run nothing; macOS unchanged); `devices.spec.ts` (on Linux a tap on Cursor's own agent runs the CLI the deps name with its folder).
- [ ] **Step 2:** `npx vitest run src/devices/vscodeExtension.spec.ts src/cable/hosts/cursorFolder.spec.ts src/services/devices.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.** If T1 recorded no `bin/cursor` beside the `Exec=` binary, leave that source out and say so in the report.
- [ ] **Step 4:** passes; typecheck.
- [ ] **Step 5: Commit** `Linux: a tap opens Cursor's window on the agent's folder`.

### Task 24: `cli-e2e.yml` runs the dial's hosts (§ 1.7)

**Files:** as in the table.

**Produces:**
- `E/harness/dialHosts.ts`: `export const DIAL_HOST_FILES = ['e2e/dialHost*.e2e.ts', 'e2e/deviceHerdr.e2e.ts']` and `export function dialHost(name: string, found: string | null): string | null` — returns `found`; when it is `null` and `process.env.E2E_DIAL_HOSTS === '1'` it throws `<name> is not installed on a dial-hosts run` as the file loads.
- `cli/vitest.e2e.dialHosts.config.ts`: the e2e config with `include: DIAL_HOST_FILES`. `cli/vitest.e2e.ci.config.ts` excludes the same list.
- `herdrServer.ts`: `herdrBinary` goes through `dialHost('herdr', …)`.
- `cli-e2e.yml`: input `dial_hosts` (boolean, "Only the dial's hosts: herdr, WezTerm, Zellij, an X11 desktop and sway"); jobs `e2e`, `e2e-macos-disk` and `e2e-summary` also need `!inputs.dial_hosts`; a new job `dial-hosts`, name `e2e (dial hosts)`, `if: ${{ !inputs.agent_browser_podman }}`, `ubuntu-24.04`, 30 minutes, `permissions: contents: read` as the file's, `E2E_DIAL_HOSTS: '1'`, shaped as `agent-browser-podman`: checkout, Node, `scripts/apt-install.sh tmux zsh lsof xvfb openbox wmctrl xterm x11-utils sway foot fonts-dejavu-core` and the zsh `compaudit` fix the shards have; herdr (0.9.5, or 0.8.0 if `deviceHerdr` needs it: the builder's call, said in the PR), Zellij (`RECORDED_ZELLIJ.version`) and WezTerm (its newest stable `.deb` that installs on the image) each from its GitHub release, version pinned and `sha256sum -c` checked, into `~/.local/bin`; `npm ci`; `npx vitest run --config vitest.e2e.dialHosts.config.ts` with the JSON reporter; then "every case passed and none was skipped" (`numTotalTests > 0 && numPassedTests === numTotalTests`); the result and the failing cases' daemon logs uploaded.
- `docs/validation-and-release.md`, after the `agent_browser_podman` paragraph: what `dial_hosts` runs, and that the nightly run includes the job.

- [ ] **Step 1:** Write the above. `actionlint .github/workflows/cli-e2e.yml` passes.
- [ ] **Step 2:** `npx vitest list --config vitest.e2e.ci.config.ts --filesOnly` no longer lists `deviceHerdr.e2e.ts`; `npx vitest list --config vitest.e2e.dialHosts.config.ts --filesOnly` lists it; where herdr is not found, `E2E_DIAL_HOSTS=1 npx vitest run --config vitest.e2e.dialHosts.config.ts` fails naming herdr, and without the variable the file skips as before.
- [ ] **Step 3: Commit** `CLI end to end: a job with the dial's hosts installed, herdr first`.

### Task 25: E2E: WezTerm takes the words

**Files:** `E/dialHostWezterm.e2e.ts`, `E/harness/weztermMux.ts` (modelled on `herdrServer.ts`).

- [ ] **Step 1:** `weztermMux.ts`: `dialHost('wezterm', …)`; a `wezterm-mux-server` of the test's own (its socket and config under the daemon's throwaway home, never the developer's), the daemon's `wezterm` a wrapper pinned to that socket; `spawn(folder)` starts the suite's fake engine in a new pane and answers its pane id; `text(pane)` is `wezterm cli get-text --pane-id`.
- [ ] **Step 2:** The file, `describe.skipIf(!weztermBinary)`: a hooked fake Claude Code in a mux pane is on the fake dial with `v` in its capabilities; the dial's words reach it as its next prompt (`get-text` shows them; the engine's log has the turn); a tap runs `activate-pane` for its pane.
- [ ] **Step 3:** `npx vitest run --config vitest.e2e.config.ts e2e/dialHostWezterm.e2e.ts` — passes on this Mac if WezTerm is installed, else skips; nothing is installed on the Mac for it.
- [ ] **Step 4: Commit** `test(e2e): the dial's words reach an agent in a WezTerm pane`.

### Task 26: E2E: the port's problem and its copy

**Files:** `E/dialHostPortAccess.e2e.ts`.

- [ ] **Step 1:** Gate: Linux, `sudo -n true` works, and the account is not in `dialout` (`dialHost('sudo and a group this account is not in', …)`). A file under the test's root, `sudo chown root:dialout`, mode `0660`, listed in the daemon's `HARNESSD_TEST_DIAL_PORT` JSON.
- [ ] **Step 2:** Cases: the window's `dial_status` carries a device row `{ id, attached: false, problem: 'No access to the dial. Run: sudo usermod -aG dialout $USER, then log out and in.' }`; after `sudo usermod -aG dialout <account>` the row's problem becomes `No access to the dial yet. Log out and in.` (the daemon's own login still lacks the group); at the end the daemon's log holds each sentence's `cannot open the dial:` line once, never once a scan. `afterEach` runs `sudo gpasswd -d <account> dialout` and removes the file.
- [ ] **Step 3:** Runs only on the dial-hosts job (T24) or a Linux box with passwordless sudo; on this Mac it skips.
- [ ] **Step 4: Commit** `test(e2e): a dial the account cannot open says how to fix it`.

---

## Part 2: a tap raises the window

### Task 27: The session's sockets reach the daemon (§ 2.3)

**Files:** `cli/src/lib/startEnvironment.ts:33-34`, spec.

- [ ] **Step 1: Failing test:** `startEnvironment({ SWAYSOCK: '/run/user/1000/sway-ipc.1000.1.sock', HYPRLAND_INSTANCE_SIGNATURE: 'abc_1', XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux')` keeps all three.
- [ ] **Step 2:** `npx vitest run src/lib/startEnvironment.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement:** `SWAYSOCK` and `HYPRLAND_INSTANCE_SIGNATURE` join the "Linux desktop" names (`XDG_RUNTIME_DIR` is already kept by the `XDG_` prefix), with why in the comment.
- [ ] **Step 4:** passes, with `src/architecture.startEnvironment.spec.ts`.
- [ ] **Step 5: Commit** `A start keeps sway's and Hyprland's socket names`.

### Task 28: Which desktop this login exposes (§ 2.3)

**Files:** `H/linuxDesktop.ts` + spec (new).

**Interfaces (produces):**
```ts
export type LinuxDesktop =
  | { kind: 'sway'; socket: string }
  | { kind: 'hyprland'; signature: string }
  | { kind: 'kwin'; bus: string; runtimeDir: string }
  | { kind: 'gnome'; bus: string }
  | { kind: 'x11'; display: string; xauthority?: string }
  | { kind: 'none'; why: 'no desktop session' | 'gnome without the extension' | 'unknown compositor' | 'no swaymsg' | 'no hyprctl' | 'no wmctrl' }
export interface LinuxDesktopDeps {
  env: Readonly<Partial<Record<'SWAYSOCK' | 'HYPRLAND_INSTANCE_SIGNATURE' | 'XDG_RUNTIME_DIR' | 'WAYLAND_DISPLAY' | 'DBUS_SESSION_BUS_ADDRESS' | 'DISPLAY' | 'XAUTHORITY', string>>>
  uid: number
  home: string
  /** A folder's entry names; none when it cannot be read. */
  list(dir: string): string[]
  /** What the path is and whose: null when it is not there. */
  kind(path: string): { type: 'socket' | 'file' | 'folder'; uid: number } | null
  run: OrcaDeps['run']
  onPath: OrcaDeps['onPath']
}
export function findLinuxDesktop(deps: LinuxDesktopDeps): Promise<LinuxDesktop>
/** The line the daemon's log says for it (Global Constraints). */
export function desktopLine(desktop: LinuxDesktop): string
/** This process's own: its environment, uid and home, the real file system, `apps`' runner and PATH. */
export function linuxDesktopDeps(apps: Pick<OrcaDeps, 'run' | 'onPath'>): LinuxDesktopDeps
```
Found in this order, the first that holds; never throws:
1. **sway:** `SWAYSOCK` (absolute), else each `sway-ipc.<uid>.<digits>.sock` in the runtime dir, at most four; a socket of this uid for which `swaymsg -s <socket> -t get_version` exits 0. A socket found with no `swaymsg` on `PATH` is `none · no swaymsg`.
2. **Hyprland:** `HYPRLAND_INSTANCE_SIGNATURE` in the form `^[A-Za-z0-9_]{1,128}$` whose `<runtime>/hypr/<signature>/.socket.sock` is this uid's socket, else the first such folder; no `hyprctl` is `none · no hyprctl`.
3. **KDE:** the bus is `DBUS_SESSION_BUS_ADDRESS` (in the form `^unix:(path|abstract)=[^,;\s]{1,200}`), else `unix:path=<runtime>/bus` when that is this uid's socket; `dbus-send` on `PATH`, a runtime dir, and T5's `nameHasOwner` call answering `boolean true`.
4. **GNOME:** the same bus; `org.gnome.Shell` owned and T6's `introspect` exiting 0 with the extension's interface in its output. Shell owned, no extension, and a Wayland socket in this login (`WAYLAND_DISPLAY`, or a `wayland-<digits>` socket of this uid in the runtime dir): `none · gnome without the extension`.
5. **X11**, only when this login has no Wayland socket: `DISPLAY` in the form `^:[0-9]{1,3}(\.[0-9]{1,2})?$`, else the lowest `X<n>` socket in `/tmp/.X11-unix` owned by this uid or root; `xauthority` is `XAUTHORITY` (absolute and a file), else `<home>/.Xauthority`, else the first `.mutter-Xwaylandauth.*` or `xauth_*` file of this uid in the runtime dir, else none; no `wmctrl` is `none · no wmctrl`.
6. A Wayland socket and nothing above: `none · unknown compositor`. Nothing at all: `none · no desktop session`.

- [ ] **Step 1: Failing tests** (fake deps; the bus answers are `RECORDED_KWIN.nameHasOwner.stdout` and `RECORDED_GNOME_SHELL.introspect`/`introspectWithout`): one case per row above, each from the variable and from the socket alone; the order (sway's socket beside a `DISPLAY` is sway); Review Focus 6 (a socket of another uid; two sway sockets of which the second answers; an X socket of a third uid); a relative `XDG_RUNTIME_DIR` is ignored; `DISPLAY=localhost:10.0` is no display; every `run` gets `10_000`; `desktopLine` for each kind.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/linuxDesktop.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** passes, with `src/architecture.startEnvironment.spec.ts`; typecheck.
- [ ] **Step 5: Commit** `Linux: which desktop this login exposes, from its own variables and sockets`.

### Task 29: Each app's window class (§ 2.2)

**Files:** `H/frontApp.ts`, spec.

**Interfaces:** `export function windowClasses(app: string): readonly string[]` — the spellings an app's window is known by (X11's `WM_CLASS` class and Wayland's app id), from one fixed table; none for an app with no row. Rows: `vscode` and `cursor` (`RECORDED_LINUX_APPS.*.startupWmClass` and its lower case), `claude` and `codex` (the same, where recorded), `wezterm` (`org.wezfurlong.wezterm`), `kitty` (`kitty`), `ghostty` (`com.mitchellh.ghostty`), `harness` (`com.autonomous.harness`, `harness`; `desktop/linux/CMakeLists.txt`). Each row's comment names where its value was read; a class nobody could confirm gets no row.

- [ ] **Step 1: Failing tests:** each row above; an unknown app and an inherited key (`constructor`) give `[]`; every spelling matches `^[A-Za-z0-9._-]{1,64}$`; every key is an app id.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/frontApp.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** passes; typecheck.
- [ ] **Step 5: Commit** `Each app's window class, for the raise`.

### Task 30: The raise (§ 2.1, § 2.2)

**Files:** `H/linuxRaise.ts` + spec (new).

**Interfaces (produces):**
```ts
/** The agent's process and its parents, nearest first, and its app's class spellings. */
export interface RaiseTarget { pids: readonly number[]; classes: readonly string[] }
export interface RaiseBackend { raise(target: RaiseTarget): Promise<boolean> }
export type RaiseRun = Pick<OrcaDeps, 'run' | 'onPath'>
export interface LinuxRaise {
  /** Whether the last look found a desktop: false until the first look lands. */
  ready(): boolean
  /** Brings forward the window of that process or one of its parents, else its app's by class. Never throws. */
  raise(window: { pid?: number; app?: string }): Promise<boolean>
}
export interface LinuxRaiseDeps {
  find(): Promise<LinuxDesktop>
  backend(desktop: Exclude<LinuxDesktop, { kind: 'none' }>): RaiseBackend
  processes(): Promise<readonly Pick<ProcessName, 'pid' | 'ppid'>[]>
  classes(app: string): readonly string[]
  log(line: string): void
}
export function createLinuxRaise(deps: LinuxRaiseDeps): LinuxRaise
```
The first look starts in `createLinuxRaise`; `desktopLine` is logged when it differs from the last line said. `raise` waits for a look under way; the pids are `parentChain(pid, table)` (`scannedApp.ts`), none for a pid that is not a whole number above 1 or is not in the table; nothing to look for, no desktop, or a backend that answers false or throws is `false`; after a `false` from a backend the desktop is looked for again, in the background.

- [ ] **Step 1: Failing tests:** the line is logged once, and again only when a later look differs; `ready()` before and after the first look; the chain is nearest first and bounded as `parentChain` bounds it; a process table that rejects still raises by class; no pid and no class runs no backend; a failed raise looks again and the next raise uses the new desktop; a backend that throws is `false`; two raises at once both run.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/linuxRaise.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** passes; typecheck.
- [ ] **Step 5: Commit** `Linux: one way to bring an agent's window forward`.

### Tasks 31-35: one backend per desktop

Each is `create<Name>Raise(deps, …): RaiseBackend` in its own file, tested against its recording through a fake `run` that answers the recorded output for the recorded argv. Common cases in every spec: the first of `pids` that owns a window wins over a nearer pid that owns none; no pid matches and a class does (compared without case); neither matches → `false` and no second command; the listing fails, is not what it should be, or is over the runner's buffer → `false`; a pid, class, id or address out of form never reaches a command; each call gets `10_000`; nothing throws.

Each of the five:
- [ ] **Step 1:** write the spec above (the common cases and the task's own).
- [ ] **Step 2:** run it (the task's `Run:`) — FAIL, the file is not there. Commit red.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** the run and `npm run typecheck` pass.
- [ ] **Step 5:** commit with the task's message.

### Task 31: sway

`createSwayRaise(deps: RaiseRun, socket: string)`. `swaymsg -s <socket> -t get_tree`; windows are the nodes with a numeric `pid` (walk `nodes` and `floating_nodes`, at most 4096 nodes and 32 deep); by pid: `swaymsg -s <socket> '[pid=<p>] focus'` (one argument); by class (`app_id`, else `window_properties.class`): `[con_id=<id>] focus`. True on exit 0. Fixture: `RECORDED_SWAY`. Run: `npx vitest run src/cable/hosts/linuxRaiseSway.spec.ts`. Commit: `Linux: a tap raises the window on sway`.

### Task 32: Hyprland

`createHyprlandRaise(deps: RaiseRun, signature: string)`. `hyprctl -i <signature> clients -j`; by pid: `hyprctl -i <signature> dispatch focuswindow pid:<p>`; by class (`class`, else `initialClass`): `dispatch focuswindow address:<address>`, the address in the form `^0x[0-9a-f]{1,16}$`. True when it exits 0 and prints what `RECORDED_HYPRLAND.focusByPid.stdout` shows for success. Run: `npx vitest run src/cable/hosts/linuxRaiseHyprland.spec.ts`. Commit: `Linux: a tap raises the window on Hyprland`.

### Task 33: KDE

`createKwinRaise(deps: RaiseRun & { dir: string; write(path: string, text: string): void; remove(path: string): void; name(): string }, bus: string)`; `dir` is `<runtime>/harness`, made 0700; `write` makes the file 0600; `name()` is unique per raise (this process's pid and a counter). The script's text is fixed in the file but for two values, written as JSON: the pids (whole numbers) and the classes (each in the form `^[A-Za-z0-9._-]{1,64}$`); it activates the first window whose pid is one of the pids in their order, else whose class is one of the classes without case, through the property names `RECORDED_KWIN.scriptApi` gives, for Plasma 5 and 6 alike. Then T5's three calls over `dbus-send --bus=<bus>`: load, run, unload; the file is removed in a `finally`, and so is the script when a call after the load fails. True when load and run exited 0.

Extra cases: the file is gone after a success, after each failing call and after a throw; a class with a quote, a backslash or a newline is dropped before the script is written (the test reads the written text); two raises at once use two files. Run: `npx vitest run src/cable/hosts/linuxRaiseKwin.spec.ts`. Commit: `Linux: a tap raises the window on KDE`.

### Task 34: GNOME

`createGnomeRaise(deps: RaiseRun, bus: string)`. By class only: for each spelling in turn, `RECORDED_GNOME_SHELL.activateHit`'s call (`gdbus call --address <bus> --dest org.gnome.Shell --object-path /de/lucaswerkmeister/ActivateWindowByTitle --method de.lucaswerkmeister.ActivateWindowByTitle.activateByWmClass <class>`), true at the first that prints the recorded hit, false after the last. Pids are not used; no classes → `false` with no call. Run: `npx vitest run src/cable/hosts/linuxRaiseGnome.spec.ts`. Commit: `Linux: a tap raises the app on GNOME with the extension`.

### Task 35: X11

`createX11Raise(deps: RaiseRun, display: string, xauthority?: string)`. Every command is `env DISPLAY=<display> [XAUTHORITY=<file>] wmctrl …` (`env` from `PATH`; each a separate argument). `wmctrl -lpx`: a row is `<id> <desktop> <pid> <instance>.<class> <host> <title>`; a class spelling matches the fourth field when it is the whole field's class or instance, without case (`RECORDED_WMCTRL.lpx` fixes the split). Then `wmctrl -i -a <id>`, the id in the form `^0x[0-9a-f]{1,8}$`. True on exit 0. A pid of 0 (a window that names none) matches nothing. Run: `npx vitest run src/cable/hosts/linuxRaiseX11.spec.ts`. Commit: `Linux: a tap raises the window on X11`.

### Task 36: tmux says which client it switched (§ 2.2)

**Files:** `H/adapter.ts` (one optional member), `H/tmux.ts:26-31` (`TMUX_CLIENTS` and its line's form), `:52-65` (`personsClient`), `:99`; `H/tmux.spec.ts`; `cli/src/services/devices.spec.ts:3035-3059` (the fake `list-clients` lines only).

**Interfaces:**
- `HostAdapter.windowPid?(pane: Pane): number | undefined` — "The process whose window holds the pane, as its last `focus` found it; asked once after a `focus` that answered true, and forgotten then. Absent, or none: the agent's own process."
- tmux: `TMUX_CLIENTS` becomes `#{client_activity}|#{client_pid}|#{client_name}|#{@harness_daemon}|#{session_name}`; a client whose pid is not a whole number above 1 is still switched, with no pid kept. After a switch that exited 0 the client's pid is kept for that pane id until `windowPid` reads it; at most 16 are kept, the oldest dropped.

- [ ] **Step 1: Failing tests:** the `list-clients` call carries the new format; after a tap `windowPid(pane)` is the switched client's pid, and `undefined` at a second ask, before any tap, after a failed or refused switch, and for another pane; the chosen client is still the one used last among the person's own.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/tmux.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** passes, with `src/services/devices.spec.ts`, whose three fake `list-clients` lines and one expected call (`:3035-3059`) take the new format in this task's green commit and nothing else there changes; typecheck.
- [ ] **Step 5: Commit** `tmux's adapter says which client it switched`.

### Task 37: An agent's process and app, by id

**Files:** `H/observed.ts` (one method beside `paneOf(agentId, adapter)` at `:484`), `H/observed.spec.ts`.

**Interfaces:** `ObservedSource.windowOf(agentId: string): { pid: number; app: string } | undefined` — a live agent's latest caller (`entry.caller ?? entry.pid`) and its app; none for an ended or unknown one.

- [ ] **Step 1: Failing test:** a hooked agent gives its hook's caller and app; after an event from another process, that one; a scan-found session its own pid and the scan's app; an ended session and an unknown id `undefined`.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/observed.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.** Nothing else in the file changes.
- [ ] **Step 4:** passes; typecheck.
- [ ] **Step 5: Commit** `The observed source says an agent's process and app`.

### Task 38: The opener raises on Linux (§ 2.1)

**Files:** `H/open.ts:43-54` (`OpenDeps`), `:56-153` (`createOpenActions`); `H/open.spec.ts`.

**Interfaces:** `OpenDeps` gains `raise?: LinuxRaise` and `windowOf?(agentId: string): { pid?: number; app?: string } | undefined`. With `raise` (Linux):
- `can(target)`: a pane the opener brings forward, or `raise.ready()`.
- `open`: a `before` pane whose focus answered true is followed by `raise.raise({ pid: adapter.windowPid?.(pane) ?? window.pid, app: window.app })`, and the tap answers true whatever the raise answered. No pane, or a pane that failed or refused: `raise.raise(window)` is the answer, after the same `[device] open · <id> · fallback` line macOS writes for a pane that failed. An `instead` pane that answered true raises nothing.
- `bring(app)`: there on Linux too, with macOS's one-at-a-time and last-pick-wins rules unchanged; it runs `raise.raise({ app })` for any app but `herdr`, which runs nothing (the raise itself answers false for an app with no class).
- `desktop` stays macOS's. macOS paths and their tests are unchanged.

- [ ] **Step 1: Failing tests** (`open.spec.ts`, `platform: 'linux'`, a recording `raise`):
  - `Linux: a pane that comes before its app is followed by the raise, with the agent's process and app` (WezTerm: `activate-pane`, then `raise({ pid: 4242, app: 'wezterm' })`).
  - `Linux: tmux's switched client is the process whose window is raised` (an adapter with `windowPid`).
  - `Linux: an agent with no pane is raised by its process, and the tap answers what the raise did`.
  - `Linux: a pane that failed logs the fallback and raises; one that refused raises with no line`.
  - `Linux: a link's pane raises nothing after it`.
  - `Linux: can() is the pane or a desktop found`; `with no raise given, Linux is as before` (the existing Linux cases, untouched).
  - `Linux: a pick brings the app through the raise, one at a time, the last pick winning`; `a pick of herdr runs nothing`.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/open.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npx vitest run src/cable/hosts` passes; typecheck.
- [ ] **Step 5: Commit** `Linux: a tap and a pick bring the window forward through the raise`.

### Task 39: A terminal's tap raises its editor (§ 1.6, § 2)

**Files:** `H/vscode.ts:95-104` (`focus`), `H/vscode.spec.ts`.

**Interfaces:** the adapter's deps gain `raise?: LinuxRaise['raise']`. A terminal pane's tap, once its `show` line is queued: macOS runs `open -b` as today; with `raise`, `await raise({ pid: <the pane's pid>, app: editor })`; the tap answers true either way.

- [ ] **Step 1: Failing tests:** on Linux a terminal's tap queues the show with `raise: true` and then calls `raise({ pid: 4242, app: 'vscode' })` (`'cursor'` for Cursor); a raise that answers false leaves the tap true; no `raise` given runs nothing more; macOS unchanged.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/vscode.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** passes; typecheck.
- [ ] **Step 5: Commit** `Linux: a tap on an agent in an editor's terminal brings the editor forward`.

### Task 40: The devices use the raise

**Files:** `cli/src/services/devices.ts` (`DevicesDeps`, one `const` above the adapter list at `:477`, the two `createVscodeAdapter` lines at `:490-491`, the `createOpenActions` call at `:503`), `devices.spec.ts`; `H/linuxRaise.ts` + spec (one exported function).

**Interfaces:**
- `linuxRaise.ts`: `export function systemLinuxRaise(apps: OrcaDeps, log: (line: string) => void): LinuxRaise` — `createLinuxRaise` over `findLinuxDesktop(linuxDesktopDeps(apps))`, the five backends by `desktop.kind` (KDE's `dir`, `write`, `remove` and `name` on the real file system), `readProcessNames` and `windowClasses`.
- `devices.ts`: `DevicesDeps.raise?: LinuxRaise` ("For this service's tests"); `const raise = deps.raise ?? (apps.platform === 'linux' ? systemLinuxRaise(apps, log) : undefined)`; both editors' adapters get `raise: raise && ((window) => raise.raise(window))`; the opener gets `raise` and `windowOf: (agentId) => observed?.windowOf(agentId)`.

- [ ] **Step 1: Failing tests:** `linuxRaise.spec.ts`: `systemLinuxRaise` picks each backend for its desktop kind (a fake `apps.run` answering a recorded listing per kind). `devices.spec.ts` (its Linux default gets a `raise` that finds nothing, so every existing case stands): a tap on a hooked agent in a WezTerm pane on Linux calls `raise.raise` with that agent's caller pid and `wezterm`; an agent with no pane has `f` in its capabilities once `raise.ready()` and its tap answers the raise; a pick brings the app through the raise; with no `raise` given on Linux the devices build the system's (one `[device] raise · ` line is logged; nothing runs but the fake `apps.run`); macOS builds none.
- [ ] **Step 2:** `npx vitest run src/services/devices.spec.ts src/cable/hosts/linuxRaise.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the run, `npm run typecheck` and `npm run test:core` (100% per file) pass.
- [ ] **Step 5: Commit** `Linux: the devices bring an agent's window forward`.

### Task 41: E2E: X11

**Files:** `E/dialHostX11Raise.e2e.ts`, `E/harness/x11Desk.ts`.

- [ ] **Step 1:** `x11Desk.ts`: `dialHost` for `Xvfb`, `openbox`, `wmctrl`, `xterm` and `xprop`; an `Xvfb` on a free display with its own auth file and `openbox`, both under the test's root and ended by the worker's reaper; `terminal(d, folder)` starts `xterm -e` on the suite's fake Claude Code (the daemon's `CLAUDE_PATH`, its environment the daemon's plus `DISPLAY`) and answers the engine's pid and the window's id; `active()` reads `xprop -root _NET_ACTIVE_WINDOW`.
- [ ] **Step 2:** The file: a daemon whose environment has that `DISPLAY` and `XAUTHORITY`; two xterms, the agent's started first so the other is active; the log holds `[device] raise · x11`; the fake dial's tap on the agent makes its xterm the active window (`until`), and the tap's outcome is the opener's; a second daemon with no `DISPLAY` in its environment and the X socket in `/tmp/.X11-unix` raises the same way.
- [ ] **Step 3:** Runs on the dial-hosts job; skips on this Mac.
- [ ] **Step 4: Commit** `test(e2e): a tap raises the agent's window on X11`.

### Task 42: E2E: sway

**Files:** `E/dialHostSwayRaise.e2e.ts`, `E/harness/swayDesk.ts`.

- [ ] **Step 1:** `swayDesk.ts`: `dialHost` for `sway`, `swaymsg` and `foot`; a headless sway (`WLR_BACKENDS=headless`, `WLR_RENDERER=pixman`, `WLR_LIBINPUT_NO_DEVICES=1`) with a private `XDG_RUNTIME_DIR` under the test's root; `terminal(d, folder)` starts `foot` on the fake engine; `focused()` reads the focused node's pid from `swaymsg -t get_tree`.
- [ ] **Step 2:** The file: a daemon given only `XDG_RUNTIME_DIR` (no `SWAYSOCK`): the log holds `[device] raise · sway`; two foot windows, the other focused; the tap focuses the agent's (`until` on `focused()`); a second case with `SWAYSOCK` set.
- [ ] **Step 3:** Runs on the dial-hosts job; skips on this Mac.
- [ ] **Step 4: Commit** `test(e2e): a tap focuses the agent's window on sway`.

---

## Part 3: Zellij and kitty

### Task 43: The hook's new hints (§ 3.1)

**Files:** `cli/hook/notify.mjs:554-587` (`HOST_HINTS`, the comment above it, `hostHints`), `cli/src/hookNotify.spec.ts:2499-2501` (`HINTS`) and new cases.

**Interfaces:** `HOST_HINTS` becomes, in order: `TERM_PROGRAM`, `__CFBundleIdentifier`, `HERDR_PANE_ID`, `REX_BLOCK`, `ZELLIJ`, `ZELLIJ_PANE_ID`, `ZELLIJ_SESSION_NAME`, `TMUX_PANE`, `HC_TERMINAL_ID`, `CMUX_SURFACE_ID`, `CMUX_WORKSPACE_ID`, `KITTY_WINDOW_ID`, `KITTY_LISTEN_ON`, `WEZTERM_PANE`, `ORCA_AGENT_SESSION_ID`, `ORCA_TERMINAL_HANDLE`, `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`. `MAX_HINTS` stays 10. `ZELLIJ_PANE_ID`, `ZELLIJ_SESSION_NAME` and `KITTY_LISTEN_ON` over 64 characters are left out before the cap counts them; every other name is cut at 64 as today. The comment says what each new name is (an id, a session's name, a socket's address: no credential) and why it is never cut.

- [ ] **Step 1: Failing tests:** the list's order (the existing `lists its hint names in this order` case, with the new `HINTS`); `a session in Zellij inside kitty sends Zellij's three and kitty's two`; `sends the first MAX_HINTS of the names set` still holds with eighteen names; `a socket or a session name over 64 characters is left out, not cut` (65 characters: absent; 64: whole), and takes none of the ten; `the largest body the hook can build is under 4096 bytes` still holds.
- [ ] **Step 2:** `npx vitest run src/hookNotify.spec.ts -t 'a session outside a pane'` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npx vitest run src/hookNotify.spec.ts src/core/observedHook.spec.ts` passes (the core is not edited).
- [ ] **Step 5: Commit** `The hook names Zellij's pane and session, and kitty's socket`.

### Task 44: Zellij (§ 3.2)

**Files:** `H/zellij.ts` + spec (new).

**Interfaces:** `export function createZellijAdapter(deps: Pick<OrcaDeps, 'run' | 'onPath' | 'platform'>): HostAdapter & Required<Pick<HostAdapter, 'type' | 'canType'>>`.
- `id: 'zellij'`, `tap: 'before'`, no bundle. No pane on Windows.
- `paneOf`: `ZELLIJ_PANE_ID` (`^[0-9]{1,9}$`) and `ZELLIJ_SESSION_NAME` (the form in "Decided here") → id `<session>:<pane>` when `place.host === 'zellij'` and no `TMUX_PANE` is set, else `held:<session>:<pane>`.
- `canFocus`: a `zellij` on `PATH`. `focus`: `zellij --session <s> action focus-pane-id <id>` (the spelling T7 recorded), true on exit 0.
- `canType`: the id is not `held:` and a `zellij` is on `PATH`. `type`: the text rules of T18; one send at a time per pane; first `zellij --session <s> action list-panes --json`, and only when it lists that id as a terminal pane (not a plugin; the field names are `RECORDED_ZELLIJ.listPanes`'s): `… action write-chars --pane-id <id> -- <text>`, then `… action send-keys --pane-id <id> Enter`; true when all three exited 0.

- [ ] **Step 1: Failing tests** (a fake `run` answering `RECORDED_ZELLIJ`): `paneOf` takes its two hints and refuses each out of form (a session starting with `-`, with `/`, with a space, over 64; a pane that is not digits); `types only into the agent's own pane` (host `herdr` or `rex`, and `TMUX_PANE` set, give `held:`; no words, the tap still runs); the exact argv of focus and of the three typing calls; `a pane that is gone, or a plugin's, is not typed into` (the recorded `listPanes` without that id; `missingPane`); `a session that is gone` (`missingSession`) is false; one send at a time; words starting with `--`; no `zellij` on `PATH`; Windows has no pane.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/zellij.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** passes; typecheck.
- [ ] **Step 5: Commit** `Zellij: a tap focuses the agent's pane, and the dial's words reach it`.

### Task 45: kitty (§ 3.3)

**Files:** `H/kitty.ts` + spec (new).

**Interfaces:** `export function createKittyAdapter(deps: Pick<OrcaDeps, 'run' | 'onPath' | 'exists' | 'platform'> & { log(line: string): void; uid: number; socketOwner(path: string): number | null }): HostAdapter & Required<Pick<HostAdapter, 'type' | 'canType'>>`.
- `id: 'kitty'`, `tap: 'before'`, `bundle: APP_BUNDLES.kitty`. No pane on Windows.
- `paneOf`: `KITTY_WINDOW_ID` (`^[0-9]{1,9}$`) and `KITTY_LISTEN_ON` in the form `unix:` + an absolute path, or on Linux `unix:@` + `[A-Za-z0-9._-]{1,58}` → id `<window>@<listen_on>` when `place.host === 'kitty'` and no `ORCA_TERMINAL_HANDLE` is set, else `held:<window>@<listen_on>`. A window id in form with no `KITTY_LISTEN_ON` gives no pane and logs `[device] kitty · remote control off` once per process.
- The binary: "Decided here". A path socket must be this account's at each verb (`socketOwner(path) === uid`); an abstract one cannot be checked.
- `canFocus`/`focus`: `kitten @ --to <listen_on> focus-window --match id:<id>`.
- `canType`/`type`: the text rules of T18, then every backslash doubled (kitty reads Python escapes in `send-text`; `RECORDED_KITTY.sendTextBackslash` shows what lands); `kitten @ --to <listen_on> send-text --match id:<id> -- <text>`, then `kitten @ --to <listen_on> send-key --match id:<id> enter`; one send at a time per window; true when both exited 0.

- [ ] **Step 1: Failing tests** (a fake `run` answering `RECORDED_KITTY`): `paneOf` and each hint out of form (`tcp:localhost:5000`, a relative path, `unix:@name` on macOS); the log line once across many looks; `types only into the agent's own pane`; the exact argv of focus, `send-text` and `send-key`, and `kitty +kitten @ …` when only `kitty` is found; `words with a backslash reach the prompt as typed` (`a\nb` typed as five characters is sent as `a\\nb`; `\x1b[31m`; `c:\new`); `a socket that is another account's is never spoken to`; remote control refused (`remoteControlOff`), no socket (`noSocket`), a window that is gone (`missingWindow`) → false; one send at a time; Windows has no pane.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/kitty.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** passes; typecheck.
- [ ] **Step 5: Commit** `kitty: a tap focuses the agent's window, and the dial's words reach it`.

### Task 46: Both in the devices' list (§ 3)

**Files:** `cli/src/services/devices.ts:477-502` (the list and its comment), `devices.spec.ts`.

**Interfaces:** `const adapters = [herdrNoted, noting(createZellijAdapter(apps)), tmux, herdrAppNoted, cmuxAppNoted, ...[createKittyAdapter({ ...apps, log, uid, socketOwner }), createWeztermAdapter(apps), …].map(noting)]`: Zellij after herdr and before tmux, kitty before WezTerm. `uid` is the process's; `socketOwner` is `statSync(path).uid` for a socket, `null` otherwise or on any error.

- [ ] **Step 1: Failing tests** (`devices.spec.ts`, as its herdr and WezTerm cases are built): a hooked agent with Zellij's hints has `v` and `f`; its tap runs `zellij --session s1 action focus-pane-id 3`, then its app comes forward as every `before` pane's (macOS `open -b`, Linux the raise); the dial's words run the three Zellij calls and reach no other adapter; the same for kitty's two calls; `an agent in Zellij inside kitty: the tap and the words are Zellij's`; `kitty inside an Orca terminal still sends through Orca`; a kitty session with no socket logs the line once and keeps its tap by bundle on macOS.
- [ ] **Step 2:** `npx vitest run src/services/devices.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the run, typecheck and `npm run test:core` pass.
- [ ] **Step 5: Commit** `The dial reaches agents in Zellij and kitty`.

### Task 47: The dial follows Zellij's focus (only if T7 says so)

Read `RECORDED_ZELLIJ.subscribe.reportsFocus` first. **False: do nothing and commit nothing;** T50 and T51 say there is no follow, and nothing polls instead. True:

**Files:** `H/zellijFollow.ts` + spec (new), `cli/src/services/devices.ts` (one block beside the Orca focus watch at `:1542-1615`), `devices.spec.ts`.

**Interfaces:** `createZellijFollow(deps: Pick<OrcaReadDeps, 'spawn' | 'onPath'>): { watch(session: string, onPane: (pane: string) => void): OrcaFocusWatch }` — one `zellij --session <s> subscribe …` child (the form `RECORDED_ZELLIJ.subscribe` shows), its lines read as `watchOrcaFocus` reads its own (a bounded line, a line over the bound skipped whole, `SIGTERM` then `SIGKILL` after 1 s). In `devices.ts`: one child per session with a shown agent, at most four, started while a dial is attached and stopped when the last goes or no shown agent is in that session; a line turns the dials to `observed.byPane('zellij', '<session>:<pane>')` through `cable.followLocal(agent.id, 'focus')`, skipped within 2 s of the dial's own Zellij focus (an echo, as `orcaSwitches`); lines are outcomes (`[device] zellij watch · started`, `· ended`, `[device] focus · skipped · echo`), never a pane or a session.

- [ ] **Step 1: Failing tests:** `zellijFollow.spec.ts` against `RECORDED_ZELLIJ.subscribe.lines` (each focus line tells its pane; a split line; an over-long line; stop); `devices.spec.ts` (a focus line turns the dial; no dial, no child; the last dial gone, the child stopped; an echo skipped; a fifth session starts none).
- [ ] **Step 2:** `npx vitest run src/cable/hosts/zellijFollow.spec.ts src/services/devices.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the run, typecheck and `npm run test:core` pass.
- [ ] **Step 5: Commit** `The dial follows the pane focused in Zellij`.

### Task 48: E2E: Zellij

**Files:** `E/dialHostZellij.e2e.ts`, `E/harness/zellijSession.ts`.

- [ ] **Step 1:** `zellijSession.ts`: `dialHost('zellij', …)`; a background session of the test's own (`zellij attach --create-background`, its socket folder, config and cache under the daemon's throwaway home; the daemon's `zellij` a wrapper pinned to that socket folder); `agent(folder)` starts the fake engine in a new pane with the real hook, so its hints are Zellij's own; `screen(pane)` is `action dump-screen`; `focused()` reads `list-panes --json`.
- [ ] **Step 2:** The file: the agent is on the fake dial with `v` and `f`; the dial's words land in its pane as its next prompt; a tap makes its pane the focused one; a pane closed since answers the dial's words with no typing anywhere. With T47 built: focusing its pane by hand turns the dial.
- [ ] **Step 3:** `npx vitest run --config vitest.e2e.config.ts e2e/dialHostZellij.e2e.ts` — passes on this Mac if Zellij 0.44 is installed, else skips; runs on the dial-hosts job.
- [ ] **Step 4: Commit** `test(e2e): the dial reaches an agent in a Zellij pane`.

### Task 49: E2E: kitty (only if T8 says kitty starts under Xvfb)

Read `RECORDED_KITTY.startsUnderXvfb` first. **False: do nothing and commit nothing;** the PR says kitty has contract tests only.

**Files:** `E/dialHostKitty.e2e.ts`, `E/harness/kittyWindow.ts`, `.github/workflows/cli-e2e.yml` (the dial-hosts job installs `kitty` and `libgl1-mesa-dri`).

- [ ] **Step 1:** `kittyWindow.ts`: `dialHost('kitty', …)`; kitty under `x11Desk`'s display with `LIBGL_ALWAYS_SOFTWARE=1`, `allow_remote_control socket-only` and a `listen_on` socket under the test's root, its config its own; `agent(folder)` starts the fake engine in a window with the real hook.
- [ ] **Step 2:** The file: `v` and `f`; the words land (`kitten @ get-text`); a tap focuses its window (`kitten @ ls`); a kitty started with no socket logs `[device] kitty · remote control off` once and has no `v`.
- [ ] **Step 3:** Runs on the dial-hosts job; skips on this Mac (it would open a real window).
- [ ] **Step 4: Commit** `test(e2e): the dial reaches an agent in a kitty window`.

---

## Docs

### Task 50: `docs/cli.md`

One commit, no test. A new section `## The dial on Linux`, after `## Your devices`:

- **Starts at login:** the entry's path; turned off where the desktop keeps login items; sway and Hyprland run it only with `dex` or `uwsm`; a server uses `harness service install`; `harness uninstall` removes it.
- **No access to the dial:** the two sentences and what each means.
- **A tap brings the window forward:** a table by desktop (sway, Hyprland, KDE: nothing to install; X11: `wmctrl`; GNOME on Wayland: the Activate Window By Title extension; anything else: the pane inside its terminal only), and the log line that says which was found.
- **Links:** the four, opened where the app registered its scheme (as T1 recorded).
- **kitty:** `allow_remote_control socket-only` and `listen_on unix:/tmp/kitty` in `kitty.conf`, then restart kitty; a socket address over 64 characters is not used.
- **Zellij:** 0.44; whether the dial follows its focus (T7's answer).
- **WezTerm:** takes the dial's words.

And in `## The daemon's environment`, the "Linux desktop" row gains `SWAYSOCK` and `HYPRLAND_INSTANCE_SIGNATURE`. Commit: `docs: the dial on Linux`.

### Task 51: The component's own docs

One commit, no test.
- `cli/AGENTS.md`, the `devices` row: the port's access problem (`cable/portAccess.ts`), the Linux seat check, links by `xdg-open`, the raise (`cable/hosts/linuxDesktop.ts`, `linuxRaise.ts`: what it reads and runs, in memory, found once a process start and after a failed raise; KDE's short-lived file), WezTerm's words, Zellij (`cable/hosts/zellij.ts`) and kitty (`cable/hosts/kitty.ts`), and T47's children if built.
- `docs/specs/2026-11-15-device-host-adapter.md`: the adapters table (WezTerm's `type`; rows for Zellij and kitty), the list's order, the "Linux and Windows" platform line, and the new `windowPid` member.
- `docs/specs/2026-11-14-dial-app-filter.md`: the exe names (T20).
- `docs/plans/2026-11-19-dial-linux-design.md`: § 1.6's table (each link on or off, as recorded), § 2.2 (tmux's client pid is asked for), § 3.2 (follow or not), § 3.4 (kitty's e2e or not), and the two lines that still name the seat file (the Interactions table's "Fast user switching" row: "Needs logind's seat file" becomes "Needs logind (`loginctl`)"; § Testing's "the seat file (fixture files)" becomes "the seat check (a fake `loginctl`)"); § 1.3 already says `loginctl`.
Commit: `docs: the dial's Linux hosts, where the component is described`.

---

## Verification

**Unit tests, per task (each task's Step 4; on this Mac, nothing outside the worktree):** the files each task names, then `cd cli && npm run typecheck`. Desktop: `cd desktop && flutter test --no-pub test/devices_controller_test.dart test/local_cli_discovery_test.dart` (T15, and the three existing `ensureRunning` cases the PR cites for § 1.1a: `local_cli_discovery_test.dart:546`, `:583`, `:632`; no new Desktop test for it).

**PR CI (automatic, once the PR is ready):** `cli-typecheck` and `cli-tests` on Linux (where `install.spec.ts` runs under dash and every Linux branch runs on its own platform), `pty-checks` and `companions` (they read `cli/`), `desktop-tests` (T15), `process-checks` (`actionlint` on `cli-e2e.yml`). No extra run is started.

**Local gates PR CI does not run** (`docs/validation-and-release.md`): from a clean tree at the final commit, on this Mac, `python3 scripts/local-checks.py --run`. For these paths it plans `cli-core` (`npm run test:core`: `services/devices.ts` at 100%) and `cli-serial` (`npx vitest run src/cable/serial.real.spec.ts --maxWorkers=1`: `cable/serial.ts` changed). Paste its output into the PR body.

**CLI end to end on GitHub, by hand, once, after the final review:** `gh workflow run cli-e2e.yml --ref feat/dial-linux` (Actions → CLI end to end → Run workflow on the branch). One run: the eight shards and the macOS job (T11's two starts, and every existing dial file on Linux with the new code) and the new job `e2e (dial hosts)` on `ubuntu-24.04`, which installs herdr, WezTerm, Zellij, Xvfb with openbox, wmctrl and xterm, and sway with foot, and must pass with no case skipped. Every daemon there is `IsolatedDaemon`'s: a private root, home, data and runtime folders, its own port, socket and tmux server, fake engines, a fake dial on a pseudo-terminal, a fake backend on loopback, no account. What a tester reads in that job's log:
- `deviceHerdr.e2e.ts`: herdr's agents on the dial with the real binary (§ 1.7).
- `dialHostWezterm`: the words in the pane's text (§ 1.5).
- `dialHostPortAccess`: the two sentences on the dial's row, and the log line once (§ 1.2).
- `dialHostX11Raise`: `_NET_ACTIVE_WINDOW` becomes the agent's xterm (§ 2).
- `dialHostSwayRaise`: the focused node becomes the agent's foot (§ 2).
- `dialHostZellij`: the words land and the focus moves (§ 3.2); `dialHostKitty` only if T49 was built (§ 3.3).
Every Linux daemon there runs T16's real check: a runner has no active seat0 session, so `loginctl` answers no user and the dial stays this daemon's. A dial file failing with `cable: USB belongs to the account at this computer's screen` in its daemon log means the check took the dial from the runner. A re-run after a fix to one of those files alone: `gh workflow run cli-e2e.yml --ref feat/dial-linux -f dial_hosts=true` (one runner). Report the run links. GNOME, KDE and Hyprland have contract tests against their recordings and no live check (spec § Verification).

**The installer on a real Ubuntu, in a container on this Mac (a tester, about three minutes):** `docker run --rm -v "$PWD/cli/scripts/install.sh:/install.sh:ro" ubuntu:24.04`, in it `apt-get install -y curl ca-certificates tmux procps`, a user `u`, then as `u`: `sh /install.sh`. It downloads the released Node and CLI from the public CDN, as any install does; no account is used, and the daemon it starts below is given `BACKEND_WS_URL=ws://127.0.0.1:9 WEB_URL=http://127.0.0.1:9 ADAPTER_UPDATE_DISABLE=true`, so nothing else leaves the container. The tester sees: `~/.config/autostart/harnessd.desktop` with the five lines; with `XDG_CONFIG_HOME=/home/u/cfg` it is under `/home/u/cfg/autostart`; after adding `Hidden=true` and installing again the file is unchanged, and so is one whose `Exec=` was replaced by another program's; running the entry's `Exec=` twice at once (`sh -c '<Exec> & <Exec> & wait'`) leaves one master (`harness status` names one pid, `pgrep -fc __harnessd` is 1). The container is removed with `--rm`.

**For a person with a Linux desktop and a dial (sent to harness-pm; not a tester's):** no Linux VM and no USB pass-through exist here.
- After a fresh install and a log out and in, `harness status` says running with nobody having typed `harness start`; with Desktop also installed, still one daemon.
- Plugged in from an account outside the device's group: Desktop's Devices tab and `harness hardware watch` show `No access to the dial. Run: sudo usermod -aG <group> $USER, then log out and in.`, whole and readable; after the command, `No access to the dial yet. Log out and in.`; after logging in again the dial attaches.
- A tap on an agent in each terminal they have (tmux, WezTerm, kitty with remote control on, Zellij, VS Code's terminal) brings its window forward; the daemon's log says `[device] raise · <their desktop>`; on GNOME Wayland without the extension the pane is chosen and the window stays, with `[device] raise · none · gnome without the extension`.
- Switching to another account lets the dial go; switching back takes it again.
- The dial's voice lands in a WezTerm, Zellij and kitty pane.
- On a Mac, with their own eye: a tap and the voice in a Zellij pane and in a kitty window with remote control on (a kitty window cannot be driven headless there).

**Said in the PR as a follow-up, not changed here (spec § 1.1a):** an opt-in systemd unit written from a shell whose `XDG_DATA_HOME` differs from the desktop session's names another data folder, so Desktop's `harness start` spawns a second master that fails to bind port 18473.

**Harness OS** (Review Focus 8): not run here; its dial is checked by the OS's own acceptance when that workflow next runs by hand. Said in the PR.

**No temporary workflow:** every long check runs in `cli-e2e.yml`, which is started by hand on the branch and keeps the new job for later nights; the remaining checks need a container on this Mac or a person's desktop. No check runs against production.
