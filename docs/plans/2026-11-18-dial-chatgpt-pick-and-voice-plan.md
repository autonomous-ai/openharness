# The dial lands on a ChatGPT agent, and its words reach the ChatGPT app's Codex — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(dial): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. A task with no red test is one commit.

**Goal:** A dial whose list was empty is put on the first agent of the machine list it is sent, and the dial's words for a Codex session run through a `codex` that can start: the ChatGPT app's own CLI for a session in that app (macOS), else the `codex` a launch would run, under the person's login-shell environment.

**Architecture:**
- **A, the landing** (`cli/src/cable/cableSession.ts`, `syncAgentsNow`): after `agents.end` of a machine list, when the ring sent before had no agents, the record names none of the list and no follow is in flight, the record becomes the list's first agent and its `focus` is sent, with the echo guard the re-assert sets. The dial's own `agents.list` empties `lastRing` before the push that answers it: a dial asks only when it holds none.
- **B, the queue** (`cli/src/cable/hosts/codexQueue.ts`): which `codex` runs and the environment it gets. `observed.ts` says whether the session is the ChatGPT app's, and words the person can act on after a definite failure. `services/devices.ts` only passes the dependencies on.
- Devices process only. Nothing in `cli/src/core`, nothing stored or synced, no new log line: one line gains a word.

**Tech Stack:** TypeScript daemon (Node, vitest), `cli/`. End-to-end tests on the real daemon with fake engines and a fake dial (`cli/e2e/`).

**Spec:** `docs/plans/2026-11-18-dial-chatgpt-pick-and-voice-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` (Protect the core, Rules 4 to 7) and `cli/src/services/AGENTS.md`.

## Base

- Branch `fix/dial-chatgpt-pick-and-voice`, at `76f9a82582`, worktree `/Users/duynguyen/orca/workspaces/autonomous-harness/dial-chatgpt-user`. Nothing else has to merge first.
- **Before the first task, once:** `cd cli && npm ci --no-audit --no-fund` (this worktree's `cli/` has no `node_modules`). One process runs it, never two tasks at once.
- Names at the base (the tasks name functions, never lines):
  - `cableSession.ts`: `syncAgentsNow`, `pushAgents`, the `'agents.list'` case (it calls `pushAgents()`), `lastRing`, `desiredFocus` (its setter calls `reportShown`), `appFocusUnsent`, `expectedAppFocusEcho`, `expectedAppFocusEchoUntil`, `APP_FOCUS_SETTLE_MS` (750), `AGENTS_PUSH_GAP_MS`, `focusAgent`, `follow`, `followApp`, `pushAgents`, the `'focus'` and `'app.pick'` cases.
  - `cableSession.spec.ts`: `connect`, `makeHost`, `LoopbackPort` (`say`, `sent`, `types`, `close`), `AGENTS`, `row`, `appHost`, `settle`; the replug pattern in `a dial that comes back on its port is reported again once its ring is pushed`.
  - `codexQueue.ts`: `createCodexQueue`, `codexQueueDeps`, `CodexQueueDeps`, `CodexQueue`, `CodexQueueResult`, `CodexQueueFailure`, `CodexRunEnd`, `BINARY_LOOK_MS`, `QUEUE_TIMEOUT_MS`, `CODEX_THREAD`. Its spec: `recorder`, `held`, `realQueue`, `fakeCodex`, `executable`, `options`, `THREAD`, `FAKE_CODEX`.
  - `observed.ts`: `ObservedActions` (`codexQueue`, `count`), `countWord`, `queueable`, `send`, `first`, `words`. Its spec: `fakeActions`, `setup`, `counted`, `FAILED`, and in `describe('ObservedSource and codex queue')` `cx`, `inOrca`, `given`; in `describe('ObservedSource and the Codex app')` `inApp`, `hooked`, `scanned`, `rollout`.
  - `services/devices.ts`: `DevicesDeps.codex`, the `createCodexQueue` call. Its spec: `codex`, `codexRuns`, and in `describe('codex queue, for Codex outside a pane …')` `started`, `listed`, `said`, `ending`, `host`.
  - `lib/loginShellEnv.ts`: `loginShellEnvironment`, `warmLoginShellEnvironment`, `oneShotParentEnv`. `lib/engineBin.ts`: `engineBin`. `lib/binaryOnPath.ts`: `resolveBinaryOnPath`.
  - End to end: `harness/daemon.ts` `IsolatedDaemon` (`create`, `env`, `root`, `engineConfig`, `opens`, `log`), `fakeEngineShim`, `until`; `harness/fakeDial.ts` `FakeDial` (`send`, `next`, `messages`); `harness/codexOutside.ts` `CodexOutside`; `harness/hungCodex.ts` `writeHungCodex` (the way to write over a daemon's `codex`); `dialStream.e2e.ts` `turned`; `dialAppFilter.e2e.ts` `fresh`, `plugged`, `startFirst`, `startOutside`, `shows`, `FILTER`, `GHOSTTY`.
- If a name differs at the base, the implementer follows the code and says so in its report.
- The spec and this plan were committed at `f17f6a82c7`. The main session commits their later updates; no task does.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 A machine list lands a dial that holds no agent | `cli/src/cable/cableSession.ts`, `cableSession.spec.ts`, `cli/e2e/dialAppFilter.e2e.ts` | none | xhigh | `cableSession.spec.ts`, `e2e/dialAppFilter.e2e.ts` |
| 2 The fake dial turns by hand past the echo guard; the Orca follow files | `cli/e2e/harness/fakeDial.ts`, `cli/e2e/dialStream.e2e.ts`, `dialPaneFollow.e2e.ts`, `dialOrcaFocus.e2e.ts` | 1 | high | none (tests only, one commit) |
| 3 The app follow files | `cli/e2e/dialTerminalFollow.e2e.ts`, `dialClaudeAppFollow.e2e.ts`, `dialVscodeFollow.e2e.ts`, `dialVscode.e2e.ts` | 1, 2 | high | none (tests only, one commit) |
| 4 The device files | the 18 files Task 4 lists | 1, 2 | high | none (tests only, one commit) |
| 5 The end-to-end daemon finds no ChatGPT app but a test's own | `cli/e2e/harness/daemon.ts`, `harness/codexAppCli.ts` (new), `harness/fakeEngine.mjs`, `cli/e2e/developerState.e2e.ts` | none | high | `e2e/developerState.e2e.ts` |
| 6 `codex queue` runs the `codex` a launch would, under the login shell's environment | `cli/src/cable/hosts/codexQueue.ts`, `codexQueue.spec.ts`, `cli/src/services/devices.ts`, `devices.spec.ts` | none | xhigh | `codexQueue.spec.ts`, `devices.spec.ts` |
| 7 A ChatGPT app session is queued through the app's own CLI | `codexQueue.ts`, `codexQueue.spec.ts`, `cli/src/cable/hosts/observed.ts`, `observed.spec.ts`, `devices.spec.ts`, `cli/e2e/deviceCodex.e2e.ts` | 5, 6 | xhigh | `codexQueue.spec.ts`, `observed.spec.ts`, `devices.spec.ts`, `e2e/deviceCodex.e2e.ts` (macOS) |
| 8 A failed queue says what to do, and which `codex` ran | `observed.ts`, `observed.spec.ts`, `devices.spec.ts` | 7 | high | `observed.spec.ts`, `devices.spec.ts` |
| 9 The docs say the new behaviour | `docs/specs/2026-11-15-device-codex.md`, `docs/specs/2026-11-14-dial-app-filter.md`, `cli/AGENTS.md` | none | medium | none (docs, one commit) |

Longest chain: three tasks (6 → 7 → 8; 5 → 7 → 8; 1 → 2 → 3 or 4). Tasks 1, 5, 6 and 9 share no file and start at once.

- Tasks 6, 7 and 8 edit `codexQueue.ts`, `observed.ts` and `devices.spec.ts` in turn: each depends on the one before, so none overlaps.
- Task 7 needs Task 5 for its end-to-end test (the harness names the app's CLI) and Task 6 for the queue's new dependencies.
- Tasks 3 and 4 need Task 2 only for `FakeDial.turnUntil`.
- Task 1 leaves other dial end-to-end files red at its head (the landing changes what they expect). Tasks 2 to 4 turn them green. `deviceCodex.e2e.ts` (Task 7) sends no `focus` and waits for none, so the landing does not change it.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/**` | **Devices service process** only | their specs (PR CI `cli-tests`) |
| `cli/src/services/devices.ts` | **Devices service process** | 100% per file (`npm run test:core`, local) |
| `cli/e2e/**` | Tests and their harness | the end-to-end runs in Verification |
| `docs/**`, `cli/AGENTS.md` | Docs | review |

Not changed, and a diff in any is a finding: anything under `cli/src/core/`, `cli/src/architecture.coreFiles.txt`, `cli/src/lib/loginShellEnv.ts`, `lib/startEnvironment.ts`, `lib/engineBin.ts`, `lib/binaryOnPath.ts`, `cable/hosts/codexApp.ts`, `cable/cableHost.ts`, `devices/` (firmware), `desktop/`, `.github/`.

## Global Constraints

**A, the landing (spec, "A")**
- Only after `agents.end` of a list with `view: 'machine'`, with or without `appFilter`. A window's tab (no `view`) never lands.
- All four hold: the list has agents; `lastRing` had none before this push; the record names none of the list's agents; `appFocusUnsent` is false.
- The `'agents.list'` case empties `lastRing` before its `pushAgents()` (PM, 2026-11-18): a dial asks for the list only when it holds none, for example after its 15 s silence rule while the port stays open. The record is kept, so a record in the ring is re-asserted. A greeting (`hello`) is unchanged.
- A daemon or devices process that restarts behind a plugged dial lands it on the first agent (PM, 2026-11-18).
- A record in the list is re-asserted as today. A ring that replaces a ring with agents sends no landing.
- The landing sets the expected echo for `APP_FOCUS_SETTLE_MS` (750 ms) and goes through `focusAgent`, so the host hears `dialShows`. It calls no `host.focus` and brings nothing forward.
- `same` on `app.pick` still sends nothing. No new log line.

**B, the queue (spec, "B")**
- An app session is `agent.app === 'codex' && agent.engine === 'codex'`. A session whose app is not known yet is not the app's.
- The app's CLI: the first of `/Applications/ChatGPT.app` and `~/Applications/ChatGPT.app` whose `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` is executable. macOS only, run directly, no shell.
- Every other session, and an app session with no app CLI found: `CODEX_PATH` when set, else `codex` on the login shell's PATH, then on the daemon's. Each look holds 30 s; a look taken before the login shell was read holds only until it is read.
- The app's CLI that fails is not tried again through the other `codex`: the words must never run twice.
- The run's environment: `oneShotParentEnv()`, with `PATH` the login shell's followed by the daemon's and `CODEX_HOME` the daemon's (`env.CODEX_HOME`).
- The login shell is read (`warmLoginShellEnvironment`) on the first `can()` or `send()`, on macOS and Linux. Never at start, never on Windows. Windows still never runs `codex queue`.
- After a definite failure (`exit <n>` or `no binary`) for a session with no pane to type into: `Update ChatGPT, then try again.` for an app session, `Codex could not take it. Try again.` for another. `refused` keeps `<name> did not answer.`.
- The log: `[device] voice · codex-failed (exit 127 · app)` or `(… · path)`. `(refused)` has no suffix: no `codex` ran. `voice · codex` and the `voice · no-answer` that follows a failure are unchanged (the spec's Measures name no other line).
- No log line holds a path, the app's name, a thread id or the words.

**The test seam (PM, 2026-11-18)**
- One variable, `HARNESS_CODEX_APP_BIN`, read in `codexQueue.ts` alone, as `HARNESS_ORCA_APP_BIN` is in `devices/orcaHomes.ts`: an absolute path is the only place the app's CLI is looked for; empty or relative, the two app folders.
- It passes the start allowlist with no edit: `START_ENV_PREFIXES` keeps `HARNESS_`, and `isAgentSessionVariable` does not name it (`src/architecture.startEnvironment.spec.ts` holds it).
- The end-to-end harness names it for every daemon, inside the daemon's own root and missing until a test writes it, so no daemon under test runs the developer's ChatGPT app (Task 5).

**What the landing changes for a test (Tasks 1 to 4)**
- M1: a `focus` on the ring's first agent follows the first machine list with agents, each one after an empty list, and each one that answers the dial's `agents.list` while the record names none of its agents.
- M2: the record names that agent. Each later ring push re-asserts it. A follow to it sends nothing (the dial is there). The host's shown agent is that agent, not none.
- M3: for 750 ms after the landing and after each re-assert, a dial's `focus` on another agent is dropped, and one on that agent is taken as its echo: no `host.focus`, no rest, no switch.

**Adapting a test to the landing**
- Expect the landing where it is the truth: the `focus`, the shown agent.
- A hand's turn that may fall within 750 ms of a daemon `focus` is sent with `FakeDial.turnUntil` (Task 2): again until its effect is seen, as a person turns again.
- A follow to the agent the dial already shows: wait for the line the follow writes, or turn the dial elsewhere first.
- A "no focus" check names the agent the test is about, never any `focus`.
- Never: a fixed sleep, a longer timeout as the fix, a removed assertion about the behaviour under test, a switch that turns the landing off.
- A failure none of M1 to M3 explains is a finding about Task 1: stop and report it.

**Every task**
- No fixed sleeps. Comments say why. No file under `cli/src/core` changes.
- Tests never touch the developer's own apps, daemon, `~/.codex` or `/Applications`: a spec that uses the real `codexQueueDeps()` stubs `HARNESS_CODEX_APP_BIN` to a path in its temp folder, and the login shell is always mocked.

## Review Focus

1. **The login shell is slow, fails or gives nothing** (a `.zshrc` that hangs for its 5 s, no shell): the words still go, from the daemon's environment; nothing throws; a look taken before the read is taken again after it. Pinned in Task 6.
2. **An empty or missing PATH on either side:** the joined PATH has no empty segment, which would be the folder `codex` runs in (the home folder). Pinned in Task 6.
3. **The ChatGPT app is there but its CLI fails** (an older app with no `queue`, exit 2): one run, never a second through the other `codex`; a CLI that is not executable is passed over. Pinned in Task 7; the person's sentence in Task 8.
4. **A reattach after the person turned to an agent further down the ring:** that agent is re-asserted, not the first. Pinned in Task 1.
5. **A swipe in the 750 ms after a landing:** dropped once, and the next swipe after them moves the dial. Pinned in Task 1.

---

### Task 1: A machine list lands a dial that holds no agent

**Layer:** devices service process. **Depends on:** none. **Effort:** `xhigh` (the session's focus record, a follow in flight, the echo guard).

**Red tests:** `cli/src/cable/cableSession.spec.ts`, `cli/e2e/dialAppFilter.e2e.ts`.

**Files:**
- Modify: `cli/src/cable/cableSession.ts` (`syncAgentsNow` and the `'agents.list'` case only)
- Test: `cli/src/cable/cableSession.spec.ts`
- Test: `cli/e2e/dialAppFilter.e2e.ts`

**Interfaces:**
- Produces, in `syncAgentsNow`, after `agents.end` was sent:

```ts
// Read before `this.lastRing` takes this push's agents.
const heldNone = this.lastRing.length === 0
// … lastRing, reportShown, as at the base …
if (this.desiredFocus && agents.some((a) => a.id === this.desiredFocus)) {
  // the re-assert, as at the base
} else if (view === 'machine' && heldNone && agents.length > 0 && !this.appFocusUnsent) {
  this.expectedAppFocusEcho = agents[0].id
  this.expectedAppFocusEchoUntil = Date.now() + APP_FOCUS_SETTLE_MS
  await this.focusAgent(agents[0].id)
}
```

- Produces, in the message switch:

```ts
case 'agents.list':
  // A dial asks for the list only when it holds none (its 15 s silence rule empties it while the port stays open),
  // so the answer is a push after an empty list. The record stays: one in the ring is re-asserted.
  this.lastRing = []
  await this.pushAgents()
  return
```

- The comment says why, from the spec: the firmware adds a list's agents before it removes the old ones, so only a list that follows none leaves its face on no agent; a follow writes its record before its push and sends its own focus after it. The sentence "This is the ONLY thing the daemon re-asserts" is reworded: the record is still the only thing sent, and the landing writes it first.

Fixtures for the new tests, in `describe('a machine list lands a dial that holds no agent (docs/plans/2026-11-18-dial-chatgpt-pick-and-voice-design.md)')`, after `appHost`: `RING = [row('o1', 'ghostty'), row('h1', 'harness', 'svfa')]`; `machine = (agents: CableAgent[]) => ({ agents, tab: '', total: agents.length, view: 'machine' as const })`; `WINDOW = { agents: AGENTS, tab: 't1', total: 2 }`; `landed(snapshot, over = {})`: `connect(makeHost({ dialShows: vi.fn(), listAgentSnapshot: async () => snapshot(), ...over }))`, the hello `{ t: 'hello', product: 'harness', mac: 'aa:bb' }`, then wait for `agents.end`; `focuses = (port) => port.sent.filter((m) => m.t === 'focus')`. Tests that move time use `vi.useFakeTimers({ toFake: ['Date', 'performance'] })`.

- [ ] **Step 1: Write the tests in `cableSession.spec.ts`.**
  - `the first machine list after an attach sends focus on its first agent, after the list, and brings nothing forward`: `focuses` equals `[{ t: 'focus', agentId: 'o1' }]`; in `port.types()` the `focus` comes after the last `agents.end`; `host.focus` was not called; `dialShows`' last call is `[session, { name: 'o1', app: 'Ghostty' }, 'o1']`.
  - `a dial that says appFilter lands on the shown app's first agent, and a pick of the shown app still sends nothing`: `appHost()`, hello with `appFilter: 'v1'`: `focuses` equals `[{ t: 'focus', agentId: 'g1' }]`. Then `port.sent.length = 0`, `app.pick` of `ghostty`, `pickApp` called, `settle()`: `port.sent` holds no `apps`, `agents.begin`, `agent`, `agents.end` or `focus`.
  - `a machine list after an empty one lands on its first agent`: an empty list at the hello gives no `focus`; advance 1,100 ms, the list becomes `RING`, `session.syncAgents()`: `focuses` equals `[{ t: 'focus', agentId: 'o1' }]`.
  - `a ring that replaces a ring with agents sends no landing`: after the landing on `o1`, clear `port.sent`, advance 1,100 ms, the list becomes `[row('x1', 'ghostty'), row('x2', 'ghostty')]`, `syncAgents()`: no `focus`. And a dial greeted on `WINDOW` whose window then shuts (the list becomes `machine(RING)`): no `focus` at all.
  - `a record in the list is re-asserted, not the first agent`: landed on `o1`; advance 751 ms; the dial says `focus` `h1`; clear `port.sent`; advance 1,100 ms; the list gains `row('n1', 'ghostty')`; `syncAgents()`: `focuses` equals `[{ t: 'focus', agentId: 'h1' }]`.
  - `a reattach keeps the person's place: a record further down the new ring is re-asserted` (Review Focus 4): as above up to the dial's `focus` `h1`; `port.close('unplugged')`; the session opens its next port (the replug pattern at the base); hello: on the new port `focuses` equals `[{ t: 'focus', agentId: 'h1' }]`.
  - `a reattach whose record names an agent of another ring lands on the first agent`: the same, with the list `[row('x1', 'ghostty'), row('x2', 'ghostty')]` at the second hello: `[{ t: 'focus', agentId: 'x1' }]`.
  - `a follow in flight lands only its own agent`: an empty list at the hello; advance 1,100 ms; then the list becomes `RING` and `followApp` is called in the same synchronous step, so the session's own tick cannot push the list first. (a) `session.followApp('mac-local', 'h1')`: at least one `focus`, every one on `h1`. (b) in a session of its own, `session.followApp('mac-local', 'zz')`: `focuses` equals `[{ t: 'focus', agentId: 'zz' }]`, none on `o1`.
  - `a window's tab with no record sends no focus`: greeted on `WINDOW`: no `focus`.
  - `a dial that asks agents.list while its port stays open is landed on the first agent, or has its record re-asserted` (PM, 2026-11-18): (a) landed on `o1`; advance 751 ms; the dial says `focus` `h1`; advance 1,100 ms; the list becomes `[row('x1', 'ghostty'), row('x2', 'ghostty')]`, `syncAgents()`: no `focus` (a ring that replaces a ring with agents). Clear `port.sent`; the dial says `{ t: 'agents.list' }`; wait for `agents.end`: `focuses` equals `[{ t: 'focus', agentId: 'x1' }]`, after that `agents.end`. (b) in a session of its own: landed on `o1`; advance 751 ms; the dial says `focus` `h1`; clear `port.sent`; the dial says `agents.list`; wait for `agents.end`: `focuses` equals `[{ t: 'focus', agentId: 'h1' }]`. The port never closes in either.
  - `in the 750 ms after the landing a swipe is dropped, and the first swipe after them moves the dial` (Review Focus 5): landed on `o1`; the dial says `focus` `h1`: `host.focus` not called, `dialShows`' last agent still `o1`; advance 751 ms; the dial says `focus` `h1` again: `host.focus` called with `'h1'`, `dialShows`' last call names `h1`. In a session of its own: the dial says `focus` `o1` within the 750 ms: `host.focus` and `host.turned` not called (the landing's echo is no hand's move).
- [ ] **Step 2: Write the end-to-end test in `e2e/dialAppFilter.e2e.ts`:** `a dial plugged in over an app's ring is sent a focus on its first agent, after its list, and nothing is brought forward`. `fresh()`, `plugged(desk)`, `a1 = startFirst(d, first, 'ghostty', 'a1', GHOSTTY)`, `a2 = startOutside(d, 'a2', GHOSTTY)`, `shows(first, 'ghostty', [a1, a2])`. The first dial, whose list went from none to `a1`, hears `focus` on `a1.id` (`first.next`, 30 s). Note `d.opens().length`. Plug a second dial: `plugged(desk, FILTER, 'E2E-B', 'e2:e0:00:00:00:0b')`, `shows(second, 'ghostty', [a1, a2])`. The first `focus` the second dial hears (`second.next((m) => m.t === 'focus', 30_000, 'the focus after the list')`) names `a1.id`, and its index in `second.messages` is after the `agents.end` of the list that holds both. `d.opens().length` is unchanged.
- [ ] **Step 3: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts`, then `npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilter.e2e.ts -t "plugged in over an app's ring"`. Expected: FAIL in the tests that expect a landing (no `focus` is sent; the end-to-end test fails waiting for the first dial's `focus`), the `agents.list` test's (a) included. The tests that expect no `focus`, and the `agents.list` test's (b) (today's re-assert), may already pass.
- [ ] **Step 4: Commit** `test(dial): a machine list lands a dial that holds no agent (red)`.
- [ ] **Step 5: Implement** the landing and the `'agents.list'` case (Interfaces above).
- [ ] **Step 6: Adapt the tests the landing changes,** in `cableSession.spec.ts` and `e2e/dialAppFilter.e2e.ts` only, by Global Constraints ("What the landing changes for a test", "Adapting a test to the landing"). In the unit spec a hand's turn right after a machine list either moves fake time 751 ms first or has the dial say the landing's echo first, as an older firmware does. The report lists each changed test with M1, M2 or M3.
- [ ] **Step 7: Run** `cd cli && npx vitest run src/cable && npm run typecheck`, then `npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilter.e2e.ts` twice. Expected: PASS both times.
- [ ] **Step 8: Commit** `dial: a machine list lands a dial that holds no agent on its first agent`.

### Task 2: The fake dial turns by hand past the echo guard; the Orca follow files

**Layer:** end-to-end tests and harness. **Depends on:** 1. **Effort:** `high`.

**Red test:** none: no behaviour changes. The tests it changes fail at Task 1's head, and that is its evidence. One commit.

**Files:**
- Modify: `cli/e2e/harness/fakeDial.ts`
- Modify: `cli/e2e/dialStream.e2e.ts`, `cli/e2e/dialPaneFollow.e2e.ts`, `cli/e2e/dialOrcaFocus.e2e.ts`

**Interfaces:**
- Produces: `FakeDial.turnUntil<T>(agentId: string, what: string, probe: () => T | undefined, ms = 60_000): Promise<T>`: sends `{ t: 'focus', agentId }`, again every 2 s, until `probe` gives a value, polling every 50 ms; throws naming `what` after `ms`. Moved from `dialStream.e2e.ts`'s `turned`, which goes. Its comment says why: the daemon drops a dial's `focus` for 750 ms after a focus of its own (a landing, a re-assert, a follow) and the firmware echoes none, so a person's turn is made again.

- [ ] **Step 1: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialStream.e2e.ts e2e/dialPaneFollow.e2e.ts e2e/dialOrcaFocus.e2e.ts`. Note each failing test and its failure.
- [ ] **Step 2: Add `turnUntil`,** use it in `dialStream.e2e.ts` in place of `turned`, and adapt each failing test by Global Constraints. Known from reading: `dialStream.e2e.ts` expects the stream's first line to say no agent after sessions are listed (M2: the dial has landed); `dialOrcaFocus.e2e.ts`'s `turnedToFirst` turns to the first listed agent right after a re-assert (M3) and `typedUntilMoved` waits for a `focus` on an agent the dial may already show (M2).
- [ ] **Step 3: Run** the three files again, twice. Expected: PASS both times, with no test skipped that ran at the base.
- [ ] **Step 4: Commit** `test(dial): the Orca follow end-to-end tests expect a landed dial`. The report lists each changed test with its failure at Task 1's head and M1, M2 or M3.

### Task 3: The app follow files

**Layer:** end-to-end tests. **Depends on:** 1, 2 (`FakeDial.turnUntil`). **Effort:** `high`.

**Red test:** none, as Task 2. One commit.

**Files:**
- Modify: `cli/e2e/dialTerminalFollow.e2e.ts`, `cli/e2e/dialClaudeAppFollow.e2e.ts`, `cli/e2e/dialVscodeFollow.e2e.ts`, `cli/e2e/dialVscode.e2e.ts`

- [ ] **Step 1: Run** the four files on this Mac (`dialTerminalFollow` and `dialVscodeFollow` run on macOS only): `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialTerminalFollow.e2e.ts e2e/dialClaudeAppFollow.e2e.ts e2e/dialVscodeFollow.e2e.ts e2e/dialVscode.e2e.ts`. Note each failing test and its failure.
- [ ] **Step 2: Adapt** each failing test by Global Constraints. Known from reading: each file sends a dial `focus` right after agents are listed (M3) and holds "no focus since" checks (M2).
- [ ] **Step 3: Run** the four files again, twice. Expected: PASS both times.
- [ ] **Step 4: Commit** `test(dial): the app follow end-to-end tests expect a landed dial`. The report as in Task 2.

### Task 4: The device files

**Layer:** end-to-end tests. **Depends on:** 1, 2 (`FakeDial.turnUntil`). **Effort:** `high`.

**Red test:** none, as Task 2. One commit, or none when no file needs a change (the report then says so, with the run).

**Files (each only where the landing changed what it expects):**
- `cli/e2e/deviceWithoutApp.e2e.ts`, `deviceCompat.e2e.ts`, `devicesProcess.e2e.ts`, `deviceHerdrApp.e2e.ts` (these four send or wait for a `focus`)
- `cli/e2e/deviceHerdr.e2e.ts`, `deviceCmux.e2e.ts`, `deviceClaudeOrca.e2e.ts`, `deviceOpencode.e2e.ts`, `deviceNotify.e2e.ts`, `deviceOrcaHomes.e2e.ts`, `deviceDialSkill.e2e.ts`, `devicesOnDemand.e2e.ts`, `dialCodexApp.e2e.ts`, `hardwareWatch.e2e.ts`, `wifiDevice.e2e.ts`, `windows.e2e.ts`, `terminal.e2e.ts`, `recapsCompat.e2e.ts` (they plug a dial in; run to confirm)

Not here: `deviceCodex.e2e.ts` (Task 7), `dialAppFilter.e2e.ts` (Task 1), `endurance.e2e.ts` and `perf.e2e.ts` (opt-in workloads that send and wait for no `focus`), `dialAppFilterOnDial.e2e.ts` (a real dial; its log pattern names only `app filter:` lines).

- [ ] **Step 1: Run** the 18 files: `cd cli && E2E_BUNDLE=1 E2E_WORKERS=4 npx vitest run --config vitest.e2e.config.ts <the 18 files>`. Note each failing test, and each `describe` skipped for a missing binary (`herdr`, Herdr Core, another build).
- [ ] **Step 2: Adapt** each failing test by Global Constraints. Read the skipped `describe`s for a hand's `focus` right after a list and adapt those the same way.
- [ ] **Step 3: Run** each changed file again, twice, one file at a time. Expected: PASS both times.
- [ ] **Step 4: Commit** `test(dial): the device end-to-end tests expect a landed dial`. The report as in Task 2, with what was skipped.

### Task 5: The end-to-end daemon finds no ChatGPT app but a test's own

**Layer:** end-to-end harness. **Depends on:** none. **Effort:** `high`.

**Red test:** `cli/e2e/developerState.e2e.ts`.

**Files:**
- Modify: `cli/e2e/harness/daemon.ts` (`create`'s `settings`, `EngineConfig`)
- Create: `cli/e2e/harness/codexAppCli.ts`
- Modify: `cli/e2e/harness/fakeEngine.mjs` (the `queue` branch, its header comment)
- Test: `cli/e2e/developerState.e2e.ts`

**Interfaces:**
- Produces in `daemon.ts`: `settings.HARNESS_CODEX_APP_BIN = join(own, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex')`, never written by `create`. Its comment says why, as `HARNESS_VSCODE_BIN`'s does: `/Applications` is the computer's, whatever the home, so the devices look for the app's CLI here alone. `EngineConfig.queueLedger?: string`: the file under the root where `codex queue` notes its calls, `codex-queue` when unset.
- Produces in `fakeEngine.mjs`: the `queue` branch appends to `join(config.root, config.queueLedger ?? 'codex-queue')`. Nothing else of it changes.
- Produces in `codexAppCli.ts` (header: the ChatGPT app's own Codex CLI and a PATH `codex` that cannot queue, as fakes under a daemon's root; the real app and a real `codex` never run):
  - `writeAppCodex(daemon: IsolatedDaemon): void`: writes `fakeEngineShim('codex', { ...daemon.engineConfig, queueLedger: 'codex-app-queue' })`, mode 0755, at `daemon.env.HARNESS_CODEX_APP_BIN`, making its folders. Throws when that path is not inside `daemon.root`. Before the daemon starts.
  - `appQueued(daemon: IsolatedDaemon): unknown[]`: each line of `codex-app-queue` parsed; `[]` when there is none.
  - `writePathCodexWhoseQueueFails(daemon: IsolatedDaemon): void`: writes over `<root>/bin/codex` as `writeHungCodex` does, with a first line that, for `process.argv[2] === 'queue'`, appends a line to `<root>/codex-path-queue` and exits 127. Every other call runs the fake engine as before.
  - `pathQueueRuns(daemon: IsolatedDaemon): number`: the lines of `codex-path-queue`; 0 when there is none.

- [ ] **Step 1: Write the tests in `developerState.e2e.ts`.**
  - `finds none of the developer's ChatGPT app: its devices look for the app's own codex only in its own root, where there is none`: `IsolatedDaemon.create()`; `d.env.HARNESS_CODEX_APP_BIN` is absolute, `relative(d.root, bin)` does not start with `..`, and `existsSync(bin)` is false.
  - `it.skipIf(process.platform === 'win32')`: `a test's own app codex notes its queue calls apart from the PATH codex's, whose queue exits 127`: `IsolatedDaemon.create()`, `writeAppCodex(d)`, `writePathCodexWhoseQueueFails(d)`, `codex = new CodexOutside(d, 'api', [], {})` (its constructor writes the thread's rollout). `execFileSync(d.env.HARNESS_CODEX_APP_BIN, ['queue', '--thread', codex.sessionId, '--message=hi'], { env: d.env })`: `appQueued(d)` equals `[{ args: ['queue', '--thread', codex.sessionId, '--message=hi'], codexHome: d.env.CODEX_HOME }]` and `<root>/codex-queue` does not exist. `spawnSync(join(d.root, 'bin', 'codex'), ['queue', '--thread', codex.sessionId, '--message=hi'], { env: d.env }).status` is 127 and `pathQueueRuns(d)` is 1. `spawnSync(join(d.root, 'bin', 'codex'), ['--version'], { env: d.env }).status` is 0.
- [ ] **Step 2: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/developerState.e2e.ts`. Expected: FAIL in both new tests (the variable is unset; `./harness/codexAppCli.js` does not exist).
- [ ] **Step 3: Commit** `test(dial): the end-to-end daemon finds no ChatGPT app but a test's own (red)`.
- [ ] **Step 4: Implement** the setting, the ledger and `codexAppCli.ts` (Interfaces above).
- [ ] **Step 5: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/developerState.e2e.ts e2e/deviceCodex.e2e.ts && npx vitest run src/testing`. Expected: PASS (`deviceCodex.e2e.ts` still reads `codex-queue`).
- [ ] **Step 6: Commit** `dial: the end-to-end daemon finds no ChatGPT app but a test's own`.

### Task 6: `codex queue` runs the `codex` a launch would, under the login shell's environment

**Layer:** devices service process. **Depends on:** none. **Effort:** `xhigh` (it reads the person's login shell and builds the environment a program runs in).

**Red tests:** `cli/src/cable/hosts/codexQueue.spec.ts`, `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/codexQueue.ts`
- Test: `cli/src/cable/hosts/codexQueue.spec.ts`
- Modify: `cli/src/services/devices.ts` (`DevicesDeps.codex`'s type and doc comment only)
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Produces in `CodexQueueDeps`:
  - `run(file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<CodexRunEnd>` (the type of `env` widens; the real `run`'s body stays).
  - `parentEnv(): NodeJS.ProcessEnv`: what a run starts from.
  - `readLoginShell(): void`: starts the read of the login shell's environment. Never throws.
- Produces: `codexQueueDeps(): Omit<CodexQueueDeps, 'home' | 'cwd'>`, and `DevicesDeps.codex?: Omit<CodexQueueDeps, 'home' | 'cwd'>`. The `createCodexQueue` call in `devices.ts` does not change.
- The real deps:
  - `binary()`: `name = engineBin('codex')`; `resolveBinaryOnPath(name, { PATH: loginShellEnvironment().PATH }) ?? resolveBinaryOnPath(name)`. A `CODEX_PATH` that names a path is that path in both looks, so it comes first and a missing one finds nothing, as today. Held 30 s on the monotonic clock, as today.
  - `parentEnv()`: `{ ...oneShotParentEnv(), PATH }`, `PATH` the login shell's and the daemon's joined with `path.delimiter`, in that order; a side that is unset or empty adds nothing.
  - `readLoginShell()`: `warmLoginShellEnvironment()`, and when it ends the held look is dropped.
- `createCodexQueue`:
  - The first `can()` or `send()` that reaches the look calls `deps.readLoginShell()`, once for the queue's life. On `win32` it is never called, and `deps.binary()` is never asked, as today.
  - `send` runs with `env: { ...deps.parentEnv(), CODEX_HOME: deps.home }`.
- `can()`, `send(threadId, text)` and `CodexQueueResult` keep their shape (Task 7 changes them).
- Comments: the file header says which `codex` and which environment, and why (the daemon runs under launchd and never read the person's profile; an npm `codex` is `#!/usr/bin/env node` and exits 127 with no `node` on PATH; spec, cause 2). The `BINARY_LOOK_MS` comment says a look is at most two walks.

The login shell in `codexQueue.spec.ts`, never a real one:

```ts
const shell = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv, read: (): Promise<NodeJS.ProcessEnv> => Promise.resolve({}) }))
vi.mock('../../lib/loginShellEnv.js', async (original) => ({
  ...await original<typeof import('../../lib/loginShellEnv.js')>(),
  loginShellEnvironment: () => shell.env,
  warmLoginShellEnvironment: () => shell.read(),
  // The module's own rule, restated: the real one reads the module's cache, which this mock never fills.
  oneShotParentEnv: () => ({ ...shell.env, ...process.env }),
}))
```

`afterEach` sets `shell.env = {}` and `shell.read` back. `recorder` and `held` gain `parentEnv: () => ({ PATH: '/usr/bin' })` and `readLoginShell: vi.fn()`.

- [ ] **Step 1: Write the tests in `codexQueue.spec.ts`.**
  - Update `send runs codex queue with the thread and the text …`: the run's `env` is `{ PATH: '/usr/bin', CODEX_HOME: '/home/u/.codex' }`.
  - `codex on the login shell's PATH is found before the daemon's, and CODEX_PATH before both`: folders `login/` and `daemon/`, each with an executable `codex`; `shell.env = { PATH: login }`, `vi.stubEnv('PATH', daemon)`, `CODEX_PATH` `''`: `binary()` is `login/codex`. Remove it, advance 30 s: `daemon/codex`. `CODEX_PATH` an executable `other/my-codex`, advance 30 s: that path. `CODEX_PATH` a missing path, advance 30 s: null.
  - `a look taken before the login shell was read is taken again once it is read` (Review Focus 1): `shell.env = {}`, the daemon's PATH an empty folder: `binary()` is null. Put `codex` in `login/`, set `shell.env = { PATH: login }`: still null (held). `shell.read` answers a promise the test holds; `readLoginShell()`; resolve it; after a microtask turn `binary()` is `login/codex`, with no time advanced.
  - `a read that gives nothing changes nothing and never throws` (Review Focus 1): `shell.read` resolves `{}`; `readLoginShell()` does not throw; `binary()` is the daemon's `codex`.
  - `the run's environment is the login shell's with the daemon's on top, PATH the login shell's then the daemon's, CODEX_HOME the daemon's`: `shell.env = { PATH: '/login/bin', CODEX_HOME: '/login/codex', ONLY_LOGIN: '1', BOTH: 'login' }`, `vi.stubEnv('PATH', '/daemon/bin')`, `vi.stubEnv('BOTH', 'daemon')`; a queue of `{ ...codexQueueDeps(), run: <recording>, binary: () => FAKE_CODEX, home: '/daemon/codex', cwd: dir }`: after one `send`, the recorded `env` has `PATH` `` `/login/bin${delimiter}/daemon/bin` ``, `CODEX_HOME` `'/daemon/codex'`, `ONLY_LOGIN` `'1'`, `BOTH` `'daemon'`.
  - `an empty PATH on either side adds no empty segment` (Review Focus 2): `shell.env = {}`: `parentEnv().PATH` is `'/daemon/bin'`. `shell.env = { PATH: '/login/bin' }` and the daemon's PATH `''`: `'/login/bin'`. In neither does `PATH` start or end with `delimiter`.
  - `the login shell is read on first use: never at creation, once however often it is asked, never on Windows`: with `readLoginShell: vi.fn()`: not called after `createCodexQueue`; called once after `can()`, `can()` and a `send`; a queue whose first use is `send` calls it once; a refused `send` alone does not call it; with `platform: 'win32'`, `can()` and `send` never call it nor `binary`.
- [ ] **Step 2: Write the tests in `devices.spec.ts`.** The `codex` fake gains `parentEnv: () => ({ PATH: '/usr/bin' })` and `readLoginShell`, a `vi.fn()` the specs can read; `codexRuns`' `env` type becomes `NodeJS.ProcessEnv`.
  - Update `the queue is wired with env.CODEX_HOME and the home directory`: the run's `env` is `{ PATH: '/usr/bin', CODEX_HOME: env.CODEX_HOME }`.
  - `the login shell is read once a Codex session is listed, never for a computer with none`: the devices started with a Claude Code session outside Harness listed: `readLoginShell` not called. With the Codex session of `started()` listed: called once, however many times the list is read.
- [ ] **Step 3: Run** `cd cli && npx vitest run src/cable/hosts/codexQueue.spec.ts src/services/devices.spec.ts`. Expected: FAIL in the new and updated tests (`readLoginShell` and `parentEnv` are never asked; the login shell's PATH is not read).
- [ ] **Step 4: Commit** `test(dial): codex queue runs the codex a launch would, under the login shell's environment (red)`.
- [ ] **Step 5: Implement** (Interfaces above).
- [ ] **Step 6: Run** `cd cli && npx vitest run src/cable/hosts src/services/devices.spec.ts src/architecture.spec.ts src/architecture.startEnvironment.spec.ts src/architecture.environment.spec.ts && npm run typecheck && npm run test:core`, then `npx vitest run --config vitest.e2e.config.ts e2e/deviceCodex.e2e.ts`. Expected: PASS, 100% for `services/devices.ts`.
- [ ] **Step 7: Commit** `dial: codex queue runs the codex a launch would, under the login shell's environment`.

### Task 7: A ChatGPT app session is queued through the app's own CLI

**Layer:** devices service process. **Depends on:** 5 (the harness names the app's CLI), 6 (the queue's dependencies; it edits the same files after it). **Effort:** `xhigh` (it chooses the program that runs with a person's words).

**Red tests:** `cli/src/cable/hosts/codexQueue.spec.ts`, `cli/src/cable/hosts/observed.spec.ts`, `cli/src/services/devices.spec.ts`, `cli/e2e/deviceCodex.e2e.ts` (macOS).

**Files:**
- Modify: `cli/src/cable/hosts/codexQueue.ts`
- Test: `cli/src/cable/hosts/codexQueue.spec.ts`
- Modify: `cli/src/cable/hosts/observed.ts` (`queueable`, `send`'s queue call)
- Test: `cli/src/cable/hosts/observed.spec.ts`
- Test: `cli/src/services/devices.spec.ts`
- Test: `cli/e2e/deviceCodex.e2e.ts`

**Interfaces:**
- Consumes: Task 6's `CodexQueueDeps`; Task 5's `writeAppCodex`, `appQueued`, `writePathCodexWhoseQueueFails`, `pathQueueRuns`.
- Produces in `codexQueue.ts`:
  - `export type CodexRan = 'app' | 'path'`: which `codex` a send chose, as the log names it.
  - `CodexQueueResult = { outcome: 'queued' | 'timeout' | 'busy' } | { outcome: 'failed'; reason: 'refused' } | { outcome: 'failed'; reason: Exclude<CodexQueueFailure, 'refused'>; ran: CodexRan }`.
  - `CodexQueue { can(isApp: boolean): boolean; send(threadId: string, text: string, isApp: boolean): Promise<CodexQueueResult> }`, `isApp`: the session is the ChatGPT app's.
  - `CodexQueueDeps.appBinary(): string | null`: the ChatGPT app's own Codex CLI, where it can run.
  - `export function appCodexCandidates(named: string | undefined, home: string): string[]`: `[named]` when `named` is an absolute path; else `/Applications/ChatGPT.app/…` then `<home>/Applications/ChatGPT.app/…`, each ending `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`.
  - The real `appBinary()`: the first of `appCodexCandidates(process.env.HARNESS_CODEX_APP_BIN, homedir())` that is executable, else null; held 30 s and dropped with the other look when the login shell is read. Its comment names the variable's one use, as `orcaApp()`'s does.
- `createCodexQueue`:
  - The choice: on `win32` none, and no dependency is asked. For `isApp` on `darwin`, `deps.appBinary()` when it is there (`ran: 'app'`). Else `deps.binary()` (`ran: 'path'`). Off `darwin`, `deps.appBinary()` is never asked.
  - `can(isApp)`: a choice is there.
  - `send`: the checks first, as today (`refused` asks no dependency). No choice: `{ outcome: 'failed', reason: 'no binary', ran: 'path' }`. A numeric exit or `not-started` carries the choice's `ran`. One run a send: a failed app CLI is never followed by the other `codex`.
- Produces in `observed.ts`: `private inCodexApp(e: Entry): boolean`, `e.agent.app === 'codex' && e.agent.engine === 'codex'` (the test `codexApp.ts` `paneOf` uses); `queueable` asks `codexQueue.can(this.inCodexApp(e))`; `send` calls `codexQueue.send(sessionId, text, this.inCodexApp(e))`. The count stays `` `codex-failed (${queued.reason})` `` here (Task 8 changes it).

- [ ] **Step 1: Write the tests in `codexQueue.spec.ts`.** Every existing call becomes `can(false)` and `send(…, false)`; every expected `failed` with an exit or `no binary` gains `ran: 'path'`. `recorder` and `held` gain `appBinary: () => null`. A `beforeEach` stubs `HARNESS_CODEX_APP_BIN` to `join(dir, 'no-app', 'codex')`, so no spec looks in `/Applications`.
  - `an app session on macOS runs the app's own codex; with none there it runs the other`: `platform: 'darwin'`, `appBinary: () => '/app/codex'`: `send(THREAD, 'hi', true)` runs `/app/codex` with the same arguments and environment; `send(THREAD, 'hi', false)` runs `FAKE_CODEX`; with `appBinary: () => null`, `send(…, true)` runs `FAKE_CODEX`.
  - `can() is true for an app session with only the app's codex, and false for another session there`: `appBinary: () => '/app/codex'`, `binary: () => null`: `can(true)` true, `can(false)` false, `send(THREAD, 'hi', false)` is `{ outcome: 'failed', reason: 'no binary', ran: 'path' }` and runs nothing.
  - `off macOS the app's codex is never asked for`: `platform: 'linux'`, `appBinary: vi.fn(() => '/app/codex')`: `can(true)` is true through `binary`, `send(…, true)` runs `FAKE_CODEX`, `appBinary` not called.
  - `a failure names the codex that ran, and a failed app codex is not run again through the other` (Review Focus 3): app session, ends `[2]`: `{ outcome: 'failed', reason: 'exit 2', ran: 'app' }` and one call; `['not-started']`: `{ outcome: 'failed', reason: 'no binary', ran: 'app' }`; another session, ends `[127]`: `{ outcome: 'failed', reason: 'exit 127', ran: 'path' }`; a refused send is `{ outcome: 'failed', reason: 'refused' }`.
  - Update the Windows test: `can(true)` false; `send(THREAD, 'hi', true)` is `{ outcome: 'failed', reason: 'no binary', ran: 'path' }`; `appBinary` and `binary` never asked.
  - `the app's codex is the absolute path HARNESS_CODEX_APP_BIN names, alone; else the app in /Applications, then in ~/Applications`: `appCodexCandidates(undefined, '/Users/u')`, `('', …)` and `('codex', …)` equal `['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', '/Users/u/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex']`; `('/t/app/codex', '/Users/u')` equals `['/t/app/codex']`.
  - `the real app look finds an executable there, passes over a file that cannot run, and holds 30 s` (Review Focus 3): `HARNESS_CODEX_APP_BIN` a path in the temp folder: `appBinary()` null; a file with no execute bit there, advance 30 s: null; made executable, advance 29,999 ms: null; 1 ms more: the path.
- [ ] **Step 2: Write the tests in `observed.spec.ts`.** `fakeActions`' `codexQueue` becomes `can: vi.fn((_isApp: boolean) => true)` and `send: vi.fn(async (_threadId: string, _text: string, _isApp: boolean) => ({ outcome: 'queued' }))`; every expected `send.mock.calls` gains its third value (`false` in `describe('ObservedSource and codex queue')`); `FAILED` gains `ran: 'path'`.
  - In `describe('ObservedSource and the Codex app')`: `a Codex app session asks the queue as the app's, and a Codex in Ghostty does not`: `hooked({ ...inApp, transcriptPath: rollout })`: `capabilities` then `send(agent, 'next')`: every `can` call is `[true]`, `send.mock.calls` equals `[[THREAD, 'next', true]]`. The same session with `hostHints: { TERM_PROGRAM: 'ghostty' }`: `[false]` and `[[THREAD, 'next', false]]`.
  - `with only the app's codex there, an app session lists voice and a Codex in Ghostty does not`: `can.mockImplementation((isApp) => isApp)`: `capabilities(agent).voice` true for the app session, false for the other.
  - `a session whose app is not known yet is not the app's`: a session the scan found with no app learned (`scanned(new Map())`): every `can` call is `[false]`.
- [ ] **Step 3: Write the tests in `devices.spec.ts`,** in `describe('codex queue, for Codex outside a pane …')`. The `codex` fake gains `appBinary: () => null`. `APP = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'`.
  - `a ChatGPT app session on macOS runs the app's own codex`: `started({ codex: { ...codex, platform: 'darwin', appBinary: () => APP }, orca: { ...orca, platform: 'darwin' } }, { hostHints: { __CFBundleIdentifier: 'com.openai.codex' } })`; `sendTurn` is `{ ok: true }`; `codexRuns[0][0]` is `APP`; `said()` equals `['[device] voice · codex']`; no line of `logs` holds `APP`.
  - `with no codex but the app's, an app session lists sv`: the same with `binary: () => null`: `listed()` equals `[{ id: ID, name: 'api', caps: 'sv' }]`.
  - `a Codex app session's words still go through codex queue, and nothing is opened` stays: its `codex` is on `linux`, so the other `codex` runs.
- [ ] **Step 4: Write the end-to-end test in `e2e/deviceCodex.e2e.ts`:** `it.skipIf(process.platform !== 'darwin')("a Codex session in the ChatGPT app takes the dial's spoken words through the app's own codex, when the codex on PATH cannot queue")`. The first test's setup (it may become a helper both use), with `writeAppCodex(d)` and `writePathCodexWhoseQueueFails(d)` before `d.start()`, and `new CodexOutside(d, 'api', children, { __CFBundleIdentifier: 'com.openai.codex' })`. Its row has `host: 'codex'` and `caps` containing `v`. After `UserPromptSubmit` and the dial's voice (`relay.speech = 'run the spoken tests'`): the dial hears `voice.transcript` with those words; a log line ends `[device] voice · codex`; `appQueued(d)` equals `[{ args: ['queue', '--thread', codex.sessionId, '--message=run the spoken tests'], codexHome: d.env.CODEX_HOME }]`; `pathQueueRuns(d)` is 0; the log holds no `codex-failed`, no `codex.sessionId`, no `codex.transcriptPath` and not `d.env.HARNESS_CODEX_APP_BIN`.
- [ ] **Step 5: Run** `cd cli && npx vitest run src/cable/hosts/codexQueue.spec.ts src/cable/hosts/observed.spec.ts src/services/devices.spec.ts`, then `npx vitest run --config vitest.e2e.config.ts e2e/deviceCodex.e2e.ts`. Expected: FAIL in the new tests (no `appBinary`, no `isApp`; end to end, the PATH `codex` runs and exits 127, so no `voice · codex` line comes).
- [ ] **Step 6: Commit** `test(dial): a ChatGPT app session is queued through the app's own CLI (red)`.
- [ ] **Step 7: Implement** (Interfaces above).
- [ ] **Step 8: Measure one look, before and after** (code standard 4: `can()` runs for each Codex row on every 1 s tick while a dial is connected). A script in the task's scratch folder, never committed: a temp folder with 63 folders on a PATH; 1,000 looks not held, each timed. Before: the base's look (`resolveBinaryOnPath('codex', { PATH })`), with `codex` in the last folder and with none. After: this task's look for an app session with no app CLI and no `codex` (the two app candidates, then both PATHs). Put the after figures and the date in the `BINARY_LOOK_MS` comment beside the old ones, and both in the report for the pull request.
- [ ] **Step 9: Run** `cd cli && npx vitest run src/cable/hosts src/services/devices.spec.ts src/architecture.spec.ts src/architecture.startEnvironment.spec.ts && npm run typecheck && npm run test:core`, then `npx vitest run --config vitest.e2e.config.ts e2e/deviceCodex.e2e.ts e2e/dialCodexApp.e2e.ts`. Expected: PASS, 100% for `services/devices.ts`; on macOS `deviceCodex.e2e.ts` passes 2 and skips none.
- [ ] **Step 10: Commit** `dial: a ChatGPT app session is queued through the app's own CLI`.

### Task 8: A failed queue says what to do, and which `codex` ran

**Layer:** devices service process. **Depends on:** 7 (`CodexRan`, `inCodexApp`; it edits the same files after it). **Effort:** `high`.

**Red tests:** `cli/src/cable/hosts/observed.spec.ts`, `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts` (`ObservedActions.count`'s type, `send`)
- Test: `cli/src/cable/hosts/observed.spec.ts`
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Produces: `ObservedActions.count` takes `` 'codex-failed (refused)' | `codex-failed (${Exclude<CodexQueueFailure, 'refused'>} · ${CodexRan})` `` in place of `` `codex-failed (${CodexQueueFailure})` ``. Its doc comment: a failed queue's reason and which `codex` ran, fixed words only.
- In `send`, after a queue that answered `failed`:
  - `refused`: `count('codex-failed (refused)')`, then on as today.
  - an exit or `no binary`: `` count(`codex-failed (${reason} · ${ran})`) ``; then, when no pane of the session types (`typer` is none), `refuse('no-answer', …)` with `Update ChatGPT, then try again.` when `inCodexApp(e)`, else `Codex could not take it. Try again.`. A session with a pane that types goes on as today, with today's sentences.
- `send`'s doc comment says the two sentences and why (a session in the ChatGPT app has no pane to type into, and "did not answer" names nothing a person can do; spec, cause 2).

- [ ] **Step 1: Write the tests in `observed.spec.ts`,** in `describe('ObservedSource and codex queue')`.
  - Update `failed falls back to Orca only when idle at a handle, with today's sentences`: each count is `'codex-failed (exit 1 · path)'`; the `cx` row is `{ ok: false, reason: 'Codex could not take it. Try again.' }` with `'no-answer'`.
  - Update the Zellij, herdr, Rex, tmux test: a Codex with no herdr socket answers `Codex could not take it. Try again.`; a Claude Code there keeps `proj did not answer.`; the count is `'codex-failed (exit 1 · path)'`.
  - Replace `a failure is counted with its reason`: `no binary` with `ran: 'path'`: `Codex could not take it. Try again.`, counts `[['codex-failed (no binary · path)'], ['no-answer']]`. `refused`: `proj did not answer.`, counts `[['codex-failed (refused)'], ['no-answer']]`.
  - `an app session whose queue failed is told to update ChatGPT` (Review Focus 3): the session `{ ...cx, hostHints: { __CFBundleIdentifier: 'com.openai.codex' } }`; `send` answers `{ outcome: 'failed', reason: 'exit 127', ran: 'app' }`: `{ ok: false, reason: 'Update ChatGPT, then try again.' }`, counts `[['codex-failed (exit 127 · app)'], ['no-answer']]`. With `ran: 'path'` (no app CLI was there): the same sentence, counts `[['codex-failed (exit 127 · path)'], ['no-answer']]`.
  - Update `countWord says a word as it is …`: `countWord('codex-failed (exit 1 · path)')` is itself.
- [ ] **Step 2: Write the tests in `devices.spec.ts`.**
  - Update `a failed queue is said in one line with its exit code, then today's route answers`: the message `Codex could not take it. Try again.`; `said()` equals `['[device] voice · codex-failed (exit 1 · path)', '[device] voice · no-answer']`.
  - Update `a codex that could not start is said with no binary`: the same message; `'[device] voice · codex-failed (no binary · path)'`.
  - Update `no log line carries the thread id, the words, the transcript's path or the Codex home`: the two failed lines gain ` · path`.
  - `a ChatGPT app session whose app codex exits 127 is told to update ChatGPT, in one line that names no path`: Task 7's app setup with `ending(127)`'s `run`: the message `Update ChatGPT, then try again.`; `said()` equals `['[device] voice · codex-failed (exit 127 · app)', '[device] voice · no-answer']`; no line of `logs` holds `APP`, and neither `said()` line holds `ChatGPT`.
- [ ] **Step 3: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts src/services/devices.spec.ts`. Expected: FAIL in the new and updated tests (today's sentence, no suffix).
- [ ] **Step 4: Commit** `test(dial): a failed queue says what to do, and which codex ran (red)`.
- [ ] **Step 5: Implement** (Interfaces above).
- [ ] **Step 6: Run** `cd cli && npx vitest run src/cable/hosts src/services/devices.spec.ts && npm run typecheck && npm run test:core`. Expected: PASS, 100% for `services/devices.ts`.
- [ ] **Step 7: Commit** `dial: a failed queue says what to do, and which codex ran`.

### Task 9: The docs say the new behaviour

**Layer:** docs. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: docs. One commit.

**Files:**
- Modify: `docs/specs/2026-11-15-device-codex.md`
- Modify: `docs/specs/2026-11-14-dial-app-filter.md`
- Modify: `cli/AGENTS.md` (the `devices` row of "The processes")

- [ ] **Step 1: `docs/specs/2026-11-15-device-codex.md`,** each change marked "(Changed 2026-11-18, [design](../plans/2026-11-18-dial-chatgpt-pick-and-voice-design.md).)":
  - The data flow: `execFile(codex, …)` runs the ChatGPT app's own CLI for a session in that app (macOS), else the `codex` a launch would run; its environment is the login shell's with the daemon's on top, `PATH` the login shell's then the daemon's, `CODEX_HOME = env.CODEX_HOME`. A failed queue with no pane to type into answers `Update ChatGPT, then try again.` or `Codex could not take it. Try again.`.
  - "The binary is the Codex Harness itself launches … No login-shell probe" becomes Global Constraints' two binary lines and the lazy read. `can()` takes whether the session is the app's.
  - "What it logs": `codex-failed (exit N · app)`, `(exit N · path)`, `(no binary · app)`, `(no binary · path)`, `(refused)`.
  - Failure cases: "No `codex` on `PATH`" becomes no `codex` anywhere (an app session still queues through the app's CLI); new rows for a failed app session and a failed session elsewhere, with their sentences and lines. Measures: the same forms.
  - Tests: the list gains what Tasks 6 to 8 added, in one line each.
- [ ] **Step 2: `docs/specs/2026-11-14-dial-app-filter.md`,** one line beside "Picking returns to the face, on the first agent of the new ring.": a dial whose list was empty (an attach, or a list that emptied and filled again) is put on the new ring's first agent by the daemon's `focus` (2026-11-18, the design's link). The line also names the list the dial asks for itself (`agents.list`, as after its 15 s silence rule): the daemon answers it as a list after an empty one, so the dial lands on the first agent unless its record is in the ring (PM, 2026-11-18).
- [ ] **Step 3: `cli/AGENTS.md`,** in the `devices` row, the clause on `codex queue`: it runs the ChatGPT app's own Codex CLI for a session in that app on macOS, else the `codex` a launch would run, under the person's login-shell environment, read once at the first Codex session it is asked about (`cable/hosts/codexQueue.ts`).
- [ ] **Step 4: Check** every link added opens a file that exists (`ls` the targets), and `git diff --stat` names only the three files.
- [ ] **Step 5: Commit** `docs: codex queue's codex and environment, and the dial's landing`.

## Verification

**Platforms the pull request names:** macOS (A and B). Linux (A; B's `codex` lookup and environment; the app's CLI is never asked for). Windows (A only, in session code no platform changes; the queue never runs there, held by `codexQueue.spec.ts`). No Windows hardware run: an unverified row, said as such in the pull request.

**End-to-end checks, on the final head:**

1. **The dial end-to-end files on this Mac** (local: `dialTerminalFollow`, `dialVscodeFollow`, `deviceCmux`, one test of `dialAppFilter` and the new test of `deviceCodex` run on macOS only, and no workflow runs them there).
   - Run, in `cli/`, with an arm64 Node: `E2E_BUNDLE=1 E2E_WORKERS=4 npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilter.e2e.ts e2e/deviceCodex.e2e.ts e2e/developerState.e2e.ts` and every file of Tasks 2, 3 and 4. About ten minutes. If the run stops on a TMPDIR too long for a socket, run it again with `TMPDIR=/tmp`.
   - Isolated by the suite's own harness (`cli/AGENTS.md`, rule 6; `e2e/harness/daemon.ts`): each daemon has a throwaway home and data folder, a private tmux server, a port of its own, fake Claude Code and Codex, a fake `open`, a stub `orca`, no VS Code, and after Task 5 no ChatGPT app but a test's own. The backend is a fake on `127.0.0.1`; the machine a test signs in as is made up.
   - A person should see: every file passed; `deviceCodex.e2e.ts` 2 passed and 0 skipped; `dialAppFilter.e2e.ts`'s `plugged in over an app's ring` passed; no test skipped that ran at the base.
2. **The whole end-to-end suite on Linux**, the repo's own workflow, by hand, once: Actions → CLI end to end → Run workflow on the branch (`gh workflow run cli-e2e.yml --ref fix/dial-chatgpt-pick-and-voice`). Eight shards and `e2e-summary` green. It is advisory and never runs on the pull request; its run link goes in the pull request. `deviceCodex.e2e.ts`'s new test is skipped there (macOS only). **Starting this run needs the PM's turn when phase 4 reaches it** (PM, 2026-11-18): the tester asks through the main session and starts nothing before the answer.

**No temporary workflow.** The long check, the whole suite, has the repo's own by-hand workflow. The macOS run is about ten minutes at four workers and needs this Mac. Proposal for the maintainers, not this branch: a macOS job in CLI end to end for the dial files that run on macOS only.

**Required local gates**, run at the final head on this Mac and recorded in the pull request:
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit: it runs `cli-core` (`npm run test:core`, 100% per file under `src/core/` and `src/services/`), which applies because `cli/src/services/devices.ts` changes. Its receipt goes in the pull request's body before the tested commit is pushed.
- `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts src/testing src/architecture.spec.ts src/architecture.startEnvironment.spec.ts src/architecture.environment.spec.ts`.
- `git diff --stat origin/main -- cli/src/core cli/src/architecture.coreFiles.txt cli/src/lib/loginShellEnv.ts cli/src/lib/startEnvironment.ts cli/src/cable/hosts/codexApp.ts devices desktop .github` prints nothing.
- Not needed: `cli-serial`, `cli-shell`, `cli-pty`, `npm run test:harnessd`, desktop, firmware, device-app: no path of theirs changes.

**In PR CI, by itself:** `cli-typecheck` and `cli-tests` run every unit spec above on Linux (the harness files under `cli/e2e/harness/` select the CLI's jobs). No extra run is started.

**Numbers:** Task 7's look, before and after, in the pull request. The landing adds one frame per attach or refill and no recurring work.

**Never touched by a tester or a test:** the real ChatGPT app and its CLI, `/Applications`, `~/.codex`, `~/.claude`, the developer's daemon (port 18473) and `~/.harness`, the developer's login shell in a unit test, Diego's dial, any backend but the fake, production.

**Diego's own check** (his dial, his ChatGPT app, his everyday daemon, his eye; no tester or agent runs it), after the merge, on the merged build (PM, 2026-11-18):
- With ChatGPT shown on the dial, unplug it and plug it in again: the face shows a ChatGPT agent, not "Choose a pane".
- Speak to a ChatGPT agent: its thread takes the words, and the daemon's log has `[device] voice · codex` with no `codex-failed`. If one comes, its `· app` or `· path` says which `codex` ran.

**Against production:** none.

## Decisions (PM, 2026-11-18)

1. **A dial that asks `agents.list` while the port stays open:** `lastRing` is emptied before the push that answers it, since a dial asks only when it holds none (its 15 s silence rule). A record named in the ring is re-asserted; else the dial lands on the first agent. In Task 1: the `'agents.list'` case, its interface sketch and one more red unit test; Task 9's landing line names this case.
2. **A daemon or devices process that restarts behind a plugged dial** lands it on the first agent. Accepted (spec updated).
3. **The log's word when no `codex` ran:** as drafted. `(no binary · path)` when none was found; `(refused)` with no suffix.
4. **Diego's own check** on his dial and the ChatGPT app is after the merge.
5. **The CLI end-to-end workflow on GitHub** (Verification, check 2) needs the PM's turn when phase 4 reaches it.
