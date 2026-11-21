# Dial eval for the Claude app and the ChatGPT app Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** One score per app (0-100) for how well the dial works with the Claude app and the ChatGPT app, from a fixed
catalog of 28 scenarios graded automatically in two tiers, with a wrong-session-send gate and a committed baseline that
CI holds as a ratchet.

**Architecture:** A typed catalog (`cli/src/testing/dialAppEval/`) is run by two drivers behind one `EvalDriver`
interface: tier A drives the real `startDevices` in the Vitest process (fake clock, loopback dial, mocked machine
readers, two new `DevicesDeps` seams), tier B drives the real daemon through the e2e harness (`cli/e2e/harness/`). One
runner turns steps into observations (`Seen`), pure check evaluators score them, a pure grader makes the report and the
verdicts against `baseline.json`. `npm run eval:dial-apps` runs both tiers and merges them.

**Tech Stack:** TypeScript (Node 24), Vitest 4.1.10 (unit suite and `vitest.e2e.config.ts`), `node:sqlite`, the e2e
harness (`IsolatedDaemon`, `Desk`, `FakeDial`, `Outside`, `CodexOutside`, the fake backend), Python 3 for
`scripts/ci-plan.py`.

**Spec:** `docs/plans/2026-11-21-dial-app-eval-design.md` (read it with this plan; its Decisions section is final).

## Global Constraints

- Weights: D5 25, D3 15, D2 15, D1 15, D4 10, D7 10, D6 5, D8 5. A dimension with no check in a run is left out and the
  others renormalised; the table shows `—`.
- Latency, inclusive (≤), scores 1 / 0.5 / 0: D2 follow 1 s / 3 s; D3 open 1 s / 3 s; D4 working and needs-you 1 s / 3 s;
  D4 done 2.5 s / 5 s; D1 a change on the ring 2 s / 5 s; D8 event-loop p99 50 ms / 200 ms; D8 CPU ≤ 10 % / ≤ 25 % of
  the scenario's wall time. D5, D6, D7 and D8's processes-left check are pass/fail.
- Points lost by check `c` of dimension `d` (n_d checks of that dimension for that app, main set):
  `100 · (w_d / Σw) · (1 − score_c) / n_d`.
- Gate: any voice prompt delivered to a session other than the step's target fails the whole run, whatever the score.
- Target ≥ 95 per app is reported; a score below 95 never fails CI.
- Held out: CH1-3, XH1-3 (6 of 28), in `heldOut.ts` and `dialAppEvalHeldOut.e2e.ts`, scored apart, never in the
  headline.
- Tier A: deterministic, the whole tier under 60 s, no D8. Tier B: each e2e file under about 6 minutes on a CI runner.
- Every tier B scenario carries the three D8 checks (devices-process CPU, event-loop delay p99, processes left), so both
  apps have a D8 score (PM, 2026-11-21).
- A coverage gap leaves that scenario × platform out of the scores (neither pass nor fail), lists it in the report, and
  the number of runs left out is printed beside each app's score (PM, 2026-11-21).
- Tier B's baseline holds macOS only in this PR: Linux tier B is gate-only (PM, 2026-11-21).
- Never the real `~/.claude`, `~/.codex`, Claude or ChatGPT app, `/usr/bin/open`, `xdg-open`, backend or account:
  throwaway homes and temp folders only. No real Claude or ChatGPT app is ever run.
- Every eval test, tier A and tier B, runs under one network guard (Task 23): a connection to anything but this machine
  (loopback, a Unix socket, a named pipe) fails the test, naming its host and port, never its path, query or payload
  (PM, 2026-11-21).
- Nothing under `cli/src/core/`. The only product-code changes are the two `DevicesDeps` seams (`transcribe`,
  `watchStore`), each documented "For this service's tests", and the transcriber field on `CableHostWiring` they feed.
- Fixtures are made up: titles start with `Eval `, folders with `/work/eval-`. The report names scenario ids, check
  ids and session keys, never a title, folder, path or spoken text.
- No fixed sleeps in tier A (virtual time only). Tier B waits are bounded `until` polls; a scenario's own `wait` step
  (X11's 300 ms, XH3's 200 ms) is scenario timing.
- C8 is graded as specified (opens the resting session, then sends) and fails at baseline; nothing here builds it.
- Copy follows the Naming System: "the dial", "the Claude app", "the ChatGPT app", "Codex threads".

## Review Focus

1. **Tier A on another host.** The baseline is written on macOS and PR CI checks it on Linux: a result that carries a
   host path, a real-time duration or a `process.platform` branch differs there. Task 4 runs C1 twice and compares;
   Task 8 asserts results hold no absolute path; Task 4 declares gaps host-independently; Verification 2 checks Linux.
2. **Timers that never stop.** The cable's 1 s tick and the carousel's refresh make "advance to the next timer" loop
   forever. Task 4's clock spec: a world that sets a timer from every timer stops at its limit, naming it.
3. **A delivery with no known target** (words typed into a pane no session owns) is a wrong-session send, never
   ignored. Task 5's spec.
4. **Evidence that names the machine** (a temp folder, `HOME`, a `/work/eval-` folder from a frame) never reaches
   `report.json` or `report.md`. Task 7's spec.
5. **Two sessions with the same title, and a list cut short** (`agents.begin` with no `agents.end`, or a second
   `begin`): rows are matched by agent id, only complete lists count. Task 5's spec.

## Decisions this plan makes (from the spec's room)

- **Probes** ("a scenario whose check must fail does fail with its evidence"): every scenario carries `probes`, checks
  that name a `ghost` session (declared, never written or started), so they fail whatever the product does. A probe is
  caught when a result scores below 1 and its evidence is not empty; evidence lists only what was observed, so a driver
  that observes nothing fails its probes. Probes are never scored.
- **Scaffolding while the step families land:** a step kind with no handler yet throws `StepNotBuilt`; the specs mark
  that scenario skipped. Task 22 removes `StepNotBuilt`, the skips and the "every scenario ran" assertions.
- **Tier A clock:** `vi.useFakeTimers({ now: EVAL_EPOCH, toFake: ['setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'Date', 'performance'] })` (`EVAL_EPOCH = Date.UTC(2026, 10, 21, 9)`), installed before
  `startDevices`. `setImmediate`, `nextTick` and `queueMicrotask` stay real so the driver can drain I/O. "Quiet" = no
  store read in flight (the wrapped readers' counter) and no `FSReqCallback`, `FSReqPromise` or `FileHandleCloseReq` in
  `process.getActiveResourcesInfo()`, on two real `setImmediate` turns in a row.
- **A coverage gap** (a `process.platform` read on the scenario's path that the injected platform cannot choose) drops
  that scenario × platform from the scores (neither pass nor fail), lists it, and counts it beside its app's score
  (PM, 2026-11-21). A run is one tier × platform × scenario, counted once whatever the number of its gap reasons. Gaps
  are declared host-independently: a read that differs between macOS and Linux makes the scenario a gap on every
  platform.
- **D8 in tier B:** the catalog gives every scenario whose tiers hold `b` one check `{ id: 'cost', kind: 'cost', dim:
  'D8' }` and D8 in its dims (PM, 2026-11-21); tier A evaluates it to nothing. The tier B driver measures every
  scenario from `start` to the end of `stop`, so the runner evaluates checks after `stop`.
- **`front` in D3:** darwin `open -b <bundle>` (with or without the link); linux `xdg-open <link>` or a raise of the
  app; win32 `harness-pty open-link <link>` or `harness-pty raise` (tier A records `windowsRaise.link`/`.app` and
  `raise` as those argv). Bundles: `com.anthropic.claudefordesktop`, `com.openai.codex`.
- **Not in the catalog:** the step "remove a store session (Claude)": no scenario uses it, so it has no handler.
- **Results files:** `$DIAL_EVAL_OUT/results-<tier>-<source>.json`, source `spec`, `claude`, `chatgpt` or `heldOut`.

---

## Task graph

| # | Task | Effort | Depends on |
|---|---|---|---|
| 1 | The eval's contract | medium | - |
| 2 | The carousel model in `src/testing` | medium | - |
| 3 | `DevicesDeps` seams: `transcribe`, `watchStore` | high | - |
| 4 | Tier A skeleton: `startDevices` in process, C1, its run time | xhigh | 1, 2, 3 |
| 5 | Check evaluators | high | 1 |
| 6 | Grader and verdicts | high | 1 |
| 7 | Report | medium | 1 |
| 8 | Runner, and the tier A spec on it | high | 4, 5 |
| 9 | Catalog: the 28 scenarios and their probes | high | 4 |
| 10 | The eval command | high | 6, 7, 8 |
| 11 | Tier A: the ChatGPT app's store | high | 8, 9 |
| 12 | Tier A: live sessions (hooks, the Claude mod, quit, relaunch) | high | 8, 9 |
| 13 | Tier A: the dial and the windows (tap, swipe, unplug, replug, thread, attach) | high | 8, 9 |
| 14 | Tier A: voice, and the fake apps that answer links | high | 11, 12, 13 |
| 15 | The Claude store fixture refuses the real store | medium | - |
| 16 | `corePerf.cjs` measures the devices process | medium | - |
| 17 | The Claude mod's inbox poll in the e2e harness | medium | - |
| 18 | Tier B driver core, its cost meter, and C1 on the real daemon | high | 4, 8, 16, 23 |
| 19 | Tier B: the Claude app's scenarios | high | 9, 17, 18, 23 |
| 20 | Tier B: the ChatGPT app's scenarios | high | 9, 18, 23 |
| 21 | `ci-plan.py`: linux-e2e runs the eval's files | high | 2 |
| 22 | Held-out e2e file, baseline, ratchet, timing hints, scaffolding out | high | 10, 14, 19, 20, 23 |
| 23 | One network guard for every eval test | high | 8 |

Files shared by tasks (devcrew runs them one at a time; the dependencies above order them): `types.ts` (1, 4 only if
the budget fallback applies, 22), `catalog.ts` (4, 9), `dialAppEval.spec.ts` (4, 8, 23, 22), `tierA/driver.ts` (4, 14,
22), `tierA/steps/window.ts` (4, 13), `cli/e2e/harness/appEvalDriver.ts` (18, 22), `appEvalClaude.ts` (18, 19),
`appEvalChatgpt.ts` (18, 20), `dialAppEvalClaude.e2e.ts` (18, 19, 22), `dialAppEvalChatgpt.e2e.ts` (20, 22).
Task 23's `netGuard.*` files are its own; Tasks 18-20 and 22 only import `netGuard.ts`. Task 23 shares no file with
Task 9 or Tasks 11-14.
No task edits the catalog after Task 9: a family task that finds an entry wrong reports it.

Longest chain: 3 → 4 → 8 → 23 → 18 → 19 → 22 (seven tasks; 1 → 5 → 8 → 23 → 18 → 19 → 22 is as long).

---

## Foundations

### Task 1: The eval's contract

**Files:** Create `cli/src/testing/dialAppEval/types.ts`; Test `cli/src/testing/dialAppEval/types.spec.ts`.
**Depends on:** -. **Effort:** medium.

**Interfaces:** Produces exactly this (doc comments from the spec; bodies only where shown):

```ts
export type App = 'claude' | 'chatgpt'
export type Dimension = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7' | 'D8'
export type Platform = 'darwin' | 'win32' | 'linux'
export type Tier = 'a' | 'b'
export type SessionKey = string
export type Label = string
export const DIMENSIONS: readonly Dimension[]                       // D1..D8 in order
export const WEIGHTS: Readonly<Record<Dimension, number>>           // Global Constraints
/** [full, half], inclusive. */
export const THRESHOLDS: { follow: [1000, 3000]; open: [1000, 3000]; working: [1000, 3000]; needsYou: [1000, 3000];
  done: [2500, 5000]; ringChange: [2000, 5000]; loopP99Ms: [50, 200]; cpuPercent: [10, 25] }

export interface SessionDef {
  key: SessionKey; app: App
  id: string            // Claude Code's cliSessionId, or the Codex thread id: a fixed made-up UUID
  localId?: string      // Claude only: `local_<uuid>`, its store file and its link's session
  title: string         // the app's title (Claude) / Codex's thread name (ChatGPT): starts with "Eval "
  cwd: string           // under /work/eval-
  ageMs: number         // last active this long before the step that writes it
  project?: string      // ChatGPT: its sidebar project
  resumable?: true      // the fake app starts it when its link runs
  cli?: true            // a Codex CLI session in a terminal, not the ChatGPT app's (X10)
  ghost?: true          // never written or started: only probes name it
}

export const STEP_KINDS = ['claude.write', 'codex.write', 'hook', 'front', 'thread', 'attach', 'tap', 'swipe',
  'voice', 'quit', 'relaunch', 'unplug', 'replug', 'wait'] as const
export type StepKind = (typeof STEP_KINDS)[number]
export type Step = { label?: Label } & (
  | { kind: 'claude.write'; sessions: SessionKey[]; archived?: true }
  | { kind: 'codex.write'; sessions: SessionKey[]; projects?: string[]; names?: Record<SessionKey, string>;
      archived?: SessionKey[]; ages?: Record<SessionKey, number>; walBusy?: true }
  | { kind: 'hook'; session: SessionKey; event: 'start' | 'turn-start' | 'needs-input' | 'turn-stop' | 'end';
      asks?: 'permission' | 'question'; lastAnswer?: string }
  | { kind: 'front'; app: App | 'other' }
  | { kind: 'thread'; title: string }
  | { kind: 'attach'; session: SessionKey }
  | { kind: 'tap'; session: SessionKey }
  | { kind: 'swipe'; session: SessionKey }
  | { kind: 'voice'; transcript: string; target: SessionKey }
  | { kind: 'quit'; app: App }
  | { kind: 'relaunch'; app: App }
  | { kind: 'unplug' }
  | { kind: 'replug' }
  | { kind: 'wait'; ms: number; until?: string }   // until: a check id whose condition ends the wait
)   // one member per kind, so StepOf<K> (Extract) narrows
export type StepOf<K extends StepKind> = Extract<Step, { kind: K }>

export const CHECK_KINDS = ['ring', 'focus', 'still', 'open', 'state', 'voice', 'recap', 'cost'] as const
export type CheckKind = (typeof CHECK_KINDS)[number]
export type Check = { id: string; dim: Dimension; after?: Label; at?: Label } & (
  | { kind: 'ring'; page: App; expect: SessionKey[]; timed?: true }
  | { kind: 'focus'; session: SessionKey; noBounce?: true }
  | { kind: 'still'; ms: number }
  | { kind: 'open'; session: SessionKey; link: boolean }
  | { kind: 'state'; session: SessionKey; state: 'working' | 'needs-you' | 'done' | 'idle' }
  | { kind: 'voice'; session: SessionKey; text: string }
  | { kind: 'recap'; session: SessionKey; text: string }
  | { kind: 'cost' }
)

export interface Scenario {
  id: string; app: App; title: string; dims: Dimension[]; platforms: Platform[]; tiers: Tier[]; heldOut: boolean
  sessions: SessionDef[]
  world?: { front?: App | 'other'; chatgptInstalled?: false; linkFails?: App[] }   // front defaults to `app`
  steps: Step[]; checks: Check[]; probes: Check[]
  fresh?: true                                    // tier B: on a daemon of its own
}

export interface Delivery { at: number; path: 'mod' | 'turns' | 'codex' | 'typed'; target: SessionKey | null; text: string }
export interface Seen {                            // `at`: ms since the scenario's start (virtual in A, wall in B)
  frames: Array<{ at: number; message: Record<string, unknown> }>
  faces: Array<{ at: number; page: string; tiles: string[]; active: string | null }>
  commands: Array<{ at: number; argv: string[] }>
  deliveries: Delivery[]
  steps: Array<{ at: number; index: number; kind: StepKind; label?: Label }>
  cost?: { cpuPercent: number; loopP99Ms: number; leftovers: number }
}
export interface CheckResult {
  tier: Tier; platform: Platform; scenario: string; check: string   // `<id>.<part>`, or `<id>` for a D7 check
  app: App; dim: Dimension; heldOut: boolean
  score: number                                    // 0..1
  timed: boolean                                   // latency or cost threshold: reported, never asserted in tier B
  ms?: number | null
  evidence: string[]                               // what was observed, one line each; empty when nothing was
}
export interface WrongSend { tier: Tier; platform: Platform; scenario: string; target: SessionKey; got: SessionKey | null;
  path: Delivery['path']; at: number }
export interface CoverageGap { tier: Tier; platform: Platform; scenario: string; app: App; reason: string }
export interface RunResults { schema: 1; results: CheckResult[]; wrongSends: WrongSend[]; gaps: CoverageGap[] }
export interface Baseline { schema: 1; checks: Record<string, number>; apps: Record<App, number | null> }
export interface AppScores { score: number | null; dims: Record<Dimension, number | null>
  leftOut: number }                                // that app's tier × platform × scenario runs left out for a gap
export interface Group { app: App; dim: Dimension; scenario: string; pointsLost: number; checks: string[] }
export interface Report {
  schema: 1
  apps: Record<App, AppScores>; heldOut: Record<App, AppScores>
  byTier: Record<Tier, Record<App, AppScores>>; byPlatform: Record<string, Record<App, AppScores>>  // key `<tier>/<platform>`
  gate: { passed: boolean; wrongSends: WrongSend[] }
  failing: Array<CheckResult & { pointsLost: number }>; groups: Group[]   // groups ranked, most points lost first
  gaps: CoverageGap[]
  delta: { apps: Record<App, { before: number | null; after: number | null }>;
           checks: Array<{ key: string; before: number | null; after: number | null }> }
}
export interface Verdict { ok: boolean; message: string }
export interface EvalDriver {
  readonly tier: Tier
  start(scenario: Scenario, platform: Platform): Promise<void>   // time 0: devices up, dial welcomed, page and front set
  step(step: Exclude<Step, { kind: 'wait' }>): Promise<void>     // throws StepNotBuilt for a kind it cannot run yet
  settle(ms: number, until?: () => boolean): Promise<void>       // let the world run up to ms, or until `until` holds
  now(): number
  seen(): Seen                                                   // still read after stop()
  gaps(): string[]
  stop(): Promise<void>
}
export class StepNotBuilt extends Error { constructor(readonly kind: StepKind, readonly tier: Tier) }
export function agentIdOf(session: Pick<SessionDef, 'app' | 'id'>): string   // observedAgentId(claude|codex, id)
export function resultKey(r: Pick<CheckResult, 'tier' | 'platform' | 'scenario' | 'check'>): string  // tier/platform/scenario/check
```

- [ ] **Step 1: Failing test** `types.spec.ts`: `agentIdOf gives the observed source's id for both apps`
  (`agentIdOf({ app: 'claude', id: X })` equals `observedAgentId('claude', X)`, ChatGPT → `'codex'`);
  `the weights are the spec's and sum to 100`; `resultKey joins tier, platform, scenario and check with /`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/types.spec.ts` → FAIL (module missing).
- [ ] **Step 3:** Write `types.ts`.
- [ ] **Step 4:** Same command → PASS; `npm run typecheck` passes.
- [ ] **Step 5:** Commit red, then green.

### Task 2: The carousel model in `src/testing`

**Files:** Create `cli/src/testing/dialCarousel.ts`, `cli/src/testing/dialCarousel.spec.ts`; Modify
`cli/e2e/harness/fakeDial.ts`. **Depends on:** -. **Effort:** medium.

**Interfaces:** Produces `export type DialMessage`, `export const CAROUSEL_REFRESH_MS = 50`, `CAROUSEL_TILES = 16`,
`export class DialCarousel { heard(message: DialMessage): void; picked(app: string): void; refresh(): void;
readonly tiles: string[]; active: number; refused: number }` — the class moved as it is from `fakeDial.ts`, its
comments kept. `fakeDial.ts` imports it and re-exports `DialMessage` (e2e files import it from there).

- [ ] **Step 1: Failing tests** in `dialCarousel.spec.ts`: `a list pushed over 16 tiles adds before it removes, so
  its one new agent is refused and the face is "Choose a pane"` (16 tiles, list `[x]` → `tiles []`, `refused 1`,
  `active -1`); `the list's order is applied by swaps and the face stays on its agent`; `a focus before its tile lands
  once the tile is there`; `a pick lands its ring's first tile; a pick of the app shown lands nothing`; `a list still
  building is not read`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialCarousel.spec.ts` → FAIL (module missing).
- [ ] **Step 3:** Move the class; `fakeDial.ts` keeps its behaviour.
- [ ] **Step 4:** Same command → PASS; `npm run typecheck`;
  `TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialOrcaFullRing.e2e.ts e2e/deviceNotify.e2e.ts` →
  PASS (they read `dial.carousel()`).
- [ ] **Step 5:** Commit red, then green.

### Task 3: `DevicesDeps` seams: `transcribe`, `watchStore`

**Files:** Modify `cli/src/services/devices.ts`, `cli/src/cable/cableHost.ts`; Test
`cli/src/services/devices.spec.ts`, `cli/src/cable/cableHost.spec.ts`. **Depends on:** -. **Effort:** high.

**Interfaces:** Produces
```ts
// CableHostWiring (cableHost.ts): for the devices' tests, the transcriber in place of the backend's
transcribe?: (pcm: Buffer, sampleRate: number, lang: string, signal?: AbortSignal) => Promise<string>
// DevicesDeps (devices.ts), each "For this service's tests: …"
transcribe?: CableHostWiring['transcribe']        // handed to DaemonCableHost's wiring
watchStore?: (folders: readonly string[], changed: (file?: string) => void) => () => void
```
`DaemonCableHost.transcribe` returns `this.wiring.transcribe(...)` when set, posting nothing. `ClaudeAppSource`'s and
`CodexAppSource`'s `watch` call `deps.watchStore ?? watchNearest`; opencode's watch is unchanged.

- [ ] **Step 1: Failing tests:** `cableHost.spec.ts` `transcribes with the wiring's transcriber when given, and posts
  nothing` (fetch spy not called, the text returned). `devices.spec.ts`: `a dial's speech goes to the devices'
  transcriber when one is given` (the `FakeCable`'s host `transcribe(Buffer.alloc(2), 16000, 'en')` resolves the
  seam's text; the seam got `(pcm, 16000, 'en', undefined)`); `the Claude app's store and the ChatGPT app's Codex home
  are watched through watchStore when given` (with a dial attached: `watchStore` called with the Claude roots' chains
  and `[join(homedir(), '.codex')]`; `watchedFolders.calls` holds neither).
- [ ] **Step 2:** `cd cli && npx vitest run src/cable/cableHost.spec.ts src/services/devices.spec.ts` → FAIL.
- [ ] **Step 3:** Implement the three fields.
- [ ] **Step 4:** Same command → PASS; `npm run typecheck`; `npm run test:core` → 100 % per file, `devices.ts`
  included.
- [ ] **Step 5:** Commit red, then green.

## Tier A

### Task 4: Tier A skeleton: `startDevices` in process, C1, its run time

**Files:** Create in `cli/src/testing/dialAppEval/`: `dialAppEval.spec.ts`, `catalog.ts`, `tierA/machine.ts`,
`tierA/clock.ts`, `tierA/clock.spec.ts`, `tierA/loopbackDial.ts`, `tierA/storeWatch.ts`, `tierA/world.ts`,
`tierA/driver.ts`, `tierA/steps/claudeStore.ts`, `tierA/steps/window.ts`, and the stub families
`tierA/steps/codexStore.ts`, `sessions.ts`, `dial.ts`, `voice.ts`. Modify `types.ts` only if Step 7's fallback
applies. **Depends on:** 1, 2, 3. **Effort:** xhigh.

**Interfaces:**
- Consumes: Task 1's types; `DialCarousel`; `DevicesDeps.transcribe`, `.watchStore`; `claudeAppFixture`,
  `codexAppFixture`, `ClaudeAppStore`, `CodexAppThreads`, `fakeCore`, `emptyPorts`, `CableDecoder`/`encodeCableFrame`.
- Produces:
  ```ts
  // tierA/machine.ts: imports nothing at run time from src/ (vi.hoisted loads it before the mocks)
  export interface LiveProcess { pid: number; ppid: number; executable: string; tty?: string; app?: string }
  export interface MachineModel {
    platform: Platform; processes: Map<number, LiveProcess>; bundleIds: Map<string, string>
    reset(platform: Platform): void; start(p: LiveProcess): void; end(pid: number): void
    // what the mocks answer: listProcesses, processAlive, learnApps, readProcessNames, readTtyName, readBundleId,
    // OpenSessions.owners/busy, SessionRows.find, from the processes above and the sessions they run
    owners: Map<string, { engine: 'claude' | 'codex'; pid: number; cwd: string; transcriptPath: string | null }>
  }
  export const machine: MachineModel
  // tierA/clock.ts
  export const EVAL_EPOCH: number                    // Date.UTC(2026, 10, 21, 9)
  export const MAX_ADVANCES = 100_000                // per settle
  export function installClock(): void              // the fake timers of "Decisions", now = EVAL_EPOCH
  export function quiet(inFlight: () => number): Promise<void>
  export function settle(ms: number, until: (() => boolean) | undefined, inFlight: () => number): Promise<void>
    // sentinel timer at now+ms; loop: quiet, stop when until() or the sentinel fired, else vi.advanceTimersToNextTimer();
    // throws `runaway timers` past MAX_ADVANCES
  // tierA/loopbackDial.ts: the round dial over CableFleet's open/discover, greeting with { appFilter: 'v1' }
  export class LoopbackDial {
    readonly cable: Partial<CableFleetOptions>       // discover, open, inUse: false, canUseUsb: true, reset: false
    readonly frames: Seen['frames']; readonly faces: Seen['faces']
    send(m: DialMessage): void; tap(agentId: string): void /* agent.open */; swipe(agentId: string): void /* focus */
    voice(pcm: Buffer[]): void /* voice.begin, pcm frames, voice.end */; pick(app: string): void
    unplug(): void; replug(): void
  }
  // tierA/storeWatch.ts
  export function createStoreWatch(): { watch: NonNullable<DevicesDeps['watchStore']>; changed(path: string): void }
    // changed(path) calls each registration whose nearest existing folder holds `path` with its entry name, as
    // fs.watch does; a registration whose folders are not on this host (win32 paths on a posix host) is called with none
  // tierA/world.ts
  export interface TierAWorld {
    readonly scenario: Scenario; readonly platform: Platform; readonly machine: MachineModel
    readonly ports: CorePorts; readonly core: CoreApi; readonly dial: LoopbackDial
    readonly listener: Readonly<Record<string, ListenerHandler | ListenerStreamHandler>>   // what deps.listen got
    readonly claudeStore: ReturnType<typeof claudeAppFixture>; readonly codexHome: ReturnType<typeof codexAppFixture>
    readonly folders: { claudeProjects: string; codexSessions: string }   // transcripts; emptied per scenario
    speech: string | null                                                 // what deps.transcribe answers
    storeChanged(path: string): void
    now(): number; agentId(key: SessionKey): string; session(key: SessionKey): SessionDef
    deliver(d: Omit<Delivery, 'at'>): void
    answer(rule: (argv: readonly string[]) => { code: number; stdout?: string } | undefined): void
    gap(reason: string): void
    quiet(): Promise<void>
  }
  export type StepHandler<K extends StepKind> = (world: TierAWorld, step: StepOf<K>) => Promise<void>
  // tierA/driver.ts
  export class TierADriver implements EvalDriver { constructor(deps: { startDevices: typeof startDevices }) }
  // tierA/steps/<family>.ts each: export const <family>Steps: { [K in its kinds]: StepHandler<K> }
  //   claudeStore: 'claude.write'   window: 'front' (built), 'thread', 'attach' (stubs)
  //   codexStore: 'codex.write'     sessions: 'hook', 'quit', 'relaunch'     dial: 'tap', 'swipe', 'unplug', 'replug'
  //   voice: 'voice'                a stub: async () => { throw new StepNotBuilt(kind, 'a') }  (Task N builds it)
  // catalog.ts
  export const MAIN: Scenario[]; export const HELD_OUT: Scenario[]      // [C1] and [] here
  export function scenariosFor(tier: Tier, platform: Platform): Scenario[]   // MAIN and HELD_OUT on that tier, platform
  ```
- The world, per scenario: a fresh temp root holding the Claude store at `claudeStoreRoots(platform, env, tempHome)[0]`
  when that path is the host's kind, else a plain temp root (the readers always read the fixture's root, spec "OS
  branches"); the ChatGPT Codex home; `deps.claudeAppStore` the real `ClaudeAppStore` on that root and
  `deps.codexAppThreads` the real `CodexAppThreads` on that home, each wrapped to count its reads in flight (the clock's
  `inFlight`); the ChatGPT app installed unless `world.chatgptInstalled === false` (darwin: the
  `bundleId` dep answers `com.openai.codex`; linux: `vi.stubEnv('HARNESS_APPLICATIONS_DIR', <temp>)` with a file at
  `chatgpt/ChatGPT`; win32: `storePackageFolder` answers a folder); `xdg-mime` answers a desktop file for both schemes;
  `world.linkFails` apps' links answer code 1. `deps.orca.run`, `deps.codex.run`, `raise`, `windowsRaise` and
  `core.turns.send` record into `Seen` (`commands` or `deliveries`).
- `start()`: install the clock, `machine.reset(platform)`, `startDevices(fakeCore({ dataDir }), ports, deps)` with the
  mocks below and the stand-ins `devices.spec.ts` gives for herdr, hc, cmux, opencode, `orcaReads`, VS Code, Cursor,
  Orca's plugin, `claude` (none) and `orcaHomes` (empty); the front app (`listener.front`); the dial plugged and
  welcomed; `pick` of the page (`world.front` if an app, else the scenario's app). `stop()`: `ports.devices.stop()`,
  `vi.useRealTimers()`, `vi.unstubAllEnvs()`, remove the temp root.
- Gaps: list every `process.platform` read on the paths these scenarios run (start from the reads in
  `cli/src/cable/hosts/` and `cli/src/cable/*.ts` the seams do not cover) in `driver.ts`'s `PLATFORM_GAPS`, each with
  the platforms it misleads on both macOS and Linux hosts.

- [ ] **Step 1: Failing tests.** `clock.spec.ts`: `settle advances to the next timer only once the world is quiet`
  (a timer due at 500 set by a read that resolves on a real fs call fires after the read); `settle stops at its
  limit, and as soon as until holds`; `a world that sets a timer from every timer stops with "runaway timers"`.
  `dialAppEval.spec.ts` (the mock block below, then): `C1 on darwin, win32 and linux: the Claude page's last whole list
  is the five sessions, newest first, by their titles` (ids `agentIdOf(a..e)` in order, names `Eval Alpha`…);
  `C1 twice gives the same frames at the same virtual times`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/` → FAIL (modules missing).
- [ ] **Step 3: The mock block** at the top of `dialAppEval.spec.ts`, every answer from
  `const { machine } = await vi.hoisted(async () => await import('./tierA/machine.js'))`:
  `../../lib/sessionSearch/externals/support.js` (`listProcesses`, `processAlive`, `fileStamp`),
  `../../lib/sessionSearch/external.js` (`OpenSessions`, `SessionRows`), `../../cable/hosts/scannedApp.js`
  (`learnApps`, `readProcessNames`, `readTtyName`, `readBundleId`), `../../cable/hosts/folderWatch.js` (`watchNearest`
  inert), `../../cable/hosts/unixSocket.js` (`watchSocket` inert), `../../lib/tmuxOnPath.js`,
  `../../cable/hosts/zellij.js` (`zellijFinder`), `../../cable/hosts/kitty.js` (`kittyFinder`),
  `../../lib/voiceRouter.js` (inert), `../../devices/orcaHomes.js` (`orcaHomesDeps` with none). `startDevices` is
  imported after them (`await import('../../services/devices.js')`), as `devices.spec.ts` does.
- [ ] **Step 4:** Build the machine, clock, loopback dial, store watch, world, driver, `claude.write` (rewrites each
  session's store file with `lastActivityAt = now − ageMs`, then `storeChanged`), `front`, the stubs, and `catalog.ts`
  with C1 (Task 9's table row). The spec runs C1 through the driver directly (Task 8 puts it on the runner).
- [ ] **Step 5:** Same command → PASS; `npm run typecheck`.
- [ ] **Step 6: Measure.** Print each C1 run's wall ms; project `max × 84` (28 scenarios × 3 platforms). Record the
  numbers in the commit message and the task's report.
- [ ] **Step 7: Budget.** If the projection is over 60 s: add `osBranch?: true` to `Scenario` ("its path has an OS
  branch: tier A runs it on win32 and linux too") and make `scenariosFor` run the others on darwin only. If even that
  projection is over 60 s, stop and report to the main session.
- [ ] **Step 8:** Commit red, then green.

### Task 5: Check evaluators

**Files:** Create `cli/src/testing/dialAppEval/checks.ts`, `checks.spec.ts`. **Depends on:** 1. **Effort:** high.

**Interfaces:** Produces
```ts
export function graded(value: number | null, threshold: readonly [number, number]): 0 | 0.5 | 1   // ≤, null → 0
export function evaluate(check: Check, scenario: Scenario, seen: Seen, tier: Tier, platform: Platform): CheckResult[]
export function holds(check: Check, scenario: Scenario, seen: Seen): boolean       // the condition a wait can end on
export function wrongSends(scenario: Scenario, seen: Seen): Array<Omit<WrongSend, 'tier' | 'platform'>>
```
Parts per kind (`<id>.<part>`; a check whose `dim` is D7 gives one pass/fail result `<id>`, 1 when every untimed part
is 1):
- `ring` (window: lists after `after`, the last whole list before `at` or the end, on `page`; app `chatgpt` is the wire's
  `codex`): `recall`, `precision` (duplicates and unknown ids count as extra rows), `order` (share of expected keys at
  their index), `names` (share named `observedTitle(title)`, the title as the latest `codex.write` `names` before `at`
  set it), `cap` (≤ 16 rows), `archived` (no row archived by a step before `at`); `change` (timed, `ringChange`) when
  `timed`: from `after` to the first list with recall and precision 1.
- `focus`: `lands` (the face's active tile is the session's id at `at`/end), `latency` (timed, `follow`), `noBounce`
  when set (after the first landing, no face on another session).
- `still`: `still`, no face change in `ms` after `after`. `open`: `link` when `link` (a command holding
  `claude://code/continue?session=<localId>` or `codex://threads/<id>`), `front` ("Decisions"), `latency` (timed,
  `open`). `state`: `shown` (the session's row in that state after `after`), `latency` (timed; `working`, `needsYou`,
  `done`; none for idle). `voice`: `reached`, `once`, `exact`. `recap`: `exact` (the session's summary frame's text).
  `cost`: `cpu` and `loopP99` (timed: `cpuPercent`, `loopP99Ms`), `leftovers` (pass/fail: 0 left); tier A gives no
  result.
- Wrong sends: each delivery after a `voice` step whose target is not that step's target, or is `null`.

- [ ] **Step 1: Failing tests** (hand-made `Seen`), one `describe` per kind with a pass, a fail and a latency case each
  (≤ is inclusive: 1000 ms follow → 1, 3000 → 0.5, 3001 → 0, never → 0); and: `two rows with the same title are
  matched by id`; `a list with no agents.end, or cut by a second agents.begin, is not read`; `a delivery with no known
  target is a wrong send`; `a ring check with D7 is one pass/fail result`; `evidence is empty when nothing was seen`;
  `cost gives nothing in tier A`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/checks.spec.ts` → FAIL.
- [ ] **Step 3:** Implement; read the frame shapes in `cli/src/cable/cableSession.ts` (`agent`, `focus`, `apps`, turn
  and summary cards).
- [ ] **Step 4:** Same command → PASS; typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 6: Grader and verdicts

**Files:** Create `cli/src/testing/dialAppEval/grade.ts`, `grade.spec.ts`. **Depends on:** 1. **Effort:** high.

**Interfaces:** Produces
```ts
export const BASELINE_PATH: string                  // cli/src/testing/dialAppEval/baseline.json, from this file
export function grade(results: RunResults, baseline: Baseline | null): Report
export function tierAVerdict(results: RunResults, baseline: Baseline): Verdict
export function tierBVerdict(results: RunResults, baseline: Baseline, platform: Platform): Verdict
export function updateBaseline(baseline: Baseline | null, results: RunResults, tiers: readonly Tier[]): Baseline
export function loadBaseline(path?: string): Baseline | null
```
- Scores over the main set; held-out alone in `heldOut`; `byTier` and `byPlatform` over each subset. Each
  `AppScores.leftOut` counts the distinct `tier/platform/scenario` of that app's gaps in the same subset.
- `tierAVerdict`: not ok on any wrong send; else not ok when tier A's keys or scores differ from the baseline's tier A
  entries: a lower score is "regression: <keys>"; a higher score, a new key or a missing one is "stale baseline:
  <keys>; run `npm run eval:dial-apps -- --tier a --update-baseline` and commit
  cli/src/testing/dialAppEval/baseline.json".
- `tierBVerdict`: not ok on any wrong send; else not ok for each untimed result of that platform whose baseline entry is
  1 and now below 1. No entry for that platform: the gate only. Timed results never.
- `updateBaseline` replaces the given tiers' entries (tier B: that run's platforms) and keeps the rest.

- [ ] **Step 1: Failing tests:** `an app's score is the weighted mean of its dimensions, renormalised without D8`
  (D1 [1, 0], D5 [0] → 18.75); `points lost: D1's failing check 18.75 and D5's 62.5, summing to 100 − score`;
  `held-out results are scored apart and never in the headline`; `the gate fails on one wrong send`; `delta lists each
  changed check and both app scores`; `tier A: a drop is a regression, a rise or a new check a stale baseline naming
  the update command`; `tier B: a pass/fail drop fails, a timed drop does not, a platform with no entries asserts the
  gate only`; `updateBaseline keeps the other tier's entries`; `a gap's run is in no score, and each app's leftOut
  counts its runs left out once each` (two reasons for one run → 1; a ChatGPT gap leaves the Claude app's 0).
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/grade.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS; typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 7: Report

**Files:** Create `cli/src/testing/dialAppEval/report.ts`, `report.spec.ts`. **Depends on:** 1. **Effort:** medium.

**Interfaces:** Produces `export function summary(report: Report): string` (the terminal table),
`export function markdown(report: Report): string`, `export function writeReport(dir: string, report: Report): { json:
string; md: string }`. Sections: score table app × D1-D8 (`—` for none) with the app score, "left out: N" beside it (its
`leftOut`, also when 0) and the 95 target; held-out table; per-tier and per-platform rows, each score with its left
out; the gate with each wrong send (scenario, platform, target and got keys, path);
each failing check with its evidence; ranked groups with points lost; coverage gaps; the delta.

- [ ] **Step 1: Failing tests:** `the table shows — for a dimension with no check`; `each app's score shows its runs
  left out beside it`; `held-out is its own table`;
  `a wrong send is listed by keys and path, never by text`; `evidence holding os.tmpdir(), HOME or a /work/eval-
  folder is printed with that part replaced by <path>`; `writeReport writes report.json and report.md`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/report.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS; typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 8: Runner, and the tier A spec on it

**Files:** Create `cli/src/testing/dialAppEval/runner.ts`, `runner.spec.ts`; Modify `dialAppEval.spec.ts`.
**Depends on:** 4, 5. **Effort:** high.

**Interfaces:** Produces
```ts
export const SETTLE_END_MS = 6_000                   // after the last step: past the largest half threshold (5 s)
export interface ScenarioRun { scenario: string; platform: Platform; results: CheckResult[]; probes: CheckResult[];
  wrongSends: WrongSend[]; gaps: CoverageGap[] }
export async function runScenario(driver: EvalDriver, scenario: Scenario, platform: Platform): Promise<ScenarioRun>
export function uncaughtProbes(run: ScenarioRun): string[]   // probe ids with no result < 1 carrying evidence
export function collect(runs: readonly ScenarioRun[]): RunResults
export function writeResults(dir: string, source: 'spec' | 'claude' | 'chatgpt' | 'heldOut', results: RunResults): string
export function readResults(dir: string): RunResults          // every results-*.json in dir, merged
```
`runScenario`: `start`, each step (`wait` → `settle(ms, until && (() => holds(check, …)))`, else `step`), `settle
(SETTLE_END_MS)`, `stop` (also on a throw), then evaluate checks and probes on `seen()`. Driver gaps → no results, the
gaps listed with the scenario's `app`. `StepNotBuilt` propagates.

- [ ] **Step 1: Failing tests** in `runner.spec.ts` with a scripted fake driver: `steps run in order and labels are
  timed`; `a wait ends as soon as its check holds`; `the world settles 6 s after the last step`; `a driver's gap drops
  the scenario's results and lists it with its app`; `checks are evaluated on what the driver saw through its stop`; `probes are evaluated apart and not in the results`; `results files round-trip
  and merge`; `the driver stops when a step throws`. In `dialAppEval.spec.ts`, replace Task 4's C1 case with:
  `describe.each(platforms)` → `it.for(scenariosFor('a', platform))('$id', async (scenario, { skip }) => …)` (skip on
  `StepNotBuilt`; assert `wrongSends` empty and `uncaughtProbes` empty), keep the twice-run case on the runner, add
  `no result carries an absolute path` (none of `tmpdir()`, `HOME`, `/work/eval-` in any result), and `afterAll` writes
  `results-a-spec.json` to `DIAL_EVAL_OUT` when set.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/runner.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run src/testing/dialAppEval/` → PASS (C1 on three platforms, its probe caught);
  `DIAL_EVAL_OUT=$(mktemp -d) npx vitest run src/testing/dialAppEval/dialAppEval.spec.ts` writes the file; typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 9: Catalog: the 28 scenarios and their probes

**Files:** Modify `cli/src/testing/dialAppEval/catalog.ts`; Create `heldOut.ts`, `catalog.spec.ts`.
**Depends on:** 4. **Effort:** high.

`heldOut.ts` opens with: "Held out (docs/plans/2026-11-21-dial-app-eval-design.md, Held-out set): whoever fixes a
failing group of the dial eval does not read this file." Sessions: keys as below, `Eval <Name>` titles, `/work/eval-
<key>` folders, fixed UUIDs. Platforms: all three unless named. Tiers `['a', 'b']` unless "A only". Unless a row says
otherwise: a row's sessions are written to their app's store by its first step (`claude.write` or `codex.write`), "with
processes" adds a `hook start` for each, ages rise with the key's order (a, t1, s01 newest, 60 s apart), and a ChatGPT
thread's Codex name is its title. Every scenario whose tiers hold `b` also gets the check `cost` (D8) and D8 in its
dims (PM, 2026-11-21); the table does not repeat it. `p` = probe, always on a ghost `z` (open / focus / ring with `z` added / state /
recap / voice to `z`).

| Id | Setup and steps (labels in quotes) | Checks | p |
|---|---|---|---|
| C1 | a-e Claude app, ages 60-300 s; claude.write a-e | ring D1 claude [a..e] | ring |
| C2 | a-c; write; wait until ring; "archive": write b archived | ring D1 timed after archive [a,c]; ring D7 [a,c] | ring |
| C3 | s01-s30, ages 1-30 min; write | ring D1 [s01..s16]; ring D7 same. A only | ring |
| C4 | a; write; wait; "tap": tap a | open D3 a link | open |
| C5 | a, b with processes (hook start); front claude; swipe a; "attach": attach b | focus D2 b after attach | focus |
| C6 | a with a process; "turn": turn-start; wait 5 s; "stop": turn-stop "Eval answer one." | state D4 working after turn; state D4 done after stop; recap D6 a | recap |
| C7 | a, b with processes; turn-start a; "ask": needs-input a permission | state D4 needs-you a after ask | state |
| C8 | a resumable, resting; front claude; swipe a; "voice": voice "Eval words for alpha." → a | open D3 a link after voice; voice D5 a | voice |
| C9 | front claude; write a (no hook); "swipe": swipe a; "hook": hook start a | open D3 a link after swipe; ring D1 after hook [a]; ring D7 [a] | open |
| C10 | a, b; write; hook start both; wait until ring; "quit": quit claude; wait 2 s; "relaunch": relaunch claude | ring D7 after relaunch [a,b]; ring D1 after relaunch [a,b] | ring |
| C11 | a, b; write; swipe b; "unplug": unplug; wait 3 s; "replug": replug | ring D7 after replug [a,b]; focus D7 b after replug | focus |
| X1 | projects order [p2, p1, p3]; t1 p1 10 s, t2 p1 50 s, t3 p2 30 s, t4 p2 20 s, t5 p3 40 s, t6 none 5 s, t7 none 60 s, t8 p3 70 s; names set; codex.write all | ring D1 chatgpt [t4,t3,t1,t2,t5,t8,t6,t7] (design 2026-11-19, "The sidebar's order") | ring |
| X2 | t1, t2; front chatgpt; swipe t1; "title": thread t2's name | focus D2 t2 after title | focus |
| X3 | darwin only; t1, t2; write; wait until ring; "front": front chatgpt; wait 5 s; "tap": tap t2 | still D2 5 s after front; ring D7 [t1,t2] after front; open D7 t2 link after tap | open |
| X4 | t1; write; "tap": tap t1 | open D3 t1 link | open |
| X5 | t1 (read only); world.linkFails chatgpt; "tap": tap t1 | open D3 t1 link: false | open |
| X6 | t1-t3; write; "archive": write archived [t2], ages {t3: 1 s} | ring D1 timed after archive [t3,t1]; ring D7 same | ring |
| X7 | b0000-b1999 (ages ascending, no project); write walBusy; fresh | ring D7 [b0000..b0015] | ring |
| X8 | t1; hook start; "turn": turn-start; "stop": turn-stop "Eval codex answer." | state D4 working after turn; state D4 done after stop; recap D6 t1 | recap |
| X9 | t1 with a running session (hook start), idle; swipe t1; "voice": voice "Eval words for one." → t1 | voice D5 t1 | voice |
| X10 | t1 ChatGPT and c1 Codex CLI (`cli`, source cli in `threads`), both /work/eval-shared; write; hook start c1 | ring D1 chatgpt [t1] | ring |
| X11 | t1-t3; front chatgpt; swipe t1; thread t2; wait 300; thread t1; wait 300; "last": thread t2 | focus D2 t2 after last, noBounce; focus D7 same | focus |
| CH1 | s01-s16; write; wait; "new": write s00 (age 30 s) | ring D1 after new [s00, s01..s15]. A only | ring |
| CH2 | a, title "Eval 🎉 " + 70 more characters; write | ring D1 [a] (its name the title rule's). A only | ring |
| CH3 | a, b with processes; turn-start b; swipe a; "voice": voice "Eval words for alpha." → a | voice D5 a | voice |
| XH1 | t1, t2; write; "rename": write names {t1: "Eval Renamed"} | ring D1 after rename [t1,t2]. A only | ring |
| XH2 | a Claude, t1 ChatGPT; world.front claude; "front": front chatgpt; "title": thread t1's name | focus D2 t1 after title | focus |
| XH3 | t1, t2; front chatgpt; swipe t1; "follow": thread t2; wait 200; "voice": voice "Eval words for two." → t2 | voice D5 t2 | voice |

- [ ] **Step 1: Failing tests** in `catalog.spec.ts`: `the ids are C1-C11, X1-X11 and the six held out, 6 of 28`;
  `each scenario's checks cover exactly its dims` (CH3 and XH3: D5); `X3 is macOS only`; `C3, CH1, CH2 and XH1 are tier A
  only, every other scenario (C10, C11, X7, C8, X9, CH3 and XH3 among them) runs in tier B`; `each tier B scenario
  carries exactly one cost check, D8, and the tier A only ones none`; `every key a step or check names is declared, and only probes name a
  ghost`; `every title starts with "Eval " and every folder with /work/eval-`; `every scenario has a probe, and each
  step kind but wait is used by a scenario whose probe can see it` (claude.write, codex.write, quit, relaunch → ring;
  unplug, replug → ring or focus; hook → state or recap; tap, swipe → open or focus; front, thread, attach → focus or
  open; voice → voice); `the held-out file says it is not to be read`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/catalog.spec.ts` → FAIL.
- [ ] **Step 3:** Write the scenarios (`HELD_OUT` from `heldOut.ts`).
- [ ] **Step 4:** Same command → PASS; `npx vitest run src/testing/dialAppEval/` → PASS (scenarios needing unbuilt
  kinds skip); typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 10: The eval command

**Files:** Create `cli/src/testing/dialAppEval/run.ts`, `run.spec.ts`; Modify `cli/package.json` (`"eval:dial-apps":
"tsx src/testing/dialAppEval/run.ts"`). **Depends on:** 6, 7, 8. **Effort:** high.

**Interfaces:** Produces `export function parseArgs(argv: string[]): { tiers: Tier[]; update: boolean }` (`--tier a|b`,
`--update-baseline`; anything else a usage error) and `export async function main(argv: string[], deps: { exec(cmd:
string, args: string[], env: NodeJS.ProcessEnv): Promise<number>; out?: string; platform: NodeJS.Platform; log(line:
string): void }): Promise<number>`. Tier A: `npx vitest run src/testing/dialAppEval/dialAppEval.spec.ts`; tier B:
`npx vitest run --config vitest.e2e.config.ts e2e/dialAppEvalClaude.e2e.ts e2e/dialAppEvalChatgpt.e2e.ts
e2e/dialAppEvalHeldOut.e2e.ts`, each with `DIAL_EVAL_OUT` (default a new temp folder, printed). Then `readResults`,
`grade` against `loadBaseline()`, print `summary`, `writeReport`. Exit 1 when a tier wrote no results or the gate failed,
else 0, whatever the score; a child's ratchet failure is printed, not fatal. `--update-baseline` writes
`updateBaseline(…)` to `BASELINE_PATH`, and refuses when the gate failed: "a voice prompt reached another session:
stop and ask the PM before a baseline is written". On win32, tier B is not run and the report says why.

- [ ] **Step 1: Failing tests** (fake `exec` writing fixture results): `argument errors name the usage`; `tier a then b,
  merged into one report in DIAL_EVAL_OUT`; `--tier b runs only the e2e files`; `a tier with no results exits 1`;
  `a low score exits 0`; `--update-baseline writes the baseline, keeping the tier not run`; `and refuses on a wrong
  send`; `tier B is not run on Windows`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/run.spec.ts` → FAIL.
- [ ] **Step 3:** Implement; the script entry calls `main(process.argv.slice(2), realDeps)`.
- [ ] **Step 4:** Same command → PASS; typecheck; `npm run eval:dial-apps -- --tier a` prints a report.
- [ ] **Step 5:** Commit red, then green.

### Task 11: Tier A: the ChatGPT app's store

**Files:** Modify `cli/src/testing/dialAppEval/tierA/steps/codexStore.ts`; Create `codexStore.spec.ts` beside it.
**Depends on:** 8, 9. **Effort:** high.

`codex.write`: rows to `threads` (`recencyAtMs = now − ageMs`; `ages` override; `archived`; `cli` sessions with source
`cli`), `.codex-global-state.json` (`projects` order, each session's project), `session_index.jsonl` names (titles,
then `names`); `walBusy` holds a write in the WAL through `codexHome.writer()` until the scenario stops; then
`storeChanged` for each file written.

- [ ] **Step 1: Failing tests** (a fake world): `writes the threads, the sidebar's projects and Codex's names, then
  tells the watch each file`; `archived and ages rewrite those rows`; `walBusy keeps a write open in the WAL`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/tierA/steps/codexStore.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS; `npx vitest run src/testing/dialAppEval/` → X1, X6, X7, XH1 run on three
  platforms (not skipped), probes caught; typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 12: Tier A: live sessions (hooks, the Claude mod, quit, relaunch)

**Files:** Modify `tierA/steps/sessions.ts`; Create `tierA/steps/sessions.spec.ts`. **Depends on:** 8, 9.
**Effort:** high.

**Interfaces:** Produces `export async function startSession(world: TierAWorld, key: SessionKey): Promise<void>` (Task
14's fake apps call it) and `sessionsSteps` for `hook`, `quit`, `relaunch`.
- `hook`: `start` → `startSession`: a process in `machine` (pid `41000 + index`, its app as the platform tells it:
  `learnApps`' answer, `hostHints` with the app's hints), its transcript in `world.folders`, `machine.owners`, then
  `ports.devices.observed({ … event: 'session-start' })`; for Claude, the mod: a loop holding
  `ports.devices.inboxPoll({ pollId, sessionId })` open, each answered text a `mod` delivery to that session.
  `turn-start`, `needs-input` (`asks`), `turn-stop` (the last answer appended to the transcript, and in the event as
  the core passes it), `end` (closes the poll). Read `cli/src/core/observedHook.ts` for the event's fields.
- `quit`: for each live session of the app, `end`, then its process out of `machine`. `relaunch`: `startSession` for
  each session the quit ended.

- [ ] **Step 1: Failing tests:** `start puts the process in the machine, tells the devices and opens the mod's poll`;
  `an answered poll is a mod delivery to that session, and the mod polls again`; `turn-stop writes the last answer
  where readLastAnswer reads it`; `quit ends the app's sessions and relaunch starts them again`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/tierA/steps/sessions.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS; tier A spec: C6, C7, C10 run (with Task 11: X8, X10); typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 13: Tier A: the dial and the windows (tap, swipe, unplug, replug, thread, attach)

**Files:** Modify `tierA/steps/dial.ts`, `tierA/steps/window.ts`; Create `tierA/steps/dial.spec.ts`,
`tierA/steps/window.spec.ts`. **Depends on:** 8, 9. **Effort:** high.

`tap` → `dial.tap(agentId)`; `swipe` → `dial.swipe(agentId)` (its rest follows on the cable's own timer); `unplug` /
`replug` → the loopback port closes and discovery stops answering / answers again; `thread` → `listener.thread` with
`{ thread: title }` as the watch sends it; `attach` → `listener.attach` with the session as the mod sends it.

- [ ] **Step 1: Failing tests:** `tap sends agent.open and swipe sends focus for the session's id`; `unplug closes the
  port and replug lets discovery find it again`; `thread and attach reach the listener's handlers as the watch and the
  mod send them`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/tierA/steps/dial.spec.ts
  src/testing/dialAppEval/tierA/steps/window.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS; tier A spec: C4, C11 run (with 11: X2-X5, X11, XH2; with 12: C5, C9);
  win32's opens are graded at `harness-pty open-link`; typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 14: Tier A: voice, and the fake apps that answer links

**Files:** Modify `tierA/steps/voice.ts`, `tierA/driver.ts` (install the fake apps at `start`); Create
`tierA/fakeApps.ts`, `tierA/steps/voice.spec.ts`, `tierA/fakeApps.spec.ts`. **Depends on:** 11, 12, 13.
**Effort:** high.

`voice`: `world.speech = transcript`, then `dial.voice([pcm])` with a short made-up PCM buffer; `transcribe` answers
`world.speech`. Fake apps (`world.answer`): a `claude://code/continue?session=<localId>` or `codex://threads/<id>`
command (open, xdg-open or open-link) for a `resumable` session not live → `startSession`; answer code 0 (1 for
`world.linkFails`).

- [ ] **Step 1: Failing tests:** `voice sets the transcript and sends voice.begin, the audio and voice.end`;
  `a link for a resumable resting session starts it once`; `a link for another session starts nothing`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/tierA/steps/voice.spec.ts
  src/testing/dialAppEval/tierA/fakeApps.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS; `npx vitest run src/testing/dialAppEval/` → every scenario runs on every
  platform, none skipped, no wrong send; C8's `voice` and `open` parts score 0 (expected: not built). A wrong send here
  stops the task: report it. Typecheck.
- [ ] **Step 5:** Commit red, then green.

## Tier B

### Task 15: The Claude store fixture refuses the real store

**Files:** Modify `cli/src/testing/claudeAppFixture.ts`; Create `cli/src/testing/claudeAppFixture.spec.ts`.
**Depends on:** -. **Effort:** medium.

`claudeAppFixture(root)` throws `the Claude app fixture never writes the real Claude app store` when `resolve(root)` is,
or is inside, a root of `claudeStoreRoots(process.platform, process.env, userInfo().homedir)` (the account's own home,
as `codexAppFixture` reads it), before any write.

- [ ] **Step 1: Failing tests:** `refuses each root of the account's own store, and a folder inside one`; `writes a
  temp store as the app does`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/claudeAppFixture.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; `npx vitest run src/cable/hosts/claudeAppStore.spec.ts` → PASS; typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 16: `corePerf.cjs` measures the devices process

**Files:** Modify `cli/e2e/harness/corePerf.cjs`; Test `cli/src/testing/corePerf.spec.ts`. **Depends on:** -.
**Effort:** medium.

The preload also runs for `__service` with `HARNESSD_SERVICE=devices` when `HARNESS_E2E_PERF_DEVICES=1`; its ready file
is `core-<pid>.json` as for the others.

- [ ] **Step 1: Failing test:** `measures the devices service when asked, and not without HARNESS_E2E_PERF_DEVICES`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/corePerf.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS.
- [ ] **Step 5:** Commit red, then green.

### Task 17: The Claude mod's inbox poll in the e2e harness

**Files:** Create `cli/e2e/harness/modInbox.ts`; Modify `cli/e2e/deviceWithoutApp.e2e.ts`,
`cli/e2e/deviceClaudeOrca.e2e.ts`. **Depends on:** -. **Effort:** medium. No behaviour change: one commit.

**Interfaces:** Produces `export function inboxPoll(d: IsolatedDaemon, sessionId: string, signal?: AbortSignal):
Promise<{ status: number; body: unknown }>` (body `null` when empty), the POST both files make today.

- [ ] **Step 1:** Move the helper; both files import it (`deviceClaudeOrca` reads `.status`).
- [ ] **Step 2:** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts
  e2e/deviceClaudeOrca.e2e.ts` → PASS.
- [ ] **Step 3:** Commit.

### Task 23: One network guard for every eval test

**Files:** Create `cli/src/testing/dialAppEval/netGuard.cjs`, `cli/src/testing/dialAppEval/netGuard.ts`,
`cli/src/testing/dialAppEval/netGuard.spec.ts`; Modify `cli/src/testing/dialAppEval/dialAppEval.spec.ts`.
**Depends on:** 8. **Effort:** high.

Why (PM, 2026-11-21): a devices spec's red run posted to the production backend's speech-to-text, and tier A, before a
fix, opened 4-5 WebSockets to `wss://harness-api.autonomous.ai/api/device-ws` with the machine's hostname in a query
parameter. Every eval test, tier A and tier B, runs under one guard: a connection to anything but this machine fails
the test, naming its host and port, never its path, query or payload.

**Interfaces:**
- Produces:
  ```ts
  // netGuard.cjs: the one implementation, plain CommonJS on Node's built-ins only, so `--require` loads it into any Node
  // (as e2e/harness/corePerf.cjs). Required with HARNESS_E2E_NET_GUARD_FILE set it installs itself, appending one
  // JSON line per event to that file (mode 0o600); without it, it installs nothing.
  // netGuard.ts: the typed door every TS caller uses
  export const NET_GUARD_PRELOAD: string                 // absolute path of netGuard.cjs
  export const NET_GUARD_FILE_ENV = 'HARNESS_E2E_NET_GUARD_FILE'
  export interface NetAttempt { api: 'net' | 'tls' | 'dgram' | 'dns'; host: string; port: number | null
    pid: number; process: string }   // process: HARNESSD_SERVICE under `__service`, `core` (`__run`), `master`
                                     // (`__harnessd`), else `node`; never a path or an argument
  export function isLocal(host: string | undefined): boolean
  export function guardThisProcess(): { taken(): NetAttempt[] /* since the last call, then cleared */; uninstall(): void }
  export function readNetGuard(file: string): { loaded: Array<{ pid: number; process: string }>; attempts: NetAttempt[] }
    // a missing file: both empty
  export function netGuardEnv(file: string, nodeOptions?: string): { NODE_OPTIONS: string; HARNESS_E2E_NET_GUARD_FILE: string }
    // `--require=<NET_GUARD_PRELOAD>` first, then the NODE_OPTIONS given (corePerf's preload) kept
  export function describeAttempt(a: NetAttempt): string   // `<process> <api> <host>:<port>`
  ```
- What it guards: `net.Socket.prototype.connect` (the one door of `net.connect`, `tls.connect`, `http(s).request`, the
  `ws` package, `fetch` and the global `WebSocket`), read in each form Node passes (an options object, `(port, host)`,
  `(path)`, the normalized array `net.connect` hands on); `dgram.Socket#send` and `#connect`; `dns.lookup`,
  `dns.promises.lookup` and the `resolve*` functions of both. If a Step 1 case shows an entry point that does not pass
  through these, wrap it too, recorded the same way.
- Local: no host (Node's default), `localhost`, `*.localhost`, `127.0.0.0/8`, `0.0.0.0`, `::1`, `::`, `::ffff:127.*`
  (bracketed too), and any `path` (a Unix socket or a named pipe). Everything else is not, the machine's own hostname
  and its LAN addresses included (a lookup of the hostname can leave the machine).
- A refused attempt: recorded (the in-process list, or a `{ kind: 'attempt', … }` line), then the caller sees a
  connection failure on the next tick (`process.nextTick`, never a timer, so tier A's fake clock does not hold it): the
  socket destroyed with an `ENETUNREACH` error `the dial eval reaches no network: <host>:<port>`, a dgram callback or
  `error` event with it, a lookup with `ENOTFOUND`. The product's own error path runs; the test fails on the record.
  At install the file preload writes `{ kind: 'loaded', pid, process }`, so a caller can prove the guard is in a
  process (Task 18).
- Tier A (`dialAppEval.spec.ts`): the `fetch` stub and the `ws` mock go; `guardThisProcess()` in `beforeAll`,
  `uninstall` in `afterAll`, and `afterEach` expects `taken().map(describeAttempt)` to equal `[]` beside the processes
  `reached` (the `child_process` refusal stays: it is about processes, not the network). The header says the guard is
  the one way the spec refuses the network.

- [ ] **Step 1: Failing tests.** `netGuard.spec.ts` (never a real host: `192.0.2.1` and `example.invalid` only):
  `fetch, a ws WebSocket, the global WebSocket, net.connect, a net.Socket's connect, tls.connect, http.request and
  https.request to a host off this machine each fail and are each recorded by host and port` (`it.each` over the eight);
  `a URL's path, its query and a request's body are never recorded` (a fetch POST to
  `http://example.invalid:9/stt?hostname=eval-marker-host` with body `eval-marker-body`: the attempt is
  `{ host: 'example.invalid', port: 9 }`, and neither marker is in the JSON of `taken()` or in the error's message);
  `localhost, 127.0.0.1, ::1 and a Unix socket (a named pipe on Windows) still connect` (a local server answers each);
  `a lookup of example.invalid is refused and recorded, and localhost resolves`; `a dgram send to 192.0.2.1 is refused
  and recorded, and one to 127.0.0.1 arrives`; `uninstall puts every entry point back`; `preloaded through
  netGuardEnv into a child Node with __service and HARNESSD_SERVICE=devices, the file records it loaded as devices and
  its attempt on 192.0.2.1, and its local connection works` (a child spawned as `corePerf.spec.ts` spawns its own);
  `netGuardEnv keeps the NODE_OPTIONS it is given`; `without its file the preload installs nothing`.
  `dialAppEval.spec.ts`: `tier A reaches no network: a fetch to example.invalid fails and the guard names it`
  (`taken()` holds `example.invalid`, which clears it for `afterEach`).
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/netGuard.spec.ts
  src/testing/dialAppEval/dialAppEval.spec.ts` → FAIL (module missing).
- [ ] **Step 3:** Write `netGuard.cjs` and `netGuard.ts`; move the tier A spec onto the guard.
- [ ] **Step 4:** Same command → PASS, every tier A scenario that ran before still runs, none fails on the guard;
  `npm run typecheck`.
- [ ] **Step 5:** Commit red, then green.

### Task 18: Tier B driver core, its cost meter, and C1 on the real daemon

**Files:** Create `cli/e2e/harness/appEvalDriver.ts`, `cli/e2e/harness/appEvalCost.ts`,
`cli/e2e/harness/appEvalClaude.ts`, `cli/e2e/harness/appEvalChatgpt.ts`, `cli/e2e/dialAppEvalClaude.e2e.ts`.
**Depends on:** 4, 8, 16, 23. **Effort:** high.

**Interfaces:**
- Consumes: Task 23's `guardThisProcess`, `netGuardEnv`, `readNetGuard`, `describeAttempt`.
- Produces:
  ```ts
  export interface TierBWorld {
    readonly d: IsolatedDaemon; readonly desk: Desk; readonly dial: FakeDial
    readonly scenario: Scenario; readonly platform: Platform
    now(): number; agentId(key: SessionKey): string; session(key: SessionKey): SessionDef
    deliver(d: Omit<Delivery, 'at'>): void; gap(reason: string): void
    readonly children: ChildProcess[]                    // ended at stop
  }
  export type TierBHandler<K extends StepKind> = (world: TierBWorld, step: StepOf<K>) => Promise<void>
  export class TierBDriver implements EvalDriver {
    close(): Promise<void>                               // one per e2e file; close in afterAll
    networkReached(): string[]                           // describeAttempt of each attempt since the last call
  }
  // appEvalCost.ts
  export async function beginCost(d: IsolatedDaemon): Promise<{ end(): Promise<NonNullable<Seen['cost']>> }>
  // appEvalClaude.ts / appEvalChatgpt.ts: claudeSteps / chatgptSteps for that app's sessions:
  //   'claude.write' (built here), 'codex.write', 'hook', 'attach', 'quit', 'relaunch' (stubs: StepNotBuilt(kind, 'b'))
  ```
- `start`: a daemon (`IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })`, the fake backend signed in for
  voice as `deviceWithoutApp.e2e.ts` does), its open, home and stores checked inside its root before it starts; a new
  one for the first scenario and each `fresh` one, else the last one reset (fixtures removed, children ended, the dial
  unplugged and plugged, the ring empty before going on). The dial plugged with `{ appFilter: 'v1' }`, the page picked,
  the front app sent. Generic steps here: `front` and `thread` on the stdin of the real `harness hardware watch --json`
  (as `dialChatgptFollow.e2e.ts`), `tap`, `swipe`, `unplug`, `replug` (`Desk`), `voice` (`backend.speech`, then the
  dial's voice frames). `Seen`: frames from `dial.messages`, faces from `dial.carousel()` after each frame, commands
  from `opens.log` (`HARNESS_OPEN_BIN`), wall ms since start. On Linux, `writeSchemeApps` for both schemes.
- Cost, every scenario (PM, 2026-11-21): each daemon is created with `HARNESS_E2E_PERF_DEVICES=1`, its own perf dir and
  token and `NODE_OPTIONS=--require <corePerf.cjs>`. `beginCost` at the end of `start` (time 0): the devices pid
  (`devicesPids`), its CPU time by `ps`, corePerf's `/start` on that process, and the root's process list
  (`src/testing/rootProcesses.ts`). `end()` after `stop`'s cleanup: CPU by `ps` again over the wall time
  (`cpuPercent`), corePerf's `/end` `eventLoop.p99Ms` (`loopP99Ms`), and `leftovers`: processes under the root that were
  not there at begin, are not the daemon's own (`harnessd`, `harnessd-core`, `harnessd-<process>`) and still run.
  `seen().cost` holds it.
- The network guard (Task 23), on every tier B process: the constructor calls `guardThisProcess()` (the e2e test
  process), `close()` uninstalls it. Each daemon, after `IsolatedDaemon.create` and before `start` (as
  `enginehomes.e2e.ts` sets `d.env.NODE_OPTIONS`): `Object.assign(d.env, netGuardEnv(join(d.root, 'net-guard.jsonl'),
  '--require=<corePerf.cjs>'))`. Every child the driver or a step starts (`world.children`, `harness hardware watch`)
  gets the same two variables. At the end of `start`, `readNetGuard(file).loaded` must hold `core` and `devices`, else
  `start` throws `the network guard is not in the <process> process`. `networkReached()` gives `taken()` and the file's
  attempts not given before; the driver reads the file at each `stop` and before it closes a daemon (the root goes with
  it).
- `dialAppEvalClaude.e2e.ts`: `describe.skipIf(win32)`, one `TierBDriver`, `it.for` over `scenariosFor('b', host)`
  filtered to the Claude app, skip on `StepNotBuilt`; asserts no wrong send, no uncaught probe and
  `driver.networkReached()` equal to `[]` (also for a skipped scenario: a step before the unbuilt one may have reached
  out); `afterAll` writes `results-b-claude.json` to `DIAL_EVAL_OUT` when set.

- [ ] **Step 1: Failing test:** write `dialAppEvalClaude.e2e.ts` with C1 and `the network guard is in the core and the
  devices process, and a connection from the devices process to 192.0.2.1 fails the run naming it` (the driver's guard
  file given a hand-written attempt line: `networkReached()` names `devices net 192.0.2.1:9`); `cd cli &&
  TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialAppEvalClaude.e2e.ts` → FAIL (driver missing).
- [ ] **Step 2:** Implement the driver core, the generic steps and `claude.write`.
- [ ] **Step 3:** Same command → C1 passes, its probe caught, its `cost` check giving `cpu`, `loopP99` and
  `leftovers` results, no network reached; the rest skip. Print each scenario's wall time.
- [ ] **Step 4:** Commit red, then green.

### Task 19: Tier B: the Claude app's scenarios

**Files:** Modify `cli/e2e/harness/appEvalClaude.ts`, `cli/e2e/dialAppEvalClaude.e2e.ts`.
**Depends on:** 9, 17, 18, 23. **Effort:** high.

`hook` through `Outside` (`outsideAgent.ts`) with the Claude app's hints (on Linux under the fake of the app), each live
session's mod poll held with `inboxPoll` (`mod` deliveries); `attach` through the real `harness device claude link
--json` and the mod's POST, as `dialClaudeAppFollow.e2e.ts`; `quit` ends the app's sessions, `relaunch` starts them
again; the fake Claude app follows `opens.log` and starts a `resumable` session whose continue link was run. Every
process these steps start (`Outside`, `harness device claude link`, the fake app's sessions) runs with the daemon's
`netGuardEnv` (Task 23) and goes in `world.children`.

- [ ] **Step 1: Failing test:** add `it('ran every Claude scenario of tier B')` (none skipped) → FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialAppEvalClaude.e2e.ts`
  → PASS, under 6 minutes on this Mac (report the time); no wrong send and no network reached (else stop and report).
- [ ] **Step 4:** Commit red, then green.

### Task 20: Tier B: the ChatGPT app's scenarios

**Files:** Modify `cli/e2e/harness/appEvalChatgpt.ts`, `cli/e2e/harness/codexOutside.ts`; Create
`cli/e2e/dialAppEvalChatgpt.e2e.ts`. **Depends on:** 9, 18, 23. **Effort:** high.

- `codex.write` with `codexAppFixture` in the daemon's `~/.codex` and the app installed as `dialChatgptFollow.e2e.ts`
  does (macOS Info.plist, Linux file under the root's stand-in for /usr/lib); `walBusy` through the fixture's
  `writer()`. `hook` through `CodexOutside`, whose `hook` gains `'Stop'` (its header updated) for X8's done and recap;
  `quit`/`relaunch` as for Claude. Codex queue sends recorded by the app's own Codex CLI fake (`codexAppCli.ts`) as
  `codex` deliveries. The fake ChatGPT app follows `opens.log` for `codex://threads/<id>`. X5: on macOS the root's
  `fake-open` exits 1 for a `codex:` link in that scenario; on Linux no `xdg-mime` app for `codex`. Every process these
  steps start (`CodexOutside`, the fake app's sessions) runs with the daemon's `netGuardEnv` (Task 23) and goes in
  `world.children`.
- The e2e file as Task 18's for the ChatGPT app (the same `networkReached()` assertion), with
  `it('ran every ChatGPT scenario of tier B')`.

- [ ] **Step 1: Failing test:** write the e2e file; `cd cli && TMPDIR=/tmp npx vitest run --config
  vitest.e2e.config.ts e2e/dialAppEvalChatgpt.e2e.ts` → FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Same → PASS (X3 runs on macOS, is filtered out on Linux), under 6 minutes; no wrong send and no
  network reached (else stop and report); `TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialCodexApp.e2e.ts e2e/deviceCodex.e2e.ts`
  → PASS (`CodexOutside`'s other users).
- [ ] **Step 4:** Commit red, then green.

## CI

### Task 21: `ci-plan.py`: linux-e2e runs the eval's files

**Files:** Modify `scripts/ci-plan.py`, `scripts/tests/test_ci_plan.py`, `docs/validation-and-release.md`.
**Depends on:** 2. **Effort:** high.

**Interfaces:** Produces beside `LINUX_E2E_ORCA_FILES`:
```python
LINUX_E2E_APP_EVAL_FILES = ("cli/e2e/dialAppEvalClaude.e2e.ts", "cli/e2e/dialAppEvalChatgpt.e2e.ts",
                            "cli/e2e/dialAppEvalHeldOut.e2e.ts")
LINUX_E2E_APP_EVAL_PATHS = ("cli/src/cable/hosts/", "cli/src/testing/dialAppEval/", "cli/src/testing/dialCarousel.ts",
                            "cli/e2e/harness/appEval*.ts", *LINUX_E2E_APP_EVAL_FILES)   # appEval*: PM, 2026-11-21
def linux_e2e_app_eval_path(path): ...          # listed() over the paths
```
`e2e_owners` adds linux-e2e for them; `select` keeps linux-e2e for their deletion (as Orca's); `e2e_plan` adds the
files with the same "not at <head>; update LINUX_E2E_APP_EVAL_FILES in scripts/ci-plan.py" guard. `DIAL_HOST_PATHS`
gains `cli/src/testing/dialCarousel.ts`.

- [ ] **Step 1: Failing tests:** `test_a_change_the_app_eval_covers_runs_its_e2e_files` (temp repo: a hosts file, the
  eval folder, the carousel, `cli/e2e/harness/appEvalDriver.ts` and a deletion each give the three files, and
  `cli/e2e/harness/appEvalNotes.md` does not; a head without one fails naming it);
  `test_the_app_eval_e2e_files_are_plain_and_run_on_linux`. Update `test_dial_host_files_and_adapters_run_the_dial_hosts_
  job_not_linux_e2e` (linux-e2e for a canary path or an app eval path), `test_a_change_to_the_orca_stand_in_or_adapter_
  runs_the_orca_e2e_files` (the hosts folder now runs the eval's files; `orca.ts` runs both lists; its temp repo holds
  the eval's files) and add `cli/src/testing/dialCarousel.ts` to the import walk's `within` in
  `test_the_dial_host_files_are_the_ones_cli_e2e_leaves_out`.
- [ ] **Step 2:** `python3 scripts/tests/test_ci_plan.py` → FAIL.
- [ ] **Step 3:** Implement. `docs/validation-and-release.md`: the linux-e2e row says a change to the eval's paths runs
  `LINUX_E2E_APP_EVAL_FILES` beside the PR's own, and a head without one fails the plan; the dial-hosts row lists
  `cli/src/testing/dialCarousel.ts`; the cross-read-scan paragraph's "four" tests read as `FullCheckoutTests.NAMES`.
- [ ] **Step 4:** Same → PASS; `CROSS_READ_SCAN_REQUIRED=1 python3 -c 'import sys; sys.path.insert(0, "scripts/tests");
  import unittest, test_ci_plan; unittest.main(module="test_ci_plan", argv=["x", *test_ci_plan.FullCheckoutTests.NAMES])'`
  → PASS.
- [ ] **Step 5:** Commit red, then green.

## Baseline

### Task 22: Held-out e2e file, baseline, ratchet, timing hints, scaffolding out

**Files:** Create `cli/e2e/dialAppEvalHeldOut.e2e.ts`, `cli/src/testing/dialAppEval/baseline.json`; Modify
`dialAppEval.spec.ts`, `cli/e2e/dialAppEvalClaude.e2e.ts`, `cli/e2e/dialAppEvalChatgpt.e2e.ts`, `types.ts`,
`tierA/driver.ts`, `cli/e2e/harness/appEvalDriver.ts`, `cli/ci-e2e-durations.json`; `catalog.ts` and `types.ts` only
if the budget fallback is needed. **Depends on:** 10, 14, 19, 20, 23. **Effort:** high.

- [ ] **Step 1:** Write `dialAppEvalHeldOut.e2e.ts` as Task 18's file over `HELD_OUT` (its header says whoever fixes a
  failing group does not read it), with the same `networkReached()` assertion; `results-b-heldOut.json`.
- [ ] **Step 2: Failing tests:** the tier A spec's last case `matches the baseline` (`tierAVerdict(collect(runs),
  loadBaseline()!)`, its message on failure) and each e2e file's `matches this platform's baseline`
  (`tierBVerdict(…, process.platform)`) → FAIL (no baseline).
- [ ] **Step 3: The baseline run** on this Mac at this head: `cd cli && TMPDIR=/tmp npm run eval:dial-apps --
  --update-baseline`. It writes tier A (darwin, win32, linux) and tier B darwin; no Linux tier B entry is written in
  this PR (PM, 2026-11-21). **If it shows any wrong-session send, or a test fails on the network guard, stop and report
  to the main session (the PM decides before anything merges).** Keep its `report.md` for the PR.
- [ ] **Step 4:** Same specs → PASS.
- [ ] **Step 5: Scaffolding out:** remove `StepNotBuilt` from `types.ts`, the drivers and the specs, the skips and the
  "ran every … scenario" cases (the network guard and its assertions stay); `npm run typecheck`; `npx vitest run src/testing/dialAppEval/` → PASS.
- [ ] **Step 6: Times.** The tier A spec's wall time under 60 s (else apply Task 4's fallback and redo Step 3 for tier
  A); each e2e file's time into `cli/ci-e2e-durations.json` (`durationMs`), each under about 6 minutes.
- [ ] **Step 7:** `npm test` → PASS; the three e2e files → PASS.
- [ ] **Step 8:** Commit red, then green.

---

## Verification

1. **Tier A on macOS** (this Mac, at the final head): `cd cli && npx vitest run src/testing/dialAppEval/` and
   `npm test`. Seen: all pass, the tier A spec under 60 s, `matches the baseline` green, no scenario skipped.
2. **Tier A on Linux:** PR CI's `cli-tests` (four shards) runs the same spec against the baseline written on macOS.
   Seen: green, which shows tier A gives the same results on another host. A difference there is a determinism bug
   (Review Focus 1), not a baseline to refresh.
3. **Tier B on macOS, by a tester** on this Mac, isolated by the e2e harness itself (each `IsolatedDaemon` has a
   throwaway root and home, its own data folder and socket, a private tmux, the in-memory fake backend with a made-up
   machine and token, `HARNESS_OPEN_BIN`'s recording `open`, fixtures checked inside the root; the everyday daemon on
   18473 is never reached): `cd cli && TMPDIR=/tmp npm run eval:dial-apps -- --tier b`. Seen: the three files pass,
   the report prints the score table (D8 scored for both apps, each app's runs left out beside its score), the
   held-out table and the ranked groups; no wrong-session send.
4. **Tier B on Linux:** PR CI's `linux-e2e` runs the three files (added files) on ubuntu-24.04, beside the canary (the
   harness changed) and the two files the PR modified (`deviceWithoutApp`, `deviceClaudeOrca`). Seen:
   `linux-e2e-summary` green, none of the three all skipped. Linux tier B is gate-only in this PR (PM, 2026-11-21):
   the files assert the gate and the probes there, not a baseline. If PR CI did not select them, run once by hand: **Actions → CI → Run
   workflow**, `scope=linux-e2e`, `e2e_files="cli/e2e/dialAppEvalClaude.e2e.ts cli/e2e/dialAppEvalChatgpt.e2e.ts
   cli/e2e/dialAppEvalHeldOut.e2e.ts"`. No other extra run.
5. **The network guard,** on this Mac: `cd cli && npx vitest run src/testing/dialAppEval/netGuard.spec.ts`, and in
   checks 1 and 3. Seen: every refused case names only `192.0.2.1` or `example.invalid` (no real host is ever tried),
   the local ones connect; in tier B every daemon's `net-guard.jsonl` lists `core` and `devices` as loaded and no
   attempt, and no eval test fails on the guard. On Linux, checks 2 and 4 run the same assertions. A test that fails
   on the guard is a product or harness leak to report, never one to allow.
6. **dial-hosts:** PR CI runs it for `fakeDial.ts` and `dialCarousel.ts` (`DIAL_HOST_PATHS`). Seen: green, none
   skipped. `windows-e2e` x64 also runs, for `cli/src/cable/cableHost.ts`.
7. **Local gates** at the final head from a clean tree: `cd cli && npm run typecheck`; `npm run test:core` (`devices.ts`
   at 100 %); `python3 scripts/tests/test_ci_plan.py`; then `python3 scripts/local-checks.py --run`, which selects
   every `cli-*` gate because `cli/package.json` changed (core, harnessd, orchestrator, sharing, resume,
   remote-viewers, portability, local-models, serial, pty, shell); its fence pasted into the PR body.
8. **PR evidence:** the baseline run's report (score per app and dimension, held-out score, the top groups by points
   lost), the red-then-green commits, the times (tier A total, each e2e file), platforms: macOS and Linux run, win32
   graded in tier A by injection.
9. **Gaps named in the PR:** Windows tier B (proposal: add the three files to `windows-e2e`'s list in `windows.yml`,
   not in this PR); Harness Device's Accessibility prompt (X3's second half, the device app's own e2e); sleep/wake and
   log-export signals; Linux tier B baseline entries (a later item; gate-only here, PM 2026-11-21); the network guard
   reaches the daemon's Node processes and the Node children that inherit its NODE_OPTIONS, not its non-Node ones
   (tmux, zsh, `harness-pty`, the native helpers, the fake `open`).
10. **After merge** (main session, with the PM): run both tiers on `main` and report each app's score per dimension,
   the held-out score and the top failing groups with a one-line cause each.

No check needs a real account, a person's login or production: every account is the fake backend's made-up machine.
