# CLI end to end: test builds carry their notify.mjs: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3**. Task 1 is one commit (its failing tests are
> already on main, see "Red and green"); Task 2 commits its failing tests, then the code. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** The six nightly CLI end-to-end tests that fail because their daemon has no `notify.mjs` pass again, and a
test that starts a daemon from a `cli.js` with no `notify.mjs` beside it fails at once, with a message naming the cause.

**Architecture:** Test code only. Five end-to-end files lay their build out as a build does: four through the existing
`buildWithLean`, one by copying `notify.mjs` beside the `cli.js` it installs. `IsolatedDaemon.start` gets one more check
before it spawns, next to `assertHooksContained`: `assertHookScriptBeside`, exported so the unit suite can test it.

**Tech Stack:** TypeScript, vitest 4 (`vitest.e2e.config.ts` for `e2e/`, the default config for `src/`), Node 24, tmux.

**Spec:** [docs/plans/2026-11-13-cli-e2e-nightly-red-design.md](2026-11-13-cli-e2e-nightly-red-design.md). Read it with
this plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority.

## Global Constraints

- No product change. Under `cli/src/` only the spec file `cli/src/testing/releaseFixtures.spec.ts` changes;
  `cli/src/engines/kit/notifyHooks.ts` stays as it is.
- No assertion in the five end-to-end files is skipped, loosened or removed. If one of them still fails once its
  layout is fixed, stop and tell the main session the error: do not adjust the test.
- `IsolatedDaemon` never copies `notify.mjs` on a test's behalf (spec, Anti-goals). The guard only refuses.
- The guard's message, exactly:
  `` `${scriptPath} has no notify.mjs beside it: its daemon refuses every hook install (lay it out with buildWithLean)` ``.
- The guard runs in `start`, at every start, before the spawn. Never in `create`: `masterIpcExit.e2e.ts` names its
  script after `create`.
- `withLean` stays exported from `cli/e2e/harness/release.ts`: `buildWithLean`, `withFault` and the unit spec use it.
- End-to-end files run one at a time (`E2E_WORKERS` unset), and never beside another end-to-end run on the same Mac:
  `eagerHooks.e2e.ts` gives the hook files 10 seconds, which a loaded machine misses.
- Commands run from `cli/`, after `npm ci` (a fresh worktree has no `cli/node_modules`), on Node 24 (CI's is 24.22.2).
- Platforms: none of the product's. The harness runs on macOS (locally) and Linux (the CLI end to end workflow); the
  unit spec runs in PR CI on Linux.

## Found while reading the code

Checked at `4961894fbc` on this Mac (Node 23.11.0, which vitest 4.1.10 only warns about; tmux 3.8), 2026-11-13.

- **Where the daemon looks.** `hookScriptCandidates` (`cli/src/engines/kit/notifyHooks.ts:29`): beside the running
  file, beside `process.argv[1]` (the `cli.js`), then the checkout's `hook/notify.mjs`. A lean core runs from
  `<data>/lean/<sha>/`, so for a `cli.js` alone the last candidate is `<test root>/hook/notify.mjs`: the path in the
  error below.
- **How to run, and no bundle to build first.** `npm run test:e2e -- e2e/<file> [e2e/<file> …]`. The four lean-bundle
  files build their own bundle in `beforeAll` (`build-bundle.mjs` with `BUNDLE_OUT_DIR=<scratch>/build`, which writes
  `cli.js` and `notify.mjs`: `build-bundle.mjs:168`). `nodeReferences.e2e.ts` takes the run's bundle when `E2E_BUNDLE=1`
  (as CI sets it, `e2e/harness/bundle.ts`), else builds its own. `E2E_BUNDLE` is not needed locally.
- **Baseline, each file run alone:**

  | File | Result at base | Time |
  |---|---|---|
  | `e2e/eagerIdentity.e2e.ts` | 2 failed (2): `NATIVE_LAUNCH_HELD`, "Harness's hook script is missing (…/hook/notify.mjs)" | 20 s |
  | `e2e/hermesAdmission.e2e.ts` | 2 failed (2): the same | 21 s |
  | `e2e/eagerHooks.e2e.ts` | 2 failed, 6 passed (8): "timed out after 10000ms waiting for all selected native hooks to finish after readiness" (`:274`) | 60 s |
  | `e2e/eagerRepair.e2e.ts` | 2 passed (2) | 35 s |
  | `e2e/nodeReferences.e2e.ts` | 2 passed (2), not skipped | 23 s |
  | `src/testing/releaseFixtures.spec.ts` (unit) | 4 passed (4) | 1 s |

- **`masterIpcExit.e2e.ts` is not run locally.** It passed at base (1 test, 21 s), and that run appears to have left
  two fake `codex app-server` processes and a grid runtime download in its removed root on this Mac. Not this
  change's; reported with this plan. The workflow run covers the file (Verification 3).
- **Nothing checks `cli/e2e` for unused imports.** `npm run typecheck` covers `src/**` only and there is no linter. In
  the four lean-bundle files `mkdirSync`, `writeFileSync`, `readFileSync` and `dirname` stay in use after the change
  (`dirname` in each `beforeAll`); only the `withLean` import goes.
- **Where harness helpers are tested.** `assertHooksContained` is tested in the end-to-end suite
  (`eagerHooks.e2e.ts:24`, `enginehomes.e2e.ts:71`); `release.ts` is tested from the unit suite, through a string-cast
  import, since `tsc`'s root is `src` (`src/testing/releaseFixtures.spec.ts:4`). `e2e/harness/daemon.ts` imports
  cleanly there too (probed). PR CI's `cli-tests` job has no tmux, so a unit test cannot create an `IsolatedDaemon`:
  the unit test covers the guard as a function, and one end-to-end test covers its place in `start`.
- **Every `IsolatedDaemon.create` caller with a `scriptPath`.** No caller breaks but the five Task 1 fixes.

  | Caller | Its `notify.mjs` |
  |---|---|
  | `eagerIdentity:36`, `hermesAdmission:35`, `eagerHooks:228`, `eagerRepair:34`, `nodeReferences:64` | missing: Task 1 |
  | `eagerHooks:37, 71, 118, 168`, `compat:342`, `lean:61, 214` | the folder `build-bundle.mjs` wrote |
  | `eagerOpenCode:32`, `lean:169, 188, 247, 283` | `buildWithLean` |
  | `masterIpcExit:25` | written at `:46`, after `create` and before `start` at `:47` |
  | `update:100`, `updateHostile:200`, `reexec:142, 306`, `updateOnItsOwn:164, 213` | written beside `cli.js` (`:97`, `:196`, `:139`, `:303`, `:98`); the updater swaps both files by rename, so later starts (`updateHostile:462`, `reexec:235, 357`) have it |
  | `compat:341`, `migration:133`, `releaseRehearsal:178`, `messagesSkew:82` (opt-in) | copied from the release folder (`:337`, `:130`, `:171`, `:71`) |
  | `deviceCompat:281` (`:77`), `:292` (through `fleet.ts:125`, `:90`), `recapsCompat:137` (`:66`) (opt-in) | `COMPAT_FROM` itself: the guard asks of that folder what `compat.e2e.ts:337` already does. The spec does not list these two |
  | `deviceCompat:282, 293`, `recapsCompat:138` | the run's bundle (`E2E_BUNDLE_PATH`) |
  | `opencodeLaunchCost:19` (opt-in) | `OPENCODE_COST_ROOT/{baseline,candidate}`: built folders from outside |

  `fleet.ts` passes a `scriptPath` only for `deviceCompat.e2e.ts:179`. `cli.e2e.ts:301` is a launchd definition, not a
  daemon option.

## Red and green

- **Task 1 has no red commit.** Its six failing tests are on main and the task does not change what they assert, so
  there is nothing to commit before the fix. One commit; the pull request carries the output at base (red) and at the
  commit (green), each with the commit it ran on.
- **Task 2 commits its two failing tests, then the guard.** The spec shows the guard red by running one of the three
  files with the guard in and the old layout. This plan departs from that, as its brief asked: two fast tests that stay
  in the suites, one in the unit suite PR CI runs, one in the end-to-end suite for the guard's place in `start`.
- **Why the guard is second.** With the guard in and the old layouts, `eagerRepair.e2e.ts` and `nodeReferences.e2e.ts`
  turn red too, so Task 2 waits for Task 1. Its red does not need the old layouts: its tests bring a `cli.js` alone of
  their own. Task 1's red is then the nightly's own errors, reproduced, not the guard's message.

## Review Focus

What the spec implies and its six tests do not exercise, most likely first, with the test that pins each.

- The guard's call leaves `start`, or moves after the spawn, while the function stays: Task 2's end-to-end test
  (`start()` rejects and `d.pid` is null).
- The guard sits in `create`, where a script named later (`masterIpcExit.e2e.ts:25`) or a folder laid out again
  between starts is never checked: the same test, which fails when `create` throws instead of `start`.
- A daemon with no `scriptPath` (the sources, or the run's bundle) must not be checked: every end-to-end file that
  starts one, in the workflow run (Verification 3).
- A folder from outside holding a `cli.js` alone (`COMPAT_FROM`, `OPENCODE_COST_ROOT`) is now refused where it started
  a daemon without hooks. Intended. No test: these need a published build. By eye: the message names the file.
- `buildWithLean` given a bundle whose folder has no `notify.mjs` throws `ENOENT` naming that path, before any daemon.
  Unchanged behavior; no test.

## Files and order

| File | What changes | Task |
|---|---|---|
| `cli/e2e/eagerIdentity.e2e.ts`, `cli/e2e/hermesAdmission.e2e.ts`, `cli/e2e/eagerRepair.e2e.ts` | the build folder comes from `buildWithLean` | 1 |
| `cli/e2e/eagerHooks.e2e.ts` | the same at `:226`; one new test after `:34` | 1, 2 |
| `cli/e2e/nodeReferences.e2e.ts` | copies `notify.mjs` beside the `cli.js` it installs | 1 |
| `cli/e2e/harness/daemon.ts` | `assertHookScriptBeside`, its call in `start`, the `scriptPath` comment | 2 |
| `cli/src/testing/releaseFixtures.spec.ts` | one new test | 2 |

Task 2 depends on Task 1 and shares `eagerHooks.e2e.ts` with it. Longest chain: 2. Task 1 is not split by file: its
parts would run their end-to-end files at the same time on one Mac, which the 10-second hook wait does not survive.

---

### Task 1: Five tests lay out a build

**Depends on:** nothing. **Effort:** high (five files, and reading end-to-end results before and after).

**Files:**
- Modify: `cli/e2e/eagerIdentity.e2e.ts:10, 33-35`
- Modify: `cli/e2e/hermesAdmission.e2e.ts:10, 32-34`
- Modify: `cli/e2e/eagerHooks.e2e.ts:10, 226-227`
- Modify: `cli/e2e/eagerRepair.e2e.ts:10, 32-33`
- Modify: `cli/e2e/nodeReferences.e2e.ts:14, 54`
- Test (unchanged, must fail before the change): the six tests below

**Must fail before the change:**
- `eagerIdentity.e2e.ts`: `binds, follows Copilot resume and locates a Cursor transcript with missing optional modules`,
  and `… with stalled optional modules`
- `hermesAdmission.e2e.ts`: `keeps Hermes admission pending and core ready with missing optional code, then recovers
  the complete store pool`, and `… with stalled optional code, …`
- `eagerHooks.e2e.ts`: `missing shared hooks: ready, native files installed, OpenCode launch and claude Stop/resume
  work`, and `stalled shared hooks: … and codex Stop/resume work`

**Interfaces:**
- Consumes: `buildWithLean(dir: string, bundle: string, files: Record<string, string>): string` from
  `cli/e2e/harness/release.ts`. It makes `dir`, writes `dir/cli.js` (mode 755) from the bundle at path `bundle` with
  `files` as its lean bundle, copies the `notify.mjs` beside `bundle`, and returns the path of `dir/cli.js`.
- Produces: every `scriptPath` in `cli/e2e` has a `notify.mjs` beside it (Task 2 relies on this).

- [ ] **Step 1: Run the five files at base and keep the red output**

Before any change under `cli/` (`git status --short cli/` and `git log --oneline origin/main..HEAD -- cli/` print
nothing):

```bash
git rev-parse HEAD
npm run test:e2e -- e2e/eagerIdentity.e2e.ts e2e/hermesAdmission.e2e.ts e2e/eagerHooks.e2e.ts \
  e2e/eagerRepair.e2e.ts e2e/nodeReferences.e2e.ts
```

Expected: FAIL in about 3 minutes, `Test Files  3 failed | 2 passed (5)`, `Tests  6 failed | 10 passed (16)`. The six
are the tests named above, with the errors in the baseline table. Any other failure: stop and tell the main session.

- [ ] **Step 2: The four lean-bundle files use `buildWithLean`**

In each, the import at line 10 becomes `import { buildWithLean } from './harness/release.js'`, and the lines that make
the folder and write the `cli.js` become one line. No other import changes.

| File | Lines | Become |
|---|---|---|
| `eagerIdentity.e2e.ts` | 33-35 (`const script = join(…)`, `mkdirSync(…)`, `writeFileSync(script, withLean(…), …)`) | `const script = buildWithLean(join(scratch, mode), bundle, files)` |
| `hermesAdmission.e2e.ts` | 32-34 (the same with `scriptPath`) | `const scriptPath = buildWithLean(join(scratch, mode), bundle, files)`; `text` at `:25` stays, `:26` reads it |
| `eagerRepair.e2e.ts` | 32-33 | `const script = buildWithLean(join(scratch, mode), bundle, files)` |
| `eagerHooks.e2e.ts` | 226-227 | `const script = buildWithLean(join(scratch, mode), bundle, files)` |

- [ ] **Step 3: `nodeReferences.e2e.ts` installs `notify.mjs` too**

Line 14 imports `dirname` as well (`import { dirname, join } from 'node:path'`). After line 54
(`copyFileSync(built, join(cli(), 'cli.js'))`) add
`copyFileSync(join(dirname(built), 'notify.mjs'), join(cli(), 'notify.mjs'))`. The file's header already says "an
installed copy": no new comment.

- [ ] **Step 4: Run the five files again**

The command of Step 1. Expected: PASS, `Test Files  5 passed (5)`, `Tests  16 passed (16)`, nothing skipped; several
minutes, since the six now run to their end. Then `grep -nw withLean e2e/*.e2e.ts` prints nothing.

If one of the six still fails, it is past the missing `notify.mjs` and on another cause: stop and tell the main session
the test and its error (Global Constraints).

- [ ] **Step 5: Commit**

```bash
git add cli/e2e/eagerIdentity.e2e.ts cli/e2e/hermesAdmission.e2e.ts cli/e2e/eagerHooks.e2e.ts \
  cli/e2e/eagerRepair.e2e.ts cli/e2e/nodeReferences.e2e.ts
git commit -m "e2e: five tests lay their build out with its notify.mjs beside the cli.js"
```

Report the commit, and the red (Step 1) and green (Step 4) summaries with the commit each ran on.

---

### Task 2: A `cli.js` with no `notify.mjs` beside it is refused at start

**Depends on:** Task 1 (the guard refuses the layouts Task 1 fixes, and both change `eagerHooks.e2e.ts`).
**Effort:** high.

**Files:**
- Modify: `cli/e2e/harness/daemon.ts:88-89, 188-189, 370-371`
- Test: `cli/src/testing/releaseFixtures.spec.ts` (new test, unit suite)
- Test: `cli/e2e/eagerHooks.e2e.ts` (new test after line 34)

**Must fail before the change:** the two tests of Steps 1 and 2.

**Interfaces:**
- Consumes: Task 1's layouts; `buildWithLean` as in Task 1.
- Produces: `export function assertHookScriptBeside(scriptPath: string): void` in `cli/e2e/harness/daemon.ts`.

- [ ] **Step 1: Write the failing unit test** in `cli/src/testing/releaseFixtures.spec.ts`

Add `buildWithLean: (dir: string, bundle: string, files: Record<string, string>) => string` to the names and the type
of the `release.js` import, import `assertHookScriptBeside` the same way, and add the `node:fs`, `node:os` and
`node:path` imports the test needs:

```ts
const { assertHookScriptBeside } = await import('../../e2e/harness/daemon.js' as string) as {
  assertHookScriptBeside: (scriptPath: string) => void
}

describe('a build laid out for a daemon under test', () => {
  it('has its notify.mjs beside the cli.js from buildWithLean, and a cli.js alone is refused by name', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'release-fixtures-'))
    try {
      const build = join(scratch, 'build')
      mkdirSync(build)
      writeFileSync(join(build, 'cli.js'), '#!/usr/bin/env node\n')
      writeFileSync(join(build, 'notify.mjs'), '// the hook script\n')
      const laidOut = buildWithLean(join(scratch, 'laid-out'), join(build, 'cli.js'), { [LEAN_ENTRY]: '// replacement\n' })
      expect(laidOut).toBe(join(scratch, 'laid-out', 'cli.js'))
      expect(readFileSync(join(scratch, 'laid-out', 'notify.mjs'), 'utf8')).toBe('// the hook script\n')
      expect(() => assertHookScriptBeside(laidOut)).not.toThrow()

      const alone = join(scratch, 'alone', 'cli.js')
      mkdirSync(join(scratch, 'alone'))
      writeFileSync(alone, '#!/usr/bin/env node\n')
      expect(() => assertHookScriptBeside(alone)).toThrow(
        `${alone} has no notify.mjs beside it: its daemon refuses every hook install (lay it out with buildWithLean)`)
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  })
})
```

- [ ] **Step 2: Write the failing end-to-end test** in `cli/e2e/eagerHooks.e2e.ts`, after the test that ends at line 34

```ts
it('refuses to start from a cli.js with no notify.mjs beside it, before any process starts', async () => {
  const alone = join(scratch, 'alone', 'cli.js')
  mkdirSync(dirname(alone), { recursive: true })
  writeFileSync(alone, '')
  const d = daemon = await IsolatedDaemon.create({ scriptPath: alone })
  await expect(d.start()).rejects.toThrow(`${alone} has no notify.mjs beside it`)
  expect(d.pid).toBeNull()
})
```

- [ ] **Step 3: Run both to verify they fail**

```bash
npx vitest run src/testing/releaseFixtures.spec.ts
npm run test:e2e -- e2e/eagerHooks.e2e.ts -t 'no notify.mjs beside it'
```

Expected: the first FAILS, `Tests  1 failed | 4 passed (5)`, with `assertHookScriptBeside is not a function`. The
second FAILS, 1 failed and 8 skipped: `start()` rejects with `daemon exited during boot (0)` (Node ran the empty file)
instead of the guard's message.

- [ ] **Step 4: Commit the red tests**

```bash
git add cli/src/testing/releaseFixtures.spec.ts cli/e2e/eagerHooks.e2e.ts
git commit -m "e2e: a cli.js with no notify.mjs beside it is refused at start (red)"
```

- [ ] **Step 5: Implement in `cli/e2e/harness/daemon.ts`**

- After `assertHooksContained` (ends at line 188):
  `export function assertHookScriptBeside(scriptPath: string): void`. It returns when
  `join(dirname(scriptPath), 'notify.mjs')` exists and otherwise throws `Error` with the message in Global
  Constraints. `existsSync`, `dirname` and `join` are already imported. Its comment says why: a daemon whose `cli.js`
  has no `notify.mjs` beside it refuses every hook install (`engines/kit/notifyHooks.ts` `requireHookScript`), and the
  test then fails far from the cause (six tests of the nightly run of 2026-11-12, on `NATIVE_LAUNCH_HELD` or a hook
  timeout); it never copies the file, which would hide a layout no build produces.
- In `start`, right after `assertHooksContained(this.root, this.env)` (line 371):
  `if (this.options.scriptPath) assertHookScriptBeside(this.options.scriptPath)`. Extend the comment above it
  (line 370): a test may also name its script after `create` (`masterIpcExit.e2e.ts`).
- The `scriptPath` option's comment (line 88) says the bundle has its `notify.mjs` beside it, and names
  `assertHookScriptBeside`.

- [ ] **Step 6: Run to verify**

```bash
npx vitest run src/testing/releaseFixtures.spec.ts
npm run test:e2e -- e2e/eagerHooks.e2e.ts
npm run typecheck
```

Expected: `Tests  5 passed (5)`; then `Tests  9 passed (9)` in about 2 minutes; typecheck clean. `tsc` does not read
`cli/e2e`, so the end-to-end run is what checks those edits.

- [ ] **Step 7: Commit**

```bash
git add cli/e2e/harness/daemon.ts
git commit -m "e2e: a daemon under test refuses a cli.js with no notify.mjs beside it"
```

Report both commits and the red (Step 3) and green (Step 6) summaries.

---

## Verification

Isolation: every check uses the suite's own `IsolatedDaemon` (`cli/AGENTS.md` rules 5 and 6,
`cli/e2e/harness/daemon.ts`): a throwaway home, data folder, port and private tmux server per daemon, fake Claude Code
and Codex engines, signed out, with the backend address pointed at a closed loopback port. No backend, account, device
or state folder of the person's is touched, so `docs/development.md`'s guide for a dev daemon has nothing to add.
Nothing touches production. Needs Ken himself: none.

All checks are for the final pushed head.

| # | What to run | Where | What a person should see | On GitHub |
|---|---|---|---|---|
| 1 | `cd cli && npx vitest run src/testing/releaseFixtures.spec.ts` | this Mac | `Tests  5 passed (5)`, about 1 s | PR CI's `cli-tests` runs it by itself once the pull request is ready (a `cli/` change selects the CLI suite); start nothing by hand |
| 2 | `cd cli && npm run test:e2e -- e2e/eagerIdentity.e2e.ts e2e/hermesAdmission.e2e.ts e2e/eagerHooks.e2e.ts e2e/eagerRepair.e2e.ts e2e/nodeReferences.e2e.ts` | this Mac, with no other end-to-end run beside it | `Test Files  5 passed (5)`, `Tests  17 passed (17)`, nothing skipped, several minutes. `2 skipped` in `nodeReferences` means the Node in use is not a single-file build: use an official one | check 3 |
| 3 | The **CLI end to end** workflow on the branch, once (snippet below). **Needs the main session's go first:** it holds eight Linux runners and one macOS runner for about 30 minutes, and never runs beside another heavy workflow | GitHub, `ubuntu-latest` and `macos-15` | the five files pass with every test (`eagerHooks` has nine); the snippet's last line prints `0`; other files may fail, see below | `.github/workflows/cli-e2e.yml`, `workflow_dispatch` |
| 4 | `python3 scripts/local-checks.py --list` with the seven changed files | this Mac, repository root | `{}`: no local receipt, so the pull request carries no `harness-local-checks` fence (checked 2026-11-13) | none |

```bash
# 3: from the feature worktree, after the push; HEAD is the pushed head
gh workflow run cli-e2e.yml --ref fix/cli-e2e-nightly-red
gh run list --workflow cli-e2e.yml --branch fix/cli-e2e-nightly-red --event workflow_dispatch --limit 1 \
  --json databaseId,headSha,status,url        # headSha is `git rev-parse HEAD`; databaseId is RUN_ID
gh run watch RUN_ID
S="$(mktemp -d)" && gh run download RUN_ID --pattern 'cli-e2e-shard-*' --dir "$S"
node - "$S" <<'JS'
const fs = require('node:fs'), path = require('node:path')
const ours = ['eagerIdentity', 'hermesAdmission', 'eagerHooks', 'eagerRepair', 'nodeReferences']
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)])
for (const file of walk(process.argv[2]).filter((name) => /result-\d+\.json$/.test(name))) {
  for (const result of JSON.parse(fs.readFileSync(file, 'utf8')).testResults) {
    const name = path.basename(result.name, '.e2e.ts')
    if (ours.includes(name) || result.status !== 'passed')
      console.log(result.status, name, result.assertionResults.map((test) => test.status).join(' '))
  }
}
JS
gh run view RUN_ID --log-failed | grep -c "has no notify.mjs beside it"
```

Reading check 3. The script prints one line for each of the five files, then one for every other file that failed
(tried on run 43400659690, where it printed `failed eagerIdentity failed failed` and seven more). Expected now: five
lines starting `passed`. The run as a whole may still end red, and `e2e-summary` with it, on causes other pull
requests own (spec, Non-goals): `updates` (Codex resume reported as confirmed), `suspend` (Codex Ctrl+Z under bash,
#1612), `swarmV4Journey` (remove expected to stop the session), `superTabChannel` (the agent's name in its post),
`harnessWatch` (a time passed as a frame index), and `updateHostile` (its filler opened outside its `try`; also the
`e2e (macOS, full disk)` job). `agentBrowser` passes now (#4267 is in the branch's base). A failed file outside that
list is new: report it with its error. The last command counts failures that name the guard, in any file: `0` means no
other `scriptPath` caller broke (`lean`, `eagerOpenCode`, `masterIpcExit`, `update`, `updateOnItsOwn`, `reexec` and
`updateHostile` all start from one). A shard with no result file timed out: read its log.

No temporary workflow: the long check has the repository's own workflow, started by hand on the branch, and the new
unit test runs in PR CI from now on.

Not checked end to end, and why: the opt-in files that need a published build or measured bundles (`compat`,
`deviceCompat`, `recapsCompat` with `COMPAT_FROM`; `migration` and `reexec`'s second suite with `MIGRATION_FROM`;
`releaseRehearsal` with `REHEARSE_FROM`; `messagesSkew` with `SKEW_FROM`; `opencodeLaunchCost` with
`OPENCODE_COST_ROOT`). No workflow sets these. Their layouts were read (table above): each has `notify.mjs` beside its
`cli.js` when the folder it is given is a build's.
