# The dial's swipe in Orca stays in the worktree on screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. No task pushes or merges.

**Goal:** While Orca is in front, a swipe on a dial that says `appFilter` moves only among the agents of the Orca worktree on screen, and a prompt in another worktree's agent no longer turns the dial.

**Architecture:**
- **The plugin** (`plugins/harness-device-orca`) asks Orca for `workspace:read`, hears `workspace.changed`, and posts the focused worktree's terminal handles to the devices' listener as `orcaFront`, only while it holds the `dial` stream.
- **The listener** (`cli/src/services/devicesListener.ts`) checks that message, and takes it only while a `dial` stream is open. The stream says when it is open and when it ended.
- **The devices** (`cli/src/services/devices.ts`) keep those handles in memory until the stream ends, and give the dial host a scope for Orca: an agent is in scope when its Orca terminal is one of them.
- **The dial host** (`cli/src/cable/cableHost.ts`) lists only the in-scope agents, in a ring of their own, when the dial says `appFilter`, Orca is the shown app and Orca is the settled front app. Everything else is as today.
- Nothing goes through the core. No firmware, no Desktop, nothing stored. `watch-focus` and the prompt and focus follows are not edited: the scoped list makes `followLocal` answer `no-tile` by itself.

**Tech Stack:** TypeScript daemon (Node, vitest, `cli/`); an Orca plugin in TypeScript with no build step and no dependencies (Orca 1.4.262, `orca/testing` on Node's own test runner).

**Spec:** `docs/plans/2026-11-18-dial-orca-tab-scope-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md`, `cli/src/services/AGENTS.md` and `docs/specs/2026-11-16-orca-device-plugin.md` (the plugin and the `dial` stream this builds on).

**Open questions:** none. The PM answered the draft's two on 2026-11-18 (in "Decided" below).

## Base

- `feat/dial-orca-swipe-current-worktree` at `25d8a404d3` (`main` after #4431). The spec and this plan are untracked. The main session commits them; no task does.
- This Mac has Orca 1.4.262 (`orca --version`). At the base, the plugin's own tests pass: `4 test file(s) passed (node).` (65 tests, 2026-11-18).
- **Two pull requests are open on the same files.** Keep every edit where its task says, so whichever lands second rebases by hand in a minute:
  - #4425 (Herdr scroll) and #4427 (VS Code) both edit `cableHost.ts` at `dialShows`, `devices.ts` in its imports, above the cable host, in its wiring and at the port, and the devices row of `cli/AGENTS.md`.
  - #4427 also edits `devicesListener.ts` inside `openDevicesListener` only, `observed.ts` at `target` and `locate`, `devices.ts` right under `const dial = dialStream(…)`, after `orcaMembers`' `onChange` and after the `notice` handler, and `devices.spec.ts`'s list of the listener's keys.
  - Conflicts to expect: the `const dial = dialStream(…)` line, the keys assertion in `devices.spec.ts`, the one-line devices row of `cli/AGENTS.md`. Each is "keep both".
- The tasks name functions, never lines. If a name differs at the base, the implementer follows the code and says so in its report.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The listener takes `orcaFront`; the `dial` stream says when it is open and when it ended | `cli/src/services/devicesListener.ts`, `devicesListener.spec.ts` | none | xhigh | `devicesListener.spec.ts` |
| 2 The observed source answers where an agent was placed | `cli/src/cable/hosts/observed.ts`, `observed.spec.ts` | none | medium | `observed.spec.ts` |
| 3 The dial host scopes the front app's ring | `cli/src/cable/cableHost.ts`, `cableHost.spec.ts`, `cli/src/cable/hosts/select.ts` | none | high | `cableHost.spec.ts` |
| 4 The devices keep the worktree on screen | `cli/src/services/devices.ts`, `devices.spec.ts` | 1, 2, 3 | xhigh | `devices.spec.ts` |
| 5 The plugin's inputs post one message | `plugins/harness-device-orca/src/inputs.ts`, `inputs.test.ts`, `dial.test.ts`, `worker.test.ts` | none | high | `inputs.test.ts` |
| 6 The loop sends the worktree on screen | `plugins/harness-device-orca/src/dial.ts`, `dial.test.ts` | 5 | xhigh | `dial.test.ts` |
| 7 The worker hears `workspace.changed`; the manifest and the README | `plugins/harness-device-orca/src/worker.ts`, `worker.test.ts`, `orca-plugin.json`, `README.md` | 6 | high | `worker.test.ts` |
| 8 End to end: the plugin's loop scopes a fake dial's list | `cli/e2e/harness/pluginDial.ts`, `cli/e2e/dialStream.e2e.ts` | 4, 6 | high | none: no behavior (the end-to-end test of Tasks 1 to 6), one commit |
| 9 Say it in the docs | `cli/AGENTS.md`, `cli/src/services/AGENTS.md` | none | medium | none: docs only, one commit |

Longest chain: three tasks (5 → 6 → 8, 5 → 6 → 7, or any of 1, 2, 3 → 4 → 8).

- Tasks 1, 2, 3, 5 and 9 share no file and start at once. Tasks 7 and 8 share no file and run beside each other.
- Shared files, each pair ordered by a dependency above: `dial.test.ts` (Tasks 5, 6), `worker.test.ts` (Tasks 5, 7).

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/services/devicesListener.ts`, `devices.ts` | **Devices service process** | 100% per file (`npm run test:core`) |
| `cli/src/cable/cableHost.ts`, `hosts/select.ts`, `hosts/observed.ts` | **Devices service process** | Their specs |
| `plugins/harness-device-orca/src/inputs.ts`, `dial.ts`, `worker.ts` | **Plugin worker**: a Node process Orca starts, as the person running Orca | `orca plugin test` (local) |
| `plugins/harness-device-orca/orca-plugin.json`, `README.md` | Plugin files, no process | `orca plugin validate`, `check` (local) |
| `cli/e2e/dialStream.e2e.ts`, `cli/e2e/harness/pluginDial.ts` | Test: the real daemon, a fake dial, the plugin's loop in a Node process | By hand; the CLI end to end workflow |
| `cli/AGENTS.md`, `cli/src/services/AGENTS.md` | Repo files, no process | none |

No file under `cli/src/core/` changes, `src/architecture.coreFiles.txt` gains no line, and `cable/hosts/orca.ts`, `cableSession.ts`, `cableFleet.ts`, the firmware and `e2e/harness/fakeOrca.ts` do not change.

## Before starting

- This worktree has no `cli/node_modules`: run `cd cli && npm ci` once.
- The plugin's tests and `check` run plugin code with the tester's own access, so they always run with an empty home and a bare `PATH`. Below, `iso <words>` stands for this one command, from the repo root:
  ```bash
  ( cd plugins/harness-device-orca && env -i HOME="$(mktemp -d)" PATH=/usr/bin:/bin "$(command -v orca)" plugin <words> )
  ```
  A shell keeps no function between an agent's commands: paste the whole line each time.
- The plugin's type check borrows the CLI's TypeScript and Node typings. "The plugin's type check" below is this command; expected: no output.
  ```bash
  cd plugins/harness-device-orca && orca plugin types . && ../../cli/node_modules/.bin/tsc -p . \
    --typeRoots ./.orca/types,../../cli/node_modules/@types --types orca,orca-host,orca-frame,orca-worker,orca-services,orca-testing,node
  ```
  `orca plugin types .` writes Orca 1.4.262's typings into the plugin's git-ignored `.orca/`. A reference copy, read only and never copied into the repo: `/private/tmp/claude-503/-Users-duynguyen-orca-workspaces-autonomous-harness-dial-orca-tab-scope/eaf4a554-d7ab-4fbe-ba7a-c86ec89dadff/scratchpad/ptypes/.orca/types/` (`orca-worker` for `orca.events.on`, `orca-host` for `workspace.changed`, `orca-testing` for `mountWorker` and `emit`).

## Global Constraints

- **The core does not change.** No file under `cli/src/core/`, nothing `src/core/main.ts` imports, no entry in `src/core/api.ts`.
- **One way to know the worktree on screen:** the plugin. With an old plugin, none, or Windows, the dial behaves as today. No fallback read of Orca's CLI.
- **Not edited:** `watch-focus` and every read in `cable/hosts/orca.ts`, `followPrompt`, `followFocus`, `orcaSettled`, the tab names, the tab order, recaps, a tap, notices, the other apps' rings.
- **Never in the Orca app.** Every session runs inside Diego's Orca. Only `orca plugin types`, `test`, `check`, `validate` and `release-entry` are run. Never `install`, `update`, `enable`, `restart`, `dev …`, `open`, `shot` or `list`.
- **No automatic install.** Nothing in this branch installs, updates or approves the plugin for the person (no `orca plugin install`, `update` or `--approve` from Harness). The README and the pull request's body give the commands; the person runs them.
- **The message.** One `POST /` on the devices' socket, on a connection of its own, with the body `{"type":"orcaFront","terminals":["term_…",…]}` or `{"type":"orcaFront","terminals":null}`. `terminals` holds the focused worktree's terminal ids that match `^term_[0-9a-f-]{36}$`, in Orca's order, at most 50. `null` is no focused worktree. Only the ids go: no title, branch, name or `workspaceId`.
- **The listener's bounds.** `orcaFront`: at most 4096 bytes, 10 a second per connection. Refused unless `terminals` is `null` or an array of at most 50 strings that each match `ORCA_HANDLE`. Refused while no `dial` stream is open. Nothing of the body is logged or echoed.
- **The plugin sends** only while its `dial` stream is open: the latest ids at each open, and again on each `front()` whose ids differ from the last sent on that stream. A failed send is sent once more after 1 s, if it is still the latest and the stream is still open.
- **The devices keep** `orcaFront: ReadonlySet<string> | undefined` in memory only. Set by a message, undefined after `null` or the `dial` stream's end, gone with the process. Nothing is pushed: the dials read it at their next list.
- **The scope applies** only when all four hold: the dial says `appFilter`, the shown app is that app, that app is the settled front app (`filter.settledApp()`), and a scope is set. Its rows are in a `DialRing` of their own with the app's rank, at most 16 (`RING_PLACES`); `total` is the in-scope agents' count. The APPS list and its counts do not change.
- **Logs** hold counts only, never a handle, name, title or worktree:
  - Devices: `[device] orca front · set · <n> terminals`, `[device] orca front · cleared`, each once per change.
  - Plugin (`orca plugin logs`): `dial: front not sent`.
- **The manifest**, as Orca 1.4.262's `orca plugin validate` takes it (the spec's two lists are shorthand; plain strings are refused): `"version": "0.2.0"`, `"capabilities": [{ "kind": "workspace:read" }]`, `"contributes": { …, "events": [{ "on": "workspace.changed" }] }`. `engines.orca` stays `>=1.4.248`.
- **The plugin folder** holds no dependency, `package.json`, binary or symlink. `src/dial.ts` and `src/inputs.ts` load nothing of `orca` when they run: Task 8 runs them outside Orca.
- **Cost.** No timer, no poll, no new process. One local `POST` per worktree change, and one set lookup per Orca agent per list read.
- **Platforms.** macOS and Linux. On Windows there is no listener and the plugin shows "Not on Windows yet.": nothing changes.
- **Repo rules.** Tests never touch the developer's real Orca, daemon (port 18473), dial or homes. No fixed sleeps. `src/services` stays at 100% per file.

## Review Focus

1. **A tab opened in the worktree on screen, then an agent started in it.** Orca's message names the new terminal before any agent's hook does. The agent must join the list at the next read with no new message, and one resumed in a terminal outside the set must leave it. Task 4 (`the scope is read at each list`).
2. **A daemon from before `orcaFront`, or one that refuses.** It answers 404 (or 400, 429) to every send. That must cost one retry and one log line per change, and never the `dial` stream or the panel's state. Task 6 (`a daemon from before orcaFront`).
3. **Worktrees changed faster than a send answers.** Two sends in flight could land out of order and leave the older worktree as the scope. Sends never overlap, and only the latest goes once one answers. Task 6 (`sends never overlap`).
4. **A send that never answers** (a devices process that hangs). Later changes must not wait behind it for ever. Task 6 (`a send with no answer in 2 s`).
5. **No listener at all.** On Windows, before any stream, and after `stop()`, `front()` must post nothing and throw nothing, and `stop()` must leave no send or timer. Task 6 (`on Windows, and after stop()`).

## Decided (PM for Diego, 2026-11-18)

All in the spec's "Decided": 1 the worktree on screen comes from the plugin alone; 2 a change of worktree does not move the dial; 3 a worktree with no agent gives an empty swipe list; 4 the APPS page, Orca not in front, dials without `appFilter`, recaps and a tap are unchanged; 5 `watch-focus` is untouched. Also: the prompt and focus follows need no change, and the pull request's body carries Diego's steps.

The draft's two questions, answered by the PM on 2026-11-18:

1. **Install by hand.** Harness installs, updates and approves nothing in this branch. The README (Task 7) and the pull request's body give the commands:
   - first time: `orca plugin install <repo>/plugins/harness-device-orca`. It stops with `approval_required`; the person runs again the command Orca prints, with `--approve <fingerprint>` (or approves as Orca shows), after reading Orca's own access text;
   - later: `orca plugin update <plugin-key>`. An update that adds access asks again.
   - Found read only on 2026-11-18: Diego's Orca has no Harness Device plugin installed today, so his Rollout is a first install.
   - A one-time "Connect Orca" button in Harness Device is separate work (Follow-ups). Nothing of it is built here.
2. **The empty list's face on the dial** ("Choose a pane"; a hold opens APPS) is accepted as is: no firmware change, no follow-up.

## Decided here, where the spec was silent

- **`ended` is optional** on `dialStream`, and runs only for the stream that is the open one: an older stream ending after a newer one opened runs nothing.
- **A body with no `terminals` key is refused.** Only `null` clears.
- **The devices compare sets**, so the same handles in another order change nothing. The log's `<n>` is the message's own count.
- **One function** (`orcaFronted`) serves the message and the stream's end, inside the `orca` part's guard: Node reports a throw in an abort listener as an uncaught exception.
- **A scope is an object**, `{ inScope(agentId) }` (the spec's `setScope(app, inScope?)` is shorthand). The same object set again keeps its ring. `pageOf` is exported from `select.ts` so the host finds the shown app's agents as the rings do.
- **`placedAt`** is the map's own answer, as `shownOnly` reads it.
- **The plugin's `front()`** keeps the strings that match the handle pattern, then the first 50, and compares bodies as sent. A send fails on `null`, on any status outside 200 to 299, or with no answer in 2 s (`HEAD_MS`, the listener's own deadline). A failure a newer `front()` replaced is not logged. After a logged failure the same ids are tried again at the next `front()`.
- **`post`** answers the status at the answer's head, on a connection of its own (`agent: false`).
- **The harness's stdin** is one JSON line per `front()` argument: an array of ids, or `null`.
- **The end-to-end cases join `dialStream.e2e.ts`**, which holds the loop's launcher shim and its isolation checks.

---

### Task 1: The listener takes `orcaFront`; the `dial` stream says when it is open and when it ended

**Layer:** devices service process. **Depends on:** none. **Effort:** `xhigh` (outside text from another program; what may set a scope and when).

**Red test:** `cli/src/services/devicesListener.spec.ts`.

**Files:**
- Modify: `cli/src/services/devicesListener.ts` (`DialStream`, `dialStream`, and the new handler after it, at the end of the file; nothing inside `openDevicesListener`)
- Test: `cli/src/services/devicesListener.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export const ORCA_FRONT_PER_SECOND = 10
  export const ORCA_FRONT_MAX_BYTES = 4096
  export const ORCA_FRONT_MAX_TERMINALS = 50
  export function orcaFrontHandler(isOpen: () => boolean, front: (terminals: readonly string[] | null) => void): ListenerHandler
  export interface DialStream { handler: ListenerStreamHandler; isOpen(): boolean; attached(on: boolean): void; shows(agent: DialAgent | null): void }
  export function dialStream(deps: { log(line: string): void; after(ms: number, run: () => void): () => void; ended?(): void }): DialStream
  ```
  - `orcaFrontHandler` imports `ORCA_HANDLE` from `../cable/hosts/orca.js`. It answers `REFUSED` while `isOpen()` is false, and for any `terminals` that is not `null` or an array of at most 50 strings matching `ORCA_HANDLE`. Taken, it hands `terminals` on as given and answers nothing (204). It keeps and logs nothing.
  - `isOpen()` is true from a stream's `open` until that stream ends. `ended` runs once when the open stream ends, for any `StreamEnd`.

- [ ] **Step 1: Write the failing tests.** `const H = (n: number) => \`term_00000000-0000-4000-8000-${String(n).padStart(12, '0')}\``.
  - In `describe('the dial stream')`, with `handMade()`:
    - `isOpen is false until a stream opens, true while it is open, and false once it ended`.
    - `ended runs once as the open stream ends, whatever the reason` (`gone`, `stalled`, `closed`: one call each).
    - `an older stream ending after a newer one opened runs no ended and leaves isOpen true; the newer one's end runs it`.
  - A new `describe('orcaFront')`, the handler called directly:
    - `orcaFront takes null, and up to 50 handles in the order given, while a dial stream is open` (`front` got `null`, `[H(1), H(2)]`, then 50; each answer is `undefined`).
    - `orcaFront is refused while no dial stream is open, and nothing is handed on` (`null` and `[H(1)]`).
    - `orcaFront refuses 51 handles, a non-handle, a non-array and a body with no terminals`: 51 handles, `[H(1), 'term_x']`, `[H(1).toUpperCase()]`, `['/Users/someone/wt']`, `[7]`, `[[H(1)]]`, `H(1)`, `{}`, `7`, and no key. Each is `REFUSED`; `front` is never called.
    - `the orcaFront handler holds nothing: it is its two limits and handle; 50 handles fit` (keys `handle`, `maxBytes`, `perSecond`; the three constants are `[10, 4096, 50]`; a 50-handle body is under 4096 bytes).
  - In it, `describe.skipIf(process.platform === 'win32')('on a real listener')`, with `open({ dial: dial.handler, orcaFront: orcaFrontHandler(dial.isOpen, front) })`:
    - `before the plugin's stream is open an orcaFront is 400; while it is open, 204; once it ended, 400 again, and ended ran`.
    - `an orcaFront of 4097 bytes is 413; the 11th within a second on one connection is 429` (padded as `attachOf` pads).
    - `a refused orcaFront is counted in the minute line, and no line or answer holds a handle`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devicesListener.spec.ts`. Expected: FAIL (`orcaFrontHandler` is not exported; `isOpen` is not a function).
- [ ] **Step 3: Implement.** The handler's comment says who sends it and why it needs an open stream (a late retry must not leave a scope nobody clears).
- [ ] **Step 4: Run** the step 2 command, then `npx vitest run src/services/devices.spec.ts && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devicesListener.ts`.
- [ ] **Step 5: Commit** `devices: the listener takes orcaFront while the plugin's dial stream is open`.

### Task 2: The observed source answers where an agent was placed

**Layer:** devices service process. **Depends on:** none. **Effort:** `medium`.

**Red test:** `cli/src/cable/hosts/observed.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts` (one method, right after `paneOf`; `target`, `shownOnly` and `locate` are not edited)
- Test: `cli/src/cable/hosts/observed.spec.ts`

**Interfaces:**
- Produces: `ObservedSource.placedAt(agentId: string, adapter: string): string | undefined`: the pane `setPaneNames` was last given for that agent in that adapter's `placed`, or undefined. A place is never one of its panes: `paneOf` still answers undefined for it.

- [ ] **Step 1: Write the failing test** in `describe('ObservedSource panes')`, beside the `setPaneNames` cases:
  - `placedAt answers the pane an agent was placed at, in that adapter alone`: after `setPaneNames('orca', names, new Map([[id, HANDLE]]))`, `placedAt(id, 'orca')` is `HANDLE`, `placedAt(id, 'cmux')` and `placedAt('observed:unknown', 'orca')` are undefined, and `paneOf(id, 'orca')` is still undefined. After `setPaneNames('orca', names, new Map())` it is undefined.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts`. Expected: FAIL (`placedAt` is not a function).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: the observed source answers where an agent was placed`.

### Task 3: The dial host scopes the front app's ring

**Layer:** devices service process. **Depends on:** none. **Effort:** `high`.

**Red test:** `cli/src/cable/cableHost.spec.ts`.

**Files:**
- Modify: `cli/src/cable/cableHost.ts` (a field and `setScope` beside `ranks` and `setRank`; the one line of `machineSnapshot` that picks the rows; the `select.js` import)
- Modify: `cli/src/cable/hosts/select.ts` (`pageOf` gains `export`, nothing else)
- Test: `cli/src/cable/cableHost.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RingScope { inScope(agentId: string): boolean }
  // DaemonCableHost
  setScope(app: string, scope: RingScope | undefined): void
  ```
  - One scope an app, in memory, as the ranks. A new scope object gets a new `DialRing`; the same object keeps its ring; `undefined` drops both.
  - In `machineSnapshot`, when `apps` is true, a scope is set for `list.shown` and `this.filter.settledApp() === list.shown`: the rows are `scopedRing.select(<the listed agents whose pageOf is list.shown and that are inScope>, this.ranks.get(list.shown))`, whose `total` is their count. Otherwise the line is as today. `appList` still runs first, so `apps` in the answer does not change.

- [ ] **Step 1: Write the failing tests** in `describe('the dial that shows one app at a time')`, after the rank cases, with `mixed()` (`o1 g1 o2 o3 g2`), an `appTimer` that keeps each settle, and `const without = (...out: string[]): RingScope => ({ inScope: (id) => !out.includes(id) })`:
  - `with Orca settled in front and a scope, the list is the in-scope agents in rank order, total is their count, and the app list is as it was`: rank `o3, o1, o2`, `setScope('orca', without('o2'))`; ids `['o3', 'o1']`, `total` 2, and `apps.apps` equals the one read before the scope (Orca's count 3).
  - `a scope that holds nobody gives an empty list and total 0` (`without('o1', 'o2', 'o3')`; `apps.shown` is still `orca`).
  - `the scope waits for Orca to settle in front: nothing settled, another app settled and none settled give today's list`.
  - `another app shown is not scoped: with Orca in front, a pick of Ghostty lists Ghostty's two, and a pick back lists Orca's scope`.
  - `a dial that does not say appFilter gets the single ring, scope or not` (`listAgentSnapshot()` is `o1 g1 o2 o3 g2`, `total` 5).
  - `setScope with undefined gives today's list again`.
  - `more than 16 in scope: 16 rows, and total is all in scope` (18 Orca agents).
  - `the same scope object keeps its ring, and a new one starts a new ring`: 17 idle Orca agents in scope, so `o17` is outside; `o17` then gets the latest activity. Read again with the same object: still outside. `setScope('orca', <a new object>)`: `o17` is in.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableHost.spec.ts`. Expected: FAIL (`setScope` is not a function).
- [ ] **Step 3: Implement.** `setScope`'s comment says it reaches the dial at the session's next list, as a rank does.
- [ ] **Step 4: Run** the step 2 command, then `npx vitest run src/cable/hosts/select.spec.ts src/cable/cableSession.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: the host lists only the agents in scope while their app is in front`.

### Task 4: The devices keep the worktree on screen

**Layer:** devices service process. **Depends on:** Tasks 1, 2, 3. **Effort:** `xhigh` (what is kept and for how long; a throw here must never be the dial's).

**Red test:** `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts`, in four places and no other:
  - the `./devicesListener.js` import gains `orcaFrontHandler`;
  - `const dial = dialStream({ … })` gains `ended` (that line only);
  - the listener's handlers gain `orcaFront`, right after `dial: dial.handler,`;
  - one new block, right above the `// ── the pane focused in Orca` header.
- Test: `cli/src/services/devices.spec.ts` (`fakeListener` gains `orcaFront(terminals)`; the keys assertion; a new top-level `describe` between `Orca's ring follows Orca's tabs` and `the dial follows the pane focused in Orca`)

**Interfaces:**
- Consumes: `orcaFrontHandler`, `dialStream`'s `ended` and `isOpen` (Task 1); `ObservedSource.placedAt` (Task 2); `DaemonCableHost.setScope`, `RingScope` (Task 3).
- Produces, all inside `startDevices`:
  - `let orcaFront: ReadonlySet<string> | undefined`.
  - `orcaFronted(terminals: readonly string[] | null): void`. When the set of handles differs from the one kept (`null` is none): it keeps the new set, logs `[device] orca front · set · ${terminals.length} terminals` or `[device] orca front · cleared`, and calls `cableHost.setScope('orca', scope)`, with `undefined` for none. The same set does nothing.
  - The scope, a new object for each new set: `inScope(agentId)` is whether `observed.paneOf(agentId, 'orca') ?? observed.placedAt(agentId, 'orca')` is in that set, read when asked. With the observed agents switched off, nobody is in scope.
  - Wiring: `orcaFront: orcaFrontHandler(() => dial.isOpen(), (terminals) => part.call('orca', () => orcaFronted(terminals)))`, and `ended: () => part.call('orca', () => orcaFronted(null))`.
  - Nothing is pushed to the dials, and nothing here runs on a dial's attach or detach.

- [ ] **Step 1: Write the failing tests.** The new describe is `Orca's ring is the worktree on screen (docs/plans/2026-11-18-dial-orca-tab-scope-design.md)`, with `H`, `hook`, `agent`, `host`, `land`, `settled`, `scanned`, `claudeIn` and `ring` as the describe above it defines them, a `fakeListener`, and a `settle(app)` as the describe below it has. "Scoped" below means: a dial attached, the tabs landed, the plugin's stream open (`listener.dial()`), and Orca settled in front.
  - The existing `the devices open their listener once, …`: the keys are `['front', 'attach', 'tab', 'tabs', 'dial', 'orcaFront', 'notify', 'notice']`, and `handlers.orcaFront` matches `{ maxBytes: 4096, perSecond: 10 }`.
  - `scoped, an orcaFront makes Orca's ring the agents in those terminals, in tab order`: three agents, tabs `H(3), H(1), H(2)`, `orcaFront([H(1), H(3)])`; `ring()` is `[agent(3), agent(1)]`, the answer's `total` is 2, its `apps` row for Orca counts 3, and `listAgentSnapshot()` still lists three.
  - `an agent placed by elimination is on screen when its terminal is` (Diego's four tabs: `orcaFront([H(3)])` lists the scanned agent alone).
  - `a terminal with no agent, and no terminal at all, give an empty ring` (`[H(9)]`, then `[]`: no rows, `total` 0).
  - `the scope is read at each list`: `orcaFront([H(1), H(4)])` lists agent 1; `port.observed(hook(4))` and the next read lists agents 1 and 4 with no new message; agent 1 resumed in `H(7)` leaves at the next read.
  - `an agent in tmux inside one of those terminals is not listed` (hints `TMUX_PANE: '%3'` beside `ORCA_TERMINAL_HANDLE: H(2)`, and `H(2)` in the message).
  - `null clears it, and so does the stream's end: the whole ring again`.
  - `each change is one line, with a count and no handle`: `[H(1), H(2)]`, the same two reversed, `[H(1)]`, `null`, `null`, then `[H(3)]` and the stream's end. The lines are `set · 2 terminals`, `set · 1 terminals`, `cleared`, `set · 1 terminals`, `cleared`, and no log line holds `term_`.
  - `with no dial stream open an orcaFront is refused and nothing is kept` (`REFUSED`; no line; the whole ring).
  - `an orcaFront pushes nothing` (`calls('syncAgents')` is as long after as before).
  - `Orca not in front, and a dial stream held with nothing sent, leave the whole ring`.
  - `with the observed agents switched off an orcaFront is taken and puts nobody in scope` (`HARNESS_DEVICE_OBSERVED` off, as the file's other cases switch it).
  - `a fault in the orca part costs the listener and the stream nothing` (`faults: ['orca']`: the handler answers `undefined`, the stream's end does not throw, and `[devices] orca failed · injected fault: orca` is logged).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL (no `orcaFront` handler).
- [ ] **Step 3: Implement.** The block's comment names the spec, says the set is in memory only and dies with the plugin's stream, and that no line holds a handle.
- [ ] **Step 4: Run** the step 2 command, then `npx vitest run src/services/devicesProcess.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`.
- [ ] **Step 5: Commit** `Dial: Orca's ring is the worktree on screen while Orca is in front`.

### Task 5: The plugin's inputs post one message

**Layer:** plugin worker. **Depends on:** none. **Effort:** `high`.

**Red test:** `plugins/harness-device-orca/src/inputs.test.ts`.

**Files:**
- Modify: `plugins/harness-device-orca/src/inputs.ts`
- Test: `plugins/harness-device-orca/src/inputs.test.ts`
- Modify: `plugins/harness-device-orca/src/dial.test.ts` (`world`'s inputs) and `worker.test.ts` (`inputs`): each fake gains `post: () => Promise.resolve(null)`, so the type check holds

**Interfaces:**
- Produces, on `DialInputs` and in `nodeInputs()`:
  ```ts
  /** POST `body` to `/` on the Unix socket, on a connection of its own. The answer's status, its body drained and
   *  dropped. Null when it cannot connect, or is aborted before the answer's head. */
  post(socketPath: string, body: string, signal: AbortSignal): Promise<number | null>
  ```
  `node:http`'s `request` with `agent: false`; it never rejects.

- [ ] **Step 1: Write the failing tests**, with the file's `serve`:
  - `post posts the body to / on a connection of its own and answers the status`: the server sees `POST`, `/`, the body and `connection: close`; a 204 answers `204`, and a 400 with a body answers `400`.
  - `post to a socket that is not there, and to one nothing listens on, is null`.
  - `an abort before the answer makes post null`.
- [ ] **Step 2: Run** `iso test .`. Expected: FAIL (`post` is not a function).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `iso test .` and the plugin's type check. Expected: `4 test file(s) passed (node).`, no type error.
- [ ] **Step 5: Commit** `plugins: the Orca plugin's inputs post one message`.

### Task 6: The loop sends the worktree on screen

**Layer:** plugin worker. **Depends on:** Task 5. **Effort:** `xhigh` (sends in flight, a retry and a stream that ends under them).

**Red test:** `plugins/harness-device-orca/src/dial.test.ts`.

**Files:**
- Modify: `plugins/harness-device-orca/src/dial.ts`
- Test: `plugins/harness-device-orca/src/dial.test.ts`

**Interfaces:**
- Consumes: `DialInputs.post` (Task 5).
- Produces, on `Dial`: `front(terminals: readonly string[] | null): void`, the focused worktree's terminal ids as Orca lists them, or `null` for none.
- The body: `JSON.stringify({ type: 'orcaFront', terminals })`, where a list keeps its strings that match `/^term_[0-9a-f-]{36}$/`, then its first 50.
- The rules. The loop keeps `latest`, the body of the last `front()` (none before the first). An open stream (the open answered 200, until its lines end) keeps the body the devices last took (`sent`), whether a send is in flight, and a retry's wait.
  - `front()`: nothing after `stop()`. Else it sets `latest` and pushes.
  - A stream opens: push. It ends: its retry is cancelled, and nothing more is sent or logged for it.
  - Push: nothing when no stream is open, there is no `latest`, a send is in flight, `latest` is `sent`, or `latest` is the body whose retry waits. Else it cancels a waiting retry and sends `latest`.
  - A send is `inputs.post(socket, body, signal)` on the stream's own socket, aborted with the pass and after `HEAD_MS` (2 s) on the loop's clock. A status from 200 to 299: `sent` is that body, then push. Anything else, `null` included, failed:
    - the body is no longer `latest`: push;
    - a first failure: once more after `FRONT_RETRY_MS = 1_000`, if it is still `latest` and the stream still open;
    - the retry failed: log `dial: front not sent`. `sent` stays as it was.
  - On Windows nothing is ever sent. `stop()` aborts a send in flight and cancels a retry.

- [ ] **Step 1: Write the failing tests.** `world()` gains `posts` (each `{ socket, body, signal }`) and a `post` that answers what the test queued: a status, `null`, or a hold that ends as `null` when its signal aborts; 204 with nothing queued. `H(n)` as in Task 1.
  - `front() with a stream open posts the ids to the stream's socket` (the body is exactly `{"type":"orcaFront","terminals":["<H(1)>","<H(2)>"]}`, the socket is link's).
  - `front(null) posts "terminals":null`.
  - `ids that are no handle are left out, the order kept, and at most 50 go` (`'x'`, an upper-case handle, a number and 54 handles: the first 50 handles).
  - `with no stream open nothing is posted, and the latest ids go when one opens` (unplugged, `notRunning` and a 409: two `front()` calls, no post; the stream opens, one post, the second's).
  - `each open posts the latest ids again` (the stream ends, the clock passes 1 s, the next stream gets the same body).
  - `the same ids again post nothing` (twice the same list: one post).
  - `a send that fails is sent once more 1 s later; if that fails too it is logged once, with no id` (500 then `null`: two posts, one `dial: front not sent`, no line holds `term_`, no third post).
  - `after a logged failure the same ids are sent again at the next front()`.
  - `a newer front() during the wait is sent at once, and the older one's retry is not`.
  - `the stream ending during the wait cancels the retry: nothing more is sent or logged`.
  - `sends never overlap: front() calls while one is in flight send only the latest once it answers` (A held; B, C: posts are A; A answers 204: posts are A, C).
  - `a send with no answer in 2 s is aborted and counts as failed` (its signal aborts at 2 s; a retry is due 1 s later).
  - `a daemon from before orcaFront answers 404: one retry, one line, and the state and the stream are untouched` (a later line of the stream still becomes the state).
  - `on Windows, and after stop(), front() posts nothing and throws nothing; stop() aborts a send in flight and leaves no timer`.
- [ ] **Step 2: Run** `iso test .`. Expected: FAIL (`front` is not a function).
- [ ] **Step 3: Implement.** The file's header gains one sentence: what it tells the devices, and that only ids go.
- [ ] **Step 4: Run** `iso test .` and the plugin's type check. Expected: PASS, no type error.
- [ ] **Step 5: Commit** `plugins: the Orca plugin's loop tells the devices the worktree on screen`.

### Task 7: The worker hears `workspace.changed`; the manifest and the README

**Layer:** plugin worker and plugin files. **Depends on:** Task 6. **Effort:** `high` (what of a workspace leaves the worker).

**Red test:** `plugins/harness-device-orca/src/worker.test.ts`.

**Files:**
- Modify: `plugins/harness-device-orca/src/worker.ts`, `orca-plugin.json`, `README.md`
- Test: `plugins/harness-device-orca/src/worker.test.ts`

**Interfaces:**
- Consumes: `Dial.front` (Task 6).
- Produces:
  - `wire` subscribes with `orca.events.on('workspace.changed', …)` and hands `dial.front` the context's `terminals` mapped to their `id`, or `null` for a `null` context. Nothing else of the context is read. Its stop disposes the subscription first.
  - `orca-plugin.json`: `"version": "0.2.0"`, `"capabilities": [{ "kind": "workspace:read" }]`, and `"events": [{ "on": "workspace.changed" }]` in `contributes`. Nothing else changes.
  - `README.md`, in its own words and length:
    - "What it does" gains one line: while Orca is in front, a swipe on the dial stays in the worktree on screen.
    - "What it never does": the second bullet now also says what it reads of Orca (the terminal ids of the focused worktree) and sends (those ids, to the Harness daemon on this computer; no name, title, branch or path).
    - "Install": the `orca plugin install` command stays as the first step. Then, in a line or two: Orca stops with `approval_required` and shows the access it asks for; read it, then run the command Orca prints, with `--approve <fingerprint>` (or approve as Orca shows). Later versions: `orca plugin update <plugin-key>`; one that adds access asks again. No command that approves for the reader is written out ready to paste.
    - "The access Orca asks for": "It declares no capability." becomes the one it declares, `workspace:read`, in Orca's own words ("Read your projects and workspaces (names, branches, paths and agent status) and the terminals in them, and get notified when they change"), and that it uses only the focused worktree's terminal ids.
- Two things the test kit does: it gives a new subscriber the current context first (`workspace.readContext`, `null` unless the mock host answers one), and `emit` of an event the manifest does not list throws (`"workspace.changed" never arrives: it is not in contributes.events`).

- [ ] **Step 1: Write the failing tests.** `streaming()`'s inputs gain a `post` that keeps each body and answers 204.
  - `the manifest asks for workspace:read and workspace.changed, at 0.2.0` (read with `readFileSync(new URL('../orca-plugin.json', import.meta.url))`; the three values above, and `engines.orca` is `>=1.4.248`).
  - `each workspace.changed hands its terminal ids to the devices, and nothing else of it`: emit a context with `workspaceId: '/Users/someone/secret-wt'`, `branch: 'payroll'`, `displayName: 'Payroll'` and terminals `{ id: H(1), title: 'PM' }`, `{ id: H(2) }`. The last body is exactly `{"type":"orcaFront","terminals":["<H(1)>","<H(2)>"]}`, and no body or log line holds `secret-wt`, `payroll`, `Payroll` or `PM`.
  - `the context Orca gives a new subscriber is sent as the stream opens` (the mock host answers `workspace.readContext` with one terminal; the first body names it).
  - `no focused workspace is "terminals":null` (emit `{ context: null }` after a context).
  - `deactivate ends it: a context after it posts nothing`.
  - Every existing case still ends with `worker.refusals` empty.
- [ ] **Step 2: Run** `iso test .`. Expected: FAIL (the manifest's values; `emit` throws).
- [ ] **Step 3: Implement** the worker, the manifest and the README.
- [ ] **Step 4: Run**, each expected as said:
  - `iso test .`: `4 test file(s) passed (node).`
  - `cd plugins/harness-device-orca && orca plugin validate .`: `orca-plugin.json: ok`, with `adds events: workspace.changed` and the access line quoted above.
  - `iso check .`: exit 0; the panel draws "Harness isn't installed." or nothing, never another state.
  - The plugin's type check: no output.
- [ ] **Step 5: Commit** `plugins: the Orca plugin asks for workspace:read and tells the devices the worktree on screen`.

### Task 8: End to end: the plugin's loop scopes a fake dial's list

**Layer:** test. **Depends on:** Tasks 4, 6. **Effort:** `high`.

**Red test:** none: no behavior (it adds the end-to-end test of what Tasks 1 to 6 built).

**Files:**
- Modify: `cli/e2e/harness/pluginDial.ts`, `cli/e2e/dialStream.e2e.ts`

**Interfaces:**
- Consumes: `Dial.front` (Task 6); the listener, the devices and the host (Tasks 1 to 4).
- `pluginDial.ts`: each line of its stdin is parsed as JSON and handed to `dial.front`. Stdin's end still stops the loop, and the process still ends by itself with code 0.
- `dialStream.e2e.ts`: `Loop` gains `front(terminals: string[] | null): void`, which writes one JSON line on the child's stdin. The new case has its own small helpers, as `dialOrcaFocus.e2e.ts` has them: a dial plugged with `{ appFilter: 'v1' }`, `inOrca` (a session with an `ORCA_TERMINAL_HANDLE` of its own), `front(d, bundle)` (a line on the stdin of the real `harness hardware watch --json`), `latestList(dial)`.

- [ ] **Step 1: Write the test**, `the plugin's loop tells the worktree on screen, and Orca's ring on the dial is that worktree's agents`. A daemon of its own with the fake `orca`. Handles `a1`, `a2`, `b1` and `e` are made first; `orca.layout([[[a2], [a1]], [[b1]], [[e]]])` is three worktrees, the third a terminal with no agent.
  1. The loop starts with no dial, and is handed `[a2, a1]` at once. The filtered dial is plugged: the loop says `attached`, and the daemon logs `[device] orca front · set · 2 terminals` (the ids kept while no stream was open went as it opened).
  2. Sessions A1, A2 and B1 start in their terminals. No app has settled in front: the dial's list is `A2, A1, B1`, Orca's tab order across worktrees.
  3. `front(d, 'com.stablyai.orca')`: the list becomes `A2, A1`, its `agents.end` says `total` 2, and the latest `apps` frame still counts 3 for Orca.
  4. The loop is handed `[b1]`: the list is `B1`. Then `[e]`: an `agents.begin` and `agents.end` with no agent between, `total` 0.
  5. The loop is handed `[a2, a1]` again: `A2, A1`. The dial turns to A2 by hand (`[device] swipe · ok`). A1's typed prompt moves the dial (`[device] prompt · moved`, a `focus` frame for A1). B1's typed prompt does not: `[device] prompt · skipped · no tile`, and no `focus` frame names B1.
  6. `front(d, 'com.apple.Safari')`, no listed app: the list is `A2, A1, B1` again. Orca in front again: `A2, A1`.
  7. `await plugin.stop()` is `0`. The daemon logs `[device] orca front · cleared`, and the list is `A2, A1, B1`.
  8. Every `[device] orca front` line matches `/^\[device\] orca front · (set · \d+ terminals|cleared)$/`. Neither the daemon's log nor the loop's holds a handle. The loop never logged `dial: front not sent`.
- [ ] **Step 2: Run**, on this Mac, `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialStream.e2e.ts`. Expected: PASS, the file's seven older cases included.
- [ ] **Step 3: Run** the same with `E2E_BUNDLE=1`, as the workflow starts its daemons. Expected: PASS.
- [ ] **Step 4: Commit** `e2e: the Orca plugin's loop scopes the dial's list to the worktree on screen`.

### Task 9: Say it in the docs

**Layer:** repo files. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: docs only.

**Files:**
- Modify: `cli/AGENTS.md`, `cli/src/services/AGENTS.md`

- [ ] **Step 1:** Write the changes, in each file's own words and length:
  - `cli/AGENTS.md`, the devices row of the processes table. What they keep in memory gains the terminals of the worktree on Orca's screen. Beside the `dial` stream: Orca's Harness Device plugin tells them those terminals (`orcaFront`) while it holds that stream, and while Orca is settled in front, Orca's ring for a dial that says `appFilter` is that worktree's agents.
  - `cli/src/services/AGENTS.md`, the devices paragraph: `orcaFront` joins the listener's message types (from Orca's Harness Device plugin, taken only while its `dial` stream is open), and the `dial` stream's sentence says its end drops what `orcaFront` set.
- [ ] **Step 2:** Check every link resolves.
- [ ] **Step 3: Commit** `docs: the devices keep the worktree on Orca's screen, from its Harness Device plugin`.

---

## The pull request's body

Written by the main session, not a task. It carries:

- **Platforms:** macOS and Linux (the daemon, the listener, the plugin); Windows unchanged.
- **Diego's steps**, by hand, once the release that carries this is installed (the spec's Rollout). Harness runs none of them. His Orca has no Harness Device plugin today (read only, 2026-11-18), so this is a first install:
  1. Install the plugin: `orca plugin install <repo>/plugins/harness-device-orca`. It stops with `approval_required`.
  2. Orca lists the access it asks for, in its own words: "Read your projects and workspaces (names, branches, paths and agent status) and the terminals in them, and get notified when they change" (`workspace:read`), beside the worker's own access. Run the command Orca prints, with `--approve <fingerprint>`, or approve as Orca shows.
  3. Check: with Orca in front, a swipe on the dial goes only through the tabs of the worktree on screen.
  - Later versions: `orca plugin update <plugin-key>`. An update that adds access asks again.
- **Evidence:** each task's red then green, the `harness-local-checks` fence (before the push it describes), the plugin's gates' output, the end-to-end run's link, and the cost line from "Global Constraints".

## Verification

**Platforms the pull request names:** the daemon and the CLI on macOS and Linux (unit tests in PR CI on Linux; end to end on this Mac and on the workflow's Linux runners). The plugin on macOS (its gates run on this Mac; Orca on Linux is not tested). Windows: no listener, the plugin's loop sends nothing (Task 6), nothing else changes.

**Never touched:** Diego's Orca app (no `orca plugin install`, `update`, `enable`, `restart`, `dev …`, `open`, `shot` or `list`), his everyday daemon (port 18473), his dial, `~/.claude`, `~/.codex`, `~/.local/bin/harness`, any backend, production.

**Temporary workflow:** none. The one long check is the CLI's end-to-end suite, which has a workflow of the repo's own that starts by hand on a branch (`.github/workflows/cli-e2e.yml`); it takes every `e2e/**/*.e2e.ts`, so the changed file needs no workflow edit and stays in its nightly run. The plugin's gates need the Orca CLI, which no runner has: they are local, as the plugin's own spec decided.

**Turns.** The tester asks the orchestrator before the one hand-started GitHub run (check 1).

**Local gates**, recorded in the pull request (PR CI does not run them), on this Mac at the final head:
- `cd cli && npm run typecheck && npx vitest run src/services/devicesListener.spec.ts src/services/devices.spec.ts src/services/devicesProcess.spec.ts src/cable/cableHost.spec.ts src/cable/cableSession.spec.ts src/cable/hosts/observed.spec.ts src/cable/hosts/select.spec.ts`.
- `npx vitest run src/architecture.spec.ts src/leanEntry.spec.ts`, and `git diff --stat "$(git merge-base HEAD origin/main)" -- cli/src/core cli/src/architecture.coreFiles.txt cli/src/cable/hosts/orca.ts cli/src/cable/cableSession.ts` prints nothing: the core, the Orca reads and the follows are unchanged.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit. These paths select one check, `cli-core` (`npm run test:core`: 100% per file under `src/services/`). Its fence goes in the pull request's body before the tested commit is pushed.
- The plugin's gates (check 2).
- Not needed: `npm run test:harnessd` and the other coverage gates, the serial and PTY specs, `cargo test` in `device-app`, `make desktop-test`, a firmware build or flash.

**1. The real daemon, a fake dial, a fake front app, the fake `orca`, and the plugin's own loop**
- Where: this Mac, at the final head, and once on GitHub. No account, no sign-in, no backend.
- Build: nothing by hand. The suite starts the daemon from the working tree, or from one bundle with `E2E_BUNDLE=1`.
- Run: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/dialStream.e2e.ts e2e/dialOrcaFocus.e2e.ts e2e/dialPaneFollow.e2e.ts e2e/dialAppFilter.e2e.ts e2e/dialAppFilterOnDial.e2e.ts e2e/hardwareWatch.e2e.ts e2e/devicesProcess.e2e.ts`. The last six prove the changed listener, host and ring under what already used them.
- Isolation, the suite's own (`cli/e2e/harness/daemon.ts`, cli/AGENTS.md rules 5 and 6) and the file's:
  - a throwaway home and data folder, a private port and tmux server, fake engines, a fake dial on a pseudo-terminal;
  - the fake `orca` (`e2e/harness/fakeOrca.ts`) first on the daemon's `PATH`: the real Orca never runs;
  - the plugin's loop (`src/dial.ts` with `src/inputs.ts`) in a Node process whose whole environment is the throwaway home and `PATH=/usr/bin:/bin`; its launcher is a shim the test writes in that home, and the test checks the socket it is given is inside that daemon's data folder and its port is not 18473;
  - the app in front is a line on the stdin of the real `harness hardware watch --json`, under the throwaway daemon's environment. No Orca app is read and no plugin is loaded.
- A person sees: every test passes, none skipped. In the new case the dial's list is all three Orca agents before Orca is in front, the two of one worktree once it is, the one of the other when the loop is handed its terminal, and empty for the worktree with no agent; a prompt in the other worktree logs `[device] prompt · skipped · no tile`; another app in front, and the loop stopped, give all three again. The daemon's log has `[device] orca front · set · 2 terminals` and `· cleared`, and no handle.
- Skipped or not run: report it as not verified, never as passed.
- On GitHub, by hand, once on the final head: Actions → CLI end to end → Run workflow, branch `feat/dial-orca-swipe-current-worktree` (`.github/workflows/cli-e2e.yml`). Its shards are Linux; `dialTerminalFollow` reads skipped there. Every shard passes. The link goes in the pull request.

**2. The plugin's gates** (this Mac, at the final head, the plugin committed)
- `iso test .`: `4 test file(s) passed (node).` Every server, socket, script and watched folder is in a folder the tests make under `/tmp`. The home is empty and `PATH` is `/usr/bin:/bin`, so no test can find this Mac's `harness`.
- `iso check .`: exit 0. It mounts the real worker, which finds no launcher: the panel draws "Harness isn't installed." or nothing.
- `cd plugins/harness-device-orca && orca plugin validate .`: `orca-plugin.json: ok`, `adds events: workspace.changed`, and the access line Diego will be asked to approve. Its output is pasted in the pull request.
- `cd plugins/harness-device-orca && orca plugin release-entry .`: a release for the final commit with `version` `0.2.0`. Pasted in the pull request, published nowhere.
- The plugin's type check: no output.
- On GitHub: none. No runner has the Orca CLI.

**3. In PR CI, by itself:** `cli-typecheck` and `cli-tests` run the specs of Tasks 1 to 4 on Linux; a `cli/` change also runs `companions` and `pty-checks`, and `devices.ts` is one of the files `firmware-checks` reads. `process-checks` runs for the docs and the plugin's files. Nothing is started by hand.

**4. Numbers** (root rule 4, idle daemon work), held by specs:
- at rest: nothing new runs. No timer, no poll, no process (Task 6: the same ids post nothing; Task 4: an `orcaFront` pushes nothing);
- per worktree change in Orca: one local `POST` of at most 2.3 KB, and at most one retry;
- per list read, once a second per attached dial: one pass over this computer's agents and one set lookup per Orca agent, only while a scope is set;
- before this change: none of this ran.

**5. In Diego's own Orca (needs Diego himself: his Orca, his approval, his dial, his eye; after the release, not in this pull request):** the three steps of "The pull request's body", run by hand: a first install, since his Orca has no Harness Device plugin today, then his own approval of the access Orca shows. No session and no Harness code installs or approves it for him. It is the only check against a real Orca, and the only proof that the terminal ids Orca gives a plugin are the handles the hooks send (the spec read that in upstream's source). If the list is empty in a worktree that has agents, he turns the plugin off (`orca plugin disable <the key orca plugin list shows>`): its stream ends, the scope goes, and the dial is as before. No agent runs this.

**6. Against production:** none, and never.

## Follow-ups

Not built in this branch.

- **"Connect Orca" in Harness Device** (the PM, later): a one-time button that runs the plugin's install with `--approve` after the person taps it. Separate work.
- stablyai/orca#42555 (`watch-focus`) is still open. If it ships, the focus follow starts working by itself (the spec's Follow-ups).
