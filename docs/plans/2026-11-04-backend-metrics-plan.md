# Backend metrics the scan can read from the log tail: implementation plan

This plan is followed task by task, test first, by the Engineer of task #2957 (project instructions, Engineer role),
on PR #1880's own branch. There is no execution handoff.

**Goal:** The production scan measures an hour of backend load from what one `argocd app logs` call returns today,
even though each pod's logs keep only its last ~3 minutes (Ken's scan, 2026-11-04 21:30): requests per route, CPU per
request and DB bytes per request, with no tab, person or machine id anywhere.

**Architecture:** PR #1880 (10-28) adds prom-client counters and a `/metrics` listener; main has since added per-minute
log lines (`route latency`, `db by shape`, `cpu by thread`, `cpu by kind`) from the same hooks. After merging main, the
two are one: the events that feed the Prometheus counters also feed a ring of 60 one-minute buckets, and every minute
the process logs `last hour`, the ring's sums. The newest `last hour` line of each pod is in any log tail, so one read
gives the hour. `/metrics` serves the same counters, cumulative, for a scraper.

**Tech Stack:** Node 22, Fastify 5, Prisma 5 (MongoDB), prom-client 15, vitest.

**Spec:** Task #2957's brief (Ken's prod scan, 2026-11-04) and Ken's decision of 2026-11-04 (through River): node log size stays,
the counters are how scans measure the backend, so they cover everything the scan reads from logs today.

## Global Constraints

- Labels and log keys are bounded and carry no ids: a route is its Fastify pattern (`/api/super-tabs/:tabId/changes`)
  or `unrouted`; a kind of work is the name `workKind()` gives (`http GET /x`, `web-ws <frame>`, `bus <sub> <channel>`,
  `background`); a Prisma model and operation; a status code. Each set is capped (300 values), past that `other`.
- Ships on, with no switch (ENGINEERING.md §1, Ken): the counters, the `last hour` line and the `/metrics` listener
  run in every process. The port base and host are addresses, not switches.
- One way to do a thing (ENGINEERING.md §1): one Prisma query extension, one slow-query log (main's `slow query`,
  ≥ 200 ms, at most 20 a minute), one stack in a 500's log line (main's `trace`).
- Measurement never blocks or slows the product (ENGINEERING.md §8): no work per request beyond a few map updates;
  DB bytes come from `db by shape`'s existing sampled estimate, once a minute.

## Review Focus

- A request to an unknown URL full of ids (`/wp-admin/6a7301…`) is one `unrouted` series, in `/metrics` and in the line.
- A pod that restarted 10 minutes ago logs an hour line covering 10 minutes and says so (`windowMs`, `minutes`).
- A 301st kind of work (a new bus channel, a new frame) lands in `other`, in both views, never a new series.
- A minute with no requests divides by nothing: per-request numbers are 0, not `NaN` or `Infinity`.
- A metrics port already taken (two local backends) is logged and the API keeps serving.

---

### Task 1: One Prisma query hook times every query into the histogram

**Files:**
- Modify: `backend/src/lib/queryStats.ts` (`withQueryStats`), `backend/src/lib/metrics.ts` (remove `timeQuery`,
  `withQueryTiming`, `SLOW_QUERY_MS`, `QueryCall`), `backend/src/lib/prisma.ts`
- Test: `backend/src/lib/queryStats.test.ts`, `backend/src/lib/metrics.test.ts`, `backend/integration/prismaQueryTiming.test.ts`

**Interfaces:**
- Produces: `withQueryStats(client, stats?, warn?, observe?: (model: string, operation: string, seconds: number) => void)`;
  `model` is `raw` for a call without one. `metrics.observeQuery(model, operation, seconds)`.

- [ ] **Step 1: Failing test** in `queryStats.test.ts`: `withQueryStats` on a fake client whose `$extends` keeps the
  hook; a `User.findFirst` that succeeds, one that throws, and a `$runCommandRaw` each call `observe` once with
  (`User`,`findFirst`) / (`raw`,`$runCommandRaw`) and the elapsed seconds; the thrown error passes unchanged.
- [ ] **Step 2:** Run `npx vitest run src/lib/queryStats.test.ts`: FAIL (observe never called).
- [ ] **Step 3:** Add the `observe` parameter; a throwing `observe` is caught like a throwing `stats`. `prisma.ts` wraps
  once: `withQueryStats(client, undefined, undefined, metrics.observeQuery)`. Delete `withQueryTiming` and `timeQuery`
  with their tests; the integration test uses the shared client and `withQueryStats`.
- [ ] **Step 4:** Run the unit tests above and `npm run typecheck`: PASS.
- [ ] **Step 5:** Commit.

### Task 2: The `/metrics` listener is always on

**Files:** Modify `backend/src/lib/metrics.ts` (`metricsAddress`), `backend/src/config/env.ts`; test `metrics.test.ts`.

**Interfaces:** `metricsAddress({ portBase = 9464, host = '127.0.0.1' }, workerIndex): { port, host }` (never undefined).

- [ ] **Step 1: Failing test:** `metricsAddress({}, 0)` is `{ port: 9464, host: '127.0.0.1' }`; worker 3 gets 9467.
- [ ] **Step 2:** Run it: FAIL (`undefined`).
- [ ] **Step 3:** Default the base to 9464 in `env.ts` (`METRICS_PORT_BASE` default `'9464'`, no "empty means off").
- [ ] **Step 4:** PASS. **Step 5:** Commit.

### Task 3: The last hour, from the same events as the counters

**Files:**
- Create: `backend/src/lib/lastHour.ts`, test `backend/src/lib/lastHour.test.ts`
- Modify: `backend/src/lib/metrics.ts` (counters, `request`, `dbWindow`, `busyWindow`, unmatched → `unrouted`),
  `backend/src/lib/queryStats.ts` (`onWindow` option), `backend/src/lib/selfProfile.ts` (`onWindow` option),
  `backend/src/server.ts` (wiring), tests `metrics.test.ts`, `queryStats.test.ts`, `selfProfile.test.ts`

**Interfaces:**
- `createLastHour({ pod?, minutes = 60, top = 40, maxKeys = 300, cpuMs = () => process CPU ms, log? }): LastHour`
  with `request(route: string, ms: number, failed: boolean)`, `db(work: ReadonlyMap<string, { n: number; ms: number; bytes: number }>)`,
  `busy(work: ReadonlyMap<string, number>)`, `roll()` (closes the minute and logs `last hour`).
  `startLastHour(hour, everyMs = 60_000): () => void`.
- `createMetrics(hour = createLastHour())` gains Counters `db_queries_total{work}`, `db_result_bytes_total{work}`,
  `work_busy_seconds_total{work}` and methods `request(method, route, status, seconds)`, `dbWindow(routes)`,
  `busyWindow(kinds)`, each updating the Prometheus series and the hour.
- `QueryStatsOptions.onWindow?(routes)` gets every route's `{ n, ms, bytes }` of the minute (before the top-40 cut);
  `SelfProfileOptions.onWindow?(busy)` gets every kind's busy ms.
- The line: `last hour {pod, windowMs, minutes, requests, errors, cpuMs, cpuMsPerRequest, dbQueries, dbBytes,
  dbBytesPerRequest, routes: {"GET /x": {n, perMinute, errors, ms, dbQueries, dbBytes, dbBytesPerRequest, busyMs,
  busyMsPerRequest}}, work: {"web-ws x": {dbQueries, dbBytes, busyMs}}}`; `routes` joins `http GET /x` work to its route.

- [ ] **Step 1: Failing tests** in `lastHour.test.ts`: sums across minutes and drops the 61st-oldest; per-request
  numbers; `minutes`/`windowMs` after 10 minutes; zero requests gives 0; the 301st key is `other`; a route joins its
  `http` work's DB bytes and busy ms; the line lists the top routes by time, by DB bytes and by busy ms.
- [ ] **Step 2:** Run: FAIL (module missing).
- [ ] **Step 3:** Implement `lastHour.ts`.
- [ ] **Step 4: Failing tests** in `metrics.test.ts`: an unknown URL is `unrouted`; `dbWindow` of a bus channel kind adds
  `db_result_bytes_total{work="bus web termup"}` with no id in the scrape; the 301st work is `other`; in
  `queryStats.test.ts`, `onWindow` gets every route, not only the top 40; in `selfProfile.test.ts`, `onWindow` gets the
  minute's busy ms.
- [ ] **Step 5:** Run: FAIL. **Step 6:** Implement and wire in `server.ts`. **Step 7:** PASS, typecheck. **Step 8:** Commit.

### Task 4: The pull request says how the scan reads it

- [ ] PR body: first line `Requested by 0xken15@gmail.com through Harness.`; the exact `argocd app logs` command and
  how to sum pods; `/metrics` for a scraper; the Design section; red/green evidence in a comment; backend `npm test`.
