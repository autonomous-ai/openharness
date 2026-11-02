# Activity Unfollow Replies Implementation Plan

**Goal:** Stop writing reply Activity rows for people who unfollowed that thread, and resume writing them when they follow again.

**Architecture:** `writeReplyActivity` will read each candidate recipient's thread mark by its stable id in one indexed `$in` read. It will omit candidates whose mark has `follow: false` and preserve existing behavior for absent marks and `follow: true`.

**Tech Stack:** TypeScript, Prisma, MongoDB, Vitest integration tests.

**Spec:** Task #2247, conversation `b43385a1daf243b3b4af8999`.

## Global Constraints

- No environment switch.
- Keep one indexed read for the candidate thread marks.
- Following again must restore new reply Activity rows.
- The Activity row remains scoped to the root's author and message's own chat.

## Review Focus

- An absent mark must preserve existing default-follow behavior.
- An explicit `follow: false` must suppress rows for that person only.
- An explicit `follow: true` must allow rows again.
- Replies addressed to multiple candidate authors must filter each person independently.
- The mark lookup must use one `_id: { $in: ... }` read rather than per-person queries.

## Design

- Growth: No new data; Activity expiry continues deleting rows after 30 days.
- Concurrency: Read the current thread mark in the reply transaction; the existing transaction boundary is unchanged.
- Read cost: One indexed read for the deduplicated thread and recipient mark ids.
- Scale: One read regardless of recipient count; monitor Activity write volume and transaction latency; expected limit remains the existing recipient/message batch size.
- Compatibility: Older clients need no change; clients that follow or unfollow continue using existing marks.
- Migration and rollback: None; rollback restores the old writer and existing mark rows remain valid.
- Audience: The server filters the row for the exact person whose mark is read.
- Identity: Use person ids from message authors and mark ids, never machine-owner login.
- Failure: The write remains in its existing transaction, so a failed mark read aborts rather than silently writing an incorrect row.
- Platforms: Backend only; no platform-specific behavior.

## Tasks

### Task 1: Honor the thread's follow mark when writing Activity

**Files:**
- Modify: `backend/integration/superTabActivity.test.ts`
- Modify: `backend/src/superTabs/activity.ts`

**Interfaces:**
- Consumes: Existing `SuperTabThreadMark` stable ids and `readBy` helper.
- Produces: `writeReplyActivity` omits recipients with `follow: false` and otherwise retains its current behavior.

- [ ] Write an integration test that creates a reply, confirms one unread Activity row, unfollows the thread, creates another reply and confirms no additional row, then follows again, creates a reply and confirms a new row.
- [ ] Run the focused test and verify it fails because the unfollowed reply currently creates a row.
- [ ] Update `writeReplyActivity` to read the candidate recipients' marks once by `_id: { $in: [...] }` and exclude only `follow: false`.
- [ ] Run the focused test and verify the unfollow/follow assertions pass.
- [ ] Run the full Super Tab integration suite and record its result.
