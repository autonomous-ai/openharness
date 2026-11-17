# The daemon starts from an explicit environment: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **devcrew phase 3**. Every task is test-first: a red commit (the
> tests alone), then the code commit; Task 9 (docs) changes no behavior and is one commit. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** On macOS and Linux, a daemon started by `harness start`, `harness start -f` or a dev run from the sources
gets only an explicit allowlist of the shell's environment, so another program's session tokens never reach the
daemon, its tmux server or a pane; what works under `harness service install` keeps working. Windows keeps today's
behavior.

**Architecture:** One pure function, `startEnvironment(env, platform)` in `cli/src/lib/startEnvironment.ts`, holds
the allowlist; the agent-session denylist (`isAgentSessionVariable`) wins over it; on `win32` it returns an unchanged
copy. It is applied in two places: the spawn of a background start (`daemonSpawnOptions` in `lib/daemonLaunch.ts`),
and in place on `process.env` before a start runs the master or the core in the CLI's own process (`-f`, and a dev
run), after which `HARNESS_ENV_FILE` is read again. `__harnessd`, `__run`, `__service` and the Windows `launchMaster`
are not changed. Each narrowing writes one count-only line to the daemon's log.

**Tech Stack:** TypeScript, Vitest 4.1.10, Node (CI pins 24.22.2), dotenv 17, tmux, zsh. No new dependency.

**Spec:** [docs/plans/2026-11-17-daemon-minimal-env-design.md](2026-11-17-daemon-minimal-env-design.md). Read it
with this plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority. Branch
`fix/daemon-minimal-env`, read at `b9a7280863`.

## Decided

By the orchestrator, 2026-11-17, final (the spec's Decisions 1 to 11):

1. **Design A.** Applied at the background spawn and in place before the master or core runs in the CLI's process.
   `__harnessd`, `__run`, `dropAgentSessionEnv` and the tmux server unset stay as they are.
2. **Provider credential prefixes are kept for now, each by name.** No `*TOKEN*` or `*KEY*` wildcard. The doc says
   they move to `HARNESS_ENV_FILE` next.
3. **Engine home and path settings are kept**, the six read through a parameter among them (`CURSOR_CONFIG_DIR`,
   `CURSOR_DATA_DIR`, `OPENCODE_DB`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `KILO_DB`).
4. **The agent-session denylist wins over the allowlist.**
5. **Windows keeps today's behavior.** `startEnvironment` returns an unchanged copy on `win32`; `launchMaster` is not
   changed; there is no Windows group and no case-insensitive matching. The doc names the follow-up: a start that
   reads the user's durable variables from the registry.
6. **Harness OS's `npm_config_prefix` and `BROWSER` are kept.**
7. **`XAUTHORITY` is kept**, beside `DISPLAY`.
8. **A dev run is narrowed too** (`harness start` from the sources, no `-f`). The two unit specs whose dev runs lose
   `VITEST` are fixed.
9. **Kept settings read through a parameter:** `SSH_CONNECTION`, `ZDOTDIR`, `WSL_DISTRO_NAME`, `GRID_HOME`,
   `GRID_CONTROL_PLANE_URL`, `LLAMA_SERVER`, `HC_SOCKET`.
10. **Dropped on purpose, the doc pointing to `HARNESS_ENV_FILE`:** `HC_SESSION`, `TYPESAFE_CREDENTIALS`,
    `GIT_SSH_COMMAND`.
11. **Names:** `lib/startEnvironment.ts`, `startEnvironment()`, `START_ENV_NAMES`, `START_ENV_PREFIXES`,
    `DROPPED_ON_PURPOSE`; the spec file `lib/startEnvironment.spec.ts`.

While planning, from the code at `b9a7280863` (say so if one is wrong):

1. **`HARNESS_ENV_FILE` is read again after the in-place narrowing.** `cli.ts` imports `config/loadEnv.ts` first, so
   by the time `launch()` runs, the file's variables are already in `process.env`, and narrowing in place takes out
   those not on the allowlist. A core that runs in the CLI's process (`start -f` with `HARNESS_NO_MASTER=1`, the
   Harness OS path, and a dev run) would start without them. So `config/loadEnv.ts` exports its load as
   `loadEnvFile(env)`, and the narrowing calls it (Tasks 2 and 4).
2. **The spawn options move to `lib/daemonLaunch.ts`** (`daemonSpawnOptions`), which exists "so they can be tested
   without a backend, a bundle, or a real child". Their `detached: true` moves with them, so
   `lib/windows/noWindow.spec.ts` lists `lib/daemonLaunch.ts` in place of `cli.ts` (Tasks 5 and 7).
3. **`cli.ts` cannot be loaded by a test** (it runs a command as it loads). Its call sites are asserted on the
   source, as `src/cliStopFirst.spec.ts` does, in `src/cliStartEnvironment.spec.ts`; pull request CI runs no
   end-to-end file, so this is what holds the wiring on every pull request.
4. **The log line's numbers:** N is how many variables the allowlist kept, M how many it left out, both of the
   CLI's own environment at the start. A variable the env file puts back is still counted in M. The function that
   makes it is `startEnvLine` (the module's other names follow decision 11).
5. **One code path on every platform.** The spawn and the in-place narrowing write their line on Windows too, where
   it says `0 left out`; no platform branch in `cli.ts`. The Windows `launchMaster` branch is not narrowed and writes
   no line.
6. **The in-place narrowing comes after the refusal beside a running daemon** (`refuseServedDataFolder`): a
   foreground start that leaves at once prints no `[env]` line (`e2e/twodaemons.e2e.ts` reads that output). The
   second call, before `runCoreInForeground`, is the first statement of the branch the core alone and a dev run share.
7. **The read-coverage test also reads a destructuring** (`const { NAME } = process.env`): the same read in a third
   spelling. One today, `services/osDevice.ts:120`, both names allowed.
8. **`DROPPED_ON_PURPOSE` is exported by `lib/startEnvironment.ts`** (the spec's "the lists"), a
   `Record<string, string>` of name to reason. Task 1 holds the eight the spec names; Task 3 adds the nine the scan
   finds (below). Nothing reads it but the two specs; `startEnvironment` drops its names because no group names
   them, and a unit case holds that no name is on both lists.
9. **"Allowed" in the read-coverage test is "kept on `linux`".** With no Windows group, the five names the code reads
   on Windows only (`ComSpec`, `LOCALAPPDATA`, `SystemRoot`, `USERPROFILE`, `windir`) are on no list; they go in
   `DROPPED_ON_PURPOSE` with one reason: read on Windows only, where a start keeps the whole environment
   (decision 5). This is the spec's rule ("allowed ... or listed in `DROPPED_ON_PURPOSE` with a one-line reason")
   applied to names its list did not count.
10. **Tests that start a daemon through `harness start` get the harness's own settings from an env file.**
    `IsolatedDaemon.shellEnv()` writes the settings the allowlist leaves out into a file under the test's root and
    names it in `HARNESS_ENV_FILE`: the spec's own remedy. Only the harness's settings and a test's `envFile`
    option go in; a test's `env` never does, so a sentinel stays a sentinel. With decisions 3 and 9 the harness's
    POSIX settings are all kept today (what is left out is Windows-only or unread), so the file mainly carries a
    test's `envFile`; it still holds any future harness setting the allowlist drops.
11. **The new end-to-end cases go into the two files that already own these starts:** `e2e/cli.e2e.ts` (the
    installed bundle's `harness start`) and `e2e/paneEnv.e2e.ts` (`start -f`). No new end-to-end file, so the
    nightly inventory is unchanged.
12. **A third end-to-end case, `start -f` with `HARNESS_NO_MASTER=1`,** beside the spec's two: the core runs in the
    narrowed process and reads the env file again. The dev run takes the same branch; it is held at the unit level by
    `src/cliCommand.spec.ts`, which runs it from the sources.
13. **The two dev-run specs keep `VITEST` through an env file.** `src/cliCommand.spec.ts` and
    `src/loginForceRace.spec.ts` each `envFor` writes `VITEST=true` to `<root>/test.env` and names it in
    `HARNESS_ENV_FILE`: the guard on the real `gh` (`lib/github.ts:41`) then holds in their dev-run daemons, by the
    same remedy the spec gives every other start (Task 8).

## Open questions

None.

## Global Constraints

- **The allowlist is the spec's table, verbatim** (macOS and Linux). Exact names: `PATH`, `HOME`, `USER`,
  `LOGNAME`, `SHELL`, `TMPDIR`, `TZ`, `LANG`, `LANGUAGE`, `SSH_AUTH_SOCK`, `SSH_CONNECTION`,
  `__CF_USER_TEXT_ENCODING`, `TMUX_TMPDIR`, `ZDOTDIR`, `WSL_DISTRO_NAME`; `DBUS_SESSION_BUS_ADDRESS`, `DISPLAY`,
  `WAYLAND_DISPLAY`, `XAUTHORITY`; `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`, `http_proxy`, `https_proxy`,
  `no_proxy`, `all_proxy`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`; `DOTENV_CONFIG_PATH`, `NODE_ENV`,
  every key of `config/env.ts` `fields`; `npm_config_prefix`, `BROWSER`; `CLAUDE_CONFIG_DIR`,
  `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `OPENCLAW_HOME`, `CODEX_PATH`, `CURSOR_CONFIG_DIR`,
  `CURSOR_DATA_DIR`, `OPENCODE_DB`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `KILO_DB`, `GRID_HOME`,
  `GRID_CONTROL_PLANE_URL`, `LLAMA_SERVER`, `HC_SOCKET`; `CLOUD_ML_REGION`. Prefixes, exactly these fourteen: `LC_`,
  `XDG_`, `HARNESS_`, `HARNESSD_`, `ADAPTER_`, `ANTHROPIC_`, `OPENAI_`, `AWS_`, `GOOGLE_`, `GEMINI_`, `AZURE_`,
  `OPENROUTER_`, `XAI_`, `CLAUDE_CODE_USE_`. A name matches as spelled.
- **`DROPPED_ON_PURPOSE`, from Task 1:** `TERM`, `COLORTERM`, `NODE_OPTIONS`, `TMUX`, `TMUX_PANE`, `HC_SESSION`,
  `TYPESAFE_CREDENTIALS`, `GIT_SSH_COMMAND`; Task 3 adds `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`,
  `UV_THREADPOOL_SIZE`, `VITEST`, `ComSpec`, `LOCALAPPDATA`, `SystemRoot`, `USERPROFILE`, `windir`. Agent-session
  variables are dropped by `isAgentSessionVariable`, not listed again.
- **Windows:** `startEnvironment(env, 'win32')` is a copy of `env`, equal and not the same object. `launchMaster`,
  `lib/platformDaemon.ts` and its spec do not change.
- **The log line, exactly:** `[env] started with N variables; M left out (docs/cli.md#the-daemons-environment)`,
  after the daemon log's timestamp. Counts only.
- **No name or value of a real variable** in a log line, an error, test output, a commit message or the pull
  request. Every sentinel is made up. An assertion that could print the worker's own environment is a yes or a no.
- **Not narrowed, not touched:** `__harnessd`, `__run`, `__service`, `launchMaster`, `masterProcess.ts`,
  `dropAgentSessionEnv`, `holdHarnessdEnv`, `tmuxBackend.ts serverVariablesToUnset`.
- **The core grows nothing.** No file under `cli/src/core`, `cli/src/services` or `cli/src/harnessd` changes, and
  `src/architecture.coreFiles.txt` does not change: `lib/startEnvironment.ts` is imported only by `cli.ts`,
  `lib/daemonLaunch.ts`, `testing/startEnvFile.ts` and specs. If a task finds it must touch one of those folders,
  stop and report.
- **No quoted path into another top-level directory** in `cli/src` or `cli/e2e/harness` (a string that starts with
  `docs/`, `os/`, `desktop/` and the like, or a `../` path out of `cli/`): `scripts/ci-plan.py` counts it as a read
  another suite must rerun for, and a new one needs a planner change with two security reviews. The doc link is
  written inside the log sentence, after `(`, never as a string of its own. No reason in `DROPPED_ON_PURPOSE` starts
  a string with a folder name and a slash. No CLI test reads `docs/cli.md`.
- No new option, setting, switch or dependency. No `*TOKEN*` or `*KEY*` pattern anywhere.
- A failing or flaky test is a bug, fixed at its layer: never skipped, loosened or retried. No fixed sleeps.
- **End-to-end runs use `IsolatedDaemon` only:** a throwaway root, a free port, a private tmux server, fake
  engines, signed out, backend at `127.0.0.1:9`. Never the developer's daemon (port 18473), tmux server,
  `~/.harness`, `~/.claude` or `~/.codex`. Each local run is under `caffeinate -i`, on an arm64 Node
  (`node -p process.arch`), with `SHELL=/bin/zsh` and a short `TMPDIR` of the task's own
  (`/private/tmp/claude-503/denv-t<N>/`, made first with `mkdir -p`: an agent's `TMPDIR` is too long for the
  daemon's socket).
- **Only your own processes and folders.** Other sessions run end-to-end tests on this Mac. End only what your own
  test started, by exact pid or socket; never `pkill`, `killall` or a pattern.
- No local full suite. The `cli-e2e` and `Windows` workflows are heavy: each one run, on a runner turn from the
  orchestrator, never together.
- Comments say why, in plain sentences, and name the design
  (`docs/plans/2026-11-17-daemon-minimal-env-design.md`).
- A commit adds its files by name. The documents under `docs/plans/` are untracked here and are no task's.
- Platforms: macOS and Linux change; Windows runs the changed code with its behavior unchanged. One pull request;
  its body names them and carries each task's red and green output and the Verification results.

## Found while reading the code

Read at `b9a7280863`. Nothing was run but read-only scans of `cli/src` and `scripts/local-checks.py --list`. No
test, no daemon.

**What the daemon reads.** A TypeScript-AST scan of `cli/src` (not `*.spec.*`, `*.test.*`, `testing/`, `e2e/`,
`__fixtures__/`, `fixtures/`) finds 50 names read as `process.env.NAME`, `process.env['NAME']` or a destructuring.
The allowlist keeps 39. Of the eleven it leaves out, `TERM` (`lib/oneshot.ts:44`) and `TMUX_PANE`
(`lib/uninstall/deps.ts:47`) are in Task 1's `DROPPED_ON_PURPOSE`; the other nine are Task 3's:

| Name | Read in | Why it is dropped |
|---|---|---|
| `GIT_CONFIG_GLOBAL` | `lib/agentProject.ts:228` | git's own move of its global config; without it the daemon watches `~/.gitconfig`, as under launchd and systemd |
| `GIT_CONFIG_SYSTEM` | `lib/agentProject.ts:230` | the same for `/etc/gitconfig` |
| `UV_THREADPOOL_SIZE` | `engines/kit/nativeHookFiles.ts:348` | Node's thread pool size; the daemon runs on Node's default of 4 |
| `VITEST` | `lib/github.ts:41` | the test runner's mark, so a unit test never runs the real `gh`; no daemon is given it |
| `ComSpec` | `engines/kit/windowsInstall.ts:102` | read on Windows only, where a start keeps the whole environment |
| `LOCALAPPDATA` | `config/env.ts:192` | the same (Hermes' home on Windows) |
| `SystemRoot` | `lib/runtimeInstall.ts:42`, `lib/uninstall/removal.ts:410` | the same |
| `USERPROFILE` | `lib/windows/guestHelperInstallWin.ts:27` | the same |
| `windir` | `lib/uninstall/removal.ts:410` | the same |

No `process.env[...]` with a computed name reads anything but `HARNESSD_*` (`leanEntry.ts`, `leanCoreEntry.ts`).
Reads through a parameter that defaults to `process.env` are outside this scan; decisions 3 and 9 name those kept,
and Task 1's unit case pins them.

**Starts that pass test-only variables, and how each keeps working.**

| Where | The start | Variables the allowlist drops | Plan |
|---|---|---|---|
| `e2e/master.e2e.ts:122` | `IsolatedDaemon` `foreground: true` (`start -f`) | the harness's `USERPROFILE`, `LOCALAPPDATA`, `APPDATA`, `TEMP`, `TMP` (Windows-only), `ANALYTICS_ENABLED` (unread); inherited `TERM`, `CI` | Task 6: `start()` uses `shellEnv()`, which carries them in `HARNESS_ENV_FILE`. No edit to the file |
| `e2e/cli.e2e.ts` (six `harness(m, 'start')`, and `service uninstall`'s restart) | the installed bundle's `harness start` | the same, `TERM`, `CI`. Its own `PATH`, `XDG_CONFIG_HOME` and `HARNESSD_TEST_PLATFORM` are allowed | Task 7: `install()` builds its environment from `await daemon.shellEnv()` |
| `e2e/twodaemons.e2e.ts:224,228` | `start`, `start --foreground` beside a running daemon | none reach a daemon: both leave before a spawn or a narrowing | no change (decision 6) |
| `e2e/sandbox.e2e.ts:73,92` | `start` in a sandbox | none: refused before the spawn; `CODEX_SANDBOX` is read by the CLI's own process before any narrowing | no change |
| every other end-to-end file | `__harnessd` or `__run` (`e2e/harness/daemon.ts:509`) | not narrowed: `NODE_OPTIONS` preloads, `HARNESSD_TEST_FAULTS` and the like arrive as before | no change |
| `src/cliCommand.spec.ts`, `src/loginForceRace.spec.ts` | a dev run from the sources (tsx; its loader travels in `execArgv`, not the environment) | `VITEST`, inherited from the worker; their `TMUX` (set empty or undefined to be gone). Every setting they name is allowed | Task 8: `VITEST` through an env file (decision 13) |
| `cli/scripts/box-claim-e2e.ts:200` (opt-in, by hand) | a bundle's `harness start` | `ANALYTICS_ENABLED` (nothing reads it), `TMUX`, `TMUX_PANE` (set empty to be gone) | no change |
| `desktop/tool/test_flavor.py` (`flavor_env`) | Desktop's own `harness start` | `TERM`, `CLAUDE_SECURESTORAGE_CONFIG_DIR` (the CLI does not read it; it equals `CLAUDE_CONFIG_DIR`, which is kept) | no change |
| `.github/workflows/windows.yml` install job | `harness.exe start` on a runner, through `launchMaster` | none: Windows is not narrowed | no change; Verification 5 runs it |

**Coverage gates.** `python3 scripts/local-checks.py --list` over every path in the File map prints `{}`: no gate
applies. `npm run test:core` (`src/core`, `src/services`) and `npm run test:harnessd` (`src/harnessd`) cover folders
this plan does not touch. `lib/startEnvironment.ts` is outside every per-file gate; its spec still exercises every
branch.

**No name clash.** `src/testing/daemonEnvironment.ts` exports a `daemonEnvironment(inherited, own)`: the test
harness's own, stricter allowlist, used by `e2e/harness/daemon.ts`. It stays; the product's function is
`startEnvironment` (decision 11).

**The spec's branch note.** `fix/harnessd-process-title-env` edits the same spawn; whichever merges second rebases.
Task 7 leaves the `namedNode(...)` argument and the argv as they are.

## File map

| File | Task | What changes |
|---|---|---|
| `cli/src/lib/startEnvironment.ts` (new) | 1, 3, 4 | the lists, `startEnvironment`, `startEnvLine`; then nine reasons; then `narrowOwnEnvironment` |
| `cli/src/lib/startEnvironment.spec.ts` (new) | 1, 4 | their cases |
| `cli/src/config/env.ts` | 1 | exports `ENV_FIELD_NAMES` |
| `cli/src/config/loadEnv.ts`, `loadEnv.spec.ts` | 2 | exports `loadEnvFile(env)` |
| `cli/src/architecture.startEnvironment.spec.ts` (new) | 3 | the read-coverage test |
| `cli/src/lib/daemonLaunch.ts`, `daemonLaunch.spec.ts` | 5 | `daemonSpawnOptions` |
| `cli/src/lib/windows/noWindow.spec.ts` | 5, 7 | `ALLOWED`: `lib/daemonLaunch.ts` in, then `cli.ts` out |
| `cli/src/testing/startEnvFile.ts`, `startEnvFile.spec.ts` (new) | 6 | the env file of a daemon a test starts through `harness start` |
| `cli/e2e/harness/daemon.ts` | 6 | `DaemonOptions.envFile`, `shellEnv()`, `paneEnvironment()` |
| `cli/src/cli.ts` | 7, 8 | `spawnDaemon`, then `launch` |
| `cli/src/cliStartEnvironment.spec.ts` (new) | 7, 8 | the call sites, on the source |
| `cli/e2e/cli.e2e.ts` | 7 | `install()` on `shellEnv()`; one case |
| `cli/e2e/paneEnv.e2e.ts` | 8 | two cases; `shellHas` on `paneEnvironment` |
| `cli/src/cliCommand.spec.ts`, `cli/src/loginForceRace.spec.ts` | 8 | `VITEST` through an env file; the dev run's `[env]` line |
| `docs/cli.md`, `cli/AGENTS.md` | 9 | the section, and rule 4's link |

**Task order.** 1 and 2 start at once. 3, 5, 6 and 9 need 1. 4 needs 1 and 2. 7 needs 5 and 6. 8 needs 4 and 7.
Tasks 3 and 4 both edit `lib/startEnvironment.ts`, so they run one after the other, either first. Longest chain:
1 → 5 (or 6) → 7 → 8.

## Review Focus

What a person meets that the spec's own cases do not name, most likely first. Each has its test in the task named.

1. **A variable a person needs that is on no list** (`JAVA_HOME`, exported only in the shell that ran the start):
   it reaches the pane once it is in the file `HARNESS_ENV_FILE` names, under every kind of start, the core in the
   CLI's own process included. Tasks 7 and 8 (`E2E_FROM_ENV_FILE` in the pane), Task 4 (the unit case).
2. **An allowed variable set to nothing** (`HARNESS_GRID_BIN=''` switches a default off): kept, empty. Task 1.
3. **A start on Windows:** the whole environment, as today, a person's `JAVA_HOME` and an agent's session alike
   (the master's `dropAgentSessionEnv` still takes the session). Task 1 (`win32` is a copy), Task 5 (the spawn on
   `win32`).
4. **A start from inside Harness** (`harness start` typed in an agent's pane, or an environment narrowed once
   already): the pane's session variables go, and narrowing twice changes nothing. Task 1.
5. **Names that only look allowed:** `HARNESSX`, `AWS`, `LC`, `XDG`, `CLAUDE_CODE_USER`, and `Path` or `path` on
   Linux. A prefix needs its underscore, and a name is its spelling. Task 1.

---

### Task 1: The allowlist and `startEnvironment`

**Depends on:** nothing. **Effort:** xhigh (security: this list is what reaches every pane).

**Files:**
- Create: `cli/src/lib/startEnvironment.ts`
- Modify: `cli/src/config/env.ts` (one export, after `fields`)
- Test: `cli/src/lib/startEnvironment.spec.ts` (new)

**The test that fails before the change:** `src/lib/startEnvironment.spec.ts`, "keeps what Harness and its engines
need and drops every outsider" (at the base: the module is not there).

**Interfaces:**
- Produces, from `config/env.ts`: `export const ENV_FIELD_NAMES: readonly string[]` (the keys of `fields`).
- Produces, from `lib/startEnvironment.ts`:
  - `export const START_ENV_NAMES: readonly string[]`, `export const START_ENV_PREFIXES: readonly string[]`
  - `export const DROPPED_ON_PURPOSE: Readonly<Record<string, string>>` (name to reason)
  - `export function startEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv`
  - `export function startEnvLine(given: NodeJS.ProcessEnv, kept: NodeJS.ProcessEnv): string`

- [ ] **Step 1: The cases**

```ts
import { describe, expect, it } from 'vitest'
import { ENV_FIELD_NAMES } from '../config/env.js'
import { AGENT_SESSION_VARIABLES, ORCA_VARIABLES } from './agentSessionEnv.js'
import { DROPPED_ON_PURPOSE, START_ENV_NAMES, START_ENV_PREFIXES, startEnvironment, startEnvLine } from './startEnvironment.js'

// Made up, every value (docs/plans/2026-11-17-daemon-minimal-env-design.md).
const OUTSIDERS = {
  SENTINEL_TOKEN: 's', GH_TOKEN: 'g', NODE_OPTIONS: '--require /fake/hook.cjs', CLAUDE_CODE_MESSAGING_TOKEN: 't',
  CODEX_THREAD_ID: 'c', ORCA_PAIRING_CODE: 'p', HARNESS_AGENT_SESSION: '1', TERM: 'xterm-256color',
  HC_SESSION: 'h', TYPESAFE_CREDENTIALS: 'tc', GIT_SSH_COMMAND: 'ssh -i /fake/key',
}
const KEPT = {
  PATH: '/bin', HOME: '/h', LC_ALL: 'C.UTF-8', HTTPS_PROXY: 'http://p:1', https_proxy: 'http://p:1',
  ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'dev', CODEX_HOME: '/h/.codex',
  CLAUDE_CONFIG_DIR: '/h/.claude', CURSOR_CONFIG_DIR: '/h/.cursor', HC_SOCKET: '/h/hc.sock', XAUTHORITY: '/run/x',
  SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22', npm_config_prefix: '/h/.local', ADAPTER_DATA_DIR: '/d',
  HARNESS_ENV_FILE: '/h/harness.env',
}

describe('the environment harness start gives the daemon', () => {
  it('keeps what Harness and its engines need and drops every outsider', () => {
    const shell = { ...KEPT, ...OUTSIDERS }
    expect(startEnvironment(shell, 'darwin')).toEqual(KEPT)
    expect(startEnvironment(shell, 'linux')).toEqual(KEPT)
    // A copy: the shell keeps its own.
    expect(shell.SENTINEL_TOKEN).toBe('s')
  })
  it('keeps every variable config/env.ts reads', () => {
    expect(ENV_FIELD_NAMES).toEqual(expect.arrayContaining(['PORT', 'BACKEND_WS_URL', 'CODEX_HOME', 'CLAUDE_PATH']))
    for (const name of ENV_FIELD_NAMES) expect(startEnvironment({ [name]: 'x' }, 'linux'), name).toEqual({ [name]: 'x' })
  })
  // Read through a parameter, so the read-coverage test cannot see them (decisions 3, 6, 7 and 9).
  it.each(['CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR', 'OPENCODE_DB', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'KILO_DB',
    'GRID_HOME', 'GRID_CONTROL_PLANE_URL', 'LLAMA_SERVER', 'HC_SOCKET', 'SSH_CONNECTION', 'ZDOTDIR', 'WSL_DISTRO_NAME',
    'XAUTHORITY', 'npm_config_prefix', 'BROWSER'])('keeps the setting %s', (name) => {
    expect(startEnvironment({ [name]: 'x' }, 'linux')).toEqual({ [name]: 'x' })
  })
  it('keeps each provider by its own prefix, and nothing because it looks like a secret', () => {
    const providers = {
      ANTHROPIC_AUTH_TOKEN: 'a', OPENAI_API_KEY: 'o', AWS_SECRET_ACCESS_KEY: 'w', GOOGLE_APPLICATION_CREDENTIALS: '/g',
      GEMINI_API_KEY: 'g', AZURE_OPENAI_API_KEY: 'z', OPENROUTER_API_KEY: 'r', XAI_API_KEY: 'x', CLOUD_ML_REGION: 'us', CLAUDE_CODE_USE_VERTEX: '1',
    }
    expect(startEnvironment({ ...providers, NPM_TOKEN: 'n', STRIPE_API_KEY: 's', MY_SECRET_KEY: 'k' }, 'linux')).toEqual(providers)
    expect(START_ENV_PREFIXES).toEqual(['LC_', 'XDG_', 'HARNESS_', 'HARNESSD_', 'ADAPTER_', 'ANTHROPIC_', 'OPENAI_', 'AWS_',
      'GOOGLE_', 'GEMINI_', 'AZURE_', 'OPENROUTER_', 'XAI_', 'CLAUDE_CODE_USE_'])
    expect(START_ENV_NAMES).toEqual(expect.arrayContaining(['SSH_AUTH_SOCK', '__CF_USER_TEXT_ENCODING', 'TMUX_TMPDIR',
      'DBUS_SESSION_BUS_ADDRESS', 'NODE_EXTRA_CA_CERTS', 'DOTENV_CONFIG_PATH', 'PI_CODING_AGENT_SESSION_DIR']))
  })
  it('drops every agent session variable, under an allowed prefix too', () => {
    const session = Object.fromEntries([...AGENT_SESSION_VARIABLES, ...ORCA_VARIABLES, 'ORCA_FUTURE_SETTING'].map((name) => [name, 'x']))
    expect(startEnvironment({ PATH: '/bin', TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%3', ...session }, 'linux')).toEqual({ PATH: '/bin' })
  })
  it('drops every name it drops on purpose, each with its reason', () => {
    expect(Object.keys(DROPPED_ON_PURPOSE)).toEqual(expect.arrayContaining(['TERM', 'COLORTERM', 'NODE_OPTIONS', 'TMUX',
      'TMUX_PANE', 'HC_SESSION', 'TYPESAFE_CREDENTIALS', 'GIT_SSH_COMMAND']))
    for (const [name, why] of Object.entries(DROPPED_ON_PURPOSE)) {
      expect(why.trim(), name).not.toBe('')
      expect(startEnvironment({ [name]: 'x' }, 'linux'), name).toEqual({})
    }
  })
  it('on Windows keeps the whole environment, as before (decision 5)', () => {
    const shell = { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', JAVA_HOME: 'C:\\jdk', SENTINEL_TOKEN: 's', CLAUDECODE: '1' }
    const kept = startEnvironment(shell, 'win32')
    expect(kept).toEqual(shell)
    expect(kept).not.toBe(shell)
  })
  it('keeps a variable set to nothing: empty is a setting', () => {
    expect(startEnvironment({ HARNESS_GRID_BIN: '', PATH: '' }, 'linux')).toEqual({ HARNESS_GRID_BIN: '', PATH: '' })
  })
  it('takes a prefix only with its underscore, and a name only as spelled', () => {
    expect(startEnvironment({ HARNESSX: 'x', HARNESS: 'x', AWS: 'x', LC: 'x', XDG: 'x', ANTHROPIC: 'x', CLAUDE_CODE_USER: 'x',
      CLAUDE_CODE_SESSION_ID: 'x', Path: '/bin', path: '/bin', systemroot: '/x' }, 'linux')).toEqual({})
  })
  it('gives the same answer for an environment it narrowed already', () => {
    const once = startEnvironment({ ...KEPT, ...OUTSIDERS }, 'darwin')
    expect(startEnvironment(once, 'darwin')).toEqual(once)
  })
  it('says how many variables a start left out, and never which', () => {
    const given = { PATH: '/bin', HOME: '/h', SENTINEL_TOKEN: 'sentinel-value', GH_TOKEN: 'g', TERM: 'x' }
    expect(startEnvLine(given, startEnvironment(given, 'linux')))
      .toBe('[env] started with 2 variables; 3 left out (docs/cli.md#the-daemons-environment)')
  })
})
```

- [ ] **Step 2: See it fail, and commit it**

```bash
cd cli && npx vitest run src/lib/startEnvironment.spec.ts
```

Expected: the file fails to load (`./startEnvironment.js` is not there).

```bash
git add cli/src/lib/startEnvironment.spec.ts
git commit -m "CLI: the daemon's environment is an allowlist (red test)"
```

- [ ] **Step 3: `ENV_FIELD_NAMES`**

In `cli/src/config/env.ts`, after `fields`: `export const ENV_FIELD_NAMES: readonly string[] = Object.keys(fields)`,
with one line on why (the daemon's allowlist takes every variable this file reads).

- [ ] **Step 4: `lib/startEnvironment.ts`**

The two lists, grouped as the spec's table groups them, each group with a comment that says why it is there (the
table's "Why" column) and names the design. `START_ENV_NAMES` ends with `...ENV_FIELD_NAMES`.
`DROPPED_ON_PURPOSE` holds the eight of Global Constraints, each with its reason from the spec's "Dropped on
purpose" paragraph (`HC_SESSION`, `TYPESAFE_CREDENTIALS` and `GIT_SSH_COMMAND` say "put it in `HARNESS_ENV_FILE`"),
and a comment that agent-session variables are dropped by `isAgentSessionVariable`. `startEnvironment` returns
`{ ...env }` on `win32`; elsewhere `Object.fromEntries` of the entries whose name is an exact name or a prefix match,
and not `isAgentSessionVariable`. Values are never read. The file's header comment says what the spec's Problem
section says, in a paragraph, why Windows is a copy (decision 5, the follow-up), and that `__harnessd` and `__run`
are not narrowed. `startEnvLine` returns the Global Constraints' line with `Object.keys(kept).length` and the
difference.

- [ ] **Step 5: See it pass**

```bash
npx vitest run src/lib/startEnvironment.spec.ts src/config/env.spec.ts src/architecture.spec.ts   # all passed
npm run typecheck                                                                                # no error
```

`architecture.spec.ts` shows the core's file list did not grow.

- [ ] **Step 6: Commit**

```bash
git add cli/src/lib/startEnvironment.ts cli/src/config/env.ts
git commit -m "CLI: startEnvironment, the allowlist a start gives the daemon"
```

---

### Task 2: `loadEnvFile`

**Depends on:** nothing. **Effort:** medium (one file and its spec).

**Files:**
- Modify: `cli/src/config/loadEnv.ts`
- Test: `cli/src/config/loadEnv.spec.ts` (one case)

**The test that fails before the change:** in `loadEnv.spec.ts`, "reads the selected file again into an
environment it is handed, keeping what is set there".

**Interfaces:**
- Produces: `export function loadEnvFile(env: NodeJS.ProcessEnv = process.env): void`. It reads the file
  `env.HARNESS_ENV_FILE` (else `env.DOTENV_CONFIG_PATH`) names into `env`, never over a variable already set;
  nothing when neither is set; it throws `Cannot read Harness environment file: <path>` as today. The module still
  calls it once as it loads.

- [ ] **Step 1: The case**

```ts
  it('reads the selected file again into an environment it is handed, keeping what is set there', async () => {
    const root = project()
    const file = join(root, 'harness.env')
    writeFileSync(file, 'FROM_FILE=in-the-file\nALREADY=in-the-file\n')
    const { loadEnvFile } = await import('./loadEnv.js')
    const env: NodeJS.ProcessEnv = { HARNESS_ENV_FILE: file, ALREADY: 'in-the-environment' }
    loadEnvFile(env)
    expect(env).toEqual({ HARNESS_ENV_FILE: file, FROM_FILE: 'in-the-file', ALREADY: 'in-the-environment' })
    expect(process.env.FROM_FILE).toBeUndefined()
    expect(() => loadEnvFile({})).not.toThrow()
    expect(() => loadEnvFile({ HARNESS_ENV_FILE: join(root, 'missing.env') })).toThrow('Cannot read Harness environment file')
  })
```

- [ ] **Step 2: See it fail, and commit it**

`npx vitest run src/config/loadEnv.spec.ts`: `1 failed | 4 passed (5)`, `loadEnvFile is not a function`. Commit
the spec: `"CLI: the env file can be read again into an environment (red test)"`.

- [ ] **Step 3: `loadEnvFile`**

The module's body becomes the function, with dotenv's `processEnv: env`; the module ends with `loadEnvFile()`. Its
comment gains one sentence: a start that becomes the daemon narrows `process.env` after this ran, and reads the
file again.

- [ ] **Step 4: See it pass, and commit**

`npx vitest run src/config/loadEnv.spec.ts` (5 passed), `npm run typecheck`. Commit `loadEnv.ts`:
`"CLI: loadEnvFile reads HARNESS_ENV_FILE into a given environment"`.

---

### Task 3: Every variable the daemon reads is allowed, or dropped on purpose

**Depends on:** Task 1. **Effort:** high. Shares `lib/startEnvironment.ts` with Task 4: not at the same time.

**Files:**
- Modify: `cli/src/lib/startEnvironment.ts` (`DROPPED_ON_PURPOSE`, nine entries)
- Test: `cli/src/architecture.startEnvironment.spec.ts` (new)

**The test that fails before the change:** "every variable the daemon reads is on the allowlist or dropped on
purpose": with Task 1's eight, it names exactly the nine of "Found while reading the code".

**Interfaces:**
- Consumes: `startEnvironment`, `DROPPED_ON_PURPOSE` (Task 1).

- [ ] **Step 1: The scanner and its own cases**

As `src/architecture.environment.spec.ts` does it, with the `typescript` package:
`environmentNames(code: string, file?: string): string[]` returns the names a file names on `process.env`: as
`process.env.NAME`, `process.env['NAME']` and `const { NAME } = process.env` (planning decision 7), read, set or
deleted alike. Its own cases:

```ts
it.each([
  ['process.env.FOO', ['FOO']], ["process.env['BAR']", ['BAR']], ['process.env?.BAZ', ['BAZ']],
  ['const { A, B: b, ...rest } = process.env', ['A', 'B']],
  ['// process.env.COMMENTED', []], ["const text = 'process.env.IN_A_STRING'", []],
  ['process.env[name]', []], ['env.NOT_PROCESS', []], ['process.env.A = "1"; delete process.env.B', ['A', 'B']],
])('finds the names in %s', (code, names) => expect(environmentNames(code).sort()).toEqual(names))
```

- [ ] **Step 2: The rule**

```ts
// A new read of a variable on neither list fails here, so whoever adds the read decides
// (docs/plans/2026-11-17-daemon-minimal-env-design.md).
it('every variable the daemon reads is on the allowlist or dropped on purpose', () => {
  const read = new Map<string, string>()   // name -> the first file that reads it
  // every .ts/.tsx/.mjs/.js under src, but *.spec.*, *.test.*, and the folders testing, e2e, __fixtures__, fixtures;
  // a file is parsed only when its text holds `process.env` (1,300 files: parsing all of them is seconds).
  const allowed = (name: string) => Object.keys(startEnvironment({ [name]: 'x' }, 'linux')).length === 1
  expect([...read].filter(([name]) => !allowed(name) && !(name in DROPPED_ON_PURPOSE)).map(([name, file]) => `${name} (${file})`)).toEqual([])
})
```

No check that each `DROPPED_ON_PURPOSE` name is still read: the spec lists names the daemon never reads
(`NODE_OPTIONS`, `COLORTERM`). Task 1's case holds that none is also allowed.

- [ ] **Step 3: See it fail, and commit it**

`npx vitest run src/architecture.startEnvironment.spec.ts`: the scanner's cases pass, the rule fails with
`ComSpec (engines/kit/windowsInstall.ts)`, `GIT_CONFIG_GLOBAL (lib/agentProject.ts)`,
`GIT_CONFIG_SYSTEM (lib/agentProject.ts)`, `LOCALAPPDATA (config/env.ts)`, `SystemRoot` (with whichever of its two
files the walk meets first),
`USERPROFILE (lib/windows/guestHelperInstallWin.ts)`, `UV_THREADPOOL_SIZE (engines/kit/nativeHookFiles.ts)`,
`VITEST (lib/github.ts)`, `windir (lib/uninstall/removal.ts)` and no other name. Another name there is a finding:
stop and report it. Commit: `"CLI: every variable the daemon reads is allowed or dropped on purpose (red test)"`.

- [ ] **Step 4: The nine, each with its reason**

`DROPPED_ON_PURPOSE` gets the nine names with the reasons of the table in "Found while reading the code", one line
each (the five Windows names share one reason, planning decision 9).

- [ ] **Step 5: See it pass, and commit**

`npx vitest run src/architecture.startEnvironment.spec.ts src/lib/startEnvironment.spec.ts` (all passed),
`npm run typecheck`. Commit `startEnvironment.ts`: `"CLI: the variables the daemon reads and a start drops, with why"`.

---

### Task 4: `narrowOwnEnvironment`

**Depends on:** Task 1 (the same two files), Task 2 (`loadEnvFile`). **Effort:** high. Shares
`lib/startEnvironment.ts` with Task 3: not at the same time.

**Files:**
- Modify: `cli/src/lib/startEnvironment.ts`
- Test: `cli/src/lib/startEnvironment.spec.ts` (three cases)

**The test that fails before the change:** "narrows an environment in place, then reads the env file again".

**Interfaces:**
- Consumes: `startEnvironment`, `startEnvLine` (Task 1); `loadEnvFile(env)` (Task 2).
- Produces: `export function narrowOwnEnvironment(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string`.
  It deletes from `env` every variable `startEnvironment(env, platform)` does not keep, calls `loadEnvFile(env)`,
  and returns `startEnvLine` of what it was given and what the allowlist kept.

- [ ] **Step 1: The cases** (with `mkdtempSync`, `writeFileSync`, `rmSync` and an `afterEach` that removes the folder)

```ts
  it('narrows an environment in place, then reads the env file again', () => {
    const file = join(folder, 'harness.env')
    writeFileSync(file, 'FROM_FILE=in-the-file\nSENTINEL_TOKEN=from-the-file\n')
    // As config/loadEnv.ts left it when the CLI loaded: FROM_FILE read from the file, SENTINEL_TOKEN the shell's own.
    const env: NodeJS.ProcessEnv = { PATH: '/bin', HARNESS_ENV_FILE: file, FROM_FILE: 'in-the-file', SENTINEL_TOKEN: 'from-the-shell', GH_TOKEN: 'g' }
    const line = narrowOwnEnvironment(env, 'darwin')
    // The shell's token is gone; what the person put in the file is the daemon's, as after a background start.
    expect(env).toEqual({ PATH: '/bin', HARNESS_ENV_FILE: file, FROM_FILE: 'in-the-file', SENTINEL_TOKEN: 'from-the-file' })
    expect(line).toBe('[env] started with 2 variables; 3 left out (docs/cli.md#the-daemons-environment)')
  })
  it('narrows with no env file named', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/h', CLAUDE_CODE_MESSAGING_TOKEN: 't', NODE_OPTIONS: '--require /fake/hook.cjs' }
    expect(narrowOwnEnvironment(env, 'linux')).toBe('[env] started with 1 variables; 2 left out (docs/cli.md#the-daemons-environment)')
    expect(env).toEqual({ HOME: '/h' })
  })
  it('on Windows takes nothing out', () => {
    const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows', JAVA_HOME: 'C:\\jdk', SENTINEL_TOKEN: 's' }
    expect(narrowOwnEnvironment(env, 'win32')).toBe('[env] started with 3 variables; 0 left out (docs/cli.md#the-daemons-environment)')
    expect(env).toEqual({ Path: 'C:\\Windows', JAVA_HOME: 'C:\\jdk', SENTINEL_TOKEN: 's' })
  })
```

- [ ] **Step 2: See it fail, and commit it**

`npx vitest run src/lib/startEnvironment.spec.ts`: `3 failed`, `narrowOwnEnvironment is not a function`. Commit the
spec: `"CLI: a start that becomes the daemon narrows its own environment (red test)"`.

- [ ] **Step 3: `narrowOwnEnvironment`**

Its comment says why the file is read again (planning decision 1), and that the object must be the process's own:
the master's or core's children inherit it.

- [ ] **Step 4: See it pass, and commit**

`npx vitest run src/lib/startEnvironment.spec.ts src/architecture.spec.ts`, `npm run typecheck`. Commit
`startEnvironment.ts`: `"CLI: narrowOwnEnvironment, for a start that becomes the daemon"`.

---

### Task 5: `daemonSpawnOptions`

**Depends on:** Task 1. **Effort:** medium.

**Files:**
- Modify: `cli/src/lib/daemonLaunch.ts`
- Modify: `cli/src/lib/windows/noWindow.spec.ts` (`ALLOWED`, one line added)
- Test: `cli/src/lib/daemonLaunch.spec.ts` (one case)

**The test that fails before the change:** in `daemonLaunch.spec.ts`, "starts the daemon detached, on its log, with
only the allowlist of this shell".

**Interfaces:**
- Consumes: `startEnvironment` (Task 1).
- Produces: `export function daemonSpawnOptions(given: NodeJS.ProcessEnv, logFd: number, platform: NodeJS.Platform = process.platform): { detached: true; env: NodeJS.ProcessEnv; stdio: ['ignore', number, number] }`.

- [ ] **Step 1: The case**

```ts
describe('daemonSpawnOptions', () => {
  it('starts the daemon detached, on its log, with only the allowlist of this shell', async () => {
    const { daemonSpawnOptions } = await load()
    const shell = { PATH: '/bin', HOME: '/h', ADAPTER_DATA_DIR: '/d', ANTHROPIC_API_KEY: 'kept', HARNESSD_SERVICES: 'none',
      SENTINEL_TOKEN: 's', GH_TOKEN: 'g', NODE_OPTIONS: '--require /fake/hook.cjs', CLAUDE_CODE_MESSAGING_TOKEN: 't', TERM: 'xterm' }
    expect(daemonSpawnOptions(shell, 7, 'darwin')).toEqual({
      detached: true, stdio: ['ignore', 7, 7],
      env: { PATH: '/bin', HOME: '/h', ADAPTER_DATA_DIR: '/d', ANTHROPIC_API_KEY: 'kept', HARNESSD_SERVICES: 'none' },
    })
    expect(shell.SENTINEL_TOKEN).toBe('s')
    // A build run from a checkout on Windows: the whole environment, as before (decision 5).
    expect(daemonSpawnOptions(shell, 7, 'win32').env).toEqual(shell)
  })
})
```

- [ ] **Step 2: See it fail, and commit it**

`npx vitest run src/lib/daemonLaunch.spec.ts`: one failed, `daemonSpawnOptions is not a function`. Commit:
`"CLI: the daemon's spawn options hold only the allowlist (red test)"`.

- [ ] **Step 3: `daemonSpawnOptions`, and its line in `noWindow.spec.ts`**

`ALLOWED` gains `'lib/daemonLaunch.ts'` with `cli.ts`'s reason ("a build run from a checkout: an installed copy
starts through harness-launch.exe"). `cli.ts` keeps its own line until Task 7 takes its `detached` out.

- [ ] **Step 4: See it pass, and commit**

`npx vitest run src/lib/daemonLaunch.spec.ts src/lib/windows/noWindow.spec.ts`, `npm run typecheck`. Commit both
files: `"CLI: daemonSpawnOptions, the spawn of harness start"`.

---

### Task 6: A test's daemon keeps the harness's settings through `harness start`

**Depends on:** Task 1. **Effort:** high.

**Files:**
- Create: `cli/src/testing/startEnvFile.ts`
- Modify: `cli/e2e/harness/daemon.ts` (`DaemonOptions`, `IsolatedDaemon.create`, `start`, two methods)
- Test: `cli/src/testing/startEnvFile.spec.ts` (new)

**The test that fails before the change:** `src/testing/startEnvFile.spec.ts`, "holds the harness's settings a
start would leave out, and no other variable".

**Interfaces:**
- Consumes: `startEnvironment` (Task 1).
- Produces:
  - `export function startEnvFile(env: NodeJS.ProcessEnv, names: readonly string[], more: Record<string, string> = {}, platform: NodeJS.Platform = process.platform): string`:
    the text of an env file, one `NAME='value'` line for each of `names` that `env` sets and
    `startEnvironment(env, platform)` leaves out, then `more`. It throws, naming the variable and never its value,
    on a value with a single quote or a line break.
  - `DaemonOptions.envFile?: Record<string, string>`: more lines for that file.
  - `IsolatedDaemon.shellEnv(): Promise<NodeJS.ProcessEnv>`: the environment of a shell that runs `harness start`
    or `harness start -f` for this daemon. It writes `startEnvFile(this.env, <the harness's own setting names>,
    this.options.envFile)` to `start.env` beside the fake engines' hook log (the daemon's own folder) and returns
    `{ ...this.env, HARNESS_ENV_FILE: <that file> }`. The names are the keys of the settings `create` gives a
    daemon, before `...options.env`. It loads `startEnvFile` with `await import(...)`, inside the method:
    `lib/startEnvironment.ts` loads `config/env.ts`, which reads and checks the worker's environment as it loads,
    and the 160 files that never start a daemon this way keep loading what they load today.
  - `IsolatedDaemon.paneEnvironment(pane: string, name: string): Promise<Record<string, string>>`: the environment
    of the shell a pane runs, written to `<root>/<name>.env` by that shell (`env > file.tmp && mv`, as
    `paneEnv.e2e.ts`'s `shellHas` does), read once the file is there.
  - `start()` spawns with `await this.shellEnv()` when `options.foreground`, with `this.env` otherwise.

- [ ] **Step 1: The cases**

```ts
import { parse } from 'dotenv'
import { describe, expect, it } from 'vitest'
import { startEnvFile } from './startEnvFile.js'

describe('the env file of a daemon a test starts through harness start', () => {
  it('holds the harness\'s settings a start would leave out, and no other variable', () => {
    const env = { PATH: '/t/bin', HOME: '/t/home', ZDOTDIR: '/t/home', GRID_HOME: '/t/home/.grid', USERPROFILE: '/t/home',
      TEMP: '/t/tmp', ANALYTICS_ENABLED: 'false', HARNESS_GRID_BIN: '', SENTINEL_TOKEN: 's' }
    const text = startEnvFile(env, ['PATH', 'HOME', 'ZDOTDIR', 'GRID_HOME', 'USERPROFILE', 'TEMP', 'ANALYTICS_ENABLED', 'HARNESS_GRID_BIN'],
      { E2E_FROM_ENV_FILE: 'reaches-the-pane' }, 'darwin')
    // Not PATH, HOME, ZDOTDIR, GRID_HOME or HARNESS_GRID_BIN: a start keeps them. Not SENTINEL_TOKEN: a test's own, never the harness's.
    expect(parse(text)).toEqual({ USERPROFILE: '/t/home', TEMP: '/t/tmp', ANALYTICS_ENABLED: 'false', E2E_FROM_ENV_FILE: 'reaches-the-pane' })
    // On Windows a start keeps them all: only the test's own lines.
    expect(parse(startEnvFile(env, ['USERPROFILE'], { E2E_FROM_ENV_FILE: 'x' }, 'win32'))).toEqual({ E2E_FROM_ENV_FILE: 'x' })
  })
  it('refuses a value an env file cannot hold as written, by the variable\'s name', () => {
    expect(() => startEnvFile({ TEMP: "/t/it's" }, ['TEMP'], {}, 'linux')).toThrow(/TEMP/)
    expect(() => startEnvFile({}, [], { E2E_TWO_LINES: 'a\nb' }, 'linux')).toThrow(/E2E_TWO_LINES/)
  })
})
```

- [ ] **Step 2: See it fail, and commit it**

`npx vitest run src/testing/startEnvFile.spec.ts`: the file fails to load. Commit:
`"CLI e2e: a daemon started through harness start keeps the harness's settings (red test)"`.

- [ ] **Step 3: `startEnvFile`, then the harness**

`startEnvFile`'s comment says why (the allowlist of 2026-11-17 would take any harness setting it does not name out
of a daemon `harness start` starts; the env file is where the product says such a variable goes). In `daemon.ts`
the settings literal gets a name, so its keys can be kept; nothing else of `create` changes.

- [ ] **Step 4: See it pass**

```bash
npx vitest run src/testing/startEnvFile.spec.ts src/testing/daemonListeningPort.spec.ts && npm run typecheck
export TMPDIR=/private/tmp/claude-503/denv-t6/ SHELL=/bin/zsh && mkdir -p "$TMPDIR"
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/master.e2e.ts -t 'harness start -f'   # 1 passed
```

The foreground daemon now starts with `HARNESS_ENV_FILE` set, and nothing else differs yet.

- [ ] **Step 5: Commit**

```bash
git add cli/src/testing/startEnvFile.ts cli/e2e/harness/daemon.ts
git commit -m "CLI e2e: shellEnv and paneEnvironment, for daemons harness start starts"
```

---

### Task 7: `harness start` spawns the daemon with the allowlist

**Depends on:** Task 5 (`daemonSpawnOptions`, `noWindow.spec.ts`), Task 6 (`shellEnv`, `paneEnvironment`).
**Effort:** xhigh (security: the spawn every background start, Desktop's included, goes through).

**Files:**
- Modify: `cli/src/cli.ts` (`spawnDaemon`, `:1663-1750`; the `./lib/log.js` and `./lib/daemonLaunch.js` imports)
- Modify: `cli/src/lib/windows/noWindow.spec.ts` (`ALLOWED`: the `cli.ts` line goes)
- Modify: `cli/e2e/cli.e2e.ts` (`install`, one helper, one case)
- Test: `cli/src/cliStartEnvironment.spec.ts` (new)

**The tests that fail before the change:** `src/cliStartEnvironment.spec.ts`, "the background start spawns the
daemon with the allowlist, and says how many variables it left out"; and `e2e/cli.e2e.ts`, "starts the daemon with
only the allowlist of the shell: a pane has none of its tokens, and the env file's variables".

**Interfaces:**
- Consumes: `daemonSpawnOptions(given, logFd)` (Task 5), `startEnvLine` (Task 1), `IsolatedDaemon.shellEnv`,
  `paneEnvironment`, `DaemonOptions.envFile` (Task 6).
- Produces: `src/cliStartEnvironment.spec.ts` with `SOURCE` (`cli.ts`, its comments blanked), `body(name)` and
  `at(text, call, after?)`, as `src/cliStopFirst.spec.ts` has them. Task 8 adds its case to this file.

- [ ] **Step 1: The source case**

```ts
/**
 * `harness start` hands the daemon only the allowlist of the shell that ran it (lib/startEnvironment.ts,
 * docs/plans/2026-11-17-daemon-minimal-env-design.md). The places are in cli.ts, which runs as a process and cannot
 * be loaded here: what each calls is asserted on the source, as cliStopFirst.spec.ts does, and the functions are
 * tested where they live. Pull request CI runs no end-to-end file, so this is what holds the wiring there.
 */
describe('the environment a start gives the daemon (cli.ts)', () => {
  it('the background start spawns the daemon with the allowlist, and says how many variables it left out', () => {
    const text = body('spawnDaemon')
    expect(text).toContain('daemonSpawnOptions(process.env, logFd)')
    expect(text).not.toMatch(/\.\.\.process\.env/)
    expect(text.split('startEnvLine(').length - 1).toBe(1)
    // Windows' installed start keeps today's launcher, environment and all (decision 5).
    expect(text).toContain('await launchMaster()')
  })
})
```

- [ ] **Step 2: The end-to-end case**

In `e2e/cli.e2e.ts`: `install(platform, options: DaemonOptions = {})` passes `options` to `IsolatedDaemon.create`
and spreads `await daemon.shellEnv()` where it spread `daemon.env`. A helper `tile(m, client, folder)` creates
`{ engine: 'terminal', cwd }` and waits for the row's `tmuxPane`. Then:

```ts
  // Another program's token, an agent's session and a provider key, as the shell that runs `harness start` may hold
  // them: made-up values (docs/plans/2026-11-17-daemon-minimal-env-design.md).
  it('starts the daemon with only the allowlist of the shell: a pane has none of its tokens, and the env file\'s variables', async () => {
    const m = await install(undefined, { envFile: { E2E_FROM_ENV_FILE: 'reaches-the-pane' } })
    const shell = { ...m.env, SENTINEL_TOKEN: 'sentinel-from-the-shell', CLAUDE_CODE_MESSAGING_TOKEN: 'agent-token', ANTHROPIC_API_KEY: 'kept-sentinel' }
    const started = await harness({ ...m, env: shell }, 'start')
    expect(started.status, said(started)).toBe(0)
    seen.add(pidOf(m)!)
    const client = await LocalClient.connect(m.daemon)
    const pane = (await tile(m, client, 'shell-env')).tmuxPane
    const env = await m.daemon.paneEnvironment(pane, 'shell-env')
    client.close()
    expect(env.SENTINEL_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_MESSAGING_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBe('kept-sentinel')
    expect(env.PATH).toContain(join(m.daemon.root, 'bin'))
    expect(env.E2E_FROM_ENV_FILE).toBe('reaches-the-pane')
    const log = readFileSync(join(m.daemon.dataDir, 'harness.log'), 'utf8')
    expect(log).toMatch(/\[env\] started with \d+ variables; [1-9]\d* left out \(docs\/cli\.md#the-daemons-environment\)/)
    expect(log.includes('SENTINEL_TOKEN') || log.includes('sentinel-from-the-shell'), 'the log names no variable').toBe(false)
    expect((await harness(m, 'stop')).status).toBe(0)
  })
```

- [ ] **Step 3: See both fail, and commit them**

```bash
cd cli && npx vitest run src/cliStartEnvironment.spec.ts          # 1 failed: no daemonSpawnOptions( in spawnDaemon
export TMPDIR=/private/tmp/claude-503/denv-t7/ SHELL=/bin/zsh && mkdir -p "$TMPDIR"
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/cli.e2e.ts -t 'only the allowlist of the shell'
```

Expected of the second: `1 failed`, on `expected 'sentinel-from-the-shell' to be undefined`. The file builds its
own bundle from the checkout first (a minute or two).

```bash
git add cli/src/cliStartEnvironment.spec.ts cli/e2e/cli.e2e.ts
git commit -m "CLI: harness start hands the daemon only the allowlist (red tests)"
```

- [ ] **Step 4: `spawnDaemon`**

- The spawn's options are `const options = daemonSpawnOptions(process.env, logFd)`. Before the spawn, one line
  goes to `logFd` with `writeSync` (`ts` added to the `./lib/log.js` import):

  ```ts
  writeSync(logFd, `${ts()} ${startEnvLine(process.env, options.env)}\n`)
  ```
- The Windows `launchMaster()` branch does not change, nor its comment (decision 5).
- The comments at the spawn say what is true now: the daemon gets the allowlist, not this process's environment.
- `noWindow.spec.ts`: the `cli.ts` line of `ALLOWED` goes (its test fails on a reason nothing needs).
- The `--device-dump` comments stay true (`HARNESS_DEVICE_DUMP` passes by its prefix).

- [ ] **Step 5: See them pass**

```bash
npx vitest run src/cliStartEnvironment.spec.ts src/lib/windows/noWindow.spec.ts src/cliStopFirst.spec.ts src/cliCommand.spec.ts && npm run typecheck
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/cli.e2e.ts
```

To see: the unit files pass; `e2e/cli.e2e.ts` whole, `Tests 10 passed (10)` (9 at the base).

- [ ] **Step 6: Commit**

```bash
git add cli/src/cli.ts cli/src/lib/windows/noWindow.spec.ts
git commit -m "CLI: harness start spawns the daemon from the allowlist, and logs how many variables it left out"
```

---

### Task 8: A start that becomes the daemon narrows its own environment first

**Depends on:** Task 4 (`narrowOwnEnvironment`), Task 7 (`cli.ts`, `cliStartEnvironment.spec.ts`; and through it
Task 6). **Effort:** xhigh (security; Harness OS runs this path).

**Files:**
- Modify: `cli/src/cli.ts` (`launch`, `:1598-1660`)
- Modify: `cli/e2e/paneEnv.e2e.ts` (the header comment, `shellHas`, two cases)
- Modify: `cli/src/cliCommand.spec.ts` (`envFor`; one assertion), `cli/src/loginForceRace.spec.ts` (`envFor`)
- Test: `cli/src/cliStartEnvironment.spec.ts` (one case)

**The tests that fail before the change:** `src/cliStartEnvironment.spec.ts`, "a start that becomes the daemon
narrows this process before the master or the core starts in it"; `e2e/paneEnv.e2e.ts`, both cases of "harness
start -f gives ... only the allowlist of its shell, and the env file's variables"; and in `src/cliCommand.spec.ts`,
"starts without the backend: a session that already names its machine never calls it" (a dev run), on its new
`[env]` assertion.

**Interfaces:**
- Consumes: `narrowOwnEnvironment()` (Task 4); `IsolatedDaemon` `foreground`, `envFile`, `paneEnvironment` (Task 6).

- [ ] **Step 1: The source case**

```ts
  it('a start that becomes the daemon narrows this process before the master or the core starts in it', () => {
    const text = body('launch')
    const refusal = at(text, 'refuseServedDataFolder(')
    const master = at(text, 'startMasterInForeground(')
    const first = at(text, 'narrowOwnEnvironment(')
    // After the refusal beside a running daemon: a start that leaves at once says nothing of an environment.
    expect(first).toBeGreaterThan(refusal)
    expect(first).toBeLessThan(master)
    // And again where the core runs alone in this process: HARNESS_NO_MASTER=1 (Harness OS) and a dev run alike.
    const condition = "if (foreground || SCRIPT_PATH.endsWith('.ts'))"
    const branch = at(text, condition, master) + condition.length
    const second = at(text, 'narrowOwnEnvironment(', branch)
    expect(second).toBeLessThan(at(text, 'runCoreInForeground(', branch))
    // Its first statement, under no further condition: the dev run is narrowed too (decision 8).
    expect(text.slice(branch, second)).not.toMatch(/\bif \(/)
  })
```

- [ ] **Step 2: The end-to-end cases**

In `e2e/paneEnv.e2e.ts`, `shellHas` becomes the names of `d.paneEnvironment(pane, name)` that start with a prefix
(one way to read a pane's environment). Then:

```ts
/** What the shell that runs `harness start -f` may hold beside the daemon's own: another program's token, an agent's
 *  session, a provider key. Made-up values (docs/plans/2026-11-17-daemon-minimal-env-design.md). */
const SHELL_SESSION = { SENTINEL_TOKEN: 'sentinel-from-the-shell', CLAUDE_CODE_MESSAGING_TOKEN: 'agent-token', ANTHROPIC_API_KEY: 'kept-sentinel' }

  it.each([
    ['the master', {}],
    // The core in the CLI's own process, as Harness OS's unit runs it: the env file is read again after the narrowing.
    ['the core alone', { HARNESS_NO_MASTER: '1' }],
  ])('harness start -f gives %s only the allowlist of its shell, and the env file\'s variables', async (_what, more) => {
    const d = await IsolatedDaemon.create({ foreground: true, env: { ...SHELL_SESSION, ...more }, envFile: { E2E_FROM_ENV_FILE: 'reaches-the-pane' } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const client = await LocalClient.connect(d)
    const tile = await create(d, client, 'terminal', 'pane-foreground')
    const env = await d.paneEnvironment(tile.tmuxPane, 'foreground')
    client.close()
    expect(env.SENTINEL_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_MESSAGING_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBe('kept-sentinel')
    expect(env.PATH).toContain(join(d.root, 'bin'))
    expect(env.E2E_FROM_ENV_FILE).toBe('reaches-the-pane')
    expect(d.log()).toMatch(/\[env\] started with \d+ variables; [1-9]\d* left out \(docs\/cli\.md#the-daemons-environment\)/)
    expect(d.log().includes('SENTINEL_TOKEN') || d.log().includes('sentinel-from-the-shell'), 'the log names no variable').toBe(false)
  }, 300_000)
```

- [ ] **Step 3: The dev run, in `cliCommand.spec.ts` and `loginForceRace.spec.ts`**

- In `cliCommand.spec.ts`'s "starts without the backend: a session that already names its machine never calls it",
  after its `dev mode` assertion:
  `expect(result.stdout).toMatch(/\[env\] started with \d+ variables; \d+ left out/)`.
- Each file's `envFor` writes `VITEST=true` to `join(root, 'test.env')` and sets `HARNESS_ENV_FILE` to it, with one
  comment: a dev run narrows its own environment, which takes the test runner's mark that keeps the real `gh` from
  running (`lib/github.ts`); the env file puts it back, as the product says such a variable goes (planning
  decision 13). In `cliCommand.spec.ts` it comes before `...extra`, so a test's own `HARNESS_ENV_FILE` still wins.

- [ ] **Step 4: See them fail, and commit them**

```bash
cd cli && npx vitest run src/cliStartEnvironment.spec.ts       # 1 failed | 1 passed: no narrowOwnEnvironment( in launch
npx vitest run src/cliCommand.spec.ts -t 'never calls it'       # 1 failed: no [env] line
export TMPDIR=/private/tmp/claude-503/denv-t8/ SHELL=/bin/zsh && mkdir -p "$TMPDIR"
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/paneEnv.e2e.ts
```

Expected of the last: `2 failed | 3 passed (5)`, both on `expected 'sentinel-from-the-shell' to be undefined`. The
three cases already there pass with `shellHas` on `paneEnvironment`.

```bash
git add cli/src/cliStartEnvironment.spec.ts cli/e2e/paneEnv.e2e.ts cli/src/cliCommand.spec.ts cli/src/loginForceRace.spec.ts
git commit -m "CLI: a start that becomes the daemon narrows its own environment (red tests)"
```

- [ ] **Step 5: `launch`**

One line, in two places:

```ts
console.log(`${ts()} ${narrowOwnEnvironment()}`)
```

after `refuseServedDataFolder(...)` and right before `startMasterInForeground(SCRIPT_PATH)`; and as the first
statement of the `if (foreground || SCRIPT_PATH.endsWith('.ts'))` branch, before its `dev mode` line and
`runCoreInForeground(session, SCRIPT_PATH)` (a dev run is narrowed, decision 8). One comment says why here (the
shell's environment becomes the daemon's in this process, and every child's), and why the file is read again
(planning decision 1). `paneEnv.e2e.ts`'s header gains a sentence on the allowlist.

- [ ] **Step 6: See them pass**

```bash
npx vitest run src/cliStartEnvironment.spec.ts src/cliStopFirst.spec.ts src/cliCommand.spec.ts src/loginForceRace.spec.ts && npm run typecheck
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/paneEnv.e2e.ts                          # 5 passed, from the sources
caffeinate -i env E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/paneEnv.e2e.ts e2e/master.e2e.ts -t 'harness start -f'
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/twodaemons.e2e.ts -t 'a second harness start'
```

To see: the unit files pass, `cliCommand` and `loginForceRace` whole; `paneEnv` 5 of 5 from the sources (the master
in the CLI's process); with the bundle, its two new cases and `master.e2e.ts`'s one (the master re-executed on the
lean bundle); `twodaemons` 1 passed (a foreground start beside a running daemon still leaves, with no `[env]` line
before the refusal).

- [ ] **Step 7: Commit**

```bash
git add cli/src/cli.ts
git commit -m "CLI: a start that becomes the daemon narrows its own environment before the daemon starts in it"
```

---

### Task 9: The doc

**Depends on:** Task 1 (the lists it names). **Effort:** medium. No behavior and no test (no CLI test may read
`docs/`, Global Constraints): one commit.

**Files:**
- Modify: `docs/cli.md` (a new section before `## Automation`)
- Modify: `cli/AGENTS.md` (Protect the core, rule 4)

- [ ] **Step 1: `docs/cli.md`, `## The daemon's environment`** (the anchor is `#the-daemons-environment`, which the
  log line names)

It says, in this order and no longer than this:

- On macOS and Linux, `harness start` (with or without `-f`) gives the daemon only the variables below of the shell
  that ran it. Anything else in that shell never reaches the daemon, its tmux server or a pane.
- The table, one row a group, names as in Global Constraints: System; Linux desktop; Network; Harness
  (`HARNESS_*`, `HARNESSD_*`, `ADAPTER_*`, `DOTENV_CONFIG_PATH`, `NODE_ENV` and every setting of the CLI's config,
  `BACKEND_WS_URL`, `PORT` and the rest); Harness OS; Engine settings (the names, and each engine's home and path
  setting, `CODEX_HOME`, `CLAUDE_PATH` and the rest); Provider credentials, for now.
- Left out on purpose: `TERM` and `COLORTERM` (tmux sets a pane's own), `NODE_OPTIONS`, `TMUX`, `TMUX_PANE`,
  `HC_SESSION`, `TYPESAFE_CREDENTIALS`, `GIT_SSH_COMMAND`, and every variable that names an agent's own session
  (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, every `ORCA_*`), under an allowed prefix too.
- What you export in your shell's startup files still reaches your agents: every pane starts its engine through
  your login shell.
- Anything else the daemon or its agents need, `HC_SESSION`, `TYPESAFE_CREDENTIALS` and `GIT_SSH_COMMAND` among
  them, goes in the file `HARNESS_ENV_FILE` names, which every daemon process reads as it starts.
- Provider keys will move to `HARNESS_ENV_FILE` next.
- On Windows a start keeps its whole environment for now: a Windows pane has no login shell. It narrows once a start
  reads your own variables from the registry.
- The daemon's log says how many variables a start left out, never which:
  `[env] started with N variables; M left out`.
- After `harness service install`, launchd and systemd start the daemon with their own environment, as before.

- [ ] **Step 2: `cli/AGENTS.md`, rule 4**

After the sentence that ends "(`src/architecture.environment.spec.ts`).", add: "Nor is the daemon handed the
environment of whatever started it: `harness start` passes an allowlist
([the daemon's environment](../docs/cli.md#the-daemons-environment), `src/lib/startEnvironment.ts`), and
`src/architecture.startEnvironment.spec.ts` holds every variable the daemon reads to it."

- [ ] **Step 3: Commit**

```bash
git add docs/cli.md cli/AGENTS.md
git commit -m "Docs: the daemon's environment"
```

---

## Left out

- `__harnessd`, `__run`, `__service`, the master's and the core's `dropAgentSessionEnv`, and the tmux server unset:
  as they are (decision 1).
- Windows narrowing, and `launchMaster`: a follow-up item, once a start reads the user's durable variables from the
  registry (decision 5). The doc names it.
- A tmux server that is already running keeps the environment it started with. The spec leaves a server someone
  else started to the existing named unset.
- Moving provider keys to `HARNESS_ENV_FILE`, and the macOS `KERN_PROCARGS2` helper: the spec's own out of scope.
- `src/testing/daemonEnvironment.ts`: the test harness's own allowlist stays, under its name.
- `cli/README.md` and `cli/.env.example`: no change. They name variables nothing reads any more
  (`SUMMARY_MODEL`, `CODEX_SUMMARY_MODEL`, `CURSOR_SUMMARY_MODEL`): a proposal, not this task.
- `HARNESS_PANE` and `HARNESS_SELF` pass by the `HARNESS_*` prefix, as they pass today. Whether `HARNESS_PANE`
  joins the agent-session denylist is a proposal.
- Desktop: no change. It runs `harness start`, and gets the behavior.
- No performance numbers: one filter over the environment at each start, on no hot path.

## Verification

On the final head, after the review. Isolation is the repo's own (`cli/AGENTS.md`, rules 5 and 6): every
end-to-end file boots its own daemons under a throwaway root, on a free port, with a private tmux server and fake
engines, signed out, its backend at `127.0.0.1:9`. No real account, no production, nothing of the developer's
daemon (port 18473), tmux server, `~/.harness`, `~/.claude` or `~/.codex`. No check needs the user themselves.

**Beside the end-to-end checks.** Pull request CI runs by itself what a `cli/` change selects: `cli-typecheck` and
`cli-tests` (the new or changed unit specs among them, the Windows cases with `platform` passed as `'win32'`),
`companions` and `pty-checks` (they import the CLI's code), and `process-checks`.

**Checks PR CI does not run:** none for these paths. On the final head:

```bash
python3 scripts/local-checks.py --list $(git diff --name-only origin/main...HEAD)   # {}
```

`{}` means no receipt goes in the pull request. `npm run test:core` and `npm run test:harnessd` are not needed:
nothing under `cli/src/core`, `cli/src/services` or `cli/src/harnessd` changes. If the list is not empty, a task
left its files: run `python3 scripts/local-checks.py --run` from a clean tree and paste its output.

Local checks run on this Mac (macOS, arm64, tmux, zsh), in `cli/`:

```bash
cd cli && export TMPDIR=/private/tmp/claude-503/denv-v/ SHELL=/bin/zsh && mkdir -p "$TMPDIR"
node -p process.arch    # arm64
```

1. **The unit specs and the typecheck.**

   ```bash
   npx vitest run src/lib/startEnvironment.spec.ts src/architecture.startEnvironment.spec.ts src/cliStartEnvironment.spec.ts \
     src/config/loadEnv.spec.ts src/config/env.spec.ts src/lib/daemonLaunch.spec.ts src/lib/windows/noWindow.spec.ts \
     src/testing/startEnvFile.spec.ts src/architecture.spec.ts src/architecture.environment.spec.ts \
     src/cliStopFirst.spec.ts src/cliCommand.spec.ts src/loginForceRace.spec.ts
   npm run typecheck
   ```

   To see: every file passed, and no typecheck error. `cliCommand.spec.ts` shows the dev run's `[env]` line.

2. **A pane after `harness start`, on macOS:** `e2e/cli.e2e.ts`, the installed bundle under a throwaway home.

   ```bash
   caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/cli.e2e.ts
   ```

   To see: `Tests 10 passed (10)`. In the new case a terminal pane of a daemon that `harness start` started from a
   shell holding `SENTINEL_TOKEN` and `CLAUDE_CODE_MESSAGING_TOKEN` has neither, has `PATH`, the kept
   `ANTHROPIC_API_KEY` sentinel and the env file's variable, and the daemon's log has the `[env]` line with no name
   in it.

3. **A pane after `harness start -f`, on macOS,** from the sources and from the bundle, with a master and with the
   core alone:

   ```bash
   caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/paneEnv.e2e.ts
   caffeinate -i env E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/paneEnv.e2e.ts e2e/master.e2e.ts
   ```

   To see: `paneEnv` 5 of 5 both times; `master.e2e.ts` whole, as at the base.

4. **The starts that must not change:**

   ```bash
   caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/twodaemons.e2e.ts e2e/sandbox.e2e.ts
   ```

   To see: both files as at the base (a second start beside a running daemon, and a start in Codex's sandbox).

On GitHub, by hand, after the branch is pushed, **each one run, on a runner turn from the orchestrator, one after
the other** (`docs/validation-and-release.md`: never several heavy workflows together). Report each run's link.

5. **The whole end-to-end suite on Linux** (eight shards, from the bundle), and the full disk on macOS: the existing
   workflow, which has `workflow_dispatch`.

   ```bash
   gh workflow run cli-e2e.yml --ref fix/daemon-minimal-env
   ```

   To see: `e2e (1)` to `e2e (8)`, `e2e (macOS, full disk)` and `e2e-summary` green; `cli.e2e.ts` 10 of 10,
   `paneEnv.e2e.ts` 5 of 5, `master.e2e.ts` as on `main`. A red test is reported with its link and whether
   `main`'s last nightly run has it too.

6. **Windows, unchanged where it runs:** the existing **Windows** workflow, which has `workflow_dispatch`. One run is
   worth it although Windows' behavior is meant not to change, because Windows runs changed code:
   `config/loadEnv.ts` (now `loadEnvFile`) loads in every Windows CLI and daemon process, `lib/windows/noWindow.spec.ts`
   changes and is in that job's spec list, and the install job's `harness.exe start` runs the new bundle's start.

   ```bash
   gh workflow run windows.yml --ref fix/daemon-minimal-env
   ```

   To see: both `windows-pty` jobs (the Windows CLI specs, `noWindow.spec.ts` among them) and both `install` jobs
   green (x64 and arm64). The install job installs this build with `install.ps1`, starts the daemon with
   `harness.exe start` (through `harness-launch.exe` and the unchanged `launchMaster`) and runs
   `check-install.ps1`: the daemon runs, and a PowerShell terminal starts on the terminal host. The OpenCode bind
   step on x64 is not gating there; report what it printed.

Not checked, and said so in the pull request, each an unverified row, never a passing one:

- **Harness OS's own image.** Its start (`start --foreground` with `HARNESS_NO_MASTER=1`, with `npm_config_prefix`
  and `BROWSER` kept) is check 3's second case on macOS and check 5's on Linux; no image is built for this change
  (OS workflows run by hand, for installer, image or session changes).
- **The X11 clipboard** on a real Linux desktop: Task 1's unit case holds that `DISPLAY` and `XAUTHORITY` are kept;
  no workflow runs `xclip` against a display manager's cookie.
- **A start from a Windows checkout build** (`spawnDaemon`'s spawn on `win32`): no workflow runs one; Task 5's unit
  case holds that its environment is the whole one.

**Temporary workflow:** none. Both long checks have a workflow that runs from a branch by hand (`cli-e2e.yml`,
`windows.yml`).

**A check that keeps running:** `cli-e2e.yml` runs the three new end-to-end cases every night on Linux, and pull
request CI runs the unit specs, the read-coverage test and the source assertions on every pull request. No
permanent workflow is proposed.
