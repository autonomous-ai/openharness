# Engine and machine suspension implementation plan

> The Engineer implements this plan sequentially, test first, with one independent review of the complete pull request. Commit each failing test before its implementation.

**Goal:** Keep usable engines available while backing off repeated engine failures and unresponsive machines.

**Architecture:** Classify only known engine failures from existing start receipts; unknown/setup failures remain failed starts without engine penalties. Retain bounded backoff state on the existing machine part, with separate engine and machine cooldowns. Admission and both read projections expose the same cooldown decision; CLI routing explains setup failures without excluding otherwise usable engines.

**Tech Stack:** TypeScript, Vitest, existing MongoDB machine parts and guarded transactions.

**Spec:** Swarm task #3293, “Engine suspension counts only the engine's own failures, and backs off instead of a flat 6 hours,” requested by Ken on 2026-11-05. Requirements: only engine launch/exit/question/sign-in failures count against an engine; clone/token/folder/commit/tool/model/permission-flag failures do not. Three-minute pickup failures count against the machine across engines. Two failures suspend; cooldowns progress 30m, 1h, 2h, 4h, 8h, 12h (cap), reset by success. A signed-in reading clears a sign-in suspension even when quota is unknown. Owner resume remains available.

## Global Constraints

- Scope: backend Super Tabs and CLI routing notes; no Swarm logic in `cli/src/core`.
- Preserve raw failure audience rules; route notes contain fixed categories, never raw paths, tokens or terminal text.
- No real CLI sign-out, no production writes, no new runtime dependencies or timers.
- Keep current two-failure threshold; ignored failures neither increment nor reset it. An active suspension produces one notice and does not accumulate another penalty.
- Backend unit suite and focused engine-health integrations before Ready, as explicitly requested in the task. Full Super Tab integration suite runs in PR CI only.
- One independent review. Integrator owns batched merge and release, outside 09:00–10:00 VN and within the release window.
- PR body starts: Requested by 0xKen15 through Harness.

## Design

1. **Growth:** At most one counter, capped backoff level and active suspension per supported engine, plus one set for the machine. Success removes its state; owner resume clears its engine state; expiry removes active suspensions but retains bounded backoff levels until success/removal. Machine removal/account replacement deletes all health state. Saving settings preserves it.
2. **Concurrency:** Existing guarded machine-part writes serialize failure receipts, successes, sweeps and readings. Commands count the first failure only; a late host report cannot count a server timeout twice. Fast readings fall back to the full transaction whenever a suspension changes.
3. **Read cost:** No new query, scan, history load or polling. Existing machine reads carry bounded counters; derived reads return fixed suspension sentences. CLI uses the starts it already reads.
4. **Scale:** Cost remains linear in listed machines and constant per engine, even after arbitrarily many failures. Measure a fixed machine-health workload before/after; track existing start failure notices and machine-part byte size. No growing failure history is added.
5. **Compatibility:** Extend existing suspension records with optional duration/cause and add optional backoff/machine state. Legacy `{at,fine}` records retain their six-hour expiry and old recovery rule because their cause is unknown. Both `store.ts` and `read/views.ts` expose machine cooldowns and existing per-engine refusal strings; old clients still see all engines suspended. New CLI tolerates old servers with no machine field. Review seats use the same suspension projection. No native launch contract changes.
6. **Migration/rollback:** Backend first, CLI second; no schema/index migration or production data rewrite. Old backend ignores additive machine/backoff fields and treats engine entries with its existing six-hour semantics; rollback therefore restores the old policy, not data loss. Re-contribution on an old backend can discard new optional fields; document this operational limitation. Fixture rows cover legacy shape.
7. **Audience:** Existing machine visibility and failure-reason predicates remain authoritative. New derived messages reveal only cooldown scope/duration. No copied raw failure reasons.
8. **Identity:** All actions keep existing authenticated host/owner checks. No sign-in, credential, account or execution identity changes.
9. **Failure:** Start failures retain their original reason and recipients. Suspension notices occur once and routing/admission agree. Ignored failures remain visible as route notes; unknown text is conservatively uncounted.
10. **Platforms:** Backend on Linux; pure CLI routing on macOS/Linux/Windows. No process spawning or platform-specific behavior changes.

## Review Focus

- Real setup errors contain words like “token,” “launch” and “sign in”; only known engine-specific summaries count (task 1).
- Repeated expired cooldowns retain escalation through machine readings and settings saves, and success resets only the appropriate engine plus machine (tasks 2–3).
- Timeouts of different engines combine at machine level; grid starts cannot bypass a machine cooldown (task 3).
- A healthy reading clears sign-in failures only, not a different launch/question failure; legacy records remain readable (task 2).
- A timeout followed by its host's failure is counted once; owner resume permissions and public reason redaction remain intact (task 3).

### Task 1: Attribute failures to engines precisely

**Files:** `backend/src/superTabs/engineHealth.ts`, `engineHealth.test.ts`.

**Interfaces:** Keep `noteStartFailed(state, start, now): string | null`; add a private classification of known engine launch/exit/question/sign-in failures, leaving unknown/setup errors uncounted.

- [ ] Add table-driven negative cases for clone, GitHub token, missing folder/commit/tool, unavailable model, permission flags, removed/moved machines and unknown request/account failures; positive cases use real native exit and hidden-screen summaries.
- [ ] Commit tests; run `npm test -- src/superTabs/engineHealth.test.ts --maxWorkers=2` and retain failing evidence.
- [ ] Implement conservative classification; run the same test plus direct command/liveness callers; commit and push.

### Task 2: Back off engine failures and recover by cause

**Files:** `backend/src/superTabs/engineHealth.ts`, `machines.ts`, `commands.ts`, `engineHealth.test.ts`, `commands.test.ts`, `backend/integration/superTabs.test.ts`.

**Interfaces:** Extend `engineSuspensions` with optional `durationMs` and `cause`; retain bounded `engineBackoff` per engine. Existing `readingClearsSuspensions`, `noteStartSucceeded`, `resumeEngine`, `engineUnusable`, `suspendedEngines` remain entry points.

- [ ] Test literal durations 30m/1h/2h/4h/8h/12h/12h across expiry and readings; test success reset, owner resume, settings preservation and legacy records.
- [ ] Test signed-in plus unknown quota clears sign-in cause only; mixed failures must not clear a launch failure.
- [ ] Commit failing tests and capture red; implement duration/cause/reset semantics and settings preservation, run focused tests, commit and push green.

### Task 3: Machine timeouts and route explanations

**Files:** `backend/src/superTabs/{engineHealth,machines,commands,store}.ts`, `backend/src/superTabs/read/{views,contract}.ts`, their existing tests, `backend/integration/superTabs.test.ts`, `cli/src/superTabs/{route,routeCommand}.ts`, corresponding specs.

**Interfaces:** Add bounded machine timeout counters/backoff/suspension and `machineSuspensionReason(machine, now): string | null`. Server exposes optional `machineSuspended` plus per-engine reasons for older clients. CLI `unreadyPool` treats the machine reason as an all-engine refusal; route notes use fixed descriptions of recent setup failures.

- [ ] Test alternating-engine timeouts, one notice, double-report suppression, successful start reset, expiry/backoff, grid admission and preservation across re-contribution.
- [ ] Test both read projections and persisted host readings; test route all-engine refusal and safe setup notes while candidates stay available.
- [ ] Commit failing tests and capture red; implement through existing command/read paths, run affected tests and commit/push green.
- [ ] Run backend unit suite, focused Super Tab engine-health integrations, CLI routing specs and both typechecks with bounded workers/timeouts. Full integration and CLI suites remain automatic PR CI.
- [ ] Record red/green evidence and timings in a PR comment, mark Ready, request the Integrator's independent review, and resolve findings.
