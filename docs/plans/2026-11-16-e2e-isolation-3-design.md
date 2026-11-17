# E2E isolation, part 3: no e2e daemon or pane finds an engine beside the worker's Node: design

Part 2 (#4345, merged 706a43ad1d, `docs/plans/2026-11-15-e2e-isolation-2-design.md`) made the `PATH` of everything an
end-to-end test starts an allowlist. Its PR named one hole left open, on `main` before it too. This change closes it.

## Problem

A daemon under test runs on the Node the test worker runs on: `IsolatedDaemon.start` spawns `process.execPath`. The
product looks for npm-installed engines beside the Node it runs on, whatever `PATH` says:

1. **The daemon's executable search.** `captureLaunchExecutable` (`src/engines/kit/launchExecutable.ts`) adds
   `npmEngineBins()` to the candidates of every npm engine without an `<ENGINE>_PATH` override. Its first folders are
   `npmRuntimeBins()`: `dirname(managedNodePath())` and `dirname(baseNode(process.execPath))`. With no `current-node`
   in the daemon's runtime folder (none in a test), both are the worker's Node folder.
2. **The pane's launch script.** `npmRuntimePrelude` (`src/lib/engineLaunch.ts`) puts the first of those folders that
   holds `node` and `npm` first on the pane's `PATH` when `npm` is not on it. `npm` is not in `<root>/tools`
   (`src/testing/testPath.ts`), so the prelude fires for every npm engine with no override (OpenCode, Pi, Command Code,
   Kilo, OpenClaw, Copilot), and `command -v <engine>` in that pane then finds the worker folder's engine. The same
   script's `npm prefix -g` fallback asks that folder's `npm`, which names the same prefix.
3. **`harness shell-launch` in a pane** (`src/shellLaunch.ts`, the shell's `cm` helper) builds the same script in a CLI
   process. In a test pane that process runs on `node` by name, `<root>/tools/node`, a symbolic link to the worker's
   Node. Node names itself by the real path (`process.execPath` follows the link; checked here), so its
   `managedNodePath()` is the worker's Node too.

On a developer's Mac the worker's Node is usually a version manager's (`~/.nvm/versions/node/<v>/bin/node`), and npm
puts globally installed engines in that same folder. On Diego's Mac that folder holds real `codex`, `cmd`,
`command-code`, `commandcode`, `cmdc`, `kilo` and `kilocode` (listed here, none run). `freshMachineEngines.e2e.ts`
deletes `CODEX_PATH` to test the install flow, so by the code its daemon finds that real `codex` "already installed"
and would launch it under the developer's login. CI's runner has no engine beside its Node, which is why CI never saw it.

## Goal

No daemon, service or pane an end-to-end test starts can find or run an engine beside the worker's Node, on any
developer's machine, for every engine the product supports today or later. The tests that need an engine "not
installed" (`freshMachineEngines.e2e.ts` and the others that delete or never set an `<ENGINE>_PATH`) keep working
unchanged.

## Options weighed

| Option | Closes 1 | Closes 2 | Closes 3 | Cost |
|---|---|---|---|---|
| A. Pin every `<ENGINE>_PATH` in `IsolatedDaemon` | only for pinned engines | only for pinned engines | no | A pinned override skips the recipe, so the install flow (`freshMachineEngines`) needs it deleted, which reopens the hole for that engine. Every new engine must be added by hand. |
| B. Run the daemon (and the panes' `node`) on a copy of the worker's Node in a folder that holds nothing else | yes | yes | yes | Test harness only. One copy and one first start per run (below). |
| C. Take the lookup folder from a variable the harness sets | yes | yes | yes | A product switch that exists only for tests (code standard 1), read by `lib/engineLaunch.ts`, which the core loads. |

**B is chosen** (PM, 2026-11-16). It changes no product code and needs no list, so an engine added later is covered too.

Why a copy and not a link:
- A symbolic link does not move `process.execPath`: Node reports the real path (checked here: a link's
  `process.execPath` is the nvm path).
- A hard link does, but `src/testing/placeNode.ts` records why tests never hard-link the running Node: macOS may name a
  hard-linked file by any of its links, and Homebrew's Node then failed to load its `libnode` anywhere on the Mac (#4395).
- `placeNode` already makes the copy safely (a clone where the filesystem can, `libnode` linked beside it for Homebrew's
  Node, a Rosetta Node refused by name), and `nodeReferences.e2e.ts` uses it.

## Change

### The run's Node (`src/testing/testNode.ts`, run by the global setup `e2e/harness/testNode.ts`)

The logic lives in `src/testing/testNode.ts`, so the unit suite tests it; `e2e/harness/testNode.ts` only calls it. A new global setup in `vitest.e2e.config.ts` (and so `vitest.e2e.ci.config.ts`), beside `socketRoom.ts` and
`bundle.ts`, run once per run before any worker starts:

- makes `mkdtemp(<os.tmpdir()>/harness-e2e-node-)` and, in it, `bin/node` with `placeNode` (clone or copy, `libnode`
  links beside it where the worker's Node has them);
- runs that copy once (`node -e ''`, 60 s timeout) so a copy that cannot start fails the run before any test, with an
  error that names the worker's Node and the reason;
- sets `process.env.E2E_NODE_PATH` to it (the workers inherit it, as `E2E_BUNDLE_PATH`);
- returns a teardown that removes the folder.

A Node that Rosetta runs (x86_64 on Apple Silicon) is refused by `placeNode`'s `RosettaNodeError` before anything is
copied: the whole run stops at once with its message ("Run the tests with an arm64 Node"). Today such a run already
fails in the tests that copy a Node; after this, every e2e run does. This is a change for developers only (accepted by the PM, 2026-11-16).

### The daemon runs on it (`e2e/harness/daemon.ts`)

- `IsolatedDaemon.start` spawns `this.options.node ?? process.env.E2E_NODE_PATH`. With neither set it throws
  `E2E_NODE_PATH is not set: run the end-to-end tests through vitest.e2e.config.ts` and starts nothing. There is no
  fallback to `process.execPath`: a fallback would reopen the hole without a word.
- Before every spawn it checks the folder of the Node it is about to run: it holds only `node` and `libnode.*`
  entries. Anything else throws `<folder> holds <names>: a daemon under test must run on a Node alone in its folder`.
  This also holds a test's own `options.node` (`nodeReferences.e2e.ts`'s copy under its runtime folder passes).
  It is one `readdirSync` per start.

Every process the daemon starts follows: the master starts the core and the services on
`baseNode(process.execPath)`, hooks are baked with `managedNodePath()`, both the copy.

### The panes' `node` is the same copy (`src/testing/testPath.ts`)

`workerTools()` links `<root>/tools/node` to `process.env.E2E_NODE_PATH` when it is set, and to `process.execPath`
otherwise (the unit specs that use `isolatedTmux`, which run no daemon and no engine). So `#!/usr/bin/env node`
scripts and `harness shell-launch` in a test pane also run on the copy, and their `managedNodePath()` is a folder with
no engine and no `npm`. `<root>/tools/node` stays a symbolic link: it runs the copy, and the copy is what Node names.

### Test files that link the worker's Node themselves (PM, 2026-11-16, after the 3-minute timer)

Three test files make their own `node` link (a fourth, a wrapper, below) to `process.execPath`, outside `IsolatedDaemon.start`:
- `e2e/cli.e2e.ts:145` runs `harness start` on `<runtime>/node-e2e/bin/node`, a symbolic link to the worker's Node,
  recorded in `current-node`. Node names itself by the real path, so that daemon's `baseNode(process.execPath)` is the
  worker's Node folder again.
- `e2e/creationPaths.e2e.ts:68` and `e2e/freshMachineEngines.e2e.ts:190` put a `node` link to the worker's Node first
  on a pane's `PATH`.

The final review found a fourth: `e2e/tuiShell.e2e.ts` writes a `harness` wrapper into `<root>/bin` that ran
`process.execPath`, and a fleet pane runs `harness shell-launch` through it.

All four use the run's Node (`E2E_NODE_PATH`) instead. `cli.e2e.ts` gets a case that the core `harness start` runs is
on the run's Node, red on the base.

### A script outside the suite (PM, 2026-11-16)

`cli/scripts/spike-a-stack.ts` starts `IsolatedDaemon`s under `tsx`, outside Vitest. It calls `setUpTestNode()` itself
first and its teardown at the end, so it keeps working.

### What does not change

- No product file changes: `src/` outside `src/testing/` is untouched.
- The fake engines' shims keep `#!${process.execPath}` (the worker's Node): they look up no engine.
- `npm` stays off the tool list. With the copy's folder holding no `npm`, `npmRuntimePrelude` finds nothing to add, and
  a launch of a missing npm engine says "npm is unavailable", as on a fresh computer, unless the test writes its own
  fake `npm` in its `bin` (as `freshMachineEngines.e2e.ts` does).
- Test-side CLI clients spawned with `process.execPath` (`spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts',
  ...])` in many files) keep the worker's Node. They talk to the daemon; the commands they run (`new`, `ls`, `send`,
  ...) look up no engine in their own process. `shell-launch` is the one CLI command that does, and only a pane runs it.

## Cost

Measured here (arm64 Node 22.23.5, 113 MB, APFS, load around 68 on 10 cores): a clone takes 68-79 ms and its first
start 1.0-1.5 s; later starts take 28 ms, as the original's do. That is paid once per run, not per daemon. On CI's
Linux the copy is a plain copy of the Node (about 120 MB, once per run). Per daemon start the cost is one `readdirSync`.
The plan's tester records the e2e run's wall time before and after on the same files.

## Tests (red first, made-up values only)

No red or green run starts a real engine. Every check below reads paths and folder listings; none types or runs an
engine's name.

- `src/testing/testNode.spec.ts` (unit): the setup makes a folder
  whose `bin` holds `node` and nothing but `libnode.*` links; the copy runs and its `process.execPath` is that path;
  `E2E_NODE_PATH` names it; the teardown removes the folder; a Rosetta machine (passed in) is refused and leaves no
  folder. Red: the file does not exist.
- `src/testing/testPath.spec.ts`: with `E2E_NODE_PATH` stubbed to a made-up node file, `<root>/tools/node` links to it;
  without it, to `process.execPath`. Red on the base (it links `process.execPath` always).
- `e2e/developerState.e2e.ts`, a new case **the daemon runs on a Node alone in its folder**: the folder of the daemon
  process's executable (`ps -o args= -p <pid>`, first word) is not `dirname(process.execPath)` and holds only `node` and
  `libnode.*`; a terminal tile's `node -p process.execPath > <root>/node-path` names the same copy. Red on the base: the
  daemon runs `process.execPath`, whose folder holds `npm` and `npx` on every Node install (CI's included).
- `e2e/developerState.e2e.ts`, a new case **a daemon refuses a Node beside other programs**: `IsolatedDaemon.create({
  node: <decoy>/node })` with a made-up `codex` file (never executable, never run) beside a copy of the Node in
  `<decoy>`: `start()` rejects with the folder and `codex` named, and no daemon process exists. Red on the base (it
  starts).
- With `E2E_NODE_PATH` unset (`vi.stubEnv`), `start()` rejects with the setup's name. In the same file. Red on the base.

## Verification

- Locally on this Mac (arm64), in this order, each only after the one before passed:
  1. the unit specs above and `npm run typecheck`;
  2. `e2e/developerState.e2e.ts`;
  3. `e2e/freshMachineEngines.e2e.ts`: all cases pass. This is the file that, by the code, reached the real `codex`; it
     runs only after step 2 proved the daemon's Node folder holds nothing but `node`, and the start-time check refuses
     any other.
  4. `e2e/leftBehind.e2e.ts`, `e2e/nodeReferences.e2e.ts` (its own `options.node`), `e2e/cli.e2e.ts`, and last
     `e2e/enginehomes.e2e.ts` (it types the fake `claude` and `codex` into tiles), each only in the same command line after
     `developerState.e2e.ts` passed (PM, 2026-11-16).
- On GitHub (a runner turn from the orchestrator): the whole `cli-e2e.yml` run, Linux shards and macOS, on the final
  head; its wall time against #4345's run.

## Failure cases

- A Node whose copy cannot start (a Node built against a library it finds only beside its own path, other than the
  `libnode` that `placeNode` links): the run fails before any test, naming the worker's Node and the copy's error.
- A run killed before teardown leaves `harness-e2e-node-*` in the temporary folder (a clone on APFS takes no space; on
  Linux about 120 MB), as a killed run already leaves `harness-e2e-bundle-*`.
- A test that runs `IsolatedDaemon` outside the e2e configs gets the "not set" error at `start()`, not a daemon on the
  worker's Node.

## Platforms

macOS and Linux, where the end-to-end suite runs. Windows runs no end-to-end tests (no tmux).
