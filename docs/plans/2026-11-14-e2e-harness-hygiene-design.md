# CLI end-to-end harness hygiene: nothing left behind, a bounded backend call, a socket path that fits

Three defects in the CLI end-to-end harness (`cli/e2e/`), fixed in one pull request. Ken's rule holds throughout: a
failing or flaky test is a bug, fixed at the layer where it lives with a red-then-green test, never skipped or loosened.

Platforms: macOS and Linux, where the end-to-end suite runs (Windows does not run it). Only test code changes, plus the
fake engine; no product code.

## 1. Every test ends every process and folder it started

### What was seen

- `masterIpcExit.e2e.ts` leaves two fake `codex app-server` processes and a ~19 MB `runtime/grid-0.3.63-darwin-arm64`
  folder in its throwaway root after it finishes.
- Every `agentBrowser.e2e.ts` run leaves one fake `podman events` process (the fake's `events` branch,
  `agentBrowser.e2e.ts:45`, sleeps forever).
- On this Mac on 2026-11-14: 14 orphaned fake `codex app-server` pairs (parent 1, a process group of their own, their
  executable in a removed `htmux-*` root), one fake `podman events`, and ten `htmux-*` roots holding only
  `runtime/grid-0.3.63-darwin-arm64` (19,168 KB each), written about three minutes after the roots' other contents were
  removed.

### Why

- **Children in a group of their own escape the close.** `IsolatedDaemon.close()` (and the worker's reaper) end the
  daemon's process groups. The product starts some children in a group of their own (`ownProcessGroup()`): Codex's
  rate-limit read runs `codex app-server` (`src/lib/codexRateLimits.ts`), the agent browser runs `podman events`
  (`src/services/agentBrowser/podman.ts`). When their parent dies before ending them (a daemon closed inside the read's
  10 s window, or `agentBrowser.e2e.ts` SIGKILLing the browser's process), nothing ends them.
- **The fakes never end on their own.** Real `codex app-server` is a JSON-RPC server on stdio and exits when its stdin
  ends; the fake has no `app-server` branch, falls into its TUI and ignores the end of stdin. The fake `podman events`
  sleeps forever.
- **A daemon under test can download grid from the internet.** `ADAPTER_GRID_RUNTIME_METADATA_URL` keeps its real
  default in the harness's environment, so a daemon that installs or follows a managed grid (`ensureManagedArchive`,
  `src/lib/runtimeInstall.ts:225`) fetches the 19 MB release into its root's `runtime/`. A download that finishes after
  `close()` removed the root brings the folder back, and nobody removes it. The harness already points the backend and
  web URLs at `127.0.0.1:9` so that nothing reaches beyond the machine; the grid manifest was missed. Which path starts
  the download under `masterIpcExit.e2e.ts` is not shown in the code (it is not `start --repair`, and the test only
  creates a Claude agent); the plan's grid task finds it with a local manifest server that counts requests, and the
  red test is written against that path. A second way out sits behind the first: with no managed grid after the
  manifest was asked, the models service's `installCli` (`src/services/models.ts`) goes on to grid's public installer
  (`curl -fsSL https://grid.autonomous.ai/install.sh | bash`, `src/lib/gridInstall.ts`), so a manifest that cannot be
  read would, alone, trade one download for another.

### Fix

1. **The close ends what escaped its groups.** After the groups are ended and the tmux server is stopped (it names the
   root too), the close of the daemon that owns the root (not one `beside` it, which shares the root) ends every process
   still running whose command line contains `<root>/` (every fake engine, `podman` and `gh` the daemon can start lives
   under it), read with `processTable()` (`src/testing/spawnedRuns.ts`), then removes the root. A match that leads a
   process group (pid = pgid) gets its whole group signalled: the fake engine renames its own title, so the fake Codex's
   child (`node …/fakeEngine.mjs app-server`) never names the root and is reached only through its group. A match that
   leads no group is signalled alone, never its group: the test's own `tmux -S <root>/…` calls run in the Vitest
   worker's group. The worker's reaper (`reaperProcess.mjs`) does the same for a root it removes, so a killed worker
   leaves none either. The root's path is unique (`mkdtemp`), so no stranger matches it.
2. **The fake `codex app-server` behaves as the real one does:** `codex app-server` and `codex app-server -c …` (as
   `src/engines/codex/providerMove.ts` runs it), handled before the fake records its launch argv, read JSON-RPC lines on
   stdin, answer none (as today), and exit when stdin ends. A rate-limit read then no longer appears in the fake's
   `launch-argv`; the plan checks the tests that read it (`modelSwitch.e2e.ts`) still hold.
3. **Nothing reaches the grid release server or grid's installer.** The harness's daemon environment
   (`e2e/harness/daemon.ts`) sets `ADAPTER_GRID_RUNTIME_METADATA_URL` to `http://127.0.0.1:9/grid.json`, as it sets the
   backend's, and beside it `DISABLE_GRID_INSTALL` to `true`, the product's own switch (`src/config/env.ts`, read in
   `src/lib/gridInstall.ts`), so no path goes on from the unreadable manifest to the public installer. A test's own
   environment still wins: a test that needs a grid manifest already sets its own (`update.e2e.ts`, `fleet.ts`, …).

The fake `podman events` stays as it is: with fix 1 the close ends it. A real `podman events` outliving a crashed
agent-browser process on a person's computer is a product question outside this task; it goes to the PM as a proposal.

### Tests (red first)

In `e2e/leftBehind.e2e.ts`, which already holds "a daemon under test outlives nothing of the run's":
- a daemon whose engine-side child in a group of its own outlives its parent (the agent browser's `podman events`
  after its process is SIGKILLed, or a Codex rate-limit read cut by the close): after `close()` no process names the
  root, and the root is gone;
- a daemon under test asks no grid manifest and runs no grid installer beyond the machine, on the path the plan's
  grid task finds; its environment carries both values, and a test's own still wins.
And a fake-engine check that `codex app-server` exits when its stdin ends.

## 2. `backend.api` is bounded

`cli/e2e/harness/realBackend.ts` `backend.api` calls `fetch` with no timeout: a backend that stops answering hangs the
test until Vitest's 180 s test timeout, with no word on which call. Fix: `AbortSignal.timeout(30_000)` on the call, and
on timeout an error that names the method, the path and the limit
(`the test backend did not answer POST /api/machines/resolve-computer within 30000 ms`). The timeout covers reading the
body too: `r.json().catch(() => null)` must not swallow it. Red first: a spec against a
local server that accepts and never answers.

## 3. A TMPDIR too long for the daemon's socket fails at once, saying so

A daemon's Unix socket lives in its data folder under the test root (`<TMPDIR>/htmux-XXXXXX/data/daemon-<port>.sock`,
or `…/b<n>/d/…` beside another), and a socket path has room for 96 bytes (`src/lib/localSocket.ts`). Under a long
`TMPDIR` the path does not fit; the daemon falls back to its home's short folder, which is under the same root and too
long as well, and the test fails later with `EINVAL connect` on a path of 102 bytes and no word of why.

The paths, for a root of R bytes (`realpath(os.tmpdir())`, since macOS's `/var` is `/private/var`, plus 13 for
`/htmux-XXXXXX`): the data folder's socket R+23, a beside daemon's R+23 to R+24, tmux R+17 to R+18; the bridge socket
(R+38) has a fallback of its own and the short-folder fallback (R+51) is always longer than the direct path, so neither
decides. The data folder's socket is the one that must fit.

Fix: the run fails at once. A global-setup file of its own, listed before `e2e/harness/bundle.ts` in
`vitest.e2e.config.ts`, measures the data folder's socket path under `realpath(os.tmpdir())` and, when it is over 96
bytes, stops the run before any test with:
`TMPDIR is too long for the daemon's Unix socket: <path> would be <n> bytes; a socket path has room for 96. Run with a
shorter TMPDIR, for example TMPDIR=/tmp npm run test:e2e.`
`IsolatedDaemon.create` runs the same check on the data folder the harness itself gives a daemon (`<root>/data`, or
`<root>/b<n>/d` beside another), so a daemon created outside the suite's setup fails the same way. A data folder a
test passes itself (`options.dataDir`) is not measured: where it sits is that test's subject, and `noSocket.e2e.ts`
passes one too long on purpose, to see the daemon serve on its port alone. No option says which is which: the harness
tells from whose folder it is.

Picking a short folder automatically was the other choice; it is not taken because a sandboxed agent's long TMPDIR is
often the only folder it may write, and a folder outside it would fail later and less clearly.

Red first: a spec of the check (a long folder fails with that message; the default macOS and Linux TMPDIRs pass).

## Out of scope

- Product changes. The real `podman events` outliving a crashed agent-browser process is a proposal to the PM.
- Other unit-suite leftovers in TMPDIR (`grid-credential-*`). The three `adapter-test-*` folders `cli/vitest.setup.ts`
  makes for every file, end-to-end ones included, are in scope (Task 9): the setup removes them when the file ends.

## Verification

- Locally under `caffeinate`: `masterIpcExit.e2e.ts`, `agentBrowser.e2e.ts` and `leftBehind.e2e.ts`, each with a
  process and folder census before and after (nothing new naming an `htmux-` root, no root left).
- `cli-e2e` on GitHub once, on the orchestrator's go.
