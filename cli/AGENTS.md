# The Harness CLI and daemon (harnessd)

Read this before changing anything under `cli/`. The repository-wide process rules (validation,
merging, releases) are in [../AGENTS.md](../AGENTS.md). The design, and why, is in
[../docs/design/2026-10-03-harnessd.md](../docs/design/2026-10-03-harnessd.md). The one-page picture
for new contributors is [../docs/design/2026-10-04-harnessd-before-after.md](../docs/design/2026-10-04-harnessd-before-after.md).

## The shape: master, core, services

```
MASTER   src/harnessd/     supervises: starts, watches, restarts. No feature code, no network.
CORE     src/core/         owns sessions: agents, terminals, transcripts, turns, input, questions.
                           Small and secure. Must never go down. Grows only for what every session needs.
SERVICES src/services/     everything else, each in a process of its own: search, viewers, models, …
                           and new features. Reaches the core only through core/api.ts; can fail without the core.
```

### Protect the core

The core is the one process every agent depends on, and the most trusted: it types into every terminal. It stays
small and secure, in the code and at run time, and everything else is a component in a process of its own
(anh Dee, 2026-11-12). Each of those components is an experiment, tested every day, that can be switched off or
deleted at any time: "small tiny core that is super stable and solid and a lot of components around it" (anh Dee,
2026-11-13). So nothing in the core depends on one, and deleting one changes nothing in the core. An experiment never
touches the core: "experimental feature should never touch core. it should be in its own sub component and process when
we turn on" (anh Dee, 2026-11-13); build each as if it will be shut down. What still breaks these rules, and the order
it is fixed in, is in [the audit](../docs/design/2026-11-12-core-audit.md): that list only shrinks.

1. **The core is a process, not a folder.** Everything `src/core/main.ts` imports runs in it, wherever the file
   lives: `core/`, `lib/`, `engines/`, a component's door. `src/architecture.spec.ts` walks those imports.
2. **Every other component runs in a process of its own,** from its first pull request (`SERVICE_HOSTS`): a light
   one in the edge host, a risky one alone. A service inside the core's process (`HARNESSD_SERVICES=none`) is for
   debugging, never where a feature lives. The one exception is Harness OS, which runs the core with no master
   and every service inside it (`HARNESS_NO_MASTER=1`), until its decision in the audit: that path stays tested.
3. **The core loads no component's code.** What it needs of one is typed in `src/core/api.ts`. Code a component
   must run inside the core comes through a door of its own, loaded only while the component is on, which
   `src/architecture.spec.ts` holds to its files.
4. **The core meets the outside least.** It listens only on this computer and calls no other host: the gateway renews
   the sign-in, and the core asks it to (`src/architecture.spec.ts` reads every file of the core's process and lists what can open a connection, each on
   this computer). Whatever someone other than this computer's owner can shape (a relay or backend frame,
   another account's message, GitHub text, a web page, a device, a third-party harness) is parsed and checked in
   the component that faces it, and reaches the core as typed, bounded data. No process of the daemon, and no hook,
   reads another process's environment, by any means (`/proc/<pid>/environ`, `ps e`, `KERN_PROCARGS2`,
   `tmux show-environment`): a hook reads its own and says only what it derives (`src/architecture.environment.spec.ts`).
   Nor is the daemon handed the environment of whatever started it: on macOS and Linux `harness start` passes an
   allowlist ([the daemon's environment](../docs/cli.md#the-daemons-environment), `src/lib/startEnvironment.ts`), and
   `src/architecture.startEnvironment.spec.ts` holds every variable the daemon reads to it.
   One reader is left, a listed follow-up: the macOS helper `native/darwin-process-images.c` hashes `KERN_PROCARGS2`,
   environment included.
5. **The core lends its authority narrowly.** It runs no command line a component hands it, and signs a backend
   call for a component only on a route that component declared (`MESSAGES_BACKEND_ROUTES`,
   `EXPERIMENT_BACKEND_ROUTES`).
6. **Adding to the core's process is a decision.** Every file it loads is a line of
   `src/architecture.coreFiles.txt`, and the test fails on one more. A pull request that adds a line says why
   every session needs the file; one that takes a file out deletes its line.
7. **The core grows nothing for a component.** A component works through what the core offers every client
   and service: the local API the apps use (a component's process may open it as this computer's owner's tool,
   `agentClient/daemon.ts`) and `CoreApi`. Where that is not enough, the component does it in its own process,
   or does without. No rule, list, record or mechanism goes into the core for one component, not even a generic
   one only it would use: build it as if the component will be deleted, and nothing in the core is left to take
   out.

### The processes

The master runs the core and every service process (`SERVICE_HOSTS` in `src/harnessd/services.ts`). Each
service process runs one or more services, each on its own link to the core. In Activity Monitor, `top` and
`ps -c` they show as `harnessd`, `harnessd-core` and `harnessd-<process>` (`src/harnessd/processName.ts`).

| Process | Runs | Started |
|---|---|---|
| master | supervision only (`src/harnessd/`) | by `harness start`, `harness start -f`, or launchd or systemd after `harness service install`; on Windows through `harness-launch.exe`, and by Task Scheduler's `harness start --if-down` after `harness service install` |
| core | sessions (`src/core/`) | always |
| engine-claude, engine-codex | history, last-turn readers, live transcript parsers, runtime profiles/catalogs, screen interpretation, submission verification readings, model control, question navigation, and (Codex) the shared app-server connection | on demand: an attach or read for that engine |
| engine-others | the other fourteen engines' history and last turns, from their transcripts and stores, and Amp's thread export (`src/engines/others/`); their live parsing still runs in the core | on demand: a read for one of them |
| search | session search | always |
| viewers | the harness viewers, their remote streams and rendered surfaces, and the Store | on demand: a harness here (an agent with a DSH at start, or attached since), a Store or viewers request (the list, an install, a harness's create or restore, a client's viewer stream or rendered frame, the home bridge's while a harness waits to be set up again), or at start when the release's own harnesses are to be put in place or an earlier process left viewer servers running |
| edge | the shell service, workspaces, usage, the monitor, the project readers, the change-agent handoff, the recaps, the agent cleanup, Agent Messages (which runs no timer while it is off or the computer is signed out), shared machines (sharing this machine with other accounts, and pinning the machines shared with this one), Hachi's goals (`harness goal`), Hachi's wakes and its off path (which hold no line and ask nothing while Hachi is off), the probe of which engines this machine has (the New dialog's), the home bridge on Linux, which keeps what a link cannot give in `~/.harness` after Harness's folder moved to the XDG folders and removes it once no process started before the move is left and every harness is set up again, which it asks the Store for (a look at `/proc` at each core connection and every 10 minutes on one timer, only while `bridge.json` exists) | always |
| gateway | the relay and its E2EE (`src/gateway/`) | on demand: as the core starts when signed in or anything is paired here, or when something needs it (a pairing, a window's E2EE request, a key command, the Wi-Fi device) |
| models | grid, local models, the Model Manager | on demand: once grid is in use here (a managed grid, saved grid pictures, local models), or on a models request |
| updater | checks, downloads and stages a new build (`src/services/updaterProcess.ts`) | by the master, for the installed copy only |
| devices | the dials, the window bridges, the fleet, the voice router, the Wi-Fi device, the agents outside a pane (from their hooks, `cable/hosts/observed.ts`), Orca's account homes, read from `orca account list --json` at the service's start and at a scan once 5 minutes old, kept in memory (`devices/orcaHomes.ts`), which join the open scan's places and the dial skill's homes (`cable/hosts/observedPlaces.ts`), herdr's agents, listed and followed over herdr's own socket while a dial is attached (`cable/hosts/herdrSource.ts`, `herdrClient.ts`), Herdr's agents (the Herdr app over Herdr Core), listed and followed over Herdr Core's socket while a dial is attached, on macOS (`cable/hosts/hcSource.ts`, `hcClient.ts`), and switched to by `herdr-app` (`cable/hosts/herdrApp.ts`), cmux's agents, listed from `cmux sessions list` when a store in `~/.cmuxterm` changes, while a dial is attached, on macOS (`cable/hosts/cmuxSource.ts`, `cmuxCli.ts`), and opened and spoken to by `cmux` (`cable/hosts/cmuxApp.ts`), opencode's sessions, listed and followed over opencode's local server while a dial is attached, found through its `service.json` (`cable/hosts/opencodeSource.ts`, `opencodeClient.ts`), the Claude app's Code sessions, with or without a process, listed from the app's own store (`~/Library/Application Support/Claude/claude-code-sessions`, read only, six fields of each file) when a file there changes, while a dial is attached, on macOS (`cable/hosts/claudeAppSource.ts`, `claudeAppStore.ts`), and opened by the Claude app's link (`cable/hosts/claudeApp.ts`), the ChatGPT app's Codex threads, with or without a process, listed from the app's own metadata (`~/.codex/state_5.sqlite`, table `threads`, five columns of its own threads not archived, read only on a connection opened and closed at each read, and `.codex-global-state.json`'s project order and project of each thread, and Codex's own thread names from `~/.codex/session_index.jsonl`) when one of them changes, watched on the Codex home alone, at most one read a second, at most 16 listed, while a dial is attached, on macOS, with the ChatGPT app installed (`ChatGPT.app` of bundle id `com.openai.codex` in `/Applications` or `~/Applications`, looked for at each attach), in the app's sidebar order as the ChatGPT page's rank (`cable/hosts/codexAppSource.ts`, `codexAppThreads.ts`), and opened by the ChatGPT app's link (`cable/hosts/codexApp.ts`), each app they run in one adapter (`cable/hosts/adapter.ts`), their waiting prompts and voice (a Codex session in Harness's own Codex home takes it in every state through `codex queue`, which the process runs itself: the ChatGPT app's own Codex CLI for a session in that app on macOS, else the `codex` a launch would run, under the person's login-shell environment, read once at the first Codex session it is asked about: `cable/hosts/codexQueue.ts`), which app the dial shows and, with a window open, whether it holds the window's tab or that app, and the agent it shows (`dialShows`), the app in front, each outside agent's tty, the latest tab report, the selects of the last 2 s, the pane focused in Orca, its own Orca switches of the last 2 s, Orca's tab order, its tab titles and the terminals of the worktree on Orca's screen (in memory); a Claude app session or ChatGPT app thread with no process shows on its app's page only, never in the single ring of a dial that does not say `appFilter`; the dial follows a prompt the person submits in the app in front and the session the Claude app shows, and a swipe switches Orca's pane or, while the Claude app is in front, shows the session there, or, while Herdr is in front, switches Herdr's terminal; a stroke on the dial scrolls Herdr's view of the shown agent's terminal, line by line, while Herdr is in front and its window shows that terminal's tab on screen (one `herdr-app status` a stroke, whose `tab` is matched with the terminal's `herdr.tab` label in Herdr Core, then `herdr-app do terminal.scroll`, one run at a time per terminal and one every 50 ms at most, 2 s each: `cable/hosts/herdrApp.ts`, `scrollLines.ts`), or, for a Claude Code terminal, which draws on the alternate screen, presses its own `pageup`/`pagedown` through Herdr Core's `terminal.keys`, one per 8 lines, one a call every 100 ms at most, and none while it asks, and goes nowhere otherwise: Harness's windows take a stroke only while the dial holds the window's tab or shows a Harness agent; the stroke under way and what it did while `status` answers (in memory); Orca's ring is in Orca's tab order and its agents are named by their tabs, read from `orca terminal list --include-visual-layouts` at each change of its members, only while a dial is attached, and where Orca's CLI has `watch-focus`, one `orca terminal watch-focus` child runs from Orca's settle in front until no dial is attached and the dial follows the pane focused in Orca (`cable/hosts/orca.ts`); a tap opens a Codex app session by `codex://threads/<id>`, and a rest does while the Codex app is in front, as the Claude app's link (`cable/hosts/codexApp.ts`); a tap opens a Claude Code session in VS Code's extension tab by `vscode://anthropic.claude-code/open?session=<id>`, and a rest does while VS Code is in front (`cable/hosts/vscode.ts`); the three apps open by link through `cable/hosts/appLink.ts`; on macOS a swipe selects the agent's tab in Terminal, iTerm2 or Ghostty, and selecting a tab there moves the dial; an agent in a tmux pane the person opened is on the page of the app that holds the tmux client used last on that pane's session, learned from `tmux list-clients` and that client's parents, at most one lookup a pane and agent process every 5 s, kept in memory, and its tab is that client's tty, run with the tmux the core runs, found as the core finds it (`lib/tmuxOnPath.ts`, the person's login shell asked at the first tmux call, and again only once a tmux is where the core looks without one) (`cable/hosts/tmux.ts`): a swipe or a rest while that app is in front selects that tab, then the agent's tmux window and pane, and a tap selects them before the app comes; an agent in a pane of the person's default herdr session is on the page of the app that holds the herdr client used last (its tty's access time) of the herdr server in the agent's parents, learned from `ps`, `lsof -U` of herdr's own processes (at most 16 besides the server) and that client's parents, at most one lookup a pane and agent process every 5 s, kept in memory, on macOS, and its tab is that client's tty (`cable/hosts/herdrOuter.ts`); herdr's lookup is asked before tmux's (`cable/hosts/outer.ts`): a swipe or a rest while that app is in front selects that tab, then the agent's herdr pane (`herdr agent focus`), and a tap focuses the pane before the app comes; their own local listener (`services/devicesListener.ts`), a private socket open only while the process runs, which the core neither opens nor knows, whose `dial` stream tells Orca's Harness Device plugin (`plugins/harness-device-orca`) whether a dial is attached and the agent it shows, and the plugin tells them those terminals (`orcaFront`) while it holds that stream; while Orca is settled in front, Orca's ring for a dial that says `appFilter` is that worktree's agents; Claude Code and Codex in VS Code's integrated terminal, matched to their terminal by the process tree from the shells each VS Code window reports through Harness's own extension (`plugins/harness-device-vscode`) on the listener's `vscode` stream, one per window and at most 8 (`cable/hosts/vscodeTerminals.ts`): a tap shows the terminal and brings VS Code forward (on VS Code 1.128 or later, the window that holds it), a rest shows it while VS Code is in front, and the dial's scroll scrolls that terminal, line by line, while VS Code is in front and the dial shows such an agent; for Claude Code whose settings say `"tui": "fullscreen"` (that key alone, of its managed, project-local, project and user settings files, the user file in the session's own Claude Code home as its transcript path names it, each read up to 256 KiB at a stroke's start: `cable/hosts/claudeRenderer.ts`), that is its terminal's foreground program (its group is the foreground group of the shell VS Code started in that terminal, one `ps -o pid=,pgid=,tpgid= -p <agent>,<shell>` read a stroke; both waited for at most 500 ms) and is not waiting on the person, the extension also presses PageUp or PageDown there, one key per 8 lines, which moves Claude Code's fullscreen view; Claude Code, Codex and cursor-agent in Cursor's integrated terminal, on the same `vscode` stream from Harness's extension in Cursor's windows (one pool of at most 8 windows for both editors): as in VS Code, a tap shows the terminal and brings Cursor forward, and a rest and the dial's scroll follow it while Cursor is in front, on macOS; a tap opens a Claude Code session in Cursor's extension tab by `cursor://anthropic.claude-code/open?session=<id>` (`cable/hosts/vscode.ts`); a tap on any other agent in Cursor opens Cursor's window for its folder, `open -b com.todesktop.230313mzl4w4u92 <folder>`, the folder checked absolute, at most 4096 characters, with no control character and a folder now, on macOS (`cable/hosts/cursorFolder.ts`); each window's latest state and one parent chain an agent (in memory); an agent's notice (`harness device notify`), shown as a question the dial only shows, at most 20 pending, which goes when that agent's next turn starts, the person taps "In <app>" or its agent leaves, the pending ones kept in `dial-notices.json` (`cable/noticeFile.ts`) and back after the process restarts as drawer rows that do not ring again and open to their line, none older than 24 hours, and the Notifications setting, All or Needs you, kept in `dial-notify.json`; from the first dial attached on this computer, the dial skill in each Claude Code and Codex home and Claude Code's `harness-device` plugin and, once that is set up and while it is on in the default home, the plugin turned on in each Orca account's Claude Code home (`claude plugin enable`), each home once (`cable/dialSetup.ts`), recorded in `dial-setup.json`: the process runs `claude plugin` itself, which fetches from GitHub, each call up to 60 s, to install the plugin once a computer and bring it current after each CLI update, and what `disable` marked removed in `dial-skill.json` stays removed; Harness's VS Code extension, set up once a computer through VS Code's own `code --install-extension`, up to 60 s, at the process's start, at each attach and an hour after a failed pass (`cable/vscodeExtensionSetup.ts`): installed once a dial has attached here and VS Code is there, brought current after each CLI update, recorded in `dial-setup.json`, and never installed again once the person uninstalled it in VS Code or `harness device vscode disable` marked it removed in `dial-skill.json`; Harness's extension set up in Cursor as in VS Code, through Cursor's own `cursor --install-extension`, recorded under `cursor` in `dial-setup.json`, and never installed again once `harness device cursor disable` marked it removed in `dial-skill.json`; Harness Device's plugin for Orca (`plugins/harness-device-orca`), set up as the extension is, at the process's start, at each attach, when Orca settles in front and an hour after a failed pass (`cable/orcaPluginSetup.ts`, `devices/orcaPlugin.ts`): installed once a dial has attached here and Orca runs, through Orca's own `orca plugin install`, `update` or `enable`, up to 60 s each, approved with `--approve` only when everything Orca lists is the pinned access (a trusted worker, `workspace:read`, its panel, its status bar item and `workspace.changed`) and held otherwise, recorded under `orca` or `orcaHeld` in `dial-setup.json`, brought current after each CLI update, and never installed again once the person removed it in Orca or `harness device orca disable` marked it removed in `dial-skill.json`; an agent in a Zellij pane is placed as one in tmux is, on the page of the app holding the one Zellij client that shows its session, read from the process table only when the session and the machine each have exactly one client (`cable/hosts/zellij.ts` `zellijClients`, beside tmux's in `createOuter`); Zellij's panes, on macOS and Linux, focused by `zellij --session <s> action focus-pane-id` and typed into by `write-chars` then `send-keys Enter` once `list-panes --json` shows the pane a terminal whose program has not exited, with `zellij` found as the core finds tmux (`zellijFinder`), and Zellij's focus not followed (`cable/hosts/zellij.ts`); kitty's windows with remote control on, on macOS and Linux, focused by `kitten @ --to <socket> focus-window` and typed into by `send-text`, then Enter as `send-text` `\r` to the same window (`send-key` goes to the active one), with `kitten` found as the core finds tmux, else `kitty @` (`kittyFinder`), a socket at a path spoken to only when it is this account's and Linux's abstract socket, which has no owner to read, given a tap alone, and `[device] kitty · remote control off` logged once a process start for a kitty session with no socket (`cable/hosts/kitty.ts`); WezTerm's panes typed into by `wezterm cli send-text --no-paste`, then Enter on its own (`cable/hosts/wezterm.ts`); on Linux a dial this account may not open refused before `stty`, its row saying which group to join or to log out and in, logged once a change (`cable/portAccess.ts`), the dial kept only by the account whose session is active on seat0, asked of logind by `loginctl`, read at most every 8 s (`cable/usbConsoleUser.ts`), the app links opened by `xdg-open` once `xdg-mime` names an app for their scheme, read once a scheme a process start and again after a failed open (`cable/hosts/appLink.ts`), and a tap's or a pick's window brought forward by the raise (`cable/hosts/linuxRaise.ts`, `linuxDesktop.ts`): the desktop found from this login's own variables and its sockets in `$XDG_RUNTIME_DIR` (sway, Hyprland, KWin, GNOME Shell with the Activate Window By Title extension, else X11 with `wmctrl`), once a process start and again after a failed raise, kept in memory and named once in the log (`[device] raise · <desktop>`), then the window of the agent's process or of its nearest parent that owns one (a tmux or Zellij agent's from its client's), else its app's by class (`frontApp.ts` `windowClasses`), through `swaymsg`, `hyprctl`, `dbus-send` (KWin), `gdbus` (GNOME) or `wmctrl`, each with no shell and the run timeout; KDE's raise writes a short-lived script to `$XDG_RUNTIME_DIR/harness/` (folder 0700, file 0600), which KWin loads, runs and unloads, and which is deleted after each raise (`cable/hosts/linuxRaiseKwin.ts`); on Windows the dial's port through `harness-serial.exe` (`cable/windowsSerial.ts`) | on demand: once there is a device; on Windows, starts unconditionally with the core when inline, or is requested once at startup by `core/devicesWake.ts` when out of process and cable support is enabled |
| orchestrator, sharing, memory, router, cloud (cloud agents) | the experiments | on demand: on a request, or saved state at start |
| agentBrowser | the agent browser: Podman, its setup, one container per agent whose Browser is on, and the viewers' streams of each browser's screen (`src/services/agentBrowser.ts`) | on demand: an agent whose Browser is on, a request, or its state file at start |

`HARNESSD_SERVICES` names a subset to run in their own processes, by service or by process.
`HARNESSD_SERVICES=none` runs every service in the core's process, for debugging or a quick way back. How
to add a service, and how to make one start on demand, is in [src/services/AGENTS.md](src/services/AGENTS.md).

`src/core/main.ts` `runForeground()` is the composition root: it creates the modules and wires them
together. It is the core's own entry (`harness __run`), which the master starts; `src/cli.ts` is the CLI,
and calls in for `__run`. `harness start -f` runs the master in the foreground, as launchd and systemd do.
The updater is the master's, in a process of its own (`src/services/updaterProcess.ts`): the core never
downloads a build. When it stages one, the master has the core hand over (`harnessd:update`) and judges the
new build. A core with no master gets no updates: one an older release's own handoff started hands itself
to a master once that release has gone, and one `HARNESS_NO_MASTER=1` asked for runs as it is
(`src/core/updateHandoff.ts`). A core under a master too old to run the updater starts it beside itself, in
its own process (`src/core/updaterBeside.ts`). `src/backendSocket.ts` is the transport: it receives frames and dispatches
them.
`src/gateway/` is the relay: the backend link, the E2EE sessions and keys, and every rule about what a
remote client may send and how what it is sent is sealed. It runs in a process of its own
(`src/gateway/gatewayProcess.ts`; the core's side is `src/core/gatewayLink.ts`), or in the core's with
`HARNESSD_SERVICES=none` (`src/gateway/start.ts`). The socket speaks to it in the clear through
`GatewayPort` and hears it through `GatewayEvents` (`src/core/api.ts`), and never holds a key. The
gateway also holds the other sockets that sign in to the backend for this machine's sake: the windows'
sessions to the owner's other machines, the Share relay for a harness shared with this account
(`WindowRelay`), and the fleet's lane's E2EE sessions, which the lane asks it to seal and open through
`core.account.lane` (`src/gateway/lane.ts`).

## Where new code goes

| You are adding | Put it in | Not in |
|---|---|---|
| A new feature (anything a session can run without) | a new service, `src/services/<name>.ts`, in a process of its own | the core, `core/main.ts`, `backendSocket.ts`, or a `lib/` file the core imports |
| A request the apps send to a feature | the service's start returns its handler ([src/services/AGENTS.md](src/services/AGENTS.md)) | a case in `backendSocket.ts`, a slot on `BackendSocket` |
| Behaviour of agents, terminals, transcripts, turns, input or questions | the module under `src/core/` that owns it | `core/main.ts` |
| Support for an engine (Claude Code, Codex, …) | `src/engines/<engine>/` | the core |
| A pure helper with no daemon state | `src/lib/` | the core |
| Supervision of processes | `src/harnessd/` | anywhere else |

## Rules

1. **No logic in `runForeground` or the `backendSocket.ts` request switch.** Wiring and dispatch only:
   a handler there is one call into a module or service. Review changes for that responsibility.
   `src/architecture.spec.ts` enforces import boundaries and walks the imports from `src/core/main.ts`:
   no file from an edge folder (a service, the dial, the relay, …) but those it lists, each with the
   reason and the step that ends it, and no file at all but those in `src/architecture.coreFiles.txt`.
   New exceptions need a separate architecture review; remove an
   exception as soon as it is no longer reached. Source line counts are informational, never a merge
   gate or a proxy for runtime cost
   ([../docs/design/2026-10-06-core-boundary-next.md](../docs/design/2026-10-06-core-boundary-next.md)).
2. **A feature is a service, in a process of its own.** It runs against `CoreApi` and is reached through a port
   in `CorePorts`, both in `src/core/api.ts`. A service never imports core modules, the registry, `cli.ts` or
   `backendSocket.ts` (`src/architecture.spec.ts` checks it). See [src/services/AGENTS.md](src/services/AGENTS.md).
3. **The core does not wait on a service and does not crash with one.** Services start through
   `serviceHost.start()`; every port declares fallbacks beside it in `core/api.ts`.
4. **100% coverage, per file,** for `src/core/`, `src/services/` (`npm run test:core`) and `src/harnessd/`
   (`npm run test:harnessd`). PR CI does not run these gates: run them locally when you change those
   files and record the result in the PR. Write the test that fails without your change. The one
   file outside it is `src/core/main.ts`, the wiring, which the end-to-end suite runs.
5. **End to end for every user-facing flow** (`npm run test:e2e`, `e2e/`): the real daemon, a private
   tmux server and fake Claude Code and Codex engines (`e2e/harness/fakeEngine.mjs`). Prefer extending
   the fake engine faithfully over loosening a test.
6. **Never test against the developer's own machine.** Tests use a throwaway home and data folder:
   never the real `~/.claude`, `~/.codex`, daemon (port 18473) or tmux server. In tmux tests unset
   `TMUX` and `TMUX_PANE`, and point `TMUX_TMPDIR` at a folder that exists (`src/testing/isolatedTmux.ts`).
7. **Comments say why, in plain sentences.** Name the incident or the measurement that made the code
   the way it is; that history is what keeps the next change from undoing it.
8. **Measure runtime cost with the workload it affects.** For changes to startup, the input path or
   recurring work, compare CPU, memory and latency on the same workload and toolchain against a
   recorded baseline. `e2e/perf.e2e.ts` provides an opt-in workload and JSON measurements; these are not
   an automatic performance gate. Keep failure-isolation and deadline tests mandatory. A new numerical
   performance limit needs measured evidence, not a source-size estimate.
9. **State files are written whole and read through one reader.** Write them with `atomicWriteFile` /
   `atomicWriteJson` and read them with `readState`, all in `src/lib/secureState.ts`; never `writeFile` in
   place. `src/lib/stateWrites.guard.spec.ts` lists the modules that own a state file and fails on a write in
   place there; a write that is not a state file says so on its line: `// not a state file: <why>`.

## Commands

```bash
npm run typecheck        # tsc
npm test                 # the unit suite
npm run test:core        # src/core and src/services at 100%
npm run test:harnessd    # src/harnessd at 100%
npm run test:e2e         # the real daemon, end to end
```
