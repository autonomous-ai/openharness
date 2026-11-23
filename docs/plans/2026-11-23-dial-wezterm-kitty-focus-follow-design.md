# The dial follows the focused pane in WezTerm and kitty

Date: 2026-11-23. Component: the CLI's devices process (`cli/src/services/devices.ts`, `cli/src/cable/hosts/`). The core
is not touched.

## Goal

The dial × app integration report of 2026-11-23 gives WezTerm and kitty ⚠️ on App → Dial: the dial moves to an agent
there only when a prompt is typed (the hook), not when the person focuses another pane or tab. Terminal, iTerm2 and
Ghostty follow a selected tab (#4331), Orca a focused pane (#4311), VS Code and Cursor a focused terminal (#4546).

Wanted: while WezTerm or kitty is in front and a dial is attached, focusing a pane, tab or window there that runs a
Claude Code or Codex agent turns the dial to that agent, with no typing. On every OS the app runs on: WezTerm on macOS,
Linux and Windows; kitty on macOS and Linux (kitty has no Windows build).

Done when: a person who switches WezTerm panes or tabs, or kitty windows or tabs, sees the dial turn to the agent there
within about a second of the app being settled in front; the dial's own tap there never pulls it back; nothing runs
while neither app is in front or no dial is attached.

Not in scope: tmux and herdr follow (another item, `feat/dial-tmux-herdr-apps`), so an agent in a multiplexer inside
WezTerm or kitty (a held pane, `Pane.held`) is not followed by focus here; Dial → App (a rest switching the WezTerm pane);
voice; the WezTerm and kitty tabs of an outer place (`wezterm-tab`, `kitty-tab`).

## What the apps offer (recorded 2026-11-23)

Read in disposable `ubuntu:24.04` arm64 containers (Docker on macOS), never the developer's WezTerm or kitty. Scripts and
raw output: the plan's first task records them as `cli/src/testing/recorded*.ts` values the specs use.

**WezTerm 20240203-110809-5046fc22** (its Ubuntu 22.04 arm64 `.deb`, GUI under Xvfb + openbox, `front_end = 'Software'`):
- No `wezterm cli` command subscribes to or waits for a focus change. The Lua event `window-focus-changed` needs the
  person's config: Harness does not edit `wezterm.lua`.
- `wezterm cli --no-auto-start list-clients --format json` lists the GUI itself as a client, with `focused_pane_id`: the
  pane keyboard input goes to. It changed with `activate-pane`, with a new tab or window, and with a tab switched by a key
  press in the GUI (`ctrl+Tab`). `split-pane` from the CLI left it as it was. Fields: `username`, `hostname`, `pid`,
  `connection_elapsed`, `idle_time`, `workspace`, `focused_pane_id`. 3 to 6 ms a call there.
- `list`'s `is_active` is a pane's place in its own tab only: it cannot say which tab or window has focus.
- A GUI started as people start it (no `--always-new-process`) publishes its socket (`x11-:99-org.wezfurlong.wezterm`
  under `$XDG_RUNTIME_DIR/wezterm/`), and `wezterm cli` with no `WEZTERM_UNIX_SOCKET` finds it, as the adapter's
  `activate-pane` already does. With no GUI, the call exits 1.

**kitty 0.32.2** (Ubuntu 24.04's package, under Xvfb):
- No remote-control command subscribes to focus. A watcher (`on_focus_change`) needs `watcher` in `kitty.conf` or a
  window launched with `--watcher`: Harness edits neither.
- `kitten @ ls` prints each window's environment (`env`), so it is never read (the adapter's rule since #4227).
- `kitten @ --to <socket> get-colors --match 'id:<n> and state:focused'` exits 0 when window `<n>` is the focused one and
  1 with `Error: No matching windows for expression: …` otherwise; its output is kitty's colour table, discarded. It
  followed `focus-window`, a new tab and a new OS window. 11 ms a call there. `state:active` is no use: it matches the
  active window of every tab.
- Each kitty process has its own focused window ("if no window is focused, the last focused window is matched"): with
  two kitty processes (two sockets) under openbox, window 1 of each matched `state:focused` whichever had the X focus.
  `state:focused_os_window` matched no window at all there, with or without `state:focused`, so it is not used.

## Design

### One read per app, in its adapter

A read answers a map: key, a place with a focus of its own (`'wezterm'` for WezTerm's GUI; the socket, `listenOn`, for
each kitty); value, the focused pane's `Pane.id` exactly as the adapter's `paneOf` builds it (`<n>` for WezTerm,
`<n>@<socket>` for kitty, without `held:`), or `null` when the focused pane is none of the agents'. `undefined` for a
read that failed. Each read has one deadline, `FOCUS_READ_MS` (2 s), for all its calls together; a call that would pass
it is not started.

- **WezTerm** (`cable/hosts/wezterm.ts`): `focusedPane()` runs `list-clients` once and answers the focused pane id of
  the client with the least `idle_time` (the one the person typed or clicked in last; only one client, the GUI, was
  recorded, so this choice for several is unrecorded). It is `undefined` when the call failed or its answer is out of
  form anywhere (not JSON, not an array, more than 16 clients, a `focused_pane_id` that is not a pane id, an
  `idle_time` that is not `{secs, nanos}` numbers). Only `focused_pane_id` and `idle_time` are read; `username`,
  `hostname` and `pid` are not. The same `weztermCli` as the verbs: the binary found once, asked again after a failure.
- **kitty** (`cable/hosts/kitty.ts`): `focusedWindows(panes: Pane[])` answers, per socket, which of the given agents'
  kitty panes on it is that kitty's focused window. Per socket: `get-colors --match 'id:<last> and state:focused'` for
  the pane found focused last there (the caller's order), then, unless that matched,
  `get-colors --match 'state:focused and (id:<a> or id:<b> …)'` for the rest; on exit 0 it narrows one id at a time.
  So a read is one call a socket while focus stays on an agent's window, and two while it stays on another window.
  `get-colors`' output, kitty's colour table, is discarded; only the exit code and, on exit 1, whether stderr is
  kitty's `No matching windows` are read. Any other answer (another exit code, another error, a timeout: a refused
  password, kitty gone) makes the read `undefined`. Only panes in form and on a socket of this account's (`ours`) are
  asked; at most 16 panes a read and 16 calls.

### The poll, in the devices process

A small unit, `cable/hosts/focusPoll.ts`, with its own spec: started with a read function, it reads, waits
`FOCUS_POLL_MS` (500 ms, the Terminal and iTerm2 tab poll's interval, #4331) after each read ends, and reads again until
stopped. One read at a time; an answer that lands after a stop is dropped. It reports each answer, counts reads and
failed reads, and stops itself after `FOCUS_FAILS_MAX` (3) failed reads in a row: a WezTerm whose GUI is gone would
otherwise be asked twice a second for as long as it is in front. The next settle of that app starts it again. A kitty
that refuses is kept by its adapter instead (Failures), so a kitty with only refused sockets answers an empty map, a
good read.

`services/devices.ts` runs at most one poll, for the app settled in front, while all of these hold:
- a dial is attached (`dialOn`);
- the settled app is `wezterm` or `kitty`;
- at least one live agent has a pane of that app's adapter the follow may use (below).

It checks these at that app's settle (the `appSettled` handler, as Orca's focus watch and the tab report do), at a
dial's attach, and at each change of the agents (`observed.onChange`: an agent started, gone, or its pane found its own);
it stops when they no longer hold (another app or `none` settles, the last dial goes, the last such agent goes) and when
the devices stop. A poll started at an agents' change, with the app already settled, takes its first answer as a settle
too: the person is looking at the pane the agent just started in.

**Which panes.** An agent's own pane (`observed.paneOf`, `byPane`), as everywhere: a multiplexer, terminal or editor in a
WezTerm pane or kitty window (a held pane) shows whatever is in front of it, and tmux's own follow is another item. On
Windows a WezTerm pane is the agent's own once #4566 reads the maker from the process tree (`wezterm-gui.exe` and
`wezterm-mux-server.exe` → `wezterm`); before it every pane there was held. This branch is rebased onto it, so the
follow has no Windows rule of its own (the orchestrator's decision 1, to take a held WezTerm pane on Windows, is not
needed). kitty has no Windows build.

### When a read moves the dial

Each answer is compared with the poll's last one. The candidates are:
- on the poll's first answer: every focused pane that is an agent's;
- after it: the focused panes whose place's entry changed since the last answer, that are an agent's.

The dial turns to the candidate's agent (cause `pane`, `cable.followLocal`) only when there is exactly one (two kittys
each with an agent focused cannot say which the person looks at, "Two kittys"), the app is still the latest in front
(`cableHost.latestFront()`: the settle of the app the person went to comes `FRONT_SETTLE_MS` after the switch), and:
- on the first answer, the dial did not move within `ATTACH_ECHO_MS` (2 s) before it, as Orca's settle and the Claude
  app's (a tap brought the app forward);
- after it, the dial made no move while the read ran (`dialMoves` as the read started), and it is not the echo of the
  dial's own tap on that pane within `TAB_ECHO_MS` (2 s): a `dialMovesTo()` noted by the WezTerm and kitty adapters'
  `focus`, wrapped as Orca's is before `noting()`.

A focused pane no agent runs in, a failed read, or an unchanged one moves nothing. With no dial linked
(`!cable.isConnected`, as after an attach before the dial's greeting) nothing is followed or counted, and the first
answer stays the first until one is read with a dial linked, so a dial attaching while WezTerm is settled still turns to
its focused agent. The prompt follow is unchanged: a prompt typed in a WezTerm or kitty pane still moves the dial (to
the agent the focus already showed).

### Two kittys

kitty on Linux starts a process per launch by default, each with its own socket (`listen_on` gets `-<pid>`), and each
has a focused window, which kitty cannot say is in the OS window with focus (recorded above). A kitty the person is not
in keeps its focused window, so the one whose focused window changed is the one they act in: a focus change moves the
dial. As kitty settles with agents focused in two kittys, nothing moves (no single candidate). Going from one kitty's OS
window to another's changes neither kitty's focused window, so it moves nothing either; the next focus change inside it
does. macOS's kitty.app is one process by default, so this is Linux's case.

### Failures, logs and measures

Each line is an outcome, never the app's pane id, window id, socket, title or the agent:
- `[device] pane · moved`, `[device] pane · skipped · no tile` (FOLLOWED's new `pane` cause; `FollowCause` gains it);
- `[device] pane · skipped · echo`, `[device] pane · skipped · unknown agent`, `[device] pane · skipped · not in front`;
- `[device] focus poll · started` and `[device] focus poll · stopped · <n> reads, <m> failed` (and `· failing` when it
  stopped itself), one each per poll, so a poll that only fails is seen. kitty with remote control off never starts
  one: its agents have no pane.
- `[device] kitty · focus refused`, once per refusal: a kitty socket whose `get-colors` call was refused or timed out
  (a password kitty may ask the person) answers that read `undefined` and is not asked again until that kitty restarts:
  a new socket identity (`<dev>:<ino>`) at its path, or, for Linux's abstract socket, a read with no pane on it any
  more. In memory only, at most 16 sockets; a daemon restart forgets them. So kitty asks the person once a start at most.

### Limits and cost

- One poll at most, only with its app settled in front, a dial attached and an agent there: zero calls otherwise.
- WezTerm: one `wezterm cli` process a read. kitty: one or two `kitten @` processes a socket a read while focus stays,
  at most 16 a read. Reads 500 ms apart after each ends, never overlapping, each within 2 s.
- The PR records, on this Mac and on Linux, the devices process's CPU over a minute with the poll running (the e2e's
  fakes in front, a dial attached) against the same minute with another app in front, beside the recorded call times.

### Same reach as the tap

The poll runs `wezterm cli` and `kitten @` as the tap does, so it reaches what the tap reaches and no more:
- WezTerm's GUI socket is found under `$XDG_RUNTIME_DIR` on Linux; a daemon started with no `XDG_RUNTIME_DIR` in its
  environment finds none, for the tap as for the poll (the poll then stops itself after 3 failed reads). Not changed
  here; the final report proposes it.
- A WezTerm pane of a mux domain (`wezterm connect`) is numbered by the mux server, while `list-clients` on the GUI
  answers the GUI's own: not covered, as the tap's `activate-pane` is not.

## Data

Nothing is stored, synced or exposed. The poll keeps in memory only its last answer (pane ids) and the dial's recent
taps, both dropped when it stops; the kitty adapter keeps its refused sockets' names and identities until the daemon
stops. It reads `focused_pane_id` and `idle_time` of WezTerm's clients and kitty's exit codes;
no title, cwd, text or environment. Nothing leaves the computer; the log lines carry no identifiers.

## Platforms

- WezTerm: macOS, Linux (X11; on Wayland where the front app is known), Windows (with #4566). `wezterm cli` is the same
  on each.
- kitty: macOS and Linux. Remote control on (its `allow_remote_control` and `listen_on`), as the existing tap and words
  already need.
- GNOME or KDE on Wayland tells no front app, so nothing settles and no poll runs there, as for the other follows.

## Testing

- Recorded values first, each with how it was made (scripts as in the spike): `RECORDED_WEZTERM.listClients` (the GUI's
  `list-clients` before and after a focus change, and with no GUI) and `RECORDED_KITTY.focusedMatch` (exit codes and
  stderr of `get-colors --match` for a single id, the `or` form with parentheses, no match, and kitty started with
  `allow_remote_control password` and no password given: whether it refuses at once or asks the person; a prompt is
  accepted, shown once a kitty start).
- Red-then-green unit specs: `wezterm.spec.ts` (`focusedPane`, the form checks), `kitty.spec.ts` (`focusedWindows`: the
  order, the `or` match, the narrowing, the bounds, the deadline, `ours`, a refusal or timeout not asked again, asked
  again at a new socket identity or an abstract socket's return, other sockets still asked, the line once), `focusPoll.spec.ts` (interval, no
  overlap, a stop drops a late answer, counts, stops itself after 3 failures), `devices.spec.ts` (start and stop
  conditions including an agents' change, the first answer as settle with its echo and kept
  until a dial is linked, a change follows, two candidates move nothing, not latest in front, the tap echo, a dial move
  during a read, unknown agent). `npm run test:core` keeps `src/services` at 100%.
- End to end with fakes (`cli/e2e/dialPaneFocusFollow.e2e.ts`): the isolated daemon; the fake engine hooked with only
  WezTerm's or kitty's variables, its caller on a pty whose maker is named `wezterm-gui` or `kitty`
  (`e2e/harness/orcaHost.ts`'s `orcaTerminal(..., { name })`, without Orca's variables), so its pane is its own; a real
  listening unix socket of the test's at a short path for `KITTY_LISTEN_ON`; a fake `wezterm` and a fake `kitten` on the
  daemon's PATH that answer `list-clients` and `get-colors --match` from a file the test writes, in the recorded forms,
  the fake `wezterm` also moving its focus on `activate-pane`, and each counting its calls; the front told on
  `harness hardware watch`'s stdin as `dialOrcaFocus.e2e.ts` does. It checks: the settle follows the focused agent; a
  focus change moves the dial; the dial's tap on another agent is not pulled back; another app in front stops the calls.
  Runs on macOS and Linux locally and in PR CI's e2e.
