# Buddy quoted consent and owner deletion implementation plan

> Implement task by task in this Engineer session, test first, with independent security reviews of the completed pull request.

**Goal:** A Buddy can post only the quoted line its owner saw and approved, and that owner can delete the proposal posted as them.

**Architecture:** Keep consent enforcement in `okayedWords` and command authorization in `messageEdits.ts`. Read proposal ownership from the existing stored source, allow deletion separately from editing, and reuse transactional message deletion.

**Tech Stack:** TypeScript, Vitest, Prisma/MongoDB, generated CLI skill text.

**Spec:** Swarm task #3322, requested by emma: require a quoted line after `I'll post this as you:`, exclude everything after its closing quote, and let only the attributed owner delete their Buddy proposal.

## Global Constraints

- Backend and CLI skill text, plus Desktop/phone delete-only eligibility authorized by River on November 5; no new protocol, dependencies or core code.
- Two independent security reviews before merge; Integrator owns review/test routing and shipping.
- Commit this plan first, then each task's failing tests before implementation. Push the draft and each completed task.
- Keep the owner's direct-word consent path and existing quote styles and whitespace normalization.
- Test fixtures use synthetic content and isolated stores; never sign out a real CLI or use production data.

## Design

- Growth: no new records. Owner deletion removes a reply-free proposal; a root with replies becomes the existing tombstone. Remove its proposal source as well so goal/scope cannot retain deleted content.
- Concurrency: existing command transaction and group revision guard authorization and deletion; operation receipts retain retry idempotency. Keep the original ask consumed after deletion.
- Read cost: use the already selected source/author fields; existing indexed message/thread/counter reads only. No new query or scan.
- Scale: parser work stays linear in the bounded messages already loaded; deletion uses the existing bounded lookbacks. Compare consent timing before/after at normal and maximum message sizes; command latency is the first warning metric.
- Compatibility: no wire/schema change. Older unquoted Buddy summaries fail visibly and must be shown again with quotes; direct owner words keep working. Backend ships before the refreshed skill.
- Migration + rollback: no migration. Reverting code restores the defect and should be avoided; deletion is intentionally irreversible and existing thread replies remain.
- Audience: server verifies readable conversation, person author, source ownership and actor identity. Other people, the Swarm owner and every agent remain unauthorized.
- Identity: authenticated actor only, never the host computer's login. Proposal attribution and source person must agree.
- Failure: refuse unquoted/malformed summaries with `PROPOSAL_UNSHOWN` and guidance to show a quoted line again. Preserve existing deleted/not-found errors.
- Platforms: backend behavior is common to all clients; generated skill is shared by macOS/Linux/Windows. Desktop/phone must offer Delete for the owner's own proposal, while Edit remains limited to plain messages. No process-launch changes.

## Review Focus

- A malformed or unquoted newest marker must invalidate older quoted consent, including within the same message.
- Mixed/unclosed/nested quote delimiters must never broaden consent or reveal a trailing private sentence.
- A quoted public sentence followed by private text must post exactly the public sentence.
- Deletion must require the attributed person and proposal source owner to agree; editing and unrelated system rows stay forbidden.
- A proposal with replies must lose its source content and pending deliveries while preserving its thread; deletion must not allow the Buddy to resend the same ask.

## Validation plan

Run focused backend consent/message-edit unit files, the CLI skill spec, and both component typechecks locally, with at most two test workers and ten-minute command limits. Add store-level cases to the existing Super Tab integration files; their full Linux suite and both component unit suites run in automatic ready-PR CI, per project instructions revision 74. Record red/green commands and counts in a PR comment before Ready. No full local suite repeated after CI. Retain separate implementation, validation and waiting timings; merge/publication belong to the Integrator.

### Task 1: Require quoted consent and teach recovery

**Files:** `backend/src/superTabs/buddies.ts`, `backend/src/superTabs/buddies.test.ts`, `backend/src/superTabs/commands.ts`, `backend/integration/superTabSwarmBuddy.test.ts`, `cli/src/lib/swarmSkills.ts`, `cli/src/lib/swarmSkills.spec.ts`.

**Interfaces:** Preserve `okayedWords(words: string, ask: { text?: string; shown?: readonly string[] }): boolean`. `shownLine` returns null only when there is no marker, and an empty non-consenting value for a marker without a valid quoted line, so older consent is not revived.

- [ ] Commit tests rejecting an unquoted public line followed by private sentences, the unquoted line alone, unclosed/malformed quotes, and fallback to an older quoted offer. Assert the quoted line posts verbatim and appended/private-only text is refused. Require quote guidance in the generated skill and refusal.
- [ ] Run `vitest run src/superTabs/buddies.test.ts --maxWorkers=2` in backend and `vitest run src/lib/swarmSkills.spec.ts --maxWorkers=2` in CLI; record expected consent/wording failures.
- [ ] Remove the unquoted fallback, retain newest-marker invalidation, and require quotes in the skill example and server recovery text.
- [ ] Run the same files green, record evidence, commit and push.

### Task 2: Let only the owner delete their proposal

**Files:** `backend/src/superTabs/messageEdits.ts`, `backend/src/superTabs/messageEdits.test.ts`, `backend/src/superTabs/store.ts`, `backend/integration/superTabMessageEdits.test.ts`.

**Interfaces:** Extend internal `MessageChangeTarget` with optional `proposalOwnerId`, derived only from stored `buddy-proposal` source. `deleteMessage` allows matching person author/source owner; `editMessage` keeps the plain-message rule. Existing return/effect shapes remain unchanged.

- [ ] Commit tests for owner deletion with and without replies; reject other members, Swarm owner, agents, mismatched source owner and unrelated system rows. Add store tests creating a real Buddy proposal, deleting it, preserving replies without proposal content, cancelling pending delivery and refusing reuse of the original ask.
- [ ] Run `vitest run src/superTabs/messageEdits.test.ts --maxWorkers=2`; record owner deletion failing before the fix.
- [ ] Derive trusted proposal ownership, permit delete only, and remove source metadata when retaining a deleted root.
- [ ] Run focused unit files/typechecks, record evidence and push. Mark Ready with red/green evidence, then hand the stable revision to the Integrator for two security reviews and independent testing.

### Task 3: Offer owner-only Delete in Desktop and phone

River expanded the task after inspection found `canChange` hides both actions for every proposal. This Windows session has no Flutter/Dart toolchain; push the backend first and ask River to assign the app work on a Mac, in this task and branch.

**Files:** Desktop `lib/super_tabs/profile_actions.dart`, `lib/super_tabs/view.dart`, their focused tests, and the matching phone eligibility/menu code and tests.

**Interfaces:** Keep the existing edit eligibility unchanged. Add a separate delete eligibility check that retains write/access/archive/deleted checks and admits only a `buddy-proposal` whose person author and source `personId` both equal the signed-in account. The server remains authoritative.

- [ ] Commit failing app tests: the owner sees Delete but no Edit for their proposal; another person, an agent-authored row and a mismatched source owner do not gain Delete; plain messages retain both actions.
- [ ] Run the affected Flutter tests red on the Mac, implement the separate eligibility, then run them green and analyze changed Dart files.
- [ ] Record light/dark menu evidence with a memory store and fake sign-in, push, and hand the complete stable revision to the Integrator. No real CLI sign-out.
