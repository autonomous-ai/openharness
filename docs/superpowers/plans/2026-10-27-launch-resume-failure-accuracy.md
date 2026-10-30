# Launch and Resume Failure Accuracy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch counters stop counting correct refusals as failures and say who started a launch; a failed resume preparation keeps its reason; a half-written Codex history line no longer refuses a resume; Desktop's first-arrival Retry and `harness new <cloud>` stop producing refusals of their own.

**Architecture:** Fixed counter names are added to the two mirrored contract files (CLI and backend copies must stay byte-identical). The daemon classifies refusals in `productUsageSignals.ts` and counts them in `gateway/productUsage.ts`. Resume repair throws a typed error whose kind travels in the resume reply. The cloud request checks move into one helper both the cloud service and `harness new` call.

**Tech Stack:** TypeScript (CLI and backend: vitest), Dart/Flutter (Desktop).

**Spec:** `docs/superpowers/specs/2026-10-27-launch-resume-failure-accuracy-design.md`

## Global Constraints

- `cli/src/lib/productUsageContract.ts` ≡ `backend/src/types/productUsage.ts` and `cli/src/lib/productHealthContract.ts` ≡ `backend/src/types/productHealthContract.ts`, byte for byte (tests: `backend/src/lib/productUsage.test.ts` "keeps the client and server vocabulary identical", `backend/src/analytics/productHealth.test.ts`).
- Only fixed names leave the daemon: no message text, path, session id or conversation text in a counter. Log lines may carry the repair error's message (file name + line number only) — never conversation text.
- Refusal set (spec §3), exactly: `SESSION_IN_HARNESS`, `SESSION_OPEN_ELSEWHERE`, `SESSION_OPEN_IN_TERMINAL`, `SESSION_BUSY_IN_TERMINAL`, `INVALID_REQUEST`.
- Preparation kinds (spec §1), exactly: `invalid_json`, `foreign_session`, `not_owned_file`, `changed_during`, `other`.
- Existing totals keep counting what they count today except that refusals leave `launch_failed`; nothing is renamed or removed.
- Rollout: backend before CLI (spec "Rollout"). Plan produces both; release order is the releaser's.

## Review Focus

1. A resume whose history ends in a complete line with no trailing newline (valid JSON) — must resume exactly as before, bytes unchanged. Test in Task 2.
2. A half-written last line *followed by nothing* in a history that also needs repair elsewhere — the repaired lines change, the tail stays byte-identical. Test in Task 2.
3. A create refused with a refusal code from an agent (`startedBy: 'agent'`) — counts `launch_refused`, `launch_agent_started`, `launch_agent_refused`, never `launch_failed` or `launch_agent_failed`. Test in Task 4.
4. A first-arrival Retry while the first create is still `awaitingConfirmation` — keeps today's behaviour (re-checks the same attempt). Test in Task 6.
5. `harness new devin-cloud -- task` with no `--repo` — Devin's repository is optional, so it must NOT be refused locally. Test in Task 5.

## Ruling against the spec

Spec §2 says the passed-through tail is "counted as `resume_preparation_partial_tail`". The repair runs in `core/agents/launch.ts`, which has no counter path, and a resume that succeeds has no failure to attach it to. Ruling: log it (`resume history ended in a partial line; kept as is`) and do not add a counter. Task 2 edits the spec line to match.

Spec §1 puts the `changed_during` wording in Desktop. Desktop has no case for `RESUME_PREPARATION_FAILED` and shows the daemon's `detail`, so the daemon's detail carries it instead (Task 3) and every app, the phone included, shows the same words. Task 3 edits the spec line to match.

---

### Task 1: Counter vocabulary

**Files:**
- Modify: `cli/src/lib/productUsageContract.ts` (launch names ~line 175–205), then copy to `backend/src/types/productUsage.ts`
- Modify: `cli/src/lib/productHealthContract.ts` (~line 44–52), then copy to `backend/src/types/productHealthContract.ts`
- Modify: `docs/product-measurement.md`
- Test: `backend/src/lib/productUsage.test.ts`, `backend/src/analytics/productHealth.test.ts`

**Interfaces:**
- Produces: metrics `launch_refused`, `launch_agent_started`, `launch_agent_created`, `launch_agent_failed`, `launch_agent_refused`; family `launch_refused_code` in `LAUNCH_ERROR_FAMILIES` (so `launch_refused_code_<code>` exists for every `LAUNCH_ERROR_CODES` entry); `export const RESUME_PREPARATION_KINDS = ['invalid_json', 'foreign_session', 'not_owned_file', 'changed_during', 'other'] as const` and `type ResumePreparationKind` in `productHealthContract.ts`; metrics `request_<source>_resume_preparation_<kind>` for every `HEALTH_SOURCES` × kind in `PRODUCT_HEALTH_METRICS`.

- [ ] **Step 1: Write the failing test** in `backend/src/lib/productUsage.test.ts`:

```ts
it('names launch refusals and agent-started launches', () => {
  const metrics = new Set<string>(PRODUCT_USAGE_METRICS)
  for (const m of ['launch_refused', 'launch_agent_started', 'launch_agent_created', 'launch_agent_failed', 'launch_agent_refused',
    'launch_refused_code_session_in_harness', 'launch_refused_code_invalid_request']) expect(metrics.has(m), m).toBe(true)
})
```
and in `backend/src/analytics/productHealth.test.ts`:
```ts
it('names each resume preparation kind per source', () => {
  for (const kind of ['invalid_json', 'foreign_session', 'not_owned_file', 'changed_during', 'other'])
    expect((PRODUCT_HEALTH_METRICS as readonly string[]).includes(`request_app_resume_preparation_${kind}`), kind).toBe(true)
})
```

- [ ] **Step 2: Run** `cd backend && npx vitest run src/lib/productUsage.test.ts src/analytics/productHealth.test.ts` — Expected: the two new tests FAIL.
- [ ] **Step 3: Add the names** to the two CLI contract files, then `cp` each over its backend copy.
- [ ] **Step 4: Run** the same command — Expected: PASS, parity tests included. Also `cd cli && npx tsc --noEmit -p .` — Expected: no errors.
- [ ] **Step 5: Document** in `docs/product-measurement.md` beside the launch counters: `launch_refused` (+ code family) with the refusal set; `launch_agent_*` (a create carrying `startedBy`; person-started = total − agent); `request_<source>_resume_preparation_<kind>`.
- [ ] **Step 6: Commit** `feat(usage): names for launch refusals, agent launches and resume preparation kinds`.

### Task 2: Typed resume preparation errors; keep a half-written tail

**Files:**
- Modify: `cli/src/engines/kit/resumeRepair.ts` (`historyRepair` ~55–92, `scanHistory` ~111+, `repairHistory` ~168–220)
- Modify: spec line in §2 (see Ruling)
- Test: `cli/src/engines/kit/resumeRepair.spec.ts`

**Interfaces:**
- Consumes: `ResumePreparationKind` (Task 1).
- Produces: `export class ResumePreparationError extends Error { constructor(readonly kind: ResumePreparationKind, message: string) }` from `resumeRepair.ts`. Every throw in that file becomes one: invalid JSON / non-object record → `invalid_json`; wrong or missing first record (`does not belong`, `has no session metadata`) → `foreign_session`; outside the session profile / not an owned regular file → `not_owned_file`; `changedDuring` → `changed_during`; write failure and non-ENOENT stat errors → `other`. Messages unchanged.

- [ ] **Step 1: Write failing tests** in `resumeRepair.spec.ts`, reusing the file's existing history fixtures:
  - `classifies each refusal`: invalid JSON mid-file → `kind === 'invalid_json'`; first record of another session → `foreign_session`; no `session_meta` → `foreign_session`; a symlinked history → `not_owned_file`.
  - `keeps a half-written last line`: history = valid `session_meta` line + one repairable item line + `'{"type":"respo'` (no trailing `\n`) → `repairHistory` returns without throwing; the file's last bytes equal `'{"type":"respo'`; the repairable line is repaired.
  - `still refuses a broken line that ends in a newline`: same tail followed by `\n` → throws `invalid_json`.
  - `leaves a complete unterminated last line alone`: last line valid JSON without `\n` → bytes unchanged, no throw (Review Focus 1).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/engines/kit/resumeRepair.spec.ts` — Expected: new tests FAIL (no `ResumePreparationError`; tail throws).
- [ ] **Step 3: Implement.** `historyRepair.line(line, last: boolean)`: when `last` and `JSON.parse` fails, return the line unchanged and set a `partialTail` flag instead of throwing; `scanHistory` passes `last = true` only for the final fragment that had no newline; `repairHistoryText` passes `last` for the final element only when the input does not end in `\n`. `repairHistory` logs `resume history ended in a partial line; kept as is` (the file's existing logger) when the flag is set.
- [ ] **Step 4: Run** the spec file and `resumeRepair.real.spec.ts` — Expected: PASS.
- [ ] **Step 5: Edit spec §2**: replace "and counted as `resume_preparation_partial_tail`" with "and logged; no counter (a resume that succeeds has no failure to attach it to)".
- [ ] **Step 6: Commit** `fix(resume): typed preparation errors; a half-written last history line no longer refuses`.

### Task 3: The resume reply and counters carry the kind

**Files:**
- Modify: `cli/src/lib/resumeAgentService.ts:276-278`
- Modify: `cli/src/lib/productUsageSignals.ts` (`productUsageRequest`'s returned function), `cli/src/backendSocket.ts:~949` (the `measured(...)` call)
- Test: `cli/src/lib/resumeAgentService.spec.ts`, `cli/src/lib/productUsageSignals.spec.ts`

**Interfaces:**
- Consumes: `ResumePreparationError` (Task 2), `RESUME_PREPARATION_KINDS` (Task 1).
- Produces: reply `{ ok: false, error: 'RESUME_PREPARATION_FAILED', reason: ResumePreparationKind, detail }`; the measured callback becomes `(error, state, hasAgent, ok?, failure?, preparation?: unknown)`, and `backendSocket` passes `p.reason`.

- [ ] **Step 1: Write failing tests.**
  - `resumeAgentService.spec.ts` `reports why preparation failed`: stub `prepareSessionResume` to throw `new ResumePreparationError('changed_during', 'rollout changed…')` → reply `reason === 'changed_during'`, `detail === 'Codex is still writing this conversation. Try again once it stops.'`; a plain `Error` → `reason === 'other'`, detail unchanged (`'Could not prepare the saved conversation. Its history has been retained.'`); the daemon log receives `resume preparation failed: changed_during: rollout changed…`.
  - `productUsageSignals.spec.ts` `counts a preparation kind once`: a resume answered `('RESUME_PREPARATION_FAILED', undefined, false, false, undefined, 'invalid_json')` from source `app` emits `request_app_resume_preparation_invalid_json` and `request_app_resume_reason_preparation_failed`; an unknown string → `..._preparation_other`; no `preparation` → no preparation counter.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/resumeAgentService.spec.ts src/lib/productUsageSignals.spec.ts` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** in the three files; the kind is emitted through `detail('preparation_<kind>')`, normalised against `RESUME_PREPARATION_KINDS`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Edit spec §1**: "Desktop's text for the refusal names the cause" → "The reply's detail names the cause" (same sentence otherwise).
- [ ] **Step 6: Commit** `feat(resume): the reply and counters say why preparation failed`.

### Task 4: Launch refusals and agent-started launches

**Files:**
- Modify: `cli/src/lib/productUsageSignals.ts` (`ProductUsageLaunchSignal`, `productUsageLaunch` ~88–107)
- Modify: `cli/src/backendSocket.ts:939-940`
- Modify: `cli/src/gateway/productUsage.ts` (`launch()` ~425–475)
- Test: `cli/src/lib/productUsageSignals.spec.ts`, `cli/src/gateway/productUsage.spec.ts`

**Interfaces:**
- Consumes: Task 1 names.
- Produces: `export const LAUNCH_REFUSALS = new Set(['SESSION_IN_HARNESS', 'SESSION_OPEN_ELSEWHERE', 'SESSION_OPEN_IN_TERMINAL', 'SESSION_BUSY_IN_TERMINAL', 'INVALID_REQUEST'])`; signal `phase` gains `'refused'`; signal gains `agentStarted?: true` on `start`; `productUsageLaunch(type, id, emit, engine?, agentStarted = false)`. `backendSocket` passes `(frame.payload as { startedBy?: unknown })?.startedBy === 'agent'`.

- [ ] **Step 1: Write failing tests.**
  - `productUsageSignals.spec.ts` `a correct refusal is not a launch failure`: for each code in the refusal set, `productUsageLaunch('agent_create', ID, emit)` then the reply `(code, 'failed')` emits `{ phase: 'refused', code: <lower-cased listed code> }` and no `phase: 'failed'`; `'SPAWN_FAILED'` still emits `phase: 'failed'`.
  - `productUsageSignals.spec.ts` `marks an agent's launch`: `productUsageLaunch('agent_create', ID, emit, 'claude', true)` emits `{ phase: 'start', engine: 'claude', agentStarted: true }`.
  - `gateway/productUsage.spec.ts` `counts refusals and agent launches apart`: start(agentStarted) + refused(`session_in_harness`) → counters `launch_started`, `launch_agent_started`, `launch_refused`, `launch_refused_code_session_in_harness`, `launch_agent_refused`; and none of `launch_failed`, `launch_agent_failed` (Review Focus 3). A person's start + failed → `launch_failed` only, no `launch_agent_*`. An agent's start + created → `launch_created` and `launch_agent_created`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/productUsageSignals.spec.ts src/gateway/productUsage.spec.ts` — Expected: new tests FAIL.
- [ ] **Step 3: Implement.** The gateway stores `agent: boolean` on the launch record at `start`, adds `launch_refused` / `launch_refused_code_<listed>` on `refused`, and the `launch_agent_<phase>` twin for `started`, `created`, `failed`, `refused`. `refused` marks the launch done like the other final phases.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(usage): correct refusals and agent launches counted apart`.

### Task 5: One cloud request check for the service and `harness new`

**Files:**
- Modify: `cli/src/lib/cloudAgents.ts` (new export), `cli/src/cloud/service.ts:246-252`, `cli/src/lib/newCommand.ts` (`parseNewArgs`, after the `--repo` check ~171)
- Test: `cli/src/lib/newCommand.spec.ts`, existing `cli/src/cloud/service.spec.ts` (must stay green)

**Interfaces:**
- Produces: `export function cloudRequestRefusal(agent: CloudAgentId, task: string, repository: string | null | undefined): string | null` in `cloudAgents.ts` — returns the exact `detail` strings `service.ts` uses today (no task; not a GitHub repository; a coding agent without `repositoryOptional` and no repository), else `null`. `repositoryOf` moves with it if `service.ts` is its only home.

- [ ] **Step 1: Write failing tests** in `newCommand.spec.ts`:
  - `refuses a cloud task locally`: `parseNewArgs(['cursor-cloud'])` (no task) throws `NewUsageError` with `'Tell Cursor Cloud what to do.'`; `['cursor-cloud', '--repo', 'gitlab.com/a/b', '--', 'x']` throws with `'That is not a GitHub repository: give owner/name or https://github.com/owner/name.'`; `['cursor-cloud', '--', 'x']` throws `'Choose a GitHub repository for Cursor Cloud.'`.
  - `lets Devin Cloud start without a repository`: `['devin-cloud', '--', 'x']` parses (Review Focus 5).
  (Use the names from `CLOUD_AGENTS`; if `cursor-cloud` is not a coding agent there, use the first `kind: 'coding'` entry without `repositoryOptional`.)
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/newCommand.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the helper; `service.ts` returns `{ ok: false, error: 'INVALID_REQUEST', detail }` from it; `parseNewArgs` throws `NewUsageError(detail)` from it.
- [ ] **Step 4: Run** `newCommand.spec.ts` and `src/cloud/*.spec.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `fix(cli): harness new checks a cloud task before sending it`.

### Task 6: First-arrival Retry does not create twice

**Files:**
- Modify: `desktop/lib/state/first_arrival.dart` (`run` ~220–290)
- Test: `desktop/test/first_arrival_test.dart`

**Interfaces:**
- Consumes: nothing new. `AgentCreationAttempt.agentId` and `.awaitingConfirmation` exist.

- [ ] **Step 1: Write failing tests** in `first_arrival_test.dart`, using the file's fake `createAgent` (line ~100) with a call counter:
  - `retry after the pane was missing waits for the same harness`: first run's create returns an id but no pane appears → error `'The harness has not opened yet. Try again to check it.'`; add the pane with that `agentId`; `retry` → succeeds, and `createAgent` was called **once**.
  - `retry after a failed create creates again`: first create fails → `retry` calls `createAgent` a second time.
  - `retry while confirming keeps the same attempt` (Review Focus 4): an attempt with `awaitingConfirmation == true` → `retry` re-checks it, no second create.
- [ ] **Step 2: Run** `cd desktop && flutter test test/first_arrival_test.dart` — Expected: the first test FAILS (two creates).
- [ ] **Step 3: Implement.** In `run`, when `_attempt?.agentId != null` and the previous failure was the missing pane, skip the create and go straight to the pane lookup (waiting as the first run does); keep `_attempt` instead of replacing it.
- [ ] **Step 4: Run** the test file, then the New Harness coverage gate: `flutter test --coverage --branch-coverage && node tool/check_new_harness_coverage.mjs coverage/lcov.info` — Expected: PASS; gate prints `100%` (or the same pre-existing gap as `main` — record it, do not widen it).
- [ ] **Step 5: Commit** `fix(desktop): first-arrival Retry waits for the harness it already made`.

### Task 7: Whole-change checks

- [ ] **Step 1: Run** `cd cli && npm test` and `npx tsc --noEmit -p .`; `cd backend && npm test`; record pass counts.
- [ ] **Step 2: Run** the CLI coverage gates the touched areas fall under (AGENTS.md): `npm run test:core` and `npm run test:resume`. Expected: PASS.
- [ ] **Step 3:** No commit unless a fix was needed; record results in the PR body.
