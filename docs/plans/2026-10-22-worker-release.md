# Finished-worker decisions implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Require the Lead to reuse, keep or stop each finished worker; stopping closes its native session and returns its machine slot.

**Architecture:** Persist the decision on the Swarm agent, independently of the group's replaceable assignment. The backend gates new routing, starting and assignment. The execution host consumes stop requests through the existing identity-bound core lifecycle, including its service-process bridge, and confirms removal through the command transaction, which also cancels deliveries. A global SuperTabRun reservation prevents another public Swarm from assigning the same native session during close. A pending stop cannot be reversed or reassigned, so a stale host read cannot stop newly assigned work.

**Tech stack:** Existing TypeScript, Zod, Prisma/MongoDB, Vitest and Flutter. No new dependencies.

**Spec:** The Lead's brief in this group's assignment: finished work requires reuse, keep or stop; only the project's Lead or the tab owner/contributor decides; active work is never stopped; host-confirmed removal frees slots. Deliver a draft PR only.

## Global constraints

- Work from current origin/main; keep changes within worker release ownership and its necessary model/tests.
- Product = Swarm; coordinating role = Lead; visible copy in plain English.
- CLI tests use Node 24 and disposable data; never touch port 18473, the real tmux or personal agent homes.
- Keep older clients compatible through optional fields; explain unsupported commands from older backends plainly.
- No new dependencies. Do not mark the PR ready, merge or release.
- Preserve the 2,000 UTF-16-unit launch prompt limit and adjacent groups' changes.

## Review focus

- Stop requests remain irreversible until removal; reuse cannot race host closure.
- Decisions survive replacing a brief or archiving the finished group.
- Only the execution host can acknowledge a requested stop; a person cannot fake this through an agent command.
- Repeated host polls and lost acknowledgements never close a replacement session or close the same session twice.
- Removing the agent also removes its outstanding deliveries and releases the slot despite an older running observation/start receipt.

### Task 1: Backend policy and state

**Files:** backend/src/superTabs/model.ts, commands.ts, machines.ts; commands.test.ts, machines.test.ts.

**Interfaces:** Optional agent decision tied to the finished assignment; helpers compute pending decisions by project and reject new work; agent.release accepts keep/stop. A host-only acknowledgement uses the existing agent.remove command for a stop-requested worker.

- [x] Add tests for Lead/owner/contributor permissions, active-work refusal, pending guards, keep/reuse/stop, brief replacement and host acknowledgement.
- [x] Run affected tests and observe failures caused by the missing behavior.
- [x] Implement persistence on completion, project guards and irreversible stop requests; expose pending decisions in status.
- [x] Verify affected backend tests pass.

### Task 2: Host lifecycle and integration

**Files:** backend/src/superTabs/store.ts, backend/integration/superTabs.test.ts; cli/src/superTabs/host.ts, host.spec.ts; cli/src/core/api.ts, experimentQueries.ts and their tests; cli/src/services/processCoreApi.ts and its tests. Core API additions are kept in a separate commit.

**Interfaces:** Host roster exposes stop requests only without active work. The CLI closes the exact agent-started native session through core.agents.close and checks core.agents.stopped before acknowledging agent.remove as that agent. The close request carries the exact native session identity and is exposed only to the Swarm service process. Backend removal requires the current release token, shares cancellation semantics with ordinary withdrawal, and stores a durable stopped-harness receipt independent of replaceable observations.

- [x] Add failing tests for host stop pickup, safe retry, refusal/unavailable lifecycle, foreign sessions and slot release through real Mongo transactions.
- [x] Implement stop pickup outside native delivery; withhold new input for stop-requested agents.
- [x] Verify host tests and backend integration pass, including cancelled deliveries and slot counts.

### Task 3: Guidance, validation and delivery

**Files:** cli/src/superTabs/service.ts (release HELP and compatibility only), desktop/lib/super_tabs/launch_prompt.dart, affected tests.

**Interfaces:** HELP lists keep/stop and recommends stopping unless more work is imminent; launch/delivery guidance tells the Lead to decide after completion.

- [x] Add failing tests for release HELP, older-backend error and launch prompt wording/length.
- [x] Implement guidance and plain unsupported-command error.
- [ ] Run CLI npm run test:super-tabs (100% coverage), npm run typecheck and affected host/service tests; backend npx tsc --noEmit, vitest run src/superTabs and npm run test:super-tabs; desktop flutter analyze and affected launch tests. Run required full component suites once with bounded workers, recording unavailable or baseline failures explicitly.
- [ ] Review the final diff independently; fix material findings and verify affected checks.
- [ ] Fetch/rebase current main, inspect new interactions and repeat only invalidated checks. Commit/push the reviewed changes and open a draft PR with exact evidence and timing. Report its URL and head revision.
