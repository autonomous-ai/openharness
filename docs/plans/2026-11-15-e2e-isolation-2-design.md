# E2E isolation, part 2: no developer state reaches a test's tmux server, panes or engines: design

Part 1 (#4318, merged, `docs/plans/2026-11-15-e2e-daemon-isolation-design.md`) gave every `IsolatedDaemon` an allowlist of
inherited variables (`src/testing/daemonEnvironment.ts`). Its review found two more holes, both on `main` before it and
both checked again with made-up values only. This change closes them, on `main` after #4318 (ae1f9d4f9d).

## Problem

### 1. A login shell in a pane finds the developer's real Claude Code and Codex

The harness puts its `bin` (fake `claude` and `codex`, the `gh`, `security` and `sudo` stubs) first on the daemon's
`PATH`. A terminal tile opens the login shell, and on macOS `/etc/zprofile` runs `path_helper`, which puts every folder
of `/etc/paths` (`/usr/local/bin` first) ahead of whatever `PATH` it was handed. Typing `claude` or `codex` in a tile
then starts the real engine, under the developer's login, not the fake one. Checked here with an empty `ZDOTDIR` and a
`PATH` of `<fake bin>:/usr/bin:/bin`: a login zsh's `whence -p claude` names `/usr/local/bin/claude`; with
`path=(<fake bin> $path)` in `$ZDOTDIR/.zprofile`, the fake. Seven of the 32 cases of `e2e/enginehomes.e2e.ts` hit it on a
developer's Mac; so does any test that types an engine's name. `agentBrowserPodman.e2e.ts` already works around the same
`path_helper` for its own bin, in that one file.

The shell itself is the developer's too: `SHELL` is on the allowlist, so a developer whose login shell is bash, fish or
tcsh runs every tile under it, and bash's `/etc/profile` and fish run `path_helper` as well.

### 2. A tmux server a test starts itself gets the developer's whole environment

`src/testing/isolatedTmux.ts` builds its `env` as `{ ...process.env, TMUX_TMPDIR }` and runs every `run(...)` with it.
The first tmux client to reach a socket starts its server, and the server's global environment is that client's
environment. So when the test, not the daemon, opens the first session (`harness/abandonedWorker.ts`,
`hookclient.e2e.ts` "own session", `tmuxmoves.e2e.ts`, `typingLatency.e2e.ts`, `races.e2e.ts` sibling, and about twenty
unit specs under `src/lib/`), every pane on that server, the daemon's own panes included, inherits the developer's
`SSH_AUTH_SOCK`, API keys and every other variable; the fake engines and the hooks they run see them too. Checked here:
a server started by a client holding `FAKE_DEV_SECRET`, then a pane opened by a client with a clean environment (as the
daemon's): the pane has `FAKE_DEV_SECRET`. Even when the daemon starts the server first, tmux's default
`update-environment` copies `SSH_AUTH_SOCK` (and `DISPLAY`, `SSH_CONNECTION`, `XAUTHORITY`...) from the test's client into
each session it creates. `HOME` and `ZDOTDIR` are the developer's there too, so a login shell in such a pane reads the
developer's `.zshrc` and `.zprofile`.

### 3. A process that names no root on its command line outlives its test

The developer's Mac has several real `claude` processes parented to pid 1, each with its working folder in an e2e
`htmux-*` root: the real engines of hole 1, left behind. Teardown (`IsolatedDaemon.close`, and the worker's reaper,
`e2e/harness/reaperProcess.mjs`, when a worker goes without closing) stops the daemon's process groups, kills the tmux
server, then ends what is left by command line: `src/testing/rootProcesses.ts` matches only a process whose command
line names `<root>/`. A process started in a pane by name (`claude`, `claude --resume <id>`, anything a test or an
engine starts with `nohup` or in a group of its own) names no root, survives the server's SIGHUP when it ignores it or
has left the pane's group, and is never matched. The real Claude Code does exactly that.

### 4. The developer's PATH folders hold their other real engines

The allowlist keeps the developer's `PATH` whole, and its folders are absolute: on this Mac it holds `~/.opencode/bin`,
`~/.local/bin` (`cursor-agent`, `claude`), `~/.grok/bin`, `~/.antigravity/...`, `/usr/local/bin` and more, so the
throwaway `HOME` hides none of them. The harness pins only `CLAUDE_PATH` and `CODEX_PATH`; every other engine
(`engineBin`, `src/lib/engineBin.ts`: `OPENCODE_PATH || 'opencode'` and the rest) is found by name on that `PATH`, by the
daemon and by a tile, and is the developer's real one. The PM's census of 2026-11-15 found 153 orphans with their
working folder in an `htmux-*` root: 121 `claude`, 23 `node`, 5 `opencode`, 4 `cursor-agent`, some nearly two days old.
On CI no other engine is installed, so the same tests there see none: the result depends on the machine.

## Goal

No process an end-to-end test starts (the daemon, a tmux server, the shells in its panes, the fake engines and their
hooks) sees the developer's environment, dotfiles, credentials or real engines, and the fake engines always win on
`PATH` in a pane's login shell; no other engine is found at all, as on CI. None outlives its test: once a test's teardown has run, whether the test passed, failed
or timed out, or its worker went without closing, no process is left whose command line names its root or whose working
folder is inside it.

## Change

1. **`isolatedTmux(own = {})`** (`src/testing/isolatedTmux.ts`) builds its environment from #4318's allowlist, as the
   daemon's is: `daemonEnvironment(process.env, { HOME: <root>/home, ZDOTDIR: <root>/home, TMPDIR: <root>/t, ...own,
   TMUX_TMPDIR: <root> })`. It makes `<root>/home` with an empty `.zshrc` (Debian's, Ubuntu's and Fedora's zsh otherwise
   open the new-user menu in every pane; the reason `IsolatedDaemon.create` writes one today, which then stays only as its
   append to the same file) and `<root>/t` (the daemon's own `TMPDIR` folder today, so a pane on a server the test
   started keeps its temporary files in the root too). Its parameter changes meaning, from the whole inherited
   environment to what the caller sets on top:
   - callers that passed `{ ...process.env, X }` pass `{ X }` (`harnessSessionLabel.spec.ts`,
     `codexUpdateRestart.real.spec.ts`, `processImages.real.spec.ts`); their panes move from the developer's `HOME` to
     `<root>/home` unless they name one;
   - `tmuxBackend.spec.ts:896` passes what it adds to its already filtered `inherited` (`HARNESSD_*`, `HOME`, `ZDOTDIR`,
     `HISTFILE`) as `own`;
   - callers that pass a minimal environment (`guestParity.real.spec.ts`, `terminalClose.real.spec.ts`,
     `tmuxBackend.contract.spec.ts`: `PATH`, `TERM`, `LANG`) keep passing it, and gain the rest of the allowlist and the
     pinned `HOME`, `ZDOTDIR`, `TMPDIR`;
   - callers that pass an environment already made clean (`races.e2e.ts` `d.env`, `nativePaneHold.spec.ts` `tmux.env`)
     pass it as is.
   `TMUX` and `TMUX_PANE` are still deleted after the merge: they are not on the allowlist, but a caller's `own` can carry
   them (a caller forwarding a parent's environment; `isolatedTmux.spec.ts`'s first case does so on purpose). The unit
   specs change only in what they pass; no test changes what it asserts. The plan lists each caller. The two `.real`
   specs run only with `RUN_REAL_TMUX_DISCOVERY=1`; the plan runs them so once.
2. **`IsolatedDaemon.create`** (`e2e/harness/daemon.ts`):
   - shares that home: `dirs.home` is `tmux.env.HOME` (the same `<root>/home` as today);
   - pins `TEMP` and `TMP` to the same folder as `TMPDIR` (`dirs.tmp`). Windows' `os.tmpdir()` reads them, not
     `TMPDIR`, and the allowlist of #4318 dropped them, so a daemon there fell back to `%SystemRoot%\temp`, outside its
     root (PM, 2026-11-15). Not on the allowlist: the parent's is never used, as for `TMPDIR`;
   - pins `SHELL: '/bin/zsh'` in `own`, so the shell of every tile is the same on every machine and never the
     developer's choice. CI already sets it (`cli-e2e.yml`, every e2e job installs zsh); macOS ships it. A test that wants
     another shell still names it in `options.env` (`shells.e2e.ts`, `restoreInput.e2e.ts`, `suspend.e2e.ts`,
     `eagerHooks.e2e.ts`), and `enginehomes.e2e.ts`'s "given no SHELL" case still deletes it. No fallback to another
     shell: every runner has `/bin/zsh`, and a machine without it fails at `create` with an error that names it, after
     closing and forgetting the tmux `isolatedTmux` already made, as the socket-path refusal does (`daemon.ts:296-304`;
     not for a daemon `beside` another, whose tmux and root are the other's). A second way would be a second rule to
     keep true;
   - gives a pane's login zsh back the `PATH` it was handed, whole, after `/etc/zprofile`: a line in `$ZDOTDIR/.zshenv`
     (read before `/etc/zprofile`) notes `$PATH`, and a line in `$ZDOTDIR/.zprofile` (read right after it, before the
     `.zshrc` a test writes) sets `PATH` to it again. So nothing `path_helper` adds (`/usr/local/bin`, `/etc/paths.d`)
     stays, and the `PATH` of Change 4 is all a tile has. Not a path written into the file: a daemon `beside` another
     shares its home but has its own bin, and each tile must keep its own daemon's. Written once, by the daemon that is
     not `beside` another, appended (a test's own lines stay). A test's own `.zshrc` (`tuiShell.e2e.ts`,
     `freshMachineEngines.e2e.ts`) and its own later `.zprofile` lines (`agentBrowserPodman.e2e.ts`,
     `agentBrowser.e2e.ts:87-89`, other bins first) still have the last word. A non-login shell never reads
     `/etc/zprofile` and keeps the daemon's `PATH`. `shells.e2e.ts`'s "zsh user with no startup files" removes both files
     as it removes `.zshrc`. The daemon's own login-shell read (`lib/loginShellEnv.ts`, `zsh -lic`) reads them too, so
     what it learns from the login shell (`engineBinary`, `engineFileStamp`, `launchEnvironment`) names the fakes and no
     real engine: intended.
   - Only zsh is covered. A test that names bash or tcsh (`shells.e2e.ts`, `restoreInput.e2e.ts`, `suspend.e2e.ts`,
     `eagerHooks.e2e.ts`) runs `/etc/profile` or `/etc/csh.login` and its `path_helper` on macOS; none of them types an
     engine's name or calls `connectors elsewhere`, and the comment at the harness's lines says a test that does under
     another shell puts the bin back itself.

3. **A process whose working folder is inside the root is the test's too** (`src/testing/rootProcesses.ts`
   `rootProcesses`, and its copy in `e2e/harness/reaperProcess.mjs`, which plain Node cannot import from TypeScript):
   a match is a process whose command line names `<root>/` or whose working folder is the root or inside it
   (`cwd === root || cwd.startsWith(root + '/')`). The root is a unique `mkdtemp` folder (`htmux-*`, checked as today),
   so a working folder in it is that test's (a person's own shell `cd`'d into a test root would be ended too: accepted).
   The working folders are a separate map, pid to folder, read once per sweep and passed to `rootProcesses`, not added to
   `processTable` (whose other callers stay as fast as they are): `lsof -a -d cwd -F pn` on macOS (one call, the
   account's own processes; measured here 0.27 s for 656 of 900), `/proc/<pid>/cwd` on Linux. `lsof` exits 1 when some
   process cannot be read: its output still counts; only no output at all (missing, failed to start) is a failure. A
   process whose folder cannot be read (another account's, or gone) is judged by its command line alone, as today.
   Two guards, since the sweep kills (PM, 2026-11-15), each with a unit test, in both copies:
   - **The root is one a test made**, checked before anything is read or signalled: absolute; its real path directly
     inside the real path of the worker's temporary folder (`os.tmpdir()`); its name `htmux-` and more (the check
     today); and not `/`, the account's home, or the checkout or anything that holds it. Otherwise the sweep throws,
     naming the root, and signals nothing.
   - **Only the account's own processes, never the caller's**: the folder map holds only processes of the sweep's own
     uid (`lsof` lists only those without root, and the map checks the uid it reports, `-F pnu`; on Linux the owner of
     `/proc/<pid>`), so a working-folder match is always the account's; the sweep's own pid, its parent and pid 1 are
     never matched, by command line or folder (as today). A folder matches only when it equals the root or starts with
     the root plus `/`, so `/tmp/htmux-1` never matches `/tmp/htmux-10`. A match that leads its process group is ended with the group, as today, so a real
   engine's children (its MCP servers, its shell tools) go with it. Both teardown paths use it: `IsolatedDaemon.close`
   after the tmux server is killed (a test that failed or timed out still runs its `afterEach`, which closes the
   daemon), and the reaper when the worker went without closing. A close that still finds one alive throws, naming its
   pid and command, as today. The sweep runs once per test root at teardown, off every hot path; the plan records its
   time before and after on this Mac.

4. **`PATH` is an allowlist too** (a new `src/testing/testPath.ts`, used by `isolatedTmux` and `IsolatedDaemon.create`):
   - `<root>/tools` holds a link to each tool the tests and the daemon run by name, to the absolute path the worker's own
     `PATH` resolves it to (`resolveBinaryOnPath`, once per worker, cached), never a folder and never an engine. A tool
     the worker does not have is left out, and `create` does not fail on it; a test that needs it skips with its reason
     (as `shells.e2e.ts` does for zsh today). Eight tools, each with its reason in a comment:
     | Tool | Why |
     |---|---|
     | `node` | the running `process.execPath`, not a lookup: hook command lines and `#!/usr/bin/env node` scripts run it by name |
     | `tmux` | the daemon's terminal backend and the tests' own servers |
     | `git` | workspaces, the Store, worktrees, the tests' own repositories |
     | `zsh` | the tiles' shell (`SHELL`, Change 2) |
     | `bash`, `tcsh`, `dash` | the shells `shells.e2e.ts`, `restoreInput.e2e.ts`, `suspend.e2e.ts` and `eagerHooks.e2e.ts` name; CI's Linux may lack `tcsh` or `dash` |
     | `podman` | the agent browser files (Homebrew's on macOS) |
     The plan audits every command the e2e files and the daemon run by name and adds any other it finds, with its reason;
     the list never holds an engine's name.
   - The `PATH` is `<bin>:<root>/tools:/usr/bin:/bin:/usr/sbin:/sbin` for a daemon (its fakes and stubs first, as today),
     `<root>/tools:/usr/bin:/bin:/usr/sbin:/sbin` for a server a test starts (`isolatedTmux`'s pin, under `own`), and
     never anything of the worker's `PATH`. The system folders hold `ps`, `lsof`, `sh`, `env`, `sleep` and the rest, and no
     engine on macOS or on CI's Linux. A test that names its own `PATH` (`options.env`, `own`) still wins.
   - So no engine but the harness's fakes and a test's own stand-ins is found by name, by the daemon or in a tile: every
     other engine is "not installed", as on CI. One engine has an absolute install path in its recipe
     (`/usr/local/bin/hermes`, `lib/engineInstall.ts`); no e2e file uses Hermes, and the plan checks whether the daemon
     probes that path before it is needed (if so, `HERMES_PATH` is pinned to a missing file in the root).
   - POSIX only: Windows runs no e2e (no tmux), and its `PATH` keeps today's rule.

What does not change: the allowlist itself (`SHELL` stays on it for `isolatedTmux`'s own callers, whose tmux falls back to
the account's shell anyway), the daemon's other pins, and the test-side helpers that run `git` or `build-bundle.mjs` with
`{ ...process.env, ... }` (they run no agent code and no pane; see Follow-up).

## Tests (red first, made-up values only)

No red or green run ever starts a real engine: the PATH test asks the shell where `claude` and `codex` resolve
(`whence -p`) and never types them, and the files that type an engine's name (`enginehomes.e2e.ts` and the others) run
on this Mac only after that test is green.

- `src/testing/isolatedTmux.spec.ts` (unit): with `vi.stubEnv` putting `FAKE_DEV_SECRET`, a fake `SSH_AUTH_SOCK` and a
  fake `HOME` holding a `.zshrc` that prints a marker into this worker's environment, a pane opened through
  `isolatedTmux().run('new-session', ..., '/bin/zsh', '-l', '-i')` (zsh named, not the allowlisted `SHELL`) has neither
  variable, its `HOME`, `ZDOTDIR` and `TMPDIR` are under the root, and it never prints the marker. A value in `own`
  reaches the pane. The zsh part skips where `/bin/zsh` is missing. PR CI's unit jobs install neither tmux nor zsh, so
  the file is skipped there: its red and green runs are taken locally and recorded in the PR.
- `e2e/developerState.e2e.ts` (the file #4318 added): its existing first case also asserts `d.env.TEMP` and `d.env.TMP`
  are `d.env.TMPDIR` while the worker's environment holds fake ones (red on the base; Windows itself runs no e2e). Two new
  cases:
  - **the test's own tmux session**: with a fake secret in the worker's environment, the test opens the first session
    (`d.tmux.run('new-session', ...)`) before `d.start()`, so its client starts the server; the daemon's terminal tile's
    environment then has no `FAKE_DEV_SECRET`. Red on the base. (`SSH_AUTH_SOCK` is not asserted here: tmux's
    `update-environment` drops a name the creating client lacks, and the daemon's has none, so that half is green on the
    base already; the unit case covers it, where the test's client opens the pane.)
  - **the fake engines win on PATH**: `$ZDOTDIR/.zshenv`, appended by the test after the harness's line, puts a decoy
    folder first on `PATH`, as `/etc/zprofile` does (it runs before `.zprofile`, so this reproduces `path_helper` on
    Linux CI too); the decoy holds a `claude` and a `codex` that only write a marker file. The test types
    `whence -p claude codex > <root>/resolved` into a terminal tile and reads the file: both are the daemon's own bin,
    and no marker exists. Red on the base on Linux (the decoy) and on macOS (the decoy, or `path_helper`'s
    `/usr/local/bin`); no engine runs either way.
- `src/testing/rootProcesses.spec.ts` (unit): a row whose command line names nothing but whose working folder is the root
  or inside it is matched (alone, or with its group when it leads one); a folder outside, a sibling whose name starts with
  the root's (`<root>x/...`), or none known, is not; a folder-matched row of another uid is not; the sweep's own pid and
  its parent are not, even with their folder in the root; a root outside the temporary folder, `/`, the home, the
  checkout or a name without `htmux-` throws before any signal (the kill function is stubbed and asserted uncalled). `src/testing/reaperProcess.spec.ts`, which drives the real reaper
  process: a `sleep` whose command line names nothing and whose working folder is in an `htmux-` root it registered is
  ended when its worker goes. Red on the base.
- Nothing is left after teardown (`e2e/leftBehind.e2e.ts`, two cases, red on the base; each kills its `sleep` by pid in
  `afterEach` should it fail):
  - **after a close**: a terminal tile runs `nohup sleep 600 >/dev/null 2>&1 & echo $! > <root>/left.pid` (no root on its
    command line, deaf to the server's SIGHUP, in a process group of its own, its working folder the tile's, inside the
    root), as a real engine left by hand would be; after `d.close()` that pid is gone and no process names the root or
    has its folder inside it.
  - **after a worker that went without closing**: `harness/abandonedWorker.ts` opens
    `d.tmux.run('new-session', '-d', '-c', <projects>, ...)` running the same line and reports the pid it wrote in its
    JSON; once the worker exits and the reaper has swept, it is gone.
- `src/testing/testPath.spec.ts` (unit, PR CI): no tool's name is an engine's command or launch name
  (`ENGINE_CLI_COMMANDS` in `src/lib/engineBin.ts` and the discovery aliases beside it, `agent`, `cmd`, `command-code`);
  each link is to an absolute file; a tool missing from a fake worker `PATH` is left out without an error; the `PATH`
  holds no folder of the worker's (a fake worker `PATH` with a fake `opencode` in it, and `opencode` does not resolve on
  the result). Red on the base (the module is new: red as missing).
- `e2e/developerState.e2e.ts`, one more case: with a fake `opencode` and a fake `cursor-agent` that only write a marker,
  in a folder put on the worker's `PATH` by `vi.stubEnv`, a terminal tile's `whence -p opencode cursor-agent` names
  neither, `d.env.PATH` has no folder of the worker's, and no marker exists. Red on the base.
- `e2e/leftBehind.e2e.ts`'s "after a close" case also types, in a tile, a stand-in `opencode` and `cursor-agent` that the
  test writes into the daemon's bin (each ignores SIGHUP, leaves its own group and sleeps, writing its pid): after
  `d.close()` both are gone. Red on the base (command lines without the root).
- `e2e/shells.e2e.ts`'s no-startup-files case stays green (it removes the harness's `.zshenv` and `.zprofile`).

## Verification

The change reaches every e2e daemon and every test that starts tmux, so the whole suite runs once on GitHub
(`cli-e2e.yml`, Run workflow on the branch, after a runner turn from the orchestrator). Locally, on this Mac (where the
real engines sit in `/usr/local/bin`), `e2e/developerState.e2e.ts` first, and the rest only once its PATH case is green:
`e2e/enginehomes.e2e.ts` (all 32 cases, the seven
that typed an engine's name included: they now reach the fake engines), `e2e/shells.e2e.ts`, `e2e/hookclient.e2e.ts`,
`e2e/leftBehind.e2e.ts` (runs `abandonedWorker.ts`), `src/testing/rootProcesses.spec.ts`,
`src/testing/reaperProcess.spec.ts`, the sweep's time per close before and after, and the unit specs that call `isolatedTmux` (`npx vitest run` on
those files; PR CI runs the unit suite). Platforms: macOS and Linux (e2e runs there; Windows has no tmux).

The real `claude` processes already left on the developer's Mac are not touched by this change or its checks; the
orchestrator clears them after the current dial test.

## Failure cases

- `lsof` missing or giving no output on macOS: the sweep falls back to command lines for that call and logs one line
  naming why, so a teardown never fails on it; a process it then misses is what the leftBehind cases catch.
- A test or the daemon runs a tool by name that is not on the list: it fails on a "not found"; the tool goes on the
  list with its reason, in this pull request (the local Mac run and the GitHub run find them).
- A unit spec or e2e file that needed an inherited variable in its tmux server fails: the variable goes in that caller's
  `own`, or on the allowlist with its reason if every caller needs it, in this pull request.
- A machine without `/bin/zsh`: `IsolatedDaemon.create` throws `"/bin/zsh is required: a daemon under test runs its
  tiles under zsh"`, after closing the tmux it made (see Change 2).
- A test that overwrites `.zshenv` or `.zprofile` (`dotfiles.e2e.ts` writes `.zprofile`) loses the PATH lines: it types
  no engine's name, and the comment at the harness's lines says a test that types one appends to them, never truncates.

## Follow-up (its own item)

Test-side helpers still hand children the developer's environment: `git` in `hachiVerbs`, `hachiWake`, `storeProcess`,
`workspacesProcess` (`{ ...process.env, HOME, GIT_CONFIG_NOSYSTEM }`), and every `build-bundle.mjs` call
(`harness/bundle.ts` and a dozen files). They run no pane or engine; a `GIT_DIR` or `GIT_*` of the developer's could still
point a test's `git` at the wrong repository.
