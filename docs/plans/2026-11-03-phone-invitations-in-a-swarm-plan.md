# Phone: invitations when already in a Swarm Implementation Plan

> Worked by the project instructions (Engineer, revision 27): each plan task commits its failing test, then its code.

**Goal:** A person already in a Swarm sees a new invitation on the phone and can join it.

**Architecture:** `SwarmInbox` reads invitations in any Swarm state, at a slower pace when the person has a Swarm. Home lists them above the projects, using the start screen's existing join and Not now.

**Tech Stack:** Flutter, widget tests over `FakeSwarm`.

**Spec:** Tony's mobile list, task 24.

## Sketch: Swarm Home, in a Swarm, with one invitation (approved for Tony by the Lead: one line each, gone when there are none)

```
┌──────────────────────────────────────┐
│ ▣ Phone Swarm ▾                ≡  ✓✓ │
│                                      │
│ Invitations                          │
│ ╭──────────────────────────────────╮ │
│ │ Design Team       Not now   Join │ │
│ ╰──────────────────────────────────╯ │
│                                      │
│ Pinned                               │
│ ╭──────────────────────────────────╮ │
│ │ # openharness                    │ │
│ ╰──────────────────────────────────╯ │
│ Projects                             │
│ ╭──────────────────────────────────╮ │
│ │ # lamp                           │ │
│ ╰──────────────────────────────────╯ │
└──────────────────────────────────────┘
```

Joining: Join reads `Joining…`; a refusal shows its words in red under the row; the new Swarm then appears in the list. No invitation: no heading. It shows under every filter and whichever Swarm the switcher picked, as an invitation belongs to the account, not to a Swarm.

## Decline

Neither the backend nor Desktop has a decline (`invite.accept` and `invite.revoke` only), and this task is phone-only. So the phone keeps the start screen's **Not now**: it hides the invitation for this session and leaves it on the server.

## Design

- growth: N/A because nothing new is stored.
- concurrency: N/A because this only reads; join keeps its one receipt per invitation.
- read cost: with a Swarm, one read of the list on opening, then at most every 5 minutes, or on pull to refresh. With no Swarm, every poll, as today.
- scale: one read per open phone per 5 minutes, a twentieth of Home's 15 s poll; the read is indexed by email and capped at 100 Swarms. 10x phones stays small; the metric that warns first is `GET /api/super-tabs/invitations` per minute.
- compatibility: an older server answers 404, which reads as none, as today.
- migration + rollback: N/A because nothing is stored.
- audience: the server lists only the account's own invitations.
- identity: N/A because it reads as the signed-in account.
- failure: with a Swarm, a failed read keeps what was shown and says nothing, since Home has work to show; it is logged and read again at the next pace. With no Swarm, as today.
- platforms: phone only.

## Global Constraints

- PR body starts: Requested by tony@autonomous.ai through Harness.
- Mobile only, based on main. Existing Swarm screens and design tokens; no new colors or icons. No on/off switch.
- Never install builds on anyone's phone. Phone tests use fakes, never a real sign-out.

## Review Focus

- An invitation to a Swarm the person is already in after joining: the row goes once the next read lands.
- Not now, then pull to refresh: it stays hidden this session.
- A failed read while in a Swarm: Home unchanged, no "Couldn't check invitations".
- The last Swarm left: the start screen still shows invitations as before.
- Home's cached first paint: no invitation row until read.

---

### Task 1: The inbox reads invitations in a Swarm

**Files:** Modify `mobile/lib/swarm/swarm_inbox.dart`. Test `mobile/test/swarm/swarm_invitations_in_swarm_test.dart`.

- [ ] Failing tests: read with a Swarm; at most every 5 minutes; a failure keeps the list and raises nothing; no Swarm reads each poll.
- [ ] Implement, commit test first, then code.

### Task 2: Home lists them

**Files:** Modify `mobile/lib/swarm/swarm_page.dart`. Test as above.

- [ ] Failing widget test: a person in a Swarm sees the invitation, joins it, and the new Swarm is listed; Not now hides it.
- [ ] Implement, commit test first, then code. Screenshots in the PR.
