# Contributor view: what a person's machines and subscriptions did for the Swarm

Task #2444, asked by 0xken15@gmail.com through Harness, from PRODUCT.md's Contribution section (main f7fdd4fd5, #2782):
contributing must be **Seen**. "The contributor sees what their capacity shipped, and gets credit for it. Their quota is
never drained without them knowing." Targets it serves: contributors per week ≥ 3 in each Swarm with two or more people,
and contributors this week still contributing next week ≥ 80%.

## What exists today (surveyed on main 68e31ef83)

- **The person card** (Members panel › a person; `desktop/lib/super_tabs/leaderboard/person_row.dart`) shows the last
  7 days: Shipped (pull requests of requests they asked for), Unblocked (answers), and **Lent**: each of their machines'
  busy agent-hours on other people's tasks (`leaderboard/lent.ts`). It never says what their machines *shipped*, nor
  anything about their subscriptions.
- **Manage › Machines** shows each machine's owner and, expanded, each subscription's tightest window
  (`5-hour limit · resets in 2h 10m`). It never says whose work used it.
- **The phone** shows the same leaderboard; tapping a person opens a sheet of label/value lines (`swarmPersonWeek`), its
  `Lent` line a machine count and agent-hours.
- **The server records** each attempt's engine and model in the group's ledger (`ledger.runs`, at most 20 per group,
  kept 5 weeks), the attempt a request shipped on (`ledger.shippedBy`), merges and fixes after merge
  (`fixedAfterMergeAt`), each machine's owner (`ContributedMachine.contributorId`), its subscriptions' 5-hour and weekly
  windows (`observation.quotas`, every reader of the machine sees them), and lent busy time per week and day.
- **Missing:** which machine an attempt ran on (a run names its agent by a hash only), anything counting contributors,
  and any word to an owner when someone else's work starts using their machine. The closest notice is the PM-switch
  line in the owner's Buddy chat (`pm-switch-notice`, `commands.ts` agent.switchResult).

## The design

Three small additions to what exists, no new collection, no new endpoint.

1. **Each attempt notes its machine.** `recordRun` (`leaderboard/record.ts`) adds `machineId` (the assignment's
   `execution.machineId`) to the run; `shippedBy` keeps it, as it keeps the rest of the run. Runs recorded before this
   resolve their machine at read time from their agent while that agent exists (`run.agentId` → `state.agents`), and
   otherwise count for no machine.
2. **The leaderboard read says, per person, what they brought.** `PersonDetails.brought` lists every machine the
   person contributed that the reader may see, a Mac's Harness Team account folded into its Mac, each with:
   - `shipped`: verified requests in the period whose shipping attempt ran on it. Verified is PRODUCT.md's north-star
     rule as far as the server knows it: shipped with a pull request (the board's existing rule) and no fix merged after
     it (`fixedAfterMergeAt` absent). Anyone's requests count: this is what the capacity shipped, not what the person
     asked.
   - `busyHours`: the Lent time already kept (busy on other people's tasks).
   - `subscriptions`: each engine's **weekly** window from the machine's own last reading (a Team account reads its
     Mac's): percent used and when it resets, or unknown.
   `Leaderboard.contributors` counts, for the period and the one before, the people whose machine ran an attempt on a
   group the board sums (requests and review/test steps alike: PRODUCT.md's "ran work"), and how many of last period's
   ran again this period: the two Contribution targets, read by the PM's weekly report with `scope=all`. Counts only,
   no ids (ENGINEERING.md 8).
3. **The owner hears when others start using their machine.** When `work.assign` gives someone else's task (Lent's
   rule: its requester is not the machine's contributor; a PM's or private chat's work never counts) to an agent on a
   contributed machine, and that machine's owner has not been told this week, the server posts one line in the owner's
   own Buddy chat (`openSwarmBuddyChat`, as the PM-switch notice does) and marks the machine with the week
   (`ContributedMachine.othersToldWeek`). Once per machine per week (Monday 00:00 UTC, the board's week) keeps it a
   notice, not a feed; the person card shows the rest.

### Mockups (from the real screens)

Desktop and web, Members › a person's card (today's card with **Lent** replaced by **Brought**; the heading, Shipped and
Unblocked unchanged):

```
┌─────────────────────────────────────────────────────────────┐
│ (◉) ken15 👑                                     424 points │
│ 111 shipped · 40 unblocked · 411 hours                      │
│                                                             │
│ Shipped 12                                                  │
│ Fix login on web                                            │
│ ...                                                         │
│ Unblocked 4                                                 │
│ Pick the release day                           waited 2 h   │
│                                                             │
│ Brought 2                                                   │
│ Mac Studio                    5 shipped · 31 h for others   │
│   Claude                     38% used · resets in 3d        │
│   Codex                      not read yet                   │
│ MacBook Pro                    0 shipped · 0 h for others   │
│   Claude                     71% used · resets in 6d        │
│                                                             │
│                                 Manage people  Edit profile │
└─────────────────────────────────────────────────────────────┘
```

Empty: `Brought` with `No machines brought yet`. From a server without `brought`, the card keeps today's **Lent**.

Phone, Leaderboard › a person (today's sheet of lines; the `Lent` line becomes one line per machine brought):

```
 ken15                                   ✕
 Points       424 last 7 days · place 1
 Shipped      12 asks landed · median 3 h to ship
 Unblocked    4 answered · 2 h of agent time freed
 Mac Studio   5 shipped · 31 h for others
              Claude 38% used, resets in 3d
 MacBook Pro  0 shipped · 0 h for others
              Claude 71% used, resets in 6d
 Streak       3 days shipping
```

The owner's Buddy chat (Desktop, web, phone), once per machine per week:

```
 Wren · Your Buddy
 ─────────────────────────────────────────────────────────────
 Swarm   diego's work "Fix login" started on your Mac Studio
         (Claude, 38% of this week used, resets in 3d). Members ›
         your card shows what it runs and ships; Manage › Machines
         can pause new work.
```

The line names the task's title only when the owner may read its project; otherwise it says "diego's work". Engines
are named as the Swarm's other lines name them ("Claude", "Codex").

## Checked against PRODUCT.md

- Contribution, **Seen**: what the capacity shipped (Brought › shipped), credit (it sits in the person's card beside
  their points), never drained unknowingly (the weekly notice, and the weekly quota in the card).
- Targets: contributors per week and kept next week are measured from recorded attempts (`contributors`).
- Anti-goals: no customer data hidden or changed; nothing exposed (see Audience); no feature for people talking to people.
- What matters most, 5 (Contribution): this is that work.

## Checked against ENGINEERING.md

- 1 Simple: extends the leaderboard read and the attempt record; no switch, no setting.
- 2 Nothing left behind: `Lent` details stay only for clients released before this (Compatibility); the card's Lent
  section is replaced by Brought, kept for an older server's answer until 2026-12-03.
- 3 Correct: each behavior test first (plan).
- 4 Fast: the leaderboard read is not a hot path; it does no new query (Read cost). `work.assign` adds an in-memory
  check and at most one message a week per machine.
- 5 Data: Design section below.
- 6 Failures are seen: a notice that cannot reach a Buddy chat still records nothing silently (Failure).
- 7 Secure: the server decides what each reader sees (Audience).
- 8 Measurable: `contributors` counts.
- 9 Architecture: TypeScript and the shared Flutter code; the phone's vendored copy changes in step.
- 10 Platforms: below.
- 11 Readable: copy follows the Naming System ("Brought", "for others", Buddy, Swarm).

## Design (docs/feature-design-rules.md)

1. **Growth:** `run.machineId` is one string on a run that already exists (≤ 20 runs per group, kept 5 weeks).
   `othersToldWeek` is one number per contributed machine, replaced weekly, deleted with the machine. The notice is a
   Buddy chat message, kept and deleted as that chat's messages are. Nothing new otherwise.
2. **Concurrency:** the notice and its mark are written by the `work.assign` command in the same commit as the
   assignment; the mark makes that commit also write the machine part, guarded by the version it read (parts/commit.ts).
   Two assigns, or an assign and the machine's own report, racing in the week's first notice conflict on that part and
   one retries, as every conflicting command does; the retry sees the mark and posts nothing (at most one line). Only
   the week's first such assign per machine writes the machine part, so reports and assigns rarely meet.
3. **Read cost:** the leaderboard read already loads the groups and visible machines it sums; `brought` and
   `contributors` are computed from them in memory, O(runs) ≤ 20 × groups. The response grows by ≤ 20 machines per
   person, a few hundred bytes. No new query, so no index; nothing polls.
4. **Scale:** at 10x (70 people, 200 machines, 2,000 groups) the in-memory pass is 40,000 runs, well under a
   millisecond per thousand; the first metric to warn is the leaderboard read's duration in the request log.
5. **Compatibility:** old clients ignore `brought`, `contributors` and the new notice kind's source (they show its text,
   as any unknown kind). New clients on an old server see no `brought` and keep showing Lent. Readers of `Run` and
   `shippedBy` (models, recent models, model share, ship credit) key by engine, model, effort and time; an extra
   `machineId` changes none of them (searched: `ledger.runs`, `shippedBy` in `backend/src`).
6. **Migration and rollback:** none. Old runs resolve by agent or count for no machine. A rollback leaves
   `machineId` and `othersToldWeek` unread; the previous release ignores both.
7. **Audience:** `brought` lists only the machines the reader's `visibleState` keeps (Buddy-only machines hidden) and
   counts only groups the reader may read (the read hands in no other); subscriptions come from the same readings every
   reader of the machine already sees. The notice goes to the machine's owner alone, in their own Buddy chat, and names
   a task title or project only when `canReadProject` lets the owner read it; the requester's name is a Swarm member's.
8. **Identity:** N/A because nothing runs as anyone: the server writes the notice in its own words (listed with the
   PM-switch notice as server words, so no agent's words are marked as another account's).
9. **Failure:** a machine with no reading shows its subscriptions as unknown ("not read yet"); an owner with no Buddy
   chat gets one opened (as the PM-switch notice does); a run with no machine counts nowhere rather than guessing.
10. **Platforms:** Desktop (macOS, Windows, Linux) and web share the card; the phone app (iOS, Android) shows the lines in
    its person sheet; the Buddy chat notice reaches all three. The CLI shows nothing new.
