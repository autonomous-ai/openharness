# E2E daemon isolation from the developer's state: design

## Problem

`cli/e2e/harness/daemon.ts` `IsolatedDaemon.create` builds the daemon's environment as
`daemonEnvironment(tmux.env, own)`: everything in the shell that runs the tests, minus a few borrowed names
(`src/testing/daemonEnvironment.ts`: `HARNESSD_*`, an agent session's variables, GitHub logins, the host app's hints),
with `own` on top. `own` pins HOME, the data, runtime and auth folders, CODEX_HOME, grid (#4307) and the rest, but not:

- `HARNESS_CONNECTIONS_DIR`: `lib/connectors/store.ts` `connectorsDir` reads it first. A developer who set it gives
  every e2e daemon their connected-service tokens (`tokens.json`, `clients.json`).
- `XDG_DATA_HOME`: `Store.adoptLegacy` copies `<XDG_DATA_HOME>/harness-os/connections/*` into the daemon's store when
  that has none, so the developer's Harness OS tokens are copied into the test root. It also places OpenCode, Kilo,
  Devin, Muse and Amp data (`config/env.ts`).
- `USERPROFILE` (Windows): `os.homedir()` follows it there, not HOME, so every default under `homedir()` is the
  developer's real profile.

A denylist that names these would miss the next one: the audit below found two dozen, and names no code reads today
(`AWS_*`, `NPM_TOKEN`, `SSH_AUTH_SOCK`: a daemon holding the developer's ssh agent can push as them) would still pass.

## Audit: what the daemon inherited that names the developer's state

Read from the names the daemon's code reads (`cli/src`, not specs); values were never read. Every one of them is gone
after this change.

| Kind | Variables |
|---|---|
| Connected services | `HARNESS_CONNECTIONS_DIR` |
| Shared folders | `XDG_DATA_HOME`, `XDG_CONFIG_HOME`; Windows `USERPROFILE`, `LOCALAPPDATA`, `APPDATA` |
| Engine homes the harness does not pin | `AGY_HOME`, `AMP_PLUGIN_DIR`, `AMP_SESSIONS_DIR`, `AMP_STATE_DIR`, `COMMANDCODE_HOME`, `COPILOT_HOME`, `CURSOR_HOME`, `CURSOR_CONFIG_DIR`, `CURSOR_DATA_DIR`, `DEVIN_HOME`, `DEVIN_CONFIG_PATH`, `GROK_HOME`, `HERMES_HOME`, `KILO_DATA_DIR`, `KILO_PLUGIN_DIR`, `MUSE_HOME`, `MUSE_CONFIG_DIR`, `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, `OPENCODE_DATA_DIR`, `OPENCODE_PLUGIN_DIR`, `PI_HOME`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` (the readers and adoption read these; hooks are installed only for Claude Code and Codex) |
| Harness folders and files | `HARNESS_AGENT_MESSAGES_DIR`, `HARNESS_DEVICES_DIR`, `HARNESS_LOGS_DIR`, `HARNESS_PTY_DIR`, `HARNESS_PTY_BIN`, `HARNESS_BIN_DIR`, `ADAPTER_CLI_DIR`, `HARNESS_FLASHER_CACHE`, `HARNESS_TUI_BIN`; `HARNESS_ENV_FILE` and `DOTENV_CONFIG_PATH` (`config/loadEnv.ts` loads the developer's env file into the daemon) |
| Credential files | `ORI_CREDENTIALS_PATH` (OpenRouter), `GIT_CONFIG_GLOBAL` |
| API keys | every `keyEnv` of `lib/apiConnections.ts` `API_PRESETS` (`OPENROUTER_API_KEY`, `REQUESTY_API_KEY`, `FAL_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `REPLICATE_API_TOKEN`) and `ANTHROPIC_AUTH_TOKEN` (`lib/gatewayRuntime.ts`) |
| Not read by the daemon's code, but reachable by what it runs | `SSH_AUTH_SOCK`, `AWS_*`, `NPM_TOKEN`, `GH_TOKEN`/`GITHUB_TOKEN` (already dropped), `NODE_OPTIONS` |

## Change

One rule, in one place: a daemon under test inherits only what it needs to run and nothing that names the developer's
state. What the harness sets, and a test's `options.env`, still win (`own`, spread last).

1. `src/testing/daemonEnvironment.ts` keeps from the inherited environment only an allowlist, each name with its reason
   in a comment:
   - `PATH` (the harness prepends its own `bin`; the tools the tests run: node, tmux, git, zsh);
   - `LANG`, `LC_ALL` and every `LC_*` (UTF-8 in tmux and the panes; CI sets `LANG: C.UTF-8`);
   - `TERM` (tmux and the panes), `SHELL` (the login shell a pane opens; CI sets `/bin/zsh`);
   - `USER`, `LOGNAME` (who the process is; no state);
   - `TZ` (times in logs and transcripts), `CI`;
   - Windows: `SystemRoot`, `ComSpec`, `PATHEXT`, `windir` (Node cannot spawn a child without them there).
   Everything else is dropped, so the old borrowed-name filters (`HARNESSD_*`, agent session, GitHub logins, host
   hints) are replaced by this one rule and removed. A name an e2e file turns out to need is added to the allowlist
   with its reason; never a denylist again.
2. `IsolatedDaemon.create` pins the Windows profile under its throwaway home, since `homedir()` falls back to the real
   profile there and dropping the names is not enough: `USERPROFILE` = home, `LOCALAPPDATA` = `home/AppData/Local`,
   `APPDATA` = `home/AppData/Roaming`. It does not pin `XDG_*`: the allowlist already keeps the developer's out, and every
   default then falls under the throwaway HOME (`home/.config`, `home/.local/share`); a pin would also move Cursor's
   config folder to `home/.config/cursor` and send the real-Podman file's Podman on macOS to look for its machine there.
   `HARNESS_CONNECTIONS_DIR` and the engine homes are no longer inherited either, so their defaults fall under that home
   (`home/.harness/connections`). `TMPDIR` stays pinned to the root's `t` folder, as today, and is not on the allowlist:
   the parent's is never used. It names in `own` what it relied on inheriting: `TMUX_TMPDIR` from its isolated tmux
   (today it rides in on `tmux.env`), and the loopback `HARNESS_STORE_CATALOG_URL` that `cli/vitest.setup.ts` sets, so
   the Store never reads the live catalog. The `CLAUDE_CONFIG_DIR` delete after the call becomes dead (it is no longer
   inherited) and is removed, and so are the per-file guards the allowlist makes dead (`VITEST: ''` in
   `sharedTabs.e2e.ts`, the delete loops in `cli.e2e.ts`, `harness/fleet.ts`, `tuiShell.e2e.ts`,
   `deviceWithoutApp.e2e.ts`).

## Tests (red first)

- `src/testing/daemonEnvironment.spec.ts` (unit, PR CI): an unknown variable in the parent (`FAKE_SECRET_TOKEN`) does
  not reach the daemon; neither do fake values for the audit's names (`HARNESS_CONNECTIONS_DIR`, `XDG_DATA_HOME`,
  `SSH_AUTH_SOCK`, an API key); every allowlisted name and `LC_*` passes; a value in `own` wins. The existing cases
  (HARNESSD_, agent session, GitHub, host hints) stay as assertions of the new rule.
- A new e2e file `e2e/developerState.e2e.ts`: the test process's env names a fake `HARNESS_CONNECTIONS_DIR` holding a
  saved connection, and a fake `XDG_DATA_HOME` holding a legacy Harness OS `tokens.json`, both in a temp folder of the
  test. The daemon starts, `connectors` `list` shows neither connection, the fake folders are unchanged,
  `d.env.USERPROFILE` is its home and `d.env.XDG_DATA_HOME` is unset. A second case: a test's own `HARNESS_CONNECTIONS_DIR`
  in `options.env` is the one used. Red on `main`.

## Verification

The change reaches every e2e daemon, so the whole suite runs once on GitHub (`cli-e2e.yml`, Run workflow on the branch,
after a runner turn from the orchestrator), and once more with `agent_browser_podman=true` (that input runs only the
real-Podman file, which the eight shards leave out; on Linux its Podman loses the inherited `XDG_RUNTIME_DIR`). Locally:
the new e2e file and the files the plan names (`enginehomes.e2e.ts` without the eight cases that type an engine's name,
see Follow-up). Platforms: macOS and Linux (e2e runs there;
the Windows pins are not exercised by an e2e run, which needs tmux).

## Failure cases

- An e2e file that needed an inherited variable fails on the GitHub run: the variable goes on the allowlist with its
  reason, in this pull request.
- A developer who needs a daemon under test to see a real value sets it in that test's `options.env`.

## Follow-up (high priority, its own item)

E2E daemons on a developer's Mac can run the developer's REAL Claude Code and Codex. A terminal tile opens a login zsh,
and macOS's `/etc/zprofile` (`path_helper`) puts `/usr/local/bin` ahead of the harness's own `bin`, so typing `claude`
or `codex` in a tile starts the real engine, under the developer's login, instead of the fake one. Reproduce: on a Mac
with the real `claude` and `codex` in `/usr/local/bin`, `cd cli && SHELL=/bin/zsh TMPDIR=/tmp npx vitest run --config
vitest.e2e.config.ts e2e/enginehomes.e2e.ts`: seven of the eight cases that type an engine's name fail, at the base
commit too. Not fixed here (this change keeps `PATH` as it was); other files that type an engine by hand share it.
