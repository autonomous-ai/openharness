# Engine sign-in report plumbing implementation plan

> Implement natively, task by task, with failing tests committed before their fixes.

**Goal:** Carry installed pane engines' sign-in results through the shared probe and machine reports without admitting an unverified engine.

**Architecture:** Let `engineAccount` own engine-specific knowledge; the shared probe calls it for every installed process engine and projects only boolean/null sign-in and numeric/null activity. Swarm readiness can preserve any known process-engine response, but its periodic request stays limited to engines with account readers (Claude/Codex today), and the owner relay can satisfy only those two. Existing start admission remains unchanged.

**Tech Stack:** TypeScript, Node 22.23.2, Vitest.

**Spec:** Task #3839, narrowed by River on 2026-11-06: shared probe/report plumbing and admission safeguards only. Vendor probes are deferred to small tasks on machines with those engines installed; no new engine becomes selectable in this change.

## Global Constraints

- No secret in any report or log. Same admission rules as today's two engines.
- Owns `cli/src/`; no backend, Desktop or admission changes.
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

### Task 2: Carry process-engine readiness safely

**Files:** `cli/src/superTabs/machines.ts`, `cli/src/superTabs/machines.spec.ts`, `cli/src/lib/machineEngines.ts`, `cli/src/lib/machineEngines.spec.ts`.

**Interfaces:** consumes task 1 availability rows; produces existing machine readiness payload and `harness machines engines` rows. No new admission API.

- [x] Test readiness includes signed-in/out/unknown other process engines, ignores terminal/unknown names, strips extra fields, and does not use Claude/Codex relay for them. Retain cache and relay recovery assertions. Test machine-engine requests include accounts=true so their sign-in column is populated.
- [x] Run the two affected test files, observe failures, commit tests.
- [x] Keep the periodic request at Claude/Codex until another account reader lands, filter responses to known process engines, and limit relay satisfaction to Claude/Codex. Ask for accounts in the machine-engine command and update comments. Keep the separate launch admission/install gate unchanged.
- [x] Run those tests plus start/admission and account/probe tests; run CLI typecheck. Commit and push.

## Validation

Local: affected tests (`engineProbe`, `engineAccount`, `machineEngines`, `superTabs/machines`, `superTabs/start`) and importers of changed modules; CLI typecheck. Linux full CLI suite comes from automatic Ready PR CI. No native vendor sign-in evidence is claimed: vendor probes are outside the narrowed scope. Review checks the unchanged admission gate and scalar-only reports. Record red/green evidence in a PR comment before Ready.

## Validation receipts

- CLI Node 22.23.2: typecheck passed; affected/importer run 1087 passed, four existing 5s timeouts. Focused serial retry with 30s timeout: seven selected tests passed, including those four. No implementation changes between those runs.
- Before/after test commits and exact commands are in the PR red/green comment. Linux CLI suite remains automatic Ready PR CI evidence.

## Security review correction

The initial implementation requested all fifteen engines periodically. Security review identified unused idle login-shell work, so the periodic request returns to Claude/Codex and its original 20-second deadline. A regression test first fails on the fifteen-engine request, then passes on the bounded request. On-demand account probing remains generic for vendor-reader follow-ups.

With periodic reports still containing only two requested engines, the backend row-bound change is unnecessary and removed, along with its added test. The final diff is CLI-only and needs no backend-first rollout. The earlier backend test/implementation commits remain in history to explain their reversal. Minor unsupported-reader early-return cleanup is deferred as the project review rules require.
