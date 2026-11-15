# CLI end-to-end: a daemon under test inherits an allowlist, and its profile is under its own home: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **diegodev phase 3**. Tasks 1 and 2 are test-first: a red commit
> (the tests alone), then the code commit. Task 3 is one commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daemon started by the CLI end-to-end harness takes from the shell that runs the tests only what it needs
to run, and keeps its profile and its tmux folder under its own throwaway root, so nothing a developer's shell names
(connected-service tokens, shared folders, engine homes, API keys, an ssh agent) reaches it.

**Architecture:** Test harness only. `IsolatedDaemon.create` (`cli/e2e/harness/daemon.ts`) names in `own` everything it
used to leave riding in on the inherited environment and still needs: the Windows profile under its home, its tmux
folder, the Store's catalog. Then `daemonEnvironment` (`cli/src/testing/daemonEnvironment.ts`) keeps from the inherited
environment an allowlist and drops the rest, in place of its four lists of names to drop. No `XDG_*` is set by anyone:
each default then falls under the throwaway home. `own`, with a test's `options.env` last in it, still wins.

**Tech Stack:** TypeScript, Vitest 4.1, Node (v22.21.1 on this Mac; CI pins 24.22.2), tmux, zsh. No new dependency.

**Spec:** [docs/plans/2026-11-15-e2e-daemon-isolation-design.md](2026-11-15-e2e-daemon-isolation-design.md). Read it with
this plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority.

## Decided

By the PM, final:

- An allowlist, never a list of names to drop. A name an end-to-end file turns out to need is added to it with its
  reason in a comment.
- `IsolatedDaemon.create` pins `USERPROFILE`, `LOCALAPPDATA` and `APPDATA` under the throwaway home, passes
  `TMUX_TMPDIR` from its isolated tmux, and loses the `CLAUDE_CONFIG_DIR` delete. `TMPDIR` stays the root's `t` folder
  and is not on the allowlist: the parent's is never used. A test's `options.env` still wins.
- Red tests: the unit spec, and the new `cli/e2e/developerState.e2e.ts`.

The answers to the first draft's five questions (2026-11-15), by number, as the rest of this plan names them:

1. **The Store's catalog is pinned in `own`:** `HARNESS_STORE_CATALOG_URL` = `http://127.0.0.1:9/catalog.json`, beside
   `BACKEND_WS_URL` (Task 1). It is not on the allowlist: a developer's own mirror reaches no daemon.
2. **No `XDG_*` is pinned.** Only `USERPROFILE`, `LOCALAPPDATA` and `APPDATA`. In a daemon's environment every
   `XDG_*` is unset, so Cursor's config folder stays `<home>/.cursor` and the real-Podman file is not changed: the
   first draft's task for its macOS wrapper is dropped.
3. **Verification has a second GitHub run:** `cli-e2e.yml` with `agent_browser_podman=true`, after the eight-shard
   run, each on a runner turn from the orchestrator. That input runs only the real-Podman file, which the shards
   leave out. If Podman breaks there on the lost `XDG_RUNTIME_DIR`, the fix is that name on the allowlist, with its
   reason.
4. **The guards this change makes dead are removed in this pull request** (Task 3).
5. **`enginehomes.e2e.ts` runs locally without the eight cases that type an engine's name** (24 cases); the Linux run
   on GitHub holds the eight. The gap behind them (a daemon under test on a developer's Mac can start the real
   `claude` and `codex`) is the spec's Follow-up section, not this change.

While planning, from the code (say so if one is wrong):

- **Names are compared without their capitals.** Windows reads them so, and its shells spell them differently: cmd and
  PowerShell hand a child `SystemRoot`, `ComSpec`, `windir` and `Path`; Git Bash hands it `SYSTEMROOT`, `COMSPEC` and
  `WINDIR`. An exact match on the spec's spelling would drop one set or the other. A kept name keeps its spelling.
- **Two tasks, in this order:** the harness's own names first (Task 1), then the allowlist (Task 2). Every commit then
  leaves the suite working, and each task has a red test of its own.
- **The spec's first end-to-end case is four.** The pins are checked on a daemon that is made and never started
  (Task 1). The other three need the allowlist (Task 2): a second never-started daemon holds `FAKE_SECRET_TOKEN` and
  the developer's `XDG_DATA_HOME` and `XDG_CONFIG_HOME` out of a real `d.env`, as the unit spec holds them out of the
  function's answer; and one daemon with both variables set never copies the legacy folder (see below), so the copy
  has a case of its own beside the spec's.
- **`cli.e2e.ts:154` keeps its `XDG_CONFIG_HOME`.** It is the test's own setting for the client and the fake platform,
  not a guard, and with no pin in the harness it is the only one (see below). Only the delete loop under it goes.

## Global Constraints

- No product code. Only `cli/src/testing/daemonEnvironment.ts`, its spec, and files under `cli/e2e/`.
- The allowlist, verbatim from the spec: `PATH`; `LANG`, `LC_ALL` and every `LC_*`; `TERM`, `SHELL`; `USER`,
  `LOGNAME`; `TZ`, `CI`; Windows `SystemRoot`, `ComSpec`, `PATHEXT`, `windir`. Not `HOME`, `TMPDIR` or
  `TMUX_TMPDIR`: the harness sets those. Not any `XDG_*`: nobody sets them.
- The pins, verbatim: `USERPROFILE` = home, `LOCALAPPDATA` = `home/AppData/Local`, `APPDATA` =
  `home/AppData/Roaming`. No `XDG_*` pin, in the harness or in a task's fix: unset, each falls under the throwaway
  home (`home/.config`, `home/.local/share`).
- **Only made-up paths and values.** No test, log line, commit message or pull request body reads or carries the real
  value of a variable the audit names. A test puts a fake in the worker's environment with `vi.stubEnv` and takes it
  out with `vi.unstubAllEnvs()`; it never saves the old value itself. An assertion names the keys it compares: never
  `expect(d.env)` or `expect(process.env)` whole, whose diff would print the developer's environment.
- A failing or flaky test is a bug, fixed at its layer: never skipped, loosened, retried or given a longer timeout. No
  fixed sleeps.
- No local full suite. A task runs only the tests of what it changed. Every local end-to-end run is under
  `caffeinate -i`, with a short TMPDIR of the task's own (`/private/tmp/claude-503/iso-t<N>/`, made first with
  `mkdir -p`; an agent's TMPDIR is too long for the daemon's socket) and **`SHELL=/bin/zsh`**, as the workflow sets
  it: this Mac's account shell is bash, and several files write a `.zshrc` and expect it read.
- Never run or list `e2e/agentBrowserPodman.e2e.ts` locally: it acts on the machine's real Podman.
- On this Mac, never run a case that types an engine's name into a terminal tile: it starts the real `claude` or
  `codex` from `/usr/local/bin` (decision 5; the spec's Follow-up). No task's own checks have one;
  `enginehomes.e2e.ts` runs only as Verification 3 gives it.
- The GitHub workflow `cli-e2e` is heavy: every run of it, each of Verification's two, waits for a runner turn from
  the orchestrator.
- Other sessions run end-to-end tests on this Mac. A task ends only the processes its own test started and removes
  only its own folders, by their exact pid, socket or path, never by a pattern.
- Comments say why, in plain sentences, and name the audit of 2026-11-15.
- A commit adds its files by name. The two documents under `docs/plans/` are untracked here and are no task's.
- Platforms: macOS and Linux, where the end-to-end suite runs. No end-to-end run exists on Windows (it needs tmux):
  its names are held by the unit spec, its pins only as values checked on a Mac or on Linux. One pull request; its body names the platforms and carries
  each task's red and green output and the Verification results.

## Found while reading the code

Checked at `b5070936bb`, and rehearsed on this Mac (macOS, tmux 3.6b, Node 22.21.1): the change of Tasks 1 and 2 and
their tests were put into this worktree, run, and taken out again. Twice: the first draft's change, which also pinned
four `XDG_*` (since dropped, decision 2), whole; and this plan's, only where dropping the pins changed a test or a
task. Each number below says which.

- **Baseline.** `npx vitest run src/testing/daemonEnvironment.spec.ts`: 5 passed. `npm run typecheck`: clean, 69 s.
- **What rides in today and is relied on**, beyond the allowlist's own names:
  - `TMUX_TMPDIR`, from `isolatedTmux().env`. Every daemon needs it, and `e2e/harness/fakePlatform.mjs:48` refuses
    to start a master without it (`cli.e2e.ts`). Task 1 names it in `own`.
  - `HARNESS_STORE_CATALOG_URL`, from `cli/vitest.setup.ts:84`. Four files list the Store (`dsh_list`):
    `storeProcess`, `viewersOnDemand`, `services`, `endurance`. Task 1 names it in `own` (decision 1).
  - `VITEST`, from Vitest's worker. The daemon's `ghRun` refuses under it (`src/lib/github.ts:41`), and
    `sharedTabs.e2e.ts:246,251,403` set it to `''` so a stub `gh` runs. No file relies on the refusal: the harness's
    own refusing `gh` is first on every daemon's PATH (`daemon.ts:325`), also in the two files that set a PATH of
    their own (`creationPaths.e2e.ts:69`, `freshMachineEngines.e2e.ts:209`). Dropped with the rest.
  - `HARNESS_TEST_ISOLATED`, from `cli/vitest.setup.ts:86`: read only beside `VITEST` (`src/config/testIsolation.ts`).
- **No end-to-end file sets `process.env` for a daemon to read.** The only writes: `noSocket.e2e.ts` (TMPDIR, for the
  harness's own `tmpdir()`), `realBackendPort.e2e.ts` (a limit for the backend process, which takes `process.env`
  itself) and `harness/bundle.ts` (`E2E_BUNDLE_PATH`, read by `daemon.ts` in the test's process). No helper under
  `e2e/harness/` reads off `d.env` a name the harness does not set, but `TMUX_TMPDIR`.
- **The workflow's own variables.** `cli-e2e.yml` sets `LANG` and `SHELL` for the job: both are on the allowlist.
  `E2E_BUNDLE`, `E2E_ARTIFACTS_DIR`, `DISKFULL` and `HARNESS_E2E_*` are read by the test's process, never by a daemon.
- **`cli/vitest.setup.ts:41-45` already deletes `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME`** (and the
  engines' homes) from every worker. A test that plays a developer's shell sets them after it, with `vi.stubEnv`;
  `isolatedTmux()` copies `process.env` when the daemon is made, which is how they reach it today. So with no pin a
  daemon's shared folders are what they are at the base in every existing file: unset. `XDG_CACHE_HOME` and
  `XDG_RUNTIME_DIR` are not in that list and ride in today where a shell sets them; the allowlist drops them. No code
  under `cli/src` reads either. Rootless Podman on Linux reads `XDG_RUNTIME_DIR`, and only the real-Podman file runs
  it, with a store of its own named by `--root` and `--runroot` (`agentBrowserPodman.e2e.ts:637`): decision 3,
  Verification 5. This Mac's shell sets none of the five (asked as set or unset; no value read).
- **`cli.e2e.ts:154` sets `XDG_CONFIG_HOME` for its own client, and it is needed.** `install()` writes that
  environment into the fake platform's `config.json` as `baseEnv` (`:70`); the fake `systemctl` builds the unit's path
  from `config.baseEnv.XDG_CONFIG_HOME` (`e2e/harness/fakePlatform.mjs:105`), and the client under test takes its
  config folder from the same name (`src/harnessd/platform.ts:411`). The harness sets none (decision 2), so without
  this line the Linux cases have no path. Task 3 leaves it and removes only the delete loop under it.
- **`connectors` `{ action: 'list' }`** answers `{ connections: [{ connector, state, … }], signed_in, shared }`
  (`src/services/connectors.ts:261-267`, `src/lib/connectors/connect.ts:83-98`): one card for each service of the
  catalog, `state: 'not_connected'` until a token is saved, and one for each saved token the catalog does not know.
  Signed out, it reaches no network. The service starts with the edge host and writes its keys into its store as it
  starts, so a developer's folder would also be changed.
- **One daemon with both variables set never copies the legacy folder:** `adoptLegacy` returns when the store named
  by `HARNESS_CONNECTIONS_DIR` already has a `tokens.json` (`src/lib/connectors/store.ts:243`). The copy shows only
  with `XDG_DATA_HOME` alone.
- **The existing unit case "does not borrow the session of an agent" expects `CLAUDE_CODE_USE_BEDROCK` to pass.**
  Under the allowlist it does not: the expectation becomes `{ PATH: '/test/bin' }`.
- **The rehearsal, unit** (first rehearsal; the unit cases and the allowlist are as they were then): the planned spec
  on today's code, `3 failed | 5 passed (8)`; on the change, 8 passed; typecheck clean.
- **The rehearsal, end to end** (sources, no bundle, `SHELL=/bin/zsh`, other sessions' suites running beside it).
  - This plan's change, no `XDG_*` pin: the new file's five cases as written below, at the base
    `4 failed | 1 passed (5)`, after Task 1 `3 failed | 2 passed (5)` (its own case passes, Task 2's three still
    fail), after Task 2 `5 passed (5)` in 26 s. And `cli.e2e.ts` with both tasks in, Task 3's delete loop out and its
    own `XDG_CONFIG_HOME` kept: 8 passed, 123 s.
  - The first rehearsal, with the four pins in, not run again: `memory` 1 passed, `storeProcess` 5 passed,
    `deviceWithoutApp` 9 passed, `fleet` 6 passed, and `enginehomes` `7 failed | 25 passed (32)`, the same seven
    cases as at the base (next line). None of these files names an `XDG_*` a pin could have fed
    (`grep XDG_ cli/e2e`: `memory.e2e.ts` sets its own, `cli.e2e.ts` and `fakePlatform.mjs` are above), and without
    the pins their daemons' shared folders are the base's. Verification 3 runs them on the final head.
- **`enginehomes.e2e.ts` is red on this Mac at the base commit: `7 failed | 25 passed (32)`,** 12 minutes, in a copy
  of `b5070936bb`. A login zsh on macOS puts `/usr/local/bin` ahead of the test's own `bin` folder (`/etc/zprofile`,
  `path_helper`), and this Mac has a real `claude` and a real `codex` there: an engine typed by hand into a terminal
  tile is found there first, not the fake (read from the PATH order and the two files; no pane was looked at). The
  seven: "claude with CLAUDE_CONFIG_DIR: a resume typed into a terminal",
  both "a conversation started by hand in a terminal" cases, both "an incomplete … holds binding" cases, "Codex
  binding does not wait for the optional native discovery cooldown" and "unavailable Codex descriptor evidence holds
  binding". The eighth such case, the Codex resume, passes: it binds from the command line and the file alone. Not
  this change's: `PATH` is inherited before and after. Left as found: it is the spec's Follow-up (decision 5). The
  first rehearsal ran the whole file before this was known; without the eight, 24 cases are left and all 24 passed
  with that change. Verification 3's filter keeps exactly those 24: `npx vitest list --config vitest.e2e.config.ts
  e2e/enginehomes.e2e.ts` prints 32 cases, 24 with the filter, and the eight it drops are the eight above (listed,
  nothing run).
- **This Mac's account shell is bash.** With the session's `SHELL=/bin/bash`, more of `enginehomes.e2e.ts` fails at
  the base ("claude model picker follows the login shell home": its `.zshrc` is never read); with `SHELL=/bin/zsh`
  that case passes.
- **A new file needs no timing hint.** `ci-e2e-durations.json` names 15 of the 145 files; one without a hint costs
  `defaultDurationMs`, 60 s (`src/__fixtures__/ciTestSequencer.ts:63`), and the summary takes its list from
  discovery. The new file took 18 s here.
- **`e2e/tuiShell.e2e.ts` runs nowhere:** it needs `HN_TUI_BINARY`, which no workflow sets and this checkout has no
  build of. It is skipped in every check below.
- **Local gates.** `python3 scripts/local-checks.py --list` on the File map's paths prints `{}`. End-to-end files are
  not typechecked (`tsconfig.json` has `rootDir: src`); the unit spec is.

## File map

| File | Change | Task |
| --- | --- | --- |
| `cli/e2e/harness/daemon.ts` | `create`: the Windows profile, `TMUX_TMPDIR`, the Store's catalog, in `own` (1); the dead `CLAUDE_CONFIG_DIR` delete goes, and a comment says why no `XDG_*` is named (2) | 1, 2 |
| `cli/e2e/developerState.e2e.ts` | new: one case (1), its helpers and four more (2) | 1, 2 |
| `cli/src/testing/daemonEnvironment.ts` | the allowlist, in place of the four lists | 2 |
| `cli/src/testing/daemonEnvironment.spec.ts` | three new cases, one changed expectation | 2 |
| `cli/e2e/sharedTabs.e2e.ts`, `cli/e2e/cli.e2e.ts`, `cli/e2e/harness/fleet.ts`, `cli/e2e/tuiShell.e2e.ts`, `cli/e2e/deviceWithoutApp.e2e.ts` | guards that can no longer change anything go (decision 4) | 3 |

`cli/e2e/agentBrowserPodman.e2e.ts` is no task's (decision 2).

## Review Focus

Each line is pinned by a test in the task that owns the code.

- A developer who names only the shared data folder (`XDG_DATA_HOME`, no `HARNESS_CONNECTIONS_DIR`), which is most of
  them: nothing is copied into the daemon's own store, and the daemon's environment names no shared folder at all
  (unset, not moved: Cursor's config folder stays `<home>/.cursor`). Task 2, cases "copies no Harness OS
  connections" and "takes nothing from the shell".
- Windows spells the names its own way (`Path`, `SystemRoot`; `SYSTEMROOT` under Git Bash): kept in either spelling,
  while `USERPROFILE` and `APPDATA` beside them are not. Task 2, unit case "keeps what Windows needs".
- What the harness or a test sets wins when it is not on the list, and when it is empty (`HARNESS_GRID_BIN: ''`).
  Task 2, unit case "lets what the harness or a test sets win", and the case "uses the connections folder a test
  names for it", on a real daemon.
- A daemon beside another has the first one's home, profile and tmux folder. Task 1, its case, last line.
- A developer's own settings that passed until now (`CLAUDE_CODE_USE_BEDROCK`, a Store mirror, the parent's
  `TMPDIR`): none reaches a daemon. Task 2, unit cases "inherits only" and "does not borrow the session"; Task 1,
  its case (`HARNESS_STORE_CATALOG_URL`, `TMPDIR`).

No test can pin this one: a developer whose `tmux`, `git` or `zsh` on PATH is a version manager's shim loses the
shim's own variables (`ASDF_DATA_DIR`, `MISE_DATA_DIR`, `VOLTA_HOME`) in a daemon, as it already lost their `HOME`.
Not so on this Mac or on a runner. The spec's rule covers it: the name goes on the allowlist, with its reason.

---

### Task 1: The harness names a daemon's profile, tmux folder and Store catalog

**Depends on:** nothing. **Effort:** high.

**Files:**
- Modify: `cli/e2e/harness/daemon.ts:333-389` (the `own` argument in `IsolatedDaemon.create`)
- Create, test: `cli/e2e/developerState.e2e.ts`

**The test that fails before the change:** in the new `cli/e2e/developerState.e2e.ts`, "has its profile under its own
home, and its own tmux folder, temporary folder and Store catalog".

**Interfaces:**
- Produces: `d.env.TMUX_TMPDIR` set by the harness itself, which Task 2 relies on; the new file with its `describe`,
  its `scratch` folder and its `daemon` closed after each case, which Task 2's cases use.

- [ ] **Step 1: Write the file**

```ts
/**
 * A daemon under test knows nothing of the developer's own state, whatever their shell names.
 *
 * `IsolatedDaemon.create` handed a daemon the environment of the shell that ran the tests, less a few names (audit of
 * 2026-11-15, docs/plans/2026-11-15-e2e-daemon-isolation-design.md). A developer with HARNESS_CONNECTIONS_DIR set gave
 * every daemon under test their connected services' tokens, and one with Harness OS connections under XDG_DATA_HOME
 * had them copied into the test's root (lib/connectors/store.ts `adoptLegacy`).
 *
 * Every path and value here is made up, in a folder of this test. `vi.stubEnv` puts them in this worker's environment
 * as a developer's shell would, and takes them out again: no real value of these variables is read or printed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IsolatedDaemon } from './harness/daemon.js'

describe('a daemon under test knows nothing of the developer\'s own state', () => {
  let scratch = ''
  let daemon: IsolatedDaemon | undefined

  beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'developer-state-')) })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await daemon?.close()
    daemon = undefined
    rmSync(scratch, { recursive: true, force: true })
  })

  it('has its profile under its own home, and its own tmux folder, temporary folder and Store catalog', async () => {
    // A developer's shell that names every one of them: made-up folders, so a failure prints nothing real.
    for (const name of ['USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) vi.stubEnv(name, join(scratch, name))
    vi.stubEnv('HARNESS_STORE_CATALOG_URL', 'https://store.invalid/catalog.json')
    const d = daemon = await IsolatedDaemon.create()
    const home = d.env.HOME!
    expect({
      USERPROFILE: d.env.USERPROFILE, LOCALAPPDATA: d.env.LOCALAPPDATA, APPDATA: d.env.APPDATA,
      TMUX_TMPDIR: d.env.TMUX_TMPDIR, TMPDIR: d.env.TMPDIR, HARNESS_STORE_CATALOG_URL: d.env.HARNESS_STORE_CATALOG_URL,
    }).toEqual({
      USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming'),
      TMUX_TMPDIR: d.tmux.root, TMPDIR: join(d.root, 't'), HARNESS_STORE_CATALOG_URL: 'http://127.0.0.1:9/catalog.json',
    })
    // A daemon beside another shares its home and its tmux server. Never started: the first one's close takes its folders.
    const beside = await IsolatedDaemon.create({ beside: d })
    expect([beside.env.HOME, beside.env.USERPROFILE, beside.env.TMUX_TMPDIR]).toEqual([home, home, d.tmux.root])
  })
})
```

No `XDG_*` here: the harness names none (decision 2), and a developer's is kept out by the allowlist, so Task 2 holds
that.

- [ ] **Step 2: See it fail**

```bash
cd cli && export TMPDIR=/private/tmp/claude-503/iso-t1/ SHELL=/bin/zsh && mkdir -p "$TMPDIR"
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/developerState.e2e.ts
```

Expected: `1 failed (1)`. The diff shows the four fakes where the daemon's own profile and its catalog should be;
`TMUX_TMPDIR` and `TMPDIR` already match.

- [ ] **Step 3: Commit the red test**

```bash
git add cli/e2e/developerState.e2e.ts
git commit -m "CLI e2e: a daemon under test keeps its profile under its own home (red test)"
```

- [ ] **Step 4: Name them in `own`**

In `IsolatedDaemon.create`, three additions to the object passed to `daemonEnvironment`; nothing else moves. After
`HOME: dirs.home,`:

```ts
      // Its profile, under that home too. On Windows os.homedir() follows USERPROFILE, not HOME, so every default
      // under it was the developer's real profile (audit of 2026-11-15).
      USERPROFILE: dirs.home,
      LOCALAPPDATA: join(dirs.home, 'AppData', 'Local'),
      APPDATA: join(dirs.home, 'AppData', 'Roaming'),
```

After `TMPDIR: dirs.tmp,`:

```ts
      // Its tmux server's folder, by name (src/testing/isolatedTmux.ts): the daemon's bare tmux calls must reach the
      // fixture's private server, whatever else it inherits.
      TMUX_TMPDIR: tmux.env.TMUX_TMPDIR,
```

After `WEB_URL: 'http://127.0.0.1:9',`:

```ts
      // Nor the Store's catalog on GitHub (dsh/catalog.ts): a published one turned a fixture registry of two into the
      // live shelf of 23. Until now this reached a daemon only from the worker's environment (vitest.setup.ts).
      HARNESS_STORE_CATALOG_URL: 'http://127.0.0.1:9/catalog.json',
```

No `XDG_*` line (decision 2).

- [ ] **Step 5: See it pass**

Run: the command of Step 2. Expected: `1 passed (1)`.

- [ ] **Step 6: The files that read these names**

```bash
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/cli.e2e.ts e2e/storeProcess.e2e.ts
```

Expected: 2 files passed, 8 and 5 tests. `cli.e2e.ts` starts its masters through `fakePlatform.mjs`, which refuses
one with no `TMUX_TMPDIR`; `storeProcess.e2e.ts` lists the Store.

- [ ] **Step 7: Commit**

```bash
git add cli/e2e/harness/daemon.ts
git commit -m "CLI e2e: the harness names a daemon's profile, tmux folder and Store catalog"
```

---

### Task 2: A daemon under test inherits an allowlist

**Depends on:** Task 1. It names `TMUX_TMPDIR` in `own`: without that, the allowlist would send every daemon under
test to the system's default tmux folder. Both tasks also change `daemon.ts` and `developerState.e2e.ts`.
**Effort:** xhigh (credentials: what reaches every daemon under test, and every pane it opens).

**Files:**
- Modify: `cli/src/testing/daemonEnvironment.ts` (the whole file, 20 lines)
- Test: `cli/src/testing/daemonEnvironment.spec.ts`
- Modify: `cli/e2e/harness/daemon.ts` (the three lines after the `daemonEnvironment(…)` call, and the comment above
  `USERPROFILE` that Task 1 wrote)
- Test: `cli/e2e/developerState.e2e.ts` (three helpers, four more cases)

**The tests that fail before the change:** in `cli/src/testing/daemonEnvironment.spec.ts`, the new "inherits only what
it needs to run" and "keeps what Windows needs", and "does not borrow the session of an agent" with its new
expectation; in `cli/e2e/developerState.e2e.ts`, the new "takes nothing from the shell but what it needs to run",
"copies no Harness OS connections from the developer's shared data folder into its own" and "shows none of the
developer's connected services". The fourth new end-to-end case, "uses the connections folder a test names for it",
passes before and after: it holds that a test's own value still wins.

**Interfaces:**
- Consumes: Task 1's `TMUX_TMPDIR` in `own`, and the `describe`, `scratch` and `daemon` of the end-to-end file.
- Produces: `daemonEnvironment(inherited: NodeJS.ProcessEnv, own: NodeJS.ProcessEnv): NodeJS.ProcessEnv`, signature
  unchanged. Its one caller is `daemon.ts`.

- [ ] **Step 1: The unit cases**

In `describe('a daemon under test')`, after the first case, add:

```ts
  it('inherits only what it needs to run, and nothing else the shell names', () => {
    const needed = {
      PATH: '/test/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', LC_CTYPE: 'UTF-8', LC_MESSAGES: 'C', TERM: 'xterm-256color',
      SHELL: '/bin/zsh', USER: 'tester', LOGNAME: 'tester', TZ: 'UTC', CI: 'true',
    }
    expect(daemonEnvironment({
      ...needed,
      // Made up, every one: the kinds of name the audit found (docs/plans/2026-11-15-e2e-daemon-isolation-design.md).
      FAKE_SECRET_TOKEN: 'fake-secret', HARNESS_CONNECTIONS_DIR: '/fake/connections', XDG_DATA_HOME: '/fake/share',
      SSH_AUTH_SOCK: '/fake/agent.sock', OPENAI_API_KEY: 'fake-key', HOME: '/fake/home', TMPDIR: '/fake/tmp',
      TMUX_TMPDIR: '/fake/tmux', NODE_OPTIONS: '--require /fake/hook.cjs', VITEST: 'true',
    }, {})).toEqual(needed)
  })
  it('keeps what Windows needs to start a child, however the shell spells it', () => {
    // cmd and PowerShell hand a child SystemRoot, ComSpec, windir and Path; Git Bash hands it SYSTEMROOT, COMSPEC and WINDIR.
    const cmd = { Path: 'C:\\test\\bin', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.COM;.EXE', windir: 'C:\\Windows' }
    const bash = { PATH: '/c/test/bin', SYSTEMROOT: 'C:\\Windows', COMSPEC: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.COM;.EXE', WINDIR: 'C:\\Windows' }
    expect(daemonEnvironment({ ...cmd, USERPROFILE: 'C:\\Users\\fake', LOCALAPPDATA: 'C:\\Users\\fake\\AppData\\Local', Fake_Secret_Token: 'fake-secret' }, {})).toEqual(cmd)
    expect(daemonEnvironment({ ...bash, USERPROFILE: 'C:\\Users\\fake', APPDATA: 'C:\\Users\\fake\\AppData\\Roaming' }, {})).toEqual(bash)
  })
  it('lets what the harness or a test sets win, on the list or not, empty or not', () => {
    expect(daemonEnvironment({ PATH: '/host/bin', LANG: 'C.UTF-8', HARNESS_GRID_BIN: '/host/grid' },
      { PATH: '/test/bin', HOME: '/test/home', HARNESS_GRID_BIN: '', HARNESS_CONNECTIONS_DIR: '/test/connections' }))
      .toEqual({ PATH: '/test/bin', LANG: 'C.UTF-8', HOME: '/test/home', HARNESS_GRID_BIN: '', HARNESS_CONNECTIONS_DIR: '/test/connections' })
  })
```

In "does not borrow the session of an agent running the tests", the expectation becomes `{ PATH: '/test/bin' }`:
`CLAUDE_CODE_USE_BEDROCK` is a setting the developer chose, and stayed under the old rule. The other four cases stay
as they are, as assertions of the new rule.

- [ ] **Step 2: The end-to-end cases**

In `cli/e2e/developerState.e2e.ts`, the imports become:

```ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Store } from '../src/lib/connectors/store.js'
```

Above the `describe`, three helpers:

```ts
/** A connections folder with one connection saved, as Connections leaves it. */
function saved(root: string, code: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  new Store(root).save(code, { access_token: 'e2e-not-a-credential', source: 'custom', mcp_entry: { url: `https://${code}.example/mcp`, headers: {} } })
}

/** Every file under [root], with what it holds. */
function files(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((file) => [file, readFileSync(file, 'utf8')]))
}

/** The connections the daemon shows as made, by code. */
async function connected(d: IsolatedDaemon): Promise<string[]> {
  const client = await LocalClient.connect(d)
  try {
    // Connected services answer once the edge host has reached the core: until then the answer has no list in it.
    const cards = await until('connectors to answer', async () => {
      const answer = await client.request<{ connections?: Array<{ connector: string; state: string }> }>('connectors', { action: 'list' }, 30_000)
      return Array.isArray(answer.connections) ? answer.connections : null
    }, 60_000, 250)
    return cards.filter((card) => card.state !== 'not_connected').map((card) => card.connector).sort()
  } finally { client.close() }
}
```

In the `describe`, under `let daemon`:

```ts
  const failed = (d: IsolatedDaemon) => onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
```

And after Task 1's case, four more:

```ts
  it('takes nothing from the shell but what it needs to run', async () => {
    vi.stubEnv('FAKE_SECRET_TOKEN', 'e2e-not-a-secret')
    vi.stubEnv('HARNESS_CONNECTIONS_DIR', join(scratch, 'connections'))
    vi.stubEnv('SSH_AUTH_SOCK', join(scratch, 'agent.sock'))
    // The shared folders are not the harness's to name either: unset, each falls under the daemon's own home.
    vi.stubEnv('XDG_DATA_HOME', join(scratch, 'share'))
    vi.stubEnv('XDG_CONFIG_HOME', join(scratch, 'config'))
    const d = daemon = await IsolatedDaemon.create()
    expect({
      FAKE_SECRET_TOKEN: d.env.FAKE_SECRET_TOKEN, HARNESS_CONNECTIONS_DIR: d.env.HARNESS_CONNECTIONS_DIR, SSH_AUTH_SOCK: d.env.SSH_AUTH_SOCK,
      XDG_DATA_HOME: d.env.XDG_DATA_HOME, XDG_CONFIG_HOME: d.env.XDG_CONFIG_HOME,
    }).toEqual({
      FAKE_SECRET_TOKEN: undefined, HARNESS_CONNECTIONS_DIR: undefined, SSH_AUTH_SOCK: undefined,
      XDG_DATA_HOME: undefined, XDG_CONFIG_HOME: undefined,
    })
  })

  it('copies no Harness OS connections from the developer\'s shared data folder into its own', async () => {
    const shared = join(scratch, 'share')
    saved(join(shared, 'harness-os', 'connections'), 'harness_os_service')
    const before = files(scratch)
    vi.stubEnv('XDG_DATA_HOME', shared)
    const d = daemon = await IsolatedDaemon.create()
    failed(d)
    await d.start()
    expect(await connected(d)).toEqual([])
    expect(existsSync(join(d.env.HOME!, '.harness', 'connections', 'tokens.json'))).toBe(false)
    expect(files(scratch)).toEqual(before)
  })

  it('shows none of the developer\'s connected services, and leaves their folders as they were', async () => {
    const theirs = join(scratch, 'connections')
    const shared = join(scratch, 'share')
    saved(theirs, 'developer_service')
    saved(join(shared, 'harness-os', 'connections'), 'harness_os_service')
    const before = files(scratch)
    vi.stubEnv('HARNESS_CONNECTIONS_DIR', theirs)
    vi.stubEnv('XDG_DATA_HOME', shared)
    const d = daemon = await IsolatedDaemon.create()
    failed(d)
    await d.start()
    expect(await connected(d)).toEqual([])
    expect(files(scratch)).toEqual(before)
  })

  it('uses the connections folder a test names for it', async () => {
    const own = join(scratch, 'own-connections')
    saved(own, 'test_service')
    const d = daemon = await IsolatedDaemon.create({ env: { HARNESS_CONNECTIONS_DIR: own } })
    failed(d)
    await d.start()
    expect(await connected(d)).toEqual(['test_service'])
  })
```

And one sentence ends the second paragraph of the file's header: `A daemon now inherits only an allowlist
(src/testing/daemonEnvironment.ts), and the harness names the rest (harness/daemon.ts).`

- [ ] **Step 3: See both fail**

```bash
cd cli && export TMPDIR=/private/tmp/claude-503/iso-t2/ SHELL=/bin/zsh && mkdir -p "$TMPDIR"
npx vitest run src/testing/daemonEnvironment.spec.ts
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/developerState.e2e.ts
```

Expected: the unit spec `3 failed | 5 passed (8)`; the end-to-end file `3 failed | 2 passed (5)`: "takes nothing" on
its five fakes where `undefined` should be, "copies no" on `expected [ 'harness_os_service' ] to deeply equal []`,
"shows none" on `expected [ 'developer_service' ] to deeply equal []`.

- [ ] **Step 4: Commit the red tests**

```bash
git add cli/src/testing/daemonEnvironment.spec.ts cli/e2e/developerState.e2e.ts
git commit -m "CLI e2e: a daemon under test inherits only what it needs to run (red tests)"
```

- [ ] **Step 5: The allowlist**

`cli/src/testing/daemonEnvironment.ts` becomes the list below and the function. `GITHUB_CREDENTIALS`, `HOST_HINTS`,
`borrowed` and the import of `isAgentSessionVariable` go, with their comments. The function keeps an inherited entry
when its name, in capitals, is on the list or starts with `LC_`, and spreads `own` over what is kept; the kept name
keeps its spelling.

```ts
/**
 * What a daemon under test takes from the shell that runs the tests: what it needs to run, and nothing that says
 * where the developer keeps something or who they are to a service. Everything else is dropped, known or not. The
 * audit of 2026-11-15 found two dozen names the daemon's code reads that named the developer's own state: their
 * HARNESS_CONNECTIONS_DIR gave every daemon under test their connected services' tokens, and their XDG_DATA_HOME had
 * their Harness OS tokens copied into the test's root. A list of names to drop would miss the next one, and
 * SSH_AUTH_SOCK, AWS_* and NPM_TOKEN, which no code here reads but what a daemon runs can use. The lists this replaced
 * are covered by it: the host supervisor's HARNESSD_*, an agent session's variables, a GitHub login, the host app's
 * hints.
 *
 * A name an end-to-end file turns out to need is added here, with its reason. Never a list of names to drop again.
 * What the harness sets, and what a test sets, are `own` and always win (e2e/harness/daemon.ts).
 *
 * In capitals: Windows reads a name whatever its capitals, and its shells spell them differently (cmd hands a child
 * SystemRoot and Path, Git Bash SYSTEMROOT and PATH).
 */
const INHERITED: ReadonlySet<string> = new Set([
  // The tools the tests run: node, tmux, git, zsh. The harness puts its own bin folder first.
  'PATH',
  // UTF-8 in tmux and in the panes, with every LC_* (below). CI sets LANG to C.UTF-8.
  'LANG', 'LC_ALL',
  // The terminal tmux and the panes draw for, and the login shell a pane opens. CI sets SHELL to /bin/zsh.
  'TERM', 'SHELL',
  // Who the process is. No state.
  'USER', 'LOGNAME',
  // Times in logs and transcripts, and whether this is a CI run.
  'TZ', 'CI',
  // Windows: Node cannot start a child without these.
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR',
])
```

- [ ] **Step 6: The delete that is now dead, and why no shared folder is named**

In `cli/e2e/harness/daemon.ts`, remove the two comment lines and the line
`if (!options.env || !('CLAUDE_CONFIG_DIR' in options.env)) delete env.CLAUDE_CONFIG_DIR` after the
`daemonEnvironment(…)` call: `CLAUDE_CONFIG_DIR` is no longer inherited, so only a test's own can be there.

And the comment Task 1 wrote above `USERPROFILE` gains, as its last sentences:

```ts
      // No XDG_* is named: a daemon inherits none (src/testing/daemonEnvironment.ts), so each falls under this home.
      // Naming XDG_CONFIG_HOME would also move Cursor's config folder to .config/cursor (engines/cursor/contract.ts).
```

- [ ] **Step 7: See them pass**

```bash
npx vitest run src/testing/daemonEnvironment.spec.ts       # 8 passed
npm run typecheck                                          # no error, about a minute
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/developerState.e2e.ts   # 5 passed
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/memory.e2e.ts e2e/cli.e2e.ts   # 1 and 8 passed
```

- [ ] **Step 8: Commit**

```bash
git add cli/src/testing/daemonEnvironment.ts cli/e2e/harness/daemon.ts
git commit -m "CLI e2e: a daemon under test inherits an allowlist, not the developer's shell"
```

---

### Task 3: The guards the allowlist made dead

Task 4 of the first draft; its Task 3, the macOS Podman wrapper, went with the `XDG_*` pins (decision 2).

**Depends on:** Task 2 (they are dead only once nothing else is inherited). **Effort:** high (five files; each
removal is proved a no-op before it goes).

**Files:**
- Modify: `cli/e2e/sharedTabs.e2e.ts:245-246,251,403`
- Modify: `cli/e2e/cli.e2e.ts:156-157`
- Modify: `cli/e2e/harness/fleet.ts:91-96`
- Modify: `cli/e2e/tuiShell.e2e.ts:49`
- Modify: `cli/e2e/deviceWithoutApp.e2e.ts:64-66`

**The test that fails before the change:** none: no behavior. Each line removed can no longer change anything: a
daemon's environment now holds the allowlist's names, the harness's own and the test's, and none of the names below
is among them.

- [ ] **Step 1: Remove them**

| Where | What goes | Why it is dead |
| --- | --- | --- |
| `sharedTabs.e2e.ts:245-246` | the comment, and the fifth argument `{ owner: { VITEST: '' } }` | `VITEST` is not inherited; the stub `gh` runs |
| `sharedTabs.e2e.ts:251,403` | `, VITEST: ''` | the same |
| `cli.e2e.ts:156-157` | the comment and the loop deleting five names | none of the five is inherited, and the harness sets none of them |
| `harness/fleet.ts:91-96` | the comment and the loop deleting what names a server | a runner's registry or proxy is not inherited; `assertLocalOnly`, the next line, stays and names anything a test passes |
| `tuiShell.e2e.ts:49` | the line | `isolatedTmux` already took `TMUX` and `TMUX_PANE`; `HN_SOCKET` is not inherited |
| `deviceWithoutApp.e2e.ts:64-66` | the three deletes | the same, and `HARNESS_PANE` is not inherited |

**`cli.e2e.ts:154` stays as it is**, with its `XDG_CONFIG_HOME: join(home, '.config')`: the harness sets no `XDG_*`,
and the fake `systemctl` and the client under test both read this one (`e2e/harness/fakePlatform.mjs:105`,
`src/harnessd/platform.ts:411`). None of the six removals depends on an `XDG_*` (checked for this plan: the names are
`VITEST`, the loop's five, a server's address, `TMUX`, `TMUX_PANE`, `HN_SOCKET` and `HARNESS_PANE`).

`sharedPair`'s fifth parameter stays: `sharedTabs.e2e.ts:518` passes it. Before each removal, read the `create` calls
that feed the environment in question and confirm no test passes the name itself; if one does, leave that guard and
say so in the task report.

- [ ] **Step 2: Run what can run here**

```bash
cd cli && export TMPDIR=/private/tmp/claude-503/iso-t3/ SHELL=/bin/zsh && mkdir -p "$TMPDIR"
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/cli.e2e.ts e2e/deviceWithoutApp.e2e.ts e2e/fleet.e2e.ts
```

Expected: 3 files passed, with 8, 9 and 6 tests, none skipped (`cli.e2e.ts` rehearsed for this plan with its loop
out; the other two in the first rehearsal). `sharedTabs.e2e.ts` needs the real backend's Mongo and Redis, which this
Mac has no install of: it runs in Verification 4. `tuiShell.e2e.ts` runs nowhere.

- [ ] **Step 3: Commit**

```bash
git add cli/e2e/sharedTabs.e2e.ts cli/e2e/cli.e2e.ts cli/e2e/harness/fleet.ts cli/e2e/tuiShell.e2e.ts cli/e2e/deviceWithoutApp.e2e.ts
git commit -m "CLI e2e: remove the per-file guards the allowlist made dead"
```

---

## Left out

- `cli/vitest.setup.ts:41-45` keeps its deletions: they are for the unit specs, which read the worker's environment
  themselves.
- `e2e/memory.e2e.ts:39-43` keeps the seven homes it names: they still place the package's folders, so they are not
  dead. (It leaves its `memory-e2e-*` folder in TMPDIR, as it did before.)
- `ghRun`'s refusal under `VITEST` (`src/lib/github.ts:41`) is product code and stays for the unit specs.
- No text of `cli/AGENTS.md` changes: rule 6 already says a test never uses the developer's own machine.
- Windows: `TEMP`, `TMP` and `USERNAME` are not on the spec's list and are not added.
- No `XDG_*` pin, and no change to `cli/e2e/agentBrowserPodman.e2e.ts` (decision 2). `XDG_RUNTIME_DIR` is not on the
  allowlist unless Verification 5 shows Podman needs it (decision 3).
- The real engines a daemon under test can start on a developer's Mac: a login zsh puts `/usr/local/bin` ahead of the
  harness's own `bin`, so `claude` or `codex` typed into a terminal tile is the developer's. Not this change's
  (`PATH` is inherited before and after) and not fixed here: it is the spec's
  [Follow-up](2026-11-15-e2e-daemon-isolation-design.md#follow-up-high-priority-its-own-item), a high-priority item
  of its own, with how to reproduce it.

## Verification

On the final head, after the review. Isolation is the repo's own (`cli/AGENTS.md`, rules 5 and 6): every file boots
its own daemons under a throwaway root, with a private tmux server and fake engines, signed out, its backend at
`127.0.0.1:9`. No real account, no production, nothing of the developer's daemon (port 18473), `~/.harness`,
`~/.claude` or `~/.codex`. Every variable the new tests set is a made-up path in the test's own folder. One gap in
that isolation was found here and is kept out of these checks: on this Mac a case that types an engine's name into a
terminal tile starts the real engine (the spec's Follow-up), so check 3 leaves those eight cases to the Linux run
(decision 5). None of these checks needs Diego himself.

Local checks run on this Mac (macOS, tmux), in `cli/`, one command at a time:

```bash
cd cli && export TMPDIR=/private/tmp/claude-503/iso-v/ SHELL=/bin/zsh && mkdir -p "$TMPDIR"
```

1. **The unit spec and the typecheck.**

   ```bash
   npx vitest run src/testing/daemonEnvironment.spec.ts
   npm run typecheck
   ```

   To see: `Tests 8 passed (8)` (the base: 5); the typecheck prints no error.

2. **The new file.**

   ```bash
   caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/developerState.e2e.ts
   ```

   To see: `Tests 5 passed (5)`, in about 25 s. The same file at the base commit: `4 failed | 1 passed (5)`.

3. **The files whose daemons' environment this changes most.** The PM's three, and two more the reading found:
   `storeProcess` lists the Store (decision 1), and `deviceWithoutApp` starts an engine outside a pane from `d.env`.
   `enginehomes.e2e.ts` runs apart, without the eight cases that type an engine by hand (decision 5).

   ```bash
   caffeinate -i npx vitest run --config vitest.e2e.config.ts \
     e2e/memory.e2e.ts e2e/cli.e2e.ts e2e/storeProcess.e2e.ts e2e/deviceWithoutApp.e2e.ts
   caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/enginehomes.e2e.ts \
     -t '^(?!.*(typed into a terminal|started by hand in a terminal|holds binding|native discovery cooldown))'
   ```

   To see: four files passed, with 1, 8, 5 and 9 tests, none skipped; then `24 passed | 8 skipped (32)`. About a
   quarter of an hour in all on a busy Mac. Never the second command without its `-t`: the eight cases it leaves
   out start the real `claude` and `codex` here. A failure is compared with the same file at the base commit, in a
   copy of its own (`git archive b5070936bb cli | tar -x -C <folder>`, `node_modules` linked in), with the same
   `SHELL`, filter and a TMPDIR of its own: an old red is reported as such, never as passed.

On GitHub, by hand, **two runs, one after the other, each only on a runner turn from the orchestrator**, after the
branch is pushed (shared runners, `docs/validation-and-release.md`). Check 5 starts after check 4 has ended and the
orchestrator has given a second turn. Report each run's link.

4. **The whole suite on Linux, and the full disk on macOS:** the existing workflow, eight Linux shards and one macOS
   runner, each shard with the real backend and its in-memory Mongo and Redis.

   ```bash
   gh workflow run cli-e2e.yml --ref fix/e2e-daemon-isolation
   ```

   To see: `e2e (1)` to `e2e (8)`, `e2e (macOS, full disk)` and `e2e-summary` green; `e2e/developerState.e2e.ts` in
   the summary's verified files. It proves that every file's daemons start and work on the allowlist, `sharedTabs`
   among them with its stub `gh`, and `enginehomes.e2e.ts` whole, with the eight cases this Mac cannot run. A red
   test is reported with its link and whether main's last nightly run has it too. A file that fails because it
   needed an inherited variable: that one name goes on the allowlist with its reason and an assertion in the unit
   spec, in this pull request, and the orchestrator decides on the rerun.

5. **The agent browser on real Podman, on Linux** (decision 3): the same workflow with its input, which runs only
   `e2e/agentBrowserPodman.e2e.ts`. The eight shards leave that file out (`vitest.e2e.ci.config.ts`), so check 4
   says nothing of it.

   ```bash
   gh workflow run cli-e2e.yml --ref fix/e2e-daemon-isolation -f agent_browser_podman=true
   ```

   To see: one job, `e2e (agent browser, real Podman)`, green, every case passed and none skipped (the job requires
   it); one runner, up to 50 minutes. It proves rootless Podman still runs under a daemon that no longer hands it
   `XDG_RUNTIME_DIR`. If it is red because Podman lost that name (Podman's error in the job's output or in the
   preserved daemon log names the runtime folder): `XDG_RUNTIME_DIR` goes on the allowlist in
   `cli/src/testing/daemonEnvironment.ts`, with its reason in a comment (rootless Podman keeps its runtime state
   there; a folder of the login session, not the developer's data), and joins `needed` in the unit case "inherits
   only what it needs to run", test first, in this pull request. Then this run again, on the orchestrator's turn. No
   other `XDG_*` is added, and none is pinned. Any other red is reported with its link and whether main's last run
   of this input has it too; another name Podman turns out to need follows the spec's rule (the allowlist, with its
   reason), on the orchestrator's word.

Not checked, and said so in the pull request, each an unverified row, never a passing one: the macOS path of
`agentBrowserPodman.e2e.ts` (no task changes the file, but its daemon now starts Podman from the allowlist; it needs
a Mac with Podman and a stopped machine, and this Mac has no `podman`); `tuiShell.e2e.ts` (no `hn` build, no
workflow gives it one); the Windows names and pins beyond the unit spec.

**Temporary workflow:** none. The long checks have a workflow already (`.github/workflows/cli-e2e.yml`, run by hand
from a branch and every night), which finds the new file by itself. The unit spec runs on every pull request, the new
end-to-end file every night: nothing here needs a new check that keeps running.

**Beside the end-to-end checks:** PR CI runs by itself what a `cli/` change selects, `cli-typecheck` and `cli-tests`
(the unit spec among them) first. **Checks PR CI does not run:** none for these paths
(`python3 scripts/local-checks.py --list` prints `{}`); `npm run test:core` and `test:harnessd` are not needed, as
nothing under `cli/src/core`, `cli/src/services` or `cli/src/harnessd` changes.
