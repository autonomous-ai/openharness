# Phone: drafts and unsent messages survive Implementation Plan

> Worked by the project instructions (Engineer, revision 27): each plan task commits its failing test, then its code.

**Goal:** A chat's draft stays per chat and thread until sent or cleared; a Not sent message survives a restart and can be retried or deleted; both are per account and go on sign-out and on losing access.

**Architecture:** One sealed file per signed-in account (`SwarmKept`), as the kept Home is, read when the session starts. `SwarmConversation` and `SwarmThread` read their draft and posts from it when opened and write to it as they change. `SwarmInbox` drops a Swarm's part when access is lost; `SwarmHost` clears all of it on sign-out.

**Tech Stack:** Flutter, ChaCha20-Poly1305 under a Keychain key, widget tests over `FakeSwarm` with an in-memory key.

**Spec:** Tony's mobile list, task 25; Desktop's #2610 for thread drafts.

## Sketch: the Not sent row

```
┌──────────────────────────────────────┐
│ (D) dee                              │
│     Ship the fix tonight?            │
│     ⚠ Not sent · Retry · Delete      │
└──────────────────────────────────────┘
```

Same row as today, in the same yellow and blue, with Delete added beside Retry. After a restart it looks the same. Delete takes it away at once, with no question. A draft has no new look: the words are simply still in the box.

## Decisions

- **Sealed, not the plain store.** Drafts hold what someone wrote, unlike read marks (ids and numbers). They are sealed as the kept Home is, with their own Keychain key.
- **A Not sent message may already have arrived.** Its answer was lost, so nobody knows. Retry uses the same receipt, so it never posts twice. If it did arrive, Delete cannot unsend it: the message appears when the chat is next read.
- **A post caught mid-send by a kill** comes back as Not sent, for the same reason.
- **Files are not kept.** A draft's waiting files stay in memory only, as on Desktop. A Not sent post keeps the files already uploaded, as references in its command, but its row no longer draws their chips after a restart.
- **A moment with no account is not a sign-out.** The app clears the kept file when someone signs out, another account signs in, or Swarm is turned off, not while the same account is still being read.

## Design

- growth: a sent or emptied draft and a post read back, refused or deleted leave at once. At most 500 drafts and 200 posts per account, oldest first; the whole file goes on sign-out.
- concurrency: writes run one at a time per file, and a clear is never undone by an earlier write, as the kept Home does.
- read cost: read once per session; a write comes at most every 300 ms while typing. A kept chat absent from the Swarm's read is asked for once per session, to learn whether access is gone.
- scale: bounded per phone by the caps above; nothing server-side beyond that one ask. The file's size warns first.
- compatibility: no file reads as nothing. No server change: Retry is the same command under the same receipt.
- migration + rollback: nothing to migrate. An older app ignores the file, which stays sealed.
- audience: only the signed-in account's, on this phone; another account's file opens for nobody, and its key goes on clear.
- identity: the account id of the session.
- failure: a Keychain or disk that refuses keeps nothing and logs it, and the draft stays in memory for this run.
- platforms: phone, iOS and Android, through the Keychain or Keystore already used by the kept Home.

## Global Constraints

- PR body starts: Requested by tony@autonomous.ai through Harness.
- Mobile only, based on main. No new colors or icons. No on/off switch.
- Never install builds on anyone's phone. Phone tests use fakes, never a real sign-out.

## Review Focus

- A chat lost while it is closed: its draft goes without the chat being opened.
- Two accounts on one phone, one after the other: neither ever reads the other's.
- A write under way when sign-out clears: nothing comes back.
- Sent, then killed before the debounce: no sent text returns as a draft.
- A restored post that the first read shows arrived: it leaves, and shows once.

---

### Task 1: A sealed file per account

**Files:** Create `mobile/lib/swarm/swarm_kept.dart`. Test `mobile/test/swarm/swarm_kept_test.dart`.

- [ ] Failing tests: round trip; another account reads none; a clear takes file and key; a damaged file is none; caps hold.
- [ ] Implement, commit test first, then code.

### Task 2: Drafts stay

**Files:** Modify `swarm_conversation.dart`, `swarm_thread.dart`, `swarm_inbox.dart`, `swarm_reader.dart`, `swarm_session.dart`, `phone_shell.dart`. Test as above.

- [ ] Failing tests: chat and thread drafts survive leaving and a restart; sending clears them.
- [ ] Implement, commit test first, then code.

### Task 3: Not sent stays, with Retry and Delete

**Files:** Modify `swarm_outbox.dart`, `swarm_post_line.dart`, `swarm_conversation.dart`, `swarm_thread.dart`, the two pages.

- [ ] Failing tests: a Not sent post survives a restart; Retry sends the same receipt; Delete removes it for good; a read that holds it settles it.
- [ ] Implement, commit test first, then code.

### Task 4: Clearing

**Files:** Modify `swarm_session.dart`, `swarm_inbox.dart`, `swarm_conversation.dart`.

- [ ] Failing tests: sign-out, another account and Swarm off clear it; a Swarm lost and a chat lost, open or closed, clear their part.
- [ ] Implement, commit test first, then code. Screenshots in the PR.
