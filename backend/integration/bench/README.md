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
| `--desktop-readers N` | 3 | Desktop windows of the owner and the first machine owners, polling the full state. |
| `--host-readers N` | 2 | CLI hosts of the first machines reading their roster. |
| `--mix a=w,…` | `message.send=2,work.status=1,work.check=1` | Relative weights of a worker's posts in its own group. |
| `--every k=ms,…` | see `config.ts` | Cadences: `workerPostMs` 4000, `leadSendMs` 5000, `nativeTurnMs` 10000, `observeMs` 15000, `deliveryPassMs` 3000, `desktopPollMs` 3000, `hostTickMs` 1000. |
| `--driver NAME` | legacy | Which store's clients to run (below). |

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

Per operation, per kind of writer (worker, terminal, machine, host, Lead, readers) and per writer: calls, OK, failed transaction attempts (P2034 write conflicts and transient errors the
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

`legacyDriver.ts` is today's store through today's routes. For the parts store, add a driver that:

- builds its routes or store on the given (counted) client, and returns the same `Reply` shape;
- makes `desktopReader` and `hostReader` poll the way the new clients do (first load, then changes since a cursor),
  keeping their cursor inside the reader;
- answers `snapshot` from its parts, and `stateSize` with the total of its active parts (documents and BSON bytes);

then register it in `DRIVERS` (`bench.ts`) and run `--driver <name>` with the same seed. Nothing in `plan.ts`,
`seed.ts` or `load.ts` changes.
