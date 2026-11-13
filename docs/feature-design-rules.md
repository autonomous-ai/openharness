# Feature design rules

Ken's rules, set on 2026-10-27; [AGENTS.md](../AGENTS.md) carries the short version (code standard 5). This is
the detailed version: what a good answer to each line contains.

**Why:** a design that never asks how its data grows, who writes it at once, or how much a client reads per poll is
found wrong late, after many changes are built on it, and a retry is not the fix. Privacy bugs, old clients refused
during a rolling deploy, and one person's work running under another's login are found late for the same reason: the
spec had no design-check step.

## Rule 1. Every spec that stores, syncs or exposes data has a Design section

The Design section answers each line below briefly, or says "N/A because …". It is part of the spec, and a design
review checks each line before build groups start. A feature added to a branch after its design was approved is a
spec of its own and needs its own Design section; a scratchpad doc in chat is not one.

### 1. Growth: what deletes it

Say what makes each record leave the active set or the database, and at what size it stops working without that.

A good answer:
- gives a lifecycle table per record (create, update, finish, lost, cancel, leave and rejoin, delete, purge,
  recreate under the same key), with no empty cell;
- for each archive or expiry state, lists every reader of "all records" and says what it does with the archived
  ones.

### 2. Concurrency: at what level it locks

Name the unit a write locks, and what each write reads and must guard.

A good answer:
- lists each invariant with what keeps it on every path: commands, sweeps and liveness checks, machine reports,
  migration, rollback, and failure;
- makes a decision taken outside a command guard what it read;
- runs the lock table against the goal (for example "no conflicts between groups") on a thin end-to-end slice
  before groups split.

### 3. Read cost: read only what changed

State, for each read path, what it may send and what it may load from the database, at a named size. A test asserts
both. "Only what changed" includes removals: a reader must learn that something it held left.

### 4. Scale: 10x, and the metric that warns first

Say what happens at ten times today's largest case (people, agents, records, size), and which measured number shows
the limit coming before users do. Measure it on the thin slice, not only at integration.

### 5. Compatibility: old and new clients

Say what an old client sees, what a client sees from an older or newer server during a rolling deploy, and what
every existing reader does with a new field or state. "Every existing reader" means a search of the code, with one
line per reader. "Not active" is not an answer.

### 6. Migration and rollback

Give the order of deploys and migration. Say what the previous release does with every new field and state if you
roll back. Name the production data the migration was checked against: an isolated restore of the production backup
before the feature branch merges, or the owner's no and the read-only anomaly queries run instead. Check the rollback
section again whenever scope grows.

### 7. Audience: the server enforces it

The server decides who can read each record, in one predicate that every read path calls. List every place a copy of
private data can end up, and the guard on each one:
- API reads, change feeds, stubs and tombstones;
- notifications and mentions;
- an agent's terminal screen and scrollback once the data is delivered to it;
- shares;
- logs and stored observations;
- what a rolled-back release would show.

### 8. Identity: never use the machine owner's login

Work for one person never runs as another person: not their OS account, git login, engine subscription or session.
Say which identity each action runs as on a shared machine, and what happens when that identity is missing (refuse
and say so, never fall back to the owner).

### 9. Failure: nothing breaks without saying so

For each way the feature can fail (a machine offline, a session closed, a limit hit, a step refused, a write lost),
say who notices, what the person sees, and how the record recovers. A failure state needs its lifecycle (line 1) and
its readers (line 5) like any other.

### 10. Platforms

Name the platforms it runs on (macOS, Windows, Linux, web, phone), and what differs or is left out on each.

## Rule 2. Review the design again when a limit is close or a bug comes back

Review the design again, with the same ten lines, when either of these happens:
- a measured limit is less than 10x away;
- the same bug needs patching a second time.

A retry, a cap or a second patch of the same thing is the signal, not the fix.

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

## Tech limits

Designed for 10x today's scale. Each is checked on the current build; a resource less than 10x below its limit needs a
design review.

- Hot-path queries: p95 ≤ 100 ms, none scans a collection.
- Desktop at rest with 16 terminals: ≤ 1% of one core, ≤ 500 MB. Daemon at rest: ≤ 1% of one core.
- Remote terminal echo over a direct connection: p95 ≤ 50 ms.
- `ci/required`: ≤ 15 min.
