# An agent's post that only acknowledges is refused; a reaction settles it instead (task #3391) Plan

> Worked by the Engineer, test first (superpowers test-driven-development): each task's failing test is committed and
> seen red before the code that passes it.

**Goal:** An agent's post that says nothing beyond "on it", "got it", "thanks" or "will do" is refused with `ACK_ONLY`
and the next step (react instead). An agent's reaction to a message it was sent settles its delivery of that message,
as an answer does. People are never refused.

**Architecture:** A new `backend/src/superTabs/acknowledgements.ts` holds `isAcknowledgement(text)`: the text, lower-cased
and cut into clauses at punctuation, is an acknowledgement only when every clause is on the ack list, at least one is a
real acknowledgement (not just "ok"), and the text has no question mark, digit, link or tag. `commands.ts` `message.send`
refuses an agent's such post (no files, no tags, not a note to itself, not in a Buddy chat) with `ACK_ONLY`. `message.react`
in `commands.ts` records `effects.settles` for an agent's reaction that is on; `store.ts` closes that agent's own open
deliveries of the message as `answered`, with the same update a reply uses (shared helper, one place).

**Tech Stack:** TypeScript, vitest (unit), vitest with a Mongo replica set (`npm run test:super-tabs`).

**Spec:** task #3391 brief; project instructions ("Never post an acknowledgement ... react instead").

## Global Constraints

- Owned files: `backend/src/superTabs/` (and `backend/integration/superTabs.test.ts` for the store test, this plan).
- `ACK_ONLY` is a new name; none of the codes in `removedRefusals.test.ts` returns. The classifier errs toward letting a
  post through: anything not wholly on the list passes.
- No schema change, no numeric threshold: the list is the whole rule, so no length constant either.
- A reaction by a person settles nothing (people have no deliveries to settle); only the recipient agent's own rows move.

## Review Focus

- A real short answer ("Yes at 1a2b3c", "Done: PR #12", a link, a question) is never refused.
- The reaction settles only the reacting agent's deliveries of that message, in the open states a reply settles.

## Task 1: The classifier and the refusal

**Files:** `backend/src/superTabs/acknowledgements.ts`, `acknowledgements.test.ts`, `commands.ts`, `commands.test.ts`
**Interfaces:** `isAcknowledgement(text: string): boolean`

- [ ] Failing test: `isAcknowledgement` is true for "on it", "Got it, thanks!", "Will do." and false for "Yes at 1a2b3c", a
      link, "on it?", "on it #12", "thanks, merged", "ok".
- [ ] Failing test: an agent's `message.send` of "on it" throws `ACK_ONLY`; the same text from a person, with a file, with a
      tag, as a note to itself or in a Buddy chat passes; "Yes at 1a2b3c" passes.
- [ ] Implement the classifier and the refusal; both tests pass.

## Task 2: A reaction settles the delivery

**Files:** `backend/src/superTabs/commands.ts`, `store.ts`, `reactions.test.ts`, `backend/integration/superTabs.test.ts`
**Interfaces:** `effects.settles?: { messageId: string; agentId: string }`

- [ ] Failing test: an agent's `message.react` (on) returns `settles`; a person's, or an agent removing its reaction, does not.
- [ ] Failing integration test: an agent's 👀 on a message closes its own queued and claimed delivery of it as `answered`
      and not another agent's.
- [ ] Implement `settles` and the store update (shared with the reply path); both tests pass.
