# Harness Device: a new user's first run — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** every task is done on the branch (2026-11-17), and the final review's fixes are landing. Spec decisions 1 to 10 hold; the open questions were answered by decision 10, and the final review corrected section D (the adapter-ws label stays the hostname; the device-ws label is a new device's name).

**Goal:** A brand-new user who installs Harness Device on a Mac sees what the install is doing, gets tmux with no Homebrew run, sees the Claude Code sessions Orca runs under its own accounts on the dial, with their waiting prompts, has an app log of step lines and results only, and gets a new machine named as the Mac is in System Settings.

**Architecture:**
- **Installer** (done). On a Mac `install.sh` finds a tmux that is already there and otherwise downloads the managed build. It never runs `brew`. Every child that could read its stdin gets `</dev/null`. The desktop app's "with Homebrew" copy goes.
- **Device app** (done but for the docs). The install's output is read line by line as it arrives. A fixed Rust table turns a script step line into fixed copy under the spinner, and only step lines and results reach the log. No first-run screens: #4399 sets Claude Code and Codex up with no click.
- **Orca homes.** `devices/orcaHomes.ts` asks Orca's own CLI for its account homes and keeps only `home` (done). The devices process adds them to the open scan's places and to the dial skill's homes (done). What is left joins Orca's Claude Code homes to #4399's automatic plugin setup: once the default home's plugin is recorded as set up, each Orca home not yet recorded gets `claude plugin enable harness-device@openharness --scope user`, with `CLAUDE_CONFIG_DIR=<home>` on that child alone, and is recorded by real path in `dial-setup.json`. `harness device claude enable` and `disable` cover the Orca homes too. Nothing in the daemon core changes.
- **Machine name** (done). `cli/src/lib/computerName.ts` reads macOS's ComputerName once per process, with the hostname as the fallback. The four places that send a new machine's label use it.

**Tech Stack:** TypeScript daemon and CLI (`cli/src`, `cli/e2e`), vitest; Markdown docs. (Done tasks: POSIX sh, Dart and Flutter, Rust and Tauri 2, plain TypeScript in `device-app/ui`.)

**Spec:** [docs/plans/2026-11-17-new-user-onboarding-design.md](2026-11-17-new-user-onboarding-design.md). Read it with this plan: the plan argues from it. Read #4399's spec too: [docs/plans/2026-11-17-dial-agents-always-on-design.md](2026-11-17-dial-agents-always-on-design.md).

## Base

- Branch `fix/new-user-onboarding`, rebased onto `main` at `1e17b388ce` (after #4399). Every task is built on this one branch and split into four pull requests at the end ([Pull requests](#pull-requests)).
- Before the first task: `cd cli && npm ci`.
- Tasks name code by name. A line number is only a hint. If a name below is gone, stop and report.
- Never touched by a task, a test or a check: the person's `~/.claude`, `~/.codex`, Orca profiles, `~/.harness`, daemon (port 18473), tmux server, the real `orca`, `claude` plugin state and `brew`. Tests use throwaway homes and fakes.

## Done

| # | PR | Task | Commits (red, then green) |
|---|---|---|---|
| — | A | The spec and this plan | `d99384d508`, `6af858e2ac` (revision after #4399) |
| 1 | A | tmux on a Mac with no Homebrew run | `c99393769a`, `5f0ec8a90a` |
| 2 | A | No child reads the script | `e716899ace`, `9eff089306` |
| 3 | A | The desktop's setup plan names the managed tmux | `6e6097d2a0`, `8100f4f4b1` |
| 5 | B | The window draws the install's step (narrowed: the step only) | `3a0b206ac6`, `bc9fe46bab` |
| 6 | B | A run hands its lines as they arrive | `53a48d137c`, `08119ed4ab` |
| 7 | B | The install shows its step and logs only steps | `b57ee51cca`, `c7cb7416cb` |
| 9 | C | Orca's account homes (`devices/orcaHomes.ts`) | `0b8c0e6841`, `26803e93c6` |
| 10 | C | `externalProviders` takes places | `26d55d56b4`, `9d3a20fe0c` |
| 11 | C | The scan's places (`observedPlaces.ts`) | `be63e4b73b`, `73d5295e5a` |
| 12 | C | The devices service reads Orca's homes; the dial skill in Orca homes through `dialHomeSetup`'s `adopted()` | `8b9b3d0553`, `076530ec33` |
| 14 | C | End to end on the isolated daemon (the Codex case: "with a dial attached") | `51c5144d81` |
| 15 | D | The computer's name | `0e8538675f`, `b0d47639de` |
| 16 | D | A new machine's label is the computer's name | `76b5ff8a8b`, `1a4cf4abac` |

**Dropped (orchestrator, 2026-11-17):** Task 4 (the first-run screens: #4399 sets both agents up with no click, spec decision 1) and Task 13 (the old `enable` and `disable` in Orca homes: replaced by Tasks 13a to 13e). Check 8 (the real `claude` in homes that share `plugins/`) has run and passed: `claude plugin enable` and `disable` work in an Orca-like home whose `plugins/` is linked to the default home's.

## Pull requests

| PR | Branch at PR time | Tasks | Files |
|---|---|---|---|
| A. Installer | `fix/new-user-onboarding-installer` | 1, 2, 3 | `cli/scripts/install.sh`, `cli/src/scripts/install.spec.ts`, `cli/src/lib/tmuxOnPath.ts` (a comment), `desktop/lib/`, `desktop/test/`, `desktop/CLAUDE.md`, `desktop/RELEASE.md`, and the spec and this plan |
| B. Device app (items 3 and 5) | `fix/new-user-onboarding-device-app` | 5, 6, 7, 8 | `device-app/`, `desktop/design/desktop-design-system.md`, `docs/plans/2026-11-13-device-menubar-design.md` |
| C. Orca homes (item 2) | `fix/new-user-onboarding-orca-homes` | 9, 10, 11, 12, 13a, 13b, 13c, 13d, 13e, 14 | `cli/src/` but `cli/src/scripts/install.spec.ts`, `cli/src/lib/tmuxOnPath.ts` and D's files, `cli/e2e/`, `cli/AGENTS.md`, `docs/cli.md`; and `cli/src/cli.ts`, shared with D |
| D. Machine name | `fix/new-user-onboarding-machine-name` | 15, 16 | `cli/src/lib/computerName.ts`, `computerName.spec.ts`, `cli/src/lib/authRefresh.ts`, `cli/src/gateway/upstream.ts`, `upstream.spec.ts`, `cli/src/authCommand.spec.ts`, `cli/src/architecture.spec.ts`, `cli/src/__fixtures__/bundledCli.ts`, `cli/src/__fixtures__/computerNameFake.ts`, `cli/src/device/deviceLink.ts`, `deviceLink.spec.ts`; and `cli/src/cli.ts`, shared with C |

- **One commit, one pull request.** Every commit of a task, and every review fix, touches files of one row only. A fix that spans two rows is two commits. `cli/src/cli.ts` is in two rows: a commit that touches it belongs to C (Task 13d's `DeviceDeps` wiring) or to D (Task 16's two labels), never both. Every D commit's subject starts `Machine name: `, and no other commit's does: the split picks D by subject, since a path cannot tell C's `cli.ts` commits from D's.
- `desktop/design/desktop-design-system.md` is under `desktop/` and goes with B: the design doc's own rule puts a screen's change and its section in one pull request. A touches other `desktop/` files, so the two never meet. B's PR CI runs the Desktop suite too, because of that one file.
- The four are independent and merge in any order. C and D both change `cli/src/cli.ts`, in places far apart: the one merged second integrates `main` and reruns its CLI checks.
- **Split**, once the final review is done:

  ```bash
  git fetch origin
  SRC=fix/new-user-onboarding
  commits() { git log --reverse --format=%H "origin/main..$SRC" -- "$@"; }
  MACHINE=$(git log --reverse --format=%H --grep='^Machine name: ' "origin/main..$SRC")
  git switch -c fix/new-user-onboarding-installer origin/main
  git cherry-pick $(commits cli/scripts/install.sh cli/src/scripts/install.spec.ts desktop/lib desktop/test \
    desktop/CLAUDE.md desktop/RELEASE.md docs/plans/2026-11-17-new-user-onboarding-design.md \
    docs/plans/2026-11-17-new-user-onboarding-plan.md)
  git switch -c fix/new-user-onboarding-device-app origin/main
  git cherry-pick $(commits device-app desktop/design/desktop-design-system.md \
    docs/plans/2026-11-13-device-menubar-design.md)
  git switch -c fix/new-user-onboarding-orca-homes origin/main
  git cherry-pick $(commits cli/src cli/e2e cli/AGENTS.md docs/cli.md ':(exclude)cli/src/scripts/install.spec.ts' \
    | grep -vxF "$MACHINE")
  git switch -c fix/new-user-onboarding-machine-name origin/main
  git cherry-pick $MACHINE
  ```

  Then check: the four branches' commit counts add up to `git rev-list --count origin/main..$SRC`; each D commit names only D's files (`git show --name-only --format= <sha>`); and for each branch `git diff --exit-code $SRC <branch> -- <its files>` prints nothing, `cli/src/cli.ts` left out for C and D (a difference means `main` changed that file since the base: review the cherry-pick's result). For `cli/src/cli.ts`: `git diff fix/new-user-onboarding-orca-homes $SRC -- cli/src/cli.ts` shows only D's lines (the import and the two labels), and `git diff fix/new-user-onboarding-machine-name $SRC -- cli/src/cli.ts` only C's.
- Not in this plan: publishing the installer (`make upload-cli-install-sh`). Until then the CDN serves the old script, and B works with either.
- Each pull request names its platforms and carries its evidence ([Verification](#verification)). Merge and release follow `docs/validation-and-release.md`.

## Layers (the remaining tasks)

| Files | Layer and process | Gate |
|---|---|---|
| `cli/src/devices/claudePlugin.ts` | Shared by the `harness` command and the devices process | `claudePlugin.spec.ts` |
| `cli/src/devices/dialSkillFiles.ts` | Shared: the command writes `dial-skill.json`, the devices process `dial-setup.json` | `dialSkillFiles.spec.ts` |
| `cli/src/cable/dialHomeSetup.ts`, `dialPluginSetup.ts`, `dialSetup.ts`, `cli/src/devices/orcaHomes.ts` | The devices process | their specs |
| `cli/src/services/devices.ts` | The devices process | its spec; `npm run test:core`, 100% per file (local gate) |
| `cli/src/deviceClaude/command.ts`, `cli/src/cli.ts` | The `harness` command's own process | `command.spec.ts` |
| `cli/e2e/` | The isolated daemon | `npm run test:e2e`; the `cli-e2e` workflow |
| `device-app/AGENTS.md`, `desktop/design/desktop-design-system.md`, `docs/plans/2026-11-13-device-menubar-design.md` | Docs | none |

Nothing under `cli/src/core/` or `cli/src/harnessd/` changes, and `cli/src/architecture.coreFiles.txt` gains no line.

## Global Constraints

- **Decisions 1 to 9 of the spec are final** (restated under [Decided](#decided-the-orchestrator-2026-11-17)).
- **The Orca home's call** is exactly `claude plugin enable harness-device@openharness --scope user` to turn on, and `claude plugin disable harness-device@openharness --scope user` to turn off. Never `install`, `uninstall`, `marketplace` or `update` in an Orca home: `plugins/` is shared with the default home, and only the default home installs, updates and uninstalls.
- **`CLAUDE_CONFIG_DIR=<home>`** is set on Harness's own child only, never on `process.env`.
- **When:** the devices pass turns on an Orca home only once the default home's plugin is recorded as set up (`dial-setup.json`'s `plugin` is a version), only while `wanted()` is true (a dial attached here once and `disable` has not removed Claude Code), and never on Windows.
- **The record:** `dial-setup.json` gains `pluginHomes`, the real paths of the Orca homes the devices turned the plugin on in, at most `MAX_HOMES` (64), each `listable`. A home Orca no longer lists is dropped at the next pass after a read that answered. A file from #4399 (no field) reads as none. Its one writer stays the devices process.
- **A recorded home is never enabled again** by the devices, whatever its entry reads.
- **A failed home** is counted `failed` with a fixed step word (`ClaudeStep`), never a path, and tried again no sooner than an hour (`RETRY_MS`, 3 600 000 ms), each home on its own clock.
- **CLI stderr copy, exact:** `Could not turn on Claude Code in one Orca account.` and `Could not turn off Claude Code in one Orca account.`
- **Exit codes:** `enable` exits 0 when the default home succeeded, whatever the Orca homes did. `disable` exits 1 when an Orca home failed.
- **Order:** `enable` sets the default home up whole (plugin, then the removal cleared and the skill) before any Orca home. `disable` saves the removal, then turns off each Orca home, then uninstalls the default home's plugin as on `main`, then removes the skills.
- **No Orca account's email, id or path** in a log line, an error, a measure or stderr. Counts only.
- **No new measure:** the day's tally (`[device] dial setup · claude · …`) counts an Orca home's failure as `failed`; nothing else is added.
- **Device app rules** (`device-app/AGENTS.md`): one log, redacted. **Repo rules:** a test that fails first, no fixed sleeps, comments say why, copy short.

## Review Focus

1. **An Orca read that fails or times out** empties the cache's list. It must not drop the recorded homes, or the next good read would enable again a home the person turned off. Task 13c (`a failed Orca read drops no recorded home`).
2. **Homes that overlap:** the same home twice, an Orca home whose real path is the default home's, a home reached through a link, and the command run inside an Orca terminal, where `CLAUDE_CONFIG_DIR` is already one of them. Each home is run once and the default home never as an Orca one. Task 13c (`the default home listed as an Orca account is never run as one`, `a home listed twice or through a link is one home`), Task 13d (`the command's own home is not run twice`).
3. **A `disable` that lands while the pass enables an Orca home:** the command found it still off and left it, then the pass turned it on. The pass reads `wanted()` again after each home and turns that home off again, recording nothing. Task 13c (`a disable that lands during an Orca home's enable turns that home off again`).
4. **A record damaged or edited by hand,** or one from #4399: a relative path, a control character, more than 64, a non-string. Only what a `listable` list may hold is kept, and #4399's file reads as no Orca home. Task 13b (`a record from #4399 reads with no plugin homes`, `a damaged plugin homes list keeps only what it may hold`).
5. **Many Orca homes, some failing:** each failing home waits its own hour, the others are still tried in the same pass, and the default home's own update still runs. Task 13c (`a failing home waits its hour and the others are still tried`).

## Decided (the orchestrator, 2026-11-17)

Not reopened:

1. **No first-run screens** (dropped after #4399, which sets both agents up with no click).
2. **2A.** macOS never runs brew; the managed tmux otherwise. Every stdin-reading child in `install.sh` gets `</dev/null`.
3. **Orca.** Homes from `orca account list --json`, only `home` kept; they join the open scan and the dial skill. Out of scope: Harness's session and turn hooks in Orca homes (a core change).
4. The step line is fixed copy from a Rust table.
5. The app logs step lines, each run's result, and on a failure the lines shown.
6. Four pull requests by component and topic, built on this branch and split by cherry-pick.
7. **Machine name (D).** macOS's ComputerName, the hostname otherwise.
8. An Orca home is turned off with `claude plugin disable`, and only the default home uninstalls; a Codex session in an Orca Codex home gets its last answer from the scan's roots; the managed tmux check uses a local `file://` manifest only.
9. **After #4399:** Orca Claude Code homes join #4399's automatic setup, each with its own record; a home where the person turned the plugin off stays off; `harness device claude enable` and `disable` cover the Orca homes; an Orca home needs only `claude plugin enable`, since `plugins/` is shared with `~/.claude`.
10. **Scope of the remaining work (2026-11-17):** Task 5 narrowed to the install's step; Task 8 narrowed to the step line and the log; Task 13 replaced by spec section C "The plugin".

## Decided here, where the spec left it to the builder

- **The Orca step runs in the plugin's own pass,** after the default home's step, under the same one-pass-at-a-time guard, so all `claude plugin` runs are one at a time. It runs even when the default home is current (the default home's early return no longer ends the pass).
- **An Orca home already on is recorded with no call.** The pass lists first (`claudeHomeEnable`), so a home turned on by hand or by `enable` costs one `--version` and one `list`, not a write.
- **No disk read when nothing is due:** the pass works out the listed homes' real paths once per Orca read (the cache hands a new list object at each read), compares them with the in-memory record, and reads `dial-skill.json` only when a home is due. A scan with every home recorded runs no `claude` and reads no file.
- **The Orca step's `claude` lookup** uses the default home's shell rule (`SHELL_MS`, and at once at an attach). Not found: nothing counted, asked again at the next pass.
- **A failed save of the record:** that home is counted `failed` with `save`, and the next pass finds it on and records it with no call.
- **An Orca read the command could not make is no Orca home,** and says nothing: the removal mark already keeps every home's hook and mod quiet (`pluginActs` reads it), and with no Orca, the common case, nothing should be said.
- **`disable` leaves both records as they are.** While Claude Code is removed the pass runs nothing; `enable` turns every listed Orca home on again, as it sets the default home up again.
- **No `claude` found by `disable` while an Orca home's settings read on** is that home's failure (its line, exit 1), as `PLUGIN_LEFT_ON` is the default home's.
- **A successful Orca enable counts nothing** in the day's tally: the spec names only `failed`, and `set up` counts the computer's plugin setup.

## Design check (docs/feature-design-rules.md)

The spec's Design section stands. Where each point lands:

| Point | Task |
|---|---|
| 1 Growth: `dial-setup.json` gains `pluginHomes` (real paths, at most 64, unlisted homes dropped); the Orca homes list in memory only; the skill's homes keep their bound | 13b, 13c (done: 9, 12) |
| 2 Concurrency: the step through the app's event queue; the Orca cache one value replaced whole; `claude plugin` runs one at a time (one pass at a time in the devices; one home after another in the command) | 13c, 13d (done: 6, 7, 9) |
| 3 Read cost: one `orca account list` at start and at most every 5 minutes; one more `sessions/` folder per Orca home; a scan with every Orca home recorded runs no `claude` and reads no file | 13c (done: 9, 12) |
| 4 Scale: 50 accounts is one call, 50 folders, and at most 50 homes enabled once each | 13c |
| 5 Compatibility: #4399's `dial-setup.json` (no field) reads as no Orca home set up, so each is enabled once; an older CLI ignores the field | 13b |
| 6 Migration and rollback: none; a rolled-back CLI leaves the Orca homes' entries as they were | 13b |
| 7, 8 Audience and identity: only `home` kept, nothing of it logged; `CLAUDE_CONFIG_DIR` on our own child only | 13a, 13c, 13d |
| 9 Failure: a failed plugin home counted and retried after an hour; from the command, one line | 13c, 13d |
| 10 Platforms | every task's tests; [Verification](#verification) |

If question 1 is answered (a), point 1 also gains `dial-skill.json`'s `pluginHomes` (the command's list, replaced whole at each `enable`, at most 64): the spec's Design section names it in the same pull request.

Numbers for pull request C (rule 4): the `[observed] scan · … ms` lines of Task 14's run with one Orca home and with none, and Task 13e's run.

## Tasks at a glance

| # | PR | Task | Depends on | Effort |
|---|---|---|---|---|
| 8 | B | The docs: the install's step and its log | none | medium |
| 13a | C | The plugin calls for an Orca home (`claudePlugin.ts`) | none | high |
| 13b | C | The record of Orca homes (`dialSkillFiles.ts`, `dialHomeSetup.ts`) | none | xhigh |
| 13c | C | The devices turn the plugin on in each Orca home | 13a, 13b | xhigh |
| 13d | C | `enable` and `disable` in each Orca home | 13a, 13b | xhigh |
| 13e | C | End to end: two Orca homes, a fake dial, then `disable` | 13c, 13d | high |

Longest chain: 13a (or 13b) → 13c → 13e, three tasks. 13c and 13d share no file and run side by side. Task 8 runs at any time.

---

### Task 8: The docs: the install's step and its log

**PR:** B. **Depends on:** none (written from the spec and Tasks 5 and 7, done). **Effort:** `medium`. No behavior change: one commit, no red test.

**Files:**
- Modify: `device-app/AGENTS.md`, `desktop/design/desktop-design-system.md`, `docs/plans/2026-11-13-device-menubar-design.md`

- [ ] **Step 1: Edit.**
  - `device-app/AGENTS.md`, the "One log, redacted" rule: an install logs its step lines (`▸`, `✓`, `✗`), each run's result and, after a failure, the lines the screen shows; never the rest of what a run prints.
  - `desktop/design/desktop-design-system.md`, the Harness Device section: the Install screen's working state is the spinner with one muted body line under it, the step, fixed copy (`Getting ready…`, `Installing tmux…`, `Downloading Harness…`), never the script's text. The gallery sentence stands: Task 5 already put the step into `Install · working`.
  - `docs/plans/2026-11-13-device-menubar-design.md`, the Install section: "Setting up Harness" shows the step under the spinner, from a fixed table of the script's step lines; the sentence "The output goes to the app's log" becomes what the log holds (above). Name the change `(2026-11-17, docs/plans/2026-11-17-new-user-onboarding-design.md)`.
- [ ] **Step 2: Check** `git diff --stat` names only these three files, and `grep -n "output goes to the app's log" docs/plans/2026-11-13-device-menubar-design.md` prints nothing.
- [ ] **Step 3: Commit** `Docs: Setting up Harness shows its step, and the log holds steps and results`.

---

### Task 13a: The plugin calls for an Orca home

**PR:** C. **Layer:** shared by the `harness` command and the devices process. **Depends on:** none. **Effort:** `high`.

**Red test:** `cli/src/devices/claudePlugin.spec.ts`.

**Files:**
- Modify: `cli/src/devices/claudePlugin.ts`, `cli/src/devices/claudePlugin.spec.ts`

**Interfaces:**
- Produces, for Tasks 13c and 13d:

  ```ts
  export type ClaudeStep = 'unsupported' | 'list' | 'marketplace' | 'install' | 'enable' | 'disable' | 'uninstall' | 'update'
  /** Turns the plugin on in a home that shares `plugins/` with the default home (an Orca account's): its files are
   *  there already, so only this home's settings change. One already on there runs nothing more. */
  export async function claudeHomeEnable(deps: ClaudeDeps): Promise<ClaudeResult>
  /** Turns it off in such a home's settings and leaves its files: an uninstall here would remove what every home names. */
  export async function claudeHomeDisable(deps: ClaudeDeps): Promise<ClaudeResult>
  /** Claude Code as claudeRun() finds it, pointed at [home]: CLAUDE_CONFIG_DIR on this child alone. null: no `claude`. */
  export function claudeRunIn(home: string): ClaudeRun | null
  ```
- `claudeHomeEnable`: `supportedRun` (else `UNSUPPORTED`); `userEntry` (a failure is `list`); an entry with `enabled === true` is `{ ok: true }`; otherwise one `change(run, ['plugin', 'enable', DIAL_PLUGIN_ID, '--scope', 'user'], LOCAL_MS, 'enable')`. Never `install` or `marketplace`.
- `claudeHomeDisable`: `run` null is `{ ok: true }` (the command checks the settings itself, Task 13d); `userEntry` (a failure is `list`); no entry, or one not on, runs nothing and is `{ ok: true }`; otherwise one `change(…, ['plugin', 'disable', DIAL_PLUGIN_ID, '--scope', 'user'], LOCAL_MS, 'disable')`. Never `uninstall`.
- `claudeRunIn(home)`: `installedEngineBin('claude')`, then `claudeRunner(bin, { ...process.env, CLAUDE_CONFIG_DIR: home })`.

- [ ] **Step 1: Write the failing tests,** with the spec's fake `run` that records each call.
  - `describe('claudeHomeEnable')`: `turns the plugin on in that home with enable alone` (listed off: calls are `--version`, `plugin list --json`, `plugin enable harness-device@openharness --scope user`, and none of `install`, `marketplace`, `update`); `one already on runs nothing more` (no `enable` call); `not listed there, it still runs enable, and a failure is the first line Claude Code wrote, step enable`; `a list that cannot be read is step list`; `an old Claude Code is unsupported and asked nothing more`.
  - `describe('claudeHomeDisable')`: `turns the plugin off and never uninstalls it`; `an entry not listed or already off runs nothing`; `a failure is the first line Claude Code wrote, step disable`; `no claude is ok and runs nothing`.
  - `describe('claudeRunIn')`: `the child gets CLAUDE_CONFIG_DIR and process.env does not`: a fake `claude` script (as `describe('claudeRun')` makes one) that prints its `CLAUDE_CONFIG_DIR`; it prints the home; `process.env.CLAUDE_CONFIG_DIR` is what it was before.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/claudePlugin.spec.ts`. Expected: FAIL (the functions are not there). Commit `Dial: tests for turning the plugin on and off in a shared home`.
- [ ] **Step 3: Implement.** The comment above the two functions says why only `enable` and `disable` run in such a home: check 8 showed an uninstall in one home removes the files every home names, and the others' entries then stay on.
- [ ] **Step 4: Run** `npx vitest run src/devices src/deviceClaude && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: the plugin is turned on and off in a home that shares its files`.

### Task 13b: The record of Orca homes

**PR:** C. **Layer:** shared files in the data folder; the devices process's record. **Depends on:** none. **Effort:** `xhigh` (a stored record, read by two processes).

**Red test:** `cli/src/devices/dialSkillFiles.spec.ts`, `cli/src/cable/dialHomeSetup.spec.ts`.

**Files:**
- Modify: `cli/src/devices/dialSkillFiles.ts`, `dialSkillFiles.spec.ts`, `cli/src/cable/dialHomeSetup.ts`, `dialHomeSetup.spec.ts`

**Interfaces:**
- Produces, in `dialSkillFiles.ts`:

  ```ts
  export interface DialSetupRecord { dial: boolean; plugin?: string; homes: DialSkillHomes; pluginHomes: string[] }
  // Per question 1 (a): the command's own list, in dial-skill.json.
  /** The Orca homes `harness device claude enable` turned the plugin on in, by real path. */
  export function readPluginHomes(dataDir: string): Read<{ homes: string[] }>
  /** Replaces that list whole; the removal marks and the skill folders stay. undefined once saved, else the error's code. */
  export function writePluginHomes(dataDir: string, homes: string[]): string | undefined
  ```
  `setupOf` reads `pluginHomes` through `homesOf` (each `listable`, each once, at most `MAX_HOMES`); a file with no field reads `[]`. `writeSetup` writes it as `setupOf` keeps it. `writeRemoved` keeps `pluginHomes` (it rewrites the file whole today and would drop it), and `writePluginHomes` keeps `removed` and `homes`; a list emptied leaves the key out, as `homes` does. The head comment names the new field in each file and its one writer.
- Produces, on `DialHomeSetup` (the record's one writer, as `plugin()` and `recordPlugin()` are):

  ```ts
  /** The Orca homes the devices turned the plugin on in, by real path. */
  pluginHomes(): readonly string[]
  /** Replaces that list and saves the whole record; false when it could not be saved, and the list is as before. */
  recordPluginHomes(homes: string[]): boolean
  ```
  Every other save of the record (`save`, `attached`'s first save, `recordPlugin`) keeps `pluginHomes`: the record is one value in memory, saved whole.

- [ ] **Step 1: Write the failing tests,** in throwaway data folders.
  - `dialSkillFiles.spec.ts`:
    - `a record from #4399 reads with no plugin homes`: `{"dial":true,"plugin":"0.6.59","homes":{"claude":[],"codex":[]}}` reads with `pluginHomes: []` and the rest as it was.
    - `plugin homes are written and read back`; `a damaged plugin homes list keeps only what it may hold` (a relative path, a control character, a number, a duplicate, 70 paths: 64 kept, each once).
    - `the command's plugin homes are kept by every write of dial-skill.json`: `writePluginHomes` then `writeRemoved('claude', true)` then `writeRemoved('codex', false, [...])`: the list is still there, and `writePluginHomes` keeps `removed` and `homes`.
    - `an unreadable dial-skill.json reads as unread and is not written`: `writePluginHomes` returns the code and the file is unchanged (mode 000, skipped as root).
  - `dialHomeSetup.spec.ts`:
    - `recordPluginHomes saves the whole record`: after it, `readSetup` has `dial`, `plugin`, the skill homes and the new list.
    - `a record that cannot be saved keeps the list as before and says false`.
    - `the skill's own saves keep the plugin homes`: record two homes, then a pass that writes a Codex home: the file still holds them.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/dialSkillFiles.spec.ts src/cable/dialHomeSetup.spec.ts`. Expected: FAIL. Commit `Dial: tests for the record of Orca homes the plugin was turned on in`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/devices src/cable src/deviceClaude && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: the record keeps the Orca homes the plugin was turned on in`.

### Task 13c: The devices turn the plugin on in each Orca home

> Decision 10 (2026-11-17, after this plan): the Orca step runs only while the default home's plugin reads on in its settings; a home in either `dial-setup.json`'s or `dial-skill.json`'s `pluginHomes` counts as recorded, and the devices write only `dial-setup.json`. Where this task's text below differs, decision 10 wins.

**PR:** C. **Layer:** the devices process. **Depends on:** 13a (`claudeHomeEnable`, `claudeHomeDisable`, `ClaudeStep`), 13b (`pluginHomes`, `recordPluginHomes`, `readPluginHomes`). **Effort:** `xhigh` (a stored record, a pass that runs `claude` against other accounts' settings, a file under the 100% gate).

**Red test:** `cli/src/cable/dialPluginSetup.spec.ts`, `cli/src/cable/dialSetup.spec.ts`, `cli/src/devices/orcaHomes.spec.ts`, `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/cable/dialPluginSetup.ts`, `dialPluginSetup.spec.ts`, `cli/src/cable/dialSetup.ts`, `dialSetup.spec.ts`, `cli/src/devices/orcaHomes.ts`, `orcaHomes.spec.ts`, `cli/src/services/devices.ts`, `devices.spec.ts`, `cli/AGENTS.md` (the devices row)

**Interfaces:**
- `OrcaHomesCache` gains `answered(): boolean`: the last read gave Orca's answer (false before the first read and after a failed one).
- `DialPluginSetupDeps` gains:

  ```ts
  /** The default home, which the Orca step never runs in. */
  home: string
  /** Claude Code found as claude() is, pointed at [home]. */
  claudeIn(home: string, shell: boolean): Promise<ClaudeRun | null>
  /** Orca's Claude Code homes from its last read; answered: that read gave Orca's answer. */
  orca(): { homes: readonly string[]; answered: boolean }
  /** dial-setup.json's pluginHomes, and its writer. */
  pluginHomes(): readonly string[]
  recordPluginHomes(homes: string[]): boolean
  /** Per question 1 (a): the homes `enable` recorded in dial-skill.json, read only when a home is due. */
  enabledByCommand(): Read<{ homes: string[] }>
  ```
- `DialSetupDeps` gains `orcaClaude(): { homes: readonly string[]; answered: boolean }`; `createDialSetup` wires `home: deps.claudeHome`, `claudeIn: deps.claude`, `orca: deps.orcaClaude`, `pluginHomes`/`recordPluginHomes` from the home setup, `enabledByCommand: () => readPluginHomes(deps.dataDir)`. `services/devices.ts` gives `orcaClaude: () => ({ homes: orcaHomes.get().claude, answered: orcaHomes.answered() })`.
- The pass: after the default home's step (now skipped, not returned from, when the version is current or within its hour), the Orca step:
  1. The listed homes by real path (`realpathSync`; one that does not resolve is left out), each once, the default home's real path left out. Worked out again only when `orca().homes` is a new list.
  2. When `answered`, recorded homes not in that list leave the record (`recordPluginHomes`).
  3. Due: listed, not recorded, not within its own hour. None due: the step ends, with no file read and no `claude`.
  4. Then only when `recorded()` is a version, `wanted()` is true and the command's list reads (not `unread`); a home in the command's list is not due.
  5. One home after another: `claudeIn(home, shell)` (null: the step ends, nothing counted); `claudeHomeEnable`. A failure: `count('failed', step)`, that home waits an hour. Success: `wanted()` read again; false: `claudeHomeDisable` on that home and nothing recorded; else the home is added to the record (at most `MAX_HOMES`) and saved, a failed save counted `failed` with `save`.
  6. The per-home hours are kept only for listed homes, so the map is bounded by the list.
- `pass()`'s return stays what it was: true only when the default home's plugin was installed or updated.

- [ ] **Step 1: Write the failing tests.**
  - `orcaHomes.spec.ts`: `answered says whether the last read gave Orca's answer`: false before a read, true after a good one, false after a failed one, true again after a good one.
  - `dialPluginSetup.spec.ts`, with the spec's `rig` gaining the new deps and a fake `claudeIn` that records each call's home:
    - `each Orca home is turned on once, with that home alone, and recorded`: two homes in throwaway folders; after a pass, `claudeIn` was asked for each, each got `plugin enable … --scope user` and no `install`; the record holds both real paths; a second pass runs no `claude`.
    - `nothing runs in an Orca home before the default home is recorded`, and `nothing while Claude Code is removed, or not wanted`, and `nothing on Windows`.
    - `a recorded home is never enabled again`: a home recorded and its entry off: no `enable`.
    - `an Orca home already on is recorded with no enable`.
    - `the default home listed as an Orca account is never run as one`; `a home listed twice or through a link is one home`.
    - `a new Orca home is turned on at the next pass`: the list grows between passes.
    - `a home Orca no longer lists leaves the record`, and `a failed Orca read drops no recorded home` (`answered` false, list empty: the record is unchanged).
    - `a failing home waits its hour and the others are still tried`: home A's `enable` fails (step `enable`, counted `['failed', 'enable']`, no path in any count or log line); home B is recorded in the same pass; at `HOUR - 1` A is not tried, at `HOUR` it is.
    - `a disable that lands during an Orca home's enable turns that home off again`: `wanted()` goes false inside the fake's `enable`; that home then gets `plugin disable`, and the record holds nothing.
    - `a home the command recorded is not run`; `a command list that cannot be read runs nothing in Orca homes`.
    - `the default home's update still runs with Orca homes due`: a new version recorded, and the Orca step after it.
    - `a scan with every Orca home recorded reads no file`: as the spec's `a pass with this version recorded … reads no file`, with two homes recorded.
    - `a record that cannot be saved counts failed save, and the next pass records the home with no enable`.
  - `dialSetup.spec.ts`: `the Orca step uses the home setup's record`: after a pass, `readSetup(dataDir).pluginHomes` holds the home.
  - `devices.spec.ts`: `the dial setup is given Orca's Claude Code homes and whether the read answered`: with `fakeOrcaHomes({ claude: [home], codex: [] })` and a fake `claude` that records its homes, a dial attach turns the plugin on in `home` and `dial-setup.json` records it. The spec's `fakeOrcaHomes` gains `answered`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/orcaHomes.spec.ts src/cable/dialPluginSetup.spec.ts src/cable/dialSetup.spec.ts src/services/devices.spec.ts`. Expected: FAIL. Commit `Dial: tests for the plugin in each Orca account's home`.
- [ ] **Step 3: Implement.** `dialPluginSetup.ts`'s head comment gains why: Orca runs Claude Code under its own account homes, which share `plugins/` with `~/.claude`, so the files are there and only each home's entry is turned on, once; one the person turned off stays off. `cli/AGENTS.md`'s devices row: after "Claude Code's `harness-device` plugin", add "and, once that is set up, the plugin turned on in each Orca account's Claude Code home (`claude plugin enable`), each home once, recorded in `dial-setup.json`".
- [ ] **Step 4: Run** `npx vitest run src/cable src/devices src/services/devices.spec.ts src/architecture.spec.ts && npm run typecheck && npm run test:core`. Expected: PASS, `services/devices.ts` at 100%.
- [ ] **Step 5: Commit** `Dial: the plugin is turned on in each Orca account's home, once`.

### Task 13d: `enable` and `disable` in each Orca home

**PR:** C. **Layer:** the `harness` command. **Depends on:** 13a (`claudeHomeEnable`, `claudeHomeDisable`, `claudeRunIn`), 13b (`writePluginHomes`, per question 1 (a)). **Effort:** `xhigh` (it changes the settings of several accounts).

**Red test:** `cli/src/deviceClaude/command.spec.ts`.

**Files:**
- Modify: `cli/src/deviceClaude/command.ts`, `command.spec.ts`, `cli/src/cli.ts` (the `device` case's deps), `docs/cli.md` (the `harness device claude` row)

**Interfaces:**
- `DeviceDeps` gains:

  ```ts
  /** Orca's Claude Code account homes; none when Orca is not here or could not be read. Asked only by claude enable and disable. */
  orcaHomes(): Promise<string[]>
  /** Claude Code pointed at [home], with CLAUDE_CONFIG_DIR on that child alone. */
  claudeIn(home: string): ClaudeRun | null
  ```
  `cli.ts`: `orcaHomes: () => readOrcaHomes(orcaHomesDeps()).then((read) => read.homes.claude)`, `claudeIn: claudeRunIn`.
- The Orca homes the command runs: each by real path, once; one whose real path is the command's own home's (`claudeHome()`) is left out.
- `enable`: as today; only when `turnOn` returned 0, `claudeHomeEnable({ run: deps.claudeIn(home), platform })` for each home, one after another. A failure prints `Could not turn on Claude Code in one Orca account.` (once per failed home) and the next is still tried. Then `writePluginHomes(dataDir, <the homes that succeeded>)` (question 1 (a)); a failed save prints `Could not save the dial setting.` and exits 1. Otherwise exit 0.
- `disable`: inside `turnOff`'s plugin step, after the removal is saved: for each Orca home, with `deps.claudeIn(home)` null and that home's `settings.json` reading on (`claudePluginState`), or `claudeHomeDisable` failing, it prints `Could not turn off Claude Code in one Orca account.` (once per failed home). Then the default home's step as today. `turnOff` returns 1 when an Orca home failed; its own first error, if any, is still printed.
- `DEVICE_USAGE`'s two `claude` lines say "…, in each Orca account too". `status` and Codex's verbs do not change and ask Orca nothing.

- [ ] **Step 1: Write the failing tests,** with a fake `claudeIn` that records each call's home and arguments, and `orcaHomes` returning throwaway homes.
  - `enable turns the plugin on in each Orca home after the default home`: the default home's calls come first and carry no home; each Orca home gets `plugin enable … --scope user` and never `install`; at the first Orca call `dial-skill.json` has no removal and the default home holds the skill; exit 0, stderr empty; `process.env.CLAUDE_CONFIG_DIR` is unchanged; `readPluginHomes` holds both real paths.
  - `a home that fails to turn on prints one line and the command still exits 0`: stderr is exactly the line, though the fake's stderr named a path; the next home is still tried and recorded.
  - `an enable that fails in the default home asks Orca nothing`.
  - `the command's own home is not run twice`: listed as itself and through a link.
  - `disable turns off each Orca home first, then the default home`: each Orca home gets `plugin disable … --scope user` and never `uninstall`; the default home's `uninstall` comes last; `dial-skill.json` says Claude Code removed at the first Orca call.
  - `a home that fails to turn off prints one line and the command exits 1`: the default home is still uninstalled and the skills removed.
  - `with no claude and an Orca home's settings on, disable says that home failed`.
  - `with no Orca home, or Orca not read, enable and disable are as before`; `status and Codex's verbs ask Orca nothing`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/deviceClaude`. Expected: FAIL. Commit `Dial: tests for turning Claude Code on and off in Orca's accounts`.
- [ ] **Step 3: Implement.** `command.ts`'s head comment says why Orca homes are turned off first and never uninstalled: they share `plugins/` with the default home, and an uninstall there first would leave their entries on (check 8). `docs/cli.md`'s `harness device claude` row: `enable` and `disable` also turn the plugin on or off in each Orca account's Claude Code home; a home that fails says so in one line.
- [ ] **Step 4: Run** `npx vitest run src/deviceClaude src/devices src/cliCommand.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: Turn on and Turn off reach Claude Code in Orca's accounts`.

### Task 13e: End to end: two Orca homes, a fake dial, then `disable`

**PR:** C. **Layer:** `cli/e2e`. **Depends on:** 13c, 13d. **Effort:** `high`. No product behavior change: one commit, no red test. Step 2 proves the spec can fail.

**Files:**
- Modify: `cli/e2e/deviceOrcaHomes.e2e.ts`, `cli/e2e/harness/fakeEngine.mjs`

**Interfaces:**
- The fake `claude plugin` learns `disable`, as Claude Code writes it: the plugin stays installed and the home's `enabledPlugins` entry becomes `false`. Its `plugins/` state is per home through `CLAUDE_CONFIG_DIR`, so a home whose `plugins` links to the default home's shares it, as Orca's do.
- An Orca-like Claude Code home here: `plugins` and `projects` linked to the default home's, its own `settings.json` and `sessions/`.

- [ ] **Step 1: Write the specs,** on the file's `fresh`/`plugged` setup (an `IsolatedDaemon` with `CABLE_DISABLE=false` and the fake dial; `fresh` gains an optional `claudeVersion` and these tests pass `'2.1.287'`, as `deviceDialSkill.e2e.ts` does, so the fake Claude Code can take the plugin) and `deviceDialSkill.e2e.ts`'s `pluginCalls`, `setupRecord`, `pluginOn` and `device` helpers (moved to a shared place in `cli/e2e/harness/` only if both files need them; otherwise copied as the file's own).
  - `with a dial attached, the plugin is turned on in each Orca account's home and recorded`: two Orca-like homes listed by the fake `orca`. After `plugged`: the default home installed, then both homes `pluginOn`; `setupRecord(d).pluginHomes` holds both real paths; `pluginCalls` has `plugin enable harness-device@openharness --scope user` twice and one `install`. The log has no home path and no `example.invalid`.
  - `a home the person turned off stays off`: the fake `claude plugin disable` run with `CLAUDE_CONFIG_DIR` at home A, as `/plugin` would; unplug, plug again, wait for the next `[observed] scan` line: A still off, B on, no new `enable` call.
  - `disable turns every home off, and enable turns them on again`: `device(d, ['claude', 'disable'])` exits 0 with stderr empty; A, B and the default home read off and the default home's plugin is uninstalled; then `device(d, ['claude', 'enable'])` exits 0 and all three read on. The command's PATH has the daemon's, so it reads the same fake `orca`.
- [ ] **Step 2: Prove it can fail.** Run the first test with the fake `orca`'s accounts left out. Expected: it times out waiting for home A. Put them back.
- [ ] **Step 3: Run** `cd cli && E2E_BUNDLE=1 TMPDIR=/tmp npm run test:e2e -- e2e/deviceOrcaHomes.e2e.ts e2e/deviceDialSkill.e2e.ts e2e/deviceClaudeOrca.e2e.ts`. Expected: PASS. Note the `[observed] scan · … ms` lines for the pull request.
- [ ] **Step 4: Commit** `Dial: end to end, Claude Code's plugin in each Orca account's home`.

---

## Verification

None of these touches the person's daemon (18473), `~/.harness`, `~/.claude`, `~/.codex`, Orca profiles, tmux server, real `orca`, or `brew`. A check that could not be run is reported as not verified, never as passed.

**Platforms each pull request names.** A: macOS (the ladder), Linux (apt's redirect), the desktop app on macOS; Windows only by a test's name in a list. B: Harness Device on macOS, and Linux in PR CI. C: the daemon and the command on macOS and Linux; Windows makes no Orca read and runs no Orca step. D: macOS (ComputerName), Linux and Windows (the hostname, as today).

**Temporary workflow:** none. The one long check, the CLI's end-to-end suite, has its workflow (`.github/workflows/cli-e2e.yml`), and its nightly run takes the new tests from then on. The other checks are short, or need this Mac: a real `/bin/sh`, the app's window.

**In PR CI, nothing started by hand:** A runs `cli-typecheck`, `cli-tests` and `desktop-tests`; B runs `device-app-checks` and `desktop-tests`; C runs the CLI's suites and the suites that read its files; D runs `cli-typecheck` and `cli-tests`.

**Local gates PR CI does not run:**

| PR | Gate | How |
|---|---|---|
| A | none listed for its paths (`python3 scripts/local-checks.py --list` prints `{}`) | checks 1 to 3 below, recorded in the pull request |
| B | Harness Device on macOS (`docs/validation-and-release.md`) | check 4, recorded by hand in the pull request |
| C | `cli-core`: `npm run test:core`, 100% per file for `services/devices.ts` | `python3 scripts/local-checks.py --run` from a clean tree at C's final commit; paste its fence into the pull request's body before the push |
| C | no new core file | `git diff --stat origin/main -- cli/src/core cli/src/harnessd cli/src/architecture.coreFiles.txt` prints nothing |
| D | none listed for its paths (`python3 scripts/local-checks.py --list <D's files>` prints `{}`) | check 10, recorded in the pull request |
| D | no new core file | the same `git diff --stat` as C's prints nothing |

**1. The installer's spec on this Mac (A).** `cd cli && npx vitest run src/scripts/install.spec.ts`. Every test passes; macOS's `/bin/sh` is where the piped tests were red before Task 2.

**2. The real `/bin/sh`, piped, with no network (A).** On this Mac, in `T=$(mktemp -d /tmp/nuo.XXXXXX)`:
- Set up: `$T/bin/brew` and `$T/brew/bin/brew` append their arguments to `$T/brew.log`; a manifest `$T/manifest.json` for this Mac's platform key, one key a line as the spec's `managedFixture` writes it, whose `url` is `file://$T/tmux.tar.gz`, an archive of a script that prints `tmux 9.9`, with its real sha256.
- Run: `env -i HOME="$T/home" SHELL=/bin/zsh PATH="$T/bin:/usr/bin:/bin:/usr/sbin:/sbin" HARNESS_HOMEBREW_PREFIXES="$T/brew" HARNESS_TMUX_METADATA_URL="file://$T/manifest.json" /bin/sh -c 'cat cli/scripts/install.sh | /bin/sh -s -- --host'`.
- A person should see `▸ Installing the managed tmux into …`, `✓ tmux ready (tmux 9.9)`, `✓ Host requirements ready.`; `$T/home/.local/bin/tmux` links into `$T/home/.harness/runtime`; `$T/brew.log` does not exist.
- Again in a fresh `HOME="$T/home2"`, with a `tmux` that prints `tmux 3.7c` in `$T/brew/bin` and the manifest URL at a file that is not there: `✓ tmux ready (tmux 3.7c)`, no link, no `brew.log`.
- Afterwards `rm -rf "$T"`. Only the local `file://` manifest is used (decision 8). On GitHub: none; PR CI runs the same ladder against fakes.

**3. The desktop's tests (A).** Task 3's Step 4, on this Mac. Not started: the Windows desktop workflow, which is manual and heavy; only a test's name changes there.

**4. Harness Device on macOS (B).** `(cd device-app/ui && npm ci && npm run typecheck && npm test && npm run build) && cd device-app/src-tauri && cargo test --locked`, on this Mac. All pass. This is the macOS proof: PR CI compiles Linux only.

**5. The gallery (B).** `cd device-app/ui && npm run gallery && open gallery.html`. Every frame 420 × 320, nothing clipped, `Install · working` with `Installing tmux…` under the spinner, muted, light and dark. **Needs the user's eye:** the tester sends the screenshot; the person says the look is right.

**6. The real app, isolated, against fakes (B).** On this Mac, the unbundled debug binary in the isolated shell of `docs/plans/2026-11-13-device-menubar-plan.md` (Verification: `$T/env`, the recording `open` and `curl`, `FAKE_HARNESS`, a `state.json` whose `loginItem` is true so macOS is asked for no login item). Screenshots go to the person, who checks the look.

| Row | Set up | What a person should see |
|---|---|---|
| First run | no `HARNESS_DEVICE_CLI`; `state.json` `{"version":1,"cliSeen":false,"askedSignIn":false,"loginItem":true}`; a `curl` that prints a script: for `--host` it prints 300 lines of noise and `▸ Installing the managed tmux into /x`, then waits for `$T/fake/s1`; for `--desktop` it prints `▸ Installing the Harness Node runtime into /x`, waits for `$T/fake/s2`, then copies the fake CLI to `$HOME/.local/bin/harness`. Signed out | **Setting up Harness** with `Getting ready…`, then `Installing tmux…`; `touch s1`: `Downloading Harness…`; `touch s2`: **Sign in**. The log has the two `install: ▸ …` lines and both results, and no line of the noise |
| The install fails | the `curl` script prints six lines and exits 6 | the last four lines and Retry; the log has `install: --host exit 6` and four `install: last: …` lines; Retry starts at `Getting ready…` |

At the end: quit the app, `rm -rf "$T"`, and `lsof -nP -iTCP:18473 -sTCP:LISTEN -t` prints the pid it printed before.

**7. The devices on a real daemon with a fake dial (C).**
- On this Mac, at the final head: `cd cli && E2E_BUNDLE=1 TMPDIR=/tmp npm run test:e2e -- e2e/deviceOrcaHomes.e2e.ts e2e/deviceWithoutApp.e2e.ts e2e/deviceDialSkill.e2e.ts e2e/deviceClaudeOrca.e2e.ts e2e/dialOrcaFocus.e2e.ts`. Isolation: the suite's `IsolatedDaemon` (`cli/AGENTS.md` rule 6; `docs/development.md`, "Isolated end-to-end testing"): a throwaway home, data folder and auth folder, its own port and tmux server, fake engines (the fake `claude plugin` among them), the backend at `127.0.0.1:9`, the dial a fake on a pseudo-terminal, and a fake `orca` first on its PATH so the real Orca never runs.
- What passes: every test. A Claude Code session in an Orca-like home is on the dial's list, named from that home's record, and the log holds counts only.
- On GitHub, by hand, once: Actions → CLI end to end → Run workflow, on the pushed branch that holds C's commits. Every shard passes. Report the run link.

**8. The real Claude Code in throwaway homes that share `plugins/` (C).** Done before Task 13a: passed (the orchestrator, 2026-11-17). `claude plugin enable` and `disable` in Orca-like homes whose `plugins/` links to the default home's: each lists the plugin, each turns on, and after their disable each reads off while the default home stays on.

**9. Both Orca homes enabled, recorded, then turned off (C).** Task 13e's specs, run in check 7's command on this Mac at the final head, and in the same by-hand `cli-e2e` run on GitHub. With this branch's CLI, two throwaway Orca-like homes (their `plugins` and `projects` linked to the daemon's own Claude Code home, as Orca links them), the fake `orca` listing them and a fake dial attached in the devices service. Passes when: both homes end with `harness-device@openharness` on and both real paths in `dial-setup.json`'s `pluginHomes`; a home turned off as `/plugin` would stays off after a replug; `harness device claude disable` exits 0 and leaves all three homes off with the default home's plugin uninstalled; `enable` turns them on again.

**10. The computer's name (D).**
- `cd cli && npx vitest run src/lib/computerName.spec.ts src/authCommand.spec.ts src/gateway/upstream.spec.ts src/device/deviceLink.spec.ts src/architecture.spec.ts`, on this Mac. All pass. PR CI runs them on Linux.
- On this Mac, read only: `cd cli && node --import tsx -e "import('./src/lib/computerName.ts').then((m) => console.log(m.computerName()))"` prints what `scutil --get ComputerName` prints. Nothing runs `scutil --set`.
- No end-to-end run against a backend: the label reaches only the backend's create of a new machine or device binding (the adapter-ws label stays the hostname, spec D), and a check against production is not planned. The four callers' bodies are checked against fake backends in the unit tests.

**Not planned here:**
- The spec's last check, Orca's real sessions on the person's dial with nothing pressed. It needs their own Orca accounts and dial: **the user's own**, after the merge; no tester runs it.
- Whether `orca account list` starts Orca when it is not running. The 5 s deadline bounds it either way.

**Proposal, not in this plan:** none of these checks needs a new permanent workflow.

## Open questions

None. Both were answered by spec decision 10 (the orchestrator, 2026-11-17): (a) for the record, and the Orca step runs only while the default home's plugin reads on.
