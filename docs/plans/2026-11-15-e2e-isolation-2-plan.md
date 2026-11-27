# CLI end-to-end, part 2: nothing of the developer's reaches a test's tmux server, panes or engines, and nothing outlives its test: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **diegodev phase 3**. Every task is test-first: a red commit (the
> tests alone), then the code commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No process an end-to-end test starts (the daemon, a tmux server, the shells in its panes, the fake engines
and their hooks) sees the developer's environment, dotfiles, credentials or real engines; the fake engines win on
`PATH` in a pane's login shell and no other engine is found by name, as on CI; and once a test's teardown has run,
nothing is left that names its root or has its working folder inside it.

**Architecture:** Test harness only. A new `cli/src/testing/testPath.ts` makes `<root>/tools`, a link for each tool
the tests and the daemon run by name, and the `PATH` that holds it and the system's folders, never a folder of the
worker's own `PATH`. `isolatedTmux` (`cli/src/testing/isolatedTmux.ts`) builds its environment from #4318's allowlist,
that `PATH` and a home of its own in the root, so a tmux server the test starts is as clean as one the daemon starts.
`IsolatedDaemon.create` (`cli/e2e/harness/daemon.ts`) shares that home and that `PATH` behind its own `bin`, pins
`SHELL`, `TEMP` and `TMP`, and writes two zsh startup lines that give a login shell back the `PATH` it was handed.
The teardown sweep (`cli/src/testing/rootProcesses.ts`, and its copy in `cli/e2e/harness/reaperProcess.mjs`) also ends
a process whose working folder is in the root, behind a check that the root is one a test made.

**Tech Stack:** TypeScript, plain Node (`reaperProcess.mjs`), Vitest 4.1, Node (v22.21.1 on this Mac; CI pins
24.22.2), tmux 3.6b, zsh, `lsof` (macOS) and `/proc` (Linux). No new dependency.

**Spec:** [docs/plans/2026-11-15-e2e-isolation-2-design.md](2026-11-15-e2e-isolation-2-design.md). Read it with this
plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority. Part 1 (#4318,
[its plan](2026-11-15-e2e-daemon-isolation-plan.md)) is merged; this branch is on `main` at `d5202f76b9`.

## Decided

By the PM, final:

- **`SHELL` is pinned to `/bin/zsh` in `IsolatedDaemon.create`** (option A). No fallback shell: every end-to-end job of
  `cli-e2e.yml` installs zsh, and macOS ships it. A machine without `/bin/zsh` fails at `create` with a named error,
  after closing and forgetting the tmux `isolatedTmux` made (not for a daemon `beside` another).
- **`TEMP` and `TMP` are pinned to the daemon's `TMPDIR` folder.** Windows' `os.tmpdir()` reads them, and the
  allowlist dropped them. Not on the allowlist. The existing first case of `developerState.e2e.ts` asserts both.
- **`PATH` is an allowlist too** (the spec's Change 4): `<root>/tools` links to eight named tools resolved once for
  each worker; `<bin>:<root>/tools:/usr/bin:/bin:/usr/sbin:/sbin` for a daemon, without `<bin>` for a tmux server a
  test starts; a tool the worker lacks is left out and never fails `create`; the list never holds an engine's name,
  held by a unit test against `ENGINE_CLI_COMMANDS` and the aliases beside it. A task audits every command the
  end-to-end files and the daemon run by name, to complete the list, each with its reason, and checks the recipe path
  `/usr/local/bin/hermes`.
- **The startup lines give a login zsh back the whole `PATH` it was handed**, not only its first folder.
- **The `isolatedTmux` callers under `src/lib` and `src/testing` change only in what environment they pass.** No test
  changes what it asserts. Each caller and its exact change is in the table of Task 3.
- **The working-folder sweep has two guards, each with a unit test in both copies** (`rootProcesses.ts` and
  `reaperProcess.mjs`): the root is checked to be a folder a test made before anything is read or signalled (it throws
  and signals nothing); only the account's own processes are in the folder map, a folder matches only as the root or
  under the root plus `/`, and the sweep's own pid, its parent and pid 1 are never matched.
- **No red or green run starts a real engine.** The PATH tests ask the shell where a name resolves (`whence -p`) and
  never type it. On this Mac, where real engines are in `/usr/local/bin` and in the developer's own folders, a file
  that types an engine's name runs only after `e2e/developerState.e2e.ts`'s PATH cases are green.
- **No process outside a test root is killed or touched.** The real engines already left on the developer's Mac stay
  as they are; the orchestrator clears them later.
- **Out of scope, a follow-up:** the `git` and `build-bundle.mjs` helpers that spread `process.env`.
- **Red tests prove each leak with made-up values only.** No real value of the environment is read or printed.

While planning, from the code at `d5202f76b9` and a rehearsal on this Mac (say so if one is wrong):

1. **One more caller needs its own variables: `src/lib/engineShellStartup.spec.ts:94`.** It calls `isolatedTmux()` after
   `vi.stubEnv('ZDOTDIR', dir)` and took that through the old default (the worker's whole environment). With the
   allowlist its three real-tmux cases fail (rehearsed), so it passes `{ ZDOTDIR: f.dir, DISABLE_AUTO_UPDATE: 'false' }`
   in Task 2's code commit, by the spec's own rule (Failure cases: the variable goes in that caller's `own`).
2. **The PATH case's decoy acts in a login shell only:** `[[ -o login ]] && path=(<decoy> $path)`. A terminal tile is
   a zsh that is not a login shell, which runs the daemon's prelude and then `exec`s `zsh -l`
   (`src/lib/engineLaunch.ts` `buildTerminalLaunchArgv`), so `.zshenv` is read twice. The spec's unguarded line puts
   the decoy on `PATH` in the outer shell, and the `PATH` the inner shell notes then holds it: the case fails with the
   fix in (rehearsed with plain zsh for the whole-`PATH` lines, and end to end for the first draft's lines).
   `/etc/zprofile` runs in a login shell only, and so does the guarded line.
3. **A `developerState` case holds the `SHELL` pin** (`d.env.SHELL` is `/bin/zsh` under a made-up developer's `SHELL`;
   a test's own still wins). The refusal on a machine without `/bin/zsh` has no test: no machine that runs the suite
   lacks it, and a switch to pretend so would be a second way.
4. **`HERMES_PATH` is pinned to `<bin>/hermes`**, a file that is missing until a test writes its own Hermes there.
   The spec leaves it to this check, and the check says yes: `/usr/local/bin/hermes` is the one recipe path outside
   any home (`src/lib/engineInstall.ts:91`); every daemon reads its identity for discovery
   (`src/lib/engineBin.ts` `ownershipInput`), and a daemon that installs Hermes hooks with no `HERMES_PATH` of its own
   would run its `--version` (`src/engines/hermesRecord.ts` through `captureLaunchExecutable`, which looks at the
   recipe's paths only when no override is set). The spec's "no e2e file uses Hermes" is no longer so: six name it,
   and one of them, `e2e/opencodeLaunchCost.e2e.ts:25`, installs Hermes hooks without a `HERMES_PATH`.
5. **No package manager goes on the tool list** (`npm`, `npx`, `pnpm`, `yarn`, `bun`, `brew`), beside no engine. The
   launch script asks `npm prefix -g` and looks for an engine in that folder (`src/lib/engineLaunch.ts`), which on a
   developer's machine is where their npm engines are. A test that needs one writes its own in `<bin>`, as
   `freshMachineEngines.e2e.ts` does. The unit case that holds the engines' names holds these too.
6. **The daemon's `PATH` is `<bin>` and then the tmux fixture's own** (`${dirs.bin}:${tmux.env.PATH}`): one place
   makes the folders, and a daemon beside another has its own `bin` before the same tools.
7. **`testPath.ts` has no branch for Windows.** Both its callers need tmux, which Windows has not; its unit spec is
   skipped there.
8. **The root is given as its real path.** `isolatedTmux` already makes it so. The guard holds
   `dirname(root) === realpath(tmpdir())` and that the root is no link; working folders, which the kernel reports as real
   paths, are then matched against the same string as command lines. The one existing unit case that passed
   `mkdtempSync(...)` unresolved (`/tmp` is a link on macOS) wraps it in `realpathSync`.
9. **A root that is already gone passes the guard** when its name and its parent do: a second `close` of one daemon
   is harmless today and stays so.
10. **In the reaper the refusal is its log line**, `[e2e reaper] not a test root, left alone: <root>`, as today: it has
    nobody to throw to, and it goes on to the next root.
11. **`rootProcesses` takes the folder map last:** `rootProcesses(root, table, self?, folders?)`. No existing call
    changes, and a call without the map judges by command line alone.
12. **A source check holds the callers' rule** (Task 3): no call hands `isolatedTmux` a spread of another environment.
    It is the red test of Task 3 and keeps the next caller honest (`AGENTS.md` rule 13).
13. **The variable the startup lines share is `HARNESS_E2E_PATH`**, set and never exported, so no child sees it.
14. **The `/bin/zsh` check shares the socket-path refusal's cleanup** (one `try`, one `catch`), so the existing
    `noSocket.e2e.ts` case that leaves no root covers the cleanup of both.
15. **The `leftBehind` case asks before it types its stand-ins:** `whence -p opencode cursor-agent` must name the two
    files the test wrote, or the case fails there and types nothing. So its red run is safe at any commit, on any
    machine.
16. **`PATH` stays on the allowlist though both callers now set it** (the spec: the allowlist does not change). Its
    comment says who sets it.
17. **`e2e/freshMachineEngines.e2e.ts:186` renames its own `tools` folder** (`tmux-only`): it made `<root>/tools`
    for a `PATH` with no `node` on it, and that folder is now the fixture's (Task 2).

## Open questions

**Answered by the PM, 2026-11-15, all as recommended:** 1. run the eight switched specs once locally; report
`tmuxAgentDiscovery.real.spec.ts` and `guestParity.real.spec.ts` as unverified. 2. run `enginehomes.e2e.ts` from sources;
the Codex cases held on the missing native control helper are reported as this environment's limit, CI's Linux run is
the evidence. 3. npm engines beside the daemon's own Node are their own high-priority item, opened after this merges;
this pull request keeps `freshMachineEngines.e2e.ts` out of local runs and states the hole and its mechanism in its
body. 4. the daemon's `.zshrc` append is removed. 5. `agent_browser_podman=true` runs on GitHub after the whole suite, in
the same runner turn. 6. `developerState.e2e.ts` in `cli-e2e` is enough; tmux and zsh in `cli-tests` is a follow-up.
7. unit specs whose in-process `TmuxBackend` starts the server are a follow-up.

For Diego, in one message. The draft says what it assumes until then; each answer changes only the lines named.

1. **The specs behind a switch.** The spec says "the two `.real` specs run only with `RUN_REAL_TMUX_DISCOVERY=1`; the
   plan runs them so once". The code has ten such callers behind four switches (the table of Task 3). One,
   `src/lib/tmuxAgentDiscovery.real.spec.ts`, starts this machine's installed engines by design, so it cannot run under
   the no-real-engine rule; another, `guestParity.real.spec.ts`, needs a guest account and its helper, which this Mac
   has not. Neither passes an argument, so neither changes, but their panes move to `<root>/home` and to the new
   `PATH`. **The draft assumes** the other eight run once locally (Verification 2) and these two are reported as
   unverified rows. Is that right, or should one of them run somewhere?
2. **`enginehomes.e2e.ts` on this Mac.** The spec expects "all 32 cases" locally. The file has 34 at `d5202f76b9`, ten
   of which type an engine's name. Rehearsed at the old base with the first draft's change in: `5 failed | 27 passed
   (32)` (the base: 7 failed). The two Claude cases passed. The five Codex cases that start or hold a `codex` typed by
   hand reached the fake engine and then held on `the native control helper is unavailable`: on macOS a daemon run
   from the sources has no process-image helper (it is built into a bundle only, from
   `HARNESS_PROCESS_IMAGES_ARTIFACT`). **The draft assumes** the run from the sources, each such case reported with
   that line of its daemon log and never as passed, and the Linux run on GitHub as the proof of the whole file. Or
   should the local run be from a bundle with the helper (`E2E_BUNDLE=1` and an artifact built by
   `scripts/build-process-images.py`), which was not rehearsed?
3. **Engines beside the Node that runs the daemon are found whatever `PATH` says.** For an engine npm installs, the
   daemon also looks in the folder of its own Node (`src/lib/engineLaunch.ts` `npmRuntimeBins`:
   `dirname(process.execPath)`), and a daemon under test runs on the test's Node. On this Mac that folder holds a real
   `codex`, `cmd`, `command-code`, `kilo` and `kilocode`. An override (`<ENGINE>_PATH`) turns that search off, which is
   why `codex` is safe in most files; no e2e file starts Kilo or Command Code without its own. One file is not safe:
   `e2e/freshMachineEngines.e2e.ts` deletes `CODEX_PATH` on purpose ("no codex anywhere", so the daemon installs
   one), and on this Mac the daemon's search then reaches the real `codex` beside its Node, today and after this
   change (read from `captureLaunchExecutable`; never run to see). Two ways to close it: the Hermes pin for every engine (`<ENGINE>_PATH` at `<bin>/<its command>`, missing
   until a test writes one), which does not help that file; or the daemon under test runs on a Node in a folder of
   the root (a hard link, so that `process.execPath` is the root's), which does. **The draft assumes** only
   `HERMES_PATH` is pinned, as the spec says; that file is kept out of every local run (Global Constraints) and the
   pull request names the gap. Close it here, and which way, or a follow-up?
4. **The daemon's own `.zshrc` line** (`daemon.ts:313`, an append of nothing) can change nothing once `isolatedTmux`
   writes the file; the spec says it "stays only as its append". **The draft assumes** it is removed with its
   comment, which moves to `isolatedTmux.ts` (`AGENTS.md` rule 2, nothing left behind). Keep it instead?
5. **The agent browser on real Podman.** The eight shards leave `agentBrowserPodman.e2e.ts` out, and it is the only
   file that runs the `podman` link of the tool list. **The draft assumes** the spec's one run, the shards, and an
   unverified row for that link. Add the `agent_browser_podman=true` run (one runner, up to 50 minutes)?
6. **A check that keeps running.** `isolatedTmux.spec.ts`'s pane cases never run on pull requests: the unit jobs
   install no tmux and no zsh. The same leak is held every night by `developerState.e2e.ts`. **The draft assumes**
   that is enough. Or should `cli-tests` install tmux and zsh?
7. **Unit specs whose backend starts the server.** In `tmuxBackend.spec.ts`'s "session variables on a real tmux
   server" and `tmuxBackend.contract.spec.ts`, the `TmuxBackend` under test runs in the Vitest worker and its bare
   `tmux` starts the server, with the worker's environment. `isolatedTmux` cannot reach that. **The draft assumes** it
   joins the spec's Follow-up. Agreed?

## Global Constraints

- No product code. Only `cli/src/testing/`, `cli/e2e/`, and spec files under `cli/src/lib/`. Nothing under
  `cli/src/core`, `cli/src/services` or `cli/src/harnessd`.
- **No run starts a real engine.** On this Mac a login zsh finds the developer's engines before the fake ones, or
  beside them, until Task 5 is in. So, in every task and in Verification:
  - never type an engine's name (`claude`, `codex`, `opencode`, `cursor-agent` or any other of
    `ENGINE_CLI_ALIASES`) into a pane, a tile or a shell of your own; ask where a name resolves with `whence -p`;
  - never run a file that types an engine's name (`e2e/enginehomes.e2e.ts`, `e2e/hookclient.e2e.ts`,
    `e2e/agentBrowser.e2e.ts`, `e2e/conversationOwners.e2e.ts`; grep a file for `send-keys` and `type(` before running
    one this list does not name) until both PATH cases of `e2e/developerState.e2e.ts` are green on the same tree, in
    the same shell session, first, by the run's own exit status;
  - never run `npm run test:tmux-real` or `src/lib/tmuxAgentDiscovery.real.spec.ts`: they start this machine's
    installed engines by design;
  - never run `e2e/freshMachineEngines.e2e.ts` on this Mac: it takes the daemon's `CODEX_PATH` away, and the daemon
    then finds the real `codex` beside its Node (question 3). The GitHub run holds it;
  - never run or list `e2e/agentBrowserPodman.e2e.ts` locally: it acts on the machine's real Podman.
- **Only made-up paths and values.** No test, log line, commit message or pull request body reads or carries a real
  value of the environment. A test puts a fake in the worker's environment with `vi.stubEnv` and takes it out with
  `vi.unstubAllEnvs()`. A pane is asked for the names a test needs, one by one, never for `env`: at the base its
  environment is the developer's. An assertion names the keys it compares: never `expect(d.env)` or
  `expect(process.env)` whole. The developer's `PATH` is a real value too: a test that judges a `PATH` built from it
  asserts a yes or no, so that a failure prints no folder of theirs.
- **Only your own processes and folders.** Other sessions run end-to-end tests on this Mac, and real engines from
  earlier runs are still there, on purpose. A task ends only what its own test started, by exact pid, socket or
  path: never `pkill`, `killall`, a pattern, or a `tmux kill-server` without `-S <its own socket>`. A leftover that is
  not yours is reported, never ended. A task removes only a folder it made, by its full path written out: never `rm`
  with a variable that could be empty, and rather leave a folder than guess.
- The allowlist itself does not change (`cli/src/testing/daemonEnvironment.ts`: comments only).
- The tool list holds a command only when a test or the daemon runs it by name and the system's folders do not have
  it on macOS or on CI's Linux, with its reason in a comment. Never an engine, never a package manager, never a
  folder.
- A failing or flaky test is a bug, fixed at its layer: never skipped, loosened, retried or given a longer timeout.
  No fixed sleeps.
- No local full suite. A task runs only the tests of what it changed. Every local end-to-end run is under
  `caffeinate -i`, with a short TMPDIR of the task's own (`/private/tmp/claude-503/iso2-t<N>/`, made first with
  `mkdir -p`; an agent's TMPDIR is too long for the daemon's socket) and `SHELL=/bin/zsh`, as the workflow sets it:
  this Mac's account shell is bash.
- The GitHub workflow `cli-e2e` is heavy: its one run waits for a runner turn from the orchestrator.
- Comments say why, in plain sentences, and name the audit of 2026-11-15 and what was found (the design's Problem).
- A commit adds its files by name. The documents under `docs/plans/` are untracked here and are no task's.
- Platforms: macOS and Linux, where tmux runs. One pull request; its body names the platforms and carries each task's
  red and green output, the audit's table, the Verification results, and the local-checks receipt, in the body before
  the push that CI reads it from.

## Found while reading the code

Read at `d5202f76b9`. **What was run, and when:** the first draft of this plan (Tasks 2, 3, 6 and 7 as they are here,
and the daemon's task with startup lines that put back only the first folder) was rehearsed on this Mac (macOS,
tmux 3.6b, zsh 5.9, Node 22.21.1) at `d058b79780`, in copies of the tree outside this worktree. Its numbers are
marked "old base" below. Since then the base moved twice and the PM added the `PATH` allowlist, the whole-`PATH`
lines, `TEMP` and `TMP`: Task 1, Task 5's cases, the `PATH` assertions of Task 2, the stand-ins of Task 6's
end-to-end case and Task 7's end-to-end cases were **not run**. Their expected outputs are read from the code, and a
task whose red or green differs says so in its report. At the new base only three things were run, none changing a
file: `vitest list`, the eight unit files, and the whole-`PATH` lines in a plain zsh.

- **Baseline at `d5202f76b9`.** The eight unit files of Verification 1: `116 passed` (`isolatedTmux.spec.ts` 2,
  `rootProcesses.spec.ts` 6, `reaperProcess.spec.ts` 1, `tmuxBackend.spec.ts` 76, `callerPane.spec.ts` 14,
  `harnessSessionLabel.spec.ts` 9, `nativePaneHold.spec.ts` 6, `tmuxExternalAdoption.spec.ts` 2). Cases listed:
  `enginehomes.e2e.ts` 34, `hookclient.e2e.ts` 10, `shells.e2e.ts` 8, `leftBehind.e2e.ts` 7,
  `developerState.e2e.ts` 5, `dotfiles.e2e.ts` 2. Old base: the six gated files of Verification 2, `64 passed`;
  `processImages.real.spec.ts` with `RUN_DARWIN_PROCESS_IMAGES=1`, `2 passed`.
- **`isolatedTmux` has 24 calls in 18 files** (the table of Task 3). Six change; the rest pass nothing, a minimal
  environment or an environment already clean. `daemon.ts` and `isolatedTmux.ts` are as they were at the old base;
  `tmuxBackend.spec.ts`'s two calls are now at `:925` and `:1061` (the spec still says `:896`).
- **The specs behind a switch are ten, under four switches**, not two under one: `RUN_REAL_TMUX_DISCOVERY=1` (seven
  files; `npm run test:tmux-real` runs six of them), `RUN_DARWIN_PROCESS_IMAGES=1` (`processImages.real.spec.ts`,
  macOS), `RUN_TERMINAL_CONTRACT=1` (`tmuxBackend.contract.spec.ts`, `npm run test:terminal-contract`) and
  `RUN_REAL_GUEST_PARITY=1` (`guestParity.real.spec.ts`). `tmuxAgentDiscovery.real.spec.ts` types the path of every
  installed engine into a pane (`:113`): on this Mac those are real ones (question 1).
- **In a Vitest worker `HOME` and `ZDOTDIR` are already throwaway folders** (`cli/vitest.setup.ts`), so the unit
  case that shows a developer's `.zshrc` being read stubs `HOME` to a made-up home and `ZDOTDIR` to unset.
  `harness/abandonedWorker.ts` runs under `tsx`, not Vitest: there both are the developer's.
- **Panes take their environment from the tmux server**, which has that of the first client to reach its socket; the
  daemon passes a pane no `PATH` of its own. Hence hole 2. With Change 4 a tile on a server the test's own client
  started has the fixture's `PATH`: no engine at all, the fake ones neither. Five places open such a session
  (`hookclient.e2e.ts:376`, `tmuxmoves.e2e.ts:65`, `typingLatency.e2e.ts:137`, `races.e2e.ts:218`,
  `harness/abandonedWorker.ts:19`); none types an engine's name into a tile afterwards.
- **A terminal tile is two shells:** `[zsh, '-c', <prelude> 'exec "$@"', 'harness-terminal', <cwd>, zsh, '-l']`
  (`buildTerminalLaunchArgv`). Every other shell the daemon starts for zsh is `-lic` (`engineLaunch.ts`,
  `engineBin.ts`, `loginShellEnv.ts`, `tmuxOnPath.ts`), a login shell, which reads both startup lines.
- **The whole-`PATH` lines, run in a plain zsh with made-up folders, nothing started:** handed
  `<bin>:<tools>:/usr/bin:/bin:/usr/sbin:/sbin`, a login zsh on this Mac has `/usr/local/bin` and eleven more folders
  ahead of `<bin>`, and `whence -p claude codex tmux` names `/usr/local/bin` three times; with the two lines its
  `PATH` is exactly what it was handed and the two engines are `<bin>`'s. The same through a tile's two shells, with
  the guarded decoy; with the spec's unguarded decoy, the decoy's. A second daemon's `<bin2>` on the same home:
  `<bin2>`'s. A test's later `.zprofile` line and its `.zshrc` still win. `env` shows no `HARNESS_E2E_PATH`.
  `whence -p` prints nothing for a name it cannot find and returns 1.
- **`e2e/shells.e2e.ts:99` asserts that no startup file is in the home.** Its case removes `.zshrc` first (`:86`) and
  must remove the two new files with it (Task 5).
- **Other files that write a startup file:** `dotfiles.e2e.ts:59` overwrites `.zprofile` and types no engine's name;
  `agentBrowserPodman.e2e.ts:193` appends to it, after the harness's line; `agentBrowser.e2e.ts:90`,
  `clockjump.e2e.ts:71`, `creationPaths.e2e.ts:72`, `freshMachineEngines.e2e.ts:116,210` and `enginehomes.e2e.ts`
  write `.zshrc`, which runs after both lines. `assertHooksContained` reads `.zshenv` and `.zprofile` only for
  `CLAUDE_CONFIG_DIR=` and `CODEX_HOME=`.
- **Who types an engine's name:** `enginehomes.e2e.ts` (ten cases: the two "a resume typed into a terminal", the two
  "started by hand in a terminal", the two "a Codex typed in …", the two "an incomplete … holds binding", "Codex
  binding does not wait for the optional native discovery cooldown" and "unavailable Codex descriptor evidence holds
  binding"), `hookclient.e2e.ts:339`, `agentBrowser.e2e.ts:378`, `conversationOwners.e2e.ts:67`.
- **One file already has a `tools` folder in its root:** `e2e/freshMachineEngines.e2e.ts:186,205-206` makes
  `<root>/tools` (`mkdirSync`, not recursive) with one link, `tmux`, for a `PATH` of its own with no `node` on it. Once
  the fixture makes `<root>/tools` it fails there. Its folder takes another name (Task 2). No other test's folder
  meets `<root>/tools`, `<root>/home` or `<root>/t` (`creationPaths.e2e.ts` uses `tools-without-tmux`).
- **Engines a test stands in for are named by path:** `PI_PATH`, `HERMES_PATH` and the like are set to a script in
  `<root>/bin` whose first line is `#!<the test's Node>` (`otherEngines.e2e.ts`, `hermesTerminalRecord.e2e.ts`,
  `hermesAdmission.e2e.ts`, `eagerHooks.e2e.ts`). They need nothing of the worker's `PATH`.
- **No file but `e2e/` creates an `IsolatedDaemon`**, and every job that runs `e2e/` is in `cli-e2e.yml`: the eight
  shards and the Podman job install zsh with apt and set `SHELL: /bin/zsh`; the macOS job has the system's. So the
  refusal on a machine without `/bin/zsh` meets no runner.
- **The audit, as far as planning took it** (Task 1 completes it). Bare names product code hands to `execFile` and
  `spawn`: `tmux`, `ps`, `git`, `lsof`, `systemctl`, `sqlite3`, `sudo`, `launchctl`, `du`, `stty`, `ssh`, `sh`,
  `whoami`, `plutil`, `osascript`, `loginctl`, `ioreg`, `nvidia-smi`, `grid`, the Windows ones, and engines. Bare
  names the end-to-end files run: `ps`, `tmux`, `git`, `lsof`, `python3`, `hdiutil`, `pkill`, `pgrep`, `unshare`,
  `sample`, `footprint`, `yes`, `tty`, `sleep`. On this Mac `tmux`, `git`, `bash` and `python3` resolve in
  `/usr/local/bin`, `node` and `npm` in the Node version manager's folder; `/usr/bin` has a `git`, a `python3` and a
  `sqlite3` of its own. `typingLatency.e2e.ts:46` runs `tmux` by name with the fixture's environment.
  `harness/outsideAgent.ts:56` and `harness/fakeDial.ts:60` run `python3`. The launch script runs `npm prefix -g`
  (decision 5).
- **The reaper refuses a root with a log line and goes on** (`reaperProcess.mjs:124-127`), and
  `reaperProcess.spec.ts` asserts that line. At the base a folder named `htmux-abc` anywhere passes its check: it is
  swept and removed.
- **`lsof -a -d cwd -F pnu` on this Mac:** four lines for each process (`p<pid>`, `u<uid>`, `fcwd`, `n<folder>`), 670
  of 918 processes, all of this account, exit 0; about 355 ms a call beside 105 ms for `ps` (five runs each, the
  machine busy with other sessions' suites). The spec measured 0.27 s.
- **The rehearsal, unit (old base).**
  - Task 2, without the `PATH` pin: the three new cases at the base `3 failed | 2 passed (5)`; with the helper
    `5 passed`. With the helper in and no caller changed, the five other ungated files stayed green, and
    `engineShellStartup.spec.ts`'s three real-tmux cases failed, each on a pane that is gone (decision 1).
  - Task 3: the source check names four files at the base and none after. The six gated files with every change in:
    `64 passed`, three runs. Once in four runs, with the helper in and before any caller changed,
    `codexUpdateRestart.real.spec.ts` "bounds update restarts" failed on `Unexpected end of JSON input`: its fixture
    writes `attempts.json` in place while the spec reads it. Not seen again in three runs; not this change's.
  - Task 6: the nine new cases, with this plan's own text, at the base `9 failed | 6 passed (15)`; with the sweep
    `15 passed`, twice.
  - Task 7: the three new cases, with this plan's own text, at the base `3 failed | 1 passed (4)`; with the sweep
    `4 passed`, twice, about 2 s.
  - `npm run test:terminal-contract` with the helper in: `6 passed | 2 skipped (8)`.
- **The rehearsal, end to end (old base;** sources, no bundle, `SHELL=/bin/zsh`, other sessions' suites beside it).
  - Task 2's case at the base: `expected 'e2e-not-a-secret\n' to be 'unset\n'`; with the helper the file passed.
  - The `SHELL` case before `daemon.ts` changed: `expected '/fake/bin/fish' to be '/bin/zsh'`. The decoy case:
    `expected '/usr/local/bin/claude\n/usr/local/bin…'` (resolved, never run); with the first draft's lines, passed.
  - Task 6's `sleep` at the base: `what the tile left: expected true to be false`; with the sweep, passed, 7 s.
  - With the whole first draft in, and only after its PATH case was green there: `enginehomes.e2e.ts`
    `5 failed | 27 passed (32)`, 10.6 minutes (question 2); `shells.e2e.ts`, `hookclient.e2e.ts` and
    `leftBehind.e2e.ts` passed, 26 cases. Four files, 17 minutes. Every close in them ran the new sweep, and none
    ended a process that was not its test's.
- **Local gates.** `python3 scripts/local-checks.py --list` on the File map's paths names two, both on macOS:
  `cli-pty` (`npm run test:terminal-contract`, for `tmuxBackend.spec.ts`) and `cli-shell`
  (`RUN_REAL_TMUX_DISCOVERY=1 npx vitest run src/lib/engineShellStartup.spec.ts --maxWorkers=1`). Neither starts an
  engine. `npm run test:core` and `test:harnessd` are not needed: nothing under their folders changes. End-to-end
  files are not typechecked (`tsconfig.json` has `rootDir: src`); the unit specs are.

## File map

| File | Change | Task |
| --- | --- | --- |
| `cli/src/testing/testPath.ts` | new: the audited tool list, `<root>/tools`, the `PATH` | 1 |
| `cli/src/testing/testPath.spec.ts` | new: five cases | 1 |
| `cli/src/testing/isolatedTmux.ts` | its environment from the allowlist and `testPath`; `<root>/home` with an empty `.zshrc`, `<root>/t`; the parameter is what the caller sets on top | 2 |
| `cli/src/testing/isolatedTmux.spec.ts` | three new cases, one call (2); the source check (3) | 2, 3 |
| `cli/src/lib/engineShellStartup.spec.ts` | `:94` names its own two variables | 2 |
| `cli/e2e/freshMachineEngines.e2e.ts` | `:186`: its own tools folder takes a name the fixture does not use | 2 |
| `cli/src/testing/daemonEnvironment.ts` | comments only: its second caller (2), what `SHELL` is still on the list for (4), who sets `PATH` (5) | 2, 4, 5 |
| `cli/e2e/developerState.e2e.ts` | two helpers and one case (2); `TEMP` and `TMP` in the first case, one case (4); two cases (5) | 2, 4, 5 |
| `cli/src/lib/tmuxBackend.spec.ts`, `harnessSessionLabel.spec.ts`, `codexUpdateRestart.real.spec.ts`, `processImages.real.spec.ts` | pass what they add, not a spread | 3 |
| `cli/e2e/harness/daemon.ts` | the shared home, `TEMP` and `TMP`, the `SHELL` pin and its refusal (4); the `PATH`, the two startup lines, `HERMES_PATH` (5) | 4, 5 |
| `cli/e2e/shells.e2e.ts` | `:86` removes the two new files with `.zshrc` | 5 |
| `cli/src/testing/rootProcesses.ts` | the root guard, the folder map, the match by working folder | 6 |
| `cli/src/testing/rootProcesses.spec.ts` | nine new cases, one `realpathSync` | 6 |
| `cli/e2e/leftBehind.e2e.ts` | one new case (6); the worker's cases also hold what its pane left (7) | 6, 7 |
| `cli/e2e/harness/reaperProcess.mjs` | the same rule, its copy | 7 |
| `cli/src/testing/reaperProcess.spec.ts` | three new cases | 7 |
| `cli/e2e/harness/abandonedWorker.ts` | its tmux session leaves a `sleep` behind, and it reports the pid | 7 |

Tasks 4 and 5 share `daemon.ts` and `developerState.e2e.ts`, and Tasks 6 and 7 share `leftBehind.e2e.ts`: in each
pair neither needs the other's code, and they never run at once.

## The sweep's rule

For Tasks 6 and 7, which write it twice: plain Node cannot import TypeScript, so the reaper keeps a copy.

- **A test root**, checked before anything is read or signalled. All of:
  - a string, absolute, whose last part is `htmux-` and at least one more character;
  - `dirname(root)` equals `realpathSync(os.tmpdir())` (a temporary folder that cannot be resolved refuses);
  - the root itself, when it exists, is a folder and not a link (`lstat`); one that is gone passes;
  - it is not the account's home (`os.userInfo().homedir`, resolved; never `$HOME`, which Vitest replaces), and it
    neither is nor holds the folder of the file that runs the check (the checkout is above that file).

  Otherwise: in `rootProcesses.ts` it throws `not a test root (isolatedTmux's <tmp>/htmux-XXXXXX): <root>`, the text of
  today; in the reaper it logs `[e2e reaper] not a test root, left alone: <root>`, the text of today, and neither
  sweeps nor removes.
- **The folder map**, pid to working folder, read once for each sweep, after the process table:
  - macOS: one `lsof -a -d cwd -F pnu`, found on `PATH`, at most 5 s. Its fields: `p<pid>` starts a process, `u<uid>`
    is its account, `n<folder>` its working folder. Its exit status is not read: it exits 1 when some process cannot
    be read, and what it printed still counts. No output at all (missing, failed to start, timed out) is the one
    failure: one line is logged, naming why, and the map is empty for that sweep.
  - Linux: for each pid of the table, `/proc/<pid>/cwd` and the owner of `/proc/<pid>`; one that cannot be read is
    left out.
  - Only a process whose account is the sweep's own (`process.getuid()`) goes in.
- **A match** is a row that is not the sweep's own pid, its parent or pid 1, and whose command line holds `<root>/`
  (as today) or whose folder in the map equals the root or starts with the root plus `/`. `/tmp/htmux-1` never matches
  `/tmp/htmux-10`. A row with no folder in the map is judged by its command line alone.
- **Ending it** is as today: a match that leads a process group (and, in `rootProcesses.ts`, not the caller's own)
  is ended with its group, any other alone; SIGKILL; at most 5 s for them to go; what is still alive is named.

## Review Focus

Each line is pinned by a test in the task that owns the code.

- A developer with other engines on their `PATH` (`opencode`, `cursor-agent` and the rest): none resolves in a tile,
  and the daemon's `PATH` holds no folder of theirs. Task 5, case "finds no engine of the developer's by name"; Task 1,
  case "names no engine".
- A tool that only works from the folder it is installed in: each link is run once, through `<root>/tools`. Task 1,
  case "runs each tool through its link".
- A test that opens the first tmux session itself, before its daemon starts: the daemon's tile has none of the
  developer's variables. Task 2, the end-to-end case, and the unit case "gives a pane none of the developer's
  variables".
- A developer whose own home has a `.zshrc`, and whose login shell is not zsh: no pane reads it, and every tile is
  zsh. Task 2, unit case "runs none of the developer's zsh startup files"; Task 4, case "runs its tiles under
  /bin/zsh".
- A system profile that puts folders ahead of the daemon's (`path_helper` on every Mac): `claude` and `codex` still
  resolve to the fake ones in a tile. Task 5, the decoy case.
- An engine left running by hand in a tile, `claude` or another: gone after the close, and after a worker that never
  closed. Task 6 and Task 7, the `leftBehind` cases.
- The sweep reaching too far: a root whose name begins another's, a folder that only looks like a root, a link named
  like one, another account's process, the worker itself, a second close. Tasks 6 and 7, the unit cases.
- `lsof` missing: the close still succeeds, by command line, and says so once. Task 6, unit case "is unknown, said
  once".

No test can pin these: a machine without `/bin/zsh` (decision 3); a tool the audit missed, which shows as a "not
found" in the local run or the GitHub run and goes on the list with its reason, in this pull request (the spec's
Failure cases); and that no real engine starts, which no test may try. The last is held by the PATH cases and by the
rule that orders the runs.

---

### Task 1: The audit, and the `PATH` a test's processes get

**Depends on:** nothing. **Effort:** xhigh (which programs every daemon under test and every pane can reach).

**Files:**
- Create: `cli/src/testing/testPath.ts`
- Create, test: `cli/src/testing/testPath.spec.ts`

**The tests that fail before the change:** the five cases of the new `cli/src/testing/testPath.spec.ts`, red as a
module that is not there. They need no tmux and run on PR CI.

**Interfaces:**
- Produces, in `cli/src/testing/testPath.ts`:

  ```ts
  /** The commands a test or a daemon under test runs by name and the system's folders may not have. Never an engine. */
  export const TEST_TOOLS: readonly string[]
  /** Where every machine keeps ps, lsof, sh, env, sleep and the rest, and no engine. */
  export const SYSTEM_FOLDERS: readonly string[]   // ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
  /** Each tool [worker]'s PATH has, with its absolute file; `node` is the Node running the tests. With no argument:
   *  this worker's own, found once and kept. */
  export function workerTools(worker?: NodeJS.ProcessEnv): ReadonlyMap<string, string>
  /** Makes `<root>/tools`, a link for each of [tools], and returns `<root>/tools:/usr/bin:/bin:/usr/sbin:/sbin`. */
  export function testPath(root: string, tools?: ReadonlyMap<string, string>): string
  ```

  Task 2 calls `testPath(root)`; Task 5 reads the result off `tmux.env.PATH`.

**No local end-to-end run.** The audit reads code; it starts nothing.

- [ ] **Step 1: The audit**

Every command the end-to-end files and the daemon run by name, each with where it is on this Mac and on
`ubuntu-latest`. The table goes into the task report and the pull request; the list in Step 4 is its result.

What to read:

- Product code, less specs: every first argument of `execFile`, `execFileSync`, `spawn`, `spawnSync`, `exec` and the
  repo's own wrappers that is not an absolute path, a literal or a constant; and every command word of the shell
  scripts the daemon writes for a pane (`src/lib/engineLaunch.ts`, `src/lib/nativePaneHold.ts`,
  `src/engines/kit/`, `src/core/agents/heldLaunches.ts`).
- `cli/e2e/` and `cli/e2e/harness/`: the same calls where the environment is a daemon's or the fixture's (`d.env`,
  `d.tmux.env`, `daemon.env`); every line typed into a pane (`send-keys -l`, `type(`); every script a test or a fake
  engine writes; every `#!/usr/bin/env <name>`.
- `cli/hook/notify.mjs` and the hook command lines the daemon installs: what they run by name.

For each name, one verdict:

| Verdict | When |
| --- | --- |
| nothing to do | it is in `/usr/bin`, `/bin`, `/usr/sbin` or `/sbin` on macOS and on `ubuntu-latest`, or only one of the two platforms ever runs it and has it there |
| on the list, with its reason | a test or the daemon needs it and the system's folders lack it on either platform |
| never | an engine (`ENGINE_CLI_ALIASES`), a package manager (decision 5), or a stub the harness writes in `<bin>` (`gh`, `security`, `sudo`) |
| not installed for a test | the daemon only probes for it (`docker`, `ollama`, `nvidia-smi`, `brew`): absent, as on a machine without it |

Where planning got to, to check and complete (Found while reading the code has the names): the spec's eight stand;
`python3` is the system's on both platforms, and the three helpers that run it use only `pty`, `os` and `select`
(read them to confirm); `sqlite3`, `ssh`, `curl`, `tar`, `du`, `stty` are the system's; `npm` is never.

And the Hermes path (decision 4): read `ownershipInput` (`src/lib/engineBin.ts`), `captureLaunchExecutable`
(`src/engines/kit/launchExecutable.ts`), `hermesKeepsRecord` (`src/engines/hermesRecord.ts`) and
`availabilityScript` (`src/lib/engineLaunch.ts`), and say in the report whether a default daemon under test stats,
tests or runs `/usr/local/bin/hermes`, and when. Planning's reading is that it is read for its identity by every
daemon and run only when Hermes hooks are installed or a Hermes is launched with no `HERMES_PATH`; Task 5 pins
`HERMES_PATH` on that reading. A different answer is reported before Task 5 starts. The same reading names the
folder beside the daemon's Node (question 3): confirm it and name it in the report.

- [ ] **Step 2: The unit cases**

`cli/src/testing/testPath.spec.ts`:

```ts
/**
 * The PATH of everything an end-to-end test starts holds the test's own tools and the system's folders, and nothing of
 * the developer's: their PATH's folders are absolute, so a throwaway HOME hid none of them, and every engine the
 * harness does not fake was found there by name (audit of 2026-11-15, docs/plans/2026-11-15-e2e-isolation-2-design.md:
 * 5 `opencode` and 4 `cursor-agent` among the processes tests left on one Mac). Every folder and file here is made up.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveBinaryOnPath } from '../lib/binaryOnPath.js'
import { ENGINE_CLI_ALIASES, ENGINE_CLI_COMMANDS } from '../lib/engineBin.js'
import { SYSTEM_FOLDERS, TEST_TOOLS, testPath, workerTools } from './testPath.js'

/** What each tool is asked through its link: something it answers without doing anything. */
const ASKED: Record<string, string[]> = {
  node: ['--version'], tmux: ['-V'], git: ['--version'], podman: ['--version'],
  zsh: ['-fc', 'exit 0'], bash: ['--norc', '-c', 'exit 0'], tcsh: ['-fc', 'exit 0'], dash: ['-c', 'exit 0'],
}

describe.skipIf(process.platform === 'win32')('the PATH of what a test starts', () => {
  let scratch = ''
  beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'test-path-')) })
  afterEach(() => { rmSync(scratch, { recursive: true, force: true }) })
  /** A folder of [scratch] holding [names], each a file that would only fail. */
  const folder = (...names: string[]): string => {
    const dir = mkdtempSync(join(scratch, 'folder-'))
    for (const name of names) writeFileSync(join(dir, name), '#!/bin/sh\nexit 97\n', { mode: 0o755 })
    return dir
  }

  it('names no engine, by the command it is started with or an alias it is found by, and no package manager', () => {
    const engines = new Set([...Object.values(ENGINE_CLI_COMMANDS), ...Object.values(ENGINE_CLI_ALIASES).flat()].filter(Boolean))
    expect(TEST_TOOLS.filter((tool) => engines.has(tool))).toEqual([])
    // `npm prefix -g` is where a developer's npm engines are, and the launch script looks there (lib/engineLaunch.ts).
    expect(TEST_TOOLS.filter((tool) => ['npm', 'npx', 'pnpm', 'yarn', 'bun', 'brew'].includes(tool))).toEqual([])
    // Every tool is asked something below: one added to the list is added there.
    expect(TEST_TOOLS.filter((tool) => !ASKED[tool])).toEqual([])
  })

  it('finds each tool where the worker\'s PATH has it, node as the Node running the tests, and leaves out one it lacks', () => {
    const worker = folder('git', 'tmux', 'opencode')
    expect([...workerTools({ PATH: worker })]).toEqual([['node', process.execPath], ['tmux', join(worker, 'tmux')], ['git', join(worker, 'git')]])
    // This worker's own are found once.
    expect(workerTools()).toBe(workerTools())
  })

  it('links them in <root>/tools, each to an absolute file, and puts no folder of the worker\'s PATH on the result', () => {
    const worker = folder('git', 'opencode'), root = folder()
    const path = testPath(root, workerTools({ PATH: worker }))
    expect(path).toBe([join(root, 'tools'), ...SYSTEM_FOLDERS].join(':'))
    expect(readdirSync(join(root, 'tools')).sort()).toEqual(['git', 'node'])
    for (const name of ['git', 'node']) {
      expect(isAbsolute(readlinkSync(join(root, 'tools', name))), name).toBe(true)
      expect(statSync(join(root, 'tools', name)).isFile(), name).toBe(true)
    }
    expect(resolveBinaryOnPath('git', { PATH: path })).toBe(join(root, 'tools', 'git'))
    // The developer's engine, a folder away from a tool they also have: not found.
    expect(resolveBinaryOnPath('opencode', { PATH: path })).toBeNull()
  })

  it('makes the folder once: a daemon beside another asks again for the same root', () => {
    const tools = workerTools({ PATH: folder('git') }), root = folder()
    expect(testPath(root, tools)).toBe(testPath(root, tools))
  })

  it('runs each tool the worker has through its link, with nothing else on PATH', () => {
    const root = folder(), path = testPath(root)
    for (const [name] of workerTools()) {
      expect(() => execFileSync(join(root, 'tools', name), ASKED[name], { env: { PATH: path, HOME: root }, stdio: 'ignore', timeout: 10_000 }), name).not.toThrow()
    }
  })
})
```

- [ ] **Step 3: See them fail, and commit them**

```bash
cd cli && npx vitest run src/testing/testPath.spec.ts
```

Expected: the file fails to load, `Cannot find module './testPath.js'` (or `Failed to resolve import`): 1 failed
file, no test run.

```bash
git add cli/src/testing/testPath.spec.ts
git commit -m "CLI e2e: the PATH of what a test starts holds no folder of the developer's (red tests)"
```

- [ ] **Step 4: `testPath.ts`**

To the Interfaces block. What it and the tests leave open:

- `TEST_TOOLS` is the spec's eight, in this order, and what the audit adds after them, each with its reason in a
  comment beside it:

  | Tool | Why |
  | --- | --- |
  | `node` | the running `process.execPath`, never a lookup: hook command lines and `#!/usr/bin/env node` scripts run it by name |
  | `tmux` | the daemon's terminal backend and the tests' own servers |
  | `git` | workspaces, the Store, worktrees, the tests' own repositories |
  | `zsh` | the tiles' shell |
  | `bash`, `tcsh`, `dash` | the shells `shells.e2e.ts`, `restoreInput.e2e.ts`, `suspend.e2e.ts` and `eagerHooks.e2e.ts` name; CI's Linux may lack `tcsh` or `dash` |
  | `podman` | the agent browser files (Homebrew's on macOS) |

- A tool is found with `resolveBinaryOnPath(name, worker)`; one it cannot find is left out, without a word.
- A link is a symbolic link to the absolute file. One that is already there is left as it is.
- The file's header says why the `PATH` is a list of links and never a folder (one folder of the worker's `PATH` is
  every engine in it), and names the audit of 2026-11-15 and the PM's census.

- [ ] **Step 5: See them pass**

```bash
npx vitest run src/testing/testPath.spec.ts   # 5 passed
npm run typecheck                             # no error, about a minute
```

A tool that fails through its link (the last case) is the audit's to judge: it finds its own files by its folder.
Say which in the report; it is not worked around by putting its folder on `PATH`.

- [ ] **Step 6: Commit**

```bash
git add cli/src/testing/testPath.ts
git commit -m "CLI e2e: the tools a test may run by name, linked in its root"
```

---

### Task 2: A tmux server the test starts has an allowlist, a home and a `PATH` of its own

**Depends on:** Task 1 (`testPath`). **Effort:** xhigh (credentials: what reaches every pane of a server a test
starts).

**Files:**
- Modify: `cli/src/testing/isolatedTmux.ts` (the function, lines 11-36)
- Test: `cli/src/testing/isolatedTmux.spec.ts` (three new cases; `:20` in the code commit)
- Modify: `cli/src/lib/engineShellStartup.spec.ts:94`
- Modify: `cli/e2e/freshMachineEngines.e2e.ts:186`
- Modify: `cli/src/testing/daemonEnvironment.ts:11-12` (comment only)
- Test: `cli/e2e/developerState.e2e.ts` (two helpers, one case)

**The tests that fail before the change:** in `cli/src/testing/isolatedTmux.spec.ts`, "gives a pane none of the
developer's variables, and a home, a temporary folder and a PATH of its own", "adds what the caller sets, which wins
over its own home but never over its tmux folder" and "runs none of the developer's zsh startup files in a login
shell"; in `cli/e2e/developerState.e2e.ts`, "gives a tile nothing of the developer's when the test itself opened the
first tmux session". PR CI's unit jobs have no tmux, so the unit file's pane cases are skipped there: their red and
green runs are taken here and recorded in the pull request.

**Interfaces:**
- Consumes: `testPath(root)` (Task 1).
- Produces: `isolatedTmux(own: NodeJS.ProcessEnv = {})`, returning what it returns today (`root`, `socket`, `env`,
  `run`, `close`). `env` is `daemonEnvironment(process.env, { HOME: <root>/home, ZDOTDIR: <root>/home,
  TMPDIR: <root>/t, PATH: testPath(<root>), ...own, TMUX_TMPDIR: <root> })` less `TMUX` and `TMUX_PANE`. The three
  folders exist, and `<root>/home/.zshrc` is an empty file. Tasks 4 and 5 read `tmux.env.HOME` and `tmux.env.PATH`.
- Produces, in `cli/e2e/developerState.e2e.ts`: `tile(d, client, name): Promise<{ id: string; tmuxPane: string }>`
  and `typed(d, pane, line, file): Promise<string>`, which the cases of Tasks 4 and 5 use.

**Local end-to-end run:** `e2e/developerState.e2e.ts` only. It types no engine's name. Do not run any file the Global
Constraints list.

- [ ] **Step 1: The unit cases**

In `cli/src/testing/isolatedTmux.spec.ts`, `readFileSync` joins the `node:fs` import, `dirname` the `node:path` one,
`afterEach` and `vi` the Vitest one, and `import { resolveBinaryOnPath } from '../lib/binaryOnPath.js'` is added.
First in `describe.skipIf(!hasTmux)('real tmux test isolation', …)`:

```ts
  // The first tmux client to reach a socket starts its server, and the server's environment is that client's. A test
  // that opened the first session gave every pane on the server, a daemon's own included, the developer's variables
  // (audit of 2026-11-15, docs/plans/2026-11-15-e2e-isolation-2-design.md). Every value here is made up.
  describe('a server the test starts', () => {
    let theirs = ''
    let tmux: Awaited<ReturnType<typeof isolatedTmux>> | undefined
    afterEach(async () => {
      vi.unstubAllEnvs()
      await tmux?.close()
      tmux = undefined
      rmSync(theirs, { recursive: true, force: true })
    })
    /** A developer's shell: a secret, an ssh agent, a folder of their own on PATH, and a home whose .zshrc says it ran. */
    const developer = () => {
      theirs = mkdtempSync(join(tmpdir(), 'isolated-tmux-theirs-'))
      writeFileSync(join(theirs, '.zshrc'), 'echo developer-zshrc-ran\n')
      vi.stubEnv('FAKE_DEV_SECRET', 'not-a-secret')
      vi.stubEnv('SSH_AUTH_SOCK', join(theirs, 'agent.sock'))
      vi.stubEnv('HOME', theirs)
      // As most developers: no ZDOTDIR, so zsh reads the home's (vitest.setup.ts gives the worker one of its own).
      vi.stubEnv('ZDOTDIR', undefined)
      // Their folder, then only where tmux is: a failure then prints no folder of the real PATH.
      vi.stubEnv('PATH', [theirs, dirname(resolveBinaryOnPath('tmux')!), '/usr/bin', '/bin'].join(':'))
    }
    /** What a pane of [made] has under each name, `unset` where it has none. Named one by one: never the pane's whole
     *  environment, which at the base is the developer's. */
    const inPane = async (made: Awaited<ReturnType<typeof isolatedTmux>>, names: string[]): Promise<string[]> => {
      const out = join(made.root, 'pane')
      await made.run('new-session', '-d', '-s', 'pane', '/bin/sh', '-c',
        `printf '%s\\n' ${names.map((name) => `"\${${name}-unset}"`).join(' ')} > '${out}.tmp' && mv '${out}.tmp' '${out}'; exec sleep 600`)
      await vi.waitFor(() => expect(existsSync(out)).toBe(true), { timeout: 10_000 })
      return readFileSync(out, 'utf8').split('\n').slice(0, -1)
    }

    it('gives a pane none of the developer\'s variables, and a home, a temporary folder and a PATH of its own', async () => {
      developer()
      const made = tmux = await isolatedTmux()
      const home = join(made.root, 'home')
      expect(await inPane(made, ['FAKE_DEV_SECRET', 'SSH_AUTH_SOCK', 'HOME', 'ZDOTDIR', 'TMPDIR', 'TMUX_TMPDIR', 'PATH']))
        .toEqual(['unset', 'unset', home, home, join(made.root, 't'), made.root, `${join(made.root, 'tools')}:/usr/bin:/bin:/usr/sbin:/sbin`])
      // The empty .zshrc keeps the new-user menu of Debian's, Ubuntu's and Fedora's zsh out of every pane.
      expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('')
    })

    it('adds what the caller sets, which wins over its own home but never over its tmux folder', async () => {
      developer()
      const made = tmux = await isolatedTmux({ OWN_VALUE: 'set by the caller', HOME: join(theirs, 'own'), TMUX_TMPDIR: join(theirs, 'tmux') })
      expect(await inPane(made, ['OWN_VALUE', 'HOME', 'TMPDIR', 'TMUX_TMPDIR', 'FAKE_DEV_SECRET']))
        .toEqual(['set by the caller', join(theirs, 'own'), join(made.root, 't'), made.root, 'unset'])
    })

    it.skipIf(!existsSync('/bin/zsh'))('runs none of the developer\'s zsh startup files in a login shell', async () => {
      developer()
      const made = tmux = await isolatedTmux()
      const ready = join(made.root, 'ready')
      // zsh by name: the shell the allowlist lets through is the developer's own.
      const pane = await made.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'zsh', '-x', '120', '-y', '40', '/bin/zsh', '-l', '-i')
      await made.run('send-keys', '-t', pane, '-l', `: > '${ready}'`)
      await made.run('send-keys', '-t', pane, 'Enter')
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10_000 })
      expect(await made.run('capture-pane', '-p', '-S', '-200', '-t', pane)).not.toContain('developer-zshrc-ran')
    })
  })
```

- [ ] **Step 2: The end-to-end case**

In `cli/e2e/developerState.e2e.ts`, above the `describe`:

```ts
/** A terminal tile of [d], up: its row. */
async function tile(d: IsolatedDaemon, client: LocalClient, name: string): Promise<{ id: string; tmuxPane: string }> {
  const cwd = join(d.projectsDir, name)
  mkdirSync(cwd, { recursive: true })
  const opened = await client.request('agent_create', { engine: 'terminal', cwd }, 60_000)
  expect(opened.error, JSON.stringify(opened)).toBeUndefined()
  return until('the terminal tile to be up', async () => {
    const { agents } = await client.request<{ agents: Array<{ id: string; status: string; tmuxPane?: string }> }>('agents_list', { includeStopped: true }, 30_000)
    const now = agents.find((agent) => agent.id === opened.agent.id)
    return now?.status === 'active' && now.tmuxPane ? { id: now.id, tmuxPane: now.tmuxPane } : null
  }, 60_000, 250)
}

/** What [line], typed into [pane], wrote into [file]: the tile's own answer, never its whole environment. The file is
 *  moved into place whatever the line returned: `whence -p` returns 1 for a name it cannot find. */
async function typed(d: IsolatedDaemon, pane: string, line: string, file: string): Promise<string> {
  await d.tmux.run('send-keys', '-t', pane, '-l', `${line} > ${file}.tmp; mv ${file}.tmp ${file}`)
  await d.tmux.run('send-keys', '-t', pane, 'Enter')
  return until(`the tile to write ${file}`, () => existsSync(file) ? readFileSync(file, 'utf8') : null, 30_000, 100)
}
```

And last in the `describe`:

```ts
  it('gives a tile nothing of the developer\'s when the test itself opened the first tmux session', async () => {
    vi.stubEnv('FAKE_DEV_SECRET', 'e2e-not-a-secret')
    const d = daemon = await IsolatedDaemon.create()
    failed(d)
    // The first client to reach a socket starts its server, and the server's environment is that client's.
    await d.tmux.run('new-session', '-d', '-s', 'opened-by-the-test', '/bin/sleep', '600')
    await d.start()
    const client = await LocalClient.connect(d)
    try {
      const { tmuxPane } = await tile(d, client, 'own-session')
      expect(await typed(d, tmuxPane, 'printf \'%s\\n\' "${FAKE_DEV_SECRET-unset}"', join(d.root, 'tile-secret'))).toBe('unset\n')
    } finally { client.close() }
  })
```

`SSH_AUTH_SOCK` is not asserted here: tmux's `update-environment` drops a name the creating client lacks, and the
daemon's has none. The unit case holds it. The file's header gains one sentence: a tmux server the test starts takes
the same allowlist (`src/testing/isolatedTmux.ts`).

- [ ] **Step 3: See them fail**

```bash
cd cli && export TMPDIR=/private/tmp/claude-503/iso2-t2/ SHELL=/bin/zsh && mkdir -p "$TMPDIR"
npx vitest run src/testing/isolatedTmux.spec.ts
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/developerState.e2e.ts -t 'opened the first tmux session'
```

Expected: the unit file `3 failed | 2 passed (5)`: the first on `expected [ 'not-a-secret', …(6) ]`, the second on
its `TMPDIR` (empty at the base), the third on `developer-zshrc-ran` in the pane. The end-to-end case
`1 failed | 5 skipped (6)` on `expected 'e2e-not-a-secret\n' to be 'unset\n'`.

- [ ] **Step 4: Commit the red tests**

```bash
git add cli/src/testing/isolatedTmux.spec.ts cli/e2e/developerState.e2e.ts
git commit -m "CLI e2e: a tmux server the test starts takes nothing of the developer's (red tests)"
```

- [ ] **Step 5: `isolatedTmux(own: NodeJS.ProcessEnv = {})`**

In `cli/src/testing/isolatedTmux.ts`, after the root is made: make `<root>/home`, write `<root>/home/.zshrc` empty,
make `<root>/t`; then `env` as the Interfaces block gives it, `TMUX_TMPDIR` last so no caller can move it, with `TMUX`
and `TMUX_PANE` still deleted after the merge (a caller forwarding a parent's environment can carry them). Nothing
else moves: the binary, still found on the worker's own `PATH` and run by its absolute path, the socket folder, `run`,
`close`.

The comment above the function says, beside what it says today: why the environment is an allowlist (the first
client's environment is the server's, and so every pane's: the audit of 2026-11-15); that the parameter is what the
caller sets on top, never an environment to inherit; why the home has an empty `.zshrc` (the new-user menu of
Debian's, Ubuntu's and Fedora's zsh in every pane); that `<root>/t` is the temporary folder of a pane on a server the
test started; and that the `PATH` is the fixture's own (`testPath.ts`), so a pane finds no engine of the developer's.

In `cli/src/testing/daemonEnvironment.ts`, the sentence that ends "(e2e/harness/daemon.ts)." also names the second
caller: a tmux server a test starts itself (`isolatedTmux.ts`).

- [ ] **Step 6: The three places the change breaks**

- `cli/src/testing/isolatedTmux.spec.ts:20`: `child = await isolatedTmux({ TMUX: inherited.TMUX, TMUX_PANE: pane })`.
  `inherited` stays for the control two lines below, which must still reach the parent's server.
- `cli/src/lib/engineShellStartup.spec.ts:94`:
  `server = await isolatedTmux({ ZDOTDIR: f.dir, DISABLE_AUTO_UPDATE: 'false' })`, the two names its fixture stubs.
- `cli/e2e/freshMachineEngines.e2e.ts:186`: `tools = join(d.root, 'tmux-only')`. Its folder holds `tmux` alone, for a
  `PATH` with no `node` on it, and `<root>/tools` is now the fixture's. Nothing else in the file changes. It is not
  run here (Global Constraints): the GitHub run of Verification 7 is its check.

- [ ] **Step 7: See them pass**

```bash
npx vitest run src/testing/isolatedTmux.spec.ts                                             # 5 passed
npm run typecheck                                                                           # no error
npx vitest run src/lib/tmuxBackend.spec.ts src/lib/nativePaneHold.spec.ts src/lib/tmuxExternalAdoption.spec.ts \
  src/lib/harnessSessionLabel.spec.ts src/lib/callerPane.spec.ts                            # 5 files, 107 passed
RUN_REAL_TMUX_DISCOVERY=1 npx vitest run src/lib/engineShellStartup.spec.ts --maxWorkers=1  # 10 passed
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/developerState.e2e.ts        # 6 passed
```

The second and fourth were green in rehearsal without the `PATH` pin, and were not run with it. A case that fails
now ran something by name in a pane: it is a tool for Task 1's list (with its reason, test first, in
`testPath.spec.ts`'s `ASKED`), or that caller passes a `PATH` of its own. Never the worker's `PATH` put back.

- [ ] **Step 8: Commit**

```bash
git add cli/src/testing/isolatedTmux.ts cli/src/testing/isolatedTmux.spec.ts cli/src/lib/engineShellStartup.spec.ts cli/e2e/freshMachineEngines.e2e.ts cli/src/testing/daemonEnvironment.ts
git commit -m "CLI e2e: a tmux server the test starts inherits the allowlist, with a home and a PATH of its own"
```

---

### Task 3: The callers pass what they add, never a copy of the worker's environment

**Depends on:** Task 2 (the parameter's new meaning, and `isolatedTmux.spec.ts`). **Effort:** medium (mechanical).

**Files:**
- Test: `cli/src/testing/isolatedTmux.spec.ts` (one case)
- Modify: `cli/src/lib/tmuxBackend.spec.ts:924-927`
- Modify: `cli/src/lib/harnessSessionLabel.spec.ts:29,107`
- Modify: `cli/src/lib/codexUpdateRestart.real.spec.ts:66`
- Modify: `cli/src/lib/processImages.real.spec.ts:99`

**The test that fails before the change:** in `cli/src/testing/isolatedTmux.spec.ts`, "no caller hands it a copy of
another environment". No test of the four files changes what it asserts.

**No local end-to-end run.**

- [ ] **Step 1: The source check**

In `cli/src/testing/isolatedTmux.spec.ts`, outside the `describe` that needs tmux, so that it runs on PR CI:

```ts
// The parameter was the whole environment to inherit, and four callers spread the worker's into it: a server they
// started had the developer's variables again (audit of 2026-11-15). It is now what the caller sets on top.
it('no caller hands it a copy of another environment', () => {
  const cli = join(import.meta.dirname, '..', '..')
  const spreads = (folder: string) => readdirSync(join(cli, folder), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => /isolatedTmux\(\s*\{[^}]*\.\.\./.test(readFileSync(file, 'utf8')))
    .map((file) => relative(cli, file))
  expect([...spreads('src'), ...spreads('e2e')]).toEqual([])
})
```

`relative` joins the `node:path` import.

- [ ] **Step 2: See it fail, and commit it**

```bash
cd cli && npx vitest run src/testing/isolatedTmux.spec.ts -t 'no caller hands it'
```

Expected: `1 failed`, naming `src/lib/codexUpdateRestart.real.spec.ts`, `src/lib/harnessSessionLabel.spec.ts`,
`src/lib/processImages.real.spec.ts` and `src/lib/tmuxBackend.spec.ts`.

```bash
git add cli/src/testing/isolatedTmux.spec.ts
git commit -m "CLI e2e: no caller hands isolatedTmux a copy of another environment (red test)"
```

- [ ] **Step 3: The callers**

Every call, by the PM's word. Only the four rows marked **changes** are this task's; two are Task 2's, done. Every
row gains the fixture's `PATH` unless it passes its own.

| Call | Passes today | After | Runs |
| --- | --- | --- | --- |
| `e2e/harness/daemon.ts:279` | nothing | the same (Tasks 4 and 5 change what `create` does with it) | every end-to-end file |
| `e2e/races.e2e.ts:207` | `d.env`, a daemon's own | the same, as is | `cli-e2e` |
| `src/testing/isolatedTmux.spec.ts:14,48` | nothing | the same | where tmux is |
| `src/testing/isolatedTmux.spec.ts:20` | `{ ...process.env, TMUX, TMUX_PANE }` | `{ TMUX: inherited.TMUX, TMUX_PANE: pane }` (Task 2) | where tmux is |
| `src/lib/tmuxBackend.spec.ts:925` | `{ ...inherited, HOME: home, ZDOTDIR: home, HISTFILE: …, HARNESSD_SERVICE_TOKEN: …, HARNESSD_SUPERVISED: …, HARNESSD_WATCHDOG_MS: …, CLAUDECODE: …, ORCA_PAIRING_CODE: …, ORCA_AGENT_SESSION_SPAWN_TOKEN: …, OPENAI_API_KEY: 'fixture-key' }`, `inherited` being the worker's less harnessd's and an agent session's names | **changes:** the same object without `...inherited`; line 924 (`const inherited = …`) goes; `removedBefore` and the comment above stay | where tmux is |
| `src/lib/tmuxBackend.spec.ts:1061` | nothing, then `tmux.env.HOME = tmux.root` | the same | where tmux is |
| `src/lib/nativePaneHold.spec.ts:21` | nothing, then sets `tmux.env.HOME` and `ZDOTDIR` | the same | where tmux is |
| `src/lib/nativePaneHold.spec.ts:56` | `tmux.env`, the first fixture's | the same, as is | where tmux is |
| `src/lib/tmuxExternalAdoption.spec.ts:20` | nothing (its panes move from the spec's own `home` to `<root>/home`; it asserts nothing of either) | the same | where tmux is |
| `src/lib/harnessSessionLabel.spec.ts:29,107` | `{ ...process.env, HOME: home, ZDOTDIR: home, HISTFILE: join(home, 'history') }` | **changes:** `{ HOME: home, ZDOTDIR: home, HISTFILE: join(home, 'history') }` | where tmux is |
| `src/lib/callerPane.spec.ts:112,149` | nothing | the same | where tmux is |
| `src/lib/engineShellStartup.spec.ts:94` | nothing | `{ ZDOTDIR: f.dir, DISABLE_AUTO_UPDATE: 'false' }` (Task 2) | `RUN_REAL_TMUX_DISCOVERY=1`; local gate `cli-shell` |
| `src/lib/codexUpdateRestart.real.spec.ts:66` | `{ ...process.env, ZDOTDIR: dir, CODEX_HOME: dir }` | **changes:** `{ ZDOTDIR: dir, CODEX_HOME: dir }` | `RUN_REAL_TMUX_DISCOVERY=1` |
| `src/lib/restartDiscovery.real.spec.ts:18` | nothing | the same | `RUN_REAL_TMUX_DISCOVERY=1` |
| `src/lib/terminalClose.real.spec.ts:19` | `{ PATH, TERM }`, the worker's `PATH` | the same; gains the rest of the allowlist and the pinned folders, and keeps the `PATH` it names | `RUN_REAL_TMUX_DISCOVERY=1` |
| `src/lib/engineStop.real.spec.ts:142` | nothing | the same | `RUN_REAL_TMUX_DISCOVERY=1` |
| `src/lib/unusedCodexClose.spec.ts:119` | nothing | the same | `RUN_REAL_TMUX_DISCOVERY=1`, one case |
| `src/lib/tmuxAgentDiscovery.real.spec.ts:70` | nothing | the same | `RUN_REAL_TMUX_DISCOVERY=1`; **never on this Mac**: it starts the installed engines |
| `src/lib/processImages.real.spec.ts:99` | `{ ...process.env, ZDOTDIR: root, CODEX_HOME: join(root, 'codex') }` | **changes:** `{ ZDOTDIR: root, CODEX_HOME: join(root, 'codex') }` | `RUN_DARWIN_PROCESS_IMAGES=1`, macOS |
| `src/lib/tmuxBackend.contract.spec.ts:11` | `{ PATH, TERM }`, the worker's `PATH` | the same | `RUN_TERMINAL_CONTRACT=1`; local gate `cli-pty` |
| `src/lib/guestParity.real.spec.ts:76` | `{ PATH, TERM, LANG }`, the worker's `PATH` | the same | `RUN_REAL_GUEST_PARITY=1`, a Mac with a guest account |

A caller that turns out to need one more inherited variable names it in its own argument, never a spread, and the
task report says which.

- [ ] **Step 4: See them pass**

```bash
npx vitest run src/testing/isolatedTmux.spec.ts src/lib/tmuxBackend.spec.ts src/lib/harnessSessionLabel.spec.ts   # 3 files: 6, 76 and 9 passed
npm run typecheck                                                                                                 # no error
RUN_REAL_TMUX_DISCOVERY=1 npx vitest run src/lib/codexUpdateRestart.real.spec.ts                                  # 11 passed
RUN_DARWIN_PROCESS_IMAGES=1 npx vitest run src/lib/processImages.real.spec.ts                                     # 2 passed, macOS
```

None of the four starts an engine: their Codex is a script the spec writes, and a compiled `sleep`.

- [ ] **Step 5: Commit**

```bash
git add cli/src/lib/tmuxBackend.spec.ts cli/src/lib/harnessSessionLabel.spec.ts cli/src/lib/codexUpdateRestart.real.spec.ts cli/src/lib/processImages.real.spec.ts
git commit -m "CLI e2e: the isolatedTmux callers pass what they add, not the worker's environment"
```

---

### Task 4: A daemon's home, temporary folders and shell are the harness's own

**Depends on:** Task 2 (`tmux.env.HOME`). It shares `daemon.ts` and `developerState.e2e.ts` with Task 5 and needs
nothing of its code. **Effort:** high.

**Files:**
- Modify: `cli/e2e/harness/daemon.ts` (`create`: lines 253, 288, 296-313, 344-352)
- Test: `cli/e2e/developerState.e2e.ts` (the first case, one new case)
- Modify: `cli/src/testing/daemonEnvironment.ts:22-23` (comment only)

**The tests that fail before the change:** in `cli/e2e/developerState.e2e.ts`, the existing "has its profile under its
own home, and its own tmux folder, temporary folder and Store catalog", with `TEMP` and `TMP` in it, and the new "runs
its tiles under /bin/zsh, whatever shell the developer uses, unless a test names another".

**Interfaces:**
- Consumes: `tmux.env.HOME` (Task 2).
- Produces: `d.env.TEMP === d.env.TMP === d.env.TMPDIR`; `d.env.SHELL === '/bin/zsh'` unless `options.env` names
  another; `TILE_SHELL`, a constant of `daemon.ts`.

**Local end-to-end run:** `e2e/developerState.e2e.ts`, the two cases, which start no daemon. Do not run any file the
Global Constraints list.

- [ ] **Step 1: The cases**

In `cli/e2e/developerState.e2e.ts`, the first case: `TEMP` and `TMP` join the three names its loop stubs
(`for (const name of ['USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP']) vi.stubEnv(name, join(scratch, name))`),
and both sides of its `expect` gain them: `TEMP: d.env.TEMP, TMP: d.env.TMP` against
`TEMP: join(d.root, 't'), TMP: join(d.root, 't')`. Its title gains nothing. Then, after it:

```ts
  it('runs its tiles under /bin/zsh, whatever shell the developer uses, unless a test names another', async () => {
    vi.stubEnv('SHELL', '/fake/bin/fish')
    const d = daemon = await IsolatedDaemon.create()
    expect(d.env.SHELL).toBe('/bin/zsh')
    // Never started: it only shows whose word wins. Beside the first, whose close takes its folders.
    expect((await IsolatedDaemon.create({ beside: d, env: { SHELL: '/bin/bash' } })).env.SHELL).toBe('/bin/bash')
  })
```

- [ ] **Step 2: See them fail, and commit them**

```bash
cd cli && export TMPDIR=/private/tmp/claude-503/iso2-t4/ SHELL=/bin/zsh && mkdir -p "$TMPDIR"
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/developerState.e2e.ts -t 'has its profile under|runs its tiles under'
```

Expected: `2 failed`, the others skipped: the first shows `TEMP` and `TMP` undefined where the daemon's own folder
should be, the second `expected '/fake/bin/fish' to be '/bin/zsh'`.

```bash
git add cli/e2e/developerState.e2e.ts
git commit -m "CLI e2e: a daemon's temporary folders and shell are the harness's own (red tests)"
```

- [ ] **Step 3: `IsolatedDaemon.create`**

In `cli/e2e/harness/daemon.ts`, in the order the function runs:

1. Above the class, `const TILE_SHELL = '/bin/zsh'`, with why: the shell of every tile, the same on every machine and
   never the developer's choice (a bash, fish or tcsh user ran every tile under it, and bash and fish run
   `path_helper` too); CI installs it and macOS ships it; no second shell to fall back to, which would be a second
   rule to keep true.
2. `dirs.home` is `tmux.env.HOME!`: the home `isolatedTmux` made, the same `<root>/home` as today.
3. The refusal. The socket-path check and the new one share one `try` and the `catch` of today:

   ```ts
   try {
     if (!existsSync(TILE_SHELL)) throw new Error(`${TILE_SHELL} is required: a daemon under test runs its tiles under zsh`)
     if (options.dataDir === undefined) assertSocketPathFits(join(dirs.data, `daemon-${port}.sock`))
   } catch (error) { /* as today: close and forget the tmux, unless beside; rethrow */ }
   ```

   The comment above the socket-path check stays with it.
4. The `.zshrc` line (`:313`) and its comment: by question 4, the draft removes both (the comment's reason is in
   `isolatedTmux.ts` since Task 2).
5. In `own`: after `ZDOTDIR: dirs.home,`, `SHELL: TILE_SHELL,` with one line of why; after `TMPDIR: dirs.tmp,`,
   `TEMP: dirs.tmp, TMP: dirs.tmp,`, with why (Windows' `os.tmpdir()` reads them, not `TMPDIR`, and with neither a
   daemon there fell back to `%SystemRoot%\temp`, outside its root: the PM, 2026-11-15). `...options.env` stays last,
   so `shells.e2e.ts`, `restoreInput.e2e.ts`, `suspend.e2e.ts` and `eagerHooks.e2e.ts` keep their shells, and
   `enginehomes.e2e.ts`'s "given no SHELL" case still deletes it.

In `cli/src/testing/daemonEnvironment.ts`, the comment above `'TERM', 'SHELL'`: `SHELL` is still inherited for a tmux
server a test starts itself, whose tmux would fall back to the account's shell anyway; a daemon's is pinned
(`e2e/harness/daemon.ts`).

- [ ] **Step 4: See them pass**

```bash
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/developerState.e2e.ts   # every case there passed
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/noSocket.e2e.ts         # 2 passed: the shared refusal still leaves no root
```

- [ ] **Step 5: Commit**

```bash
git add cli/e2e/harness/daemon.ts cli/src/testing/daemonEnvironment.ts
git commit -m "CLI e2e: a daemon's home, temporary folders and shell are the harness's own"
```

---

### Task 5: A daemon and its tiles find the fake engines, the linked tools and nothing of the developer's

**Depends on:** Task 2 (`tmux.env.PATH`, and the `tile` and `typed` helpers), and through it Task 1.
**Effort:** xhigh (which engine a name starts, under whose login).

**Files:**
- Modify: `cli/e2e/harness/daemon.ts` (`create`: after the folders are made, and lines 362-366)
- Test: `cli/e2e/developerState.e2e.ts` (two cases)
- Modify: `cli/e2e/shells.e2e.ts:86`
- Modify: `cli/src/testing/daemonEnvironment.ts:18-19` (comment only)

**The tests that fail before the change:** in `cli/e2e/developerState.e2e.ts`, "finds its own engines first in a
tile's login shell, whatever the system's profile puts ahead of them" and "finds no engine of the developer's by name:
its PATH is its own bin, the linked tools and the system's folders".

**Interfaces:**
- Consumes: `tmux.env.PATH` (Task 2); `tile(d, client, name)` and `typed(d, pane, line, file)` (Task 2).
- Produces: `d.env.PATH === '<root>/bin:<root>/tools:/usr/bin:/bin:/usr/sbin:/sbin'` (a daemon beside another: its
  own `bin` first); `d.env.HERMES_PATH === '<bin>/hermes'`; `$ZDOTDIR/.zshenv` and `$ZDOTDIR/.zprofile`, each one
  line, written once by the daemon that is not `beside` another.

**Local end-to-end runs:** `e2e/developerState.e2e.ts`, `e2e/shells.e2e.ts`, `e2e/dotfiles.e2e.ts` and
`e2e/workspacesProcess.e2e.ts`. None types an engine's name: the PATH cases ask with `whence -p`. Do not run any file
the Global Constraints list; they are Verification 4's, after this task's two cases are green on the final head.

- [ ] **Step 1: The two cases**

In `cli/e2e/developerState.e2e.ts`, `appendFileSync` and `writeFileSync` join the `node:fs` import. Last in the
`describe`:

```ts
  it('finds its own engines first in a tile\'s login shell, whatever the system\'s profile puts ahead of them', async () => {
    const d = daemon = await IsolatedDaemon.create()
    failed(d)
    // As macOS's /etc/zprofile does (path_helper), on any machine, and like it in a login shell only: a folder put
    // ahead of the daemon's own, after the harness's line in .zshenv and before its line in .zprofile. Its engines
    // only leave a mark, and nothing runs them.
    const decoy = join(scratch, 'decoy'), mark = join(scratch, 'decoy-ran')
    mkdirSync(decoy)
    for (const name of ['claude', 'codex']) writeFileSync(join(decoy, name), `#!/bin/sh\necho ${name} >> ${mark}\n`, { mode: 0o755 })
    appendFileSync(join(d.env.ZDOTDIR!, '.zshenv'), `[[ -o login ]] && path=(${decoy} $path)\n`)
    // The startup lines are the home's, written once: a daemon beside the first adds no second.
    await IsolatedDaemon.create({ beside: d })
    expect(readFileSync(join(d.env.ZDOTDIR!, '.zprofile'), 'utf8').trim().split('\n')).toHaveLength(1)
    await d.start()
    const client = await LocalClient.connect(d)
    try {
      const { tmuxPane } = await tile(d, client, 'path')
      // Asked, never typed: on a developer's Mac the name alone would start their real engine.
      expect(await typed(d, tmuxPane, 'whence -p claude codex', join(d.root, 'resolved')))
        .toBe(`${join(d.root, 'bin', 'claude')}\n${join(d.root, 'bin', 'codex')}\n`)
      expect(existsSync(mark)).toBe(false)
    } finally { client.close() }
  })

  it('finds no engine of the developer\'s by name: its PATH is its own bin, the linked tools and the system\'s folders', async () => {
    // A folder of the developer's PATH with two engines in it, as ~/.opencode/bin and ~/.local/bin are: made up, and
    // each would only leave a mark.
    const theirs = join(scratch, 'their-bin'), mark = join(scratch, 'their-engine-ran')
    mkdirSync(theirs)
    for (const name of ['opencode', 'cursor-agent']) writeFileSync(join(theirs, name), `#!/bin/sh\necho ${name} >> ${mark}\n`, { mode: 0o755 })
    vi.stubEnv('PATH', `${theirs}:${process.env.PATH}`)
    const d = daemon = await IsolatedDaemon.create()
    failed(d)
    // A yes or a no, never the folders: at the base they are the developer's own.
    const own = d.env.PATH!.split(':').filter((folder) => !['/usr/bin', '/bin', '/usr/sbin', '/sbin'].includes(folder))
    expect(own.length === 2 && own[0] === join(d.root, 'bin') && own[1] === join(d.root, 'tools'), 'PATH: its bin, the linked tools, the system\'s folders').toBe(true)
    // The one engine whose recipe names a path outside any home (/usr/local/bin/hermes, lib/engineInstall.ts): the
    // daemon's Hermes is its own bin's, missing until a test writes one.
    expect(d.env.HERMES_PATH).toBe(join(d.root, 'bin', 'hermes'))
    await d.start()
    const client = await LocalClient.connect(d)
    try {
      const { tmuxPane } = await tile(d, client, 'other-engines')
      // Asked, never typed. `whence -p` prints nothing for a name it cannot find.
      expect(await typed(d, tmuxPane, 'whence -p opencode cursor-agent', join(d.root, 'resolved-others'))).toBe('')
      expect(existsSync(mark)).toBe(false)
    } finally { client.close() }
  })
```

- [ ] **Step 2: See them fail, and commit them**

```bash
cd cli && export TMPDIR=/private/tmp/claude-503/iso2-t5/ SHELL=/bin/zsh && mkdir -p "$TMPDIR"
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/developerState.e2e.ts -t 'finds its own engines first|finds no engine of the developer'
```

Expected: `2 failed`, the others skipped. The first on a missing `.zprofile` (`ENOENT`): no daemon is started and
nothing is asked. The second on `PATH: its bin, the linked tools, the system's folders: expected false to be true`,
before its daemon starts. Neither prints a folder of the real `PATH`, and neither runs anything.

```bash
git add cli/e2e/developerState.e2e.ts
git commit -m "CLI e2e: a tile finds the fake engines and no engine of the developer's (red tests)"
```

- [ ] **Step 3: `IsolatedDaemon.create`**

Three changes in `cli/e2e/harness/daemon.ts`:

1. After the folders are made, for a daemon that is not `beside` another, appended (`{ flag: 'a' }`), each once:

   | File | Line |
   | --- | --- |
   | `<home>/.zshenv` | `HARNESS_E2E_PATH=$PATH` |
   | `<home>/.zprofile` | `[[ -n $HARNESS_E2E_PATH ]] && PATH=$HARNESS_E2E_PATH` |

   The comment says: macOS's `/etc/zprofile` runs `path_helper`, which puts `/etc/paths` (`/usr/local/bin` first) and
   `/etc/paths.d` ahead of the `PATH` a login zsh was handed, so `claude` or `codex` typed into a tile was the
   developer's real engine, under their login (audit of 2026-11-15; seven cases of `enginehomes.e2e.ts` on a
   developer's Mac). `.zshenv` is read before `/etc/zprofile` and notes the `PATH`; `.zprofile` is read right after
   it and sets it again, before any `.zshrc` and any later `.zprofile` line a test writes, which keep the last word.
   Nothing `path_helper` adds stays. The `PATH` is noted, not written here: a daemon beside another shares this home
   and has a `bin` of its own. The variable is not exported. A test that types an engine's name appends to these two
   files and never truncates them. Only zsh is covered: a test that types one under bash or tcsh sets its `PATH` back
   itself.
2. In `own`, `PATH` becomes `` `${dirs.bin}:${tmux.env.PATH}` ``: the daemon's fakes and stubs first, as today, then
   the fixture's linked tools and the system's folders (`src/testing/testPath.ts`), and never the worker's `PATH`. The
   comment says why (the spec's Problem 4: the developer's folders are absolute, so the throwaway home hid none of
   them, and every engine but the two pinned ones was theirs).
3. In `own`, after `CODEX_PATH`: `HERMES_PATH: join(dirs.bin, 'hermes'),` with why (decision 4).

- [ ] **Step 4: The case with no startup files, and the comment**

- `cli/e2e/shells.e2e.ts:86`: `for (const name of ['.zshenv', '.zprofile', '.zshrc']) rmSync(join(d.env.ZDOTDIR!, name))`.
  Its last assertion (`:99`) already names all four files.
- `cli/src/testing/daemonEnvironment.ts`, the comment above `'PATH'`: both callers set their own
  (`testPath.ts`); it is still inherited for a caller of this function that sets none.

- [ ] **Step 5: See them pass**

```bash
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/developerState.e2e.ts                       # every case passed: 9 with Task 4 in, 8 without
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/shells.e2e.ts e2e/dotfiles.e2e.ts e2e/workspacesProcess.e2e.ts
```

Expected of the second: 3 files passed, none failed: `shells` (8 cases: bash, tcsh, and zsh with no startup files),
`dotfiles` (2: it overwrites `.zprofile` and loses the line, which its cases never need), `workspacesProcess` (the
daemon's `git`, through its link). A "not found" in a daemon's log or a pane is a tool the audit missed: it goes on
Task 1's list with its reason, test first in `testPath.spec.ts`, and the report names it.

- [ ] **Step 6: Commit**

```bash
git add cli/e2e/harness/daemon.ts cli/e2e/shells.e2e.ts cli/src/testing/daemonEnvironment.ts
git commit -m "CLI e2e: a daemon and its tiles find the fake engines, the linked tools and nothing of the developer's"
```

---

### Task 6: The close ends what was left in the root's folders

**Depends on:** nothing. It shares `cli/e2e/leftBehind.e2e.ts` with Task 7. **Effort:** xhigh (it kills processes:
what it may match, and what it must never).

**Files:**
- Modify: `cli/src/testing/rootProcesses.ts`
- Test: `cli/src/testing/rootProcesses.spec.ts`
- Test: `cli/e2e/leftBehind.e2e.ts` (one case)

**The tests that fail before the change:** in `cli/src/testing/rootProcesses.spec.ts`, the nine cases of Step 1; in
`cli/e2e/leftBehind.e2e.ts`, "ends what a tile left running in its folder, though its command line names nothing of
the root".

**Interfaces** (all in `cli/src/testing/rootProcesses.ts`; the rule is [The sweep's rule](#the-sweeps-rule)):

```ts
export interface Places { tmp: string; home: string; checkout: string }
/** Throws unless [root] is a root a test made. [at] is for the spec: os.tmpdir(), the account's home, this file's folder. */
export function assertTestRoot(root: string, at?: Places): void
export interface FolderRow { pid: number; uid: number; folder: string }
/** The rows of `lsof -a -d cwd -F pnu`. */
export function lsofFolders(output: string): FolderRow[]
/** pid to folder, of the account [uid] alone. */
export function ownFolders(rows: FolderRow[], uid: number): Map<number, string>
/** The working folder of each of this account's processes: lsof on macOS, /proc on Linux. Empty, and one line logged, when none can be read. */
export function workingFolders(table: ProcessRow[], uid?: number): Map<number, string>
export function rootProcesses(root: string, table: ProcessRow[], self?: number, folders?: ReadonlyMap<number, string>): RootProcesses
export async function endRootProcesses(root: string, ms?: number): Promise<string[]>   // as today, for IsolatedDaemon.close
```

`endRootProcesses` calls `assertTestRoot(root)` first, then reads the table and the folders, and goes on as today.
`rootProcesses` keeps its own check of the name, as today. `IsolatedDaemon.close` does not change.

**Local end-to-end run:** `e2e/leftBehind.e2e.ts`. It types `nohup sleep 600`, and two stand-ins of its own by name
only after the tile has said that each name is the stand-in's file: on a machine where it is not, the case fails
there and types neither. Do not change that order.

- [ ] **Step 1: The unit cases**

In `cli/src/testing/rootProcesses.spec.ts`: `mkdirSync`, `realpathSync` and `symlinkSync` join the `node:fs` import,
`vi` the Vitest one, and `assertTestRoot`, `lsofFolders`, `ownFolders` and `workingFolders` the one from
`./rootProcesses.js`. The five cases of `describe('rootProcesses')` stay as they are. After it:

```ts
// A real engine started by name in a tile names no root: `claude`, `claude --resume <id>`. Many were found on a
// developer's Mac, parented to pid 1, each with its working folder in a test's root (audit of 2026-11-15).
describe('a process whose working folder is in the root', () => {
  it('is the test\'s, alone or with the group it leads, though its command line names nothing', () => {
    const table = [...OWN, row(100, 1, 100, 'claude'), row(101, 100, 100, 'node mcp-server'), row(110, 1, 90, 'claude --resume 1'),
      row(120, 1, 120, 'sleep 600'), row(130, 1, 130, 'sleep 600'), row(140, 1, 140, 'sleep 600')]
    // 120 is in a root whose name begins this one's, 130 outside, 140 not known.
    const folders = new Map([[100, ROOT], [110, `${ROOT}/projects/a`], [120, `${ROOT}d/projects`], [130, '/tmp']])
    expect(rootProcesses(ROOT, table, 50, folders)).toEqual({ groups: [100], pids: [110], all: [100, 101, 110] })
  })

  it('is never the caller, its parent or pid 1', () => {
    const table = [row(1, 0, 1, 'launchd'), ...OWN]
    expect(rootProcesses(ROOT, table, 50, new Map([[1, ROOT], [40, ROOT], [41, ROOT], [50, `${ROOT}/x`]]))).toEqual({ groups: [], pids: [40], all: [40] })
  })

  it('is read from lsof\'s fields, and kept only for a process of this account', () => {
    const rows = lsofFolders(`p100\nu501\nfcwd\nn${ROOT}/a b\np200\nu0\nfcwd\nn${ROOT}\np300\nu501\nfcwd\nn/\n`)
    expect(rows).toEqual([{ pid: 100, uid: 501, folder: `${ROOT}/a b` }, { pid: 200, uid: 0, folder: ROOT }, { pid: 300, uid: 501, folder: '/' }])
    expect([...ownFolders(rows, 501)]).toEqual([[100, `${ROOT}/a b`], [300, '/']])
    // Another account's process in the root is judged by its command line alone.
    const table = [...OWN, row(100, 1, 100, 'sleep 600'), row(200, 1, 200, 'sleep 600')]
    expect(rootProcesses(ROOT, table, 50, ownFolders(rows, 501))).toEqual({ groups: [100], pids: [], all: [100] })
  })

  it('is read for this process, on this machine', () => {
    expect(workingFolders(processTable()).get(process.pid)).toBe(realpathSync(process.cwd()))
  })

  it.runIf(process.platform === 'darwin')('is unknown, said once, when lsof cannot run: the sweep then goes by command line', () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('PATH', '/nowhere')
    try {
      expect(workingFolders([])).toEqual(new Map())
      expect(said.mock.calls).toEqual([[expect.stringMatching(/^\[e2e sweep\] no working folders read \(lsof: .+\): swept by command line alone$/)]])
    } finally { vi.unstubAllEnvs(); said.mockRestore() }
  })
})

describe('a test root', () => {
  let made: string[] = []
  afterEach(() => { for (const folder of made) rmSync(folder, { recursive: true, force: true }); made = [] })
  /** A temporary folder with a root in it, a home and a checkout beside them: all made up. */
  const places = () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'root-guard-')))
    made.push(base)
    for (const name of ['tmp/htmux-abc', 'home', 'repo/cli/src/testing']) mkdirSync(join(base, name), { recursive: true })
    return { base, root: join(base, 'tmp', 'htmux-abc'), at: { tmp: join(base, 'tmp'), home: join(base, 'home'), checkout: join(base, 'repo', 'cli', 'src', 'testing') } }
  }

  it('is a folder isolatedTmux made, given as its real path, there or already removed', () => {
    const { root, at } = places()
    expect(() => assertTestRoot(root, at)).not.toThrow()
    rmSync(root, { recursive: true })
    expect(() => assertTestRoot(root, at)).not.toThrow()
  })

  it('is nothing else: not a folder outside the temporary one or deeper in it, a link, the home, or what holds the checkout', () => {
    const { base, root, at } = places()
    mkdirSync(join(root, 'htmux-deeper'))
    symlinkSync(join(base, 'home'), join(at.tmp, 'htmux-link'))
    const refused = (path: string, where = at) => expect(() => assertTestRoot(path, where), path).toThrow(`not a test root (isolatedTmux's <tmp>/htmux-XXXXXX): ${path}`)
    for (const path of ['', '/', at.tmp, 'htmux-abc', join(at.tmp, 'htmux-'), join(at.tmp, 'other'), join(base, 'htmux-abc'), join(root, 'htmux-deeper'), join(at.tmp, 'htmux-link')]) refused(path)
    // A temporary folder that is the home's parent, or the checkout's: the root would be the home, or hold the checkout.
    refused(root, { ...at, home: root })
    refused(root, { ...at, checkout: join(root, 'repo', 'cli', 'src', 'testing') })
    // Given through a link to the temporary folder: not its real path.
    symlinkSync(at.tmp, join(base, 'tmp-link'))
    refused(join(base, 'tmp-link', 'htmux-abc'))
  })
})
```

In `describe('endRootProcesses')`, the existing case's folder becomes
`realpathSync(mkdtempSync(join(tmpdir(), 'htmux-')))` (its real path, as `isolatedTmux` gives one), and two cases
follow it:

```ts
  it('ends a process left in the root whose command line names nothing, and none in a folder whose name begins the root\'s', async () => {
    const dir = root = realpathSync(mkdtempSync(join(tmpdir(), 'htmux-')))
    mkdirSync(join(dir, 'projects'))
    mkdirSync(`${dir}x`)
    const inside = spawn('sleep', ['600'], { cwd: join(dir, 'projects'), stdio: 'ignore' }), beside = spawn('sleep', ['600'], { cwd: `${dir}x`, stdio: 'ignore' })
    started = [inside, beside]
    await until(() => processTable().filter((each) => (each.pid === inside.pid || each.pid === beside.pid) && each.command === 'sleep 600').length === 2 || null)
    try {
      expect(await endRootProcesses(dir)).toEqual([])
      expect([alive(inside.pid!), alive(beside.pid!)]).toEqual([false, true])
      // A second close of the same daemon: the root is gone, and nothing is left to end.
      rmSync(dir, { recursive: true, force: true })
      expect(await endRootProcesses(dir)).toEqual([])
    } finally { rmSync(`${dir}x`, { recursive: true, force: true }) }
  })

  it('signals nothing, and says which, for a root that is not a test\'s', async () => {
    const outer = root = realpathSync(mkdtempSync(join(tmpdir(), 'root-guard-')))
    const link = join(realpathSync(tmpdir()), `htmux-link-${process.pid}`)
    mkdirSync(join(outer, 'htmux-abc'))
    symlinkSync(outer, link)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      for (const path of ['/', realpathSync(tmpdir()), outer, join(outer, 'htmux-abc'), link]) {
        await expect(endRootProcesses(path), path).rejects.toThrow(`not a test root (isolatedTmux's <tmp>/htmux-XXXXXX): ${path}`)
      }
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
      rmSync(link, { force: true })
    }
  })
```

- [ ] **Step 2: The end-to-end case**

In `cli/e2e/leftBehind.e2e.ts`: `mkdirSync`, `readFileSync` and `writeFileSync` join the `node:fs` import, and
`import { workingFolders } from '../src/testing/rootProcesses.js'` is added. Before the `it.each` of the worker:

```ts
  // What was found on a developer's Mac (audit of 2026-11-15): real engines left by hand in a tile, parented to pid 1,
  // their command lines naming nothing of the root and their working folders inside it: `claude` most of them, 5
  // `opencode` and 4 `cursor-agent` beside them. A `sleep` stands in for the first, and a script of the test's own
  // for each of the other two.
  it('ends what a tile left running in its folder, though its command line names nothing of the root', async () => {
    const d = daemon = await IsolatedDaemon.create()
    await d.start()
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'left')
    mkdirSync(cwd, { recursive: true })
    const opened = await client.request('agent_create', { engine: 'terminal', cwd }, 60_000)
    expect(opened.error, JSON.stringify(opened)).toBeUndefined()
    const pane = await until('the terminal tile to be up', async () => {
      const { agents } = await client.request<{ agents: Array<{ id: string; status: string; tmuxPane?: string }> }>('agents_list', { includeStopped: true }, 30_000)
      const now = agents.find((agent) => agent.id === opened.agent.id)
      return now?.status === 'active' && now.tmuxPane ? now.tmuxPane : null
    }, 60_000, 250)
    client.close()
    /** What [line], typed into the tile, wrote into [file], moved into place whatever the line returned. */
    const typed = async (line: string, file: string): Promise<string> => {
      await d.tmux.run('send-keys', '-t', pane, '-l', `${line} > ${file}.tmp; mv ${file}.tmp ${file}`)
      await d.tmux.run('send-keys', '-t', pane, 'Enter')
      return until(`the tile to write ${file}`, () => existsSync(file) ? readFileSync(file, 'utf8') : null, 30_000, 100)
    }
    // Deaf to the hangup its pane's end sends, and in a process group of its own: as an engine left running is.
    const left = [Number(await typed('nohup sleep 600 >/dev/null 2>&1 & echo $!', join(d.root, 'left.pid')))]
    watched = [...left]
    // The other engines: stand-ins in the daemon's own bin, each deaf to the hangup, saying its pid and then a `sleep`.
    const bin = join(d.root, 'bin'), others = ['opencode', 'cursor-agent']
    for (const name of others) {
      const said = join(d.root, `${name}.pid`)
      writeFileSync(join(bin, name), `#!/bin/sh\ntrap '' HUP\necho $$ > ${said}.tmp && mv ${said}.tmp ${said}\nexec sleep 600\n`, { mode: 0o755 })
    }
    // Asked before typed: a name that is not the stand-in's file is never run. On a developer's Mac it could be theirs.
    expect(await typed(`whence -p ${others.join(' ')}`, join(d.root, 'resolved'))).toBe(others.map((name) => `${join(bin, name)}\n`).join(''))
    for (const name of others) {
      await d.tmux.run('send-keys', '-t', pane, '-l', `${name} &`)
      await d.tmux.run('send-keys', '-t', pane, 'Enter')
      left.push(await until(`the ${name} stand-in to say its pid`, () => existsSync(join(d.root, `${name}.pid`)) ? Number(readFileSync(join(d.root, `${name}.pid`), 'utf8')) : null, 30_000, 100))
      watched = [...left]
    }
    await until('all three to be a sleep', () => processTable().filter((row) => left.includes(row.pid) && row.command === 'sleep 600').length === 3 || null, 10_000, 100)
    await d.close()
    daemon = undefined
    expect(left.filter(alive), 'what the tile left').toEqual([])
    const table = processTable(), folders = workingFolders(table)
    const inRoot = (pid: number) => { const folder = folders.get(pid); return folder === d.root || folder?.startsWith(`${d.root}/`) }
    expect(table.filter((row) => row.command.includes(`${d.root}/`) || inRoot(row.pid)).map((row) => row.command)).toEqual([])
  })
```

The `afterEach` already kills `watched` by pid: all three go there should the case fail.

- [ ] **Step 3: See them fail, and commit them**

```bash
cd cli && export TMPDIR=/private/tmp/claude-503/iso2-t6/ SHELL=/bin/zsh && mkdir -p "$TMPDIR"
npx vitest run src/testing/rootProcesses.spec.ts
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/leftBehind.e2e.ts -t 'ends what a tile left running'
```

Expected: the unit file `9 failed | 6 passed (15)` on macOS: the two match cases on an empty answer, five on a
function that is not there yet, "ends a process left in the root" on `expected [ true, true ] to deeply equal
[ false, true ]`, and "signals nothing" on `promise resolved "[]" instead of rejecting`. The end-to-end case
`1 failed | 7 skipped (8)`, on `what the tile left`, three pids alive; or, on a Mac whose login shell finds another
`opencode` or `cursor-agent` first and before Task 5 is in, at the `whence -p` line, with nothing typed. Either is
red; say which in the report. After each run: `ps -o pid=,command= -p <pid>` for any pid the output names must show
nothing.

```bash
git add cli/src/testing/rootProcesses.spec.ts cli/e2e/leftBehind.e2e.ts
git commit -m "CLI e2e: a close ends what was left in the root's folders (red tests)"
```

- [ ] **Step 4: The sweep**

Write the functions of the Interfaces block to [The sweep's rule](#the-sweeps-rule). What the rule and the tests
leave open:

- The log line when no folder can be read: `[e2e sweep] no working folders read (lsof: <why>): swept by command line
  alone`, `<why>` being the error's message, or `exit <status>` when lsof printed nothing.
- `lsof` through `spawnSync`, so that an exit status of 1 does not throw away what it printed; `maxBuffer` as
  `processTable`'s.
- The file's header gains the third reason beside the two of today: a process started by name in a pane names no
  root, and a real engine survives its pane's end.

- [ ] **Step 5: See them pass**

```bash
npx vitest run src/testing/rootProcesses.spec.ts                                   # 15 passed (14 on Linux)
npm run typecheck                                                                  # no error
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/leftBehind.e2e.ts   # 8 passed
```

`leftBehind.e2e.ts` whole: its other cases close a daemon too, through the new sweep. On a Mac where the new case
still stops at its `whence -p` line, it passes once Task 5 is in: say so, and it is run again in Verification 4.

- [ ] **Step 6: Commit**

```bash
git add cli/src/testing/rootProcesses.ts
git commit -m "CLI e2e: a close ends a process whose working folder is in the test's root"
```

---

### Task 7: The reaper ends them too, when a worker went without closing

**Depends on:** nothing. It shares `cli/e2e/leftBehind.e2e.ts` with Task 6, so the two never run at once.
**Effort:** xhigh (it kills processes, from a process nobody watches).

**Files:**
- Modify: `cli/e2e/harness/reaperProcess.mjs` (`endRootProcesses`, `reap`, the header)
- Test: `cli/src/testing/reaperProcess.spec.ts` (three cases)
- Modify: `cli/e2e/harness/abandonedWorker.ts:18-19,26`
- Test: `cli/e2e/leftBehind.e2e.ts` (the `Started` type, the `afterEach`, the worker's `it.each`)

**The tests that fail before the change:** in `cli/src/testing/reaperProcess.spec.ts`, "ends a process whose folder is
in a root it was told, and leaves one in a folder whose name only begins the root's" and "sweeps and removes nothing in
a folder named like a root that is not directly in the temporary folder, or is a link"; in
`cli/e2e/leftBehind.e2e.ts`, the three "is gone, tmux server and all, once the worker that started it …" cases, on
what the worker's pane left. The third unit case, "takes a working folder only from a process of its own account",
runs on macOS only and holds a guard: at the base it fails too, as nothing is matched by folder.

**Interfaces:**
- Consumes: [The sweep's rule](#the-sweeps-rule), whole. Nothing of Task 6's code.
- Produces: nothing another task uses. `abandonedWorker.ts` prints one more field, `left`, the pid its pane left.

**Local end-to-end run:** `e2e/leftBehind.e2e.ts`, the worker's cases. They type nothing into a pane.

- [ ] **Step 1: The unit cases**

In `cli/src/testing/reaperProcess.spec.ts`, the existing case stays as it is. The imports gain `spawn` and
`ChildProcess`, `once` from `node:events`, `realpathSync` and `symlinkSync`, `describe`, and `alive` from
`./spawnedRuns.js`. After it:

```ts
describe.skipIf(process.platform === 'win32')('the worker\'s reaper and a process left in a root\'s folder', () => {
  const folders: string[] = []
  const started: ChildProcess[] = []
  afterEach(() => {
    for (const child of started.splice(0)) child.kill('SIGKILL')
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  })
  /** A `sleep` in [cwd], running: its command line names nothing. */
  const sleeper = async (cwd: string): Promise<ChildProcess> => {
    const child = spawn('sleep', ['600'], { cwd, stdio: 'ignore' })
    started.push(child)
    await once(child, 'spawn')
    return child
  }
  const gone = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null
  /** The reaper, told [lines], its worker then gone: what it wrote, once it has exited. Not spawnSync: this worker
   *  must be free to reap its own children, or one the reaper ended stays a zombie, alive to a signal. */
  const reaped = async (lines: object[], env: NodeJS.ProcessEnv = process.env): Promise<string> => {
    const reaper = spawn(process.execPath, [REAPER], { stdio: ['pipe', 'ignore', 'pipe'], env })
    let said = ''
    reaper.stderr!.on('data', (chunk: Buffer) => { said += chunk.toString() })
    reaper.stdin!.end(lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
    const [code] = await once(reaper, 'exit')
    expect(code, said).toBe(0)
    return said
  }

  it('ends a process whose folder is in a root it was told, and leaves one in a folder whose name only begins the root\'s', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'htmux-')))
    folders.push(dir, `${dir}x`)
    mkdirSync(join(dir, 'work'))
    mkdirSync(`${dir}x`)
    const inside = await sleeper(join(dir, 'work')), beside = await sleeper(`${dir}x`)
    const said = await reaped([{ tmux: join(dir, 'no-server'), root: dir }])
    await expect.poll(() => gone(inside), { timeout: 10_000 }).toBe(true)
    expect(inside.signalCode).toBe('SIGKILL')
    expect(alive(beside.pid!)).toBe(true)
    expect(existsSync(dir)).toBe(false)
    expect(said).toContain(`[e2e reaper] ended 1 processes that still named ${dir} or ran in it`)
  })

  it('sweeps and removes nothing in a folder named like a root that is not directly in the temporary folder, or is a link', async () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), 'reaper-guard-')))
    const nested = join(outer, 'htmux-abc'), elsewhere = join(outer, 'elsewhere'), link = join(realpathSync(tmpdir()), `htmux-link-${process.pid}`)
    folders.push(outer, link)
    for (const folder of [nested, elsewhere]) { mkdirSync(folder); writeFileSync(join(folder, 'kept'), '') }
    symlinkSync(elsewhere, link)
    const kept = [await sleeper(nested), await sleeper(elsewhere)]
    const said = await reaped([{ tmux: join(outer, 'no-server-1'), root: nested }, { tmux: join(outer, 'no-server-2'), root: link }])
    for (const refused of [nested, link]) expect(said).toContain(`[e2e reaper] not a test root, left alone: ${refused}`)
    expect(kept.map((child) => alive(child.pid!))).toEqual([true, true])
    expect([nested, elsewhere].map((folder) => existsSync(join(folder, 'kept')))).toEqual([true, true])
  })

  // Linux reads /proc, which nothing here can stand in for: there the owner of /proc/<pid> is the same check.
  it.runIf(process.platform === 'darwin')('takes a working folder only from a process of its own account', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'htmux-'))), outside = realpathSync(mkdtempSync(join(tmpdir(), 'reaper-uid-')))
    folders.push(dir, outside)
    const mine = await sleeper(outside), theirs = await sleeper(outside)
    // An lsof that puts both in the root, the second as another account's. The real one lists another account's only for root.
    const bin = join(outside, 'bin'), uid = process.getuid!()
    mkdirSync(bin)
    writeFileSync(join(bin, 'lsof'), `#!/bin/sh\nprintf 'p%s\\nu%s\\nfcwd\\nn%s\\n' ${mine.pid} ${uid} ${dir}/work ${theirs.pid} ${uid + 1} ${dir}/work\n`, { mode: 0o755 })
    await reaped([{ tmux: join(dir, 'no-server'), root: dir }], { ...process.env, PATH: `${bin}:${process.env.PATH}` })
    await expect.poll(() => gone(mine), { timeout: 10_000 }).toBe(true)
    expect(alive(theirs.pid!)).toBe(true)
  })
})
```

- [ ] **Step 2: The worker, and its cases**

`cli/e2e/harness/abandonedWorker.ts`, in place of its `new-session` line: the session runs, in the daemon's projects
folder, a shell that leaves a `sleep` behind and writes its pid, and the worker waits for the pid and prints it:

```ts
// Its tmux server, which an agent's pane would have started. And in it what a tile leaves behind: a `sleep` deaf to
// the hangup its pane's end sends, its command line naming nothing of the root, its working folder inside it.
const leftFile = join(daemon.root, 'left.pid')
await daemon.tmux.run('new-session', '-d', '-s', 'left-behind', '-c', daemon.projectsDir,
  '/bin/sh', '-c', 'nohup sleep 600 >/dev/null 2>&1 & echo $! > "$0.tmp" && mv "$0.tmp" "$0"; exec sleep 600', leftFile)
const left = await until('what its pane left', () => existsSync(leftFile) ? Number(readFileSync(leftFile, 'utf8')) : null, 10_000, 50)
```

`left` joins the JSON it prints, `existsSync` and `readFileSync` its `node:fs` import, and one clause its header.

`cli/e2e/leftBehind.e2e.ts`: `Started` gains `left: number`; the `afterEach` also kills `started.left` when it is
alive, by its pid; and the worker's `it.each` ends with:

```ts
    // And what its pane left in the root's folders, which no process group and no command line reaches.
    expect(alive(started.left), 'what the worker\'s pane left').toBe(false)
```

after the wait for the root to be removed: the reaper sweeps before it removes.

- [ ] **Step 3: See them fail, and commit them**

```bash
cd cli && export TMPDIR=/private/tmp/claude-503/iso2-t7/ SHELL=/bin/zsh && mkdir -p "$TMPDIR"
npx vitest run src/testing/reaperProcess.spec.ts
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/leftBehind.e2e.ts -t 'once the worker that started it'
```

Expected: the unit file `3 failed | 1 passed (4)` on macOS (`2 failed | 1 passed (3)` on Linux): the first and third
on a `sleep` that never goes, the second on a missing `not a test root, left alone` line. The end-to-end cases
`3 failed`, each on `what the worker's pane left: expected true to be false`. After the runs, `ps -p <pid>` for each
pid named: none left.

```bash
git add cli/src/testing/reaperProcess.spec.ts cli/e2e/harness/abandonedWorker.ts cli/e2e/leftBehind.e2e.ts
git commit -m "CLI e2e: the reaper ends what a worker's pane left in the root's folders (red tests)"
```

- [ ] **Step 4: The reaper's copy**

In `cli/e2e/harness/reaperProcess.mjs`, to [The sweep's rule](#the-sweeps-rule):

- `isTestRoot(root)`: the rule's check, true or false. `reap` asks it where the name check is today, and logs the
  line of today when it is false. The checkout is the folder of this file.
- `workingFolders(table)`: the rule's map, with the account check inside it.
- `endRootProcesses(root)`: a match is the rule's. Its two lines become
  `[e2e reaper] ended <n> processes that still named <root> or ran in it` and
  `[e2e reaper] pids <…> of <root> outlived SIGKILL by 5000 ms`.
- When no folder can be read: `[e2e reaper] no working folders read (lsof: <why>): swept by command line alone`.
- The header and the comment above `endRootProcesses` say what the sweep now reaches and why, and still name
  `src/testing/rootProcesses.ts` as the rule it copies.

- [ ] **Step 5: See them pass**

```bash
npx vitest run src/testing/reaperProcess.spec.ts                                                                         # 4 passed (3 on Linux)
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/leftBehind.e2e.ts -t 'once the worker that started it'   # 3 passed
```

- [ ] **Step 6: Commit**

```bash
git add cli/e2e/harness/reaperProcess.mjs
git commit -m "CLI e2e: the worker's reaper ends a process whose working folder is in a test's root"
```

---

## Left out

- The test-side helpers that hand `git` and `build-bundle.mjs` the developer's environment (`hachiVerbs`, `hachiWake`,
  `storeProcess`, `workspacesProcess`, `workspacesFolders`, `harness/bundle.ts` and a dozen files): the spec's
  Follow-up. They run in the test's own process, with the worker's `PATH`.
- The allowlist's names: unchanged. `SHELL` stays on it for a tmux server a test starts itself, `PATH` for a caller
  that sets none.
- Windows: `testPath.ts` has no branch for it (decision 7), and only `TEMP` and `TMP` are for it.
- Shells other than zsh: a test that names bash or tcsh still runs `/etc/profile` or `/etc/csh.login` and its
  `path_helper` on macOS. None types an engine's name.
- `agentBrowserPodman.e2e.ts:193` and `agentBrowser.e2e.ts:87-90` keep their own lines: they come after the
  harness's and keep the last word.
- The three callers that name the worker's `PATH` themselves (`terminalClose.real.spec.ts`,
  `tmuxBackend.contract.spec.ts`, `guestParity.real.spec.ts`): the spec keeps what they pass. They type no engine's
  name.
- A tile on a tmux server the test's own client started: no engine on its `PATH`, the fake ones neither. No test
  types one there.
- Engines beside the daemon's own Node (question 3), and a tmux server a unit spec's in-process `TmuxBackend`
  starts (question 7).
- `cli/AGENTS.md`: no text changes. Rule 6 already says a test never uses the developer's own machine, and still
  names `isolatedTmux.ts` for what it does.
- The real engines already running on the developer's Mac: not this change's to end. The new sweep matches only the
  root it is given, so it never reaches them either.
- `spawnedRuns.ts`'s own search by root (`belonging`): command lines only, as it was; no caller of it runs a pane.

## Verification

On the final head, after the review. Isolation is the repo's own (`cli/AGENTS.md`, rules 5 and 6), which this change
completes: every file boots its own daemons under a throwaway root, with a private tmux server and fake engines,
signed out, its backend at `127.0.0.1:9`. No real account, no production, nothing of the developer's daemon
(port 18473), `~/.harness`, `~/.claude` or `~/.codex`. Every variable the new tests set is made up. None of these
checks needs Diego himself.

**The order is the rule.** On this Mac real engines are in `/usr/local/bin`, in the developer's own folders and
beside their Node. Check 3 is first among the end-to-end checks, and check 4 starts only when check 3 has passed
whole on the same head in the same shell session, by its exit status (`check 3 && check 4`, never a line read by
eye). If it has not, stop and report: nothing that types an engine's name runs. Never `npm run test:tmux-real`,
`tmuxAgentDiscovery.real.spec.ts` or `agentBrowserPodman.e2e.ts` here.

Local checks run on this Mac (macOS, tmux, zsh), in `cli/`, one command at a time:

```bash
cd cli && export TMPDIR=/private/tmp/claude-503/iso2-v/ SHELL=/bin/zsh && mkdir -p "$TMPDIR"
```

1. **The unit specs and the typecheck.**

   ```bash
   npx vitest run src/testing/testPath.spec.ts src/testing/isolatedTmux.spec.ts src/testing/rootProcesses.spec.ts \
     src/testing/reaperProcess.spec.ts src/lib/tmuxBackend.spec.ts src/lib/nativePaneHold.spec.ts \
     src/lib/tmuxExternalAdoption.spec.ts src/lib/harnessSessionLabel.spec.ts src/lib/callerPane.spec.ts
   npm run typecheck
   ```

   To see: 9 files passed, `137 passed` (the base: 8 files, 116): `testPath` 5, `isolatedTmux` 6, `rootProcesses`
   15, `reaperProcess` 4, the five under `src/lib` 107 as before. The typecheck prints no error. PR CI runs the same
   files on Linux, where `isolatedTmux`'s pane cases and the others' tmux cases are skipped: this run is their
   evidence.

2. **The specs behind a switch, once** (question 1). None starts an engine: each runs a script or a `sleep` of its
   own.

   ```bash
   RUN_REAL_TMUX_DISCOVERY=1 npx vitest run src/lib/engineShellStartup.spec.ts src/lib/codexUpdateRestart.real.spec.ts \
     src/lib/restartDiscovery.real.spec.ts src/lib/terminalClose.real.spec.ts src/lib/engineStop.real.spec.ts \
     src/lib/unusedCodexClose.spec.ts
   RUN_DARWIN_PROCESS_IMAGES=1 npx vitest run src/lib/processImages.real.spec.ts
   (cd .. && python3 scripts/local-checks.py --run)
   ```

   To see: `6 passed (6)` files, every case passed (64 at the old base); then `2 passed`; then the receipt, one
   `harness-local-checks` fence with `cli-pty` and `cli-shell` passed, from a clean tree at the final commit. The
   fence goes into the pull request body before the push. These panes now have the fixture's `PATH`: a case that
   fails on a command not found names a tool for the list. Not run, each an unverified row:
   `tmuxAgentDiscovery.real.spec.ts` and `guestParity.real.spec.ts`.

3. **The developer's state, first of the end-to-end checks.**

   ```bash
   caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/developerState.e2e.ts
   ```

   To see: `Tests 9 passed (9)`, "finds its own engines first in a tile's login shell" and "finds no engine of the
   developer's by name" among them. At the base commit the same file, with these cases, is `5 failed | 4 passed (9)`.

4. **The files that type an engine's name, and one for each tool of the list.** Only after check 3, in one line with
   it:

   ```bash
   caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/developerState.e2e.ts && \
   caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/enginehomes.e2e.ts e2e/hookclient.e2e.ts \
     e2e/shells.e2e.ts e2e/leftBehind.e2e.ts e2e/workspacesProcess.e2e.ts
   ```

   To see: `hookclient` 10, `shells` 8, `leftBehind` 8 and `workspacesProcess` passed whole (they run `node` in
   every hook, `bash` and `tcsh`, the sweep at every close, and the daemon's `git`). `enginehomes`: 34 cases; the
   Claude cases that type `claude` pass, having reached the fake engine. A Codex case that types `codex` and then
   holds is read in its daemon log: on `the native control helper is unavailable`, it is the source-run daemon of
   question 2, reported with that line and the case's name, compared with the same case at the base commit
   (`git archive d5202f76b9 cli | tar -x -C <a folder of the check's own>`, `node_modules` linked in, the same
   `SHELL` and a TMPDIR of its own, and there without its ten cases that type a name:
   `-t '^(?!.*(typed into a terminal|typed in |started by hand in a terminal|holds binding|native discovery cooldown))'`,
   24 cases). Any other red is a finding. About 20 minutes on a busy Mac. A "not found" in a daemon's log or a pane
   is a tool the audit missed: reported, and added in this pull request.

5. **The sweep's time for each close, before and after.** A script of the check's own, kept in `$TMPDIR` and never
   committed, times `endRootProcesses` on an empty root eleven times:

   ```bash
   cat > "$TMPDIR/sweep-time.mts" <<'EOF'
   import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
   import { tmpdir } from 'node:os'
   import { join } from 'node:path'
   import { pathToFileURL } from 'node:url'
   const { endRootProcesses } = await import(pathToFileURL(join(process.argv[2], 'src/testing/rootProcesses.ts')).href)
   const root = realpathSync(mkdtempSync(join(tmpdir(), 'htmux-')))
   const times: number[] = []
   for (let run = 0; run < 11; run++) { const from = performance.now(); await endRootProcesses(root); times.push(performance.now() - from) }
   rmSync(root, { recursive: true, force: true })
   times.sort((a, b) => a - b)
   console.log(`sweep of an empty root, 11 runs: median ${times[5].toFixed(0)} ms, fastest ${times[0].toFixed(0)} ms, slowest ${times[10].toFixed(0)} ms`)
   EOF
   npx tsx "$TMPDIR/sweep-time.mts" "$PWD"                 # after
   npx tsx "$TMPDIR/sweep-time.mts" <a copy of the base>   # before
   ```

   The copy of the base is check 4's. To see, and to put in the pull request: both lines. Not measured in planning;
   from the two calls timed apart, about 105 ms before (`ps`) and about 460 ms after (`ps` and `lsof`). The sweep
   runs once for each test root at teardown, off every hot path.

6. **Nothing left.** After checks 3 to 5, by this run's own folder, counted and never listed:

   ```bash
   lsof -a -d cwd -F pn 2>/dev/null | grep -c "^n$(cd "$TMPDIR" && pwd -P)/"
   ps -A -o command= | grep -c "$(cd "$TMPDIR" && pwd -P)/htmux-"
   ```

   To see: `0`, and `1` (the `grep` itself). A number above that is reported with the pids, and they are ended only
   if this run started them.

On GitHub, by hand, **one run, only on a runner turn from the orchestrator**, after the branch is pushed (shared
runners, `docs/validation-and-release.md`). Report the run's link.

7. **The whole suite on Linux, and the full disk on macOS:** the existing workflow, eight Linux shards and one macOS
   runner. The change reaches every daemon under test and every test that starts tmux.

   ```bash
   gh workflow run cli-e2e.yml --ref fix/e2e-isolation-2
   ```

   To see: `e2e (1)` to `e2e (8)`, `e2e (macOS, full disk)` and `e2e-summary` green; `e2e/developerState.e2e.ts` and
   `e2e/leftBehind.e2e.ts` in the summary's verified files; `e2e/enginehomes.e2e.ts` whole, 34 cases. It proves the
   startup lines against a decoy on Linux, the `/proc` half of the sweep, every link of the tool list but `podman`
   on a runner (Node from the tool cache, `tcsh` and `dash` from apt), and that no file needed a variable or a
   folder its daemon or its tmux server no longer inherits. A red test is reported with its link and whether main's
   last nightly run has it too. A file that fails on a command not found: the tool goes on the list with its reason,
   test first. One that needed an inherited variable: the name goes in that caller's own argument, or on the
   allowlist with its reason and an assertion in `daemonEnvironment.spec.ts` if every caller needs it. Both in this
   pull request, and the orchestrator decides on the rerun.

Not checked, and said so in the pull request, each an unverified row, never a passing one:
`tmuxAgentDiscovery.real.spec.ts` (it starts real engines); `guestParity.real.spec.ts` (no guest account here);
`freshMachineEngines.e2e.ts` on a Mac (question 3; check 7 holds it on Linux);
`agentBrowserPodman.e2e.ts` and with it the `podman` link (question 5); `tuiShell.e2e.ts` (it needs an `hn` build no
workflow gives it); `opencodeLaunchCost.e2e.ts`, the one file the `HERMES_PATH` pin changes (a cost measurement, run
when asked); the refusal on a machine without `/bin/zsh`; the Windows names beyond their values.

**Temporary workflow:** none. The long check has a workflow already (`.github/workflows/cli-e2e.yml`, run by hand from
a branch and every night), which finds the new cases by itself.

**Beside the end-to-end checks:** PR CI runs by itself what a `cli/` change selects, `cli-typecheck` and `cli-tests`
first: there `testPath.spec.ts`, the source check, the root guard, the `/proc` half of the folder map and the reaper's
two cases run on every pull request. **Checks PR CI does not run:** `cli-pty` and `cli-shell`, by check 2's receipt.
`npm run test:core` and `test:harnessd` are not needed: nothing under `cli/src/core`, `cli/src/services` or
`cli/src/harnessd` changes.
