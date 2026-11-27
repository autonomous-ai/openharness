# CLI end-to-end, part 3: no daemon or pane of a test finds an engine beside the worker's Node: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **diegodev phase 3**. Every task is test-first: a red commit (the
> tests alone), then the code commit; Task 5 alone has nothing a test reads and is one commit. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** No daemon, service or pane an end-to-end test starts can find or run an engine beside the Node the test
worker runs on, on any developer's machine, for every engine the product supports today or later; the tests that need
an engine "not installed" keep working unchanged.

**Architecture:** Test harness only. A new global setup of the end-to-end configs makes one copy of the worker's Node
for the run, alone in a folder of its own (`cli/src/testing/testNode.ts`, with `placeNode`), starts it once and names
it in `E2E_NODE_PATH`. `IsolatedDaemon.start` (`cli/e2e/harness/daemon.ts`) spawns that copy, or a test's own
`options.node`; it starts nothing with neither, and refuses a Node whose folder holds anything but `node` and
`libnode.*`. `cli/src/testing/testPath.ts` links `<root>/tools/node` to the same copy, so `node` in a pane is it too.
The three test files that link a Node themselves link that copy (`cli/e2e/cli.e2e.ts`, whose daemons `harness start`
starts, `creationPaths.e2e.ts` and `freshMachineEngines.e2e.ts`), and the hand-run `cli/scripts/spike-a-stack.ts`
makes a copy of its own.

**Tech Stack:** TypeScript, Vitest 4.1.10, Node (arm64 v22.23.5 on this Mac; CI pins 24.22.2), tmux, zsh, `ps`. No
new dependency.

**Spec:** [docs/plans/2026-11-16-e2e-isolation-3-design.md](2026-11-16-e2e-isolation-3-design.md). Read it with this
plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority. Parts 1 (#4318) and 2 (#4345,
[its plan](2026-11-15-e2e-isolation-2-plan.md)) are merged; this branch, `fix/e2e-isolation-3`, is on `main` at
`8fcfa7de5c`.

## Decided

By the PM, 2026-11-16, final:

- **Option B of the spec.** One copy of the worker's Node for each run, made by a new end-to-end global setup with
  `src/testing/placeNode.ts` and named in `E2E_NODE_PATH`. `IsolatedDaemon.start` spawns
  `options.node ?? E2E_NODE_PATH`, throws with neither, and refuses a Node whose folder holds anything but `node` and
  `libnode.*`. `src/testing/testPath.ts` links `<root>/tools/node` to `E2E_NODE_PATH` when it is set.
- **No fallback to `process.execPath`** in `IsolatedDaemon.start`: it would reopen the hole without a word.
- **A Node that Rosetta runs** (x86_64 on Apple Silicon) makes the whole end-to-end run fail at once with
  `placeNode`'s `RosettaNodeError`. Accepted.
- **No product file changes.** Only `cli/src/testing/` and `cli/e2e/`, the test configuration the spec names,
  `cli/vitest.e2e.config.ts`, and the one hand-run script below.
- **What stays on the worker's Node:** the fake engines' shims (`#!${process.execPath}`) and the CLI clients a test
  spawns itself. `npm` stays off the tool list.
- **No red or green run of a task starts a real engine, or types an engine's name in a pane.** Made-up files only.
  `e2e/freshMachineEngines.e2e.ts` runs locally only after the `developerState` case that proves the daemon's Node
  folder holds only `node` is green. The whole `cli-e2e.yml` run needs a runner turn from the orchestrator.

By the PM, 2026-11-16, on the first draft's three questions (the spec's "Test files that link the worker's Node
themselves", "A script outside the suite" and Verification step 4):

- **The three test files that link the worker's Node themselves link the run's Node** (`E2E_NODE_PATH`):
  `e2e/cli.e2e.ts:145`, `e2e/creationPaths.e2e.ts:68` and `e2e/freshMachineEngines.e2e.ts:190`. The red test is a
  case in `cli.e2e.ts` that the core `harness start` runs is on the run's Node. Task 4.
- **`cli/scripts/spike-a-stack.ts` calls `setUpTestNode()` itself first and its teardown at the end,** so it keeps
  working. Task 5.
- **`e2e/enginehomes.e2e.ts` runs locally, last, and `e2e/cli.e2e.ts` runs locally too,** each only in the same
  command line after `e2e/developerState.e2e.ts` passed. Verification 4.

While planning, from the code at `8fcfa7de5c` (say so if one is wrong):

1. **The case reads the core's line in `ps`, not the master's.** The master names itself `harnessd`
   (`src/harnessd/master.ts:281`, `process.title`), and `ps -o args=` then prints only that (checked here on a plain
   Node: `harnessd`). The core sets no title, and the master starts it on its own Node
   (`src/masterProcess.ts:256`, `baseNode(process.execPath)`), so the first word of the core's line is the daemon's
   Node.
2. **The guard judges the folder Node names itself by:** `dirname(realpathSync(node))`. A symbolic link in a clean
   folder to a Node beside other programs would pass a check of the link's folder, and that is the spec's own hole 3.
3. **The guard is `assertNodeAlone` in `src/testing/testNode.ts`,** with unit cases; `daemon.ts` calls it. Pull
   request CI runs no end-to-end file, so the unit cases are what holds the guard on every pull request.
4. **The refusal names at most five programs,** sorted, then `and N more`: a developer's Node folder can hold
   dozens (code standard 4, every list bounded).
5. **`E2E_NODE_PATH` is a real path.** macOS's temporary folder is behind a link, and Node names itself by the real
   path: the test compares the two as text.
6. **The setup is second of three:** after `socketRoom.ts`, before `bundle.ts`. A Node that cannot be copied stops
   the run before the minutes of a bundle build.
7. **`e2e/harness/testNode.ts` calls `setUpTestNode()` with no argument and never re-exports it.** Vitest hands a
   global setup its project as the first argument (`globalSetupFile.setup?.(this)`); read as the machine, it would
   switch the Rosetta refusal off without a word.
8. **`workerTools(worker)` reads `worker.E2E_NODE_PATH`,** the environment it is handed, as it reads `worker.PATH`. So
   the spec's "stubbed" case passes it in that argument. `workerTools()` keeps what it found at its first call, so the
   "not set" case creates its daemon before it takes the variable away.
9. **One `try` after the folder is made:** a refused Node, a failed copy and a copy that cannot start all leave no
   folder. Only the last is wrapped, with its message; `RosettaNodeError` passes as it is.
10. **An empty `E2E_NODE_PATH` counts as not set,** in `start` and in `workerTools`.
11. **An assertion that would print the worker's own Node, or the names beside it, is a yes or a no, or a count.**
    On a developer's Mac that path names their account, and the names are their programs.
12. **`testNode.spec.ts` is skipped on Windows,** as `testPath.spec.ts` is: Windows runs no end-to-end test.
13. **"#4345's run" is run 43746252131,** the whole suite at its final head. Its one red, an `agentClient.e2e.ts`
    race, was already on `main` (recorded in #4345).

For Tasks 4 and 5, from the code at `ed79d28aa6` (Tasks 1 and 2 in):

14. **`cli.e2e.ts` is gated by its own case, not by `developerState`'s.** Its daemons take `harness start`'s door,
    which the guard in `IsolatedDaemon.start` never sees. So in Verification 4 its new case runs alone first, and
    the whole file only after that passed, in the same line.
15. **The new case judges the core's Node with `assertNodeAlone`,** the check `start` makes for its own daemons, and
    only after the yes or no: a refusal then names the run's folder, never the developer's (decision 11).
16. **The three links take `process.env.E2E_NODE_PATH!`, with no fallback.** Without it `symlinkSync` throws and the
    test fails; the three files run only under the end-to-end configs, whose setup sets it.
17. **Task 4's red run starts one daemon on the worker's Node,** as this file always has, makes no harness and types
    nothing. A daemon looks beside its Node only when it launches a harness (`src/engines/nativeLaunch.ts:171`, the
    one caller of `captureLaunchExecutable` besides Hermes's record, whose path is pinned).
18. **The spike makes its Node first in its `try`, before the first daemon, not before the backend.** A backend that
    cannot start (no services folder: the usual way it fails by hand) then copies nothing, and a Node that cannot be
    copied stops the backend through the `catch` that is already there.
19. **`e2e/creationPaths.e2e.ts` joins the local checks** (the plan's own addition: Task 4 changes it, and the
    spec's list was written before): after every gated check passed, before `enginehomes`. Say so if GitHub's run
    is enough for it.

## Open questions

For Diego, in one message. The draft says what it assumes until then; the answer changes only the lines named. The
first draft's three questions are answered (Decided, above).

1. **A real run of `cli/scripts/spike-a-stack.ts` after Task 5.** No test and no workflow runs the script, and it
   needs a real backend: the backend's own `npm ci`, and a services folder with `mongodb-memory-server` and
   `redis-memory-server` named in `HARNESS_E2E_SERVICES_DIR`. This Mac has `redis-server`, but no such folder and no
   `backend/node_modules`. **The draft assumes** it is not run: Task 5 shows that it still loads and leaves no Node
   behind, and the pull request lists the script as unverified. Or (a) a temporary workflow on the branch
   (`.github/workflows/tmp-e2e-isolation-3.yml`, Linux, set up as `cli-e2e.yml` sets up the real backend, about five
   minutes of a shared runner, removed before the pull request), or (b) a run by hand on this Mac, after installing
   those into throwaway folders?

## Global Constraints

- No product code. Only `cli/src/testing/`, `cli/e2e/`, `cli/vitest.e2e.config.ts` and the hand-run
  `cli/scripts/spike-a-stack.ts`. Nothing under `cli/src/core`, `cli/src/services`, `cli/src/harnessd`,
  `cli/src/lib` or `cli/src/engines`.
- **No run starts a real engine.** On this Mac the worker's Node folder holds real engines. In every task and in
  Verification:
  - a task runs only its unit specs and `e2e/developerState.e2e.ts`, which asks where a name resolves (`whence -p`)
    and types only `node -p process.execPath`; never type an engine's name into a pane, a tile or a shell of your own.
    Task 4 runs instead two cases of `e2e/cli.e2e.ts` that make no harness, and Task 5 its script with no backend;
  - never run `e2e/freshMachineEngines.e2e.ts`, `e2e/creationPaths.e2e.ts`, `e2e/enginehomes.e2e.ts` or the whole of
    `e2e/cli.e2e.ts` in a task. They are Verification 3 and 4's, in one line after `e2e/developerState.e2e.ts`
    passed whole, by the run's own exit status;
  - never run `npm run test:tmux-real`, `src/lib/tmuxAgentDiscovery.real.spec.ts` or
    `e2e/agentBrowserPodman.e2e.ts` here;
  - the made-up `codex`, `kilo` and the like in the tests are empty files, never executable, never run.
- **Only made-up paths and values.** A test never prints the worker's own Node or what is beside it (decision 11).
  No log line, commit message or pull request body carries a real path of the developer's.
- **Only your own processes and folders.** Other sessions run end-to-end tests on this Mac. A task ends only what
  its own test started, by exact pid or socket; never `pkill`, `killall` or a pattern. It removes only a folder it
  made, by its full path written out.
- **Nothing writes into the run's Node folder.** Every daemon of the run shares it; the guard refuses the next start
  if a test does.
- A failing or flaky test is a bug, fixed at its layer: never skipped, loosened, retried or given a longer timeout.
  No fixed sleeps.
- No local full suite. Every local end-to-end run is under `caffeinate -i`, on an arm64 Node
  (`node -p process.arch`), with a short TMPDIR of the task's own (`/private/tmp/claude-503/iso3-t<N>/`, made first
  with `mkdir -p`; an agent's TMPDIR is too long for the daemon's socket) and `SHELL=/bin/zsh`.
- The GitHub workflow `cli-e2e` is heavy: its one run waits for a runner turn from the orchestrator.
- Comments say why, in plain sentences, and name the audit of 2026-11-16 and the design.
- A commit adds its files by name. The documents under `docs/plans/` are untracked here and are no task's.
- Platforms: macOS and Linux, where the end-to-end suite runs. One pull request; its body names the platforms and
  carries each task's red and green output and the Verification results.

## Found while reading the code

Read at `8fcfa7de5c`. **What was run:** Tasks 1 to 3, with this plan's own test text and a first writing of the
code, in a copy of `cli/` at the base outside this worktree (macOS, arm64 Node 22.23.5, sources, no bundle,
`SHELL=/bin/zsh`), and nothing else. **Not run:** `freshMachineEngines.e2e.ts`, `leftBehind.e2e.ts`,
`enginehomes.e2e.ts`, and `nodeReferences.e2e.ts` (its bundle build needs the whole checkout, not `cli/` alone).
What is said of them is read from the code; a task whose red or green differs from the below says so in its report.

**For Tasks 4 and 5, run later** in a copy of `cli/`, `store/`, `pty/` and `plugins/` at `ed79d28aa6` (Tasks 1 and 2
in, Task 3 not; the same Mac and Node): Task 4's new case, red and then green with the one link changed, beside the
file's first case (neither makes a harness), and Task 5's change with no backend. **Not run:** the other seven cases
of `cli.e2e.ts` (six make a fake `claude` harness), `creationPaths.e2e.ts`, and the spike script with a backend.

- **Baseline.** The eight unit files of Verification 1: `36 passed` (`testPath` 4, `placeNode` 8, `socketPathRoom` 5,
  `isolatedTmux` 7, `daemonListeningPort` 4, `fakeCodexAppServer` 2, `releaseFixtures` 5, `ghStub` 1). Cases listed:
  `developerState.e2e.ts` 9, `freshMachineEngines.e2e.ts` 7, `leftBehind.e2e.ts` 8, `nodeReferences.e2e.ts` 2,
  `enginehomes.e2e.ts` 34, `shells.e2e.ts` 8, `dotfiles.e2e.ts` 2, `cli.e2e.ts` 8, `creationPaths.e2e.ts` 5.
- **The rehearsal.**
  - Task 1: red, `Cannot find module './testNode.js'`; green, `7 passed`; `npm run typecheck` clean (31 s).
  - Task 2: red, `1 failed | 4 passed (5)` on `node is the run's Node: expected false to be true`; green, `5 passed`.
  - Task 3, with Tasks 1 and 2 in: red, `3 failed | 9 skipped (12)`, the first on
    `the daemon runs on the run's Node: expected false to be true`, the other two on
    `promise resolved "undefined" instead of rejecting`; green, the whole file `12 passed (12)` in 19 s. After each
    run no `harness-e2e-node-*` was left and no process ran on one.
  - The setup itself, five times, load around 21: median 1245 ms, 1158 to 1587 ms (the design: 1.1 to 1.6 s).
  - Task 4: red, `1 failed | 8 skipped (9)` on `the core runs on the run's Node: expected false to be true`, 22 s
    with the file's own bundle build; green, with the first case, `2 passed | 7 skipped (9)`, 25 s. After each run
    no `harness-e2e-node-*` was left and no process of the run.
  - Task 5, with no backend: `Error: Set SPIKE_OUT`, exit 1; with `SPIKE_OUT` and no services folder, a `TypeError`
    on `"paths[0]"`, exit 1; no `harness-e2e-node-*` after either.
- **`harness start`'s door, in `cli.e2e.ts`.** The command starts the master on `managedNodePath()`
  (`src/core/main.ts:364`), here the link `<runtime>/node-e2e/bin/node`. Node names itself by the real path;
  `masterNode` keeps it (`node-e2e` is no runtime folder's name, so `nodeMajorOf` is null:
  `src/masterProcess.ts:369`), and the master starts the core on `baseNode(process.execPath)`. So the first word of
  the core's line in `ps` is the real path behind the link: the worker's Node at the base, the run's Node after
  Task 4 (seen in the rehearsal). The definitions `harness service install` writes keep the link's own path.
- **`backend.stop()` closes its daemons first,** then its services (`e2e/harness/realBackend.ts` `stopAll`): the
  spike removes its Node after it. `startRealBackend` starts nothing before it reads `HARNESS_E2E_SERVICES_DIR`.
- **A file's own bundle build reads `store/`, `pty/` and `plugins/` beside `cli/`** (`cli/build-bundle.mjs`).
- **The lookup, as the spec says.** `npmRuntimeBins()` (`src/lib/engineLaunch.ts:1090`) is
  `dirname(managedNodePath())` and `dirname(baseNode(process.execPath))`; `managedNodePath()` is `process.execPath`
  with no `current-node` (`src/lib/nodeRuntime.ts:24`); `captureLaunchExecutable` adds `npmEngineBins()` for an npm
  engine with no override (`src/engines/kit/launchExecutable.ts:130`). The CLI's own verbs import no launch code
  (`src/cli.ts` takes only the engines' names), so `harness new` in a test's own process looks up nothing.
- **The master makes no name link beside the run's Node.** `namedNode` links only a Node inside the daemon's own
  runtime folder (`src/harnessd/processName.ts:70`); the copy is outside every root, so its folder stays as made.
  `nodeReferences.e2e.ts`'s own Node is inside one: its links go to `libexec/harnessd`, never `bin`.
- **`options.node` has one user,** `e2e/nodeReferences.e2e.ts:69`: a copy at
  `<scratch>/runtime/node-v<version>-e2e/bin/node`, alone in `bin`. It passes the guard as it is.
- **A launcher follows by itself.** `e2e/harness/olderReleaseHandoff.mjs:11` spawns its core on its own
  `process.execPath`, and the launcher runs on the Node `start` gives it.
- **`e2e/harness/abandonedWorker.ts` runs under `tsx`, not Vitest,** with the worker's environment less
  `E2E_ARTIFACTS_DIR` (`e2e/leftBehind.e2e.ts:184`): it inherits `E2E_NODE_PATH`.
- **`harness start` in `sandbox.e2e.ts` and `twodaemons.e2e.ts` starts nothing:** both assert the refusal.
- **A daemon and its panes never see `E2E_NODE_PATH`:** it is not on the allowlist
  (`src/testing/daemonEnvironment.ts`). Only the harness reads it.
- **The unit suite loads the end-to-end harness untyped** (`tsconfig.json` has `rootDir: src`):
  `await import('../../e2e/harness/socketRoom.js' as string)` in `socketPathRoom.spec.ts:10`. Three unit specs load
  `e2e/harness/daemon.js` the same way, and `ghStub.spec.ts` reads it as text.
- **In a unit worker `os.tmpdir()` is behind a link on macOS** (`vitest.tmpdir.ts`: a folder under `/tmp`).
- **`placeNode` does not export its `Machine` type** and copies before it makes folders: the folder it copies into
  must exist.
- **Where the checks run.** Pull request CI runs the unit suite on Linux (`ci.yml`, four shards): `testNode.spec.ts`
  and `testPath.spec.ts` run there on every pull request. `cli-e2e.yml` runs every end-to-end file but
  `agentBrowserPodman.e2e.ts` on eight Linux shards, nightly and by hand; its macOS job runs only two files
  (`diskfull`, `updateHostile`, filtered). So the new `developerState` cases on macOS are the local run's.
- **Local gates.** `python3 scripts/local-checks.py --list` on the File map's paths names none (`{}`).
- **#4345's local record:** `enginehomes.e2e.ts` `28 passed | 6 failed (34)` on a daemon run from sources, the six
  Codex cases holding on `the native control helper is unavailable`; on GitHub 33 passed and 1 skipped.

## File map

| File | Change | Task |
| --- | --- | --- |
| `cli/src/testing/testNode.ts` | new: the run's Node and its teardown, `assertNodeAlone` | 1 |
| `cli/src/testing/testNode.spec.ts` | new: seven cases | 1 |
| `cli/e2e/harness/testNode.ts` | new: the global setup, one call | 1 |
| `cli/vitest.e2e.config.ts` | the setup second in `globalSetup`; a paragraph in its header | 1 |
| `cli/src/testing/testPath.ts` | `node` is the run's Node where there is one | 2 |
| `cli/src/testing/testPath.spec.ts` | one new case | 2 |
| `cli/e2e/harness/daemon.ts` | `start` spawns the run's Node or a test's own, behind the two refusals | 3 |
| `cli/e2e/developerState.e2e.ts` | three new cases | 3 |
| `cli/e2e/cli.e2e.ts` | the managed link names the run's Node; one new case | 4 |
| `cli/e2e/creationPaths.e2e.ts` | its `node` link names the run's Node | 4 |
| `cli/e2e/freshMachineEngines.e2e.ts` | its `node` link names the run's Node | 4 |
| `cli/scripts/spike-a-stack.ts` | makes the run's Node itself, and removes it | 5 |

No two tasks share a file. Dependencies: Task 3 on Tasks 1 and 2; Tasks 4 and 5 each on Task 1 alone, so both can
run beside Task 3.

## Review Focus

Each line is pinned by a test in the task that owns the code.

- A developer whose Node is Homebrew's, which loads `libnode` from beside the path it runs as: the guard lets
  `libnode.*` through and nothing else. Task 1, case "lets a Node be alone but for libnode".
- A Node reached through a symbolic link in a clean folder (a version manager's shim, a managed link): judged by the
  folder it names itself by. Task 1, case "judges the folder Node names itself by".
- A copy that cannot start: the run stops before any test, names the worker's Node and the reason, and leaves no
  folder. Task 1, case "stops the run when the copy cannot start".
- Vitest's own argument to a global setup: never read as the machine. Task 1, case "is what the suite's setup makes".
- `E2E_NODE_PATH` empty, or taken away by a test: nothing starts, and never on the worker's Node. Task 3, case
  "starts nothing when the run gave it no Node".
- A daemon started by a door the guard never sees, `harness start` on a managed link: its core runs on the run's
  Node, alone in its folder. Task 4, case "runs its core on the run's Node, alone in its folder, behind the managed
  link".

No test can pin these: a real x86_64 Node under Rosetta (a machine passed in stands for it: this worktree's
dependencies are installed for arm64, so Vitest itself does not start under one); Homebrew's own Node, on a Mac that
runs none; a run killed before its teardown, which leaves `harness-e2e-node-*` as a killed run leaves
`harness-e2e-bundle-*`; a test file written later that links the worker's Node for a daemon or a pane of its own,
which only review holds; the spike script's own call (open question 1); and that no real engine starts, which no test
may try. The last is held by the guard and by the order of Verification.

---

### Task 1: The run's Node, and the guard

**Depends on:** nothing. **Effort:** xhigh (which programs every daemon under test can reach, under the developer's
login).

**Files:**
- Create: `cli/src/testing/testNode.ts`
- Create, test: `cli/src/testing/testNode.spec.ts`
- Create: `cli/e2e/harness/testNode.ts`
- Modify: `cli/vitest.e2e.config.ts` (the header comment, and `globalSetup` at `:28`)

**The tests that fail before the change:** the seven cases of the new `cli/src/testing/testNode.spec.ts`, red as a
module that is not there. They need no tmux and run on pull request CI.

**Interfaces:**
- Consumes: `placeNode(path, runFrom, machine)` and `RosettaNodeError` (`cli/src/testing/placeNode.ts`, unchanged).
- Produces, in `cli/src/testing/testNode.ts`:

  ```ts
  /** Makes the run's Node, starts it once and names it in E2E_NODE_PATH. Returns the teardown, which removes its folder.
   *  [machine] and [start] are for the spec: this Node's own machine, and one run of the copy. */
  export function setUpTestNode(machine?: Parameters<typeof placeNode>[2], start?: (node: string) => void): () => void
  /** Throws unless [node], by its real path, is alone in its folder but for `libnode.*`. */
  export function assertNodeAlone(node: string): void
  ```

- Produces, in `cli/e2e/harness/testNode.ts`: `export default function setup(): () => void`.
- Produces, in every end-to-end worker: `process.env.E2E_NODE_PATH`, the real path
  `<os.tmpdir(), resolved>/harness-e2e-node-XXXXXX/bin/node`. Tasks 2 and 3 read it by that name.

**Local end-to-end run:** one case of `e2e/developerState.e2e.ts` that starts no daemon (Step 5).

- [ ] **Step 1: The unit cases**

`cli/src/testing/testNode.spec.ts`:

```ts
/**
 * The run's Node: a copy of the Node running the tests, alone in a folder of its own. The product looks for
 * npm-installed engines beside the Node it runs on, whatever PATH says (lib/engineLaunch.ts `npmRuntimeBins`), and a
 * version manager puts the developer's real engines in that folder (audit of 2026-11-16,
 * docs/plans/2026-11-16-e2e-isolation-3-design.md). Every folder and file here is made up; the one program run is the
 * copy of this Node.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RosettaNodeError } from './placeNode.js'
import { assertNodeAlone, setUpTestNode } from './testNode.js'

// The end-to-end harness and its configuration are outside tsconfig's rootDir (src), so they are loaded untyped, as
// socketPathRoom.spec.ts loads socketRoom.ts.
const setup = (await import('../../e2e/harness/testNode.js' as string) as { default: (project?: unknown) => () => void }).default
const config = (await import('../../vitest.e2e.config.js' as string) as { default: { test: { globalSetup: string[] } } }).default

const ROSETTA = { platform: 'darwin', arch: 'x64', cpu: 'Apple M1 Pro' }
const ALONE = 'a daemon under test must run on a Node alone in its folder'
/** What [folder] holds beside a Node and the library Homebrew's Node loads from beside it. */
const strangers = (folder: string) => readdirSync(folder).filter((name) => name !== 'node' && !name.startsWith('libnode.'))

describe.skipIf(process.platform === 'win32')('the run\'s Node', () => {
  let base = '', tmp = ''
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'test-node-')))
    tmp = join(base, 'tmp')
    mkdirSync(tmp)
    // The temporary folder behind a link, as macOS's is.
    symlinkSync(tmp, join(base, 't'))
    vi.stubEnv('TMPDIR', join(base, 't'))
    // Stubbed first, so that what the setup sets is taken out again.
    vi.stubEnv('E2E_NODE_PATH', undefined)
  })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }) })
  /** A folder of [base] holding [files], each empty: never run. */
  const folder = (name: string, ...files: string[]): string => {
    mkdirSync(join(base, name))
    for (const file of files) writeFileSync(join(base, name, file), '')
    return join(base, name)
  }

  it('is a copy of this Node alone in its folder, named by its real path in E2E_NODE_PATH, and gone at teardown', () => {
    const teardown = setUpTestNode()
    const node = process.env.E2E_NODE_PATH!
    expect(readdirSync(tmp)).toEqual([expect.stringMatching(/^harness-e2e-node-.{6}$/)])
    expect(node).toBe(join(tmp, readdirSync(tmp)[0], 'bin', 'node'))
    expect(strangers(dirname(node))).toEqual([])
    expect(() => assertNodeAlone(node)).not.toThrow()
    // Node names itself by its real path: the folder the daemon looks beside is this one.
    const run = spawnSync(node, ['-p', 'process.execPath'], { encoding: 'utf8', timeout: 20_000 })
    expect(run.stderr + run.stdout).toBe(`${node}\n`)
    teardown()
    expect(readdirSync(tmp)).toEqual([])
  })

  it('refuses a Node that Rosetta runs, by name, and leaves no folder', () => {
    expect(() => setUpTestNode(ROSETTA)).toThrow(RosettaNodeError)
    expect([readdirSync(tmp), process.env.E2E_NODE_PATH]).toEqual([[], undefined])
  })

  it('stops the run when the copy cannot start, naming this Node and the reason, and leaves no folder', () => {
    const refusal = (() => {
      try { setUpTestNode(undefined, () => { throw new Error('made-up: library not loaded') }) } catch (error) { return String(error) }
    })()
    // A yes or a no: the message names the developer's own Node.
    expect(refusal === `Error: A copy of ${process.execPath} cannot start, so no end-to-end daemon can run: made-up: library not loaded`,
      'names this Node and the reason').toBe(true)
    expect([readdirSync(tmp), process.env.E2E_NODE_PATH]).toEqual([[], undefined])
  })

  it('is what the suite\'s setup makes, after the socket room is measured and before the bundle is built', () => {
    // Vitest hands a global setup its project: never read as the machine.
    const teardown = setup(ROSETTA)
    expect(process.env.E2E_NODE_PATH).toBe(join(tmp, readdirSync(tmp)[0], 'bin', 'node'))
    teardown()
    expect(readdirSync(tmp)).toEqual([])
    expect(config.test.globalSetup).toEqual(['./e2e/harness/socketRoom.ts', './e2e/harness/testNode.ts', './e2e/harness/bundle.ts'])
  })

  it('lets a Node be alone but for libnode, which Homebrew\'s Node loads from beside it', () => {
    expect(() => assertNodeAlone(join(folder('alone', 'node', 'libnode.141.dylib', 'libnode.so.141'), 'node'))).not.toThrow()
  })

  it('refuses a Node beside other programs, naming the folder and at most five of them', () => {
    const one = folder('one', 'node', 'codex')
    const many = folder('many', 'node', 'npm', 'npx', 'corepack', 'codex', 'kilo', 'opencode', 'pi')
    expect(() => assertNodeAlone(join(one, 'node'))).toThrow(`${one} holds codex: ${ALONE}`)
    expect(() => assertNodeAlone(join(many, 'node'))).toThrow(`${many} holds codex, corepack, kilo, npm, npx and 2 more: ${ALONE}`)
  })

  it('judges the folder Node names itself by: a link in a clean folder to a Node beside other programs is refused', () => {
    const theirs = folder('theirs', 'node', 'codex'), clean = folder('clean')
    symlinkSync(join(theirs, 'node'), join(clean, 'node'))
    expect(() => assertNodeAlone(join(clean, 'node'))).toThrow(`${theirs} holds codex: ${ALONE}`)
  })
})
```

- [ ] **Step 2: See them fail, and commit them**

```bash
cd cli && npx vitest run src/testing/testNode.spec.ts
```

Expected: the file fails to load on a module that is not there (`Cannot find module` or `Failed to resolve import`,
naming `e2e/harness/testNode.js` or `./testNode.js`): 1 failed file, no test run.

```bash
git add cli/src/testing/testNode.spec.ts
git commit -m "CLI e2e: a run has a Node of its own, alone in its folder (red tests)"
```

- [ ] **Step 3: `cli/src/testing/testNode.ts`**

To the Interfaces block. What it and the tests leave open:

- `setUpTestNode`, in this order: `mkdtempSync(join(tmpdir(), 'harness-e2e-node-'))`, resolved with `realpathSync`;
  `bin` in it; `placeNode(<bin>/node, [], machine)`; `start(<bin>/node)`; `process.env.E2E_NODE_PATH = <bin>/node`.
  The teardown is `rmSync(<folder>, { recursive: true, force: true })`.
- Everything after the folder is made is in one `try`; its `catch` removes the folder and throws on (decision 9).
- The default `start` is `execFileSync(node, ['-e', ''], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 })`.
  What it throws is wrapped, with the error as `cause`:
  `` `A copy of ${process.execPath} cannot start, so no end-to-end daemon can run: ${reason}` ``, the reason being
  the error's `message` (Node puts the copy's standard error in it). `RosettaNodeError` is not wrapped.
- `assertNodeAlone`: the names in `dirname(realpathSync(node))` other than `node` and those starting `libnode.`,
  sorted. With any: `` `${folder} holds ${names}: a daemon under test must run on a Node alone in its folder` ``,
  the names joined with `, `, the first five and then ` and ${rest} more`. One `readdirSync`. A folder that is not
  there throws as `realpathSync` does.
- The file's header says why a copy and not a link (a symbolic link does not move `process.execPath`; a hard link of
  the running Node broke Homebrew's Node across the Mac, #4395), why the folder holds nothing else (the product looks
  beside its Node for engines, and a version manager's folder holds the developer's real ones: the audit of
  2026-11-16), and what it costs (one copy and one first start for each run: the design's Cost).

- [ ] **Step 4: The setup and the configuration**

- `cli/e2e/harness/testNode.ts`: a header in the style of `socketRoom.ts` (what it is, why, that the workers
  inherit `E2E_NODE_PATH` as they do `E2E_BUNDLE_PATH`, and why it passes nothing on: decision 7), and

  ```ts
  export default function setup(): () => void { return setUpTestNode() }
  ```

- `cli/vitest.e2e.config.ts`: `globalSetup: ['./e2e/harness/socketRoom.ts', './e2e/harness/testNode.ts', './e2e/harness/bundle.ts']`.
  Its header gains a paragraph: every daemon runs on a copy of the worker's Node made for the run
  (`e2e/harness/testNode.ts`), and a Node that Rosetta runs stops the run before any test, by name.
  `vitest.e2e.ci.config.ts` merges this file and does not change.

- [ ] **Step 5: See them pass**

```bash
npx vitest run src/testing/testNode.spec.ts src/testing/placeNode.spec.ts src/testing/socketPathRoom.spec.ts   # 7, 8 and 5 passed
npm run typecheck                                                                                             # no error
export TMPDIR=/private/tmp/claude-503/iso3-t1/ SHELL=/bin/zsh && mkdir -p "$TMPDIR"
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/developerState.e2e.ts -t 'runs its tiles under /bin/zsh'
ls -d "$TMPDIR"harness-e2e-node-* 2>/dev/null | wc -l
```

Expected of the last two: `1 passed | 8 skipped (9)`, a case that starts no daemon, in a real run with the setup in
it; then `0`: the teardown took the folder.

- [ ] **Step 6: Commit**

```bash
git add cli/src/testing/testNode.ts cli/e2e/harness/testNode.ts cli/vitest.e2e.config.ts
git commit -m "CLI e2e: one copy of the worker's Node for each run, alone in its folder"
```

---

### Task 2: `node` in a pane is the run's Node

**Depends on:** nothing (it reads the variable by name). **Effort:** medium (mechanical, one file and its spec).

**Files:**
- Modify: `cli/src/testing/testPath.ts` (the comment at `:19-20`, `workerTools` at `:41-48`)
- Test: `cli/src/testing/testPath.spec.ts` (one case)

**The test that fails before the change:** in `cli/src/testing/testPath.spec.ts`, "links node to the run's Node where
the run made one, and to the Node running the tests where it did not".

**Interfaces:**
- Produces: `workerTools(worker?)` maps `node` to `worker.E2E_NODE_PATH` when it is set and not empty, to
  `process.execPath` otherwise. Its signature, `testPath` and every other tool are as they were. Task 3's first case
  reads the result through a tile.

**No local end-to-end run.**

- [ ] **Step 1: The case**

In `cli/src/testing/testPath.spec.ts`, after "finds each tool where the worker's PATH has it":

```ts
  // The product looks beside the Node it runs on for npm-installed engines (lib/engineLaunch.ts npmRuntimeBins), and a
  // CLI run by `node` in a pane names itself by the real path behind the link (audit of 2026-11-16,
  // docs/plans/2026-11-16-e2e-isolation-3-design.md). So the link is to the run's own Node, alone in its folder.
  it('links node to the run\'s Node where the run made one, and to the Node running the tests where it did not', () => {
    const run = join(folder('node'), 'node'), worker = folder('git')
    const tools = workerTools({ PATH: worker, E2E_NODE_PATH: run })
    // A yes or a no: at the base the answer is the developer's own Node.
    expect(tools.get('node') === run, 'node is the run\'s Node').toBe(true)
    const root = folder()
    testPath(root, tools)
    expect(readlinkSync(join(root, 'tools', 'node')) === run, 'and so is the link in <root>/tools').toBe(true)
    // A unit spec's tmux fixture runs no daemon and no engine, and no setup made it a Node.
    expect(workerTools({ PATH: worker }).get('node')).toBe(process.execPath)
    expect(workerTools({ PATH: worker, E2E_NODE_PATH: '' }).get('node')).toBe(process.execPath)
  })
```

- [ ] **Step 2: See it fail, and commit it**

```bash
cd cli && npx vitest run src/testing/testPath.spec.ts
```

Expected: `1 failed | 4 passed (5)`, on `node is the run's Node: expected false to be true`.

```bash
git add cli/src/testing/testPath.spec.ts
git commit -m "CLI e2e: node in a pane is the run's Node (red test)"
```

- [ ] **Step 3: `workerTools`**

In `cli/src/testing/testPath.ts`, `node` is `worker.E2E_NODE_PATH || process.execPath`. The comment above `'node'`
in `TEST_TOOLS` and the function's own say what it is now and why: the run's copy (`testNode.ts`), so that a
`#!/usr/bin/env node` script and `harness shell-launch` in a pane run on a Node with no engine and no `npm` beside
it; the Node running the tests where no run made one (the unit specs that use `isolatedTmux`). The link stays a
symbolic link: it runs the copy, and the copy is what Node names.

- [ ] **Step 4: See it pass**

```bash
npx vitest run src/testing/testPath.spec.ts src/testing/isolatedTmux.spec.ts   # 5 and 7 passed
npm run typecheck                                                              # no error
```

- [ ] **Step 5: Commit**

```bash
git add cli/src/testing/testPath.ts
git commit -m "CLI e2e: a test root's node link names the run's Node"
```

---

### Task 3: A daemon under test runs on the run's Node, or does not start

**Depends on:** Task 1 (`assertNodeAlone`, and `E2E_NODE_PATH` in every end-to-end worker: without it every start
would throw) and Task 2 (the tile's half of the first case). **Effort:** xhigh (the Node of every daemon under test,
under the developer's login; no fallback).

**Files:**
- Modify: `cli/e2e/harness/daemon.ts` (the header `:1-12`, an import, `DaemonOptions.node` at `:88-89`, a comment
  above `fakeEngineShim` at `:260`, `start` at `:469-486`)
- Test: `cli/e2e/developerState.e2e.ts` (imports, three cases)

**The tests that fail before the change:** in `cli/e2e/developerState.e2e.ts`, "runs on a Node alone in its folder,
and so does node in its tiles", "refuses a Node beside other programs, and starts nothing" and "starts nothing when
the run gave it no Node, never falling back to the worker's".

**Interfaces:**
- Consumes: `assertNodeAlone(node)` (Task 1); `process.env.E2E_NODE_PATH` (Task 1); `<root>/tools/node`, a link to
  it (Task 2); `tile(d, client, name)` and `typed(d, pane, line, file)`, already in `developerState.e2e.ts`.
- Produces: `IsolatedDaemon.start` spawns `options.node`, or `E2E_NODE_PATH`; it throws
  `E2E_NODE_PATH is not set: run the end-to-end tests through vitest.e2e.config.ts` with neither, and what
  `assertNodeAlone` throws for either. In both it spawns nothing: `d.pid` stays `null` and `d.log()` empty.

**Local end-to-end run:** `e2e/developerState.e2e.ts` only. Its red run starts daemons as every file does today, and
one on the test's own copy of Node with an empty file beside it; nothing in it types or runs an engine.

- [ ] **Step 1: The three cases**

In `cli/e2e/developerState.e2e.ts`: `import { execFileSync } from 'node:child_process'` and
`import { placeNode } from '../src/testing/placeNode.js'` are added, `realpathSync` joins the `node:fs` import and
`dirname` the `node:path` one. The header gains one sentence: a daemon runs on a Node alone in its folder
(`src/testing/testNode.ts`). Last in the `describe`:

```ts
  // The product looks for npm-installed engines beside the Node it runs on, whatever PATH says (lib/engineLaunch.ts
  // `npmRuntimeBins`), and a version manager puts the developer's real engines there (audit of 2026-11-16,
  // docs/plans/2026-11-16-e2e-isolation-3-design.md). These read paths and listings, and run or type no engine.
  it('runs on a Node alone in its folder, and so does node in its tiles', async () => {
    const d = daemon = await IsolatedDaemon.create()
    failed(d)
    await d.start()
    // The core's line: the master names itself harnessd (process.title), which is all ps then shows of it, and it
    // starts the core on its own Node.
    const ran = execFileSync('ps', ['-o', 'args=', '-p', String(d.corePid())], { encoding: 'utf8' }).trim().split(' ')[0]
    // A yes or a no, and a count: at the base the folder is the developer's own, and the names in it their programs.
    expect(ran === process.env.E2E_NODE_PATH, 'the daemon runs on the run\'s Node').toBe(true)
    expect(dirname(ran) !== dirname(process.execPath), 'which is not beside the worker\'s').toBe(true)
    expect(readdirSync(dirname(ran)).filter((name) => name !== 'node' && !name.startsWith('libnode.')).length, 'programs beside the daemon\'s Node').toBe(0)
    const client = await LocalClient.connect(d)
    try {
      const { tmuxPane } = await tile(d, client, 'node')
      expect(await typed(d, tmuxPane, 'node -p process.execPath', join(d.root, 'node-path')) === `${ran}\n`, 'node in a tile is the daemon\'s Node').toBe(true)
    } finally { client.close() }
  })

  it('refuses a Node beside other programs, and starts nothing', async () => {
    // A Node of the test's own with a made-up program beside it, as a version manager's folder has: an empty file,
    // never executable, never run. By its real path: the refusal names the folder Node names itself by.
    const decoy = join(realpathSync(scratch), 'decoy')
    mkdirSync(decoy)
    placeNode(join(decoy, 'node'))
    writeFileSync(join(decoy, 'codex'), '')
    const d = daemon = await IsolatedDaemon.create({ node: join(decoy, 'node') })
    await expect(d.start()).rejects.toThrow(`${decoy} holds codex: a daemon under test must run on a Node alone in its folder`)
    expect([d.pid, d.log()]).toEqual([null, ''])
  })

  it('starts nothing when the run gave it no Node, never falling back to the worker\'s', async () => {
    // Created first: its tools folder already links the run's Node, and testPath.ts keeps what it found.
    const d = daemon = await IsolatedDaemon.create()
    for (const none of [undefined, '']) {
      vi.stubEnv('E2E_NODE_PATH', none)
      await expect(d.start()).rejects.toThrow('E2E_NODE_PATH is not set: run the end-to-end tests through vitest.e2e.config.ts')
    }
    expect([d.pid, d.log()]).toEqual([null, ''])
  })
```

- [ ] **Step 2: See them fail, and commit them**

```bash
cd cli && export TMPDIR=/private/tmp/claude-503/iso3-t3/ SHELL=/bin/zsh && mkdir -p "$TMPDIR"
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/developerState.e2e.ts -t 'Node alone in its folder|Node beside other programs|gave it no Node'
```

Expected: `3 failed | 9 skipped (12)`. The first on `the daemon runs on the run's Node: expected false to be true`;
the other two on a promise that resolved where a rejection was expected: the daemon started. None prints a path of
the developer's, and each daemon is closed by the file's `afterEach`.

```bash
git add cli/e2e/developerState.e2e.ts
git commit -m "CLI e2e: a daemon under test runs on a Node alone in its folder (red tests)"
```

- [ ] **Step 3: `IsolatedDaemon.start`**

In `cli/e2e/harness/daemon.ts`:

1. `import { assertNodeAlone } from '../../src/testing/testNode.js'`.
2. In `start`, with the two checks that open it and before anything is spawned:
   `const node = this.options.node || process.env.E2E_NODE_PATH`; with none, throw
   `E2E_NODE_PATH is not set: run the end-to-end tests through vitest.e2e.config.ts`; then `assertNodeAlone(node)`.
   The spawn takes `node`. `process.execPath` is no longer read there.
3. The comment there says why: the product looks for npm-installed engines beside the Node the daemon runs on
   (`lib/engineLaunch.ts` `npmRuntimeBins`), and on a developer's Mac that was the version manager's folder with
   their real engines in it, which `freshMachineEngines.e2e.ts`'s daemon would have found "already installed" (audit
   of 2026-11-16); why there is no fallback (it would reopen that without a word); that the check runs at every
   start and holds a test's own Node too. The master starts the core and the services on the same Node, and hooks
   are written with it.
4. `DaemonOptions.node`: "instead of the run's own (`E2E_NODE_PATH`)", and that it must be alone in its folder too.
5. Above `fakeEngineShim`, one line: the shims keep the worker's Node, since a fake engine looks up no engine.
6. The file's header gains a sentence: it runs on a copy of the worker's Node alone in its folder
   (`e2e/harness/testNode.ts`), so it finds no engine beside its Node.

- [ ] **Step 4: See them pass**

```bash
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/developerState.e2e.ts          # 12 passed
npx vitest run src/testing/daemonListeningPort.spec.ts src/testing/fakeCodexAppServer.spec.ts \
  src/testing/releaseFixtures.spec.ts src/testing/ghStub.spec.ts                                # 4, 2, 5 and 1 passed: they read daemon.ts
ls -d "$TMPDIR"harness-e2e-node-* 2>/dev/null | wc -l                                           # 0
```

A case of the first that now fails on `npm`, `npx` or another program "not found" took it from beside the worker's
Node: say which in the report. It is never fixed by putting that folder back.

- [ ] **Step 5: Commit**

```bash
git add cli/e2e/harness/daemon.ts
git commit -m "CLI e2e: a daemon under test runs on the run's Node, or does not start"
```

---

### Task 4: The test files that link a Node themselves link the run's

**Depends on:** Task 1 (`E2E_NODE_PATH` in every end-to-end worker, and `assertNodeAlone`). Not on Task 2 or 3:
none of its files is theirs, and `cli.e2e.ts`'s daemons never pass `IsolatedDaemon.start`. **Effort:** high.

**Files:**
- Modify, test: `cli/e2e/cli.e2e.ts` (an import after `:23`; `install()` at `:141-145`; the comment of the first
  case at `:171-172`; one new case after it)
- Modify: `cli/e2e/creationPaths.e2e.ts` (`:68`)
- Modify: `cli/e2e/freshMachineEngines.e2e.ts` (`:190`)

**The test that fails before the change:** in `cli/e2e/cli.e2e.ts`, "runs its core on the run's Node, alone in its
folder, behind the managed link". The two other links have no case of their own (PM): they are the same one-word
change, on a `node` that no case of those files reads; their files pass whole in Verification 3 and 4.

**Interfaces:**
- Consumes: `process.env.E2E_NODE_PATH` and `assertNodeAlone(node)` (Task 1); `install()`, `harness(m, ...args)`,
  `pidOf`, `statusOf`, `commandOf`, `said` and `seen`, already in `cli.e2e.ts`.
- Produces: nothing another task reads.

**Local end-to-end run:** two cases of `e2e/cli.e2e.ts` that make no harness. The red run starts one daemon from the
installed bundle on the worker's Node, as this file always has, and stops it; nothing in it launches, types or runs
an engine (decision 17). The rest of the file, `creationPaths.e2e.ts` and `freshMachineEngines.e2e.ts` are
Verification's, never this task's.

- [ ] **Step 1: The case**

In `cli/e2e/cli.e2e.ts`: `import { assertNodeAlone } from '../src/testing/testNode.js'` is added. After the case
"starts on an external Node reached through a managed-runtime symlink without relocating it":

```ts
  // The product looks for npm-installed engines beside the Node the daemon runs on, whatever PATH says
  // (lib/engineLaunch.ts `npmRuntimeBins`), and Node names itself by the real path behind the managed link: on a
  // developer's Mac that was a version manager's folder, with their real engines in it (audit of 2026-11-16,
  // docs/plans/2026-11-16-e2e-isolation-3-design.md). This reads one path and one listing, and makes no harness.
  it('runs its core on the run\'s Node, alone in its folder, behind the managed link', async () => {
    const m = await install()
    const started = await harness(m, 'start')
    expect(started.status, said(started)).toBe(0)
    const master = pidOf(m)!
    const core = (await statusOf(m)).corePid as number
    seen.add(master).add(core)
    // The core's line: the master names itself harnessd, which is all ps shows of it, and starts the core on its own Node.
    const ran = commandOf(core).split(' ')[0]
    // A yes or a no: at the base the path is the developer's own Node.
    expect(ran === process.env.E2E_NODE_PATH, 'the core runs on the run\'s Node').toBe(true)
    // Only after it: a refusal here names the run's folder, never the developer's.
    expect(() => assertNodeAlone(ran)).not.toThrow()
    expect((await harness(m, 'stop')).status).toBe(0)
  })
```

- [ ] **Step 2: See it fail, and commit it**

```bash
cd cli && export TMPDIR=/private/tmp/claude-503/iso3-t4/ SHELL=/bin/zsh && mkdir -p "$TMPDIR"
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/cli.e2e.ts -t 'behind the managed link'
```

Expected: `1 failed | 8 skipped (9)`, on `the core runs on the run's Node: expected false to be true` (about 22 s:
the file builds its own bundle). It prints no path of the developer's, and the file's `afterEach` ends the daemon.

```bash
git add cli/e2e/cli.e2e.ts
git commit -m "CLI e2e: harness start runs its core on the run's Node (red test)"
```

- [ ] **Step 3: The three links**

Each `symlinkSync(process.execPath, <link>)` becomes `symlinkSync(process.env.E2E_NODE_PATH!, <link>)`, with no
fallback (decision 16), and a comment that says why: Node names itself by the real path behind a link, and the
product looks beside that path for engines (audit of 2026-11-16, the design).

1. `cli/e2e/cli.e2e.ts:145`, in `install()`: the managed Node is a link to the run's Node
   (`e2e/harness/testNode.ts`). The comment at `:141` says so. The first case's comment at `:172` no longer holds
   ("the external interpreter running the fixture"): the managed path points at a Node outside the runtime folder,
   the run's, which is what that case needs.
2. `cli/e2e/creationPaths.e2e.ts:68`: `<root>/tools-without-tmux/node`.
3. `cli/e2e/freshMachineEngines.e2e.ts:190`, in `withoutCodex`: `<root>/bin/node`.

What stays `process.execPath` in the three files: the bundle build (`cli.e2e.ts:52`), the `#!` lines of the fake
platform tools and of the made-up `codex` files, and the CLI clients the tests spawn. They look up no engine.

- [ ] **Step 4: See it pass**

```bash
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/cli.e2e.ts -t 'behind the managed link|external Node reached through'
ls -d "$TMPDIR"harness-e2e-node-* 2>/dev/null | wc -l
```

Expected: `2 passed | 7 skipped (9)` (about 25 s), then `0`. The second case is the one whose comment changed: its
daemon still makes no `libexec/harnessd` name link, since the run's Node is outside the runtime folder too.

- [ ] **Step 5: Commit**

```bash
git add cli/e2e/cli.e2e.ts cli/e2e/creationPaths.e2e.ts cli/e2e/freshMachineEngines.e2e.ts
git commit -m "CLI e2e: the test files that link a Node themselves link the run's Node"
```

---

### Task 5: The spike stack makes the run's Node itself

**Depends on:** Task 1 (`setUpTestNode`). **Effort:** medium (mechanical, one file).

**Files:**
- Modify: `cli/scripts/spike-a-stack.ts` (an import after `:14`; `stop` at `:28-36`; the first line of the `try` at
  `:40`)

**The test that fails before the change:** none: no behavior a test reads. No test, typecheck or workflow loads
this script (`tsconfig.json` includes `src` only, and no package script names it), and it runs only against a real
backend with Mongo and Redis, which this Mac has not set up. A spec that read its text would pin words, not what it
does. One commit, no red.

**Interfaces:**
- Consumes: `setUpTestNode(): () => void` (Task 1, `cli/src/testing/testNode.ts`); `backend.stop()`, which closes
  the daemons it signed in before it stops its services.
- Produces: nothing another task reads.

**No local end-to-end run.** Step 2 starts no backend and no daemon.

- [ ] **Step 1: The change**

In `cli/scripts/spike-a-stack.ts`:

1. `import { setUpTestNode } from '../src/testing/testNode.js'`, with the other imports at the top: it loads
   nothing of Vitest, so it does not wait for the worker-state line.
2. `let removeTestNode = () => {}` beside `stopping`. In `stop`, `removeTestNode()` after `await backend.stop()`
   (the daemons are closed by then) and before `log('stopped')`.
3. First in the `try`, before the first `signIn`: `removeTestNode = setUpTestNode()`.
4. One comment there: a daemon under test starts only on the run's Node (`e2e/harness/daemon.ts` `start`), which
   Vitest's global setup makes and this script, outside Vitest, makes itself; and why here (decision 18).

Left as it is: the `node` link in bob's home (`:93`) and the guard's `process.execPath` (`:104`). They run CLI
clients for the desktop, which look up no engine (the spec's "What does not change").

- [ ] **Step 2: See it load, and leave nothing**

```bash
cd cli && export TMPDIR=/private/tmp/claude-503/iso3-t5/ && mkdir -p "$TMPDIR"
env -u SPIKE_OUT npx tsx scripts/spike-a-stack.ts; echo "exit $?"
env -u HARNESS_E2E_SERVICES_DIR SPIKE_OUT="$TMPDIR/out" npx tsx scripts/spike-a-stack.ts; echo "exit $?"
ls -d "$TMPDIR"harness-e2e-node-* 2>/dev/null | wc -l
```

Expected: `Error: Set SPIKE_OUT` and `exit 1`; a `TypeError` on `"paths[0]"` (no services folder: the backend
starts nothing) and `exit 1`; then `0`. This shows that the import resolves under `tsx` and that a backend that
cannot start leaves no Node. It does not run the new call: open question 1.

- [ ] **Step 3: Commit**

```bash
git add cli/scripts/spike-a-stack.ts
git commit -m "CLI e2e: the spike stack makes the run's Node itself"
```

---

## Left out

- `e2e/harness/outsideAgent.ts:77` links the worker's Node as a fake app's executable: no daemon, no pane. No other
  end-to-end file links the worker's Node (`grep` of `e2e/` at `ed79d28aa6`: the three of Task 4 and this one).
- A rule in code that no test file links the worker's Node: not asked for (Review Focus names the gap).
- The fake engines' shims and the CLI clients a test spawns with `process.execPath`: the spec keeps them. They look
  up no engine in their own process.
- `npm` on the tool list: never. A test that needs one writes its own in its `bin`.
- `e2e/nodeReferences.e2e.ts`: unchanged. Its own Node passes the guard as it is laid out.
- `e2e/harness/bundle.ts` and the files that build a bundle with `process.execPath`: the build looks up no engine.
- Windows: no end-to-end tests there, and the unit spec is skipped.
- `cli/AGENTS.md`: no text changes. Rule 6 already says a test never uses the developer's own machine.
- The unit suite: its specs already move `process.execPath` or stand in for `npmEngineBins`
  (`src/engines/kit/launchExecutable.spec.ts`).

## Verification

On the final head, after the review. Isolation is the repo's own (`cli/AGENTS.md`, rules 5 and 6), which this change
completes: every file boots its own daemons under a throwaway root, with a private tmux server and fake engines,
signed out, its backend at `127.0.0.1:9`. No real account, no production, nothing of the developer's daemon
(port 18473), `~/.harness`, `~/.claude` or `~/.codex`. None of these checks needs Diego himself.

**The order is the rule.** On this Mac real engines are beside the worker's Node. Each check starts only when the
one before passed on the same head, in the same shell session, by its exit status: checks 2 to 4 are one command
line, never a result read by eye. If one fails, stop and report: nothing after it runs. The one exception is said
at check 4: its last three runs wait for every gate, not for each other. Never
`npm run test:tmux-real`, `tmuxAgentDiscovery.real.spec.ts` or `agentBrowserPodman.e2e.ts` here.

Local checks run on this Mac (macOS, arm64, tmux, zsh), in `cli/`:

```bash
cd cli && export TMPDIR=/private/tmp/claude-503/iso3-v/ SHELL=/bin/zsh && mkdir -p "$TMPDIR"
node -p process.arch    # arm64. With x64 every end-to-end run stops at once, by design: switch to the arm64 Node first.
```

1. **The unit specs and the typecheck.**

   ```bash
   npx vitest run src/testing/testNode.spec.ts src/testing/testPath.spec.ts src/testing/placeNode.spec.ts \
     src/testing/socketPathRoom.spec.ts src/testing/isolatedTmux.spec.ts src/testing/daemonListeningPort.spec.ts \
     src/testing/fakeCodexAppServer.spec.ts src/testing/releaseFixtures.spec.ts src/testing/ghStub.spec.ts
   npm run typecheck
   ```

   To see: 9 files passed, `44 passed` (the base: 8 files, 36): `testNode` 7, `testPath` 5, the rest as before. The
   typecheck prints no error.

Checks 2 to 4, one line:

```bash
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/developerState.e2e.ts && \
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/freshMachineEngines.e2e.ts && \
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/leftBehind.e2e.ts e2e/nodeReferences.e2e.ts && \
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/cli.e2e.ts -t 'behind the managed link' && {
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/cli.e2e.ts
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/creationPaths.e2e.ts
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/enginehomes.e2e.ts
}
```

The four runs before the brace are the gates: each starts only when the one before passed. The three inside it
start only when all four passed, and then each runs whatever the one before it did: the harness-making cases of
`cli.e2e.ts` and `creationPaths.e2e.ts` were not run on this Mac in planning, `enginehomes` is known not to be clean
here, and one's red must not hide another's result. `enginehomes` is last.

2. **The developer's state, first of the end-to-end checks:** `e2e/developerState.e2e.ts`. To see:
   `Tests 12 passed (12)`, "runs on a Node alone in its folder, and so does node in its tiles" among them. At the
   base the same file, with these cases, is `3 failed | 9 passed (12)`.

3. **The file that reached the real `codex`:** `e2e/freshMachineEngines.e2e.ts`, which starts only because check 2
   exited 0. To see: `Tests 7 passed (7)` (a case is skipped on a machine with a `node`, `npm` or `codex` in its
   system folders; this Mac has none). Its three cases that take Codex away assert the daemon's own
   `Installing Codex.` or `Downloading Codex.` line: a daemon that found a Codex beside its Node fails them there.
   Its own `node`, first on its panes' `PATH`, is the run's Node too (Task 4). A red in this file is a finding:
   stop, report it, and run nothing after it.

4. **The other files the spec names, and the one Task 4 adds.** To see, in this order:
   - `leftBehind` 8 and `nodeReferences` 2 passed (a worker outside Vitest inherits the run's Node; a test's own
     Node passes the guard).
   - `cli.e2e.ts`, its new case alone first: `1 passed | 8 skipped (9)`. Its daemons take `harness start`'s door,
     which `developerState` does not prove, so this case is the file's own gate (decision 14): the core runs on the
     run's Node, alone in its folder. A red in it stops the line. Then the whole file: `Tests 9 passed (9)` (the
     base: 8), six of them making a fake `claude` harness on a daemon from the installed bundle. A red there is a
     finding, reported with its case's name and the daemon log the file prints.
   - `creationPaths.e2e.ts` (decision 19): 5 cases, each making a fake `claude` or `codex` harness. To see:
     `5 passed`. Its result here from sources is not known; a case that holds on
     `the native control helper is unavailable` is reported with that line and its name, as below, never as passed.
   - `enginehomes.e2e.ts`, last (PM): it types the fake `claude` and `codex` into tiles, and its result here is not
     clean. 34 cases, as #4345 recorded it on this Mac: `28 passed | 6 failed`, the six Codex cases that hold on
     `the native control helper is unavailable` in their daemon's log (a daemon run from sources on macOS has no
     such helper). Each is reported with that line and its name, never as passed; any other red is a finding. About
     20 minutes on a busy Mac.

5. **The cost, before and after.** Two numbers for the pull request.

   ```bash
   cat > "$TMPDIR/run-node-time.mts" <<'EOF'
   import { join } from 'node:path'
   import { pathToFileURL } from 'node:url'
   const { setUpTestNode } = await import(pathToFileURL(join(process.argv[2], 'src/testing/testNode.ts')).href)
   const times: number[] = []
   for (let run = 0; run < 5; run++) { const from = performance.now(); const remove = setUpTestNode(); times.push(performance.now() - from); remove() }
   times.sort((a, b) => a - b)
   console.log(`the run's Node, copied and started once, 5 runs: median ${times[2].toFixed(0)} ms, fastest ${times[0].toFixed(0)} ms, slowest ${times[4].toFixed(0)} ms`)
   EOF
   npx tsx "$TMPDIR/run-node-time.mts" "$PWD"
   mkdir -p /private/tmp/claude-503/iso3-base && git -C .. archive 8fcfa7de5c cli | tar -x -C /private/tmp/claude-503/iso3-base
   ln -s "$PWD/node_modules" /private/tmp/claude-503/iso3-base/cli/node_modules
   (cd /private/tmp/claude-503/iso3-base/cli && caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/shells.e2e.ts e2e/dotfiles.e2e.ts)   # before
   caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/shells.e2e.ts e2e/dotfiles.e2e.ts                                               # after
   rm -rf /private/tmp/claude-503/iso3-base
   ```

   To see, and to put in the pull request: the script's line (in planning: median 1245 ms, once for each run), and
   Vitest's `Duration` of the two runs, 10 cases each, with the machine's load beside them. The two files change in
   no task and type no engine's name. A copy of `cli/` alone runs from sources, as `developerState.e2e.ts` did in
   planning; it cannot build a bundle, so no `E2E_BUNDLE` there. The cost for each daemon start is one
   `readdirSync`.

6. **Nothing left.** After checks 2 to 5, by this run's own folder, counted and never listed:

   ```bash
   run="$(cd "$TMPDIR" && pwd -P)"
   ls -d "$run"/harness-e2e-node-* 2>/dev/null | wc -l
   ps -A -o command= | awk -v node="$run/harness-e2e-node-" 'index($1, node) == 1' | wc -l
   ps -A -o command= | awk -v root="$run/htmux-" 'index($0, root) && $1 != "awk"' | wc -l
   ```

   To see: `0` three times. Every daemon of these runs ran on a Node in this folder, so the second line counts any
   that is left by its own first word. A number above that is reported with the pids, and they are ended only if
   this run started them.

On GitHub, by hand, **one run, only on a runner turn from the orchestrator**, after the branch is pushed (shared
runners, `docs/validation-and-release.md`). Report the run's link.

7. **The whole suite on Linux, and the full disk on macOS:** the existing workflow, eight Linux shards and one macOS
   runner. The change reaches every daemon under test.

   ```bash
   gh workflow run cli-e2e.yml --ref fix/e2e-isolation-3
   ```

   To see: `e2e (1)` to `e2e (8)`, `e2e (macOS, full disk)` and `e2e-summary` green; `developerState.e2e.ts` 12 of
   12, `freshMachineEngines.e2e.ts` 7 of 7, `nodeReferences.e2e.ts` 2, `leftBehind.e2e.ts` 8, `cli.e2e.ts` 9 of 9,
   `creationPaths.e2e.ts` 5 of 5, `enginehomes.e2e.ts` 33 passed and 1 skipped, as in #4345's run. There every
   daemon starts from the run's bundle (`E2E_BUNDLE`), `cli.e2e.ts`'s installed copy of it among them. It proves the
   plain copy on Linux (no clone), a runner's Node whose
   own folder holds `npm`, `npx` and `corepack`, that no file took a program from beside the daemon's Node, and on
   the macOS runner the clone and its first start. Each job's wall time is set beside the same job of run
   43746252131 (decision 13) in the pull request. A red test is reported with its link and whether main's last
   nightly run has it too. A file that fails for want of `npm` or another program beside the Node writes its own in
   its `bin`, test first, in this pull request; the worker's folder is never put back. The orchestrator decides on
   the rerun.

Not checked, and said so in the pull request, each an unverified row, never a passing one:
`cli/scripts/spike-a-stack.ts` against a backend (open question 1: what is shown instead is that it loads, Task 5;
that `setUpTestNode` works outside Vitest under `tsx`, check 5's script; and a daemon's start on that Node,
check 2); a real x86_64 Node under Rosetta (Review Focus); Homebrew's own Node; the new `developerState` and
`cli.e2e.ts` cases on a second Mac (the macOS job runs two other files).

**Temporary workflow:** none in the draft. The long check has a workflow already (`.github/workflows/cli-e2e.yml`,
run by hand from a branch and every night), which finds the new cases by itself. The spike script has none: whether
it gets a temporary one is open question 1.

**A check that keeps running:** the same workflow holds the four new cases every night on Linux, and pull request
CI runs `testNode.spec.ts` and `testPath.spec.ts` on every pull request. A Mac-only break of the copy stops a
developer's next local run at its first step, by name. No question for Diego.

**Beside the end-to-end checks:** pull request CI runs by itself what a `cli/` change selects, `cli-typecheck` and
`cli-tests` first. **Checks PR CI does not run:** none for these paths (`scripts/local-checks.py --list` names
none). `npm run test:core` and `test:harnessd` are not needed: nothing under `cli/src/core`, `cli/src/services` or
`cli/src/harnessd` changes.
