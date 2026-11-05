# A refused Swarm re-reads the Swarm list at most once a minute: plan

> Way of working: this plan's Engineer implements it task by task, test first (test-driven-development), in one pull
> request. No subagents, no execution handoff.

**Goal:** Since #2913, Desktop re-reads the account's Swarm list each time a Swarm's read is refused (FORBIDDEN or
NOT_FOUND) to decide whether the Swarm is gone. A backend refusing every read for a while (a restart) then gets one list
read per refused read. Cap it at one list read per Swarm per minute, and still close the Swarm as soon as a list that
answered leaves it out.

**Architecture:** The cap lives in `SuperTabClient._stillListed(id)`, the controller's `stillListed` hook. The client
remembers when it last read the list for Swarm `id`. Within a minute of that, it reads nothing and answers from the
latest list that answered, whoever read it (its own discovery reads count), as long as that list answered after the
Swarm's last ask: "not listed" closes the Swarm at once, "listed" keeps it. If no list has answered since that ask, the
answer is unknown and the Swarm stays open. After a minute, the next refusal reads the list again. Signing in as
another account forgets these answers.

**Tech Stack:** Dart/Flutter (`desktop/lib/super_tabs/client.dart`), flutter_test with the Swarm switcher test's fake
backend and `package:clock`.

**Spec:** Task #2767 (follow-up to #2647, approved by River when #2913 was reviewed).

## Global Constraints

- Fails safe: a cached answer only closes a Swarm when a list read that answered for this account, after the ask,
  leaves it out. Anything unknown keeps it open, as in #2913.
- Desktop tests use a memory store and a fake sign-in; nothing signs the Mac's CLI out.

## Review Focus

- A cached "not listed" can never come from an older list (one read before the Swarm was joined, or another account's).
- The cap is per Swarm, and a list read that failed still starts the minute.

## Task 1: the cap

**Files:** `desktop/lib/super_tabs/client.dart`, `desktop/test/super_tab_swarm_switcher_test.dart`.
- [ ] Failing tests, using the fake backend that refuses reads: many refusals within a minute read the list once, the
  first one failing to read; a refusal after a minute reads it again; a discovery read that drops the Swarm closes it
  at the next refusal, with no further list read; a list that answered before the ask never closes it.
- [ ] `_stillListed` keeps the time of each Swarm's last ask and the time of the last list that answered, and both are
  forgotten on an account change.
