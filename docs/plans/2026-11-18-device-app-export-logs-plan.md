# Export logs from the Harness menu-bar app — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. No task pushes or merges.

**Goal:** One click on `Export logs` in the Harness menu-bar app writes the same log bundle the desktop app exports, now with the menu-bar app's own log, the dial plugins' status and the apps' versions, with emails and the home folder blanked, and shows the zip in Finder.

**Architecture:**
- **One bundler, in the CLI.** `harness logs export` grows; the menu-bar app runs it as the desktop app does. No second bundler in Rust.
- **The bundle stays pure** (`cli/src/lib/logBundle.ts`): every input is passed in. A new module collects the facts that need a process (four status commands of this same CLI, the apps' versions) behind an injected runner, and the command's body moves into a module with injected deps, so all of it tests without spawning anything of this Mac's.
- **The app stays thin.** It runs `logs export --json` with fixed arguments, keeps the answer's `path` only when it is an absolute bundle-named path, and runs `open -R` on it. A new `logs.rs` holds the parse; the reducer gains one row with three states and one line.
- The core does not change: nothing under `cli/src/core/`, nothing it imports, no line of `architecture.coreFiles.txt`.

**Tech Stack:** TypeScript (`cli/`, vitest); Rust and Tauri 2 (`device-app/src-tauri`, `cargo test`). No new dependency.

**Spec:** `docs/plans/2026-11-18-device-app-export-logs-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md`, `device-app/AGENTS.md`, and the Harness Device section of `desktop/design/desktop-design-system.md`.

**Open questions:** none; the PM's answers are under "Answers", before the tasks.

## Base

- `feat/device-app-export-logs` at `76f9a82582`, two commits behind `origin/main` (`dd57b1c93a`, fetched 2026-11-18). One of the two, #4443 (the Pixel H logo), edits `lib.rs`, `main.rs`, a test in `types.rs` and the design doc's Harness Device section. The main session brings the branch up to `origin/main` before the tasks start; no task rebases.
- `feat/device-app-connect-orca` is not merged and edits the same Rust files (`types.rs`, `model.rs`, `app.rs`, `runner.rs`, `main.rs`, `lib.rs`), `device-app/AGENTS.md` and the design doc. Whichever merges second meets conflicts at: `MenuAction` and `AppState`; `menu_id`, `menu_action` and the count in `every_menu_action_has_its_own_id`; the `state()` fixture and the whole-menu expectations; `Runner::run`'s match and the list in `the_binary_gets_its_four_effects_back`; the "Fixed arguments" rule; the design doc's menu listing. So the menu change here is kept small: one block in `menu()`, one arm in `menu_log`, new words only appended in `types.rs`.
- The spec and this plan are untracked. The main session commits them; no task does.
- The tasks name functions, never lines. If a name differs at the base, the implementer follows the code and says so in its report.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The bundle: the app's log, `status.txt`, emails and the home blanked | `cli/src/lib/logBundle.ts`, `logBundle.spec.ts`, `cli/src/cli.ts` (one property) | none | xhigh | `logBundle.spec.ts` |
| 2 The facts: status outputs, versions, the app's log folder | `cli/src/lib/logBundleFacts.ts`, `logBundleFacts.spec.ts` | none | high | `logBundleFacts.spec.ts` |
| 3 The command uses both | `cli/src/lib/logsExportCommand.ts`, `logsExportCommand.spec.ts`, `cli/src/testing/readZip.ts`, `cli/src/lib/logBundle.spec.ts` (one import), `cli/src/cli.ts` | 1, 2 | high | `logsExportCommand.spec.ts` |
| 4 The app reads the CLI's answer | `device-app/src-tauri/src/logs.rs`, `lib.rs`, `types.rs` | none | xhigh | `logs.rs` tests |
| 5 The row, the click and its answer | `device-app/src-tauri/src/types.rs`, `model.rs`, `app.rs`, `runner.rs`, `main.rs` | 4 | high | `model.rs`, `app.rs`, `runner.rs`, `main.rs` tests |
| 6 Say it in the guides | `desktop/design/desktop-design-system.md`, `device-app/AGENTS.md` | none | medium | none: docs only, one commit |

Longest chain: two tasks (1 → 3, 2 → 3, or 4 → 5).

- Tasks 1, 2, 4 and 6 share no file and start at once.
- Shared files, each pair ordered by a dependency above: `cli.ts` and `logBundle.spec.ts` (Tasks 1, 3); `types.rs` (Tasks 4, 5).
- Why Task 5 is one task: `app.rs`, `runner.rs` and `main.rs` match `Event`, `Effect` and `MenuAction` with no wildcard, so a new variant compiles only with its arm, and the reducer's tests read the row through the menu. Split, one half would leave an empty arm.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/lib/logBundle.ts`, `logBundleFacts.ts`, `logsExportCommand.ts`, `cli/src/cli.ts` | **The `harness` command's own process.** Never the core, a service or the devices process | Their specs, in PR CI's `cli-tests`; `cli-typecheck`. No coverage gate covers these files |
| `device-app/src-tauri/src/*.rs` | **The menu-bar app**, Rust | `cargo test` (PR CI on Linux; on this Mac by hand) |
| The two guides | Repo files, no process | `process-checks` (and `desktop-tests`, which a `desktop/` path selects) |

`cli/src/lib/redactSecrets.ts` is one of the core's files and does not change.

## Before starting

- This worktree has no `cli/node_modules`: run `cd cli && npm ci` once.
- Tauri's dependencies take minutes to compile. Set one `CARGO_TARGET_DIR` outside the repository for both Rust tasks (`export CARGO_TARGET_DIR="$HOME/.cache/harness-device-target"`).
- `cargo test --locked --lib` needs no window bundle. `cargo test --locked` (which also runs `main.rs`'s tests, Task 5) embeds `ui/dist`: run `cd device-app/ui && npm ci && npm run build` first.

## Global Constraints

**Never**
- The core does not change: no file under `cli/src/core/`, `cli/src/services/` or `cli/src/harnessd/`, no line of `cli/src/architecture.coreFiles.txt`, and `cli/src/lib/redactSecrets.ts` stays as it is (prompt records and search use it).
- No spec, and no session, runs `harness logs export`, `harness status` or `harness device … status` from the sources or a build outside Verification's isolation: the status commands run this Mac's own `claude`. CLI specs reach a process only through a fake `Run`, or `process.execPath -e …` (Node itself). App tests reach the CLI only through `testing::Fake`.
- No new `process.env.NAME` read in any CLI file (`architecture.startEnvironment.spec.ts` reads every file): the facts take the environment as a parameter, and `cli.ts` hands `process.env` whole, as its `device` case does.
- No upload, no network, no firmware command, no change to the desktop app, no new window screen, plugin, entitlement or Info.plist key.
- In `device-app/`, no string starts with another component's folder and a slash (`cli/…`, `desktop/…`, `docs/…`, `tests/…`), test data included: `scripts/ci-plan.py` reads it as a read of that folder.

**The bundle** (the contract between Tasks 1, 2 and 3; exact values from the spec)
- Unchanged: the name `harness-logs-YYYYMMDD-HHMM.zip`; `~/Desktop`, else the working directory; `--to <dir>`, `--days <n>`; the 7-day window, the 20 MB device cap, the 5 MB `harness.log` tail.
- New entries: `logs/harness-device/app-YYYYMMDD.log` (the same window; only files of that name are read from the app's folder) and `status.txt`.
- The app's log folder, Tauri's `app_log_dir` for `ai.autonomous.harness.device`: macOS `~/Library/Logs/ai.autonomous.harness.device/`; Linux `${XDG_DATA_HOME:-~/.local/share}/ai.autonomous.harness.device/logs/`; Windows `%LOCALAPPDATA%\ai.autonomous.harness.device\logs\`.
- Blanked in every log and `status.txt`, in this order: `redactSecretsInText`; emails → `<email>`; the home folder → `~`. The README goes through the last two.
- `status.txt`: `harness status`, `harness device claude status --json`, `harness device codex status --json`, `harness device vscode status --json`, run at the same time, 10 s each; a failure is one line, never stderr.
- Versions in the README: the CLI, Node, the OS, and on macOS `CFBundleShortVersionString` of Harness, Harness Device, Orca, Visual Studio Code, ChatGPT, Claude and Herdr found in `/Applications` or `~/Applications`, by `plutil -extract CFBundleShortVersionString raw -o - <Info.plist>`, 2 s each.
- The `--json` line keeps `path` (absolute), `included`, `bytes`, and is the only line on stdout: the desktop app reads the last line (`desktop/lib/logging/log_export.dart`) and waits 30 s for the command (`HarnessCliRunner.defaultRunTimeout`).

**The app** (the contract between Tasks 4 and 5)
- It runs exactly `logs export --json`, 60 s. It keeps `path` only when it is absolute and its file name is `harness-logs-\d{8}-\d{4}\.zip`, whole.
- Copy, exact: `Export logs`, `Exporting logs…`, `Saved to <zip, home as ~>`, `Export failed: timed out`, `Export failed: Harness did not answer`, `Export failed: no file`.
- Log lines, exact: `logs: exported`, `logs: export failed: <the same fixed reason>`. Never the path, in any line.
- The reveal: `open -R <zip>` on macOS; elsewhere `xdg-open <the zip's folder>`.

**Platforms.** The CLI part: macOS, Linux, Windows (the apps' versions on macOS only). The menu-bar app: macOS and Linux.

**Repo rules.** A failing test first, at the layer where the behavior lives. No fixed sleeps. Comments say why. No stub, dead code or TODO left behind.

## Review Focus

1. **Status commands that hang, or a child that prints.** Four commands waited for one after another would take 40 s, past the desktop app's 30 s; a child's output on the command's stdout would make the last line no JSON. Task 2 (`all four start before any answers`), Task 3 (`--json prints one line`).
2. **The CLI gone between the click and the run.** The row must come back with `Export failed: Harness did not answer`, never stay on `Exporting logs…`. Task 4 (`a CLI that cannot start`), Task 5 (`an export with no CLI still answers`).
3. **A home that begins another folder's name, and a Windows home inside JSON.** `/Users/al` must leave `/Users/alice` alone; `C:\Users\al` reads `C:\\Users\\al` in a JSON log line and must be blanked there too. Task 1 (`the home is blanked as a whole folder`).
4. **A zip outside the home** (another volume, `--to` one day). The menu then shows its whole path; the app's log must not, and the menu is logged at each change. Task 5 (`the log never names the zip`).
5. **An answer that names a path with a line break, or one 100 KB long.** It would become a menu line. Task 4 (`a path that is no menu line`).

## Decided (PM, 2026-11-18)

The spec's five decisions, not reopened: one CLI command for both apps; emails blanked in the bundle only; one line in the menu, kept until the next export or the app quits; no firmware command; the copy `Export logs` (Answer 1).

## Decided here, where the spec was silent

Confirmed by the PM (Answer 3).

- **`home` is a required option of `buildLogBundle`**, so no caller can leave the blanking off.
- **The home is blanked as a whole folder,** as the menu-bar app's own log does (`home_rule` in `log.rs`): not inside a longer name. Its JSON spelling (each `\` doubled) is blanked too.
- **The versions reach the README through `notes`,** which the command already uses for `machine:`. No new option.
- **`status.txt`** is each command under `$ harness <its words>`, a blank line between. Two lines the spec does not name: `(no answer)` for a command killed otherwise or that could not start, `(no output)` for one that printed nothing.
- **Version lines:** `node: v24.22.2`; `os: macOS 26.0.1` (`os: darwin <os.release()>` when `sw_vers` fails; `os: <platform> <os.release()>` elsewhere); `<App>: <version>`. An app whose version cannot be read is not listed. `plutil` and `sw_vers` run by their full paths in `/usr/bin`.
- **The command's body moves** from `cli.ts` to `cli/src/lib/logsExportCommand.ts`, with its real things handed in, so a spec covers it. A relative `--to` is resolved, so `path` is always absolute.
- **The event carries the zip and its `~` form** (`Exported { zip, shown }`, where the spec writes `PathBuf`): the reducer is pure and has no home folder.
- **More answers that are a failure:** a last line over 64 KiB, or a CLI that cannot start, is `Harness did not answer`; a path over 1024 bytes or with a control character is `no file`. The file is not looked for on disk.
- **The menu's log line says `Saved`** where the menu says `Saved to …`.
- **The row follows `Open Harness`**, directly above `About`; the line is between the row and `About`.
- **The line outlives the CLI.** A CLI that goes away takes the row, not the line; an export's answer is heard whatever became of the CLI.
- **An app update's relaunch does not wait for an export.** The CLI run is a process group of its own and finishes; the new app shows no line.

## Answers (PM, 2026-11-18)

1. The row reads `Export logs` (no `…`): it acts at once, as the design doc's rule for this menu says. `Exporting logs…` keeps its `…`.
2. A macOS prompt for the Desktop folder at a person's first export is accepted; the zip still goes to `~/Desktop`.
3. The twelve points under "Decided here, where the spec was silent" are confirmed.

---

### Task 1: The bundle: the app's log, `status.txt`, emails and the home blanked

**Layer:** the `harness` command's process (what leaves the computer). **Depends on:** none. **Effort:** `xhigh` (privacy: every rule here decides what a person sends).

**Red test:** `cli/src/lib/logBundle.spec.ts`.

**Files:**
- Modify: `cli/src/lib/logBundle.ts` (the options, the two new entries, the blanking, the README, the header comment)
- Modify: `cli/src/cli.ts` (`logsExportCommand`'s `buildLogBundle` call gains `home: homedir()`; nothing else)
- Test: `cli/src/lib/logBundle.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LogBundleOptions {
    // today's fields, and:
    /** The person's home folder (`os.homedir()`): written `~` in every text file of the bundle, the README too. */
    home: string
    /** The menu-bar app's log folder. Only its `app-YYYYMMDD.log` files in the window are read. */
    deviceAppLogsDir?: string
    /** The text of `status.txt`. No file without it. */
    status?: string
  }
  /** Steps 2 and 3 of the bundle's blanking, after `redact`: email addresses, then the home folder. */
  export function blankPersonal(text: string, home: string): string
  ```
  - Every log, `harness.log`, the removals file, the app's logs and `status.txt` are written as `blankPersonal(opts.redact(text), opts.home)`. The README is `blankPersonal(readme, opts.home)`: it never goes through `redact`.
  - Emails: `/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g` → `<email>`, the menu-bar app's own rule.
  - The home: trailing separators dropped; an empty one or a root blanks nothing. Each place it is followed by the end of the text or by a character no folder name holds (not `[A-Za-z0-9_.-]`; dots that end a sentence count as the end) reads `~`: the rule of `home_rule` in the menu-bar app's `log.rs`. The same for its JSON spelling (each `\` doubled) when that differs.
  - The app's logs: names matching `/^app-(\d{8})\.log$/` whose day is in the window, regular files only, sorted; entries `logs/harness-device/<name>`, `included` as `harness-device/<name>`. A folder that is missing or cannot be read includes nothing.
  - Entry order: `README.txt`, `status.txt`, today's `logs/…`, `logs/harness-device/…`, `harness.log`, the removals file. `included` follows it, without the README.
  - The README's last lines, replacing `Secrets (tokens, …) were blanked before writing.` and followed by today's four `dial-*.log:` lines unchanged:
    ```text
    Blanked before writing: secrets (tokens, keys, passwords, signed URLs), email addresses (<email>) and the home folder (~).
    Never included: conversations and transcripts, prompts, voice, tokens, keys, passwords and sign-in files, any process's environment, project files.
    status.txt: what `harness status` and `harness device claude|codex|vscode status --json` printed.
    logs/harness-device/: the Harness menu-bar app's own log.
    The dial's firmware version is in harness.log: the `fw` on the `cable: dial … on fw …` line of each dial greeting.
    ```

- [ ] **Step 1: Write the failing tests**, on throwaway folders, in `describe('buildLogBundle')`. Every existing call gains `home: '/Users/nobody'`; its expectations do not change.
  - `takes the menu-bar app's log in the window, and nothing else of its folder`: the folder holds `app-20260915.log`, `app-20260901.log`, `cli-20260915.log`, `app-20260915.log.bak`, `state.json`, and a folder named `app-20260914.log`; with `now` 15 Sep 2026 the zip's names are `README.txt` and `logs/harness-device/app-20260915.log`, and `included` is `['harness-device/app-20260915.log']`.
  - `a missing app log folder includes nothing`: the names are `['README.txt']`.
  - `blanks a token, an email and the home in every text file`: the line `Bearer abcdefghijklmnop for person@example.com in /Users/somebody/project/src`, written to a dated log, a `usb-AA` dial log, `harness.log`, the removals file, the app's log and `status`, with `home: '/Users/somebody'` and `redact: redactSecretsInText`, reads `Bearer <redacted> for <email> in ~/project/src` in each of the six entries.
  - `the home is blanked as a whole folder`: `blankPersonal('/Users/al/x /Users/alice/y /Users/al. /Users/al', '/Users/al')` is `'~/x /Users/alice/y ~. ~'`; `blankPersonal('{"cwd":"C:\\\\Users\\\\al\\\\repo"} C:\\Users\\al\\x', 'C:\\Users\\al')` is `'{"cwd":"~\\\\repo"} ~\\x'`; a home of `''` or `'/'` changes nothing. (Review Focus 3.)
  - `never includes a transcript, a sign-in file or a project file placed beside the logs`: `session.jsonl`, `auth.json`, `main.ts` and `notes.md`, each holding `NEVER-IN-THE-BUNDLE`, placed in the logs folder, in `usb-AA/`, in the data folder and in the app's log folder, beside one real log in each; the zip's names are exactly the real ones, and no entry's bytes hold the marker.
  - `status.txt holds what it is given, blanked, right after the README`: `status: '$ harness status\nsigned in as person@example.com at /Users/somebody/.harness\n'` gives the entry `'$ harness status\nsigned in as <email> at ~/.harness\n'`, second of the names, and `included` holds `status.txt`; with no `status` there is no entry.
  - `the README lists the notes given to it and says what is blanked and never included`: `notes: ['node: v24.22.2', 'Harness Device: 0.1.0', 'cwd: /Users/somebody/work']` are in the README, the last as `cwd: ~/work`; each of the five lines above is in it, and today's `dial-*.log:` lines after them.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/logBundle.spec.ts`. Expected: FAIL (`blankPersonal` is not exported; no `logs/harness-device/` entry; the home is not blanked).
- [ ] **Step 3: Implement.** The header comment names the two new entries and the menu-bar app as the third caller.
- [ ] **Step 4: Run** the step 2 command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `CLI: the log bundle takes the menu-bar app's log and status.txt, and blanks emails and the home folder`.

### Task 2: The facts: status outputs, versions, the app's log folder

**Layer:** the `harness` command's process (it starts other programs). **Depends on:** none. **Effort:** `high`.

**Red test:** `cli/src/lib/logBundleFacts.spec.ts`.

**Files:**
- Create: `cli/src/lib/logBundleFacts.ts`
- Test: `cli/src/lib/logBundleFacts.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RunResult { code: number | null; stdout: string; timedOut: boolean }
  /** One program run to its end with no shell: its stdout, never its stderr. Never rejects. */
  export type Run = (file: string, args: readonly string[], timeoutMs: number) => Promise<RunResult>
  export const STATUS_TIMEOUT_MS = 10_000
  export const VERSION_TIMEOUT_MS = 2_000
  export const FACT_OUTPUT_MAX_BYTES = 256 * 1024
  /** `status`, then `device claude|codex|vscode status --json`. */
  export const STATUS_COMMANDS: readonly (readonly string[])[]
  /** Harness, Harness Device, Orca, Visual Studio Code, ChatGPT, Claude, Herdr. */
  export const APPS: readonly string[]
  export interface FactsDeps {
    /** How this CLI was started: `process.execPath`, `process.execArgv`, then `process.argv[1]`. */
    self: readonly string[]
    platform: NodeJS.Platform
    home: string
    env: NodeJS.ProcessEnv
    /** `process.version`. */
    nodeVersion: string
    /** `os.release()`. */
    osRelease: string
    exists: (path: string) => boolean
    run: Run
  }
  export interface BundleFacts { status: string; versions: string[]; deviceAppLogsDir: string | undefined }
  /** The real runner. */
  export const runCommand: Run
  export function statusText(self: readonly string[], run: Run): Promise<string>
  export function versionLines(deps: FactsDeps): Promise<string[]>
  export function deviceAppLogsDir(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string | undefined
  /** The three, the status and the versions at the same time. Never rejects. */
  export function collectBundleFacts(deps: FactsDeps): Promise<BundleFacts>
  ```
  - `runCommand` is `execFile` as `claudeRunner` in `devices/claudePlugin.ts` runs it: no shell, stdin closed, `timeout`, `killSignal: 'SIGKILL'`, `maxBuffer: FACT_OUTPUT_MAX_BYTES`, `windowsHide: true`. `code` is 0, the exit code, or null (a kill, a program that could not start, output past the bound); `timedOut` only when the timeout killed it. What a killed command started ends by itself, as there.
  - `statusText`: each of `STATUS_COMMANDS` as `run(self[0], [...self.slice(1), ...words], STATUS_TIMEOUT_MS)`, all started before any is awaited. Each section is `$ harness <words joined by a space>`, then on the next lines:
    - `timedOut`: `(no answer: timed out after 10 s)`;
    - `code` 0: stdout with its trailing whitespace cut, or `(no output)` when nothing is left;
    - another number: `(exit <code>)`, and none of its stdout;
    - null, or a `run` that threw or rejected: `(no answer)`.
    Sections are joined by one blank line; the text ends with a newline.
  - `versionLines`: `node: <nodeVersion>`; then on `darwin` `os: macOS <stdout of /usr/bin/sw_vers -productVersion, trimmed>`, or `os: darwin <osRelease>` when it fails, and elsewhere `os: <platform> <osRelease>`; then, on `darwin` only, for each of `APPS` in order, the first of `/Applications/<App>.app/Contents/Info.plist` and `<home>/Applications/<App>.app/Contents/Info.plist` that `exists`: `<App>: <version>`, the version being the trimmed stdout of `/usr/bin/plutil -extract CFBundleShortVersionString raw -o - <that file>` when it exits 0 and matches `/^[0-9A-Za-z.+-]{1,32}$/`. Every run takes `VERSION_TIMEOUT_MS` and all start together. An app not found runs nothing and has no line.
  - `deviceAppLogsDir`: `darwin` `<home>/Library/Logs/ai.autonomous.harness.device`; `linux` `<XDG_DATA_HOME when it is an absolute path, else <home>/.local/share>/ai.autonomous.harness.device/logs`; `win32` `<LOCALAPPDATA>/ai.autonomous.harness.device/logs`, or undefined when it is unset; any other platform undefined. Joined with `node:path`'s `join`, the folder named segment by segment.

- [ ] **Step 1: Write the failing tests.** `run` is a fake that records its calls; the only real runs are `process.execPath -e …`.
  - `status.txt: each command under its own heading`: with answers `{0, '● running\n'}`, `{0, '{"enabled":true}\n'}`, `{1, 'half'}` and `{null, '', timedOut}` the text is, exactly:
    ```text
    $ harness status
    ● running

    $ harness device claude status --json
    {"enabled":true}

    $ harness device codex status --json
    (exit 1)

    $ harness device vscode status --json
    (no answer: timed out after 10 s)
    ```
    and each call was `('/node', ['--flag', '/cli.js', ...words], 10_000)` for `self = ['/node', '--flag', '/cli.js']`.
  - `a command that could not start, threw, or printed nothing is one line`: `{null, ''}` and a `run` that rejects give `(no answer)`; `{0, '  \n'}` gives `(no output)`.
  - `all four start before any answers`: with a `run` whose promises the test resolves by hand, four calls are recorded before the first is resolved. (Review Focus 1.)
  - `the real runner gives stdout and the exit code, never stderr`: `runCommand(process.execPath, ['-e', 'console.log("out"); console.error("SECRET"); process.exit(3)'], 10_000)` is `{ code: 3, stdout: 'out\n', timedOut: false }`, and `JSON.stringify` of the result holds no `SECRET`.
  - `the real runner ends a command at its time`: `runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 200)` is `{ code: null, timedOut: true }` with an empty stdout; a file that is not there is `{ code: null, timedOut: false }`.
  - `on a Mac the versions name the OS and each app found`: `exists` true for Harness in `/Applications` and Orca under the home only, `sw_vers` answering `26.0.1\n`, `plutil` answering `1.2.3\n` and `1.4.262\n`: the lines are `['node: v24.22.2', 'os: macOS 26.0.1', 'Harness: 1.2.3', 'Orca: 1.4.262']`; `plutil` ran twice, each as `('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', <the Info.plist>], 2_000)`.
  - `an app whose version cannot be read is not listed`: a `plutil` that exits 1, times out, or prints `not a version!` leaves no line; a `sw_vers` that fails gives `os: darwin 25.6.0`.
  - `off a Mac nothing is run`: `linux` gives `['node: v24.22.2', 'os: linux 6.8.0']` and `run` was never called.
  - `the app's log folder, per platform`: the five cases above, the expected paths built with `join`; a relative `XDG_DATA_HOME` is not used.
  - `the facts come together`: `collectBundleFacts` returns the three, and the status commands and `sw_vers` are all recorded before any is resolved.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/logBundleFacts.spec.ts`. Expected: FAIL (the module is missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command, `npx vitest run src/architecture.startEnvironment.spec.ts` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `CLI: the log bundle's facts: status outputs, versions, the menu-bar app's log folder`.

### Task 3: The command uses both

**Layer:** the `harness` command's process. **Depends on:** 1, 2. **Effort:** `high`.

**Red test:** `cli/src/lib/logsExportCommand.spec.ts`.

**Files:**
- Create: `cli/src/lib/logsExportCommand.ts`
- Create: `cli/src/testing/readZip.ts` (`readZip`, moved as it is out of `logBundle.spec.ts`)
- Modify: `cli/src/lib/logBundle.spec.ts` (imports `readZip`; its own copy goes)
- Modify: `cli/src/cli.ts` (the function `logsExportCommand` and the imports of `buildLogBundle`, `bundleFileName` and `redactSecretsInText` go; the `logs` case calls the module; `release` joins the `os` import)
- Test: `cli/src/lib/logsExportCommand.spec.ts`

**Interfaces:**
- Consumes: `buildLogBundle`, `bundleFileName` (Task 1); `BundleFacts`, `collectBundleFacts`, `runCommand` (Task 2); `redactSecretsInText`; `tildify` (`lib/daemonState.ts`).
- Produces:
  ```ts
  export interface LogsExportDeps {
    /** What followed `harness logs`: `export`, `--to <dir>`, `--days <n>`, `--json`. */
    args: readonly string[]
    logsDir: string
    dataDir: string
    version: string
    home: string
    cwd: string
    now: Date
    /** The README's `machine:` line; undefined when signed out. */
    machineId: string | undefined
    facts: () => Promise<BundleFacts>
    out: (line: string) => void
  }
  /** Writes the zip and says where. Resolves once it is written. */
  export function logsExportCommand(deps: LogsExportDeps): Promise<void>
  ```
  - As today: `--days` (7, at least 1), `--to` (else `<home>/Desktop` when it exists, else `cwd`), the folder made when missing, the two ways of saying it. `path` is `resolve(cwd, to, bundleFileName(now))`.
  - New: `notes` is `machine: <id or 'not signed in'>` then the facts' `versions`; `status`, `deviceAppLogsDir` and `home` are handed to the bundle; `redact` is `redactSecretsInText`.
  - `cli.ts`: `logsExportCommand({ args: rest, logsDir: env.HARNESS_LOGS_DIR, dataDir: env.ADAPTER_DATA_DIR, version: VERSION, home: homedir(), cwd: process.cwd(), now: new Date(), machineId: readAuthSession()?.machineId, facts: () => collectBundleFacts({ self: [process.execPath, ...process.execArgv, process.argv[1]], platform: process.platform, home: homedir(), env: process.env, nodeVersion: process.version, osRelease: release(), exists: existsSync, run: runCommand }), out: (line) => console.log(line) }).then(() => process.exit(0)).catch(onError)`.

- [ ] **Step 1: Write the failing tests**, on throwaway folders, `facts` a fake returning `{ status: '$ harness status\nat <home>/x for a@b.co\n', versions: ['node: v24.22.2', 'Harness Device: 0.1.0'], deviceAppLogsDir: <a folder with app-20261118.log> }`, `now` 18 Nov 2026 10:30:
  - `--json prints one line: path, included, bytes`: with `--to <dir> --json`, `out` was called once; the line's keys are exactly `path`, `included`, `bytes`; `path` is `<dir>/harness-logs-20261118-1030.zip`, the file is there and `bytes` long. (Review Focus 1.)
  - `the zip holds the facts`: read with `readZip`: `status.txt` is `'$ harness status\nat ~/x for <email>\n'`; `logs/harness-device/app-20261118.log` is there; the README holds `machine: m_1`, `node: v24.22.2` and `Harness Device: 0.1.0`; signed out, it holds `machine: not signed in`.
  - `without --to the zip goes to the Desktop, else the working directory`: with `<home>/Desktop` it is written there; without, in `cwd`.
  - `a relative --to gives an absolute path`: `--to out` writes `<cwd>/out/harness-logs-20261118-1030.zip`, the folder made.
  - `without --json it says where, then what`: the first line starts `wrote ` and ends ` KB)`, each included name follows on a line of its own; `--days 1` leaves a log two days old out.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/logsExportCommand.spec.ts`. Expected: FAIL (the module is missing).
- [ ] **Step 3: Implement**, and move `readZip`.
- [ ] **Step 4: Run** `npx vitest run src/lib/logsExportCommand.spec.ts src/lib/logBundle.spec.ts src/lib/logBundleFacts.spec.ts src/architecture.spec.ts src/architecture.startEnvironment.spec.ts` and `npm run typecheck`. Expected: PASS. `git diff --stat "$(git merge-base HEAD origin/main)" -- cli/src/core cli/src/services cli/src/harnessd cli/src/architecture.coreFiles.txt cli/src/lib/redactSecrets.ts` prints nothing.
- [ ] **Step 5: Commit** `CLI: harness logs export adds status.txt, the versions and the menu-bar app's log`.

### Task 4: The app reads the CLI's answer

**Layer:** the menu-bar app (outside text that becomes an argument of `open`). **Depends on:** none. **Effort:** `xhigh`.

**Red test:** the tests of `device-app/src-tauri/src/logs.rs`.

**Files:**
- Create: `device-app/src-tauri/src/logs.rs`
- Modify: `device-app/src-tauri/src/lib.rs` (`pub mod logs;`), `types.rs` (two words, appended)
- Test: in `logs.rs`

**Interfaces:**
- Produces:
  ```rust
  // types.rs
  /// Why an export gave no zip.
  #[derive(Clone, Copy, Debug, PartialEq, Eq)]
  pub enum ExportFailure { TimedOut, NoAnswer, NoFile }
  /// The zip an export wrote, and how the menu names it: the home folder as `~`.
  #[derive(Clone, Debug, PartialEq, Eq)]
  pub struct Exported { pub zip: PathBuf, pub shown: String }

  // logs.rs
  pub const EXPORT_DEADLINE: Duration = Duration::from_secs(60);
  /// Runs `logs export --json` and reads its answer.
  pub fn export(cli: &dyn Cli, home: &Path) -> Result<Exported, ExportFailure>
  /// The zip a finished run names.
  pub fn parse(output: &Output) -> Result<PathBuf, ExportFailure>
  /// `~/Desktop/…` for a zip under `home`, else the whole path.
  pub fn shown(zip: &Path, home: &Path) -> String
  /// What `open` is run with: `-R <zip>` on `macos`, elsewhere the zip's folder.
  pub fn reveal_args(os: &str, zip: &Path) -> Vec<String>
  /// `timed out`, `Harness did not answer`, `no file`.
  pub fn reason(failure: ExportFailure) -> &'static str
  ```
  - `export` is `export_within(cli, home, EXPORT_DEADLINE)`, private, as `account::auth_status_within`. A run that cannot start is `NoAnswer`.
  - `parse`, the first that holds: `timed_out` → `TimedOut`; a code other than 0, no stdout, a last line over `cli::LINE_MAX`, or one that is not a JSON object → `NoAnswer`; then `path` missing or not a string, not absolute, over 1024 bytes, holding a control character, or whose text after the last `/` is not `harness-logs-`, 8 digits, `-`, 4 digits, `.zip` and nothing more → `NoFile`.
  - `shown` compares whole folders (`strip_prefix`): `/Users/pp/…` is not under `/Users/p`.

- [ ] **Step 1: Write the failing tests** (`#[cfg(unix)]` where the fake CLI runs):
  - `only an absolute bundle path is kept`: a table over `Output`. Kept: `{"path":"/Users/p/Desktop/harness-logs-20261118-1030.zip","included":["a"],"bytes":9}` at exit 0, and the same after an earlier line `note`. `NoAnswer`: the same line at exit 1; `oops`; an empty stdout; `[1]`; `"x"`; a line of `LINE_MAX + 1` bytes. `NoFile`: `{"bytes":1}`; `{"path":7}`; `tmp/harness-logs-20261118-1030.zip`; `/tmp/evil.zip`; `/tmp/harness-logs-2026118-1030.zip`; `/tmp/harness-logs-20261118-1030.zip.sh`; `/tmp/xharness-logs-20261118-1030.zip`; `/tmp/harness-logs-20261118-1030.zip/`. `TimedOut`: `timed_out` with the good line.
  - `a path that is no menu line`: a path holding `\n` (as JSON's `\n`), and one of 1025 bytes that ends in a bundle name, are `NoFile`. (Review Focus 5.)
  - `the export is one fixed run`: the fake's `logs export --json` printing the good line gives `Ok(Exported { zip, shown: "~/Desktop/harness-logs-20261118-1030.zip" })` for that home, and `fake.calls()` is `["logs export --json"]`; `@exit 1` gives `NoAnswer`; `@hang` within a 300 ms deadline gives `TimedOut`.
  - `a CLI that cannot start`: the fake's program removed gives `NoAnswer`. (Review Focus 2.)
  - `the home reads as a tilde`: under the home `~/Desktop/x.zip`; `/Volumes/Work/x.zip` and `/Users/pp/x.zip` (home `/Users/p`) unchanged.
  - `the reveal is open -R on a mac and the folder elsewhere`: `reveal_args("macos", zip)` is `["-R", <zip>]`; `reveal_args("linux", zip)` is `[<its folder>]`.
  - `every failure has its fixed reason`: the three strings.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked --lib logs::`. Expected: FAIL (does not compile: no `logs` module).
- [ ] **Step 3: Implement.** Format with `cargo fmt`.
- [ ] **Step 4: Run** `cargo test --locked --lib`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: reads what harness logs export answered`.

### Task 5: The row, the click and its answer

**Layer:** the menu-bar app (the menu, the reducer, the runner's thread, the binary's ids). **Depends on:** 4. **Effort:** `high`.

**Red tests:** `model.rs`, `app.rs`, `runner.rs` and `main.rs` tests.

**Files:**
- Modify: `device-app/src-tauri/src/types.rs`, `model.rs`, `app.rs`, `runner.rs`, `main.rs`
- Test: in each

**Interfaces:**
- Consumes: `logs::export`, `logs::reveal_args`, `logs::reason`, `Exported`, `ExportFailure` (Task 4).
- Produces:
  ```rust
  // types.rs
  pub enum MenuAction { /* …, */ ExportLogs /* , About, Quit */ }
  /// The export of logs, as the menu shows it. Saved: the zip with the home as `~`.
  #[derive(Clone, Debug, Default, PartialEq, Eq)]
  pub enum LogsExport { #[default] Idle, Running, Saved(String), Failed(ExportFailure) }
  pub struct AppState { /* …, */ pub logs: LogsExport }
  pub enum Event { /* …, */ LogsExported(Result<Exported, ExportFailure>) }
  pub enum Effect { /* …, */ ExportLogs, Reveal(PathBuf) }
  ```
  - **`model::menu`**, after `Open Harness` and before `About`:
    - with `CliState::Found`: `Text("Exporting logs…")` while `Running`, else `Action(ExportLogs, "Export logs")`;
    - then, whatever the CLI's state: `Text("Saved to <shown>")` for `Saved`, `Text("Export failed: <reason>")` for `Failed`.
  - **`model::menu_log`** writes a `Saved to …` line as `Saved`. One constant holds `Saved to ` for both.
  - **`app.rs`:**
    - `Event::Menu(MenuAction::ExportLogs)`, only with a CLI found and no export running: `logs = Running`, `Effect::ExportLogs`.
    - `Event::LogsExported(Ok(exported))`: `logs = Saved(exported.shown)`, `Effect::Reveal(exported.zip)`, `Effect::Log("logs: exported")`.
    - `Event::LogsExported(Err(failure))`: `logs = Failed(failure)`, `Effect::Log("logs: export failed: <reason>")`.
    - Nothing else changes `logs`: not a tick, a menu opened, or a CLI that goes away. `relaunch_waits` does not change.
  - **`runner.rs`:**
    - `Effect::ExportLogs`: with a CLI, on a thread, `send(Event::LogsExported(logs::export(&*cli, &home)))`; with none, `Event::LogsExported(Err(ExportFailure::NoAnswer))` at once. Not `with_cli`: its `Cli(false)` would leave the row waiting for an answer.
    - `Effect::Reveal(zip)`: `shared.open(&reveal_args(std::env::consts::OS, &zip), "logs")`.
  - **`main.rs`:** `menu_id(MenuAction::ExportLogs)` is `"export_logs"`, and `menu_action` knows it.

- [ ] **Step 1: Write the failing tests.**
  - `model.rs`. `state()` gains `logs: LogsExport::Idle`. Every existing expectation of a menu with a CLI found gains `Export logs` directly above `About` (`the_whole_menu`, `the_sound_row`, `the_notifications_submenu`, `the_update_rows`, `the_menu_as_a_log_line`; in `open_harness_needs_the_desktop_app` the last rows become the separator, `Export logs`, `About`, `Quit`). New:
    - `the_export_row_has_three_states`: `Idle` gives the action alone; `Running` the disabled `Exporting logs…` and no action; `Saved("~/Desktop/harness-logs-20261118-1030.zip")` the action, then `Text("Saved to ~/Desktop/harness-logs-20261118-1030.zip")`, then `About`; each `Failed` the action, then `Export failed: timed out`, `Export failed: Harness did not answer` or `Export failed: no file`.
    - `the_export_row_needs_a_cli`: for `Installing`, `InstallFailed` and `Removed`, in every state of `logs`, no item reads `Export logs` or `Exporting logs…`; a `Saved` line is still there.
    - `the_log_never_names_the_zip`: `menu_log` of the menu with `Saved("/Volumes/Work/harness-logs-20261118-1030.zip")` is `Device ready | Signed in | Open Harness | Export logs | Saved | About | Quit`. (Review Focus 4.)
  - `app.rs`. Existing `rows(...)` lists and `menu:` lines of a found CLI gain the row. New, with `exported()` being `Exported { zip: "/Users/p/Desktop/harness-logs-20261118-1030.zip", shown: "~/Desktop/harness-logs-20261118-1030.zip" }`:
    - `a_click_exports_and_the_row_waits`: the click gives one `Effect::ExportLogs` and a menu with `Text("Exporting logs…")`; a second click gives none.
    - `a_saved_export_is_revealed_and_named`: the answer gives `Effect::Reveal(zip)`, the log `["logs: exported"]`, the rows `… "Export logs", "Saved to ~/Desktop/harness-logs-20261118-1030.zip", "About", "Quit"`; no effect's log line holds `harness-logs-`.
    - `a_failed_export_says_why`: each failure gives its line and `logs: export failed: <reason>`, and no `Reveal`.
    - `the_line_stays_until_the_next_export`: after a save, a tick, a menu opened and `Event::Cli(false)` keep the line (the last without the row); with the CLI back, a click removes it.
    - `without_a_cli_a_click_exports_nothing`: on a removed CLI the click gives no `ExportLogs`; an answer that arrives then still sets the line.
  - `runner.rs`:
    - `an_export_gives_the_zip`: the fake's `logs export --json` naming a zip under the world's home gives `Event::LogsExported(Ok(Exported { zip, shown: "~/Desktop/harness-logs-20261118-1030.zip" }))`, and the calls are `["logs export --json"]`.
    - `an_export_with_no_cli_still_answers`: with no CLI found, and with the fake's program removed after it was found, the answer is `Event::LogsExported(Err(ExportFailure::NoAnswer))`. (Review Focus 2.)
    - `the_reveal_is_one_fixed_open`: `Effect::Reveal(zip)` records `["-R", <zip>]` on macOS and `[<its folder>]` elsewhere (`#[cfg]` on the expectation).
    - `the_binary_gets_its_four_effects_back`: `Effect::ExportLogs` and `Effect::Reveal(..)` join the effects that do not come back.
  - `main.rs`, `every_menu_action_has_its_own_id`: `ExportLogs` joins the list, the ids are 11, `menu_id(ExportLogs)` is `"export_logs"`.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked`. Expected: FAIL (does not compile: no `MenuAction::ExportLogs`).
- [ ] **Step 3: Implement.** Format with `cargo fmt`.
- [ ] **Step 4: Run** `cargo test --locked`. Expected: PASS, the library's tests and the binary's.
- [ ] **Step 5: Commit** `Harness Device: Export logs in the menu`.

### Task 6: Say it in the guides

**Layer:** docs. **Depends on:** none. **Effort:** `medium`. **Red test:** none: docs only, one commit.

**Files:**
- Modify: `desktop/design/desktop-design-system.md` (the Harness Device section)
- Modify: `device-app/AGENTS.md`

- [ ] **Step 1: The design doc.**
  - The menu listing gains, between `Open Harness` and `About`, `Export logs` and under it `Saved to ~/Desktop/harness-logs-20261118-1030.zip`.
  - One bullet after the About bullet: `Export logs` is there while Harness is installed; while it runs the row is the disabled `Exporting logs…`; then Finder shows the zip and a disabled line under the row reads `Saved to ~/Desktop/harness-logs-YYYYMMDD-HHMM.zip`, or `Export failed:` and `timed out`, `Harness did not answer` or `no file`; the line stays until the next export or the app quits.
  - The bullet `A menu action that asks for more before it is done ends in …` stays as it is: `Export logs` acts at once and has no `…` (Answer 1).
  - The gallery does not change: it shows the window's screens, and this adds none.
- [ ] **Step 2: `device-app/AGENTS.md`.**
  - The first paragraph: the app also exports the logs (`Export logs`), through the CLI.
  - **Fixed arguments:** `logs export --json` is one more fixed line. `open -R` takes one argument that is not fixed text: the zip the CLI's answer names, kept only when it is an absolute path whose file name is `harness-logs-YYYYMMDD-HHMM.zip` (`logs.rs`); nothing from the webview.
  - **One log, redacted:** an export logs `logs: exported` or `logs: export failed:` and a fixed reason, and the menu's line as `Saved`; never the zip's path.
- [ ] **Step 3: Commit** `Docs: the menu-bar app's Export logs`.

## Follow-ups (proposals, not in this branch)

- A permanent end-to-end case for `harness logs export` in `cli/e2e` (the built CLI under the suite's throwaway home, with its fake engines), so the real command runs in the nightly and by-hand CLI end-to-end workflow.
- The desktop app's export dialog could say what the bundle now holds.

## The pull request's body

- Platforms: the CLI part on macOS, Linux and Windows (unit tests on Linux in PR CI; the apps' versions on macOS only; not run on Windows); the menu-bar app on macOS (tested by hand on this Mac) and Linux (PR CI).
- The core is unchanged (the `git diff --stat` of Task 3, step 4, prints nothing), so `npm run test:core` and the other coverage gates are not needed.
- Evidence: each task's red and green runs; `cargo test --locked` on this Mac; Verification's checks 2 to 4, as text.

## Verification

**Never touched:** the person's `~/.harness`, daemon (port 18473), dial, `~/.claude`, `~/.codex`, real Desktop, any account, any backend, production. Nothing signs in. Check 4 only executes the installed CLI's files, under the throwaway home.

**Temporary workflow:** none. Every unit check runs in PR CI by itself; checks 2 to 4 need a Mac's menu bar and Finder; the macOS `cargo test` is the repo's own by-hand gate (`docs/validation-and-release.md`, "What PR CI does not run") and takes minutes.

**In PR CI, by itself** (nothing is started by hand; `ci/required` is the one required check): `cli-typecheck` and `cli-tests` (the three specs, on Linux); `companion-subsystems` and `pty-checks` (a `cli/` change selects them); `device-app-checks` (`cargo test --locked` on Linux, the app's UI suite); `desktop-tests` (the design doc is under `desktop/`); `process-checks`.

**Local-only gates:** `python3 scripts/local-checks.py --list` on this plan's paths selects none (checked 2026-11-18). `npm run test:core`, `test:harnessd` and the other coverage gates, the serial and PTY specs, `make desktop-test` and the CLI end-to-end workflow are not needed: none of their files change. The one by-hand gate is check 1's `cargo test --locked` on this Mac, recorded in the pull request.

**Isolation** (the repo's guide: `docs/development.md`, "Isolated end-to-end testing", and `cli/AGENTS.md` rule 6; plus a home and a `PATH` of its own):

```bash
T="$(cd "$(mktemp -d /tmp/hx.XXXXXX)" && pwd -P)"; REPO="$PWD"
mkdir -p "$T"/{home/Desktop,bin,fake,out} "$T/home/.harness/logs/usb-AA" "$T/home/.harness/cli/data" \
  "$T/home/Library/Application Support/ai.autonomous.harness.device"
cat > "$T/env" <<EOF
export HOME="$T/home" CFFIXED_USER_HOME="$T/home"
export PATH="$T/bin:/usr/bin:/bin:/usr/sbin:/sbin"      # no folder of the person's: no claude, codex, orca or harness
export PORT=28473 ADAPTER_DATA_DIR="$T/home/.harness/cli/data" HARNESS_AUTH_DIR="$T/home/.harness/auth"
export ADAPTER_COMPUTER_ID_FILE="$T/home/.harness/computer-id"
export BACKEND_WS_URL=ws://127.0.0.1:9 WEB_URL=http://127.0.0.1:9
export ADAPTER_UPDATE_DISABLE=true ANALYTICS_ENABLED=false DISABLE_HOOK_INSTALL=true CABLE_DISABLE=true
export FAKE_HARNESS="$T/fake" REPO="$REPO"
unset TMUX TMUX_PANE CLAUDE_CONFIG_DIR CODEX_HOME HARNESS_ENV_FILE HARNESS_DEVICE_CLI
EOF
ln -s "$(command -v node)" "$T/bin/node"
# No login item is asked for and no window opens.
echo '{"version":1,"cliSeen":true,"askedSignIn":true,"loginItem":true}' \
  > "$T/home/Library/Application Support/ai.autonomous.harness.device/state.json"
# What the app asks besides the export: the fake answers, so no daemon is started.
printf '{"attached":false}\n@stdin\n' > "$T/fake/hardware_watch_--json"
printf '{"loggedIn":true}\n' > "$T/fake/auth_status_--json"; printf '0.6.58\n' > "$T/fake/--version"
# Checks 3 and 4: the fake for everything but the export, which goes to a real CLI.
cat > "$T/bin/harness" <<'EOF'
#!/bin/sh
if [ "$1 $2" = "logs export" ]; then exec "$EXPORT_NODE" "$EXPORT_CLI" "$@"; fi
exec "$REPO/device-app/src-tauri/tests/fake-harness" "$@"
EOF
chmod +x "$T/bin/harness"
lsof -nP -iTCP:18473 -sTCP:LISTEN -t > "$T/person-daemon.pid"     # compared again at the end
```

- The app is the unbundled debug binary, built once in an ordinary shell: `(cd device-app/ui && npm ci && npm run build) && (cd device-app/src-tauri && cargo build --locked)`; `APP="${CARGO_TARGET_DIR:-device-app/src-tauri/target}/debug/harness-device"`. It is started from a shell that sourced `"$T/env"`, where `command -v claude codex orca` prints nothing.
- The click: a person at this Mac, or a tester whose terminal has Accessibility (`osascript`, System Events, process `harness-device`: `click menu bar item 1 of menu bar 2`, then the row). Without it the tester asks the main session and does not skip.
- No screenshots. The evidence is text: the `menu:` and `logs:` lines of `$T/home/Library/Logs/ai.autonomous.harness.device/app-*.log`, `$T/fake/calls.log`, and the output of the `unzip` and `grep` commands.
- `open` is the real one: a Finder window on `$T/home/Desktop` opens on this Mac's screen at each saved export. It is closed by hand.
- At the end: Quit from the menu, `rm -rf "$T"`, and `lsof -nP -iTCP:18473 -sTCP:LISTEN -t` still prints the pid in `person-daemon.pid`.

| # | What to run | Where | What a person should see |
|---|---|---|---|
| 1 | The suites, at the final head: `cd cli && npm ci && npx vitest run src/lib/logBundle.spec.ts src/lib/logBundleFacts.spec.ts src/lib/logsExportCommand.spec.ts src/architecture.spec.ts src/architecture.startEnvironment.spec.ts && npm run typecheck`; `cd device-app/ui && npm ci && npm run build`; `cd device-app/src-tauri && cargo test --locked`; the `git diff --stat` of Task 3, step 4 | this Mac, the full checkout | all pass; the diff prints nothing. `cargo test` here is the macOS proof: PR CI compiles Linux only. On GitHub: PR CI's own runs, none by hand |
| 2 | The app against the fake CLI: `HARNESS_DEVICE_CLI="$REPO/device-app/src-tauri/tests/fake-harness" "$APP"`, one run; the script is rewritten before each row's click | this Mac, isolated | each row's menu lines and log lines, word for word |
| 3 | The app against this branch's CLI: `(cd cli && npm run build)`, the seeds below, then `EXPORT_NODE="$T/bin/node" EXPORT_CLI="$REPO/cli/dist/cli.js" HARNESS_DEVICE_CLI="$T/bin/harness" "$APP"`; click `Export logs`; then the commands below | this Mac, isolated; the apps' versions are read from this Mac's `/Applications` with `plutil`, read-only | Finder shows `$T/home/Desktop` with `harness-logs-….zip` selected; the menu has `Export logs` and `Saved to ~/Desktop/harness-logs-….zip`; the log has `logs: exported` and a `menu:` line with `Saved`, no path; every command below prints what it says |
| 4 | The app against the CLI installed on this Mac, an older one: as check 3 with `EXPORT_NODE="$(cat "$REAL/.harness/runtime/current-node")" EXPORT_CLI="$REAL/.harness/cli/cli.js"`, `REAL` being the person's home, read before `"$T/env"` is sourced | this Mac, isolated; the installed CLI's files are executed, nothing of the person's is read or written | the same row, Finder and `Saved to` line; the zip is today's bundle (no `status.txt`): the app works the same. Skipped, and reported as not run, on a Mac with no installed CLI |
| 5 | **Needs Diego himself; not needed for merge** (the spec). On an installed build with this change, in his own session: click `Export logs` once | his Mac, his own logs and Desktop | Finder shows the zip on his Desktop. He notes whether macOS asks to let Harness use the Desktop folder (Answer 2: accepted) |

**Check 2, row by row.** The script is `$T/fake/logs_export_--json`; `Z="$T/home/Desktop/harness-logs-20261118-1030.zip"`, made first with `printf x > "$Z"`; `GOOD` is the line `{"path":"<Z>","included":[],"bytes":1}`.

| Row | Script | The menu, the log, what else |
|---|---|---|
| Saved | `GOOD` | click → Finder shows the zip; `Export logs`, then `Saved to ~/Desktop/harness-logs-20261118-1030.zip`, then `About`; log: `logs: exported`, and `menu: … \| Export logs \| Saved \| About \| Quit` |
| While it runs | `@wait go`, then `GOOD` | before `touch "$T/fake/go"` the row reads `Exporting logs…`, greyed, and `calls.log` has gained one `logs export --json`; after it, the Saved row |
| No answer | `@exit 1` | `Export failed: Harness did not answer`; log `logs: export failed: Harness did not answer`; no Finder window |
| No file | `{"path":"/etc/hosts"}` | `Export failed: no file`; no Finder window |
| Timed out | `@hang` | `Exporting logs…` for 60 s, then `Export failed: timed out` |
| The next export | `GOOD` again | the failed line is gone while it runs, then the Saved line |

**Check 3, the seeds and the commands.**

```bash
D="$(date +%Y%m%d)"
printf 'ws: Bearer abcdefgh12345678 for person@example.com in %s/project/src\n' "$T/home" > "$T/home/.harness/logs/app-$D.log"
printf 'cable: dial AA:BB on fw 0.0.95 proto 3\n' > "$T/home/.harness/cli/data/harness.log"
for f in "$T/home/.harness/logs/session.jsonl" "$T/home/.harness/logs/auth.json" "$T/home/.harness/logs/usb-AA/main.ts" \
  "$T/home/.harness/cli/data/transcript.jsonl" "$T/home/Library/Logs/ai.autonomous.harness.device/notes.jsonl"; do
  mkdir -p "$(dirname "$f")"; echo NEVER-IN-THE-BUNDLE > "$f"; done
# After the click:
unzip -o -q "$T"/home/Desktop/harness-logs-*.zip -d "$T/out" && (cd "$T/out" && find . -type f | sort)
grep -R "$T/home" "$T/out"; grep -R 'abcdefgh12345678' "$T/out"; grep -R 'NEVER-IN-THE-BUNDLE' "$T/out"
grep -RE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$T/out"; grep -R '/Users/' "$T/out"
grep -c '^\$ harness ' "$T/out/status.txt"; cat "$T/out/README.txt"
```

- The names: `README.txt`, `status.txt`, `logs/app-<today>.log`, `logs/harness-device/app-<day>.log` (the running app's own), `harness.log`. No `.jsonl`, `auth.json` or `main.ts`.
- The first four `grep`s print nothing. `logs/app-<today>.log` reads `ws: Bearer <redacted> for <email> in ~/project/src`.
- `grep -R '/Users/'`: any hit is reported with its file and line, never passed over: it is a path of this Mac from outside the throwaway home.
- `status.txt` has four headings, each followed by output or one bracketed line. The README has `node:`, `os: macOS`, a line for each of the seven apps this Mac has, the blanked and never-included lines, and the firmware line.
