# Buddy proposal offers implementation plan

> Implemented by the Engineer in this session, task by task, test first; one independent review of the pull request.

**Goal:** A Buddy offers to propose a ready idea once, checks existing work first, and sends the exact shown proposal only after its owner agrees.

**Architecture:** Update the four Buddy launch prompts and the shared built-in Buddy skill. Keep the existing proposal command, quoted-message consent contract and project boundaries.

**Tech Stack:** TypeScript and Vitest; no dependencies.

**Spec:** Harness task #3865, “A Buddy offers to turn a good idea into a proposal,” requested by Dee on 2026-11-06 (conversation `6c9be92915cf280cbc548667`).

## Global Constraints

- Prompt text only, plus tests of the built instructions.
- A ready idea has a clear goal, why it matters and a done-when condition.
- Check for an existing proposal or task before offering; point to a match instead of duplicating it.
- Show the exact proposal and ask “Want me to propose this to <project>?” without waiting to be asked.
- Never send without the person's agreement. One offer per idea; no nagging.
- Keep the quoted `I'll post this as you:` consent format and the existing project scope.

## Review Focus

- All four launch paths must carry the offer, duplicate-check and consent instructions.
- The built skill must agree with the launch prompt in every skill mode.
- An ignored or declined offer must not be repeated or sent.
- A matching existing proposal/task must be surfaced instead of another offer.
- Ambiguous project choice and changed proposal wording still need the owner's answer.

## Design

No storage, query, lock, audience, identity, telemetry or API changes. Growth, concurrency, read-cost and scale changes are N/A: this modifies instructions only. Existing bounded project reads and proposal consent enforcement remain in use. Compatibility requires no backend deployment or migration; rollback reverts the prompt text. Platforms: Buddy instructions on macOS, Linux and Windows; local tests on macOS and Linux CI.

## Conversation example

```text
Person: Reconnecting loses my draft. Keep it until I send or discard it.
Buddy:  [Checks the project's existing proposals and tasks.]
Buddy:  Want me to propose this to Harness?
        I'll post this as you: "Keep my unsent draft through a reconnect so I don't lose work; done when it stays until I send or discard it."
Person: Yes.
Buddy:  [Sends those exact words once.]
```

## Task 1: Offer ready ideas in every Buddy context

**Files:** Modify `cli/src/superTabs/start.ts`, `cli/src/lib/swarmSkills.ts`; test `cli/src/superTabs/start.spec.ts` and `cli/src/lib/swarmSkills.spec.ts`.

**Interfaces:** Consume `startAgent(...)`'s emitted `agent_create.prompt` and `prepareSwarmSkill(...)`'s written Buddy skill. No new public interfaces; keep all command payloads unchanged.

- [ ] Add table-driven assertions on the emitted main, Swarm, thread and project-session prompts: readiness, unsolicited offer, duplicate lookup, exact shown text, owner's yes, and no repeated offer. Assert the same requirements on the built skill in all modes, preserving quoted-consent and project-selection checks.
- [ ] Commit the tests and run `npm test -- src/superTabs/start.spec.ts src/lib/swarmSkills.spec.ts --maxWorkers=2`; record the missing-instruction failures.
- [ ] Update the launch text and shared skill with the proactive offer and explicit consent boundary, removing contradictory passive-only wording.
- [ ] Run the two changed test files plus affected importer tests and `npm run typecheck`. Use automatic PR CI for the full CLI suite; no coverage/PTY gates are touched.
- [ ] Run a synthetic transcript against a native agent using the built instructions: a ready idea should produce the exact proposal and offer, without a send. Include duplicate and declined-offer cases; record the actual output and limitations in the PR.
- [ ] Commit and push the passing change, mark the PR ready, and hand review/testing to the Integrator.
