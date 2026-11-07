# PM reaction settlement implementation plan

> Implement natively, task by task, with a committed failing test before the fix and one independent review.

**Goal:** A PM's explicit reaction settles a person's message, so a joke needs no reply just to leave the owed list.

**Architecture:** Reuse the existing message.react → settleReaction path and owed-list/pulse persistence. Accept every supported reaction instead of only verdict emoji. Keep the PM identity, on=true and exact-message checks; receipt reactions written internally never call this explicit-command path.

**Tech Stack:** TypeScript, Vitest, existing Prisma/MongoDB transaction; no dependency or schema changes.

**Spec:** Task #3663, conversation ef3328db5c39c5f324771e27. River's 2026-11-06 clarification supersedes the initial question exception: “No phrase check ... Every person's message stays owed until the PM replies or reacts. A PM reaction settles it ... The PM decides what needs words.” Test Leo's one-line joke, plus a question to pin that ruling.

## Global Constraints

- One task/branch/PR; first body line: Requested by dee through Harness.
- Do not infer requests from language or punctuation. An explicit PM reaction or reply settles the message.
- Other agents and people, removing a reaction, and automatic receipt eyes do not settle PM owes.
- No production writes, secrets, sign-outs, system installs or CLI core changes. Temp files only in mktemp -d folders; stop only own processes by id.
- Affected tests locally; full backend and Super Tab integration suites in ready PR CI. Red/green evidence in a PR comment; one review.

## Design

- **Growth/concurrency:** No new state; remove a row from the existing 50-row owed list under the existing transaction/fence.
- **Read cost/scale:** No query/index changes or extra reads. Existing bounded owed scan; no classifier, content read or transcript copy.
- **Compatibility/rollback:** Existing records and clients unchanged. Rollback restores verdict-only settlement; it does not recreate rows already settled.
- **Audience/identity:** Only the actual project's PM's explicit command settles that message; existing reaction/message access checks still apply.
- **Failure/platforms:** Normal validation failures remain visible. Shared backend behavior on every client; no screen/layout changes.

## Review Focus

- Eyes, laugh and heart must clear the joke as verdict reactions already did (unit and real-store tests).
- A question also clears on a PM reaction, per the later PM ruling; no phrase classifier (unit and real-store tests).
- Another person's/agent's reaction and taking a reaction off must leave the PM's owes intact (existing and extended unit tests).
- Reacting to one thread message must not clear its siblings (unit test).
- Automatic receipt eyes must remain a receipt, not an explicit answer; only message.react invokes settleReaction (verify the command boundary and retain receipt tests from #3609).

### Task 1: Settle an explicit PM reaction

**Files:** pulse.ts, commands.ts; pulse.test.ts, integration/superTabs.test.ts.
**Interfaces:** settleReaction(state, group, agentId, messageId, on) removes only that owed message when the actual PM adds a reaction. The emoji is already validated by message.react.

- [x] Commit tests: all seven reactions clear a social message and owedLines/pulse; questions clear too; removing a reaction/other actors do not; thread siblings remain. Add a real-store joke/question case proving persisted owed state (`cb868b10b`).
- [x] Run new tests and observe missing eyes/laugh/heart settlement before implementation: four unit failures and the real-store joke remained owed.
- [x] Remove verdict-only filtering and its unused set/argument; keep actual-PM/on/exact-message checks and automatic receipt path unchanged.
- [x] Run pulse, commands, answers, inbox, reactions and liveness importers: 545 tests pass; four affected real-store reaction/answer/index cases pass; typecheck clean.
- [x] Commit/push the green fix and record red/green evidence in the PR. Full component suites run in ready CI.
- [ ] Independent review confirms the final head.

## Evidence

- `npm --prefix backend test -- src/superTabs/pulse.test.ts src/superTabs/commands.test.ts src/superTabs/answers.test.ts src/superTabs/inbox.test.ts src/superTabs/reactions.test.ts src/superTabs/liveness.test.ts`: 545 passed.
- `npm --prefix backend run test:super-tabs -- integration/superTabs.test.ts -t 'a PM reaction settles|closes the reacting agent|settles a reaction.s deliveries by index|closes an agent.s delivery when it answers'`: four passed. The joke and question leave durable owed state without replies; other actors/removal do not clear them; existing answer/delivery isolation and indexed delivery updates still pass.
- `npm --prefix backend run typecheck`: passed. No query, index, schema, dependency or screen changes; no production reads/writes.
