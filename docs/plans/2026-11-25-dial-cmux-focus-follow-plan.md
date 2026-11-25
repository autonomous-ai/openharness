# Dial: follow the focus in cmux: Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **devcrew phase 3** (a queue: each task starts once the tasks it
> depends on have landed and no running task shares one of its files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On macOS, with cmux settled in front and a dial attached, moving cmux's focus to another surface, switching
workspace, or cmux coming forward turns the dial to the one live agent at cmux's focused surface, never to a wrong
session, with no typing.

**Architecture:** Devices process only, nothing in `cli/src/core/`. A new reader, `HO/cmuxFocus.ts`, tails cmux's own
event log `~/.cmuxterm/events.jsonl` (read-only, bounded) and keeps cmux's front workspace and each workspace's focused
surface in memory. The cmux source's existing watch tells a change of that file on a new dep `events()`; `SV/devices.ts`
reads only while the dial is attached, cmux is found and cmux is the settled front app, plus one read at cmux's settle,
and follows the one live merged-list entry at the front surface (`cable.followLocal(id, 'pane')`), skipping the dial's
own cmux moves of the last 2 s (`cmuxFocuses`, a `dialMovesTo()` keeper fed by `cmuxAppNoted`).

**Tech Stack:** TypeScript (Node 24), `node:fs` (read-only fd reads), Vitest with injected fakes and fake timers, the dial
app eval (tier A spec, tier B e2e files) as the no-drop gate.

**Spec:** `docs/plans/2026-11-25-dial-cmux-focus-follow-design.md` (approved; read it with this plan). Base:
`feat/dial-cmux-focus-follow` at `c92d79f9c8`. The spec and this plan are the branch's first commit (made by the main session on the PM's go).

Paths: `HO/` is `cli/src/cable/hosts/`; `SV/` is `cli/src/services/`; `TS/` is `cli/src/testing/`; `EV/` is
`cli/src/testing/dialAppEval/`. Commands run in `cli/`.

## Decisions already made (PM, 2026-11-24/25): not reopened

1. Push, not poll: the tail of `events.jsonl`, told by `cmuxSource.ts`'s existing watch (`changed(file)`). No second
   watcher, timer, cmux process or socket.
2. Read only while cmux is the settled front app and a dial is attached; zero reads otherwise; one catch-up read at
   cmux's settle.
3. cmux's settle follows its focused surface unless the dial moved within `ATTACH_ECHO_MS` (as `followFocus`, Orca's).
4. With two or more cmux windows known, `workspace.selected` makes the front unknown; only `window.keyed` sets it.
5. Only the event's name, `boot_id` and the workspace, surface and window ids are read; no title, cwd, prompt preview or
   other payload is kept or logged; at most 1 MiB a read and 16 KiB a line; the file is opened `O_RDONLY` and never
   written, truncated, renamed or deleted.
6. Never a wrong session: exactly one live merged-list entry (`registry.entries()`, not `ended`) holding pane key
   `cmux:<surface lower case>` or the session of cmux's row at that surface; else nothing. The dial's own tap or rest on
   a cmux pane is noted (`cmuxFocuses = dialMovesTo()`, through `cmuxAppNoted`) and not followed back within 2 s.
7. macOS only (the cmux source is created only on darwin). Linux and Windows unchanged.
8. The dial eval's code and scenarios do not change (no cmux scenario exists); only `EV/baseline.json`, and only if a
   rerun's numbers change. Held-out scenarios are never read.
9. Docs: the `devices` row of `cli/AGENTS.md`'s processes table gets the cmux focus follow, in the style of herdr's
   `pane.focused` clause.

## What this plan decides from the spec's words

- **The reader's file door** is an interface, `CmuxLogFiles` (`open`, `fstat`, `read`, `close` on a numeric fd), with a
  real one, `cmuxLogFiles()`, opening with `fs.constants.O_RDONLY` only. `DevicesDeps` gets `cmuxEvents?: CmuxLogFiles`
  for the devices' specs, default `cmuxLogFiles()`. Both specs drive an in-memory log, `fakeCmuxLog()` in
  `TS/fakeCmux.ts`, which counts opens (the spec's "no `open` of the log").
- **No log vs a failed read.** `open` rejecting with `ENOENT`: front unknown, state cleared, no line. Any other failure
  (open, fstat, read): a gap, state cleared, `[cmux] events · gap`. Neither throws. The first read after a `reset()` (or
  ever) clears the state too but says no gap line; a new `boot_id` clears it and says none either.
- **"Dropped first partial line"** applies only when the read starts past byte 0.
- **Oldest goes** for the 256 workspaces and 16 windows means least recently set (a `Map` re-inserted on each set).
- **Ids** are kept in lower case once `CMUX_ID` (`HO/hostDetect.ts`) took them; the front surface is matched as
  `cmuxPaneKey(surface)`.
- **A line is applied** only when its substring test passed, it is at most 16 KiB, `JSON.parse` gives an object whose
  `type` is `"event"` and whose `name` is one of the eight, and every id the event uses passes `CMUX_ID`; else it is
  skipped. The substring test alone never applies a line (a prompt preview quoting the words is escaped JSON, and its
  parsed `name` is another).
- **One read at a time.** `read()` called while one runs returns one shared promise of the one read that runs after it;
  ten calls give one more read. `reset()` while a read runs makes that read commit nothing and answer `{}`.
- **"Changed since the last read."** The devices keep the last known front surface (`cmuxLast`). A read whose front has
  no surface changes nothing and leaves `cmuxLast` as is, so a failed read or a window-ambiguous selection followed by
  the same surface again turns nothing back. It is cleared with the reader.
- **Skip lines and order** (as `herdrFocused`): not changed and not a settle → nothing, no line; no dial linked →
  nothing; echo (`[device] cmux focus · skipped · echo`); no agent or two (`… · unknown agent`); cmux not the settled
  and latest front app as the read ends (`… · not in front`). A front with no surface says nothing.
- **The read's time** is said as the cmux source says its own: `[cmux] read · events · <ms>`, for the first read after a
  reset and then only for a read slower than every one said.
- **The nameless change** keeps today's all-agents `sessions list` run and also calls `events()`. A change of
  `events.jsonl` calls `events()` and starts no run. Changes while the stores' folder is not there call nothing.
- **The agent at a surface** (`cmuxAgentAt`): the cmux source's listed rows holding that pane key give their
  `engine`+`sessionId`; the live entries of `registry.entries()` whose `paneKeys` hold the key, or whose engine and
  session id are one of those rows', are the candidates; exactly one is followed. No `followPage`: cmux's agents are on
  cmux's own page.
- **Reset** happens at the dial's detach and whenever an attach leaves the cmux source stopped (cmux not found); a read
  landing after a reset is dropped by an epoch the devices hold.

## Global Constraints

- macOS only; nothing of this runs on Linux or Windows (`cmuxSource` and so `cmuxFocus` exist only on darwin).
- Nothing in `cli/src/core/`; no new process, file, frame, request, setting or state file.
- `events.jsonl` opened `O_RDONLY`, never written, truncated, renamed or deleted.
- Bounds: 1 MiB a read (`MAX_EVENTS_READ = 1024 * 1024`), 16 KiB a line (`MAX_EVENT_LINE = 16 * 1024`), 256 workspaces
  (`MAX_WORKSPACES`), 16 windows (`MAX_WINDOWS`), one read at a time.
- Echo windows: `TAB_ECHO_MS` (2 s, via `dialMovesTo()`) and `ATTACH_ECHO_MS` (2 s) as they are in `SV/devices.ts`.
- Log lines are fixed words and numbers only: `[cmux] events · gap`, `[cmux] read · events · <ms>`,
  `[device] cmux focus · skipped · echo | unknown agent | not in front`. Never an id, path, title or payload value.
- `SV/devices.ts` stays at 100% per-file coverage (`npm run test:core`).
- Comments say why (cli/AGENTS.md rule 7); names follow `docs/naming-system.md`.

## Review Focus

1. **A dial tap into another workspace.** cmux logs `workspace.selected` (front = that workspace's old surface) before
   `surface.focused` (the tapped one); a read between the two sees the old surface, which the echo rule alone does not
   excuse, and the dial would leave the agent it was turned to. Open question 2; Task 3 holds the test for the
   recommended answer.
2. **A dial turned by hand stays put.** A working agent's hooks append lines many times a second while cmux is in
   front; none of them may turn the dial back to the front surface's agent. Task 3: after a follow and a hand turn, 20
   non-focus lines and a repeated `surface.focused` of the same surface ask no `followLocal`.
3. **cmux restarted.** A new `boot_id` with stale workspace→surface entries must not name an old surface as the front.
   Task 1: after a boot change, a `window.keyed` naming a workspace whose surface was known only before it gives
   `{ workspace }` with no surface.
4. **The log rotated or rewritten while cmux is in front** (renamed to `events.jsonl.1`, a new short file). Task 1: a
   new identity, and a size below the offset, each read as a gap from the new file's last 1 MiB, never a stale offset.
5. **Upper-case ids.** cmux prints upper-case UUIDs, hooks may carry either case. Task 3: a hooked agent whose hints are
   upper case and a log in upper case is followed; Task 1: ids come back lower case.

---

### Task 1: The log's reader (`HO/cmuxFocus.ts`)

**Effort:** xhigh (a reader of another program's file: bounds, rotation, partial lines, data kept).
**Depends on:** none.

**Files:**
- Create: `cli/src/cable/hosts/cmuxFocus.ts`
- Create: `cli/src/cable/hosts/cmuxFocus.spec.ts`
- Modify: `cli/src/testing/fakeCmux.ts` (two exports: `cmuxEventLine`, `fakeCmuxLog`)
- The spec and the plan are already committed: do not add them again.

**Interfaces:**
- Produces (`HO/cmuxFocus.ts`):
  - `export const CMUX_EVENTS = 'events.jsonl'`, `MAX_EVENTS_READ`, `MAX_EVENT_LINE`, `MAX_WORKSPACES`, `MAX_WINDOWS`
  - `export interface CmuxLogFiles { open(path: string): Promise<number>; fstat(fd: number): Promise<{ dev: number; ino: number; size: number }>; read(fd: number, into: Buffer, position: number): Promise<number>; close(fd: number): Promise<void> }`
  - `export function cmuxLogFiles(): CmuxLogFiles` (node:fs, `O_RDONLY` only)
  - `export type CmuxFront = { workspace?: string; surface?: string }` (lower case)
  - `export interface CmuxFocusDeps { files: CmuxLogFiles; path: string; monotonic(): number; log(line: string): void }`
  - `export interface CmuxFocus { read(): Promise<CmuxFront>; reset(): void }`
  - `export function createCmuxFocus(deps: CmuxFocusDeps): CmuxFocus`
- Produces (`TS/fakeCmux.ts`):
  - `cmuxEventLine(name: string, ids?: { boot?: string; seq?: number; workspace?: string; surface?: string; pane?: string; window?: string }, payload?: Record<string, unknown>): string`
    — one line as v0.65.2.2 writes it: keys sorted at every level, `type: "event"`, unset ids left out, a trailing `\n`.
  - `fakeCmuxLog(): CmuxLogFiles & { opens: number; positions: number[]; append(text: string): void; rotate(): void; rewrite(text: string): void; remove(): void; failNext(): void; hold(): () => void }`
    — an in-memory file: `positions` records each `read`'s position, `rotate()` gives a new `ino` and an empty file,
    `rewrite()` the same `ino` with shorter content, `remove()` makes `open` reject with `ENOENT`, `failNext()` makes the
    next `read` reject, `hold()` makes the next `read` wait until the function it returns is called.

- [ ] **Step 1: Write the failing tests** in `cmuxFocus.spec.ts`, on `fakeCmuxLog()` and `cmuxEventLine()`, ids as
  upper-case UUIDs (`W1`, `W2`, `S1`…, `WIN1`, `WIN2`), boot `B1`:
  - `surface.focused (W1,S1)` then `window.keyed` (`payload.workspace_id: W1`) → `read()` is `{ workspace: w1, surface: s1 }`.
  - `pane.focused` with `payload.selected_surface_id: S2` in W1 → surface `s2`.
  - One window known: `workspace.selected W2` with W2's surface known → `{ w2, s2 }`; with W2's unknown → `{ workspace: w2 }`.
  - Two windows (`window.created WIN1`, `window.keyed WIN2`): `workspace.selected W2` → `{}`; the next `window.keyed`
    → its workspace. `window.closed WIN2` → one window again, `workspace.selected` sets the front.
  - `surface.closed S1` → W1 has no surface (`{ workspace: w1 }`); `workspace.closed W1` → `{}`.
  - A new `boot_id` clears every workspace's surface (Review Focus 3).
  - Gap by `rotate()`, by `rewrite()` shorter than the offset, and by appending more than 1 MiB of non-focus lines with a
    focus line at the end: each reads only the last 1 MiB, says `[cmux] events · gap` once, and gives the focus at the
    end; a first read says no gap.
  - A line split across two appends (two reads) is applied once, whole; a line past 16 KiB holding
    `"name":"surface.focused"` is skipped and the next line is applied.
  - A prompt line (`workspace.prompt.submitted`, preview text containing `"name":"surface.focused"`) changes nothing; a
    focus line whose ids are not UUIDs changes nothing; a line that is not JSON changes nothing.
  - `remove()` → `{}`, no line, no throw; `failNext()` → `{}`, a gap, and the next read rebuilds from the last 1 MiB.
  - 257 workspaces: the least recently set is forgotten; 17 windows: the oldest is forgotten.
  - Ten `read()` calls during one read give exactly one more read (count `fstat` calls); `reset()` during a read: that
    read answers `{}` and the next read is a first read.
  - Every log line matches `/^\[cmux\] (events · gap|read · events · \d+)$/`; no line or returned value contains a
    payload value (a `title`, `cwd` and `preview` given in payloads).
  - On a real temp file with mode `0o400` (real timers), `createCmuxFocus({ files: cmuxLogFiles(), … })` reads it, and
    its bytes and `mtimeMs` are the same after (proves `O_RDONLY`).

- [ ] **Step 2: Run them to verify they fail**
  Run: `npx vitest run src/cable/hosts/cmuxFocus.spec.ts`
  Expected: FAIL (`cmuxFocus.js` not found).

- [ ] **Step 3: Implement `createCmuxFocus` and `cmuxLogFiles`** as the spec's "The log's reader" and this plan's
  decisions say. Read the new bytes in one `read` at `max(offset, size - MAX_EVENTS_READ)`; close the fd in a `finally`;
  carry the partial last line (at most `MAX_EVENT_LINE`, else skip to the next newline). Header comment: why the log and
  not the socket (cmuxOnly refuses the daemon), and that lines name people's work, so nothing but ids is taken.

- [ ] **Step 4: Run them to verify they pass**
  Run: `npx vitest run src/cable/hosts/cmuxFocus.spec.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit** the five files: `Dial: a read-only reader of cmux's event log (cmux focus follow)`.

### Task 2: When it reads (`HO/cmuxSource.ts`, `SV/devices.ts`)

**Effort:** xhigh (devices process wiring, a read gated by front, attach and detach; concurrency with resets).
**Depends on:** Task 1.

**Files:**
- Modify: `cli/src/cable/hosts/cmuxSource.ts` (`CmuxSourceDeps.events`, `changed`)
- Modify: `cli/src/cable/hosts/cmuxSource.spec.ts`
- Modify: `cli/src/services/devices.ts` (`DevicesDeps.cmuxEvents` ~line 174; the cmux source's construction ~962-985;
  `appSettled` ~1418; a new section `// ── the surface focused in cmux ──` after herdr's (~2436); `dialAttached` ~2447-2513)
- Modify: `cli/src/services/devices.spec.ts` (`start()`'s `over.cmuxEvents`; a new `describe('cmux', …)` inside
  `the dial follows the pane focused in tmux and herdr` or beside it, on `withCmux`-style setup)

**Interfaces:**
- Consumes: Task 1's `createCmuxFocus`, `cmuxLogFiles`, `CMUX_EVENTS`, `CmuxFront`; `TS/fakeCmux.ts fakeCmuxLog`.
- Produces: `CmuxSourceDeps.events(): void`; `DevicesDeps.cmuxEvents?: CmuxLogFiles`; in `devices.ts`:
  `cmuxRead(): Promise<CmuxFront | undefined>` (undefined: the read landed after a reset, by an epoch `cmuxReads` bumped
  at each reset), its two callers (the source's `events` and cmux's settle), and `dropCmuxFocus(): void`. Task 3 hands
  each caller's front on to the follow.

- [ ] **Step 1: Write the failing tests.**
  `cmuxSource.spec.ts`, `describe('the watch')`: `changed('events.jsonl')` calls `events` once and asks `sessions`
  nothing; `changed()` calls `events` once and asks every agent once (as today); `changed('claude-hook-sessions.json')`
  and `changed('events.jsonl.1')` do not call `events`; with the folder gone, `changed('events.jsonl')` calls nothing.
  `devices.spec.ts`, a `fakeCmuxLog()` as `cmuxEvents`, cmux installed (`withCmux`'s client), the log holding a
  `surface.focused` and a `window.keyed`:
  - no dial: `host().front('cmux')` and settle, then a change of `events.jsonl` → `opens` is 0;
  - dial attached, another app settled: a change → `opens` 0;
  - dial attached, cmux settles → exactly one open (the settle read); each change after → one more read each;
  - cmux leaves the front (another app settled) → a change opens nothing;
  - detach → `reset`: the next attach's settle read starts at byte 0 again (`positions`);
  - cmux not found at attach (`fake.found = false`) → its settle reads nothing;
  - `[cmux] read · events · <n>` said for the first read only, while later reads are not slower.

- [ ] **Step 2: Run them to verify they fail**
  Run: `npx vitest run src/cable/hosts/cmuxSource.spec.ts src/services/devices.spec.ts -t "cmux"`
  Expected: FAIL (`events` not called; `cmuxEvents` unknown).

- [ ] **Step 3: Implement.** `cmuxSource.ts changed`: after the folder checks, `file === undefined || file === CMUX_EVENTS`
  calls `deps.events()` before the existing branches. `devices.ts`: build `cmuxFocus` beside `cmuxSource` (same darwin and
  `observed` guard) with `path: join(cmuxStoresAt, CMUX_EVENTS)`; `events: () => part.call('cmux', () => dialOn &&
  cmuxFound && cableHost.settledApp() === 'cmux' ? cmuxRead() : undefined)`; `appSettled`: `if (app === 'cmux')
  part.call('cmux', () => dialOn && cmuxFound ? cmuxRead() : undefined)`; `dialAttached`: `dropCmuxFocus` when the
  dial goes and when the cmux part leaves the source stopped. Section comment: push, zero reads behind other apps, one
  catch-up read at the settle, and why (spec "Decided" 1-2).

- [ ] **Step 4: Run them to verify they pass**
  Run: `npx vitest run src/cable/hosts/cmuxSource.spec.ts src/services/devices.spec.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit** the four files: `Dial: read cmux's event log while cmux is in front with a dial attached`.

### Task 3: Who is followed (`SV/devices.ts`)

**Effort:** xhigh (the never-a-wrong-session rule, echo timing).
**Depends on:** Task 2.

**Files:**
- Modify: `cli/src/services/devices.ts` (`cmuxFocuses` beside `herdrFocuses` ~663; `cmuxAppNoted` ~676; the cmux
  section from Task 2)
- Modify: `cli/src/services/devices.spec.ts` (the `cmux` describe from Task 2)

**Interfaces:**
- Consumes: Task 2's `cmuxRead()`, its two callers and `dropCmuxFocus`; `cmuxPaneKey` (`HO/cmuxCli.ts`);
  `registry.entries()`; `cmuxSource.list()`.
- Produces: `let cmuxLast: string | undefined` (cleared in `dropCmuxFocus`); `cmuxFocused(front: CmuxFront, settle: boolean): Promise<void> | undefined`,
  called by both of Task 2's callers (`settle` true for cmux's settle); `cmuxFocuses = dialMovesTo()`; `cmuxAppNoted = noting({ ...cmuxApp, focus, show })`, each noting
  `cmuxApp.paneKey(pane)` as it starts and dating the note from its end (`.finally(ended)`), as `herdrNoted`;
  `cmuxAgentAt(surface: string): HostAgent | undefined`; `cmuxFocused` follows with `cable.followLocal(agent.id, 'pane')`;
  `dropCmuxFocus` also clears `cmuxFocuses`.

- [ ] **Step 1: Write the failing tests** (the spec's devices list, then Review Focus 1, 2 and 5), with
  `followLocal` read from `calls('followLocal')` and lines from `logs`:
  - pane switch: dial on, cmux settled, a hooked Claude Code in surface S1 and one in S2 (hints `IN_CMUX`-style, upper
    case), append `surface.focused (W1,S2)` → `followLocal(<S2's agent>, 'pane')`;
  - workspace switch: one window, `workspace.selected W2` whose surface is known → its agent followed;
  - cmux settling: the log's front is S1 → the settle follows S1's agent; a dial move (`noteMove`, e.g. a turn) within
    2 s before the settle → `[device] cmux focus · skipped · echo`, no follow;
  - the open scan's copy (`scanned()` + a cmux row at S1 with `sessionId: 'sess-1'`) is followed at S1;
  - a surface with no agent (a shell) and two live agents at one surface → `unknown agent`, no follow; an ended entry at
    the surface beside a live one → the live one is followed;
  - a front with no surface (two windows, `workspace.selected`) → no follow and no line;
  - the dial's own tap on S2's agent (`host().open(...)` through `cmuxAppNoted`), then the log's `surface.focused S2` →
    `echo`, no follow; after 2 s the same surface appended again is not followed (unchanged);
  - cmux left the front while the read ran (hold the read, settle another app, land it) → `not in front`;
  - no dial linked (`connected = false`) → nothing followed, no line;
  - a read under way at the detach (`hold()`), landed after it → nothing followed, no line;
  - Review Focus 2: after a follow, a hand turn, 20 non-focus lines and one repeated `surface.focused` of the same
    surface → no further `followLocal`;
  - Review Focus 1 (for Open question 2's recommended answer): a tap on S3 in W2 whose known surface is S2; the log
    gets `workspace.selected W2`, a read lands, then `surface.focused S3` and a read → no `followLocal` at all;
  - every `[device] cmux focus` line matches `/^\[device\] cmux focus · skipped · (echo|unknown agent|not in front)$/`.

- [ ] **Step 2: Run them to verify they fail**
  Run: `npx vitest run src/services/devices.spec.ts -t "cmux"`
  Expected: FAIL (no `followLocal` with cause `pane` for cmux).

- [ ] **Step 3: Implement** `cmuxFocused` in the order of this plan's "Skip lines and order"; the echo check is
  `settle && dialMovedAt within ATTACH_ECHO_MS`, then `cmuxFocuses.echo(key, monotonic())` (plus `|| cmuxFocuses.unseen(at)`
  if Open question 2 is answered yes); `cmuxAgentAt` as "The agent at a surface" says; the in-front check is
  `cableHost.settledApp() === 'cmux' && cableHost.latestFront() === 'cmux'`. Comment the hard rule (spec "Who is
  followed") and why there is no `followPage`.

- [ ] **Step 4: Run them to verify they pass**
  Run: `npx vitest run src/services/devices.spec.ts && npm run typecheck && npm run test:core`
  Expected: PASS; `SV/devices.ts` at 100%.

- [ ] **Step 5: Commit** the two files: `Dial: a focus move in cmux turns the dial to its agent`.

### Task 4: The devices row in `cli/AGENTS.md`

**Effort:** medium (docs, one file). No failing test: it changes no behavior; one commit.
**Depends on:** none (it names only what this plan fixes: `cable/hosts/cmuxFocus.ts`, `services/devices.ts`
`cmuxFocused`).

**Files:**
- Modify: `cli/AGENTS.md` (the `devices` row of "The processes" table)

- [ ] **Step 1: Add the clause** right after herdr's, i.e. after "…herdr's lookup of the app holding its client is
  macOS and Linux only;" and before "a Zellij, kitty, WezTerm, Orca or herdr pane typed into…", in the row's style: the
  surface cmux says has the focus moves the dial to its agent with no poll; the tail of cmux's own event log
  `~/.cmuxterm/events.jsonl`, opened read-only and never written, read when the cmux source's watch tells it changed,
  only while cmux is settled in front and a dial is attached, and once as cmux settles; at most 1 MiB a read and 16 KiB a
  line; only the event's name, `boot_id` and its workspace, surface and window ids taken, of its focus, selection,
  key-window and close events alone; an offset, the file's identity, the boot id, up to 256 workspaces' surfaces and 16
  windows kept in memory until the dial goes; with two cmux windows known only `window.keyed` names the front workspace;
  followed only when exactly one live agent is at that surface, and the dial's own cmux moves of the last 2 s are not
  followed back; on macOS (`cable/hosts/cmuxFocus.ts`, `services/devices.ts` `cmuxFocused`).

- [ ] **Step 2: Commit** `cli/AGENTS.md`: `Docs: the devices follow cmux's focus`.

## Verification

Every check runs on the final head, after the final review's fixes. Isolation: no real cmux, tmux or herdr is run or
read; cmux is not installed on this Mac and nothing installs it. The unit specs use `fakeCmuxLog()` and the devices
specs' throwaway home (`homedir()` is the suite's own); the eval's tiers run their own isolated daemons, homes, data
folders, ports, private tmux and herdr, fake apps and `FakeBackend` (test accounts only). No production backend.

1. **Unit, typecheck and coverage, on this Mac.** `npm run typecheck`; `npx vitest run src/cable/hosts/cmuxFocus.spec.ts
   src/cable/hosts/cmuxSource.spec.ts src/cable/hosts/cmuxCli.spec.ts src/cable/hosts/cmuxApp.spec.ts
   src/services/devices.spec.ts src/testing/fakeLogs.spec.ts`; `npm run test:core` (required: `src/services/` changed;
   every file at 100%; PR CI does not run it). Then `python3 scripts/local-checks.py --run` from the repo root on a
   clean tree, its output in the PR body before the push. Seen: all green.
2. **The read's cost, on this Mac (numbers for the PR, hot path rule 4).** A throwaway script in the scratchpad (not
   committed) runs `createCmuxFocus` with `cmuxLogFiles()` on a temp file: a first read of a 1 MiB log of non-focus
   lines with focus lines among them, then 100 reads of one appended hook-sized line each. Seen: the first read's ms and
   the median and worst of the 100, listed in the PR. There is no "before": the path is new, and it runs only while cmux
   is in front.
3. **Tier A, all apps, on this Mac.** `npx vitest run src/testing/dialAppEval/dialAppEval.spec.ts`. Seen: every
   scenario passes, `matches the baseline` among them (no cmux scenario exists; a change here is a finding).
4. **Both tiers, the tester on this Mac, one run, only once the PM gives the turn** (one eval run on this Mac at a time):
   `OUT=$(mktemp -d); DIAL_EVAL_OUT="$OUT" TMPDIR=/tmp caffeinate -i npm run eval:dial-apps -- --update-baseline`.
   It runs tier A's spec, then tier B's files (`dialAppEvalClaude`, `dialAppEvalChatgpt`, `dialAppEvalVscode`,
   `dialAppEvalCursor`, `dialAppEvalOrca`, `dialAppEvalIterm` (macOS only), and the held-out file, which nobody opens,
   nor its scenarios or results' evidence). The gate, read from `$OUT/report.md` and `report.json`:
   - `Gate: passed`, 0 wrong-session sends. One wrong send: stop and ask the PM before any baseline is kept;
   - no app's score below its `baseline.json` value on `main`. A lower score only from timed checks (`timed` in the
     results) or `grade.ts RACED_B`'s keys is the runner's noise by the eval's rules, not a drop; a pass/fail check that
     was 1 and is below 1 is a drop;
   - `git diff cli/src/testing/dialAppEval/baseline.json`: empty → nothing to commit; changed with the gate passed and
     no drop → an implementer commits it alone as `Dial eval: baseline after the cmux focus follow`; any failed line
     above → `git checkout -- cli/src/testing/dialAppEval/baseline.json` and the failure is a finding.
   The tester reports the score table, the held-out count as printed, and that diff.
5. **PR CI, on its own, nothing started by hand:** `cli-typecheck`; `cli-tests` (tier A on Linux); `dial-hosts`
   (`cli/src/cable/hosts/` changed); `linux-e2e` (the dial app eval's six files, as `HO/` and `SV/devices.ts` changed);
   `windows-e2e` on x64 (`cli/src/cable/` changed: nothing of this runs there). Seen: each green. Tier B by hand on
   GitHub: `ci.yml`'s `workflow_dispatch` (scope `linux-e2e`, `e2e_files` naming them) only as a rerun of a failed job;
   no workflow runs `dialAppEvalIterm.e2e.ts` (macOS only), which check 4 covers.
6. **Needs Diego himself, after the release, not a merge gate:** with cmux installed and his own dial, cmux in front
   with two agents in two surfaces, he clicks the other surface, then switches workspace, then brings cmux forward from
   another app. He should see the dial turn to the agent there within about a second each time, stay put on a shell
   surface, and not turn back after he turns it by hand. No agent runs this check or reads his terminals or his log.
7. **Production:** none.

## What the pull request says

- Platforms: macOS only (cmux runs only there); Linux and Windows unchanged.
- Data: the spec's Data section (read-only, ids only, in memory, nothing stored or sent).
- Numbers: check 2; the eval's score table and `baseline.json`'s diff, or "unchanged".
- `npm run test:core`'s receipt; that no cmux end-to-end exists (no cmux on any runner), so the follow is proved by the
  devices specs and the eval guards against drops.

## Proposals (not in this branch)

- A cmux scenario in the dial app eval (a fake cmux event log beside the fake apps), so later pull requests measure the
  follow's latency and wrong-session count on cmux too.

## Answered by the PM (2026-11-25)

1. **A dial attached while cmux is already settled in front:** yes. Once the attach's cmux source has started, one
   settle read runs, as Orca's settle does at such an attach. Task 2 adds the call in `dialAttached` and a test: attach
   with cmux settled → one settle read, its agent followed.
2. **The moment between a dial tap's two cmux events:** yes. A front change is skipped while a dial move to cmux is
   still unseen (`cmuxFocuses.unseen(at)`, as the ChatGPT thread follow does), for at most 2 s. Task 3's Review Focus 1
   test is written for this.
