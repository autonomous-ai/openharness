# The dial lists, follows, talks to and opens cmux's agents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(devices): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. No task pushes or merges.

**Goal:** With cmux on this Mac and a dial attached, each agent cmux tracks is on the dial, on cmux's page, with its live state, hook or no hook; a tap, and a rest while cmux is in front, open that agent's tab; the dial's words reach it only at an idle prompt and only with cmux's Automation mode on, else the dial says `Turn on Automation mode in cmux.`

**Architecture:**
- **One client** (`cli/src/cable/hosts/cmuxCli.ts`, new) finds cmux's own binary and runs it: `sessions list`, `socket-status`, `rpc surface.input_state`, `paste`. Its own `spawn`, no shell, no `CMUX_*` variable, bounded. It never throws or logs.
- **One source** (`cable/hosts/cmuxSource.ts`, new, id `cmux`) lists cmux's agents from `cmux sessions list --json`, run again per agent when a store file in `~/.cmuxterm` changes. Pushed by the folder watch `unixSocket.ts` already has, which now passes the changed file's name. No timer, no socket.
- **The cmux adapter** (`cable/hosts/cmuxApp.ts`, new, id `cmux`): a tap and a rest are `open -b com.cmuxterm.app cmux://workspace/<w>/surface/<s>`, through `appLink.ts` `createAppLink`; words are five checked steps ending in `cmux paste --submit -` with the text on stdin.
- **The open scan's copy** of a Claude Code or Codex session cmux lists is placed at cmux's pane through the door Orca's ring uses (`ObservedSource.setPaneNames('cmux', …, placed)`), so a tap and a rest work from the first list after a restart.
- **`HostAdapter.type` answers a `TypeResult`**, so an adapter's own refusal sentence reaches the dial through `observed.ts` `send`.
- **The hook** sends `CMUX_SURFACE_ID` and `CMUX_WORKSPACE_ID` on macOS, and `hostDetect.ts` reads them as `cmux` (`inCmux`), a new app id with a row in the firmware's name table.
- Everything is in the devices process, the hook and one firmware table row. Nothing goes through the core, and nothing is stored.

**Tech Stack:** TypeScript daemon (Node, vitest, `cli/`), the hook (`cli/hook/notify.mjs`), one C table row (`devices/harness-device/firmware`). cmux is **not installed** and is never installed: every test runs a fake `cmux` built from cmux `v0.65.2.2`'s docs and source.

**Spec:** `docs/plans/2026-11-17-dial-cmux-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md`, `cli/src/services/AGENTS.md`, and the Herdr Core adapter this is built like (`docs/plans/2026-11-16-herdr-app-design.md`, #4382).

**Open questions:** none. The draft's four were answered by the PM on 2026-11-17 ("Decided", 7 to 10).

## Base

- `feat/dial-cmux` at `0a335d6114` (`main` after #4394; `origin/main` has since moved to `3bde211303`). The spec and this plan are untracked. The main session commits them; no task does.
- **#4391 is open** (`fix/dial-recap-after-restart`, head `3e5b290ede` when this was written, `ci/required` failing). It changes `observed.ts`, `observed.spec.ts`, `hcSource.ts`, `hcClient.ts`, `devices.ts` and `devices.spec.ts`, which Tasks 5 and 9 change too, and Task 12 adds to `devices.spec.ts`. Only Task 12 waits for it. The main session integrates `main` once it merges, before Task 12 starts.
- The tasks name functions, never lines:
  - `cable/hosts/unixSocket.ts`: `watchSocket`, its `hold`.
  - `cable/hosts/hostDetect.ts`: `APP_BUNDLES`, `NAMES`, `APP_IDS`, `NEARER_HOSTS`, `inHerdr`, `detectApp`, `detectHost`.
  - `cable/hosts/adapter.ts`: `HostAdapter.type`, rule 3. `cable/hosts/types.ts`: `SendResult`, `HostSource`.
  - `cable/hosts/observed.ts`: `ObservedActions.count`, `send`, `forgetDialPrompt`, `observedAgentId`, `ObservedSource.paneOf`, `setPaneNames`, `shownOnly`. `observed.spec.ts`: `fakeActions`, `Fakes`, `counted`.
  - `cable/hosts/hcSource.ts` (the model for Task 7), `herdrApp.ts` (the model for Task 8), `herdrSource.ts`: `MAX_AGENTS`, `MAX_CWD`, `shown`. `orca.ts`: `RUN_TIMEOUT_MS`, `MAX_TEXT`, `CONTROL`, `OrcaDeps`. `open.ts`: `openPath`. `appLink.ts`: `createAppLink`, `AppLinkDeps`, `AppLink` (the model: `claudeApp.ts`, `codexApp.ts`).
  - `services/devices.ts`: `DevicesDeps`, `apps`, `openBin`, `noting`, `noteMove`, `herdrAppNoted`, `adapters`, `opener`, `voiced`, `hcSource`, `registry`, `outsideTurn`, `dialAttached`, `observed`, `placeInOrca` (the model for the place).
  - `devices.spec.ts`: `start`, `watched`, `orca`, `orcaRuns`, `readers`, and the Herdr Core describe's `onMac`, `attach`, `listed`, `said`, `host`, `brings`.
  - `hook/notify.mjs`: `HOST_HINTS`, `MAX_HINTS`, `hostHints`. `hookNotify.spec.ts`: `HINTS`, `SENT`, `panelessHints`, `noHints`, `runHook`, `collect`.
  - `cli/e2e`: `IsolatedDaemon` (`opens`, `log`, `env`, `root`), `Desk`, `FakeBackend`, `Outside`, `until`, and `deviceHerdrApp.e2e.ts`'s `rosters`, `showing`, `rowOf`, `said`, `speak`, `fresh`.
- If a name differs at the base, the implementer follows the code and says so in its report.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The fake cmux and the cmux client | `cli/src/testing/fakeCmux.ts` (new), `cli/src/cable/hosts/cmuxCli.ts` (new), `cmuxCli.spec.ts` (new) | none | xhigh | `cmuxCli.spec.ts` |
| 2 The watch tells the changed file's name | `cli/src/cable/hosts/unixSocket.ts`, `unixSocket.spec.ts` | none | medium | `unixSocket.spec.ts` |
| 3 cmux has an id, a name, a bundle and a row on the dial | `cli/src/cable/hosts/hostDetect.ts`, `hostDetect.spec.ts`, `frontApp.spec.ts`, `scannedApp.spec.ts`, `cli/src/cable/cableHost.spec.ts`, `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c`, `devices/harness-device/firmware/test/test_touch_ui.py` | none | high | `hostDetect.spec.ts`, `frontApp.spec.ts`, `scannedApp.spec.ts`, `test_touch_ui.py` |
| 4 A cmux terminal is cmux, not Ghostty | `cli/src/cable/hosts/hostDetect.ts`, `hostDetect.spec.ts` | 1, 3 | high | `hostDetect.spec.ts` |
| 5 What the dial says when typing is refused | `cli/src/cable/hosts/types.ts`, `adapter.ts`, `observed.ts`, `observed.spec.ts`, `cli/src/services/devices.ts` | none | high | `observed.spec.ts` |
| 6 The hook sends cmux's ids, on macOS | `cli/hook/notify.mjs`, `cli/src/hookNotify.spec.ts` | none | high | `hookNotify.spec.ts` |
| 7 The cmux source | `cli/src/cable/hosts/cmuxSource.ts` (new), `cmuxSource.spec.ts` (new) | 1 | xhigh | `cmuxSource.spec.ts` |
| 8 The cmux adapter | `cli/src/cable/hosts/cmuxApp.ts` (new), `cmuxApp.spec.ts` (new) | 1, 4, 5 | xhigh | `cmuxApp.spec.ts` |
| 9 The devices run the cmux source | `cli/src/services/devices.ts`, `devices.spec.ts` | 2, 7, 8 | xhigh | `devices.spec.ts` |
| 10 End to end, a fake cmux | `cli/e2e/deviceCmux.e2e.ts` (new), `cli/src/testing/fakeCmux.ts` | 6, 9 | high | none: no behavior (the end-to-end test of Tasks 1 to 9), one commit |
| 11 Say it in the docs | `cli/AGENTS.md`, `docs/specs/2026-11-15-device-host-adapter.md` | none | medium | none: docs only, one commit |
| 12 The recap after a restart, held by #4391's path | `cli/src/services/devices.spec.ts`, `cli/e2e/deviceCmux.e2e.ts` | 9, 10, and **#4391 merged to `main`** (external) | high | none: two tests of behavior #4391 and Task 9 already give, one commit |

Longest chain: 1 → 4 → 8 → 9 → 10 → 12: six tasks, five without Task 12.

- Tasks 1, 2, 3, 5, 6 and 11 share no file and start at once. Tasks 7 and 8 share no file and run beside each other.
- Shared files, each pair ordered by a dependency above:
  - `hostDetect.ts`, `hostDetect.spec.ts`: Tasks 3 and 4.
  - `devices.ts`: Tasks 5 and 9. `devices.spec.ts`: Tasks 9 and 12.
  - `fakeCmux.ts`: Tasks 1 and 10. `deviceCmux.e2e.ts`: Tasks 10 and 12.
- **Only Task 12 waits for #4391.** When Tasks 1 to 11 are done and #4391 is still open, the orchestrator decides whether the pull request goes without Task 12; done-when 6 then stays open (spec, decision 5).

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/hosts/cmuxCli.ts`, `cmuxSource.ts`, `cmuxApp.ts`, `unixSocket.ts`, `hostDetect.ts`, `adapter.ts`, `types.ts`, `observed.ts` | **Devices service process**, and only there | Their specs (PR CI `cli-tests`, Linux) |
| `cli/src/services/devices.ts` | **Devices service process** | 100% per file (`npm run test:core`, local) |
| `cli/hook/notify.mjs` | The hook: one file that ships alone, run by the agent | `src/hookNotify.spec.ts`; its macOS tests run only on a Mac |
| `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` | **Firmware**, the round dial; not flashed, no release | `test_touch_ui.py` (PR CI `firmware-checks`) |
| `cli/src/testing/fakeCmux.ts` | Test: a fake `cmux` program in a temp folder | none |
| `cli/e2e/deviceCmux.e2e.ts` | Test: the real daemon, a fake dial, the fake cmux, the fake `open` | Verification 1, locally on this Mac |
| The docs of Task 11 | Repo files, no process | Review |

Not changed, and a diff in any is a finding:
- anything under `cli/src/core/`, `cli/src/architecture.coreFiles.txt`, `cli/vitest.setup.ts`;
- `cable/hosts/open.ts`, `registry.ts`, `select.ts` (`APP_LIMIT` stays 16), `frontApp.ts`, `scannedApp.ts`, `appLink.ts`, `hcSource.ts`, `herdrSource.ts`, `herdrApp.ts`;
- `cable/cableHost.ts`, `cableSession.ts`, `cli/e2e/harness/daemon.ts`;
- the firmware's `cable_client.h` (`CABLE_MAX_APPS` stays 16) and `version.txt`.

## Global Constraints

- **Never the person's cmux.** cmux is not installed on this Mac and no task installs or starts it. No task, spec or check reads `~/.cmuxterm`, cmux's settings (`defaults` domain `com.cmuxterm.app`) or `/Applications/cmux.app`, and none runs a `cmux` that is not the test's own fake. cmux's settings are never changed by anything.
- **The binary.** `cmux` on `PATH` only when its real path ends in `/cmux.app/Contents/Resources/bin/cmux`; else `/Applications/cmux.app/Contents/Resources/bin/cmux` when it exists; else cmux is not installed and nothing runs. The release app only. macOS only.
- **A run.** `spawn`, no shell, each value one argument, stdin written and closed (empty when there is none), 10 s (`RUN_TIMEOUT_MS`), stdout read up to 8 MiB, past which the run is killed and answers `too-big`. Its environment is the devices process's own **with no `CMUX_*` variable**. `core/agentSessionEnv.ts` is not changed.
- **Forms**, checked before a value is an argument, a link or a key:
  - a surface or a workspace: `/^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/`;
  - cmux's word for an agent, and `--agent`'s value: `/^[a-z][a-z0-9-]{0,31}$/`;
  - a store file: `<word>-hook-sessions.json`;
  - a session id: `/^[A-Za-z0-9._:-]{1,128}$/` (a record with another is listed without one);
  - `cwd` cut to 4096 characters; a name cut to 64, control characters removed (`shown`).
- **Kinds.** `claude`, `codex`, `cursor`, `opencode`, `pi`, `omp`, `muse`, `amp`, `grok`, `copilot` as themselves; `hermes-agent` → `hermes`; `antigravity` → `agy`. Another word keeps its own when it fits the word's form; else the record is not listed.
- **Listed.** A record with `active_for_surface: true`, a surface and a workspace in their form, a positive integer `pid` that is alive (`process.kill(pid, 0)` succeeds or fails with `EPERM`), and a kind. One row per surface: the newest `updated_at_unix` wins. At most 64 listed.
- **Row.** A `uuid()` id, pane key `cmux:<surface, lower case>`, host and app `cmux`, the engine from the kind, the session id, `callerPid` from `pid`, the folder's name from `cwd` else the kind, and `cwd`. `transcript_path`, launch commands and environments are never kept.
- **States.** `running` → working; `needsInput` → needs-you; `idle` and `unknown` → idle. A turn that leaves `running` or `needsInput` for `idle` is done with `unseenDone` false.
- **Reads.** At start one `sessions list --json --all`. On a change of `<word>-hook-sessions.json` in `~/.cmuxterm`, one `sessions list --json --agent <word> --all`, whose rows replace that agent's. A change with no file name runs all. Per agent one run at a time; changes during a run give one more after it. A run that ends after `stop()` is dropped. **No timer, no poll, no `cmux events`.**
- **Words.** A blank text or one over `MAX_TEXT` (2,000) is not sent; control characters become spaces; one prompt per surface at a time. Then, in order: `cmux socket-status --json` (`effective_mode` must be `automation` or `allowAll`); `cmux --json rpc surface.input_state {"surface_id":"<surface>"}` (`terminal: true`, `agent: true`, `lifecycle: "idle"`, `state: "empty"`, `blocks_typing: false`); the source's kind at that surface, when it has one, is the caller's; `cmux --json paste --workspace <w> --surface <s> --submit -` with the text on stdin, sent only on exit 0 and `submitted: true`. **Never `--force`. The text is never an argument. Nothing is sent twice.** `password` mode is not supported.
- **Tap and rest.** `open -b com.cmuxterm.app cmux://workspace/<workspace>/surface/<surface>` through `appLink.ts` `createAppLink` with `bundle: 'com.cmuxterm.app'` (so `openPath`, and `HARNESS_OPEN_BIN` in tests), the pane id checked again first, 10 s. A second rest of that agent while one runs is `busy`. No `cmux focus-panel`.
- **The scan's copy.** An agent of the open scan with no cmux pane of its own, whose engine and session id a cmux row names, is placed at that row's pane (`setPaneNames('cmux', new Map(), placed)`): a tap and a rest show it there; a place never takes words.
- **The dial's sentences:** `Turn on Automation mode in cmux.`; `<name> is busy. Say it when it is done.`; `<name> is waiting for your answer in cmux.`; `Too long. Say it shorter.`; `<name> did not answer.` A waiting agent's line is `Waiting for you · cmux`.
- **Log lines**, fixed words and counts only, no id, folder, name or words: `[cmux] listed · <n> agents`, `[cmux] list · failed|too-big`, `[cmux] over · <n> left out`, `[cmux] watch · none|on`, `[cmux] read · <agent word or all> · <ms>`.
- **Counters.** `[device] voice · cmux` when sent; `busy`, `waiting`, `too-long`, `no-answer`, `refused (cmux)` when refused.
- **The app.** Id `cmux`, name `cmux`, bundle `com.cmuxterm.app`, after `ghostty` in `NAMES`, so `APP_IDS` has 18 and `codex` stays right after `claude`. cmux NIGHTLY (`com.cmuxterm.app.nightly`) names nothing.
- **The hints.** `CMUX_SURFACE_ID` and `CMUX_WORKSPACE_ID` join `HOST_HINTS` after `HC_TERMINAL_ID`, on macOS only, and count toward `MAX_HINTS` (10). No other `CMUX_*` name is ever sent.
- **The kill switch.** `HARNESS_DEVICE_OBSERVED=off` stops the cmux source too. It runs only while a dial is attached, on macOS, with cmux found.
- **Platforms.** macOS only. Linux and Windows: no change; the hook sends no CMUX hint there.
- **Repo rules.** Test first, at the layer where the behavior lives. No fixed sleeps. Every list and fan-out bounded. Comments say why. No promise of the client or the source rejects. Specs that run a script are `describe.skipIf(process.platform === 'win32')`. `src/services` stays at 100% per file.

## Review Focus

1. **A Claude Code or Codex session in cmux that the open scan lists before any hook of it** (each daemon restart, for every agent sitting idle). The scan's copy has no cmux pane, and it wins the fold over cmux's row by its session id (`registry.ts`: observed before a listing source). A person expects a tap to open its tab at once: Task 9 places it at cmux's pane (decided 7), and its three tests hold the tap, the rest, no words through the place, and the place going. Its state and words stay the scan's until its first hook, by the door's own rule.
2. **cmux writes a store on every hook.** A working agent's hooks are several writes a second, each maybe a temp file renamed over the store. A person expects one `cmux` process after another, never a pile, and no process for a file that is no store. Task 7, `ten changes during one run give one more run, not ten`, and `a name that is no store's runs nothing`.
3. **The person turns Automation mode on and speaks again at once.** `socket-status` reads the saved setting (`live_enforcement: "not_observed"`), so the running app may still refuse. The dial then says `<name> did not answer.`, not the Automation sentence again, and nothing is pasted. Task 8, `the mode reads automation and the socket still refuses: no-answer, and no paste runs`.
4. **cmux itself refuses the paste** after the idle read: the person typed a draft meanwhile (its Draft guard), or the tab was moved to another workspace and the id from the hook's environment is stale. One paste runs, it is never run again, and never with `--force`. Task 8, `a paste cmux refuses after an idle read is no-answer: one paste, none forced`.
5. **The hook's id and the store's id differ only in case** (cmux prints UUIDs in upper case; a store or a link may hold lower). The hooked copy and cmux's row must still be one agent, and the kind check must still find the row. Task 7, `kindAt answers whatever the case of the id`; Task 8, `paneKey is cmux:<surface> in lower case`; Task 9, the fold test's two ids differ in case.

## Decided (PM for Diego, 2026-11-17)

The spec's "Decided" section holds each: (1) the list and state from `cmux sessions list --json`, re-run per agent on `~/.cmuxterm` changes through `watchSocket`, no `cmux events`; (2) words only with `automation` or `allowAll`, an idle empty prompt and the same kind, through `cmux paste --workspace --surface --submit -` on stdin, never `--force`, else `Turn on Automation mode in cmux.` through a new `TypeResult`; `password` mode unsupported; cmux's settings never changed; (3) a tap and a rest are the `cmux://` link through `appLink.ts` `createAppLink` with `bundle: 'com.cmuxterm.app'` (`open -b com.cmuxterm.app cmux://workspace/<w>/surface/<s>`, through `openPath`), a second rest while one runs is `busy`, no `focus-panel`; (4) a new app id `cmux` and a firmware name row, no firmware release; the hook sends the two ids on macOS only; (5) the recap waits for #4391 and nothing else does; (6) tests use a fake `cmux`, and the e2e puts it in a `cmux.app/Contents/Resources/bin` folder on `PATH` with the fake `open`.

Answered on the draft's open questions (PM, 2026-11-17):
7. **The scan's copy is placed.** In Task 9, `devices.ts` places the open scan's copy of a Claude Code or Codex session that runs in cmux through the door Orca's ring already uses (`ObservedSource.setPaneNames('cmux', …, placed)`), so a tap and a rest work from the first list after a restart. Three tests. No dependency on #4391.
8. **The recap is #4391's.** Task 12 is two tests that hold done-when 6 through #4391's own path: no recap read in the cmux source. It still waits for #4391 on `main`.
9. **The link goes through `appLink.ts`** (3 above): Task 8's verbs come from `createAppLink`; Tasks 9 and 10 expect `open -b com.cmuxterm.app cmux://…`.
10. **No temporary workflow.** The e2e runs locally on this Mac, isolated. A permanent macOS e2e job is a proposal for the final report.

## Decided here, where the spec was silent

- **The forms live in `cmuxCli.ts`** (`CMUX_ID`, the pane's id, the pane key, the refusal sentence), as `HC_TERMINAL` lives in `hcClient.ts`. `hostDetect.ts` imports `CMUX_ID`, so Task 4 waits for Task 1; the app's id and name (Task 3) do not.
- **The client is inert off macOS** (`binary()` is none), so a `cmux` on a Linux `PATH` never runs. The devices hand it their own platform.
- **The client checks, the source decides.** `sessions()` tells only records that are active for their surface and whose ids, pid and word are in form. Whether the pid is alive, which record a surface shows and what is listed are the source's.
- **`binary()` is asked at each run and at each attach.** The adapter's `canFocus` and `canType` read what the last attach found (`found`), as herdr's is read at each attach.
- **The source asks whether `~/.cmuxterm` is there** (`folder()`), since `watchSocket` holds the parent while it is not and tells every change of the home folder. With no folder **no run starts** (so a daemon under test, whose home has none, never runs an installed cmux). The folder appearing runs all agents once; the folder going drops every row with no run. `[cmux] watch · none|on` is said when that changes, and kept across a detach.
- **A name that is no store's runs nothing** (`.DS_Store`, a temp file).
- **A row is one agent while its surface, kind and pid stay the same.** Its session id may change (Claude Code's `/clear`). Another pid or kind at that surface is another agent: a new row and id, whose first state ends no turn.
- **`agent_lifecycle` that is null or another word reads `unknown`.**
- **A result never replaces rows read by a run that started after it.** An all-agents run that ends after an agent's later run leaves that agent's rows.
- **At most 32 runs at a time** (cmux `v0.65.2.2` has 20 agents). A change that would start a 33rd waits as one all-agents run.
- **Every listable row is kept, 1,024 at most, and the first 64 are listed**, so when one leaves the next is listed with no run. `over` counts the rows kept past 64, those past 1,024, and `total_matches` above what a run printed. It is said when its number changes.
- **A run with no answer keeps that agent's rows.** `[cmux] list · failed|too-big` is said once per agent word until a run of it succeeds. The client's `failed`, `timeout` and `no-binary` all say `failed`, and so does bad JSON: the spec has those two words alone.
- **`[cmux] read · <word|all> · <ms>` is said for a word's first run after a start, then only for a run slower than every one said before it.** The spec says "each run's time"; one line per hook of a working agent would be thousands of lines a day, and the slowest is the number its target needs.
- **A prompt's blank or over-long text is `no-answer`,** and so is a `socket-status` run that fails: the mode is not known, so the dial does not say to turn it on.
- **`cmux rpc` gets `--json` before it,** as the spec writes it; it prints JSON either way (`CLI/cmux.swift`, `case "rpc"`).
- **`countWord` in `observed.ts`** turns a count into its log word (`mod`, an adapter's id, `refused (<id>)`). `devices.ts` calls it where it mapped the others, so Task 5 adds no branch to a file held at 100%.
- **`open.ts` `bundleOf` is not changed.** A cmux terminal carries cmux's own bundle id.
- **The source tells a row's pane** (`CmuxSource.paneAt`), since a row carries only the surface (`cmux:<surface>`) and the link needs the workspace too: decided 7 reads it in `devices.ts`. It is Task 7's, beside `kindAt`.
- **`canFocus` is `createAppLink`'s** (macOS), not "cmux is found": a cmux pane exists only from a cmux terminal or a cmux row, and a link no app takes answers false to the opener's fallback.
- **The e2e also runs a hooked agent in cmux** (done-when 2), which the spec's list does not name: it is the one place the real hook, the core's route, `inCmux` and the adapter meet.
- **The e2e asserts no time.** It prints the time from the store's write to the dial's row and the log's `read` line, and the tester reports them against done-when 1's second (Verification 1).
- **No default fake in `e2e/harness/daemon.ts`.** With no folder no run starts (above), so other e2e files run no `cmux` even on a Mac that has one.

## What Task 1 settles

The planner read these in cmux `v0.65.2.2` (`gh api repos/manaflow-ai/cmux/contents/<path>?ref=v0.65.2.2 -H "Accept: application/vnd.github.raw"`; nothing installed). Task 1 reads the two marked **check** the same way, and its report ends `assumptions: all hold`, or the ones that do not.

| | The fake and the client assume | Read in | If it is otherwise |
|---|---|---|---|
| A1 | `sessions [list] [--agent <name>] [--all] [--json]`; top level `{state_dir, default_codex_home, limit, total_matches, stores, sessions}`; a record has `agent`, `session_id`, `workspace_id`, `surface_id`, `cwd`, `transcript_path`, `pid`, `agent_lifecycle`, `active_for_surface`, `updated_at_unix`, `launch_arguments`; newest first, 100 unless `--all`; the state folder is `CMUX_AGENT_HOOK_STATE_DIR`, else `$HOME/.cmuxterm` | `CLI/CMUXCLI+SessionsList.swift` | held |
| A2 | `socket-status --json` prints `effective_mode`, `configured_mode`, `live_enforcement: "not_observed"`, and never connects; `CMUX_BUNDLE_ID` moves the domain it reads | `CLI/CMUXCLI+SocketControlStatus.swift` | held |
| A3 | `rpc <method> [json-params]` prints the method's result at the top level; `surface.input_state` answers `terminal`, `agent`, `lifecycle`, `state`, `blocks_typing` | `CLI/cmux.swift` (`case "rpc"`), `docs/cli-contract.md` (Draft Guard) | held |
| A4 | `paste --workspace --surface --submit -` reads the text from stdin; with `--json` it prints `terminal.paste`'s payload at the top level, `submitted` in it; `--force` skips its Draft guard | `CLI/CMUXCLI+Paste.swift`, `CLI/cmux.swift` (`printV2Payload`) | held |
| A5 | Every agent's store file is `<its name>-hook-sessions.json`, and `--agent` takes that name | `CLI/CMUXCLI+AgentHookCatalog.swift` | held |
| A6 | The modes' words are exactly `off`, `cmuxOnly`, `automation`, `password`, `allowAll` | **check:** the socket control mode's enum (found from `SocketControlPolicyResolver`) | **Stop and report**: the words gate depends on two of them |
| A7 | A socket that refuses makes `rpc` and `paste` exit non-zero | **check:** `CLI/SocketClient+V2.swift`, `CLI/CLIError.swift` | The fake follows the source, and the report says so; the client's rule (anything but exit 0 and the right JSON is no answer) holds either way |

---

### Task 1: The fake cmux and the cmux client

**Layer:** test fixture, and the devices service process. **Depends on:** none. **Effort:** `xhigh` (the one place a hook's id and the dial's words reach another program's command line; a child process with a deadline and a bound).

**Red test:** `cli/src/cable/hosts/cmuxCli.spec.ts`.

**Files:**
- Create: `cli/src/testing/fakeCmux.ts`, `cli/src/cable/hosts/cmuxCli.ts`
- Test: `cli/src/cable/hosts/cmuxCli.spec.ts` (new)

**Interfaces:**
- Produces, in `cli/src/testing/fakeCmux.ts`:
  ```ts
  /** The cmux release the fake answers as; its header names each upstream file a field comes from (A1 to A7). */
  export const CMUX_TAG = 'v0.65.2.2'
  /** One record of `sessions list`, by cmux's own field names. Unset: active for its surface, `idle`, cwd `/work/api`,
   *  `updated_at_unix` its place in the list. Every record also prints a `transcript_path` and `launch_arguments`. */
  export interface FakeCmuxSession {
    agent: string; surface_id: string; workspace_id: string; pid: number | null
    session_id?: string; cwd?: string | null; agent_lifecycle?: string | null
    active_for_surface?: boolean; updated_at_unix?: number; more?: Record<string, unknown>
  }
  export type FakeCmuxCommand = 'sessions' | 'socket-status' | 'rpc' | 'paste'
  /** A command that misbehaves: exits so and prints nothing, prints these bytes, prints that many bytes, or never answers. */
  export type FakeCmuxFault = { exit: number } | { raw: string } | { flood: number } | 'hold'
  export interface FakeCmuxState {
    sessions?: FakeCmuxSession[]
    /** More than were printed, to say some were left out. */
    totalMatches?: number
    /** `effective_mode`; `cmuxOnly` when unset, as cmux's default. */
    mode?: string
    /** `surface.input_state` by surface id; unset: a terminal with an idle agent at an empty prompt. */
    input?: Record<string, { terminal?: boolean; agent?: boolean; lifecycle?: string; state?: string; blocks_typing?: boolean }>
    /** `terminal.paste`'s `submitted`; true when unset. */
    submitted?: boolean
    fail?: Partial<Record<FakeCmuxCommand, FakeCmuxFault>>
  }
  /** One run: its arguments, its stdin read to the end, and the names of its own variables that start `CMUX_`. */
  export interface FakeCmuxCall { args: string[]; stdin: string; env: string[] }
  export interface FakeCmux {
    /** `<root>/cmux.app/Contents/Resources/bin/cmux`. */
    readonly binary: string
    /** A folder that holds one link named `cmux` to it: what a PATH gets. */
    readonly dir: string
    /** Written beside and renamed over, so a run never reads half. */
    set(state: FakeCmuxState): void
    calls(): FakeCmuxCall[]
    remove(): void
  }
  /** In `root`, else a fresh temp folder. */
  export function fakeCmux(root?: string): FakeCmux
  /** Writes `<home>/.cmuxterm/<word>-hook-sessions.json`, making the folder: what a hook of cmux's does to its store. */
  export function touchStore(home: string, word: string): void
  ```
  - `bin/cmux` is a `sh` script that `exec`s the test's own Node (`process.execPath`) on a `.mjs` beside it. It records the call before it answers.
  - It answers `sessions list --json [--agent <w>] [--all]` (A1: filtered, newest first, cut at 100 without `--all`), `socket-status --json` (A2), `[--json] rpc surface.input_state <json>` (A3) and `[--json] paste --workspace <w> --surface <s> --submit -` (A4). Anything else exits 64.
  - As the real one: `rpc` and `paste` exit non-zero and print nothing unless the mode is `automation` or `allowAll` (A7); `paste` exits non-zero when that surface's input holds a draft or a dialog and no `--force` is among its arguments.
- Produces, in `cli/src/cable/hosts/cmuxCli.ts`:
  ```ts
  export const CMUX_ID = /^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/
  export const CMUX_WORD = /^[a-z][a-z0-9-]{0,31}$/
  /** A store file's name; group 1 is cmux's word for its agent. */
  export const CMUX_STORE = /^([a-z][a-z0-9-]{0,31})-hook-sessions\.json$/
  export const CMUX_APP_BINARY = '/Applications/cmux.app/Contents/Resources/bin/cmux'
  export const CMUX_AUTOMATION_OFF = 'Turn on Automation mode in cmux.'
  export const cmuxStoreDir = (home: string): string => join(home, '.cmuxterm')
  /** The key a hooked copy and a listed copy of one agent share (registry.ts). */
  export const cmuxPaneKey = (surface: string): string => `cmux:${surface.toLowerCase()}`
  export const cmuxPaneId = (workspace: string, surface: string): string => `${workspace}/${surface}`
  /** A pane id's two ids, each in its form; else none. */
  export function cmuxPaneOf(id: string): { workspace: string; surface: string } | undefined
  /** cmux's word as an engine's kind: the table, else its own word when it fits CMUX_WORD. */
  export function cmuxKind(word: unknown): string | undefined

  export type CmuxLifecycle = 'running' | 'idle' | 'needsInput' | 'unknown'
  export interface CmuxSession {
    word: string; kind: string; surface: string; workspace: string; pid: number
    lifecycle: CmuxLifecycle; updatedAt: number; sessionId?: string; cwd?: string
  }
  export type CmuxFault = 'no-binary' | 'failed' | 'timeout' | 'too-big'
  /** `unread`: how many records cmux matched and did not print. */
  export type CmuxSessions = { ok: true; sessions: CmuxSession[]; unread: number } | { ok: false; fault: CmuxFault }
  export interface CmuxInputState {
    terminal: boolean; agent: boolean; lifecycle: CmuxLifecycle
    state: 'empty' | 'draft' | 'dialog' | 'unknown'; blocksTyping: boolean
  }
  export type CmuxPrompt = 'sent' | 'busy' | 'waiting' | 'automation-off' | 'no-answer'
  export interface CmuxClient {
    /** cmux's own binary by its real path; none when cmux is not installed, and off macOS. */
    binary(): string | null
    /** Every agent's records, or one agent's by cmux's word: only those active for their surface, each value in form. */
    sessions(word?: string): Promise<CmuxSessions>
    /** `effective_mode`; none when it could not be read. */
    mode(): Promise<string | undefined>
    inputState(surface: string): Promise<CmuxInputState | undefined>
    /** True only when cmux pasted and submitted. Runs once. */
    paste(workspace: string, surface: string, text: string): Promise<boolean>
  }
  export interface CmuxClientDeps {
    /** The devices process's own environment, with no CMUX_* variable. */
    env: NodeJS.ProcessEnv
    home: string
    platform: NodeJS.Platform
    onPath(name: string): string | null
    /** None when it cannot be resolved. */
    realpath(path: string): string | null
    exists(path: string): boolean
    /** A timer; its cancel is returned. */
    after(ms: number, run: () => void): () => void
  }
  export function cmuxClientDeps(): CmuxClientDeps
  export function createCmuxClient(deps: CmuxClientDeps): CmuxClient
  ```
  - The arguments, exactly: `['sessions','list','--json','--all']`; `['sessions','list','--json','--agent',word,'--all']`; `['socket-status','--json']`; `['--json','rpc','surface.input_state',JSON.stringify({ surface_id })]`; `['--json','paste','--workspace',workspace,'--surface',surface,'--submit','-']`.
  - A deadline answers by itself and kills the child (`SIGKILL`), as `orca.ts` `run` does. The child's stderr is not read.

- [ ] **Step 1: Read A6 and A7** in cmux at the tag, as "What Task 1 settles" says. A6 otherwise: stop and report.
- [ ] **Step 2: Write `fakeCmux.ts`** as "Interfaces" says.
- [ ] **Step 3: Write the failing tests** in `cmuxCli.spec.ts`, `describe.skipIf(process.platform === 'win32')`, each on a fake cmux of its own, `platform: 'darwin'`, and an `after` the test fires by hand. `S` and `W` are two UUIDs in upper case.
  - The binary:
    - `a cmux on PATH whose real path ends in /cmux.app/Contents/Resources/bin/cmux is the binary, by its real path`.
    - `another program called cmux is not: a plain file, and one in xcmux.app; then the app's own binary when it exists, else none`.
    - `off macOS there is none, whatever is on PATH`; `with no binary every call answers its failure and nothing is spawned` (`no-binary`, `undefined`, `false`).
  - `cmuxKind keeps the ten, maps hermes-agent and antigravity, keeps gemini, and refuses a word out of form` (`'Gemini'`, `'a b'`, 33 characters, `7`).
  - `cmuxPaneOf takes <workspace>/<surface>, and refuses any other` (`S` alone, `W/--help`, three parts, lower case passes).
  - Sessions:
    - `sessions() is one run of sessions list --json --all, with an empty stdin`: the call's `args`, `stdin: ''`.
    - `sessions('claude') adds --agent claude; a word out of form ('--help', 'Claude Code') runs nothing and is failed`.
    - `it tells only records active for their surface, in form`: one good record beside one with `active_for_surface: false`, a surface `--help`, a workspace of 35 characters, `pid` `null`, `0` and `1.5`, and `agent: 'Bad Word'`. One session comes back.
    - `a session id out of form, a null cwd and a null lifecycle list the record without them, as unknown; a cwd is cut at 4096`.
    - `nothing of transcript_path or launch_arguments is in the answer`: `JSON.stringify(answer)` matches neither.
    - `total_matches above what was printed is unread`.
    - `exit 1 and bytes that are no JSON are failed; one byte past 8 MiB is too-big and the child is killed; no answer by the deadline is timeout and the child is killed`. The deadline is `RUN_TIMEOUT_MS`.
    - `a binary that cannot be executed is failed, and nothing rejects`.
  - `a run's environment has no CMUX_* variable`: with `CMUX_SOCKET_PATH`, `CMUX_AGENT_HOOK_STATE_DIR`, `CMUX_BUNDLE_ID` and `CMUX_SURFACE_ID` stubbed, `cmuxClientDeps().env` holds none, and the fake's call records `env: []`.
  - `mode() tells effective_mode; a failed run, bytes that are no JSON, or a value that is no word, is none`.
  - `inputState() is one rpc with the surface id as JSON, and tells the five fields; a surface out of form runs nothing; a refused socket, or a field of another type, is none`.
  - `paste() puts the text on stdin and in no argument, with --workspace, --surface, --submit and -; true only on exit 0 and submitted: true`: `submitted: false`, exit 1, a timeout and an id out of form are `false`; one call each at most; no call's `args` holds `--force`.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/hosts/cmuxCli.spec.ts`. Expected: FAIL (`cmuxCli.js` is missing).
- [ ] **Step 5: Implement `cmuxCli.ts`.** Its header says why it has runs of its own (`orca.ts`'s run has no stdin, and its 1 MiB buffer reads as a timeout) and why no `CMUX_*` goes out (a daemon started from a cmux terminal carries them; `socket-status` and `sessions list` would follow them to another mode and another store folder).
- [ ] **Step 6: Run** the step 4 command, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 7: Commit** `devices: a client for cmux's own command line, and a fake cmux from v0.65.2.2`. The red commit holds `fakeCmux.ts` and the spec.

### Task 2: The watch tells the changed file's name

**Layer:** devices service process. **Depends on:** none. **Effort:** `medium`.

**Red test:** `cli/src/cable/hosts/unixSocket.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/unixSocket.ts`
- Test: `cli/src/cable/hosts/unixSocket.spec.ts`

**Interfaces:**
- Produces: `watchSocket(where: { socketPath: string; home: string }, changed: (file?: string) => void): () => void`. `file` is the name `fs.watch` gave for the folder it holds; none when the OS gave none. Nothing else changes: the folders, the move to a nearer one, the move out of one removed. herdr's and hc's callers pass a `changed` that takes nothing, and are not edited.

- [ ] **Step 1: Write the failing tests** in the watch's own describe, each waiting on a promise the callback resolves:
  - `it tells the name of the file that changed in the folder it holds`: a file `claude-hook-sessions.json` written beside the socket's place tells that name.
  - `from the parent it tells the name of what changed there`: with the socket's folder not made, making it tells the folder's own name.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/unixSocket.spec.ts`. Expected: FAIL (the callback gets nothing).
- [ ] **Step 3: Implement.** The doc comment says who reads the name (cmux's stores, `cmuxSource.ts`).
- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/unixSocket.spec.ts src/cable/hosts/herdrSource.spec.ts src/cable/hosts/hcSource.spec.ts src/cable/hosts/socketAttempts.spec.ts && npm run typecheck`. Expected: PASS, the last three unedited.
- [ ] **Step 5: Commit** `devices: the folder watch tells which file changed`.

### Task 3: cmux has an id, a name, a bundle and a row on the dial

**Layer:** devices service process, and the firmware's name table. **Depends on:** none. **Effort:** `high` (two components; the firmware's test holds the two tables equal, so they change in one commit).

**Red tests:** `hostDetect.spec.ts`, `frontApp.spec.ts`, `scannedApp.spec.ts`, `test_touch_ui.py`.

**Files:**
- Modify: `cli/src/cable/hosts/hostDetect.ts`, `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` (`host_name`'s table)
- Test: `cli/src/cable/hosts/hostDetect.spec.ts`, `frontApp.spec.ts`, `scannedApp.spec.ts`, `cli/src/cable/cableHost.spec.ts`, `devices/harness-device/firmware/test/test_touch_ui.py`

**Interfaces:**
- Produces:
  - `APP_BUNDLES.cmux === 'com.cmuxterm.app'`; `NAMES.cmux === 'cmux'`, right after `ghostty`. `APP_IDS` has 18 ids.
  - Through the tables, with no new code: `detectApp` and `frontAppId` give `cmux` for the bundle; `open.ts` brings it by `open -b com.cmuxterm.app` on a pick; the scan learns it from a session's parents.
  - The firmware's `host_name("cmux")` is `"cmux"`.
  - `detectHost` does not change here (Task 4).

- [ ] **Step 1: Write the tests.**
  - `hostDetect.spec.ts`:
    - `cmux's bundle id is the app cmux, read cmux`: `detectApp({ __CFBundleIdentifier: 'com.cmuxterm.app' })` is `'cmux'`; `hostDisplayName('cmux')` and `appDisplayName('cmux')` are `'cmux'`.
    - `cmux NIGHTLY names nothing` (a pin): `com.cmuxterm.app.nightly` gives `UNKNOWN_APP`.
    - The count test reads `APP_IDS has 18 ids, and every one has a display name`; `codex` is still right after `claude`, and `cmux` right after `ghostty`. In `the unknown app reads Other, …`, `others` has 16.
  - `frontApp.spec.ts`: `BUNDLES` gains `['com.cmuxterm.app', 'cmux']`. The values that are none gain `'com.cmuxterm.app.nightly'` and `'cmux'` (no exe row: cmux is macOS's).
  - `scannedApp.spec.ts`, in `scannedApps on macOS`: `a session under cmux is in cmux`: rows `[500, 499, '/bin/zsh']` and `[499, 1, '/Applications/cmux.app/Contents/MacOS/cmux']`, bundles `{ '/Applications/cmux.app': 'com.cmuxterm.app' }`, answer `new Map([[500, 'cmux']])`.
  - `cableHost.spec.ts`: `17 apps with agents send 16 rows, the shown one kept` reads `18 apps …`. Where it named `APP_IDS[16]` it names the last id (`APP_IDS.at(-1)`, the unknown app), so the row that takes the 16th place is still `Other`. Nothing else in it changes.
  - `test_touch_ui.py`: the `named` table of "See it in" hints gains `{"cmux","See it in cmux"}`.
- [ ] **Step 2: Run.**
  - `cd cli && npx vitest run src/cable/hosts/hostDetect.spec.ts src/cable/hosts/frontApp.spec.ts src/cable/hosts/scannedApp.spec.ts src/cable/cableHost.spec.ts`. Expected: FAIL in the tests that name `cmux` and the count; the pin passes.
  - From the repository root: `python3 devices/harness-device/firmware/test/test_touch_ui.py`. Expected: FAIL (the dial says "See it in Terminal").
- [ ] **Step 3: Implement.** `hostDetect.ts`: the two rows. `APP_IDS`'s comment says eighteen ids; the firmware holds 16 and the `apps` frame holds to it. `ui_habitat.c`: `{"cmux", "cmux"}` after `{"ghostty", "Ghostty"}`. Nothing else in the firmware.
- [ ] **Step 4: Run** both commands of step 2, then `cd cli && npx vitest run src/cable src/services/devicesListener.spec.ts src/services/devices.spec.ts && npm run typecheck`. Expected: PASS. A spec outside this task's files that counted 17 ids is a finding: stop and report it.
- [ ] **Step 5: Commit** `dial: cmux has an id, a name and a row on the dial's name table`.

### Task 4: A cmux terminal is cmux, not Ghostty

**Layer:** devices service process. **Depends on:** 1 (`CMUX_ID`), 3 (the same two files). **Effort:** `high` (outside text decides the page an agent is on, and which adapter may type into its terminal).

**Red test:** `cli/src/cable/hosts/hostDetect.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/hostDetect.ts`
- Test: `cli/src/cable/hosts/hostDetect.spec.ts`

**Interfaces:**
- Consumes: `CMUX_ID` (`cmuxCli.ts`).
- Produces, in `hostDetect.ts`:
  ```ts
  /** The agent runs in cmux's own terminal. Every program started there inherits cmux's variables (`code .`, WezTerm,
   *  kitty, tmux), so only with both ids in form, cmux's own TERM_PROGRAM (`ghostty`) or none, and no nearer or other
   *  app's variable. */
  export function inCmux(hints: Readonly<Record<string, string>>): boolean
  ```
  - True only when `CMUX_SURFACE_ID` and `CMUX_WORKSPACE_ID` both fit `CMUX_ID`, `TERM_PROGRAM` is `ghostty` or absent, and none of `NEARER_HOSTS`, `HC_TERMINAL_ID`, `KITTY_WINDOW_ID`, `WEZTERM_PANE`, `ORCA_TERMINAL_HANDLE` is set.
  - `detectHost` gives `cmux` when `inCmux`, right after its `inHerdr` line. `detectApp` gives `cmux` when `inCmux`, right after its `inHerdr` line, before the bundle id and `TERM_PROGRAM` are read.

- [ ] **Step 1: Write the failing tests** (`S`, `W` two UUIDs; `cmux = { CMUX_SURFACE_ID: S, CMUX_WORKSPACE_ID: W }`):
  - `inCmux`, true: `cmux`; with `TERM_PROGRAM: 'ghostty'`; with `__CFBundleIdentifier: 'com.cmuxterm.app'`; ids in lower case.
  - `inCmux`, false: `{}`; one id alone; a surface of `'--help'`, `'x; rm -rf /'` and 37 characters; `TERM_PROGRAM` `'vscode'`, `'WezTerm'`, `'tmux'`, `'iTerm.app'`; each of `HERDR_PANE_ID`, `REX_BLOCK`, `ZELLIJ`, `TMUX_PANE`, `HC_TERMINAL_ID`, `KITTY_WINDOW_ID`, `WEZTERM_PANE`, `ORCA_TERMINAL_HANDLE` beside the two ids.
  - `a cmux terminal is cmux's host and page, never Ghostty's`: `detectHost` and `detectApp` are `'cmux'` for `{ ...cmux, TERM_PROGRAM: 'ghostty' }`, and with `__CFBundleIdentifier: 'com.mitchellh.ghostty'` beside it.
  - `a program started from a cmux terminal is its own`: `{ ...cmux, TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.microsoft.VSCode' }` gives `vscode` and `vscode`.
  - `tmux inside cmux is tmux, on cmux's page`: `{ ...cmux, TMUX_PANE: '%3', TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'com.cmuxterm.app' }` gives host `tmux`, app `cmux`.
  - `a cmux terminal whose ids the hook left out is Ghostty's host, on cmux's page`: `{ TERM_PROGRAM: 'ghostty', __CFBundleIdentifier: 'com.cmuxterm.app' }` gives host `ghostty`, app `cmux`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/hostDetect.spec.ts`. Expected: FAIL (`inCmux` is missing; `ghostty`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command, then `npx vitest run src/cable && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: an agent in a cmux terminal is on cmux's page, not Ghostty's`.

### Task 5: What the dial says when typing is refused

**Layer:** devices service process. **Depends on:** none. **Effort:** `high` (the one path that types into a person's terminal; `devices.ts` is in the 100% gate).

**Red test:** `cli/src/cable/hosts/observed.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/types.ts`, `adapter.ts`, `observed.ts`, `cli/src/services/devices.ts`
- Test: `cli/src/cable/hosts/observed.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  /** What an adapter's `type` answers: sent (`true`), not sent (`false`), the agent is in a turn (`'busy'`) or waits on
   *  the person (`'waiting'`) as its app says now, or a fixed sentence of the adapter's own for the dial (`refused`):
   *  never a value from a hook or an app. */
  export type TypeResult = boolean | 'busy' | 'waiting' | { refused: string }
  // adapter.ts
  type?(pane: Pane, text: string, engine: string): Promise<TypeResult>
  // observed.ts: ObservedActions.count's union gains `{ refused: HostAdapter }`
  /** What a count says in the log: a fixed word, the adapter that typed by its id, or `refused (<its id>)`. */
  export function countWord(what: Parameters<ObservedActions['count']>[0]): string
  ```
  - `send`, after the typing: only `=== true` is sent (an object is truthy). `'busy'` and `'waiting'` give `send`'s own two sentences and counts. `{ refused }` returns that sentence as the reason and counts `{ refused: <the adapter> }`. `false` is `<name> did not answer.` In all four the dial prompt it recorded is forgotten.
  - `adapter.ts`'s rule 3 and `type`'s comment say so. No other adapter changes: each still answers `true` or `false`.
  - `devices.ts`: `count: (what) => voiced(countWord(what))`. Nothing else.

- [ ] **Step 1: Write the failing tests** in `ObservedSource actions`, with `Fakes.orcaSend` answering a `TypeResult` and `counted` reading through `countWord`:
  - `an adapter that says busy gives the busy sentence, counted busy`: reason `proj is busy. Say it when it is done.`
  - `an adapter that says waiting gives the waiting sentence, counted waiting`: reason `proj is waiting for your answer in Orca.`
  - `an adapter's own sentence reaches the dial as it is, counted refused (orca)`: `{ refused: 'Turn on Automation mode in cmux.' }` gives `{ ok: false, reason: 'Turn on Automation mode in cmux.' }`, `counted` ends `['refused (orca)']`, and no `orca` is counted.
  - `after each of the three, the next turn's hook is a person's, not the dial's`: the dial prompt was forgotten (as the existing `a failed Orca send` test reads it).
  - `countWord says a word as it is, an adapter by its id, and a refusal by its adapter's id`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts`. Expected: FAIL (an object counts as sent).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/cable src/services/devices.spec.ts && npm run typecheck && npm run test:core`. Expected: PASS, `devices.spec.ts` unedited, `services/devices.ts` at 100%.
- [ ] **Step 5: Commit** `devices: an adapter can say why it did not type, in a sentence of its own`.

### Task 6: The hook sends cmux's ids, on macOS

**Layer:** the hook. **Depends on:** none. **Effort:** `high` (one file that ships alone into every agent; tests differ by platform).

**Red test:** `cli/src/hookNotify.spec.ts`.

**Files:**
- Modify: `cli/hook/notify.mjs`
- Test: `cli/src/hookNotify.spec.ts`

**Interfaces:**
- Produces: `HOST_HINTS` is `[…, 'TMUX_PANE', 'HC_TERMINAL_ID', 'CMUX_SURFACE_ID', 'CMUX_WORKSPACE_ID', 'KITTY_WINDOW_ID', …]`. Off macOS the two are skipped before the cap counts them, as `HC_TERMINAL_ID` is. A value is cut to 64 characters as every hint is (a UUID is 36). The hook checks no form: `inCmux` does (Task 4).

- [ ] **Step 1: Write the failing tests.**
  - `HINTS` gains the two names in that place; `SENT` leaves both out off macOS. Each existing expectation built from `HINTS` that the two names now reach is rebuilt from `SENT`, with no number written in.
  - `it.runIf(darwin)`: `sends cmux's surface and workspace from a cmux terminal, and no other CMUX_ name`: env `{ ...noHints, TERM_PROGRAM: 'ghostty', CMUX_SURFACE_ID: S, CMUX_WORKSPACE_ID: W, CMUX_TAB_ID: S, CMUX_PANEL_ID: S, CMUX_SOCKET_PATH: '/x/cmux.sock', CMUX_SOCKET_PASSWORD: 'secret' }` posts `hostHints` equal to `{ TERM_PROGRAM: 'ghostty', CMUX_SURFACE_ID: S, CMUX_WORKSPACE_ID: W }`, and the body matches none of `/TAB_ID|PANEL_ID|SOCKET|secret/`.
  - `it.runIf(not darwin)`: `off macOS cmux's ids are left out, and take none of the MAX_HINTS`: with every name set, the keys are the first `MAX_HINTS` of `HINTS` without `TMUX_PANE`, `HERDR_PANE_ID`, `HC_TERMINAL_ID` and the two.
  - `lists its hint names in this order, …` and `the largest body the hook can build is under 4096 bytes` pass with the new list.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/hookNotify.spec.ts`. Expected: FAIL (the list's order; no cmux id sent).
- [ ] **Step 3: Implement.** `HOST_HINTS`'s comment says what the two are (ids, no credential; cmux sets `TERM_PROGRAM=ghostty`, so without them a cmux agent reads as Ghostty's), why macOS alone, and that `CMUX_SOCKET_PASSWORD` and the rest must never leave this process.
- [ ] **Step 4: Run** the step 2 command. Expected: PASS on this Mac. The Linux run is PR CI's.
- [ ] **Step 5: Commit** `hook: an agent in a cmux terminal says which surface and workspace, on macOS`.

### Task 7: The cmux source

**Layer:** devices service process. **Depends on:** 1. **Effort:** `xhigh` (runs side by side, results out of order, a stop mid-run, liveness).

**Red test:** `cli/src/cable/hosts/cmuxSource.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/cmuxSource.ts`
- Test: `cli/src/cable/hosts/cmuxSource.spec.ts` (new)

**Interfaces:**
- Consumes: `CmuxClient['sessions']`, `CmuxSession`, `CmuxPrompt`, `CMUX_STORE`, `CMUX_AUTOMATION_OFF`, `cmuxPaneKey`, `cmuxPaneId` (Task 1); `MAX_AGENTS`, `shown` (`herdrSource.ts`); `MAX_TEXT` (`orca.ts`).
- Produces:
  ```ts
  export interface CmuxSourceDeps {
    client: Pick<CmuxClient, 'sessions'>
    /** Tells of each change where cmux's stores live, with the changed file's name when the OS gave one
     *  (unixSocket.ts watchSocket), until its stop is called. */
    watch(changed: (file?: string) => void): () => void
    /** Whether the stores' folder is there now. */
    folder(): boolean
    /** Whether that process is alive, asked of the OS alone. */
    alive(pid: number): boolean
    /** The dial's words: the cmux adapter's prompt (cmuxApp.ts). `pane` is `<workspace>/<surface>`. */
    prompt(pane: string, kind: string, text: string): Promise<CmuxPrompt>
    /** A tap on that agent at that pane, as the devices route it. */
    focus(pane: string, agentId: string): Promise<boolean>
    canShow(pane: string): boolean
    show(pane: string, agentId: string): Promise<PaneSwitch>
    now(): number
    monotonic(): number
    uuid(): string
    log(line: string): void
    count(what: 'cmux' | 'busy' | 'waiting' | 'too-long' | 'no-answer' | 'refused (cmux)'): void
  }
  export class CmuxSource implements HostSource {
    readonly id = 'cmux'
    constructor(deps: CmuxSourceDeps)
    start(): void
    stop(): void
    onChange(listener: () => void): () => void
    /** The kind of the agent cmux lists at that surface, whatever the id's case, listed or past the 64; else none. */
    kindAt(surface: string): string | undefined
    /** The pane (`<workspace>/<surface>`) of a row it lists, by the row's id; else none. devices.ts places the open
     *  scan's copy of that session there (decided 7). */
    paneAt(agentId: string): string | undefined
    // list, capabilities, send, focus, hasPane, showPane: HostSource's
  }
  /** `process.kill(pid, 0)`: alive when it succeeds or fails with EPERM. It reads nothing of the process. */
  export function pidAlive(pid: number): boolean
  ```
- The rules the signatures do not say (each from "Global Constraints" or "Decided here"):
  - `start()` asks `folder()`, says `watch · on|none` when it differs from the last said, holds the watch, and with a folder runs all agents once. `stop()` closes the watch, drops every run under way and every row (one `onChange` when there were rows).
  - A change: first `folder()`. It changed: say it; appeared, run all; gone, drop every row. Else with no folder: nothing. Else no name: run all. Else a store's name: run that word. Else: nothing.
  - A run under way for that word (or for all) marks one more after it. At most 32 runs at a time.
  - A result sets its agents' records, unless a run that started later already set them. Then every kept record whose pid is gone goes; each surface shows its newest record; a row whose surface, kind and pid are the same keeps its id, place and state history; the rest are new rows at the end.
  - `send` refuses by its own state first, as `HcSource.send` does: too long; no such row; a needs-you row is `waiting`; a `running` row is `busy`. Then `deps.prompt`, and each outcome is its sentence and count: `sent` → `{ ok: true }`, `cmux`; `busy`; `waiting`; `automation-off` → `CMUX_AUTOMATION_OFF`, `refused (cmux)`; `no-answer`.
  - `capabilities()` is `{ status: true, voice: true, focus: true, answer: false }`. It has no `markSeen`: nothing is ever unseen.

- [ ] **Step 1: Write the failing tests.** `setup(over)` gives a source on a fake client whose `sessions(word)` calls are recorded and answered by hand (a promise per call), the watch's `changed`, a `folder` flag, a set of live pids, a counter for `uuid`, clocks, the log and the counts. `S1`, `S2`, `W` are UUIDs. Nothing sleeps.
  - Listing:
    - `at start it asks for every agent once, and lists each record whose pid is alive`: the row is `{ id, engine: 'claude', name: 'api', host: 'cmux', app: 'cmux', sessionId, cwd: '/work/api', callerPid, paneKeys: ['cmux:<S1 lower>'], state: 'idle', unseenDone: false }`; `listed · 1 agents` is said.
    - `a record whose pid is gone is not listed`; `pidAlive is true when kill succeeds or says EPERM, false on ESRCH` (`process.kill` spied).
    - `one row per surface: the newest updated_at_unix wins, whichever store it came from`.
    - `the name is the folder's, else the kind`: `/work/api` → `api`; no cwd and `/` → `claude`; control characters go and 64 characters stay.
  - States:
    - `running is working, needsInput is needs-you, idle and unknown are idle`.
    - `a turn that leaves running or needsInput for idle is done with nothing unseen, and stays done while it stays idle`.
    - `unknown after running is idle, not done; an agent first listed idle is idle`.
    - `the same surface, kind and pid keep the row's id and place, through a new session id; another pid there is a new id, idle, with no done`.
  - The watch:
    - `a store's change asks for that agent alone, and its rows replace that agent's; the other agents' rows stay`: after `changed('codex-hook-sessions.json')` the call is `sessions('codex')`.
    - `a change with no name asks for every agent`.
    - `a name that is no store's runs nothing`: `'claude-hook-sessions.json.tmp'`, `'.DS_Store'`, `'CLAUDE-hook-sessions.json'`, `'-hook-sessions.json'`.
    - `with no folder nothing runs and watch · none is said; when it appears every agent is asked once and watch · on is said; removed, every row goes with no run`.
    - `a dial plugged in again to the same folder says no watch line twice`.
  - Runs:
    - `ten changes during one run give one more run, not ten`.
    - `two agents' runs go side by side`.
    - `a run that ends after stop() changes nothing, and after a new start its answer is still dropped`.
    - `an all-agents run that ends after an agent's later run leaves that agent's rows`.
    - `a 33rd run waits as one all-agents run`: with 32 words' runs under way, a 33rd word's change starts none, and `sessions()` is asked once the first ends.
    - `each result drops every row whose pid is gone, another agent's too`.
  - Bounds and failures:
    - `64 are listed and the 65th is kept: it is listed when one leaves, with no new run`.
    - `over is said when its number changes, with what cmux matched and did not print`: 65 rows and `unread: 3` say `over · 4 left out`, once.
    - `a failed or too-big run keeps the rows, and says so once until that agent's next good run`.
    - `onChange is told only when a listed row changed`: the same answer again, and one that differs only in `updatedAt`, tell nothing.
  - Words, a tap and a rest:
    - `send refuses by its own state before any prompt`: too long, an unknown id, a needs-you row, a working row; `prompt` is not called.
    - `it.each` of the five outcomes: the result and the count, with `Turn on Automation mode in cmux.` and `refused (cmux)` for `automation-off`.
    - `the prompt is given <workspace>/<surface>, the row's kind and the text`.
    - `focus, hasPane and showPane hand the pane and the id on, and paneAt tells that pane; an unknown id is false, false, failed and none`.
    - `kindAt answers whatever the case of the id, for a row past the 64 too; none where cmux lists nothing`.
  - `every line it logs is one of the five, with no id, folder or name`: each matches `/^\[cmux\] (watch · (none|on)|listed · \d+ agents|over · \d+ left out|list · (failed|too-big)|read · ([a-z][a-z0-9-]{0,31}|all) · \d+)$/`.
  - `read is said for a word's first run, then only for a slower one`: `monotonic` moved by hand.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/cmuxSource.spec.ts`. Expected: FAIL (`cmuxSource.js` is missing).
- [ ] **Step 3: Implement.** A run's promise ends in its own catch, which says `list · failed`.
- [ ] **Step 4: Run** the step 2 command, then `npx vitest run src/cable && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: cmux's agents, listed from cmux's own stores when they change, pushed and never polled`.

### Task 8: The cmux adapter

**Layer:** devices service process. **Depends on:** 1, 4, 5. **Effort:** `xhigh` (a hook's ids reach a link and a command line; the dial's words reach a person's terminal).

**Red test:** `cli/src/cable/hosts/cmuxApp.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/cmuxApp.ts`
- Test: `cli/src/cable/hosts/cmuxApp.spec.ts` (new)

**Interfaces:**
- Consumes: `CmuxClient`, `CmuxPrompt`, `CMUX_ID`, `CMUX_AUTOMATION_OFF`, `cmuxPaneId`, `cmuxPaneOf`, `cmuxPaneKey` (Task 1); `inCmux`, `APP_BUNDLES` (Tasks 3, 4); `TypeResult` (Task 5); `createAppLink`, `AppLinkDeps` (`appLink.ts`, unchanged); `MAX_TEXT`, `CONTROL`.
- Produces:
  ```ts
  /** `run`, `platform`, `inFront` (cmux is the app in front) and `bin` (the raw `HARNESS_OPEN_BIN`) are appLink.ts's. */
  export type CmuxAppDeps = AppLinkDeps & {
    client: Pick<CmuxClient, 'mode' | 'inputState' | 'paste'>
    /** cmux is installed, as the last attach found it (devices.ts). */
    found(): boolean
    /** The kind of the agent the cmux source lists at that surface; none when it lists none there (CmuxSource.kindAt). */
    kindAt(surface: string): string | undefined
  }
  export interface CmuxAppAdapter extends HostAdapter {
    canShow(pane: Pane): boolean
    show(pane: Pane, agentId: string): Promise<PaneSwitch>
    paneKey(pane: Pane): string
    type(pane: Pane, text: string, engine: string): Promise<TypeResult>
    canType(pane: Pane): boolean
    /** The dial's words for that pane (`<workspace>/<surface>`): the cmux source's door too. */
    prompt(pane: string, kind: string, text: string): Promise<CmuxPrompt>
  }
  export function createCmuxAppAdapter(deps: CmuxAppDeps): CmuxAppAdapter
  ```
  - `id: 'cmux'`, `tap: 'instead'`, `bundle: APP_BUNDLES.cmux`.
  - `paneOf`: on macOS, `place.host === 'cmux'` and `inCmux(place.hints)`; the pane's id is `cmuxPaneId(CMUX_WORKSPACE_ID, CMUX_SURFACE_ID)`, each as the hint has it.
  - `canFocus`, `focus`, `canShow` and `show` are `createAppLink(deps, { session: CMUX_PANE, url, bundle: APP_BUNDLES.cmux })`, with no `forward`: `CMUX_PANE` is a module constant, `<CMUX_ID>/<CMUX_ID>` anchored, no `g` flag; `url(pane)` is `cmux://workspace/<w>/surface/<s>` from `cmuxPaneOf`. So the run is `open -b com.cmuxterm.app cmux://workspace/<w>/surface/<s>`, 10 s; `canFocus` is macOS; `canShow` is macOS and `inFront()`; a second rest of that agent while one runs is `busy`.
  - `canType`: on macOS and `found()`.
  - `prompt`: the five steps of "Global Constraints", and their answers: blank, over-long or a pane out of form → `no-answer`; a second prompt for that surface while one runs → `busy`; mode none → `no-answer`, not `automation` or `allowAll` → `automation-off`; input state none, or `terminal` or `agent` not true → `no-answer`; `needsInput` → `waiting`; `running`, `draft` or `dialog` → `busy`; anything else but idle, empty and not blocking → `no-answer`; another kind at that surface → `no-answer`; then the paste, `sent` or `no-answer`.
  - `type`: `prompt(pane.id, engine, text)` as `true`, `'busy'`, `'waiting'`, `{ refused: CMUX_AUTOMATION_OFF }` or `false`.

- [ ] **Step 1: Write the failing tests**, with a recording `run` and a fake client whose three calls are recorded and answered as told:
  - `its id is cmux, a tap is its own, and its bundle is cmux's`.
  - `off macOS it has no pane, and nothing focuses, shows or types`.
  - `paneOf takes both ids from a cmux terminal, as <workspace>/<surface>`; `paneOf refuses one id alone, an id out of form, any host but cmux, and ids another app inherited` (`TERM_PROGRAM: 'vscode'`, `TMUX_PANE`).
  - `paneKey is cmux:<surface> in lower case`.
  - `canFocus is macOS's; canType follows whether cmux was found; canShow needs cmux in front`.
  - `focus is one open of cmux's link sent to cmux alone, true on exit 0`: the run is `['/usr/bin/open', ['-b', 'com.cmuxterm.app', 'cmux://workspace/<W>/surface/<S>'], 10_000]`; with `bin: '/x/fake-open'` that path runs.
  - `an open that fails is false; show is ok or failed`.
  - `a pane out of form runs nothing`: `'--help'`, `S` alone, `` `${W}/x; rm -rf /` ``, for `focus`, `show`, `type` and `prompt`.
  - `a second rest of that agent while one runs is busy, and runs nothing more`.
  - Words, with the client's calls in order:
    - `sent: the mode, the input state, then one paste with the workspace, the surface and the text`: calls `[['mode'], ['inputState', S], ['paste', W, S, 'run the tests']]`.
    - `control characters become spaces; a blank text and one over 2,000 characters ask nothing and are no-answer`.
    - `it.each` mode `cmuxOnly`, `off`, `password`, `somethingNew`: `automation-off`, and neither `inputState` nor `paste` is asked. `allowAll` goes on.
    - `a mode that could not be read is no-answer, and nothing more is asked`.
    - `the mode reads automation and the socket still refuses: no-answer, and no paste runs` (`inputState` answers none).
    - `needsInput is waiting; running, a draft and a dialog are busy; no terminal, no agent, an unknown lifecycle or state, and blocks_typing with an empty prompt are no-answer`: `paste` is never asked.
    - `another kind at that surface is no-answer; no record there goes on`.
    - `a paste cmux refuses after an idle read is no-answer: one paste, none forced` (`paste` answers false; it was asked once).
    - `a second prompt for that surface while one runs is busy, and the client is asked once; the surface takes words again after each outcome`.
    - `type answers true, busy, waiting, the Automation sentence, or false`: `{ refused: 'Turn on Automation mode in cmux.' }` for `automation-off`.
    - `words and a tap do not wait for each other`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/cmuxApp.spec.ts`. Expected: FAIL (`cmuxApp.js` is missing).
- [ ] **Step 3: Implement.** The header says the link needs no socket, goes to cmux alone by its bundle id (so cmux NIGHTLY, which registers the same scheme, never gets it) and brings cmux itself, and that the mode is read when the words are said, so turning Automation mode on works at once.
- [ ] **Step 4: Run** the step 2 command, then `npx vitest run src/cable && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: a tap and a rest open the agent's tab in cmux, and its words go through cmux's own paste`.

### Task 9: The devices run the cmux source

**Layer:** devices service process. **Depends on:** 2, 7, 8. **Effort:** `xhigh` (wiring in a file held at 100%; a third outside source beside two).

**Red test:** `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts`
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `cmuxClientDeps`, `createCmuxClient`, `cmuxStoreDir`, `cmuxPaneId`, `CmuxClient` (Task 1); `watchSocket` with a name (Task 2); `CmuxSource` with `paneAt`, `pidAlive` (Task 7); `createCmuxAppAdapter` (Task 8); `observedAgentId`, `ObservedSource.paneOf`, `setPaneNames` (`observed.ts`, unchanged).
- Produces:
  - `DevicesDeps.cmux?: CmuxClient`, for this service's tests, as `hc` is. Unset: `createCmuxClient({ ...cmuxClientDeps(), platform: apps.platform })`.
  - The adapter, built with `found` (kept from the last attach), `inFront: () => cableHost.latestFront() === 'cmux'`, `kindAt` from the source, `bin: openBin`. It sits in `adapters` right after `herdrAppNoted` and before WezTerm, wrapped by `noting`.
  - The source: `observed && apps.platform === 'darwin' ? new CmuxSource({ … }) : null`, with
    - `watch: (changed) => watchSocket({ socketPath: join(cmuxStoreDir(home), 'stores'), home }, changed)`, `home` the client deps';
    - `folder: () => existsSync(cmuxStoreDir(home))`, `alive: pidAlive`;
    - `prompt` the adapter's; `focus` through `opener.open(agentId, { pane })` after `noteMove()`, as `hcSource`'s; `canShow` the adapter's; `show` the noted copy's;
    - `now: Date.now`, `monotonic`, `uuid: randomUUID`, `log`, `count: voiced`.
  - It joins `HostRegistry` after `hcSource`, and its `onChange` runs `part.call('dial', outsideTurn)`.
  - `dialAttached`: `part.call('cmux', …)` reads `client.binary()` at each attach, keeps `found`, and starts the source when a dial is on and cmux is found, else stops it.
  - **The place** (decided 7), `placeInCmux(observed, cmuxSource)` beside `placeInOrca`: for each row of `cmuxSource.list()` with a session id, the observed agent `observedAgentId(row.engine, row.sessionId)` that has no cmux pane of its own (`observed.paneOf(id, 'cmux')` is none) is placed at `cmuxSource.paneAt(row.id)`; then `observed.setPaneNames('cmux', new Map(), placed)`. It runs after each change of the cmux source and of the observed source (`setPaneNames` tells only a change, so the two never loop), and with an empty map when the source stops. cmux names no pane, so the names map stays empty. Its comment says why: the scan's copy wins the fold by its session id and has no hook to name its pane until that session's next turn; a place opens and shows, never takes words.

- [ ] **Step 1: Write the failing tests** in a describe `cmux's agents, from cmux's own stores (docs/plans/2026-11-17-dial-cmux-design.md)`. `withCmux(over)` starts the devices on macOS (`onMac`) with a fake `CmuxClient` (its `binary`, and each of its four calls recorded and answered as told), a `.cmuxterm` folder made in the suite's throwaway home (`vitest.setup.ts`, never the developer's) and removed after, and records with `pid: process.pid`. `start` takes `cmux: null` for "no client given".
  - `with a dial attached and cmux found its agents are listed svf, on cmux's page; detached, the source stops and its watch is closed`: `watched.calls` holds `[{ socketPath: join(homedir(), '.cmuxterm', 'stores'), home: homedir() }, expect.any(Function)]`; `hostOf` and `appOf` are `cmux`.
  - `cmux not installed: nothing is asked and no folder is watched`; `off macOS, and with HARNESS_DEVICE_OBSERVED off, there is no cmux source`.
  - `a store's change reaches the dial as a card`: the recorded watch's `changed('claude-hook-sessions.json')` with the next answer `running`, then `needsInput`, then `idle`, tells a processing card, `Waiting for you · cmux`, then a done card.
  - `a tap on a listed agent is one open of cmux's link, and is the dial's own move`: `orcaRuns` is `[['/usr/bin/open', ['-b', 'com.cmuxterm.app', 'cmux://workspace/<W>/surface/<S>'], 10_000]]`.
  - `a rest with cmux in front shows its tab; with another app in front it has no pane`.
  - `the dial's words reach a listed agent through cmux, and are counted cmux`; `with the default mode the dial hears the Automation sentence, counted refused (cmux), and nothing is pasted`.
  - `a hooked agent in cmux is on cmux's page with cmux's pane, never a tab's, and its tap is the link`: a hook with `{ TERM_PROGRAM: 'ghostty', CMUX_SURFACE_ID, CMUX_WORKSPACE_ID }`.
  - `a hooked agent cmux also lists is one row, the hook's`: the hook's ids in upper case, the record's in lower; `listed()` has one row, with `observedAgentId('claude', 'sess-1')`.
  - `a hooked agent with no mod takes the dial's words through cmux, and the Automation sentence reaches the dial`: `[device] voice · refused (cmux)`.
  - The open scan's copy (decided 7; Review Focus 1), a Claude Code session the scan lists with no hook, its record's ids in lower case:
    - `a session the open scan found and cmux lists is one row, the scan's, placed at cmux's tab: a tap is one open of cmux's link from the first list`: `listed()` has one row, `observedAgentId('claude', 'sess-1')`; `orcaRuns` is `[['/usr/bin/open', ['-b', 'com.cmuxterm.app', 'cmux://workspace/<W>/surface/<S>'], 10_000]]`.
    - `a rest with cmux in front shows the placed session's tab, and the dial's words for it never reach cmux`: the rest runs that link; after the words, the fake client's `mode`, `inputState` and `paste` were not asked.
    - `the place goes when cmux no longer lists that session, and a hook from its cmux terminal gives it a pane of its own`: after an answer without its record, a tap runs no `cmux://` open; after a hook with its `CMUX_SURFACE_ID` and `CMUX_WORKSPACE_ID`, a tap runs the link again and the words reach cmux (`mode` asked).
  - `tmux inside a cmux terminal keeps tmux's pane, on cmux's page`.
  - `a pick of cmux brings cmux forward`: one run `['/usr/bin/open', ['-b', 'com.cmuxterm.app'], 10_000]`.
  - `with no client given the devices run the cmux on PATH, with no CMUX_* variable`: `PATH` stubbed to a `fakeCmux().dir` first, `CMUX_SOCKET_MODE` and `CMUX_AGENT_HOOK_STATE_DIR` stubbed; once `[cmux] listed · 1 agents` is logged (`vi.waitFor`), the fake's one call has `env: []`. `describe.skipIf(win32)`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts -t cmux`. Expected: FAIL (nothing listed; `DevicesDeps.cmux` is unknown).
- [ ] **Step 3: Implement.** The adapters' comment says why cmux comes before the terminals (cmux tells its programs they run in Ghostty, whose tabs hold none of them).
- [ ] **Step 4: Run** `npx vitest run src/cable src/services/devices.spec.ts src/services/devicesListener.spec.ts src/architecture.spec.ts src/architecture.environment.spec.ts && npm run typecheck && npm run test:core`. Expected: PASS, `services/devices.ts` at 100%.
- [ ] **Step 5: Commit** `dial: cmux's agents are on the dial with their state, hook or no hook`.

### Task 10: End to end, a fake cmux

**Layer:** test. **Depends on:** 6, 9. **Effort:** `high`.

**Red test:** none: no behavior (the end-to-end test of Tasks 1 to 9). One commit.

**Files:**
- Create: `cli/e2e/deviceCmux.e2e.ts`
- Modify, only if a helper is missing: `cli/src/testing/fakeCmux.ts`

**Interfaces:**
- Consumes: `fakeCmux`, `touchStore` (Task 1); the e2e harness (`IsolatedDaemon`, `Desk`, `FakeBackend`, `Outside`, `until`), with the shapes `deviceHerdrApp.e2e.ts` uses for its rows, cards, words, tap (`{ t: 'agent.open', agentId }`) and `dialAppFilter.e2e.ts` for a pick (`{ t: 'app.pick', app }`).

- [ ] **Step 1: Write `deviceCmux.e2e.ts`**, `describe.skipIf(process.platform !== 'darwin')`. Its header says cmux is never run: the daemon's `cmux` is the fake, linked first on its `PATH` from a `cmux.app/Contents/Resources/bin` folder in the daemon's root, and its `open` is the harness's fake.
  - `fresh()`: a daemon signed in to a `FakeBackend` for the speech, a desk, and a fake cmux in `d.root`. **Before the daemon starts**, it checks `realpathSync(resolveBinaryOnPath('cmux', d.env)!)` is `realpathSync(fake.binary)`, and that `HARNESS_OPEN_BIN` is an absolute path inside `d.root`.
  - `cmux's agents are on the dial with their state and no hook, and take the dial's words only with Automation mode`:
    1. A dial plugged in with no `.cmuxterm` in the daemon's home: the log has `[cmux] watch · none`, and the fake has no call.
    2. A live child of the test's own (Node that waits) is the record's pid. `fake.set` one `claude` record, then `touchStore(home, 'claude')`. The dial lists `{ name: 'api', engine: 'claude', host: 'cmux', caps: 'svf' }`. The test prints the milliseconds from the write to that row, and the log's `[cmux] read · all · <ms>`.
    3. `running`, `needsInput`, `idle`, each with a `touchStore`: a turn started, the line `Waiting for you · cmux`, then a done card.
    4. Words with the default mode: the dial hears `Turn on Automation mode in cmux.`; the fake's calls since are one `socket-status --json`; the log has `[device] voice · refused (cmux)`.
    5. `mode: 'automation'`: the words are taken; the fake's calls are `socket-status`, `rpc surface.input_state`, then `paste --workspace <W> --surface <S> --submit -` whose `stdin` is the words; no call holds `--force` or the words in `args`; the log has `[device] voice · cmux`.
    6. The record `running`: the dial hears `api is busy. Say it when it is done.`, and no `paste` is added.
    7. The child ended, then a `touchStore`: the row goes.
  - `a tap opens the agent's tab by cmux's link, and a pick of cmux brings cmux forward`: after `agent.open`, `d.opens()` is `[['-b', 'com.cmuxterm.app', 'cmux://workspace/<W>/surface/<S>']]`; after `app.pick` of `cmux` (a dial that says `appFilter`), it gains `['-b', 'com.cmuxterm.app']`.
  - `a hooked agent in cmux is one row on cmux's page, and its tap is the same link`: `Outside.start(d, 'web', { TERM_PROGRAM: 'ghostty', CMUX_SURFACE_ID: S2, CMUX_WORKSPACE_ID: W2 })`; its row has `host: 'cmux'` and the dial's `apps` hold `cmux` and no `ghostty`; a record of that surface with its pid and session id, then a `touchStore`, leaves one row with the same id; its tap's `open` is `['-b', 'com.cmuxterm.app', 'cmux://workspace/<W2>/surface/<S2>']`.
  - `afterEach` ends the children, then the desk, the daemon and the backend.
- [ ] **Step 2: Run** `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceCmux.e2e.ts --reporter=default`. Expected: PASS, three tests, none skipped, on this Mac. A failure is a finding in the task that owns the behavior: report it, do not loosen the test.
- [ ] **Step 3: Commit** `e2e: cmux's agents on the dial, from a fake cmux`.

### Task 11: Say it in the docs

**Layer:** docs. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: docs only. One commit.

**Files:**
- Modify: `cli/AGENTS.md`, `docs/specs/2026-11-15-device-host-adapter.md`

- [ ] **Step 1: `cli/AGENTS.md`**, the devices row of "The processes": after Herdr's part, cmux's agents, listed from `cmux sessions list` when a store in `~/.cmuxterm` changes, while a dial is attached, on macOS (`cable/hosts/cmuxSource.ts`, `cmuxCli.ts`), and opened and spoken to by `cmux` (`cable/hosts/cmuxApp.ts`).
- [ ] **Step 2: `docs/specs/2026-11-15-device-host-adapter.md`:**
  - The adapters table gains `cmux` | `hosts/cmuxApp.ts` | `CMUX_SURFACE_ID` and `CMUX_WORKSPACE_ID` in a cmux terminal | `cmux paste --submit`, only with Automation mode, an idle empty prompt and the same agent | the `cmux://workspace/<w>/surface/<s>` link, sent to cmux alone (`open -b com.cmuxterm.app`, `appLink.ts`), macOS only | the link, while cmux is in front.
  - Under it, one paragraph: what needs nothing of cmux (the list, the state, a tap, a rest: `cmux sessions list` and the link use no socket) and what needs Automation mode (only the dial's words), with a link to the spec.
  - The steps, in two lines: in cmux, Settings ▸ Automation ▸ Socket Control Mode ▸ Automation mode. Only the dial's words need it; Harness never changes it.
  - The interface block's `type` reads `Promise<TypeResult>`, with one line on what a `TypeResult` is.
- [ ] **Step 3: Commit** `docs: cmux's agents reach the dial through cmux's command line`.

### Task 12: The recap after a restart, held by #4391's path

**Layer:** test. **Depends on:** 9, 10, and **#4391 merged to `main`** and integrated into this branch (external). **Effort:** `high` (a restart, and a race the dial's restore loses if a row is listed before its answer).

**Red test:** none: the behavior is #4391's (the scan reads each open Claude Code and Codex session's last answer before it lists the row) and Task 9's (cmux's row folds into the scan's copy, placed at cmux's tab). No recap read goes into the cmux source (decided 8). One commit.

**Files:**
- Test: `cli/src/services/devices.spec.ts`, `cli/e2e/deviceCmux.e2e.ts`

**Before step 1** the implementer reads `observed.ts` and `devices.spec.ts` on `main`: how the scan's last answer is read (#4391's `ObservedDeps.lastAnswer`, read at its head `3e5b290ede` through `cable/hosts/lastAnswer.ts` `readLastAnswer`) and how `devices.spec.ts` reaches it. If the scan does not read the last answer of a session it lists, stop and report.

- [ ] **Step 1: Write the two tests.**
  - `devices.spec.ts`, in Task 9's describe: `after a restart an idle Claude Code agent cmux lists is restored with its last answer, placed at cmux's tab`: the scan's session and a cmux record with its session id; `host().recentSummaries(id)` holds the answer, no done card was told, and a tap runs `['/usr/bin/open', ['-b', 'com.cmuxterm.app', 'cmux://workspace/<W>/surface/<S>'], 10_000]`.
  - `deviceCmux.e2e.ts`: `an idle Claude Code agent cmux lists shows its last answer when the dial plugs in`: a transcript written by hand in the daemon's own Claude projects folder, a live process the scan reads as that session, a record with its session id and that pid; the dial is sent a `summary` with `restore: true` for that row, and no `done`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts && npm run typecheck && npm run test:core`, then Task 10's step 2 command. Expected: PASS, four e2e tests. A failure is a finding in #4391's path or Task 9: report it; do not add a reader to the cmux source.
- [ ] **Step 3: Commit** `dial: an idle agent cmux lists shows its last recap after a daemon restart`.

## Verification

**Platforms the pull request names:** the daemon and the hook on macOS. Tested: the unit specs on Linux in PR CI and on this Mac; check 1 on this Mac. Linux and Windows: nothing a person sees changes. Unit tests with `platform: 'linux'` hold that the client has no binary, the source is not built and the adapter has no pane (Tasks 1, 8, 9), and on a Linux runner that the hook sends no cmux id (Task 6).

**Never touched:** a real cmux (none is installed; none is installed for this), `~/.cmuxterm`, cmux's settings, Diego's everyday daemon (port 18473), `~/.claude`, `~/.codex`, his tmux server, his dial, his Herdr, any backend, production. `/usr/bin/open` never runs: every e2e `open` is the harness's fake.

**Temporary workflow:** none (decided 10). Check 1 is one file of about two minutes that runs isolated on this Mac. No workflow of the repo runs a macOS e2e file but the disk-full job, and the repo adds no CI run to a pull request (`docs/validation-and-release.md`). Check 2 has a workflow of the repo's own.

**Turns.** The tester asks the orchestrator before the one hand-started GitHub run (check 2).

**Local gates**, recorded in the pull request (PR CI does not run them), on this Mac at the final head:
- `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts src/services/devicesListener.spec.ts src/hookNotify.spec.ts`. The hook's macOS tests run only here.
- `npm run test:core`: 100% per file under `src/services/`, `services/devices.ts` named. The one gate the repo requires for these paths (`python3 scripts/local-checks.py --list …` answers `cli-core` alone).
- `npx vitest run src/architecture.spec.ts src/architecture.environment.spec.ts src/leanEntry.spec.ts`. `git diff --stat origin/main -- cli/src/core cli/src/architecture.coreFiles.txt cli/vitest.setup.ts` prints nothing.
- From the repository root: `python3 devices/harness-device/firmware/test/test_touch_ui.py` (PR CI's `firmware-checks` runs it too).
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit. Its receipt goes in the pull request's body before the tested commit is pushed.
- Not needed: `npm run test:harnessd`, the serial and PTY specs, `cargo test` in `device-app`, `make desktop-test`, a firmware build or flash.

**1. A fake cmux, the real daemon, a fake dial**
- Where: this Mac only, at the final head. No test account, no sign-in: the speech goes to a fake backend on loopback.
- Build: nothing by hand. The suite starts the daemon from the working tree.
- Run: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceCmux.e2e.ts --reporter=default`.
- Isolation, the suite's own (`cli/e2e/harness/daemon.ts`, cli/AGENTS.md rules 5 and 6) and the file's:
  - a throwaway home (so its own `.cmuxterm`), data folder and Codex home, a private port and tmux server, a fake dial on a pseudo-terminal;
  - the fake `cmux` in the daemon's root, in a `cmux.app/Contents/Resources/bin` folder, linked first on the daemon's `PATH`, and checked to be the one the daemon resolves before it starts;
  - the fake `open` (`HARNESS_OPEN_BIN`), checked to be inside the daemon's root;
  - the daemon under test inherits no `CMUX_*` (`src/testing/daemonEnvironment.ts`), and the client would drop one.
  - Before and after the run, `ls -d ~/.cmuxterm /Applications/cmux.app; command -v cmux` answers the same: nothing.
- A person sees: three tests pass, none skipped (four once Task 12 is in). The first one's log has `[cmux] watch · none`, `[cmux] watch · on`, `[cmux] listed · 1 agents`, `[cmux] read · all · <ms>`, `[device] voice · refused (cmux)`, `[device] voice · cmux` and `[device] voice · busy`. It prints the time from a store write to the card it gives: under 1,000 ms on this Mac, else a finding (done-when 1; a new row also waits for the dial's own 1 s list push). `--reporter=default` keeps that line visible under an agent's runner. The second one's `open` record is `-b com.cmuxterm.app` and the link, then `-b com.cmuxterm.app`.
- Skipped or not run: report it as not verified, never as passed.
- On GitHub: none. `cli-e2e.yml`'s shards are Linux, where the file reads skipped, and its one macOS job runs the disk-full tests alone. **Proposal** (not this pull request; it goes in the final report, decided 10): a macOS job of `cli-e2e.yml` for the macOS-only dial files; this one needs nothing installed.

**2. The other dial flows still hold**
- On GitHub, by hand, once on the final head: Actions → CLI end to end → Run workflow, branch `feat/dial-cmux` (`.github/workflows/cli-e2e.yml`). Every shard passes. `deviceCmux.e2e.ts` reads skipped there. The link goes in the pull request.
- Isolation: the suite's own. No account, no secret.
- What it shows: `deviceWithoutApp`, `deviceClaudeOrca`, `deviceCodex`, `deviceHerdr` (its stale-socket test), `dialAppFilter`, `dialClaudeAppFollow`, `dialTerminalFollow` and `devicesProcess` pass on the new `type` result, the new adapter, the eighteenth app id, the watch's new argument and the hook's new list.
- On this Mac beside check 1, for the macOS-only tests the shards skip: `… npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilter.e2e.ts e2e/deviceHerdrApp.e2e.ts` (the pick's `open -b`, and Herdr's adapter beside cmux's; the second needs the Herdr Core installed here and runs it as its own plan says, in a private session).

**3. In PR CI, by itself:** `cli-typecheck` and `cli-tests` run the specs of Tasks 1 to 9 on Linux (the fake cmux is a script, so the client's and the devices' through tests run there); `firmware-checks` runs `test_touch_ui.py`. Nothing is started by hand.

**4. Numbers** (root rule 4, idle daemon work), read from check 1 and held by specs:
- at rest, cmux installed and no agent's hook firing: one folder watch, no timer, no process (Task 7, `a name that is no store's runs nothing`; the source has no `after`);
- cmux not installed: nothing at all (Task 9);
- per store write: one `cmux` run for that agent and one parse, never two at once for one agent (Task 7); check 1 prints the run's time and the write-to-row time with the fake;
- before this change: none of this ran. The real cmux's run time, with a real store and Codex index, is the spec's follow-up check.

**5. On a real cmux (person-only; not in this pull request):** the spec's first follow-up. It needs cmux installed by Diego himself, his own settings and his eye: the list against real stores, a tap on a real tab, words with Automation mode on and off, and the `read` times. No agent installs cmux or runs this.

**6. Against production:** none, and never.
