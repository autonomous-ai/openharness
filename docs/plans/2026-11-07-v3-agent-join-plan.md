# Swarm v3 agent join implementation plan

> Implement task by task with tests committed and observed failing before code, followed by independent review and security reviews.

**Goal:** Join an org by bringing an agent on this computer, and create Regular or PM agents without the old add-machine/Team-account sequence.
**Architecture:** Reuse the authenticated join transport and native prompt surfaces. Own join widgets under `desktop/lib/super_tabs/join/`; keep shell wiring with #4118 and consume #4116's v3 command contract. Engine selection starts the person's own CLI settings. New Regular agents have no project; PM creation names and starts one.
**Tech Stack:** Flutter/Dart; existing SuperTab request/controller, memory fixtures and fake sign-in.
**Spec:** Task #4121; shared docs/specs/2026-11-07-swarm-v3.md from #4116.

## Global Constraints

- Desktop only, light and dark; no phone/web work.
- No login reads, Team account setup, subscription relay or add-machine step.
- Use existing native launch path; no process spawning in widgets.
- Server/daemon enforce owner identity and capability. Never accept identity from form input.
- Backend contract ships first. No legacy fallback that reads credentials or enrolls a machine.

## Design

- Growth: form state and operation receipts exist only for the current dialog; persisted agents/projects use #4116's bounded lifecycle.
- Concurrency: one in-flight submission; retries reuse the operation ID. Backend/daemon own mutation locks.
- Read cost: use existing local machine/engine observations, no new polling or full-state scans.
- Scale: one bounded engine picker and one mutation per submission; no fan-out. Backend command latency is the first warning metric.
- Compatibility: unsupported v3 backend reports an actionable upgrade error, never falls back to Team setup.
- Migration/rollback: backend first; no Desktop data migration. Revert widgets if necessary without deleting agents/projects.
- Audience: existing authenticated membership/visibility enforcement on server.
- Identity: current signed-in person's local agent, never another machine owner's login.
- Failure: visible bounded-time failure/retry, stable operation ID, account-change/dismiss guards.
- Platforms: macOS, Linux, Windows Desktop; offscreen tests on macOS, no new process launch path.

## Review Focus

- Join acknowledgement followed by lost agent-start response retries without duplicating membership or Buddy.
- Account switches and late responses cannot open another account's org or agent.
- PM project name is trimmed/required; Regular creation sends no project.
- Missing local daemon/engine is visible and recoverable without enrolling a remote machine.
- No raw network errors or secrets appear in UI.

## Task 1: Join with an engine

**Files:** `desktop/lib/super_tabs/join/bring_agent_dialog.dart`, existing `join_dialog.dart`; `desktop/test/swarm_v3_join_test.dart`.
**Interfaces:** authenticated join request; #4116 local bring-agent command; current-account guard; completion callback to select Buddy.

- [ ] Commit failing tests for engine selection, no Team/machine choice, join/Buddy completion, timeout/retry and account changes.
- [ ] Observe red, implement the flow using the confirmed contract, run affected join tests.
- [ ] Commit implementation and push draft PR.

## Task 2: Regular or PM creation

**Files:** `desktop/lib/super_tabs/join/new_agent_dialog.dart`; `desktop/test/swarm_v3_new_agent_test.dart`.
**Interfaces:** `showSwarmNewAgentDialog` for #4118; current local machine and available engines; #4116 own-agent creation contract.

- [ ] Commit failing tests for Regular, PM project validation/start, duplicate submissions and safe visible failures.
- [ ] Observe red, implement native prompt and contract request, run affected tests.
- [ ] Commit and push; coordinate shell integration and remove obsolete join choice presentation.

## Task 3: Evidence and handoff

**Files:** screenshot fixture under `desktop/test/`; plan results.
**Interfaces:** memory store/fake sign-in; light/dark captures of both flows.

- [ ] Capture both themes, analyze changed files, run style gate and affected integration tests.
- [ ] Record red/green evidence, platforms and limitations; ready PR with review and two independent security reviews requested.
