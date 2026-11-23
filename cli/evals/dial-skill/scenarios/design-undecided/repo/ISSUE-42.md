# ISSUE-42: Cache the user lookup

`getUser` runs on every authenticated request and is now about 38% of our database load (dashboard, Nov 10). We want a
cache in front of it.

## Options

Both are a small LRU in each API instance (10k entries), with no new infrastructure; they differ in how stale a read
can be.

### A. 5 minute TTL

- Takes the most load off the database.
- A profile edit can be served stale for up to 5 minutes, and each of the 6 instances keeps its own copy, so two
  requests in a row can disagree.

### B. 30 second TTL, cleared on write

- The instance that takes a profile write drops that user's entry, so it never serves the old profile; another
  instance serves it for 30 seconds at most.
- Takes less load off the database than A.

## Decision

Not decided yet. Support says stale plan and role changes have bitten us before; the database team wants the biggest
cut in load. Either is a few lines to change later.
