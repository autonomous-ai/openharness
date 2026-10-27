# Feature design rules

Status: **draft for Ken's approval**. No process file links here yet.

A feature design that several groups will build against must meet these rules before any build group starts. Each
rule exists because #1755 broke it and paid for it later. Incident ids (D1–D12) point to the
[post-mortem](postmortems/2026-10-27-1755-design-rework.md), which has the evidence and the cost of each.

These rules are about the design, not the code. A design that meets them can still have coding slips; review
catches those.

## Rules

### 1. Every invariant names who keeps it, on every path

For each invariant, list every path that can break it and say what keeps it on that path:
- commands;
- sweeps and liveness checks;
- machine reports;
- migration and rollback;
- the failure and cancel paths.

A path with no keeper is a bug in the design.

- **Check:** pick any invariant and any background path, and find the line that says what happens there.
- **Prevents:**
  - D8f: run records were freed by commands only, not by liveness. This blocked 16 agents in production.
  - D1: hosts were woken for additions only.
  - D8b: a liveness decision did not guard what it read.

### 2. A new state or field comes with a table of its readers

When a design adds a status, flag or field to an existing record, search the code for every reader of that record,
or of the field it changes. Write one line per reader saying what it does with the new value. "Not active" is not
enough on its own.

- **Check:** the table names files, and a search for the field finds no reader the table misses.
- **Prevents:**
  - D8a, D8c, D8d, D8e and D8f: `lost` was unknown to decisions, the light loader, routing, rollback and run
    records.
  - D5: `dormant` was unknown to revocation, reports, route history and the archived list.

### 3. Every record has a lifecycle table

For each record the design creates or changes, give one row per event:
- create;
- update;
- finish;
- lost or failed;
- cancel;
- leave and rejoin;
- delete, purge, and recreate under the same key.

Each row says what is written, what derived records change (run records, deliveries, markers, tombstones), and who
writes them.

- **Check:** no empty cell. Each "nothing" is a stated decision.
- **Prevents:**
  - D6: a key recreated after a purge reset its version.
  - D8d: lost, then cancel, reassign or recover.
  - D12: leave and rejoin.
  - D8f: lost outside a command.

### 4. Privacy follows the data, not the routes

For private data, list every place a copy of it can end up, and the check that guards each one:
- API reads, change feeds, stubs and tombstones;
- notifications and mentions;
- an agent's terminal screen and scrollback once the data is delivered to it;
- shares, including ones made outside a Swarm;
- the same session in other Swarms;
- logs and stored observations;
- what a rolled-back release would show.

- **Check:** follow one private message from its post to every screen it can reach, and find each guard.
- **Prevents:**
  - D9: a private chat was readable in the PM's terminal, through ordinary shares and from other Swarms.
  - D10: rollback would have made private chats public.
  - Also the dormant-stub leak, which the design review caught.

### 5. One rule, one predicate, used by every read path

Write each read filter (audience, known kind, visibility) as one function. List every read path, and make each one
call that function. When a design adds a read path, it gets a test comparing its output with a first load's.

- **Check:** the read path list exists, and each filter appears once.
- **Prevents:**
  - D4: changes sent a kind that first loads hid.
  - D8c: the second loader derived a different decision.

### 6. Every read path has a cost budget: sent and loaded

For each read path, state what it may send and what it may load from the database, at a named Swarm size. A test
asserts both. "Costs what changed" must hold for both numbers.

- **Check:** a number per read path, and a test for each one.
- **Prevents:**
  - D3: reads loaded 1.17–2.3 MB to send 3 KB, which blocked the merge and cost a new group.
  - D2: every host tick resent its roster.

### 7. Build a thin end-to-end slice before groups split

Before parallel groups build against a contract, build one real write and one real read of each kind on the
isolated stack, and measure them against rules 1 and 6:
- a command;
- a Desktop change read;
- a host tick.

Contract changes found here are cheap. After clients have built against the contract, they are not.

- **Check:** the slice's numbers are in the design before groups start.
- **Prevents:**
  - D2: the etag and the readings rule were found by group 5's run, after the contract was built.
  - D3: database load was found only by group 6.
  - D7: the touch table conflicted with the no-conflict goal.

### 8. Rollout, migration and rollback name the previous release and real data

The design states:
- the order of deploys and migration;
- for every new field and state, what the previous release does with it on rollback;
- which production anomalies the migration was checked against.

Before the feature branch merges, the migration runs on an isolated restore of production data. If the owner says
no, the design records that, along with the read-only queries that looked for anomalies. When scope grows, the
rollback section is checked again.

- **Check:** a row per new field in a "previous release" table, and the dry-run evidence names its data source.
- **Prevents:**
  - D10: rollback would have exposed private chats and misread lost work.
  - D11: orphan history failed the production migration after the merge.

### 9. Scope added after approval reopens the design

A feature that joins a branch after its design was approved gets its own design note in the repository, not only in
chat. The note covers rules 1–4 and 8 against the approved design: which invariants it touches, which records gain
states, what private data it carries, what rollback does with it. A design review passes it before its build group
starts. A deadline is not a reason to skip this.

- **Check:** the note's path is in the build brief, along with its review verdict.
- **Prevents:**
  - D8: the liveness design was a scratchpad doc with no review, and caused six fixes, one of them in production.
  - D9 and D10: Chat with PM's copies and rollback were never designed against the approved design.
  - D12.

### 10. The design review checks this list, item by item

The design review is done by a Reviewer on a different engine, with code citations, as #1731's review was. It gives
a verdict on each checklist item below, not only an overall verdict. The whole-branch review asks the same
interaction questions again once the groups have merged.

- **Check:** the verdict lists each item as met, not met or not applicable, with a reason.
- **Prevents:**
  - D5, D6 and D7: the design review passed without reader tables, lifecycle tables or a slice.
  - D9 and D10: they surfaced only at the whole-branch review, when fixing cost 7.5 h.
  - It keeps what worked: #1731's review found 6 issues in 9 minutes, before any code.

## Design checklist (copy into the design doc)

Fill this in before build groups start. The design review marks each line. Each line takes a minute to check: the
design either has the table or number, or it doesn't.

```markdown
## Design checklist (docs/feature-design-rules.md)

Reviewed revision: ______  Reviewer: ______  Verdict per line: met / not met / n.a. (why)

1. Invariants: each listed with its keeper on commands, sweeps, liveness checks, machine
   reports, migration, rollback, failure and cancel.                                  [ ]
2. New states and fields: a table of every reader (file), and what it does with the new value.
   A search for the field finds no reader the table misses.                           [ ]
3. Lifecycle: one table per record (create, update, finish, lost, cancel, leave/rejoin,
   delete, purge, recreate), with derived records and who writes them. No empty cells.  [ ]
4. Privacy: every copy of private data (reads, feeds, stubs, notifications, terminals,
   shares, other Swarms, logs, rollback) has its guard named.                          [ ]
5. Read rules: the list of read paths; each filter is one predicate they all call;
   a test compares each new read path with first load.                                 [ ]
6. Cost: per read path, the bytes sent and the bytes loaded at a named size, each with
   a test.                                                                             [ ]
7. Thin slice: one command, one Desktop read and one host tick ran on the isolated
   stack before the split. Numbers: ______                                             [ ]
8. Rollout: deploy and migration order; what the previous release does with each new
   field and state; migration checked on a production restore (or the owner's no plus
   anomaly queries).                                                                   [ ]
9. Scope: every feature added after approval has a design note in the repo, with its
   own review verdict.                                                                 [ ]
10. Review: a Reviewer on a different engine, with code citations, marked each line above.  [ ]
```

## Proposed link (not applied; Ken decides)

One line for the bullet list in `AGENTS.md`:

```markdown
- Before build groups start on a feature design, the design meets the
  [Feature design rules](docs/feature-design-rules.md) and its review marks the checklist.
```
