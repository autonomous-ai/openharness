# An agent in herdr inside a terminal app's tab shows on that app's page, and a swipe reaches it

## Intent

Diego (2026-11-19, CLI 0.6.73 with #4491 and #4497): in Terminal.app, tab A is a plain shell and tab B runs `herdr`, with
a Claude Code session in a herdr pane. Selecting tab B on the Mac turns the dial to that agent; a swipe on the dial's
Terminal page never lands on tab B. An agent in a herdr pane whose herdr client runs in a terminal app's tab (Terminal,
iTerm2, Ghostty) must show on that app's page, one row, and the dial's swipe, rest and tap must reach it there, as #4491
did for the person's tmux.

## Root cause (diagnosed read-only, reported to the PM)

Checked with a private herdr 0.8.0 (throwaway `HOME` and `XDG_CONFIG_HOME`), never the person's:

- herdr is a server and clients, like tmux. `herdr` in a tab starts (or attaches to) a server that detaches (`ppid` 1,
  no tty); the panes' shells are the server's children. A client is a `herdr` process on the tab's tty, connected to the
  server's `herdr-client.sock`. herdr's API (`herdr api schema --json`, protocol 19) has no call that lists clients.
- A pane inherits the server's `__CFBundleIdentifier` and `TERM_PROGRAM` and gets `HERDR_PANE_ID`. `detectApp` names the
  app the **server** started in (Terminal when it started from Terminal, none or another app otherwise), and the pane's
  tty is herdr's own pty, which no tab holds.
- `observed.ts`: only `TMUX_PANE` asks for an outer place (`createTmuxOuter`), so for a herdr pane:
  - `learnTty` reads the herdr pty, and `byTab('terminal-app', <tab B's tty>)` finds no agent: the devices log's
    `[device] tab · skipped · unknown agent` right after `tab · moved`.
  - `tabs.ts` `paneOf` refuses it (host `herdr` is not its app, and there is no `outer`), and `herdr.ts` has no `show`:
    `hasPane` is false, so a swipe that rests on the agent selects no tab and focuses no pane.

## Goals

1. An agent in a pane of the person's default herdr session, whose client runs in a tab of Terminal, iTerm2 or Ghostty,
   is on that app's page: one row (the herdr source's copy folds into it by its pane key, as today), never a second row
   on a herdr page.
2. A swipe or rest while that app is in front selects the client's tab, then the agent's herdr pane
   (`herdr agent focus`). While the app is not in front, a swipe or rest changes nothing in herdr.
3. A tap focuses the herdr pane (as today), brings the client's app forward and selects the client's tab.
4. Selecting that tab on the Mac turns the dial to the agent (the existing `byTab`, by the client's tty).
5. Herdr.app (Herdr Core, `HC_TERMINAL_ID`) keeps today's Herdr page; herdr inside tmux keeps #4491's behaviour.

## Non-goals

- Named herdr sessions (`herdr --session <name>`): the hook sends no `HERDR_PANE_ID` there (`hook/notify.mjs`), so no
  lookup runs; unchanged. Stated in the pull request.
- Linux and Windows: the lookup answers nothing at once; unchanged. Stated in the pull request.
- herdr over `--remote`; an agent no hook told of (the herdr source's own row stays on the herdr page, as the 2026-11-16
  spec says); voice and scroll for herdr: unchanged.
- The dial following herdr's own pane changes inside one tab.

## Anti-goals

- Nothing in the daemon core, the hook or the observed route's body (`cli/AGENTS.md` rule 7). No new hint.
- No reading of another process's environment or argv. Only process names, parents and ttys (`ps`), the unix-socket
  rows `lsof` gives for herdr's own processes, and a tty's access time (`stat`).
- No command into a session or client herdr did not tell us of; no command at all while the client's app is not in
  front, except a tap's existing `herdr agent focus`.

## Constraints

- Devices process only: `cli/src/cable/hosts/` and the wiring in `cli/src/services/devices.ts`. `observed.ts`, `open.ts`
  and `tabs.ts` hold no rule about herdr (`cli/src/services/AGENTS.md`); `observed.ts` already takes a generic `outer`.
- Every value read is outside text: pids are held to the pid form, ttys to `TAB_TTY` before they become a tab, pane ids
  to `HERDR_PANE`; commands run with no shell, each value one argument.
- Logs: fixed words and counts only, `errorKind(err)` for a failure (#4458, #4488). Harness paths, if any, through
  `cli/src/config/harnessHome.ts` (none are needed).
- Ken's paused `feat/dial-linux` touches `hosts/` and `devices.ts`: rebase on `main` often.

## Approaches

1. **Learn the outer place from the herdr client's process (chosen, PM 2026-11-19).** Find the herdr server in the
   caller's parents, the clients connected to it by their unix sockets (`lsof`), the client used last by its tty's access
   time, and its app by the open scan's walk. Same shape as `createTmuxOuter`; `observed.ts` takes it through its
   existing `outer` dep.
2. Ask herdr which client shows the pane. Not possible: herdr 0.8.0's API lists no clients.
3. Have the hook send the tab's tty. Rejected: changes the hook and the core's observed body (core rule 7), and the
   pane's environment names where the server started, not the client.

## Design

### The lookup (`cli/src/cable/hosts/herdrOuter.ts`, new)

`createHerdrOuter(deps)` returns the same kind of function as `createTmuxOuter`:
`(hints, pid) => Promise<{ app?, tty? }> | undefined`.

- `undefined` at once, running nothing, when: the platform is not macOS, `hints.HERDR_PANE_ID` is missing or fails
  `HERDR_PANE`, or the pid fails the pid form. The agent is then placed exactly as today.
- Otherwise a promise that never rejects:
  1. One process-table read (`deps.processes`, `readProcessNames`: pid, ppid, executable).
  2. **The server**: the nearest process named `herdr` (executable basename, exactly) in the caller's parent chain
     (`parentChain`, at most `WALK_PARENTS`). None: `{}`.
  3. **Its clients**: every other process named `herdr`, at most 16 (more: the 16 with the highest pids, as the newest).
     One `lsof -a -U -p <server>,<each> -F pdn` run (`/usr/sbin/lsof`, `RUN_TIMEOUT_MS`): a client is connected when
     one of its `n->0x…` peers is the `d` address of a server descriptor whose `n` path ends in `/herdr-client.sock`.
     A process connected only to `herdr.sock` (a `herdr agent …` command) is not a client. No other `herdr` process,
     or none connected: the server is the only candidate (herdr's `--no-session` runs the panes under the client
     itself, on the tab's tty).
  4. **Their ttys**: one `ps -o pid=,tty= -p <candidates>` run (`/bin/ps`); a tty becomes `/dev/<tty>` and is a tab
     only when it passes `TAB_TTY`. The server as the only candidate counts only with a tty (a detached server has
     `??`): else `{}`.
  5. **Their apps**: one `scannedApps(<candidates>, { platform, roots, processes: async () => rows, bundleId })` with
     the rows of step 1. A candidate whose parents name no listed app is dropped: a client inside tmux or Herdr.app
     (its parents end at a detached server or holder), whose pty `TAB_TTY` also matches. None left: `{}`.
  6. **The client used last**: of those left, the one whose tty's access time (`stat`, `atimeMs`) is newest: a tty's
     access time moves when the person types into it (checked on macOS, 2026-11-19), as `w`'s idle time does. A tie,
     or a failed `stat`: the higher pid. Its answer is `{ app, tty }`, with no `tty` when it failed `TAB_TTY`.
- `lsof` and `ps` exit 1 when a pid in their list has gone, with the rest of their output intact (checked on macOS):
  their stdout is read whatever the exit code, and a step counts as not read only when its run gave no output at all
  or timed out. The `lsof` parser takes `p`, `d` and `n` lines and passes over every other (`f`, one per descriptor).
- At most one lookup in flight per pane and caller, and one per pane and caller every 5 s; a sooner ask gets the last
  answer (`OUTER_EVERY_MS`, exported from `tmux.ts` and shared).
- Its line, once per lookup: `[device] herdr client · found`, `· none`, or `· not read · <step>` with `<step>` one of
  `processes`, `sockets`, `ttys`, `app`.

### The order with tmux (`devices.ts`)

`observed`'s `outer` dep becomes one function, built by a small generic `firstOuter(first, second)` in
`cli/src/cable/hosts/outer.ts` (with its own spec; `devices.ts` keeps one line of wiring, as its `test:core` gate wants):
the first lookup's answer when it has an app; else the second's; `undefined` only when both answer `undefined`, and
`{}` when the first answered a promise with no app and the second answers `undefined`. Neither lookup knows the other.
`devices.ts` passes herdr's first, tmux's second. That keeps #4491's behaviour for herdr inside the person's tmux: a
herdr server that detached is in no tmux pane, so both find nothing, as today; herdr's `--no-session` inside tmux runs
its panes under the client in the tmux pane, so herdr's lookup finds no app (the tmux server's parents) and tmux's
finds the tmux client's app, as today.

### The herdr pane (`herdr.ts`)

- `paneOf`: the pane id carries the app when `place.outer` names one in `APP_IDS`: `w1:p1` as today, or
  `w1:p1:terminal-app`. Every verb (`focus`, `type`, `show`, `paneKey`) first takes the bare herdr pane id from it
  (`HERDR_PANE` checks that part); the per-pane `focusing` and `prompting` maps, `herdr agent focus` and
  `client.prompt` see the bare id only, so the herdr source's copy (bare id) and the observed copy share one turn.
  `prompt(paneId)` stays bare. `paneKey` stays `herdr:w1:p1`, so the herdr source's copy folds as today, and its own
  `focus(paneId)` is unchanged.
- `canShow`: only a pane with an app, and only while that app is the app in front (a new `HerdrAdapterDeps.front()`,
  wired in `devices.ts` as a closure on `cableHost.latestFront()`, as tmux's).
- `show`: `herdr agent focus <pane>` through the same per-pane turn as `focus` (it joins a focus under way and waits for
  words under way); `'ok'` when it exits 0, else `'failed'`.

### What does not change

- `observed.ts`: `askOuter`, `placeApp`, `shown` and the tap's raise of a `tap: 'after'` pane are generic since #4491; a
  herdr answer lands the same way (app, tty, bundle; the caller's tty never read while nested). A doc comment that names
  only tmux is widened to "a multiplexer"; no logic change is expected. If a test shows one is needed, it is generic.
- `tabs.ts`: `paneOf` already takes `place.outer`.
- `byTab`: finds the agent by the client's tty.

### Cases

- One Terminal tab runs herdr: the agent is on Terminal's page at that tab; tab A's plain agent stays at tab A.
- Two tabs attached to one herdr server: the one typed into last gives the tab; selecting either moves the dial only
  when it is that one (`byTab`), until a new `turn-start` or `session-start` asks again.
- herdr's server started from another app (Orca, Ghostty) and attached from Terminal: Terminal's page, as the client
  decides, not the inherited bundle id.
- No client (detached): `{}`, so today's page from the hints, and today's tap.
- herdr inside Herdr.app's terminal: the client's parents end at Herdr Core's holder, no listed app: `{}`, today's page.
- herdr inside Orca, VS Code or Cursor: the client's app is that app; no tab (not a tab app), so a rest shows the herdr
  pane while that app is in front, and a tap opens that app.

### Measures

The `[device] herdr client` lines above. The lookup's cost is measured before and after on the same machine: wall time
of one lookup with 1 and 3 clients (the `lsof` of the private run: about 40 ms).

### Data

Nothing is stored, synced or exposed: the client's app and tty live on the session's entry in the devices process's
memory, gone with it. No design checklist applies.

### Platforms

- macOS: everything above.
- Linux, Windows: the lookup answers `undefined`; nothing changes.

## Verification (for the plan)

- Unit, red then green:
  - `herdrOuter.spec.ts`: not herdr, a bad pane id or off macOS: `undefined` and no command; no herdr in the parents;
    no client; a `herdr agent` command connected only to `herdr.sock` is no client; one client; two clients, the newer
    tty access time wins, a tie the higher pid; a client in tmux (no app) loses to one in Terminal; a tty out of form;
    a client whose parents name no app; Herdr.app's terminal (holder not under the scan's roots): `{}`;
    `--no-session` (server on a tab tty); `lsof`/`ps` exiting 1 with output is read; each step that fails logs its
    word and answers `{}`; the 5 s bound and the shared in-flight lookup; more than 16 herdr processes.
  - `herdr.spec.ts`: the pane id's app field, verbs and `paneKey` on both forms; one turn for the bare and the app id;
    `canShow` with and without the app in front; `show` runs `herdr agent focus` in the pane's turn.
  - `outer.spec.ts`: `firstOuter`'s four cases (first has an app; first has none, second has one; first none, second
    `undefined` → `{}`; both `undefined` → `undefined`).
  - `observed.spec.ts`: only if a generic change there turns out to be needed (the end-to-end test covers a herdr agent
    landing on the outer app and tab, and `showPane` showing the tab, then the herdr pane).
- End to end, macOS, on the real daemon with a private herdr (`e2e/harness/herdrServer.ts`, throwaway `HOME` and
  config), never the person's herdr, Terminal, daemon or Claude home (`e2e/dialHerdrTerminal.e2e.ts`):
  - a herdr client is attached first, from a fake Terminal's tab (`tabUnder(d, 'terminal-app', [herdr], …)`, pinned to
    the private server; its tty read with `ps -o tty= -p <pid>`; the pty given a size if herdr needs one);
  - then a fake Claude Code runs in a pane of the private server, as `e2e/deviceHerdr.e2e.ts` starts one
    (`herdr.pane` and `type '"$CLAUDE_PATH"'`), so its hook carries herdr's own `HERDR_PANE_ID` and no
    `__CFBundleIdentifier`; a second pane holds another agent, so a swipe has two to walk;
  - the fake dial lists the agent on Terminal's page, one row, none on a herdr page;
  - with Terminal in front on the fake watch, a swipe makes the watch select the client's tty and herdr's focused pane
    becomes the agent's (`rpc('agent.get')`'s `focused`); with another app in front, herdr's focus does not move;
  - a `front` line naming the client's tty turns the dial to the agent;
  - no window opens; `open` is the harness's fake (`HARNESS_OPEN_BIN`);
  - the lookup sees only the test's own herdr processes (PM, 2026-11-19): the daemon under test finds, first on its
    PATH, a `ps` of the e2e harness's that runs `/bin/ps` and drops each `herdr` row whose process is not in the test's
    own process tree, so the lookup's candidates, and so its `lsof -p` list, never hold a herdr of the person's. The
    harness records the pids it dropped and kept, and the test checks that every herdr pid kept is the test's. No
    product switch or option is added for it. If that cannot be done cleanly, the e2e reads the person's herdr's socket
    rows read-only, as the product does, and the pull request says so (PM's fallback).
- Accepted and stated in the pull request (PM, 2026-11-19): herdr's `--no-session` inside the person's tmux inside a
  terminal app rests by `herdr agent focus` rather than #4491's tmux select (the tab is still right). Of clients whose
  tty's access time cannot be read, each ranks below every client whose time was read; among equals the higher pid.
- Local gates: `npm run typecheck`, the unit tests of the changed files, the new e2e, and `npm run test:core` for the
  `services/devices.ts` wiring.
- Docs in the same pull request: `cli/AGENTS.md`'s devices row (a herdr agent is on its client's app's page), and
  `cli/src/services/AGENTS.md` where #4491's person's-tmux paragraph sits.
