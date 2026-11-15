# The dial and the terminal apps follow each other, tab by tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use diegodev phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A swipe that rests on an agent in macOS Terminal, iTerm2 or Ghostty selects its tab, and selecting a tab there turns the round dial to that tab's agent.

**Architecture:**
- **Harness Device** (Rust) sends every Apple Event itself, from fixed scripts. While a tab app is in front, a watch runs and the dial is attached, it asks for the selected tab's tty every 500 ms and writes a `tab` line on the watch's stdin. It reads `select` lines from the watch's stdout and selects that tab; a tap's line says `"raise":true`, and its window is raised too.
- **`harness hardware watch`** carries both ways: a `tab` line becomes a `tab` message to the devices' own listener, and each line of the listener's `tabs` stream becomes a `select` line on stdout.
- **The devices process** reads each outside agent's tty once per pid with `ps`. A rest writes the agent's `{app, tty}` on the stream; a tap runs `open -b`, then writes the same line with `"raise":true`. A tab report turns the dials through the path a person's prompt takes (`CableSession.followLocal`), once its app has settled in front, unless it echoes the dial's own select.
- Everything is in memory. Nothing goes through the core, no firmware, no Desktop UI, no Flutter.

**Tech Stack:** TypeScript daemon and CLI (Node, vitest, `cli/`); Rust and Tauri 2 (`device-app/src-tauri`), `objc2-foundation`'s `NSAppleScript`.

**Spec:** `docs/specs/2026-11-15-dial-terminal-follow.md`.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/cableSession.ts`, `cableFleet.ts`, `cableHost.ts` | **Devices service process** | Their specs |
| `cli/src/cable/hosts/tabs.ts` (new), `observed.ts`, `appFilter.ts` | **Devices service process**; `tabs.ts` is also loaded by the CLI's watch | Their specs (`appFilter.spec.ts` keeps its file at 100%) |
| `cli/src/services/devicesListener.ts`, `devices.ts` | **Devices service process** | 100% per file (`npm run test:core`) |
| `cli/src/devices/client.ts`, `listenerClient.ts` | The CLI: `harness hardware watch`, a process the Harness Device app starts | Their specs |
| `device-app/src-tauri/src/tabs.rs` (new), `tabs_macos.rs` (new), `watch.rs`, `runner.rs`, `main.rs`, `lib.rs`, `Cargo.toml`, `Info.plist`, `Entitlements.plist` (new), `tauri.conf.json` | Harness Device, a process of its own | `cargo test --lib`; PR CI compiles Linux only, macOS by hand |
| `cli/e2e/dialTerminalFollow.e2e.ts` (new) | Test: the real daemon, a fake dial, the real watch, Claude Code on a pty | By hand on a Mac (macOS only) |
| `cli/AGENTS.md`, `cli/src/services/AGENTS.md`, `device-app/AGENTS.md` | Repo files, no process | none |

No file under `cli/src/core/` changes, and `src/architecture.coreFiles.txt` gains no line (cli/AGENTS.md, Protect the core, rule 7).

## Stack and external prerequisites

- **Base.** `feat/dial-pane-follow` at `cb84872467` (PR #4311). This branch is stacked on it.
- **The sibling branch** `dial-claude-app-follow` has the same base and changes the same follow code. Task 1 holds the two shapes both branches share and nothing else. When its commits are in, the main session hands its SHA to that branch's session. That branch adds the `claude` pane kind, the `attach` cause's behavior and `attachHandler`; this plan adds none of them.
- If that branch lands the two shapes first, Task 1 becomes a rebase onto its SHA and a check that the names match "Interfaces" below. The main session says which.

## Global Constraints

- **Tab apps.** `terminal-app`, `iterm`, `ghostty`, and no other. Every hop checks `app` against that list and `tty` against `^/dev/ttys[0-9]{1,4}$`, and drops a line that fails either.
- **Lines.**
  - Harness Device → watch stdin: `{"tab":{"app":"terminal-app","tty":"/dev/ttys023"}}`, under 140 bytes, one pipe write.
  - Watch → listener: `{"type":"tab","app":"terminal-app","tty":"/dev/ttys023"}`, 96 bytes at most, 10 a second per connection.
  - Watch → listener: `{"type":"tabs"}`, answered by an NDJSON stream; 2 opens a second per connection.
  - Stream line: `{"app":"terminal-app","tty":"/dev/ttys023"}`. Watch stdout: `{"select":{"app":"terminal-app","tty":"/dev/ttys023"}}`.
  - A tap's stream line and stdout line also hold `"raise":true`, after `tty`. Only a tap sets it; a swipe's line has no `raise` key. Every hop checks `raise` is a boolean or absent, and drops a line that fails. `false` reads as absent.
  - The `front` line and message do not change.
- **Fixed scripts.** Every AppleScript is fixed text in Harness Device. A tty enters only as an `NSAppleEventDescriptor` handler parameter, after the tty check, and is never put into script text. The script is chosen from Harness Device's own table keyed by app id. No bundle id or name from the daemon is used.
- **Nothing but ttys and selection.** No script reads a title, name, working directory, history or contents. No script says `activate`.
- **Polling.** Every 500 ms, only while a tab app is in front, a watch runs and the last dial status said attached. It stops at once otherwise. No two calls overlap. Each call has a 2 s Apple Event timeout.
- **Several windows.** A tab report is the front window's selected tab. A select searches every visible window, and raises the window only while the app is frontmost. Ghostty selects only while Ghostty is frontmost.
- **A tap.** `open -b` first, as #4296 does, then the select with `"raise":true`. The flag only picks a second fixed handler, `focus_tty(tty)`, instead of `select_tty(tty)`: it selects the tab and raises the window that holds it, in Ghostty too, whether or not the app is frontmost. It is fixed text like the others, and the tty is its parameter.
- **The settle.** A tab report is acted on only when its app is the settled front (`FRONT_SETTLE_MS`, 1 s).
- **The echo window** is 2 s. Every select of the last 2 s is kept, at most 8, not only the last one.
- **The entitlement.** The bundle's entitlements file holds `com.apple.security.automation.apple-events` and no other key (`bundle.macOS.entitlements`). The pull request says so.
- **The stream** (the PM's limits): one open stream across every connection, and a newer one ends the older; a socket that closes, errors or does not drain in 2 s ends it; one stream per connection, which sends no other message; opening is rate-limited. Nothing is queued for a stream that is not open.
- **The tty of an agent:** `ps -o tty= -p <pid>` through `execFile`, 1 s timeout, 256-byte output bound, once per pid. `??` is no tty.
- **macOS only.** Off macOS the daemon gives no agent a tab and Harness Device reports none. The same watch code runs everywhere, with no platform switch.
- **Measures**, with no tty, title, agent or session in any line:
  - Devices log: `[device] tab · moved | no-tile | not-in-front | no-agent | echo`, and the existing `[device] swipe · <outcome>`.
  - Harness Device log: `tabs: <App> select ok | none | failed`, `tabs: <App> not allowed`, `tabs: Ghostty has no tty`, and one poll-failure count line a minute.
- **device-app rules** (`device-app/AGENTS.md`): fixed arguments; the app in front is private; one log, redacted; no other component's path in a string.
- **Repo rules.** Tests never touch the developer's real `~/.claude`, daemon (port 18473), tmux or dial. No fixed sleeps. `src/services` stays at 100% per file.

## Review Focus

1. **A report for a tab the dial selected one rest earlier.** A swipe rests on A, then on B; A's report lands after B's select. The dial must not be pulled back to A. Task 6 (`a report for a tty the dial selected before its latest select is still an echo`).
2. **A session resumed in another tab,** with the same session id and a new pid. A swipe must select the new tab, and a report for the old tty finds no agent. Task 5 (`a new pid reads again, and the old tty is gone at once`).
3. **A watch that stops reading its stream** (hung, stopped). The listener ends the stream in 2 s and frees its connection; a rest then counts `failed`, and the next watch's stream opens. Task 3 (`a client that stops reading`), Task 5 (`a stream that ended since the turn is failed`).
4. **A report whose app left the front.** It is dropped when another app settles, and is not acted on when its own app comes back later. Task 6 (`a report is dropped when another app settles`).
5. **macOS's consent prompt left open for minutes.** The selects that came meanwhile must not run when it is answered, and polling goes on. Task 8 (`a_select_that_waited_behind_a_call_over_two_seconds_is_dropped`).

---

### Task 1: The shared shapes: `followLocal`, and panes by kind

**Layer:** devices service process. **Depends on:** none. **Effort:** `high`.

**Red test:** the renamed calls in `cableSession.spec.ts`, `cableFleet.spec.ts`, `cableHost.spec.ts` and `devices.spec.ts`. The pane dispatch has none: no behavior, and `observed.spec.ts` passes unchanged.

**Files:**
- Modify: `cli/src/cable/cableSession.ts`, `cli/src/cable/cableFleet.ts`, `cli/src/cable/cableHost.ts`, `cli/src/cable/hosts/observed.ts`, `cli/src/services/devices.ts`
- Test: `cli/src/cable/cableSession.spec.ts`, `cli/src/cable/cableFleet.spec.ts`, `cli/src/cable/cableHost.spec.ts`, `cli/src/services/devices.spec.ts`

**Interfaces:**
- Produces, in `cableSession.ts`:
  - `export type FollowCause = 'prompt' | 'tab' | 'attach'`
  - `CableSession.followLocal(agentId: string, cause: FollowCause): Promise<void>`, which replaces `followPrompt(agentId)`. Its rules and their order do not change. One generation serves every cause: a later follow wins.
  - `CableHost.localFollowed?(cause: FollowCause, outcome: 'moved' | 'no-tile'): void`, which replaces `promptFollowed?(outcome)`.
- Produces, in `cableFleet.ts`: `followLocal(...args: Parameters<Surface['followLocal']>)`, which replaces `followPrompt`.
- Produces, in `cableHost.ts`: `CableHostWiring.localFollowed?: (cause: FollowCause, outcome: 'moved' | 'no-tile') => void` and `DaemonCableHost.localFollowed(cause, outcome)`, which replace `promptFollowed`.
- Produces, in `services/devices.ts`, one table of lines by cause. Each branch adds its own row:
  ```ts
  const FOLLOWED: Partial<Record<FollowCause, Record<'moved' | 'no-tile', string>>> = {
    prompt: { moved: '[device] prompt · moved', 'no-tile': '[device] prompt · skipped · no tile' },
  }
  ```
  `localFollowed` logs the cause's line, and nothing for a cause with no row. The local `followPrompt(agentId, source)` keeps its name and calls `cable.followLocal(agentId, 'prompt')`.
  > Rebase onto main (after #4326): FOLLOWED is now a complete `Record<FollowCause | 'settle', …>`, a row for every cause; the partial table above is history.
- Produces, in `observed.ts`, module-private:
  - `type ShownPane = { kind: 'orca'; handle: string }`
  - `private shownPane(agent: HostAgent): ShownPane | undefined`, which replaces `paneHandle`.
  - `hasPane` is `shownPane(agent) !== undefined`. `showPane` is a `switch` on `pane.kind`, whose `'orca'` case calls `actions.orcaSwitch(pane.handle)`.
  - A later kind is one union member, one line in `shownPane`, one `case` and one `ObservedActions` member.

- [ ] **Step 1: Write the failing tests:**
  - `cableSession.spec.ts`: every `followPrompt(x)` becomes `followLocal(x, 'prompt')`, and every `promptFollowed` mock becomes `localFollowed`, whose calls read `['prompt', 'moved']` and `['prompt', 'no-tile']`.
  - `followLocal tells the host its cause`: `followLocal('a2', 'tab')` gives `[['tab', 'moved']]`; for an agent the list lacks, `[['tab', 'no-tile']]`.
  - `a later follow of another cause wins over an earlier one's read` (the spec file's `heldRead` helper: `followLocal('a2', 'prompt')` held, then `followLocal('a3', 'tab')`: one focus, for `a3`).
  - `cableFleet.spec.ts`: `followLocal reaches each attached dial`, with its cause.
  - `cableHost.spec.ts`: `localFollowed reaches the wiring` (`[['prompt', 'moved'], ['tab', 'no-tile']]`).
  - `devices.spec.ts`: `FakeCable.followLocal = recorder('followLocal')`; a person's prompt asks `[[ID, 'prompt']]`; `seen.host.localFollowed!('prompt', …)` writes the two prompt lines as before; `a follow of a cause with no line writes none` (`'attach'`).
    > Rebase onto main (after #4326): with the complete table every cause has a line, so this last test went.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts src/cable/cableFleet.spec.ts src/cable/cableHost.spec.ts src/services/devices.spec.ts`. Expected: FAIL (`followLocal` is not a function).
- [ ] **Step 3: Implement.** `git grep -n "followPrompt\|promptFollowed" -- cli/src cli/e2e` shows no use left but the local helper in `devices.ts`.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable/hosts/observed.spec.ts && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`.
- [ ] **Step 5: Commit** `dial: a local follow names its cause, and a source shows a pane by its kind`. Report the SHA: the main session hands it to `dial-claude-app-follow`.

### Task 2: The tab apps, the tty check and the tty reader

**Layer:** devices service process, and the CLI's watch. **Depends on:** none. **Effort:** `medium`.

**Red test:** `cli/src/cable/hosts/tabs.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/tabs.ts`
- Test: `cli/src/cable/hosts/tabs.spec.ts`

**Interfaces:**
- Produces:
  - `export const TAB_APPS = ['terminal-app', 'iterm', 'ghostty'] as const`, `export type TabApp = (typeof TAB_APPS)[number]`
  - `export const TAB_TTY = /^\/dev\/ttys[0-9]{1,4}$/`
  - `export interface Tab { app: TabApp; tty: string }`
  - `export function isTabApp(app: unknown): app is TabApp`
  - `export function tabOf(value: unknown): Tab | null`: the `app` and `tty` of an object when both pass, and no other key of it.
  - `export type RunPs = (args: string[], bounds: { timeout: number; maxBuffer: number }) => Promise<string | null>` (stdout, or null when the run failed).
  - `export function readTty(pid: number, run?: RunPs): Promise<string | undefined>`: `/bin/ps -o tty= -p <pid>` through `execFile`, `{ timeout: 1_000, maxBuffer: 256 }`. The answer is trimmed and prefixed with `/dev/`. It is undefined unless it passes `TAB_TTY`.
- The module imports `node:child_process` and nothing of the daemon.

- [ ] **Step 1: Write the failing tests:**
  - `the tab apps are three of the app ids` (each is in `APP_IDS`).
  - `a tty is /dev/ttys and one to four digits`: takes `/dev/ttys0`, `/dev/ttys023`, `/dev/ttys9999`; refuses `/dev/ttys`, `/dev/ttys12345`, `/dev/pts/3`, `ttys023`, `/dev/ttys02a`, `/dev/ttys023\n`, `/dev/ttys023; rm`.
  - `tabOf takes an app of the three and a tty, and no other key`: `toStrictEqual({ app, tty })` for an object with extra keys; null for `orca`, `none`, `constructor`, a bad tty, a string, an array, null.
  - `readTty asks ps once for the pid, with 1 s and 256 bytes`: the run gets `['-o', 'tty=', '-p', '4242']` and `{ timeout: 1_000, maxBuffer: 256 }`; `'ttys023\n'` gives `/dev/ttys023`.
  - `??, nothing, a failed run and a tty the check refuses are no tty` (`'??\n'`, `''`, null, `'pts/3\n'`, `'ttys12345\n'`).
  - `a pid that is not a positive integer is not asked` (0, -1, 1.5, NaN).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/tabs.spec.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: the three tab apps, the tty check, and one ps for a pid's tty`.

### Task 3: The listener: the `tab` message and the `tabs` stream

**Layer:** devices service process. **Depends on:** Task 2. **Effort:** `xhigh` (connections, limits, the account's private socket).

**Red test:** `cli/src/services/devicesListener.spec.ts`.

**Files:**
- Modify: `cli/src/services/devicesListener.ts`
- Test: `cli/src/services/devicesListener.spec.ts`

**Interfaces:**
- Consumes: `Tab`, `tabOf` (Task 2).
- Produces:
  ```ts
  export interface ListenerStream {
    /** One NDJSON line. False, with nothing written, once the stream has ended or while an earlier line has not drained. */
    write(line: unknown): boolean
    /** Aborts when the stream ends. */
    readonly ended: AbortSignal
  }
  export interface ListenerStreamHandler {
    maxBytes: number
    perSecond: number
    /** `REFUSED` for a body that is not a message of its type. Otherwise the stream is open, and the handler's to write on. */
    open(message: Record<string, unknown>, stream: ListenerStream): typeof REFUSED | void
  }
  ```
  - `DevicesListenerOptions.handlers: Readonly<Record<string, ListenerHandler | ListenerStreamHandler>>`
  - `export const TAB_PER_SECOND = 10`, `export const TAB_MAX_BYTES = 96`, `export function tabHandler(report: (tab: Tab) => void): ListenerHandler`
  - `export const TABS_PER_SECOND = 2`, `export const TABS_MAX_BYTES = 32`
  - `export interface TabsStream { handler: ListenerStreamHandler; isOpen(): boolean; select(tab: Tab, raise: boolean): boolean }`, `export function tabsStream(): TabsStream`. `select` writes `{ app, tty }` as one line and is false with no open stream. With `raise` (a tap's) the line is `{ app, tty, raise: true }`; without it the line has no `raise` key.
- Rules of a stream, in the listener:
  - The answer is `200`, `Content-Type: application/x-ndjson`, headers sent at once, body left open.
  - Its connection's 2 s deadline is cleared. The connection still counts toward `LISTENER_MAX_CONNECTIONS`.
  - One open stream per type. A newer one ends the older first.
  - It ends when the client closes, the socket errors, a newer stream opens, a line has not drained 2 s after its write, or the listener closes.
  - Ending a stream destroys its connection: it has no deadline left to free its slot.
  - A request on a connection that holds a stream destroys that connection, counted `refused`.
  - Body size and rate are checked as for any type, before `open` runs. A handler that throws is `500`, counted `failed`.
- `tabHandler` hands on `tabOf(message)` and answers `REFUSED` when it is null. It keeps and logs nothing.

- [ ] **Step 1: Write the failing tests** (the spec file's `open` helper and real connections on a socket in a temp folder):
  - `a stream handler answers 200, its lines arrive as NDJSON, and it ends when the client closes` (`ended` aborts; a later `write` is false).
  - `a second stream of the type ends the first and closes its connection; the second goes on`.
  - `a stream outlives the 2 s deadline, and still counts as one of the 16` (15 more connections are taken, the next is closed).
  - `a client that stops reading: a line not drained in 2 s ends the stream and closes its connection, and a line while one waits is not written`.
  - `a socket that errors ends the stream at once`.
  - `a second message on a connection that holds a stream closes it, counted refused`.
  - `the third open in a second on one connection is 429, and the open stream stays`.
  - `a stream handler that refuses is 400 and opens nothing; one that throws is 500, counted failed`.
  - `close ends an open stream and leaves no timer`.
  - `tab takes each of the three apps with a tty, and hands on only app and tty`.
  - `tab refuses another app id, none and a bad tty`.
  - `a 97-byte tab is 413; the 11th tab in a second on a connection is 429`.
  - `tabs is open only while a stream is; select writes one {"app","tty"} line; with no stream it is false`.
  - `a select that raises writes "raise":true after app and tty; one that does not has no raise key` (`toStrictEqual` on each parsed line).
  - `a newer tabs stream is the one written to`.
  - `nothing logs or echoes a tty`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devicesListener.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devicesListener.ts`.
- [ ] **Step 5: Commit** `devices: the listener takes a tab report, and holds one select stream open`.

### Task 4: The cable host says when an app settles in front

**Layer:** devices service process. **Depends on:** Task 1 (`cableHost.ts`). **Effort:** `medium`.

**Red test:** `cli/src/cable/hosts/appFilter.spec.ts`, `cli/src/cable/cableHost.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/appFilter.ts`, `cli/src/cable/cableHost.ts`
- Test: `cli/src/cable/hosts/appFilter.spec.ts`, `cli/src/cable/cableHost.spec.ts`

**Interfaces:**
- Produces:
  - `AppFilterDeps.settled(app: string): void`, called at the end of each `settle(app)`, once `settledApp()` reads that app.
  - `CableHostWiring.frontSettled?: (app: string) => void`, which the host's filter calls through.
  > Rebase onto main (after #4326): `frontSettled` is replaced by #4326's `appSettled`, one hook the Claude app's follow and the tab follow share.

- [ ] **Step 1: Write the failing tests:**
  - `appFilter.spec.ts`: `settled is told each app that stays in front 1 s, and never one that left sooner`: `front('orca')` and 999 ms: none; at 1 s: `[['orca']]`; `front('ghostty')` then `front('vscode')` inside a second: `vscode` only; `front('none')`: `none`; at each call `settledApp()` already reads that app. The file stays at 100%.
  - `cableHost.spec.ts`: `frontSettled reaches the wiring when the app in front settles, with a window open too` (a scripted `appTimer`).
    > Rebase onto main (after #4326): both tests repeated #4326's `appSettled` ones; the appFilter one went (its 999 ms check moved into `a front that does not stay 1 s tells no settle`), and this one is now the window-open case of `appSettled reaches the wiring each time an app settles`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/appFilter.spec.ts src/cable/cableHost.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: the host says when an app has settled in front`.

### Task 5: A swipe selects the agent's tab, and a tap raises it after `open -b`

**Layer:** devices service process. **Depends on:** Tasks 1, 2, 3. **Effort:** `xhigh` (a background read racing hook events; `services/devices.ts` is in the 100% gate).

**Red test:** `cli/src/cable/hosts/observed.spec.ts`, `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts`, `cli/src/services/devices.ts`
- Test: `cli/src/cable/hosts/observed.spec.ts`, `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `ShownPane`, `shownPane` (Task 1); `TabApp`, `isTabApp`, `readTty` (Task 2); `tabsStream`, `ListenerStreamHandler` (Task 3).
- Produces, in `observed.ts`:
  - `ObservedDeps.tty?(pid: number): Promise<string | undefined>`. Absent (off macOS), no agent has a tty and nothing is read.
  - `ObservedActions.tabsOpen(): boolean` and `ObservedActions.tabSelect(app: TabApp, tty: string, raise: boolean): PaneSwitch` (`'ok'` when the line was written, `'failed'` with no stream).
  - `ShownPane` gains `{ kind: 'tty'; app: TabApp; tty: string }`.
  - `ObservedSource.byTab(app: string, tty: string): HostAgent | undefined`.
- Rules, in `observed.ts`:
  - **The read.** When an event or the open scan leaves an agent in a tab app, and no read was made for that pid, one `deps.tty(pid)` starts in the background. The pid is the event's `callerPid`, or the scan's owner pid.
  - An event from another pid drops the tty at once and starts a read for the new pid.
  - An answer is kept only if its agent is still listed and that pid is still its latest. A read that rejects is no tty.
  - **The pane.** `shownPane` answers Orca's pane first, as today. Else it answers `tty` when the session is live, its app is a tab app, the tty of its latest pid is known and `actions.tabsOpen()` is true.
  - `showPane`'s `'tty'` case answers `actions.tabSelect(app, tty, false)`: a swipe never raises.
  - **The tap** (PM, 2026-11-15). `focus` awaits `actions.open` as today. When it answers true, and `shownPane` then answers a `tty` pane, it calls `actions.tabSelect(app, tty, true)`.
    - The pane is read after `open` answers: an agent that ended or changed pid meanwhile gets no select.
    - An `open` that answers false writes no select. With no stream a tap only opens.
    - `focus` answers what `open` answered, whatever the select's outcome.
  - `byTab` answers the live agent whose app and tty match, the one with the latest `lastActivityAt` if two do.
- Produces, in `services/devices.ts`:
  - `DevicesDeps.tty?: (pid: number) => Promise<string | undefined>`, for this service's tests; `readTty` by default.
  - The observed source gets `tty` only when `apps.platform === 'darwin'`.
  - `const tabs = tabsStream()`; the actions `tabsOpen: () => tabs.isOpen()` and `tabSelect: (app, tty, raise) => (tabs.select({ app, tty }, raise) ? 'ok' : 'failed')`.
  - `tabs: tabs.handler` beside `front` in the `deps.listen` call. `DevicesDeps.listen`'s handlers are `ListenerHandler | ListenerStreamHandler`.

- [ ] **Step 1: Write the failing tests:**
  - `observed.spec.ts`, `describe('ObservedSource tabs')`, with a `tty` dep the test resolves by hand:
    - `an agent in Terminal gets its tty from one read for its pid` (hints `{ __CFBundleIdentifier: 'com.apple.Terminal' }`, `callerPid: 100`: calls `[[100]]`; three more events of pid 100 add none).
    - `iTerm2 and Ghostty are read too; Orca, VS Code and an unknown terminal are not`.
    - `no tty (??) is no pane`.
    - `a new pid reads again, and the old tty is gone at once`: an event with `callerPid: 101`; before its read ends `hasPane` is false; after, a select carries the new tty.
    - `a read that ends after its agent went, or after a newer pid's began, is dropped`; `a read that rejects is no tty`.
    - `the open scan reads the tty of an agent whose parents name a tab app`.
    - `hasPane needs a tab app, a tty, a live session and an open stream`; `with no tty reader (off macOS) nothing is read and no agent has a tab`.
    - `showPane writes one select that does not raise and answers ok, and failed with no stream` (`tabSelect` got `('terminal-app', '/dev/ttys023', false)`; `orcaSwitch` and `open` are not called).
    - `an agent with an Orca handle is shown by Orca, whatever its app`.
    - `a tap opens the app, then selects the tab with raise`: with `open` held, `tabSelect` is not called; once it answers true, `tabSelect` got `('terminal-app', '/dev/ttys023', true)`, once, and `focus` answers true.
    - `a tap whose open fails selects nothing, and answers false`.
    - `an agent that ended, or whose pid changed, while open ran gets no select`.
    - `with no stream a tap only opens`; `a tap on an agent with an Orca handle writes no select`.
    - `byTab: the live agent of that app and tty, the most recently active of two, none for another app, an ended session or an unknown tty`.
  - `devices.spec.ts`, in `describe("the mod's voice and Orca, …")`. A stream is opened by calling `listener.given[0].handlers.tabs.open` with a fake `ListenerStream`:
    - `a rest on an agent in Terminal writes one select on the stream, and runs no orca and no open` (the line is `toStrictEqual({ app: 'terminal-app', tty: '/dev/ttys023' })`, with no `raise` key; `said()` is `['[device] swipe · ok']`).
    - `with no stream open a turn starts no rest` (`swipeSwitches` is false); `a stream that ended since the turn is failed`.
    - `off macOS no agent has a tab, and its tty is never read` (`platform: 'linux'`).
    - `with no listen given no agent has a tab`.
    - `a tap runs open -b, then writes the select with raise:true` (`host().openAgent(ID)`, with the run of `['/usr/bin/open', ['-b', 'com.apple.Terminal'], 10_000]` held: the stream has no line; once it exits 0 the stream's one line is `{ app: 'terminal-app', tty: '/dev/ttys023', raise: true }`).
    - `a tap whose open -b fails writes no select`.
    - `no swipe line carries a tty`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts src/services/devices.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Give `tabsOpen` and `tabSelect` to every `ObservedActions` literal (`git grep -n "orcaSwitch" -- cli/src cli/e2e`).
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/services/devicesProcess.spec.ts src/architecture.spec.ts && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`.
- [ ] **Step 5: Commit** `dial: a swipe that rests on an agent in a terminal tab selects that tab`.

### Task 6: Selecting a tab moves the dial

**Layer:** devices service process. **Depends on:** Tasks 4, 5. **Effort:** `xhigh` (a report racing the settle and the dial's own selects; what the log may say).

**Red test:** `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts`
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `tabHandler` (Task 3); `CableHostWiring.frontSettled`, `settledApp()` (Task 4); `ObservedSource.byTab`, the `tabSelect` action (Task 5); `CableFleet.followLocal`, `FOLLOWED` (Task 1).
- Produces, in `services/devices.ts`:
  - `tab: tabHandler((tab) => part.call('dial', () => …))` beside `front` and `tabs` in the `deps.listen` call.
  - `FOLLOWED.tab = { moved: '[device] tab · moved', 'no-tile': '[device] tab · no-tile' }`.
  - `frontSettled` in the `new DaemonCableHost({ … })` literal.
  - `const ECHO_MS = 2_000`, `const ECHO_KEPT = 8`.
- Rules:
  - **The record of selects** (PM, 2026-11-15). The `tabSelect` action notes `{ tty, at: monotonic() }` for each line it wrote, a rest's and a tap's alike. Every select of the last `ECHO_MS` is kept, not only the last one. Records older than `ECHO_MS` are dropped, and at most `ECHO_KEPT` are kept: a ninth drops the oldest.
  - **The latest report** is one record, `{ app, tty, at }`. A newer one replaces it.
  - A report whose app is `cableHost.settledApp()` is acted on at once. Otherwise it waits.
  - When an app settles: a waiting report for that app is acted on. One for another app is dropped, with `[device] tab · not-in-front`.
  - **Acting** uses up the report, then, in this order:
    1. No dial linked (`!cable.isConnected`): nothing more.
    2. A select record with the report's tty, written less than `ECHO_MS` before the report arrived: `[device] tab · echo`.
    3. `observed.byTab(app, tty)` finds none: `[device] tab · no-agent`.
    4. Else `cable.followLocal(agent.id, 'tab')`.
  - `stop` forgets the report and the records.

- [ ] **Step 1: Write the failing tests**, in `describe('selecting a tab moves the dial (docs/specs/2026-11-15-dial-terminal-follow.md)')`. A dial attached, no window, an agent in Terminal with tty `/dev/ttys023`, a fake clock for `now`; a report is `listener.given[0].handlers.tab.handle({ type: 'tab', app, tty }, signal)`:
  - `a tab report whose app has settled in front asks the dials to follow its agent, as a tab's follow` (`calls('followLocal')` is `[[ID, 'tab']]`).
  - `a report before its app settles waits for the settle, then asks`.
  - `a report is dropped when another app settles, counted not-in-front, and is not acted on when its app settles later`.
  - `the newest report is the one acted on`.
  - `the dial's own select for that tty in the last 2 s is its echo`: at 1 999 ms `[device] tab · echo` and nothing asked; a report at 2 000 ms asks.
  - `a report for a tty the dial selected before its latest select is still an echo`: agents `A` and `B` in Terminal; the dial rests on `A`, then 500 ms later on `B`; `A`'s report comes after `B`'s select. `[device] tab · echo`, `calls('followLocal')` is empty, and the dial is not pulled back to `A`.
  - `nine selects inside 2 s keep the newest eight`: nine agents in Terminal, each with its own tty, a tap on each 100 ms apart (a tap writes its select with no rest). The first one's report asks `followLocal` for it; the second one's is `[device] tab · echo`.
  - `a report held for the settle is judged by when it arrived` (it arrives 1.5 s after the select and settles 1 s later: echo).
  - `no agent with that tty, or one in another app: no-agent`.
  - `the dial's answer is counted: tab · moved, and tab · no-tile` (`seen.host.localFollowed!('tab', …)`).
  - `with no dial linked nothing is asked or counted`.
  - `no tab line names a tty, an app, an agent or a session`: every `[device] tab` line is exactly one of the five.
  - `a follow that throws is logged and the devices keep running`.
  - `stop forgets the waiting report: a settle after it asks nothing`.
  - The Task 1 test `a follow of a cause with no line writes none` keeps `'attach'`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`.
- [ ] **Step 5: Commit** `devices: selecting a terminal tab turns the dial to its agent, unless it echoes the dial's own select`.

### Task 7: The watch carries tab reports in and selects out

**Layer:** the CLI. **Depends on:** Task 2. **Effort:** `xhigh` (a stream's life, its retries and two tells in order).

**Red test:** `cli/src/devices/client.spec.ts`, `cli/src/devices/listenerClient.spec.ts`.

**Files:**
- Modify: `cli/src/devices/client.ts`, `cli/src/devices/listenerClient.ts`
- Test: `cli/src/devices/client.spec.ts`, `cli/src/devices/listenerClient.spec.ts`

**Interfaces:**
- Consumes: `tabOf`, `Tab` (Task 2). The messages and lines of Global Constraints.
- Produces, in `listenerClient.ts`:
  - `export async function streamDevices(dataDir: string, message: { type: string }, chunk: (data: Buffer) => void, options: { signal: AbortSignal; platform?: NodeJS.Platform; fetch?: typeof fetch }): Promise<boolean>`.
  - It posts `message`, hands each chunk of a `200` answer's body on, and resolves true when that body ends.
  - It resolves false, never throws, for: no listener path, a socket not this account's own, any other status, no answer's headers in 2 s. An abort ends it and lets its connection go.
- Produces, in `client.ts`:
  - `DialWatchDeps.tell` also takes `{ type: 'tab'; app: string; tty: string }`.
  - `DialWatchDeps.selects?: (chunk: (data: Buffer) => void, signal: AbortSignal) => Promise<boolean>`; `streamDevices(dataDir, { type: 'tabs' }, …)` by default.
  - `const SELECT_LINE_MAX = 96`, `const STREAM_RETRY_MS = 1_000`, `const STREAM_RETRY_MAX_MS = 30_000`.
- Rules:
  - **Stdin.** One reader for both lines. A line whose `tab` passes `tabOf` is told as `{ type: 'tab', app, tty }`. One that fails is dropped.
  - Tab tells have a slot of their own: one at a time, `TELL_GAP_MS` after each, the newest wins. A tell not taken is not tried again. A tab tell does not wait on a front tell.
  - **The stream** opens after `connected` has named `dial-watch`. Each line of at most `SELECT_LINE_MAX` bytes that passes `tabOf`, and whose `raise` is a boolean or absent, prints `{"select":{"app":…,"tty":…}}`. Any other line prints nothing.
  - A line whose `raise` is `true` prints `{"select":{"app":…,"tty":…,"raise":true}}`. `false` prints the line without it. No other key of a stream line is printed.
  - When the stream ends or does not open, it is opened again after 1 s, then 2 s, doubling to 30 s. A stream that had opened starts again from 1 s.
  - A `dial_status` that says attached opens it at once when none is open or opening, and resets the wait.
  - With no listener path (`devicesListenerPath` is null) nothing is opened or retried.
  - The watch ending (any exit) aborts the stream and clears its timer.

- [ ] **Step 1: Write the failing tests:**
  - `listenerClient.spec.ts`:
    - `streamDevices posts the message and hands each chunk on until the listener ends the stream: true`.
    - `false for no socket, a socket of another account, a 404, a 429 and no answer in 2 s`.
    - `false on Windows without a call`; `an abort ends it`; `never throws`.
  - `client.spec.ts`, `describe('harness hardware watch: the selected tab')`, fake timers:
    - `a tab line is told to the devices listener as a tab message`.
    - `a bad app, a bad tty and a tab that is not an object are dropped, and the next line is told`.
    - `two tab lines while a tell is under way: the newest is told when it ends, the one between is skipped`.
    - `a tab tell does not wait for a front tell under way`.
    - `nothing of a tab goes on the core's socket`.
    - `the stream opens after connected, and each line prints one select line`.
    - `a stream line with a bad app or tty, one that is not JSON and one over 96 bytes print nothing`.
    - `a stream line with "raise":true prints the select with "raise":true, after app and tty` (the printed line is exactly `{"select":{"app":"terminal-app","tty":"/dev/ttys023","raise":true}}`).
    - `a line with no raise, or raise false, prints the select with no raise key; no other key is printed`.
    - `a raise that is not a boolean prints nothing` (`"true"`, `1`, `null`, `{}`), `and the next line is printed`.
    - `a stream that ends is opened again after 1 s, 2 s, 4 s, then 30 s at most; one that had opened starts again from 1 s`.
    - `the dial attaching opens it at once, and opens no second one`.
    - `with no listener path no stream is opened or retried`.
    - `stdin closing ends the stream and leaves no timer`.
    - `a select line does not hold back the next status line`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/client.spec.ts src/devices/listenerClient.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `watch: a tab line is told to the devices, and each select of their stream is printed`.

### Task 8: Harness Device: the tab rules

**Layer:** Harness Device. **Depends on:** none. **Effort:** `high`.

**Red test:** the tests in `device-app/src-tauri/src/tabs.rs`.

**Files:**
- Create: `device-app/src-tauri/src/tabs.rs`
- Modify: `device-app/src-tauri/src/lib.rs` (`pub mod tabs;`)

**Interfaces:**
- Produces:
  ```rust
  pub const POLL_EVERY: Duration = Duration::from_millis(500);
  pub const CALL_TIMEOUT: Duration = Duration::from_secs(2);

  #[derive(Clone, Copy, Debug, PartialEq, Eq)]
  pub enum TabApp { Terminal, Iterm, Ghostty }
  impl TabApp {
      pub fn id(self) -> &'static str;      // terminal-app | iterm | ghostty
      pub fn bundle(self) -> &'static str;  // com.apple.Terminal | com.googlecode.iterm2 | com.mitchellh.ghostty
      pub fn name(self) -> &'static str;    // Terminal | iTerm2 | Ghostty
      pub fn from_id(id: &str) -> Option<TabApp>;
      pub fn from_bundle(bundle: &str) -> Option<TabApp>;
  }
  pub fn tty_ok(tty: &str) -> bool;
  pub fn tab_line(app: TabApp, tty: &str) -> Option<String>;
  pub fn select_of(line: &str) -> Option<(TabApp, String, bool)>;  // the bool is the line's raise

  #[derive(Clone, Copy, Debug, PartialEq, Eq)]
  pub enum TabError { Denied, NoTty, Failed }
  pub fn tab_error(app: TabApp, code: i64) -> TabError;
  #[derive(Clone, Copy, Debug, PartialEq, Eq)]
  pub enum Selected { Done, NoTab }

  pub trait TabScripts: Send + Sync {
      fn running(&self, app: TabApp) -> bool;
      fn selected_tty(&self, app: TabApp) -> Result<Option<String>, TabError>;
      fn select_tty(&self, app: TabApp, tty: &str, frontmost: bool) -> Result<Selected, TabError>;
      fn focus_tty(&self, app: TabApp, tty: &str) -> Result<Selected, TabError>;
  }
  pub struct NoTabs;                       // runs nothing: `running` is false
  pub fn system() -> Arc<dyn TabScripts>;  // NoTabs here; Task 9 gives macOS its own

  pub struct Select { pub app: TabApp, pub tty: String, pub frontmost: bool, pub raise: bool }
  #[derive(Default)]
  pub struct Out { pub line: Option<String>, pub log: Vec<String> }

  #[derive(Default)]
  pub struct TabFollow { /* private */ }
  impl TabFollow {
      pub fn front(&mut self, bundle: &str);
      pub fn watching(&mut self, on: bool);
      pub fn attached(&mut self, on: bool);
      pub fn polls(&self) -> Option<TabApp>;
      pub fn polled(&mut self, app: TabApp, answer: Result<Option<String>, TabError>, now: u64) -> Out;
      pub fn select(&mut self, app: TabApp, tty: String, raise: bool);
      pub fn next_select(&mut self) -> Option<Select>;
      pub fn selected(&mut self, app: TabApp, done: Result<Selected, TabError>) -> Out;
      pub fn waited(&mut self, call: Duration);
  }
  ```
- Rules:
  - `tab_error`: `-1743` is `Denied`. `-1728` and `-10000` are `NoTty` for Ghostty only. Every other code is `Failed`.
  - `polls()` is the app in front when it is one of the three, a watch runs, the dial is attached and that app is not turned off. A new watch starts detached.
  - Each time `polls()` turns to an app, that app's last reported tty is forgotten: the first answer is written.
  - `polled` gives the tab line when the tty passes `tty_ok` and is new. It gives nothing for an app no longer polled, for no window (`Ok(None)`) and for a tty that fails the check.
  - `Denied` and `NoTty` turn that app off until the app restarts, each with one log line, once: `tabs: Terminal not allowed`, `tabs: Ghostty has no tty`.
  - A failed poll is counted. `polled` writes `tabs: <n> polls failed` once a minute has passed since the first uncounted failure (`now` is seconds).
  - `select_of` reads `raise` as true for `"raise":true`, and as false when the key is absent or `false`. A `raise` of any other type drops the line.
  - `select` keeps only the newest waiting select, and none for an app turned off. `next_select` takes it, with whether its app is in front and its `raise`. A newer select replaces a waiting one whatever either's `raise`.
  - `selected` logs `tabs: <Name> select ok` (`Done`), `none` (`NoTab`) or `failed`; `Denied` and `NoTty` turn the app off as above.
  - `waited(call)` drops the waiting select when `call` is over `CALL_TIMEOUT`: only macOS's consent prompt holds a call that long.
  - No log line holds a tty.

- [ ] **Step 1: Write the failing tests:**
  - `the_three_apps_by_id_and_by_bundle`.
  - `a_tty_is_dev_ttys_and_one_to_four_digits` (the cases of Task 2's test).
  - `a_tab_line_is_one_short_line_and_none_for_a_bad_tty` (`{"tab":{"app":"terminal-app","tty":"/dev/ttys023"}}`; under 140 bytes for every app and `/dev/ttys9999`).
  - `a_select_line_is_read_only_when_its_app_and_tty_pass` (an unknown app, a bad tty, a status line, `not json`: None).
  - `a_select_line_raises_only_when_it_says_true` (`"raise":true`: true; no key and `"raise":false`: false).
  - `a_select_line_with_a_raise_that_is_not_a_boolean_is_dropped` (`"true"`, `1`, `null`, `{}`: None).
  - `it_polls_only_with_a_tab_app_in_front_a_watch_and_the_dial_attached`.
  - `a_front_change_a_watch_ending_or_the_dial_detaching_stops_it_at_once`; `a_new_watch_starts_detached`.
  - `it_reports_a_change_and_the_first_answer_each_time_polling_starts`.
  - `an_answer_for_an_app_no_longer_polled_is_dropped`.
  - `the_newest_waiting_select_replaces_the_one_before`.
  - `a_waiting_select_keeps_its_raise_and_a_newer_one_brings_its_own` (`select(.., true)`: `next_select().raise` is true; `select(.., true)` then `select(.., false)`: one select, `raise` false).
  - `a_select_that_waited_behind_a_call_over_two_seconds_is_dropped` (2 000 ms keeps it; 2 001 ms drops it).
  - `denied_turns_that_app_off_and_says_so_once`; `the_other_apps_go_on`.
  - `ghostty_without_a_tty_is_turned_off_and_the_same_code_from_terminal_is_a_failed_call`.
  - `failed_polls_are_one_count_line_a_minute`.
  - `each_select_is_one_log_line`.
  - `no_log_line_holds_a_tty`.
  - `no_tabs_runs_nothing`.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --lib tabs::`. Expected: FAIL (it does not compile).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test --locked --lib`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: the tab lines, the tty check, and when it asks for the selected tab`.

### Task 9: Harness Device: the fixed scripts, run in process on macOS

**Layer:** Harness Device, macOS. **Depends on:** Task 8. **Effort:** `xhigh` (Apple Events to other apps, `unsafe` FFI).

**Red test:** the tests in `device-app/src-tauri/src/tabs_macos.rs`, and `the_bundle_says_why_it_sends_apple_events` and `the_bundle_may_send_apple_events` in `tabs.rs`.

**Files:**
- Create: `device-app/src-tauri/src/tabs_macos.rs`, `device-app/src-tauri/Entitlements.plist`
- Modify: `device-app/src-tauri/src/tabs.rs` (`system()`, two tests), `device-app/src-tauri/src/lib.rs`, `device-app/src-tauri/Cargo.toml`, `device-app/src-tauri/Cargo.lock`, `device-app/src-tauri/Info.plist`, `device-app/src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: `TabApp`, `TabScripts`, `TabError`, `tab_error`, `Selected`, `tty_ok` (Task 8).
- Produces:
  - `pub struct MacTabs`, which implements `TabScripts`. `tabs::system()` answers it on macOS.
  - `Info.plist`: `NSAppleEventsUsageDescription`, "Your dial follows your terminal tabs."
  - `Entitlements.plist` (PM, 2026-11-15): a plist whose one key is `com.apple.security.automation.apple-events`, `<true/>`. `tauri.conf.json`: `bundle.macOS.entitlements` is `"Entitlements.plist"`, beside `minimumSystemVersion`. The commit's message and the pull request say why: a build signed with the hardened runtime sends no Apple Event without it, and an ad hoc build is unchanged.
  - `Cargo.toml`: `objc2-foundation`'s features for `NSAppleScript`, `NSAppleEventDescriptor` and their error dictionary. No new crate.
- Rules:
  - **One thread of its own** holds every `NSAppleScript`. Each app's script is compiled once, at its first call. A call is a job sent to that thread and its answer waited for. AppKit's main thread never runs one.
  - **Three fixed sources**, one per app, each with three handlers, each inside `with timeout of 2 seconds`:
    - `selected_tty()`. Terminal: `tty of selected tab of front window`. iTerm2: `tty of current session of current window`. Ghostty: `tty of focused terminal of selected tab of front window`. With no visible window it answers the empty string, which is `Ok(None)`.
    - `select_tty(t, front)`, a swipe's; `front` is `TabScripts::select_tty`'s `frontmost`. Terminal: in each visible window, find `t` in `tty of tabs`; `set selected tab`; when `front`, `set index of` that window `to 1`. iTerm2: `select` the tab, then the session that holds `t`; when `front`, raise the window. Ghostty: nothing unless `front`; then `select tab` on the tab whose terminal holds `t`. Each answers whether a tab held `t`.
    - `focus_tty(t)`, a tap's (`"raise":true`; PM, 2026-11-15). It takes no `front`: `open -b` is bringing the app forward. Terminal: as `select_tty`, and always `set index of` that window `to 1`. iTerm2: `select` the tab, then the session, and always raise the window. Ghostty: `select tab` on the tab whose terminal holds `t`, whether or not Ghostty is frontmost. It answers whether a tab held `t`. It never says `activate`.
  - `MacTabs::focus_tty` calls the app's `focus_tty` handler, and `MacTabs::select_tty` its `select_tty`. Which one runs is the caller's choice between two fixed names: nothing of a line reaches a handler's name or a script's text.
  - **The call** is the `ascr`/`psbr` subroutine Apple Event: the handler's name, and its parameters as a list descriptor. `t` is a string descriptor. `select_tty` and `focus_tty` refuse a tty that fails `tty_ok` before any descriptor is made.
  - An error's `NSAppleScriptErrorNumber` goes through `tab_error`.
  - `running` is `NSRunningApplication`'s list for the app's bundle id, never an Apple Event.

- [ ] **Step 1: Write the failing tests** (macOS; none of them scripts another app but the last):
  - `a_handler_gets_its_parameter_as_a_descriptor`: a test source `on echo(t)` / `return t` / `end echo`, run through the same call, answers `/dev/ttys023`; the compiled source does not contain it.
  - `the_fixed_sources_hold_no_tty_and_read_nothing_but_ttys_and_selection`: no source matches `/dev/ttys` or contains `activate`, `name of`, `title`, `contents`, `history`, `working directory`, `do script` or `keystroke`.
  - `every_source_compiles` (compiling sends no event).
  - `every_source_has_the_three_handlers` (`on selected_tty()`, `on select_tty(`, `on focus_tty(` once each, per app).
  - `a_tty_that_fails_the_check_is_never_sent` (through `select_tty` and through `focus_tty`).
  - `an_app_that_is_not_running_reads_as_not_running` (a bundle id no app has).
  - `the_bundle_says_why_it_sends_apple_events` (`include_str!` of `Info.plist` holds the key and the sentence).
  - `the_bundle_may_send_apple_events`, in `tabs.rs`, so it runs on Linux too: `tauri.conf.json`, parsed, has `bundle.macOS.entitlements` equal to `"Entitlements.plist"`; `include_str!` of that file, its lines trimmed and joined as `types.rs` reads `Info.plist`, holds `<key>com.apple.security.automation.apple-events</key><true/>` and exactly one `<key>`.
  - `scratch_terminal_windows`, `#[ignore]`: Verification, check 2. Its own test-only script opens two Terminal windows with `do script ""` and notes their ids and ttys. A guard closes those two windows by id when the test ends, passed or failed. It asserts:
    - `select_tty` for the second window's tty answers `Done`, and that window's selected tab has that tty;
    - an unknown tty (`/dev/ttys9999`) answers `NoTab`, through `select_tty` and through `focus_tty`;
    - after the test raises the first window inside Terminal, `selected_tty` answers its tty;
    - `focus_tty` for the second window's tty, with the first window raised, answers `Done`, and `selected_tty` then answers the second window's tty: its window was raised inside Terminal;
    - the frontmost app's bundle id is the same before and after.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --lib tabs_macos::`. Expected: FAIL (it does not compile).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test --locked --lib`. Expected: PASS; the ignored test is listed as ignored.
- [ ] **Step 5: Commit** `Harness Device: Terminal, iTerm2 and Ghostty tabs through fixed scripts, a tty only as a parameter`.

### Task 10: Harness Device: the watch and the runner follow tabs

**Layer:** Harness Device. **Depends on:** Task 8. **Effort:** `xhigh` (a thread, three locks, a child's pipes).

**Red test:** the tests in `device-app/src-tauri/src/watch.rs` and `runner.rs`.

**Files:**
- Modify: `device-app/src-tauri/src/watch.rs`, `device-app/src-tauri/src/runner.rs`, `device-app/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `TabFollow`, `TabScripts`, `Select`, `Out`, `select_of`, `POLL_EVERY`, `system()` (Task 8).
- Produces:
  - `Watch::tab(&self, line: &str)`: a tab line on the child's stdin, as `front` writes its own. Nothing of it is logged.
  - `spawn_watch(cli, log, send, select: impl Fn(TabApp, String, bool) + Send + 'static)`: a stdout line that `select_of` reads goes to `select`, with its `raise`, and is no `Event`. The runner hands it to `TabFollow::select`.
  - `Doors.tabs: Arc<dyn TabScripts>`; `main.rs` gives `tabs::system()`.
- Rules, in `runner.rs`:
  - One thread, started with the runner and ended with it. It waits, with no timer, while `polls()` is none and no select waits.
  - A waiting select runs first. Its app not `running`: dropped, and no call is made. Else `focus_tty(app, tty)` when its `raise` is true, and `select_tty(app, tty, frontmost)` when it is not; then `selected`.
  - Else, `POLL_EVERY` after the last poll: `selected_tty` for `polls()`, then `polled`. Its line goes to the watch running now, through `Watch::tab`.
  - Each call's length goes to `waited`. A tick missed while a call ran is not made up.
  - `front_changed` also tells `TabFollow::front`. Starting a watch tells `watching(true)`; stopping it, or its `WatchExit`, `watching(false)`. Each `WatchLine` of the current watch tells `attached`.
  - The tab state's lock is taken last, and is never held across a script call, a write or `send`.
  - Each `Out.log` line goes to the log. No tty and no tab line goes to the log, an `Event` or the state file.

- [ ] **Step 1: Write the failing tests** (a fake `TabScripts` that counts and scripts its answers; the `Fronts` source; a fake CLI whose watch prints `{"attached":true}` and records its stdin; a short poll interval, as `spawn_watch_within` takes its durations):
  - `watch.rs`: `a_select_line_reaches_the_tabs_and_is_no_status` (a status, a select, a select with a bad tty: one `(Terminal, "/dev/ttys023", false)`, and the status alone as an event).
  - `watch.rs`: `a_select_line_carries_its_raise_and_a_raise_that_is_not_a_boolean_is_dropped` (`"raise":true`: `(Terminal, "/dev/ttys023", true)`; `"raise":"true"`: nothing).
  - `watch.rs`: `a_tab_line_reaches_the_watch`.
  - `runner.rs`:
    - `the_selected_tab_is_written_to_the_watch_with_terminal_in_front_and_the_dial_attached`.
    - `nothing_is_asked_with_another_app_in_front_no_watch_or_no_dial`.
    - `a_change_of_tab_is_one_line_and_a_repeat_none`.
    - `asking_stops_when_another_app_comes_to_the_front`.
    - `a_select_from_the_watch_runs_once_and_says_whether_its_app_is_in_front`.
    - `a_select_that_raises_runs_focus_tty_and_one_that_does_not_runs_select_tty` (the fake counts each: a line with `"raise":true` is one `focus_tty` and no `select_tty`, with another app in front too; a line without it is one `select_tty` and no `focus_tty`).
    - `an_app_that_is_not_running_is_never_sent_an_event` (a select that raises too).
    - `no_two_calls_overlap` (a call held on a gate while ticks pass: one call inside at a time).
    - `nothing_of_a_tab_is_logged_but_its_outcome` (no log line contains `ttys`).
    - `the_tab_thread_ends_with_the_runner`.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --lib -- watch:: runner::`. Expected: FAIL (it does not compile).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `(cd device-app/ui && npm ci && npm run build) && cd device-app/src-tauri && cargo test --locked`. Expected: PASS; the binary compiles.
- [ ] **Step 5: Commit** `Harness Device: it reports the selected tab while a terminal app is in front, and selects the tab the dial rests on`.

### Task 11: End to end: a tab moves the dial, and a swipe prints a select

**Layer:** test. **Depends on:** Tasks 6, 7. **Effort:** `high`.

**Red test:** none: no behavior (it adds end-to-end tests of what Tasks 1 to 7 built).

**Files:**
- Create: `cli/e2e/dialTerminalFollow.e2e.ts`

**Interfaces:**
- Consumes: `IsolatedDaemon`, `until`, `Desk`, `FakeDial`, `InOrca` (`e2e/harness/`), as `dialPaneFollow.e2e.ts` uses them; the watch as `hardwareWatch.e2e.ts` starts it, its stdout read line by line.
- Consumes: `Outside` (`e2e/harness/outsideAgent.ts`): the fake Claude Code on a pseudo-terminal of its own, started with `{ __CFBundleIdentifier: 'com.apple.Terminal' }`. Not a tmux pane (PM, 2026-11-15): `TMUX_PANE` would make the hook treat the session as a pane.
- The test reads each session's tty itself: `ps -o tty= -p <its pid>`, with `/dev/` before it.
- `describe.skipIf(process.platform !== 'darwin')`: off macOS the daemon gives no agent a tab.
- The real Terminal is never asked anything: no Harness Device runs, and the test writes the `tab` lines itself.

- [ ] **Step 1: Write the tests** (a daemon of its own for each case; a dial with no `appFilter`, so one ring holds every agent; `A` and `B` in Terminal tabs; `W` an `InOrca` session with `WEZTERM_PANE` and no pane; the watch written `{"front":"com.apple.Terminal"}`):
  - `a tab line with an agent's tty moves the dial to it`: the dial turned to `A` by hand; the watch is written `{"tab":{"app":"terminal-app","tty":<B's tty>}}`; the dial hears `{ t: 'focus', agentId: B.id }`; the log has `[device] tab · moved`. The report waits for the settle by itself: nothing is retried.
  - `a tty of no agent does not`: a tab line with `/dev/ttys9999`; wait for `[device] tab · no-agent`; the dial heard no `focus` since.
  - `a swipe that rests on an agent prints one select line after at least 395 ms, and the report that echoes it does not move the dial`:
    1. The dial turns to `W`, then to `A`, again every 2 s until the watch prints `{"select":{"app":"terminal-app","tty":<A's tty>}}`: the stream opens after `connected`, with no frame to wait on.
    2. That line came no less than 395 ms after the `Date.now()` read before the turn to `A`, and is the one select line since. The log has `[device] swipe · ok`.
    3. The dial turns to `W`. The watch is written A's tab line. Wait for `[device] tab · echo`. The dial heard no `focus` for `A` since the turn to `W`.
  - `the daemon's log has no tty, no bundle id and no session id`.
- [ ] **Step 2: Run**, on a Mac, `cd cli && npm run typecheck && npx vitest run --config vitest.e2e.config.ts e2e/dialTerminalFollow.e2e.ts e2e/dialPaneFollow.e2e.ts e2e/hardwareWatch.e2e.ts`. Expected: PASS.
- [ ] **Step 3: Commit** `e2e: a terminal tab moves the dial, and a swipe prints its select`.

### Task 12: Say it in the docs

**Layer:** repo files. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: no behavior.

**Files:**
- Modify: `cli/AGENTS.md`, `cli/src/services/AGENTS.md`, `device-app/AGENTS.md`

- [ ] **Step 1:** Write the changes, in each file's own words and length:
  - `cli/AGENTS.md`, the devices row of the processes table: a swipe selects the agent's tab in Terminal, iTerm2 or Ghostty, and selecting a tab there moves the dial.
  - `cli/src/services/AGENTS.md`, the devices paragraph: the listener also takes `tab`, and holds one `tabs` stream open, a handler of a second kind.
  - `device-app/AGENTS.md`, "Rules a change keeps": the tab scripts are fixed text, and a tty is a handler parameter only; a tab's tty goes to the watch's stdin and nowhere else; the `tabs:` log lines name one of the three terminal apps and never a tty; the bundle's entitlements file holds the Apple Events key and no other. "Commands": how to run the ignored scratch-window test.
- [ ] **Step 2:** Check every link resolves.
- [ ] **Step 3: Commit** `docs: the dial and the terminal apps follow each other, tab by tab`.

---

## Verification

**Platforms the pull request names:** the daemon, the CLI and Harness Device on macOS (tested; on a dial by Diego). Linux: the daemon's and the watch's unit tests and Harness Device's pure rules run in PR CI, and no tab follows. Windows: nothing changes.

**Temporary workflow:** none. No check here is long: the one new end-to-end file runs in a few minutes on a Mac, and the others need this Mac's Terminal or a dial.

**Workflows:** none changes (PM, 2026-11-15). The new end-to-end file runs on a Mac by hand. Adding it to the nightly macOS job (`e2e-macos-disk` in `.github/workflows/cli-e2e.yml`) is a separate proposal, not part of this pull request.

**The pull request also says:** the bundle gains `Entitlements.plist` with the one key `com.apple.security.automation.apple-events`; that a build signed with the hardened runtime sends no Apple Event without it; and that an ad hoc build is unchanged.

**Turns.** The tester asks the orchestrator before the one hand-started GitHub run (check 1), and before check 2 opens Terminal windows on this Mac. Diego's checks (4) wait for Diego.

**Local gates**, recorded in the pull request (PR CI does not run them):
- `cd cli && npm run typecheck && npm run test:core`: 100% per file for `services/devices.ts` and `services/devicesListener.ts`. Then `npx vitest run src/architecture.spec.ts src/leanEntry.spec.ts`: the core's file list is unchanged.
- `(cd device-app/ui && npm ci && npm run build) && cd device-app/src-tauri && cargo test --locked`, on a Mac (`docs/validation-and-release.md`, "Harness Device on macOS").
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit; its receipts go in the pull request.
- Not needed: `npm run test:harnessd`, the serial specs, `make device-test`.

**1. The real daemon, a fake dial, the real watch, Claude Code on a pty**
- Run, on a Mac, at the final head: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialTerminalFollow.e2e.ts e2e/dialPaneFollow.e2e.ts e2e/dialAppFilter.e2e.ts e2e/deviceClaudeOrca.e2e.ts e2e/deviceWithoutApp.e2e.ts e2e/hardwareWatch.e2e.ts e2e/devicesProcess.e2e.ts`.
- Isolation: the suite's own (`e2e/harness/daemon.ts`). A throwaway home and data folder, a private port and tmux server, fake engines, a fake dial on a pseudo-terminal. No backend and no sign-in. No Harness Device runs and no Apple Event is sent: the test writes the `front` and `tab` lines on the watch's stdin. The real Terminal, the everyday daemon (18473) and production are not touched.
- A person sees: every test passes. The daemon's log has `[device] tab · moved`, `[device] tab · no-agent`, `[device] tab · echo` and `[device] swipe · ok`, with nothing else in them.
- On GitHub, by hand, once on the final head: Actions → CLI end to end → Run workflow, branch `feat/dial-terminal-follow` (`.github/workflows/cli-e2e.yml`). Its shards are Linux: the new file's cases are skipped there, and the run proves the other dial files on the changed listener and watch. Every shard passes. The new file itself has no run on GitHub: the Mac run above is its evidence.

**2. Harness Device's Terminal handlers, against two scratch windows**
- Run, on this Mac, at the final head: `cd device-app/src-tauri && cargo test --locked --lib -- --ignored scratch_terminal_windows`.
- What it touches: Harness Device's own handlers, in process, against two Terminal windows the test opens and closes itself. It never reads, selects or closes any other Terminal window, and never asks iTerm2 or Ghostty anything.
- A person sees: two Terminal windows appear and go. Terminal does not come forward. The test passes: the tab was selected in the window that held the tty, an unknown tty answered none, the raised window's tty was read, and `focus_tty` raised the other window inside Terminal.
- The first run may show macOS's "wants access to control Terminal" for the app the tester's shell runs in. A person allows it. If nobody can, report the check as not verified, never as passed.
- Not checked here, as the spec says: tabs inside one window, iTerm2, Ghostty and a real denial.
- On GitHub: none. It needs a Mac session with Terminal.

**3. Linux, in PR CI:** `device-app-checks` compiles Harness Device and runs `tabs.rs`'s rules; the CLI unit jobs run Tasks 1 to 7's specs. Nothing is started by hand.

**4. On a dial (Diego's)** (the spec's "On a dial" 1 to 7)
- When: Diego is back, at the final head. Asked of the orchestrator first.
- Where: Diego's Mac, his round dial on the firmware it has, the real Terminal with Claude Code tabs. The Harness window closed.
- Why not an isolated daemon: the real Claude Code's hooks reach only the daemon that installed them. No step calls a backend.
- Build: save `harness version`; `make install-cli` at the final head; `(cd device-app/ui && npm ci && npm run build) && (cd device-app/src-tauri && cargo build --locked)`, then `target/debug/harness-device`, with the released Harness Device quit.
- Diego does and sees:
  1. First use: Terminal in front, the dial attached: macOS asks once. Allow.
  2. Three Claude Code tabs in one Terminal window, Terminal in front: selecting each tab turns the dial to it within about 1.5 s.
  3. Swiping: Terminal selects that agent's tab each time the dial rests. With another app in front, the tab changes behind it and Terminal stays behind.
  4. Two Terminal windows: a swipe to an agent in the other window raises that window while Terminal is in front.
  5. A fast swipe across three agents ends on the last one, and the dial is not pulled back.
  6. iTerm2 and Ghostty, if installed: steps 2 and 3. For Ghostty, whether `select tab` brings it forward.
  7. Denied: Harness Device's Terminal switch off in System Settings, Harness Device restarted: prompts still move the dial, and tab selection does nothing.
  8. The cost (the spec's Design notes): CPU of Harness Device and of Terminal over one minute with Terminal in front, with the released Harness Device and with this build (`top -l 60 -pid <pid> -stats cpu`). Both go in the pull request.
  9. A tap (the spec's "A tap"; its "On a dial" list has no such step): with another app in front, tap a notification of an agent whose tab is not the selected one, then one whose tab is in Terminal's other window. Terminal comes forward on that agent's tab each time, and the dial stays on that agent.
- Evidence: the daemon log's `[device] tab · moved` and `[device] swipe · ok` lines, Harness Device's `tabs:` lines, the two CPU figures.
- Not checked on a dial: the entitlement. The debug build is signed ad hoc, where it changes nothing. Task 9's test proves the key is in the file and the file is named in the bundle's settings. What it does under the hardened runtime is seen when the app is first signed for release: this repo signs no such build.
- **Afterwards:** quit the debug Harness Device and start the released one. Put the release CLI back with the public installer, as `cli/scripts/install-cli.sh` says; `harness version` reads as saved.
- Not done, for whatever reason: report it as not verified, never as passed.
- On GitHub: none. It needs a dial, Terminal and macOS's Automation prompt.

## Open questions

None.

## Decided (PM, 2026-11-15)

The draft's five open questions, as the PM answered them for Diego. The spec holds the same answers ("A tap", "Echo", "The entitlement", "End to end").

1. **A tap's order** (Tasks 3, 5, 7, 8, 9, 10). `open -b` first, then the select line with `"raise":true`. Only a tap sets the flag, never a swipe. It only picks a second fixed handler, `focus_tty(tty)`, instead of `select_tty(tty)`: it selects the tab and raises the window that holds it, and in Ghostty selects the tab whether or not Ghostty is frontmost. Never `activate`. The flag travels on the listener's stream line and the watch's stdout `select` line, and every hop checks it is a boolean or absent. The scripts stay fixed text, with the tty only as a handler parameter and no string put together.
2. **The echo's memory** (Task 6). Every select of the last 2 s, at most 8. A test rests on A then B, and A's late report does not pull the dial back.
3. **The entitlement** (Task 9). An entitlements file that holds only `com.apple.security.automation.apple-events`, true, named by `bundle.macOS.entitlements` in `tauri.conf.json`, with a test that the key is there. The pull request states it.
4. **The new end-to-end file after this pull request** (Verification). No workflow changes. It runs on a Mac by hand. Adding it to the nightly job is a separate proposal.
5. **The end-to-end test's real tty** (Task 11). `Outside` (`cli/e2e/harness/outsideAgent.ts`), not a tmux pane.

## Decided here, where the spec was silent

- `ps` is run as `/bin/ps`, so no `ps` earlier on `PATH` runs instead, as `open.ts` runs `/usr/bin/open`.
- "macOS only" in the daemon is one line: the observed source gets a tty reader only on `darwin`. No other file asks the platform.
- `tabSelect` answers at once (`'ok'` when the line is written).
- A tap writes its select only once `open` has answered true. An `open` that fails brought no app forward, so nothing is raised behind another app. The pane is read after `open` answers, and `focus` answers what `open` answered.
- A tap's select is noted for the echo as a rest's is. The dial already shows the tapped agent, so its report changes nothing either way.
- `"raise":false` reads as no `raise`. The devices process writes the key only as `true`, and the watch prints it only as `true`.
- The watch checks `raise` itself, where it reads the stream line. `tabOf` still hands on `app` and `tty` alone, so a tab report can never carry it.
- A newer waiting select replaces an older one whatever either's `raise`, as the spec's "replaces any select still waiting" reads.
- The entitlement's test sits in `tabs.rs` beside the `Info.plist` one, so it runs on Linux in PR CI.
- A request on a connection that holds a stream closes that connection. Ending a stream closes its connection too: it has no deadline left.
- A line written while an earlier one has not drained is not written: the stream buffers one line at most.
- The watch's wait starts again from 1 s after a stream that had opened, and when the dial attaches.
- With no listener path the watch opens no stream and retries none.
- A tab report is judged an echo by when it arrived, so its wait for the settle does not age it past 2 s.
- `[device] tab · not-in-front` is written when another app settles while a report waits. A report whose app never settles waits, one record, until a newer one replaces it.
- With no dial linked, a tab report is neither followed nor counted, as a prompt is.
- Harness Device writes the first answer each time polling starts: a tab app coming to the front, a watch starting, the dial attaching.
- "Ticks and selects are skipped while the prompt is open" is one rule: a select that waited behind a call longer than the 2 s Apple Event timeout is dropped.
- `-1728` and `-10000` turn only Ghostty off, as the spec's line names it. From Terminal or iTerm2 the same codes are a failed call: a tab closing during a read must not turn the app off until restart.
- Every script answers nothing, not an error, when its app has no visible window.
- `<App>` in Harness Device's lines is the app's name (Terminal, iTerm2, Ghostty), as the spec's own two examples write it.
- The poll-failure line is `tabs: <n> polls failed`. It names no app: a poll's app is the app in front, which Harness Device never logs. The spec's own two once-only lines (`not allowed`, `has no tty`) name the app.
- Whether a select's app is frontmost is Harness Device's own knowledge of the app in front, passed to `select_tty` as a boolean, `front`. No script asks an app whether it is frontmost. `focus_tty` takes no such boolean.
- The end-to-end echo case leaves the agent for one with no pane before the report comes, so the echo guard, not "already shown", is what keeps the dial.
