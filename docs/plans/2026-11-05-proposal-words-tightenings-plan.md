# Proposal words check: three tightenings Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). Two independent security reviews on the pull request (Buddy guard).

**Goal:** Task #2989, the follow-up to #2926 / #3024. A Buddy's proposal posts only its owner's own words, or the one
line the Buddy showed them and they okayed. The two security reviews of #3024 left three minor gaps in the words check
(`backend/src/superTabs/buddies.ts`, `okayedWords`), and this closes them. Tightening only: what passes today and is
the owner's own words or the newest okayed shown line still passes.

**Architecture:**

- **(1) The first quoted line after the marker.** `shownLines` becomes `shownLine`, which returns at most one line. It
  looks at what follows the Buddy's last "I'll post this as you:". If that starts with a quote (`"` or `“`), the shown
  line is the text up to the first closing quote (`"` or `”`). Anything after the closing quote, such as "OK?" or a
  second quoted line, does not count. Otherwise the shown line is everything after the marker, taken whole with its
  outer quotes trimmed, as today. Today every quoted span after the marker counted, and so did the stray text around
  the first one.
- **(2) The newest shown line.** `okayedWords` reads `shown` newest first, as `shownBefore` gives it. It checks only
  the newest Buddy message that carries the marker. An older shown line in the same window (the Buddy showed A, then
  B, then the owner said ok) is refused. If the newest marker message shows nothing, nothing counts.
- **(3) The colon lead-in of the owner's ask.** Today the text after the owner's first colon always counted, so a
  label ("Bug: login fails"), an attribution ("Ken said: the client is leaving") or a refusal ("Don't post this: …")
  let the Buddy post the rest as the owner. Now the text after the first colon counts only when everything before it
  is a short ask to send it:
  - it starts with a send word, optionally after ok/yes/please/can you: post, send, share, propose, tell, pass,
    forward, submit or raise, or in Vietnamese gửi, đăng, chuyển, nói or đề xuất. Words that read as a label as often
    as an ask (report, file, pass, báo) are left out;
  - it has no negation (not, don't, never, no, đừng, không, chưa);
  - it has no sentence break (`.`, `!`, `?`, `;` or a new line);
  - it is at most 10 words.

  Otherwise only the owner's whole message or a line they quoted counts. Any other words get the existing
  show-then-ok refusal (`PROPOSAL_UNSHOWN`).
- No new query: the 50 Buddy-chat rows the propose context reads already carry everything. The `shownBefore` window
  (the Buddy's plain rows in the ask's lane since the owner's previous message) is unchanged.
- The skill text needs no change. It already says to put nothing after the marker but the line, and that a change is
  a new line to show.

**Tech Stack:** TypeScript, the backend's Vitest unit suite.

**Spec:** task #2989's brief.

## Global Constraints

- Tightening only. Every case the unit and integration tests accept today still passes.
- Refusals use the existing `PROPOSAL_UNSHOWN` message. Nothing new is posted.
- Owns `backend/src/superTabs/buddies.ts` and `buddies.test.ts`. No schema, index or query change.

## Design

- growth: N/A because nothing is stored.
- concurrency: N/A because this is a pure check inside the existing command.
- read cost: no new read.
- scale: N/A because it checks at most 50 rows of one Buddy chat, once per proposal.
- compatibility: an older Buddy that sends an older shown line or a fragment is refused, and the refusal tells it to
  show the line and wait for the ok. Clients are unchanged.
- migration + rollback: none. A rollback restores the looser check.
- audience: the server checks the words, as today.
- identity: N/A because no login or author changes.
- failure: a refused send says why (`PROPOSAL_UNSHOWN`), and the Buddy shows the line again.
- platforms: N/A because this is backend only.

## Review Focus

- Does any path still accept words the owner did not write or okay? Check the closing-quote scan, the
  newest-marker pick and the lead-in pattern.
- Does any legitimate case that passes today now fail? Look especially at an unquoted line after the marker and at
  "Send this to the PM: …".

## Tasks

### Task 1: only the first quoted line after the marker

**Files:** `backend/src/superTabs/buddies.test.ts`, `backend/src/superTabs/buddies.ts` (`shownLines`)

- [ ] Test: `I'll post this as you: “A” or “B”` lets A through and refuses B; `“A” OK?` refuses `A” OK?`; an
      unquoted line after the marker still passes whole. Watch it fail.
- [ ] Code: `shownLine` returns the first quoted line, or everything after the marker when it is unquoted. Run
      `npx vitest run src/superTabs/buddies.test.ts`.

### Task 2: only the newest shown line

**Files:** same (`okayedWords`)

- [ ] Test: shown newest first `[“B”, “A”]` lets B through and refuses A. A newer Buddy message without the marker
      leaves the newest marker line in force. A newest marker message that shows nothing lets nothing through. Watch
      it fail.
- [ ] Code: check only the newest `shown` entry that has the marker.

### Task 3: the colon lead-in

**Files:** same (`ownerLines`)

- [ ] Test: these pass: "post this: Fix the login", "Send this to the PM: Offline drafts please",
      "ok, please send it: …" and "Gửi PM: …". These are refused after the colon: "Bug: login fails",
      "Ken said: the client is leaving", "Don't post this: …", "Please don't send this: …" and a lead-in with a
      sentence break. Each whole message still passes. Watch it fail.
- [ ] Code: `askLeadIn` decides whether the lead-in is an ask to send.
