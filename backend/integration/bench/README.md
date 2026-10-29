# Swarm state benchmark (#1726)

A repeatable before and after measure for two goals of
[Swarm state by parts](../../../docs/plans/2026-10-26-swarm-state-parts.md): agents in different work groups never
conflict (goal 1), and a poll costs what changed, not the whole Swarm (goal 3). The baseline on main is
[docs/performance/2026-10-26-swarm-state-baseline.md](../../../docs/performance/2026-10-26-swarm-state-baseline.md).

## Run it

From `backend/`, after `npm ci`:

```bash
npm run bench:swarm-state                         # the default busy Swarm, about 3 minutes
npm run bench:swarm-state -- --lane cross-group   # goal 1: one writer per group, so any conflict is across groups
npm run bench:swarm-state -- --done-share 0       # the hot Swarm: all 200 groups active, the same 20 workers spread over them
```

It starts its own MongoDB replica set on 127.0.0.1 (as `integration/superTabs.test.ts` does), with fixture accounts and
machines, and never reads `DATABASE_URL` or any other database. It writes `<driver>-<time>.json` and `.md` to
`integration/bench/results/` (or `--out DIR`) and prints the markdown.

| Option | Default | Meaning |
|---|---|---|
| `--seed N` | 1726 | Seeds every choice: who posts what, when. Same seed, same plan (the report's plan fingerprint). |
| `--groups N` | 200 | Work groups besides the Leads group. |
| `--done-share X` | 0.9 | Share of groups done before the load; the rest are active. |
| `--workers N` | 20 | Workers, at most one per active group. Each takes active groups in turn and holds the task of its first (an agent holds one active task at a time); its messages go to any of its groups, its status and checks to that first group. |
| `--lane L` | mixed | `mixed`: the busy Swarm below. `cross-group`: one writer per group at a time, for goal 1 (below). |
| `--machines N` | 6 | Contributed machines, each its own person's; machine 0 is the owner's and runs the Lead. |
| `--duration S` | 120 | Load length in seconds. A slow store stretches it by up to a quarter (at least 10 s); work left after that is reported as skipped. |
| `--desktop-readers N` | 3 | Desktop windows of the owner and the first machine owners, polling the Swarm (below). |
| `--host-readers N` | 2 | CLI hosts of the first machines reading their roster (below). |
| `--mix a=w,…` | `message.send=2,work.status=1,work.check=1` | Relative weights of a worker's posts in its own group. |
| `--every k=ms,…` | see `config.ts` | Cadences: `workerPostMs` 4000, `leadSendMs` 5000, `nativeTurnMs` 10000, `observeMs` 15000, `deliveryPassMs` 3000, `desktopPollMs` 3000, `hostTickMs` 1000. |
| `--driver NAME` | parts | Which store's clients to run (below). |

The isolated poll in the report runs right after the load, while every part changed in the last 30 s still comes
again. To see what one up-to-date poll costs the database when the Swarm is idle, and after a single post, run the
diagnostic. It takes the same options:

```bash
NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  DATABASE_URL=mongodb://127.0.0.1:1/bench-never-used npx tsx integration/bench/pollDatabaseBytes.ts
```

To see what a migrated Swarm's kept old state (`SuperTab.legacyState`, about 1 MB in production) costs each read, run
the old state diagnostic. It gives the benchmark's Swarm a 1 MB old state, then times the Lead's status, a host's delivery
poll with nothing waiting (the empty read) and one post, 30 times each, with the old state kept and once it is removed,
and prints the median time and what MongoDB sent the backend per read. It takes the same options:

```bash
NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  DATABASE_URL=mongodb://127.0.0.1:1/bench-never-used npx tsx integration/bench/oldStateReads.ts
```

To see what one machine's report (`observeMachine`, every 15 s per machine) costs alone, its median time and what MongoDB
sent the backend for it, with and without the time checks, run the report diagnostic. It takes the same options:

```bash
NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  DATABASE_URL=mongodb://127.0.0.1:1/bench-never-used npx tsx integration/bench/observeReads.ts
```

The bench's own tests (helpers, plus a short run of the whole scenario), and its typecheck:

```bash
npx vitest run --config integration/bench/vitest.config.ts
npx tsc -p integration/bench/tsconfig.json
```

## What runs

Setup builds the Swarm through real commands: members join, machines are contributed, the Lead and the workers are
added, every group gets a brief and two checks, and each done group runs a whole task (assign, pass both checks, done).
Then, all at once, each on its own seeded timeline:

- each worker posts in its own group: `message.send`, `work.status`, `work.check`, in the mix;
- each worker's terminal records a turn (a prompt and its answer, `native.append`), which also notifies the Lead;
- the Lead sends a worker a message, which waits as a delivery;
- each machine reports (`observeMachine`) every 15 s;
- each machine's host passes over its agents' deliveries every 3 s: lists them, claims and acknowledges each one;
- Desktop readers poll the full state every 3 s and host readers their roster every 1 s.

In the `cross-group` lane each worker's posts and terminal turns run in one sequence, and there are no Lead messages and
no delivery passes, so no two calls ever write one group at once: every conflict between agents is between different
groups. Machine reports stay, every 15 s: after the parts change they write only their machine's part, so they must not
conflict with group writes either. The report's writer kinds table shows which kind of writer met the conflicts.

After the load each reader polls once more, alone, as a client that is already up to date. That poll's response size
and what MongoDB sent the backend for it (`serverStatus` bytes out, minus the status call's own reply) show what a poll
costs the database: today a host roster reply is a few KB, but it loads the whole Swarm document.

## What it reports

Per operation, per kind of writer (worker, terminal, machine, delivery pass, Lead, Desktop and host readers) and per writer: calls, OK, failed transaction attempts (P2034 write conflicts and transient errors the
store retried), calls that needed a retry, `SWARM_BUSY` (a call that ran out of retries), other errors, p50, p95 and
max latency. Per reader: polls, latency, response bytes, and the isolated poll. The state's size (documents and BSON
bytes) after setup and after the load. The run: commit, machine, MongoDB version, seed, plan fingerprint and settings.

Retries are counted without touching the store: `attempts.ts` wraps the database client's `$transaction`, which every
store attempt goes through (spec: "Mongo transactions through Prisma as today"), and ties each failed attempt to the
call that made it.

## The seam for the parts store

The scenario talks to a store only through `SwarmDriver` (`driver.ts`): create a Swarm, run a command (as a person or
as an agent), read back setup facts (`snapshot`), a machine's generation and report, open and record a terminal, list,
claim and acknowledge deliveries, a Desktop reader and a host reader, the state's size, close. Commands keep their
shapes across versions, so they cross the seam as they are.

Two drivers, registered in `DRIVERS` (`bench.ts`); run either with the same seed. Nothing in `plan.ts`, `seed.ts` or
`load.ts` differs between them.

- `legacyDriver.ts` (`--driver legacy`) is main's store through main's routes: every Desktop poll reads the whole
  Swarm, every host tick its roster. On the store by parts those full reads answer 426, so it runs only on main (the
  baseline).
- `drivers/parts.ts` (`--driver parts`, the default here) is the store by parts, read the way the merged clients read
  it: commands and the other writes through the same routes; setup facts from a first load; each Desktop window loads
  once, then reads the changes since its cursor (a `reload` answer is followed by a first load in the same poll); each
  host reads its host form in full at start and at least every minute, and by change in between, naming the etag of
  the rows it holds. The state's size is its live parts.
