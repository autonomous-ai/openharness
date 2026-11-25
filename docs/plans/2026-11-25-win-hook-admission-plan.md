# A session's hooks are never lost while it is being admitted Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Every hook an engine sends for its session reaches the core in order, and a session is bound to its agent as
soon as its engine's own verified process identifies it: a resumed row takes the conversation its process reports (A),
a binding with no time orders nothing (B), a session's follow-up hooks wait behind its admission instead of being
refused (C), and engine settings files are read with or without a UTF-8 BOM (D).

**Architecture:** A: `registry.register` loses its `RESUME_SESSION_MISMATCH` branch, so a never-hooked resumed row
rotates onto the reported conversation as a `/clear` does; the Hermes terminal pass loses the step that existed only to
get past that branch. B: `createAdmissionOrder` sets no watermark from an untimed binding and lets a timed hook pass an
untimed accepted watermark it arrived after. C: a new core module, `core/engines/sessionHookWait.ts`, keeps per session
(engine and session id) the admissions the hook server has read and not settled, and the follow-up hooks waiting behind
them; `hookServer.ts` tells it when an admission starts and ends, answers a waiting hook `200 {pending: true}`, and
replays it later through the same route code an arriving hook runs. D: one helper, `lib/settingsText.ts`, decodes
settings bytes without a leading BOM; `inspectHookFile` and every other reader of the same files use it.

**Tech Stack:** TypeScript (Node 24), Vitest 4, the end-to-end harness (`cli/e2e`, a private tmux server, the fake
engines `cli/e2e/harness/fakeEngine.mjs`). All commands run in `cli/` unless they say otherwise.

**Spec:** `docs/plans/2026-11-25-win-hook-admission-design.md` (read it with this plan). The orchestrator's decisions of
2026-11-25 are final: A drops the branch and keeps the clients' `RESUME_SESSION_MISMATCH` handling (older daemons send
it); B as the spec's section 2; C is hold-and-replay in the hook server, per session, with the settlement, order and
bounds of the spec's section 3; D uses one helper and rewrites without a BOM; every OS; logs name no stored string, path
or prompt.

## Global Constraints

- **Core.** `npm run test:core` holds 100% per file for every `src/core/` file this plan touches
  (`core/agents/hermesTerminal.ts`, `core/engines/admissionOrder.ts`, the new `core/engines/sessionHookWait.ts`).
  Two new files join the core's process, each with its line in `src/architecture.coreFiles.txt` (sorted) in the task
  that first imports it, and its reason in the pull request: `core/engines/sessionHookWait.ts` (every session's
  follow-up hooks pass through it while the session is admitted) and `lib/settingsText.ts` (every engine launch's hook
  install reads the engine's settings through it). `core/main.ts` changes only in Task 2, wiring only.
- **No fixed sleeps in tests.** Timers are the test's (`vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`,
  leaving `setImmediate` real so HTTP replies flow) or the test waits on an event, a file or a frame. The fake engine's
  new gates are files the test writes, not delays.
- **Logs.** Fixed words, `sid(sessionId)`, counts and `errorKind(error)` only: never a body, path, prompt, delivery id
  or reason text from a hook (`src/architecture.failureLogs.spec.ts`, #4531). The new lines, exactly:
  - `[hooks] <sid> <route> waits for its session's admission` — once per session per admission ahead of it;
  - `[hooks] <sid> waiting hooks ran · <n>` — when a session's waiting hooks have all run after their admissions
    settled;
  - `[hooks] <sid> <route> runs unheld · <reason>`, `<reason>` one of `session_full`, `core_full`, `timed_out` — one
    per hook that did not wait or stopped waiting;
  - `[hooks] <sid> <route> waiting hook failed · <errorKind>`.
  A replayed hook still unbound is refused through today's once-a-minute line, `[hooks] <sid> <route> refused ·
  unbound`.
- **Bounds (C).** 32 waiting hooks per session, 256 across the core and 4 MiB of their bodies (`Buffer.byteLength` of
  the body's JSON), each waiting at most 120 s. Why these: a normal wait is under 3 s (the Windows tester's 2 to 3 s);
  the longest designed wait is the 20 s process-record wait plus 1 s retries, so 120 s is six times it; 32 per session
  is above the hooks one turn sends while a tool asks; a tool-start body can be 128 KiB, so the byte bound, not the
  count, caps memory.
- **Names and routes.** The six waiting routes are `turn-stop`, `wait`, `subagent`, `tool-start`, `turn-start`,
  `session-end`. The reply to a waiting hook is `200 {"pending": true}` (the hook client reads a pending turn-stop as
  held and the others as delivered, `hook/notify.mjs:490-492`). The Cursor and Command Code linked Stop
  (`X-Harness-Hook-Delivery-Id` naming a registration's receipt, `hookServer.ts:1052-1063`) keeps its own path, ahead of
  any wait.
- **Clients unchanged.** Desktop and mobile keep their `RESUME_SESSION_MISMATCH` copy (`app_state.dart`); fixtures that
  stand for a row an older daemon saved (`resumeAgentService.spec.ts:1206-1211`, `:1250`) stay.
- **Every OS.** Unit tests are platform-free and run on Linux CI; D's Windows-origin tests live in specs windows-e2e runs
  (`windowsHooks.spec.ts`, `folderTrust.spec.ts`); A, B and C reach Windows through the VM check (Verification).
- **Tests use throwaway homes and data folders only** (cli/AGENTS.md rule 6): never `~/.claude`, `~/.codex`, port
  18473 or the developer's tmux.
- **Commits.** Each task: one commit of its failing tests, then one of the change, staging only the files the task
  names (a task with no failing test is one commit). Commit nothing outside a task.
- **Pull request text.** Says plainly that the user's log has no create in it, so their stuck create is not proven to
  be D; lists the spec's "Found, not fixed here" items; names macOS, Linux and Windows.

## What this plan decides from the spec's words

- **Where the wait lives.** In `core/engines/sessionHookWait.ts`, beside `pendingAdmission.ts`, so it is a unit with
  its own 100% coverage; `hookServer.ts` holds one instance per server, closed with the server.
- **What settles an admission.** Per (session key, delivery id) the module counts the requests of that delivery still
  in their route handler, and whether its latest admission job is queued. A request counts from the moment its body
  parsed (before the Hermes gateway check and `resolveHookAgent`, so the 20 s process-record wait counts) until its
  handler returns; a job counts from just before `admissions.submit` until its `accept` callback has run `notify()` or
  its `reject` callback has run `completedReply`. The admission is settled when no request of it is in its handler and
  its latest job ended. This gives exactly the spec's rule: every `ignore` and every 400, 409 or 429 ends its request
  with no job; the `onWait` 202 leaves its request in its handler; a held or queued `200 pending` leaves its job queued;
  a re-sent delivery id while unsettled is the same admission, in its first place, and whichever request queued the
  latest job decides. An older job of the same delivery that ends late (one `pendingAdmission.submit` replaced) changes
  nothing.
- **When a hook waits.** Only when its body names an engine and a session, no row has that session id for that engine
  (`registry.bySession(id)?.engine !== engine`), and an admission of that key that arrived before it is unsettled.
  Otherwise it runs at once, as today, including a bound session's hook while one of its prompts is re-admitted.
- **Order.** Waiting hooks of a session run one at a time in arrival order; the head runs once no unsettled admission
  that arrived before it is left (a later admission never holds an earlier hook, and a hook ready implies every hook
  before it is ready). The run starts on a later turn of the event loop (`setImmediate`) after the settling call
  returned, so the bind's synchronous announcements (`onPromptSubmitted`, the start of `onRegistered`) come first.
- **Replay is the arrival's code.** Each route's normal path becomes one function `(body, firedAt) → {status, body}`;
  an arriving hook that does not wait writes its result, a replayed one writes nothing (its client left) and is logged
  only as the lines above say.
- **A (registry).** The guard keeps one rule: a resumed row with `lastHookAt === 0` or a launch that is not `ready`
  binds only a hook carrying a valid process identity. Another conversation is then an ordinary rotation (`rebound`,
  `earlierSessionIds`, `boundAt` now, `resumeOnly` and `launch: ready` kept by the existing entry build).
- **A (Hermes).** `hermesTerminal.ts:141-152` (the `endedSince` step) exists only to confirm the resumed session before
  the registry would fail its switch: it goes, with its dep, its wiring, `hermesSessionEndedSince` and
  `HERMES_SESSION_END`. The same-session confirm at `:123-126` stays: its commit binds the row (`boundAt`) and lets the
  resume's attach follow it (`bind.ts:874-875`); only its comment, which names the guard, changes.
- **B.** An untimed binding sets no watermark; an untimed binding of another conversation in the same scope also drops
  the watermark it replaces (a changed binding made outside the queue is newer authority, `admissionOrder.ts:24-25`); one
  of the same conversation keeps it. Against no watermark every hook of the process is current, a lone untimed one
  included (the spec: "every hook of the agent's current process is newer than it"). Against an accepted untimed
  watermark a timed hook that arrived after it is `current`, one that arrived before it `older`; an untimed candidate
  keeps today's arrival rule (`ambiguous`, so `HOOK_ORDER_UNTIMED`), and equal timed candidates and the queue's
  `leaders()` rule are unchanged.
- **D.** `settingsText(bytes)` is the one way: fatal UTF-8 decode that drops one leading BOM (`TextDecoder`'s default).
  `inspectHookFile` uses it, so every file it reads (JSON, Codex's `config.toml`, the YAML hook files) reads without a
  BOM and a rewrite publishes text with none; a file that differs from Harness's text only by its BOM is not rewritten
  (the engines read it). A UTF-16 file still fails the decode and is held as today. The other readers of the same files
  are Tasks 7 and 8 (see Open questions, 1).

## Review Focus

1. **A row an older build failed** (`launch: failed RESUME_SESSION_MISMATCH`, `active: false`, saved): after the update
   discovery confirms its engine and the next hook of another conversation rotates it; nobody has to act. Test: Task 1.
2. **A waiting Stop replayed right after a rotation's bind**, while `handleRegistered` is still forgetting the old
   conversation (`bind.ts:322-328`, awaited): the new conversation's turn ends and the old one is not revived. Tests:
   Task 5 (the replay starts after the accept's `onRegistered` call) and Task 10 (a `/clear` whose transcript comes late).
3. **Waiting hooks of a session whose admission is rejected** (a Codex subagent's child session): refused as today,
   with the once-a-minute unbound line, never one line per hook. Test: Task 5.
4. **A settings file PowerShell wrote as UTF-16** (`Out-File`'s default): held with today's reason and left byte for
   byte, never rewritten as mojibake. Test: Task 6.
5. **Codex's `config.toml` saved with a BOM** (the hook review file): hooks install, reviews are recorded and the file
   is written back without the BOM. Test: Task 6.

---

## Tasks

| Task | What | Effort | Depends on |
|---|---|---|---|
| 1 | Registry: a resumed row rotates onto the conversation its process reports (A) | xhigh | — |
| 2 | Hermes: the confirm-first step goes (A) | high | 1 |
| 3 | Admission order: an untimed binding orders nothing (B) | high | — |
| 4 | `sessionHookWait`: admissions and waiting hooks per session (C) | xhigh | — |
| 5 | Hook server: follow-up hooks wait behind their admission (C) | xhigh | 4 |
| 6 | `settingsText`: hook files and folder trust read a BOM (D) | high | — |
| 7 | Engine readers of the same files read a BOM (D) | high | 6 |
| 8 | Device readers of the same files read a BOM (D) | high | 6 |
| 9 | Fake engine: late transcript, lazy SessionStart, lost hooks, BOM | high | — |
| 10 | End to end: hooks during an admission (C) | high | 5, 9 |
| 11 | End to end: a resumed agent takes a new conversation (A, B) | high | 1, 3, 9 |
| 12 | End to end: a settings file with a BOM does not hold a create (D) | high | 6 |

Tasks 5 and 6 both add a line to `src/architecture.coreFiles.txt`; devcrew runs them one after the other.

### Task 1: Registry — a resumed row rotates onto the conversation its process reports (A)

**Effort:** xhigh (persisted binding). **Depends on:** none.

**Files:**
- Modify: `cli/src/lib/registry.ts:18` (the `resumesConversation` import goes: its only use is the branch),
  `:2329-2350` (the guard and its comment)
- Modify: `cli/src/lib/resumeStoppedAgent.ts:152-153` (comment only: a wrong conversation is no longer "caught by the
  mismatch guard"; it binds as a rotation when its hook arrives)
- Test: `cli/src/lib/registry.spec.ts:2448-2482` (the two guard tests replaced) and new cases beside them
- Test: `cli/src/lib/registry.admission.spec.ts:228` (renamed and kept: the rotation's write meets each fault)
- Test: `cli/src/lib/resumeStoppedAgent.spec.ts:255-256` (comment only)

**Interfaces:**
- Produces: `registry.register(input)` on a row with `resumeOnly` and (`lastHookAt === 0` or a launch not `ready`),
  given a valid `processIdentity` and another `sessionId`, resolves `{ entry, isNew: true, rebound: <old id>, … }` with
  `entry.active === true`, `entry.launch` `{ state: 'ready' }`, `entry.resumeOnly === true`, `entry.earlierSessionIds`
  holding the old id. Without a valid `processIdentity` it resolves `null` and changes nothing, as today. Tasks 2 and 11
  rely on this.

- [ ] **Step 1: Write the failing tests** in `registry.spec.ts`, each with the new conversation's own transcript file
  (`join(dataDir, '<id>.jsonl')`, `'{}\n'`) and the existing helpers (`loadRegistryModule`, `registerProcess`,
  `removeRegistryAgent`, `processIdentity`):
  - `lets process discovery start a resumed row, and binds another conversation its process reports as a rotation` —
    the old test's setup through `openProcessAgent`; then
    ```ts
    expect(rotated).toMatchObject({ isNew: true, rebound: 'resume-target', entry: { agentId: original.agentId,
      sessionId: 'unexpected-new-session', active: true, resumeOnly: true, launch: { state: 'ready' } } })
    expect(rotated!.entry.earlierSessionIds).toContain('resume-target')
    expect(existsSync(transcriptPath)).toBe(true) // the old conversation stays on disk
    ```
  - `binds another conversation on the first hook after the row was marked ready, as a rotation` — the old "ready
    first" setup (`setLaunch(…, { state: 'ready' })`, `lastHookAt` 0); expects `rebound: 'ready-first'`, active, ready.
  - `binds another conversation as a rotation after a reload` — `resumePendingAgent`, `confirmLaunch(agentId,
    { processIdentity: processIdentity(122) })`, `flush()`, a reloaded module; the reloaded row still has `lastHookAt`
    0 and `resumeOnly`; `register` of another conversation with the process identity rotates as above.
  - `still binds no hook without a valid process identity on a never-hooked resumed row` — `register` with no
    `processIdentity` resolves `null`; the row keeps its `sessionId`, `active` and `launch`.
  - Review Focus 1, `recovers a row an older build failed with RESUME_SESSION_MISMATCH once its engine is confirmed` —
    `registry.json` written with that row (`active: false`, `resumeOnly: true`, `lastHookAt: 0`, `launch: { state:
    'failed', error: 'RESUME_SESSION_MISMATCH', detail: … }`), `load()`, `confirmLaunch` as discovery does, then
    `register` of another conversation rotates; `active` true, `launch` ready.
  - In `registry.admission.spec.ts:228`, rename to `keeps a resumed binding intact when its rotation's write meets %s`;
    its assertions stay (the live list and the disk unchanged after the throw).
- [ ] **Step 2: Run them to verify they fail**
  Run: `npx vitest run src/lib/registry.spec.ts src/lib/registry.admission.spec.ts -t "rotation|older build|valid process identity"`
  Expected: FAIL — `register` resolves `null` and the row reads `launch.error: 'RESUME_SESSION_MISMATCH'`.
- [ ] **Step 3: Implement.** In `register`, the block at `:2337` becomes one condition: a resumed row still unhooked
  (`resumeOnly && (lastHookAt === 0 || launch not ready)`) returns `null` only when `!validProcessIdentity(input.
  processIdentity)`. The `failed` row, its `persist` and `traceLaunch('resume conversation mismatch')` go. The comment
  says why the rest stays (a hook with no verified process cannot speak for the resumed engine) and why another
  conversation binds (the running engine is the truth; a failed row over an engine the person types into was wrong,
  this spec, A). Remove the import. Fix the two comments in `resumeStoppedAgent.ts` and its spec.
- [ ] **Step 4: Run to verify they pass**
  Run: `npx vitest run src/lib/registry.spec.ts src/lib/registry.admission.spec.ts src/lib/registry.hookPersistence.spec.ts src/lib/resumeStoppedAgent.spec.ts src/lib/resumeAgentService.spec.ts src/hookAdmission.golden.spec.ts`
  Expected: PASS.
- [ ] **Step 5: Commit** the tests, then the change.

### Task 2: Hermes — the confirm-first step goes (A)

**Effort:** high. **Depends on:** Task 1 (a direct follow of a never-hooked resumed row is a rotation only once the
registry stops failing it).

**Files:**
- Modify: `cli/src/core/agents/hermesTerminal.ts:29-31` (the `endedSince` dep), `:123-126` (comment only), `:141-152`
  (the step goes)
- Modify: `cli/src/core/main.ts:178` (the import), `:2091` (the wiring line)
- Modify: `cli/src/engines/identities.ts:14` (the import), `:100-111` (`hermesSessionEndedSince` goes)
- Modify: `cli/src/engines/hermes/contract.ts:154-162` (`HERMES_SESSION_END` and its comment go)
- Modify: `cli/src/core/agents/bind.ts:869-870` (comment only: no resume is refused for another conversation now)
- Test: `cli/src/core/agents/hermesTerminal.spec.ts` (the `endedSince` fixture line and the cases at `:141-176`,
  `:228-236` go; one new case)
- Test: `cli/src/engines/identities.hermes.spec.ts:155-174` (the describe `whether a Hermes session was left since a
  moment` goes, and the import)
- Test: `cli/e2e/hermesTerminalRecord.e2e.ts:165-188` (comment, and the rotation's record asserted)

**Interfaces:**
- Consumes: Task 1's rotation.
- Produces: `HermesTerminalDeps` without `endedSince`.

- [ ] **Step 1: Write the failing test** in `hermesTerminal.spec.ts`:
  `follows a resumed row a /new left straight onto the session its record names` — with today's fixture,
  `deps.endedSince.mockResolvedValue(true)`;
  `expect(await t.follow(agent({ sessionId: OLD, resumeOnly: true, lastHookAt: 0 }), observed(), pass())).toEqual({ sessionId: S })`.
  (Its `endedSince` line goes with the dep in Step 3.) In the e2e file's case `follows a resumed Hermes through /new
  without failing it`, add that the saved row's `earlierSessionIds` holds the resumed session, and say in its comment
  that the agent follows `/new` as a rotation.
- [ ] **Step 2: Run to verify it fails**
  Run: `npx vitest run src/core/agents/hermesTerminal.spec.ts -t "straight onto"`
  Expected: FAIL — resolves `{ sessionId: OLD }`.
- [ ] **Step 3: Implement.** Delete the step, the dep, its wiring, the reader and the contract; drop the tests that
  covered only the removed step (`confirms a resumed row a /new left…`, `follows a resumed row onto another session only
  when its own was never left`, `waits on a resumed row whose store cannot say…`, the resumed half of `asks a store it
  could not read again only once it changed…`) and the `endedSince` fixture line. Keep `confirms a resumed row once`;
  rewrite its source comment to the reason that remains (the commit binds the row and lets the resume's attach follow
  it).
- [ ] **Step 4: Run to verify it passes**
  Run: `npx vitest run src/core/agents/hermesTerminal.spec.ts src/core/agents/bind.spec.ts src/engines/identities.hermes.spec.ts src/architecture.spec.ts`, then `npx vitest run --config vitest.core.config.ts src/core/agents/hermesTerminal.spec.ts`
  Expected: PASS, `hermesTerminal.ts` at 100% in the coverage table.
- [ ] **Step 5: Commit** the test, then the change.

### Task 3: Admission order — an untimed binding orders nothing (B)

**Effort:** high. **Depends on:** none.

**Files:**
- Modify: `cli/src/core/engines/admissionOrder.ts:19-38` (`observe`, `status`)
- Test: `cli/src/core/engines/admissionOrder.spec.ts` (two lines that encode the old rule, three new cases)
- Test: `cli/src/core/engines/pendingAdmission.spec.ts` (one new case)

**Interfaces:**
- Produces: `observe(key, scope, { id, at: null })` leaves no watermark of its own; `status` returns `'current'` for a
  timed order that arrived after an untimed accepted watermark. Same signatures as today.

- [ ] **Step 1: Write the failing tests** (`stamp(firedAt, arrival, scope)` as the spec file defines it):
  - In `uses arrival for already observed legacy deliveries…`, `stamp(50, 3)` after the untimed accept of `b` becomes
    `'current'` (was `'ambiguous'`); in `retains current binding authority…`, the last line (`'a'` against `d` untimed in
    `process-2`) becomes `'current'`.
  - `a binding with no time sets no watermark: every hook of its process is current against it` — `observe('agent',
    'p', { id: 'old', at: null })`; `status('agent', 'new', stamp(10, 1, 'p'))` and `stamp(undefined, 2, 'p')` are both
    `'current'`.
  - `an untimed binding of another conversation drops the watermark it replaces, one of the same keeps it` — accept
    `b` at `stamp(20, 1, 'p')`; `observe(… { id: 'b', at: null })` keeps it (`a` at `stamp(10, 2, 'p')` is `'older'`);
    `observe(… { id: 'c', at: null })` drops it (`a` at `stamp(10, 3, 'p')` is `'current'`).
  - `an untimed accepted watermark does not hold a timed hook that arrived after it` — accept `b` at
    `stamp(undefined, 5)`; `a` at `stamp(30, 6)` is `'current'`, at `stamp(30, 4)` `'older'`, at `stamp(undefined, 6)`
    `'ambiguous'`; equal timed (`accept b stamp(20,7)`, `a stamp(20,8)`) stays `'ambiguous'`.
  - In `pendingAdmission.spec.ts`: `admits a new conversation's timed hook over a resumed row's untimed binding` —
    `submit('agent', 'd1', request({ conversationId: 'new', binding: { id: 'old', at: null }, order: { scope:
    'process', firedAt: 50, arrival: 1 } }))`, `flush()`: `accept` called once, `held` not called.
- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run src/core/engines/admissionOrder.spec.ts src/core/engines/pendingAdmission.spec.ts`
  Expected: FAIL — `'ambiguous'` where `'current'` is expected; `held` called with `HOOK_ORDER_AMBIGUOUS`.
- [ ] **Step 3: Implement** in `observe`: an untimed binding returns after dropping a same-scope watermark of another
  id; a timed one behaves as today. In `status`: a timed order against an untimed watermark returns `older` when its
  arrival is not after the watermark's, else `current`; the untimed-candidate branch stays. Comments say why (a
  resumed row's binding is a reservation no hook confirmed; this spec, B).
- [ ] **Step 4: Run to verify they pass**
  Run: `npx vitest run --config vitest.core.config.ts src/core/engines/admissionOrder.spec.ts src/core/engines/pendingAdmission.spec.ts`
  Expected: PASS, both files at 100%.
- [ ] **Step 5: Commit** the tests, then the change.

### Task 4: `sessionHookWait` — admissions and waiting hooks per session (C)

**Effort:** xhigh (concurrency). **Depends on:** none.

**Files:**
- Create: `cli/src/core/engines/sessionHookWait.ts`
- Test: `cli/src/core/engines/sessionHookWait.spec.ts`

**Interfaces:**
- Produces (Task 5 uses every name):
  ```ts
  export type WaitingRoute = 'turn-stop' | 'wait' | 'subagent' | 'tool-start' | 'turn-start' | 'session-end'
  export interface SessionHookWaitBounds { perSession: number; total: number; totalBytes: number; maxWaitMs: number }
  /** 32, 256, 4 MiB, 120 s (Global Constraints). */
  export const SESSION_HOOK_WAIT_BOUNDS: SessionHookWaitBounds
  /** One key per engine and session; no two pairs share one (JSON of the pair). */
  export function sessionKey(engine: string, sessionId: string): string
  export interface AdmissionTicket {
    /** This request of the delivery left its route handler. Idempotent. */
    requestDone(): void
    /** The delivery's admission job is about to be queued; the returned call says it ended. Idempotent; only the
     *  latest job of the delivery decides. */
    queued(): () => void
  }
  export interface WaitingHook { route: WaitingRoute; sessionId: string; bytes: number; run: () => Promise<void> }
  export function createSessionHookWait(bounds?: Partial<SessionHookWaitBounds>): {
    /** An admission of [key] read its delivery [deliveryId]. The same id while it is unsettled is the same admission. */
    admission(key: string, deliveryId: string): AdmissionTicket
    /** True: [hook] waits, its caller answers `200 {pending: true}` and [hook.run] is called once, later. False: run it
     *  now (nothing unsettled ahead of it, or over a bound, which is logged). */
    hold(key: string, hook: WaitingHook): boolean
    /** Drops every admission, waiting hook and timer; runs nothing. Afterwards `hold` is false and tickets do nothing. */
    close(): void
  }
  ```
- Rules the body follows: an admission is unsettled while a request of it is in its handler or its latest job is
  queued, and keeps the arrival number of its first request; a hook waits only behind unsettled admissions of its key
  with a smaller arrival number; waiting hooks of a key run one at a time in arrival order, each awaited, the next
  checked after; a drain starts by `setImmediate` after a settle; each waiting hook has its own `setTimeout(maxWaitMs)`
  (unref'd), at which it leaves the queue and runs at once (`timed_out`); a hook over `perSession`, `total` or
  `totalBytes` is not queued (`session_full`, `core_full`); a `run` that rejects is logged by `errorKind` and the next
  hook runs. The log lines are the Global Constraints' exactly. A key's state is deleted once it has no admission and
  no waiting hook.

- [ ] **Step 1: Write the failing tests** (fake `setTimeout`/`clearTimeout`; `run` is a `vi.fn` resolving or a
  deferred; a helper awaits `setImmediate` to let a drain start):
  - `runs a hook at once when nothing of its session is being admitted` — `hold` is false, nothing logged.
  - `holds a hook behind an admission that arrived before it, and runs it once that admission settles` — ticket
    `admission(k, 'd1')`; `hold` true; `run` not called after `requestDone()` while `queued()`'s end is pending; called
    once after the end and a turn; lines `waits for its session's admission` then `waiting hooks ran · 1`.
  - `settles only when every request of the delivery is done and its latest job ended; the same id is the same
    admission` — two tickets for `d1`, the second arriving after the hook: the hook still waits for both requests;
    a job queued by the second ticket decides; the first job's end, called last, changes nothing.
  - `never holds a hook behind an admission that arrived after it` — hook 1 behind `d1`; `d2` arrives; hook 2 behind
    both; `d1` settles: hook 1 runs, hook 2 does not; `d2` settles: hook 2 runs.
  - `runs a session's waiting hooks one after another in arrival order` — three hooks; the second `run` starts only
    after the first's promise resolved; order of calls is arrival order.
  - `starts a run on a later turn, never inside the call that settled the admission` — `run` not called synchronously
    in the ending call, called after `setImmediate`.
  - `does not hold a hook over the session, core or byte bound, and says why` — bounds `{ perSession: 1 }`,
    `{ total: 1 }` across two keys, `{ totalBytes: 10 }` with `bytes: 11`: `hold` false and `runs unheld ·
    session_full` / `core_full`.
  - `runs a hook past its time at once, and says so` — `maxWaitMs: 1000`; `advanceTimersByTimeAsync(1000)`: `run`
    called once, line `runs unheld · timed_out`; settling the admission later runs nothing more.
  - `says a failed run by its kind and runs the next` — `run` rejects with a `TypeError`: line `waiting hook failed ·
    TypeError` (as `errorKind` prints it); the next hook runs.
  - `says a session's wait once per admission` — two hooks behind `d1` log one `waits` line; a third behind `d2` logs
    another.
  - `keeps engines apart` — `sessionKey('claude', 'x')` ≠ `sessionKey('codex', 'x')`; `sessionKey('a', 'b:c')` ≠
    `sessionKey('a:b', 'c')`; a hook of one is not held by the other's admission.
  - `drops everything on close and runs nothing` — after `close()`, timers cleared (`vi.getTimerCount()` 0), no `run`,
    `hold` false, tickets inert.
- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run src/core/engines/sessionHookWait.spec.ts`
  Expected: FAIL — the module does not exist.
- [ ] **Step 3: Implement** the module by the rules above. Comments name the incidents (the Windows 2-3 s window, the
  hours of refused Stops in the user's log) and why the run waits a turn.
- [ ] **Step 4: Run to verify they pass**
  Run: `npx vitest run --config vitest.core.config.ts src/core/engines/sessionHookWait.spec.ts`
  Expected: PASS, `sessionHookWait.ts` at 100% statements, branches, functions and lines.
- [ ] **Step 5: Commit** the tests, then the module.

### Task 5: Hook server — follow-up hooks wait behind their admission (C)

**Effort:** xhigh (concurrency, the core's hook path). **Depends on:** Task 4.

**Files:**
- Modify: `cli/src/hookServer.ts:423-436` (`HookServerOptions.hookWait?: Partial<SessionHookWaitBounds>`, for tests),
  `:461` and `:1158` (one wait per server, closed with it), `:590-960` (session-start: tickets), `:962-1097` (the six
  routes through one path; `refuseUnbound` and `boundHook` replaced)
- Modify: `cli/src/architecture.coreFiles.txt` (add `core/engines/sessionHookWait.ts`)
- Test: create `cli/src/hookServer.wait.spec.ts`
- Test, only if a case encodes a 403 for a hook behind a pending admission of its own session (the survey found none):
  `cli/src/hookServer.spec.ts`, `cli/src/hookAdmission.golden.spec.ts`

**Interfaces:**
- Consumes: Task 4's `createSessionHookWait`, `sessionKey`, `WaitingRoute`, `SessionHookWaitBounds`.
- Produces: the hook routes' behavior Task 10 drives end to end.

- [ ] **Step 1: Write the failing tests** in `hookServer.wait.spec.ts`, on the real registry and a real server as
  `hookServer.spec.ts` starts one (its `start()` and credentialed fetch copied in, `startHookServer(0, handlers,
  { hookWait })`): an agent opened by `registry.openProcessAgent` and bound to an old session; its SessionStart for a
  new session names a transcript that does not exist yet, so it is held `DURABLE_ADMISSION_WAIT`; then the transcript is
  written and the 1 s retry advanced. Each follow-up carries `x-harness-hook-fired-at`.
  - `it.each(six routes)` `a %s hook of a session whose SessionStart is held waits, then runs after the session is
    bound` — reply `200 {pending: true}`; its handler (`onTurnStop`, `onPersonWait`, `onSubagent`, `onToolStart`,
    `onTurnStart`, `onSessionEnd`) not called while held; after the bind, called once with the new session id and the
    original fired-at, and after `onRegistered` (`invocationCallOrder`).
  - `waits during the process-record wait` — `resolveHookAgent` calls `onWait` and awaits a deferred; the SessionStart is
    answered 202; a `turn-stop` is answered pending; the deferred resolves to the row; after the bind `onTurnStop` runs.
  - `runs a session's waiting hooks in arrival order, each with its own fired-at` — `wait` (1000), `subagent` (1001),
    `turn-stop` (1002): handler calls in that order with those times.
  - `admits a later prompt while an earlier Stop waits` — SessionStart held, a `turn-stop` (fired-at 1000) waiting, then
    the session's UserPromptSubmit (fired-at 1001, its own delivery id): once the transcript exists both admissions are
    accepted, `onPromptHook` runs with 1001, and `onTurnStop` runs after it with 1000 (the turn layer orders them).
  - Review Focus 3, `refuses the waiting hooks of a rejected admission with the once-a-minute line` — the held
    SessionStart's row is made inactive (`registry.setActive(agentId, false)`) and the 1 s retry advanced, so the
    admission is rejected `stale_hook`; its two waiting hooks: no handler call, exactly one `[hooks] <sid> <route>
    refused · unbound` line.
  - `runs at once over the session's bound, and says so` — `hookWait: { perSession: 1 }`: the second hook is answered
    403 `UNBOUND_HOOK` at once; line `runs unheld · session_full`.
  - `runs a hook past its time at once` — `hookWait: { maxWaitMs: 2_000 }`, the transcript never written: after 2 s
    the hook is refused (unbound line) and `runs unheld · timed_out` is said.
  - `runs a bound session's hook at once while its prompt is re-admitted` — the session bound; its UserPromptSubmit held
    by `hookAdmissionBlocked` (`STOP_SETTLING`); a `turn-stop` answers `{ ok: true }` and `onTurnStop` runs at once.
  - `refuses at once a hook of an unbound session with nothing being admitted`.
  - `treats a SessionStart sent again with the same delivery id as the same admission` — two posts with one
    `x-harness-hook-delivery-id` (the second answered from the pending receipt), a `turn-stop`, then the bind: the stop
    runs once, after the bind.
  - `keeps the Cursor linked Stop on its own path` — a Cursor registration carrying its Stop (delivery id, `hookEvent:
    'stop'`), then `turn-stop` with that delivery id: answered by the linked path (`{ pending: true }` parked), no
    `waits` line.
  - `names no body text in its lines` — prompts, paths and tool input in the bodies never appear in any logged line.
- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run src/hookServer.wait.spec.ts`
  Expected: FAIL — follow-ups answered 403 `UNBOUND_HOOK`.
- [ ] **Step 3: Implement** in `startHookServer`:
  - `const waits = createSessionHookWait(options.hookWait)`, closed beside `admissions.close()`.
  - session-start: once the body parsed, `engine` and the delivery id (`nativeDeliveryId ?? randomUUID()`, moved up
    from `:646-648`, same value) are known; `ticket = body.sessionId ? waits.admission(sessionKey(engine,
    body.sessionId), deliveryId) : undefined`; the rest of the branch runs in `try … finally { ticket?.requestDone() }`.
    In `enqueue`, `const jobEnded = ticket?.queued()` just before `admissions.submit`; a refused submit (429) calls it at
    once; `accept` calls it after `notify()` and the parked-Stop claim has started; `reject` after `completedReply`.
  - The six routes: a map from URL to `WaitingRoute`; one branch reads and checks the body as each route does today
    (401, 400, `wait`'s no input or prompt, `subagent`'s two events); `turn-stop`'s linked-delivery branch stays first;
    `firedAt = hookFiredAt(req)`; when `body.engine && body.sessionId`, the session is unbound and `waits.hold(…, {
    route, sessionId, bytes: Buffer.byteLength(JSON.stringify(body)), run: async () => { await followUp(route, body,
    firedAt) } })` is true, answer `200 {pending: true}`; else write `await followUp(route, body, firedAt)`.
  - `followUp(route, body, firedAt): Promise<{ status: number; body: unknown }>`: `verifiedBoundMutation`; unbound gives
    `unbound(sessionId, route)` (today's once-a-minute line and `403 {error: 'UNBOUND_HOOK'}`); bound runs today's effect
    and log line for the route with `firedAt`, `200 {ok: true}` (turn-stop keeps `stopHookDelayMs`).
  - Add the coreFiles line.
- [ ] **Step 4: Run to verify they pass**
  Run: `npx vitest run src/hookServer.wait.spec.ts src/hookServer.spec.ts src/hookServer.hermes.spec.ts src/hookAdmission.golden.spec.ts src/engines/otherAdmission.golden.spec.ts src/lib/registry.admission.spec.ts src/architecture.spec.ts src/architecture.failureLogs.spec.ts src/architecture.hookHolds.spec.ts`
  Expected: PASS.
- [ ] **Step 5: Commit** the tests, then the change.

### Task 6: `settingsText` — hook files and folder trust read a BOM (D)

**Effort:** high (rewrites people's settings files). **Depends on:** none.

**Files:**
- Create: `cli/src/lib/settingsText.ts`
- Modify: `cli/src/engines/kit/nativeHookFiles.ts:141` (decode through the helper)
- Modify: `cli/src/engines/kit/folderTrust.ts:74, :97, :123, :142` (the JSON and TOML readers)
- Modify: `cli/src/architecture.coreFiles.txt` (add `lib/settingsText.ts`)
- Test: create `cli/src/lib/settingsText.spec.ts`
- Test: `cli/src/engines/kit/nativeHookFiles.spec.ts`, `cli/src/engines/kit/windowsHooks.spec.ts`,
  `cli/src/engines/kit/folderTrust.spec.ts`

**Interfaces:**
- Produces (Tasks 7, 8): `export function settingsText(bytes: Uint8Array): string` — the bytes as UTF-8 text without
  one leading BOM; throws on bytes that are not UTF-8.

- [ ] **Step 1: Write the failing tests:**
  - `settingsText.spec.ts`: drops one leading BOM, keeps a second one and any BOM past the start, leaves text without
    one as it is, throws on `Buffer.from([0xff, 0xfe, 0x7b, 0x00])`.
  - `nativeHookFiles.spec.ts`: `reads a settings file that starts with a BOM as its text alone` —
    `inspectHookFile(file).content` is `'{"a":1}\n'` for `'\uFEFF{"a":1}\n'`.
  - `windowsHooks.spec.ts` (windows-e2e runs it on Windows):
    `installs Claude Code's hooks into a settings.json Windows PowerShell 5 saved with a BOM, and writes it back
    without one` — `'\uFEFF{"theme":"dark"}\r\n'`; `installHookSettings('claude', claude.settings, 19473, home)` is
    `true`; the file's first byte is `{`; `JSON.parse` keeps `theme` and has the hooks.
    Review Focus 5: the same for Codex with `hooks.json` and `config.toml` each starting with a BOM: `true`, the review
    records written, neither file starting with a BOM.
    Review Focus 4: `holds a settings.json saved as UTF-16, as before, and leaves it byte for byte` — `FF FE` then
    UTF-16LE text: `false`, bytes unchanged.
  - `folderTrust.spec.ts`: `reads and records trust in a .claude.json and a config.toml that start with a BOM` —
    `trustsIn` true for a BOM file that trusts the folder; `recordTrustIn` `'trusted'` for one that does not, written
    without the BOM; a file that is not UTF-8 reads as no trust and `'skipped'`, with no throw.
- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run src/lib/settingsText.spec.ts src/engines/kit/nativeHookFiles.spec.ts src/engines/kit/windowsHooks.spec.ts src/engines/kit/folderTrust.spec.ts`
  Expected: FAIL — no module; content keeps `\uFEFF`; install `false` with `failed to write settings.json` and a
  `SyntaxError`; trust read as no.
- [ ] **Step 3: Implement** the helper; `inspectHookFile` decodes through it (the `ignoreBOM: true` decoder goes);
  `folderTrust`'s four readers read bytes and decode through it, the TOML readers treating a failed decode as an absent
  file. Add the coreFiles line.
- [ ] **Step 4: Run to verify they pass**
  Run: Step 2's command, then `npx vitest run src/engines/kit src/engines/removeHooks.spec.ts src/lib/publishedGridConfig.spec.ts src/architecture.spec.ts`
  Expected: PASS.
- [ ] **Step 5: Commit** the tests, then the change.

### Task 7: Engine readers of the same files read a BOM (D)

**Effort:** high. **Depends on:** Task 6 (`settingsText`).

**Files:**
- Modify: `cli/src/engines/kit/runtime.ts:121` (`readJson`: Claude Code's models and effort from `settings.json`)
- Modify: `cli/src/lib/engineAccount.ts:57` (`readJson`: `apiKeyHelper` in `settings.json`)
- Modify: `cli/src/engines/kit/inheritedMcp.ts:18-23` (`readObject`: the user's `settings.json` and the project's
  `.claude/settings.local.json`)
- Test: create `cli/src/engines/kit/runtime.spec.ts`; `cli/src/lib/engineAccount.spec.ts`,
  `cli/src/engines/kit/inheritedMcp.spec.ts`

- [ ] **Step 1: Write the failing tests** — one per reader, each with a file starting `'\uFEFF'`: `readJson` returns the
  object; the account reads as signed in by its `apiKeyHelper`; `recordInheritedMcp` records the fresh servers and
  writes the settings back without a BOM.
- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run src/engines/kit/runtime.spec.ts src/lib/engineAccount.spec.ts src/engines/kit/inheritedMcp.spec.ts`
  Expected: FAIL — `null`, signed out, nothing recorded.
- [ ] **Step 3: Implement** each read as bytes through `settingsText`, inside the reader's existing `catch`.
- [ ] **Step 4: Run to verify they pass** (Step 2's command, plus `src/lib/runtimeProfile.homes.spec.ts`). Expected:
  PASS.
- [ ] **Step 5: Commit** the tests, then the change.

### Task 8: Device readers of the same files read a BOM (D)

**Effort:** high. **Depends on:** Task 6 (`settingsText`).

**Files:**
- Modify: `cli/src/devices/dialSkill.ts:240-250` (`pluginEntry`: the `harness-device` plugin's state in
  `settings.json`, read by the dial setup and `harness device claude`)
- Modify: `cli/src/cable/hosts/claudeRenderer.ts:71-92` (`readSettings`: the `tui` key)
- Test: `cli/src/devices/dialSkill.spec.ts`, `cli/src/cable/hosts/claudeRenderer.spec.ts`

- [ ] **Step 1: Write the failing tests** — a BOM `settings.json` turning the plugin on reads `'on'`; a BOM settings file
  with `"tui": "fullscreen"` decides fullscreen.
- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run src/devices/dialSkill.spec.ts src/cable/hosts/claudeRenderer.spec.ts`
  Expected: FAIL — unknown, undecided.
- [ ] **Step 3: Implement** both reads through `settingsText`, inside their existing `catch`.
- [ ] **Step 4: Run to verify they pass** (Step 2's command). Expected: PASS.
- [ ] **Step 5: Commit** the tests, then the change.

### Task 9: Fake engine — late transcript, lazy SessionStart, lost hooks, BOM

**Effort:** high. **Depends on:** none.

**Files:**
- Modify: `cli/e2e/harness/fakeEngine.mjs` (the header's config list, startup `:1008-1011`, transcript creation
  `:618-627`, the record writer `:668-674`, `!clear` `:1662-1679`, the hook runner, the settings readers `:256`,
  `:525-530`)
- Modify: `cli/e2e/harness/daemon.ts:55-88` (`EngineConfig`: the three fields)
- Test: create `cli/src/testing/fakeEngineAdmission.spec.ts` (as `fakeEngineUntil.spec.ts` runs the fake: its own
  throwaway root and home, hooks that write their input to files)

**Interfaces:**
- Produces (Tasks 10-12), each faithful to the engine it names:
  - `lateTranscript: true` (Claude Code): each new conversation's transcript, its startup's (not a resume's) and a
    `!clear`'s, is created only once `<root>/transcript.release` exists; meanwhile `<root>/transcript.waiting` holds the
    session id, the SessionStart hook runs at once naming the path that does not exist, the turn runs and every record is
    kept back; on the release the file is created with those records and both files are removed; after 60 s it is
    created anyway. Claude Code on Windows announces SessionStart before its transcript exists (2-3 s measured, CLI
    0.6.89).
  - `lazySessionStart: true` (Codex): no SessionStart at start; the first prompt runs it (`source` `resume` for a
    resumed process, else `startup`) before its UserPromptSubmit; a `!clear` before any prompt runs only its own
    SessionStart (`clear`). Codex sends SessionStart at its first prompt.
  - `lostHooks: string[]`, entries `<event>` or `<event>:<source>`: such a hook is not run and is noted in the hook log
    as lost, as a hook killed at its timeout on a loaded machine.
  - Both engines read their hook settings with or without a leading BOM, as Claude Code and Codex do.

- [ ] **Step 1: Write the failing tests:** `lateTranscript`: the SessionStart input's `transcript_path` does not exist;
  a typed prompt runs UserPromptSubmit and Stop and the file is still absent; after the release it exists and holds the
  user message. `lazySessionStart`: nothing before typing; a typed prompt runs SessionStart then UserPromptSubmit, in
  that order. `lostHooks: ['SessionStart:resume']` on a resumed process: no SessionStart at start; `!clear` runs
  SessionStart with `source: 'clear'`. A settings file starting with a BOM still runs its hooks.
- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run src/testing/fakeEngineAdmission.spec.ts`
  Expected: FAIL — the transcript exists at start; SessionStart runs at start; the BOM settings run no hook.
- [ ] **Step 3: Implement** the four in the fake and the three fields in `EngineConfig`, each documented in the fake's
  header with the engine behavior it models.
- [ ] **Step 4: Run to verify they pass**
  Run: `npx vitest run src/testing/fakeEngineAdmission.spec.ts src/testing/fakeEngineUntil.spec.ts src/testing/fakeEngineHelpProbe.spec.ts`
  Expected: PASS.
- [ ] **Step 5: Commit** the tests, then the change.

### Task 10: End to end — hooks during an admission (C)

**Effort:** high. **Depends on:** Tasks 5 and 9.

**Files:**
- Create: `cli/e2e/hookWait.e2e.ts` (the shape of `rotation.e2e.ts`: `IsolatedDaemon`, `LocalClient`, `until`, the
  daemon log printed on failure; the wrapper rewritten with extra config as `races.e2e.ts` `install` does)

No failing test of its own: it adds the end-to-end proof of Task 5 (one commit). Each case also asserts the daemon log
has `waits for its session's admission` and `waiting hooks ran`, and no `turn-stop refused · unbound`, so it cannot pass
without the wait.

- [ ] **Step 1: Write the cases:**
  - `Claude Code: a session whose SessionStart comes before its transcript, then a prompt and a Stop: the turn starts
    and ends, and a recap is made` — `lateTranscript`; `agent_create` (no task); once `transcript.waiting` exists, a
    prompt typed into the pane (`tmux send-keys`) as a person does; once the hook log shows its Stop ran, the release;
    then `turn_started`, `turn_ended` and a `turn_summary` holding the prompt's word for the agent, and the agent bound to
    the session the waiting file named.
  - Review Focus 2, `Claude Code: a /clear whose new transcript comes late, then a prompt and a Stop` — the first
    conversation released at start and one turn; `!clear` typed; the same steps; the agent bound to the new session,
    `session_reset` for the old one, the new turn ended and recapped.
- [ ] **Step 2: Run** `npm run test:e2e -- e2e/hookWait.e2e.ts`. Expected: PASS.
- [ ] **Step 3: Commit.**

### Task 11: End to end — a resumed agent takes a new conversation (A, B)

**Effort:** high. **Depends on:** Tasks 1, 3 and 9.

**Files:**
- Create: `cli/e2e/resumeRotation.e2e.ts`

No failing test of its own (one commit); each case asserts the log has no `RESUME_SESSION_MISMATCH`,
`HOOK_ORDER_AMBIGUOUS` or `stale_hook` line for the new session.

- [ ] **Step 1: Write the cases:**
  - `Codex: a resumed agent whose first input starts a new conversation binds it, and its turn ends` — create and one
    turn; `agent_delete`, stopped; the wrapper rewritten with `lazySessionStart`; `agent_resume`, active on the saved
    conversation; `!clear` typed (Codex's `/new`); the agent bound to a new session, active and not failed; a turn on it
    starts and ends.
  - `Claude Code: a /clear on a resumed agent whose resume hook was lost binds the new conversation` — the same with
    `lostHooks: ['SessionStart:resume']`.
- [ ] **Step 2: Run** `npm run test:e2e -- e2e/resumeRotation.e2e.ts`. Expected: PASS.
- [ ] **Step 3: Commit.**

### Task 12: End to end — a settings file with a BOM does not hold a create (D)

**Effort:** high. **Depends on:** Task 6 (the daemon rewrites the file without its BOM before the fake engine reads
it, so the fake's own BOM reading, Task 9, is not needed here).

**Files:**
- Create: `cli/e2e/settingsBom.e2e.ts`

No failing test of its own (one commit).

- [ ] **Step 1: Write the case:** `it.each(['claude', 'codex'])` `%s: a settings file that starts with a BOM does not
  hold a create` — before `d.start()`, the isolated home's `settings.json` (Claude Code, beside
  `d.engineConfig.claudeProjectsDir`) or `hooks.json` (Codex, in `d.engineConfig.codexHome`) written as `'\uFEFF{}\n'`;
  `agent_create` answers no error (no `NATIVE_LAUNCH_HELD`), the agent binds and a turn ends; the file no longer starts
  with a BOM; the log has no `failed to write`.
- [ ] **Step 2: Run** `npm run test:e2e -- e2e/settingsBom.e2e.ts`. Expected: PASS.
- [ ] **Step 3: Commit.**

---

## Verification

Run once, on the final head, after the independent review (devcrew testers), in this order.

1. **Local gates (this Mac), with receipts before the pull request is marked ready.** From a clean tree at the final
   commit, in the repository root: `python3 scripts/local-checks.py --run`. Its paths select `cli-core`
   (`npm run test:core`: `src/core/` changed), `cli-portability` (`npm run test:portability`: `lib/registry*.ts`) and
   `cli-resume` (`npm run test:resume`: `lib/resumeStoppedAgent*.ts`); paste its output into the PR body. Then
   `cd cli && npm run typecheck`. PR CI runs `cli-typecheck` and `cli-tests` (the default suite, four shards) on Linux:
   no second local full suite.
2. **End to end on this Mac** (macOS, the real daemon from the checkout, `IsolatedDaemon`: a throwaway root holding its
   own data folder, Claude Code and Codex homes and port, a private tmux server with `TMUX`/`TMUX_PANE` unset and
   `TMUX_TMPDIR` its own, the fake engines, no backend sign-in; never the developer's daemon on 18473, `~/.claude`,
   `~/.codex` or tmux):
   `cd cli && npm run test:e2e -- e2e/hookWait.e2e.ts e2e/resumeRotation.e2e.ts e2e/settingsBom.e2e.ts`, then the
   flows these changes run through:
   `npm run test:e2e -- e2e/rotation.e2e.ts e2e/races.e2e.ts e2e/hookStatus.e2e.ts e2e/hermesTerminalRecord.e2e.ts e2e/hermesAdmission.e2e.ts e2e/updates.e2e.ts`.
   What a person would see, which the cases assert: the agent turns working and then idle for the turn typed before
   its session was bound, its recap arrives, and a resumed agent follows its new conversation instead of going "Start
   failed".
3. **PR CI on Linux** (automatic, `ci/required`): `linux-e2e` runs the three new e2e files and
   `hermesTerminalRecord.e2e.ts`, plus the canary `twoAccounts.spike.e2e.ts` because `cli/e2e/harness/` changed. With
   Task 8, `cli/src/cable/hosts/claudeRenderer.ts` also selects `dial-hosts` and the six dial app eval files (3½–7 min
   each; see Open questions, 1).
4. **windows-e2e** (automatic, by path, `scripts/ci-plan.py`): selected by `cli/src/engines/kit/folderTrust.ts` (the
   module of a `WINDOWS_SPECS` spec) and `cli/src/engines/kit/windowsHooks.spec.ts` (a `WINDOWS_SPECS` spec whose own
   name says Windows, so `windows_only`: x64 and arm64), and with Task 8 by `cli/src/devices/` and `cli/src/cable/`. It
   runs `windows.yml`'s specs on `windows-latest` and `windows-11-arm`, among them Task 6's BOM install and folder trust
   cases. It does not run A, B or C's specs or the CLI end to end on Windows: item 6 does.
5. **The full CLI end to end on GitHub**, once, by hand, after PR CI is green: **Actions → CLI end to end → Run
   workflow** on the branch (the hook path of every session changed). Report the run link in the PR.
6. **Windows VM** (the shared UTM VM, Windows 11 ARM64, `ssh admin@192.168.64.7`, in the turn the orchestrator gives;
   the Ubuntu VM suspended first). Follow the repo's guide, `docs/testing/windows-pty-e2e.md` steps 3-7, with every
   folder of `env.cmd` moved under `C:\work\hookadm\` and `PORT=18480` added: the branch head's bundle (`npm run bundle`,
   `dist/cli.js` and `dist/notify.mjs`), the released terminal host (`pty/` does not change) named by
   `HARNESS_PTY_BIN`, the daemon started by `launch.ps1` outside the SSH session, signed out of Harness (the loopback API
   needs no account, so no backend is reached). The engine homes the daemon writes (`%USERPROFILE%\.claude\settings.json`,
   `%USERPROFILE%\.codex\hooks.json` and `config.toml`) are backed up with their sha256 before the first start and
   checked restored at the end (the guide's step 7). **Needs the user:** Claude Code and Codex on that account signed in
   to test accounts, never a person's; if they are not, the check stops and asks. Then, reading
   `C:\work\hookadm\logs`' daemon log:
   - D: before the first start, the backed-up Claude Code `settings.json` rewritten by Windows PowerShell 5
     `Set-Content -Encoding utf8` (which writes a BOM). Expected: no `[hooks] failed to write settings.json` line; the
     file afterwards starts with `{`.
   - A Claude Code create with a first task: no `NATIVE_LAUNCH_HELD`; the task's turn starts and ends; `harness ps`
     (the guide's `cli.cmd ps`) shows it idle with its recap.
   - A Claude Code create with no task, and a prompt typed into its pane within its first two seconds: the log has
     `turn-stop waits for its session's admission` and `waiting hooks ran`, no `refused · unbound`; the turn ends.
   - Codex: create, one turn, close (`agent_delete`), resume (`agent_resume`), `/new` typed, then a prompt: the log has
     `rebound <old> → <new>` and no `RESUME_SESSION_MISMATCH`, `HOOK_ORDER_AMBIGUOUS` or `stale_hook` for the new
     session; the turn ends.
   Clean up: `stop.cmd`, the engine homes restored and their sha256 checked, `C:\work\hookadm\` removed.
7. **Proposal, not a task:** list `src/hookServer.wait.spec.ts` and `src/core/engines/sessionHookWait.spec.ts` in
   `windows.yml`'s first `$paths` and in `WINDOWS_SPECS` (`scripts/ci-plan.py`), so a later pull request that changes
   hook admission runs them on Windows.

## Decisions after the plan

1. **Tasks 7 and 8 stay in this pull request** (2026-11-25): a BOM in Claude Code's `settings.json` is the same cause
   wherever that file is read, and one helper serves every reader (root AGENTS.md: a fix covers every case of the same
   cause). The `dial-hosts` jobs Task 8 selects are the pull request's own CI.
