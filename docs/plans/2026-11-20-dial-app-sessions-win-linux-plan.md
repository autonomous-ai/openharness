# The Claude and ChatGPT apps' sessions, and the ChatGPT follow, on Windows and Linux — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)`
> once its failing tests have been run and seen to fail, then the task's own message. A task with no red test is one
> commit. Commits stay local: phase 3 never pushes, and every task's red and green runs on this Mac or in the Podman
> machine `devcrew-appsessions`. The main session pushes to `origin/feat/dial-app-sessions-win-linux` only in phase 4,
> and each push while the temporary workflow (Task 1) is in the branch is a heavy run the main session asks the PM for
> first. No task pushes, merges, rebases or opens a pull request.

**Goal:** On Windows and Linux the dial lists the Claude app's Code sessions and the ChatGPT app's Codex threads as it
does on macOS, and Harness Device follows the thread open in ChatGPT on Windows, X11, sway and Hyprland, with every
OS-forced difference the spec's named one and macOS unchanged.

**Architecture:**
- **CLI (devices process only).** One new per-OS helper (`appPlaces.ts`) says where each app keeps its store and its
  program; the Claude store reader and source take a list of roots in place of one; the Store package lookup that
  `codexQueue.ts` caches moves into `lib/windows/storePackage.ts` so the install check and the queue share one answer;
  `devices.ts` drops the two `darwin` gates. The readers' rules, bounds, names and log lines do not change.
- **Harness Device.** `follow.rs` learns the off-macOS front values, the Linux program checks and a saved switch that
  stands in for Accessibility; one door per desktop (`follow_windows.rs`, `follow_x11.rs`, `follow_sway.rs`,
  `follow_hyprland.rs`), each with its own hook or connection; `follow::system` picks the door in `front.rs`'s order.
  The menu model stays free of `cfg`: `App::new` is told whether the item is a switch.
- **Pure rule, thin OS call**, as the base does: every rule is a function over plain values that runs on a Mac; the
  Win32, X11 and socket calls around it are a few lines: the Linux ones proven in the Podman machine in phase 3, the
  Win32 ones in phase 4 on the temporary workflow's Windows runners and the VM.

**Tech Stack:** TypeScript (Node 24, vitest) in `cli/`; Rust 1.95+ and Tauri 2 in `device-app/src-tauri` with
`windows-sys` 0.61 and `x11rb` 0.14 (already dependencies); GitHub Actions for one temporary workflow.

**Spec:** `docs/plans/2026-11-20-dial-app-sessions-win-linux-design.md`. Read it with this plan, the root `AGENTS.md`,
`cli/AGENTS.md`, `cli/src/services/AGENTS.md`, `device-app/AGENTS.md`, `docs/feature-design-rules.md`,
`docs/validation-and-release.md`, and the macOS designs it carries over:
`docs/plans/2026-11-19-dial-claude-app-sessions-design.md`, `docs/plans/2026-11-19-dial-chatgpt-ring-and-follow-design.md`,
`docs/plans/2026-11-20-dial-chatgpt-follow-ax-design.md`.

Path shorthand: `HO/` is `cli/src/cable/hosts/`, `ST/` is `device-app/src-tauri/`, `E2E/` is `cli/e2e/`.

## Base

- `feat/dial-app-sessions-win-linux` at `41645b59a8` (`feat/dial-windows` at `e7316662ff` with
  `origin/feat/device-app-win-linux` at `84843fcd49` merged in). The spec and this plan are untracked; the main session
  commits them, no task does.
- `.github/workflows/tmp-device-app-win-linux.yml` came in with the merge. It belongs to the other branch, runs only on
  its branches, and no task here touches it.
- When #4513 and `feat/device-app-win-linux` are on `main`, the main session rebases (spec, decision 2). Line numbers
  below are this base's; a task follows the expression it names when a line has moved.
- Nothing is installed in this worktree: `npm ci` in `cli/` before the first CLI task. One `CARGO_TARGET_DIR` outside
  the repository for `device-app` (`device-app/AGENTS.md`).

## How each kind of task proves itself

Phase 3 never pushes, and every task's tests run locally: red, then green, on this Mac or in the Podman machine.

- **CLI Windows and Linux paths** are plain values: unit tests on the Mac pass `platform: 'win32' | 'linux'` and use
  `node:path`'s `win32` / `posix`, as `herdrSocketPath` (`HO/herdrClient.ts`) does. Red, then green, with
  `cd cli && npx vitest run <spec>`.
- **Harness Device pure rules** compile everywhere (`cfg(any(windows, test))`, `cfg(any(target_os = "linux",
  all(test, unix)))`, as the base's `front_*.rs`): red, then green, with `cd device-app/src-tauri && cargo test --locked
  --lib <filter>` on the Mac. Every rule a Windows or Linux door holds is one of these, so its red and green are local.
- **`#[cfg(target_os = "linux")]` Rust** (`follow_x11.rs`) runs in a container on the Podman machine
  `devcrew-appsessions`: `rust:1-bookworm` plus `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
  libxdo-dev`, the repository mounted, `CARGO_TARGET_DIR` on a volume (`device-app/AGENTS.md`).
- **`#[cfg(windows)]` Rust** (Task 13's Win32 glue around its pure rules) is written in phase 3 and cannot be compiled
  there: on this Mac `cargo check --locked --lib --tests --target x86_64-pc-windows-msvc` stops in `ring`'s build
  script, which needs MSVC's C headers (tried on this base, 2026-11-20). Its first compile and its live test run in
  phase 4, on Task 1's `device-app-windows` jobs (x64 and arm64) and on the VM (the testers, Verification 2 and 4).
- **The CLI end-to-end files on Linux** (Task 8) run in a Linux container on the Podman machine; the temporary
  workflow runs them again in phase 4.

## Tasks at a glance

| # | Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|---|
| 1 | Temporary workflow | `.github/workflows/tmp-dial-app-sessions-win-linux.yml` (new) | none | medium | none: temporary, one commit, run only in phase 4, removed before the merge |
| 2 | The apps' places per OS | `HO/appPlaces.ts` (new), `HO/appPlaces.spec.ts` (new) | none | high | `appPlaces.spec.ts` |
| 3 | The Claude store reads several roots | `HO/claudeAppStore.ts`, `HO/claudeAppStore.spec.ts`, `cli/scripts/benchmark-claude-app-store.ts` | 2 | high | `claudeAppStore.spec.ts` new cases |
| 4 | The Claude source watches each root | `HO/claudeAppSource.ts`, `HO/claudeAppSource.spec.ts` | 2, 3 | xhigh | `claudeAppSource.spec.ts` new cases |
| 5 | One Store package answer, shared | `cli/src/lib/windows/storePackage.ts`, `cli/src/lib/windows/storePackage.spec.ts`, `HO/codexQueue.ts`, `HO/codexQueue.spec.ts` | none | high | `storePackage.spec.ts` new cases |
| 6 | Retired: the reader already builds its URI with `pathToFileURL`; Task 9's run under the escaped profile name is the proof | — | — | — | — |
| 7 | The devices build both sources on Windows and Linux | `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts` | 2, 4, 5 | high | `devices.spec.ts` new and replaced cases |
| 8 | End to end on Linux (and macOS, unchanged) | `E2E/deviceClaudeAppSessions.e2e.ts`, `E2E/deviceCodexAppThreads.e2e.ts`, `E2E/dialChatgptFollow.e2e.ts`, `E2E/harness/schemeApps.ts` (new), `E2E/harness/daemon.ts`, `E2E/harness/outsideAgent.ts` | 7 | high | none: test tooling, one commit; the Mac and the Podman machine run it, Task 1's `cli-e2e-linux` job again in phase 4 |
| 9 | End to end on Windows | `E2E/dialWindowsAppSessions.e2e.ts` (new), `E2E/harness/windowsDaemon.ts`, `cli/vitest.e2e.windows.config.ts` | 7 | high | none: test tooling, one commit; the VM run in phase 4 is the evidence |
| 10 | Harness Device: the doors' module map | `ST/src/lib.rs`, `ST/Cargo.toml`, `ST/src/follow_windows.rs`, `ST/src/follow_x11.rs`, `ST/src/follow_sway.rs`, `ST/src/follow_hyprland.rs` (each new, doc comment only) | none | medium | none: no behavior, one commit |
| 11 | Harness Device: the follow rules off macOS | `ST/src/follow.rs`, `ST/src/runner.rs` | none | high | `follow.rs`, `runner.rs` new cases |
| 12 | Harness Device: the switch and the menu off macOS | `ST/src/types.rs`, `ST/src/model.rs`, `ST/src/app.rs`, `ST/src/state.rs`, `ST/src/runner.rs`, `ST/src/main.rs` | 11 | high | `model.rs`, `app.rs`, `state.rs`, `runner.rs` new cases |
| 13 | `WindowsFollow` | `ST/src/follow_windows.rs` | 10, 11 | xhigh | `follow_windows.rs` pure cases (Mac); the `#[cfg(windows)]` glue compiles and runs in phase 4 |
| 14 | `X11Follow` | `ST/src/follow_x11.rs`, `ST/src/front_x11.rs` (`pub(crate)` only) | 10, 11 | high | `follow_x11.rs` (Podman) |
| 15 | `SwayFollow` | `ST/src/follow_sway.rs`, `ST/src/front_sway.rs` (`pub(crate)` only) | 10, 11 | high | `follow_sway.rs` (Mac) |
| 16 | `HyprlandFollow` | `ST/src/follow_hyprland.rs`, `ST/src/front_hyprland.rs` (`pub(crate)` only) | 10, 11 | high | `follow_hyprland.rs` (Mac) |
| 17 | `follow::system` picks the door | `ST/src/follow.rs`, `ST/src/main.rs` | 12, 13, 14, 15, 16 | medium | `follow.rs` new case |
| 18 | Docs: the CLI | `cli/AGENTS.md`, `docs/specs/2026-11-15-device-host-adapter.md` | 7 | medium | none: docs, one commit |
| 19 | Docs: Harness Device and the design | `device-app/AGENTS.md`, `docs/plans/2026-11-19-device-app-win-linux-design.md`, `desktop/design/desktop-design-system.md` | 17 | medium | none: docs, one commit |

**Longest chain:** 2 → 3 → 4 → 7 → 8 (five tasks; 2 → 3 → 4 → 7 → 9 is as long). Tasks 1, 2, 5, 10 and 11 start at
once. Task 6 is retired; its number stays so the others stand. The CLI tasks (2 to 5, 7 to 9, 18) and the Harness
Device tasks (10 to 17, 19) share no file and run side by side.
`ST/src/runner.rs` is in 11 and 12, `ST/src/follow.rs` in 11 and 17, `ST/src/main.rs` in 12 and 17: those run one
after another by their dependencies. 13 to 16 share no file with each other and run side by side after 10 and 11.

## Global Constraints

- Nothing in `cli/src/core/`: `git diff --stat 41645b59a8 -- cli/src/core cli/src/architecture.coreFiles.txt` prints
  nothing (against `origin/main` after the rebase).
- macOS's code paths stay as they are: `ST/src/follow_macos.rs` is not edited; the macOS store root, its watch list
  `[root, dirname(root)]`, the `ChatGPT.app` bundle-id check, `MenuAction::FollowChatgpt` / `FollowSettings`,
  `Effect::AskAx`, `Effect::OpenAxSettings` and the Follow screen behave exactly as today; every existing macOS case
  stays green unchanged except for the new constructor shapes.
- No new variable in the daemon's start allowlist: `cli/src/lib/startEnvironment.ts` is not edited.
- The stores are read only. No test touches a person's real apps, homes, `~/.codex`, `/Applications`, `/usr/lib`,
  `%APPDATA%` or registry: throwaway homes and `HARNESS_APPLICATIONS_DIR` only.
- No poll: every new read is pushed by a non-recursive `fs.watch` (`HO/folderWatch.ts`) or a window event.
- No title, folder, name, id, pid or path in a log line, a saved file or an Event; the title goes only on the watch's
  stdin as `{"thread":"<title>"}`. The log lines are macOS's, word for word: `[claude-app] watch · on|none`,
  `listed · <n> sessions`, `read · <ms> ms · <p> parsed · <s> skipped`, `over · <n>`, `read · failed · <kind>`;
  `[codex-app] …` unchanged; `[device] thread · moved|skipped · …`; `chatgpt: follow on|off|no observer`.
- Bounds (#4485, #4494; across the Claude roots, decided by the PM, 2026-11-20): per folder, 8 orgs an account, 1,024
  names an org folder, 1 MiB a file; across the roots together, 8 account folders in all (the first root's first), 256
  parses a read, 16 listed; a name already taken from an earlier root is neither parsed nor counted as skipped; one
  pass at a time 250 ms apart (Claude); `LIMIT 200`, 16 listed, 1 s floor (Codex); a title over 256 UTF-16 units or
  holding a control character is the empty title (`follow::thread_line`, unchanged).
- Fixed values from the spec: MSIX family `Claude_pzs8sxrjxfjjc`; ChatGPT package `OpenAI.Codex`, family
  `OpenAI.Codex_2p2nqsd0c76g0`; Linux program `/usr/lib/chatgpt/ChatGPT`; front values `ChatGPT.exe` (no case) and
  `ChatGPT`; the hook's image rule `\WindowsApps\OpenAI.Codex_<…>\…\ChatGPT.exe` (`cli/hook/notify.mjs` `CHATGPT_APP`).
- The base's `ST/src/front_*.rs` change only by `pub(crate)` on a helper a door reuses.
- Menu copy: `Follow ChatGPT`, unchanged. No new screen.
- `cli/src/services/` is held at 100% per file (`npm run test:core`): every new branch in `devices.ts` has its case.
- Names and comments follow `docs/naming-system.md` and say why.

## Decided here, where the spec leaves the builder a choice

- **The Windows seam's layout.** With `HARNESS_APPLICATIONS_DIR` absolute on Windows, "installed" is the file
  `<dir>\OpenAI.Codex\app\ChatGPT.exe` (the package's own `app\ChatGPT.exe` under a folder named for the package), and
  PowerShell is not asked. On Linux it is `<dir>/chatgpt/ChatGPT`.
- **One Store package answer, shared** (not mirrored): `codexQueue.ts`'s rule as written today, moved into
  `lib/windows/storePackage.ts`. A folder found is kept while it exists; one that went (an update renames it) is asked
  for again at once; not installed, or a failed ask, is asked again after 10 minutes; one ask at a time.
- **A watch chain never reaches the home folder**: a stop folder (`%LOCALAPPDATA%\Packages`, `%APPDATA%`, `~/.config`
  or `$XDG_CONFIG_HOME`) equal to the home folder is left out of the chain.
- **The saved switch** is `followOff` in Harness Device's state file (`#[serde(default)]`, false = on), written only by
  the click.
- **A window in front that is not ChatGPT's program** (a program named ChatGPT that is not the app, or no window) is
  heard as the empty title, as macOS hears no focused window.
- **X11's `WM_NAME`** is read when the window has no `_NET_WM_NAME`: `UTF8_STRING` as UTF-8, `STRING` as Latin-1, any
  other type as no title.
- **Hyprland's title events** are `windowtitle>>ADDR` and `windowtitlev2>>ADDR,…`, both taken only for the active
  window's address; the title is always read from `j/activewindow`, never from the event.
- **An observer's connection that ends after it started** ends that observation quietly; the next start opens a new
  one. No new log line.
- **How the Windows end-to-end tap reaches the apps.** The whole vitest run, and so the sealed daemon it starts
  (`windowsDaemon.ts`, unchanged in how it seals), runs as dial-windows's test user `hxdialwin` in that user's console
  session, through the desk's `console.ps1` (a one-shot `schtasks /it` task under the account it is run as, over SSH as
  `hxdialwin`). The daemon's homes (`HOME`, `USERPROFILE`, `LOCALAPPDATA`, `APPDATA`, `CODEX_HOME`) are the throwaway
  root's, so the fixture stores are the only stores it reads; `harness-pty open-link` asks Windows for the scheme's
  handler (`AssocQueryStringW`), which reads the registry under the process's own token, not its environment, so it
  finds `hxdialwin`'s `claude://` and `codex://` handlers and `ShellExecuteExW` starts the app on that user's desktop.
  Nothing in the harness changes for this; only where the run is started from does.

## Review Focus

1. **A Windows profile named like the e2e's (`Nguyễn Văn A' & 100%`)**: both Claude roots, the Codex store's
   `immutable=1` URI and the seam's program path work with it. Pinned in Task 2 (roots) and Task 9 (the sealed
   profile, whose Codex store the reader opens by its own `pathToFileURL` URI).
2. **The Claude app installed while a dial is attached** (MSIX: `Packages\Claude_…\LocalCache\Roaming\Claude\…` made
   folder by folder; Linux: `~/.config/Claude` made after start): the watch walks down its chain and the first store is
   listed without another event, and a busy sibling (another package's folder, another app's config folder) wakes
   nothing. Pinned in Task 4.
3. **`APPDATA`, `LOCALAPPDATA` or `XDG_CONFIG_HOME` relative, empty, or the home folder itself**: the profile's
   defaults are used and the home folder is never watched. Pinned in Task 2.
4. **ChatGPT retitled behind another app, a second ChatGPT window, or another program named `ChatGPT` / `ChatGPT.exe`
   in front**: no line names a title that is not the focused ChatGPT window's. Pinned in Tasks 13 to 16.
5. **The switch turned off while an observation runs**: no line after the click, the observation is dropped at once;
   turned on again with ChatGPT in front, the first title is written again. Pinned in Task 12.

---

### Task 1: Temporary workflow

**Files:** Create `.github/workflows/tmp-dial-app-sessions-win-linux.yml`.

Temporary: one commit, no red test, removed before the merge (a later devcrew step removes it). As planned, the PM's
answer (2026-11-20): push-only on this branch, `ubuntu-24.04` for the three end-to-end files, Harness Device's `cargo
test --lib` on Windows x64 and arm64 runners. It runs only in phase 4: every push while it is in the branch is a heavy
run the main session asks the PM for first.

- [ ] **Step 1: Write the workflow.** First line comment: `# Temporary: removed before feat/dial-app-sessions-win-linux
  merges. No secrets, nothing signed, published or deployed.` `on: push: branches: [feat/dial-app-sessions-win-linux]`,
  `paths: ['cli/**', 'device-app/src-tauri/**', '.github/workflows/tmp-dial-app-sessions-win-linux.yml']`.
  `permissions: contents: read`. `concurrency: { group: tmp-dial-app-sessions-${{ github.ref }}, cancel-in-progress:
  true }`. Every checkout `persist-credentials: false`. Two jobs:
  - `cli-e2e-linux` on `ubuntu-24.04`, `timeout-minutes: 45`, `defaults.run.working-directory: cli`, env `LANG:
    C.UTF-8`, `SHELL: /bin/zsh`. Steps copied from `cli-e2e.yml`'s `e2e` job: setup-node `24.22.2`; `sudo bash
    ../scripts/apt-install.sh tmux zsh tcsh dash lsof`, the inotify `sysctl` and the `compaudit` fix; `npm ci
    --no-audit --no-fund`. Then, with `E2E_BUNDLE: '1'` and `E2E_ARTIFACTS_DIR: ${{ runner.temp }}/e2e-daemon-logs`:
    `npx vitest run --config vitest.e2e.config.ts e2e/deviceClaudeAppSessions.e2e.ts e2e/deviceCodexAppThreads.e2e.ts
    e2e/dialChatgptFollow.e2e.ts --reporter=default --reporter=json --outputFile.json="$RUNNER_TEMP/result.json"`. A
    step that fails unless `numTotalTests > 0 && numPassedTests === numTotalTests` (as `cli-e2e.yml`'s Podman job: a
    skipped file passes otherwise). On failure, upload `e2e-daemon-logs/` (`retention-days: 7`).
  - `device-app-windows`, matrix `runner: [windows-latest, windows-11-arm]`, `timeout-minutes: 60`: rust-toolchain
    stable, `Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6` (`workspaces: device-app/src-tauri`,
    `shared-key: dial-app-sessions-tmp`), then `cargo test --locked --lib --manifest-path
    device-app/src-tauri/Cargo.toml`.
- [ ] **Step 2: Check it.** `actionlint .github/workflows/tmp-dial-app-sessions-win-linux.yml` prints nothing (or
  `python3 scripts/ci-plan.py`'s actionlint step, as `process-checks` runs it).
- [ ] **Step 3: Commit** `ci: a temporary workflow for the app sessions on Windows and Linux (removed before the merge)`.

### Task 2: The apps' places per OS

**Files:** Create `HO/appPlaces.ts`, `HO/appPlaces.spec.ts`.

**Interfaces:**
- Produces:
  - `export interface ClaudeStoreRoot { root: string; watch: readonly string[] }` — `watch` is `root`, then each folder
    above it, nearest first, down to the stop folder.
  - `export function claudeStoreRoots(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): ClaudeStoreRoot[]`
  - `export function chatGptPlaces(platform: NodeJS.Platform, appsDir: string | undefined, home: string): string[]`
  - `export const CLAUDE_MSIX_FAMILY = 'Claude_pzs8sxrjxfjjc'`

- [ ] **Step 1: Write the failing tests** (`appPlaces.spec.ts`), each with exact paths:
  - `darwin`, home `/Users/a`: one root `/Users/a/Library/Application Support/Claude/claude-code-sessions`, watch
    `[root, '/Users/a/Library/Application Support/Claude']`, whatever `XDG_CONFIG_HOME` says.
  - `win32`, home `C:\Users\Nguyễn Văn A' & 100%`, `LOCALAPPDATA` and `APPDATA` set absolute: two roots in this order,
    `<LOCALAPPDATA>\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code-sessions` with watch `[root,
    …\Roaming\Claude, …\LocalCache\Roaming, …\LocalCache, …\Claude_pzs8sxrjxfjjc, <LOCALAPPDATA>\Packages]`, then
    `<APPDATA>\Claude\claude-code-sessions` with watch `[root, <APPDATA>\Claude, <APPDATA>]` (built with `win32.join`).
  - `win32` with both unset, empty or relative: `<home>\AppData\Local` and `<home>\AppData\Roaming` in their place.
  - `linux`: `XDG_CONFIG_HOME` absolute → `<it>/Claude/claude-code-sessions`, watch `[root, <it>/Claude, <it>]`; unset,
    empty or relative → `<home>/.config/…`; `XDG_CONFIG_HOME` equal to `home` → the chain stops at `<home>/Claude` and
    never holds `home`.
  - `chatGptPlaces`: `darwin` → `[<apps>/ChatGPT.app or /Applications/ChatGPT.app, <home>/Applications/ChatGPT.app]`
    (a relative `appsDir` ignored, as today's devices.spec case); `linux` → `[<apps>/chatgpt/ChatGPT]`, else
    `['/usr/lib/chatgpt/ChatGPT']`; `win32` → `[<apps>\OpenAI.Codex\app\ChatGPT.exe]` for an absolute `appsDir`, else
    `[]` (the package is asked); any other platform → `[]`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/appPlaces.spec.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** both functions with `node:path`'s `win32` on `win32` and `posix` elsewhere; "set" means
  non-empty and absolute for that platform, as `herdrSocketPath` reads it. No I/O: pure values.
- [ ] **Step 4: Run** the spec. Expected: PASS.
- [ ] **Step 5: Commit** red, then `feat(cli): where the Claude and ChatGPT apps keep their stores and programs on each OS`.

### Task 3: The Claude store reads several roots

**Files:** Modify `HO/claudeAppStore.ts`, `HO/claudeAppStore.spec.ts`, `cli/scripts/benchmark-claude-app-store.ts`.

**Interfaces:**
- Consumes: `claudeStoreRoots` (Task 2), in the benchmark only.
- Produces: `constructor(roots: readonly string[])`; `export interface StoreFolders { roots: readonly string[];
  accounts: readonly string[]; orgs: readonly string[] }` (`roots` are the given roots that are real folders, in the
  given order); `folders()` answers `undefined` only when no root is a real folder. `files`, `touch`, `read`, `forget`
  keep their signatures.

- [ ] **Step 1: Write the failing tests** (fixture stores via `src/testing/claudeAppFixture.ts` in two temp roots):
  - two roots, both there: sessions of both are listed, newest sort time first, at most 16 in all;
  - the same `local_<uuid>.json` name in both roots: one row, the first root's fields (its title), even when the
    second root's copy is newer; the second copy is not parsed (the `parsed` count shows it) and not counted skipped;
  - the bounds across roots (the PM, 2026-11-20): 6 account folders in the first root and 6 in the second → 8 read
    (the first root's 6, then the second's first 2 by name) and `over` counts 4; 256 parses a read across both roots;
    8 orgs an account and 1,024 names an org folder stay per folder;
  - only the second root there: `folders()` gives `roots: [second]`; neither there: `undefined` and everything held is
    forgotten; a root that goes takes its files with it at the next `folders()`;
  - every existing case passes with `new ClaudeAppStore([root])`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/claudeAppStore.spec.ts`. Expected: the new cases FAIL
  (the constructor takes one root).
- [ ] **Step 3: Implement.** `folders()` walks the roots in order, the 8-account bound counted across them; each `Org`
  keeps the index of its root; `read()` leaves out a file whose name an org of an earlier root holds. The open in
  `textOf` becomes `constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)`, as
  `HO/opencodeClient.ts` writes it, with a comment: Windows defines neither flag, so the open there is a plain read-only
  one after the same `lstat` (the spec's named difference); no behavior changes. The benchmark builds each case's store
  at `claudeStoreRoots(platform(), {}, <its throwaway home>)[0].root` and reads all that call's roots, so a Windows run
  measures the two-root walk.
- [ ] **Step 4: Run** the spec. Expected: PASS. Run `node --import tsx scripts/benchmark-claude-app-store.ts
  "$TMPDIR/bench.json"` once; it prints its cases.
- [ ] **Step 5: Commit** red, then `feat(cli): the Claude app's store is read from every root it has, the first root's copy first`.

### Task 4: The Claude source watches each root

**Files:** Modify `HO/claudeAppSource.ts`, `HO/claudeAppSource.spec.ts`.

**Interfaces:**
- Consumes: `ClaudeStoreRoot` (Task 2); `StoreFolders.roots` (Task 3).
- Produces: `ClaudeAppSourceDeps.roots: readonly ClaudeStoreRoot[]` in place of `root: string`; every other dep as
  today.

- [ ] **Step 1: Write the failing tests** (the fake watch records each call's folder list and its callback, as today):
  - `start()` sets one watch per root on its `watch` list, in roots order; `stop()` closes them and the account/org
    watches;
  - a root's event while that root is not there: no name, or the basename of a folder of its own chain, lists again;
    any other name (another package's folder under `Packages`, another app's folder under `~/.config` or `%APPDATA%`)
    does nothing; the other root's state does not change that;
  - Review Focus 2: the MSIX chain made folder by folder after start (the fake watch moved nearer, as `watchNearest`
    does, its event naming the next folder down each time) ends with one listing that reads the new store, with no
    further event;
  - an event of a root that is there names an account folder: its watches below are dropped and the folders listed
    again (today's rule, per root);
  - `[claude-app] watch · on` once any root is there, `· none` once none is, each said once a change;
  - two roots' events within 250 ms give one pass, and a pass at a time across both roots;
  - every existing case passes with `roots: [{ root, watch: [root, dirname(root)] }]`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/claudeAppSource.spec.ts`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.** `unwatch` becomes one stop per root; `rootChanged(root, file)` takes the root it came
  from and `unwatchBelow(join(root.root, file))`; `there` is per root, and `look()` says `on` while any root is there.
  The chain's basenames are what a not-there root's event may name.
- [ ] **Step 4: Run** the spec. Expected: PASS.
- [ ] **Step 5: Commit** red, then `feat(cli): the Claude app's source watches each of its store's roots from its nearest folder`.

### Task 5: One Store package answer, shared

**Files:** Modify `cli/src/lib/windows/storePackage.ts`, `cli/src/lib/windows/storePackage.spec.ts`, `HO/codexQueue.ts`,
`HO/codexQueue.spec.ts`.

**Interfaces:**
- Produces:
  - `export const STORE_PACKAGE_ASK_MS = 600_000` (moved from `codexQueue.ts`'s `PACKAGE_ASK_MS`).
  - `export interface StorePackageLook { known(): string | null; ask(): Promise<string | null> }` — `known()` is the
    folder last answered while it still exists, else null, and starts nothing; `ask()` joins the ask under way, or
    starts one when the kept folder is gone or 10 minutes have passed since a miss or a failure, else answers
    `known()` at once. One ask at a time. Never rejects.
  - `export function storePackageLook(name: string, query: (name: string) => Promise<string | null> = storePackageFolder,
    now: () => number = () => performance.now(), exists: (path: string) => boolean = existsSync): StorePackageLook`
  - `HO/codexQueue.ts`: `export const APP_PACKAGE = 'OpenAI.Codex'`; `codexQueueDeps(look: StorePackageLook =
    storePackageLook(APP_PACKAGE))`.

- [ ] **Step 1: Write the failing tests** in `storePackage.spec.ts` (fake query and clock): a found folder is answered
  by `known()` and `ask()` with no second query while it exists, and asked for at once when it is gone; not installed
  and a query that throws answer null, and are asked again only after 600,000 ms; two `ask()`s during one query share
  it (one query); `known()` never queries.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/windows/storePackage.spec.ts`. Expected: FAIL, no
  `storePackageLook`.
- [ ] **Step 3: Implement** `storePackageLook`; in `codexQueue.ts` the package's codex is `look.known()`'s folder's
  `app\resources\codex.exe`; with none, `void look.ask().then((folder) => { if (folder !== null) looks.delete('app') })`.
  `codexQueue.spec.ts`'s three package cases build `codexQueueDeps(storePackageLook('OpenAI.Codex', query))`; their
  assertions do not change.
- [ ] **Step 4: Run** `npx vitest run src/lib/windows/storePackage.spec.ts src/cable/hosts/codexQueue.spec.ts`.
  Expected: PASS.
- [ ] **Step 5: Commit** red, then `refactor(cli): one Store package answer, which the ChatGPT install check and the queue share`.

### Task 6: Retired

Retired (2026-11-20): the Codex reader already builds its `file:` URI with `pathToFileURL`, so it does not change;
Task 9's run under the profile whose name needs escaping is the proof. The number stays so the others stand.

### Task 7: The devices build both sources on Windows and Linux

**Files:** Modify `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts`.

**Interfaces:**
- Consumes: `claudeStoreRoots`, `chatGptPlaces` (Task 2); `ClaudeAppStore(roots)` (Task 3); `ClaudeAppSourceDeps.roots`
  (Task 4); `storePackageLook`, `APP_PACKAGE`, `codexQueueDeps(look)` (Task 5).
- Produces: `DevicesDeps.storePackageFolder?: (name: string) => Promise<string | null>` (tests only; default
  `storePackageFolder`).

- [ ] **Step 1: Write the failing tests** in `devices.spec.ts`; the two `it.each(['off macOS', …])('%s there is no
  source')` cases are replaced, not kept (their `HARNESS_DEVICE_OBSERVED` off row stays):
  - Claude: on `win32` the source is built and its two root chains are watched (paths from `claudeStoreRoots('win32',
    …)` for the suite's home); on `linux` its one; a store row's tap on `linux` runs the Claude adapter's link (the
    recorded run of `xdg-open` once `xdg-mime` named an app), on `win32` the Windows raise's `link`;
  - ChatGPT installed, at each attach: `linux` with `HARNESS_APPLICATIONS_DIR` at a temp folder holding
    `chatgpt/ChatGPT` as a file starts the source; missing, or a folder in its place, does not; `win32` with the seam
    holding `OpenAI.Codex\app\ChatGPT.exe` starts it and asks no package; `win32` without the seam: the fake
    `storePackageFolder` answering a folder starts it, answering null does not, and a second attach within 10 minutes
    (fake `performance`) asks nothing more (one query for two attaches), a third after 10 minutes asks again;
  - the macOS cases (`/Applications`, then `~/Applications`, the seam) pass unchanged;
  - `threadNamed` through a `thread` report: the existing "with the ChatGPT app settled in front a report follows its
    thread at once" case runs on `win32` (front `ChatGPT.exe`) and on `linux` (front `ChatGPT`), each ending in
    `[device] thread · moved` and the dial's focus.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: the new cases FAIL (no source
  off macOS).
- [ ] **Step 3: Implement.** Both sources are built when `observed` is on, whatever the platform; the Claude source's
  roots are `claudeStoreRoots(apps.platform, process.env, homedir())` and its store reads `roots.map(({ root }) =>
  root)`; `chatGptApps` becomes `chatGptPlaces(apps.platform, process.env.HARNESS_APPLICATIONS_DIR, homedir())`;
  `chatGptInstalled` is: `darwin` the bundle-id check as today; `linux` the first place that is a file (`statSync`,
  any error false); `win32` the seam's place when there is one, else `(await chatGptPackage.ask()) !== null`, where
  `chatGptPackage = storePackageLook(APP_PACKAGE, deps.storePackageFolder)` is the one given to `codexQueueDeps`. The
  comments that say "on macOS alone" say where each runs now.
- [ ] **Step 4: Run** the spec, then `npm run typecheck` and `npm run test:core`. Expected: PASS, `devices.ts` at 100%.
- [ ] **Step 5: Commit** red, then `feat(cli): the Claude and ChatGPT apps' sessions on the dial on Windows and Linux`.

### Task 8: End to end on Linux (and macOS, unchanged)

**Files:** Modify `E2E/deviceClaudeAppSessions.e2e.ts`, `E2E/deviceCodexAppThreads.e2e.ts`, `E2E/dialChatgptFollow.e2e.ts`,
`E2E/harness/daemon.ts`, `E2E/harness/outsideAgent.ts`; create `E2E/harness/schemeApps.ts`.

Test tooling: one commit. Its evidence in phase 3 is the three files passing on this Mac and in a Linux container on
the Podman machine, every case run (Step 5); Task 1's `cli-e2e-linux` job runs them again in phase 4.

**Interfaces:**
- Consumes: `claudeStoreRoots`, `chatGptPlaces` (Task 2).
- Produces: `IsolatedDaemon.binDir` (getter: the daemon's own `bin`, first on its PATH);
  `writeSchemeApps(d: IsolatedDaemon, apps: Record<string, string>): void` (`schemeApps.ts`) — writes a fake `xdg-mime`
  into `d.binDir` that prints the named `.desktop` for `query default x-scheme-handler/<scheme>` and nothing else;
  `FAKE_APPS['claude-app'] = { bundle: 'Claude', id: 'com.anthropic.claudefordesktop', exe: 'claude-desktop' }`.

- [ ] **Step 1:** Each file's `describe.skipIf(process.platform !== 'darwin')` becomes `skipIf(process.platform ===
  'win32')`. The store, the Codex home and the app come from the helpers: the Claude root is
  `claudeStoreRoots(process.platform, d.env, d.env.HOME!)[0].root`; the ChatGPT app on Linux is a file at
  `chatGptPlaces('linux', d.env.HARNESS_APPLICATIONS_DIR, d.env.HOME!)[0]`, on macOS the home's fake `Info.plist` as
  today. Each checks its paths are inside `d.root` before the start, as today.
- [ ] **Step 2:** On Linux, before the start, `writeSchemeApps(d, { claude: 'com.anthropic.Claude.desktop', codex:
  'chatgpt.desktop' })`. A tap's expected open is `[url]` on Linux (the fake `open` in `xdg-open`'s place) and
  `['-b', bundle, url]` on macOS.
- [ ] **Step 3:** The Claude file's second case on Linux starts its fake Claude Code under the fake app
  `'claude-app'` (`Outside.start(d, 'e2e-live', { CLAUDE_CODE_HOST_SESSION_ID: LIVE }, 'claude-app')`), so the scan's
  parents name the Claude app (`claudeApp.ts` `paneOf`'s Linux rule); on macOS its hints stay as today.
- [ ] **Step 4:** `dialChatgptFollow.e2e.ts` writes `{"front":"ChatGPT"}` on Linux and `{"front":"com.openai.codex"}`
  on macOS.
- [ ] **Step 5: Run** on this Mac: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceClaudeAppSessions.e2e.ts
  e2e/deviceCodexAppThreads.e2e.ts e2e/dialChatgptFollow.e2e.ts`. Expected: PASS. Then on Linux, on the Podman
  machine `devcrew-appsessions` (`podman machine start devcrew-appsessions`; `podman machine ssh devcrew-appsessions
  sudo sysctl -w fs.inotify.max_user_instances=1024 fs.inotify.max_user_watches=524288`): a throwaway
  `node:24-bookworm` container (`--rm`, no host home, no host display), the repository mounted read-only at `/src`
  and `cli/`, `store/` and `plugins/` copied into the container's `/work` (no host `node_modules`); there `apt-get
  install -y tmux zsh tcsh dash lsof`, the `compaudit` fix as `cli-e2e.yml` runs it, `npm ci --no-audit --no-fund`,
  then with `LANG=C.UTF-8 SHELL=/bin/zsh E2E_BUNDLE=1` the same `vitest run` plus `--reporter=json
  --outputFile.json=/work/result.json`. Expected: `numTotalTests > 0` and `numPassedTests === numTotalTests` (a
  skipped file would pass otherwise). No push: the temporary workflow's run is phase 4's.
- [ ] **Step 6: Commit** `test(cli): the app sessions' and the ChatGPT follow's end-to-end files run on Linux`.

### Task 9: End to end on Windows

**Files:** Create `E2E/dialWindowsAppSessions.e2e.ts`; modify `E2E/harness/windowsDaemon.ts`,
`cli/vitest.e2e.windows.config.ts`.

Test tooling: one commit. Its evidence is the VM run in phase 4 (Verification 4), as dial-windows's test user
`hxdialwin` in that user's console session, where the Claude app (winget, Squirrel) and the ChatGPT app (Store) are
installed and register `claude://` and `codex://`. The daemon is sealed as today: the fixture stores sit in its
throwaway profile, and the apps run as `hxdialwin` on its desktop (Decided here, "How the Windows end-to-end tap reaches
the apps").

**Interfaces:**
- Consumes: `claudeStoreRoots`, `chatGptPlaces` (Task 2); `claudeAppFixture`, `codexAppFixture` (`cli/src/testing/`).
- Produces: a sealed Windows daemon's env gains `HARNESS_APPLICATIONS_DIR: <root>\Applications` (so no sealed daemon
  asks Windows for the account's own ChatGPT package; missing until a test writes its own), and `prepare` receives
  `{ auth, profile, applications }`.

- [ ] **Step 1:** `describe.runIf(process.platform === 'win32')`, `startWindowsDaemon({ capabilities: { appFilter: 'v1' },
  prepare })`. `prepare` writes, inside the sealed profile: Claude fixtures in both `claudeStoreRoots('win32',
  {LOCALAPPDATA, APPDATA of the profile}, profile)` roots (one session only in the MSIX root, one only in `%APPDATA%`,
  and one `local_<uuid>` in both with two titles); the Codex fixture of `deviceCodexAppThreads.e2e.ts` in
  `<profile>\.codex`; and the file `<applications>\OpenAI.Codex\app\ChatGPT.exe`.
- [ ] **Step 2:** Cases, each with `onTestFailed` printing the log tail:
  - the Claude page lists the three sessions, idle, the shared one once with the MSIX root's title; archiving one in
    the fixture removes its row;
  - the ChatGPT page lists the fixture's threads in the sidebar's order; archiving one removes its row;
  - a tap on a Claude row, then on a ChatGPT row. Before each, the case fails with a named message ("close the Claude
    app in this session first") when that app's program (`claude.exe`, `ChatGPT.exe`) already runs as this user, since
    a running app takes the link in its first process and the check would not see it. After the tap, within 20 s, one
    of:
    - **opened**: a new process of that program whose command line holds the dial's link for that row
      (`claude.exe` with `claude://code/continue?session=<the row's local id>`; `ChatGPT.exe --single-argument
      codex://threads/<the row's id>`), read with `powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process
      -Filter \"Name='claude.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json"` from `System32` (the test's
      own read-only call, not the daemon's); a process of it holding another row's link fails the case. Then, within
      30 s, that process's `MainWindowHandle` (`Get-Process -Id <pid>`) is not 0: its window came. The case prints
      `tap: <program> · the row's link · window shown`, then ends only the processes it found (`taskkill /pid <pid> /t
      /f`) and waits for them to exit, so nothing of the app holds a file of the root when `close` removes it;
    - **fallback**: the opener's `[device] open · claude|codex · fallback` line (`open-link` refused: no handler); the
      case prints `tap: fallback · no handler`.

    Neither is a failure. Which one passes the check is the Verification's call (4), not the case's: `hxdialwin` has
    both handlers, so there it must be **opened**.
  - the watch: `spawn(process.execPath, [E2E_BUNDLE_PATH, 'hardware', 'watch', '--json'], { env: d.env, stdio:
    ['pipe', 'ignore', 'ignore'] })`, `{"front":"ChatGPT.exe"}`, then `{"thread":"Fixture Named"}` → `[device] thread ·
    moved` and the dial's focus on that row; a name two threads share → `skipped · ambiguous`;
  - the whole log holds no title, folder, session id or thread id of the fixtures.
- [ ] **Step 3:** `vitest.e2e.windows.config.ts`'s `include` gains `e2e/dialWindowsAppSessions.e2e.ts`.
- [ ] **Step 4: Run** on this Mac: `cd cli && npm run typecheck`, then `npx vitest run --config
  vitest.e2e.windows.config.ts`. Expected: typecheck clean; both Windows files found and skipped. The VM run, every
  case run, is phase 4's (Verification 4).
- [ ] **Step 5: Commit** `test(cli): the app sessions and the ChatGPT follow end to end on Windows`.

### Task 10: Harness Device: the doors' module map

**Files:** Modify `ST/src/lib.rs`, `ST/Cargo.toml`; create `ST/src/follow_windows.rs`, `ST/src/follow_x11.rs`,
`ST/src/follow_sway.rs`, `ST/src/follow_hyprland.rs`, each one `//!` doc paragraph saying what the door reads.

No behavior: one commit, so Tasks 13 to 16 never meet in `lib.rs` or `Cargo.toml`.

- [ ] **Step 1:** `lib.rs`: `#[cfg(any(windows, test))] pub mod follow_windows;`, `#[cfg(target_os = "linux")] pub mod
  follow_x11;`, `#[cfg(any(target_os = "linux", all(test, unix)))] pub mod follow_sway;` and the same for
  `follow_hyprland`, beside the `front_*` lines. `Cargo.toml`: `windows-sys` gains the feature
  `Win32_Storage_Packaging_Appx` (`GetPackagesByPackageFamily`); `Cargo.lock` does not change.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked --lib`. Expected: PASS, as before.
- [ ] **Step 3: Commit** `chore(device-app): the ChatGPT follow's doors for Windows, X11, sway and Hyprland, declared`.

### Task 11: Harness Device: the follow rules off macOS

**Files:** Modify `ST/src/follow.rs`, `ST/src/runner.rs`.

**Interfaces:** Produces, in `follow.rs`:
- `pub const CHATGPT_EXE: &str = "ChatGPT.exe"`, `pub const CHATGPT_LINUX: &str = "ChatGPT"`, `pub const
  CHATGPT_PROGRAM: &str = "/usr/lib/chatgpt/ChatGPT"`.
- `pub fn is_chatgpt_front(value: &str) -> bool` — `CHATGPT_BUNDLE`, `ChatGPT.exe` without case, or exactly `ChatGPT`.
- `pub fn program_installed(program: &Path) -> bool` — a regular file.
- `pub fn runs_program(proc_root: &Path, pid: u32, program: &Path) -> bool` — `read_link(<proc_root>/<pid>/exe) ==
  program`.
- `pub struct FollowSwitch` with `pub fn new(on: bool) -> Arc<FollowSwitch>`, `pub fn on(&self) -> bool`, `pub fn
  set(&self, on: bool)` (calls the listener `start` gave, when the value changed), `pub fn start(&self, changed:
  Box<dyn Fn() + Send + Sync>)` — what every door off macOS answers `AxTrust` with.
- `AxTrust` gains `fn switch(&self, _on: bool) {}` (a default: `MacFollow` and `NoFollow` keep theirs unchanged).

- [ ] **Step 1: Write the failing tests:** `ChatgptFollow::front("ChatGPT.exe")`, `("chatgpt.EXE")` and `("ChatGPT")`
  observe as `com.openai.codex` does (and give the offer cue as it does), `("chatgpt")` and `("ChatGPT.app")` do not;
  `program_installed` true for a file, false for a folder, a missing path; `runs_program` against a temp proc root
  whose `<pid>/exe` links to the program, another program, or nothing; `FollowSwitch` starts as given, `set` calls the
  listener once a change and never for the same value; a runner case: a front value `ChatGPT.exe` reads the door's
  `trusted()` before the rules judge it, as `com.openai.codex` does today (`front_changed`).
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked --lib follow runner`. Expected: FAIL.
- [ ] **Step 3: Implement**; `ChatgptFollow::front` and `Shared::front_changed` call `is_chatgpt_front`.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** red, then `feat(device-app): ChatGPT in front on Windows and Linux, and the switch that stands for Accessibility there`.

### Task 12: Harness Device: the switch and the menu off macOS

**Files:** Modify `ST/src/types.rs`, `ST/src/model.rs`, `ST/src/app.rs`, `ST/src/state.rs`, `ST/src/runner.rs`,
`ST/src/main.rs`.

**Interfaces:**
- Consumes: `AxTrust::switch` (Task 11).
- Produces: `Saved.follow_off: bool` (`#[serde(default)]`, key `followOff`); `FollowState.switch: bool`;
  `MenuAction::FollowSwitch`; `Effect::FollowSwitch(bool)`; `App::new(saved, cli_found, desktop_installed, now,
  install_exits_app, follow_switch: bool)`.

- [ ] **Step 1: Write the failing tests:**
  - `model.rs`: with `follow.switch`, the item is `Check(FollowSwitch, "Follow ChatGPT", trusted)` at the same place,
    shown only when installed and the dial is attached; `due()` never answers `Screen::Follow` with `switch` set,
    whatever `waiting`, `installed` and `trusted` are; without `switch`, every existing case unchanged;
  - `app.rs`: with `follow_switch`, a click on `FollowSwitch` saves `follow_off` flipped and gives
    `Effect::FollowSwitch(on)`, `on` being the new switch (`!follow_off` after the click), and opens no screen and no
    settings; `Event::FollowOffer` shows nothing and
    saves nothing; `Event::Follow { trusted, .. }` logs `chatgpt: follow on|off` and redraws the item as today; macOS
    (`follow_switch` false) unchanged;
  - `state.rs`: a file without `followOff` reads `follow_off: false` and keeps `askedSignIn`, `askedFollow`,
    `askedAx`; `followOff: true` reads back;
  - `runner.rs` (Review Focus 5): with a fake door whose `switch` sets its `trusted`, ChatGPT in front, a watch and the
    dial attached, `Effect::FollowSwitch(false)` stops the observation at once (the fake's observation box is dropped
    and a title it hears after writes no line); `FollowSwitch(true)` starts a new one, whose first title is written
    even when it equals the last.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked --lib model app state runner`. Expected: FAIL.
- [ ] **Step 3: Implement.** `App::new` sets `state.follow.switch = follow_switch`; the runner runs
  `Effect::FollowSwitch(on)` as `doors.follow.switch(on)`, then tells the rules `trusted(doors.follow.trusted())`;
  `main.rs` passes `!cfg!(target_os = "macos")`. `model.rs` and `app.rs` stay free of `cfg` (`parity.rs` holds it).
- [ ] **Step 4: Run** the same, then `cargo test --locked --lib`. Expected: PASS.
- [ ] **Step 5: Commit** red, then `feat(device-app): Follow ChatGPT is Harness's own switch off macOS, saved, and never a screen there`.

### Task 13: `WindowsFollow`

**Files:** Modify `ST/src/follow_windows.rs`. `ST/src/front_windows.rs` is not edited: its `app()` gives only the
file name, and splitting it would be more than a visibility change, so the door reads the image path itself
(`OpenProcess` + `QueryFullProcessImageNameW`, as `app()` does).

**Test that fails first:** the pure cases of `follow_windows.rs`, red then green on this Mac. The `#[cfg(windows)]` FFI
glue and its Windows-only tests are written here and cannot be compiled on the Mac (`cargo check --target
x86_64-pc-windows-msvc` stops in `ring`'s build script without MSVC's C headers, tried 2026-11-20); their compile and
their live test run in phase 4, on Task 1's `device-app-windows` jobs (x64, arm64) and on the VM, by the testers
(Verification 2 and 4). A failure there comes back as a phase 4 fix.

**Interfaces:**
- Consumes: `FollowSwitch`, `Heard`, `ChatgptWindow`, `AxTrust` (Task 11).
- Produces: `pub struct WindowsFollow`, `pub fn new(switch: Arc<FollowSwitch>) -> WindowsFollow`; pure, on every OS:
  `pub fn is_chatgpt_image(path: &str) -> bool` (the hook's `CHATGPT_APP` rule, without case),
  `pub fn family_found(status: u32, count: u32) -> bool`, and `pub fn reads_title(event: u32, hwnd: usize,
  id_object: i32, id_child: i32, foreground: usize) -> bool` with `EVENT_SYSTEM_FOREGROUND = 0x0003`,
  `EVENT_OBJECT_NAMECHANGE = 0x800C`, `OBJID_WINDOW = 0`, `CHILDID_SELF = 0` as local constants.

- [ ] **Step 1: Write the failing tests** (pure, on the Mac): `is_chatgpt_image` true for
  `C:\Program Files\WindowsApps\OpenAI.Codex_26.1117.3838.0_arm64__2p2nqsd0c76g0\app\ChatGPT.exe` in any case, false for
  `OpenAI.CodexBeta_…`, for `…\app\Codex.exe`, for a `ChatGPT.exe` elsewhere; `family_found` true only for
  `ERROR_INSUFFICIENT_BUFFER` (122) with `count > 0`, false for success with 0 and any other status; `reads_title`
  true for a foreground event, and for a name change only with `hwnd == foreground`, `OBJID_WINDOW` and
  `CHILDID_SELF`; false for another `hwnd`, another `idObject` (a caret, a menu), another child. These alone are the red
  commit.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked --lib follow_windows` on the Mac. Expected: FAIL
  (the pure functions are not there). No push.
- [ ] **Step 3: Implement.** `observe(heard)` spawns the observer's thread: `GetForegroundWindow`, its pid, its image
  path (the door's own read); not ChatGPT's (`is_chatgpt_image`) → `Title(None)` and the thread waits for `WM_QUIT`;
  ChatGPT's → `SetWinEventHook` for `EVENT_SYSTEM_FOREGROUND` and for `EVENT_OBJECT_NAMECHANGE`, `WINEVENT_OUTOFCONTEXT`,
  `idProcess` that pid, a thread-local callback as `front_windows.rs` has, a hook that fails → `NoObserver`; the title
  read is `GetWindowTextLengthW` + `GetWindowTextW` of the foreground window at start and at each event
  `reads_title` takes; the box's `Drop` posts `WM_QUIT` to the thread (`PostThreadMessageW`) and unhooks there. A panic
  in the callback ends the loop, as `front_windows.rs` does. `installed()` is `GetPackagesByPackageFamily(
  "OpenAI.Codex_2p2nqsd0c76g0")` read through `family_found`. `AxTrust` delegates to the switch. One more test,
  `#[ignore]`, `follow_windows_live`: the test makes its own window, brings it to the front (skips with a stderr line
  when Windows refuses the foreground, as `pty/tests/raise.rs` skips), observes with the ChatGPT check pointed at its
  own pid (an inner `observe_with(check: impl Fn(u32) -> bool + Send + 'static, heard)` that `observe` calls with
  the image rule), retitles the window twice with `SetWindowTextW`, and hears each title once, in order. Beside it,
  `#[cfg(windows)]` tests that run on a runner: an observation started with no ChatGPT window in front hears
  `Title(None)` once, and dropping its box ends its thread within 1 s (`WM_QUIT`); `installed()` answers without
  panicking on a runner with no ChatGPT package. These and the glue go in the second commit: none of them can run before
  phase 4.
- [ ] **Step 4: Run** on the Mac `cargo test --locked --lib follow_windows`, then `cargo test --locked --lib`.
  Expected: PASS (the glue is compiled out here). The report says the Windows glue and its tests are written and not
  yet compiled, for phase 4.
- [ ] **Step 5: Commit** red, then `feat(device-app): the ChatGPT window's title on Windows`.

### Task 14: `X11Follow`

**Files:** Modify `ST/src/follow_x11.rs`; `ST/src/front_x11.rs` only to make `property32` `pub(crate)`.

**Interfaces:**
- Consumes: `FollowSwitch`, `runs_program`, `CHATGPT_PROGRAM`, `program_installed` (Task 11).
- Produces: `pub struct X11Follow`, `pub fn new(display: String, switch: Arc<FollowSwitch>) -> X11Follow`; pure:
  `pub struct ActiveMask` with `pub fn moved(&mut self, active: Option<u32>) -> (Option<u32>, Option<u32>)` (the
  window to unselect and the one to select); `pub fn reads(atom: u32, has_net_name: bool, net_name: u32, wm_name: u32)
  -> bool`; `pub fn title(net_name: Option<&[u8]>, wm_name: Option<(WmNameType, &[u8])>) -> Option<String>`.

- [ ] **Step 1: Write the failing tests:** the mask moves: none → A selects A; A → B unselects A and selects B; B → none
  unselects B; B → B moves nothing. `reads`: `_NET_WM_NAME` always; `WM_NAME` only when the window has no
  `_NET_WM_NAME`; any other atom never. `title`: `_NET_WM_NAME` UTF-8 first; else `WM_NAME` `UTF8_STRING` as UTF-8,
  `STRING` as Latin-1 (`0xE9` → `é`), any other type none; invalid UTF-8 in `_NET_WM_NAME` is none.
- [ ] **Step 2: Run** in the Podman container `cargo test --locked --lib follow_x11`. Expected: FAIL.
- [ ] **Step 3: Implement.** Its own `x11rb` connection: `PropertyChangeMask` on the root (`_NET_ACTIVE_WINDOW`) and on
  the active window as `ActiveMask` says; at start and at each active change, the active window's `_NET_WM_PID` checked
  with `runs_program("/proc", pid, CHATGPT_PROGRAM)` (through `observe_with(check, heard)`), then its title, or
  `Title(None)`; at each `PropertyNotify` that `reads` takes for the active window, the title again. The box's `Drop`
  shuts the connection's socket down (`shutdown(2)` on its fd), which wakes `wait_for_event`; a connect that fails is
  `NoObserver`. `installed()` is `program_installed(CHATGPT_PROGRAM)`. One `#[ignore]` test, `follow_x11_live`: under
  `DISPLAY`, the test makes a window with `_NET_WM_PID` its own pid, sets the root's `_NET_ACTIVE_WINDOW` itself (it is
  its own window manager), observes with the check pointed at its own pid, changes `_NET_WM_NAME` twice, then deletes
  it and sets `WM_NAME`, and hears the three titles in order.
- [ ] **Step 4: Run** the container's `cargo test --locked --lib follow_x11`, and the live test under Xvfb
  (Verification 5). Expected: PASS.
- [ ] **Step 5: Commit** red, then `feat(device-app): the ChatGPT window's title on X11`.

### Task 15: `SwayFollow`

**Files:** Modify `ST/src/follow_sway.rs`; `ST/src/front_sway.rs` only to make `pid` `pub(crate)` (if the
focused-node walk behind `focused_pid` is not a function of its own, the door walks the tree itself rather than split
it).

**Interfaces:**
- Consumes: Task 11's checks; `front_sway::{message, read_message}`.
- Produces: `pub struct SwayFollow`, `pub fn new(switch: Arc<FollowSwitch>) -> SwayFollow`; pure: `pub fn
  focused_title(tree: &[u8], chatgpt: &dyn Fn(u32) -> bool) -> Option<String>` and `pub fn heard(kind: u32, event:
  &[u8], chatgpt: &dyn Fn(u32) -> bool) -> Option<Option<String>>` (None: nothing heard; `Some(title)`: say it).

- [ ] **Step 1: Write the failing tests** against a fake sway on a `UnixStream` pair, as `front_sway.rs`'s tests do:
  the subscribe is `["window"]`; the first title is the tree's focused node's `name` when its pid passes, else none; a
  `focus` or `title` event of a focused container whose pid passes says its `name`; of a focused container of another
  pid says the empty title; a `title` event of an unfocused container (a ChatGPT window behind) says nothing; `close`,
  `move` and workspace events say nothing; a payload over `PAYLOAD_MAX` or another magic ends the observation.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked --lib follow_sway`. Expected: FAIL.
- [ ] **Step 3: Implement** on its own connection to `$SWAYSOCK` (none, or a refused subscribe: `NoObserver`); the
  pid check is `runs_program("/proc", pid, CHATGPT_PROGRAM)` through `observe_with(check, heard)`; `installed()` is
  `program_installed(CHATGPT_PROGRAM)`; `AxTrust` delegates to the switch; the box's `Drop` shuts the stream down. One `#[ignore]` test, `follow_sway_live`: under a running sway (`SWAYSOCK` set),
  it starts `foot` with a title, checks for `foot`'s pid, retitles it twice by OSC 2, and hears each title in order.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** red, then `feat(device-app): the ChatGPT window's title on sway`.

### Task 16: `HyprlandFollow`

**Files:** Modify `ST/src/follow_hyprland.rs`; `ST/src/front_hyprland.rs` only to make `ask` and `next_line`
`pub(crate)`.

**Interfaces:**
- Consumes: Task 11's checks; `front_hyprland::{sockets, active_window, active_pid}`.
- Produces: `pub struct HyprlandFollow`, `pub fn new(switch: Arc<FollowSwitch>) -> HyprlandFollow`; pure: `pub enum
  HyprEvent { Active(Option<String>), Title(String), Other }` with `pub fn hypr_event(line: &str) -> HyprEvent`, and
  `pub fn active_title(answer: &[u8]) -> Option<String>`.

- [ ] **Step 1: Write the failing tests** against fake event lines and answers, as `front_hyprland.rs`'s tests do:
  `activewindowv2>>ADDR` asks `j/activewindow` and says its `title` when its `pid` passes, else the empty title;
  `activewindowv2>>` (no window) says the empty title and asks nothing; `windowtitle>>ADDR` and
  `windowtitlev2>>ADDR,anything` ask again only when `ADDR` is the active address; a title event of another address
  asks nothing; the same title asked twice is said by the rules once (their own repeat rule); a line over `LINE_MAX`
  is skipped; an answer over `ANSWER_MAX` is no title.
- [ ] **Step 2: Run** `cargo test --locked --lib follow_hyprland`. Expected: FAIL.
- [ ] **Step 3: Implement** on its own `.socket2.sock` connection (no signature or socket: `NoObserver`); the first
  title is one `j/activewindow` ask; the pid check is `runs_program("/proc", pid, CHATGPT_PROGRAM)`; `installed()` is
  `program_installed(CHATGPT_PROGRAM)`; `AxTrust` delegates to the switch; the box's `Drop` shuts the event stream
  down.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** red, then `feat(device-app): the ChatGPT window's title on Hyprland`.

### Task 17: `follow::system` picks the door

**Files:** Modify `ST/src/follow.rs`, `ST/src/main.rs`.

**Interfaces:**
- Consumes: `WindowsFollow`, `X11Follow`, `SwayFollow`, `HyprlandFollow` (13 to 16); `front::linux_front`.
- Produces: `pub enum DoorKind { Mac, Windows, X11(String), Sway, Hyprland, None }`, `pub fn door_kind(os: &str,
  linux: Option<LinuxFront>) -> DoorKind`, and `pub fn system(home: PathBuf, switch_on: bool) -> Arc<dyn FollowDoor>`.

- [ ] **Step 1: Write the failing test:** `door_kind("macos", None)` is `Mac`, `("windows", None)` `Windows`, `("linux",
  Some(X11(":1")))` `X11(":1")`, `Sway`, `Hyprland`, and `("linux", Some(LinuxFront::None))` `None`, in `front.rs`'s
  order (the same `linux_front` answer picks both the front source and the door).
- [ ] **Step 2: Run** `cargo test --locked --lib follow::`. Expected: FAIL.
- [ ] **Step 3: Implement**; `main.rs` calls `follow::system(paths.home_dir()?, !saved.follow_off)`. The macOS arm is
  `MacFollow::new(home)` as today.
- [ ] **Step 4: Run** `cargo test --locked --lib` on the Mac. Expected: PASS. The Windows arm compiles in phase 4
  with Task 13's glue (Verification 2).
- [ ] **Step 5: Commit** red, then `feat(device-app): each desktop's ChatGPT door, chosen as its front source is`.

### Task 18: Docs: the CLI

**Files:** Modify `cli/AGENTS.md`, `docs/specs/2026-11-15-device-host-adapter.md`.

One commit, no red test.

- [ ] **Step 1:** `cli/AGENTS.md`'s devices row: the Claude app's store "on macOS, Windows and Linux", with each OS's
  roots (the MSIX private copy first, then `%APPDATA%\Claude`; `$XDG_CONFIG_HOME/Claude`, else `~/.config/Claude`),
  each watched from its nearest folder; the ChatGPT app's threads on all three, installed as `ChatGPT.app`, the Store's
  `OpenAI.Codex` (one answer shared with `codex queue`, asked again after 10 minutes) or `/usr/lib/chatgpt/ChatGPT`;
  the thread follow on Windows (the pipe) and Linux (the socket).
- [ ] **Step 2:** The host adapter spec: the `claude` row's "macOS only" becomes the three OSes' openers; the two
  listing sources' lines name Windows and Linux.
- [ ] **Step 3: Commit** `docs: the app sessions and the ChatGPT follow on Windows and Linux, in the CLI's docs`.

### Task 19: Docs: Harness Device and the design

**Files:** Modify `device-app/AGENTS.md`, `docs/plans/2026-11-19-device-app-win-linux-design.md`,
`desktop/design/desktop-design-system.md`.

One commit, no red test. The gallery (`device-app/ui/src/gallery.ts`) shows the window's screens, not the native menu,
and the Follow screen does not change: it is not edited.

- [ ] **Step 1:** `device-app/AGENTS.md`: Follow ChatGPT is offered on Windows, X11, sway and Hyprland too; "The ChatGPT
  window's title is private as a tty" names the four doors; "What Accessibility reads" stays macOS's, and a line says
  what each door reads off macOS (the spec's table) and that off macOS the item is Harness's own saved switch.
- [ ] **Step 2:** The device-app-win-linux design's named-differences row "Follow ChatGPT (AX title)": Windows and X11 /
  sway / Hyprland follow by the native title; GNOME and KDE on Wayland do not.
- [ ] **Step 3:** `desktop-design-system.md`'s Harness Device section: off macOS, `Follow ChatGPT` is a plain on/off check
  item (the rule for an on/off setting), with no screen; the permission rule stays macOS's.
- [ ] **Step 4: Commit** `docs: Follow ChatGPT on Windows and Linux in Harness Device's docs and the design system`.

---

## Verification

Platforms the pull request names: Windows 10/11 (x64, arm64) and Linux (X11, sway, Hyprland; GNOME and KDE on Wayland
without the follow) gain the three behaviours; macOS unchanged. Nothing runs against production, a real account, or a
person's own apps or homes.

1. **Local gates, this Mac, on the final head** (the final tester; receipts into the pull request body before the push):
   - `cd cli && npm run typecheck && npx vitest run src/cable src/lib/windows src/services/devices.spec.ts
     src/architecture.spec.ts src/leanEntry.spec.ts`;
   - `npm run test:core` (`services/devices.ts` at 100%);
   - `python3 scripts/local-checks.py --run` from a clean tree at the final commit;
   - `git diff --stat <base> -- cli/src/core cli/src/architecture.coreFiles.txt` prints nothing;
   - the three end-to-end files on macOS, unchanged behaviour: `cd cli && npx vitest run --config vitest.e2e.config.ts
     e2e/deviceClaudeAppSessions.e2e.ts e2e/deviceCodexAppThreads.e2e.ts e2e/dialChatgptFollow.e2e.ts` (the suite's
     own throwaway homes, fake `open`, `HARNESS_APPLICATIONS_DIR`);
   - Harness Device on macOS (PR CI does not compile it): `cd device-app/src-tauri && cargo test --locked`.
2. **Temporary workflow** (Task 1; phase 4 only, each push asked of the PM first, as a heavy run): `cli-e2e-linux`
   runs the three files on `ubuntu-24.04` with every case run (a person reading the run sees each file's cases passed,
   none skipped); `device-app-windows` runs `cargo test --locked --lib` on `windows-latest` (x64) and `windows-11-arm`
   (arm64). That job is the first compile and run of Task 13's `#[cfg(windows)]` glue and its Windows tests: a compile
   error or a red case there is a phase 4 fix. The report carries the run link. PR CI never runs `cli/e2e`, so this
   carries the Linux end-to-end check (the PM, 2026-11-20); after the merge the nightly `cli-e2e.yml` shards run the
   three files with the rest.
3. **PR CI, once the pull request is ready** (phase 4, after the rebase): `cli-typecheck`, `cli-tests`,
   `device-app-checks` (Linux `cargo test` and the base's live X11 front source; Windows x64 `cargo test --lib`),
   `process-checks`. No extra run.
4. **Windows ARM64 VM `admin@192.168.64.5`** (phase 4, the testers). The main session asks the PM for the VM's turn,
   run only while dial-windows is not using it, and for dial-windows's `E2E_WORK` (the receipt that owns `hxdialwin`:
   `desktop-e2e.sh` refuses a user it holds no receipt for). Isolation:
   - **Who and where.** Everything that needs a desktop runs as dial-windows's test user `hxdialwin`, in that user's
     console session, where the Claude app (winget, Squirrel) and the ChatGPT app (Store) are installed, signed in to
     nothing, and register `claude://` and `codex://`. Never the admin user's desktop, profile, apps or sign-ins.
   - **The daemon** is sealed by `windowsDaemon.ts`: a throwaway root holds its profile (the escaped name), data, auth,
     every engine home and the fixture stores; a free port, signed out, a backend of `127.0.0.1:9`, a stand-in dial on
     a pipe of its own. It runs as `hxdialwin`, so `open-link` finds that user's handlers (Decided here).
   - **The apps** are only started by the taps and ended by the case; nothing in them is signed in to or changed.
   - **No user is added or removed:** no `user-add`, `user-del` or `cleanup`, since `hxdialwin` and its receipt are
     dial-windows's.

   Steps, with `E2E_WORK=<dial-windows's> E2E_USER=hxdialwin VM_HOST=192.168.64.5 VM_ADMIN=admin` and
   `D=desktop/scripts/windows-e2e/desktop-e2e.sh`:
   - `$D preflight`, then `$D session-on` (its screenshot shows `hxdialwin`'s desktop). With no console session, sign
     the user in as `docs/plans/2026-11-19-dial-windows-plan.md` "Signing the test user in" says, on the PM's go.
   - The tree: `VM_SSH=admin@192.168.64.5 VM_DIR=C:/work/oh-appsessions cli/scripts/windows-pty-e2e/vm-sync.sh --cli`
     (a folder of this run, never dial-windows's `C:/work/oh`). As admin over SSH: `icacls C:\work\oh-appsessions
     /grant "hxdialwin:(OI)(CI)M"`, the same for `C:\work\oh-appsessions-target`; `cd /d C:\work\oh-appsessions\pty &&
     cargo build --release --bins`; `npm ci` in `..\cli`; in `..\device-app\src-tauri`, with
     `CARGO_TARGET_DIR=C:\work\oh-appsessions-target`, `cargo test --locked --lib --no-run`, which prints the test
     executable (the arm64 compile of Task 13's glue). `where node` names the `node.exe` the run uses; one under the
     admin's profile, which `hxdialwin` cannot read, is a stop the report names.
   - Two run scripts, written on the VM beside `C:\work\oh-appsessions\cli\scripts\windows-dial-e2e\console.ps1` (not
     in the repository): `app-sessions-e2e.ps1` sets `E2E_BUNDLE=1` and `HARNESS_PTY_BIN=C:\work\oh-appsessions\pty\target\release\harness-pty.exe`,
     goes to `C:\work\oh-appsessions\cli` and runs `<node.exe> node_modules\vitest\vitest.mjs run --config
     vitest.e2e.windows.config.ts`; `follow-live.ps1` runs `<the test executable> --ignored follow_windows_live
     --nocapture`. Each exits with its program's code.
   - Before the run, as `hxdialwin`: `$D sh 'reg query HKCU\Software\Classes\claude /s'` and the same for `codex`, kept.
   - (1), (2) and (3)'s CLI side: `RUN_TIMEOUT=900 $D sh 'powershell -NoProfile -ExecutionPolicy Bypass -File
     C:\work\oh-appsessions\cli\scripts\windows-dial-e2e\console.ps1 -Script app-sessions-e2e.ps1 -TimeoutSec 900'`
     (SSH as `hxdialwin`; `console.ps1` runs the script as a one-shot `schtasks /it` task in that user's console
     session; exit 3 means no console session). What a person reading the output sees: `dialWindows.e2e.ts` and
     `dialWindowsAppSessions.e2e.ts` pass, every case run; the sessions and threads listed, an archive removing a row,
     the watch's `thread · moved`; and for the taps `tap: claude.exe · the row's link · window shown` and `tap:
     ChatGPT.exe · the row's link · window shown`: the app's process started with the dial's link for the right
     session or thread (`claude.exe` with `claude://code/continue?session=<local id>`, `ChatGPT.exe --single-argument
     codex://threads/<id>`), and its window came. The apps are not signed in, so they cannot show the session itself.
     `tap: fallback · no handler` passes only when the registry read shows that scheme has no handler (the app is
     missing); the evidence is then the opener's `[device] open · <adapter> · fallback` line and the unit tests that
     pin the link (Task 7's tap cases, `claudeApp`'s and `codexApp`'s link specs), and the report names the missing app.
   - After the run, the two `reg query` reads again: the same as before.
   - `WindowsFollow`: the same `console.ps1` call with `-Script follow-live.ps1`. Expected: `follow_windows_live ... ok`
     with two titles heard; a skip line (foreground refused) is a failed check to rerun, not a pass.
   - The benchmarks, as admin over SSH (no desktop needed): `node --import tsx scripts/benchmark-claude-app-store.ts
     <out>` and `node --import tsx scripts/benchmark-codex-app-threads.ts <out>` in `C:\work\oh-appsessions\cli`,
     numbers into the pull request ("before: none" off macOS).
   - At the end, as admin: the two run scripts, `C:\work\oh-appsessions` and `C:\work\oh-appsessions-target` removed.
     The tests' roots go with their `close`, and the app processes the taps started with the case.
   - Optional, the PM's call (heavy): **Actions → Windows → Run workflow** on the branch runs `vitest.e2e.windows.config.ts`
     on `windows-latest` and `windows-11-arm` too.
5. **Linux, the Podman machine `devcrew-appsessions`** (the repository mounted read-only into throwaway containers; no
   host home, no host display):
   - Harness Device: a `rust:1-bookworm` container with `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
     libxdo-dev xvfb sway foot`, `CARGO_TARGET_DIR` on a volume: `cargo test --locked --lib` (all Linux rules, the
     `follow_x11` cases among them); then `Xvfb -displayfd 3` on a free display and `DISPLAY=:<n> cargo test --locked
     --lib -- --ignored follow_x11_live --nocapture`; then a headless sway (`WLR_BACKENDS=headless
     WLR_LIBINPUT_NO_DEVICES=1 sway &`, its `SWAYSOCK` exported) and `cargo test --locked --lib -- --ignored
     follow_sway_live --nocapture`. Expected: each `... ok`. If headless sway does not start in the image, the report
     says so with sway's own error, and `SwayFollow` rests on its fixture cases (spec).
   - The benchmarks in a `node:24` container from `cli/` (`npm ci`, then both `node --import tsx scripts/benchmark-…`).
6. **A person, after release** (not a merge gate; needs the user themselves, with their own signed-in apps): on Windows
   (MSIX or Squirrel Claude, the Store's ChatGPT) and on Linux (the `.deb` Claude and ChatGPT), they check that the
   sessions and threads are listed, idle ones too; a tap opens each; opening a ChatGPT thread moves the dial (whether
   the window's title is the thread's name off macOS, decision 4); the switch stops it.
7. **Against production:** none.

## Open questions

None. The PM answered the three of the draft on 2026-11-20: the temporary workflow as planned (Task 1), the bounds
across the Claude roots (Global Constraints), and the Windows tap in `hxdialwin`'s console session (Task 9, Verification 4).
