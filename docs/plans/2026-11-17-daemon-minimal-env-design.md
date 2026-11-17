# The daemon starts from an explicit environment

Date: 2026-11-17. Branch: `fix/daemon-minimal-env`. Component: `cli/` (the CLI and harnessd). Platforms: macOS and
Linux change. Windows keeps today's behavior in this pull request (decision 5).

## Problem

`harness start` spawns the daemon with `env: { ...process.env }` (`cli/src/cli.ts`, `launch()`). Whatever ran
`harness start` gives the daemon its whole environment, and the daemon gives it to every process it starts: the core,
the services, the tmux server it starts (which copies its environment into every new pane), and every agent, terminal
tile and hook.

The only guard today is a denylist (`lib/agentSessionEnv.ts`: `AGENT_SESSION_VARIABLES` and every `ORCA_*`), which
the master and a master-less core drop at start. A denylist only knows the programs someone has listed. Any other
program's session secrets still reach every pane: a CI or IDE shell's `GH_TOKEN`, a VS Code terminal's `NODE_OPTIONS`
bootloader, a new Claude Code or Orca variable that is not on the list yet.

The daemon does not need them. `harness service install` already runs it from an explicit environment: launchd's or
systemd's own, plus `CARRIED_ENV` (`lib/platformDaemon.ts`), plus what the person puts in `HARNESS_ENV_FILE`. On
macOS and Linux every pane runs its engine through the person's interactive login shell
(`engineLaunch.ts interactiveEngineShell`), and the daemon's one-shots and engine-home readers fill gaps from a
captured login shell (`lib/loginShellEnv.ts`). So variables from the person's rc files reach their agents anyway.

## Goal

On macOS and Linux, the daemon started from a shell gets only what Harness and the engines it launches need, from an
explicit allowlist. Another program's session tokens never reach it. Everything that works under
`harness service install` keeps working under `harness start`.

## Decisions (orchestrator, 2026-11-17)

1. Design A below.
2. **Provider credentials are kept** for now, so that nobody who exports an API key in the shell they run
   `harness start` from loses their agents. They are named in the allowlist one prefix at a time and tested. There is
   no `*TOKEN*` or `*KEY*` wildcard. The doc says that provider keys move to `HARNESS_ENV_FILE` next; whether to drop
   them from the allowlist then is a later product decision.
3. **Engine home and path settings are kept** (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `CURSOR_CONFIG_DIR`, …). They are
   settings, not secrets, and the daemon reads them to find sessions.
4. Every agent-session variable is still dropped (`CLAUDE_CODE_MESSAGING_TOKEN`, `CODEX_THREAD_ID`, every `ORCA_*`, …),
   even where an allowed prefix would match it. The denylist wins over the allowlist.
5. **Windows keeps today's rule in this pull request.** A Windows pane has no login shell: the terminal host starts
   with the core's environment (`lib/ptyHost/launch.ts`), so the daemon's environment is the only way a person's own
   variables (`JAVA_HOME`, `GOPATH`, `CLAUDE_CODE_GIT_BASH_PATH`, …) reach an agent. Narrowing it waits for a start
   that reads the user's durable variables from the registry. That is a follow-up item, named in the doc.
6. **Harness OS's unit variables are kept:** `npm_config_prefix` and `BROWSER`
   (`os/root/usr/lib/systemd/user/harness-daemon.service`).
7. **`XAUTHORITY` is kept**, beside `DISPLAY`, for the X11 clipboard.
8. **A dev run is narrowed too.** `harness start` from the sources (no `-f`) runs the core in the CLI's own process
   (`cli.ts`); it follows the same rule as every other start.
9. **Settings read through a parameter are kept** when they are a setting, not a secret and not a session's:
   `SSH_CONNECTION`, `ZDOTDIR`, `WSL_DISTRO_NAME`, `GRID_HOME`, `GRID_CONTROL_PLANE_URL`, `LLAMA_SERVER`, `HC_SOCKET`
   (the Herdr Core adapter).
10. **Dropped on purpose, with the doc pointing to `HARNESS_ENV_FILE`:** `HC_SESSION` (the calling shell's Herdr
    session), `TYPESAFE_CREDENTIALS` (a credential), `GIT_SSH_COMMAND` (a command line every git in every pane would
    run).
11. The function is named `startEnvironment()`. `cli/src/testing/daemonEnvironment.ts` already exports a
    `daemonEnvironment`, the test harness's own.

## Design

### One function, the places a shell's environment enters

`cli/src/lib/startEnvironment.ts` exports:

- `startEnvironment(env, platform = process.platform): NodeJS.ProcessEnv` returns a new object. On macOS and Linux it
  holds only the allowed entries of `env`, minus every name `isAgentSessionVariable` matches. On Windows it returns a
  copy of `env` unchanged (decision 5).
- `START_ENV_NAMES`, `START_ENV_PREFIXES` and `DROPPED_ON_PURPOSE` are the lists, grouped and commented by why each
  entry is there.

It is applied where an outside shell's environment enters the daemon:

1. **`harness start` (background).** The spawn in `launch()` uses `env: startEnvironment(process.env)` in place of
   `{ ...process.env }`. The desktop app's start comes through here.
2. **`harness start -f` (foreground), and a dev run from the sources.** Before the master (or, with
   `HARNESS_NO_MASTER=1` or a dev run, the core) starts in this process, `process.env` is narrowed in place to
   `startEnvironment(process.env)`. Its children inherit the narrowed environment. Harness OS's unit runs this path.

The Windows `launchMaster` is not changed (decision 5).

`__harnessd` and `__run` are internal entries. Their caller chooses the environment: the launchd plist and systemd
unit (already explicit), `harness start` (now explicit), a master re-exec (the master's own, already narrowed), the
end-to-end harness. They are not narrowed again, so the end-to-end suite's `NODE_OPTIONS` preloads keep reaching the
daemon they test. The master's and core's `dropAgentSessionEnv()` stays as it is, as the guard on those entries, and so
does the tmux server cleanup (`tmuxBackend.ts serverVariablesToUnset`), which is about a tmux server someone else
started.

`HARNESS_ENV_FILE` is loaded by every daemon process at start (`config/loadEnv.ts`). The CLI loads it at import,
before any narrowing, so a master or core that runs in the CLI's own process (`-f`, a dev run) loads it again after
narrowing. It stays the place for anything else the daemon or its agents should have.

### The allowlist (macOS and Linux)

Exact names unless marked as a prefix (`*`).

| Group | Names | Why |
|---|---|---|
| System | `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `TZ`, `LANG`, `LANGUAGE`, `LC_*`, `SSH_AUTH_SOCK`, `SSH_CONNECTION`, `__CF_USER_TEXT_ENCODING`, `TMUX_TMPDIR`, `ZDOTDIR`, `WSL_DISTRO_NAME` | What launchd and systemd give a user agent; the locale (`lib/childLocale.ts`); git over SSH in panes; a daemon started over SSH asks for no password dialog nobody sees (`services/agentBrowser/setup.ts`); tmux's socket folder; the person's zsh startup folder; WSL detection |
| Linux desktop | `XDG_*`, `DBUS_SESSION_BUS_ADDRESS`, `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY` | Config and runtime folders, the clipboard (`lib/osClipboard.ts`), guest helpers |
| Network | `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` and their lowercase forms, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR` | A machine behind a proxy or a private CA reaches the backend, and its engines reach theirs |
| Harness | `HARNESS_*`, `HARNESSD_*`, `ADAPTER_*`, `DOTENV_CONFIG_PATH`, `NODE_ENV`, and every variable `config/env.ts` reads (its `fields`, exported as a list) | Harness's own settings. `HARNESSD_*` is still held by each process as `lib/harnessdEnv.ts` says |
| Harness OS | `npm_config_prefix`, `BROWSER` | Set by Harness OS's unit for the daemon's own children |
| Engine settings | `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `OPENCLAW_HOME`, `CODEX_PATH`, `CURSOR_CONFIG_DIR`, `CURSOR_DATA_DIR`, `OPENCODE_DB`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `KILO_DB`, `GRID_HOME`, `GRID_CONTROL_PLANE_URL`, `LLAMA_SERVER`, `HC_SOCKET`, and the engine homes and paths in `config/env.ts` | Where each engine and runtime keeps its state; decisions 3 and 9 |
| Provider credentials (for now) | `ANTHROPIC_*`, `OPENAI_*`, `AWS_*`, `GOOGLE_*`, `GEMINI_*`, `AZURE_*`, `OPENROUTER_*`, `XAI_*`, `CLOUD_ML_REGION`, `CLAUDE_CODE_USE_*` | What the engines Harness launches read to reach their provider (Claude Code on Bedrock or Vertex, Codex, Gemini, Grok); decision 2 |

Dropped on purpose (`DROPPED_ON_PURPOSE`, each with its reason in the code): `TERM` and `COLORTERM` (tmux sets a pane's
own, and a daemon under launchd has none), `NODE_OPTIONS` (an IDE terminal's debugger bootloader would run in every
daemon process), `TMUX` and `TMUX_PANE` (the caller's pane, never the daemon's), `HC_SESSION`, `TYPESAFE_CREDENTIALS`,
`GIT_SSH_COMMAND` (decision 10), the names the read-coverage scan finds that no group covers (`GIT_CONFIG_GLOBAL`,
`GIT_CONFIG_SYSTEM`, `UV_THREADPOOL_SIZE`, `VITEST`; the plan gives each reason), and every agent-session variable.

### Keeping the list honest

A test reads every `process.env.NAME` and `process.env['NAME']` in `cli/src` (not tests, fixtures, `testing/` or
`e2e/`). Each name must be allowed by the allowlist or listed in `DROPPED_ON_PURPOSE` with a one-line reason. A new read
of an unlisted variable fails the test, so whoever adds it decides. Names read through a parameter (decisions 3 and 9)
are not visible to the scan, and are pinned by the unit test instead.

### Errors and logging

Nothing new can fail: the function is pure. `harness start` logs one line to the daemon log with the **count** of
variables it left out, never their names or values (code standard 7), so a person can tell why a variable is missing:
`[env] started with N variables; M left out (docs/cli.md#the-daemons-environment)`.

### Docs

`docs/cli.md` gets a section "The daemon's environment". It lists the allowlist by group. It says that rc files reach
agents through the login shell, and that `HARNESS_ENV_FILE` is the place for anything else, the dropped settings of
decision 10 among them. It notes that provider keys will move to `HARNESS_ENV_FILE`, and that Windows keeps the whole
environment until a start reads the user's variables from the registry. `cli/AGENTS.md` rule 4 (the core meets the
outside least) links to it.

## Testing

Red first, with sentinel variables:

- **Unit (`lib/startEnvironment.spec.ts`).** An environment holding outsiders (`SENTINEL_TOKEN`, `GH_TOKEN`,
  `NODE_OPTIONS`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CODEX_THREAD_ID`, `ORCA_PAIRING_CODE`, `HARNESS_AGENT_SESSION`, `TERM`,
  `HC_SESSION`, `TYPESAFE_CREDENTIALS`, `GIT_SSH_COMMAND`) drops every one of them on macOS and Linux. It keeps `PATH`,
  `HOME`, `LC_ALL`, `HTTPS_PROXY`, `https_proxy`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, `AWS_PROFILE`,
  `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `CURSOR_CONFIG_DIR`, `HC_SOCKET`, `XAUTHORITY`, `SSH_CONNECTION`,
  `npm_config_prefix`, `ADAPTER_DATA_DIR`, `HARNESS_ENV_FILE`. On Windows it returns the environment unchanged.
- **The read-coverage test** above.
- **The starts.** Unit tests for the extracted spawn options, and for the in-place narrowing and env-file reload of
  `-f` and a dev run.
- **End to end (`e2e/`).** `harness start` from an environment holding `SENTINEL_TOKEN=…` and
  `CLAUDE_CODE_MESSAGING_TOKEN=…` runs against the isolated daemon and a private tmux server. A new terminal pane's
  `env` has neither, and still has `PATH` and a kept `ANTHROPIC_API_KEY` sentinel. The same holds for `harness start -f`.
- Existing suites that start the daemon through `harness start` with test-only variables move those variables to an
  `HARNESS_ENV_FILE`, or to `__harnessd` where they test the daemon itself.

Local gates: `npm run test:core` and `npm run test:harnessd` if those folders change, plus the end-to-end check above.

## Out of scope

- Windows (decision 5): a follow-up item, once a start reads the user's durable variables from the registry.
- Moving provider keys to `HARNESS_ENV_FILE` and dropping them from the allowlist (decision 2, a later item).
- The macOS helper that reads `KERN_PROCARGS2` (already a listed follow-up in `cli/AGENTS.md`).
- Narrowing a tmux server someone else started, beyond the existing named unset.

## Risks

- A variable some user relies on that is in no group above stops reaching the daemon started by `harness start`.
  The daemon has the same gap under `harness service install` today. The log line and the doc say where to put it.
- The branch `fix/harnessd-process-title-env` edits the same spawn line; whichever merges second rebases.
