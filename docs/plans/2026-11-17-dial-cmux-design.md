# The dial lists, follows, talks to and opens cmux's agents (PM for Diego, 2026-11-17)

Wave 2, row 9 of the device integration roadmap: cmux through its CLI, and a short guide to its Automation mode. Built
like the other host adapters (#4341 the adapter layer, #4382 Herdr Core, #4373 a pick brings the app). Nothing in the
core (`cli/src/core/`).

## What cmux is and offers (read 2026-11-17 from `manaflow-ai/cmux` v0.65.2.2: its docs and source; not installed here)

cmux is a macOS terminal app built on Ghostty, for coding agents (`com.cmuxterm.app`). The Homebrew cask installs
`/Applications/cmux.app` and links `cmux` to `/Applications/cmux.app/Contents/Resources/bin/cmux`. It is **not installed
on this Mac**; nothing here installs it or changes its settings.

- **Every terminal** gets `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID` (UUIDs; `CMUX_TAB_ID` and `CMUX_PANEL_ID` repeat
  them) and `TERM_PROGRAM=ghostty` (`TerminalSurface+StartupEnvironment.swift`). So today a hooked agent in cmux is on Ghostty's
  page, and a tap raises Ghostty: wrong.
- **Its own agent hooks** (installed by cmux for Claude Code, Codex, OpenCode, Pi, Grok, Gemini, Cursor, Amp and more)
  keep one store per agent, `~/.cmuxterm/<agent>-hook-sessions.json`, written on every hook. `cmux sessions list --json`
  reads those stores **without the socket** and prints, per record: `agent`, `session_id`, `workspace_id`,
  `surface_id`, `cwd`, `transcript_path`, `pid`, `agent_lifecycle` (`running`, `idle`, `needsInput`, `unknown`),
  `active_for_surface` and more (`CLI/CMUXCLI+SessionsList.swift`). The top level is `{state_dir, default_codex_home,
  limit, total_matches, stores, sessions}`, newest first, cut at 100 unless `--all`. `--agent <name>` reads one agent's
  store; a Codex run also walks `CODEX_HOME/sessions` for its index.
- **The control socket** has five modes (Settings ▸ Automation ▸ Socket Control Mode, `automation.socketControlMode`):
  `off`; `cmuxOnly`, the default, "only processes started inside cmux terminals" (an ancestry check); `automation`,
  "external local automation clients from this macOS user"; `password`; `allowAll`. The Harness daemon is not started
  inside cmux, so with the default every socket command from it is refused. `cmux socket-status --json` reports
  `effective_mode` **without connecting** (`CLI/CMUXCLI+SocketControlStatus.swift`): the saved setting with the
  caller's environment overrides, `live_enforcement: "not_observed"`, so a running app that has not applied a change yet
  can still refuse.
- **Typing:** `cmux paste --surface <id> --submit -` pastes stdin through the Cmd+V path (bracketed when the program
  asks, unsafe control bytes replaced) and presses the agent's own submit key. It refuses over a draft or an open dialog
  unless `--force` (its Draft guard). `surface.input_state` (`cmux rpc`) answers `terminal`, `agent`, `lifecycle`
  (`unknown`, `running`, `idle`, `needsInput`), `state` (`empty`, `draft`, `dialog`, `unknown`) and `blocks_typing`.
  All of these need the socket.
- **Links:** `cmux://workspace/<workspace>/surface/<surface>` opens that tab (`CmuxNavigationTargetResolver.swift`;
  runtime or restart-stable ids; a surface moved to another workspace is still found). Opened by `open`, it needs no
  socket and brings cmux forward.

## Goal

With cmux on this Mac and a dial attached:
- each agent cmux tracks is on the dial, on cmux's page, with its live state, hook or no hook, in cmux's default mode;
- a tap, and a rest while cmux is in front, open that agent's tab;
- a pick of cmux on the APPS screen brings cmux forward;
- the dial's words reach an agent only at an idle prompt, and only with cmux's Automation mode on; otherwise the dial
  says how to turn it on;
- after a daemon restart, an idle Claude Code or Codex agent in cmux shows its last recap (with #4391).

## Decided (PM for Diego, 2026-11-17)

1. **List and state** come from `cmux sessions list --json`, run again when `~/.cmuxterm` changes (pushed, not
   polled). Not `cmux events`, which needs Automation mode for everything.
2. **Voice** only when `effective_mode` is `automation` or `allowAll`, the surface's `input_state` is idle with an empty
   prompt, and the agent there is the one the dial means. Through `cmux paste --submit`, never `--force`. Otherwise the
   dial shows `Turn on Automation mode in cmux.`; the docs give the steps. `password` mode is not supported (no secret
   is read). cmux's settings are never changed.
3. **Tap and rest** are the `cmux://` link alone, sent to cmux by its bundle id through `appLink.ts` `createAppLink`
   with `bundle: 'com.cmuxterm.app'` (`open -b com.cmuxterm.app cmux://workspace/<w>/surface/<s>`, through `openPath`),
   as the Claude and Codex apps' links, so only the release app receives it. A second rest while one runs is `busy`.
   No `cmux focus-panel` (it needs the socket).
4. **A new app id `cmux`** (the 18th; the dial's list still holds the 16 apps that have agents), and a firmware
   `host_name` row `{"cmux", "cmux"}` with no firmware release: an older firmware names it "Terminal" until the next
   one. The hook sends `CMUX_SURFACE_ID` and `CMUX_WORKSPACE_ID`, on macOS only.
5. **The recap** after a restart waits for #4391 on `main`; the other tasks do not wait for it. It is #4391's own path
   (the scan's copy, below), held by two tests: no recap read in the cmux source (PM, 2026-11-17).
6. **Tests use a fake `cmux`**, built from the v0.65.2.2 docs and source above. cmux is not installed; a check against
   the real app is a follow-up. The end to end runs locally on this Mac, isolated, with no temporary workflow; a
   permanent macOS e2e job is a proposal (PM, 2026-11-17).
7. **The open scan's copy is placed at cmux's pane** (PM, 2026-11-17). A Claude Code or Codex session in cmux that the
   open scan lists before any hook wins the fold over cmux's row and has no cmux pane. `devices.ts` places it at that
   row's pane through the door Orca's ring already uses (`ObservedSource.setPaneNames('cmux', …, placed)`), so a tap and
   a rest work from the first list after a restart. No dependency on #4391.

## Design

Everything is in the devices process (`cli/src/cable/hosts/`, `cli/src/services/devices.ts`), the hook
(`cli/hook/notify.mjs`) and one firmware table row. `core/observedHook.ts` takes any hint name within its bounds.

### Finding cmux (`cmuxCli.ts`)

- The binary: `cmux` on `PATH` only when its real path (`realpath`) ends in `cmux.app/Contents/Resources/bin/cmux`
  (other programs are called `cmux` too: the cask's link resolves into the app); else
  `/Applications/cmux.app/Contents/Resources/bin/cmux` when it exists. None: cmux is not installed and nothing below
  runs. The e2e puts its fake inside a `cmux.app/Contents/Resources/bin/` folder of its own and links it on `PATH`.
- **One client object** (`createCmuxClient`, injected as `deps.cmux` the way `deps.hc` is): `binary()`,
  `sessions(agent?)`, `mode()`, `inputState(surface)`, `paste(workspace, surface, text)`.
- **Its runs** are its own (`orca.ts`'s `deps.run` has no stdin and a 1 MiB buffer that reads as a timeout): `spawn`
  with no shell, each value one argument, stdin written and closed (empty when there is none), the 10 s run timeout
  (`RUN_TIMEOUT_MS`), stdout read up to 8 MiB, past which the run is killed and answers `too-big` (apart from
  `timeout`). The environment is the devices process's own **without any `CMUX_*` variable**: a daemon started from a
  cmux terminal carries them, and `socket-status` and `sessions list` would follow them (a mode override, another
  store folder than the one watched). The core's `agentSessionEnv.ts` is not changed.
- Every value from a hook or from cmux is checked against its form again before it is an argument: a UUID
  (`/^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/`) for a surface or workspace, a kind for `--agent`.
- It never throws and never logs: cmux's answers name people's folders and agents.
- The release app only (`com.cmuxterm.app`); cmux NIGHTLY (`com.cmuxterm.app.nightly`) is not tried.
- **Kinds:** cmux's `agent` word goes through one closed table here, to Harness's engine ids (`engines/types.ts`
  `ENGINES`): `claude`, `codex`, `cursor`, `opencode`, `pi`, `omp`, `muse`, `amp`, `grok`, `copilot` as themselves,
  `hermes-agent` → `hermes`, `antigravity` → `agy` (cmux's words from `AgentHookCatalog.swift` at the tag). Another word
  (`gemini`, `kiro`, …) keeps its own when it fits `/^[a-z][a-z0-9-]{0,31}$/`, as hc's unknown kinds do; else the
  record is not listed. `--agent` is given cmux's word, from the store file's name.

### The cmux source (`cmuxSource.ts`)

Built as `HcSource` is: it runs while a dial is attached and cmux is found, stops with the last dial, lists at most 64
agents, and tells `onChange` only when the listed rows changed.

- **When it reads:** at start, one `sessions list --json --all` run. Then on each change of a store file
  (`<word>-hook-sessions.json`) in `~/.cmuxterm` (the devices process's own `HOME`), one run for that agent alone
  (`--agent <word> --all`), whose rows replace that agent's rows; the other agents' rows stay. So a Claude Code hook
  never walks Codex's sessions. A change with no file name runs all agents. Per agent, one run at a time; changes during
  a run give one more after it. A run that ends after `stop()` is dropped.
- **The watch** is `unixSocket.ts`'s `watchSocket`, made to pass the changed file's name (no second watcher): it holds
  `~/.cmuxterm`, else its parent and `HOME`, and goes back to them when the folder is removed. With no `~/.cmuxterm`
  nothing is listed until it appears. No timer runs.
- **Bounds:** `--all`, since the default 100 newest records may leave out an idle active agent behind restorable old
  ones; the 8 MiB bound holds it (`too-big` keeps the rows as they were). `total_matches` above what was read is
  `over`.
- **Listed:** a record with `active_for_surface: true`, UUID `surface_id` and `workspace_id`, a positive integer `pid`
  that is alive (`process.kill(pid, 0)` succeeds or fails with `EPERM`; it reads nothing of the process), and a kind
  (above). One row per surface: the
  newest `updated_at_unix` wins. Other records (ended sessions, other surfaces' history) are not listed.
- **Row:** a `uuid()` id, the pane key `cmux:<surface, lower case>`, host and app `cmux`, the engine from the kind, the
  `session_id` when it fits `/^[A-Za-z0-9._:-]{1,128}$/`, the folder's name from `cwd` else the kind as its name, and
  `cwd`. State: `running` → working, `needsInput` → needs-you, `idle` and `unknown` → idle. cmux has no done word, so,
  as hc's idle after working (`hcSource.ts`, herdr's Q10), a turn that leaves `running` or `needsInput` for `idle` is a
  done card with nothing unseen. `transcript_path` is never read: a recap reads only inside the engine's own folders
  (below).
- **An agent that exits** without a hook (killed) stays until the next change in `~/.cmuxterm` or the next attach; each
  run drops rows whose pid is gone. No timer polls pids.
- **Its tap** goes through the opener (`open.ts`) to the cmux adapter's `focus`, as a hooked agent's does. **Its rest:**
  `hasPane` (the adapter's `canShow`) and `showPane` (the adapter's `show`). **Its words:** the adapter's `prompt`,
  with the refusals below as the dial's sentences.
- **Merge with a hooked copy:** the registry folds a row into the hooked copy on any one of the same `engine` and
  `session_id`, the same pid, or the same pane key (`registry.ts`), and keeps the hooked one. The cmux row carries all
  three (`callerPid` from `pid`), so the fold holds also while the hooked copy has no cmux pane yet.
- **The open scan's copy** (decided 7): the scan lists every open Claude Code and Codex session, and its copy wins the
  fold by its session id, with no cmux pane until that session's next hook. `devices.ts` places each such copy with no
  cmux pane of its own at the pane of the cmux row that names its engine and session id (the source tells a row's pane,
  `paneAt`), through `setPaneNames('cmux', new Map(), placed)`, after each change of either source. A place opens and
  shows, never takes words: its state and words stay the scan's until its first hook. The place goes when cmux no
  longer lists that session, or when a hook gives it a cmux pane of its own.
- Logs, fixed words and counts only: `[cmux] listed · <n> agents`, `[cmux] list · failed|too-big`,
  `[cmux] over · <n> left out`, `[cmux] watch · none|on`, `[cmux] read · <agent word or all> · <ms>` (the hot-path
  number: each run's time, from the fake in tests and from a real cmux later).

### The cmux adapter (`cmuxApp.ts`)

- `id: 'cmux'`, `tap: 'instead'` (the link brings cmux itself), `bundle: 'com.cmuxterm.app'`, macOS only.
- **`paneOf`:** `CMUX_SURFACE_ID` and `CMUX_WORKSPACE_ID`, both UUIDs, with `place.host === 'cmux'`. The pane id holds
  both (`<workspace>/<surface>`); `paneKey` is `cmux:<surface, lower case>`.
- **`focus`, `canFocus`, `show`, `canShow`** come from `appLink.ts` `createAppLink` with `bundle: 'com.cmuxterm.app'`
  (decided 3): `open -b com.cmuxterm.app cmux://workspace/<workspace>/surface/<surface>` by `open.ts`'s `openPath` (so
  `HARNESS_OPEN_BIN` in tests), the pane id checked again first. True once `open` exits 0. `canFocus`: macOS.
  **`canShow`:** cmux is the app in front (`frontApp`, by its bundle). **`show`:** the same link run; a second rest of
  that agent while one runs is `busy`.
- **`prompt(pane, kind, text)`**, the one way words reach cmux, for the source and for a hooked copy:
  1. A blank text, or one over `MAX_TEXT`, is not sent; control characters become spaces. One prompt per surface at a
     time: a second is `busy`. `paste` is given `--workspace` and `--surface`.
  2. `cmux socket-status --json`: `effective_mode` not `automation` or `allowAll` is `automation-off`.
  3. `cmux --json rpc surface.input_state {"surface_id": <surface>}`: it must say `terminal: true`, `agent: true`,
     `lifecycle: "idle"`, `state: "empty"`, `blocks_typing: false`. `needsInput` is `waiting`; `running`, a draft or a
     dialog is `busy`; anything else, or a failed run, is `no-answer`.
  4. When the cmux source has a record on that surface, its kind must be `kind`: else `no-answer` (another agent holds
     the surface now).
  5. `cmux paste --surface <surface> --submit -`, the text on stdin (never in an argument, where other processes see
     it), with `--json` so the answer's `submitted` is read (`printV2Payload` of `terminal.paste`): exit 0 and
     `submitted: true` is `sent`. Pasted but not submitted (`submitted` not `true`), a non-zero exit or a timeout is
     `no-answer` and is never sent again: the words may be at the prompt already. cmux's own Draft guard runs in that
     command too (`ensureAgentPromptIsFree`).
- **`type`, `canType`:** `type` runs `prompt` and answers `true` (`sent`), `'busy'`, `'waiting'`,
  `{ refused: 'Turn on Automation mode in cmux.' }` (`automation-off`) or `false` (the rest); `canType` is true when
  cmux is found (the mode is checked by `prompt`, when the words are said, so turning Automation mode on takes effect
  at once).
- **Order in `devices.ts`:** right after Herdr's (`herdr`, `tmux`, `herdrApp`, then `cmux`, before WezTerm), wrapped
  by `noting` as the others are, so a hooked agent in cmux never reaches Ghostty's tab adapter.

### What the dial says when typing is refused (`adapter.ts`, `observed.ts`)

A hooked agent's words go through `observed.ts` `send`, which today turns a failed `type` into `<name> did not answer.`,
even when cmux says the agent is busy while its hook still says idle. `HostAdapter.type` becomes
`Promise<TypeResult>`, `TypeResult = boolean | 'busy' | 'waiting' | { refused: string }` (`types.ts`):
- `'busy'` and `'waiting'` give `send`'s own sentences with the agent's name (`<name> is busy. Say it when it is
  done.`, `<name> is waiting for your answer in <app>.`) and counts (`busy`, `waiting`);
- `{ refused }` is a fixed sentence of the adapter's, never a value from a hook or an app; `send` returns it and
  counts `refused (<adapter id>)` (a new entry of the count's union, mapped where `devices.ts` maps the others);
- only `true` is sent: `send` checks `=== true`, since an object is truthy.
`adapter.ts`'s rule 3 and `type`'s comment say so. The other adapters keep answering `true` or `false`. The cmux
source's own `send` maps the same outcomes to the same sentences.

A hooked Claude Code or Codex agent in cmux takes the dial's words through Harness's own mod or Codex queue first, as
anywhere (`observed.ts`): cmux's mode matters only when those do not take them.

### The hook and the app (`notify.mjs`, `hostDetect.ts`, firmware)

- `CMUX_SURFACE_ID` and `CMUX_WORKSPACE_ID` join `HOST_HINTS` after `HC_TERMINAL_ID`, on macOS only, and count toward
  `MAX_HINTS`. The copy in `hookNotify.spec.ts` changes with it.
- `inCmux(hints)`, beside `inHerdr` and for the same reason (every program started in a cmux terminal inherits its
  variables: `code .`, WezTerm, kitty, tmux): both CMUX hints are UUIDs, `TERM_PROGRAM` is `ghostty` or absent, and no
  nearer or other app's variable is set (`NEARER_HOSTS`, `HC_TERMINAL_ID`, `KITTY_WINDOW_ID`, `WEZTERM_PANE`,
  `ORCA_TERMINAL_HANDLE`). `detectHost` and `detectApp` answer `cmux` when `inCmux`, ahead of `TERM_PROGRAM`;
  `detectApp` also maps `com.cmuxterm.app` by `APP_BUNDLES`. The adapter's `paneOf` asks `inCmux` too.
- `cmux` joins `NAMES` (display `cmux`, after `ghostty`, so `codex` stays right after `claude`) and `APP_BUNDLES`;
  `APP_IDS` becomes 18 (`hostDetect.spec.ts`, and the "Seventeen ids" comment). The APPS pick brings it by #4373's path
  with no other change. `select.ts`'s `APP_LIMIT` (16) is unchanged.
- Firmware: `{"cmux", "cmux"}` in `ui_habitat.c` `host_name`, kept equal by `test_touch_ui.py`. No firmware release in
  this branch.

### The recap after a restart (waits for #4391)

#4391's scan reads the last answer of every open Claude Code and Codex session before it lists the row, and that copy
is the row the dial shows for a session cmux also lists (cmux's row folds into it, placed at cmux's tab: decided 7). So
the cmux source reads no recap (decided 5). Two tests hold done-when 6 through that path, once #4391 is on `main`: one
in `devices.spec.ts`, one in the end to end.

### The guide (docs)

`cli/AGENTS.md`'s devices row names cmux. `docs/specs/2026-11-15-device-host-adapter.md` gets cmux's row (list, state, tap, rest, words; what needs Automation
mode) and the steps, in two lines: in cmux, Settings ▸ Automation ▸ Socket Control Mode ▸ Automation mode. Only the
dial's words need it; Harness never changes it.

### Wiring (`services/devices.ts`)

The cmux source joins the registry after the hc source, behind `HARNESS_DEVICE_OBSERVED`, on macOS only. It starts at a
dial's attach when cmux is found and stops with the last dial. Its `onChange` runs the same turn as the other outside
sources. Its client is injected as `deps.cmux`, for tests. `devices.ts` keeps its 100% coverage under `npm run
test:core` (`cli/AGENTS.md`).

## Data

Nothing is stored or synced. For each cmux agent the dial gets the fields it gets for a Herdr one (name from the folder,
state, kind, folder), over the same local link. cmux's stores are read only through `cmux sessions list`, as this user,
from the devices process; `transcript_path`, launch commands and environments in them are not kept. The user's words go
to `cmux paste` on stdin. No log line names an agent, a folder, an id or words.

## Measures

`[cmux]` log lines above; voice outcomes through the existing counter, with `cmux` and `refused (cmux)` beside
`herdr-app`.

## Platforms

macOS only (cmux runs only there). Linux and Windows: no change; the hook sends no CMUX hint there.

## Testing

- **A fake `cmux`** (`cli/src/testing/fakeCmux.ts`): an executable script in the test's temp folder, inside a
  `cmux.app/Contents/Resources/bin/` folder, answering `sessions list --json`, `socket-status --json`,
  `--json rpc surface.input_state` and `--json paste --surface <id> --submit -` from a state file the test writes, and
  recording each call's arguments and stdin. Its answers follow the v0.65.2.2 field names above; the fixture names the
  tag and the files they come from.
- **Specs (red first):** `cmuxCli.spec.ts` (finding the binary, the PATH realpath rule, the kinds, bounds, timeouts),
  `cmuxSource.spec.ts` (listed or not, states, done cards, the watch with and without `~/.cmuxterm`, one run per agent
  at a time, a run after stop, pids gone, `EPERM`, the 64 cap, merge keys), `unixSocket.spec.ts` (the name passed), `cmuxApp.spec.ts` (`paneOf`, the link and its checks, the prompt's five steps and
  each refusal), `hostDetect.spec.ts`, `hookNotify.spec.ts`, `observed.spec.ts` (a `refused` sentence reaches the dial),
  `devices.spec.ts` (start and stop with the dial, no `CMUX_*` in a run's environment, the scan's copy placed at
  cmux's tab), `test_touch_ui.py`.
- **End to end, macOS** (`cli/e2e/deviceCmux.e2e.ts`): the daemon under test with its own `HOME`, the fake `cmux` on
  its `PATH` and the fake `open` (#4373). The records' pid is a live process the test starts and ends. Writing a store
  file in that `HOME` lists the agent with its state, and the log's `read` line gives the time from write to card; a state
  change arrives as a card; a tap runs one `open -b com.cmuxterm.app` of the `cmux://` link; the words arrive on the fake's stdin with
  `automation` and are refused with `cmuxOnly` (the dial's sentence); a pick of cmux runs `open -b com.cmuxterm.app`.
  It checks the fake is the cmux the daemon resolves before any tap, so a real cmux is never driven.
- Nothing runs or reads Diego's own cmux, `~/.cmuxterm` or cmux settings.

## Out of scope

- `cmux ssh` and cloud workspaces, other machines' surfaces; `password` mode; `cmux events`; answering a needs-input
  agent from the dial; installing or starting cmux; changing its settings.

## Follow-ups

- A check against the real cmux app (a nightly that installs the cask, or Diego once he installs it), with the `read`
  times of a real store and Codex index.
- cmux NIGHTLY.
- The firmware release that carries the `cmux` name.

## Done when

1. With cmux running and no Harness hook, each agent its stores list as active and alive is on the dial, on cmux's
   page, with its state; a state change reaches the dial as a card within a second of the store's write.
2. A hooked agent in cmux is listed once, on cmux's page, never Ghostty's.
3. A tap opens cmux at that agent's tab (opening cmux when it is closed); a rest with cmux in front shows the tab; a
   pick of cmux on APPS brings cmux forward.
4. The dial's words reach an idle cmux agent as one submitted prompt only with Automation mode (or full access) on;
   with the default mode the dial says `Turn on Automation mode in cmux.`; nothing is typed while it works, waits, holds
   a draft or a dialog, or when the text is empty or too long.
5. With cmux not installed, or no `~/.cmuxterm`, nothing is listed and no timer runs; when the folder appears, its
   agents appear with no daemon restart.
6. After #4391 is on `main`: after a daemon restart, an idle Claude Code or Codex agent listed from cmux shows its last
   recap.
7. The specs and the end to end above pass.
