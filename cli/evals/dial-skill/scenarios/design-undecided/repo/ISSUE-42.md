# ISSUE-42: Cache the user lookup

`getUser` runs on every authenticated request and is now about 38% of our database load (dashboard, Nov 10). We want a
cache in front of it.

## Options

### A. In-process LRU

- A small LRU in each API instance (10k entries, 5 minute TTL).
- No new infrastructure.
- A profile edit can be served stale for up to 5 minutes, and each of the 6 instances keeps its own copy, so two
  requests in a row can disagree.

### B. Redis

- One shared Redis at `cache.accounts.invalid`, cleared on every profile write, so reads are never stale.
- Ops has to provision and run it, and it adds roughly $180/month.
- One more service on the request path that can be down.

## Decision

Not decided yet. Support says stale plan and role changes have bitten us before; ops would rather not run another
service this quarter.
