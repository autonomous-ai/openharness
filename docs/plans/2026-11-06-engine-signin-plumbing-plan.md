# Engine sign-in report plumbing implementation plan

> Implement natively, task by task, with failing tests committed before their fixes.

**Goal:** Carry installed pane engines' sign-in results through the shared probe and machine reports without admitting an unverified engine.

**Architecture:** Let `engineAccount` own engine-specific knowledge; the shared probe calls it for every installed process engine and projects only boolean/null sign-in and numeric/null activity. Swarm readiness reports every known process engine but the owner relay can satisfy only Claude/Codex. Existing start admission remains unchanged.

**Tech Stack:** TypeScript, Node 22.23.2, Vitest.

**Spec:** Task #3839, narrowed by River on 2026-11-06: shared probe/report plumbing and admission safeguards only. Vendor probes are deferred to small tasks on machines with those engines installed; no new engine becomes selectable in this change.

## Global Constraints

- No secret in any report or log. Same admission rules as today's two engines.
- CLI plumbing owns `cli/src/`; no Desktop or admission changes. The report validator dependency below is the minimal backend report-validator dependency.
- Never touch the person's real sign-in. Tests replace external shell/account boundaries.
- No installs or new background processes. Existing four-worker probe limit stays.
- Unknown sign-in is null, never true; uninstalled engines are not account-probed.

## Design

- Growth: reports remain bounded by the engine catalog; ten-minute readiness cache replaces old values.
- Concurrency: existing four probe workers and readiness cache; no new shared state.
- Read cost: opt-in account reads, installed process engines only; unsupported readers return unknown.
- Scale: 10x engines increases bounded batches; probe duration is the first warning metric.
- Compatibility: existing fields and tri-state semantics; old daemons remain unknown.
- Migration/rollback: no persisted schema change; revert the plumbing.
- Audience: existing authenticated machine report transport; server admission unchanged.
- Identity: each machine's local account; owner's relay applies only to its two supported engines.
- Failure: account read errors become unknown without forwarding error contents.
- Platforms: shared TypeScript, no new process launch or platform-specific mechanism.

## Review Focus

- Credential-bearing reader results/errors must never be copied into reports (task 1).
- A failed reader or older daemon must not appear signed in (tasks 1/2).
- A healthy owner relay must not mark Cursor or another unsupported engine signed in (task 2).
- Terminal/unknown catalog names must not enter Swarm readiness (task 2).
- Existing Claude/Codex admission and relay recovery must still work (task 2).

### Task 1: Generalize the opt-in account probe

**Files:** `cli/src/lib/engineProbe.ts`, new `cli/src/lib/engineProbe.spec.ts`.

**Interfaces:** consumes `engineAccount(engine): Promise<EngineAccount>` and the existing launch/install probes; produces unchanged `probeEngines(engines, { accounts })` availability rows.

- [x] Add tests with controlled external launch/account boundaries: installed Cursor signed in/out/unknown; missing installs and accounts=false never read accounts; thrown errors become null; extra credential fields never escape.
- [x] Run `npx vitest run src/lib/engineProbe.spec.ts --maxWorkers=1`, watch missing account fields fail, commit tests.
- [x] Call the account reader for every installed process engine, explicitly project safe scalar fields, and return unknown on reader failure. Update field comments.
- [x] Run affected probe/account tests and commit implementation.

### Task 2: Carry all process-engine readiness safely

**Files:** `cli/src/superTabs/machines.ts`, `cli/src/superTabs/machines.spec.ts`, `cli/src/lib/machineEngines.ts`, `cli/src/lib/machineEngines.spec.ts`.

**Interfaces:** consumes task 1 availability rows; produces existing machine readiness payload and `harness machines engines` rows. No new admission API.

- [x] Test readiness includes signed-in/out/unknown other process engines, ignores terminal/unknown names, strips extra fields, and does not use Claude/Codex relay for them. Retain cache and relay recovery assertions. Test machine-engine requests include accounts=true so their sign-in column is populated.
- [x] Run the two affected test files, observe failures, commit tests.
- [x] Request all PROCESS_ENGINES in own readiness, filter to known process engines, and limit relay satisfaction to Claude/Codex. Ask for accounts in the machine-engine command and update comments. Keep the separate launch admission/install gate unchanged.
- [x] Run those tests plus start/admission and account/probe tests; run CLI typecheck. Commit and push.

### Task 3: Preserve the expanded report at the server boundary

**Files:** `backend/src/superTabs/machines.ts`, `backend/src/superTabs/machines.test.ts`.

**Interfaces:** existing `machineObservationSchema` accepts readiness rows; admission schemas stay unchanged.

Discovery: the backend rejects more than eight readiness rows. The full process-engine catalog has fifteen, so the CLI change otherwise rejects every expanded report. Raised with River in the task thread; the validator-only dependency is included for review, without changing engine admission.

- [x] Add a test accepting the literal fifteen-engine catalog (boolean/null fields) and rejecting 17 rows and credential-bearing rows.
- [x] Run `npm test -- src/superTabs/machines.test.ts`, watch the catalog report fail, commit tests.
- [x] Raise only readiness.engines' bound from 8 to 16; no contribution or start allowlist changes.
- [x] Run the affected backend tests and backend typecheck. Automatic PR CI supplies backend unit and Super Tab integration evidence.

Rollout: backend accepting sixteen rows must ship before a CLI sends fifteen. Older CLI reports remain valid. No schema, query or index changes.

## Validation

Local: affected tests (`engineProbe`, `engineAccount`, `machineEngines`, `superTabs/machines`, `superTabs/start`) and importers of changed modules; CLI typecheck. Linux full CLI suite comes from automatic Ready PR CI. No native vendor sign-in evidence is claimed: vendor probes are outside the narrowed scope. Review checks the unchanged admission gate and scalar-only reports. Record red/green evidence in a PR comment before Ready.

## Validation receipts

- CLI Node 22.23.2: typecheck passed; affected/importer run 1087 passed, four existing 5s timeouts. Focused serial retry with 30s timeout: seven selected tests passed, including those four. No implementation changes between those runs.
- Backend: 34 machine tests passed (catalog test first failed on the eight-row validator); 503 related command, Buddy-machine, engine-health and slot tests passed. Typecheck passed.
- Before/after test commits and exact commands are in the PR red/green comment. Linux component suites and backend integration remain automatic Ready PR CI evidence.
