# The dial and the apps follow each other, pane by pane — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use diegodev phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With no Harness window, a prompt a person submits in the app in front turns the round dial to that agent, and a swipe that rests on an agent in an Orca terminal switches Orca to its pane without bringing Orca forward.

**Architecture:**
- The hook tells a prompt another Claude session sent from one a person typed (`relayed: true`). The core takes that one boolean on `turn-start` and forwards it. In the devices process the observed source says what each turn's start was (a person's prompt, a relayed one, or the turn of a prompt the dial delivered). The devices move the dial only for a person's prompt whose agent's app is the settled front app, through `CableSession.followApp`.
- A hand's `focus` starts one 400 ms timer per dial, in that dial's session. When it fires and the dial still shows the agent, the cable host asks the agent's source to show its pane: `orca terminal switch`, never `open -b`.
- Everything is in memory, in the devices process. No firmware, no Desktop UI, no Flutter, no new core file.

**Tech Stack:** TypeScript daemon and CLI (Node, vitest, `cli/`), the hook script (`cli/hook/notify.mjs`).

**Spec:** `docs/specs/2026-11-14-dial-pane-follow.md`.

## Layers

Every file this plan creates or changes, and the process it runs in (`cli/AGENTS.md`, master / core / services).

| File | Layer and process | Gate |
|---|---|---|
| `cli/hook/notify.mjs` | The hook: a process of its own, started by the engine | `src/hookNotify.spec.ts` |
| `cli/src/core/observedHook.ts` | **Core.** Already a line of `src/architecture.coreFiles.txt`: no new line. It takes one more bounded field and keeps nothing | 100% per file (`npm run test:core`) |
| `cli/src/cable/hosts/types.ts`, `orca.ts`, `observed.ts`, `appFilter.ts` | **Devices service process** | Their specs (`appFilter.spec.ts` keeps its file at 100%) |
| `cli/src/cable/cableHost.ts`, `cableSession.ts`, `cableFleet.ts` | **Devices service process** | Their specs |
| `cli/src/services/devices.ts` | **Devices service process** | 100% per file (`npm run test:core`) |
| `cli/e2e/dialPaneFollow.e2e.ts`, `cli/e2e/harness/inOrca.ts` (new), `cli/e2e/deviceClaudeOrca.e2e.ts` | Test: the real daemon, a fake dial, a fake `orca`, the real watch | `cli-e2e.yml` |
| `cli/e2e/harness/fakeBackend.ts`, `cli/e2e/harness/fakeDial.ts` | Test fakes: the fake backend answers speech to text, the fake dial sends audio (Task 16) | `cli-e2e.yml` |
| `cli/AGENTS.md`, `docs/specs/2026-11-13-device-claude-orca.md` | Repo files, no process | none |

The core learns nothing of the prompt and nothing of where the dial is: it lets one boolean through. `core/api.ts`, `core/devicesLink.ts` and `services/devicesProcess.ts` do not change: they already forward the event whole (`event('observed', { ...observed })`).

## Stack and external prerequisites

- **Base.** This branch is stacked on `feat/dial-app-filter`, which is on `fix/dial-swipe-order` and `feat/device-claude-orca` (#4296). That branch is still being rebased, so **the stack base is the SHA the dial-app-filter session reports**, never a branch name read at dispatch. Its head when this plan was written: `71d8c2f174`.
- **Names.** That plan (`docs/plans/2026-11-14-dial-app-filter-plan.md`) is written T2, T4, …; this plan's own tasks are Task N.
- **Landed at `71d8c2f174`:**
  - T2: `HostAgent.app`, `detectApp(hints)`, `APP_IDS`. Tasks 2 to 9 need only this, which `c41103bcb8` already held.
  - T3: `AppRings` in `select.ts`: `update(agents)`, `apps()`, `counts()`, `ring(app): { rows, total }`.
  - T4: `AppFilter` in `appFilter.ts`: `shown()`, `front(app)`, `pick(app, cause?)`, `stop()`, `FRONT_SETTLE_MS = 1_000`. Its `settledFront` is private and has no reader.
  - T8, and T23: `claude` is the 15th app id (bundle `com.anthropic.claudefordesktop`) in `detectHost` and `detectApp`.
- **The settled front's reader is this branch's.** `AppFilter.settledApp()` would be dead code on that branch, so Task 11 adds it to `appFilter.ts` with the code that calls it. T4 at `5e80d489a4` is the base for that file.
- **Not landed, needed by Tasks 11 to 13** (Task 10 waits for them):
  - T5: `DaemonCableHost` owns the filter and the rings; `front(app: string): void`; `listAgentSnapshot(opts?: { apps?: boolean })`, which answers the shown app's ring (`AppRings.ring(shown)`) asked with `apps: true`, and the single `DialRing` asked without.
  - T6: the session's `appFilter` flag, and its list read `listAgentSnapshot({ apps: this.appFilter })`.
  - T9: `DevicesPort.front(app: string): boolean` (it needs T5 and T7).
- **Not landed, needed by Tasks 15 and 16** (Task 14 waits for them): T10 (`dial_front` on the local socket), T11 (`frontAppId`, with the `claude` row), T12 (`harness hardware watch --json` reads `{"front":"…"}` on stdin and sends `dial_front`).
- **Not landed, needed only by the on-dial check** (Verification, check 2): T13 and T14, the Harness Device app writing the app in front on macOS. No task here waits for them.
- **Files both branches write.** `cableHost.ts` (`CableHostWiring`, the class), `cableSession.ts` (`interface CableHost`), `services/devices.ts` (the `new DaemonCableHost({ … })` literal, `port`). Each task below says where its lines go, so a rebase keeps both sides.

## Global Constraints

- **The app moves the dial** only on a `turn-start` that is not `relayed`, is not the turn of a prompt the dial delivered, and whose `agent.app` equals the settled front app. No front known: no move. No tile for the agent in the dial's list: no move. An agent the dial already shows: nothing is sent.
- **The front, not the shown app.** The condition reads the settled front (`settledApp()`), never `shown()`: the person may have picked another app on the dial. Whether the agent has a tile is asked of the ring that dial walks: the shown app's for a dial that says `appFilter`, the single ring for one that does not.
- **The move** goes through `CableSession.followApp` with the local machine: its queue, its list-before-focus order and its echo guard.
- **`relayed`** is set by the hook when `UserPromptSubmit`'s `prompt` starts with `<cross-session-message ` after leading whitespace. The prompt is never sent. The core takes an optional boolean `relayed` on `turn-start` only.
- **A pending dial prompt** is recorded per session when the dial's words reach an outside agent (the mod's inbox `'taken'`, or Orca's `terminal send`), is consumed by that session's next `turn-start`, and expires after 10 minutes.
- **A swipe.** 400 ms after the last turn of the dial, one timer per dial. Then `orca terminal switch --terminal <handle> --json` through `cli/src/cable/hosts/orca.ts`: `execFile`, no shell, 10 s timeout, one command per handle. A switch that meets a running command is dropped, not queued. Never `open -b`. A failure logs one line and shows nothing on the dial.
- **A tap** (`agent.open`) keeps #4296's behavior: switch, then Orca comes forward. Every other host: a swipe only marks seen.
- **The Claude app** is the app `claude` by T23's mapping, which has landed. This plan adds no mapping.
- **Measures** are daemon log lines with no content and no identifier: `[device] prompt · moved`, `[device] prompt · skipped · relayed | dial prompt | not in front | no tile`, `[device] swipe · ok | failed | busy | superseded`.
- **Memory only.** Nothing is written to disk. No polling: no timer but the 400 ms rest.
- **Platforms** (decision 3). macOS is tested, on a dial too. Linux X11, where `feat/dial-app-filter` also reports the app in front (its T15): the same code follows prompts and switches Orca, with no platform switch; it runs the unit and end-to-end tests and is untested on a dial, and the pull request says "Linux X11 untested". Where no front is reported (Wayland), the dial does not move. Windows has no agents outside a pane.
- **Speech to text** (decision 5) runs only on production: there is no staging account. So nobody speaks to a dial for this branch, and no test or check asks a real backend for a transcript. "A prompt the dial delivered does not move the dial" is covered end to end with a fake speech to text (Task 16).
- **Repo rules.** Tests never touch the developer's real `~/.claude`, daemon (port 18473), tmux, Orca or dial. No fixed sleeps: fake timers, or a wait on a condition.

## Review Focus

1. **A dial prompt's turn that starts before `orca terminal send` returns.** `--wait-submit` returns after the prompt is submitted, and the session's hook can reach the devices first. The turn must still be the dial's, and the next typed prompt must still move the dial. Task 4 (`the turn that starts while orca terminal send still runs is the dial's`).
2. **The dial moves by itself while a rest is pending** (a prompt's move, a tapped notice). The switch must not run for an agent the dial left. Task 6 (`the dial moved by the app before 400 ms: superseded`).
3. **A dial whose list lacks the agent while its app is in front:** a pick on the dial holds another app, a Harness window is open, or a second dial has another ring. That dial stays, and its record of where it is does not change. Task 12 (`an agent this dial's list lacks`), Task 13 (`the dial's answer is counted`).
4. **The Orca terminal changed or ended between the turn and the rest.** The switch uses the handle of the session's latest event, and an ended session runs nothing. Task 5 (`the handle is the latest event's`).
5. **The cable pulled, or the daemon stopping, with a rest pending.** No timer is left and nothing runs. Task 6 (`the link dropping, or stop, ends a pending rest`).

---

### Task 1: Stack the branch on the base

**Layer:** none. **Depends on:** the base SHA the dial-app-filter session reports (external; at least `c41103bcb8`). **Effort:** `medium`. **Red test:** none: no behavior (workflow).

**Files:** none of its own.

- [ ] **Step 1:** Ask the main session for the base SHA. Confirm it holds T2: `git grep -n "export function detectApp" <sha> -- cli/src/cable/hosts/hostDetect.ts`. If it does not, stop and report.
- [ ] **Step 2:** `git rebase <sha>` on `feat/dial-pane-follow`.
- [ ] **Step 3:** `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts src/core/observedHook.spec.ts src/hookNotify.spec.ts`. Expected: PASS, as on the base.

### Task 2: The hook says a prompt came from another session

**Layer:** the hook. **Depends on:** Task 1. **Effort:** `high`.

**Files:**
- Modify: `cli/hook/notify.mjs` (`observedBody`, beside `observedEvent`)
- Test: `cli/src/hookNotify.spec.ts` (`describe('hook notify: a session outside a pane')`)

**Interfaces:**
- Produces: the body posted to `/api/hook/observed` carries `relayed: true` when the event's name, as `observedEvent` resolves it, is `UserPromptSubmit`, `input.prompt` is a string, and `/^\s*<cross-session-message /` matches it. Otherwise the body has no `relayed` key. Nothing else of the prompt is read or sent. `relayed` is never among the fields dropped to fit 4096 bytes.

- [ ] **Step 1: Write the failing tests:**
  - `a prompt another session sent posts turn-start with relayed: true, and never the prompt`: prompt `<cross-session-message from="a1">prompt-secret</cross-session-message>`; the body matches `{ event: 'turn-start', relayed: true }`; its JSON matches neither `cross-session` nor `prompt-secret`.
  - `leading whitespace before it is still relayed` (`'\n \t<cross-session-message from="a1">x'`).
  - `a typed prompt posts no relayed`: `'hi'`; `'see <cross-session-message from="a1">'`; `'<cross-session-messages>'`; a prompt that is an object; no prompt. Each body has no `relayed` property.
  - `only UserPromptSubmit says it`: Cursor's `beforeSubmitPrompt`, Copilot's `userPromptSubmitted` and Claude Code's `Stop`, each with such a `prompt`: no `relayed`.
  - `a relayed body with every field at its bound keeps relayed and is under 4096 bytes` (the hints, paths and session id of `the largest body the hook can build`).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/hookNotify.spec.ts`. Expected: FAIL (`relayed` is undefined).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `hook: a prompt another session sent is told apart, and still never sent`.

### Task 3: Core: `relayed` on `turn-start`

**Layer:** core. **Depends on:** Task 1. **Effort:** `xhigh` (the core's trust boundary).

**Files:**
- Modify: `cli/src/core/observedHook.ts` (`ObservedHookEvent`, `parseObservedHook`)
- Test: `cli/src/core/observedHook.spec.ts`

**Interfaces:**
- Produces: `ObservedHookEvent.relayed?: boolean`.
- Rule, checked before the `asked` branch: a body whose `relayed` is defined is refused (`null`) unless its `event` is `turn-start` and `relayed` is a boolean. A taken one is forwarded as it came; a body without it gets no key.

- [ ] **Step 1: Write the failing tests:**
  - `takes relayed true and false on turn-start, and hands it on` (`parseObservedHook` equals the body; `onObserved` forwards it with `relayed`).
  - `a turn-start without relayed has no such key` (`toStrictEqual`).
  - `rejects a relayed that is not a boolean`: `'true'`, `1`, `0`, `null`, `{}`, `[]`.
  - `rejects relayed on any other event`: `session-start`, `needs-input`, `turn-stop`, `turn-error`, `session-end` and `asked`, each with `relayed: true` and with `relayed: false`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/core/observedHook.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run test:core && npx vitest run src/architecture.spec.ts && npm run typecheck`. Expected: PASS, 100% for `core/observedHook.ts`, the core's file list unchanged.
- [ ] **Step 5: Commit** `core: a paneless turn-start may say it was relayed, one boolean and nothing else`.

### Task 4: The observed source says what a turn's start was

**Layer:** devices service process. **Depends on:** Task 3 (the event's type). **Effort:** `xhigh` (a record racing the turn it stands for).

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts` (`Entry`, `send`, `ingest`)
- Test: `cli/src/cable/hosts/observed.spec.ts`

**Interfaces:**
- Consumes: `ObservedHookEvent.relayed` (Task 3).
- Produces:
  - `export type PromptSource = 'person' | 'relayed' | 'dial'`
  - `const DIAL_PROMPT_TTL_MS = 600_000`, in the module alone: the spec pins the 10 minutes it names.
  - `ObservedSource.ingest(e: ObservedEvent): PromptSource | undefined` (was `void`; `services/devices.ts` compiles unchanged).
- Rules:
  - A source is answered only for a `turn-start` of a session the source lists once the event is taken. Every other event, and a session it does not list (Harness's own folder, the 51st session), answers `undefined`.
  - **Open question 1, provisional:** a `turn-start` of engine `agy` or `commandcode` answers `undefined`. Theirs is a model call or a tool call, not a prompt (`hook/notify.mjs`, `observedEvent`).
  - `e.relayed === true` answers `'relayed'` and uses up no record (**open question 2, provisional**).
  - Otherwise records older than the limit are dropped (`now - at >= DIAL_PROMPT_TTL_MS`). If one is left, the oldest is removed and the answer is `'dial'`. Else `'person'`.
  - The records live on the session's `Entry`: at most 8, the oldest dropped for a 9th, gone with the entry.
  - `send`: the mod's route records one when `toMod` answers `'taken'`. Orca's route records one **before** `actions.orcaSend` runs and takes that same record back, if it is still there, when the send answers false. A refusal (`too-long`, `no-answer`, `pending`, `waiting`, `busy`) records nothing.

- [ ] **Step 1: Write the failing tests** (the spec's `setup` and `fakeActions`, a scripted `now`):
  - `a turn's start says what it was`: a typed prompt is `'person'`; `relayed: true` is `'relayed'`; `relayed: false` is `'person'`; `session-start`, `turn-stop`, `needs-input`, `session-end` and `asked` are `undefined`; a session in an excluded folder is `undefined`.
  - `Command Code's and agy's turn-start say nothing` (open question 1).
  - `the turn after the mod took the dial's words is the dial's, and the one after is the person's`.
  - `the turn after orca terminal send is the dial's, and the one after is the person's`.
  - `the turn that starts while orca terminal send still runs is the dial's` (an `orcaSend` that resolves after the `turn-start` is ingested), and the next is `'person'`.
  - `a send Orca refuses leaves no record` (`orcaSend` false: the next turn is `'person'`); `a refused or missed delivery records nothing` (`'busy'` and `'missed'` from the mod, a working agent, a waiting one).
  - `two prompts the mod took: the next two turns are the dial's, the third the person's`.
  - `a dial prompt expires after 10 minutes`: at `599_999` ms the turn is `'dial'`; recorded again, at `600_000` ms it is `'person'`.
  - `a relayed turn does not use up the dial's prompt` (open question 2): taken, then a relayed `turn-start`, then a plain one: `'relayed'`, `'dial'`.
  - `at most 8 are kept for a session`: 9 taken, then 9 turns: eight `'dial'`, then `'person'`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts`. Expected: FAIL (`ingest` answers `undefined`).
- [ ] **Step 3: Implement.** The comment on the Orca route says why the record comes before the command.
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: each turn's start is a person's prompt, a relayed one or the dial's own`.

### Task 5: Orca shows a pane, and says when it is busy

**Layer:** devices service process. **Depends on:** Task 1. **Effort:** `high`.

**Files:**
- Modify: `cli/src/cable/hosts/types.ts`, `cli/src/cable/hosts/orca.ts`, `cli/src/cable/hosts/observed.ts` (`ObservedActions`, two methods beside `focus`), `cli/src/services/devices.ts` (two lines: `opener`, and the observed actions literal)
- Test: `cli/src/cable/hosts/orca.spec.ts`, `cli/src/cable/hosts/observed.spec.ts`

**Interfaces:**
- Produces, in `types.ts`:
  - `export type PaneSwitch = 'ok' | 'failed' | 'busy'`
  - On `HostSource`: `hasPane?(agent: HostAgent): boolean` and `showPane?(agent: HostAgent): Promise<PaneSwitch>`.
- Produces, in `orca.ts`: `switchTo(handle: string): Promise<PaneSwitch>` (was `Promise<boolean>`). `'busy'` when words are being typed into that terminal: nothing runs and nothing is queued. A switch that meets one under way for the same terminal is that run, with its outcome, and words for it wait for the switch to end. `'ok'` when the switch exits 0. `'failed'` otherwise: a handle that is not `term_<uuid>`, no `orca`, a non-zero exit, the 10 s timeout. The command line is unchanged.
- Produces, in `observed.ts`:
  - `ObservedActions.orcaSwitch(handle: string): Promise<PaneSwitch>`
  - `ObservedSource.hasPane(agent)`: true when the source has actions, the session is live, and its latest event carried an Orca handle.
  - `ObservedSource.showPane(agent)`: `actions.orcaSwitch` with the handle of the session's **latest** event. `'failed'`, with nothing run, for an agent that is gone, ended or has no handle now. It never calls `actions.open`.
- `services/devices.ts`: `orcaSwitch: orca.switchTo` in the observed actions. The tap's opener keeps its boolean: `orcaSwitch: (handle) => orca.switchTo(handle).then((done) => done === 'ok')`.

- [ ] **Step 1: Write the failing tests:**
  - `orca.spec.ts`: `switchTo answers ok when the switch exits 0 and failed when it does not` (the existing `switchTo runs the switch alone` case, with its argv); `a handle that is not term_<uuid>` and `no orca on PATH` answer `'failed'`; `a switch for a handle whose command still runs is busy and runs nothing` (while a `send` runs, and while a `switchTo` runs: `calls` holds one entry); `another handle's switch runs`.
  - `observed.spec.ts`:
    - `hasPane: an agent in an Orca terminal, while its session lives`; false in WezTerm, herdr and the Claude app, false once its session ended, false with no actions.
    - `showPane switches Orca to the terminal and answers what Orca said` (`'ok'`, `'failed'`, `'busy'` passed through; `actions.open` never called).
    - `the handle is the latest event's`: a session resumed in another Orca terminal switches to the new handle; one whose next event carries no handle, and one that ended, answer `'failed'` and call no `orcaSwitch`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/orca.spec.ts src/cable/hosts/observed.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** List the other `ObservedActions` literals with `git grep -n "orcaSend" cli/src cli/e2e` and give each `orcaSwitch`.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable/hosts/open.spec.ts src/services/devices.spec.ts && npm run test:core && npm run typecheck`. Expected: PASS: a tap still switches, and `services/devices.ts` stays at 100%.
- [ ] **Step 5: Commit** `devices: Orca's switch says ok, failed or busy, and a source can show an agent's pane`.

### Task 6: The dial's session: a rest, 400 ms after the last turn

**Layer:** devices service process. **Depends on:** Task 1. **Effort:** `xhigh` (a timer racing the echo guards, a move and the link).

**Files:**
- Modify: `cli/src/cable/cableSession.ts` (`interface CableHost` beside `markSeen?`, `case 'focus'`, the two places that reset `expectedAppFocusEcho`, `stop()`)
- Test: `cli/src/cable/cableSession.spec.ts` (`describe('what the dial cannot do for an agent')`)

**Interfaces:**
- Produces:
  - `export const SWIPE_REST_MS = 400`
  - `CableHost.swipeSwitches?(agentId: string): boolean`: whether a rest of the dial on that agent switches its app's pane.
  - `CableHost.swipeEnded?(agentId: string, how: 'rest' | 'superseded'): void`: how a hand's turn to such an agent ended.
- Rules, for a `focus` that passed both guards (after the record is written, beside `markSeen` / `host.focus`, which stay as they are):
  - A pending rest for **another** agent is cancelled and told `swipeEnded(thatAgent, 'superseded')`. A pending rest for the same agent is cancelled and told nothing.
  - If `swipeSwitches?.(agentId)` is true, one unref'd timer of `SWIPE_REST_MS` is started. A session holds at most one.
  - When it fires: `swipeEnded(agentId, 'rest')` if `desiredFocus` is still that agent, else `swipeEnded(agentId, 'superseded')`.
  - A new port, the link gone and `stop()` cancel a pending rest and tell nothing.
  - A host that throws from `swipeEnded` in the timer is this dial's fault (`fault`), never an uncaught error.

- [ ] **Step 1: Write the failing tests** (fake `setTimeout` and `clearTimeout`; a host whose `swipeSwitches` is true for `a1` and `a3`):
  - `a hand's turn to an agent with a pane rests after 400 ms, once`: nothing at 399 ms; `swipeEnded('a1', 'rest')` at 400 ms, called once; `markSeen` was called at the turn, as before.
  - `three turns within 400 ms: one rest, for the last agent` (`a1`, `a3`, `a1`: `superseded` for `a1` then `a3`, one `rest` for `a1`).
  - `a turn away before 400 ms runs no rest for the first` (`a1`, then `a2`, which has no pane: `swipeEnded('a1', 'superseded')` only, and no timer is left).
  - `a second turn to the same agent restarts the rest and supersedes nothing`.
  - `an agent with no pane starts no timer`; `a host without swipeSwitches behaves as today`.
  - `a focus the echo guard drops starts nothing` (after `session.followApp('', 'a1')`, the dial's own `focus a1`: `swipeSwitches` is not called).
  - `the dial moved by the app before 400 ms: superseded` (a turn to `a1`, then `followApp('', 'a2')` and its echo, then 400 ms).
  - `the link dropping, or stop, ends a pending rest`: nothing is told and `vi.getTimerCount()` is 0.
  - `a host that throws at the rest is the dial's fault` (`onFault` hears it).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: a turn that rests 400 ms is told to the host, once per dial`.

### Task 7: The cable host and the devices: a rest switches Orca's pane, and is counted

**Layer:** devices service process. **Depends on:** Task 5. **Effort:** `high`.

**Files:**
- Modify: `cli/src/cable/cableHost.ts` (`CableHostWiring` beside `focused?`; two methods beside `focus`, and its comment), `cli/src/services/devices.ts` (the `new DaemonCableHost({ … })` literal, beside `focused`)
- Test: `cli/src/cable/cableHost.spec.ts` (`describe('an agent outside Harness takes its voice, its answer and its tap from its own source')`), `cli/src/services/devices.spec.ts` (`describe("the mod's voice and Orca, …")`)

**Interfaces:**
- Consumes: `HostSource.hasPane`, `showPane`, `PaneSwitch` (Task 5). It implements Task 6's two `CableHost` members by name.
- Produces:
  - `CableHostWiring.swiped?: (outcome: PaneSwitch | 'superseded') => void`
  - `DaemonCableHost.swipeSwitches(agentId: string): boolean`: true for an agent outside Harness (`outsideEntry`) whose source's `hasPane` says so.
  - `DaemonCableHost.swipeEnded(agentId: string, how: 'rest' | 'superseded'): void`. `'superseded'` tells `swiped('superseded')` and runs nothing. `'rest'` runs the source's `showPane` and tells `swiped` its answer; an agent gone by then, a source without `showPane` and a `showPane` that rejects tell `'failed'`.
  - `services/devices.ts`: `swiped` writes one line for each outcome, `[device] swipe · <outcome>`.
- `focus()` is unchanged: it marks seen at once. Its comment now says a swipe switches Orca's pane after the rest and never brings an app forward.

- [ ] **Step 1: Write the failing tests:**
  - `cableHost.spec.ts`:
    - Replace `a swipe to an Orca agent marks it seen and never opens Orca` with `a swipe to an Orca agent marks it seen at once and brings nothing forward`: `host.focus('o1')` calls `markSeen`, and neither `source.focus` nor `source.showPane`.
    - `swipeSwitches is true only for an outside agent whose source has a pane for it` (false for `hasPane` false, a source without it, a Harness agent, an unknown id).
    - `a rest shows the pane through source.showPane, never source.focus, and tells what came of it` (`'ok'`, `'failed'`, `'busy'`).
    - `superseded tells superseded and runs nothing`; `a rest on an agent that has gone, and a showPane that rejects, tell failed`.
    - `nothing of a swipe reaches the fleet or the core's doors` (`heard()` holds no `o1`).
  - `devices.spec.ts` (the agent of `an agent with an Orca handle lists v and f`; a rest is `host().swipeEnded(id, 'rest')`):
    - `a rest on an Orca agent runs orca terminal switch once and no open -b, on macOS too` (`orcaRuns` is the one `['terminal', 'switch', '--terminal', HANDLE, '--json']` run; `said()` is `['[device] swipe · ok']`).
    - `a switch that fails is one line with no handle, and the dial is sent nothing` (`[device] swipe · failed`; `seen.cable.calls` gains nothing).
    - `a rest while a command runs on that terminal is dropped: busy`; `a superseded rest is counted and runs nothing`.
    - `an agent in the Claude app or WezTerm: a rest runs nothing` (`swipeSwitches` is false).
    - `a tap still switches and, on macOS, brings Orca forward` (`orcaRuns` is the switch, then `['/usr/bin/open', ['-b', 'com.stablyai.orca'], 10_000]`).
    - `no swipe line carries a handle, a session or an agent`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableHost.spec.ts src/services/devices.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`.
- [ ] **Step 5: Commit** `dial: a swipe that rests on an Orca agent switches Orca's pane, and never brings it forward`.

### Task 8: End to end: a swipe and the fake `orca`

**Layer:** test. **Depends on:** Tasks 6, 7. **Effort:** `high`. **Red test:** none: no behavior (it adds end-to-end tests of what Tasks 5 to 7 built, and moves a test helper).

**Files:**
- Create: `cli/e2e/dialPaneFollow.e2e.ts`, `cli/e2e/harness/inOrca.ts`
- Modify: `cli/e2e/deviceClaudeOrca.e2e.ts` (its `InOrca` class and `IN_ORCA` move to `harness/inOrca.ts`, which exports them; it imports them)

**Interfaces:**
- Consumes: `IsolatedDaemon`, `until`, `Desk`, `FakeDial` (`e2e/harness/`), as `deviceClaudeOrca.e2e.ts` uses them.
- Produces, in `harness/inOrca.ts`: `InOrca`, whose constructor takes a fourth argument, the session's extra hints (`ORCA_TERMINAL_HANDLE`, `__CFBundleIdentifier`, `WEZTERM_PANE`, `CLAUDE_CODE_HOST_SESSION_ID`).
- The fake `orca`: a script in the daemon's own `bin` folder (first on its `PATH`, `e2e/harness/daemon.ts`), written before `d.start()`. Each run records its arguments in a file of its own under the daemon's root, and exits with the code a test wrote (0 by default). The real `orca` and the real Orca app are never run: the swipe path has no `open`, and no test here taps.
- Each case lists its sessions and acts at once, as `deviceClaudeOrca.e2e.ts` does: the observed source checks a session's process every 30 s, and `InOrca`'s process is whatever the hook's shell leaves as its parent.

- [ ] **Step 1: Write the tests** (no window; a daemon of its own for each case; two sessions in Orca terminals, `A` and `B`, each with its own `term_<uuid>` handle; one session `W` with `WEZTERM_PANE` and no handle):
  - `the dial's turn to an agent in an Orca terminal runs the fake switch once, 400 ms after`: the dial sends `{ t: 'focus', agentId: A.id }`; wait for the log's `[device] swipe · ok`; one recorded run, `terminal switch --terminal <A's handle> --json`; its file's `mtimeMs` is no less than 395 ms after the `Date.now()` read before the send (the exact 400 is Task 6's, on a fake clock).
  - `a turn to an agent outside Orca runs nothing`: `focus W`, then `focus B`; wait for B's run; it is the only run recorded.
  - `a switch the fake orca refuses is one log line, and the dial is sent no toast`: exit code 1; `focus A`; wait for `[device] swipe · failed`; no `toast` since.
  - `the daemon's log has no handle and no session id`.
- [ ] **Step 2: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialPaneFollow.e2e.ts e2e/deviceClaudeOrca.e2e.ts`. Expected: PASS.
- [ ] **Step 3: Commit** `e2e: a swipe on the dial switches the fake Orca's pane`.

### Task 9: Say it in the docs

**Layer:** repo files. **Depends on:** Task 1. **Effort:** `medium`. **Red test:** none: no behavior.

**Files:**
- Modify: `cli/AGENTS.md` (the devices row of the processes table: the dial follows a person's prompt in the app in front, and a swipe switches Orca's pane), `docs/specs/2026-11-13-device-claude-orca.md` (the "Open (`f`)" bullet: a swipe that rests switches the pane too, without bringing Orca forward, with a link to this spec)

- [ ] **Step 1:** Write the two changes, in the files' own words and length.
- [ ] **Step 2:** Check every link resolves.
- [ ] **Step 3: Commit** `docs: the dial follows a prompt, and a swipe switches Orca's pane`.

### Task 10: Restack: the base holds the settled front

**Layer:** none. **Depends on:** Tasks 2 to 9 (a rebase moves the base under a task in flight); T5, T6 and T9 on the base, at a SHA the dial-app-filter session reports (external). **Effort:** `medium`. **Red test:** none: no behavior (workflow).

**Files:** none of its own.

- [ ] **Step 1:** Ask the main session for the SHA. Confirm it holds them: `git grep -n "front(" <sha> -- cli/src/cable/cableHost.ts cli/src/core/api.ts`; `git grep -n "appFilter" <sha> -- cli/src/cable/cableSession.ts`. If one is missing, stop and report.
- [ ] **Step 2:** `git rebase <sha>`. On a conflict in a file both branches write, keep both sides.
- [ ] **Step 3:** Read the merged `appFilter.ts`, `cableHost.ts` and `cableSession.ts`. Report every name that differs from "Stack and external prerequisites", so the main session can correct Tasks 11 to 13 before they are dispatched.
- [ ] **Step 4:** `cd cli && npm run typecheck && npm run test:core && npx vitest run src/cable src/hookNotify.spec.ts`. Expected: PASS.

### Task 11: The cable host: the settled front, and what became of a prompt

**Layer:** devices service process. **Depends on:** Task 10 (T5: the host owns the filter, so the reader has its caller in this task). **Effort:** `medium` (two readers and a pass-through).

**Files:**
- Modify: `cli/src/cable/hosts/appFilter.ts`, `cli/src/cable/cableHost.ts` (`CableHostWiring` beside `swiped?`; beside `front`; `knows`)
- Test: `cli/src/cable/hosts/appFilter.spec.ts`, `cli/src/cable/cableHost.spec.ts`

**Interfaces:**
- Consumes: `AppFilter`'s private `settledFront` (T4, as at `5e80d489a4`); the host's filter and `front(app)` (T5).
- Produces:
  - `AppFilter.settledApp(): string | undefined { return this.settledFront }`. What it reads, as T4 leaves it: `settledFront` changes only in `settle(app)`, once an app has stayed in front for `FRONT_SETTLE_MS`; it can be `none` or an app with no agents; it is `undefined` until the first front settles; `stop()` does not clear it.
  - `DaemonCableHost.settledApp(): string | undefined`: the filter's, with or without a window. It is not `shown()`: a pick on the dial changes the shown app and leaves this as it is.
  - `CableHostWiring.promptFollowed?: (outcome: 'moved' | 'no-tile') => void`, and `DaemonCableHost.promptFollowed(outcome)`, which hands it on.
  - `DaemonCableHost.knows(agentId)` is also true for an agent outside Harness that the registry holds. It is read only for `followApp`'s log line, which would otherwise say the dial has no tile for it.

- [ ] **Step 1: Write the failing tests:**
  - `appFilter.spec.ts`, one test with the spec's fake `after`: `settledApp is the app that has stayed in front for 1 s`. `undefined` at first; `front('orca')` and less than `FRONT_SETTLE_MS`: still `undefined`; at `FRONT_SETTLE_MS`: `orca`; `front('ghostty')` then `front('vscode')` inside a second, settled: `vscode`, never `ghostty`; `front('none')` settled: `none`; an app with no agents settled: that app; after `stop()`: unchanged. The file stays at 100%.
  - `cableHost.spec.ts`:
    - `settledApp is undefined until an app settles in front, then that app` (a scripted `appTimer`).
    - `a pick on the dial changes the shown app and not the settled one` (Orca settled in front, VS Code picked: `settledApp()` is `orca`, `apps.shown` is `vscode`).
    - `settledApp follows the app in front with a window open too`.
    - `promptFollowed reaches the wiring`; `knows an agent outside Harness`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/appFilter.spec.ts src/cable/cableHost.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: the host says which app settled in front, and hears what became of a prompt`.

### Task 12: The dial's session and the fleet: follow a prompt

**Layer:** devices service process. **Depends on:** Task 6 (its echo test runs the rest's handler), Task 10 (T6's list read). **Effort:** `xhigh` (it shares `followApp`'s queue, record and echo guard).

**Files:**
- Modify: `cli/src/cable/cableSession.ts` (`interface CableHost`; a method beside `followApp`; `syncAgentsNow`'s list read), `cli/src/cable/cableFleet.ts` (one line beside `followApp`)
- Test: `cli/src/cable/cableSession.spec.ts`, `cli/src/cable/cableFleet.spec.ts`

**Interfaces:**
- Consumes: `followApp`, `desiredFocus`, `appFocusUnsent`; the list read `listAgentSnapshot({ apps: this.appFilter })` (T6).
- Produces:
  - `CableHost.promptFollowed?(outcome: 'moved' | 'no-tile'): void`
  - `CableSession.followPrompt(agentId: string): Promise<void>`
  - `CableFleet.followPrompt(agentId: string)`: every attached dial's, as `followApp` is.
- Rules of `followPrompt`, in this order:
  1. Not linked, or not greeted: nothing.
  2. The dial already shows the agent (`agentId === desiredFocus` and nothing unsent): nothing is sent, counted or read. A stuck engine repeating its event costs no list read.
  3. It reads the list this dial would be sent, by the one read `syncAgentsNow` makes (one private helper, used by both). That is the ring this dial walks: the shown app's for a dial that says `appFilter`, the single ring for one that does not, the tab's with a window.
  4. The list lacks the agent: `promptFollowed('no-tile')`. No frame goes out and `desiredFocus` is not written.
  5. Else `promptFollowed('moved')`, then `followApp(this.host.localMachine().id, agentId)`.

- [ ] **Step 1: Write the failing tests:**
  - `followPrompt moves the dial through followApp: the list first, then the focus` (one `{ t: 'focus', agentId: 'a2' }`; `selectMachine` is not asked for another machine; `promptFollowed('moved')` once).
  - `the move's echo starts no Orca switch`: the dial's own `focus a2` reaches neither `host.focus`, `markSeen` nor `swipeSwitches`.
  - `an agent this dial's list lacks: nothing is sent and the dial's place is kept` (`promptFollowed('no-tile')`; the next `syncAgents` re-asserts the old agent).
  - `an agent the dial already shows: nothing is sent or counted, and the list is not read`.
  - `not linked: nothing`.
  - `a dial that says appFilter is asked for its own list` (the fake host records `{ apps: true }`); `one that does not is asked for the single ring`.
  - `two prompts in a row: the later one wins` (`followApp`'s queue).
  - `cableFleet.spec.ts`: `followPrompt reaches each attached dial`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts src/cable/cableFleet.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: a prompt's move goes through followApp, for a dial whose list holds the agent`.

### Task 13: The devices: a person's prompt moves the dial

**Layer:** devices service process. **Depends on:** Tasks 4, 11, 12. **Effort:** `xhigh` (what the log may say; `services/devices.ts` is in the 100% gate).

**Files:**
- Modify: `cli/src/services/devices.ts` (`port.observed`; the `new DaemonCableHost({ … })` literal, beside `swiped`)
- Test: `cli/src/services/devices.spec.ts` (its `FakeCable` gains `followPrompt = recorder('followPrompt')`)

**Interfaces:**
- Consumes: `ObservedSource.ingest`'s `PromptSource` (Task 4); `DaemonCableHost.settledApp()`, `CableHostWiring.promptFollowed` (Task 11); `CableFleet.followPrompt` (Task 12); `DevicesPort.front` (T9), to settle a front in the tests.
- Produces, in `port.observed`, for an event whose `ingest` answered a source, inside `part.call('dial', …)`:
  1. No dial linked (`!cable.isConnected`): nothing more. The dial prompt was already used up by `ingest`.
  2. `'relayed'`: the line `[device] prompt · skipped · relayed`.
  3. `'dial'`: `[device] prompt · skipped · dial prompt`.
  4. `'person'`: when `cableHost.settledApp()` is undefined, or differs from the agent's `app`: `[device] prompt · skipped · not in front`. Else `cable.followPrompt(agentId)`. The shown app is never read here: a dial that shows another app answers `no-tile` itself (Task 12).
- Produces: `promptFollowed: (outcome) => log(outcome === 'moved' ? '[device] prompt · moved' : '[device] prompt · skipped · no tile')`.

- [ ] **Step 1: Write the failing tests** (a dial attached, no window; the front settled with `port.front(app)` and 1 s of fake time; agents from `port.observed(hook(…))`):
  - `a person's prompt with its app in front asks the dials to follow it` (`seen.cable.calls` holds `['followPrompt', [ID]]`).
  - `a relayed prompt asks nothing and is counted`.
  - `the turn of a prompt the dial delivered asks nothing, by the mod and by Orca, and the next prompt asks again`.
  - `another app in front, none in front, and no front known ask nothing: not in front` (`port.front('ghostty')`; `port.front('none')`; no `front` at all).
  - `a front that has not stayed 1 s is not yet in front`.
  - `a pick on the dial does not change which app is in front`: Orca settled in front, an agent in Ghostty too, Ghostty picked on the dial (`host().pickApp('ghostty')`): a prompt in Orca still asks the dials to follow it.
  - `a prompt in the Claude app, with the Claude app in front, asks the dials to follow it` (hints `{ __CFBundleIdentifier: 'com.anthropic.claudefordesktop' }`, so its app is `claude` by T23; `port.front('claude')`).
  - `the dial's answer is counted: moved, and no tile` (`seen.host.promptFollowed!('moved')` and `('no-tile')`).
  - `with no dial linked nothing is asked or counted, and the dial's prompt is still used up`.
  - `with the observed source switched off nothing is asked`.
  - `no prompt line names an app, an agent or a session`: every `[device] prompt` line is exactly one of the five; no log line holds the agent's id, `sess-1` or the handle.
  - `a follow that throws is logged and the devices keep running`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`.
- [ ] **Step 5: Commit** `devices: a prompt a person submits in the app in front turns the dial to its agent`.

### Task 14: Restack: the base holds the front's route

**Layer:** none. **Depends on:** Tasks 11, 12, 13 (no task in flight); T10, T11 and T12 on the base, at a SHA the dial-app-filter session reports (external). **Effort:** `medium`. **Red test:** none: no behavior (workflow).

**Files:** none of its own.

- [ ] **Step 1:** Ask the main session for the SHA. Confirm it holds them: `git grep -n "claudefordesktop" <sha> -- cli/src/cable/hosts/frontApp.ts`; `git grep -n "dial_front" <sha> -- cli/src/localWsServer.ts cli/src/devices/client.ts`. If one is missing, stop and report. If Task 10's base already held them, this task only checks.
- [ ] **Step 2:** `git rebase <sha>`.
- [ ] **Step 3:** `cd cli && npm run typecheck && npm run test:core && npx vitest run src/cable src/devices/client.spec.ts src/hookNotify.spec.ts`. Expected: PASS.

### Task 15: End to end: a prompt moves the dial

**Layer:** test. **Depends on:** Tasks 2, 3, 8, 13, 14. **Effort:** `high`. **Red test:** none: no behavior (it adds end-to-end tests of what Tasks 2 to 4 and 11 to 13 built).

**Files:**
- Modify: `cli/e2e/dialPaneFollow.e2e.ts`

**Interfaces:**
- Consumes: Task 8's file, `InOrca` and fake `orca`; the way `e2e/hardwareWatch.e2e.ts` starts `harness hardware watch --json` with a stdin pipe. The fake front app is a line written on that pipe, `{"front":"<bundle id>"}` (T12).
- The front settles 1 s after the line, with no frame to wait on. Each "moves" case therefore sends its prompt inside `until(…)`, again every 500 ms, until the dial hears the `focus`: a prompt before the settle is skipped, and one after a move is already shown.

- [ ] **Step 1: Write the tests** (no window; `A` and `B` in Orca terminals with `__CFBundleIdentifier: 'com.stablyai.orca'`; `C` with `__CFBundleIdentifier: 'com.anthropic.claudefordesktop'`; the dial turned to `A` by hand first):
  - `a prompt typed in Orca, with Orca in front, moves the dial to its agent`: the watch is written `{"front":"com.stablyai.orca"}`; `B`'s `UserPromptSubmit` hook with `prompt: 'run the tests'`; the dial hears `{ t: 'focus', agentId: B.id }`; the log has `[device] prompt · moved`.
  - `a message from another session does not move it`: `A`'s hook with `prompt: '<cross-session-message from="b">hi</cross-session-message>'`; wait for `[device] prompt · skipped · relayed`; the dial heard no `focus` for `A` since.
  - `a prompt in the Claude app, with the Claude app in front, moves the dial`: the watch is written `{"front":"com.anthropic.claudefordesktop"}`; `C`'s prompt; the dial hears `focus` for `C`.
  - `the daemon's log has no bundle id, no session id, no handle and no word of a prompt`.
- [ ] **Step 2: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialPaneFollow.e2e.ts e2e/deviceClaudeOrca.e2e.ts e2e/hardwareWatch.e2e.ts`. Expected: PASS.
- [ ] **Step 3: Commit** `e2e: a prompt in the app in front moves the dial, and a relayed one does not`.

### Task 16: End to end: the turn of a prompt the dial spoke, with a fake speech to text

**Layer:** test. **Depends on:** Task 15 (its file, and its fake front app). **Effort:** `high`. **Red test:** none: no behavior (it adds an end-to-end test of what Tasks 4 and 13 built, and two test fakes).

**Files:**
- Modify: `cli/e2e/dialPaneFollow.e2e.ts`, `cli/e2e/harness/fakeBackend.ts`, `cli/e2e/harness/fakeDial.ts`

**Interfaces:**
- Why a fake (decision 5): the daemon asks the backend it is signed in to for the transcript (`DaemonCableHost.transcribe`: `POST <backend>/api/voice/stt?lang=<lang>`, a bearer token, one WAV in a multipart body), and speech to text runs only on production. The suite has no fake of it yet: its voice cases (`deviceWithoutApp.e2e.ts`, #4296's) send no audio and read a refusal.
- The daemon does not change: no switch and no test seam. Its own `transcribe` runs against the fake backend.
- Produces, in `harness/fakeBackend.ts`: `FakeBackend.speech: string | null = null`. While it is a string, `POST /api/voice/stt` reads the upload to its end and answers `{ success: true, data: { transcript: <speech>, lang: <the query's lang> } }`, as `backend/src/routes/voice.ts` does. The route sits after the token check, so a call with no machine's token is the 401 every route gives. `seen` holds its request line, as for every request. While it is null, nothing changes.
- Produces, in `harness/fakeDial.ts`: `FakeDial.audio(pcm: Buffer): void`, one `CableType.Pcm` frame.
- In `dialPaneFollow.e2e.ts`: the helper that creates and starts a case's daemon (Task 8) takes two optional things more: extra env, and a function run on the created daemon before `d.start()`. The other cases pass neither.
- Consumes: Task 8's fake `orca` and `InOrca`; Task 15's watch and its front line; the sign-in of `e2e/dialBuddyChat.e2e.ts` (`FakeBackend.start()`, `addMachine(ME)`, `me`; env `BACKEND_WS_URL: relay.wsUrl`, `WEB_URL: relay.httpUrl`, `ADAPTER_COMPUTER_ID`; `auth/session.json` under `d.root`, written before `d.start()`).
- Orca's route only: the on-dial step this replaces spoke into an Orca pane. The mod's route stays at the unit layer (Tasks 4 and 13).

- [ ] **Step 1: Write the test** `the turn of a prompt the dial spoke does not move the dial, and the next typed prompt does` (no window; a daemon of its own, signed in to a `FakeBackend` whose `speech` is `'run the spoken tests'`; `A` and `B` in Orca terminals, as in Task 15; the watch written `{"front":"com.stablyai.orca"}`). Every wait is on a condition:
  1. The dial is turned to `B` by hand; wait for the fake `orca`'s `terminal switch` run for `B`'s handle.
  2. `A`'s `UserPromptSubmit` hook with `prompt: 'first'`, inside `until(…)` as Task 15's "moves" cases send theirs, until the dial hears `{ t: 'focus', agentId: A.id }`: Orca has settled in front. Then `A`'s `Stop` hook; wait for the dial's `turn.done` for `A` (Orca's route types only at an idle agent's prompt).
  3. The dial speaks to `A`: `{ t: 'voice.begin', agentId: A.id, uploadId: 'spoken-1', sr: 16_000 }`, `dial.audio(Buffer.alloc(3_200, 1))`, `{ t: 'voice.end', uploadId: 'spoken-1' }`. The dial hears `voice.transcript` with `text: 'run the spoken tests'` and `agentId: A.id`. `relay.seen` holds one `POST /api/voice/stt?lang=en`. The fake `orca` recorded one `terminal send --terminal <A's handle> --text=run the spoken tests --enter --wait-submit 5 --json`. The log has `[device] voice · orca`.
  4. The dial is turned to `B` by hand; wait for the second `terminal switch` run for `B`'s handle.
  5. `A`'s `UserPromptSubmit` hook, once, with `prompt: 'run the spoken tests'` (the turn Orca's typing starts). Wait for the log's `[device] prompt · skipped · dial prompt`. The dial heard no `focus` for `A` since step 4.
  6. `A`'s `Stop` hook, then its `UserPromptSubmit` with `prompt: 'and again'`: the dial hears `{ t: 'focus', agentId: A.id }` again, and the log has a second `[device] prompt · moved`.
  7. The daemon's log has no `spoken tests`, no handle and no session id.
- [ ] **Step 2: Run** `cd cli && npm run typecheck && npx vitest run --config vitest.e2e.config.ts e2e/dialPaneFollow.e2e.ts e2e/dialBuddyChat.e2e.ts e2e/deviceCompat.e2e.ts` (the last two use the two fakes). Expected: PASS.
- [ ] **Step 3: Commit** `e2e: the turn of a prompt the dial spoke does not move the dial, with a fake speech to text`.

---

## Verification

**Local gates**, recorded in the pull request (PR CI does not run them):
- `cd cli && npm run typecheck && npm run test:core`: 100% per file for `core/observedHook.ts` and `services/devices.ts`; and `npx vitest run src/architecture.spec.ts` (the core's file list is unchanged).
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit; its receipts go in the pull request.
- Not needed: `npm run test:harnessd`, the serial specs, `make device-test` (nothing of theirs changes).

**Platforms the pull request names:** the daemon and CLI on macOS (tested, on a dial too) and on Linux (unit and end-to-end tests; no dial, so "Linux X11 untested"). Windows: no agents outside a pane.

**The pull request also says,** in these words or closer to its own:
- "Linux X11 untested": the same code follows prompts and switches Orca there, and no dial was tried on Linux (decision 3).
- No spoken prompt was run on a dial: speech to text runs only on production. "A prompt the dial delivered does not move the dial" is covered end to end with a fake speech to text (`cli/e2e/dialPaneFollow.e2e.ts`, Task 16), by Orca's route; the mod's route by unit tests (decision 5).

**Temporary workflow:** none. The one long check runs in the repo's own **CLI end to end** workflow, and the new file joins that suite's nightly run as every file in `cli/e2e` does.

**Turns.** The tester asks before using either, and starts nothing until it is granted.
- **A runner turn,** asked of the orchestrator, before the one hand-started run on GitHub (check 1).
- **The dial and Diego's turn,** asked of the orchestrator, before check 2.

**1. The real daemon, a fake dial, a fake `orca`, a fake front app, a fake speech to text**
- Run: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialPaneFollow.e2e.ts e2e/deviceClaudeOrca.e2e.ts e2e/deviceWithoutApp.e2e.ts e2e/hardwareWatch.e2e.ts e2e/devicesProcess.e2e.ts e2e/dialBuddyChat.e2e.ts`, on a Mac or a Linux box, at the final head.
- Isolation: the suite's own (`e2e/harness/daemon.ts`): a throwaway home and data folder, a private port and tmux server, fake engines, a fake dial on a pseudo-terminal. No real backend and no real account: every case runs with no backend and no sign-in but Task 16's, whose daemon is signed in, with a fixture token, to the suite's fake backend on this machine (`e2e/harness/fakeBackend.ts`), which answers the speech-to-text call with a fixed transcript. The fake `orca` is first on that daemon's `PATH`; the front app is a line on the real watch's stdin. The real Orca, the real Claude app, the everyday daemon (18473) and production are not touched.
- A person sees: every test passes. The daemon's log has `[device] prompt · moved`, `[device] prompt · skipped · relayed`, `[device] prompt · skipped · dial prompt`, `[device] voice · orca` and `[device] swipe · ok` lines, with nothing else in them.
- On GitHub, by hand, once on the final head, after a runner turn: Actions → CLI end to end → Run workflow, branch `feat/dial-pane-follow` (`.github/workflows/cli-e2e.yml`). Every shard passes.

**2. On a dial: the app moves the dial, a swipe moves Orca** (the spec's "On a dial" 1 to 5)
- When: after every task, on the final head, once the base holds T13 and T14.
- **First, the turn.** Nothing below starts before the orchestrator's go.
- Where: Diego's Mac, his round dial on the firmware it has (none is flashed), the real Orca, the real Claude Code and the real Claude app. The Harness window closed, so the dial lists this computer's agents.
- Why not an isolated daemon: the real Claude Code's hooks, in Orca and in the Claude app, reach only the daemon that installed them. These steps call no backend: every frame stays between the hook, the daemon, `orca` and the dial on this Mac.
- **Nobody speaks to the dial in this check** (decision 5): a spoken word would ask production for its transcript. A word spoken by mistake is told to the orchestrator.
- Before anything changes, save `harness version`.
- Build: `make install-cli` at the final head (a local install; nothing is published).
- The front app (decision 4): the Harness Device app built from this stack (T13, T14), the only source of the app in front; the released one writes none. `(cd device-app/ui && npm ci && npm run build) && (cd device-app/src-tauri && cargo build --locked)`, then `target/debug/harness-device`, with the released Harness Device app quit. It is quit after the check ("Afterwards").
- A person does and sees:
  1. Two Claude Code agents in two Orca panes, Orca in front: a prompt typed in either pane turns the dial to it within a second or two.
  2. Swiping between them switches Orca's pane each time the dial rests. With another app in front, Orca does not come forward.
  3. A notification on the dial, tapped: the dial shows the agent, Orca shows its pane and comes forward (#4296).
  4. Two sessions in the Claude app, the app in front: a prompt sent in either turns the dial to it. A swipe to one changes nothing in the app.
  5. A message from another Claude session to an agent in Orca does not turn the dial.
- Evidence: the daemon log's `[device] prompt · moved`, `[device] prompt · skipped · relayed` and `[device] swipe · ok` lines, and a photo of the dial for steps 1 and 4.
- **Afterwards:** quit the debug Harness Device app and start the released one if it ran before. Put the release CLI back with the public installer (`curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash`, as `cli/scripts/install-cli.sh` says); `harness version` reads as saved, with no `-dev.`. Tell the orchestrator the dial is free.
- Not done, for whatever reason: report it as not verified, never as passed.
- On GitHub: none. It needs a real dial, Orca and the Claude app.

**Not run: a spoken prompt on a dial** (decision 5). Speech to text runs only on production and there is no staging account, so no check here speaks to a dial. What that step would have shown is check 1's, by Task 16's test.

## Decisions (the PM for Diego, 2026-11-14)

The answers to this plan's open questions, numbered as they were asked. The spec holds them too ("On a dial", "Design notes"). Task 4 still calls 1 and 2 "open question, provisional": they are decided as it was drafted, and nothing in it changes.

1. **Engines with no prompt event.** Command Code's and agy's `turn-start` never moves the dial: theirs is a tool call or a model call, not a prompt (Task 4).
2. **A relayed message while a dial prompt waits.** A relayed `turn-start` does not consume a pending dial prompt, so the dial prompt's own turn still does not move the dial (Task 4).
3. **Linux.** Linux X11 stays on, with no platform switch. The pull request says "Linux X11 untested" (Global Constraints, Verification).
4. **The front app for the on-dial check.** The stack's debug Harness Device build runs on Diego's Mac for the check and is quit after (Verification, check 2).
5. **The spoken prompt on a dial.** None: there is no staging account, and #4296 ran voice on production by Diego's own choice, which this branch does not repeat. "A prompt the dial delivered does not move the dial" is covered end to end with a fake speech to text (Task 16), and the pull request says so (Verification).

Open questions: none.

Waited on, outside this plan: the base SHA (Task 1); the dial-app-filter tasks named in Tasks 10 and 14 (T5, T6, T9; then T10, T11, T12); and T13 and T14 for the on-dial check.

## Decided here, where the spec was silent

- The measures' words are the nine log lines of Global Constraints, as the notify tally and `[device] voice · …` are.
- With no dial linked, a prompt is neither followed nor counted; a pending dial prompt is still used up.
- Orca's route records the dial prompt before `orca terminal send` runs and takes it back if the send fails: the turn's hook can arrive before the command returns. The rule a person sees is the spec's.
- A session keeps at most 8 pending dial prompts. They go with the session.
- An agent the dial already shows is not counted as a move.
- A second turn to the same agent restarts its rest and is not counted as superseded. A pulled cable ends a pending rest and counts nothing.
- A rest on an agent that has gone, ended or left Orca since the turn counts `failed` and runs nothing.
- A tap does not cancel a pending rest. A tap 0.4 to 1 s after a rest meets the rest's switch: it waits for that one run, then Orca comes forward (the PM, after the final review). No false `busy`.
- `switchTo` answers `'ok' | 'failed' | 'busy'`: one command, one answer. The tap's opener keeps its boolean.
- `relayed` on an `asked` event is refused, as on every event but `turn-start`.
- Grok's prompt event is named `UserPromptSubmit` by the hook, so its rule is Claude Code's.
- `DaemonCableHost.knows` is true for an agent outside Harness, so `followApp`'s log line does not say the dial has no tile for it.
- The end-to-end test takes 395 ms as the earliest a switch may run: Node may fire a timer a millisecond early. The exact 400 is the unit test's.
- The fake speech to text is a route of the suite's fake backend (`POST /api/voice/stt`), not a switch in the daemon: the daemon's own `transcribe` runs unchanged against it. The suite had no such fake: its voice cases sent no audio.
- The end-to-end dial prompt goes by Orca's route, as the on-dial step it replaces did. The mod's route is covered by unit tests (Tasks 4 and 13).
