# A Claude Code session in the person's tmux shows on the page of the terminal app that holds the tmux client

## Intent

Diego (2026-11-19, CLI 0.6.71, firmware 0.1.4): Claude Code started in a tmux session inside Terminal.app does not
show on the dial; the same session started in Terminal without tmux does. An agent in a tmux pane must show on the page
of the app the person sees it in (Terminal, iTerm2, Ghostty, Orca, …), and the dial's tap and swipe must reach it there.

## Root cause (diagnosed read-only, reported to the PM)

- The daemon log line `[agent] 0db66f66 attached · terminal=tmux:%0` is a Harness agent created on 2026-11-17 (`create
  pane open`, named "Math"), not Diego's session. Diego's session runs in a tmux session he opened, so its hook goes to
  the devices process on the observed route (`hook/notify.mjs` `ownPane`): the core keeps nothing of it, as designed.
- Inside a tmux pane, tmux sets `TERM_PROGRAM=tmux` (checked on tmux 3.6b with a private server). The pane's
  `__CFBundleIdentifier` is whatever the tmux **server** inherited when it started. On Diego's Mac the default server was
  started by the daemon (it created pane %0 on 2026-11-17), so the pane has no bundle id. `detectApp` then answers
  `tmux`: the agent sits on a "tmux" page, while the dial follows the app in front (Terminal), whose page is empty. A tap
  brings no app forward either: `bundleOf('tmux', …)` has no bundle.
- When the server did start from a terminal app, the bundle id names that app, which may not be the one the person
  attaches from now, and the tty read for the agent is the tmux pane's pty, which no Terminal tab holds; the tabs
  adapter also refuses any agent whose host is not its app (`tabs.ts` `paneOf`).

## Goals

1. An agent in a tmux pane the person opened shows on the page of the app that holds the tmux client attached to that
   pane's session: one row, never a second "tmux" row.
2. A tap selects the agent's tmux window and pane on the session the found client shows, brings that app forward and
   selects the client's tab (Terminal, iTerm2, Ghostty); with no client found, today's `switch-client` (`tmux.ts`).
3. A swipe or a rest, while that app is in front, selects the client's tab and then the agent's tmux window and pane
   (`select-window` and `select-pane` on the pane's own session, never `switch-client`). While the app is not in front,
   a swipe or rest changes nothing in tmux.
4. Selecting that tab in the terminal app turns the dial to the agent (the existing `byTab`, by the client's tty).

## Non-goals

- Voice and scroll for an agent in tmux: unchanged.
- The dial following the person's own tmux window changes inside one tab.
- Zellij and kitty (Ken's `feat/dial-linux`).
- tmux servers other than the daemon's (`-L`, `-S`): as today, a pane there is not proven and stays on the "tmux" page.

## Anti-goals

- Nothing in the daemon core, the hook or the observed route's body (`cli/AGENTS.md` rule 7). No new hint.
- No reading of another process's environment (`tmux show-environment` included).
- No `switch-client` on a swipe; no command on a session Harness made.

## Constraints

- Devices process only (`cli/src/cable/hosts/`, wiring in `cli/src/services/devices.ts`).
- Every value from tmux is outside text: the client's pid is checked against the pid form, its tty against `TAB_TTY`,
  the session name is read only for the Harness-session check and never logged or used as a target; tmux runs with no
  shell, every value one argument.
- Logs carry counts and fixed words only (#4458).
- Harness paths only through `cli/src/config/harnessHome.ts` (none are needed).
- Branch `fix/dial-claude-app-idle-sessions` (in review) also touches `observed.ts`, `select.ts`, `appFilter.ts`,
  `cableHost.ts`, `devices.ts`: rebase on `main` when it merges, keeping both sides.

## Approaches

1. **Learn the outer app from the tmux client (chosen).** In the devices process, ask the daemon's tmux which client
   shows the pane's session, walk that client process's parents to its app as the open scan already does
   (`scannedApp.ts`), and take the client's tty as the tab. Works whoever started the tmux server, and follows a
   re-attach from another terminal.
2. Have the hook send the client's tty or app. Rejected: changes the hook and the core's observed body (core rule 7).
3. Trust `__CFBundleIdentifier` inside tmux. Rejected: it names the app that started the server, which is absent on
   Diego's Mac and wrong after a re-attach from another app.

## Design (decided)

`observed.ts` and `open.ts` hold no rule about any app (`cli/src/services/AGENTS.md`): every tmux rule below lives in
`tmux.ts`, and `observed.ts` only takes a generic answer from a dep, as it takes `apps` and `tty` today.

### The outer place of a nested agent (`tmux.ts`, wired in `devices.ts`)

`tmux.ts` exports one lookup beside the adapter, sharing its constants and checks, given an event's hints and its
caller's pid:

- Not tmux (no `TMUX_PANE` in the hints, or one out of form): it answers `undefined` at once, runs nothing, and the
  agent is placed exactly as today.
- tmux: it answers a promise of `{ app?, tty? }`, and never rejects:
  1. `tmux display-message -p -t %N` with the adapter's `TMUX_PANE_FACTS`: a pane with a daemon's tag or in a session
     Harness named is not the person's, so `{}`;
  2. one process-table read (`TmuxDeps.processes`, widened to the full row with `executable`): the pane's process must
     be the caller or one of its parents (`parentChain`), as `focus` checks; otherwise `{}` (a pane of the same id on
     another server is no proof);
  3. `tmux list-clients -t %N -F '#{client_activity}|#{client_pid}|#{client_tty}'` (the pane id resolves to its session:
     a session named like `$0x` cannot be a `-t` by name); the client used last wins, on a tie the one listed later, as
     `personsClient`; no client (a detached session) is `{}`;
  4. the client's app: `scannedApps([clientPid], { platform, roots: appRoots(homedir()), processes: async () => rows,
     bundleId: readBundleId })` with the rows of step 2, so the table is read once; its tty when it passes `TAB_TTY`.
     A client whose parents name no listed app answers `{}`.
- At most one lookup per pane in flight and one per pane every 5 s: a lookup asked sooner gets the last answer. Command
  Code's `turn-start` comes at every tool call, and a lookup is a `ps` and up to 16 `plutil` runs.
- It logs a count line, no ids or names: `[device] tmux client · found`, `· none`, `· not read`.

### The app, tty and bundle (`observed.ts`)

- A new optional dep, `outer(hints, pid)`, the lookup above. `undefined`: nothing changes for that event.
- A promise: the agent is nested in a host whose own pty is no tab. Its caller's tty is never read (`learnTty` is not
  run, and `tty`/`ttyPid` are cleared at once, so a session resumed inside tmux never keeps an old tab). When the answer
  lands, while the session's caller and hints are still those it was asked for and it is live, the entry keeps it as
  `outer`; its app is `outer.app`, its tty `outer.tty`, its tap bundle that app's (`APP_BUNDLES`). Until it lands, and
  with an answer of `{}`, the app is `detectApp`'s, as today (`tmux`, or the bundle id the server inherited).
- Asked at the session's first event in a pane, and again at each `session-start` and `turn-start` (the person may have
  re-attached from another app). Every other event keeps the entry's `outer` while the caller and the pane stay the same,
  so a `needs-input` or `turn-stop` never puts the agent back on the "tmux" page. A new caller or pane drops it.
- `Place` gains `outer?: { app: string; tty?: string }`, handed to every adapter's `paneOf`.

### The tab (`tabs.ts`)

`paneOf` takes `place.outer` when it is there: the tab is `outer.app` and `outer.tty`. Otherwise as today: a
multiplexer's own pty is never a tab.

### The tmux pane (`tmux.ts`)

- The pane id carries a third field, the app, only when `place.outer` names one (checked against `APP_IDS`): `%3:100` as
  today, or `%3:100:terminal-app`. `PANE_AND_PID` reads both.
- `canShow`: only a pane with an app, and only while that app is the app in front (a new dep, `front()`, wired to
  `cableHost.latestFront()`). `show`: the same checks as `focus` (not Harness's, the pane's process in the agent's chain),
  then one `tmux select-window -t %N ; select-pane -t %N`. Its own session's active window and pane change, so every
  client on that session shows it; no client is switched to another session.
- `focus` (a tap): a pane with an app runs the same select as `show`, so the client whose tab is raised is the one that
  moves; a pane without one keeps today's `switch-client` on the person's client used last (a detached session, or no
  app found).

### Tap, swipe and rest (`observed.ts`, generic)

- A rest and a swipe: `showPane` shows the agent's first resting pane whose adapter's tap is `'after'` (a tab), then its
  first resting other pane, each that exists; one alone is shown as today. The answer is `busy` if either was busy,
  `failed` only if every one shown failed, else `ok`. Only an agent with `outer` has both today.
- A tap: unchanged order (the first tapped pane, before or instead of the app, then `open -b`). `focus` then raises the
  agent's first resting `'after'` pane, rather than only a first shown pane that is one.

### Cases

- Several clients on one session: the client used last gives the app and tab; only its tab turns the dial (`byTab`).
- A pane the person moves to another session: it keeps the app it had until the next `session-start` or `turn-start`.
- A detached session: no client, so the "tmux" page, as today; a tap switches the person's client used last, as today.
- tmux started inside herdr, cmux or Herdr's own terminal: the nearer host wins in `detectHost`; this path does not run
  for it (out of scope).

### Measures

The `[device] tmux client` counts above, and the existing `[device] open · tmux · not its pane` for a refused show or
tap. The lookup's cost is measured before and after on the same machine: wall time of one lookup with 1 and 3 clients.

### Data

Nothing is stored, synced or exposed: the client's app and tty live on the session's entry in the devices process's
memory, gone with it. No design checklist applies.

### Platforms

- macOS: everything above.
- Linux: the app is learned the same way (the walk reads names there), so a tmux agent lands on its terminal's page; no
  tty passes `TAB_TTY`, so there is no tab, and a swipe or rest only selects the tmux window and pane while that app is
  in front.
- Windows: no tmux; nothing changes.

## Verification (for the plan)

- Unit, red then green:
  - `tmux.spec.ts`: the lookup (not tmux: `undefined` and no command; a person's pane; a Harness pane; a pane not in the
    caller's chain; no client; the client used last; a tty out of form; the 5 s bound); the pane id's app field; `show`
    and `canShow`; `focus` with and without an app.
  - `observed.spec.ts`: a nested event lands on `outer`'s app with its tty and bundle; keeps it at `needs-input` and
    `turn-stop`; asks again at `turn-start`; falls back on `{}`; never reads the caller's tty and clears an old one;
    `showPane` shows the tab then the other pane; `focus` raises the tab when the tmux pane came first.
  - `tabs.spec.ts`: a place with `outer`.
- End to end, macOS, on the real daemon with its private tmux server (`IsolatedDaemon`, throwaway `HOME` and
  `TMUX_TMPDIR`), never the person's tmux or Terminal (`e2e/dialTmuxTerminal.e2e.ts`):
  - an outside agent (`harness/outsideAgent.ts`) runs in a pane of a session the test opened on that server by hand,
    with no `__CFBundleIdentifier` (a server the daemon started, as on Diego's Mac);
  - a tmux client is attached to that session from a fake Terminal: `terminal-app` added to `FAKE_APPS`
    (`outsideAgent.ts`), whose `fakeApp` symlink in `$HOME/Applications/Terminal.app` (`com.apple.Terminal`) runs the
    existing Python PTY helper that runs `tmux -S <daemon socket> attach`, so the client has a tty and its parent is
    the fake Terminal (the builder check ran this chain; a copy of `/usr/bin/script` is killed by macOS);
  - the fake dial sees the agent on Terminal's page, one row, and none on a "tmux" page;
  - with Terminal in front on the fake watch, a swipe makes the watch select the client's tty, and tmux's active pane
    of that session becomes the agent's; with another app in front, tmux's active pane does not move;
  - no GUI window opens and nothing real is opened (`HARNESS_OPEN_BIN` fake, as the other dial tests).
- Local gates: `npm run typecheck`, the unit tests of the changed files, the new e2e, and `npm run test:core` for the
  `services/devices.ts` wiring.
- Docs in the same pull request: `cli/AGENTS.md`'s devices row (a tmux agent is on its client's app's page; swipe and
  tap select its window and pane), and `cli/src/services/AGENTS.md`'s person's-tmux paragraph (a select moves the
  pane's own session, for every client on it; `switch-client` only without a found client).
