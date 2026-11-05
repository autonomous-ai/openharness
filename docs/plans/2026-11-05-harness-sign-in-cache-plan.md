# Harness sign-in cache per pod — plan (task #3041)

**Goal:** Stop reading the session row and the user row from Mongo on every request signed in with a Harness session.
Atlas's per-collection counters on 11-05 show `harness_sessions` at 47.2 reads/s and `users` at 52.8/s on the primary
(River, from Ken's table), about 16 ops per backend request. Signing out, revoking and removing a computer must still
take effect at once, on every pod.

**Architecture:** `authenticateHarnessAccessToken` (lib/harnessSession.ts) remembers a good sign-in for 30 seconds in a
bounded per-pod map keyed by the access token's hash. Every request still reads its access token from Redis, as today;
the cached path reads the person's **sign-in epoch** in the same Redis call (`MGET`). Every write that ends a session or
changes what a sign-in answers sets that person's epoch to a new random value after the database write. A cached sign-in
whose epoch moved is dropped and read from Mongo again.

**Tech Stack:** Node 22, Prisma 5.22 / MongoDB, ioredis, Vitest.

**Spec:** River's addition to task #3041 (11-05): a short in-memory cache per pod for the sign-in lookups, signing out and
revoking clearing it at once, two security reviews, Atlas ops before and after.

This plan is written and carried out by its Engineer, test first; there is no execution handoff.

## The rules it keeps

- **Revocation at once, on every pod.** The epoch is in Redis, not in the pod: a sign-out on pod A is seen by pod B's
  next request, in the Redis read that request already makes.
- **No lost sign-out in a race.** The miss path reads the epoch *before* it reads the session and the user, and writers
  set it *after* their write. A sign-out that lands between the two reads leaves the remembered epoch stale, so the next
  request reads Mongo again.
- **An epoch never repeats.** It is a random value, not a counter: a key that expired and was written again cannot equal
  a value a pod remembers. It lives an hour, far past the 30-second cache; an expired epoch only causes a miss.
- **A failed epoch write fails the sign-out.** `signInsChanged` throws, so a revoke route answers an error rather than
  "signed out" while other pods could still serve the session for up to 30 seconds. Retrying is safe: every revoke is
  idempotent.
- **Only success is cached**, and callers get a copy.
- **Redis down is still an outage** (`AUTH_SERVICE_UNAVAILABLE`), cached or not.

Writes that set the epoch: sign-out (`revokeHarnessSession`), revoking a device (`revokeHarnessSessionById`), a computer
turning itself into a team machine (`convertComputer`), SSO refusing a renewal (`ssoSession.ts renew`), removing a
computer that ends its team session (`MachineService`), and user rows changing what a sign-in answers: `UserService`
update (role, plane), remove, a provisional row merged away, and an SSO sign-in that rewrites the email, role or subject.

Also not changed: the one-time email migration at start (lib/db/migrate.ts) only lower-cases an email; a pod may
answer the old casing for up to 30 seconds.

Not changed: SSO-token requests (no Harness session) keep their path; they are about 5 of the 53 user reads a second.

## Design

- Growth: at most 20,000 entries per pod, oldest dropped first, each gone after 30 s; epoch keys expire after an hour.
- Concurrency: none in the pod (one thread); across pods the epoch orders a sign-out against a cached read (above).
- Read cost: a hit is one Redis `MGET` (today: one `GET`) and no Mongo read; a miss adds one Redis `GET`.
- Scale: at 10x sign-ins the map's bound holds memory under ~10 MB; the first warning is the hit rate falling, seen as
  `harness_sessions` reads per second on Atlas rising back.
- Compatibility: no client, API or schema change; tokens are unchanged.
- Migration + rollback: none; reverting removes the cache, and epoch keys expire by themselves.
- Audience: the server checks every request as before; the cache only remembers its own answer.
- Identity: the cached identity is the session's user, never the machine owner's login.
- Failure: Redis down answers 503 as today; an epoch that cannot be written fails the sign-out loudly.
- Platforms: backend only.

## Global Constraints

No behaviour change for a caller except fewer database reads. No new settings or switches. Two independent security
reviews before merge (sign-in and tokens).

## Review Focus

- Every write that ends a Harness session or changes a user's sign-in answer sets the epoch, after the write.
- The miss path's order: access record, epoch, then session and user.

## Tasks

### 1. The cache and the epoch (`backend/src/lib/harnessAuthCache.ts`)

- [x] Failing tests: 30 s life, bound, fresh epochs that never repeat with an hour's life, a failed write throws.
- [x] Code that passes them.

### 2. Authentication uses it (`backend/src/lib/harnessSession.ts`)

- [x] Failing tests: a second request reads no Mongo; a token gone from Redis stops; sign-out and revoke by id end a
      remembered sign-in at once, with nothing cleared in the pod; a sign-out between the reads is not missed; read again
      after 30 s; Redis down is an outage; no refusal remembered; callers get a copy.
- [x] Code: the cached path, the miss path's order, epochs set by sign-out, revoke and conversion.

### 3. Every other writer sets the epoch

- [x] Failing tests: SSO refusing a renewal, removing a computer, and `UserService` update, remove, merge and an
      SSO rewrite each set the person's epoch.
- [x] Code.

### 4. Before and after

- [ ] Atlas ops/s and `harness_sessions` / `users` reads per second before and after the release, in Ken's thread.
