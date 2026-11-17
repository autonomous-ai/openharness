# Harness Device: a new user's first run — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** updated to the approved spec (decisions 1 to 8, 2026-11-17). No open question.

**Goal:** A brand-new user who installs Harness Device on a Mac sees what the install is doing, gets tmux with no Homebrew run, is asked once to turn on Claude Code and Codex, sees the Claude Code sessions Orca runs under its own accounts on the dial, has an app log of step lines and results only, and gets a new machine named as the Mac is in System Settings.

**Architecture:**
- **Installer.** On a Mac `install.sh` finds a tmux that is already there (on PATH, or in a Homebrew prefix's `bin`) and otherwise downloads the managed build. It never runs `brew`. Every program it starts that could read its stdin gets `</dev/null`, so a script piped into `/bin/sh -s` is never swallowed. The desktop app's "with Homebrew" plan copy and its probe go.
- **Device app.** `Screen::Claude` and `Screen::Codex` come back for a first run, on what #4389 removed. The install's output is read line by line as it arrives: a fixed Rust table turns a script step line into fixed copy under the spinner, and only step lines and results reach the log.
- **Orca homes.** A new module asks Orca's own CLI for its account homes and keeps only `home`. The devices process adds them to the open scan's places and to the dial skill writer's homes. `harness device claude enable` and `disable` run the plugin steps once per Orca Claude Code home, with `CLAUDE_CONFIG_DIR` on the child alone (`disable` there is `claude plugin disable`; only the default home uninstalls). Nothing in the daemon core changes.
- **Machine name.** A new module `cli/src/lib/computerName.ts` reads macOS's ComputerName once per process, with the hostname as the fallback. The four places that send a new machine's label use it. No core-loaded file imports it.

**Tech Stack:** POSIX sh and vitest (`cli/scripts`, `cli/src/scripts`); Dart and Flutter (`desktop/`); Rust and Tauri 2 (`device-app/src-tauri`); plain TypeScript (`device-app/ui`); TypeScript daemon and CLI (`cli/src`, `cli/e2e`).

**Spec:** [docs/plans/2026-11-17-new-user-onboarding-design.md](2026-11-17-new-user-onboarding-design.md). Read it with this plan: the plan argues from it.

## Base

- Branch `fix/new-user-onboarding`, from `main` at `b9a7280863`. All 16 tasks are built on this one branch and split into four pull requests at the end ([Pull requests](#pull-requests)).
- Before the first task: `cd cli && npm ci`; `cd device-app/ui && npm ci && npm run build` (the app's binary embeds `ui/dist`); `cd desktop && flutter pub get` (Flutter 3.47 or later). One `CARGO_TARGET_DIR` outside the repository compiles Tauri's dependencies once.
- Tasks name code by name. A line number is the base's and only a hint. If a name below is gone, stop and report.
- Never touched by a task, a test or a check: the person's `~/.claude`, `~/.codex`, Orca profiles, `~/.harness`, daemon (port 18473), tmux server, the real `orca`, `claude` plugin state and `brew`. Tests use throwaway homes and fakes.

## Pull requests

| PR | Branch at PR time | Tasks | Files |
|---|---|---|---|
| A. Installer | `fix/new-user-onboarding-installer` | 1, 2, 3 | `cli/scripts/install.sh`, `cli/src/scripts/install.spec.ts`, `desktop/lib/`, `desktop/test/`, `desktop/CLAUDE.md`, `desktop/RELEASE.md`, and the spec and this plan |
| B. Device app | `fix/new-user-onboarding-device-app` | 4, 5, 6, 7, 8 | `device-app/`, `desktop/design/desktop-design-system.md`, `docs/plans/2026-11-13-device-menubar-design.md`, `docs/plans/2026-11-16-dial-skill-every-home-design.md` |
| C. Orca homes | `fix/new-user-onboarding-orca-homes` | 9, 10, 11, 12, 13, 14 | `cli/src/` but `cli/src/scripts/install.spec.ts` and D's files, `cli/e2e/`, `cli/AGENTS.md`, `docs/cli.md`; and `cli/src/cli.ts`, shared with D |
| D. Machine name | `fix/new-user-onboarding-machine-name` | 15, 16 | `cli/src/lib/computerName.ts`, `computerName.spec.ts`, `cli/src/lib/authRefresh.ts`, `cli/src/gateway/upstream.ts`, `upstream.spec.ts`, `cli/src/authCommand.spec.ts`, `cli/src/architecture.spec.ts`, `cli/src/__fixtures__/bundledCli.ts`, `cli/src/__fixtures__/computerNameFake.ts`; and `cli/src/cli.ts`, shared with C |

- **One commit, one pull request.** Every commit of a task, and every review fix, touches files of one row only. A fix that spans two rows is two commits. `cli/src/cli.ts` is in two rows: a commit that touches it belongs to C (Task 13's `DeviceDeps.orcaHomes` wiring) or to D (Task 16's two labels), never both. Every D commit's subject starts `Machine name: `, and no other commit's does: the split picks D by subject, since a path cannot tell C's `cli.ts` commits from D's.
- `desktop/design/desktop-design-system.md` is under `desktop/` and goes with B: the design doc's own rule puts a screen's change and its section in one pull request. A touches other `desktop/` files, so the two never meet. B's PR CI runs the Desktop suite too, because of that one file.
- The four are independent and merge in any order. B's step table reads script lines that exist today and that A keeps (Task 1 pins them). C and D both change `cli/src/cli.ts`, in places far apart: the one merged second integrates `main` and reruns its CLI checks.
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
    docs/plans/2026-11-13-device-menubar-design.md docs/plans/2026-11-16-dial-skill-every-home-design.md)
  git switch -c fix/new-user-onboarding-orca-homes origin/main
  git cherry-pick $(commits cli/src cli/e2e cli/AGENTS.md docs/cli.md ':(exclude)cli/src/scripts/install.spec.ts' \
    | grep -vxF "$MACHINE")
  git switch -c fix/new-user-onboarding-machine-name origin/main
  git cherry-pick $MACHINE
  ```

  Then check: the four branches' commit counts add up to `git rev-list --count origin/main..$SRC`; each D commit names only D's files (`git show --name-only --format= <sha>`); and for each branch `git diff --exit-code $SRC <branch> -- <its files>` prints nothing, `cli/src/cli.ts` left out for C and D (a difference means `main` changed that file since the base: review the cherry-pick's result). For `cli/src/cli.ts`: `git diff fix/new-user-onboarding-orca-homes $SRC -- cli/src/cli.ts` shows only D's lines (the import and the two labels), and `git diff fix/new-user-onboarding-machine-name $SRC -- cli/src/cli.ts` only C's.
- Not in this plan: publishing the installer (`make upload-cli-install-sh`). Until then the CDN serves the old script, and B works with either.
- Each pull request names its platforms and carries its evidence ([Verification](#verification)). Merge and release follow `docs/validation-and-release.md`.

## Layers

| Files | Layer and process | Gate |
|---|---|---|
| `cli/scripts/install.sh` | The person's `/bin/sh`, piped from `curl` | `cli/src/scripts/install.spec.ts` (PR CI, Linux) |
| `desktop/lib/bootstrap/environment_provisioner.dart` | The desktop app | its Flutter tests (PR CI, Linux) |
| `device-app/src-tauri/src/*.rs`, `device-app/ui/src/*` | Harness Device, a process of its own | `cargo test --locked` (PR CI on Linux, macOS by hand), the window's vitest |
| `cli/src/devices/orcaHomes.ts` | Shared by the `harness` command and the devices process | its spec |
| `cli/src/cable/hosts/*`, `cli/src/cable/dialSkillWriter.ts`, `cli/src/lib/sessionSearch/externals/index.ts` | The devices process (the last one also search's) | their specs |
| `cli/src/services/devices.ts` | The devices process | its spec; `npm run test:core`, 100% per file (local gate) |
| `cli/src/deviceClaude/*`, `cli/src/cli.ts` | The `harness` command's own process | `command.spec.ts`, `plugin.spec.ts`; for D's labels, `authCommand.spec.ts` |
| `cli/src/lib/computerName.ts` | Loaded by the `harness` command (`cli.ts`, `lib/authRefresh.ts`) and the gateway (`gateway/upstream.ts`), never by the core's process | `computerName.spec.ts`, `architecture.spec.ts` |
| `cli/src/lib/authRefresh.ts`, `cli/src/gateway/upstream.ts` | The command's and the gateway's | `authCommand.spec.ts`, `upstream.spec.ts` |

Nothing under `cli/src/core/` or `cli/src/harnessd/` changes, and `cli/src/architecture.coreFiles.txt` gains no line. Checked at plan time: none of `cli.ts`, `lib/authRefresh.ts`, `gateway/upstream.ts` is in `architecture.coreFiles.txt`, so importing `computerName.ts` from them adds nothing to the core's process.

## Global Constraints

- **Decisions 1 to 8 of the spec are final** (restated under [Decided](#decided-the-orchestrator-2026-11-17)).
- **Homebrew is never run** by `install.sh`: no `brew install`, no `brew shellenv`, no `command -v brew`. The prefixes are `${HARNESS_HOMEBREW_PREFIXES:-/opt/homebrew /usr/local}`.
- **Step copy**, fixed in Rust, never the script's text: `Getting ready…` before the first match, `Installing tmux…`, `Downloading Harness…`.
- **Step table**, matched against a clean line after its `▸`:

  | The line starts with | Step |
  |---|---|
  | `Installing the managed tmux`, `downloading tmux` | `Installing tmux…` |
  | `Installing the Harness Node runtime`, `downloading Node`, `Installing harness` | `Downloading Harness…` |

- **The install log** holds only: `install: <step line>` for a clean line that starts with `▸`, `✓` or `✗`; the result (`install: --host exit 0`, `… timed out after 600 s`, `… killed by a signal`, `… could not start: …`, `install: harness not found after it`); and after a failure the lines the screen shows, each as `install: last: <line>`. Every line still passes `log::redact`.
- **Unchanged:** the two install lines word for word (no `2>&1`), `INSTALL_DEADLINE` 600 s, `LAST_LINES` 4, `LINE_CHARS` 120, each run in its own process group.
- **Window copy:**

  | Screen | Heading | Body | Buttons |
  |---|---|---|---|
  | Claude offer | Claude Code | The dial shows when Claude Code needs you, and takes a prompt you say. | Not now · **Turn on** |
  | Claude working / failed | Claude Code | spinner / the error line | none / **Retry** |
  | Codex offer | Codex | Codex can ring the dial when it needs you. | Not now · **Turn on** |
  | Codex working / failed | Codex | spinner / the error line | none / **Retry** |

- **Due:** Claude Code's screen when its status says `supported && !enabled` and `askedClaude` is not true; Codex's when `supported && installed && !enabled` and `askedCodex` is not true; both only after Sign in is answered or not due.
- **`state.json`** stays version 1. `askedClaude` and `askedCodex` are `#[serde(default)]`, so a 0.1.1 file reads as itself.
- **The webview** sends one of six action names: `retry`, `sign_in`, `later`, `cancel`, `turn_on`, `not_now`. Every command line stays fixed in Rust.
- **Orca's homes** come from `orca account list --json` only: 5 s deadline, output bounded to 256 KB, only `home` kept, at most `MAX_HOMES` (64) per engine, read at the devices service's start and at a scan once the last read is 5 minutes old, no new timer.
- **Never read another process's environment.** `src/architecture.environment.spec.ts` stays green. **No new field** is read from a session record.
- **No Orca account's email, id or path** in a log line, an error or a measure. The measure is `[observed] orca homes · <n> claude · <n> codex`, once per read.
- **CLI stderr copy:** `Could not turn on Claude Code in one Orca account.` and `Could not turn off Claude Code in one Orca account.`
- **Turn off in an Orca home** is `claude plugin disable` (a settings write), never `uninstall`; only the default home uninstalls, last. A failed Orca home makes `disable` exit 1.
- **No time budget in the command:** the app's 60 s deadline for Turn on (`CHANGE_DEADLINE`) stays.
- **A turn-on's failure line** is the last non-empty line, as `engine::reason` picks it today, cleaned as an install line is and cut at 120 characters.
- **A successful Turn on from the menu** records `askedClaude` / `askedCodex` too.
- **`CLAUDE_CONFIG_DIR`** is set on Harness's own child only, never on `process.env`.
- **Machine name:** `computerName()` runs `/usr/sbin/scutil --get ComputerName` once per process, 2 s deadline, control characters stripped, trimmed, cut at 80 characters, cached. Empty, failed, timed out, or not macOS: `os.hostname()`. Exactly four callers use it: `cli.ts` `resolveComputerMachine` and `qrSignInCommand`, `lib/authRefresh.ts` `harnessSessionRequest`, `gateway/upstream.ts`'s adapter-ws `?label=`. Every other `hostname()`, the core's included, stays.
- **Windows:** no change. Linux: the apt `</dev/null` and the scan.
- **Device app rules** (`device-app/AGENTS.md`): thin over the CLI, fixed arguments, one log, redacted, and no other component's path in a string.
- **Repo rules:** a test that fails first, no fixed sleeps, comments say why, copy short, buttons 1-2 words.

## Review Focus

1. **A `state.json` from before #4389** carries `askedClaude` and `askedCodex`. They count again: `askedClaude: true` means never asked again. Task 4 (`a_state_file_from_before_the_menu_only_app_keeps_its_offer_answers`).
2. **Orca homes that overlap:** the same home twice, the default home listed as an account, a home whose `projects/`, `sessions/` or `skills/` is a link, and the command run inside an Orca terminal, where `CLAUDE_CONFIG_DIR` is already one of them. Each folder is read once and each home turned on once. Task 9 (`keeps each home once`), Task 11 (`a linked folder is read once`), Task 13 (`the command's own home is not run twice`).
3. **An install that prints without end,** one line over 64 KiB, `\r` progress frames, bytes that are not UTF-8, or a step line with no newline at the end. The log stays bounded and the step is still fixed copy. Task 6 (`a_line_over_64_kib_is_not_handed_and_the_next_one_is`, `a_last_line_without_a_newline_is_handed`, `bytes_that_are_not_utf_8_are_handed_as_text`), Task 7 (`a_run_logs_at_most_200_step_lines`).
4. **Clicks that cross:** Turn on in the window while the menu's change for that engine runs; the window closed while a turn-on runs, which then fails; Sign in opened from the menu over an offer. One change runs, and nothing is recorded for an offer nobody answered. Task 4 (`the_window_and_the_menu_share_one_change`, `not_now_and_closing_are_remembered`, `sign_in_from_the_menu_over_an_offer_records_nothing`).
5. **A Homebrew prefix whose tmux is there but does not run,** or two prefixes. The next rung is tried, and the managed build still lands. Task 1 (`passes a Homebrew tmux that does not run`, `takes the first prefix whose tmux runs`).

## Decided (the orchestrator, 2026-11-17)

Not reopened:

1. **1A.** The Claude Code and Codex first-run screens come back after Sign in, with the due rule above. The menu's Turn on is unchanged.
2. **2A.** macOS never runs brew. A Homebrew tmux already installed is found in a prefix's `bin`; otherwise the managed tmux. Every stdin-reading child in `install.sh` gets `</dev/null`. The desktop's "with Homebrew" copy and probe go.
3. **Orca.** Homes from `orca account list --json`, only `home` kept; added to the devices' open-scan places (Claude Code records, and roots without a second read of a linked folder; Codex roots); `readRecordName` takes records folders; the dial skill writer's `adopted()` includes them; `harness device claude enable` and `disable` run per Orca Claude Code home (disable: `claude plugin disable` in each Orca home first, then the default home uninstalls as today; exit 1 on a failed home). **Follow-ups, not in this plan:** Harness's session and turn hooks in Orca homes, and the plugin for an Orca account added after Turn on.
4. The step line is fixed copy from a Rust table.
5. The app logs step lines, each run's result, and on a failure the lines shown.
6. Four pull requests by component and topic, built on this branch and split by cherry-pick.
7. **Machine name (D).** A new machine is named by macOS's ComputerName when there is one, the hostname otherwise. **Follow-up, no task:** the Desktop's suggestion to move from an offline machine to its replacement.
8. **Answers to the draft plan's questions:** an Orca home is turned off with `claude plugin disable`, and only the default home uninstalls; the app's 60 s deadline for Turn on stays, with no budget in the command; a turn-on failure shows the last non-empty line, as `engine::reason` picks it, cleaned and cut at 120; a successful Turn on from the menu records the answer; a Codex session in an Orca Codex home gets its last answer from the scan's Codex roots; the managed tmux check uses a local `file://` manifest only.

## Decided here, where the spec left it to the builder

- **The first screen waits for the three first answers again** (account, Claude Code, Codex; a failed read counts), as before #4389. Today it is chosen at the account's first answer. A person already signed in, the spec's upgrade from 0.1.1, would get no window if Claude Code's status answered a moment later.
- **The Install screen keeps its last step** after the script ends, until the first screen is chosen. Retry starts again at `Getting ready…`.
- **`Event::InstallStep(&'static str)`:** the type lets only the table's copy through. A step is sent when it changes.
- **A run logs at most 200 step lines,** then `install: --host more step lines not logged` once (the script prints about 15).
- **A Homebrew prefix's `bin` is put first on PATH,** as `brew shellenv` did. The script's advice to a person (`Install tmux yourself (brew install tmux)`) stays: it runs nothing.
- **`run_lines` beside `run` in `cli.rs`:** one implementation, `run` hands it a sink that drops every line, so no other caller changes.
- **A scan waits for an Orca read that is due or under way** (at most its 5 s). The devices process starts when a dial appears, so the dial's first scan would otherwise miss every Orca session for a minute.
- **A failed Orca read empties the list** (the spec: each read replaces the whole list). **On Windows no read is made** and nothing is logged.
- **The Orca read reaches `services/devices.ts` through its own dependency** (`DevicesDeps.orcaHomes`). Its spec holds 101 exact assertions on what `orca` ran, and none may change.
- **`enable`:** the default home is turned on whole (plugin, then the dial setting and skill) before any Orca home. A default home that fails ends the command as today. **`disable`:** Off is saved, then each Orca home, then the default home, then the skills.
- **The dial skill writer needs no new method:** `started()` runs the start pass again for a changed list.
- **`computerName()` is synchronous** (`execFileSync`, as `lib/bootId.ts` reads `sysctl`): `harnessSessionRequest()` and `UpstreamLink`'s constructor are synchronous, and the cache makes it one call per process. **By its full path,** `/usr/sbin/scutil`, as `bootId.ts` does: a daemon started from a shell whose PATH lacks `/usr/sbin` still finds it.
- **The hostname fallback is not cut by `computerName()`:** the callers that cut at 80 today (`qrSignInCommand`, `harnessSessionRequest`) keep their `.slice(0, 80)`, and the other two send it whole, as today.
- **`cli.ts`'s two labels are tested on the bundled CLI with `computerName.ts` replaced by a fake** (an esbuild resolve stub in `useBundledCli`), so the test is red on every platform, Linux CI included, where the real answer equals the hostname.

## Design check (docs/feature-design-rules.md)

The spec's Design section stands. Where each point lands:

| Point | Task |
|---|---|
| 1 Growth: two booleans in `state.json`; Orca homes in memory, at most 64 an engine | 4, 9 |
| 2 Concurrency: the step comes through the app's event queue; the homes cache is one value replaced whole, one read at a time; `claude plugin` runs one after another | 6, 7, 9, 13 |
| 3 Read cost: one `orca account list` at start and at most every 5 minutes; one more `sessions/` folder per Orca home at a scan | 9, 12 |
| 4 Scale: 50 accounts is one call and 50 folders; `enable` keeps no budget of its own, and the app's 60 s deadline for Turn on stays (decision 8) | 9, 13 |
| 5 Compatibility: version 1 state; an older CLI works with the new app | 4 |
| 7, 8 Audience and identity: only `home` kept, nothing of it logged; the variable on our own child | 9, 13 |
| 9 Failure: one log line per failed read; one stderr line per failed home | 9, 12, 13 |
| 10 Platforms | every task's tests; [Verification](#verification) |

Numbers for pull request C (rule 4): quote the `[observed] scan · … ms` line of the end-to-end run with one Orca home and with none (Task 14).

## Tasks at a glance

| # | PR | Task | Depends on | Effort |
|---|---|---|---|---|
| 1 | A | tmux on a Mac with no Homebrew run (`install.sh`) | none | high |
| 2 | A | No child reads the script (`install.sh`) | 1 | high |
| 3 | A | The desktop's setup plan names the managed tmux | none | high |
| 4 | B | The first-run screens' rules (Rust) | none | high |
| 5 | B | The window draws them, and the install's step | none | high |
| 6 | B | A run hands its lines as they arrive (`cli.rs`) | none | xhigh |
| 7 | B | The install shows its step and logs only steps | 6 | high |
| 8 | B | The docs | none | medium |
| 9 | C | Orca's account homes (`devices/orcaHomes.ts`) | none | xhigh |
| 10 | C | `externalProviders` takes places | none | medium |
| 11 | C | The scan's places (`cable/hosts/observedPlaces.ts`) | none | high |
| 12 | C | The devices service reads Orca's homes | 9, 10, 11 | xhigh |
| 13 | C | `enable` and `disable` in each Orca home | 9, 16, and check 8's result | xhigh |
| 14 | C | End to end on the isolated daemon | 12 | high |
| 15 | D | The computer's name (`lib/computerName.ts`) | none | high |
| 16 | D | A new machine's label is the computer's name | 15 | high |

Longest chains: 9 → 12 → 14 and 15 → 16 → 13 (three tasks each). Task 13 waits for 16 only because both edit `cli/src/cli.ts` (no interface passes between them), and for [check 8](#verification), which the main session has a tester run before Task 13 starts. Tasks 4 and 7 share `types.rs`, `app.rs` and `runner.rs` and need nothing of each other, so they run one after the other in either order. Tasks 1 and 2 share both their files.

---

### Task 1: tmux on a Mac with no Homebrew run

**PR:** A. **Layer:** the installer. **Depends on:** none. **Effort:** `high`.

**Red test:** `cli/src/scripts/install.spec.ts`.

**Files:**
- Modify: `cli/scripts/install.sh`, `cli/src/scripts/install.spec.ts`

**Interfaces:**
- The Darwin arm of step 1 becomes this ladder, and nothing else:
  1. `tmux_runs`: done.
  2. Else, for each prefix of `${HARNESS_HOMEBREW_PREFIXES:-/opt/homebrew /usr/local}` whose `bin/tmux` is executable: that `bin` goes first on PATH and `tmux_runs` is asked again. The first that runs ends the loop.
  3. Else `install_managed_tmux`.
- Produces for Task 7: the five step lines stay as they are (pinned below).

- [ ] **Step 1: Write the failing tests**, with the file's `managedFixture`, `hostSetupOf` and `writeCommand`. A "recording `brew`" appends its arguments to `brew-invocations` and exits 99.
  - `installs the managed tmux on a Mac with no tmux, and never runs Homebrew`: a recording `brew` on PATH and in `<scratch>/homebrew/bin`, with `HARNESS_HOMEBREW_PREFIXES=<scratch>/homebrew`. Status 0; stdout has `downloading tmux 9.9 (darwin-arm64)` and `tmux ready (tmux 9.9)` and no `Homebrew`; `~/.local/bin/tmux` links to the managed binary; `brew-invocations` does not exist.
  - `uses a tmux in a Homebrew prefix that is not on PATH, downloads nothing and runs no Homebrew`: the prefix holds a `tmux` that prints `tmux 3.7c` and a recording `brew`; a `curl` on PATH that records and exits 99. Status 0; `tmux ready (tmux 3.7c)`; no `current-tmux`, no `~/.local/bin/tmux`; neither record file exists.
  - `passes a Homebrew tmux that does not run and installs the managed build`: the prefix's `tmux` exits 127. `tmux ready (tmux 9.9)`, linked.
  - `takes the first prefix whose tmux runs`: two prefixes, the first with no tmux, the second with one.
  - `looks in the Homebrew prefixes only without tmux, then downloads the managed build` (replaces `asks about Homebrew only without tmux…`): in the Darwin arm `if tmux_runs; then` comes before the prefix loop, which comes before `install_managed_tmux`; the source holds none of `command -v brew`, `brew shellenv`, `brew install --force-bottle`, `Installing tmux via Homebrew`.
  - `finds Homebrew tmux and creates the first pane without changing its worker PATH`: its prefix's `brew` becomes a recording one, and the test adds that it was never called. The rest stands.
  - Removed: `installs tmux with an existing Homebrew and never fetches the managed build`, `falls back to the managed build when Homebrew cannot install tmux`.
  - A pin that passes before the change: `keeps the step lines Harness Device names`. The source holds `echo "▸ Installing the managed tmux into`, `echo "  ▸ downloading tmux `, `echo "▸ Installing the Harness Node runtime into`, `echo "  ▸ downloading Node ` and `echo "▸ Installing harness from`. Name the app's table in a comment, never in a string.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/scripts/install.spec.ts`. Expected: the four new tests and the renamed one FAIL. Commit `Installer: tests for tmux on a Mac with no Homebrew run`.
- [ ] **Step 3: Implement** the ladder. Rewrite the header comment's lines on Homebrew to say it. The arm's comment says why, in one sentence: on 2026-11-17 `brew install tmux` updated Homebrew, ran its cleanup and replaced openssl on a new user's Mac.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `Installer: tmux on a Mac never runs Homebrew`.

### Task 2: No child reads the script

**PR:** A. **Layer:** the installer. **Depends on:** 1 (with the brew branch gone, the list below is every child of the Darwin host step; and both tasks edit the same two files). **Effort:** `high`.

**Red test:** `cli/src/scripts/install.spec.ts`, a new `describe("scripts/install.sh: no child reads the script")`.

**Files:**
- Modify: `cli/scripts/install.sh`, `cli/src/scripts/install.spec.ts`

**Interfaces:** the spec's list, checked against the script line by line. Each of these gets `</dev/null`:

| # | Where (base line) | The call |
|---|---|---|
| 1 | `install_hn` (253) | `"$tui_staging" --version` |
| 2 | `install_managed_grid` (314) | `"$grid_target/bin/grid" --version` |
| 3, 4 | `apt_as_root` (336, 338) | `apt-get "$@"`, `sudo apt-get "$@"` |
| 5 | `tmux_runs` (355) | `tmux -V` |
| 6 | `install_managed_tmux` (416) | `"$tmux_target/bin/tmux" -V` |
| 7 | the ready line (520) | `$(tmux -V)` |
| 8 | `node_major` (548) | `"$1" -e …` |
| 9, 10 | the override's error and the managed-node line (569, 581) | `"$NODE_BIN" -v` |
| 11 | step 3b (770) | `"$NODE_BIN" "$HOME/.harness/cli/cli.js" dsh builtins` |
| 12, 13 | step 4b (795, 805) | the OpenCode subshell, and its `--version` warm-up |
| 14, 15, 16 | step 5 (819 to 822) | `"$NODE_BIN" --version`, `"$LAUNCHER" version`, `tmux -V` |
| 17, 18 | the finale (843, 868) | `"$LAUNCHER" version`, `"$TUI_BIN" --version` |

Left as they are: `curl` in `download`, `tar`, `sed`, `awk`, `shasum` and `sha256sum` (the download tools), the Node heredoc of step 3 (the heredoc is its stdin), and POSIX tools given a file or a pipe.

- [ ] **Step 1: Write the failing tests.**
  - A helper `piped(slice, env)`: `spawnSync("/bin/sh", ["-s"], { input })`, where `input` is the slice, then 24 KiB of comment lines, then `echo REACHED-THE-END`. The padding is needed: CI's `/bin/sh` is dash, which reads 8 KiB ahead, so a marker close behind the call would already be in its buffer and the test would pass without the fix. A "draining" fake starts with `cat >/dev/null`.
  - Every run gets a throwaway `HOME` and `SHELL=/bin/zsh`: host mode writes the PATH line into an rc file. The Linux rows are set up as the file's Linux tests are (no display, a `ps`).
  - One test per row, each expecting `REACHED-THE-END` on stdout, red today:
    - 5 and 7: `hostSetupOf`, `INSTALL_MODE=standalone`, a Darwin `uname`, a draining `tmux` that prints `tmux 3.6`.
    - 6: `managedFixture` with the archive's `tmux` draining.
    - 3: a Linux `uname`, an `id` that prints 0, a draining `apt-get` that writes a working `tmux`. 4: an `id` that prints 1000, a `sudo` that runs its arguments.
    - 8 and 10: the node-selection slice (as `nodeSelection` takes it) with a draining managed node.
    - 11: `gridStepOf`, `INSTALL_MODE=desktop`, a draining `NODE_BIN`.
    - 2: `gridFixture`, standalone, the archive's `grid` draining. 1: `hnFixture`, its binary draining.
    - 14 to 18: `finaleOf` with `installedFixture`'s node, launcher and tmux draining, and a draining `harness-tui`, once standalone and once desktop.
  - `the whole script piped into sh -s -- --host still says it is ready`: the full source on stdin, a Darwin `uname`, a draining `tmux`; stdout ends `✓ Host requirements ready.`
  - `the whole script piped into sh -s -- --desktop still says it is installed`: `HARNESS_NODE_BINARY` a draining fake node that answers `-e` with 24, writes a draining launcher when run with no arguments, and exits 0 otherwise; stdout has `harness 0.2.60 installed.`
  - `every call in the list carries the redirect`: the source holds each row's call with `</dev/null`. Rows 9, 12 and 13 are proved here alone: 9 runs as the script exits, and a background list already reads `/dev/null`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/scripts/install.spec.ts`. Expected: every new test FAILS on macOS; on Linux the two whole-script tests may pass (dash's read-ahead), the rest fail. Commit `Installer: tests that no child reads a piped script`.
- [ ] **Step 3: Implement** the 18 redirects. A comment at `apt_as_root` says why: under `curl … | sh -s` the script is sh's stdin, and on 2026-11-17 `brew` read part of it.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `Installer: no program it starts reads the script`.

### Task 3: The desktop's setup plan names the managed tmux

**PR:** A. **Layer:** the desktop app. **Depends on:** none. **Effort:** `high`.

**Red test:** `desktop/test/environment_provisioner_test.dart`.

**Files:**
- Modify: `desktop/lib/bootstrap/environment_provisioner.dart`, `desktop/test/environment_provisioner_test.dart`, `desktop/test/windows_known_failures.txt`, `desktop/lib/widgets/environment_setup_screen.dart` (one comment), `desktop/CLAUDE.md`, `desktop/RELEASE.md`

**Interfaces:**
- Gone: `EnvironmentPlanItem.tmuxViaHomebrew`, `_HostProbe.homebrewInstallsTmux`, `_hasHomebrew`, `Installing tmux via Homebrew…`, `tmux will be installed with Homebrew.`, `✓ brew --version`.
- Stays: `EnvironmentPlanItem.tmuxManaged`, `Downloading the managed tmux…`, `tmux will be downloaded into ~/.harness/runtime.`, `– managed tmux download`, and `_shellArguments`' PATH with the Homebrew prefixes (it finds a tmux that is already there).

- [ ] **Step 1: Write the failing tests.**
  - `without tmux the plan is one in-app step: the managed download` (replaces `…worded by whether Homebrew is here`): with a runner that would answer `command -v brew` with `Homebrew 4.0`, the plan's first detail contains `~/.harness/runtime`, the output contains `managed tmux download`, and no call contains `command -v brew` or `brew --version`. Assert on those two, not on `brew`: every call's PATH names `/opt/homebrew/bin`.
  - `automatic setup obtains tmux in-app…` adds: the progress message while it runs is `Downloading the managed tmux…`.
  - The runner helper loses `homebrewPresent` and its `command -v brew` answer. `a computer with tmux is ready without Homebrew` keeps its name and its point.
  - `desktop/test/windows_known_failures.txt`: the renamed test's line takes its new name.
- [ ] **Step 2: Run** `cd desktop && flutter test test/environment_provisioner_test.dart`. Expected: the renamed test FAILS. Commit `Desktop: test that the setup plan always names the managed tmux`.
- [ ] **Step 3: Implement.** Remove the names above and reword the doc comments that describe the ladder. Update the two sentences of `desktop/CLAUDE.md` and the two of `desktop/RELEASE.md` that say tmux comes from Homebrew when it is there: a tmux Homebrew already installed is found, and Homebrew is never run.
- [ ] **Step 4: Run** `flutter analyze && flutter test test/environment_provisioner_test.dart test/environment_setup_screen_test.dart test/boot_flow_widget_test.dart test/setup_review_render_test.dart`, then `grep -rn "tmuxViaHomebrew\|homebrewInstallsTmux\|_hasHomebrew\|via Homebrew\|with Homebrew" desktop/lib desktop/test`. Expected: PASS, and the grep prints nothing.
- [ ] **Step 5: Commit** `Desktop: the setup plan always names the managed tmux`.

Checked at plan time: `desktop/design/desktop-design-system.md` and the elements gallery hold none of the old copy, so neither changes. `desktop/design/environment-setup-prototype.html` is an old prototype and stays.

---

### Task 4: The first-run screens' rules

**PR:** B. **Layer:** Harness Device, Rust. **Depends on:** none. **Effort:** `high`.

**Red test:** the test modules of the files below. `git show e1f84bdfde^:device-app/src-tauri/src/app.rs` holds the rules and tests #4389 removed: build on them, with today's `EngineChange` rows.

**Files:**
- Modify: `device-app/src-tauri/src/types.rs`, `model.rs`, `state.rs`, `app.rs`, `runner.rs`, `engine.rs`

**Interfaces:**
- Produces, for Task 5 (the JSON the window reads and sends): screens `"claude"` and `"codex"`, each in `offer`, `working` or `failed`, `lines[0]` the error line of `failed`; actions `"turn_on"` and `"not_now"`.

  ```rust
  pub struct Saved { pub version: u32, pub cli_seen: bool, pub asked_sign_in: bool,
      #[serde(default)] pub asked_claude: bool, #[serde(default)] pub asked_codex: bool, pub login_item: bool }
  pub enum Screen { Install, SignIn, Claude, Codex }
  pub enum Action { Retry, SignIn, Later, Cancel, TurnOn, NotNow }
  // In Event:
  ClaudeSet(Result<(), String>), CodexSet(Result<(), String>),
  ```
- The rules:
  - `due`: Install, then Sign in, as today; then Claude, then Codex, by the due rule. An unknown account (`signed_in: None`) holds neither back.
  - The first screen is chosen once the account, Claude Code and Codex have each answered since the CLI was found.
  - `Turn on` (offer) and `Retry` (failed) call `set_claude(true)` or `set_codex(true)`, the menu's own change, and the window shows that screen as `view_of` gives it: `working` while that engine's turn-on runs, whoever started it.
  - A turn-on that ends well: the status reads on at once and is read again, as today; the answer is recorded; a window on that screen moves to the next one due, or closes.
  - One that fails: `EngineChange::Failed(true)` as today, so the menu row reads `Could not turn on`; a window on that screen shows `failed` with the line. Nothing is recorded.
  - `Not now`, and closing the window on an offer or a failure, record that engine's answer. Closing on `working` records nothing and stops nothing.
  - The menu's Turn on opens no window. It records that engine's answer when it ends well (decision 8), and nothing when it fails.
  - The failure line is `engine::set`'s. `engine::reason` keeps its choice of line (the last non-empty one, as today), cleans it with `log::printable`, trims it and cuts it to `install::LINE_CHARS` (120); `REASON_MAX` goes (decision 8). The runner still logs it as `claude: …` or `codex: …`.

- [ ] **Step 1: Write the failing tests.**
  - `types.rs`: `the_window_may_ask_six_things`; `state_json_keys` (six keys written; the four keys of 0.1.1 read as the default); `a_view_is_the_json_the_window_reads` (`"claude"`, `"codex"`).
  - `state.rs`: `a_0_1_1_state_file_reads_as_itself` (`{"version":1,"cliSeen":true,"askedSignIn":true,"loginItem":true}` loads with both new fields false and logs nothing); `a_state_file_from_before_the_menu_only_app_keeps_its_offer_answers` (replaces `a_state_file_with_the_old_offer_keys_loads`: `askedClaude: true` is read).
  - `model.rs`: `screens_are_due_in_order` (replaces `only_install_and_sign_in_are_due`): Claude is due with `installed` false too, and not when unsupported, on, unknown or asked; Codex after it, and not for `(supported, installed)` of `(true, false)` or `(false, true)`, on, unknown or asked.
  - `app.rs`:
    - `the_first_screen_waits_for_all_three_answers` (replaces `…_for_the_account_alone`).
    - `the_first_run_offers_sign_in_then_claude_code_then_codex` (replaces `no_offer_screen_at_first_run`): Later, Not now, Not now; each answer is one `Save`, the last one closes the window.
    - `someone_who_upgrades_is_asked_once`: `asked_sign_in` true, signed in, Claude Code `supported`, `installed: false`, off: the Claude Code offer. After Not now, an app started from what was saved shows nothing.
    - `claude_turns_on_from_the_window`, `codex_turns_on_from_the_window`: `working`, the row `Turning on…`, then the answer saved and the next screen or no window.
    - `a_turn_on_that_fails_at_the_window_shows_its_line_and_retry`: `failed` with the line, the row `Could not turn on`, nothing saved; Retry runs `SetClaude(true)` again.
    - `not_now_and_closing_are_remembered`: offer and failure record; `working` does not, and its change still ends.
    - `the_window_and_the_menu_share_one_change`: with the offer shown, the menu's Turn on then the window's run one `SetClaude(true)`, and the window reads `working`.
    - `sign_in_from_the_menu_over_an_offer_records_nothing`: the menu's Sign in… replaces the Claude Code offer and saves nothing; once the sign-in ends, the offer is back.
    - `turn_on_in_the_menu_runs_enable_with_no_window` and `a_failed_enable_shows_the_rows_error_and_no_window` keep their point, with `Ok(())` and `Err(…)`.
    - `a_turn_on_from_the_menu_that_ends_well_records_the_answer`: for Claude Code one `Save` with `asked_claude` true, for Codex `asked_codex`; an app started from what was saved offers neither. A menu turn-on that fails saves nothing.
  - `runner.rs`: a `SetClaude` and a `SetCodex` that fail answer `Err("Claude Code is busy.")` and `Err("Codex is busy.")`; `the_first_run_window_turns_claude_code_on`, with `drive` and the fake CLI: the Claude Code offer is shown, `Act(TurnOn)` ends with no window, and `device claude enable` ran once.
  - `engine.rs`: `a_failure_says_why` cuts at 120 and drops a colour code; it still takes the last non-empty line (a stderr of `first\nlast\n\n` gives `last`).
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --lib`. Expected: does not compile, then FAIL. Commit `Harness Device: tests for the Claude Code and Codex first-run screens`.
- [ ] **Step 3: Implement.** Update every `Saved { … }` that names all its fields, and the head comments of `types.rs`, `model.rs` and `app.rs`.
- [ ] **Step 4: Run** `cargo test --lib && cargo fmt --check`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: a first run offers Claude Code, then Codex`.

### Task 5: The window draws them, and the install's step

**PR:** B. **Layer:** Harness Device, the window. **Depends on:** none (the JSON is fixed by Tasks 4 and 7's Interfaces). **Effort:** `high`.

**Red test:** `device-app/ui/src/screens.test.ts`, `gallery.test.ts`.

**Files:**
- Modify: `device-app/ui/src/api.ts`, `api.test.ts`, `screens.ts`, `screens.test.ts`, `gallery.ts`, `gallery.test.ts`, `main.ts` (one comment), and `styles.css` only if the step needs a rule it lacks

**Interfaces:**
- Consumes: `Screen = 'install' | 'sign_in' | 'claude' | 'codex'`; `Action` gains `'turn_on' | 'not_now'`; `install.working` carries its step in `lines[0]`.
- The six new faces are the Global Constraints' copy table, buttons secondary first, **Turn on** and **Retry** primary. `install.working` draws the spinner and, under it, `lines[0]` as a muted body line (`body muted`, as Sign in's note). With no line it draws the spinner alone.

- [ ] **Step 1: Write the failing tests.**
  - `claude: offer, Turn on, working, a failure, Retry` and the same for Codex, clicked as a person does: the heading, the sentence, the buttons in order, `act('turn_on')`, the spinner with no button, the error line with Retry, `act('retry')`.
  - `Not now sends not_now`, for both.
  - `install: the step under the spinner`: `['Installing tmux…']` shows that text beside the spinner; a second line is not drawn; no line draws the spinner alone.
  - `the primary button is the one the contract names`: the table gains the six pairs (`Turn on`, none, `Retry`, twice).
  - `outside text is drawn as text`, and the screen reader's test: the failed faces, and the offer's sentence describing **Turn on**.
  - Removed: `a screen Rust no longer sends draws nothing`.
  - `gallery.test.ts`: 14 states, 12 pairs. `Install · working` carries `['Installing tmux…']`; the six new states are named `Claude Code · offer`, `· working`, `· failed` (`Could not change Claude Code.`) and the same for `Codex`.
- [ ] **Step 2: Run** `cd device-app/ui && npm test`. Expected: FAIL. Commit `Harness Device: tests for the Claude Code and Codex screens and the install's step`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run build && npm run gallery`. Expected: PASS; `gallery.html` shows 28 frames.
- [ ] **Step 5: Commit** `Harness Device: the window draws Claude Code, Codex and the install's step`.

### Task 6: A run hands its lines as they arrive

**PR:** B. **Layer:** Harness Device, Rust. **Depends on:** none. **Effort:** `xhigh` (two reader threads, one deadline, a kill).

**Red test:** `device-app/src-tauri/src/cli.rs`.

**Files:**
- Modify: `device-app/src-tauri/src/cli.rs`

**Interfaces:**
- Produces:

  ```rust
  /// As `run`, and hands `sink` each line of stdout and stderr, without its newline, on the caller's thread, in the
  /// order the lines arrive.
  pub fn run_lines(command: Command, deadline: Duration, sink: &mut dyn FnMut(&str)) -> io::Result<Output>
  ```
- `run(command, deadline)` is `run_lines` with a sink that drops every line. `Output` is as today: each stream's last 256 KiB.
- One thread a stream; both send to one bounded channel (`LINES_QUEUED`), so a slow sink makes the child wait and nothing piles up. A line over `LINE_MAX` is dropped, as `read_lines` drops it. Past the deadline the group is killed and no more lines are handed.

- [ ] **Step 1: Write the failing tests.**
  - `a_run_hands_each_line_as_it_arrives_in_the_order_written`: the child prints `a` on stdout, waits on a FIFO, prints `b` on stderr, waits on a second FIFO, prints `c` on stdout. The sink writes to the next FIFO as each line comes. It sees `a`, `b`, `c`, and the run ends. No sleep: the child cannot go on until the sink has the line.
  - `a_run_with_a_sink_still_gives_code_and_both_streams`: `stdout` is `a\nc\n`, `stderr` is `b\n`.
  - `a_line_over_64_kib_is_not_handed_and_the_next_one_is`.
  - `a_last_line_without_a_newline_is_handed`.
  - `bytes_that_are_not_utf_8_are_handed_as_text`: the line arrives with the replacement character, and the run ends well.
  - `a_sink_slower_than_the_child_loses_no_line`: 2000 lines, all counted.
  - `a_run_past_its_deadline_stops_handing_lines_and_dies_with_its_children`: a child that prints for ever; `timed_out`, back within the deadline and `WAIT`.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --lib cli::`. Expected: does not compile. Commit `Harness Device: tests for a run that hands its lines as they arrive`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test --lib && cargo fmt --check`. Expected: PASS, `a_run_past_its_deadline_dies_with_its_children` included.
- [ ] **Step 5: Commit** `Harness Device: a run hands its lines as they arrive`.

### Task 7: The install shows its step and logs only steps

**PR:** B. **Layer:** Harness Device, Rust. **Depends on:** 6. **Effort:** `high`.

**Red test:** `device-app/src-tauri/src/install.rs`, `app.rs`, `runner.rs`.

**Files:**
- Modify: `device-app/src-tauri/src/install.rs`, `types.rs`, `app.rs`, `runner.rs`

**Interfaces:**
- Consumes: Task 6's `run_lines`.
- Produces:

  ```rust
  pub const GETTING_READY: &str = "Getting ready…";
  pub const INSTALLING_TMUX: &str = "Installing tmux…";
  pub const DOWNLOADING_HARNESS: &str = "Downloading Harness…";
  pub trait Shell: Send + Sync {
      fn run(&self, line: &str, deadline: Duration, sink: &mut dyn FnMut(&str)) -> io::Result<Output>;
  }
  /// The step a clean line names: it starts with `▸`, then one of the table's five beginnings.
  pub fn step_of(clean: &str) -> Option<&'static str>
  pub fn install(shell: &dyn Shell, log: &dyn Log, cli_there: &dyn Fn() -> bool,
      on_step: &mut dyn FnMut(&'static str)) -> Result<(), Vec<String>>
  // In Event:
  InstallStep(&'static str),
  ```
- `install` cleans each line the sink gets by `clean_lines`' rules, logs it when it is a step line, and calls `on_step` when the step changes. The failure's lines are built from `Output` as today.
- The runner sends `Event::InstallStep` from `on_step`. The app keeps the step, starts each install at `GETTING_READY`, and `view_of(Screen::Install)` is `working` with that one line. A step for an app that is not installing, or a step it already shows, draws nothing; a closed window stays closed.

- [ ] **Step 1: Write the failing tests.** The test shell (`Answers`) takes the lines it hands the sink beside its `Output`; `runner.rs`'s `Doubles` takes the sink too.
  - `install.rs`:
    - `the_steps_a_streamed_run_yields`: `▸ Installing the managed tmux into /x`, `  ▸ downloading tmux 3.7c (darwin-arm64)…`, a line of noise, `✓ tmux ready (tmux 3.7c)`, then the second run's `▸ Installing the Harness Node runtime into /x` and `▸ Installing harness from https://x/y.json` give `[INSTALLING_TMUX, DOWNLOADING_HARNESS]`. `Installing harness now` with no `▸`, and `▸ Installing hn`, give nothing.
    - `only_step_lines_and_results_reach_the_log` (replaces `the_whole_output_goes_to_the_log`): a run that also prints `==> Pouring openssl@4`, `#!/bin/sh` and `set -eu` logs its `▸` and `✓` lines and `install: --host exit 0`, and none of those three.
    - `a_failure_logs_the_lines_the_screen_shows`: exit 6 after ten lines logs `install: --host exit 6`, then four `install: last: …` lines, the ones in `Err`.
    - `no_cli_after_both_runs_logs_what_the_screen_shows`.
    - `a_run_logs_at_most_200_step_lines`: 10 000 `▸ x` lines log 200 of them and `install: --host more step lines not logged` once.
    - `the_lines_shown_are_clean_and_short`: the log no longer holds the 10 000-character line; the shown lines are as today.
    - `the_system_shell_hands_its_lines`: `printf 'a\nb\n'` reaches the sink as `a`, `b`.
  - `app.rs`: `the_install_screen_shows_its_step`: a first run shows `["Getting ready…"]`; `InstallStep(INSTALLING_TMUX)` shows it; the same step again shows nothing; with the window closed nothing is shown; after a failure Retry shows `Getting ready…` again; a step after `InstallDone` is ignored. Every test that expects `Install`, `Working` with no line now expects `Getting ready…`.
  - `runner.rs`: `an_install_tells_its_steps`: a shell that hands `▸ Installing the managed tmux into /x` sends `InstallStep("Installing tmux…")` before `InstallDone`.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --lib`. Expected: does not compile, then FAIL. Commit `Harness Device: tests for the install's step and its log`.
- [ ] **Step 3: Implement.** `install.rs`'s head comment says what the log holds and why: the 2026-11-17 log held a script's source and brew's output.
- [ ] **Step 4: Run** `cargo test --lib && cargo fmt --check`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: Setting up Harness shows its step, and the log holds steps and results`.

### Task 8: The docs

**PR:** B. **Depends on:** none (written from the spec). **Effort:** `medium`. No behavior change: one commit, no red test.

**Files:**
- Modify: `device-app/AGENTS.md`, `desktop/design/desktop-design-system.md`, `docs/plans/2026-11-13-device-menubar-design.md`, `docs/plans/2026-11-16-dial-skill-every-home-design.md`

- [ ] **Step 1: Edit.**
  - `device-app/AGENTS.md`: it offers sign-in, Claude Code and Codex once; four screens; six action names.
  - The design doc's Harness Device section: the three offers; four screens; the install's step is one muted body line under the spinner, fixed copy; the gallery sentence stands.
  - The menu-bar design: Goal 3, the window's screens and when it opens, the Install paragraph (the step, what the log holds), the Claude Code section's "no offer" line, the state file's keys, the testing lines. Each changed part names this decision: `(2026-11-17, docs/plans/2026-11-17-new-user-onboarding-design.md)`.
  - The dial skill design: its "no offer" lines (the offer windows go; "Turn on is the consent") get one line each: a first run offers them again since 2026-11-17, and the menu's Turn on is unchanged.
- [ ] **Step 2: Check** `git diff --stat` names only these four files.
- [ ] **Step 3: Commit** `Docs: a first run offers Claude Code and Codex again, and the install shows its step`.

---

### Task 9: Orca's account homes

**PR:** C. **Layer:** shared by the `harness` command and the devices process. **Depends on:** none. **Effort:** `xhigh` (another program's output, with emails in it).

**Red test:** `cli/src/devices/orcaHomes.spec.ts` (new).

**Files:**
- Create: `cli/src/devices/orcaHomes.ts`, `cli/src/devices/orcaHomes.spec.ts`
- Modify: `cli/src/cable/hosts/orca.ts` (it imports `orcaBinary`; its own copy goes)

**Interfaces:**
- Produces:

  ```ts
  export interface OrcaHomes { claude: string[]; codex: string[] }
  export type OrcaHomesFailure = 'no orca' | 'failed' | 'timed out' | 'unreadable'
  export interface OrcaHomesRead { homes: OrcaHomes; failure?: OrcaHomesFailure }
  export interface OrcaBinaryDeps { onPath(name: string): string | null; exists(path: string): boolean; platform: NodeJS.Platform }
  export interface OrcaHomesDeps extends OrcaBinaryDeps {
    /** No shell, stdin closed. Resolves within timeoutMs whatever the child does; never rejects. `code` is null for a
     *  kill, a binary that could not start or output past maxBytes. */
    run(file: string, args: string[], opts: { timeoutMs: number; maxBytes: number }): Promise<{ code: number | null; stdout: string; timedOut: boolean }>
    uid: number
  }
  export const ORCA_HOMES_DEADLINE_MS = 5_000
  export const ORCA_HOMES_MAX_BYTES = 256 * 1024
  export const ORCA_HOMES_REFRESH_MS = 5 * 60_000
  /** Orca's CLI: the one on PATH, else, on macOS, the app's own. */
  export function orcaBinary(deps: OrcaBinaryDeps): string | null
  /** This computer's real `orca`. */
  export function orcaHomesDeps(): OrcaHomesDeps
  export function readOrcaHomes(deps: OrcaHomesDeps): Promise<OrcaHomesRead>
  export interface OrcaHomesCache {
    /** The last read's homes: none before the first read, and none after a failed one. */
    get(): OrcaHomes
    /** Reads when there is no read yet or the last is ORCA_HOMES_REFRESH_MS old, and joins a read under way. Resolves
     *  true when the list changed. Never rejects. */
    refresh(): Promise<boolean>
  }
  export function createOrcaHomesCache(deps: { read(): Promise<OrcaHomesRead>; now(): number; platform: NodeJS.Platform; log(line: string): void }): OrcaHomesCache
  ```
- `readOrcaHomes` runs `account list --json` and reads `result.claude.accounts[].home` and `result.codex.accounts[].home` of an answer whose `ok` is true. A home is kept when it is a string of at most 1024 bytes with no control character, absolute and normalised, and `ownDirectory(home, uid)` says `ok`. Each home once, at most `MAX_HOMES` an engine. Nothing else of the answer is kept or returned.
- The cache logs one line a read: `[observed] orca homes · <n> claude · <n> codex`, or `[observed] orca homes · not read · <failure>`. On `win32` it never reads and logs nothing.

- [ ] **Step 1: Write the failing tests,** with a fake `run` and throwaway folders.
  - `keeps each account's home and nothing else`: Orca 1.4.256's shape with ids and emails; the result is the two lists; `JSON.stringify` of it holds no id and no email. The call is `['account', 'list', '--json']` with `{ timeoutMs: 5000, maxBytes: 262144 }`.
  - `refuses a home that is relative, not normalised, missing, a file, another user's, too long or holds a control character`.
  - `keeps each home once`, and `keeps at most 64 an engine`.
  - `no orca runs nothing`; `an exit other than 0 is failed` (an Orca with no `account list`); `a run past its deadline is timed out`; `an answer that is not JSON, not ok or not an object is unreadable`; `an engine with no accounts list has no homes`.
  - `the real run ends at its deadline and at its byte bound`: `orcaHomesDeps().run` against a script that waits for ever, and one that prints 300 KB.
  - The cache: `the first refresh reads, and says how many`; `a refresh within 5 minutes reads nothing`; `after 5 minutes it reads again, and says whether the list changed`; `two refreshes share one read`; `a failed read empties the list and names its kind`; `a read that throws is failed`; `on Windows it never reads`.
  - `orca.ts` uses this lookup: `orca.spec.ts` passes unchanged.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/orcaHomes.spec.ts`. Expected: FAIL. Commit `Dial: tests for Orca's account homes`.
- [ ] **Step 3: Implement.** The head comment says why only `home` is kept.
- [ ] **Step 4: Run** `npx vitest run src/devices src/cable/hosts/orca.spec.ts src/architecture.spec.ts src/architecture.environment.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: Orca's account homes, from its own CLI`.

### Task 10: `externalProviders` takes places

**PR:** C. **Layer:** the devices process and search. **Depends on:** none. **Effort:** `medium`.

**Red test:** `cli/src/lib/sessionSearch/externals/index.spec.ts`.

**Files:**
- Modify: `cli/src/lib/sessionSearch/externals/index.ts`, `index.spec.ts`

**Interfaces:**
- Produces: `externalProviders(paths: ExternalPaths = externalPaths(), places?: { claude?: AdoptionPlaces; codex?: AdoptionPlaces }): ExternalProvider[]`. A given engine's places replace its own; the other providers do not change.

- [ ] **Step 1: Write the failing tests,** with `adoptionProviderOf` spied.
  - `with no places it builds today's providers`: Claude Code's places are `roots()` of `claudeProjectsRoots(paths.claudeProjectsDir)` with no `records`; Codex's are `codexHomeRoots(paths.codexHome)`.
  - `given places replace that engine's alone`: the very objects reach `adoptionProviderOf`; with only `claude` given, Codex's are today's.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/sessionSearch/externals/index.spec.ts`. Expected: FAIL. Commit `Search: test that the session providers take their places`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/lib/sessionSearch src/services/search.spec.ts src/services/searchProcess.spec.ts src/engines && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Search: the session providers take their places`.

### Task 11: The scan's places

**PR:** C. **Layer:** the devices process. **Depends on:** none. **Effort:** `high`.

**Red test:** `cli/src/cable/hosts/observedPlaces.spec.ts` (new).

**Files:**
- Create: `cli/src/cable/hosts/observedPlaces.ts`, `cli/src/cable/hosts/observedPlaces.spec.ts`

**Interfaces:**
- Produces:

  ```ts
  export interface ObservedPlaces { claude: Required<AdoptionPlaces>; codex: AdoptionPlaces }
  export interface ObservedPlacesDeps {
    /** Today's folders, asked at each call: claudeProjectsRoots and codexHomeRoots. */
    claudeRoots(): string[]
    codexRoots(): string[]
    /** Orca's account homes, from the last read. */
    orca(): { claude: readonly string[]; codex: readonly string[] }
  }
  export function observedPlaces(deps: ObservedPlacesDeps): ObservedPlaces
  ```
- `claude.roots()`: today's roots, then each Orca home's projects folder (the session store's `sessions.moved.folder`) that resolves and whose real path is not a listed root's. `claude.records()`: the records folder (`live.record.folder`) beside each of today's roots, built as the provider builds it (`join(root, '..', folder)`), then each Orca home's. `codex.roots()`: today's homes, then Orca's. In all three, a folder already listed by its real path, or by its own path where it does not resolve, is left out.

- [ ] **Step 1: Write the failing tests,** in throwaway folders with real links.
  - `with no Orca home the places are today's`.
  - `a linked folder is read once`: an Orca home whose `projects` links to the default root adds no root, and its `sessions` is a records folder.
  - `an Orca home's own projects folder is a root`; `one with no projects folder adds no root`.
  - `the same home twice, or the default home as an account, adds nothing twice`.
  - `Codex's roots are today's and then Orca's`.
  - `the lists follow the last read`: a second call after `orca()` changes gives the new lists.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observedPlaces.spec.ts`. Expected: FAIL. Commit `Dial: tests for the open scan's places with Orca's homes`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: the open scan's places, with Orca's homes`.

### Task 12: The devices service reads Orca's homes

**PR:** C. **Layer:** the devices process. **Depends on:** 9, 10, 11. **Effort:** `xhigh` (a file under the 100% gate; the start pass moves behind a read).

**Red test:** `cli/src/services/devices.spec.ts`, `cli/src/cable/hosts/recordName.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts`, `cli/src/cable/hosts/recordName.ts`, `recordName.spec.ts`, `cli/src/cable/dialSkillWriter.ts` (the comment on `started`), `cli/src/cable/dialSkillWriter.spec.ts`, `cli/AGENTS.md` (the devices row)

**Interfaces:**
- Consumes: Task 9's `createOrcaHomesCache`, `readOrcaHomes`, `orcaHomesDeps`, `OrcaHomesCache`; Task 10's `places`; Task 11's `observedPlaces`.
- `DevicesDeps.orcaHomes?: OrcaHomesCache`, for this service's tests; unset, the cache is built on the real `orca`. The spec's `start()` passes an inert one (no homes, `refresh()` false), and mocks `orcaHomesDeps` for the one test that leaves it unset.
- `RecordNameOptions` becomes `{ records: readonly string[] }`: the record must be `join(<one of them>, '<pid><suffix>')`.
- The wiring:
  - `observedSource` builds one `observedPlaces` and gives it to `externalProviders(undefined, places)`, to `readLastAnswer`'s Claude Code roots, and to `readRecordName` as `places.claude.records()`. Codex's last-answer roots are `places.codex.roots()` with `sessions` below each: the same homes as the scan's Codex roots (decision 8).
  - The homes are read only when the observed source or the skill writer runs. The first read starts with the service; the writer's `started()` runs when it lands, unless the devices have stopped.
  - Each open scan first awaits `refresh()`; when it says the list changed, `started()` runs again.
  - The writer's `adopted` is `movedEngineHomes()` with the cache's homes added to each engine.

- [ ] **Step 1: Write the failing tests.**
  - `recordName.spec.ts`: every case takes `records` (today's `sessions` beside `projects`); new: `a record in an Orca home's sessions folder is named`, `a record outside every records folder is refused`, `a record one folder below a records folder is refused`.
  - `devices.spec.ts`:
    - `the open scan's providers look in Orca's homes`: a cache holding a throwaway Orca-like home; the providers given to `OpenSessions` include a Claude Code provider whose `owners` claims a record written in that home's `sessions/` (the record and the process view as `engines/transcriptReads.golden.spec.ts` makes them), and no claim without the home.
    - `a session's name is read with the records folders`, replacing the assertion on `{ roots }`; `a last answer is read with Orca's roots`, for a Claude Code session and for a Codex session in an Orca Codex home.
    - `a scan reads Orca's homes again when the list is old, and waits for it`: `refresh()` is awaited before the owners are read.
    - `the dial skill reaches an Orca Codex home once the first read lands`, and `a later read that changes the list runs the start pass again`.
    - `a read that lands after the devices stopped starts nothing`.
    - `with no observed source and no skill writer Orca is not asked`.
    - `unset, the cache is built on this computer's orca`: with `orcaHomesDeps` mocked to a system with no `orca`, the log holds `[observed] orca homes · not read · no orca`.
    - The four tests that read the skill right after `start()` wait for it instead.
  - `dialSkillWriter.spec.ts`: `an Orca Codex home gets the skill, and a second start pass writes nothing twice`. It passes before the change: it pins what the wiring relies on.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/recordName.spec.ts src/services/devices.spec.ts`. Expected: FAIL. Commit `Dial: tests for the devices reading Orca's homes`.
- [ ] **Step 3: Implement.** Add to `cli/AGENTS.md`'s devices row: Orca's account homes, read from `orca account list --json` at the service's start and at a scan once 5 minutes old, kept in memory (`devices/orcaHomes.ts`), join the open scan and the dial skill's homes.
- [ ] **Step 4: Run** `npx vitest run src/cable src/services/devices.spec.ts src/architecture.spec.ts && npm run typecheck && npm run test:core`. Expected: PASS, `services/devices.ts` at 100%, and all 101 assertions on `orcaRuns` untouched (`git diff` shows none of them).
- [ ] **Step 5: Commit** `Dial: the open scan and the dial skill reach Orca's account homes`.

### Task 13: `enable` and `disable` in each Orca home

**PR:** C. **Layer:** the `harness` command. **Depends on:** 9; 16 (both edit `cli/src/cli.ts`, in places far apart; nothing else passes between them); and [check 8](#verification)'s result. **Effort:** `xhigh` (it changes the settings of several accounts).

**Before it starts:** check 8 has passed. If it showed an Orca home whose entry still reads on after `claude plugin disable`, or a plugin that an Orca home does not list after the default home installed it, this task does not start: the main session takes the result back to the orchestrator.

**Red test:** `cli/src/deviceClaude/command.spec.ts`, `plugin.spec.ts`.

**Files:**
- Modify: `cli/src/deviceClaude/plugin.ts`, `plugin.spec.ts`, `command.ts`, `command.spec.ts`, `cli/src/cli.ts`, `docs/cli.md`

**Interfaces:**
- Consumes: Task 9's `readOrcaHomes`, `orcaHomesDeps`.
- `ClaudeRun` becomes `(args: string[], timeoutMs: number, env?: Record<string, string>) => Promise<…>`: `env` is added to that child's environment alone.
- `DeviceDeps.orcaHomes(): Promise<{ claude: string[]; codex: string[] }>`, asked only by `claude enable` and `claude disable`. `cli.ts` gives `() => readOrcaHomes(orcaHomesDeps()).then((read) => read.homes)`.
- A home whose real path is the command's own Claude Code home (`dirname(claudeSettingsPath())`) is left out.
- `enable`: `claudeEnable` in the default home, then `turnOn`, as today; only when that returned 0, `claudeEnable` once per Orca Claude Code home with `{ CLAUDE_CONFIG_DIR: home }`. A home that fails prints the turn-on line, the next home is still tried, and the command returns 0.
- Produces in `plugin.ts`, beside `claudeDisable`:

  ```ts
  /** Turns the plugin off in this home's settings and leaves its files: an Orca home shares `plugins/` with the
   *  default home, so an uninstall here would remove what every home names. */
  export async function claudePluginDisable(deps: ClaudeDeps): Promise<ClaudeResult>
  ```

  It reads `claudeStatus`; an entry that is not listed or already off runs nothing and is `{ ok: true }`; otherwise one `change(run, ['plugin', 'disable', DIAL_PLUGIN_ID, '--scope', 'user'], LOCAL_MS)`.
- `disable`: inside `turnOff`'s plugin step, after Off is saved: `claudePluginDisable` once per Orca home with the variable, then the default home's `claudeDisable` (the uninstall) as today. A home that fails prints the turn-off line and the command returns 1, with no second line for it. `status` and Codex's verbs do not change.
- No time budget: the command tries every home; the app's 60 s deadline for Turn on stays (decision 8).

- [ ] **Step 1: Write the failing tests,** with a fake `claude` that records each call's arguments and `env`.
  - `enable runs the plugin steps once per Orca Claude Code home, with CLAUDE_CONFIG_DIR on that child alone`: the default home's calls carry no `env`; each home's carry only that variable; `process.env.CLAUDE_CONFIG_DIR` is what it was; exit 0, nothing printed.
  - `the default home is on before any Orca home is tried`: at the first call with an `env`, `dial-skill.json` says `claude: true` and the default home holds the skill.
  - `a home that fails prints one line and the command still exits 0`: stderr is exactly the turn-on line, though the fake's own stderr named a path; the home after it is still tried.
  - `an enable that fails in the default home touches no Orca home`.
  - `the command's own home is not run twice`: listed as itself and through a link.
  - `disable turns off in each Orca home first, then the default home`: each Orca home gets `plugin disable harness-device@openharness --scope user` with its variable and never `uninstall`; the default home's `uninstall` comes last, with no `env`; `dial-skill.json` already says `claude: false` at the first call.
  - `a home that fails to turn off prints one line and the command exits 1`: the default home is still uninstalled and the skills removed.
  - `with no Orca home nothing changes`; `status and Codex's verbs ask Orca nothing`.
  - `plugin.spec.ts`, under `claudeRun`: `a call's variables reach that child alone`. Under `claudePluginDisable`: `turns the plugin off and never uninstalls it`; `an entry not listed or already off runs nothing`; `a failure is the first line Claude Code wrote`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/deviceClaude`. Expected: FAIL. Commit `Dial: tests for turning Claude Code on and off in Orca's accounts`.
- [ ] **Step 3: Implement.** `docs/cli.md`'s `harness device claude` row says both verbs also run in each Orca account's home. `command.ts`'s head comment says why Orca's homes go first at `disable`, and why they are disabled rather than uninstalled: they share `plugins/` with the default home.
- [ ] **Step 4: Run** `npx vitest run src/deviceClaude src/devices && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: Turn on and Turn off reach Claude Code in Orca's accounts`.

### Task 14: End to end on the isolated daemon

**PR:** C. **Layer:** `cli/e2e`. **Depends on:** 12. **Effort:** `high`. No product behavior change: one commit, no red test. Step 2 proves the spec can fail.

**Files:**
- Create: `cli/e2e/deviceOrcaHomes.e2e.ts`
- Modify: `cli/e2e/harness/fakeOrca.ts`, `cli/e2e/harness/outsideAgent.ts`

**Interfaces:**
- `FakeOrca.accounts(homes: { claude?: string[]; codex?: string[] })` writes Orca 1.4.256's answer with made-up ids and emails at `example.invalid`; the script prints it for `account list` and exits 1 while there is none.
- `Outside.startIn(d, folder, home, hints)`: Claude Code with `CLAUDE_CONFIG_DIR` at `home`, a home with no Harness hooks. Its session id is read from the record it writes in `<home>/sessions/`, and `named` writes there.

- [ ] **Step 1: Write the spec,** on `deviceDialSkill.e2e.ts`'s `fresh` and `plugged` (an `IsolatedDaemon` with `CABLE_DISABLE=false` and the fake dial).
  - `Claude Code in an Orca account's home is found by the scan`: a home under the daemon's root, its `projects` linked to the daemon's own projects folder as Orca links it, listed by the fake `orca`. The agent is on the dial's list. The log has `[observed] orca homes · 1 claude · 0 codex` and a `[observed] scan · 1 found` line, and neither `example.invalid` nor the home's path.
  - `the name the person gave it is read from that home's record`.
  - `Codex On writes the dial skill into an Orca Codex home`.
  - `with no answer from Orca the default home's sessions are listed as before`: the harness's `orca` that exits 1; the log has `[observed] orca homes · not read · failed`.
- [ ] **Step 2: Prove it can fail.** Run the first test with `accounts()` left out. Expected: it times out waiting for the agent. Put the call back.
- [ ] **Step 3: Run** `cd cli && E2E_BUNDLE=1 TMPDIR=/tmp npm run test:e2e -- e2e/deviceOrcaHomes.e2e.ts e2e/deviceWithoutApp.e2e.ts e2e/deviceDialSkill.e2e.ts e2e/deviceClaudeOrca.e2e.ts e2e/dialOrcaFocus.e2e.ts`. Expected: PASS. Note the `[observed] scan · … ms` of the first and the last test for the pull request.
- [ ] **Step 4: Commit** `Dial: end to end, a session in an Orca account's home reaches the dial`.

---

### Task 15: The computer's name

**PR:** D. **Layer:** a library the `harness` command and the gateway load; never the core's process. **Depends on:** none. **Effort:** `high`.

**Red test:** `cli/src/lib/computerName.spec.ts` (new).

**Files:**
- Create: `cli/src/lib/computerName.ts`, `cli/src/lib/computerName.spec.ts`

**Interfaces:**
- Produces, for Task 16:

  ```ts
  export interface ComputerNameSources {
    platform: NodeJS.Platform
    /** `/usr/sbin/scutil --get ComputerName`'s stdout. Throws on a failure or past its deadline. */
    scutil(): string
    hostname(): string
  }
  export const COMPUTER_NAME_DEADLINE_MS = 2_000
  export const COMPUTER_NAME_MAX = 80
  /** This computer's own: execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8',
   *  timeout: COMPUTER_NAME_DEADLINE_MS, stdio: ['ignore', 'pipe', 'ignore'] }), and os.hostname(). */
  export const SYSTEM_COMPUTER_NAME_SOURCES: ComputerNameSources
  /** A reader that asks once and keeps its answer, whichever it was. */
  export function computerNameReader(sources: ComputerNameSources): () => string
  /** The name the person gave this computer: macOS's ComputerName, else the hostname. Asked once per process. */
  export const computerName: () => string  // computerNameReader(SYSTEM_COMPUTER_NAME_SOURCES)
  ```
- The rule: on `darwin`, the answer with every control character (U+0000 to U+001F, U+007F to U+009F) removed, then trimmed, then cut to 80 code points (`Array.from`, so a character is never split). Empty after that, a throw, or another platform: `sources.hostname()`, as it is.

- [ ] **Step 1: Write the failing tests,** with fake sources that count their calls.
  - `uses macOS's ComputerName, and asks once`: `darwin`, `scutil` answers `Diego’s Mac\n`, `hostname` `MacBook-Pro.local`. Two calls of one reader both give `Diego’s Mac`; `scutil` ran once and `hostname` never.
  - `an empty answer gives the hostname` (`'  \n'`), `an answer of control characters alone gives the hostname` (`'\u0007\u001b\n'`).
  - `a failure gives the hostname` (`scutil` throws `Error('exit 1')`), and `a timeout gives the hostname` (it throws an error whose `code` is `ETIMEDOUT`). Each asks once: a second call runs nothing.
  - `on Linux and Windows it never asks scutil`: `linux` and `win32` give the hostname, `scutil` never called.
  - `control characters go, and the name is cut at 80`: `'Lab\u0000 Mac\u007f\t\n'` gives `Lab Mac`; 100 `é` give 80; 79 letters and `🙂` keep the `🙂` whole; 80 letters and `🙂` drop it, with no lone surrogate.
  - `the system source asks scutil by its full path, with a 2 s deadline and no stdin`: `node:child_process` mocked; `SYSTEM_COMPUTER_NAME_SOURCES.scutil()` calls `execFileSync` with `/usr/sbin/scutil`, `['--get', 'ComputerName']` and `{ encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/computerName.spec.ts`. Expected: FAIL (the module is not there). Commit `Machine name: tests for the computer's name`.
- [ ] **Step 3: Implement.** The head comment says why: a reinstall after `~/.harness` was removed made a new machine named by the hostname (`MacBook-Pro.local`), not as the person named the Mac; and why the full path (as `lib/bootId.ts`).
- [ ] **Step 4: Run** the same command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Machine name: the computer's name, as macOS calls it`.

### Task 16: A new machine's label is the computer's name

**PR:** D. **Layer:** the `harness` command and the gateway. **Depends on:** 15. **Effort:** `high`.

**Red test:** `cli/src/authCommand.spec.ts`, `cli/src/gateway/upstream.spec.ts`.

**Files:**
- Create: `cli/src/__fixtures__/computerNameFake.ts`
- Modify: `cli/src/cli.ts` (`resolveComputerMachine`, `qrSignInCommand`, and the import), `cli/src/lib/authRefresh.ts` (`harnessSessionRequest`), `cli/src/gateway/upstream.ts` (the `?label=` and its comment), `cli/src/gateway/upstream.spec.ts`, `cli/src/authCommand.spec.ts`, `cli/src/__fixtures__/bundledCli.ts`, `cli/src/architecture.spec.ts`

**Interfaces:**
- Consumes: Task 15's `computerName`.
- `useBundledCli(options?: { stubs?: Record<string, string> })`: each key a source file under `cli/src/` (`'lib/computerName.ts'`), each value a module that replaces it. An esbuild `onResolve` plugin sends every import that resolves to that file to the stub. With no options the bundle is today's, so `gridCommand.spec.ts` and `devicesCommand.spec.ts` do not change.
- `computerNameFake.ts`: `export const FAKE_COMPUTER_NAME = 'Test Lab Mac'` and `export const computerName = (): string => FAKE_COMPUTER_NAME`.
- The four labels:
  - `resolveComputerMachine`: `label: computerName()`.
  - `qrSignInCommand`: `label: computerName().slice(0, 80)`.
  - `harnessSessionRequest`: `label: computerName().slice(0, 80)`.
  - `UpstreamLink`'s URL: `?label=${encodeURIComponent(computerName())}`; its comment says `?label=<the computer's name>`.
- Unchanged: every other `hostname()`: in `cli.ts` the machine link's `self.label` (`connectWithPassword`), `thisDeviceLabel`, `gateway/start.ts`, `device/deviceLink.ts`, and the core's.

- [ ] **Step 1: Write the failing tests.**
  - `authCommand.spec.ts`, its bundle built with `useBundledCli({ stubs: { 'lib/computerName.ts': <computerNameFake.ts> } })`:
    - `a QR sign-in names the computer as its person named it`: the `/api/auth/qr/start` body's `label` is `Test Lab Mac`, not `hostname()`.
    - `resolving the machine names the computer as its person named it`: the `/api/machines/resolve-computer` body's `label` is `Test Lab Mac`.
    - The two `harnessSession: { kind: 'computer', label: expect.any(String) }` assertions become `label: 'Test Lab Mac'`.
    - `Already signed in — this machine is "${hostname()…}"` stays: `thisDeviceLabel` is not one of the four.
  - `upstream.spec.ts`: `vi.mock('../lib/computerName.js', () => ({ computerName: () => 'Test Lab Mac' }))`; `the adapter-ws dial names the computer as its person named it`: the upgrade request the fake backend gets has `label=Test%20Lab%20Mac`.
  - `architecture.spec.ts`: `the core never loads computerName.ts: a machine's name is the command's and the gateway's`: `architecture.coreFiles.txt` has no `lib/computerName.ts` line. It passes before the change and pins it after.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/authCommand.spec.ts src/gateway/upstream.spec.ts`. Expected: the new and changed label tests FAIL (the label is the hostname). Commit `Machine name: tests that a new machine is named as the computer is`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/authCommand.spec.ts src/gateway src/lib/computerName.spec.ts src/architecture.spec.ts src/loginForceRace.spec.ts src/cliCommand.spec.ts src/gridCommand.spec.ts src/devicesCommand.spec.ts && npm run typecheck`, then `git diff --stat origin/main -- src/core src/harnessd src/architecture.coreFiles.txt`. Expected: PASS, and the diff prints nothing.
- [ ] **Step 5: Commit** `Machine name: a new machine is named as the computer is`.

---

## Verification

None of these touches the person's daemon (18473), `~/.harness`, `~/.claude`, `~/.codex`, Orca profiles, tmux server, real `orca`, or `brew`. A check that could not be run is reported as not verified, never as passed.

**Platforms each pull request names.** A: macOS (the ladder), Linux (apt's redirect), the desktop app on macOS; Windows only by a test's name in a list. B: Harness Device on macOS, and Linux in PR CI. C: the daemon and the command on macOS and Linux; Windows makes no read. D: macOS (ComputerName), Linux and Windows (the hostname, as today).

**Temporary workflow:** none. The one long check, the CLI's end-to-end suite, has its workflow (`.github/workflows/cli-e2e.yml`), and its nightly run takes the new file from then on. The other checks are short, or need this Mac: a real `/bin/sh`, the app's window, a real Claude Code.

**In PR CI, nothing started by hand:** A runs `cli-typecheck`, `cli-tests` and `desktop-tests`; B runs `device-app-checks` and `desktop-tests`; C runs the CLI's suites and the suites that read its files; D runs `cli-typecheck` and `cli-tests`.

**Local gates PR CI does not run:**

| PR | Gate | How |
|---|---|---|
| A | none listed for its paths (`python3 scripts/local-checks.py --list` prints `{}`) | checks 1 to 3 below, recorded in the pull request |
| B | Harness Device on macOS (`docs/validation-and-release.md`) | check 4, recorded by hand in the pull request |
| C | `cli-core`: `npm run test:core`, 100% per file for `services/devices.ts` | `python3 scripts/local-checks.py --run` from a clean tree at C's final commit; paste its fence into the pull request's body before the push |
| C | no new core file | `git diff --stat origin/main -- cli/src/core cli/src/harnessd cli/src/architecture.coreFiles.txt` prints nothing |
| D | none listed for its paths: `test:core` covers `src/core/` and `src/services/` only (`cli/vitest.core.config.ts`, `cli/AGENTS.md`), and `gateway/`, `lib/` and `cli.ts` are in no coverage gate (`python3 scripts/local-checks.py --list <D's files>` prints `{}`) | check 10, recorded in the pull request |
| D | no new core file | the same `git diff --stat` as C's prints nothing |

**1. The installer's spec on this Mac (A).** `cd cli && npx vitest run src/scripts/install.spec.ts`. The spec's own scratch folders and fakes. Every test passes; macOS's `/bin/sh` is where the piped tests are red before Task 2.

**2. The real `/bin/sh`, piped, with no network (A).** On this Mac, in `T=$(mktemp -d /tmp/nuo.XXXXXX)`:
- Set up: `$T/bin/brew` and `$T/brew/bin/brew` append their arguments to `$T/brew.log`; a manifest `$T/manifest.json` for this Mac's platform key (`darwin-arm64` or `darwin-x64`), one key a line as the spec's `managedFixture` writes it, whose `url` is `file://$T/tmux.tar.gz`, an archive of a script that prints `tmux 9.9`, with its real sha256.
- Run: `env -i HOME="$T/home" SHELL=/bin/zsh PATH="$T/bin:/usr/bin:/bin:/usr/sbin:/sbin" HARNESS_HOMEBREW_PREFIXES="$T/brew" HARNESS_TMUX_METADATA_URL="file://$T/manifest.json" /bin/sh -c 'cat cli/scripts/install.sh | /bin/sh -s -- --host'`.
- A person should see `▸ Installing the managed tmux into …`, `✓ tmux ready (tmux 9.9)`, `✓ Host requirements ready.`; `$T/home/.local/bin/tmux` links into `$T/home/.harness/runtime`; `$T/brew.log` does not exist.
- Again in a fresh `HOME="$T/home2"`, with a `tmux` that prints `tmux 3.7c` in `$T/brew/bin` and the manifest URL at a file that is not there: `✓ tmux ready (tmux 3.7c)`, no link, no `brew.log`.
- Afterwards `rm -rf "$T"`. Only the local `file://` manifest is used; the published tmux is never downloaded (decision 8). On GitHub: none; PR CI runs the same ladder against fakes (check 1's spec).

**3. The desktop's tests (A).** Task 3's Step 4, on this Mac. Not started: the Windows desktop workflow, which is manual and heavy; only a test's name changes there.

**4. Harness Device on macOS (B).** `(cd device-app/ui && npm ci && npm run typecheck && npm test && npm run build) && cd device-app/src-tauri && cargo test --locked`, on this Mac. All pass. This is the macOS proof: PR CI compiles Linux only.

**5. The gallery (B).** `cd device-app/ui && npm run gallery && open gallery.html`. 28 frames, each 420 × 320, nothing clipped, the step under the spinner muted. **Needs the user's eye:** the tester sends the screenshot; the person says the look is right.

**6. The real app, isolated, against fakes (B).** On this Mac, the unbundled debug binary in the isolated shell of `docs/plans/2026-11-13-device-menubar-plan.md` (Verification: `$T/env`, the recording `open` and `curl`, `FAKE_HARNESS`, a `state.json` whose `loginItem` is true so macOS is asked for no login item). Screenshots go to the person, who checks the look.

| Row | Set up | What a person should see |
|---|---|---|
| First run | no `HARNESS_DEVICE_CLI`; `state.json` `{"version":1,"cliSeen":false,"askedSignIn":false,"loginItem":true}`; a `curl` that prints a script: for `--host` it prints 300 lines of noise and `▸ Installing the managed tmux into /x`, then waits for `$T/fake/s1`; for `--desktop` it prints `▸ Installing the Harness Node runtime into /x`, waits for `$T/fake/s2`, then copies the fake CLI to `$HOME/.local/bin/harness`. Scripts: signed out; Claude Code `{"supported":true,"installed":false,"enabled":false}`; Codex `{"supported":true,"installed":true,"enabled":false}`; `device_claude_enable`: `@wait on` | **Setting up Harness** with `Getting ready…`, then `Installing tmux…`; `touch s1`: `Downloading Harness…`; `touch s2`: **Sign in**; Later: **Claude Code** with its sentence and Not now · Turn on; Turn on: the spinner; set its status on and `touch on`: **Codex**; Not now: the window closes. `state.json` has the three answers. The log has the two `install: ▸ …` lines and both results, and no line of the noise |
| A turn-on fails | `device_claude_enable`: `@err ✗ Could not write Claude Code's settings.`, `@exit 1` | that sentence and Retry; the menu row `Claude Code: Could not turn on`; closing the window saves `askedClaude` |
| The install fails | the `curl` script prints six lines and exits 6 | the last four lines and Retry; the log has `install: --host exit 6` and four `install: last: …` lines; Retry starts at `Getting ready…` |
| An upgrade from 0.1.1 | `HARNESS_DEVICE_CLI` set; `state.json` `{"version":1,"cliSeen":true,"askedSignIn":true,"loginItem":true}`; signed in; Claude Code off | the Claude Code offer, once; after Not now a second start opens no window |
| The menu | any row, Claude Code off and asked | Turn on in the menu opens no window |
| The menu, not asked yet | `state.json` with no `askedClaude`, the window closed, Claude Code off | Turn on in the menu opens no window; once it ends well `state.json` has `askedClaude: true`, and a second start offers nothing |

At the end: quit the app, `rm -rf "$T"`, and `lsof -nP -iTCP:18473 -sTCP:LISTEN -t` prints the pid it printed before.

**7. The devices on a real daemon with a fake dial (C).**
- On this Mac, at the final head: Task 14's Step 3. Isolation: the suite's `IsolatedDaemon` (`cli/AGENTS.md` rule 6; `docs/development.md`, "Isolated end-to-end testing"): a throwaway home, data folder and auth folder, its own port and tmux server, fake engines, the backend at `127.0.0.1:9`, the dial a fake on a pseudo-terminal, and a fake `orca` first on its PATH so the real Orca never runs.
- What passes: every test. A Claude Code session in an Orca-like home is on the dial's list, named from that home's record, and the log holds counts only.
- On GitHub, by hand, once: Actions → CLI end to end → Run workflow, on the pushed branch that holds C's commits. Eight Linux shards pass. Report the run link.

**8. Before Task 13: the real Claude Code, in throwaway homes that share `plugins/` (C).** A separate check: the main session has a tester run it on this Mac before Task 13 starts, and Task 13 depends on its result. It proves decision 8's `disable` (`claude plugin disable` in each Orca home, then the default home's uninstall) against Claude Code itself.
- Why on this Mac: it needs a real Claude Code 2.1.287 or later. No login and no model: only `claude plugin` and `claude --version` run.
- Isolation: `T=$(mktemp -d /private/tmp/oh.XXXXXX)`; every command under `env -i` with `HOME=$T/home`, a PATH of `$T/bin`, Node's folder, `claude`'s folder and the system folders, and `CLAUDE_CONFIG_DIR=$T/claude` (or an Orca home, per step). Two more homes, `$T/orca-a` and `$T/orca-b`, each with its own `settings.json` and `sessions/` and with `plugins` and `skills` linked to `$T/claude`'s (Orca's layout). The marketplace is a local copy: `cp -R .claude-plugin plugins "$T/marketplace/"` from this checkout, then `claude plugin marketplace add "$T/marketplace"` in `$T/claude`, so nothing is fetched and the checkout is never written.
- Steps, with `claude` alone: install `harness-device@openharness` in `$T/claude`; in each Orca home `claude plugin list --json` (listed there, as installed?) and `claude plugin enable harness-device@openharness --scope user`; then `claude plugin disable … --scope user` in `$T/orca-a` and `$T/orca-b`; then `claude plugin uninstall … --scope user` in `$T/claude`. Write down each home's `enabledPlugins` and its `plugin list --json` entry after each step.
- Passes when: after the Orca homes' enable, each lists the plugin as installed and on; after their disable, each reads off and `$T/claude` still on; after the default home's uninstall, no home holds it as true.
- Fails, and Task 13 does not start, when an Orca home does not list the plugin after the default home installed it, or an Orca home still reads on after its disable. The tester reports each home's entries; the main session takes them to the orchestrator.
- Afterwards `rm -rf "$T"`. On GitHub: none, as no runner has Claude Code.

**9. The branch's `enable` and `disable` with the real Claude Code (C).** At the final head, on this Mac, in check 8's isolation built afresh, plus `ADAPTER_DATA_DIR=$T/data`, `HARNESS_AUTH_DIR=$T/auth`, `ADAPTER_COMPUTER_ID_FILE=$T/computer-id`, `BACKEND_WS_URL=ws://127.0.0.1:9`, `WEB_URL=http://127.0.0.1:9`, `CLAUDE_CONFIG_DIR=$T/claude`, the local marketplace already added, and `$T/bin/orca` printing an answer that names `$T/orca-a` and `$T/orca-b`.
- Run: `cd cli && node --import tsx src/cli.ts device claude enable`, then `… device claude disable`.
- Passes when: after `enable` all three `settings.json` hold `"harness-device@openharness": true`, exit 0; after `disable` none of the three holds it as true, the Orca homes saw `plugin disable` and never `uninstall`, exit 0.
- Afterwards `rm -rf "$T"`. On GitHub: none.

**10. The computer's name (D).**
- `cd cli && npx vitest run src/lib/computerName.spec.ts src/authCommand.spec.ts src/gateway/upstream.spec.ts src/architecture.spec.ts`, on this Mac. All pass. PR CI runs them on Linux.
- On this Mac, read only: `cd cli && node --import tsx -e "import('./src/lib/computerName.ts').then((m) => console.log(m.computerName()))"` prints what `scutil --get ComputerName` prints (`MacBook Pro` here, where `hostname` is `MacBook-Pro.local`). Nothing runs `scutil --set`, and the System Settings name is never changed.
- No end-to-end run against a backend: the label reaches only the backend's create of a new machine, and a check against production is not planned. The four callers' bodies are checked against fake backends in the unit tests.

**Not planned here:**
- The spec's last check, Orca's real sessions on the person's dial. It needs their own Orca accounts and dial, so it is theirs to do after the merge, and no tester runs it.
- Whether `orca account list` starts Orca when it is not running. The 5 s deadline bounds it either way.

**Proposal, not in this plan:** none of these checks needs a new permanent workflow.
