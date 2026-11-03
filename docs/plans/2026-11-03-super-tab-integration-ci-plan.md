# Super Tab integration suite in PR CI — plan

Way of working: the project's Engineer flow (plan first, then each task test first; one review on the pull request).

**Goal:** PR CI runs the backend's Super Tab integration suite (`npm run test:super-tabs`,
`backend/vitest.super-tabs.config.ts`, `backend/integration/`) on every pull request that changes backend code, in at most
four parallel Linux shards, in under 15 minutes, gated by `ci/required`. Engineers stop running the 60–90 minute suite
locally behind a per-Mac lock.

**Architecture:** One new matrix job, `backend-integration` (shards 1–4), in `.github/workflows/ci.yml`. The planner
(`scripts/ci-plan.py`) adds it to the `backend` suite's jobs, so it runs exactly when `backend-desk` runs (a change under
`backend/` or one of the backend's declared cross-reads) and `ci/required` requires it. Files are split across shards
by recorded per-file durations (longest first onto the least-loaded shard), the same method the CLI's
`vitest.ci.config.ts` uses, in a backend copy (`backend/integration/ciSequencer.ts`, `backend/integration/ci-durations.json`,
`backend/vitest.super-tabs.ci.config.ts`): the backend may not import CLI code.

**Tech Stack:** GitHub Actions, Python planner + `unittest`, Vitest 4 custom sequencer, `mongodb-memory-server-core`.

**Spec:** task #2459 (Dee, 2026-11-03).

## Global Constraints

- At most 4 shards (account limit: 20 concurrent jobs). Non-backend PRs run nothing new.
- MongoDB: every integration file already starts its own replica set through `mongodb-memory-server-core` (7.0.24),
  so each shard has its own databases. A MongoDB service container would be a second, unused server; instead the job
  caches the downloaded `mongod` binary (`$TMPDIR/harness-super-tab-mongodb-binaries`). Redis: the suite's setup
  (`src/lib/noRedis.test-support.ts`) keeps every Redis client unconnected and `cacheOn.test-support.ts` uses in-memory
  stamps, so no file reads Redis; no Redis service is added (it would never be used). Recorded deviation from the
  brief's "MongoDB and Redis as services", with this reason.
- No database change. No change to the local `test:super-tabs` behavior.
- Timing-dependent tests the job exposes get a deterministic fix, or a recorded reason in the test.

## Review Focus

- The planner change: `backend-integration` is required whenever `backend` is planned, never on other PRs, and update
  merges no longer reuse a backend result when main changed `backend/integration/` (it is now read by PR CI).
- Sharding: every file in the config's `include` runs exactly once across the four shards.
- Wall time under 15 minutes per shard, measured in CI.

## Tasks

### 1. Planner: the backend suite includes the integration job

Files: `scripts/ci-plan.py`, `scripts/tests/test_ci_plan.py`.
Interfaces: `JOBS["backend"] == {"backend-desk", "backend-integration"}`; `NOT_READ` has no backend entry.

- [ ] Failing test: a backend-only PR requires `backend-integration`; a docs-only and a desktop-only PR do not; a main
      commit under `backend/integration/` reruns (no longer reuses) the backend suite.
- [ ] Run `python3 -m unittest scripts/tests/test_ci_plan.py` and watch it fail.
- [ ] Change `JOBS` and `NOT_READ`; declare any cross-read the scan finds in `backend/integration/`.
- [ ] Tests pass.

### 2. Duration-based shards

Files: `backend/integration/ciSequencer.ts`, `backend/integration/ciSequencer.test.ts`,
`backend/integration/ci-durations.json`, `backend/vitest.super-tabs.ci.config.ts`.

- [ ] Failing test: `durationShards` puts every file in exactly one of N shards, longest first onto the least-loaded
      shard; unknown files get the default cost; invalid hints are refused.
- [ ] Implement; the CI config merges `vitest.super-tabs.config.ts` with the sequencer.

### 3. The CI job

Files: `.github/workflows/ci.yml`.

- [ ] `backend-integration` matrix (shard 1–4), `needs: plan`, `if` ready and backend, Node 22.23.2, `npm ci`, cached
      `mongod`, `npx vitest run --config vitest.super-tabs.ci.config.ts --shard=N/4` with a JSON report uploaded per
      shard; `timeout-minutes: 20`; listed in `ci/required`'s `needs`.
- [ ] actionlint passes (the plan job runs it).

### 4. Measure and stabilize

- [ ] First ready run: per-shard wall time; the sum of per-file durations is the one-job time (the "before").
- [ ] Record the durations into `ci-durations.json`; rebalance if a shard is over 15 minutes.
- [ ] Fix or record each timing-dependent test that fails on CI runners.
- [ ] Red run: a throwaway commit breaking a store command turns `ci/required` red through `backend-integration`; then
      drop it.

### 5. Docs

Files: `docs/validation-and-release.md`.

- [ ] PR CI table: `backend/` runs `backend-desk` and `backend-integration` (four shards); how to reproduce a shard
      locally; the local full-suite rule is now covered by CI.

<!-- throwaway for #2804: a docs-only change -->
