# Buddy engine switch implementation plan

> Implement natively, task by task, with failing tests committed before their implementation and one independent review of the finished pull request.

**Goal:** Let a person switch their Buddy to another signed-in engine when its subscription runs out, keeping its chat and folder.

**Architecture:** Add an owner-only `buddy.engine` request. Reuse the pane/PM engine handoff, durable switch receipt, replacement binding and rollback; keep model and engine switches mutually exclusive. The Buddy header reads the same machine sign-in observations the server validates and offers the same menu after a subscription-limit report.

**Tech Stack:** TypeScript backend and daemon; Flutter Desktop; Vitest and Flutter widget tests. No new dependencies.

**Spec:** Swarm task #3833, conversation `45894032d75e4f44a6a34c21`. Requested by dee through Harness. The task's mockup is posted there. PM ruling: ship Claude Code and Codex here; other engines and their sign-in probes are follow-up #3839.

## Global Constraints

- Keep the Buddy's chat history and its folder; one Buddy stays one Buddy.
- Offer only engines signed in on that machine. Unknown sign-in is unavailable.
- No secret in any log. Never copy an account or login to another machine.
- Desktop tests use a memory store and a fake sign-in; works on Windows the same (`docs/windows-rules.md`).
- Small and fast: no redesign of the Buddy header. Reuse existing process launch and handoff paths.
- Backend ships first. Gate new requests on the host's `buddyEngine` capability.

## Design

- Growth: reuse the single pending `switchRequest` per Buddy and existing expiring switch/operation receipts; no new collection. Completion or the existing bounded lease clears a request.
- Concurrency: existing serialized Swarm command applies requests; engine/model switches exclude one another. Daemon handoff receipts fence duplicate stops/starts and survive restart; a bounded recovered marker keeps a later Stop Harness stopped after rollback.
- Read cost: use current agent and machine observations; no new polling, database queries or transcript scan on idle passes. A switch reads the existing bounded handoff only on demand.
- Scale: bounded machine engine list and existing host fan-out; measure header build cost and command cost on the same fixture before/after. Switch latency uses the existing bounded claim/start leases.
- Compatibility: additive command/capability and Buddy host chat field; old hosts cannot receive a switch. Existing model commands and clients remain valid.
- Migration/rollback: no migration. Roll back clients first; backend additions may remain. A failed new session uses existing handoff recovery, with a visible failure line.
- Audience: only the Buddy's owner can request its switch; only its execution host can claim, bind and report that pending switch. Outcomes remain in the private Buddy chat.
- Identity: same machine, default engine account, same Buddy ownership and launch guard. No PM role or GitHub authority is inherited.
- Failure: stale readings, signed-out engines, busy switches, failed handoffs, timeout and rollback produce actionable visible results; logs contain failure categories only.
- Platforms: backend Linux; CLI macOS/Linux/Windows via existing hidden launch path; shared Flutter UI on macOS/Linux/Windows/web (and compact layout). macOS widget evidence here; Windows native window evidence remains an independent platform check.

## Review Focus

1. Another person or Buddy trying to switch or rebind this Buddy: refuse without changing its identity.
2. Engine/model changes racing, or a replay after host restart: at most one replacement, same chat and folder.
3. Missing, stale or signed-out engine readings: no selectable offer, server refuses before stopping anything.
4. A new session failing or arriving late: restore the original and never leave two running Buddies.
5. Subscription-limit and pending states in a narrow header: actionable text, no overflow, both themes.

### Task 1: Backend owner request and private outcome

**Files:** `backend/src/superTabs/buddies.ts`, new `buddyEngine.ts` and `buddyEngine.test.ts`, `commands.ts`, `buddyModel.ts`, `tidy.ts`, `terminal.ts`, `read/hostRows.ts`; focused tests of their callers.

**Interfaces:** `buddy.engine {engine}` writes the existing `Agent.switchRequest` with default profile, owner and operation id. Host rows expose `buddyConversationId`. Existing `agent.switchClaim`, `agent.rebind`, and `agent.switchResult` settle only the requested Buddy switch. `buddyEngine` is the new host capability.

- [x] Commit failing caller-level tests for owner-only admission, signed-in/fresh/capable host, mutual exclusion, rebind preserving chat, duplicate/stale results, expiry and limit notice.
- [x] Run the new tests and record their expected failures.
- [x] Implement request validation and private result/expiry lines using existing switch state; preserve Buddy-specific authorization.
- [x] Run the new tests and affected Buddy/model/terminal/rebind tests; commit and push the passing implementation.

### Task 2: Host handoff and recovery

**Files:** `cli/src/superTabs/leadSwitchRequest.ts`, `leadSwitch.ts`, `retention.ts`, `host.ts`, `machines.ts`, `inCore.ts`; `cli/src/lib/closeAgentService.ts`, its tests, and minimal wiring in `cli/src/core/main.ts` if required.

**Interfaces:** Consume Task 1's request/chat field; use `agent_handoff_prepare`, `agent_close`, `agent_create`, `agent_handoff_complete` with one deterministic creation id. Preserve Buddy role, owner guard, folder and chat prompt. Reuse the handoff-backed one-use close permit and rollback window.

- [x] Commit failing tests: Claude Code to Codex launch in the same folder with Buddy role/chat; no sign-in or stale owner refuses before close; duplicate/restarted request does not create twice; failed/late start recovers; ordinary close remains protected.
- [x] Run those tests and record their expected failures.
- [x] Extend existing handoff/recovery to Buddies, advertise capability only with the path implemented, and keep model switches exclusive.
- [x] Run affected host, switch, replacement, close and Windows launch guard tests; typecheck and applicable non-CI coverage gates; commit and push.

### Task 3: Header engine menu and limit action

**Files:** new `desktop/lib/super_tabs/buddy_engine.dart`, `buddy_model.dart`, `buddies.dart`, `controller.dart`, `model.dart`; new `desktop/test/super_tab_buddy_engine_test.dart`, screenshot test and existing Buddy test support.

**Interfaces:** `switchBuddyEngine(String engine)` submits Task 1's command. Offers come from a fresh machine `observation.readiness.engines` with installed/signedIn both true. `switchRequest` drives pending text and disables model changes.

- [x] Commit failing widget tests with memory store/fake sign-in for selecting Codex, hidden signed-out/unknown/stale engines, pending state, command refusal and limit-action menu.
- [x] Run them and record the expected failures.
- [x] Add a compact shared-menu engine picker beside the model picker; reuse it in the one-line limit notice. Keep engine labels accurate in the model menu.
- [x] Run affected Buddy tests on macOS, light/dark screenshot runs and narrow-layout tests. Record baseline/changed header timings and analyze changed files; commit and push.
- [x] Update the PR with red/green evidence, screenshots, platform limits and timings; mark ready and hand to the Integrator for independent review/test and release.
