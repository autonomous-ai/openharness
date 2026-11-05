# The PM's wake reads only what changed, and agents' posts to it come in its digest (task #3387) Plan

> Worked by the Engineer, test first (superpowers test-driven-development): each task's failing test is committed and
> seen red before the code that passes it.

**Goal:** Each PM wake stops re-reading its whole instructions, and agents' posts to the PM arrive together in its
5-minute notice digest instead of one terminal paste each. A person's message still reaches the PM at once.

**Architecture:** Two backend changes in `backend/src/superTabs/`. (1) `pmSchedule.ts` drops the `REREAD` line from
every wake and the "Every wake: reread the instructions whole" line from the built-in section (#3151, merged 11-05
18:08), restoring "read only what people sent you … Don't reread the whole instructions for it". The CLI already tells
every agent, the PM included, when its instructions change and names the file to read again
(`cli/src/lib/swarmInstructionsSkill.ts` noticeOf), so a wake reads only what changed. (2) `noticeDigest.ts` gains
`gatheredMessage(state, draft)`, which `store.ts writeMessages` calls in place of `gatheredNotice(source)`: what was
gathered before, plus a plain post (no source) by an agent that is not a Buddy and attaches no file. The digest's
release, cancels, 30-minute settle and other-account marks already work per delivery and take these rows unchanged.

**Tech Stack:** TypeScript, Prisma on MongoDB, vitest (unit), vitest with a loopback replica set (integration).

**Spec:** task #3387 brief (anh Dee's Swarm redesign, step 1); docs/plans/2026-11-02-pm-notice-digest-design.md, whose
non-goal "Gathering agents' or people's posts" this task reverses for agents' posts.

## Global Constraints

- Backend only. The CLI needs no change: its instruction-change notice is the "re-read what changed" path. No Swarm code
  in `cli/src/core`.
- A person's message to the PM is never gathered. Nor is a Buddy's post (it carries its person's words), a status row
  that needs a person (Needs a human, Stuck), or any kind already sent at once.
- An agent's post with attachments goes at once: a digest line carries no files, and its host fetches them only for a
  delivery it lists.
- Numbers stay as they are (`NOTICE_DIGEST_MS` 5 minutes, `NOTICE_DIGEST_MAX` 50, 200-character lines).
- PR body starts "Requested by dee through Harness."

## Design

- growth: no new record; each gathered delivery ends `digested`, `cancelled`, or back to `queued` after 30 minutes, as now.
- concurrency: unchanged; a delivery is written gathered in its message's transaction, and digested by status.
- read cost: unchanged; the coordinator's poll already reads its gathered rows by index, at most 50.
- scale: at 10x agent posts the digest's "And N more" line warns first; 50 lines a digest.
- compatibility: server-side only. Old CLIs and apps never list a gathered row (no host lists one) and see the message as
  ever.
- migration + rollback: none. An older server releases any gathered row it finds, whatever its kind.
- audience: the digest runs the same recipient, sender and other-account checks per row as a listed delivery.
- identity: N/A because nothing here signs in or acts as a person.
- failure: a gathered row not digested within 30 minutes goes back to queued and is delivered alone.
- platforms: N/A because nothing here runs on a client.

## Review Focus

- A person replying to an agent in the PM's chat: still at once (author kind person, test in Task 2).
- An agent's post answering the PM's own question: gathered too; the PM reads it in at most 5 minutes (accepted by the brief).
- An agent of another account posting to the PM: its digest line carries the other-account mark (test in Task 2).
- An agent's post to an agent that is not the PM: queued at once as before (test in Task 2).
- A Buddy's post to the PM: at once (test in Task 2).

---

### Task 1: A wake re-reads nothing unchanged

**Files:**
- Modify: `backend/src/superTabs/pmSchedule.ts` (built-in section lines 28-29, `JOB_LINES.heard`, `REREAD`, `scheduleText`)
- Test: `backend/src/superTabs/pmSchedule.test.ts`

- [ ] **Step 1: Failing test** — replace "tells the coordinator in every wake to reread the whole instructions" with
  "a wake rereads nothing that did not change (anh Dee, 11-05, #3387)": for a sweep wake and a heard wake, the text has no
  `reread your project's instructions whole` and no `instructions command`; the heard line contains
  `read only what people sent you since the last wake`; `PM_SCHEDULE_TEXT` has no `Every wake: reread` and contains
  `Don't reread the whole instructions for it`.
- [ ] **Step 2:** `npx vitest run src/superTabs/pmSchedule.test.ts` fails on those lines. Commit (red).
- [ ] **Step 3:** Remove `REREAD` and its use; restore the two lines as before #3151.
- [ ] **Step 4:** Same command passes. Commit.

### Task 2: Agents' posts to the PM arrive in one digest; a person's message is immediate

**Files:**
- Modify: `backend/src/superTabs/noticeDigest.ts`, `backend/src/superTabs/store.ts` (writeMessages)
- Test: `backend/src/superTabs/noticeDigest.test.ts`, `backend/integration/superTabNoticeDigest.test.ts`

**Interfaces:**
- Produces: `gatheredMessage(state: Pick<SuperTabState, 'agents'>, message: Pick<MessageDraft, 'author' | 'source' | 'attachments'>): boolean`
  in `noticeDigest.ts`; `gatheredNotice(source)` stays for its other callers and tests.

- [ ] **Step 1: Failing unit tests** in `noticeDigest.test.ts`: `gatheredMessage` is true for an agent's plain post, false
  for a person's, a Buddy's, an agent's with attachments, and an agent's `agent-only` row; true for every source
  `gatheredNotice` takes.
- [ ] **Step 2: Failing integration tests** in `superTabNoticeDigest.test.ts`: replace "an agent's post … go at once"
  with: two workers' `message.send` to the lead are `gathered`; after 5 minutes one poll writes one digest naming both
  message ids and both rows end `digested`; a person's `message.send` in the lead chat is `queued` at once; an agent's
  post to another agent is `queued`; a status row written before rows said their status (`{ kind: 'system' }`) still goes at once.
- [ ] **Step 3:** Run both files; they fail. Commit (red).
- [ ] **Step 4:** Add `gatheredMessage`; call it in `writeMessages`.
- [ ] **Step 5:** Both files pass, with `pmSchedule.test.ts` and `superTabPmSchedule.test.ts`. Commit.
