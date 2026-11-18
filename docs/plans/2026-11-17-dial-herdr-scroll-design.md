# Dial scroll for Herdr's terminals

Diego (2026-11-17): scrolling on the dial does nothing for an agent in Herdr (Herdr.app over Herdr Core). On `main` the
dial's scroll reaches only Harness's own windows: `services/devices.ts` sends every stroke as `dial_scroll` to the core's
local clients (Desktop, the TUI), and no host adapter under `cli/src/cable/hosts` scrolls anything.

This item makes a stroke on the dial scroll Herdr's view of the shown agent's terminal while Herdr is in front. It is
built the way the VS Code branch (`feat/dial-vscode-extension`, `docs/plans/2026-11-17-dial-vscode-extension-design.md`
§4) scrolls a VS Code terminal, with the routing made general: an adapter that can scroll says so through
`HostAdapter.scroll`, and the VS Code branch moves its own terminal onto it (the PM tells that branch).

## What Herdr offers (Phase 1, 2026-11-17)

- **Herdr Core (hc 0.1.21) cannot scroll a view.** Its API (`hc schema`, 32 methods) has no scroll method; history is
  only read (`terminal.read`, `terminal.attach`'s `history`). `terminal.keys` presses keys in the program itself: it
  scrolls the program, not the history (and not late: measured 2026-11-18, §3).
- **Herdr.app (`herdr-app` 0.1.16) can.** `herdr-app commands` lists `terminal.scroll {lines | pages | to, terminal?}`:
  "Scroll a terminal's view of its history ... lines (a whole number; negative goes up, toward history) ... This
  scrolls Herdr's view, not the program." It is run as `herdr-app do terminal.scroll --terminal t7 --lines -3`, through
  the same CLI the adapter already runs for `do agent.focus`. Herdr's window socket (`~/.config/herdr-app/herdr-app.sock`)
  is not documented, so it is not spoken to directly.
- **Cost.** One `herdr-app` run that does not reach the window (`herdr-app commands`) took 10–50 ms, 5 runs on Diego's
  Mac. The plan measures `do terminal.scroll` against a private Herdr only if one can run without the person's window;
  otherwise the person checks the feel after merge.
- **Which terminal is on screen** is the window's alone: hc's terminal facts have no focus or viewer. `herdr-app status`
  ("what's on screen: layout, focus, overlays, zoom") answers it; one run took 0.04 s. Its `tab` is the tab on screen;
  its `agent` is **not** what is on screen (found 2026-11-18, after Diego's first check scrolled nothing): with a
  temporary terminal's tab opened and shown, `tab` changed to that tab while `agent` still named the agent of the tab
  before. hc labels each terminal Herdr's window holds with `herdr.space` and `herdr.tab`, so the tab is matched there.
- **The alternate screen has no history.** A program on it (an editor, a pager) is not scrolled: `terminal.scroll` has
  nothing to move, and still answers `ok`.
- **Claude Code 2.1.327 draws on the alternate screen and takes the mouse** (found 2026-11-18, after Diego's second
  check scrolled nothing on Herdr and on VS Code). A temporary Claude Code with the person's settings (`"tui":
  "fullscreen"`), its output recorded with `script`, wrote `?1049h` (alternate screen), `?1000h`/`?1002h`/`?1003h` and
  `?1006h` (mouse with wheel, SGR), kitty keyboard and bracketed paste. Its "Scroll" key context binds `pageup` to
  `scroll:pageUp`, `pagedown` to `scroll:pageDown` and the wheel to lines. On that Claude Code, with 300 lines of local
  output on screen (lines 263–300): `herdr-app do terminal.scroll --lines -20` moved nothing; `hc keys <t> pageup`
  (0.05 s, idle) showed lines 244–282, and `pagedown` 263–300 again; its input box stayed empty. hc encodes a named key
  for the program's current keyboard modes, so a key is never typed as text. hc's `terminal.keys` says it presses
  "after ~3 s of quiet" (`hc schema`), yet it pressed at once while a fake program wrote (measured, §3). hc offers no
  way to send a wheel event, and raw wheel bytes into the terminal are not sent:
  if the program's mouse mode were guessed wrong, their `ESC` would be an Escape key and the rest typed text.
- **herdr 0.8.0** (the older multiplexer, `herdrClient.ts`) is left out (PM, 2026-11-17): its public API only reports a
  pane's scroll (`PaneScrollChanged`, `PaneInfo.scroll`), and its `send-keys` types into the program.

## Behavior

- A stroke on the dial scrolls Herdr's view of a terminal, line by line as the finger moves, only when all three hold
  at its `down` (PM, 2026-11-17):
  1. **Herdr is in front** (`cableHost.latestFront() === 'herdr'`, the rule a Herdr swipe uses);
  2. the dial **shows an agent with a terminal in Herdr's window** (`hcSource.shows(address)`);
  3. that terminal is **in the tab Herdr shows on screen**: `herdr-app status`'s `tab` equals the terminal's
     `herdr.tab` label in hc (PM, 2026-11-18; `status`'s `agent` is not what is on screen, see below).
  Harness's windows then hear none of that stroke.
- Otherwise the stroke goes to Harness's windows as today (`dial_scroll`), so no terminal nobody sees is scrolled.
- The route is chosen at a stroke's `down` and kept to its `up`, as on the VS Code branch: Harness's windows are never
  left holding a drag whose `up` went to Herdr. A `move` or `up` with no `down` before it chooses then.
- A Claude Code terminal is moved by its own `pageup`/`pagedown` keys a page at a time, since it draws on the alternate
  screen (PM, 2026-11-18); every other terminal by Herdr's view, line by line.
- Travel turns into lines with Harness's own numbers (`scrollLines.ts`, from the VS Code branch: remainder += −dy × 2.5,
  16 px a line, whole lines spent, n < 0 toward older lines; `down` resets). A fling (`up` with a velocity) is not
  played: the scroll stops where the finger stops. The device's `scrollReversed` is not applied (the daemon applies it
  nowhere today).

## Design

### 1. The shown agent's id (shared with the VS Code branch, same names and signatures)

Copied from the VS Code branch so that both rebase cleanly over each other:

- `CableHost.dialShows?(dial, agent, agentId: string | null)` in `cableSession.ts`; `CableSession.reportShown` keeps
  `shownId` beside `shown` and calls the host when either changes ("a move between two agents of one name and app
  changes where the dial's scroll goes").
- `DaemonCableHost.dialShows(dial, agent, agentId)` keeps it in `shown`, and `shownAgentId(): string | undefined`
  answers it. The `dial` stream still writes a name and an app only.
- `cli/src/cable/hosts/scrollLines.ts`: `SCROLL_SCALE`, `SCROLL_LINE_PX`, `createScrollLines()`, as on that branch.

### 2. `HostAdapter.scroll` (adapter.ts)

Three optional members, asked at each stroke's `down`:

```ts
/** Whether a stroke on the dial may scroll that pane's view now, as far as the adapter knows without asking its app:
 *  its app in front and the pane in its window. */
canScroll?(pane: Pane): boolean
/** Whether the pane is the one its app shows on screen now, asked of the app once a stroke, after `canScroll`. False on
 *  any failure or past its deadline; never throws. An adapter that knows it from `canScroll` alone has none. */
onScreen?(pane: Pane): Promise<boolean>
/** Scrolls the app's view of the pane's history by whole lines, n < 0 toward older lines. Fire and forget: it never
 *  throws, and a line it could not send is counted in its own log line, never retried into the program. */
scroll?(pane: Pane, lines: number): void
```

VS Code (when it moves onto these) needs no `onScreen`: its extension already drops a line for a terminal that is not
the active one.

### 3. The Herdr adapter's scroll (herdrApp.ts)

- `canScroll(pane)`: macOS, `HC_TERMINAL.test(pane.id)`, `inFront()` and `shows(pane.id)` (the same test as
  `canShow`), and `binary()` found.
- `onScreen(pane)`: runs `herdr-app status` (no shell, `SCROLL_TIMEOUT_MS`; it took 0.04 s against Diego's window, run
  once with the PM's go). Its stdout is one JSON object (Herdr 0.1.16): `zoom`, `font_size`, `ui_font_size`, `space`,
  `tab`, `focused_pane`, `layout`, `agent`, `floats`, `overlays`, `errors`. `tab` is the id of the tab on screen. True
  only when the exit code is 0, the stdout parses as an object, its `tab` is a non-empty string, and it equals the
  pane's terminal's `herdr.tab` label (`tabOf(pane.id)`, a new adapter dep the hc source answers); a missing or null
  `tab`, a terminal with no `herdr.tab` label, another tab, bad JSON or a failed run is false. Only `tab` is read; the
  rest (names of the person's spaces and layouts) is never kept or logged.
- The hc side of that match: `hcClient.ts` keeps the `herdr.tab` label beside `herdr.space` (its `READ` list) and
  reads it into `HcTerminal.tab` (a non-empty string, else none); a `labels` event updates it, so a terminal moved to
  another tab is matched there. `HcSource.tabOf(address)` answers it for the same terminals `shows` covers (listed or
  past the 64), and `devices.ts` passes it to the adapter as `tabOf`. A failed run logs `[herdr-app] status · failed` once until one
  succeeds; a mismatch logs nothing of its own (the routing counts it, §4). The test fixture is written by hand in this
  shape with made-up ids; the raw output stays in the session's scratchpad only.
- `scroll(pane, n)`: checks the id again, drops `n === 0`, and runs
  `herdr-app do terminal.scroll --terminal <address> --lines <n>` with no shell, each value one argument, with a
  timeout of its own, `SCROLL_TIMEOUT_MS = 2_000` (a run took 10–50 ms; the 10 s `RUN_TIMEOUT_MS` of a focus would
  freeze a stroke). **One run at a time per terminal:** lines that come while a run is under way are added to a pending
  count, clamped to ±100, which the next run carries once the current one ends. **And a run starts no sooner than
  `SCROLL_GAP_MS = 50` after the last one for that terminal started** (PM, 2026-11-18): Diego's first check logged 109
  runs for 161 lines in about 3 s, about 40 processes a second carrying 1–2 lines each. With the gap a stroke costs at
  most 20 processes a second, the lines that come in the gap are summed into the next run, and none is lost; the first
  run of a stroke still starts at once.
- Its queue is a map of its own (`scrolling`, by address), never the `running` map and `once()` that a tap and a rest
  share: a scroll never joins an `agent.focus` run (it would lose its lines), and a scroll and a focus may run together.
- A run that fails (non-zero exit, timeout, no binary) drops its lines and what is pending for that terminal, and logs
  `[herdr-app] scroll · failed` once until a run succeeds again (no line per frame). Its words never name the terminal.
- Once a terminal has been quiet for 1 s (no run under way, nothing pending and no new line for it for 1 s), the adapter
  logs one line with what it did since its last such line: `[herdr-app] scroll · <lines> lines · <runs> runs · <failed>
  failed`. Counts only. A run is faster than the dial's line, so the queue drains after almost every line: a line at each
  drain would be up to ~30 a second. With the quiet second a stroke and its pauses give one line, a long stroke one at
  its end, so the lines stay bounded; the adapter needs no word of the stroke's end.

- **A Claude Code terminal is scrolled by keys, not by Herdr's view** (PM, 2026-11-18). When hc reports the
  terminal's app as `claude-code`, `scroll` presses `pageup` (lines < 0) or `pagedown` through hc's own socket
  (`HcClient.keys(address, keys)`, `terminal.keys`), never `herdr-app`. Lines are summed per terminal and one key is
  pressed per `SCROLL_PAGE_LINES = 20` lines (one page measured 19 lines at 46 rows), the rest kept for the next lines of
  that terminal and dropped with the queue at the stroke's end, quiet second or stop. At most 5 keys go in one call. The
  same queue holds: one call at a time per terminal, the 50 ms gap, `SCROLL_TIMEOUT_MS`, the ±100 clamp, the failure
  line once, the tally (its lines are the lines the keys stood for; its runs the calls) and `stop()`.
- **No key while Claude Code asks.** `canScroll` is false for a `claude-code` terminal whose hc status state is
  `blocked`, the dial's `needs-you` (a key could move the highlighted choice of a question, and the person's Enter would
  pick it); the stroke then goes to Harness's windows as today. A `working` one takes keys: hc does not wait while a
  program writes. Measured on 2026-11-18 against a private core (`cli/e2e/harness/hcCore.ts`, hc 0.1.21) with fake
  programs, never a model call: a `terminal.keys` call of one `pageup` was answered in 32–45 ms, three calls each, to an
  idle program quiet for 3 s, to one printing a line every 100 ms, to one that also reported `claude-code` `working`,
  and to one that had written 60 ms before; that `working` program read each key 40–103 ms after its call began (its
  screen polled through `terminal.read`), and five keys in one call took 158–173 ms. The "~3 s of quiet" of `hc schema`
  is not the program's output.
- Every other app keeps `terminal.scroll`.

### 4. Routing (services/devices.ts)

`routeScroll(phase, dy, velocity)` and `stroke` keep the VS Code branch's names and shape, with the target made general:

```ts
/** Where the dial's scroll goes: the shown agent's pane in the first adapter that can scroll it now. */
const scrollTarget = (): { adapter: HostAdapter; pane: Pane } | undefined
let stroke:
  | { adapter: HostAdapter; pane: Pane; lines: ReturnType<typeof createScrollLines> }
  | { deciding: { adapter: HostAdapter; pane: Pane }; held: Held }
  | 'windows'
  | undefined
```

- `scrollTarget` reads `cableHost.shownAgentId()`, then that agent's panes, in the order the adapters are kept:
  - **hooked** (the observed copy wins the registry's dedupe, so the dial's id is the observed one): for each adapter
    `a` in `adapters` with `scroll`, `observed.paneOf(agentId, a.id)` built into `{ adapter: a.id, id }`;
  - **listed by the hc source alone** (the dial's id is the row's own id): `hcSource.paneOf(agentId)`, a new read of
    the address its row holds (`find()`), built with the existing `hcPane(address)` and paired with the Herdr adapter
    entry in `adapters` (`herdrAppNoted`, whose spread keeps the new members).
  It takes the first pane whose adapter's `canScroll(pane)` is true.
- **Deciding.** With a target whose adapter has `onScreen`, the stroke is `deciding` from its `down` until the answer:
  `stroke = { deciding: target, held }`, where `held` keeps what the stroke has done meanwhile in a fixed size: that a
  `down` came, the summed `dy` of its `move`s and the last velocity, and whether its `up` came (with its velocity). On
  the answer, if that stroke is still the current one: true makes it a Herdr route (`createScrollLines()`, the held
  travel taken as one `move`), false makes it `'windows'` and replays the held stroke to the windows as a `down`, one
  `move` with the summed `dy` (when any), and the `up` (when it came). A newer `down` before the answer makes the old
  answer stale: it is dropped, and nothing of the old stroke was sent anywhere. No target, or one with no `onScreen`,
  decides at once as before.
- A stroke that went to the windows only because `onScreen` said false is counted; the devices log
  `[device] scroll · herdr-app · not on screen` once per such stroke (a hand's pace, and no address).
- `scrolled` is guarded as on the VS Code branch: `part.call('dial', () => routeScroll(...))`.
- The Wi-Fi device's strokes reach the same `cableHost.scrolled` (`devices.ts` `scroll:`), so they share `stroke` and
  the cable dial's shown agent, as on the VS Code branch. That is intended: one person, one desk, one route at a time.
- Everything stays in the devices process. Nothing in `src/core/` changes (cli/AGENTS.md rule 7).

**Merge order with the VS Code branch (PM, 2026-11-17: VS Code merges first, this branch rebases).** `routeScroll` and
`stroke` keep their names; `scrollTerminal()` becomes the general `scrollTarget()`, and `stroke`'s VS Code `terminal`
becomes `{ adapter, pane }`. On the rebase there is one route only:
- if VS Code landed with its adapter on `HostAdapter.scroll` (the PM asks that branch to), this branch only adds the
  Herdr adapter's members and `hcSource.paneOf`;
- if it landed with its own route (`scrollTerminal` → `vscode.scroll`), the rebase moves VS Code onto
  `canScroll`/`scroll` in `createVscodeAdapter` (`canScroll`: VS Code in front and `terminalOf(termPid(pane.id))`;
  `scroll`: `terminals.scroll(terminal, n)`) and deletes its own route, so no second way stays. Its e2e
  (`dialVscode.e2e.ts`) and specs must still pass unchanged.
- if VS Code has not merged when this branch is ready, this branch merges first with the shared parts above, and the
  PM tells the VS Code branch to rebase onto `HostAdapter.scroll`.

### 5. Measures and logs

- `cable: scroll ↓` / `cable: scroll ↑ (v=…)` stay as they are (cableHost.ts).
- The adapter's drain line and its failure line (§3): counts only, no address, name or text.

## Failure modes

| Case | What happens | What the person sees |
|---|---|---|
| Herdr not in front, or the shown agent has no terminal Herdr's window shows | the stroke goes to Harness's windows | as today |
| `herdr-app` missing or failing | lines dropped, counted, one log line | nothing scrolls in Herdr |
| A run hangs | `SCROLL_TIMEOUT_MS` (2 s) ends it; lines pending meanwhile are dropped with it | the scroll stops for up to 2 s |
| The shown agent's terminal is in Herdr's window but not in the tab on screen (the person clicked another, or the rest's switch failed) | `herdr-app status`'s `tab` at the stroke's `down` is another tab than the terminal's `herdr.tab`: no `terminal.scroll` runs, and the whole stroke goes to Harness's windows (PM, 2026-11-17; matched by tab, PM 2026-11-18) | as today |
| `status`'s `agent` names the shown agent while another tab is on screen (Diego's first check, 2026-11-18: 175 runs, nothing seen) | `agent` is not read; only `tab` decides | — |
| `herdr-app status` fails or takes over 2 s | the stroke goes to Harness's windows | as today |
| `status` has no `tab`, or the terminal has no `herdr.tab` label | not on screen as far as the devices can tell: the stroke goes to Harness's windows | as today |
| A fast stroke | at most one `terminal.scroll` run per terminal every 50 ms; the lines of the gap are summed into the next run | at most 20 processes a second |
| `status` is under way when the finger moves | the stroke is held in a fixed size and replayed on the answer | the first lines arrive about 0.04 s later |
| Herdr Core is not on its default session (`hookIds` false) and the dial shows the hooked copy | that copy has no Herdr pane | the stroke goes to Harness's windows |
| The terminal is on the alternate screen and is not Claude Code | Herdr has no history to move | nothing scrolls |
| A Claude Code terminal | `pageup`/`pagedown` through hc, one per 20 lines; Herdr's view is not asked to move | the transcript moves a page at a time |
| A Claude Code terminal that asks (hc's `blocked`, the dial's `needs-you`) | no key is pressed; the stroke goes to Harness's windows | as today |
| A Claude Code terminal that works (`working`) | its keys are pressed at once, as hc does while a program writes | the transcript moves while it works |
| hc refuses or times out a key call | its lines are dropped, `[herdr-app] scroll · failed` once | nothing scrolls |
| Herdr leaves the front mid-stroke | the stroke keeps its route to its `up` | the rest of that stroke scrolls Herdr's view behind |
| The dial moves to another agent mid-stroke | the stroke keeps its route; the next stroke chooses again | — |

## Platforms

macOS only: Herdr.app and the hc source run there alone. Linux and Windows are unchanged (no Herdr adapter verb runs;
every stroke goes to Harness's windows).

## Tests

- **Unit, red first:**
  - `scrollLines.spec.ts`, as on the VS Code branch.
  - `cableSession.spec.ts` / `cableHost.spec.ts`: the shown id reaches `CableHost`, a change of id alone is a change,
    `shownAgentId()` answers it and none once that dial shows none (the VS Code branch's specs).
  - `herdrApp.spec.ts`: `canScroll` per guard; `scroll` runs the exact argv with `SCROLL_TIMEOUT_MS`; one run at a time
    with pending lines summed and clamped to ±100; a scroll during a focus run of the same terminal runs on its own; a
    failure drops and logs once; the drain line's counts; a bad id or 0 lines runs nothing; off macOS nothing runs.
  - `herdrApp.spec.ts`, `onScreen`: the exact argv (`status`) and `SCROLL_TIMEOUT_MS`; true for the hand-written
    fixture whose `tab` is the pane's terminal's `tabOf`; false for another tab, a null or missing `tab`, a terminal with
    no `tabOf`, a fixture whose `agent` is the pane's address but whose `tab` is another, bad JSON, a
    non-object, a non-zero exit and a timeout; one `status · failed` line until a run succeeds; nothing of the stdout
    but `tab` read.
  - `herdrApp.spec.ts`, the gap: a run starts no sooner than 50 ms after the last one for that terminal started; lines
    of the gap are summed into one run; a stroke's first run starts at once; another terminal's runs do not wait.
  - `herdrApp.spec.ts`, Claude Code: a `claude-code` terminal's lines press `pageup`/`pagedown` through the client's
    `keys`, one per 20 lines, the rest kept, at most 5 keys a call, and run no `herdr-app`; `canScroll` is false while
    its state is `blocked` and true while `working` (hc does not wait, measured); another app runs
    `terminal.scroll`; a refused or timed-out call drops and logs once; `stop()` presses nothing more.
  - `hcClient.spec.ts`: `keys(address, keys)` sends `terminal.keys` with exactly those names and answers its outcome.
  - `hcClient.spec.ts`: `herdr.tab` is kept and read into `tab`; a `labels` event changes it; a missing or empty label
    is none.
  - `hcSource.spec.ts`: `paneOf(agentId)` answers a listed row's address and none for another id; `tabOf(address)`
    answers a shown terminal's tab and none for a terminal it does not show.
  - `devices.spec.ts`: a stroke with Herdr in front and a shown Herdr agent goes to the adapter and sends no
    `dial_scroll`, both for a hooked agent (observed pane) and one the hc source alone lists; any other case sends
    `dial_scroll` as today; the route holds from `down` to `up`. The hooked path is tested here only (the e2e sets
    `HC_SOCKET`, so `hookIds` is false there). Deciding (PM's third condition): `onScreen` false sends the held stroke
    to the windows as `down`, one summed `move` and `up`, runs no `scroll`, and logs `not on screen` once; true takes
    the held travel as lines; an answer after the `up` replays or scrolls the whole stroke; a newer `down` before the
    answer drops the stale answer and sends nothing of the old stroke.
- **End to end** (`cli/e2e/deviceHerdrApp.e2e.ts`, a new case; a private hc and the fake `herdr-app` that records its
  arguments, Herdr in front through the real `harness hardware watch --json`, as its swipe test does), shaped as
  `dialVscode.e2e.ts`'s scroll case:
  - a local window client (`e2e/harness/client.ts`) listens for `dial_scroll`;
  - a stroke on the fake dial (`down`, moves, `up`) runs the fake `herdr-app` with `do terminal.scroll --terminal <t>
    --lines <n>`; the `--lines` values summed over those runs equal the stroke's lines (the number of runs is not
    fixed), and the rest's `agent.focus` runs are ignored;
  - the private hc terminal carries `herdr.space` and `herdr.tab` labels; the fake `herdr-app` answers `status` with a
    hand-written object whose `tab` is a file the test writes: first the terminal's tab, then another tab (with `agent`
    still the terminal's address); a stroke while it names another tab runs no `terminal.scroll` and
    reaches the window as `dial_scroll` (the third condition, end to end);
  - then another app goes in front through the watch, a second stroke is sent, and the window's `dial_scroll` phases are
    exactly the strokes sent while Herdr was not the target: the first reached no window;
  - those strokes run over a fake program that reports `codex`; over one that reports `claude-code`, a stroke of 20 lines
    each way presses `pageup` then `pagedown`, which the fake program, reading its terminal raw, shows as their bytes, and
    no `terminal.scroll` runs nor `dial_scroll` reaches the window;
  - every wait is on a log line or a recorded run, never a fixed sleep.
  Skipped where hc is not installed (every GitHub runner); run locally on macOS. It never reaches Diego's own Herdr or
  hc.
- **By a person, after merge:** a real stroke on a dial over a real Herdr window, and its feel (speed, lag).

## Out of scope

- A wheel event for programs on the alternate screen: Herdr would have to send one (its real wheel does). Follow-up for
  Herdr's maker: `terminal.scroll` sends wheel reports when the program on the alternate screen takes the mouse, which
  would scroll Claude Code line by line and every such program; then the key path above goes (PM, 2026-11-18).
- herdr 0.8.0 (above); tmux, Orca, Terminal/iTerm2/Ghostty tabs; moving VS Code onto `HostAdapter.scroll` (the VS Code
  branch does it); a fling; `scrollReversed`; scrolling back to the bottom when a stroke ends.
