# A Hermes in the default home closes again (#4361): Implementation Plan

> **For agentic workers:** REQUIRED: execute with **devcrew phase 3**. One task, test-first: a red commit, then the
> code commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The other engines' worker answers `engine_stream_store` for a Hermes with a `home` only when it found that
home by looking the session up and the home is not the default one, so a Hermes in the default home no longer gains
`hermesHome: <default>` on an attach during a stop, and its Close is no longer refused with `STOP_UNCONFIRMED`.

**Architecture:** One handler changes: the `STREAM_STORE` entry of `otherStreamRequests`
(`cli/src/engines/others/streamRequests.ts`), which runs in the engine-others process, not the core. The `store` it
answers is unchanged in every case. The core's `storeOf` (`cli/src/core/main.ts`) keeps writing whatever `home` the
worker reports, which is now only a profile home the row did not know. No core file changes.

**Tech Stack:** TypeScript, Vitest, the `sqlite3` CLI for the spec's fixtures (as `cli/src/engines/hermes/home.spec.ts`).
No new dependency.

**Spec:** [docs/plans/2026-11-16-4361-hermes-stop-unconfirmed-design.md](2026-11-16-4361-hermes-stop-unconfirmed-design.md).
Read it with this plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority; its rejected options and
its Out of scope are not reopened here.

## Global Constraints

- The rule, from the spec: answer `home` only for a home **found** by `findHermesHomeForSession`, and only when
  `!sameHermesHome(found, env.HERMES_HOME)`. No `home` when the row named one, and none when the answer fell back to the
  default.
- The `store` answer is unchanged in every case: the row's home, else the found one, else `env.HERMES_HOME`, through
  `hermesDbPath`.
- Not touched: `cli/src/core/` (no core change, `main.ts` stays wiring), `cli/src/lib/stopAgentService.ts`,
  `cli/src/lib/sessionRepair.ts`, the OpenClaw branch of the same handler, `cli/src/architecture.coreFiles.txt`.
- The profile-home race during a stop is out of scope (spec, Follow-ups): no code for it here.
- The comment at the change says why, in plain sentences, and names #4361 and #4342.
- No fixed sleeps. Each case gives `env.HERMES_HOME` a `mkdtemp` folder of its own and restores it after, never the
  developer's home: on Windows `env.HERMES_HOME` is `%LOCALAPPDATA%\hermes`, which `cli/vitest.setup.ts` does not move.
- A commit adds its files by name. The two documents under `docs/plans/` are untracked and are no task's.
- Platforms: every platform runs the worker; the failure was seen on Linux. Tests: macOS (unit, typecheck) and Linux
  (the end-to-end file). The pull request names both.

## Found while reading the code

- `findHermesHomeForSession` (`cli/src/engines/hermes/home.ts`) returns a home from `listHermesHomes()`, whose first
  entry is `env.HERMES_HOME` verbatim and whose others are `join(env.HERMES_HOME, 'profiles', <name>)` for each profile
  with a `state.db`. The listing is cached (`ttlMs`); `forgetHermesHomes()` drops it.
- `sameHermesHome` lives in the same module the handler already imports dynamically, so it comes from the same
  `await import('../hermes/home.js')`.
- `streams.spec.ts` has no `STREAM_STORE` case today. Its `setup()` returns `ask`, which calls as the core does
  (`{ owner: true, local: true }`, `version: STREAM_VERSION`). A small answer comes back inline as
  `{ version: STREAM_VERSION, answer: {...} }` (`createReplyParts().send`).
- Today three of the four cases fail: the default home (answers `home: <default>`), the row's own home (answers it
  back) and the unknown session (answers `home: <default>`). The profile case passes before and after.
- The found home always equals `env.HERMES_HOME` or a path built from it, so a differently spelled default cannot
  reach this handler through the lookup today. `sameHermesHome` is the spec's choice and is kept; no test can reach a
  second spelling without mocking `env`, so none is written.

## File map

| File | Change |
|---|---|
| `cli/src/engines/others/streams.spec.ts` | A `describe` for the Hermes store answer, four cases |
| `cli/src/engines/others/streamRequests.ts` | The Hermes branch of `[STREAM_STORE]` answers `home` only for a found, non-default home |

## Review Focus

1. A Hermes in a profile home its row did not know still gets that home answered (and so recorded by the core): the
   profile case below, and the end-to-end case "follows a Hermes that only has a HOME of its own, and starts it again
   in that home".
2. The `store` is the same as before in all four cases: every case asserts the whole answer with `toEqual`, so a
   changed or missing `store` fails.
3. A session whose id no store holds yet (a Hermes before its first prompt) answers the default store and no `home`:
   the unknown-session case.
4. A row that already names a home is answered that home's store and no `home`, even when the lookup would find
   another: the own-home case puts the session in the default store too.
5. A resumed Hermes in the default home is stopped soon after its attach and the Close succeeds: the end-to-end case
   "follows a resumed Hermes through /new without failing it" (Verification 2).

---

### Task 1: The worker answers a Hermes home only when it found one that is not the default

**Effort:** high

**Depends on:** none

**Files:**
- Modify: `cli/src/engines/others/streamRequests.ts` (the Hermes branch of `[STREAM_STORE]`, about lines 105-108)
- Test: `cli/src/engines/others/streams.spec.ts`

**Red test:** `the Hermes store answer > answers no home for a session in the default home` (and the own-home and
unknown-session cases) in `cli/src/engines/others/streams.spec.ts`.

**Interfaces:**
- Consumes: `otherStreamRequests` (`./streamRequests.js`), the spec's `setup()` and its `ask`; `STREAM_STORE` from
  `../worker/otherStreamProtocol.js`; `env` from `../../config/env.js`; `forgetHermesHomes`, `hermesDbPath` from
  `../hermes/home.js`.
- Produces: nothing new. The answer stays `{ store: string, home?: string }`.

- [ ] **Step 1: Write the failing test**

In `cli/src/engines/others/streams.spec.ts`, add a top-level `describe` gated on the `sqlite3` CLI as `home.spec.ts`
gates it (`const hasSqlite = ...; describe.skipIf(!hasSqlite)('the Hermes store answer', ...)`). A local
`makeHome(root, sessions)` writes `hermesDbPath(root)` with the same `sqlite3` command `home.spec.ts` uses
(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, cwd TEXT);` plus one insert per id). Before
each case: `env.HERMES_HOME` set to a `mkdtemp` folder and `forgetHermesHomes()`; after it, `env.HERMES_HOME` restored,
`forgetHermesHomes()` again and that folder removed.

A local `ask(sessionId, extra = {})` returns
`setup().ask(STREAM_STORE, { session: { sessionId, engine: 'hermes', ...extra } })`. Ids: `DEFAULT = '20260727_162325_e25264'`, `PROFILE = '20260921_152236_a1b2c3'`, `UNKNOWN = '20261116_090000_abcdef'`.
`const profile = join(env.HERMES_HOME, 'profiles', 'work')`.

```ts
it('answers no home for a session in the default home', async () => {
  makeHome(env.HERMES_HOME, [DEFAULT])
  expect(await ask(DEFAULT)).toEqual({ version: STREAM_VERSION, answer: { store: hermesDbPath(env.HERMES_HOME) } })
})
it('names the profile home a session was found in', async () => {
  makeHome(env.HERMES_HOME, [DEFAULT]); makeHome(profile, [PROFILE])
  expect(await ask(PROFILE)).toEqual({ version: STREAM_VERSION, answer: { store: hermesDbPath(profile), home: profile } })
})
it('answers the store of a home the row already names, and no home', async () => {
  makeHome(env.HERMES_HOME, [PROFILE]); makeHome(profile, [PROFILE])
  expect(await ask(PROFILE, { hermesHome: profile })).toEqual({ version: STREAM_VERSION, answer: { store: hermesDbPath(profile) } })
})
it('answers the default store and no home for a session no store holds', async () => {
  makeHome(env.HERMES_HOME, [DEFAULT])
  expect(await ask(UNKNOWN)).toEqual({ version: STREAM_VERSION, answer: { store: hermesDbPath(env.HERMES_HOME) } })
})
```

A one-line comment on the `describe` says why: a Hermes in the default home gained `hermesHome: <default>` on an
attach during its stop, and the stop refused the Close (#4361).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd cli && npx vitest run src/engines/others/streams.spec.ts -t "the Hermes store answer"`
Expected: 3 failed, 1 passed. The default-home and unknown-session cases fail with an extra
`home: "<tmp>/.hermes"` in the received answer; the own-home case with an extra `home: "<tmp>/.hermes/profiles/work"`.
The profile case passes. If the four are skipped, `sqlite3` is missing: install it, do not go on.

- [ ] **Step 3: Commit the red test**

```bash
git add cli/src/engines/others/streams.spec.ts
git commit -m "Pin the Hermes store answer: a home only when found and not the default (#4361)"
```

- [ ] **Step 4: Change the Hermes branch of `[STREAM_STORE]` in `cli/src/engines/others/streamRequests.ts`**

Take `findHermesHomeForSession` and `sameHermesHome` from the one `await import('../hermes/home.js')`. When the row
names a home (`session.hermesHome` truthy), answer `{ store: hermesDbPath(session.hermesHome) }`. Otherwise look the
session up; answer `{ store: hermesDbPath(found ?? env.HERMES_HOME) }`, plus `home: found` only when `found` is
non-null and `!sameHermesHome(found, env.HERMES_HOME)`. A comment says why: `hermesHome: null` means the default home
on every Hermes path; #4342 moved the lookup here and answered the default too, so the core filled it during a stop
and the stop's identity check refused the Close (#4361).

- [ ] **Step 5: Run the spec and typecheck to verify they pass**

Run: `cd cli && npx vitest run src/engines/others/streams.spec.ts src/engines/hermes/home.spec.ts`
Expected: all pass, the four new cases among them.

Run: `cd cli && npm run typecheck`
Expected: exits 0, no output from `tsc`.

- [ ] **Step 6: Commit the fix**

```bash
git add cli/src/engines/others/streamRequests.ts
git commit -m "The other engines' worker answers a Hermes home only when it found one that is not the default (#4361)"
```

Each commit message ends with the attribution line the session gives.

---

## Verification

1. **Unit and typecheck, macOS (this Mac).** On the final head:
   `cd cli && npx vitest run src/engines/others/streams.spec.ts src/engines/hermes/home.spec.ts && npm run typecheck`.
   Expected: all pass, typecheck exits 0. `npm run test:core` is not needed: no file under `cli/src/core` or
   `cli/src/services` changes. PR CI runs the full unit suite.

2. **The end-to-end red check, Linux, in a disposable container.** Isolation is the container itself and the
   end-to-end harness's own throwaway homes, data folders, private tmux servers and fake engines: no real account, no
   backend, no port of the developer's daemon (18473). Image `node:24.22.2-bookworm` plus
   `tmux zsh tcsh dash lsof procps util-linux git`, run with `--init`, env `LANG=C.UTF-8 SHELL=/bin/zsh E2E_BUNDLE=1`,
   the checkout mounted or copied in, `npm ci` in `cli/`, then
   `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/hermesTerminalRecord.e2e.ts`, three times.
   Expected: "follows a resumed Hermes through /new without failing it" and every other case outside
   "in a sandbox" (seven top-level cases in the file at this base) pass 3 of 3, with no `STOP_UNCONFIRMED` from `agent_delete`. On `main` (`71a2a71e5c`) the target case
   fails 5 of 5. The three "in a sandbox" cases fail there on `main` and with the change alike ("timed out ... waiting
   for the fake Hermes": the container cannot give the fake its own sandbox), so they are not evidence either way;
   item 3 runs them.

3. **The whole file on GitHub, Linux.** Run `.github/workflows/cli-e2e.yml` by hand from the branch (Actions, CLI end
   to end, Run workflow, branch `fix/4361-hermes-stop-unconfirmed`, `agent_browser_podman` off). It runs all eight
   shards; the check is the shard whose inventory holds `e2e/hermesTerminalRecord.e2e.ts`, with its seven top-level
   cases and the three "in a sandbox" cases passing ("ran the sandbox cases" skips: the workflow does not set
   `HARNESS_E2E_REQUIRE_SANDBOX`). This takes a runner turn the orchestrator schedules. No temporary
   workflow: the repo's own workflow runs the check.

No check needs a real person's login, a device or production.
