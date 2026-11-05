# A Buddy model switch that can't run says why and offers Start again — Plan

**Goal:** When a Buddy's model switch is refused by the Buddy guard, its owner reads why in plain words ("Start your Buddy
again to switch its model") instead of `its computer could not switch it (SWARM_SKILL_FAILED)`, and Desktop offers a
one-click Start again once a switch has failed for that reason.
**Architecture:** The switch relaunches the Buddy through the daemon's `agent_retarget`; the relaunch's launch overrides
(cli/src/lib/launchOverrides.ts) run `prepareBuddyFolder` (cli/src/lib/swarmSkills.ts), whose guard throws one of two fixed
sentences, and return `SWARM_SKILL_FAILED` with that sentence as the detail. `refusal()` in cli/src/superTabs/buddyModel.ts
reads only the code. It now also recognises the guard's two sentences in the detail (the constants exported from
swarmSkills.ts, unchanged) and maps each to its own sentence; the detail itself is still never forwarded. The launch error
code stays `SWARM_SKILL_FAILED`, so the launch telemetry families and every other relaunch caller keep their contract.
**Tech Stack:** TypeScript CLI, vitest; Flutter Desktop, flutter_test.
**Spec:** Task #3256 (Scholes, 11-05; Guide2's evidence from task #3069). This plan is implemented by its Engineer, test first,
with no execution handoff.

## Global Constraints
- The Buddy guard stays as strict: no condition in `prepareBuddyFolder` changes, only which words reach the owner.
- No path or daemon detail reaches the owner: refusals are fixed sentences.
- Swarm code stays out of cli/src/core. Two security reviews (Buddy guard).
- Part 2 (Desktop) is built only after Scholes approves the mockup posted in the task.

## Review Focus
- The guard's conditions are unchanged (only `export` added to its two sentences).
- A detail that merely mentions a sentence cannot make any other failure look like success: it only changes refusal words.

## Tasks

### 1. Plain refusal words for the guard's two holds
**Files:** cli/src/superTabs/buddyModel.ts, cli/src/superTabs/buddyModel.spec.ts, cli/src/lib/swarmSkills.ts (export only)
**Interfaces:** `export const BUDDY_START_AGAIN`, `export const BUDDY_NOT_HERE` (swarmSkills.ts).
- [ ] Failing test: an `agent_retarget` answer `{ error: 'SWARM_SKILL_FAILED', detail: String(new Error(BUDDY_START_AGAIN)) }`
      reports `Start your Buddy again to switch its model`; with `BUDDY_NOT_HERE` it reports
      `Your Buddy runs only on your own computer, signed in as you`; any other `SWARM_SKILL_FAILED` keeps the code sentence.
- [ ] Watch it fail, commit.
- [ ] `refusal()` reads the detail of a `SWARM_SKILL_FAILED` answer for the two sentences. Test passes, commit.

### 2. Desktop offers Start again after a failed switch (Scholes approved the mockup; PM's scope ruling, 11-05)
**Files:** desktop/lib/super_tabs/buddies.dart, desktop/test/super_tab_buddy_model_test.dart
**Scope:** the Desktop files only. The machine does not report a missing owner record before a switch: Desktop shows the
offer once a switch has failed for that reason (River: it only affects Buddies started before 0.5.40, which isn't worth
more surface).
**Signal:** the newest system line by the current Buddy agent in its Swarm Buddy chat is the backend's
"Couldn't switch your Buddy: Start your Buddy again to switch its model…" (task 1's words), and no switch is under way.
A later line by that agent (a success, another failure) settles it, and a Buddy started again is a new agent, so a line
written by an earlier Buddy never shows the offer.
**Start again:** a running Buddy refuses a second start (backend BUDDY_EXISTS), so it is removed and then started on the
same machine and engine, which is the replacement a down Buddy's Start again already does. Its chat and its name stay.
- [ ] Failing widget test: the bar shows "Start your Buddy again to switch its model." with Start again, which sends
      buddy.remove then buddy.create for its machine and engine; the offer is gone for the new Buddy. Not shown for
      another reason, after a later line, while a switch is under way, or for a line by an earlier Buddy.
- [ ] Watch it fail, commit; build the row; test passes, commit.
