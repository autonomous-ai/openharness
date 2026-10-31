# Feature design rules

Ken's rules, set on 2026-10-27; [AGENTS.md](../AGENTS.md#feature-design-rules) carries the short version. This is
the detailed version: what a good answer to each line contains, and the incidents behind it. Incident ids (D1–D12)
point to the [post-mortem of #1755](postmortems/2026-10-27-1755-design-rework.md), which has the evidence and the
cost of each.

**Why:** Swarm had to redo its state storage (#1726) because the original design (#1405) never asked how the data
grows, who writes concurrently, or how much a client reads per poll. 31 later PRs in seven days changed the same JSON state
until it reached 1.16 MB and returned 500s. The first fix (#1722) only added a retry. The privacy bugs (#1748, #1751),
old clients getting 426 (#1755) and teammates' work running as the machine owner (the Team account work) were all
found late for the same reason: the spec had no design-check step.

## Rule 1. Every spec that stores, syncs or exposes data has a Design section

The Design section answers each line below briefly, or says "N/A because …". It is part of the spec, and a design
review checks each line before build groups start. A feature added to a branch after its design was approved is a
spec of its own and needs its own Design section; a scratchpad doc in chat is not one (D8, D9, D10).

### 1. Growth: what deletes it

Say what makes each record leave the active set or the database, and at what size it stops working without that.

A good answer:
- gives a lifecycle table per record (create, update, finish, lost, cancel, leave and rejoin, delete, purge,
  recreate under the same key), with no empty cell;
- for each archive or expiry state, lists every reader of "all records" and says what it does with the archived
  ones.

Incidents:
- #1405's Swarm state only grew until #1726.
- D5: `dormant` broke revocation, reports, route history and the archived list.
- D6: a key recreated after a purge reset its version.

### 2. Concurrency: at what level it locks

Name the unit a write locks, and what each write reads and must guard.

A good answer:
- lists each invariant with what keeps it on every path: commands, sweeps and liveness checks, machine reports,
  migration, rollback, and failure;
- makes a decision taken outside a command guard what it read;
- runs the lock table against the goal (for example "no conflicts between groups") on a thin end-to-end slice
  before groups split.

Incidents:
- #1405 locked the whole Swarm; #1722 retried instead.
- D7: the touch table would have brought the conflicts back.
- D8b: a liveness loss did not guard the machine report it was judged from.
- D9: two registrations raced.

### 3. Read cost: read only what changed

State, for each read path, what it may send and what it may load from the database, at a named size. A test asserts
both. "Only what changed" includes removals: a reader must learn that something it held left.

Incidents:
- #1405 sent the full state on every poll.
- D1: hosts missed changes that removed something.
- D2: every host tick resent its roster.
- D3: reads loaded 1.17–2.3 MB to send 3 KB, and a new group was needed.

### 4. Scale: 10x, and the metric that warns first

Say what happens at ten times today's largest case (people, agents, records, size), and which measured number shows
the limit coming before users do. Measure it on the thin slice, not only at integration.

Incidents:
- Nothing warned before the 1.16 MB Swarm returned 500s (#1722).
- D3: database bytes were not measured until group 6.
- D2: host tick cost showed only in group 5's end-to-end run.

### 5. Compatibility: old and new clients

Say what an old client sees, what a client sees from an older or newer server during a rolling deploy, and what
every existing reader does with a new field or state. "Every existing reader" means a search of the code, with one
line per reader. "Not active" is not an answer.

Incidents:
- #1755: every old client got 426, so all clients had to release together.
- D4: changes sent a kind that first loads hid during a rolling deploy.
- D8a, D8c, D8d and D8f: `lost` was unknown to decisions, the light loader, routing and run records.

### 6. Migration and rollback

Give the order of deploys and migration. Say what the previous release does with every new field and state if you
roll back. Name the production data the migration was checked against: an isolated restore of the production backup
before the feature branch merges, or the owner's no and the read-only anomaly queries run instead. Check the rollback
section again whenever scope grows.

Incidents:
- D10: rollback would have exposed private chats and misread lost work.
- D11: history from deleted conversations failed the production migration after the merge.

### 7. Audience: the server enforces it

The server decides who can read each record, in one predicate that every read path calls. List every place a copy of
private data can end up, and the guard on each one:
- API reads, change feeds, stubs and tombstones;
- notifications and mentions;
- an agent's terminal screen and scrollback once the data is delivered to it;
- shares, including ones made outside a Swarm;
- the same session in another Swarm;
- logs and stored observations;
- what a rolled-back release would show.

Incidents:
- #1748 and #1751 (D10 and D9): private chats reached the previous release and the PM's terminal.
- D12: a person who rejoined got a chat they could no longer read.
- D4 and D8c: a second read path applied different filters.
- The dormant-stub leak, which the design review caught.

### 8. Identity: never use the machine owner's login

Work for one person never runs as another person: not their OS account, git login, engine subscription or session.
Say which identity each action runs as on a shared machine, and what happens when that identity is missing (refuse
and say so, never fall back to the owner).

Incident: before the Team account work (#1688–#1705), teammates' agents ran as the machine owner, with full
permissions and the owner's git login. That was 18 of 113 agent starts in one live Swarm, 21–23 Oct (from
`docs/plans/2026-10-24-swarm-team-account.md`).

### 9. Failure: nothing breaks without saying so

For each way the feature can fail (a machine offline, a session closed, a limit hit, a step refused, a write lost),
say who notices, what the person sees, and how the record recovers. A failure state needs its lifecycle (line 1) and
its readers (line 5) like any other.

Incidents:
- D8f: 16 lost tasks left their agents silently "busy" for good, in production.
- D8: `lost` needed six fixes.
- #1744 had to make refused starts fail with a reason, where before they waited in silence.

### 10. Platforms

Name the platforms it runs on (macOS, Windows, Linux, web, phone), and what differs or is left out on each.

Incidents:
- #1722 found a Windows-only failure: a narrow pane hid Claude Code's composer.
- #1743 left Windows machines out of routing for now.

## Rule 2. Review the design again when a limit is close or a bug comes back

Review the design again, with the same ten lines, when either of these happens:
- a measured limit is less than 10x away;
- the same bug needs patching a second time.

A retry, a cap or a second patch of the same thing is the signal, not the fix.

Incidents:
- #1722 retried a 1.16 MB Swarm. That Swarm's 195 groups were already within 13x of the 16 MB document limit
  (about 2,500 groups, per #1726), and its write conflicts had already hit.
- D1: the host wake-up was patched twice.
- D5: the dormancy rule was corrected twice.
- D8: `lost` was patched six times.

## Design checklist (copy into the spec)

Each line takes about a minute to check. Either the spec answers it, or says why it doesn't apply.

```markdown
## Design (docs/feature-design-rules.md)

Reviewed revision: ______  Reviewer: ______  Each line: answered / N/A because …

1. Growth: what deletes each record; lifecycle table, no empty cells.              [ ]
2. Concurrency: what a write locks; each invariant's keeper on every path,
   sweeps and failures included.                                                  [ ]
3. Read cost: per read path, bytes sent and bytes loaded at a named size, with a test;
   removals reach readers.                                                        [ ]
4. Scale: what happens at 10x; the metric that warns first; measured on a thin slice.  [ ]
5. Compatibility: old clients, rolling deploys, and every existing reader of each new
   field or state (from a search of the code).                                    [ ]
6. Migration and rollback: order; what the previous release does with each new field;
   checked on a production restore (or the owner's no plus anomaly queries).       [ ]
7. Audience: one server predicate on every read path; every copy of private data
   has its guard named.                                                           [ ]
8. Identity: what each action runs as; never the machine owner's login; refuse
   when it's missing.                                                             [ ]
9. Failure: who notices each failure, what the person sees, how it recovers.       [ ]
10. Platforms: where it runs, and what differs.                                    [ ]

Review again when a measured limit is under 10x away, or the same bug needs a second patch.
```
