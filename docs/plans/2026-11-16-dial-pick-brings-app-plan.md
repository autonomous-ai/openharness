# A pick on the dial brings that app to the front: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **devcrew phase 3**, task by task. A test-first task is two commits:
> `test(devices): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own
> message. Task 5 adds the end-to-end test of what Tasks 1 to 4 built and is one commit. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** On macOS, a pick in the round dial's `APPS` that switches the ring also brings the picked app to the front
(`open -b <bundle>`), and with a window open a pick of Harness brings Harness Desktop forward; no end-to-end test ever
brings a real app forward on the developer's Mac.

**Architecture:** `CableHost.pickApp` (`cli/src/cable/cableHost.ts`) tells a new optional wiring `appBrought(app)` when a
pick switches the shown app, or, with a window, turns the view to Harness's tab. The devices service
(`cli/src/services/devices.ts`) wires it to a new `bring(app)` on the opener (`cli/src/cable/hosts/open.ts`), which maps
the app to its bundle (herdr excluded, Harness to Desktop's bundle) and runs `open -b`; the last pick wins: one run at a
time for any app, and a pick while one runs replaces the one waiting. The
opener runs the `open` named by `HARNESS_OPEN_BIN` when it is an absolute path, which the e2e harness points at a fake
that records its arguments. All of it in the devices process; nothing in the core.

**Tech Stack:** TypeScript, Vitest, the CLI's e2e harness (real daemon, fake dial on a pseudo-terminal, private tmux).

**Spec:** [docs/plans/2026-11-16-dial-pick-brings-app-design.md](2026-11-16-dial-pick-brings-app-design.md). Read it
with this plan, the root `AGENTS.md`, `cli/AGENTS.md` and `cli/src/services/AGENTS.md`. The spec is the authority.

## Base

- `feat/dial-pick-brings-app` at `ae81a1f077` (after #4340, #4366, #4363). Nothing else has to merge first.
- The tasks name functions, not lines. At the base: `open.ts` `createOpenActions`, `forward`, `desktop`, `OPEN`;
  `cableHost.ts` `CableHostWiring` (`appPicked`, `appSwitched`, `appView`), `pickApp`, `setView`, `pickedOver`;
  `devices.ts` the `opener` const and the `appSwitched` / `launchDesktop` wiring; `open.spec.ts` `recorder`;
  `cableHost.spec.ts` `wiring`, `setup`, `five`, `viewed`, `onGhosttyRing`, `settle`; `devices.spec.ts` `start`,
  `orca`, `orcaRuns`, `logs`, `host`, `twoApps`, `inApp`, `windowed` (the "with a window open" describe), `mac`;
  `e2e/harness/daemon.ts` `IsolatedDaemon.create` (`own`, `dirs`, the env block), `hookLog`; `dialAppFilter.e2e.ts`
  `fresh`, `plugged`, `fiveAgents`, `watch`, `listening`, `shows`, `appsFrames`, `switches`, `settleWindowPassed`,
  `openWindow`.
- If a name differs, the implementer follows the code and says so in its report.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The opener brings an app, with the `open` it is given | `cli/src/cable/hosts/open.ts`, `cli/src/cable/hosts/open.spec.ts` | none | high | `open.spec.ts` |
| 2 A pick tells `appBrought` | `cli/src/cable/cableHost.ts`, `cli/src/cable/cableHost.spec.ts` | none | high | `cableHost.spec.ts` |
| 3 The devices bring the picked app | `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts` | 1, 2 | high | `devices.spec.ts` |
| 4 Every daemon under test gets a fake `open` | `cli/e2e/harness/daemon.ts`, `cli/e2e/developerState.e2e.ts` | none | high | `developerState.e2e.ts` |
| 5 End to end, a pick runs one `open -b` | `cli/e2e/dialAppFilter.e2e.ts`, `cli/e2e/dialAppFilterOnDial.e2e.ts` | 3, 4 | high | none: the end-to-end test of Tasks 1 to 4, one commit |

Longest chain: 1 → 3 → 5 (or 2 → 3 → 5): three tasks. Tasks 1, 2 and 4 share no file and start at once.

## Layers

| File | Process | Gate |
|---|---|---|
| `cable/hosts/open.ts`, `cable/cableHost.ts` | devices service process only | their specs |
| `services/devices.ts` | devices service process | 100% per file (`npm run test:core`) |
| `e2e/harness/daemon.ts`, `e2e/*.e2e.ts` | test | Verification 1 and 2 |

No file under `cli/src/core/` changes; `cli/src/architecture.spec.ts` and `cli/src/architecture.coreFiles.txt` do not
change (cli/AGENTS.md rule 7). No firmware, no new frame, no Desktop change.

## Global Constraints

- **Only cause `pick`, only `switched`** (or `tabs` for Harness with a window). Nothing for `same`, `ignored`, or cause
  `notice`: a tapped notice keeps its own open, unchanged.
- **The bundle comes from the daemon's table**, `APP_BUNDLES` (`cable/hosts/hostDetect.ts`), by own key only; the
  frame's `app` is only a key. `herdr` is excluded by name. `harness` is `HARNESS_BUNDLE` (`ai.autonomous.harness`),
  the command `desktop()` runs. An app with no own key (tmux, Rex, Zellij, Other) runs nothing.
- **With no window a pick of `harness` brings nothing** and never starts Desktop.
- **The command:** `<open> -b <bundle>`, no shell, `RUN_TIMEOUT_MS` (10 s). `<open>` is `HARNESS_OPEN_BIN` when it is
  an absolute path, else `/usr/bin/open` (`OPEN`). Unset, empty and relative are all `/usr/bin/open`.
- **`HARNESS_OPEN_BIN` is read in one place,** `services/devices.ts`, and handed to `createOpenActions`. It is
  documented by a comment in `open.ts`, as `HARNESS_GRID_BIN` is in `lib/gridExec.ts`: it is for the end-to-end tests.
- **The last pick wins** (the PM, 2026-11-16; spec decision 4). One bring runs at a time, for any app. A bring while
  one runs replaces the single waiting one (coalesced, never a queue), which runs as soon as the running one ends, failed
  or not: at most one runs and one waits. A bring with nothing to bring (herdr, no bundle) while one runs drops the
  waiting one, so it does not run. A replaced or dropped bring answers `undefined`. No retry.
- **Log lines,** exactly `[device] app filter: bring · ok` and `[device] app filter: bring · failed`, a count only:
  never the app, the bundle or the path. Nothing ran (no bundle, herdr, replaced, off macOS): no line.
- **macOS only.** Off macOS the opener has no `bring` and the devices wire no `appBrought`.
- **Repo rules.** No unit spec runs a real `open` (every runner is a recorder). No e2e on a Mac brings a real app
  forward. No fixed sleeps. `src/services` stays at 100% per file.

## Review Focus

1. **A burst A, B, A while A's first `open` still runs.** B waits, the second A replaces it, and runs once A's first
   run ends: two `open`s, A then A, B never runs, so the Mac ends with A in front, matching the ring (no settle of B
   turns the dial). The waiting slot is one value, set and cleared in one place, and runs from the running bring's
   `finally`. Task 1, `picks A, B, A while A's first open runs …`, `a failed run still runs the waiting one` and
   `a bring with nothing to bring while one runs drops the waiting one`.
2. **An `open` that hangs** (an app deaf to launch). The opener's 10 s deadline answers `failed`, the ring stayed
   switched, and the last pick made meanwhile (of any app, since the slot is shared) runs once it has ended. Task 1,
   `bring answers failed …` and `a failed run still runs the waiting one`.
3. **A name that is no own key of `APP_BUNDLES`** (`constructor`, `__proto__`, `toString`). It runs nothing. Task 1,
   `bring of herdr, of an app with no bundle and of a name no app has runs nothing`.
4. **A pick of Harness with a window, then Desktop settling in front.** No loop: the view stays `tabs`, no `appView`,
   no second `appBrought`. Task 2, `… Harness then settling in front tells nothing more`.
5. **A tapped notice of an app with a bundle.** One `open -b`, its own, never a second from the pick it makes. Task 3,
   `a pick of the app shown, of an app with no agents, of Other and a notice's pick run no open`.

## Decided here, where the spec was silent

- **The mapping and the last-pick-wins slot live in the opener** (`open.ts` `bring`), the one file that already holds
  the bundles, `forward` and the tap's own one-run guard; the burst test is in `open.spec.ts`, beside them.
  `devices.ts` only wires it and logs, so its new lines stay few and covered.
- **The slot is the picks' alone.** A tap's `open` keeps its own per-agent guard and `desktop()` (the tap's launch of
  Desktop) runs at once; neither waits behind a bring. A tap's `open` does drop the waiting bring (Open question 3).
- **A bring with nothing to bring drops the waiting one**: the last pick wins even when it brings nothing (a tmux ring
  after a pick of VS Code must not end with VS Code settling in front and turning the dial to it, `appFilter.ts`
  `settle`).
- **A replaced bring answers `undefined` at once; the waiting one answers its own run's outcome when it runs.** So
  each `open` that ran logs one line and nothing else does.
- **`bring('harness')` runs the same `forward(HARNESS_BUNDLE)` as `desktop()`**: that is "through the opener's existing
  `desktop()`", and the slot covers it.
- **The absolute-path rule is checked in the opener** (`OpenDeps.bin`), and `devices.ts` hands the raw value. The rule
  is pinned in `open.spec.ts` and the wiring in `devices.spec.ts`.
- **`appBrought` is told from `pickApp` after the switch or the view is told**, so the ring's push is queued first.
- **The herdr exclusion is pinned in `open.spec.ts`**, where it lives; `devices.spec.ts` pins an app with no bundle
  (Other). The no-window Harness case is pinned in `cableHost.spec.ts`, where it lives.
- **The fake `open` is not on the daemon's PATH:** `<own>/fake-open`, recording into `<own>/opens.log`, so nothing that
  runs `open` by name changes. The Claude app's and VS Code's links (`claudeApp.ts`, `vscode.ts`) keep `/usr/bin/open`:
  the spec names the opener only, and no e2e carries their hints (`dialClaudeAppFollow.e2e.ts` asserts so).
- **`dialAppFilterOnDial.e2e.ts`'s log check** gains `bring · (ok|failed)`: the rig's picks now log it.

## Open questions

1. **The opt-in rig on a real dial.** Answered by the PM, 2026-11-16: the rig sets `HARNESS_OPEN_BIN: '/usr/bin/open'`
   for its daemon (opt-in, a person at the desk). Task 5, Step 3.
2. **A burst of picks.** Answered by the PM, 2026-11-16: the last one wins; one bring at a time for any app, one
   waiting, replaced by a later pick. Task 1; Global Constraints.
3. **A switch that never reaches `bring` while one waits.** Two such switches exist: a tapped notice (its own `open`, the
   dial turns to its app) and a pick of Harness with no window (the dial turns to Harness's ring, nothing is brought).
   With a bring waiting, that bring still runs after them, its app settles in front and turns the dial away from the
   last switch, against "the last one wins". It needs the switch within one running `open` (about 0.1 s, longer for an
   app that starts). Have a tap's `open` drop the waiting bring (one line in `open.ts`, Task 1), and leave the
   no-window Harness pick as is (it reaches the opener through nothing; covering it would add a wiring for one case)?
   Answered by the PM, 2026-11-16: yes to both, as recommended; the plan is written that way.

---

### Task 1: The opener brings an app, with the `open` it is given

**Files:**
- Modify: `cli/src/cable/hosts/open.ts`
- Test: `cli/src/cable/hosts/open.spec.ts`

**Interfaces:**
- Produces: `OpenDeps.bin?: string`: the raw `HARNESS_OPEN_BIN`; an absolute path (`node:path` `isAbsolute`) is the
  file `forward` runs, anything else is `OPEN`. `forward` serves the tap's `open`, `desktop` and `bring`.
- Produces, on the returned object: `bring?: (app: string) => Promise<'ok' | 'failed' | undefined>`, present only when
  `platform === 'darwin'`. `undefined` means nothing ran. Bundle: `app === 'harness'` → `HARNESS_BUNDLE`;
  `app === 'herdr'` → none; else `Object.hasOwn(APP_BUNDLES, app) ? APP_BUNDLES[app] : none`. The last pick wins: one
  bring runs at a time for any app; a bring while one runs takes the single waiting place (the one it replaces answers
  `undefined` at once), and the waiting one runs from the running one's `finally`, answering its own outcome. A bring
  with no bundle while one runs drops the waiting one and answers `undefined`. A tap's `open` drops the waiting one too
  (Open question 3); the tap's per-agent set and `desktop()` are apart from this slot and never wait on it. A run that
  rejects is `failed`.

- [ ] **Step 1: Write the failing tests** in `open.spec.ts`, with `recorder` given `bin` (extend its `over`):
  - `bring runs open -b with the app's bundle once and answers ok`: `bring('vscode')` → `'ok'`; calls
    `[{ file: '/usr/bin/open', args: ['-b', 'com.microsoft.VSCode'], timeoutMs: 10_000 }]`.
  - `bring of Harness runs the open -b ai.autonomous.harness desktop runs`.
  - `bring of herdr, of an app with no bundle and of a name no app has runs nothing`: each of `herdr`, `tmux`, `rex`,
    `zellij`, `terminal`, `constructor`, `__proto__`, `toString` → `undefined`, calls `[]`.
  - `bring answers failed on exit 1, on a timeout (code null) and on a run that rejects, and runs once`.
  - `a bring while none runs runs at once, and so does one after it has ended`: `bring('vscode')` → one call before
    any await of a release; once it answered, `bring('ghostty')` runs at once.
  - `picks A, B, A while A's first open runs: exactly two opens, A then A, and B never runs`: a runner held on a
    promise; `bring('vscode')`, `bring('ghostty')`, `bring('vscode')`; one call so far; the `ghostty` bring answers
    `undefined` before the release; after it, the first and third answer `'ok'` and calls are
    `[['-b', 'com.microsoft.VSCode'], ['-b', 'com.microsoft.VSCode']]` (each with `/usr/bin/open` and 10 000).
  - `a failed run still runs the waiting one`: the held run then answers code 1 (and, in a second case, rejects) →
    `'failed'`; the waiting `bring('ghostty')` runs after it and answers `'ok'`.
  - `a bring with nothing to bring while one runs drops the waiting one`: held `bring('vscode')`, `bring('ghostty')`,
    `bring('tmux')` → both of the last answer `undefined`; after the release, calls hold `vscode` only.
  - `a tap while a bring runs opens its own app at once and drops the waiting bring; desktop() runs at once`: held
    `bring('vscode')`, waiting `bring('ghostty')`; `open('a1', { bundle: <Ghostty's> })` runs at once and `desktop()`
    runs at once; the waiting bring answers `undefined`; after the release, no more calls.
  - `off macOS there is no bring` (`platform: 'linux'`): `opener.bring` and `opener.desktop` are `undefined`.
  - `an absolute bin is what a tap, desktop and bring run; unset, empty and relative run /usr/bin/open`: `bin:
    '/tmp/e2e/fake-open'` → every call's `file` is it; `undefined`, `''`, `'fake-open'`, `'./fake-open'` → `/usr/bin/open`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/open.spec.ts`. Expected: the new tests FAIL (`bring` is
  not a function / `file` is `/usr/bin/open`).
- [ ] **Step 3: Commit the red tests:** `test(devices): the opener brings an app, with the open it is given (red)`.
- [ ] **Step 4: Implement** `bin` and `bring` in `open.ts`. Above `OPEN`, a comment: `HARNESS_OPEN_BIN` (read in
  `services/devices.ts`, handed here as `bin`) is for the end-to-end tests, whose harness points it at a fake that
  records its arguments and opens nothing (`e2e/harness/daemon.ts`); only an absolute path is taken, so a relative one
  is never looked up on PATH. A why-comment on `bring` for herdr (its ring is herdr's socket's agents, whose terminal
  nobody knows: #4366), and one on the slot (the last pick wins, so the Mac's front app ends matching the dial's ring:
  spec decision 4).
- [ ] **Step 5: Run** `npx vitest run src/cable/hosts` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit:** `feat(devices): the opener brings an app by its bundle, with HARNESS_OPEN_BIN's open`.

### Task 2: A pick tells `appBrought`

**Files:**
- Modify: `cli/src/cable/cableHost.ts`
- Test: `cli/src/cable/cableHost.spec.ts`

**Interfaces:**
- Produces: `CableHostWiring.appBrought?: (app: string) => void`, doc: a pick on the dial switched the shown app, or
  with a window turned the view to Harness's tab; never for a notice, nor for Harness with no window.
- Rule in `pickApp`, after the existing branches compute the answer:
  `cause === 'pick' && (answer === 'tabs' || (answer === 'switched' && app !== 'harness'))` → `appBrought(app)`.

- [ ] **Step 1: Write the failing tests** in `cableHost.spec.ts`, beside `appPicked is told once for each pick`, and in
  the window describe beside `a pick of Harness on an app's ring answers tabs`. Record `appSwitched`, `appView` and
  `appBrought` into one array to pin the order:
  - `a pick that switches tells appBrought the app once, after appSwitched; same, ignored and a notice tell it
    nothing`: `pickApp('vscode')`, `pickApp('vscode')`, `pickApp('cursor')`, `pickApp('ghostty', 'notice')` → told
    `['switched pick', 'brought vscode', 'switched notice']`.
  - `with no window a pick of Harness that switches brings nothing` (as the case answering `switched` for `harness`).
  - `with a window, a pick of Harness on an app's ring tells appBrought harness once, after the view; Harness then
    settling in front tells nothing more`: `['view tabs pick', 'brought harness']`; then `front('harness')`, settle,
    list read → unchanged.
  - `with a window, a pick on the tab is ignored and brings nothing; a pick of another app on an app's ring brings it`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableHost.spec.ts`. Expected: the new tests FAIL (no
  `brought …` entries).
- [ ] **Step 3: Commit the red tests:** `test(devices): a pick that switches tells appBrought (red)`.
- [ ] **Step 4: Implement** the wiring and the rule in `pickApp` (one exit that tells it; the existing answers do not
  change).
- [ ] **Step 5: Run** `npx vitest run src/cable` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit:** `feat(devices): a pick that switches the dial's app tells the devices to bring it`.

### Task 3: The devices bring the picked app

**Files:**
- Modify: `cli/src/services/devices.ts`
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `OpenDeps.bin`, `opener.bring` (Task 1); `CableHostWiring.appBrought` (Task 2).
- `createOpenActions({ run, platform, adapters, log, bin: process.env.HARNESS_OPEN_BIN })`: the one read of the variable.
- `appBrought`: present only when `opener.bring` is; runs it and, when it answers `ok` or `failed`, logs
  `[device] app filter: bring · <outcome>`. A why-comment naming the spec.

- [ ] **Step 1: Write the failing tests** in the `the app a dial that says appFilter shows` describe, starting the
  devices with the `darwin` copy of `orca` (`{ ...orca, platform: 'darwin' }`, as `mac` is):
  - `on macOS a pick that switches runs open -b with the picked app's bundle once and logs bring · ok, with no app in
    the log`: after `twoApps`, `pickApp('vscode')` → `orcaRuns` `[['/usr/bin/open', ['-b', 'com.microsoft.VSCode'],
    10_000]]`; `logs` holds `[device] app filter: bring · ok` once; no log line matches
    `/vscode|VS Code|ghostty|Ghostty|com\.microsoft/`.
  - `an open that fails logs bring · failed once and is not run again` (a runner answering code 1).
  - `a pick of the app shown, of an app with no agents, of Other and a notice's pick run no open`: `pickApp('ghostty')`
    (shown), `pickApp('cursor')`, a pick of `terminal` (an agent with an unknown `TERM_PROGRAM`), `pickApp('vscode',
    'notice')` → no `open -b` in `orcaRuns`, no `bring` line.
  - `with a window open, a pick of Harness on an app's ring runs open -b ai.autonomous.harness` (the `windowed` setup).
  - `HARNESS_OPEN_BIN: an absolute path is the file a pick runs; empty and relative run /usr/bin/open`: `vi.stubEnv`
    before `start`, with `/tmp/e2e/fake-open`, `''`, `fake-open`.
  - `off macOS a pick runs nothing`: the default `orca` (linux), `pickApp('vscode')` → `orcaRuns` `[]`, no `bring` line.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Commit the red tests:** `test(devices): the devices bring the picked app (red)`.
- [ ] **Step 4: Implement** the two wiring lines in `devices.ts`.
- [ ] **Step 5: Run** `npx vitest run src/services/devices.spec.ts src/cable`, `npm run typecheck`, then
  `npm run test:core`. Expected: PASS, `services/devices.ts` at 100%.
- [ ] **Step 6: Commit:** `feat(devices): a pick on the dial brings that app to the front`.

### Task 4: Every daemon under test gets a fake `open`

**Files:**
- Modify: `cli/e2e/harness/daemon.ts`
- Test: `cli/e2e/developerState.e2e.ts`

**Interfaces:**
- Produces: in `IsolatedDaemon.create`, a script `<own>/fake-open` (mode 0o755) that appends one line per run, its
  arguments joined by a space (`printf '%s\n' "$*"`), to `<own>/opens.log`, and exits 0. `HARNESS_OPEN_BIN` set to its
  path in the env block, before `...options.env` so a test may name another. A comment saying why (no dial e2e on a
  Mac brings a real app forward; today's `dialAppFilter.e2e.ts` taps and picks VS Code and Ghostty).
- Produces: `IsolatedDaemon.opens(): string[][]`: each run's arguments, in order; `[]` while the record is missing.

- [ ] **Step 1: Write the failing test** in `developerState.e2e.ts`, `it.skipIf(process.platform === 'win32')`:
  `opens nothing of the developer's: its open is a fake in its own root that records what it is asked and exits 0`.
  Create a daemon (no start); `d.env.HARNESS_OPEN_BIN` is absolute and inside `d.root`; `execFileSync` it with
  `['-b', 'com.example.none']` exits 0; `d.opens()` is `[['-b', 'com.example.none']]`.
- [ ] **Step 2: Run** `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts
  e2e/developerState.e2e.ts -t "its open is a fake"`. Expected: FAIL (`HARNESS_OPEN_BIN` undefined).
- [ ] **Step 3: Commit the red test:** `test(e2e): every daemon under test gets a fake open (red)`.
- [ ] **Step 4: Implement** the fake and `opens()` in `daemon.ts`.
- [ ] **Step 5: Run** the same command for the whole file. Expected: PASS.
- [ ] **Step 6: Commit:** `test(e2e): every daemon under test runs a fake open that brings nothing forward`.

### Task 5: End to end, a pick runs one `open -b`

**Files:**
- Modify: `cli/e2e/dialAppFilter.e2e.ts`, `cli/e2e/dialAppFilterOnDial.e2e.ts`

**Interfaces:**
- Consumes: `IsolatedDaemon.opens()` (Task 4); the bring and its log line (Tasks 1 to 3).

- [ ] **Step 1: Add the case** `it.skipIf(process.platform !== 'darwin')('app.pick of VS Code runs one open -b
  com.microsoft.VSCode, and VS Code then settling in front changes nothing on the dial')`: `fresh`, `plugged`,
  `fiveAgents`, `listening`, `watch`; send `app.pick vscode`; `shows(dial, 'vscode', vscode, since)`; `until` `d.opens()`
  is `[['-b', VSCODE_BUNDLE]]` and the log has `[device] app filter: bring · ok`. Then `run.front(VSCODE_BUNDLE)`,
  `settleWindowPassed`: every `apps` frame since says `vscode`, `switches(d, 'front')` is 0, `d.opens()` has one run.
- [ ] **Step 2: Extend** `a pick of Harness in APPS returns the dial to the tab`: on darwin, `until` the last of
  `d.opens()` is `['-b', 'ai.autonomous.harness']`.
- [ ] **Step 3: Extend** the log case (`the daemon's log has "app filter: switched" lines …`): its pattern accepts
  `bring · (ok|failed)`, and `log.includes('[device] app filter: bring · ok')` is `process.platform === 'darwin'`.
  Add `bring · (ok|failed)` to `dialAppFilterOnDial.e2e.ts`'s pattern too, and in its `IsolatedDaemon.create` env set
  `HARNESS_OPEN_BIN: '/usr/bin/open'`, with a comment saying why (the PM, 2026-11-16: opt-in, a person at the desk sees
  the apps come forward).
- [ ] **Step 4: Run** on this Mac: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config
  vitest.e2e.config.ts e2e/dialAppFilter.e2e.ts`. Expected: PASS, the new case not skipped.
- [ ] **Step 5: Commit:** `test(e2e): a pick on the dial runs one open -b of the picked app`.

## Verification

**Platforms the pull request names:** the daemon on macOS (the bring). Linux and Windows: nothing changes; unit tests
with `platform: 'linux'` hold that no `bring` exists and a pick runs nothing (Tasks 1, 3).

**Never touched:** Diego's everyday daemon (port 18473) and its data, `~/.claude`, `~/.codex`, his tmux server, his
apps, any backend, production. **Temporary workflow:** none: check 1 needs macOS and the repo's e2e workflow runs
Linux; check 2 has the repo's own workflow.

**Local gates** on this Mac at the final head, recorded in the pull request (PR CI does not run them):
- `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts`.
- `npm run test:core`: 100% per file under `src/services/`, `services/devices.ts` named.
- `npx vitest run src/architecture.spec.ts src/leanEntry.spec.ts`; `git diff --stat ae81a1f077 -- cli/src/core
  cli/src/architecture.spec.ts cli/src/architecture.coreFiles.txt` prints nothing.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit; its receipt goes in the pull request's
  body before the tested commit is pushed.

**1. The dial e2e on macOS** (a tester, this Mac, final head)
- Run: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts
  e2e/developerState.e2e.ts e2e/dialAppFilter.e2e.ts e2e/deviceWithoutApp.e2e.ts e2e/deviceClaudeOrca.e2e.ts
  e2e/dialPaneFollow.e2e.ts e2e/dialTerminalFollow.e2e.ts` (the dial files that tap or pick on a Mac).
- Isolation: the suite's own (`cli/e2e/harness/daemon.ts`, cli/AGENTS.md rules 5 and 6): a throwaway home and data
  folder, a private port and tmux server, fake engines, a fake dial on a pseudo-terminal, and from Task 4 the fake
  `open` in each daemon's root. No account.
- A person sees: every test passes; the new pick case and the fake-`open` case are not skipped. Before and after the run,
  `lsappinfo info -only name $(lsappinfo front)` names the same app, and `pgrep -lf 'Visual Studio Code|Ghostty'`
  lists the same processes: nothing came forward or started.

**2. Linux regressions** (GitHub, by hand, once on the final head; ask the orchestrator for the runner turn)
- Actions → CLI end to end → Run workflow, branch `feat/dial-pick-brings-app` (`.github/workflows/cli-e2e.yml`). Every
  shard passes; the new pick case reads skipped. The link goes in the pull request.

**3. In PR CI, by itself:** `cli-typecheck` and `cli-tests` run Tasks 1 to 3's specs on Linux.

**4. On Diego's dial** (the user themselves: their Mac, their dial, their own login; never a tester)
- Run this branch's daemon as the dev daemon, as for the earlier dial tests (a dev daemon never self-updates: check its
  version names this branch's commit).
- Orca in front, pick Claude on the dial → the Claude app comes forward, and a swipe on its ring switches its session.
- Pick Orca → Orca comes forward. Pick a tmux or herdr ring → the ring changes and no app comes forward.
- With a Harness window open, on an app's ring, pick Harness → Harness Desktop comes forward, the dial shows the tab.
  With Desktop closed, pick Harness → nothing starts.

**5. Numbers:** none to take: a pick is a hand's move, one `open` per pick, on no hot path.
