# Backend resilience: rate limits, timeouts and circuit breakers (Stability 3.2 and 3.5)

Stability roadmap items 3.2 (real rate limits) and 3.5 (protection when a dependency is slow), approved by the owner.

## What changed

| Area | Before | After |
|---|---|---|
| Feature rate limits (agent routing, community, analytics, device keys, Grid profile, QR sign-in) | Counted in each process: the limit multiplied by processes and pods, and reset on every deploy | Counted once across every pod through one Redis call (`lib/rateLimit.ts`); per process while Redis is unavailable, with one warning each way. Limits unchanged |
| Every signed-in request | No ceiling | Per method and route pattern (`middlewares/routeRateLimit.ts`), two ceilings in one Redis call: per second for its caller (the agent the route names, else the machine, each together with the person; else the person), and per minute for the person whatever ids it names. 429 with Retry-After. A token already refused this window is answered before it costs a sign-in, and each refusal is held 1 s |
| Turn starts from a machine | Each one counted and relayed | After 20 in a row each under 10 s after the last, neither counted nor relayed for 60 s, and the machine is logged once (`lib/shortTurnGuard.ts`) |
| SSO token check | Identity check, then profile fallback, each with its own 5 s timeout (10 s in all) | One 5 s deadline for both. A circuit breaker per account plane fails at once after 5 failures in a row; a rejected token is an answer, not a failure |
| SSO sign-in and refresh | 5 s timeout per call | The same, plus a breaker per account plane |
| Autonomous billing service | 10 s timeout per call | The same, plus a breaker per account plane; a 401, 403 or 404 is an answer |
| Redis commands | 5 s command timeout | 1 s, and a breaker at ioredis' single send point: after 5 failed commands in a row they are refused unsent for 5 s. Transactions, pipelines and a reconnecting connection's own setup pass untouched |
| Bus while Redis cannot take a publish | Publishes dropped; a new subscription waited out the whole outage | Single-pod mode: a publish that certainly never reached Redis goes to this pod's own subscribers. One that timed out is still dropped, because Redis may deliver it and a keystroke must not arrive twice. A subscription waits at most 1 s |

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `ROUTE_RATE_LIMIT_PER_CALLER_SECOND` | 50 | Signed-in requests per route and second for one caller: the agent the route names, else the machine (each with its person), else the person. 0 turns it off |
| `ROUTE_RATE_LIMIT_PER_PERSON_MINUTE` | 12000 | Signed-in requests per route and minute for one person, whatever agents or machines they name. 0 turns it off |
| `REDIS_COMMAND_TIMEOUT_MS` | 1000 | The longest one Redis command may take on the shared command connection |
| `SSO_PROFILE_STALE_GRACE_MS` | 0 (off) | See below |

The route limits are generous on purpose until per-route counts from the ingress logs are in. The busiest client that
works as designed is an older CLI's delivery poll: one call a second per running agent. Each agent is its own caller,
so agents polling in the same second never crowd out one another; the person's 12000 a minute is 200 agents. With the
person in every caller key, naming someone else's machine or agent spends only your own budget.

**`SSO_PROFILE_STALE_GRACE_MS` needs the owner's decision.** While the SSO cannot answer (down, slow, or its breaker
open), a token this process validated within this long past its normal 60 s trust window keeps working. It never
outlives the token's own expiry, and a token the SSO rejects is dropped at once. With it off, an SSO outage signs out
everyone within about a minute: every request whose token's 60 s window has passed gets a 503. The cost of turning it
on: during an outage, a token revoked at the SSO keeps working here for up to the grace period. 600000 (10 minutes) is
the value it was built and measured with.

## KPI, before and after

Measured with `integration/bench/resilience.ts` (README in the file) on a MacBook Pro (M2 Max) shared with other agents,
so absolute numbers drift between runs. Before and after runs were interleaved so the drift hit both. One backend
process, its own MongoDB and Redis, 8 good clients listing their machines with a tenth fresh tokens, 30 s per scenario.
The bad client loads its own Swarm in full with 128 calls in flight and ignores 429. Before is main d193981; after is
390d416 (the limits as reviewed). Latency is good clients' p95 in ms.

| Scenario | Before (3 runs) | After, defaults (3 runs) | Target |
|---|---|---|---|
| Normal | 31 / 23 / 28 | 31 / 28 / 8 | — |
| One bad client | 125 / 86 / 66 (+303% / +274% / +136%) | 32 / 28 / 26 (+3% / 0% / see below) | under +10% |
| Bad client's calls in 30 s | 17,315 / 17,986 / 20,125 | 5,281 / 5,310 / 5,346 | — |
| Redis 5 s slow | 5,269 / 5,257 / 5,287 | 30 / 29 / 28 | under 1,000 |
| SSO 5 s slow | 10,006 / 10,006 / 10,008 | 24 / 25 / 20 | under 1,000 |

- **One bad client.** Within the target in two runs (+3%, 0%). In the third, the normal p95 was an outlier at 8 ms;
  every other run on this machine measured 23–31 ms. The bad-client p95 itself, 26 ms, is in line with the other runs.
  The bad client is held to 50 calls a second (its caller ceiling), and its traffic fell by about 70%: refused calls are
  answered before sign-in and held for 1 s. An earlier series with a person-wide 6000-a-minute limit counted in 1 s
  windows (100 a second) rose 36–43% in two of three runs. The per-caller ceiling is both tighter for a loop and looser
  for a person with many agents.
- **Redis 5 s slow.** p95 under 35 ms in every run. The first commands wait for the 1 s timeout until the breaker opens:
  max 1.0–1.3 s.
- **SSO 5 s slow, grace period off (the default).** p95 under 30 ms, but about half the calls are fast 503s: every token
  whose 60 s trust window passed during the slowdown. **With the grace period on (10 minutes, one run on 18f3871):**
  p95 29 ms, and 503s fell from 48% to 9%. The remaining 9% are the fresh tokens, which cannot be validated while the
  SSO is slow.

## Design (docs/feature-design-rules.md)

Reviewed revision: pending. Reviewer (another engine): pending.

1. **Growth.** Rate counters are Redis keys `rl:<limiter>:<key>:<window>`. Each expires with its own window (1 s for a
   route's caller, 1 minute for a route's person and for the feature limits); nothing else deletes them. Process memory: per-process fallback
   counters (existing windowLimiter, a bucket per key), and remembered refusals, at most 50,000, with expired ones
   swept and the map cleared beyond that. SSO stale entries live in the existing profile cache (at most 50,000) and
   only while the grace period is on. Nothing is written to Mongo.
2. **Concurrency.** A rate count is one atomic Redis EVAL (INCR, and PEXPIRE on the window's first hit); there is no
   read-modify-write. Breakers and the short-turn guard are process-local or socket-local. A breaker lets one trial
   call through at a time when half open.
3. **Read cost.** One EVAL per signed-in request with two keys, about 0.1 ms on a loopback Redis. A remembered
   refusal costs a SHA-256 of the token and a map lookup, with no Redis or Mongo. Nothing reads a whole document.
4. **Scale.** At 10x, Redis takes one EVAL per signed-in request, still far below one Redis core. First warning sign:
   Redis command latency, which opens the breaker at 1 s and logs `[bus] Redis commands failing`. Rate counts then
   fall back to per pod, with one log line.
5. **Compatibility.** No client changes. Old CLI, Desktop and phone clients get a 429 only above limits set well
   beyond any working client. They already handle a 429 as they do from the existing limiters: the CLI's Swarm client
   reports it as RATE_LIMITED and its polls retry on the next tick. Rolling deploy: old and new pods count in
   different places during the rollout (old ones in memory), which only makes limits looser for a few minutes.
   Fast 503s from an open SSO breaker are the 503 clients already get when the SSO is unreachable.
6. **Migration and rollback.** No data migration. Rolling back drops the new keys, which expire on their own. Every
   new limit has an environment switch (0 turns it off) without a rollback.
7. **Audience.** Unchanged. The limit runs after the sign-in gate and before the route authorizes anything, so every
   key includes the signed-in person: an id in the URL alone never decides whose budget a call spends. It never
   authorizes anything. Rate keys hold internal user ids, route patterns and machine ids, never tokens: QR poll tokens
   and remembered refusals use a digest.
8. **Identity.** A request counts for the person it signed in as. Nothing runs as the machine owner's login.
9. **Failure.** Redis down or stuck: commands fail fast, limits count per pod, and the bus goes single-pod. Each
   change is logged once each way (`[bus]`, `[rate-limit]`). SSO or billing service down: one log line when its breaker
   opens; callers get 503, as for an unreachable service today. A looping machine: one log line naming it. A limited
   client: 429 with Retry-After.
10. **Platforms.** Backend only (Linux pods; macOS for development). The bench needs `redis-server` on PATH; the
    real-Redis counter test is skipped where there is none, as on CI's Linux runners.
