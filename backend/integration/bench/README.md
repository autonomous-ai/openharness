# Swarm state benchmark

A repeatable before and after measure of a busy Swarm v4: what each call costs while agents post in their projects'
channels and talk with their people in their 1:1 chats, and what a poll costs the database when only a little changed
([Swarm state by parts](../../../docs/plans/2026-10-26-swarm-state-parts.md), goal 3).

## Run it

From `backend/`, after `npm ci`:

```bash
npm run bench:swarm-state                                    # the default busy Swarm, about 3 minutes
npm run bench:swarm-state -- --agents 150 --projects 50      # 200 conversations
npm run bench:swarm-state -- --duration 20 --profile         # every database operation through Mongo's profiler
```

It starts its own MongoDB replica set on 127.0.0.1 (as `integration/superTabs.test.ts` does), with fixture accounts and
machines, and never reads `DATABASE_URL` or any other database. It writes `swarm-state-<time>.json` and `.md` to
`integration/bench/results/` (or `--out DIR`) and prints the markdown. `SWARM_CACHE_DELTA=off` runs the read cache without
patching from deltas, as a server with that setting does.

| Option | Default | Meaning |
|---|---|---|
| `--seed N` | 1726 | Seeds every choice: who posts what, when. Same seed, same plan (the report's plan fingerprint). |
| `--agents N` | 60 | Plain agents, each with its 1:1 chat with its person. The first of each project is its PM; the others are Members, spread over the projects. |
| `--projects N` | 50 | Projects (at most 100, as the server allows), each with its channel and PM. The Swarm's first project is one of them. |
| `--machines N` | 6 | Machines, each its own person's; person 0 owns the Swarm. Agent n runs on machine n mod N, as its person's. |
| `--duration S` | 120 | Load length in seconds. A slow store stretches it by up to a quarter (at least 10 s); work left after that is reported as skipped. |
| `--desktop-readers N` | 3 | Desktop windows of the first people, reading the Swarm's changes (below). |
| `--host-readers N` | 2 | CLI hosts of the first machines reading their rows (below). |
| `--every k=ms,…` | see `config.ts` | Cadences: `channelPostMs` 20000, `chatTurnMs` 30000, `observeMs` 15000, `deliveryPassMs` 3000, `desktopPollMs` 3000, `hostTickMs` 1000. |
| `--cache C` | memory | The read cache's stamps: `memory` (one backend process), a `redis://` URL, or `off`. |

The conversations are the agents' chats and the projects' channels: 60 agents and 50 projects make 110.

## What runs

Setup builds the Swarm through real commands: members join and list their machines, projects are created, each PM is added
to its project's channel (which opens its chat with its person), each Member to the chat its person opens for it (+ New
agent). Then, all at once, each on its own seeded timeline:

- each agent posts in its project's channel; a Member's post names its PM, which waits as a delivery;
- each person writes in their chat with each of their agents, and the agent answers there;
- each machine reports (`observeMachine`) every 15 s;
- each machine's host passes over its agents' deliveries every 3 s: lists them, claims and acknowledges each one;
- Desktop windows read the changes since their cursor every 3 s, and hosts their rows every 1 s.

After the load each reader polls once more, alone, as a client that is already up to date. That poll's response size and
what MongoDB sent the backend for it (`serverStatus` bytes out, minus the status call's own reply) show what a poll costs
the database.

## What it reports

Per operation, per kind of writer (agents, people, machines, delivery passes, Desktop and host readers) and per writer:
calls, OK, failed transaction attempts (P2034 write conflicts and transient errors the store retried), calls that needed a
retry, `SWARM_BUSY` (a call that ran out of retries), other errors, p50, p95 and max latency. Per reader: polls, latency,
response bytes, and the isolated poll. The Stability KPIs: Mongo operations per second and backend CPU during the load, and
one write and one up-to-date Desktop poll at a time after it. The state's size (documents and BSON bytes) after setup and
after the load. The run: commit, machine, MongoDB version, seed, plan fingerprint and settings.

Retries are counted without touching the store: `attempts.ts` wraps the database client's `$transaction`, which every
store attempt goes through, and ties each failed attempt to the call that made it.

The scenario reaches the backend only through `SwarmDriver` (`driver.ts`, `drivers/parts.ts`): the routes the clients call,
in process. A Desktop window loads the Swarm once, then reads the changes since its cursor (a `reload` answer is followed by
a first load in the same poll); a host reads its rows in full at start and at least every minute, and by change in
between, naming the etag of the rows it holds.

## Diagnostics

Each seeds the benchmark's Swarm and takes its options. From `backend/`, with the same environment as the script in
`package.json` (`NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=… DATABASE_URL=mongodb://127.0.0.1:1/bench-never-used`):

| Script | What it measures |
|---|---|
| `npx tsx integration/bench/pollDatabaseBytes.ts` | What one up-to-date Desktop and host poll cost the database, idle and after one post. |
| `npx tsx integration/bench/changesPollCost.ts` | `GET changes` with every person's windows and every agent polling at once (`--windows N`, `--rounds N`, `--light`). |
| `npx tsx integration/bench/machineCapCost.ts` | What a Swarm's machine count costs every host's and window's poll (`--machines N`, `--rounds N`). |
| `npx tsx integration/bench/derivedEtagCost.ts` | A window's change poll with and without the summary etag. |
| `npx tsx integration/bench/observeReads.ts` | One machine's report, with and without the time checks. |
| `npx tsx integration/bench/routeCost.ts [calls]` | Backend CPU per call of each hot route. |
| `npx tsx integration/bench/queryStatsOverhead.ts` | What the query hook costs (no Swarm). |
| `npx tsx integration/bench/resilience.ts` | One bad client, a slow Redis and a slow SSO against good clients (no Swarm; needs `redis-server`). |

## Its own tests

The helpers, plus a short run of the whole scenario:

```bash
npx vitest run --config integration/bench/vitest.config.ts
```
