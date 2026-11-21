# The dial on Linux (roadmap Phases 0–2, 2026-11-19)

The dial works on a Linux desktop as it does on a Mac, as far as Linux lets it: the daemon is there after login, a dial
the account cannot open says how to fix it, the hosts that run on Linux get the verbs their own tools offer, app links
open where the apps exist, and a tap brings the agent's window forward on the desktops that allow it.

One pull request (Ken via harness-pm, 2026-11-19), in three parts:

- **Part 1, base:** autostart, port permission, fast user switching, Orca, WezTerm typing, links (VS Code, Cursor, the
  Claude app, the ChatGPT app), herdr on the e2e runners.
- **Part 2, tap raises the window:** X11, sway, Hyprland, KDE, GNOME; otherwise the tap focuses inside the terminal only.
- **Part 3, Zellij and kitty:** an adapter each, on macOS and Linux.

## Why

The audit of `main` 6dcb285e7d (Linux about 60 %, file:line evidence in the task brief) found that on Linux the dial
attaches and lists agents, but: the daemon only runs once someone types `harness start`; a dial the account may not
open prints a log line every 2 s and nothing else; every app link and every "bring the app forward" step is macOS-only
(`open -b`); and a tap focuses the pane inside its terminal but never raises the terminal's window.

## Decided

1. Ken approved the list (2026-11-19). Linux only: no Windows-only code path changes (the named pipe listener, the
   Windows serial helper, Task Scheduler); Windows is Diego's side.
2. Zellij and kitty adapters are built here, as part 3, macOS and Linux only (Ken via
   harness-pm, 2026-11-19, after Diego's side stopped). Zellij on Windows is dial-windows' to turn on later.
3. The Claude and ChatGPT app links on Linux go in part 1, since they share the link opener with `vscode://`
   (harness-pm, 2026-11-19).
4. The Device app on Linux (its package, and sway/Hyprland front sources beside its X11 one) is built by another
   session (device-app-win-linux), not here; the front app on Linux comes from the Device app, as on macOS, one way on
   every OS (Ken via harness-pm, 2026-11-19). GNOME and KDE on Wayland: a named difference.
5. Autostart must leave exactly one owner of the daemon when the Desktop app is also there, with a test
   (harness-pm, 2026-11-19; § 1.1a).
8. Autostart is an XDG autostart entry running `harness start`, not a default systemd unit; `harness service install`
   stays the opt-in for servers (harness-pm, 2026-11-19, after the builder check; § 1.1).
6. Test machines (harness-pm, 2026-11-19): no Linux VM. GitHub Ubuntu runners (`cli-e2e`, lane asked of harness-pm),
   headless Docker/OrbStack containers on the Mac, and the docker boxes. The real dial on Linux is a check for a person
   with a Linux desktop (§ Verification).
7. Devices is a component, not the core: nothing here touches `cli/src/core/` or `architecture.coreFiles.txt`.

9. One pull request for all three parts, one final review, one merge (Ken via harness-pm, 2026-11-19).
10. Diego's `fix/dial-claude-app-idle-sessions` adds an "ended" rule for every listing source (herdr, cmux, opencode).
    If it merges before this branch, this branch rebases onto it, and a Zellij or kitty listing (if part 3 adds one)
    follows that rule (harness-pm, 2026-11-19).

## Part 1: base

### 1.1 The daemon starts at login on Linux

Today the daemon runs only once someone types `harness start` (or under systemd after the opt-in `harness service
install`, `harnessd/platform.ts`, `lib/serviceCommand.ts`); `cli/scripts/install.sh` deliberately starts nothing
(`:843`). Windows starts `harness start --if-down` at logon through Task Scheduler.

Ken's list said "systemd --user autostart by default". The builder check found that a default systemd unit would break
two things that work today, so the login entry is an XDG autostart entry instead, and systemd stays the opt-in for
servers (harness-pm, 2026-11-19):

- A unit wanted by `default.target` starts before the desktop session imports `DISPLAY` and `WAYLAND_DISPLAY`
  into the user manager, and the daemon, its tmux server and every agent's pane keep that environment: the clipboard
  (`osClipboard.ts:94-101`), `xdg-open` and an agent opening a browser would all lose the display.
- Without linger, the user manager ends with the last session, and the daemon, tmux and the agents with it; a daemon
  `harness start` left running survives a logout today (Ubuntu's `KillUserProcesses=no`). Linger needs polkit or sudo,
  and starts the daemon at boot, before any display.

The entry:

- `install.sh`, both modes (standalone, and the Desktop app installing its CLI with `--desktop`), on Linux only, writes
  `<config>/autostart/harnessd.desktop`, where `<config>` is `$XDG_CONFIG_HOME` when it is absolute, else
  `~/.config` (the rule `harnessd/platform.ts` already follows for the unit's folder, `:411`, `:440`). It is a
  `Type=Application` entry whose `Exec=` is the launcher's absolute path and `start`, with
  `X-GNOME-Autostart-enabled=true`; its name is `Harness`. No `NoDisplay=true`: GNOME's Startup Applications hides
  such an entry, and that is where the person turns it off (changed in the final review, below). Written atomically (a temp file in the same folder, then
  a rename), and only when the file is missing or its `Exec=` is exactly install.sh's own `<launcher> start` line. A
  file with another `Exec=` (the Linux Device app's, built by device-app-win-linux, which then owns the login entry) is
  left as it is, and so is one with `Hidden=true` (harness-pm, 2026-11-19). Tests cover both.
- The desktop session runs it at login, inside the session, so the daemon has the session's environment as when
  someone types `harness start`. `harness start` is already harmless when a daemon runs ("already running", exit 0),
  and hands the start to systemd when a unit owned by this data folder is installed (`cli.ts:1665-1701`), so one entry
  covers both.
- GNOME, KDE Plasma, XFCE, Cinnamon, MATE and LXQt run XDG autostart entries; sway and Hyprland do only when the person
  set that up (`dex`, `uwsm`), which `docs/cli.md` says. A computer with no desktop session never runs it: SSH-only
  machines and containers change nothing.
- The person turns it off where they turn off any login item (GNOME's Startup Applications, KDE's Autostart
  settings), which sets `Hidden=true` in the same file or removes it. A later `install.sh` run keeps a file that says
  `Hidden=true` as it is, so the person's choice stands (above); a file the person deleted is written again by a later install,
  and they turn it off again in the same place. (My call.)
- New installs only: the updater does not run `install.sh`, and an existing install is not changed behind the
  person's back.
- The Desktop app on Linux has no launch-at-login of its own today (its only `.desktop` file is its menu entry,
  `desktop/lib/core/linux_app_image.dart:41`, `<data>/applications/harness.desktop`), so there is exactly one login
  entry. A different file name (`harnessd.desktop`) keeps the two apart.
- The comment and the final guide in `install.sh` change from "never starts anything" to "on Linux, starts at login".
- No flag to skip it (AGENTS.md: no switch for a choice the product makes). macOS is unchanged.
- **One owner.** The login entry and Desktop must never run two masters or fight over one (decision 5): § 1.1a.

### 1.1a One owner with Desktop

One master per data folder, whoever asks first: the login entry, Desktop, or a person typing `harness start`. Each asks
through `harness start`, which starts one or finds the one running, and hands the start to systemd when the opt-in unit
is installed. What holds that today (read 2026-11-19):

- Desktop probes the daemon's socket first and runs `harness start` only when nothing answers
  (`desktop/lib/ws/local_cli_discovery.dart:270-313`, `app_state.dart:6972`, `:7077-7081`). It uses the same CLI and
  data folders a standalone install does (`harness_cli_runner.dart:136-172`, `harness_home.dart:100-128`).
- `harness start` takes the spawn lock, exits "already running" when the pid file names a live master, and otherwise,
  when a unit owned by this data folder is installed (`PlatformService.ownedBy`, the unit's log path), runs
  `systemctl --user start` and never spawns beside it (`cli.ts:1665-1701`, `platformDaemon.ts:139-181`). A login race
  (Desktop starting while systemd's master is coming up) ends in a `start` of an active unit, which does nothing.
- Every CLI stop (`harness stop`, logout, update, reset) signals the master through systemd
  (`systemctl --user kill --kill-who=main`), never a stop job; the master exits cleanly and `Restart=on-failure`
  leaves it stopped (`daemonStop.ts:94`, `platform.ts:809-824`). Desktop on Linux never stops or restarts the daemon
  itself: its restart guard is macOS-only (`app_state.dart:966-980`), and stays so.

So no code changes for ownership; what is missing is the test. This work adds:

- a Desktop test that runs `LocalCliDiscovery.ensureRunning` against a daemon already answering (as the autostarted
  one would at login) and asserts no `harness start` runs;
- a CLI e2e case beside `cli.e2e.ts:288`: two `harness start` at once (the login autostart and Desktop) leave one
  master, through the spawn lock and, with a unit installed, through systemd. Desktop's `ensureRunning` does not merge
  two callers itself, and needs not: the CLI makes a second start harmless. (Builder check; my call.)

A known edge, not changed here: an opt-in unit written from a shell whose `XDG_DATA_HOME` differs from what a Desktop
launched by the desktop session sees names another data folder, so Desktop's `harness start` spawns a second master.
It does not fail: port 18473 is taken, so it logs `[hooks] control port 18473 unavailable; assigning a separate port
for this user`, listens on a random port and stays up as a machine of its own (its own computer id). Each master
rewrites the Claude Code hooks in `~/.claude/settings.json` to its own port, so hook calls go to the newest, and the
later ones retry the bridge port (51793) every 5 s. This is so in CLI 0.6.73 already; this work makes it slightly more
likely only when the login entry and an opt-in unit use different data folders. The login entry runs in the desktop
session, as Desktop does, so it agrees with Desktop. One master per user (or a hook port that does not move) touches
the core, so it is a separate follow-up, said in the final report.

### 1.2 A dial the account cannot open says how to fix it

The ESP32-S3's USB serial is `/dev/ttyACM*`, owned by `root:dialout` 0660 on Debian/Ubuntu/Fedora and `root:uucp` on
Arch. Today an account outside that group gets `stty: /dev/ttyACM0: Permission denied` from `SerialLink.open`
(`serial.ts:311`), and `cableSession.ts:1149` logs `cable: cannot open the dial: …` every 2 s (`REOPEN_EVERY_MS`),
with no state anyone sees.

- `SerialLink.open` on Linux checks access first (`access(path, R_OK | W_OK)`), before `stty`, and throws a typed
  error (`EACCES`) with the device's group. The group is read from the device node (`stat().gid`, its name from
  `/etc/group`), never assumed: dialout, uucp, or whatever the distribution uses.
- The session sets the dial's existing `problem` (`DialStatus.problem`, `cableSession.ts:603-636`), which Desktop
  already shows as the connection label (`desktop/lib/devices/devices_controller.dart:61`) and `harness hardware
  watch` already prints. No new field, no new screen. The copy, two cases:
  - not in the group: `No access to the dial. Run: sudo usermod -aG <group> $USER, then log out and in.`
  - in the group (listed in `/etc/group`) but this login does not have it yet (`process.getgroups()` lacks it):
    `No access to the dial yet. Log out and in.`
- A port that has never opened has no row today (`CableFleet.devices()` keeps entries attached or with settings,
  `cableFleet.ts:393-397`), so the fleet publishes one for it carrying only the problem, the way it already publishes a
  silent Harness Pro's (`{ id, attached: false, problem }`, `cableFleet.ts:395`), which Desktop already draws. No new
  UI. (Builder check; my call.)
- The problem clears the moment an open succeeds; the log says it once per change, not every 2 s.
- No udev rule is shipped (Ken: only if needed). The group fix works on every distribution and needs no file in
  `/etc`; Harness OS keeps its own `uaccess` rule (`os/root/usr/lib/udev/rules.d/70-harness-device.rules`).
- Desktop: the label is free text already; no change to the design doc beyond the copy, which goes in the gallery's
  dial-status example if one lists problems.

### 1.3 Fast user switching on Linux

`usbConsoleUser.ts:15` answers true on every platform but macOS and Windows, so a daemon left running by a switched-
away account keeps the dial. On Linux the active account of the seat comes from `loginctl`, logind's public CLI
(`/run/systemd/seats/seat0` is private and says not to parse it):
`loginctl show-seat seat0 --property=ActiveSession --value`, then `loginctl show-session <id> --property=User --value`. This daemon may use the USB dial when its uid is
that one. No `loginctl`, no seat0, no active session or an answer that is not a uid (no logind, a headless box, no seat)
answers true as today: a computer with no seat has no screen to switch away from. The fleet asks every 2 s, so the
answer is kept and read again at most every 8 s.

### 1.4 Orca on Linux

On Linux Orca's CLI is `orca-ide`; a bare `orca` there is usually GNOME's screen reader (`/usr/bin/orca`).
`orcaBinary` (`devices/orcaHomes.ts:66-69`) looks only for `orca` matched by its launcher pattern. On Linux it looks for
`orca-ide` on `PATH` first, then `orca` through the same launcher check; the launcher pattern accepts both names in
Orca's `resources/bin`. Every caller (`orca.ts`, `orcaHomes.ts`, `orcaPlugin.ts`) gets it from the one function.

### 1.5 WezTerm types

`wezterm.ts` focuses a pane but cannot type into it, so the dial's answer and voice skip WezTerm panes. It gains
`type`: `wezterm cli send-text --pane-id <n> --no-paste -- <text>`, then the Enter key on its own
(`send-text --no-paste $'\r'`), each with the existing run timeout, no shell. `--no-paste` sends the text as typed, so
an agent's TUI does not treat it as a bracketed paste. One send at a time per pane (as herdr's `prompting`). `canType`
is true for the agent's own pane when a `wezterm` binary is found. It runs on macOS and Linux; Windows has no process
table to tell the agent's own pane (below).

**The agent's own pane.** A terminal, an editor or a multiplexer started from a host's pane keeps that pane's
variables: `code .` run in WezTerm's pane 7 gives VS Code's terminals `WEZTERM_PANE=7`, and words typed into pane 7
run at its shell. So no variable decides whose pane it is: the process that made the agent's pseudo-terminal does. From
the hook's caller up its parents (`parentChain`'s walk and bound) while they run on the caller's tty, the first process
on another tty or on none made it: the walk from the one table the open scan reads, `ps -axo pid=,ppid=,comm=`, and
each process's tty from `ps -o tty= -p <pid>`, one at a time and only up to that first one (`scannedApp.ts`
`readPtyOwner`, `ptyOwner`), as a tty column made every read of the table three times as slow on macOS and a `ps -p`
of two pids or more takes 53 ms there, of one 2.4 ms. Only a caller whose hints name a WezTerm, kitty or Zellij pane is
read. WezTerm's pane is the agent's own when that is `wezterm-gui` or `wezterm-mux-server`
(Linux cuts it to `wezterm-mux-ser`); kitty's when `kitty`; Zellij's when its server, `zellij`; macOS names each by its
path. It is read once per caller (`observed.ts` `learnPtyOwner`) and reaches the adapters as `Place.ptyOwner`; until it
lands, and for any other maker, the pane is `held:` and takes a tap alone. A tap takes the pane of the host that made the
agent's terminal before any other (tmux's `tmux: server` too, so tmux inside a Zellij pane selects its tmux pane).

### 1.6 Links on Linux

`appLink.ts` runs `open -b <bundle> <url>` and nothing elsewhere. On Linux it runs `xdg-open <url>`, when the scheme
has an app: `xdg-mime query default x-scheme-handler/<scheme>` prints a `.desktop` name (read once per scheme per
process start and again after a failed open, with the run timeout). No handler, no `xdg-open`, or a non-zero exit:
the link answers false as today, and the tap falls back to the pane (never an error shown). `HARNESS_OPEN_BIN`'s test
hook carries over to the Linux opener.

The links this turns on:

| Link | App on Linux | Adapter | On Linux, as recorded |
|---|---|---|---|
| `vscode://anthropic.claude-code/open?session=<id>` | VS Code | `vscode.ts` | on: `code` 1.147.0 registers `vscode` (`com.microsoft.VSCode.UrlHandler.desktop`) |
| `cursor://anthropic.claude-code/open?session=<id>` | Cursor | `vscode.ts` | on: `cursor` 3.30.14 registers `cursor` (`cursor-url-handler.desktop`) |
| `claude://code/continue?session=<id>` | the Claude desktop app (Linux beta, Ubuntu/Debian) | `claudeApp.ts` | on: `claude-desktop` 5.11492.5 registers `claude` (`com.anthropic.Claude.desktop`) |
| `codex://threads/<id>` | the ChatGPT desktop app (Linux preview) | `codexApp.ts` | on: `chatgpt` 26.1111.71704 registers `codex` (`chatgpt.desktop`) |

All four are the vendors' own `.deb` packages, recorded in `cli/src/testing/recordedLinuxApps.ts`. The process names
are `code`, `cursor`, `claude-desktop` and `ChatGPT` (the ChatGPT package's `chatgpt` launcher execs `ChatGPT`), which
the exe table maps to `vscode`, `cursor`, `claude` and `codex`. The window classes are each `.desktop` file's
`StartupWMClass`: `com.microsoft.VSCode`, `Cursor` and `com.anthropic.Claude`. The ChatGPT app's `.desktop` file has
none, so the raise has no class for `codex` and finds its window by pid only; that file also claims `http` and `https`,
which makes it a browser candidate but changes nothing for `codex://`.

Each adapter's `paneOf` today needs a macOS bundle hint to know its app. On Linux it reads the same facts Linux
gives: the app from the process scan (`place.app`, from `frontApp.ts`'s exe names) or the hook's own hints. Cursor's
terminal says `TERM_PROGRAM=vscode` as VS Code's does, and only a bundle id tells them apart: hints that name VS Code by
`TERM_PROGRAM` alone are confirmed by the caller's parents (`observed.ts` `walked`), and a walk that names no app leaves
VS Code. The exe
names of the Claude and ChatGPT Linux apps and the scheme lines of their `.desktop` files are recorded from the real
packages (a task installs each in a disposable Ubuntu container, reads `dpkg -L`, the `.desktop` files'
`MimeType=` and `Exec=`, and the running process's name, and commits only those facts as fixtures). If a package does
not register its scheme, its link stays off on Linux and the spec's table says so; nothing fails hard.

Cursor's folder window (`cursorFolder.ts`, macOS `open -b <bundle> <folder>`): on Linux it runs Cursor's own CLI with
the folder (`cursor <folder>`, which brings the window open on that folder forward or opens one), with the same folder
checks. Cursor's CLI is the one in Cursor's install (its `.desktop` `Exec=` folder, or a `cursor` on `PATH` that is not
cursor-agent's shim, `docs/plans/2026-11-18-dial-cursor-design.md`); none found, the tap does nothing more.

Raising VS Code's or Cursor's window after the extension showed a terminal (`vscode.ts:102`, macOS `open -b`) is the
window raise of part 2.

### 1.7 herdr on the Linux e2e runners

`deviceHerdr.e2e.ts` is skipped on the runners (`describe.skipIf(!herdrBinary)`, `harness/herdrServer.ts:41-45`)
because herdr is not installed. `cli-e2e.yml` installs herdr from its GitHub release, version pinned (0.9.5 or the one
the recorded fakes match, the builder's call) and its checksum checked, into `~/.local/bin`. The workflow stays
nightly and manual (not on pull requests).

## Part 2: a tap raises the window

Today a tap runs the host's own focus (tmux `switch-client`, `wezterm cli activate-pane`, `orca terminal switch`,
herdr's socket, VS Code's extension) and then, on macOS only, `open -b <bundle>` (`open.ts:120-135`). On Linux the
second step is missing, so the pane is chosen but its window may stay behind others.

### 2.1 Where it goes

One new module in the devices component, `cli/src/cable/hosts/linuxRaise.ts`, called by `open.ts` where macOS calls
`forward(bundle)`: after a pane's focus answered true (for a `before` adapter), and as the fallback when there is no
pane. `can()` and `bring` on Linux use it as macOS uses `open -b`. Nothing else in the opener changes; a raise that
fails or finds nothing answers false and the tap's own outcome stays the pane's.

### 2.2 Which window

1. The agent's process chain (the existing `ps` walk, `scannedApp.ts` `parentChain`) from the agent's pid upward: the
   first ancestor that owns a window is the terminal's (or the editor's) window. The chain starts from the agent's
   window as the observed source knows it (`ObservedSource.windowOf`): for an agent in a tmux or Zellij pane, the pid of
   the client that shows its session, as its outer lookup found it (`createTmuxOuter` in `tmux.ts`, `createZellijOuter`
   in `zellij.ts`, asked in turn by `outer.ts` `firstOuter`), else its caller's or its own pid. When a tap ran tmux's `switch-client`, the adapter's `windowPid`
   gives the client it switched instead, asked once after that focus.
2. None found by pid: the app's window by its class, from the place's app (`windowClasses` in `frontApp.ts`, one fixed
   table beside its exe names: `vscode` → `com.microsoft.VSCode`, `wezterm` → `org.wezfurlong.wezterm`, …, with the
   lower-cased spelling some desktops use), as macOS raises an app by bundle. An app with no confirmed class has no row.

### 2.3 How, per desktop

Found once per process start, and again after a raise fails, from what this login exposes; never from another
process's environment (cli/AGENTS.md rule 4). The daemon may run under systemd without `DISPLAY` or `WAYLAND_DISPLAY`
(the user manager can start before the session imports them), so the backends are found from the session's own
sockets in `$XDG_RUNTIME_DIR` when the variables are absent:

| Desktop | Found by | Raise |
|---|---|---|
| sway | `$SWAYSOCK`, else `$XDG_RUNTIME_DIR/sway-ipc.<uid>.*.sock` (this account's, answering `get_version`) | `swaymsg -s <sock> -t get_tree`, then `'[pid=<p>] focus'` for the first pid that owns a window, else `'[con_id=<id>] focus'` for the first window of the class: its `app_id`, or for an XWayland window (whose `app_id` is null) its `window_properties.class` |
| Hyprland | `$HYPRLAND_INSTANCE_SIGNATURE`, else `$XDG_RUNTIME_DIR/hypr/<sig>/.socket.sock`; a signature holds at least two `_` (`<commit>_<time>_<random>`), since `hyprctl -i` reads one without as an instance's number | `hyprctl -i <sig> clients -j`, then `dispatch focuswindow pid:<p>`, else `address:<address>` of the first window of the class (`class`, else `initialClass`); success is stdout `ok`, as `hyprctl` exits 0 on a miss too |
| KDE Plasma (Wayland or X11) | `org.kde.KWin` on the session bus (`$DBUS_SESSION_BUS_ADDRESS`, else `$XDG_RUNTIME_DIR/bus`) | a KWin script loaded through `org.kde.kwin.Scripting` (`loadScript`, then `org.kde.kwin.Script.run` at `/Scripting/Script<id>` on Plasma 6, else `/<id>` on Plasma 5, then `unloadScript`) that activates the window whose `pid` (else `resourceClass`) matches, through `dbus-send`; the script reads `windowList`/`activeWindow` on Plasma 6 and `clientList`/`activeClient` on Plasma 5. A script that ran is a raise: it cannot say whether it found a window |
| GNOME on Wayland | `org.gnome.Shell` on the session bus, and the Activate Window By Title extension on: its interface name in `gdbus introspect`'s output of its object (GDBus answers an introspection of any path) | `activateByWmClass(<class>)` through `gdbus`, `(true,)` a hit (the extension matches by class, not pid: a native window's app id, an XWayland window's WM_CLASS class part) |
| Any X11 desktop with an EWMH window manager | `$DISPLAY`, else `/tmp/.X11-unix/X<n>` with its `XAUTHORITY` (`$XAUTHORITY`, `~/.Xauthority`, or the session's Xwayland auth in `$XDG_RUNTIME_DIR`) | `env DISPLAY=… XAUTHORITY=… wmctrl -lpx` to find the window by pid (else class, either side of `<instance>.<class>`), then `wmctrl -i -a <id>` |
| Anything else (GNOME Wayland without the extension, an unknown compositor, no tool installed) | — | nothing: the tap focuses inside the terminal only |

Order: the compositor's own IPC first (sway, Hyprland, KWin, GNOME), X11 last, since on Wayland the X11 socket is
Xwayland's and sees only X11 windows. One tool per desktop: `wmctrl`, not also `xdotool`.

What the person sees where nothing raises: the pane is still chosen inside its terminal, as today; the daemon log says
once per process start which raise it found (`[device] raise · none · gnome without the extension`), and `docs/cli.md`
lists what turns it on (install `wmctrl` on X11; the GNOME extension on GNOME Wayland). No error, no new screen.

KWin takes a script only as a file (`loadScript(path, name)`) and passes it no arguments, so each KDE raise writes the
fixed script with the checked pids and classes filled in as JSON to a private file
(`$XDG_RUNTIME_DIR/harness/raise-<pid>-<n>.js`, the folder 0700, the file 0600), loads it under a name of its own
(`harness-raise-<pid>-<n>`, so two raises at once never unload each other's), runs it, unloads it and deletes the file.
(Builder check; my call.)

Every command runs with no shell, the existing run timeout, one raise at a time (the opener's `running` set already
holds that per agent), and a pid or class checked against its form before it reaches a command line or a KWin script
(the script text is fixed; the pid and class are passed as checked values, never spliced unescaped).

`startEnvironment.ts`'s allowlist gains `SWAYSOCK`, `HYPRLAND_INSTANCE_SIGNATURE` and `XDG_RUNTIME_DIR` if the latter is
not there, so a `harness start` from the session carries them (its spec lists every variable).

## Part 3: Zellij and kitty

Both are detected today (`hostDetect.ts:28-31,143-149`: `ZELLIJ` → zellij, `KITTY_WINDOW_ID` → kitty) and have no
adapter, so a tap brings nothing forward inside them and the dial's answer and voice skip them. Each gets an adapter
in `cli/src/cable/hosts/` (the contract in `adapter.ts`: `paneOf`, `canFocus`, `focus`, `type`, `canType`; plain
factory objects, never throwing), listed in `services/devices.ts`'s adapter list in the nearest-host order (a
multiplexer before the terminal it runs in: Zellij beside tmux, kitty beside WezTerm). macOS and Linux; off on
Windows.

### 3.1 What the hook sends

The hook sends a session's host hints (`hook/notify.mjs` `HOST_HINTS`, at most 10, the core checks only their count
and size, `core/observedHook.ts:51-93`, so the core does not change). It gains, in the nearest-host order and each at
most 64 characters:

- `ZELLIJ_PANE_ID` and `ZELLIJ_SESSION_NAME` beside `ZELLIJ`: the pane, and which Zellij server holds it (one person
  may run several sessions; `zellij --session <name> action …` targets one).
- `KITTY_LISTEN_ON` beside `KITTY_WINDOW_ID`: kitty sets it in its windows when remote control listens
  (`listen_on unix:…`), and it is the socket `kitten @ --to` needs, since the daemon runs outside kitty.

The cap and the order are the hook's (the farthest hint drops first); the builder keeps `hookNotify.spec.ts`'s
checks and orders the new names so a session in Zellij inside kitty keeps Zellij's.

### 3.2 Zellij (0.44)

- `paneOf`: `ZELLIJ_PANE_ID` (digits) and `ZELLIJ_SESSION_NAME` (Zellij's session-name form), both checked.
- `focus`: `zellij --session <s> action focus-pane-id <id>`; `tap: 'before'`, so the terminal Zellij runs in comes
  forward after (macOS `open -b`, Linux part 2's raise).
- `type`: `zellij --session <s> action write-chars --pane-id <id> -- <text>`, then
  `zellij --session <s> action send-keys --pane-id <id> Enter`, one send at a time per pane. Before typing, the pane is
  checked against `zellij --session <s> action list-panes --json` (it exists, is a terminal pane, and its program has
  not exited), so a closed pane whose id was reused is not typed into, nor a pane Zellij holds open after its program
  exited, where Enter runs that program again.
- No follow: the dial does not follow the pane focused in Zellij. 0.44's `subscribe` reports pane render updates
  only, never a focus change (`RECORDED_ZELLIJ.subscribe`), so there is nothing to follow, and nothing polls instead.
- `zellij` is found as the core finds tmux (`zellijFinder`, through `binaryFinder` in `lib/binaryFinder.ts`): on the
  devices process's `PATH`, else where the person's login shell finds it, else in the folders the core looks in for tmux;
  none found is asked again once one is there. One finder serves the tap, the words and the client lookup. `canFocus` is
  true for any Zellij pane (a tap that finds no `zellij` brings the app forward, as tmux's does); `canType` is true for
  the agent's own pane, one whose terminal Zellij's server made (§ 1.5), not one that only holds it (herdr, Rex, tmux,
  a terminal or an editor started in Zellij).
- The page: the agent is on the page of the app that holds the Zellij client showing its session, found by an outer
  lookup of its own, asked after tmux's (`createZellijOuter`, `outer.ts` `firstOuter`), only for a caller whose terminal
  Zellij's server made (§ 1.5): a terminal started from a pane is under the server too. `list-clients` names no client's
  process or tty, so the client is read from the process table, and only when the session has exactly one client and
  the machine one Zellij client; otherwise the agent stays where its hints place it.

### 3.3 kitty

- Remote control is off by default. kitty takes commands only with `allow_remote_control` (`yes`, or `socket-only`)
  and `listen_on unix:<path>` in `kitty.conf`. Without them `KITTY_LISTEN_ON` is absent and the adapter offers
  nothing: the tap brings kitty forward as today.
- `paneOf`: `KITTY_WINDOW_ID` (digits) and `KITTY_LISTEN_ON` (`unix:` and an absolute path, or `unix:@<name>` on
  Linux), both checked.
- `focus`: `kitten @ --to <listen_on> focus-window --match id:<id>`; `tap: 'before'`.
- `type`: `kitten @ --to <listen_on> send-text --match id:<id> -- <text>`, then the Enter key
  as `send-text --match id:<id> -- \r`, one send at a time per window. Not `send-key`: kitty 0.32.2 sends a key to the
  active window whatever `--match` names (`RECORDED_KITTY.sendKeyOtherActive`).
- `kitten` is found as the core finds tmux (`kittyFinder`): on `PATH`, else through the login shell, else in the
  folders the core looks in, else on macOS `kitty.app`'s own; else `kitty` on `PATH`, run as `kitty @` (`kitty +kitten
  @` fails on 0.32.2, `RECORDED_KITTY.kittyAt`). A socket at a path is spoken to only when it is this account's. Linux's
  abstract socket (`unix:@<name>`) has no owner to read, and once kitty is gone any account may take its name: it takes
  a tap, never words.
- `canFocus`: the hints in form; `canType`: the agent's own window, one whose terminal kitty made (§ 1.5), not one that
  only holds it, at a socket at a path.
- **Telling the person.** A kitty session with no `KITTY_LISTEN_ON` gets one daemon log line per process start
  (`[device] kitty · remote control off`), and `docs/cli.md` gives the two `kitty.conf` lines to add
  (`allow_remote_control socket-only`, `listen_on unix:/tmp/kitty`), then restarting kitty. No new screen.

### 3.4 Tests

Contract tests with output recorded from the real tools (Zellij 0.44's `list-panes --json` and `subscribe`, kitty's
`kitten @ ls` and the error text when remote control is off), each a fixture in `src/testing/` as `fakeHerdr.ts`'s
`RECORDED`. E2E where the binary runs on an Ubuntu runner: Zellij in a background session
(`zellij attach --create-background`), typing and focus read back from `list-panes --json` and `dump-screen`
(`dialHostZellij`). kitty starts under Xvfb (`RECORDED_KITTY.startsUnderXvfb`), so it has an e2e too (`dialHostKitty`):
kitty under Xvfb with `LIBGL_ALWAYS_SOFTWARE=1` (Mesa's llvmpipe), with fontconfig and a font installed, which it needs
to start.

## Linux against macOS

macOS's behavior and copy are the reference (Ken via harness-pm, 2026-11-19): on Linux every dial interaction behaves
and reads as on a Mac. Where Linux forces a difference, this table names it and why. After this work:

| Interaction | On Linux | Difference, and why |
|---|---|---|
| Attach, states, copy (attached, updating, problems) | as macOS | One more problem, Linux's own: no access to the port (§ 1.2). macOS needs no group. |
| Daemon there after login | as macOS with Desktop; standalone too (§ 1.1) | Started by the desktop session's autostart, not launchd; sway/Hyprland only when the person runs XDG autostart. SSH-only machines: by hand, as today. |
| Fast user switching | as macOS (§ 1.3) | Asks logind (`loginctl`), read every 8 s, so the dial goes within about 10 s of a switch (2 s on macOS: two processes every 2 s on an idle daemon would cost more); without a seat the daemon keeps the dial, as a computer with no screen to switch. |
| List (agents, states, rings, drawer, notices, `harness device notify`) | as macOS | None: hooks, the listener socket and the fleet are the same code. Herdr.app (Herdr Core) and cmux are macOS apps and have no Linux build. |
| Speak (voice to Claude Code, Codex) | as macOS | Codex in the ChatGPT app takes `codex` from `PATH` (the app's own CLI is found only in macOS's bundle, `codexQueue.ts:154`). |
| Type (answer, voice) into a pane | herdr, Orca, WezTerm (§ 1.5), Zellij, kitty (§ 3), each only in a terminal it made | kitty only with remote control on (§ 3.3), as kitty requires. tmux types on neither. An agent started from an Orca terminal or a herdr pane (VS Code, another terminal) has that pane held: a tap alone, logged `[device] orca · held` / `[device] herdr · held`; macOS the same. |
| herdr inside a terminal | as macOS: the page of the app holding herdr's client (WezTerm, kitty, Ghostty, or the app holding the tmux or Zellij client herdr runs in), else the Other page | Linux reads herdr's clients from `ss -xn` and `/proc/<pid>/fd`, macOS from `lsof`. In a terminal with no page, a tap raises the client's window where the desktop raises by process (X11, sway, KDE, Hyprland), not GNOME. Ghostty on Linux, GNOME Terminal, Ptyxis, Konsole, Alacritty, foot and xterm offer no tab API: the tab holding the client is not selected. |
| Swipe/rest selects the WezTerm or kitty tab of a herdr or tmux client | as macOS | `wezterm cli list` and `activate-pane`; kitty's `kitten @ focus-window --match pid:`, only with remote control on. |
| Tap: the pane inside its host | as macOS | None. |
| Tap: the window comes forward | X11, sway, Hyprland, KDE; GNOME Wayland with the extension (§ 2) | GNOME on Wayland lets no other program raise a window without a Shell extension; with it, by app class not window. Elsewhere the pane is chosen and the window stays where it is. |
| Tap: app links (Claude app, ChatGPT app, VS Code, Cursor tab) | where the app is installed and registers its link (§ 1.6) | The Claude and ChatGPT apps are beta/preview on Linux; a link with no app does nothing, as a Mac without the app. |
| Swipe/rest follows the app in front; scroll in front; the app filter | as macOS once the Device app runs on Linux (X11, sway, Hyprland) | The front app comes from the Device app on every OS (decision 4). GNOME and KDE on Wayland expose no front app to other programs: there these do not follow. |
| Swipe selects the tab in Terminal, iTerm2, Ghostty | not on Linux | AppleScript; Terminal and iTerm2 are macOS apps, and Ghostty's Linux build offers no tab API. |
| Pick an app on the dial brings it forward (`bring`) | through the raise (§ 2.1) | Same limits as the tap's raise. |

## Not in this work

- Windows: Diego's side.
- Terminal/iTerm2/Ghostty tab follow on Linux: Ghostty's Linux build offers no list/send/focus.
- A udev rule shipped by the installer.

## Testing

- Every behavior change gets a red-then-green unit test at its layer: the install script's autostart entry (in the
  install script's existing tests), the permission copy (a fake device
  node whose mode denies access, and a fake `/etc/group`), the seat check (a fake `loginctl`), `orca-ide` lookup (fake
  `PATH`), WezTerm `type` (fake `wezterm` recording its argv), the Linux link opener (fake `xdg-mime`/`xdg-open`).
- Contract tests with recorded data for every Linux tool part 2 calls: `wmctrl -lpx`, `swaymsg -t get_tree`,
  `hyprctl clients -j`, the KWin scripting calls and the GNOME extension's introspection, recorded from the real tools
  in containers (sway and Hyprland headless, KWin and GNOME Shell where they run headless; else from their published
  interfaces, marked so).
- Linux e2e where the binary installs on a runner (§ Verification).

## Verification

- **X11 raise:** an Ubuntu container or runner with Xvfb, openbox, wmctrl and two xterms; a fake agent in one;
  the tap raises its xterm (`_NET_ACTIVE_WINDOW` read back).
- **Wayland raise:** headless sway (`WLR_BACKENDS=headless`) with two foot terminals; the tap focuses the agent's
  (`swaymsg -t get_tree` read back). Hyprland has no live check: it does not start without a GPU, and runners and
  containers have none (`RECORDED_HYPRLAND`); contract tests only, against `hyprctl` run on a stand-in socket, with
  the replies' text taken from Hyprland's source and marked `published`.
- **GNOME and KDE:** contract tests against recorded calls and a fake session bus; no live check.
- **WezTerm typing:** `wezterm-mux-server` headless in a container; `type` lands the text in the pane
  (`wezterm cli get-text`).
- **herdr:** the nightly `cli-e2e` workflow runs `deviceHerdr` with the real binary (run by hand on the branch, lane
  from harness-pm).
- **Autostart:** `install.sh` in an Ubuntu container writes the entry under `$XDG_CONFIG_HOME` and under `~/.config`,
  keeps a `Hidden=true` one, and writes none on macOS; running the entry's `Exec=` twice at once leaves one master.
  Plus the one-owner tests (§ 1.1a).
- **Permission copy:** a fake `/dev` node without access through `HARNESSD_TEST_DIAL_PORT`; the status's `problem`
  carries the copy.
- **Zellij:** an e2e on the Ubuntu runner with a background session (typing lands, focus moves).
- **kitty:** an e2e under Xvfb with software GL, fontconfig and a font (§ 3.4).
- **The real dial on a Linux desktop:** a person with Linux and a dial (sent to harness-pm): plug in without the
  group, read the copy, fix, see it attach; tap an agent in each terminal they have and see its window come forward.

## Platforms

Linux (all of it). macOS: Zellij and kitty (part 3), WezTerm `type` (part 1) and the shared opener paths, unit-tested there and on CI's Linux; no
macOS behavior changes otherwise. Windows: no change.

## Changed in the final review

- The login entry has no `NoDisplay=true`: GNOME's Startup Applications hides such entries, and that is where the
  person turns it off. Linux follows macOS, where the item shows in Login Items. An older entry that has the line is
  still the installer's own (only `Exec=` is compared), so the next install rewrites it.
- The installer's guide line says `Harness starts when you log in to the desktop.`: a server login (SSH, a console)
  never runs the entry.
- A WezTerm, kitty or Zellij pane takes words only when its host made the agent's pseudo-terminal (§ 1.5), read from
  the process table, not from the hints: a terminal or an editor started from a pane kept its variables, and the words
  ran at that pane's shell. The tap takes the pane of that host first, and Zellij's client lookup asks the same.
- § 1.1a: a second master under another data folder does not fail to bind 18473; it stays up on another port. Its
  guard touches the core and is a separate follow-up.

## Design (docs/feature-design-rules.md)

Nothing new is stored, synced or exposed: the permission problem rides the dial's existing status; the raise backend
and the scheme lookups are in memory per process. Files written: the login autostart entry (§ 1.1), and KDE's
short-lived raise script (§ 2.3), deleted after each raise.
