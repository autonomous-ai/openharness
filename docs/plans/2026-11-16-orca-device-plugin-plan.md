# The dial in Orca: a Harness Device plugin for Orca — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use diegodev phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inside Orca, a person sees whether a dial is attached and which agent it shows, in a panel and in the status bar, and someone without Harness gets a **Get Harness** button.

**Architecture:**
- **The devices process** serves a second stream type, `dial`, on its own listener: one NDJSON line for the state as the stream opens, then one per change. A cable session works out the agent its dial shows, the host keeps the latest report, and the stream writes only the latest state.
- **`harness device orca link`** prints where the devices' socket is, whether the daemon takes a connect and whether the devices' socket is there, so the plugin builds no path.
- **The plugin** (`plugins/harness-device-orca/`) is an Orca `trusted-worker`: its worker runs `link`, holds the `dial` stream open over the socket, and tells the panel and the status bar item each change. It is read only.
- Nothing is stored. Nothing goes through the core, no firmware, no Desktop UI, no Flutter.

**Tech Stack:** TypeScript daemon and CLI (Node, vitest, `cli/`); an Orca plugin in TypeScript and TSX with no build step and no dependencies (Orca 1.4.256, host API 1.5; `orca/testing` on Node's own test runner).

**Spec:** `docs/specs/2026-11-16-orca-device-plugin.md`.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/services/devicesListener.ts`, `devices.ts` | **Devices service process** | 100% per file (`npm run test:core`) |
| `cli/src/cable/cableSession.ts`, `cableHost.ts` | **Devices service process** | Their specs |
| `cli/src/deviceClaude/command.ts` | **CLI only**: the `harness` command's own process | Its spec |
| `cli/e2e/dialStream.e2e.ts` (new) | Test: the real daemon, fake dials, the real CLI | By hand; the CLI end to end workflow (nightly, and by hand) |
| `cli/e2e/harness/pluginDial.ts` (new) | Test: a Node process the end-to-end test starts, which runs the plugin's loop | With the file above |
| `plugins/harness-device-orca/src/inputs.ts`, `dial.ts`, `worker.ts` (new) | **Plugin worker**: a Node process Orca starts, as the person running Orca | `orca plugin test` (local) |
| `plugins/harness-device-orca/src/panel.tsx`, `protocol.ts` (new) | **Plugin panel**: Orca's sandbox, no network and no Node | `orca plugin test`, `orca plugin check` (local) |
| `plugins/harness-device-orca/orca-plugin.json`, `tsconfig.json`, `.gitignore`, `.gitattributes`, `README.md` (new) | Plugin files, no process | `orca plugin validate` (local) |
| `cli/AGENTS.md`, `cli/src/services/AGENTS.md` | Repo files, no process | none |

No file under `cli/src/core/` changes, `src/architecture.coreFiles.txt` gains no line, and `cli/src/cable/cableFleet.ts` does not change.

## Before starting

- Where `cli/node_modules` is missing (a new worktree): run `cd cli && npm ci` once.
- The plugin's tests and `check` run plugin code with the tester's own access, so they always run with an empty home and a bare `PATH`. Below, `iso <words>` stands for this one command, from the repo root (`orca` is `/Applications/Orca.app/Contents/Resources/bin/orca` on this Mac):
  ```bash
  ( cd plugins/harness-device-orca && env -i HOME="$(mktemp -d)" PATH=/usr/bin:/bin "$(command -v orca)" plugin <words> )
  ```
  `iso test .` and `iso check .` are the only ways these two run. With that `PATH` they use the Node built into Orca. A shell keeps no function between an agent's commands: paste the whole line each time.
- The plugin's type check borrows the CLI's TypeScript and Node typings (the plugin has no dependencies):
  ```bash
  cd plugins/harness-device-orca && orca plugin types . && ../../cli/node_modules/.bin/tsc -p . \
    --typeRoots ./.orca/types,../../cli/node_modules/@types --types orca,orca-host,orca-frame,orca-worker,orca-services,orca-testing,node
  ```
  Below, "the plugin's type check" is this command. Expected: no output.
- Orca's docs and typings for the plugin tasks: `/private/tmp/claude-503/-Users-duynguyen-orca-workspaces-autonomous-harness-orca-plugin/a6b06505-530a-4c5c-984f-f7660aea9e68/scratchpad/spike/docs/` (`plugin-authoring.md`, `plugin-manifest.md`, `plugin-host-api.md`, `plugin-declarative-ui.md`) and `…/scratchpad/spike/wp/` (the `worker-panel` template with its `.orca/types/`). If the scratchpad is gone: `orca plugin create <your own scratch folder> --template worker-panel --name "Harness Device"`.

## Global Constraints

- **The core does not change.** No file under `cli/src/core/`, nothing `src/core/main.ts` imports, no entry in `src/core/api.ts`.
- **Read only.** The plugin types nothing, starts no agent and moves no dial. No follow or unfollow.
- **Never in the Orca app.** Every session runs inside Diego's Orca. Only `orca plugin types`, `test`, `check`, `validate` and `release-entry` are run. Never `dev load`, `dev watch`, `dev request`, `open`, `shot`, `install`, `enable` or `restart`.
- **Nothing published.** No tag, no repository topic, no catalog entry, no release.
- **The open.** `POST /` on the devices' socket, body exactly `{"type":"dial","standby":true}` (30 bytes); at most 64 bytes, at most 1 a second per connection. While a `dial` stream is open, another open is `409` and the open one stays.
- **The three lines**, byte for byte, keys in this order:
  - `{"attached":false}`
  - `{"attached":true,"agent":null}`
  - `{"attached":true,"agent":{"name":"<name>","app":"<app>"}}`
- **A name** is the `name` of the agent's entry in the ring the session last sent, cut to 64 code points. **An app** is `hostDisplayName(host)` for a `host` that is one of `APP_IDS` (`cable/hosts/hostDetect.ts`), and `Harness` for no host or any other. No agent id, terminal handle, path, transcript or prompt is in a line.
- **Writing.** Only the latest state is written, and only when its line differs from the last one written on that stream. No timer writes a line.
- **`harness device orca link`** prints one JSON object, keys in this order, and exits 0. It is left out of `DEVICE_USAGE`.
  - `daemon` (boolean): the daemon's socket is there, is this account's own, and takes a connect within 1 s. A socket a crashed daemon left behind is `false`.
  - `devicesSocket`: the path of the devices' socket, there or not; left out where there is none.
  - `devicesReady` (boolean): that socket is there and this account's own. `link` does not connect to it.
- **The manifest:** `id` `harness-device`, `name` `Harness Device`, `version` `0.1.0`, `description` "The dial's state in Orca.", `execution` `trusted-worker`, `engines.orca` `>=1.4.248`, `license` `MIT`, no `publisher`, no `capabilities`, one `components` panel with icon `gauge`, one status bar item.
- **Exact copy** in the panel, one state at a time:

  | `state` | Panel |
  |---|---|
  | `checking` | nothing |
  | `windows` | "Not on Windows yet." |
  | `noHarness` | "Harness isn't installed." and a **Get Harness** button, which opens `https://harness.autonomous.ai/desktop` |
  | `notRunning` | "Harness isn't running." |
  | `elsewhere` | "Open in another Orca." |
  | `unplugged` | "Dial unplugged." |
  | `attached`, no agent | "Dial attached." |
  | `attached`, an agent | the agent's name, and its app on a second, muted line |

- **The status bar item** (`id` `dial`, icon `gauge`, tooltip "Harness Device", no command): text `Dial` for `attached` with no agent, the agent's name for `attached` with one, hidden for every other state.
- **The worker's bounds.** `link`: 5 s and 4 KiB of output. The head of the stream's answer: 2 s, else `notRunning`. A stream line: 1 KiB. The wait before the next pass: 1 s, 2 s, 4 s, 8 s, 16 s, then 30 s; a stream that stayed open over 30 s starts it again from 1 s. The folder watch reacts only to the socket's own entry (`devices.sock`), or to any entry where the platform gives no name, and asks `link` at most once a second.
- **The launcher:** `~/.local/bin/harness`, then `harness` on `PATH`, the order `plugins/harness-device/hooks/device.js` uses. The worker connects only to the `devicesSocket` that `link` printed in the same pass, and only when it said `devicesReady`.
- **Logs** hold states, reasons and counts only: never an agent's name, an app or a path.
  - Devices log: `[devices] dial stream · open`, `[devices] dial stream · ended · gone | stalled | closed`, `[devices] dial stream · <n> lines in the last minute`.
  - Worker log (`orca plugin logs`): `dial: <state>`, `dial: <n> lines skipped`, `dial: status bar unavailable`.
- **The plugin folder** holds no dependency, `package.json`, binary, archive or symlink: Node's built-in modules, `orca` and relative files only. `.orca/` is generated and stays out of Git. `src/dial.ts` and `src/inputs.ts` load nothing of `orca` when they run (an `import type` is fine): Task 15 runs them outside Orca.
- **Platforms.** macOS and Linux. On Windows the plugin shows "Not on Windows yet." and `link` prints no `devicesSocket`.
- **Repo rules.** Tests never touch the developer's real `~/.claude`, `~/.local/bin/harness`, daemon (port 18473), dial or Orca app. No fixed sleeps. `src/services` stays at 100% per file.

## Review Focus

1. **A socket left behind by a process that died** (a crash, a power cut). The panel must not sit on the last agent's name, on "Dial unplugged." or on nothing, for ever.
   - The daemon's: its file is still there and still this account's own, so `link` tries a connect before it says `daemon: true`. Task 6 (`a socket a crashed daemon left behind is daemon false`).
   - The devices': `link` still says `devicesReady`, and the worker's connect is refused: `notRunning`. Task 10 (`a connect that is refused, or gets no answer in 2 s, is notRunning`).
2. **A dial dropped for its faults while it holds the latest report.** Every call to its host throws then (`cableFleet.ts`, `dial.<id>`). Its port must still close, `stop()` must not reject, and the stream must not keep its agent. Task 3 (`a host whose dialShows throws`), Task 4.
3. **A stream chunk is not a line.** A line split across two chunks, two lines in one chunk, and a line that never ends must each do the right thing, and the buffer must not grow past 1 KiB. Task 10 (`a line split across two chunks`, `a line over 1 KiB`).
4. **A name is outside text.** Quotes, control characters, a lone surrogate, an emoji at the 64th place and a host named `constructor` must still give one valid line under the worker's 1 KiB. Task 2 (`a name of quotes, control characters or lone surrogates`), Task 3 (`a host the table does not know`).
5. **A launcher that prints something else.** An older `harness`, a warning before the JSON, an array, `"daemon":"yes"`, a `devicesSocket` that is not an absolute path: each is `notRunning`, never a throw and never a connect. Task 10 (`a launcher that prints anything else`).

---

### Task 1: The listener: a stream says when it can take a line, and why it ended

**Layer:** devices service process. **Depends on:** none. **Effort:** `xhigh` (connections, a callback inside a socket write, the account's private socket).

**Red test:** `cli/src/services/devicesListener.spec.ts`.

**Files:**
- Modify: `cli/src/services/devicesListener.ts` (`ListenerStream` :52, `openStream` :178, `close` :318)
- Test: `cli/src/services/devicesListener.spec.ts`
- Modify: `cli/src/services/devices.spec.ts` (the fake stream in `fakeListener().tabs` :285 gains `onWritable: () => {}`, nothing else)

**Interfaces:**
- Produces:
  ```ts
  export type StreamEnd = 'gone' | 'stalled' | 'replaced' | 'closed'
  export interface ListenerStream {
    write(line: unknown): boolean
    /** `run` is called each time the stream can take a line: once it has opened, and each time a written line has drained.
     *  Never once it has ended. A later call replaces the listener. */
    onWritable(run: () => void): void
    /** Aborts when the stream ends; its `reason` is a StreamEnd. */
    readonly ended: AbortSignal
  }
  ```
- Rules:
  - `write` inside `open` still answers false. The first `run` comes right after the `200` head is sent and the stream is writable.
  - After a line's write callback, with no error and the stream not ended, the stream is writable again and `run` is called.
  - A `run` that throws ends the stream as `closed`, counted `failed`. Nothing reaches the socket's callback.
  - `ended.reason`: `gone` when the client closes, its socket errors, or a second message on its connection closes it; `stalled` when a line has not drained in 2 s; `replaced` when a newer stream of its type opens; `closed` when the listener closes. A stream whose `open` refused or threw is aborted as `closed`. The first reason stays.
  - `tabs` calls no `onWritable`. Its tests pass unchanged.

- [ ] **Step 1: Write the failing tests**, in `describe('a stream')`, with the file's `streamHandler`, `asked` and `endOf` helpers:
  - `a writable listener runs once the stream has opened, and a line it writes is the stream's first line` (the handler writes `{ first: true }` from it; `await stream.got(1)` is `['{"first":true}']`; a `write` inside `open` answered false).
  - `the writable listener runs again each time a line has drained, and not while one waits` (its count is 1 after the open, still 1 right after a `write`, 2 once the client got the line).
  - `a later onWritable replaces the listener`.
  - `no writable call comes after the stream ended` (the client closes while a line waits).
  - `a writable listener that throws ends the stream as closed, counted failed, and the next message is taken` (the minute line reads `1 failed`; `ended.reason` is `'closed'`).
  - `ended says why`: `'gone'` (the client closes; a socket that errors; a second message on its connection), `'stalled'` (`UNDRAINABLE`, 2 s on fake timers), `'replaced'` (a newer stream), `'closed'` (`listener.close()`).
  - `a stream whose open refused or threw is aborted as closed`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devicesListener.spec.ts`. Expected: FAIL (`onWritable` is not a function).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/services/devices.spec.ts && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devicesListener.ts`.
- [ ] **Step 5: Commit** `devices: a listener stream says when it can take a line, and why it ended`.

### Task 2: The `dial` stream

**Layer:** devices service process. **Depends on:** Task 1. **Effort:** `xhigh` (an agent's name leaves the process; the latest state against a line still draining).

**Red test:** `cli/src/services/devicesListener.spec.ts`.

**Files:**
- Modify: `cli/src/services/devicesListener.ts` (beside `tabsStream` :411)
- Test: `cli/src/services/devicesListener.spec.ts`

**Interfaces:**
- Consumes: `ListenerStream.onWritable`, `StreamEnd`, `ListenerStreamHandler`, `REFUSED` (Task 1).
- Produces:
  ```ts
  export const DIAL_PER_SECOND = 1
  /** Its message, `{"type":"dial","standby":true}`, is 30 bytes. */
  export const DIAL_MAX_BYTES = 64
  export const DIAL_NAME_MAX = 64
  export type DialLine = { attached: false } | { attached: true; agent: { name: string; app: string } | null }
  export interface DialStream {
    handler: ListenerStreamHandler
    /** Whether any dial is attached. */
    attached(on: boolean): void
    /** The agent the dial shows, or null for none. */
    shows(agent: { name: string; app: string } | null): void
  }
  export function dialStream(deps: { log(line: string): void; after(ms: number, run: () => void): () => void }): DialStream
  ```
- Rules:
  - It starts detached, with no agent. Its line is `{ attached: false }` while detached, whatever agent it holds; else `{ attached: true, agent }`, the name cut to `DIAL_NAME_MAX` code points (`[...name]`, so a pair is never split).
  - `open` answers `REFUSED` unless `message.standby === true`. Else it keeps the stream, logs `[devices] dial stream · open`, and gives it one writable listener.
  - **The writer** is that listener, also called by `attached` and `shows`: when the latest line's JSON differs from the last one written on this stream, it calls `write`. A `write` that answers true is remembered and counted. One that answers false is not: the next writable call writes the then latest line.
  - When `ended` aborts it logs `[devices] dial stream · ended · <reason>` and forgets the stream. With no stream open, `attached` and `shows` only keep the state.
  - **The count:** the first line written since the last count line sets `deps.after(60_000, …)`, which logs `[devices] dial stream · <n> lines in the last minute` and starts over. A minute with no line sets no timer and logs nothing.

- [ ] **Step 1: Write the failing tests**, in `describe('the dial stream')`, on a real listener (`open({ dial: dial.handler })`, `asked(path, DIAL)` with `const DIAL = '{"type":"dial","standby":true}'`):
  - `the first line is the state as the stream opens` (`['{"attached":false}']` with no dial; `['{"attached":true,"agent":null}']` after `attached(true)`).
  - `a dial attaching and the agent it shows are a line each, byte for byte` (the three lines of Global Constraints, with `{ name: 'api', app: 'Orca' }`).
  - `a state that does not change writes nothing` (`attached(true)` twice, the same agent twice, then another agent: one line more each time it changed).
  - `a removal reaches the reader` (the agent to null: `{"attached":true,"agent":null}`; `attached(false)`: `{"attached":false}`).
  - `while detached an agent is not said` (`shows` adds no line; the agent is in the line once `attached(true)`).
  - `ten changes in one turn of the loop are two lines, the first and the last` (ten `shows` in a row: the reader gets the first agent, then the tenth).
  - `a change back to the line last written, while it drains, writes nothing more` (`shows(a)`, `shows(b)`, `shows(a)` in a row: one line, `a`).
  - `a name over 64 characters is cut to 64 code points, and a pair is not split` (`'😀'.repeat(70)` gives `'😀'.repeat(64)`; the line is under 400 bytes).
  - `a name of quotes, control characters or lone surrogates is one JSON line under 1 KiB` (64 of `"`, of `\u0000` and of `\ud800`: each line parses back to the name, holds no raw newline, and `Buffer.byteLength` is at most 1024).
  - `a second open is 409 while one is open, and the first is still written to`; `once it ends, the next open is a stream`.
  - `an open with no standby, or standby false, is 400 and opens nothing`.
  - `a 65-byte open is 413`; `while another connection holds the stream, a connection's first open is 409 and its second within a second is 429`.
  - `the stream opening and ending are a log line each`: `gone` (the client closes) and `closed` (`listener.close()`) on the real listener; `stalled` with a hand-made `ListenerStream` whose `ended` aborts with `'stalled'`.
  - `the lines written are counted once a minute, and a minute with none says nothing` (a recording `after`: one call of `60_000` at the first line; its `run` logs `[devices] dial stream · 3 lines in the last minute`; no further call until the next line).
  - `after the stream ended, attached and shows write nothing and throw nothing`.
  - `no log line holds a name or an app`.
  - `the dial handler is its two limits and open` (`[DIAL_MAX_BYTES, DIAL_PER_SECOND]` is `[64, 1]`; `Buffer.byteLength(DIAL)` is 30).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devicesListener.spec.ts`. Expected: FAIL (`dialStream` is not exported).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devicesListener.ts`.
- [ ] **Step 5: Commit** `devices: the dial stream says whether a dial is attached and which agent it shows`.

### Task 3: A cable session works out the agent its dial shows

**Layer:** devices service process. **Depends on:** none. **Effort:** `xhigh` (every write of the dial's focus record; a throw on the close path ends the devices process).

**Red test:** `cli/src/cable/cableSession.spec.ts`.

**Files:**
- Modify: `cli/src/cable/cableSession.ts` (`CableHost` :313, `lastRing` :651, `desiredFocus` :720, `onClosed` :1070, the ring push :2591)
- Test: `cli/src/cable/cableSession.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ShownAgent { name: string; app: string }
  // in CableHost:
  /** The agent this dial shows changed: as its ring last drew it, or null for none. `dial` is the session that says so,
   *  which is how a host tells two dials apart. */
  dialShows?(dial: object, agent: ShownAgent | null): void
  ```
- Rules:
  - **The shown agent** is the entry of `desiredFocus` in the ring the session last sent, as `{ name, app }` (Global Constraints, "A name", uncut), or null when that ring has no such entry.
  - The ring's record keeps each entry's `name` and `host` with its id. It stays one record: `pushRestores` reads the same one.
  - **One private method** works it out and, when the result differs from what the session last reported (by `name` and `app`), remembers it and calls `host.dialShows?.(this, result)`. It runs from the one setter every write of `desiredFocus` goes through, after a ring push has recorded its ring, and as the port closes.
  - As the port closes the result is null, and the call comes last in `onClosed`, after the session's own state is reset.
  - A `dialShows` that throws is this dial's fault (`this.fault(error)`): the move, the push or the close that caused it goes on.
  - A push of the app list alone (`ring` false) changes no ring and reports nothing.
- A test's own trap: for `APP_FOCUS_SETTLE_MS` after a ring push that re-asserted the focus, the session drops any other `focus` from the dial (`expectedAppFocusEcho`, :1418). A case that swipes after such a push has the port say the re-asserted focus first.

- [ ] **Step 1: Write the failing tests**, in `describe('the agent the dial shows (docs/specs/2026-11-16-orca-device-plugin.md)')`, with a `greeted({ dialShows, listAgents })` like the one in `describe('a prompt in the app in front')` and the ring `[{ id: 'o1', name: 'api', host: 'orca' }, { id: 'h1', name: 'web' }, { id: 't1', name: 'docs', host: 'terminal' }]`:
  - `a swipe's focus from the dial reports that agent's name and app` (`port.say({ t: 'focus', agentId: 'o1' })`: `dialShows.mock.calls` is `[[session, { name: 'api', app: 'Orca' }]]`).
  - `focusAgent and followApp report it too`; `a tapped notice that turns the dial to another app's ring reports its agent` (the `appHost` helper of `describe('the app filter')`, `port.say({ t: 'agent.open', agentId })`).
  - `an agent with no host is in Harness, and so is a host the table does not know` (`h1`: `Harness`; hosts `'nope'`, `'constructor'` and `'__proto__'`: `Harness`; `t1`: `Terminal`).
  - `a move to an agent the ring does not hold reports none` (after `o1`, `session.focusAgent('gone')`: the last call is `[session, null]`).
  - `a ring push that renames the shown agent reports the new name; one that drops it reports none; one that brings it back reports it again` (`listAgents` changed, then `await session.syncAgents(true)`).
  - `nothing is reported when nothing changed` (the same focus twice; a push with the same ring; a push that renames another agent).
  - `the port closing reports none, once` (`await port.close()`); `a session that showed none reports nothing as it closes`.
  - `a dial that comes back on its port is reported again once its ring is pushed` (the file's reopen pattern: the tick opens a new port, the dial greets again).
  - `a host whose dialShows throws: the port still closes, stop() resolves, and onFault hears it` (`dialShows` throws on every call; `await session.stop()`).
  - `a host whose dialShows throws on a swipe still hears focus` (`host.focus` got `'o1'`).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts`. Expected: FAIL (`dialShows` is never called).
- [ ] **Step 3: Implement.** `git grep -n "desiredFocus =" -- cli/src/cable/cableSession.ts` shows no write that goes around the setter.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable/cableFleet.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: a session works out the agent its dial shows, and tells the host when it changes`.

### Task 4: The host keeps the latest report

**Layer:** devices service process. **Depends on:** Task 3 (`ShownAgent`, `CableHost.dialShows`). **Effort:** `high`.

**Red test:** `cli/src/cable/cableHost.spec.ts`.

**Files:**
- Modify: `cli/src/cable/cableHost.ts` (`CableHostWiring` :107, `DaemonCableHost` beside `localFollowed` :608)
- Test: `cli/src/cable/cableHost.spec.ts`

**Interfaces:**
- Consumes: `ShownAgent`, `CableHost.dialShows` (Task 3).
- Produces:
  - `CableHostWiring.dialShows?: (agent: ShownAgent | null) => void`
  - `DaemonCableHost.dialShows(dial: object, agent: ShownAgent | null): void`
- Rules:
  - The host keeps one report: its agent and the dial that made it.
  - A report with an agent, from any dial, replaces it and reaches the wiring.
  - A null from the dial that made the kept report clears it and reaches the wiring.
  - A null from any other dial, or with no report kept, is dropped.

- [ ] **Step 1: Write the failing tests**, beside `localFollowed reaches the wiring`, with two plain objects `A` and `B` as the dials:
  - `the dial that reported last is the one shown` (`dialShows(A, x)`, `dialShows(B, y)`: the wiring got `[[x], [y]]`).
  - `a none from another dial is dropped: unplugging one of two does not blank the other's agent` (then `dialShows(A, null)`: no call more).
  - `a none from the dial that reported last reaches the wiring, and the other dial's next move fills it again` (`dialShows(B, null)`: `[null]`; `dialShows(A, z)`: `[z]`).
  - `a none with no report kept is not told` (a new host, `dialShows(A, null)`; and a second `dialShows(B, null)` after the first).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableHost.spec.ts`. Expected: FAIL (`dialShows` is not a function).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: the host keeps the agent of the dial that moved last`.

### Task 5: The devices serve the `dial` stream

**Layer:** devices service process. **Depends on:** Tasks 2, 4. **Effort:** `high` (`services/devices.ts` is in the 100% gate).

**Red test:** `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts` (beside `tabsStream()` :275, `watching` :373, the `deps.listen` call :756)
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `dialStream`, `DIAL_MAX_BYTES`, `DIAL_PER_SECOND` (Task 2); `CableHostWiring.dialShows` (Task 4).
- Produces, in `services/devices.ts`:
  - `const dial = dialStream({ log, after: timerIn('dial') })`
  - `watching` also calls `dial.attached(on)`. The wiring's `dialShows` is `(agent) => dial.shows(agent)`.
  - `dial: dial.handler` after `tabs` in the `deps.listen` call.

- [ ] **Step 1: Write the failing tests:**
  - In `the devices open their listener once, …` (:359): the keys are `['front', 'attach', 'tab', 'tabs', 'dial']`, and `handlers.dial` matches `{ maxBytes: 64, perSecond: 1 }`.
  - `fakeListener()` gains `dial()`: it opens `handlers.dial` with `{ type: 'dial', standby: true }` and a stream that records its lines, keeps the `onWritable` listener, and returns `{ lines, writable(), end(reason) }`.
  - In a new `describe('the dial stream, for Orca\'s Harness Device plugin (docs/specs/2026-11-16-orca-device-plugin.md)')`:
    - `the first line is {"attached":false}; a dial attaching, the agent it shows and the dial going are a line each` (`stream.writable()`, `seen.host.watching!(true)`, `seen.host.dialShows!({ name: 'api', app: 'Orca' })`, `seen.host.watching!(false)`: `lines` is the four objects in order).
    - `the stream's open, its end and its count go to the devices' log` (`said()` holds `[devices] dial stream · open` and `[devices] dial stream · ended · gone`; a minute on fake timers adds the count line).
    - `stopping the devices cancels the count's timer` (a line written, `await port.stop()`, a minute passes: no count line).
    - `with no listen given the dial's moves reach no stream and nothing throws`.
    - `no devices log line holds the agent's name or its app`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL (no `dial` handler).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/services/devicesProcess.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`.
- [ ] **Step 5: Commit** `devices: the dial stream is served on their listener`.

### Task 6: `harness device orca link`

**Layer:** the CLI. **Depends on:** none. **Effort:** `high`.

**Red test:** `cli/src/deviceClaude/command.spec.ts`.

**Files:**
- Modify: `cli/src/deviceClaude/command.ts`
- Test: `cli/src/deviceClaude/command.spec.ts`

**Interfaces:**
- Produces: the words `orca link` in `runDeviceCommand`, beside `claude …`. `cli/src/cli.ts` and `DeviceDeps` do not change.
- Produces, in `command.ts`:
  ```ts
  /** Whether something listens on the Unix socket at `path`: it takes a connect within `ms`. Never throws. */
  export function takesConnect(path: string, ms = 1_000, open: (path: string) => Socket = connect): Promise<boolean>
  ```
  `connect` and `Socket` are `node:net`'s. `open` is there for the one case a real socket cannot give: a connect that neither opens nor fails.
- Rules:
  - `daemon`: `localSocketRoute(dataDir, port, platform)` is not null, `socketIsPrivate` of it, and `await takesConnect` of it, in that order. A socket that is not this account's own is never connected to.
  - `takesConnect`: `connect` is true, `error` is false, and its own `setTimeout(ms)` is false. In each case the socket is destroyed and the timer cleared. Nothing is written on the socket. An `error` after it settled is swallowed.
  - `devicesSocket`: `devicesListenerPath(dataDir, platform)`, the key left out when it is null.
  - `devicesReady`: that path is not null and `socketIsPrivate` of it. No connect.
  - It reads no stdin, never calls `deps.claude()`, and does not read Claude Code's settings.
  - `orca` with no verb, another verb or an extra word prints `DEVICE_USAGE` on stderr and exits 1. `DEVICE_USAGE` does not change.
- A test's own trap: the file's `daemonAt` listens with the umask's mode (`0755`, checked 2026-11-16), which `socketIsPrivate` refuses. The cases below serve the daemon's socket as the daemon does, with a new helper `ownDaemonAt(dataDir)`: `listenLocalSocket(handler, unixSocketPath(dataDir, PORT)!)`, its `close` in `cleanup`, returning the server and a count of the requests its handler got.

- [ ] **Step 1: Write the failing tests**, in `describe('harness device orca link')`, with the file's `folder`, `devicesAt` and `device` helpers and `ownDaemonAt`:
  - `with no daemon and no dial it prints daemon false, the devices' path and devicesReady false, and exits 0` (`out` is `[JSON.stringify({ daemon: false, devicesSocket: devicesListenerPath(dataDir), devicesReady: false })]`, `err` is `[]`).
  - `daemon is true once the daemon's socket is there, this account's own, and takes a connect` (`ownDaemonAt(dataDir)`).
  - `the connect asks the daemon nothing` (the server saw one connection, which closed, and its handler got no request).
  - `a socket a crashed daemon left behind is daemon false` (`const crashed = await listenLocalSocket(handler, unixSocketPath(dataDir, PORT)!)`, then `crashed.server.close()`, as `lib/localSocket.spec.ts` makes one; the test first checks `socketIsPrivate` of the path is still true, so the answer is the connect's; `daemon` is `false`).
  - `a daemon's socket that is not private is daemon false, and is not connected to` (`ownDaemonAt`, then `chmodSync(path, 0o666)`: the server saw no connection).
  - `devicesReady is true once the devices' socket is there and this account's own` (`devicesAt(dataDir)`); `a devices' socket nothing listens on is still devicesReady true` (made as the crashed daemon's is).
  - `a devices' socket that is not private is devicesReady false, its path still printed` (mode `0o666`; the folder `0o777`; a plain file at the path).
  - `on Windows it prints {"daemon":false,"devicesReady":false} and exits 0` (`platform: 'win32'`).
  - `with the harness-device plugin off in Claude Code it prints the same` (`pluginOn(false)`).
  - `it never looks for claude` (`claude: () => { throw new Error('never') }`).
  - `orca with no verb, another verb or an extra word prints the usage and exits 1` (`['orca']`, `['orca', 'status']`, `['orca', 'link', 'extra']`); `DEVICE_USAGE` matches no `/orca/i`.
  - In `describe('takesConnect')`:
    - `a path nothing is at is false` (no file there).
    - `a connect that neither opens nor fails is false after 1 s, and its socket is destroyed` (`vi.useFakeTimers()`; `open` hands back a `new Socket()` it never connects; the promise is still pending after `vi.advanceTimersByTimeAsync(999)`, and `false` after 1 ms more; `socket.destroyed` is true).
    - `an error after it answered is not thrown` (that socket emits `error` after the 1 s: nothing is unhandled).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/deviceClaude/command.spec.ts`. Expected: FAIL (the usage, exit 1; `takesConnect` is not exported).
- [ ] **Step 3: Implement.** Update the file's header comment: `link` is also Orca's plugin's word.
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `cli: harness device orca link says where the devices' socket is, whether the daemon takes a connect, and whether the devices are there`.

### Task 7: End to end: the stream follows a fake dial

**Layer:** test. **Depends on:** Tasks 5, 6. **Effort:** `high`.

**Red test:** none: no behavior (it adds end-to-end tests of what Tasks 1 to 6 built).

**Files:**
- Create: `cli/e2e/dialStream.e2e.ts`

**Interfaces:**
- Consumes: `IsolatedDaemon`, `until`, `CLI_ROOT` (`e2e/harness/daemon.ts`), `Desk`, `FakeDial`, `InOrca`, as `dialPaneFollow.e2e.ts` and `dialTerminalFollow.e2e.ts` use them. It runs on every platform: no `skipIf`.
- `link(d)`: the real CLI, `[...CLI_ENTRY, 'device', 'orca', 'link']` under `d.env` only, its stdout parsed. Before the first run the test checks, as `dialTerminalFollow.e2e.ts` does: `env.ADAPTER_DATA_DIR` is `d.dataDir`, `env.PORT` is not `18473`, and `devicesListenerPath(d.dataDir, process.platform, env.HOME)` is `join(d.dataDir, 'devices.sock')`.
- `stream(socketPath)`: `node:http` `request({ socketPath, method: 'POST', path: '/' })` with the body `{"type":"dial","standby":true}`; its status, its lines as they come, and its close. The socket path is the one `link` printed.
- An agent's name is read from the `agent` frame the fake dial got for its id: the name the dial draws.
- `link(d)`, `stream(socketPath)`, the daemon and desk set-up and the focus that is sent again are the file's own helpers: Task 15 adds a case that uses them.
- Every agent is listed before the first focus. A session drops a dial's `focus` while it waits for the echo of a focus it re-asserted after a ring push (`cableSession.ts`, `expectedAppFocusEcho`), and the fake dial echoes nothing: each step sends its focus again every 2 s until its line is read, as `swipedTo` does in `dialTerminalFollow.e2e.ts`.

- [ ] **Step 1: Write the tests** (a daemon of its own for each case, `CABLE_DISABLE: 'false'`, `HARNESSD_TEST_DIAL_PORT` on a `Desk`; `O` an `InOrca` session with `__CFBundleIdentifier: 'com.stablyai.orca'` and an `ORCA_TERMINAL_HANDLE`; `W` one with `WEZTERM_PANE: '7'`; dials with no `appFilter`, so one ring holds both):
  - `before a dial, link says the daemon takes a connect and the devices are not ready; a dial plugged in makes them ready` (first `{ daemon: true, devicesSocket: join(d.dataDir, 'devices.sock'), devicesReady: false }`; after `desk.plug`, `until` `devicesReady` is true).
  - `the stream opens on the state as it is, and each move of the dial is one line`: the first line is `{"attached":true,"agent":null}`; `dial.send({ t: 'focus', agentId: O.id })` gives `{"attached":true,"agent":{"name":<O's name>,"app":"Orca"}}`; a focus on `W` gives its name with `"app":"WezTerm"`; a second focus on `W` gives none; a focus on `O` again makes the lines exactly those four.
  - `a second stream is 409 while the first is open, and a stream once it closed` (the open is tried again every second until it is 200).
  - `two dials: the one that did not move last going changes nothing, the one that did says agent null, and the last one going says attached false` (dials `A` and `B`; `A` to `O`, `B` to `W`; `desk.unplug` of `A`: no line by the time `B`'s next focus on `O` is read; `desk.unplug` of `B`: `{"attached":false}`. In a second run of the two: `A` to `O`, `B` to `W`, unplug `B`: `{"attached":true,"agent":null}`; `A` to `W`: its line).
  - `the daemon's log says each open and end of the stream, and nothing of an agent` (every line with `dial stream` matches `/\[devices\] dial stream · (open|ended · (gone|stalled|closed)|\d+ lines in the last minute)$/`).
- [ ] **Step 2: Run**, on this Mac, `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialStream.e2e.ts`. Expected: PASS.
- [ ] **Step 3: Commit** `e2e: the dial stream follows a fake dial, found through harness device orca link`.

### Task 8: The plugin's folder: manifest, typings and protocol

**Layer:** plugin files. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: no behavior (a manifest, config and types; `orca plugin validate` reads them in Task 13).

**Files:**
- Create: `plugins/harness-device-orca/orca-plugin.json`, `plugins/harness-device-orca/tsconfig.json`, `plugins/harness-device-orca/.gitignore`, `plugins/harness-device-orca/.gitattributes`, `plugins/harness-device-orca/src/protocol.ts`

**Interfaces:**
- Produces, `orca-plugin.json`, exactly:
  ```json
  {
    "manifestVersion": 2,
    "id": "harness-device",
    "name": "Harness Device",
    "version": "0.1.0",
    "description": "The dial's state in Orca.",
    "license": "MIT",
    "engines": { "orca": ">=1.4.248" },
    "execution": "trusted-worker",
    "pluginApi": 1,
    "main": "src/worker.ts",
    "contributes": {
      "panels": [{ "id": "dial", "title": "Harness Device", "icon": "gauge", "entry": "src/panel.tsx", "ui": "components" }],
      "statusBarItems": [{ "id": "dial", "text": "Dial", "icon": "gauge", "tooltip": "Harness Device" }]
    }
  }
  ```
  `version` and `description` are the PM's (2026-11-16).
- Produces, `src/protocol.ts`:
  ```ts
  export type DialAgent = { name: string; app: string }
  export type DialState = {
    state: 'checking' | 'windows' | 'noHarness' | 'notRunning' | 'elsewhere' | 'unplugged' | 'attached'
    agent?: DialAgent
  }
  declare module 'orca' {
    interface PluginRequests { 'dial.get': { output: DialState } }
    interface PluginPanelEvents { 'dial.changed': DialState }
  }
  ```
- `tsconfig.json` is the template's: `{ "extends": "./.orca/types/tsconfig.json", "include": ["src"] }`. `.gitignore` is `.orca/`. `.gitattributes` is the template's `* -text`.

- [ ] **Step 1: Write the files.**
- [ ] **Step 2: Run** `cd plugins/harness-device-orca && orca plugin types . && git status --short -uall .`. Expected: the five files, and nothing under `.orca/`.
- [ ] **Step 3: Run** `cd plugins/harness-device-orca && orca plugin validate .`. Expected: its only complaints name `src/worker.ts` and `src/panel.tsx`, which Tasks 11 and 12 add.
- [ ] **Step 4: Commit** `plugins: the Harness Device plugin for Orca, its manifest and protocol`.

### Task 9: The loop's inputs, and Node's real ones

**Layer:** plugin worker. **Depends on:** Task 8. **Effort:** `high`.

**Red test:** `plugins/harness-device-orca/src/inputs.test.ts`.

**Files:**
- Create: `plugins/harness-device-orca/src/inputs.ts`
- Test: `plugins/harness-device-orca/src/inputs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** A file that is not there, its stdout when it exited 0 inside the bounds, or null for any other end. */
  export type Ran = 'missing' | string | null
  export interface Answer { status: number; chunks: AsyncIterable<Uint8Array> }
  export interface DialInputs {
    platform: string
    /** '' when there is none. */
    home: string
    path: string
    run(file: string, args: readonly string[], bounds: { path: string; timeoutMs: number; maxBytes: number; signal: AbortSignal }): Promise<Ran>
    /** POST `body` to `/` on the Unix socket. Null when it cannot connect, or is aborted before the answer's head. */
    connect(socketPath: string, body: string, signal: AbortSignal): Promise<Answer | null>
    /** `changed` gets the entry's name, or null where the platform gives none. Returns its close. */
    watch(folder: string, changed: (name: string | null) => void): () => void
    /** Monotonic milliseconds. */
    now(): number
    after(ms: number, run: () => void): () => void
  }
  export function nodeInputs(): DialInputs
  ```
- Rules, for `nodeInputs()`:
  - `platform`, `home` (`os.homedir()`) and `path` (`process.env.PATH ?? ''`) are read when it is called.
  - `run`: `execFile`, no shell, `PATH` set to `bounds.path` in the child's environment, `killSignal` `SIGKILL`. `ENOENT` is `'missing'`. A non-zero exit, a timeout, output over `maxBytes` and an abort are null.
  - `connect`: `node:http` `request({ socketPath, method: 'POST', path: '/' })`. An error before the head is null. An abort after it ends the chunks. No `error` event is left unhandled.
  - `watch`: `fs.watch`. A folder that cannot be watched returns a close that does nothing. A watcher's `error` is swallowed.
  - `now` is `performance.now()`. `after` is `setTimeout`, unref'd, and returns its cancel.
- Tests use `orca/testing` (`test`, `assert`) and write every file, script and socket in a folder of their own under `/tmp` (`mkdtempSync('/tmp/hdo-')`), removed after.

- [ ] **Step 1: Write the failing tests:**
  - `run answers the stdout of a file that exits 0` (a `#!/bin/sh` script the test wrote).
  - `a file that is not there is missing, and so is a bare name the PATH it is given does not hold`.
  - `a bare name is found through the PATH it is given, not the process's own`.
  - `a non-zero exit, output over maxBytes and a run past its timeout are null, and the run past its timeout is killed` (a script that writes its pid to a file, then `exec /bin/sleep 60`; `timeoutMs: 200`; the promise settles null, and the test then waits until `process.kill(pid, 0)` throws).
  - `an abort ends a run: null`.
  - `connect posts the body to / and hands on the status and the chunks` (a `node:http` server on a socket in the test's folder; it got `POST`, `/` and the body).
  - `a socket that is not there, and one nothing listens on, are null`; `an abort before the answer is null`; `an abort after it ends the chunks`.
  - `watch tells the name of an entry made in its folder; after its close it tells nothing`; `a folder that is not there is watched by nothing and throws nothing`.
  - `nodeInputs reads the platform, the home and PATH as they are when it is called` (`process.env.HOME` and `PATH` set to the test's folder, restored after).
- [ ] **Step 2: Run** `iso test .`. Expected: FAIL (no `./inputs`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `iso test .` and the plugin's type check. Expected: `1 test file(s) passed (node).`, and no type error.
- [ ] **Step 5: Commit** `plugins: the Orca plugin's inputs, and Node's real ones`.

### Task 10: The loop

**Layer:** plugin worker. **Depends on:** Task 9. **Effort:** `xhigh` (a process, a stream, a watcher and a wait, each racing a stop; the launcher's and the stream's text are outside text).

**Red test:** `plugins/harness-device-orca/src/dial.test.ts`.

**Files:**
- Create: `plugins/harness-device-orca/src/dial.ts`
- Test: `plugins/harness-device-orca/src/dial.test.ts`

**Interfaces:**
- Consumes: `DialInputs`, `Ran`, `Answer`, `nodeInputs` (Task 9); `DialState` (Task 8).
- Produces:
  ```ts
  export const LINK_ARGS = ['device', 'orca', 'link'] as const
  export const DIAL_OPEN = '{"type":"dial","standby":true}'
  export interface Dial { state(): DialState; stop(): Promise<void> }
  export function startDial(inputs: DialInputs, tell: { changed(state: DialState): void; log(line: string): void }): Dial
  ```
- Rules. The state starts as `{ state: 'checking' }`. `tell.changed` is called only when the state differs from the current one. `tell.log` gets `dial: <state>` when the state's name changes. **A pass:**
  1. `platform` is `win32`: `windows`, and the loop ends. Nothing is run or scheduled.
  2. `run(file, LINK_ARGS, { path, timeoutMs: 5_000, maxBytes: 4_096, signal })` for `<home>/.local/bin/harness` (skipped when `home` is `''`), then `harness`. The first answer that is not `'missing'` is the launcher's. Both missing: `noHarness`.
  3. The answer must be a JSON object whose `daemon` and `devicesReady` are booleans and whose `devicesSocket` is absent or a string that starts with `/`; `devicesReady` true needs a `devicesSocket`. Anything else, and null: `notRunning`. `daemon` false: `notRunning`. `devicesReady` false: `unplugged`.
  4. `connect(devicesSocket, DIAL_OPEN, signal)`, aborted by the loop's own `after(2_000, …)` if no answer came. `409`: `elsewhere`. Any other status but `200`: `notRunning`. No answer (null: the connect was refused, or no head came in 2 s): `notRunning`.
  5. On `200` the chunks are read as lines. At most 1 KiB is held: a line over it, or 1 KiB with no newline, drops the stream. Each line:
     - `{"replaced":true}` ends the stream like a close;
     - `attached` false: `unplugged`; `attached` true with `agent` null: `attached`; with an `agent` whose `name` and `app` are strings: `attached` with `{ name, app }` and no other key;
     - anything else is skipped and counted. When the stream ends with a count, `tell.log` gets `dial: <n> lines skipped`.
  6. When a pass ends without the loop ending, the state is kept, and the next pass starts after the wait: 1 s, then doubling to 30 s. A stream that stayed open over 30 s (by `now()`) sets the wait back to 1 s.
- **The watch.** While the state is `unplugged` and `link` printed a `devicesSocket`, one watcher is on that socket's folder. A change of the socket's own entry, or of any entry where the platform gives no name, starts a pass now, or a second after the last pass began if that is later. A change that comes while a pass runs starts one more pass after it. The watcher closes when the state leaves `unplugged`.
- **`stop()`** aborts a running `link` and an open stream, closes the watcher, cancels the wait, and resolves once the pass in flight has ended. Nothing is told or logged after it is called.
- Tests: a clock the test moves (`now`, and `after` that fires when the clock passes it), a `run` that answers from a list and records its calls, a `watch` that hands the test its `changed`, and `nodeInputs().connect` against a `node:http` server on a socket in the test's own `/tmp` folder. Each step waits for the next `changed` call, never for time.

- [ ] **Step 1: Write the failing tests:**
  - `on Windows the state is windows, and nothing is run or scheduled`.
  - `with no launcher the state is noHarness; ~/.local/bin/harness is asked first, then harness` (the runs are `['/h/.local/bin/harness', 'harness']`, each with `['device', 'orca', 'link']` and `{ path, timeoutMs: 5000, maxBytes: 4096 }`); `with no home only harness is asked`.
  - `a launcher that fails is notRunning` (null).
  - `a launcher that prints anything else is notRunning, and nothing is connected`: `''`, `'warning\n{"daemon":true}'`, `'[]'`, `'{"daemon":"yes","devicesReady":true}'`, `'{"daemon":true}'`, and `daemon` and `devicesReady` true with `devicesSocket` `'devices.sock'`, `7` or absent.
  - `daemon false is notRunning, whatever devicesReady says, and nothing is connected; daemon true with devicesReady false is unplugged`.
  - `unplugged watches the folder of devicesSocket, and a change of the socket's entry asks link again at once` (`watch` got `dirname(devicesSocket)`; `changed('devices.sock')` adds a run with no clock move); `a change of another entry asks nothing` (`'registry.json'`); `a change with no name asks`.
  - `changes ask link at most once a second` (three changes in a row: one run now, one more when the clock reaches a second after it).
  - `a change while link runs asks once more`.
  - `the watcher closes when the state leaves unplugged`.
  - `the stream: the open is POST / with {"type":"dial","standby":true}, and each line becomes the state` (the three lines of Global Constraints give `{ state: 'unplugged' }`, `{ state: 'attached' }`, `{ state: 'attached', agent: { name: 'api', app: 'Orca' } }`).
  - `a 409 is elsewhere; a 404, a 429 and a 500 are notRunning`.
  - `a connect that is refused, or gets no answer in 2 s, is notRunning` (a socket file nothing listens on; a server that never answers, the clock moved 2 s).
  - `a line split across two chunks is one state, and two lines in one chunk are two`.
  - `a line over 1 KiB, and 1 KiB with no newline, drop the stream` (the server sees its connection close; the state is kept).
  - `a malformed line is skipped and counted, the state stays, and the next good line is taken` (`not json`, `[]`, `{"attached":"yes"}`, `{"attached":true}`, `{"attached":true,"agent":{"name":1,"app":"Orca"}}`; the log has `dial: 5 lines skipped` once the stream ends).
  - `only name and app are taken from an agent`.
  - `{"replaced":true} ends the stream like a close`.
  - `when the stream ends the state is kept, and link is asked again after 1 s, 2 s, 4 s, 8 s, 16 s, 30 s and 30 s`.
  - `a stream that stayed open over 30 s starts the wait again from 1 s; one that stayed 30 s does not`.
  - `the same state twice is told once`.
  - `stop ends a running link, an open stream, the watcher and the wait, and nothing is told after it` (each in its own case: the run's `signal` is aborted; the server sees the connection close; the watch's close ran; no timer is left).
  - `the log names each state as it changes, and holds no name, app or path`.
- [ ] **Step 2: Run** `iso test .`. Expected: FAIL (no `./dial`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `iso test .` and the plugin's type check. Expected: `2 test file(s) passed (node).`, no type error.
- [ ] **Step 5: Commit** `plugins: the Orca plugin's loop, from the launcher to the dial stream's lines`.

### Task 11: The panel

**Layer:** plugin panel. **Depends on:** Task 8. **Effort:** `high`.

**Red test:** `plugins/harness-device-orca/src/panel.test.tsx`.

**Files:**
- Create: `plugins/harness-device-orca/src/panel.tsx`
- Test: `plugins/harness-device-orca/src/panel.test.tsx`

**Interfaces:**
- Consumes: `DialState`, `'dial.get'`, `'dial.changed'` (Task 8).
- Produces: the module's default export `Panel` and `setup(ctx)`, as the template's `src/panel.tsx` has them.
- Rules:
  - One atom holds the state, `{ state: 'checking' }` at first. `setup` subscribes to `dial.changed` (pushed to `ctx.subscriptions`) and asks `dial.get` once.
  - It draws the table of Global Constraints with Orca's `Stack`, `Text` and `Button` only. The app's line is `Text` with `muted`. A name and an app are `Text` children, never `Markdown`.
  - **Get Harness** calls `shell.openExternal('https://harness.autonomous.ai/desktop')`. No other state draws a control.
  - There is no `src/panel.check.ts`.

- [ ] **Step 1: Write the failing tests** (`mount(panel, { host: mockHost({ requests: { 'dial.get': () => state } }) })`; each ends with `view.errors`, `view.warnings` and `view.refusals` empty, then `view.unmount()`):
  - `checking draws nothing` (no element has text; no button).
  - `each state draws its line`: `windows`, `noHarness`, `notRunning`, `elsewhere`, `unplugged` and `attached` with no agent, each found by `view.find({ text: <the exact copy> })`.
  - `an agent is its name, and its app on a second line` (`{ state: 'attached', agent: { name: 'api', app: 'Orca' } }`: both texts are found, and "Dial attached." is not).
  - `Get Harness opens https://harness.autonomous.ai/desktop` (`await view.press({ text: 'Get Harness' })`; `host.callsOf('shell.openExternal')` is `[{ url: 'https://harness.autonomous.ai/desktop' }]`).
  - `only noHarness has a button` (`view.findAll({ role: 'button' })` is empty for every other state).
  - `the panel follows dial.changed with no refresh` (`view.post('dial.changed', …)` through three states, the last an agent, then `unplugged`: the name is gone).
  - `a name is drawn as it is` (`'**bold** [x](http://e) <b>'` is found as that text).
- [ ] **Step 2: Run** `iso test .`. Expected: FAIL (no `./panel`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `iso test .` and the plugin's type check. Expected: PASS.
- [ ] **Step 5: Commit** `plugins: the Orca plugin's panel draws the dial's state`.

### Task 12: The worker

**Layer:** plugin worker. **Depends on:** Task 10. **Effort:** `high`.

**Red test:** `plugins/harness-device-orca/src/worker.test.ts`.

**Files:**
- Create: `plugins/harness-device-orca/src/worker.ts`
- Test: `plugins/harness-device-orca/src/worker.test.ts`

**Interfaces:**
- Consumes: `startDial`, `Dial` (Task 10); `nodeInputs`, `DialInputs` (Task 9); `DialState` (Task 8); `OrcaWorkerApi` (`import type` from `orca/worker`).
- Produces:
  ```ts
  /** The loop wired to Orca: `dial.get`, `dial.changed`, the status bar item and the log. Returns its stop. */
  export function wire(orca: OrcaWorkerApi, inputs: DialInputs): () => Promise<void>
  export default function activate(orca: OrcaWorkerApi): void
  export async function deactivate(): Promise<void>
  ```
- Rules:
  - `activate` is `wire(orca, nodeInputs())`, its stop kept for `deactivate`. It does not wait for the loop.
  - `wire` registers `orca.panels.handle('dial.get', …)`, which answers the loop's current state, and starts the loop with `log: orca.log`.
  - At once, and on each change of state, it calls `orca.host.call('statusBar.update', …)`: `{ id: 'dial', visible: true, text }` with `text` `Dial` or the agent's name, or `{ id: 'dial', visible: false }` (Global Constraints, "The status bar item"). On each change it also calls `orca.panels.post('dial.changed', state)`.
  - A `statusBar.update` that rejects is logged once as `dial: status bar unavailable`. The post still goes, and the loop goes on.
  - The stop stops the loop and disposes the handler.

- [ ] **Step 1: Write the failing tests.** The wiring cases mount `{ default: (orca) => { stop = wire(orca, inputs(…)) }, deactivate: () => stop() }` with `mountWorker`, where `inputs(over)` is a `DialInputs` of the test's own (`run` and `connect` answer what the case gives; `watch` and `after` do nothing):
  - `before the first pass dial.get says checking, and the status bar item is hidden` (a `run` that never settles; `worker.request('dial.get')` is `{ state: 'checking' }`; `host.callsOf('statusBar.update')` is `[{ id: 'dial', visible: false }]`).
  - `each change posts dial.changed and updates the status bar` (a `connect` whose chunks the test feeds the three lines: `worker.posts` ends with the three states as `dial.changed`, and the updates end `{ id: 'dial', visible: false }`, `{ id: 'dial', visible: true, text: 'Dial' }`, `{ id: 'dial', visible: true, text: 'api' }`).
  - `dial.get answers the state as it is now` (after the agent's line).
  - `the log names the state and never the agent's name` (`worker.logs` holds `dial: attached` and no `api`).
  - `a status bar update Orca refuses is logged once, and dial.changed is still posted` (`mockHost({ results: { 'statusBar.update': () => { throw hostError('unavailable') } } })`, two changes).
  - `deactivate stops the loop: nothing is posted or updated after it`.
  - `the real worker, with a home and a PATH that hold no launcher, says noHarness` (`import * as main from './worker'`; `process.env.HOME` and `PATH` set to an empty folder of the test's own before `mountWorker(main)` and restored after; wait for a `dial.changed` post of `{ state: 'noHarness' }`; `worker.refusals` is `[]`; `await worker.deactivate()`).
- [ ] **Step 2: Run** `iso test .`. Expected: FAIL (no `./worker`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `iso test .` and the plugin's type check. Expected: PASS.
- [ ] **Step 5: Commit** `plugins: the Orca plugin's worker tells the panel and the status bar each change`.

### Task 13: The README, and the plugin's gates

**Layer:** plugin files. **Depends on:** Tasks 11, 12. **Effort:** `medium`.

**Red test:** none: no behavior.

**Files:**
- Create: `plugins/harness-device-orca/README.md`

- [ ] **Step 1: Write the README**, in the shape and length of `plugins/harness-device/README.md`:
  - **What it does:** the panel and the status bar item, each state in one line, and that it changes as the dial moves.
  - **What it never does:** it types nothing, sends nothing off the computer and keeps nothing; it reads only whether a dial is attached and the name and app of the agent it shows, from the Harness daemon on this computer.
  - **Install:** `orca plugin install <this repository>/plugins/harness-device-orca`; it needs Orca 1.4.248 or later; macOS and Linux, "Not on Windows yet." on Windows.
  - **The access Orca asks for:** its worker is a Node process with the person's own access. It uses that to run `harness device orca link` (`~/.local/bin/harness`, then `harness` on `PATH`) and to read one local socket. It declares no capability.
- [ ] **Step 2: Run** `iso test .`. Expected: `4 test file(s) passed (node).`
- [ ] **Step 3: Run** `cd plugins/harness-device-orca && orca plugin validate .`. Expected: `orca-plugin.json: ok`, no warning.
- [ ] **Step 4: Run** `iso check .`. Expected: exit 0; the panel renders with no issue, and its summary holds "Harness isn't installed." or, if check drew before the worker's first pass ended, no text. Any other state is a failure: the worker reached a launcher.
- [ ] **Step 5: Run** the plugin's type check. Expected: no output.
- [ ] **Step 6: Commit** `plugins: the Orca plugin's README`.

### Task 14: Say it in the docs

**Layer:** repo files. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: no behavior.

**Files:**
- Modify: `cli/AGENTS.md`, `cli/src/services/AGENTS.md`

- [ ] **Step 1:** Write the changes, in each file's own words and length:
  - `cli/AGENTS.md`, the devices row of the processes table: the agent the dial shows (in memory), told to Orca's Harness Device plugin on the listener's `dial` stream.
  - `cli/src/services/AGENTS.md`, the devices paragraph: `tabs` is no longer the one handler of a second kind. `dial` is a stream too, opened with `standby`, on which the devices say whether a dial is attached and which agent it shows; a stream's handler is told when it can write and why it ended.
- [ ] **Step 2:** Check every link resolves.
- [ ] **Step 3: Commit** `docs: the devices' dial stream, for Orca's Harness Device plugin`.

### Task 15: End to end: the plugin's loop follows a fake dial

**Layer:** test. **Depends on:** Tasks 7, 9, 10. **Effort:** `high`.

**Red test:** none: no behavior (it adds an end-to-end test of what Tasks 5, 6, 9 and 10 built).

**Files:**
- Create: `cli/e2e/harness/pluginDial.ts`
- Modify: `cli/e2e/dialStream.e2e.ts` (Task 7's file: this task starts once Task 7 is done)

**Interfaces:**
- Consumes: `startDial` (Task 10), `nodeInputs` (Task 9), `DialState` (Task 8); `link(d)`'s three checks, the daemon and desk set-up and the focus that is sent again (Task 7).
- Produces, `cli/e2e/harness/pluginDial.ts`: a script, not a module anything imports. It runs the plugin's own files:
  ```ts
  import { startDial } from '../../../plugins/harness-device-orca/src/dial.ts'
  import { nodeInputs } from '../../../plugins/harness-device-orca/src/inputs.ts'
  ```
  - It calls `startDial(nodeInputs(), { changed, log })`: `changed` prints `JSON.stringify(state)` and a newline on stdout, `log` prints the line on stderr.
  - It reads its stdin and keeps nothing of it. That holds the process open while the loop only waits. When stdin ends it awaits `dial.stop()` and returns.
  - It never calls `process.exit` and handles no signal: the process ending by itself, with code 0, is the check that `stop()` left no stream, watcher or timer.
- Why a process, and not an import in the test: vitest cannot transform a file under the plugin's folder where `.orca/types/tsconfig.json` is missing (it is generated and not in Git; vitest 4.1.10 says "Failed to load tsconfig", checked 2026-11-16). `tsx` reads the tsconfig of its working folder, `cli/`, and runs them. A process also takes `nodeInputs()` whole: its home and `PATH` are its environment's.
- Produces, in `dialStream.e2e.ts`, `loop(d)`:
  - **The launcher shim**, written to `join(d.env.HOME!, '.local', 'bin', 'harness')` with mode `0o700`: `#!/bin/sh`, then one line, ``cd <CLI_ROOT> && exec /usr/bin/env -i <each set entry of d.env as NAME=value> <process.execPath> <...CLI_ENTRY> "$@"``, each word in single quotes. The CLI it starts gets `d.env` and nothing else, as `link(d)` does.
  - **The checks before the start:** `link(d)`'s three, and the shim's path starts with `d.root + sep`.
  - **The process:** `spawn(process.execPath, ['--import', 'tsx', 'e2e/harness/pluginDial.ts'], { cwd: CLI_ROOT, env: { HOME: d.env.HOME, PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] })`, kept in the file's `children` so `afterEach` kills one a failed test left. `/usr/bin:/bin` holds no `harness`: with no shim the state would be `noHarness`, never this Mac's launcher.
  - It returns `{ states, logs, stop() }`: the stdout lines parsed, the stderr lines, and `stop()`, which ends the child's stdin and resolves with its exit code.

- [ ] **Step 1: Write the script and the test** (a daemon of its own, `CABLE_DISABLE: 'false'`, `HARNESSD_TEST_DIAL_PORT` on a `Desk`; `O` an `InOrca` session as in Task 7, listed before the loop starts):
  - `the plugin's loop, through the launcher in the throwaway home, follows the dial`:
    1. No dial yet. `loop(d)`: `until` the last state is `{ state: 'unplugged' }`.
    2. `desk.plug`: `until` the last state is `{ state: 'attached' }`.
    3. The dial's focus on `O`, sent again every 2 s: `until` the last state is `{ state: 'attached', agent: { name: <O's name>, app: 'Orca' } }`.
    4. `desk.unplug`: `until` the last state is `{ state: 'unplugged' }`.
    5. `states` is exactly those four, in that order: no `notRunning`, `noHarness` or `elsewhere` was ever told.
    6. `await run.stop()` is `0`. `until` it comes, the last `dial stream` line of the daemon's log is `[devices] dial stream · ended · gone`: the loop closed the stream it held.
    7. `logs` holds `dial: unplugged` and `dial: attached`, and no line holds `O`'s name, `Orca` or `d.root`.
- [ ] **Step 2: Run**, on this Mac, `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialStream.e2e.ts`. Expected: PASS, Task 7's cases included.
- [ ] **Step 3: Run** `cd cli && E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/dialStream.e2e.ts`, as the workflow starts its daemons. Expected: PASS.
- [ ] **Step 4: Commit** `e2e: the Orca plugin's loop follows a fake dial, through a launcher in the throwaway home`.

---

## Verification

**Platforms the pull request names:** the daemon and the CLI on macOS and Linux (unit tests in PR CI on Linux; end to end on this Mac and on the workflow's Linux runners). The plugin on macOS (its gates run on this Mac; Orca on Linux is not tested). Windows: the plugin shows "Not on Windows yet." and `link` prints no `devicesSocket`, both by unit test; nothing else changes.

**Temporary workflow:** none. The one long check is the CLI's end-to-end suite, which has its own workflow (`.github/workflows/cli-e2e.yml`). The new file stays in its nightly run (PM, 2026-11-16) with no workflow change: the shards take every `e2e/**/*.e2e.ts`, and a file with no timing hint in `ci-e2e-durations.json` gets the default cost. The plugin's gates need the Orca CLI, which no runner has: they are local, as the PM decided.

**Turns.** The tester asks the orchestrator before the one hand-started GitHub run (check 1).

**Local gates**, recorded in the pull request (PR CI does not run them):
- `cd cli && npm run typecheck`.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit. These paths select one check, `cli-core` (`npm run test:core`: 100% per file for `services/devicesListener.ts` and `services/devices.ts`). Its fence goes in the pull request's body before the push it describes.
- `cd cli && npx vitest run src/architecture.spec.ts src/leanEntry.spec.ts`, and `git diff --stat "$(git merge-base HEAD origin/main)" -- cli/src/core cli/src/architecture.coreFiles.txt cli/src/cable/cableFleet.ts` prints nothing: the core is unchanged.
- The plugin's five gates (check 2).
- Not needed: `npm run test:harnessd` and the other coverage gates, the serial and PTY specs (`cable/serial*.ts` is untouched), `cargo test` for `device-app/`, Desktop tests.

**1. The real daemon, fake dials, the real `harness device orca link`, and the plugin's own loop**
- Run, on this Mac, at the final head: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialStream.e2e.ts e2e/dialTerminalFollow.e2e.ts e2e/dialPaneFollow.e2e.ts e2e/dialClaudeAppFollow.e2e.ts e2e/hardwareWatch.e2e.ts e2e/devicesProcess.e2e.ts`. The last five prove the changed listener and session under what already used them.
- Isolation: the suite's own (`e2e/harness/daemon.ts`). A throwaway home and data folder, a private port and tmux server, fake engines, fake dials on pseudo-terminals. No backend and no sign-in. `link` runs under the throwaway daemon's environment, and the test checks the socket it prints is inside that daemon's data folder and that its port is not 18473. The plugin's loop (`src/dial.ts` with `src/inputs.ts`, Task 15) runs in a Node process whose whole environment is the throwaway home and `PATH=/usr/bin:/bin`; its launcher is a shim the test writes in that home, which starts this checkout's CLI under the throwaway daemon's environment and nothing else. No Orca app runs and no plugin is loaded. The everyday daemon, Diego's dial, his Orca and production are not touched.
- A person sees: every test passes. In the new file: `link` says `devicesReady` false, then true once a dial is plugged in; the stream's lines follow the fake dial's swipes; a second stream gets 409; the daemon's log has `[devices] dial stream · open` and `· ended · gone`, with no agent's name in them; the plugin's loop says `unplugged`, `attached`, the agent's name with `Orca`, then `unplugged`, and its process ends with code 0 once it is stopped.
- On GitHub, by hand, once on the final head: Actions → CLI end to end → Run workflow, branch `feat/orca-device-plugin` (`.github/workflows/cli-e2e.yml`). Its shards are Linux; `dialTerminalFollow` is skipped there. Every shard passes. After merge the nightly run of the same workflow keeps `dialStream.e2e.ts` running.

**2. The plugin's gates** (this Mac, at the final head, the plugin committed)
- `iso test .`: `4 test file(s) passed (node).` The loop's server and sockets, the runner's scripts and the watched folder are all in folders the tests make under `/tmp`. The home is empty and `PATH` is `/usr/bin:/bin`, so no test can find this Mac's `harness`.
- `iso check .`: exit 0. It mounts the real worker, which finds no launcher: the panel draws "Harness isn't installed." or nothing, never another state.
- `cd plugins/harness-device-orca && orca plugin validate .`: `orca-plugin.json: ok`.
- `cd plugins/harness-device-orca && orca plugin release-entry .`: a release for the final commit, with `version` `0.1.0`, that commit's full SHA, a `contentHash`, and `source.path` `plugins/harness-device-orca`. It is pasted in the pull request and published nowhere.
- The plugin's type check: no output.
- On GitHub: none. No runner has the Orca CLI.

**3. Linux, in PR CI:** `cli-typecheck` and `cli-tests` run Tasks 1 to 6's specs; `process-checks` runs for the docs and the plugin's files. Nothing is started by hand.

**Not run in this branch, and what no check here covers:**
- The plugin inside the Orca app. After merge Diego can run `orca plugin install <repo>/plugins/harness-device-orca`, approve it, and look: the panel "Harness Device" in the right sidebar and the status bar item follow his dial. This is his own look, not a check of this branch.
- `src/worker.ts` and `src/panel.tsx` against a real daemon. Check 1 runs the loop and Node's inputs; the wiring to Orca and the panel meet only Orca's test kit (Tasks 11, 12).

## Answered (PM for Diego, 2026-11-16)

No question is open. The spec carries each answer ("Plan answers").

1. **A socket left by a process that died.**
   - (a) `devicesReady`, and the connect is refused or no answer's head comes in 2 s: `notRunning`. Task 10.
   - (b) `link` tries a connect to the daemon's socket, 1 s at most, and says `daemon: true` only when it is taken. Task 6.
2. **The folder watch** reacts only to `devices.sock`, or to any entry where the platform gives no name. Task 10.
3. **The new end-to-end file stays in the nightly run**, with no workflow change. Verification.
4. **The plugin's loop runs against the isolated daemon**, with Node's real inputs, through a launcher shim in the throwaway home. Task 15.
5. **The manifest:** `version` `0.1.0`, `description` "The dial's state in Orca.". Task 8.

## Decided here, where the spec was silent

- One signal, `onWritable`, serves the spec's two needs: the first line once the stream is writable, and the drain.
- A writable listener that throws ends its stream as `closed`, counted `failed`. A stream that never opened is aborted as `closed`. `replaced` is a fourth reason, which only `tabs` can meet.
- The `dial` handler refuses an open whose `standby` is not `true`. That is what makes the spec's "`replaced` cannot happen for `dial`" true, whoever the client is.
- The host hands on every report it takes. Only the stream drops a repeat, since only it knows the last line written.
- A dial is told apart by its session object, so `cableFleet.ts` does not change.
- A session's report is guarded: a host that throws costs that dial a fault, never the move or the close.
- The minute's count runs on the devices' own guarded timer (`timerIn('dial')`), set at the first line, so stopping the devices cancels it.
- `terminal`, the app of an agent in a terminal the daemon does not know, is in the table: its app reads "Terminal".
- `link` connects only to a daemon's socket that is already this account's own, and writes nothing on it. It does not connect to the devices' socket: a connection there counts against that listener's 16, and the worker's own open finds a stale one.
- The connect's 1 s is a function of its own, `takesConnect`, whose opener a test replaces: a real Unix socket cannot be made to leave a connect waiting. `DeviceDeps` and `cli.ts` stay as they are.
- `link` on Windows prints `{"daemon":false,"devicesReady":false}`. With a data folder and a home both too long for a socket it leaves `devicesSocket` out as well, and the panel reads "Dial unplugged." or "Harness isn't running." there.
- Node's real inputs sit in `src/inputs.ts`, and `src/worker.ts` passes them on, as the spec says it does. The loop's tests can then use the real socket connector without loading the worker.
- "Exists" for the launcher is the run itself: `ENOENT` is not there. A launcher that is there and cannot be run is `notRunning`.
- The loop times the wait for the answer's head on its own clock, so a test moves it. 2 s is the listener's own deadline.
- The state is kept while the loop waits after a stream ends, as the spec's Failure table reads ("the last state, for up to 1 s").
- The watcher stays across passes while the state is `unplugged`, and a change during a pass is not lost.
- The worker logs a state's name when it changes, not each agent; the skipped lines when their stream ends; a refused status bar update once.
- `statusBar.update` is called on every change, a repeat of `visible: false` included.
- The panel uses `Stack`, `Text` and `Button`. A name is never `Markdown`.
- The panel's and the status bar item's ids are both `dial`. `manifestVersion` 2 and `pluginApi` 1 are the template's, and so is `.gitattributes` (`* -text`), which keeps the plugin's `contentHash` the same on every checkout.
- The plugin's `tsconfig.json` is the template's. Node's typings come to the type check by flags, from `cli/node_modules`, so the plugin folder names no other folder.
- The plugin's tests and `check` always run with an empty home and `PATH=/usr/bin:/bin`, the tests included, though the spec asks it of `check` alone.
- `plugins/harness-device-orca/` gets no line in `.claude-plugin/marketplace.json`: that file lists Claude Code plugins.
- The end-to-end case runs the loop in a Node process of its own, through `tsx`, not as an import in the test: vitest cannot transform a file under the plugin's folder without the generated `.orca/types/tsconfig.json`. The process's environment is the throwaway home and a bare `PATH`, so `nodeInputs()` is used whole.
- That process is stopped by ending its stdin and is never told to exit: its code 0 is the check that `stop()` left nothing open.
- The shim starts the CLI through `env -i` with the throwaway daemon's variables only, so nothing of the developer's environment reaches `link`.
