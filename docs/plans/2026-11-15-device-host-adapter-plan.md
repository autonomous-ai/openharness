# One adapter per app for the agents outside Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use diegodev phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(devices): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message.

**Goal:** Each app the dial reaches an outside agent through (Orca, the Claude app, a terminal tab, WezTerm, herdr) is one adapter file behind one interface, and the round dial offers no answer controls for an agent that cannot take an answer.

**Architecture:**
- **Sources** (`HostSource`, unchanged) list agents. **Adapters** (`HostAdapter`, new) are the apps an outside agent runs in: each finds its own pane of an agent from the agent's latest hook event, and acts on that pane.
- `ObservedSource` keeps the agents, their states and, for each agent, every pane an adapter recognises, in a fixed order. Each verb uses the first pane whose adapter can do it. The source holds no rule about any app. `open.ts` keeps what every app shares: the bundle id, `open -b`, one tap at a time per agent, the fallback line.
- `services/devices.ts` builds the five adapters and hands them to the source and the opener. The echo notes of the two follow features stay there, as today.
- The firmware reads the `a` letter it already parses: without it, a question shows its prompt and `[ later ]` only.
- Nothing a person sees changes but those controls. Every command line, argument, timeout, guard, refusal sentence and log line stays as it is.
- Two fixes from #4331's review ride on the reshape, and are the only exceptions to the line above (the spec, "Added from #4331's review"). F2: the devices keep one record of the dial's own moves, so no settle turns the dial back after it showed another kind of pane (Task 12). F3: the tab's skip log lines take the form the other follow lines have (Task 13).

**Tech Stack:** TypeScript daemon (Node, vitest, `cli/`); C firmware for ESP32-S3 (`devices/harness-device/firmware`, ESP-IDF 5.5.4), its host contracts in Python and C.

**Spec:** `docs/specs/2026-11-15-device-host-adapter.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` and `cli/src/services/AGENTS.md`.

**One open question**, on Task 12: it is under "Open questions" at the end, and the task is written on the reading the merged tests force. The PM answered this plan's first six on 2026-11-15; the answers are under "Decided here" at the end, and the spec's "The interface" section holds the two that changed it (`tap`, and every pane kept).

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 0 The base | none (a note) | #4311, #4326, #4331 on `main` | none | none: no code |
| 1 The adapter's shape | `cli/src/cable/hosts/adapter.ts` (new), `open.ts` | 0 | medium | none: no behavior (types, one `export`) |
| 2 Orca | `cli/src/cable/hosts/orca.ts`, `orca.spec.ts` | 1 | high | `orca.spec.ts` |
| 3 The Claude app | `cli/src/cable/hosts/claudeApp.ts` (new), `claudeApp.spec.ts` (new) | 1 | high | `claudeApp.spec.ts` |
| 4 Tabs | `cli/src/cable/hosts/tabs.ts`, `tabs.spec.ts` | 1 | high | `tabs.spec.ts` |
| 5 WezTerm | `cli/src/cable/hosts/wezterm.ts` (new), `wezterm.spec.ts` (new) | 1 | medium | `wezterm.spec.ts` |
| 6 herdr | `cli/src/cable/hosts/herdr.ts` (new), `herdr.spec.ts` (new) | 1 | medium | `herdr.spec.ts` |
| 7 Words and rests ask the adapters | `cli/src/cable/hosts/observed.ts`, `observed.spec.ts`, `cli/src/services/devices.ts`, `devices.spec.ts` | 2, 3, 4, 5, 6 | xhigh | `observed.spec.ts` |
| 8 Taps ask the adapters | `cli/src/cable/hosts/open.ts`, `open.spec.ts`, `observed.ts`, `observed.spec.ts`, `orca.ts`, `cli/src/services/devices.ts`, `devices.spec.ts` | 7 | xhigh | `open.spec.ts`, `observed.spec.ts` |
| 9 The dial answers only where it can | `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c`, `firmware/test/test_touch_ui.py`, `firmware/test/test_question_ui.py` | none | high | `test_touch_ui.py` |
| 10 Say it in the docs | `cli/AGENTS.md`, `cli/src/services/AGENTS.md` | 8 | medium | none: no behavior |
| 11 Temporary workflow | `.github/workflows/tmp-device-host-adapter.yml` (new) | 8, 9, 12, 13 | medium | none: a temporary workflow, one commit |
| 12 One record of what the dial just showed (F2) | `cli/src/services/devices.ts`, `devices.spec.ts` | 8, 13 | xhigh | `devices.spec.ts` |
| 13 The tab's skip lines in one form (F3) | `cli/src/services/devices.ts`, `devices.spec.ts`, `cli/e2e/dialTerminalFollow.e2e.ts`, `docs/specs/2026-11-15-dial-terminal-follow.md` | 0 | medium | `devices.spec.ts` |

Longest chain: 1, 2 (or 3 to 6), 7, 8, 12, 11. Tasks 2 to 6 share no file and run beside each other. Task 9 shares no file with any task and can start at once.

`services/devices.ts` and `devices.spec.ts` are shared by Tasks 7, 8, 12 and 13, so no two of them run at once:
- **Task 13 needs none of the others.** It renames four strings in the tab follow, which Tasks 7 and 8 do not touch, so it can start as soon as Task 0 is done, beside Tasks 1 to 6 and 9. If Task 7 is running, it waits for the file.
- **Task 12 waits for Task 8 and Task 13.** For Task 8, because only then does every rest and every tap of an outside agent pass one list of adapters and one `open` in `devices.ts`; before it they pass four per-app members that Tasks 7 and 8 rewrite, and those tasks' wiring says nothing of a note to carry. For Task 13, because its tests read the tab's skip line in Task 13's form.
- **Task 11 waits for both**, for its own reason: every push starts its three jobs, so it goes in last.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/hosts/adapter.ts`, `orca.ts`, `claudeApp.ts`, `tabs.ts`, `wezterm.ts`, `herdr.ts`, `open.ts`, `observed.ts` | **Devices service process**; `tabs.ts` is also loaded by the CLI's watch | Their specs |
| `cli/src/services/devices.ts` | **Devices service process** | 100% per file (`npm run test:core`) |
| `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` | The round dial's firmware | Host contracts (`firmware/test/test_*.py`, PR CI `firmware-checks`); the ESP-IDF build |
| `cli/AGENTS.md`, `cli/src/services/AGENTS.md` | Repo files, no process | none |
| `cli/e2e/dialTerminalFollow.e2e.ts` (Task 13) | The end-to-end suite: the real daemon, macOS only | Verification 1 |
| `docs/specs/2026-11-15-dial-terminal-follow.md` (Task 13) | Repo file, no process | none |

No file under `cli/src/core/` changes, and `src/architecture.coreFiles.txt` gains no line. `cable/hosts/types.ts`, `registry.ts`, `cableHost.ts` and `cableSession.ts` do not change.

## Stack and external prerequisites

- **Base.** `main` with #4311 (`feat/dial-pane-follow`), #4326 (`feat/dial-claude-app-follow`) and #4331 (`feat/dial-terminal-follow`) merged, in that order. #4326 and #4331 conflict with each other in `observed.ts`, `open.ts`, `cableHost.ts` and `services/devices.ts`, so the merged files did not exist when this plan was written.
- **Written against the union of both:** the Claude app pieces of #4326 (`claudeShow`, `claudeInFront`, `ShownPane` kind `'claude'`, the `open` wrapper and `noteLink` in `devices.ts`) and the tab pieces of #4331 (`tabs.ts`, `Entry.tty`, `learnTty`, `tabsOpen`, `tabSelect`, `byTab`, `ShownPane` kind `'tty'`, the tap's select with raise in `ObservedSource.focus`, `selected` in `devices.ts`).
- **State, 2026-11-15:** #4311 is on `main` and in this branch. #4326 is in CI and #4331 follows it. Neither changes a file of Task 9 against `main`, so Task 9 starts now; every other task waits for Task 0.
- Tasks name functions and what moves, never line numbers.
- **Tasks 12 and 13** were written on 2026-11-15 against `origin/main` at aad8dcd535 (#4326: `dialLinks`, `noteLink`, `linkedByDial`, `claudeAttached`, `claudeSettled`, `ATTACH_ECHO_MS`) and #4331's head c6f5b7ecd6 (`selects`, `written`, `selected`, `TabReport`, `tabReported`, `followTab`, `tabSettled`, `FOLLOWED.tab`, `ECHO_MS`). #4331 still had review fixes to come. Task 0's rule holds for them: a name that differs, use the merged one; a behaviour that differs, stop and report.

## Global Constraints

- **Byte for byte.** Every command line, argument, timeout, one-at-a-time guard, refusal sentence and log line stays as it is: `orca terminal send|switch`, `wezterm cli activate-pane --pane-id`, `herdr agent focus`, `/usr/bin/open -b`, `/usr/bin/open claude://code/continue?session=…`, the 10 s `RUN_TIMEOUT_MS`, `[device] open · <app> · fallback`, `[device] voice · <what>`, `[observed] …`.
- **The guard.** `devices.spec.ts`, `cableHost.spec.ts`, `cableSession.spec.ts` and the e2e suites are not edited: they pass before and after. In `observed.spec.ts`, `open.spec.ts` and `orca.spec.ts` only how the fakes are built changes, and the three places Tasks 3, 7 and 8 name. **Any other expected value that has to change is a finding: stop and report it. It is never fixed by editing the test.**
- **The two fixes are the exception to both lines above, and only as far as their task says.** Task 13 changes four tab log lines, and their expectations in `devices.spec.ts` and `dialTerminalFollow.e2e.ts`. Task 12 adds tests to `devices.spec.ts` and changes how two of its helpers are built. No other expectation changes in either: one that has to is a finding.
- **The order** an agent's panes are kept in: herdr, WezTerm, Orca, the Claude app, tabs. **Each verb uses the first pane whose adapter can do it:** words the first with `type`, a rest the first whose `canShow` says yes, a tap the first whose `canFocus` says yes. An agent two apps name keeps every route it has today.
- **Hint sets.** A contract test's real hints are the ones the existing specs and e2e already hold for that app. Nothing is captured from a person's own apps.
- **Outside text.** A hint is checked against its own form in its adapter's `paneOf`, and the pane's id again in each verb before it reaches a command. Every command runs with no shell, each value one argument. No log line holds a handle, a session id, a pane id or a tty.
- **Not added:** an `onChange` or events member on `HostSource`; a registry merge by host identity; capability merging; an agent-route interface for the Claude Code mod; `cable_features`; any option, setting or member nobody calls.
- **Core.** Nothing in `cli/src/core/`. `architecture.coreFiles.txt` is unchanged.
- **Firmware.** `devices/harness-device` only. No flashing, no release, no `version.txt` change. Harness Pro is untouched. The daemon's refusal in `cableSession.ts` stays.
- **Platforms.** macOS: every adapter. Linux and Windows: only a pane's own command focuses (Orca, WezTerm, herdr); the Claude app link, the bundle opener and tabs are off, as today.
- **Repo rules.** `src/services` stays at 100% per file. Tests never touch the developer's real `~/.claude`, daemon (port 18473), tmux server or dial. No fixed sleeps.

## Review Focus

1. **Hints that name two panes at once.** Each route is kept, as today: herdr or WezTerm inside an Orca terminal still takes the dial's words and a rest through Orca, and herdr inside Terminal, iTerm2 or Ghostty with a watch open still writes its tab select, on a rest and after a tap. Task 7's two corner pins.
2. **The same pane named again while the dial's words wait for the mod.** They are still typed: the pane that types is compared by adapter and id, never by object. Task 7 (`an event from the same pane while the mod is waited for does not cancel the words`).
3. **An agent that moved to another app's pane while a tap's `open -b` ran.** The tap answers what `open` answered and runs no second command. Task 7 (`an agent resumed in an Orca terminal while open ran gets no command`).
4. **A pane whose adapter the opener was not given** (a list built wrong at the wiring, a wave 1 adapter added to one list only). Nothing throws; the app alone comes forward; no fallback line. Task 8 (`a pane of an adapter the opener does not hold is no pane`).
5. **A dial row that loses `a` while its choices are open.** [select], [review] and [send] do nothing; [back] still leaves. Task 9 (the block's `STALE` lines).

---

### Task 0: The base (a note, no code)

**Depends on:** #4311, #4326 and #4331 merged into `main`. **Effort:** none. **Red test:** none: no code.

- [ ] Rebase `feat/device-host-adapter` onto `origin/main` once all three are merged.
- [ ] Re-read `cli/src/cable/hosts/observed.ts`, `open.ts` and `cli/src/services/devices.ts` as merged before starting Task 1, with `observed.spec.ts`, `open.spec.ts` and `devices.spec.ts`.
- [ ] Check the union this plan names is there: `ObservedActions` holds `orcaSend`, `orcaSwitch`, `canOpen`, `open`, `claudeInFront`, `claudeShow`, `tabsOpen`, `tabSelect`, `modReady`, `toMod`, `count`; `ShownPane` has kinds `orca`, `claude`, `tty`; `createOpenActions` answers `can`, `open`, `claudeShow`; `devices.ts` holds `noteLink` and `selected`.
- [ ] A name that differs: the tasks' Interfaces still hold, use the merged name. A behaviour that differs (an order, a guard, a line): stop and report, as the plan was written against the union.
- [ ] `cd cli && node -p process.arch` prints `arm64`; `npm ci`; `npx vitest run src/cable/hosts src/services/devices.spec.ts` passes before any change.

### Task 1: The adapter's shape

**Layer:** devices service process. **Depends on:** Task 0. **Effort:** `medium`.

**Red test:** none: no behavior. Types, and one `export` keyword.

**Files:**
- Create: `cli/src/cable/hosts/adapter.ts`
- Modify: `cli/src/cable/hosts/open.ts` (`OPEN` gains `export`; nothing else)

**Interfaces:**
- Produces, in `adapter.ts`, the spec's interface as the spec writes it ("The interface"): `Place`, `Pane` and `HostAdapter`, `tap` its last member, every comment the spec gives a type or a member kept word for word. One comment is added, on `id`; the block shows it and no other:
  ```ts
  import type { PaneSwitch } from './types.js'

  export interface Place {
    host: string                                  // detectHost
    app: string                                   // detectApp
    hints: Readonly<Record<string, string>>       // that event's host hints, as the core checked them
    tty?: string                                  // its process's tty, read for a tab app (observed.ts learnTty)
  }

  export interface Pane {
    adapter: string
    id: string
  }

  export interface HostAdapter {
    /** Its app's short name, fixed in its file: the word its log lines say (`[device] open · <id> · fallback`,
     *  `[device] voice · <id>`), never a value from a hook. */
    readonly id: string
    paneOf(place: Place): Pane | undefined
    canFocus(pane: Pane): boolean
    focus(pane: Pane): Promise<boolean>
    canShow?(pane: Pane): boolean
    show?(pane: Pane, agentId: string): Promise<PaneSwitch>
    type?(pane: Pane, text: string): Promise<boolean>
    readonly tap: 'before' | 'instead' | 'after'
  }
  ```
- `Pane` stays one adapter's handle on one agent. That an agent has several is the source's to keep (`Entry.panes`, Task 7), so no type here holds a list.
- The file's header says the two layers (sources list agents, adapters are their apps) and the four rules every adapter keeps:
  1. `paneOf` checks each hint against its own form, and each verb checks the pane's id again before a command.
  2. An adapter is a plain object from a factory. No member uses `this`, so a caller may wrap one by spreading it.
  3. A verb that cannot run answers `false` or `'failed'`. It never throws.
  4. An agent may have a pane in more than one adapter: the source keeps them all, and each verb uses the first whose adapter can do it. So `paneOf` answers from its own app's values alone, never from another app's being absent.
- Produces, in `open.ts`: `export const OPEN = '/usr/bin/open'`, with its comment.

- [ ] **Step 1: Write** `adapter.ts` and add the `export`.
- [ ] **Step 2: Run** `cd cli && npm run typecheck && npx vitest run src/cable/hosts/open.spec.ts`. Expected: PASS.
- [ ] **Step 3: Commit** `devices: the shape of an app the dial reaches an outside agent through`.

### Task 2: Orca

**Layer:** devices service process. **Depends on:** Task 1. **Effort:** `high`.

**Red test:** `cli/src/cable/hosts/orca.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/orca.ts`
- Test: `cli/src/cable/hosts/orca.spec.ts`

**Interfaces:**
- Produces: `export function createOrcaAdapter(deps: OrcaDeps): HostAdapter & Required<Pick<HostAdapter, 'show' | 'type'>>`
  - `id: 'orca'`, `tap: 'before'`, no `canShow`.
  - `paneOf(place)`: `place.hints.ORCA_TERMINAL_HANDLE` when it passes `ORCA_HANDLE`, as `{ adapter: 'orca', id }`.
  - `canFocus`: `true` on every platform.
  - `focus(pane)`: `switchTo(pane.id)` answered `'ok'`. `show(pane)`: what `switchTo(pane.id)` answers. `type(pane, text)`: `send(pane.id, text)`.
- It is built on `createOrcaActions(deps)`, whose code does not change. `createOrcaActions` stays exported for now: `devices.ts` calls it until Task 7, and Task 8 takes the `export` away.

- [ ] **Step 1: Write the failing tests:**
  - The existing `describe('Orca actions')` runs through the adapter. Its `createOrcaActions(deps)` becomes one local helper: `send(handle, text)` is `adapter.type({ adapter: 'orca', id: handle }, text)`, and `switchTo(handle)` is `adapter.show({ adapter: 'orca', id: handle }, 'a1')`. No `it` body changes: these are the adapter's "same arguments as before".
  - `its id is orca, it taps before its app, and can focus on every platform` (`darwin`, `linux`, `win32`; `canShow` is undefined).
  - `paneOf takes a terminal handle in its own form, and refuses any other`: `{ ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE }`, alone and beside `__CFBundleIdentifier: 'com.stablyai.orca'`, give `{ adapter: 'orca', id: HANDLE }`. `term_0f8e2c1a`, `` `${HANDLE}; rm -rf /` ``, `--help`, `''` and hints with no handle give undefined. `host`, `app` and `tty` change nothing.
  - `focus is the switch: true only when it exits 0`: one run, `[orca, ['terminal', 'switch', '--terminal', HANDLE, '--json'], 10_000]`; exit 1 is false; a pane id not in its form is false and runs nothing.
  - `its members work when called apart from it` (`const { paneOf, focus, show, type } = adapter`).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/orca.spec.ts`. Expected: FAIL (`createOrcaAdapter` is not exported).
- [ ] **Step 3: Implement** `createOrcaAdapter`.
- [ ] **Step 4: Run** the step 2 command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: Orca is an adapter`.

### Task 3: The Claude app

**Layer:** devices service process. **Depends on:** Task 1. **Effort:** `high`.

**Red test:** `cli/src/cable/hosts/claudeApp.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/claudeApp.ts`
- Test: `cli/src/cable/hosts/claudeApp.spec.ts`

**Interfaces:**
- Consumes: `OPEN` (`open.ts`, Task 1), `RUN_TIMEOUT_MS` and `type OrcaDeps` (`orca.ts`), `APP_BUNDLES` (`hostDetect.ts`).
- Produces: `export function createClaudeAppAdapter(deps: Pick<OrcaDeps, 'run' | 'platform'> & { inFront(): boolean }): HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>>`
  - `id: 'claude'`, `tap: 'instead'`, no `type`.
  - `CLAUDE_SESSION = /^local_[A-Za-z0-9-]{1,64}$/`, with its comment from `open.ts`. The link is `OPEN` with the one argument `` `claude://code/continue?session=${pane.id}` ``, under `RUN_TIMEOUT_MS`.
  - `paneOf(place)`: only when `hints.__CFBundleIdentifier === APP_BUNDLES.claude` and `hints.CLAUDE_CODE_HOST_SESSION_ID` passes `CLAUDE_SESSION`.
  - `canFocus(pane)`: the platform is `darwin`.
  - `focus(pane)`: false off macOS or for an id not in its form, and then nothing runs; else whether the link exits 0.
  - `canShow(pane)`: `canFocus(pane) && deps.inFront()`, asked each time.
  - `show(pane, agentId)`: `'failed'` off macOS or for an id not in its form; `'busy'` while a `show` link for that agent still runs; else `'ok'` or `'failed'` by the link's exit. Its set of agents is its own: a `focus` neither waits for it nor is refused by it.

- [ ] **Step 1: Write the failing tests** (`SESSION = 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'`, `CLAUDE = 'com.anthropic.claudefordesktop'`):
  - `its id is claude, and its link takes the place of open -b` (`tap` is `'instead'`; `type` is undefined).
  - `paneOf takes a local_ session of the Claude app's own, and refuses any other`: `{ __CFBundleIdentifier: CLAUDE, CLAUDE_CODE_HOST_SESSION_ID: SESSION }` gives `{ adapter: 'claude', id: SESSION }`. Undefined for: the same session under `com.mitchellh.ghostty`, or with `TERM_PROGRAM: 'ghostty'` and no bundle; the bundle alone; `local_`, `local_a/b`, `local_x&source=y`, `local_` and 65 `a`, `session_abc`, `--args`, a bare uuid.
  - `canFocus is macOS only; canShow also needs the app in front, asked each time` (`darwin`, `linux`, `win32`; `inFront` flipped between two calls).
  - `focus runs the continue link alone`: one run, `['/usr/bin/open', ['claude://code/continue?session=' + SESSION], 10_000]`; exit 1 and no exit (`null`) are false; on Linux, and for a forged id, false and no run.
  - The five tests of `describe('a rest on a Claude app session')` in `open.spec.ts`, with `adapter.show({ adapter: 'claude', id }, agentId)` where they call `opener.claudeShow(agentId, id)`, and the same expected runs, answers and empty logs: `runs the continue link, and nothing else`; `a link that exits non-zero, or never exits, is failed, and no app is brought forward`; `an id not in the link's form never reaches open`; `on Linux and Windows nothing runs`; `a link still running drops the next for that agent, and another agent's runs`.
  - `a focus is not refused while a show's link runs, and a show is not busy while a focus runs` (both links run: four runs, as `open.spec.ts`'s tap-and-rest test counts them).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/claudeApp.spec.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement** `claudeApp.ts`. `open.ts` is not touched: its copy goes in Task 8.
- [ ] **Step 4: Run** the step 2 command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: the Claude app is an adapter`.

### Task 4: Tabs

**Layer:** devices service process, and the CLI's watch. **Depends on:** Task 1. **Effort:** `high`.

**Red test:** `cli/src/cable/hosts/tabs.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/tabs.ts`
- Test: `cli/src/cable/hosts/tabs.spec.ts`

**Interfaces:**
- Produces:
  - `export interface TabsDeps { isOpen(): boolean; select(tab: Tab, raise: boolean): boolean }`
  - `export function createTabsAdapter(deps: TabsDeps): HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>>`
  - `id: 'tabs'`, `tap: 'after'`, no `type`.
  - `paneOf(place)`: when `isTabApp(place.app)` and `place.tty` passes `TAB_TTY`, `{ adapter: 'tabs', id: place.app + ':' + place.tty }` (for example `terminal-app:/dev/ttys023`). Hints change nothing.
  - A pane's id is read back by its first `:` and checked with `tabOf`. One that fails writes nothing.
  - `canFocus(pane)` and `canShow(pane)`: `deps.isOpen()`, asked each time.
  - `show(pane)`: `deps.select(tab, false)` answered as `'ok'` or `'failed'`. `focus(pane)`: `deps.select(tab, true)`. Both answer at once: the line is written before the call returns.
- `tabs.ts` still imports nothing of the daemon: `adapter.ts` and `types.ts` by `import type` only, as the CLI's watch loads this file.

- [ ] **Step 1: Write the failing tests:**
  - `its id is tabs, and it is raised after its app` (`tap` is `'after'`; `type` is undefined).
  - `paneOf takes a tab app and a tty, and refuses any other`: each of `TAB_APPS` with `/dev/ttys023` gives `{ adapter: 'tabs', id: '<app>:/dev/ttys023' }`. Undefined for app `orca`, `vscode`, `terminal`; no tty; `/dev/pts/3`; `/dev/ttys023; rm`.
  - `canFocus and canShow are the stream being open, asked each time`.
  - `show writes one select that does not raise, and focus one that does`: `select` is called `[{ app: 'terminal-app', tty: '/dev/ttys023' }, false]`, then `[…, true]`; `show` is `'ok'`, and `'failed'` when `select` answers false; `focus` is true, then false.
  - `a pane id not in its form writes nothing`: `orca:/dev/ttys023`, `terminal-app`, `terminal-app:/dev/pts/3`, `terminal-app:/dev/ttys023:x`, `''` give `'failed'` and false, and `select` is never called.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/tabs.spec.ts`. Expected: FAIL (`createTabsAdapter` is not exported).
- [ ] **Step 3: Implement** `createTabsAdapter`.
- [ ] **Step 4: Run** the step 2 command, `npx vitest run src/devices src/services/devicesListener.spec.ts` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: a terminal tab is an adapter`.

### Task 5: WezTerm

**Layer:** devices service process. **Depends on:** Task 1. **Effort:** `medium`.

**Red test:** `cli/src/cable/hosts/wezterm.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/wezterm.ts`
- Test: `cli/src/cable/hosts/wezterm.spec.ts`

**Interfaces:**
- Consumes: `RUN_TIMEOUT_MS`, `type OrcaDeps` (`orca.ts`).
- Produces: `export function createWeztermAdapter(deps: OrcaDeps): HostAdapter`
  - `id: 'wezterm'`, `tap: 'before'`, no `show`, `canShow` or `type`. `canFocus`: `true`.
  - `WEZTERM_PANE = /^[0-9]{1,9}$/` and `APP_WEZTERM = '/Applications/WezTerm.app/Contents/MacOS/wezterm'`, from `open.ts`.
  - `paneOf(place)`: `hints.WEZTERM_PANE` when it passes.
  - `focus(pane)`: the binary is `deps.onPath('wezterm')`, else on macOS `APP_WEZTERM` when `deps.exists` says so, else none (false). Then `[wezterm, ['cli', 'activate-pane', '--pane-id', pane.id], RUN_TIMEOUT_MS]` exits 0.

- [ ] **Step 1: Write the failing tests:**
  - `its id is wezterm, it taps before its app, and it has no show and no type`.
  - `paneOf takes a pane number, and refuses any other`: `{ WEZTERM_PANE: '7' }` and `{ TERM_PROGRAM: 'WezTerm', WEZTERM_PANE: '3' }` give their pane. Undefined for `7; rm -rf /`, `--help`, `-1`, `'7 '`, `1234567890`, `''`.
  - `focus activates the pane`: `['/fake/bin/wezterm', ['cli', 'activate-pane', '--pane-id', '7'], 10_000]`; exit 1 and `null` are false.
  - `WezTerm's own binary is used on macOS when PATH has none` (`exists` is asked `[APP_WEZTERM]` only).
  - `on Linux with none on PATH nothing runs, and the app's binary is never looked for`.
  - `a pane id not in its form runs nothing`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/wezterm.spec.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement** `wezterm.ts`. `open.ts` is not touched.
- [ ] **Step 4: Run** the step 2 command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: WezTerm is an adapter`.

### Task 6: herdr

**Layer:** devices service process. **Depends on:** Task 1. **Effort:** `medium`.

**Red test:** `cli/src/cable/hosts/herdr.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/herdr.ts`
- Test: `cli/src/cable/hosts/herdr.spec.ts`

**Interfaces:**
- Consumes: `RUN_TIMEOUT_MS`, `type OrcaDeps` (`orca.ts`).
- Produces: `export function createHerdrAdapter(deps: OrcaDeps): HostAdapter`
  - `id: 'herdr'`, `tap: 'before'`, no `show`, `canShow` or `type`. `canFocus`: `true`.
  - `HERDR_PANE = /^w[0-9]{1,9}:p[0-9]{1,9}$/`, with its comment from `open.ts`.
  - `paneOf(place)`: `hints.HERDR_PANE_ID` when it passes.
  - `focus(pane)`: `deps.onPath('herdr')`, else false; then `[herdr, ['agent', 'focus', pane.id], RUN_TIMEOUT_MS]` exits 0.

- [ ] **Step 1: Write the failing tests:**
  - `its id is herdr, it taps before its app, and it has no show and no type`.
  - `paneOf takes a pane id, and refuses any other`: `{ HERDR_PANE_ID: 'w1:p2' }`, alone and beside `__CFBundleIdentifier: 'com.mitchellh.ghostty'`, give `{ adapter: 'herdr', id: 'w1:p2' }`. Undefined for `--help`, `w1:p1; rm -rf /`, `w1`, `' w1:p1'`, `w1:t1`, `p1`.
  - `focus focuses the agent`: `['/fake/bin/herdr', ['agent', 'focus', 'w1:p2'], 10_000]`; exit 1 and `null` are false.
  - `with no herdr on PATH nothing runs`; `a pane id not in its form runs nothing`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/herdr.spec.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement** `herdr.ts`. `open.ts` is not touched.
- [ ] **Step 4: Run** the step 2 command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: herdr is an adapter`.

### Task 7: Words and rests ask the adapters

**Layer:** devices service process. **Depends on:** Tasks 2, 3, 4, 5, 6. **Effort:** `xhigh` (which terminal the dial's words are typed into; three races it must keep; an agent two apps name).

**Red test:** `cli/src/cable/hosts/observed.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts`, `cli/src/services/devices.ts`
- Test: `cli/src/cable/hosts/observed.spec.ts`
- Guard: `cli/src/services/devices.spec.ts`. No expectation of it changes. A test is added only if `npm run test:core` names a line of `devices.ts` no test reaches.

**Interfaces:**
- Consumes: the five factories of Tasks 2 to 6; `HostAdapter`, `Pane`, `Place`.
- Produces, in `observed.ts`:
  ```ts
  export interface ObservedActions {
    /** The apps an agent may run in, in the order its panes are kept: each verb uses the first pane whose adapter can do it. */
    adapters: readonly HostAdapter[]
    modReady(sessionId: string): boolean
    toMod(sessionId: string, text: string): Promise<Delivery>
    canOpen(target: OpenTarget): boolean
    open(agentId: string, target: OpenTarget): Promise<boolean>
    /** The route (`mod`, or the id of the adapter that typed) or the refusal. */
    count(what: string): void
  }
  ```
  `orcaSend`, `orcaSwitch`, `claudeInFront`, `claudeShow`, `tabsOpen`, `tabSelect`, `ShownPane` and `shownPane` are gone. `canOpen`, `open` and `Entry.opens` stay as they are until Task 8.
- `Entry.handle` goes. `Entry` gains:
  - `hints`: its latest event's, `{}` for a session the scan found;
  - `panes: readonly { adapter: HostAdapter; pane: Pane }[]`: every pane an adapter recognises of it, each beside its adapter, in the adapters' order. `[]` with no `actions`, and for a session the scan found until its first event.
- One private `first(e, can)`: the first of `e.panes` for which `can(adapter, pane)` is true. The verbs differ only in their `can`:

  | Verb | `can(adapter, pane)` | Today's rule it is |
  |---|---|---|
  | Words | `!!adapter.type` | `e.handle`: an Orca terminal, whatever else names the agent |
  | A rest | `!!adapter.show && (adapter.canShow?.(pane) ?? true)` | `shownPane`: Orca's, else the Claude app's in front, else a tab with a watch open |
  | A tap's pane (Task 8) | `adapter.tap !== 'after' && adapter.canFocus(pane)` | `open.ts` `paneOf` and `paneOn` |

- What moves, rule by rule:

  | Today | After |
  |---|---|
  | `ingest` sets `entry.handle` from `ORCA_TERMINAL_HANDLE` | `ingest` sets `entry.hints`, then one private `locate(entry)`: every adapter is asked `paneOf({ host, app, hints, tty })`, and each answer is kept, in the adapters' order. On every event, a session's end too, and afresh each time: no pane of an earlier event stays |
  | `learnTty` sets and clears `entry.tty` | The same, and it calls `locate(entry)` each time the tty is cleared or a read lands |
  | `capabilities().voice`: `!!e.handle` or the mod | `first(e, words)` answers a pane, or the mod |
  | `send`: the handle read before the mod is waited for, `e.handle !== handle` after; `actions.orcaSend`; `count('orca')` | The pane that types (`first(e, words)`) read before, and read again after: none now, or one whose `adapter` or `id` differs, is the refusal `e.handle !== handle` gave. Then `adapter.type(pane, text)` and `count(adapter.id)`. Every refusal, its order and its sentence as they are |
  | `hasPane`, `showPane`, `shownPane` and its `switch` | One private `shown(agent)`: `first(e, rest)` of the live entry, asked at each look. `hasPane` is whether it answers; `showPane` is `adapter.show(pane, agent.id)`, else `'failed'` |
  | `focus`: after `open` answered true, `shownPane` of kind `tty` writes `tabSelect(app, tty, true)` | After `open` answered true, `shown(agent)` is read again: when its adapter's `tap` is `'after'` and `canFocus(pane)`, `await adapter.focus(pane)`. Any other shown pane, or none, runs nothing. `focus` answers what `open` answered |
  | `byTab`, `learnTty`'s `isTabApp` gate, `waitingOn`, states, the scan, `tick`, `checkWorking` | Unchanged |

- Produces, in `devices.ts` (the wiring only):
  - `orca = createOrcaAdapter(apps)`; `claude = createClaudeAppAdapter({ ...apps, inFront: () => cableHost.latestFront() === 'claude' })`.
  - The tabs adapter's `select` is today's `tabSelect` body: `tabs.select(tab, raise)`, and `selected(tab.tty)` when it was written.
  - `adapters = [createHerdrAdapter(apps), createWeztermAdapter(apps), orca, { ...claude, show: (pane, agentId) => { noteLink(agentId); return claude.show(pane, agentId) } }, tabsAdapter]`.
  - `ObservedActions` is `{ adapters, modReady, toMod, canOpen, open, count }`. `canOpen`, `open` and its `noteLink` wrapper do not change.
  - Until Task 8 the opener is still `createOpenActions({ ...apps, orcaSwitch: (handle) => orca.focus({ adapter: orca.id, id: handle }), log })`.

- [ ] **Step 1: Write the pins**, in `observed.spec.ts`, with `fakeActions` as it is. Each states what the code does today. Run `cd cli && npx vitest run src/cable/hosts/observed.spec.ts`. Expected: PASS. One that fails means the base is not what this plan read: stop and report.
  - `one Orca session its hook told of, then the open scan found, is listed once and keeps its Orca pane` (the spec's Done when 4): a `session-start` with `{ ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE }`, then the same session in the scan's owners and rows, with an `apps` reader. After `scanOpen()`: one agent, `host: 'orca'`, no `appPending`, `apps` never called, `hasPane` true, `showPane` `'ok'` with `orcaSwitch` called `[[HANDLE]]`, capabilities `voice` and `focus` true.
  - `an event from the same pane while the mod is waited for does not cancel the words`: a `turn-stop` with the handle, a `send` held on `toMod`, a `session-start` with the same handle, then `'missed'`: `{ ok: true }`, and `orcaSend` called `[[HANDLE, 'run the tests']]`.
  - `herdr or WezTerm inside an Orca terminal still takes the dial's words and a rest through Orca` (the first corner), once for `{ HERDR_PANE_ID: 'w1:p2', ORCA_TERMINAL_HANDLE: HANDLE }` and once for `{ WEZTERM_PANE: '7', ORCA_TERMINAL_HANDLE: HANDLE }`, after a `turn-stop`:
    - capabilities `voice` and `focus` are true;
    - `send(agent, 'next')` is `{ ok: true }`, `orcaSend` called `[[HANDLE, 'next']]`, `count` last called `'orca'`;
    - `hasPane` is true, `showPane` is `'ok'`, `orcaSwitch` called `[[HANDLE]]`;
    - a tap is true, `open` called once, and `open.mock.calls[0][1].pane?.id` is `'w1:p2'` (`'7'`): the multiplexer's pane, not the Orca terminal. Read by `id` alone, so the line stands when Task 8 renames the pane's other key.
  - `herdr inside Ghostty with a watch open still writes its tab select, on a rest and after a tap` (the second corner), in `describe('ObservedSource tabs')` with its `tabs()` helper: a `session-start` with `{ HERDR_PANE_ID: 'w1:p2', __CFBundleIdentifier: 'com.mitchellh.ghostty' }`, its tty read answered `TTY`:
    - `hasPane` is true, `showPane` is `'ok'`, `tabSelect` called `[['ghostty', TTY, false]]`;
    - a tap is true: `open` called once, its target's pane `id` `'w1:p2'`, then `tabSelect` last called `['ghostty', TTY, true]`, two calls in all;
    - `byTab('ghostty', TTY)` answers the agent; `orcaSend` and `orcaSwitch` are never called;
    - with `tabsOpen` false: `hasPane` is false, `showPane` is `'failed'`, and a tap calls `open` and writes no select.
  - Not written again: Orca over a tab. `an agent with an Orca handle is shown by Orca, whatever its app` and `with no stream a tap only opens; a tap on an agent with an Orca handle writes no select` hold it since #4331.

- [ ] **Step 2: Write the failing tests.** `fakeActions` keeps every mock and its name, and builds `adapters` from them over the real factories with an inert runner (`ran`, a `vi.fn`):
  - herdr and WezTerm as they are; Orca with `type` and `show` replaced by `orcaSend(pane.id, text)` and `orcaSwitch(pane.id)`; the Claude app (built for the platform the helper is given, `darwin` by default, `inFront` from `claudeInFront`) with `show` replaced by `claudeShow(agentId, pane.id)`; tabs over `{ isOpen: tabsOpen, select: (tab, raise) => tabSelect(tab.app, tab.tty, raise) === 'ok' }`.
  - No `it` body changes, but one: in `hasPane: a Claude app session, where a tap can open it, while the Claude app is in front`, the `canOpen` call assertion and the `canOpen.mockReturnValueOnce(false)` pair give way to "a source whose adapters were built for `linux` answers `hasPane` false for the same event".
  - Every suite that reads `fakeActions` now fails, the four pins too, as the source does not read `adapters` yet. The two corner pins are this task's red tests for the rule: a source that kept one pane per agent leaves both red.
  - `an app the source never heard of costs one adapter, and what it cannot do falls to the next pane`: a made-up adapter first in the list (`id: 'made-up'`, `tap: 'before'`, `paneOf` answers `{ adapter: 'made-up', id: 'p1' }` for `hints.MADE_UP === 'p1'`, `canFocus` true, and `focus`, `canShow`, `show`, `type` as mocks, `canShow` true).
    - After a `turn-stop` with `{ MADE_UP: 'p1', ORCA_TERMINAL_HANDLE: HANDLE }`: `paneOf` was last called with `{ host: 'terminal', app: 'terminal', hints }`; `voice` is true; `send` is `{ ok: true }`, `type` called `[[pane, 'next']]`, `count` last called `'made-up'`, `orcaSend` never; `showPane` answers what `show` said, called `[[pane, agent.id]]`, `orcaSwitch` never.
    - With its `canShow` false: `hasPane` is still true, and `showPane` is `'ok'` through `orcaSwitch`, called `[[HANDLE]]`; `show` is not called again.
    - Built with no `type`: `voice` is true, `send` is `{ ok: true }` through `orcaSend`, called `[[HANDLE, 'next']]`, and `count` last called `'orca'`.
    - With `{ MADE_UP: 'p1' }` alone, no pane is left to fall to: `canShow` false gives `hasPane` false and `showPane` `'failed'`; no `type` gives `voice` false and `send` `'proj did not answer.'`.
  - `an agent resumed in an Orca terminal while open ran gets no command`: a tab agent with its tty, a tap held on `open`, a `turn-start` from the same pid with the Terminal bundle and `ORCA_TERMINAL_HANDLE`, then `open` answers true: the tap is true, and `tabSelect`, `orcaSwitch` and `ran` are never called (the pane a rest would show is now Orca's, which does not tap after its app).
- [ ] **Step 3: Run** the step 1 command. Expected: FAIL (`orcaSend` and the other old members are never called; the made-up adapter is never asked).
- [ ] **Step 4: Implement** `observed.ts`, then the wiring in `devices.ts`.
- [ ] **Step 5: Run** `cd cli && npx vitest run src/cable src/services/devices.spec.ts && npm run typecheck && npm run test:core`. Expected: PASS, with no edit to `devices.spec.ts`, `cableHost.spec.ts` or `cableSession.spec.ts`, and 100% for `services/devices.ts`.
- [ ] **Step 6: Commit** `devices: the dial's words and a rest ask the agent's adapter`.

### Task 8: Taps ask the adapters

**Layer:** devices service process. **Depends on:** Task 7. **Effort:** `xhigh` (hook text reaches command lines here; the order of a tap's commands; which of an agent's panes a tap takes).

**Red test:** `cli/src/cable/hosts/open.spec.ts`, `cli/src/cable/hosts/observed.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/open.ts`, `cli/src/cable/hosts/observed.ts`, `cli/src/cable/hosts/orca.ts`, `cli/src/services/devices.ts`
- Test: `cli/src/cable/hosts/open.spec.ts`, `cli/src/cable/hosts/observed.spec.ts`
- Guard: `cli/src/services/devices.spec.ts`, as in Task 7.

**Interfaces:**
- Produces, in `open.ts`:
  ```ts
  /** What a tap can open of an agent: its app, by bundle id, and its own pane in it. */
  export interface OpenTarget { bundle?: string; pane?: Pane }          // Pane is adapter.ts's
  /** The bundle a tap brings forward: the app the agent's own window belongs to wins over its host's. */
  export function bundleOf(host: string, hints: Readonly<Record<string, string>>): string | undefined
  export interface OpenDeps { run: OrcaDeps['run']; platform: NodeJS.Platform; adapters: readonly HostAdapter[]; log(line: string): void }
  export function createOpenActions(deps: OpenDeps): { can(target: OpenTarget): boolean; open(agentId: string, target: OpenTarget): Promise<boolean> }
  ```
- What moves, rule by rule:

  | Today | After |
  |---|---|
  | `openTarget(host, hints)` | `bundleOf(host, hints)`: its bundle part, unchanged. `BUNDLES` stays |
  | `paneOf`, `WEZTERM_PANE`, `HERDR_PANE`, `CLAUDE_SESSION`, `APP_WEZTERM`, `Pane { app, id }`, the `focus` `switch`, `claudeShow` and its `showing` set, `OpenDeps.orcaSwitch` | Gone: each is in its adapter |
  | `paneOn(target)`: the pane unless it is the Claude app's off macOS | The target's pane when the opener holds its adapter, its `tap` is not `'after'`, and `canFocus(pane)`. The opener is handed one pane and never chooses among an agent's: the source does (below) |
  | `can(target)` | That pane, or on macOS a bundle |
  | After the pane's focus: `if (bundle && pane.app !== 'claude') forward(bundle)` | `if (bundle && adapter.tap === 'before') forward(bundle)` |
  | `` `[device] open · ${pane.app} · fallback` `` | `` `[device] open · ${adapter.id} · fallback` `` |
  | `running`, `forward`, `OPEN`, the order of `open` | Unchanged |

- In `observed.ts`: `Entry.opens` goes and `Entry.bundle?: string` comes, from `bundleOf` where `opens` was set. One private `target(e)` builds `{ bundle?, pane? }`, asked at each look: its pane is `first(e, a tap's pane)` of Task 7's table, the first of the agent's panes whose adapter's `tap` is not `'after'` and whose `canFocus` says yes. `capabilities().focus` and `focus` hand it to `canOpen` and `open`.
- A tap keeps its two parts, as today. Its pane goes to the opener, with the bundle. Then, once `open` answered true, Task 7's tail raises the pane a rest would show when that pane taps after its app. So for herdr inside Ghostty with a watch open the target's pane is herdr's and the tab's select is still written; for a tab app's agent that also has an Orca terminal the target's pane is Orca's and no select is written.
- Today's choice is kept: `open.ts` took the first of herdr, WezTerm, Orca and the Claude app that the hints name, then dropped the Claude app's off macOS. The first three can always focus and the Claude app is asked last, so "the first whose `canFocus` says yes" picks the same pane.
- In `devices.ts`: `opener = createOpenActions({ run: apps.run, platform: apps.platform, adapters, log })`. The `open` wrapper's test reads `target.pane?.adapter === claude.id && opener.can(target)`.
- In `orca.ts`: `createOrcaActions` loses its `export`.

- [ ] **Step 1: Write the failing tests.**
  - `open.spec.ts`: `recorder` builds the four adapters that run commands over its recording runner, and a tabs adapter with no stream open, and hands the five to `createOpenActions`. Orca's `focus` is replaced by one that pushes to `switched` and answers what `over.orcaSwitch` says, true by default. `target(hints)` is `{ bundle: bundleOf(detectHost(hints), hints), pane }`, the pane from the first of herdr, WezTerm, Orca, the Claude app whose `paneOf` answers. The direct `createOpenActions({…})` in `one command at a time per agent` takes the new deps with `adapters: []`. **No `it` body of `describe('opening an agent outside Harness from the dial')` changes.**
  - `describe('a rest on a Claude app session')` goes (its tests are `claudeApp.spec.ts`'s since Task 3), but `a tap is not refused while a rest's link runs, and a rest is not busy while a tap runs`, which stays with the adapter's `show` for `opener.claudeShow` and its four expected runs.
  - `a pane that taps before its app: its focus, then open -b; its focus failing, the line and open -b` (a made-up adapter: runs `[forward('com.apple.Terminal')]` after its `focus`; failing, the log is `['[device] open · made-up · fallback']`).
  - `a pane that taps instead of its app: its focus alone; open -b and the line only when it fails`.
  - `a pane that taps after its app is not the opener's`: with a bundle, `open -b` alone, its `focus` never called, no line; with none, `can` is false and nothing runs.
  - `a pane of an adapter the opener does not hold is no pane`: with a bundle, `open -b` alone and no line; with none, `can` is false.
  - `observed.spec.ts`: in `focus opens what its last event names…`, `pane: { app: 'orca', id: HANDLE }` reads `pane: { adapter: 'orca', id: HANDLE }`. Task 7's two corner pins stand as written: they read a target's pane by its `id`.
  - The made-up adapter's test gains, for `{ MADE_UP: 'p1', ORCA_TERMINAL_HANDLE: HANDLE }`:
    - a tap calls `open` with `[agent.id, { pane: { adapter: 'made-up', id: 'p1' } }]`, and its own `focus` is never called by the source;
    - with its `canFocus` false, the target's pane is `{ adapter: 'orca', id: HANDLE }`: the first that can;
    - built with `tap: 'after'`, the target's pane is Orca's too, and its `focus` is called once, with its pane, after `open` answered true; with `open` answering false, never;
    - built with `tap: 'after'` and its `canShow` false, the pane a rest would show is Orca's, so its `focus` is never called.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/open.spec.ts src/cable/hosts/observed.spec.ts`. Expected: FAIL (`bundleOf` is not exported; the opener reads no `adapters`).
- [ ] **Step 3: Implement.** Then `git grep -n -E "openTarget|ShownPane|shownPane|claudeShow|claudeInFront|orcaSwitch|orcaSend|tabSelect|tabsOpen" -- 'cli/src/**/*.ts' ':!cli/src/**/*.spec.ts'` prints nothing.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable src/services/devices.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts && npm run typecheck && npm run test:core`. Expected: PASS, with no edit to `devices.spec.ts`, and 100% for `services/devices.ts`.
- [ ] **Step 5: Commit** `devices: a tap asks the agent's adapter, and open.ts keeps what every app shares`.

### Task 9: The dial answers only where it can

**Layer:** the round dial's firmware. **Depends on:** none. **Effort:** `high`.

**Red test:** `devices/harness-device/firmware/test/test_touch_ui.py`.

**Files:**
- Modify: `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c`
- Test: `devices/harness-device/firmware/test/test_touch_ui.py`, `devices/harness-device/firmware/test/test_question_ui.py`

**Interfaces:**
- `render_question`: once the prompt and a speech error are drawn, and before the `can_text` branch, an agent that `agent_allows(s.q.agent, CABLE_CAP_A)` refuses gets `control(f, 122, 346, 187, "[ later ]", A_HOME, 0, true)` and nothing more. That is the loading question's own control, so it does not move when the question loads.
- The `case A_QUESTION_CHOICES:` block of `dispatch`: after its guard line, `A_QUESTION_CHOICES`, `A_CHOICE`, `A_QUESTION_REVIEW` and `A_ANSWER` `break` for such an agent. `A_QUESTION_BACK` and `A_QUESTION_SAY` keep their paths, the `CABLE_CAP_V` check included. The lines `    case A_QUESTION_CHOICES:` and `    case A_INBOX:` keep their text: two tests cut the block out by them.
- `agent_allows` does not change: a row with every letter, a row with no `caps`, and an agent not on the roster are as before.

- [ ] **Step 1: Write the failing test.** In `test_touch_ui.py`, after the line `portrait(dir,"caps-question-no-say");`:
  ```c
      // a question of an agent without A: the prompt and [ later ] only, and its answer actions do nothing
      for (int voice = 0; voice < 2; voice++) {
          reset(); s.view=QUESTION; s.q.valid=s.q.supported=true; s.q.count=1; s.q.revision=1;
          strcpy(s.q.agent,"a"); strcpy(s.q.token,"token-a"); strcpy(s.q.name,"Research helper");
          strcpy(s.q.item[0].prompt,"Bash: git push \xc2\xb7 answer in Orca"); s.q.item[0].count=1; s.q.item[0].can_text=voice;
          strcpy(s.q.item[0].options[0],"In Orca");
          ui_project_set_host_caps("a","orca",CABLE_CAP_S|(voice ? CABLE_CAP_V : 0)); scene_take();
          assert(scene_says("Bash: git push") && scene_says("[ later ]") && action_enabled(A_HOME));
          assert(!scene_says("[choices]") && !scene_says("[say]") && !scene_says("[next]") && !scene_says("[later]"));
          assert(!action_enabled(A_QUESTION_CHOICES) && !action_enabled(A_QUESTION_SAY) && !action_enabled(A_QUESTION_REVIEW));
          if (!voice) portrait(dir,"caps-question-no-answer");
          tap(2000,300,370); assert(s.view==QUESTION);                        // where [choices] was
          #define STALE(k) dispatch((action_t){.kind=(k),.revision=s.q.revision,.dy=s.q.index,.id="a"})
          STALE(A_QUESTION_CHOICES); assert(s.view==QUESTION);
          s.view=CHOICE; STALE(A_CHOICE); assert(!s.q.item[0].selected);
          s.q.item[0].selected=1; STALE(A_QUESTION_REVIEW); assert(s.view==CHOICE);
          strcpy(s.q.item[0].answer,"In Orca"); s.view=ANSWER_REVIEW; STALE(A_ANSWER);
          assert(!question_sends && !s.q.pending && s.view==ANSWER_REVIEW);
          STALE(A_QUESTION_BACK); assert(s.view==CHOICE);                      // back still leaves
          #undef STALE
      }
      // with every letter, and with no caps at all, the same question is as before
      for (int all = 0; all < 2; all++) {
          reset(); s.view=QUESTION; s.q.valid=s.q.supported=true; s.q.count=1; s.q.revision=1;
          strcpy(s.q.agent,"a"); strcpy(s.q.token,"token-a"); strcpy(s.q.name,"Research helper");
          strcpy(s.q.item[0].prompt,"Bash: git push \xc2\xb7 answer in Orca"); s.q.item[0].count=1;
          strcpy(s.q.item[0].options[0],"In Orca");
          if (all) ui_project_set_host_caps("a","orca",CABLE_CAPS_ALL);
          scene_take(); assert(scene_says("[choices]") && action_enabled(A_QUESTION_CHOICES));
          tap(2000,300,370); assert(s.view==CHOICE);
      }
  ```
  The prompt wraps before `Orca`, so no assertion reads across the two rows. The test's `dispatch` hands every question-view action to the question block, so `[ later ]` is checked by its hit, not by a tap.
- [ ] **Step 2: Run** `python3 devices/harness-device/firmware/test/test_touch_ui.py`. Expected: FAIL, `Assertion failed: (!scene_says("[choices]") && …)`.
- [ ] **Step 3: Implement** the two changes in `ui_habitat.c`. In `test_question_ui.py`, add `'CABLE_CAP_A'` to the `defines('ID_MAX','CABLE_NAME_MAX','CABLE_READ_TOKEN_MAX','CABLE_CAP_V')` call: it compiles `render_question` and the block, and its `agent_allows` allows everything, so none of its expectations changes.
- [ ] **Step 4: Run** `python3 devices/harness-device/firmware/test/test_touch_ui.py && python3 devices/harness-device/firmware/test/test_question_ui.py && IDF_PATH="$HOME/esp/esp-idf-5.5.4" make device-test`. Expected: `touch UI: PASS`, `question UI: PASS`, and the host suite ends with no error (about two and a half minutes on this Mac).
- [ ] **Step 5: Commit** `Round dial: a question of an agent that takes no answer shows its prompt and [ later ] only`.

### Task 10: Say it in the docs

**Layer:** repo files. **Depends on:** Task 8. **Effort:** `medium`.

**Red test:** none: no behavior.

**Files:**
- Modify: `cli/AGENTS.md`, `cli/src/services/AGENTS.md`

- [ ] **Step 1:** In `cli/AGENTS.md`, the `devices` row of "The processes": after "the agents outside a pane (from their hooks, `cable/hosts/observed.ts`)" add ", each app they run in one adapter (`cable/hosts/adapter.ts`)".
- [ ] **Step 2:** In `cli/src/services/AGENTS.md`, the paragraph "A service that drives hardware: the devices", add one sentence: "An app the dial reaches an outside agent through is one adapter file under `cable/hosts/` (`adapter.ts` has the interface), named once in `services/devices.ts`, in the order their panes are asked for; `observed.ts` and `open.ts` hold no rule about any app."
- [ ] **Step 3: Commit** `docs: an app the dial reaches an outside agent through is one adapter`.

### Task 11: The temporary workflow

**Layer:** GitHub Actions, temporary. **Depends on:** Tasks 8, 9, 12 and 13: every push to the branch starts its three jobs, one on macOS, so it goes in last. **Effort:** `medium`.

**Red test:** none: a temporary workflow, one commit. diegodev removes the file before the pull request, once Verification 1 has its evidence.

**Files:**
- Create: `.github/workflows/tmp-device-host-adapter.yml`

- [ ] **Step 1: Create the workflow** with exactly this content:
  ```yaml
  name: tmp device-host-adapter

  # TEMPORARY: removed before the pull request (docs/plans/2026-11-15-device-host-adapter-plan.md, Task 11).
  # The dial's end-to-end suites on macOS and Linux, and the round dial's ESP-IDF build, at every push to this
  # branch: PR CI runs no end-to-end suite and builds only the Harness Pro. No secret, nothing flashed, published
  # or written outside the run.
  on:
    push:
      branches: [feat/device-host-adapter]

  permissions:
    contents: read

  concurrency:
    group: tmp-device-host-adapter
    cancel-in-progress: true

  env:
    CLI_NODE_VERSION: 24.22.2

  jobs:
    dial-e2e:
      name: dial e2e (${{ matrix.os }})
      strategy:
        fail-fast: false
        matrix:
          os: [macos-15, ubuntu-latest]
      runs-on: ${{ matrix.os }}
      timeout-minutes: 45
      defaults:
        run:
          working-directory: cli
      steps:
        - uses: actions/checkout@v7
        - uses: actions/setup-node@v7
          with:
            node-version: ${{ env.CLI_NODE_VERSION }}
            cache: npm
            cache-dependency-path: cli/package-lock.json
        - name: tmux, the shells the tests launch through, and the locale (Linux, as cli-e2e.yml's shards)
          if: runner.os == 'Linux'
          run: |
            echo "LANG=C.UTF-8" >> "$GITHUB_ENV"
            echo "SHELL=/bin/zsh" >> "$GITHUB_ENV"
            sudo bash ../scripts/apt-install.sh tmux zsh tcsh dash lsof
            sudo sysctl -w fs.inotify.max_user_instances=1024 fs.inotify.max_user_watches=524288
            insecure=$(zsh -fc 'autoload -U compaudit && compaudit' 2>/dev/null | grep '^/' | sort -u || true)
            if [ -n "$insecure" ]; then
              echo "$insecure" | xargs sudo chown root:root
              echo "$insecure" | xargs sudo chmod g-w,o-w
            fi
        - name: tmux (macOS)
          if: runner.os == 'macOS'
          run: command -v tmux || brew install tmux
        - run: npm ci --no-audit --no-fund
        - name: The dial's end-to-end suites
          env:
            E2E_BUNDLE: '1'
            E2E_ARTIFACTS_DIR: ${{ runner.temp }}/e2e-daemon-logs
          run: >-
            npx vitest run --config vitest.e2e.config.ts
            e2e/deviceClaudeOrca.e2e.ts e2e/deviceWithoutApp.e2e.ts e2e/dialPaneFollow.e2e.ts
            e2e/dialClaudeAppFollow.e2e.ts e2e/dialTerminalFollow.e2e.ts e2e/dialAppFilter.e2e.ts
            e2e/dialAppFilterOnDial.e2e.ts e2e/devicesProcess.e2e.ts
        - name: Keep the failing tests' daemon logs
          if: ${{ failure() }}
          uses: actions/upload-artifact@v4
          with:
            name: tmp-dial-e2e-daemon-logs-${{ matrix.os }}
            path: ${{ runner.temp }}/e2e-daemon-logs/
            if-no-files-found: ignore

    round-firmware-build:
      name: round dial firmware build
      runs-on: ubuntu-24.04
      timeout-minutes: 20
      # The ESP-IDF release the dials are built with, as ci.yml's pro-firmware-build.
      container: espressif/idf:v5.5.4
      defaults:
        run:
          shell: bash
          working-directory: devices/harness-device/firmware
      steps:
        - uses: actions/checkout@v7
        - name: Build the ESP32-S3 firmware
          run: |
            . "$IDF_PATH/export.sh" > /dev/null
            idf.py -B build build
  ```
- [ ] **Step 2: Lint it.** Run `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/tmp-device-host-adapter.yml`, as `ci.yml` does. Expected: no output, exit 0.
- [ ] **Step 3: Commit** `Temporary workflow: the dial's end-to-end suites and the round dial's build for device-host-adapter`. A fault in this file that a push shows is fixed in a commit of its own.

### Task 12: One record of what the dial just showed (F2)

**Layer:** devices service process. **Depends on:** Tasks 8 and 13. **Effort:** `xhigh` (two settles racing the dial's own moves inside a second; an echo guard that must not grow wider).

**Red test:** `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts`
- Test: `cli/src/services/devices.spec.ts`

**The fault** (the spec, F2). Each settle looks only at its own app's record of the dial's moves: the Claude app's at `dialLinks`, a tab app's at `written`. So a rest or a tap on another kind of pane, inside the settle, is not seen, and the settle turns the dial back.

**Interfaces:**
- Consumes, as merged: `monotonic`, `ATTACH_ECHO_MS`, `noteLink`, `linkedByDial`, `claudeSettled`; `selected`, `written`, `TabReport`, `tabReported`, `followTab`; Task 8's `adapters` list; `HostAdapter` (`adapter.ts`).
- Produces, in `devices.ts`, beside the two echo notes:
  ```ts
  /** The dial's own moves on an agent outside Harness, a rest's and a tap's alike, whatever its pane: how many, and
   *  when the latest started. A settle is set aside by one made within it. */
  let dialMoves = 0
  let dialMovedAt: number | undefined
  const noteMove = (): void                                  // dialMoves++, dialMovedAt = monotonic()
  /** That adapter, its `show` and its `focus` noting the dial's move as they start: busy or failed, the dial is on that
   *  agent all the same. */
  const noting = (adapter: HostAdapter): HostAdapter
  ```
- Where a move is noted: the two verbs every adapter is reached through, and no rule about any app. That is the spec's list (Orca switch, Claude link, tab select, a tap's raise).
  - **A rest:** `noting` wraps `show`, for an adapter that has one. An adapter with no `show` gets none: the source reads `!!adapter.show` (Task 7).
  - **A tap's pane, and a tap's raise:** `noting` wraps `focus`, for every adapter. The opener calls it for a pane that taps before or instead of its app, the source for one that taps after.
- `adapters` is Task 8's list through `noting` (`[…].map(noting)`), the Claude app's `noteLink` wrap inside it. The one list goes to the source and the opener alike. `open` in `ObservedActions` does not change.
- What moves:

  | Today | After |
  |---|---|
  | `written`, counted in `selected(tty)`; `TabReport.written`; `followTab`'s `report.written !== written` | `dialMoves`; `TabReport.moves`, read in `tabReported`; `followTab`'s `report.moves !== dialMoves`, the same line. `selected(tty)` keeps `selects` only |
  | `claudeSettled`: `linkedByDial()`, any agent's link younger than `ATTACH_ECHO_MS` | `dialMovedAt !== undefined && monotonic() - dialMovedAt < ATTACH_ECHO_MS`, the same line (`[device] settle · skipped · echo`) |
  | `linkedByDial(agentId?: string)` | `linkedByDial(agentId: string)`: its any-agent form has no caller left |
  | `noteLink` (the Claude app's `show` wrap, and `open` for a Claude app pane), `dialLinks`, `claudeAttached`'s `linkedByDial(agentId)` | Unchanged: an attach is still its own agent's link's echo, within `ATTACH_ECHO_MS` |
  | `selects`, `ECHO_MS`, `ECHO_KEPT`, `followTab`'s match by tty | Unchanged: a report is still its own tty's select's echo, each select excusing one |

- The two readings of the one record (open question 1):
  - a tab app's settle: the dial moved since the report came, by count, as `written` is read today;
  - the Claude app's settle: the dial's latest move is younger than `ATTACH_ECHO_MS`, as `linkedByDial()` is read today. Its kept attach can be minutes old, so "since it came" would stop a Cmd-Tab back to the app from moving the dial.

- [ ] **Step 1: Build the fakes and write the pins.** Only how the helpers are built changes; no existing `it` body does.
  - In `describe('selecting a tab moves the dial …')`:
    - `dialWith(agents, run?)` hands `start` that runner in its `orca` deps when one is given.
    - `HANDLE = 'term_0123abcd-0000-4000-8000-0123456789ab'`; `switched = ['/opt/orca/bin/orca', ['terminal', 'switch', '--terminal', HANDLE, '--json'], 10_000]`.
    - `ORCA_AGENT = observedAgentId('claude', 'sess-orca')`, listed by `{ ...hook(9), sessionId: 'sess-orca', hostHints: { ORCA_AGENT_SESSION_ID: 'orca-1', ORCA_TERMINAL_HANDLE: HANDLE } }`.
    - `LOCAL = 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'`; `CLAUDE_AGENT = observedAgentId('claude', 'sess-claude')`, listed by `{ ...hook(8), sessionId: 'sess-claude', hostHints: { __CFBundleIdentifier: 'com.anthropic.claudefordesktop', CLAUDE_CODE_HOST_SESSION_ID: LOCAL } }`.
  - In `describe('the session the Claude app shows turns the dial …')`: `HANDLE` and `switched` as above; `dialWith` hands `start` a `tty` reader that answers `/dev/ttys023`, and returns its `listener`. No Claude app agent's tty is read: it is no tab app. `IN_ORCA` is that describe's own session id, so its agent is `observedAgentId('claude', IN_ORCA)`.
  - The pins. Each states what the code does today. Run `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: PASS. One that fails means the base is not what this plan read: stop and report.
    - `a report that came after the dial showed an Orca terminal moves the dial` (tab describe): `settle('terminal-app')`, a rest on `ORCA_AGENT`, `clock = 300`, `report('terminal-app', TTY)`: `asked()` is `[[ID, 'tab']]` and `tabLines()` is `[]`. The record sets aside a report that waited, never one that came later.
    - `a tap's raise sets aside the report its app made as it came forward` (tab describe, two agents, a runner that holds `open -b`): a tap on `agent(2)`; once `open -b com.apple.Terminal` has started, `listener.front('terminal-app')` and `report('terminal-app', ttyOf(1))`; then the run exits 0 and the tap answers. `stream.lines` is `[{ app: 'terminal-app', tty: ttyOf(2), raise: true }]`. After `FRONT_SETTLE_MS`: `asked()` is `[]`, `tabLines()` is `['[device] tab · skipped · echo']`. Today `written` holds it; after, the note on `focus` does.
    - `an attach within 2 s of the dial showing an Orca terminal is followed` (Claude describe): `dialWith('claude')`, an agent listed by `hook('session-start', { sessionId: IN_ORCA, hostHints: { ORCA_AGENT_SESSION_ID: 'orca-1', ORCA_TERMINAL_HANDLE: HANDLE } })`, a rest on it, `attach(SESSION)`: `asked()` is `[[A, 'attach']]` and `attaches()` is `[]`. An attach's echo is its own agent's link, never another pane's move.
- [ ] **Step 2: Write the failing tests.**
  - Tab describe, `a report waiting for the settle is set aside by another kind of pane the dial showed since it came (<way>)`, for three ways:

    | Way | The move | `orcaRuns` after it |
    |---|---|---|
    | a rest on an Orca terminal | `host().swipeEnded(ORCA_AGENT, 'rest')` | `[switched]` |
    | a tap on an Orca terminal | `await host().openAgent(ORCA_AGENT)` is undefined | `[switched, ['/usr/bin/open', ['-b', 'com.stablyai.orca'], 10_000]]` |
    | a tap on a Claude app session | `await host().openAgent(CLAUDE_AGENT)` is undefined | `[['/usr/bin/open', ['claude://code/continue?session=' + LOCAL], 10_000]]` |

    Each: `listener.front('terminal-app')`, `report('terminal-app', TTY)`, `clock = 800`, the move, `stream.lines` is `[]`. After `FRONT_SETTLE_MS`: `asked()` is `[]` and `tabLines()` is `['[device] tab · skipped · echo']`.
  - Tab describe, `a switch that failed sets the report aside all the same`: a runner that answers `{ code: 1 }`; the first way's steps; `[device] swipe · failed` is logged; the same two expectations.
  - Claude describe, `a settle moves nothing when the dial showed another kind of pane inside it (<way>)`, for two ways:

    | Way | The other agent | The rest ran |
    |---|---|---|
    | an Orca terminal | `hook('session-start', { sessionId: IN_ORCA, hostHints: { ORCA_AGENT_SESSION_ID: 'orca-1', ORCA_TERMINAL_HANDLE: HANDLE } })` | `orcaRuns` is `[switched]` |
    | a Terminal tab | `hook('session-start', { sessionId: 'sess-tab', hostHints: { __CFBundleIdentifier: 'com.apple.Terminal' } })`, its tty read (`await wait(0)`), then `listener.tabs()` | the stream's lines are `[{ app: 'terminal-app', tty: '/dev/ttys023' }]`, `orcaRuns` is `[]` |

    Each: `dialWith('orca')`, `attach(SESSION)`, the other agent listed, `front('claude')`, `await wait(500)`, `host().swipeEnded(<its id>, 'rest')`, `await wait(0)`, then `await wait(FRONT_SETTLE_MS - 500)`:
    - `asked()` is `[]`;
    - `attaches()` is `['[device] attach · skipped · not in front', '[device] settle · skipped · echo']`;
    - the kept agent is still A: after `await wait(2_000)` and `backInFront(front)`, `asked()` is `[[A, 'attach']]`.
- [ ] **Step 3: Run** the step 1 command. Expected: FAIL in the six new tests only. Each settle asked a follow where none is expected: `[[ID, 'tab']]` in the tab describe, `[[A, 'attach']]` in the Claude one.
- [ ] **Step 4: Implement** in `devices.ts`.
- [ ] **Step 5: Run** `cd cli && npx vitest run src/services/devices.spec.ts src/cable && npm run typecheck && npm run test:core`. Expected: PASS, 100% for `services/devices.ts`, and no existing expectation of `devices.spec.ts` edited. Three existing tests hold the rule from its other side, and pass untouched:
  - `a settle 2 s after the dial's last link moves the dial; of two links the younger counts`;
  - `the echo is that agent's alone`;
  - `each select excuses one report: the person selecting that tab again within 2 s moves the dial`.
- [ ] **Step 6: Commit** `devices: one record of what the dial just showed, so no settle turns it back`.

### Task 13: The tab's skip lines in one form (F3)

**Layer:** devices service process; the end-to-end suite; one spec. **Depends on:** Task 0. **Effort:** `medium` (four strings, and every place that reads them).

**Red test:** `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts`, `docs/specs/2026-11-15-dial-terminal-follow.md`
- Test: `cli/src/services/devices.spec.ts`, `cli/e2e/dialTerminalFollow.e2e.ts`

**Interfaces:**
- Produces, in `devices.ts`, the spec's table and nothing else:

  | Where | Today | After |
  |---|---|---|
  | `FOLLOWED.tab['no-tile']` | `[device] tab · no-tile` | `[device] tab · skipped · no tile` |
  | `followTab`, both echo lines | `[device] tab · echo` | `[device] tab · skipped · echo` |
  | `followTab`, no agent in that tab | `[device] tab · no-agent` | `[device] tab · skipped · unknown agent` |
  | `tabSettled`, another app settled | `[device] tab · not-in-front` | `[device] tab · skipped · not in front` |

- `[device] tab · moved` stays. So does the outcome word `'no-tile'` that `localFollowed` carries (`cableSession.ts`, `cableHost.ts` and their specs): it is a key, not a line.
- No other file reads these lines: `git grep` over #4331's head finds them in these four files and in `docs/plans/2026-11-15-dial-terminal-follow-plan.md`, which is the record of what #4331 built and stays.

- [ ] **Step 1: Change the expectations.** Every expected tab line takes its new form, and a title that quotes one follows it.
  - `devices.spec.ts`, in `describe('selecting a tab moves the dial …')`:
    - `a report is dropped when another app settles, counted not in front, …`: `['[device] tab · skipped · not in front']`, twice.
    - `no agent with that tty, or one in another app: unknown agent`: `'[device] tab · skipped · unknown agent'`, twice.
    - `the dial's answer is counted: tab · moved, and tab · skipped · no tile`: `['[device] tab · moved', '[device] tab · skipped · no tile']`.
    - Every `'[device] tab · echo'` reads `'[device] tab · skipped · echo'`.
    - `no tab line names a tty, an app, an agent or a session`: `five` is the five lines written out, `moved` and the four skips.
  - `cli/e2e/dialTerminalFollow.e2e.ts`:
    - both `said(d, '[device] tab · no-agent')` read `'[device] tab · skipped · unknown agent'`;
    - `said(d, '[device] tab · echo')` reads `'[device] tab · skipped · echo'`;
    - the shape check reads `/^\[device\] tab · (moved|skipped · (no tile|echo|unknown agent|not in front))$/`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL in that describe only, for example `expected [ '[device] tab · echo' ] to deeply equal [ '[device] tab · skipped · echo' ]`. The end-to-end file is macOS only and takes minutes: it is not run red.
- [ ] **Step 3: Implement** the four lines in `devices.ts`. With them, in `docs/specs/2026-11-15-dial-terminal-follow.md`, the "Devices log" bullet reads `` `[device] tab · moved`, `[device] tab · skipped · no tile | not in front | unknown agent | echo` ``, and the rest of its sentence as it is.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/services/devices.spec.ts && npm run typecheck && npm run test:core`. Expected: PASS, 100% for `services/devices.ts`. Then `git grep -n -E "tab · (no-tile|echo|no-agent|not-in-front)" -- cli docs/specs ':!docs/specs/2026-11-15-device-host-adapter.md'` prints nothing (that spec's own table names the old lines).
- [ ] **Step 5: Commit** `devices: the tab's skip lines read as the prompt's, the attach's and the settle's do`. Verification 1 runs the end-to-end file, on macOS.

---

## Verification

**Platforms the pull request names:** macOS (every adapter; unit specs, and the end-to-end suites on a macOS runner). Linux and Windows (only a pane's own command focuses; the unit specs run each adapter and the opener as `linux` and `win32`, and the end-to-end suites run on a Linux runner). The round dial's firmware (host contracts and the ESP-IDF build; no dial is flashed).

**Never touched:** Diego's everyday daemon (port 18473), his `~/.claude`, his tmux server, his dial, the real Orca, Claude app, Terminal, WezTerm or herdr, any backend, production.

**Local gates**, recorded in the pull request (PR CI does not run them), on this Mac at the final head. First `cd cli && node -p process.arch`: `arm64`.
- `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts`.
- `npm run test:core`: 100% per file under `src/services/`, `services/devices.ts` named.
- `npx vitest run src/architecture.spec.ts src/leanEntry.spec.ts`: the core's file list is unchanged.
- `IDF_PATH="$HOME/esp/esp-idf-5.5.4" make device-test`, from the repository root.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit. Its receipts go in the pull request's body before the tested commit is pushed.
- Not needed: `npm run test:harnessd`, the serial specs, `cargo test` in `device-app/`, `make desktop-test`.

**1. The temporary workflow, on GitHub** (`.github/workflows/tmp-device-host-adapter.yml`, Task 11)
- What runs: on `macos-15` and `ubuntu-latest`, the real daemon with a fake dial for `deviceClaudeOrca`, `deviceWithoutApp`, `dialPaneFollow`, `dialClaudeAppFollow`, `dialTerminalFollow`, `dialAppFilter`, `dialAppFilterOnDial` and `devicesProcess`. In `espressif/idf:v5.5.4`, `idf.py build` of the round dial's firmware.
- Isolation: the suite's own (`cli/e2e/harness/daemon.ts`, `cli/AGENTS.md` rules 5 and 6). A throwaway home and data folder, a private port and tmux server, fake Claude Code and Codex, a fake dial on a pseudo-terminal, a fake `orca` first on the daemon's `PATH`. No suite taps an agent outside Harness, so `/usr/bin/open` never runs and no real app comes forward. No backend, no sign-in, no secret. Nothing is flashed or published.
- When: at the last head before the file is removed. That head and the pull request's differ by the workflow file alone.
- Find the run: `gh run list --workflow tmp-device-host-adapter.yml --branch feat/device-host-adapter --commit "$(git rev-parse HEAD)" --json databaseId,status,conclusion,url`.
- A person sees: three green jobs. In both `dial e2e` jobs every file passes with no expectation edited but `dialTerminalFollow`'s tab lines, which read `[device] tab · skipped · unknown agent` and `[device] tab · skipped · echo` since Task 13; on Linux `dialTerminalFollow` reads skipped, as it is macOS only. So the macOS job is the one run of Task 13's end-to-end edits: every test of the file passes, and its shape check holds every tab line of the daemon's log to `moved` or `skipped · <why>`. In `round dial firmware build`, `Project build complete` and `interns_commander.bin`.
- If the macOS job fails for the runner's own reason (never run there before), say so and run the same eight files on this Mac: `cd cli && env -u TMUX -u TMUX_PANE E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts <the eight files>`. The build, on this Mac: `. ~/esp/esp-idf-5.5.4/export.sh && idf.py -C devices/harness-device/firmware -B "$TMPDIR/round-build" -D SDKCONFIG="$TMPDIR/round-build/sdkconfig" build`. A check that ran nowhere is reported as not verified, never as passed.
- The repo's own workflow for the suite is Actions → CLI end to end → Run workflow (`cli-e2e.yml`): every file, Linux only, nine runners. It is not started for this change: the temporary job runs the files this change can reach on both systems, and the nightly run covers the rest on `main`.
- After the pull request nothing of this check keeps running, and no permanent workflow changes (PM, 2026-11-15).

**2. The dial's screen, as a picture**
- Run, on this Mac: `HABITAT_PREVIEW_DIR="$(mktemp -d)" python3 devices/harness-device/firmware/test/test_touch_ui.py`, then `sips -s format png "$HABITAT_PREVIEW_DIR/caps-question-no-answer.ppm" --out caps-question-no-answer.png`.
- A person sees: the agent's name, `question 1 / 1`, the prompt ending "answer in Orca", and `[ later ]` alone. The picture goes in the pull request, beside `caps-question-no-say`.

**3. Linux, in PR CI:** the CLI unit jobs run Tasks 1 to 8's specs, and Tasks 12 and 13's in `devices.spec.ts`; `firmware-checks` runs every `firmware/test/test_*.py`. Nothing is started by hand.

**4. On a dial:** none. Flashing needs Diego's own go (the spec, "Decided"), and he is using his dial. The host contracts run the production handler and renderer, and check 2 shows the screen.

**5. Against the real apps:** none. The claim is that no command changed: `devices.spec.ts` and `open.spec.ts` hold every command's arguments, order and timeout and pass with no expectation of a command edited, and the end-to-end suites run a fake `orca`. A tap's `open` has no end-to-end run: on a Mac it would bring a real app forward.

**6. The settles that no longer turn the dial back (F2, Task 12):** none end to end, and none on a dial.
- Where it is checked: `devices.spec.ts`, red then green, on a fake clock: the devices' own wiring with the real observed source, cable host and app filter, a fake cable and listener, and a recording runner. It is in the local gates above and in PR CI.
- Why no end-to-end test: the fault lives inside the one-second settle. On a real daemon a test would have to land the dial's rest (400 ms after its turn) between a report and its settle by the wall clock: a fixed sleep, or a flaky test. The spec asks for the unit tests.
- What check 1 still shows: a tab report, an attach and a prompt each move the dial as before (`dialTerminalFollow`, `dialClaudeAppFollow`, `dialPaneFollow`), so the record sets nothing aside that it should not.
- On a dial, with the real Terminal, Orca and Claude app: not run. It would need Diego's everyday daemon and his dial, which this plan never touches.

## Open questions

The six this plan first asked are answered below. One is open, from the two fixes:

1. **Task 12, the Claude app's settle.** The spec says a settle is set aside "when the dial showed anything since the report it waits on came". For a tab app that is exact, and Task 12 keeps it: the report waits at most one settle, and the dial's moves are counted since it came. For the Claude app the report is its last attach, which is kept until the app next settles in front, minutes later after a Cmd-Tab away and back. Read to the letter, a dial that moved once since that attach would never again follow the app coming to the front, and `main`'s test `a settle 2 s after the dial's last link moves the dial; of two links the younger counts` would fail. So Task 12 is written as `main` decides it today for a link (`dial-claude-app-follow`, decided 9), widened to every kind of pane: **the Claude app's settle is set aside while the dial's latest move, of any kind, is younger than 2 s (`ATTACH_ECHO_MS`).** Both of the spec's cases are covered, as a settle comes one second after its app. Is that the rule? A "no" changes Task 12's second row of "What moves" and the last line of its Claude tests.

## Decided here

**The PM's answers to this plan's six questions (2026-11-15):**

1. **The Claude app adapter's id** is `claude`, in the file `claudeApp.ts`: the word today's log line says (`[device] open · claude · fallback`). The spec says so now.
2. **A tap's order** is one read-only member on `HostAdapter`, `tap: 'before' | 'instead' | 'after'`. It is in the spec's interface now.
3. **Hints that name two panes.** No single pane per agent. `ObservedSource` keeps every pane an adapter recognises, in the order herdr, WezTerm, Orca, the Claude app, tabs, and each verb uses the first pane whose adapter can do it: words the first with `type`, a rest the first whose `canShow` says yes, a tap the first whose `canFocus` says yes. Today's behaviour is kept in both corners: herdr or WezTerm inside an Orca terminal still types and rests through Orca, and herdr inside Terminal, iTerm2 or Ghostty with a watch open still writes its tab select. Task 7 pins both.
4. **"Expectations unchanged" in the unit specs.** Every `it` body stays and only how the fakes are built changes, but in three named places: the Claude `hasPane` test's `canOpen` assertions (Task 7), `pane: { app: 'orca' … }` reading `pane: { adapter: 'orca' … }` (Task 8), and the rest-on-Claude tests moving to `claudeApp.spec.ts` (Tasks 3 and 8). Anything else is a finding.
5. **"Recorded hint sets."** Each contract test uses the hint sets the existing specs and e2e already hold for that app. Nothing is captured from Diego's own apps.
6. **After this pull request.** No permanent workflow changes. The temporary workflow is removed before the pull request.

**Where the spec was silent:**

- **Two steps, not one.** Task 7 moves words and rests, Task 8 taps. Between them `open.ts` still finds a tap's pane itself, and `devices.ts` hands it Orca's `focus` as `orcaSwitch`. Task 8 removes both.
- **An adapter task only adds.** Tasks 2 to 6 leave `open.ts` and its spec alone, so they run beside each other. The copies in `open.ts` go in Task 8.
- **A tab's pane id** is `<app>:<tty>`. A select needs both, and `Pane` holds one id.
- **An entry keeps each pane beside its adapter** (`Entry.panes`), so no verb looks an adapter up by a pane's `adapter` word. `Pane` itself stays as the spec writes it.
- **`learnTty` and `byTab` stay in `observed.ts`**, as the spec's `Place.tty` comment names `learnTty` there. They are about where an agent is, not what an app does. `byTab` still matches by the agent's app and tty, whichever of its panes a verb uses.
- **`count` takes the adapter's id** for the route that typed, so `[device] voice · orca` stays.
- **The echo notes stay in `devices.ts`:** the Claude app's `show` is wrapped there for `noteLink`, the `open` wrapper stays, and `selected` rides in the tabs adapter's `select`. They belong to the two follow features, not to how an app is reached.
- **A tap has two parts, as today.** The opener gets the first pane that can focus among those that tap before or instead of their app. A pane that taps after its app is never in the opener's target: once `open` answered true, the source raises the pane a rest would show, when that pane taps after. That is today's `shownPane` of kind `tty`, and #4331's own test needs it (`a tap on an agent with an Orca handle writes no select`). Its answer is not the tap's.
- **One corner gains a route, by the PM's rule.** Hints that name a herdr or WezTerm pane and a Claude app session at once: today a rest shows nothing, as `open.ts` names the multiplexer's pane first; after, the rest falls to the Claude app's link while that app is in front. No route is lost, and a tap is as today. The Claude app's own sessions carry no multiplexer's variable, so nobody should meet it; it has no test of its own, as `falls to the next pane` in Task 7 holds the rule.
- **`OrcaDeps`, `orcaDeps`, `RUN_TIMEOUT_MS` and `MAX_TEXT` stay in `orca.ts`**, imported from there as `open.ts` does today. Renaming them is not this reshape.
- **`Place.host` is in the spec's interface** and no adapter of this pull request reads it. It stays as the spec wrote it.
- **The lone `[ later ]`** is the loading question's control, at the same place, so it does not move when the question loads. It sits 17 px left of the centre there today; that is not changed here.
- **`A_QUESTION_SAY` is not blocked** in the firmware: the spec lists four actions and keeps voice's own check. `[say]` is not drawn for an agent without `a`.
- **The end-to-end run** is the eight files this change can reach, on macOS and Linux, not the whole suite.
- **A move is noted as it starts, busy or failed too** (Task 12), as `noteLink` is on `main`: the dial is on that agent all the same. One corner of #4331 changes with it: a select its stream did not take used not to count, and now sets a waiting report aside. Task 12's `a switch that failed` test holds the rule.
- **A move is an adapter's `show` or `focus`** (Task 12): the spec's list. A tap on an agent with no pane of any adapter runs `open -b` alone and notes nothing, as today.
- **The lines of a settle set aside stay** `[device] settle · skipped · echo` and `[device] tab · skipped · echo`, whatever kind of pane the dial showed: the spec names no new line.
- **One record, read two ways** (Task 12): a count for a tab's report, the latest move's age for the Claude app's settle. Open question 1.
- **The older specs keep their own sentences on the rule** (`dial-claude-app-follow` decided 9; `dial-terminal-follow`, "Acting on a report", 1): F2 in this spec is the record of the change. Task 13 edits the terminal-follow spec's "Devices log" bullet only, as F3 says.
- **`docs/plans/2026-11-15-dial-terminal-follow-plan.md` keeps the old tab lines:** it is the record of what #4331 built.
- **Task 13 before Task 12, and both after Task 0.** Task 13 needs nothing of the reshape, so it does not wait for it. Task 12's tests read Task 13's line, and its code sits on Task 8's wiring.
- **Task 13's end-to-end edits are not run red.** The file is macOS only and takes minutes; its strings change with the unit spec's, which is run red, and Verification 1 runs it green.
- **The pins** in Task 7 pass before the change by design: a reshape's guard cannot fail first. They turn red once the fakes are built over adapters, and the two corner pins stay red for a source that keeps one pane per agent.
