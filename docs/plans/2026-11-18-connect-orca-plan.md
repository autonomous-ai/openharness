# Connect Orca from the Harness menu-bar app — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. No task pushes or merges.

**Goal:** The Harness menu-bar app offers `Connect Orca…` once, shows the access Orca lists for the Harness Device plugin, installs it only on the person's click, and keeps it current after each CLI update with no click.

**Architecture:**
- **The CLI carries the plugin.** The build puts `plugins/harness-device-orca`'s manifest and non-test sources in `cli.js` as `__ORCA_PLUGIN__`, version stamped by `extensionVersion()`.
- **The CLI does all of the work with Orca**, in the `harness` command's own process: `harness device orca status --json` and `harness device orca connect [--approve <fingerprint>] --json`. It writes the plugin's folder in the data folder, asks Orca's own CLI, and prints one JSON line.
- **The app stays thin.** It runs those two commands with fixed arguments, keeps Orca's fingerprint in Rust, and draws a third screen. The webview sends one new action name, `connect_orca`, and never a fingerprint.
- The core, the daemon's services and the devices process do not change.

**Tech Stack:** TypeScript (`cli/`, vitest, esbuild); Rust and Tauri 2 (`device-app/src-tauri`, `cargo test`); plain TypeScript in the app's webview (`device-app/ui`, vitest and jsdom); Python for the CI planner's test.

**Spec:** `docs/plans/2026-11-18-connect-orca-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md`, `device-app/AGENTS.md`, `docs/feature-design-rules.md`, and the Harness Device section of `desktop/design/desktop-design-system.md`.

**Open questions:** none. The PM answered both on 2026-11-18 (under "Decided").

## Base

- `feat/device-app-connect-orca` at `de566c7a55`, one commit behind `origin/main` (`365bcdcc97`, fetched 2026-11-18). The spec and this plan are untracked. The main session commits them; no task does.
- `cli/src/config/harnessHome.ts` is **not** on `origin/main` at `365bcdcc97`, and no `chore/harness-paths` branch is published (checked 2026-11-18). Task 6 checks again before it names the folder.
- Open pull requests on the same files were not read (`gh` gave no answer). `cli/src/cli.ts` and `cli/src/deviceClaude/command.ts` change often: keep each edit where its task says.
- The tasks name functions, never lines. If a name differs at the base, the implementer follows the code and says so in its report.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The plugin ships in `cli.js` | `cli/scripts/lib/orcaPluginBundle.mjs`, `cli/build.mjs`, `cli/build-bundle.mjs`, `cli/src/devices/orcaPluginBundle.spec.ts`, `scripts/ci-plan.py`, `scripts/tests/test_ci_plan.py`, `docs/validation-and-release.md` | none | high | `orcaPluginBundle.spec.ts`, `test_ci_plan.py` |
| 2 The record: `orcaConnected` | `cli/src/devices/dialSkillFiles.ts`, `dialSkillFiles.spec.ts` | none | high | `dialSkillFiles.spec.ts` |
| 3 The plugin's folder, swapped whole | `cli/src/devices/orcaPluginFolder.ts`, `orcaPluginFolder.spec.ts` | none | xhigh | `orcaPluginFolder.spec.ts` |
| 4 What the plugin is in Orca (`status`) | `cli/src/devices/orcaPlugin.ts`, `orcaPlugin.spec.ts`, `cli/src/testing/fakeOrcaCli.ts` | 2, 3 | xhigh | `orcaPlugin.spec.ts` |
| 5 `connect` | `cli/src/devices/orcaPlugin.ts`, `orcaPlugin.spec.ts` | 4 | xhigh | `orcaPlugin.spec.ts` |
| 6 The two words of `harness device orca` | `cli/src/deviceClaude/command.ts`, `command.spec.ts`, `cli/src/cli.ts`; `cli/src/config/harnessHome.ts` and its spec only if they are on the base | 1, 5 | xhigh | `command.spec.ts` |
| 7 End to end: the built CLI and a fake Orca | `cli/e2e/deviceOrcaConnect.e2e.ts` | 6 | high | none: no behavior (the end-to-end test of Tasks 1 to 6), one commit |
| 8 The app runs and reads the two commands | `device-app/src-tauri/src/orca_cli.rs`, `lib.rs`, `types.rs`, `cli.rs` | none | xhigh | `orca_cli.rs`, `cli.rs`, `types.rs` tests |
| 9 The Orca screen | `device-app/src-tauri/src/types.rs`, `app.rs`, `runner.rs`, `main.rs` | 8 | xhigh | `app.rs`, `types.rs`, `main.rs`, `runner.rs` tests |
| 10 The menu row, when `status` runs, one run at a time, the silent update | `device-app/src-tauri/src/types.rs`, `model.rs`, `app.rs`, `runner.rs` | 9 | xhigh | `app.rs`, `model.rs`, `runner.rs` tests |
| 11 The window's Orca screen, the gallery, the design doc | `device-app/ui/src/api.ts`, `screens.ts`, `screens.test.ts`, `styles.css`, `gallery.ts`, `gallery.test.ts`, `desktop/design/desktop-design-system.md` | none | high | `screens.test.ts`, `gallery.test.ts` |
| 12 Say it in the guides | `device-app/AGENTS.md`, `plugins/harness-device-orca/README.md` | none | medium | none: docs only, one commit |

Longest chain: five tasks (3 → 4 → 5 → 6 → 7, or 2 → 4 → 5 → 6 → 7). The app's chain is three (8 → 9 → 10).

- Tasks 1, 2, 3, 8, 11 and 12 share no file and start at once.
- Shared files, each pair ordered by a dependency above: `orcaPlugin.ts` and its spec (Tasks 4, 5); `types.rs` (Tasks 8, 9, 10); `app.rs` and `runner.rs` (Tasks 9, 10).
- Why the app's Rust is a chain and not a types task beside the others: `app.rs`, `runner.rs` and `main.rs` match `Event`, `Effect`, `Screen` and `MenuAction` with no wildcard, so a new variant compiles only with its arm. Each of Tasks 9 and 10 adds its words and the rules that use them together, and leaves no empty arm.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/scripts/lib/orcaPluginBundle.mjs`, `cli/build.mjs`, `cli/build-bundle.mjs` | The CLI's build | `orcaPluginBundle.spec.ts`, in PR CI's `cli-tests` |
| `cli/src/devices/orcaPlugin.ts`, `orcaPluginFolder.ts`, `dialSkillFiles.ts`, `cli/src/deviceClaude/command.ts`, `cli/src/cli.ts` | **The `harness` command's own process.** Never the core, a service or the devices process | Their specs, in `cli-tests`. No coverage gate covers these folders |
| `cli/e2e/deviceOrcaConnect.e2e.ts` | Test: the built `cli.js` and a fake `orca` | By hand; the CLI end to end workflow |
| `device-app/src-tauri/src/*.rs` | **The menu-bar app**, Rust | `cargo test` (PR CI on Linux; on this Mac by hand) |
| `device-app/ui/src/*` | The app's webview | `npm test`, `npm run typecheck` (PR CI) |
| `scripts/ci-plan.py`, the docs | Repo files, no process | `process-checks` |

`dialSkillFiles.ts` is also loaded by the devices process, which reads its other keys; it gains two functions that process never calls.

## Before starting

- This worktree has no `cli/node_modules` and no `device-app/ui/node_modules`: run `cd cli && npm ci` and `cd device-app/ui && npm ci` once.
- Tauri's dependencies take minutes to compile. Set one `CARGO_TARGET_DIR` outside the repository for every Rust task (`export CARGO_TARGET_DIR="$HOME/.cache/harness-device-target"`).
- `cargo test --locked --lib` needs no window bundle. `cargo test --locked` (which also runs `main.rs`'s tests, Task 9) embeds `ui/dist`: run `cd device-app/ui && npm run build` first.
- Every session runs inside Diego's Orca, and the real `orca` is on its `PATH`. See "Never" below.

## Global Constraints

**Never**
- The core does not change: no file under `cli/src/core/`, nothing `src/core/main.ts` imports, no line in `src/architecture.coreFiles.txt`. Nor do `cli/src/services/`, `cli/src/cable/` or `cli/src/devices/orcaHomes.ts` (the devices process's files; `orcaPlugin.ts` imports `orcaBinary` and `orcaHomesDeps` from the last, unchanged).
- No session runs a real `orca plugin install`, `update`, `enable`, `disable`, `uninstall` or `restart`, and none runs `harness device orca status` or `connect` from a build or from the sources on this Mac outside Task 7's isolation: they would ask Diego's Orca and write his data folder.
- CLI specs reach Orca only through a fake `orca` the test writes, handed in as `deps.orca()`: `PATH` is never searched. Task 7 puts the same fake in the end-to-end harness's own launcher. App tests reach the CLI only through `testing::Fake` (the fake `harness`).
- No path is built from the home folder. The plugin's folder comes from the data folder the command is handed (Task 6). The Rust app never names it.
- Nothing Orca lists is logged, by the CLI or the app: no grant, name or fingerprint. Orca's `message` is never printed (it can hold a path).

**What Orca prints** (read in Orca 1.4.262's own code on this Mac, 2026-11-18; the spec's list, with the fields' places)
- With `--json`, an answer and an error are each one pretty-printed JSON object on **stdout**: `{ "ok": true, "result": … }` or `{ "ok": false, "error": { "code", "message", "data" } }`. Exit 0; 3 for `approval_required` and `approval_stale`; 2 for `plugin_invalid`; 1 otherwise.
- `orca status --json`: `result.runtime.reachable`, `result.runtime.appVersion`.
- `orca plugin inspect <dir> --json`: `result.plugin.pluginKey` (`local.harness-device` today).
- `orca plugin list --json`: `result.plugins[]`, each with `pluginKey`, `version`, `status`, `needsReconsent`, `isDev`, `source.kind` (`local-path` for a folder) and `source.reference` (that folder).
- An approval's `error.data`: `name`, `version`, `approvalFingerprint`, `grants.executionDescription`, `grants.capabilities[].description`, `grants.replacements[]` (`command`, `action`), and more that is not read.
- `engines.orca` is `>=x.y.z`. Orca compares the three numbers; a prerelease of the same three ranks below.

**The CLI's two lines** (the contract between Tasks 4 to 7 and Task 8)
- `harness device orca status --json` prints `{"orca":"absent"}`, `offer`, `off`, `approve`, `behind` or `current`, and exits 0 for each.
- `harness device orca connect [--approve <fingerprint>] --json` prints one of:
  - `{"connect":"done"}`, exit 0;
  - `{"connect":"approve","name":…,"version":…,"fingerprint":…,"grants":[…],"update":true|false}`, exit 0;
  - `{"connect":"failed","error":"not-running"|"no-plugin"|"off"|"timeout"|"failed"}`, exit 1.
- A fingerprint is `^ap1-[0-9a-f]{32}$`, checked in the command's arguments, in Orca's answer, and again in Rust.
- A grant line: a string, in Orca's order: `executionDescription`, each capability's `description`, then each replacement as `Runs "<command>" instead of Orca's own <action>` (checked once composed). A string holding a control character (line breaks and tabs included) is `failed`; else it is trimmed and dropped when empty, and one longer than 300 characters is `failed`. More than 10 lines left is `failed`; none left is `failed`. Past a bound, nothing is cut: the whole answer is `{"connect":"failed","error":"failed"}` (exit 1), and nothing of it is passed on. Rust holds an `approve` line to the same bounds.
- Orca's answers are read up to 256 KiB (`maxBytes`); a longer one is not read. Deadlines: `orca status` 5 s, `inspect` 10 s, `list` 10 s, `install`, `update` and `enable` 60 s.

**The app** (the contract between Tasks 9, 10 and 11)
- It runs exactly `device orca status --json`, `device orca connect --json` and `device orca connect --approve <fingerprint> --json`. Deadlines 30 s and 120 s.
- The view the window reads: `{"screen":"orca","phase":"asking"|"approve"|"done"|"failed","lines":[…]}`, with `"update":true` added only for an update. No other screen's JSON changes.
- The window may send `"connect_orca"` beside the four it sends today. Cancel, Done and Close send `"cancel"`.
- Log lines: `orca: none|offer|update` on each change of the row, and `orca connect: done`, `orca connect: approve`, `orca connect: failed <code>`.
- Copy, exact: `Connect Orca…`, `Update Orca connection…` (menu); `Connect Orca`, `Update Orca connection`, `Asking Orca…`, `Orca will let Harness Device:`, `Orca connected.`, `Orca isn't running.`, `Couldn't connect Orca.`; buttons `Cancel`, `Connect`, `Update`, `Done`, `Close`.

**The screen, as drawn** (approved by the PM, 2026-11-18). 420 × 320, the window's own tokens.

| Phase | `lines` from Rust | The window draws | Buttons, in order |
|---|---|---|---|
| `asking` | `["Asking Orca…"]` | the heading; the spinner; `lines[0]`, muted, under it (as Install's step) | none |
| `approve` | the grants, 1 to 10 | the heading; `Orca will let Harness Device:`; the grants as a bulleted list that scrolls when it does not fit | `Cancel`, then `Connect` (`Update` for an update), accent |
| `done` | `[]` | the heading; `Orca connected.` | `Done`, accent |
| `failed` | one line of fixed copy | the heading; `lines[0]` in danger ink, `role="alert"` | `Close`, plain |

```text
┌──────────────────────────────────────────┐   ┌──────────────────────────────────────────┐
│ Connect Orca                             │   │ Connect Orca                             │
│                                          │   │ Orca will let Harness Device:            │
│   ◌                                      │   │ • Runs its own code in a separate        │
│   Asking Orca…                           │   │   Node.js process on the Orca host, …    │
│                                          │   │ • Read your projects and workspaces …    │
│                                          │   │                    ( Cancel ) ( Connect )│
└──────────────────────────────────────────┘   └──────────────────────────────────────────┘
┌──────────────────────────────────────────┐   ┌──────────────────────────────────────────┐
│ Connect Orca                             │   │ Connect Orca                             │
│ Orca connected.                          │   │ Orca isn't running.          (danger ink)│
│                                 ( Done ) │   │                                ( Close ) │
└──────────────────────────────────────────┘   └──────────────────────────────────────────┘
```

- The heading is `Connect Orca`, or `Update Orca connection` when `update` is true, in every phase.
- `asking` shows on open, and again from the Connect click until Orca answers, so the buttons are gone and a second click does nothing.
- No button has the focus in any phase of this screen.

**Platforms.** macOS and Linux for the CLI and the app. Windows: `status` is `absent` and nothing is run.

**Repo rules.** A failing test first, at the layer where the behavior lives. No fixed sleeps. Comments say why. No stub, dead code or TODO left behind.

## Review Focus

1. **The data folder reached through a link, or Orca recording the real path.** If `source.reference` and the folder differ only in spelling, the plugin reads `behind` for ever, and every status would bring `Update Orca connection…` back. Task 4 (`the entry names the folder through a link`).
2. **A CLI from before these commands.** The app ships after the CLI, but a person can hold an older CLI: it prints its usage and exits 1. That must be no row and no failure, at each check. Task 8 (`a CLI from before the command`), Task 10 (`a status nobody could read`).
3. **Two commands at once on the folder** (the app's `status` and a person's `connect`). One removes the other's `orca-plugin.new`. The loser must fail whole, and Orca must never be handed half a folder. Task 3 (`a swap whose second rename fails`).
4. **`dial-skill.json` there but not readable.** Reading it as "never connected" would offer the plugin again to a person who removed it. Task 4 (`a record that cannot be read`).
5. **An approval with nothing to show.** No `executionDescription`, or only empty and blank strings: the person would be asked to approve an empty list. Task 5 (`an approval with no grant left`), Task 8 (`an approve line with no grant`).

## Decided (Diego and the PM, 2026-11-18)

The spec's "Decided" 1 to 8, and the PM's eight for this plan, not reopened: the plugin ships in `cli.js` as the VS Code extension does; the CLI does all Orca work, routed in `command.ts`; the app runs the silent update and never approves on its own; the three checks, and no row when Orca is not reachable or too old; Cancel keeps the row; the folder is a new entry in the paths module when it is on the base, else `join(deps.dataDir, 'orca-plugin')`; the core and the devices process are untouched; tests use only fake `orca` and fake `harness` binaries.

The PM's answers to this plan's two questions (2026-11-18):
- **The Orca screen's four phases** are approved exactly as "The screen, as drawn" shows them.
- **Grants past the bounds are `failed`, never cut**, in the CLI and in Rust, as the grant-line rule in Global Constraints says, so a person never approves access the window did not show.

## Decided here, where the spec was silent (approved by the PM, 2026-11-18)

- **The status line's key is `orca`** (`{"orca":"offer"}`), beside `{"vscode":…}` and `{"connect":…}`.
- **The bundle's spec is `cli/src/devices/orcaPluginBundle.spec.ts`**, beside the VS Code one: vitest runs `src/**` only, so a spec under `cli/scripts/lib/` would never run.
- **`absent` for connect is two codes:** a CLI from the sources is `no-plugin`; every other `absent` is `not-running`, as the spec words it.
- **`absent` also covers** a folder that could not be written, a record that could not be read, and a list entry with no `version` or `status` string: each is "an answer that cannot be read".
- **The same folder is the same real path:** `source.reference` and the plugin's folder are compared after `realpath`, each as written when it does not resolve.
- **The command writes the record**, after every `done`, as it writes VS Code's mark. A save that fails prints `Could not save the dial setting.` on stderr; the line stays `done` and the exit 0, since Orca did connect.
- **`update` is whether Orca lists the plugin** (the states `approve` and `behind`), not `data.update`.
- **`name` and `version`** in the approve line are checked as a grant line is: past a bound, the answer is `failed`. The app reads neither.
- **Arguments.** `orca status` takes only `--json`; another word prints the usage and exits 1. `orca connect` takes only `--json` and one `--approve <fingerprint>`; anything else is the `failed` line. Neither word is in `DEVICE_USAGE`: they are the app's.
- **One `MenuAction::Orca`** serves both rows; only its label differs.
- **A replacement line** is the spec's `Runs "<command>" instead of Orca's own <action>`, without the bracketed hint Orca's own message adds.
- **The silent update** runs once after each `behind`, until the CLI is found again or its version changes. The first version the app reads is not a change.
- **Waiting runs start in this order:** the screen's `connect`, the silent update, a `status`.
- **Only the screen's `done` changes the row.** Its `approve` and `failed` answers leave the row as the last `status` set it.
- **PR CI's table** in `docs/validation-and-release.md` gains the plugin's folder beside the VS Code extension's.

---

### Task 1: The plugin ships in `cli.js`

**Layer:** the CLI's build and the CI planner. **Depends on:** none. **Effort:** `high`.

**Red tests:** `cli/src/devices/orcaPluginBundle.spec.ts`; `scripts/tests/test_ci_plan.py`.

**Files:**
- Create: `cli/scripts/lib/orcaPluginBundle.mjs`
- Modify: `cli/build.mjs`, `cli/build-bundle.mjs` (one import, and one `define` line after `__VSCODE_EXTENSION__`)
- Modify: `scripts/ci-plan.py` (one `ALSO.update` after the VS Code extension's), `scripts/tests/test_ci_plan.py`
- Modify: `docs/validation-and-release.md` (the PR CI table's `cli/` row)
- Test: `cli/src/devices/orcaPluginBundle.spec.ts`

**Interfaces:**
- Produces:
  ```js
  // cli/scripts/lib/orcaPluginBundle.mjs
  /** JSON of { [path relative to the plugin]: text }. */
  export function readOrcaPluginBundle(version) // string
  // both builds' `define`:
  __ORCA_PLUGIN__: JSON.stringify(readOrcaPluginBundle(version)),
  ```
  - Keys: `orca-plugin.json`, then every file under `src/` whose name does not end `.test.ts` or `.test.tsx`, as posix paths, sorted.
  - The manifest's text is `JSON.stringify({ ...manifest, version: extensionVersion(version) }, null, 2)` and a newline. `extensionVersion` is imported from `./vscodeExtensionBundle.mjs`, which does not change.

- [ ] **Step 1: Write the failing tests.**
  - `orcaPluginBundle.spec.ts`, importing the `.mjs` as `vscodeExtensionBundle.spec.ts` does:
    - `it carries the manifest and each source that is not a test, and nothing else`: the keys equal `orca-plugin.json` plus the non-test files the test lists from `src/` on disk; none ends `.test.ts` or `.test.tsx`, is `tsconfig.json` or `README.md`, or starts `.orca/`; the manifest's `main` and each panel's `entry` are among them.
    - `each source is the file's own text`.
    - `the manifest carries the build's version and is otherwise the file's`: `'1.2.3'` gives `version: '1.2.3'`, `id: 'harness-device'`, `engines: { orca: '>=1.4.248' }`; `'0.0.0-dev.0123456'` gives `'0.0.0-dev.g0123456'`.
    - `Orca's version pattern takes every label a build makes`: `0.6.66`, `0.6.66-dev.3e5b290ede`, `0.6.66-dev.0123456.dirty` and `0.0.0-dev.box-e2e`, stamped, each match Orca 1.4.262's semver pattern, quoted in the test.
    - `a build run from another folder is the same bytes` (a child Node in `tmpdir()`, as the VS Code spec).
    - `both builds inline it`: each of `build.mjs` and `build-bundle.mjs` matches `/__ORCA_PLUGIN__: JSON\.stringify\(readOrcaPluginBundle\(version\)\)/`.
  - `test_ci_plan.py`: replace the last assertion of `test_the_vscode_extension_belongs_to_the_cli_suite` with `test_the_orca_plugin_belongs_to_the_cli_suite`: for `plugins/harness-device-orca/src/dial.ts` and `plugins/harness-device-orca/orca-plugin.json`, `owners` and `select(...)[0]` are `{"cli"}`, `reads("cli", path)` is true and `shared_input(path)` is `None`; `plugins/harness-device-orca-x/a.ts` selects nothing.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/orcaPluginBundle.spec.ts` and `python3 -m unittest discover -s scripts/tests -p 'test_ci_plan.py'`. Expected: FAIL (the module is missing; the plugin selects no suite).
- [ ] **Step 3: Implement** the script, the two `define` lines, `ALSO.update({"plugins/harness-device-orca/": "cli"})` with a comment that the CLI's build inlines the folder, and the doc row (`plugins/harness-device-orca/` (the CLI's build carries it)).
- [ ] **Step 4: Run** the step 2 commands, then `cd cli && npx vitest run src/devices/vscodeExtensionBundle.spec.ts && node build.mjs`. Expected: PASS; the build ends `✓ Build completed successfully`.
- [ ] **Step 5: Commit** `CLI: Orca's plugin ships in cli.js`.

### Task 2: The record: `orcaConnected`

**Layer:** the `harness` command's process (a stored record). **Depends on:** none. **Effort:** `high`.

**Red test:** `cli/src/devices/dialSkillFiles.spec.ts`.

**Files:**
- Modify: `cli/src/devices/dialSkillFiles.ts` (`DialSetting`, `rewriteSetting`, two functions after `writePluginHomes`, the header comment)
- Test: `cli/src/devices/dialSkillFiles.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  /** Whether a connect of Orca's plugin once succeeded: Harness then offers it no more. */
  export function readOrcaConnected(dataDir: string): Read<{ connected: boolean }>
  /** undefined once saved, else the error's code. Nothing clears it. */
  export function writeOrcaConnected(dataDir: string): string | undefined
  ```
  - In the file it is `"orcaConnected": true`, absent until then. It is part of `DialSetting`, so every rewrite carries it.

- [ ] **Step 1: Write the failing tests**, in a new `describe('that Orca was connected')`:
  - `a missing file reads not connected; once written it reads connected, 0600`.
  - `only true counts`: a file with `"orcaConnected": "yes"`, `1` or `false` reads not connected.
  - `every other write of dial-skill.json keeps it`: after `writeOrcaConnected`, each of `writeRemoved(dataDir, 'vscode', true)`, `writeRemoved(dataDir, 'claude', false, [folder])` and `writePluginHomes(dataDir, [home])` leaves it connected; and `writeOrcaConnected` leaves the removals, the folders and the plugin homes.
  - `a file that cannot be read says so, and is not written over` (`chmod 000`): `{ connected: false, unread: true }`, and `writeOrcaConnected` answers `EACCES`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/dialSkillFiles.spec.ts`. Expected: FAIL (`readOrcaConnected` is not exported).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `CLI: dial-skill.json records that Orca was connected`.

### Task 3: The plugin's folder, swapped whole

**Layer:** the `harness` command's process (files Orca installs code from). **Depends on:** none. **Effort:** `xhigh` (atomicity; a crash or a second command must never leave half a folder).

**Red test:** `cli/src/devices/orcaPluginFolder.spec.ts`.

**Files:**
- Create: `cli/src/devices/orcaPluginFolder.ts`
- Test: `cli/src/devices/orcaPluginFolder.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  /** Makes [folder] hold exactly [files], writing only when it differs. Never throws. */
  export function ensureOrcaPluginFolder(folder: string, files: Readonly<Record<string, string>>): 'same' | 'written' | 'failed'
  ```
  - First, what an earlier run left: `<folder>.old` with no `<folder>` is renamed back; `<folder>.old` beside a `<folder>` is removed; `<folder>.new` is removed.
  - `same`: `<folder>` is a real directory holding exactly these paths, each a regular file with these bytes. Anything else differs: a missing, extra or changed file, a link, a file where a folder belongs. The compare stops at the first difference.
  - A write: every file into `<folder>.new` (folders 0700, files 0600, each on disk before the swap), `<folder>` renamed to `<folder>.old`, `<folder>.new` renamed into place, `<folder>.old` removed. A step that fails answers `failed`, removes `<folder>.new`, and puts `<folder>.old` back when it had been moved.
  - A key that is not a relative path of plain segments (`[A-Za-z0-9._-]+`, joined by `/`, none `.` or `..`) answers `failed` and writes nothing.

- [ ] **Step 1: Write the failing tests**, on throwaway folders, with `node:fs` mocked as the real one watched (as `dialSkillFiles.spec.ts`):
  - `a missing folder is written, 0700 and 0600, with nothing left beside it`.
  - `the same content writes nothing`: the folder's and each file's inode are as before.
  - `a changed, extra or missing file, a link, or a file where a folder belongs is written anew`, and the extra is gone.
  - `an old folder with no folder is put back first`: with the same content it answers `same`, and it is the old folder's inode.
  - `a leftover new folder is removed; an old folder beside a whole one is removed`.
  - `a swap whose second rename fails` (`renameSync` made to throw once for `.new`): `failed`, the earlier folder back in place and whole, no `.new` or `.old` left. (Review Focus 3.)
  - `a parent that cannot be written answers failed and leaves the folder as it was`.
  - `a key that would leave the folder writes nothing`: `../x`, `/abs`, `a//b`, `src/../x`, `src/.`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/orcaPluginFolder.spec.ts`. Expected: FAIL (the module is missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `CLI: the Orca plugin's folder is swapped whole`.

### Task 4: What the plugin is in Orca (`status`)

**Layer:** the `harness` command's process. **Depends on:** 2, 3. **Effort:** `xhigh` (outside text from another program, read with bounds).

**Red test:** `cli/src/devices/orcaPlugin.spec.ts`.

**Files:**
- Create: `cli/src/devices/orcaPlugin.ts`, `cli/src/testing/fakeOrcaCli.ts`
- Test: `cli/src/devices/orcaPlugin.spec.ts`

**Interfaces:**
- Consumes: `readOrcaConnected` (Task 2); `ensureOrcaPluginFolder` (Task 3); `orcaBinary`, `orcaHomesDeps` (`devices/orcaHomes.ts`).
- Produces:
  ```ts
  // cli/src/devices/orcaPlugin.ts
  declare const __ORCA_PLUGIN__: string | undefined
  export const ORCA_STATUS_MS = 5_000
  export const ORCA_READ_MS = 10_000
  export const ORCA_ANSWER_MAX_BYTES = 256 * 1024
  export type OrcaPluginFiles = Readonly<Record<string, string>>
  /** The real things: Orca's CLI and what cli.js carries. */
  export interface OrcaPluginRun {
    platform: NodeJS.Platform
    /** Orca's CLI (`orcaBinary`), null when it is not here. */
    orca(): string | null
    /** `orcaHomesDeps().run`: no shell; `code` null for a kill, a binary that could not start or output past maxBytes. */
    run(file: string, args: string[], opts: { timeoutMs: number; maxBytes: number }): Promise<{ code: number | null; stdout: string; timedOut: boolean }>
    /** Null in a run from the sources. */
    files(): OrcaPluginFiles | null
  }
  export interface OrcaPluginDeps extends OrcaPluginRun { folder: string; dataDir: string }
  export function orcaPluginRun(): OrcaPluginRun
  export type OrcaPluginState = 'absent' | 'offer' | 'off' | 'approve' | 'behind' | 'current'
  export async function orcaStatus(deps: OrcaPluginDeps): Promise<{ orca: OrcaPluginState }>

  // cli/src/testing/fakeOrcaCli.ts
  export type FakeOrcaWord = 'status' | 'plugin inspect' | 'plugin list' | 'plugin install' | 'plugin update' | 'plugin enable'
  export interface FakeOrcaCli {
    bin: string
    /** What [word] prints from now on, pretty-printed as Orca prints --json, and its exit code. A word with no answer prints nothing and exits 1. */
    answer(word: FakeOrcaWord, json: unknown, code?: number): void
    /** Every run's arguments, one line a run, in order. */
    calls(): string[]
  }
  /** A script at [bin] (default `<dir>/resources/bin/orca`, a path Orca's launcher check takes); its answers and its log are in [dir]. */
  export function fakeOrcaCli(dir: string, bin?: string): FakeOrcaCli
  ```
  - A module-private function works the state out once for `orcaStatus` and Task 5. Beside the state it gives what Task 5 needs: for `absent`, whether the cause is a CLI from the sources; for `approve` and `behind`, the plugin key; for `behind`, whether the entry's folder is ours.
  - The first rule that holds, in this order:
    1. Windows: `absent`, nothing run.
    2. `files()` is null: `absent` (from the sources).
    3. `orca()` is null: `absent`.
    4. `orca status --json` (5 s): not exit 0, not `ok`, `runtime.reachable` not `true`, or `appVersion` below the carried manifest's `engines.orca` (compared as Orca does): `absent`. Nothing else is run and the folder is not written.
    5. `ensureOrcaPluginFolder(deps.folder, files)` is `failed`: `absent`.
    6. `orca plugin inspect <folder> --json` (10 s): the key is `result.plugin.pluginKey`, held to `^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$` (it is later an argument). Else `absent`.
    7. `orca plugin list --json` (10 s): the entry with that `pluginKey`. An answer that cannot be read, or an entry with no `version` or `status` string: `absent`. `isDev` true: `absent`.
    8. No entry: `absent` when the record cannot be read, `off` when connected, else `offer`.
    9. `status` `disabled`: `off`. `pending`, or `needsReconsent` true: `approve`.
    10. `version` not the carried manifest's, or `source.kind` not `local-path`, or `source.reference` not the folder by real path: `behind`.
    11. `errored` or `invalid`: `absent`. Anything else: `current`.

- [ ] **Step 1: Write the failing tests.** Every case runs the fake `orca` through the real `run`, in throwaway folders, with `files` of the test's own (a manifest at `1.2.3` with `engines.orca` `>=1.4.248`, and one source). Only the deadline and byte-bound cases use a `run` that answers from a table.
  - `on Windows, and from the sources, nothing is run and no folder is written`.
  - `no orca is absent`.
  - `an Orca that is not reachable is asked status alone`: the fake's calls are `['status --json']`, and the folder is not there.
  - `an Orca below the plugin's engines is absent`: `1.4.247` and `1.4.248-rc.1` are `absent`; `1.4.248` and `1.5.0` go on.
  - `an answer that cannot be read is absent`: `status` exit 1, not JSON, `ok: false`; `inspect` exit 2; `list` not JSON; an entry with no `version`.
  - `a deadline passed is absent, at each of the three`, and the three runs were given 5 000, 10 000 and 10 000 ms and 262 144 bytes.
  - `an answer past 256 KiB is absent`.
  - `each rule, in order`, as a table: a development folder is `absent`; no entry is `offer`; no entry and connected is `off`; `disabled` is `off`; `pending` and `needsReconsent` are `approve`; another version is `behind`; another folder is `behind`; `errored` at this version from our folder is `absent`, and at another version `behind`; `running` and `idle` are `current`; an entry of another key is not ours.
  - `Orca is asked about the folder itself`: `plugin inspect <folder> --json`, then `plugin list --json`.
  - `the folder is written before Orca is asked about it, and only when it differs`: a second `orcaStatus` leaves its inode.
  - `the entry names the folder through a link`: `current`, not `behind`. (Review Focus 1.)
  - `a record that cannot be read` with no entry: `absent`, never `offer`. (Review Focus 4.)
  - `a folder that cannot be written is absent`.
  - `from the sources, the real files() is null`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/orcaPlugin.spec.ts`. Expected: FAIL (the module is missing).
- [ ] **Step 3: Implement.** The fake is a `sh` script written 0755; keep it to the contract above.
- [ ] **Step 4: Run** the step 2 command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `CLI: what Orca's plugin is in Orca, from Orca's own CLI`.

### Task 5: `connect`

**Layer:** the `harness` command's process. **Depends on:** 4. **Effort:** `xhigh` (consent: what may pass `--approve`, and what of Orca's answer is passed on).

**Red test:** `cli/src/devices/orcaPlugin.spec.ts`.

**Files:**
- Modify: `cli/src/devices/orcaPlugin.ts` (after `orcaStatus`)
- Test: `cli/src/devices/orcaPlugin.spec.ts`

**Interfaces:**
- Consumes: Task 4's state, `OrcaPluginDeps`, `fakeOrcaCli`.
- Produces:
  ```ts
  export const ORCA_FINGERPRINT = /^ap1-[0-9a-f]{32}$/
  export const ORCA_CONNECT_MS = 60_000
  export const ORCA_GRANTS_MAX = 10
  export const ORCA_GRANT_MAX_CHARS = 300
  export type OrcaConnectError = 'not-running' | 'no-plugin' | 'off' | 'timeout' | 'failed'
  export type OrcaConnect =
    | { connect: 'done' }
    | { connect: 'approve'; name: string; version: string; fingerprint: string; grants: string[]; update: boolean }
    | { connect: 'failed'; error: OrcaConnectError }
  export async function orcaConnect(deps: OrcaPluginDeps, approve?: string): Promise<OrcaConnect>
  ```
  - An `approve` off the pattern: `failed`, with nothing run, not even `status`.
  - By state: from the sources `no-plugin`; any other `absent` `not-running`; `off` `off`; `current` `done` with nothing more run; `offer`, and `behind` from another folder, `orca plugin install <folder>`; `behind` from our folder `orca plugin update <key>`; `approve` `orca plugin enable <key>`.
  - The run's arguments end `--approve <fingerprint> --json` when one was given, else `--json`. 60 s, 256 KiB.
  - Its answer: past the deadline `timeout`; `ok: true` is `done`; `error.code` `approval_required` or `approval_stale` is the `approve` line, built by the grant-line rule in Global Constraints, with `update` true for `approve` and `behind`; a fingerprint off the pattern, a grant line past a bound, more than 10 grant lines, no grant left, or a `name` or `version` that is no string is `failed`, with nothing of the answer passed on; anything else is `failed`.
  - It writes no record (Task 6 does) and has no log.

- [ ] **Step 1: Write the failing tests**, in a new `describe('connect')`, with an `approval_required` in Orca 1.4.262's whole shape (`contributions`, `why`, `nextSteps`, `approveFlag` beside the fields read):
  - `with no fingerprint it asks Orca and passes --approve to nobody`: the fake's install call is `plugin install <folder> --json`; the line is `approve` with `name: 'Harness Device'`, `version: '1.2.3'`, the fingerprint, `grants` equal to the execution sentence then the capability's description, `update: false`, and no other key.
  - `with the fingerprint Orca installs`: the call ends `--approve ap1-… --json`; the line is `{ connect: 'done' }`.
  - `a fingerprint that no longer matches shows the fresh grants`: `approval_stale` gives `approve` with the new fingerprint.
  - `a replacement is worded as Orca words it`, after the capabilities: `Runs "Open file" instead of Orca's own file opener`.
  - `Orca's errors are failed, and never its message`: `plugin_install_failed` (exit 1), `plugin_invalid` (exit 2), not JSON, `ok: false` with no code; each line is exactly `{ connect: 'failed', error: 'failed' }`.
  - `past its deadline it is timeout`, and the run was given 60 000 ms.
  - `a fingerprint off the pattern, from Orca or from the caller, is failed`: `AP1-…`, 31 digits, a trailing space; from the caller the fake's log stays empty.
  - `off installs nothing`: `off`, and no install call. `Orca not running is not-running`. `from the sources it is no-plugin`.
  - `an update that asks for nothing new goes through`: `behind` from our folder runs `plugin update local.harness-device --json` and is `done`. `one that asks for more` is `approve` with `update: true`.
  - `a hand install from another folder is installed from ours`: `plugin install <folder> --json`.
  - `a pending plugin is enabled`: `plugin enable local.harness-device --json`, and with the fingerprint.
  - `a current plugin is done with nothing run after the list`.
  - `the grants' bounds`: 10 lines of 300 characters are all passed on, in order. Each of these is exactly `{ connect: 'failed', error: 'failed' }`: the execution sentence and 10 capabilities (11 lines); a 301-character line; a line break, a tab or a bell inside a line; a replacement whose `command` holds a line break.
  - `an approval with no grant left` (no `executionDescription`, or only empty and blank strings) is `failed`. (Review Focus 5.)
  - `a folder behind what cli.js carries is written before Orca is asked to install it`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/orcaPlugin.spec.ts`. Expected: FAIL (`orcaConnect` is not exported).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `CLI: connect asks Orca, and approves only with the fingerprint it is handed`.

### Task 6: The two words of `harness device orca`

**Layer:** the `harness` command's process (its router). **Depends on:** 1, 5. **Effort:** `xhigh` (the one argument that carries consent; where the folder is).

**Red test:** `cli/src/deviceClaude/command.spec.ts`.

**Files:**
- Modify: `cli/src/deviceClaude/command.ts` (the header comment, `DeviceDeps`, the route beside `notify`'s, one new function)
- Modify: `cli/src/cli.ts` (the `device` case: one line, `orca: orcaPluginRun`, and its import)
- Modify, only if it is on the base: `cli/src/config/harnessHome.ts` and its spec
- Test: `cli/src/deviceClaude/command.spec.ts`

**Interfaces:**
- Consumes: `orcaStatus`, `orcaConnect`, `orcaPluginRun`, `ORCA_FINGERPRINT`, `OrcaPluginRun` (Tasks 4, 5); `writeOrcaConnected` (Task 2); `readOrcaPluginBundle` (Task 1, in one test).
- Produces: `DeviceDeps.orca(): OrcaPluginRun`, asked for only by these two words.
  - Routed before the words that start with `-` are dropped, as `notify` is: `argv[0] === 'orca'` and `argv[1]` is `status` or `connect`.
  - `status`: prints `orcaStatus`'s answer, one line with `--json`, indented without, exit 0.
  - `connect`: `--approve` takes the next argument as its value. A missing value, a value off `ORCA_FINGERPRINT`, a second `--approve` or any other argument prints `{"connect":"failed","error":"failed"}` and exits 1, before `deps.orca()` is asked. Else it prints `orcaConnect`'s line, and exits 0 for `done` and `approve`, 1 for `failed`; `done` then writes the record.

- [ ] **Step 1: The folder.** Run `git fetch origin main`, then `git ls-tree -r --name-only origin/main -- cli/src/config/harnessHome.ts` and `ls cli/src/config/harnessHome.ts`.
  - Neither prints: the folder is `join(deps.dataDir, 'orca-plugin')`, built in `command.ts` and nowhere else. Say so in the report; the pull request's body names it.
  - Both print: add one entry for `orca-plugin` with the label `data`, as the table's other entries are written, and take the folder from the module. Its test holds the entry to `<data folder>/orca-plugin`.
  - `origin/main` has it and this branch does not: stop and report. The branch needs `main` first; never create the file.
- [ ] **Step 2: Write the failing tests**, in a new `describe('harness device orca status and connect')`, with `fakeOrcaCli` and a default `orca: () => { throw … }` in the `device()` helper:
  - `status --json prints one line and exits 0`: `{"orca":"offer"}`; without `--json`, the same fields indented.
  - `connect --json prints what Orca lists, installs nothing and records nothing`.
  - `connect --approve prints done and records it`: `dial-skill.json` holds `"orcaConnected": true`. Then, with the plugin gone from the fake's list, `status` is `off`, and `connect` prints `{"connect":"failed","error":"off"}`, exits 1 and runs no install.
  - `harness device vscode disable keeps the record`.
  - `--approve takes the next word, wherever --json is`: `connect --approve <fp> --json` and `connect --json --approve <fp>` both end the fake's call `--approve <fp> --json`.
  - `anything else after --approve is failed before Orca is run`: no value, `--approve --json`, upper case, 31 digits, a value with more after it, `--approve` twice, a stray word. Each prints the `failed` line, exits 1, and never asks for `deps.orca()`.
  - `a record that cannot be saved is said`: `done` on stdout, exit 0, `Could not save the dial setting.` on stderr.
  - `what the build carries is what the folder holds`: with `files` from `readOrcaPluginBundle('1.2.3')`, after `status` the folder is `<dataDir>/orca-plugin`, its manifest's version is `1.2.3`, and the fake's `plugin inspect` was handed that folder.
  - `status with another word prints the usage and exits 1`.
  - `link, claude, codex, vscode and notify never ask for the Orca dependencies`, and `orca link` prints what it printed.
  - `the usage names neither word`.
  - `no file under core/, services/ or cable/ imports devices/orcaPlugin or devices/orcaPluginFolder`, written as the `deviceClaude/` test beside it.
  - `neither module names the home folder`: their sources hold no `homedir`.
- [ ] **Step 3: Run** `cd cli && npx vitest run src/deviceClaude/command.spec.ts`. Expected: FAIL (`orca status` prints the usage).
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the step 3 command, then `npx vitest run src/architecture.spec.ts src/leanEntry.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `CLI: harness device orca status and connect`.

### Task 7: End to end: the built CLI and a fake Orca

**Layer:** test. **Depends on:** 6. **Effort:** `high`. **No behavior:** one commit.

**Files:**
- Create: `cli/e2e/deviceOrcaConnect.e2e.ts`

**Interfaces:**
- Consumes: `fakeOrcaCli` (Task 4); `IsolatedDaemon` (`e2e/harness/daemon.ts`), never started, for its throwaway home, data folder and environment, as `cli.e2e.ts` uses it.

- [ ] **Step 1: Write the test.**
  - The bundle: `E2E_BUNDLE_PATH` when the run has one, else one built for this file into a throwaway folder (`build-bundle.mjs` with `BUNDLE_OUT_DIR`), as `cli.e2e.ts` does. It is the only test that reads the `__ORCA_PLUGIN__` a build inlined.
  - The fake `orca`: `fakeOrcaCli`'s script written through the harness's `bin/orca` link, as `FakeOrca.install` writes its own. The harness already names that launcher in `HARNESS_ORCA_APP_BIN`, so neither `PATH` nor the app's own path can reach a real Orca.
  - Each command is `node <cli.js> device orca …` with the harness's environment.
  - One case, in order:
    1. `status --json` is `{"orca":"offer"}`. The fake's log starts `status --json`. `<data folder>/orca-plugin` is 0700, holds `orca-plugin.json` and the plugin's sources, each 0600, and its manifest's version is `extensionVersion` of what `node <cli.js> --version` prints.
    2. `connect --json` prints the `approve` line with the fake's two grant lines; the fake's log has no `--approve`; `dial-skill.json` has no `orcaConnected`.
    3. `connect --approve <fingerprint> --json` prints `{"connect":"done"}`, and the record is written.
    4. With the plugin in the fake's list at that version and folder: `current`. At an older version: `behind`, and `connect --json` runs `plugin update local.harness-device --json`.
    5. With the plugin gone from the list: `off`; `connect --json` exits 1 with `{"connect":"failed","error":"off"}` and runs no install.
  - A second case: with the fake's `status` saying `reachable: false`, `status --json` is `absent` and the data folder holds no `orca-plugin`.
- [ ] **Step 2: Run** `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceOrcaConnect.e2e.ts`. Expected: PASS, none skipped.
- [ ] **Step 3: Commit** `test(e2e): the built CLI connects a fake Orca`.

### Task 8: The app runs and reads the two commands

**Layer:** the menu-bar app. **Depends on:** none (the two lines are in Global Constraints). **Effort:** `xhigh` (outside text; the fingerprint's pattern; what the log may hold).

**Red tests:** in `orca_cli.rs`, `cli.rs` and `types.rs`.

**Files:**
- Create: `device-app/src-tauri/src/orca_cli.rs`
- Modify: `device-app/src-tauri/src/lib.rs` (one `pub mod`), `types.rs` (four new types after `LoginEvent`; no existing type changes), `cli.rs` (`name`)

**Interfaces:**
- Produces:
  ```rust
  // types.rs
  /// An approval fingerprint as Orca prints one: `ap1-` and 32 lowercase hex digits. Only `parse` makes one.
  #[derive(Clone, Debug, PartialEq, Eq)]
  pub struct Fingerprint(String);
  impl Fingerprint { pub fn parse(text: &str) -> Option<Fingerprint>; pub fn as_str(&self) -> &str }
  #[derive(Clone, Copy, Debug, PartialEq, Eq)]
  pub enum OrcaStatus { Absent, Offer, Off, Approve, Behind, Current }
  /// The CLI's five codes; anything else it prints is `Failed`.
  #[derive(Clone, Copy, Debug, PartialEq, Eq)]
  pub enum OrcaError { NotRunning, NoPlugin, Off, Timeout, Failed }
  #[derive(Clone, Debug, PartialEq, Eq)]
  pub enum OrcaAnswer { Done, Approve { fingerprint: Fingerprint, grants: Vec<String>, update: bool }, Failed(OrcaError) }

  // orca_cli.rs
  pub const ORCA_STATUS_DEADLINE: Duration = Duration::from_secs(30);
  pub const ORCA_CONNECT_DEADLINE: Duration = Duration::from_secs(120);
  /// None when the CLI could not say.
  pub fn status(cli: &dyn Cli) -> Option<OrcaStatus>
  pub fn connect(cli: &dyn Cli, approve: Option<&Fingerprint>) -> OrcaAnswer
  ```
  - `status` runs `["device", "orca", "status", "--json"]`. `None` for a run that could not start, timed out or did not exit 0, and for no line that reads as `{"orca":"<a state above>"}`.
  - `connect` runs `["device", "orca", "connect", "--json"]`, or with `"--approve", <fingerprint>` before `"--json"`. It reads the first line that parses, whatever the exit code. Past the deadline: `Failed(Timeout)`. No such line, or a run that could not start: `Failed(Failed)`.
  - An `approve` line is an answer only with a fingerprint `Fingerprint::parse` takes and 1 to 10 grants, each `log::printable` (no control character) and at most 300 characters (`chars().count()`). Anything else, more than 10 grants or one grant past either bound included, is `Failed(Failed)`: nothing is cut.
  - `cli::name` leaves out the argument after `--approve`: the log says `harness device orca connect --approve --json`.
  - Each has a `_within(cli, …, deadline)` twin for the tests, as `account::auth_status_within`.

- [ ] **Step 1: Write the failing tests**, with `testing::Fake`:
  - `types.rs`: `a_fingerprint_is_ap1_and_32_hex_digits`: one good; `AP1-…`, 31 and 33 digits, an upper-case digit, a leading or trailing space, an empty string are `None`.
  - `orca_cli.rs`:
    - `status_reads_each_state`: six lines, six states; the fake's calls are `["device orca status --json"]`.
    - `a_cli_from_before_the_command` (no script: `Unknown command`, exit 1): `None`. (Review Focus 2.)
    - `a_status_nobody_can_read_is_none`: `{"orca":"later"}`, not JSON, `@exit 1` after a good line, `@hang` past a short deadline.
    - `connect_reads_its_line`: `done`; an `approve` line with `name` and `version`; each `failed` code, printed before `@exit 1`; an unknown code is `Failed(Failed)`.
    - `connect_passes_the_fingerprint_only_when_handed_one`: the fake's calls are `device orca connect --json`, then `device orca connect --approve ap1-… --json`.
    - `a_fingerprint_off_the_pattern_is_never_an_answer`.
    - `grants_past_ten_lines_or_300_characters_are_failed`: 10 grants of 300 characters are an `Approve` with all 10; 11 grants, a 301-character grant, a grant holding `\n`, `\t` or a bell are each `Failed(Failed)`.
    - `an_approve_line_with_no_grant` is `Failed(Failed)`. (Review Focus 5.)
    - `no_line_or_a_run_past_its_deadline_is_failed`: `Failed(Failed)` and `Failed(Timeout)`.
  - `cli.rs`: `the_log_names_a_run_without_its_fingerprint`: after a `connect` with one, a log line is `harness device orca connect --approve --json: exit 0`, and no line holds the fingerprint or a grant.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked --lib orca_cli`, then `cargo test --locked --lib fingerprint`. Expected: FAIL to compile (`orca_cli` is missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test --locked --lib`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: runs and reads harness device orca`.

### Task 9: The Orca screen

**Layer:** the menu-bar app's rules. **Depends on:** 8. **Effort:** `xhigh` (consent: nothing is approved without the click, and only with the fingerprint shown).

**Red tests:** in `app.rs`, `types.rs`, `main.rs` and `runner.rs`.

**Files:**
- Modify: `device-app/src-tauri/src/types.rs` (`Screen`, `Phase`, `View`, `Action`, `MenuAction`, `Event`, `Effect`, and the tests of the view's JSON and the window's actions)
- Modify: `app.rs`, `runner.rs` (one arm in `run`), `main.rs` (`menu_id`, `menu_action`, the comment over `act`)

**Interfaces:**
- Consumes: `Fingerprint`, `OrcaAnswer`, `OrcaError`, `orca_cli::connect` (Task 8).
- Produces:
  ```rust
  pub enum Screen { Install, SignIn, Orca }                              // "orca"
  pub enum Phase { Offer, Working, Browser, Failed, Asking, Approve, Done }
  pub struct View { pub screen: Screen, pub phase: Phase, pub lines: Vec<String>,
      /// The Orca screen of an update. In the JSON only when true.
      #[serde(skip_serializing_if = "std::ops::Not::not")] pub update: bool }
  pub enum Action { Retry, SignIn, Later, Cancel, ConnectOrca }          // "connect_orca"
  pub enum MenuAction { …, Orca }                                        // menu id "orca"
  pub enum Event { …, OrcaConnect(OrcaAnswer) }
  pub enum Effect { …, RunOrcaConnect(Option<Fingerprint>) }
  ```
  - `Effect::RunOrcaConnect(approve)` runs `orca_cli::connect` on a thread through `with_cli` and answers `Event::OrcaConnect`.
  - Every `View` written out (`screen_at`, the tests' helpers in `app.rs` and `main.rs`) gains `update: false`.
  - The rules, in `app.rs`:
    - `Event::Menu(MenuAction::Orca)`, with the CLI found: the window shows `asking` with `["Asking Orca…"]`. With no connect running it asks `RunOrcaConnect(None)`; with one running it asks nothing more.
    - `Event::OrcaConnect`, heard only while a connect runs: logs `orca connect: …`, sets the phase (`done`; `approve` with the grants and `update`, keeping the fingerprint; `failed` with `Orca isn't running.` for `NotRunning` and `Couldn't connect Orca.` for the rest), and draws it only in a window that shows this screen.
    - `Event::Act(Action::ConnectOrca)` does something only in a window that shows `approve`: the phase goes back to `asking`, and `RunOrcaConnect(Some(the fingerprint kept))` is asked once.
    - `Event::Act(Action::Cancel)` on `approve`, `done` or `failed` closes the window. A window that leaves `approve` (Cancel, a close, another screen, the CLI gone) drops the fingerprint.
    - A close never stops a run. The Orca screen is never due by itself (`model::due` does not change).

- [ ] **Step 1: Write the failing tests.**
  - `types.rs`: `the_window_may_ask_five_things` (`connect_orca`; `{"connect_orca":"ap1-…"}` and `"connect_orca ap1-…"` are refused); `a_view_is_the_json_the_window_reads` gains `{"screen":"orca","phase":"approve","lines":["A"],"update":true}`, and a view with `update` false has no such key.
  - `main.rs`: `every_menu_action_has_its_own_id` counts 11, with `orca`.
  - `runner.rs`: `a_connect_runs_with_the_fingerprint_it_is_handed`: `RunOrcaConnect(None)` and `RunOrcaConnect(Some(fp))` give their answers, and the fake's calls are the two argument lists.
  - `app.rs`:
    - `a_click_on_the_row_asks_orca`: the window shows `asking` with `Asking Orca…`, and the effects hold `RunOrcaConnect(None)`.
    - `the_grants_are_shown_as_orca_words_them`: in order, with `update` as answered.
    - `nothing_is_approved_without_the_click`: from the row's click through any answers, no effect is `RunOrcaConnect(Some(_))`; `ConnectOrca` while `asking`, `done` or `failed`, on another screen, or with the window closed, asks nothing.
    - `connect_runs_approve_with_the_fingerprint_of_the_last_answer_only`: the click asks `RunOrcaConnect(Some(fp1))` once, and a second click nothing; after a second `Approve` with `fp2` (the files changed), the click asks `Some(fp2)`.
    - `done_and_each_failure`: `done` has no lines; `NotRunning` reads `Orca isn't running.`; `Off`, `NoPlugin`, `Timeout` and `Failed` read `Couldn't connect Orca.`
    - `cancel_done_and_close_close_the_window_and_install_nothing`.
    - `a_second_click_on_the_row_starts_no_second_run`.
    - `a_closed_window_stays_closed`: after `WindowClosed` an answer shows nothing, and is still logged.
    - `the_log_names_the_answer_and_nothing_orca_listed`: `orca connect: approve`, `orca connect: failed not-running`; no `Effect::Log` holds a grant or the fingerprint.
    - `an_answer_nobody_waits_for_changes_nothing`.
    - `a_cli_that_goes_away_ends_the_orca_screen`: the window hides, and a late answer is not heard.
- [ ] **Step 2: Run** `cd device-app/ui && npm run build`, then `cd ../src-tauri && cargo test --locked`. Expected: FAIL to compile (`Screen::Orca` is missing).
- [ ] **Step 3: Implement.** Fix the comment over `act` in `main.rs`: it says six actions and there are five.
- [ ] **Step 4: Run** `cargo test --locked`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: the Orca screen shows Orca's access before it connects`.

### Task 10: The menu row, when `status` runs, one run at a time, the silent update

**Layer:** the menu-bar app's rules. **Depends on:** 9. **Effort:** `xhigh` (ordering of runs; a run with no click must never approve).

**Red tests:** in `app.rs`, `model.rs` and `runner.rs`.

**Files:**
- Modify: `device-app/src-tauri/src/types.rs` (`OrcaState`, `AppState`, `Event`, `Effect`), `model.rs` (`menu` and its tests), `app.rs`, `runner.rs` (one arm in `run`, and its tests)

**Interfaces:**
- Consumes: `OrcaStatus`, `orca_cli::status` (Task 8); Task 9's screen and effects.
- Produces:
  ```rust
  #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
  pub enum OrcaState { #[default] None, Offer, Update }
  pub struct AppState { …, pub orca: OrcaState }
  pub enum Event { …, OrcaStatus(Option<OrcaStatus>) }
  pub enum Effect { …, RunOrcaStatus }
  ```
  - `model::menu`: after the sign-in row and before Sound, `Action(MenuAction::Orca, "Connect Orca…")` for `Offer`, `Action(MenuAction::Orca, "Update Orca connection…")` for `Update`, nothing for `None`.
  - `Effect::RunOrcaStatus` runs `orca_cli::status` through `with_cli` and answers `Event::OrcaStatus`.
  - The rules, in `app.rs`:
    - A `status` is wanted when the CLI is found (at start, after an install, when it comes back); when `CliVersion` answers a version other than the one known; and on `MenuOpened`, with the CLI found, when the last `status` started 300 s ago or more (`abs_diff`), or none has.
    - One Orca run at a time. A wanted run waits while one runs. When one answers, the first of these that waits starts: the screen's `connect`, the silent update, a `status`. Task 9's connects go through the same door.
    - `Event::OrcaStatus`: `Offer` is the row `Offer`; `Approve` is `Update`; `Absent`, `Off`, `Current` and `None` are no row; `Behind` is no row and wants the silent update, unless one has run since the CLI was found or its version changed.
    - The silent update is `RunOrcaConnect(None)`, never `Some`. Its answer shows no window and keeps no fingerprint: `Done` is no row, `Approve` is `Update`, `Failed` is no row.
    - The screen's `Done` is no row. Its `Approve` and `Failed` leave the row.
    - The `asking` view's `update` is whether the row is `Update`.
    - `orca: none|offer|update` is logged on each change of the row. `Cli(false)` takes the row, the runs that wait and the run noted.

- [ ] **Step 1: Write the failing tests.**
  - `model.rs`: `the_orca_row_sits_under_the_account_and_above_sound` (both labels, and none for `None`); `states()` gains the three, so `no_agent_rows_in_any_state` covers them.
  - `runner.rs`:
    - `a_status_runs_its_fixed_words`: `RunOrcaStatus` answers `OrcaStatus(Some(Offer))`, and the fake's call is `device orca status --json`.
    - `from_the_row_to_orca_connected`, with `App`, `Runner` and the fake as `from_start_to_dial_connected`: `status` answers `offer`; the row shows; its click shows the grants; `ConnectOrca` ends in `done` and no row. The fake's `device` calls are `device orca status --json`, `device orca connect --json`, `device orca connect --approve ap1-… --json`. No log line holds the fingerprint or a grant.
    - `from_start_to_dial_connected` also waits for the `status`'s answer before it reads the calls, which then hold `device orca status --json` and no other `device` word.
  - `app.rs`:
    - `status_runs_once_the_cli_is_found`: at start, after an install, when it comes back; never with no CLI.
    - `a_new_cli_version_asks_again`: the first version read asks nothing; another one asks; the same one, and `None`, do not.
    - `the_menu_asks_at_most_once_in_five_minutes`: 299 s after the last, nothing; 300 s, a `status`; a clock set back 300 s asks too.
    - `a_tick_never_asks_orca`.
    - `never_two_runs_at_a_time`: a `status` wanted while one runs, or while a connect runs, starts only at the answer.
    - `the_screens_connect_goes_before_a_waiting_status`: with a `status` running, a second wanted and the row clicked, the answer starts `RunOrcaConnect(None)` and no `RunOrcaStatus`; the connect's answer starts the `status`.
    - `each_status_sets_the_row`: the row and its place for each of the six states and for `None`; `orca: offer` is logged once, not at each same answer.
    - `a_status_nobody_could_read` is no row, and the next menu open five minutes on asks again. (Review Focus 2.)
    - `behind_updates_with_no_click_once_per_cli_version`: `RunOrcaConnect(None)` and no `Show`; a second `Behind` runs nothing; after a new version it runs again.
    - `a_silent_update_that_needs_approval_brings_the_update_row`, and its click asks `RunOrcaConnect(None)` afresh: `ConnectOrca` before that answer asks nothing.
    - `a_silent_update_that_fails_is_one_log_line_and_no_row`: `orca connect: failed timeout`.
    - `done_takes_the_row_away; cancel_and_a_failure_keep_it`.
    - `a_closed_window_still_sets_the_menu`.
    - `an_update_draws_its_own_words`: from the `Update` row, `asking` has `update` true.
    - `a_cli_that_goes_away_takes_the_row_and_what_waited`.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked`. Expected: FAIL to compile (`OrcaState` is missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test --locked`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: Connect Orca… in the menu, and updates with no click`.

### Task 11: The window's Orca screen, the gallery, the design doc

**Layer:** the app's webview, and the design doc that changes with it. **Depends on:** none (the view and the screen are in Global Constraints). **Effort:** `high`.

**Red tests:** `device-app/ui/src/screens.test.ts`, `gallery.test.ts`.

**Files:**
- Modify: `device-app/ui/src/api.ts`, `screens.ts`, `styles.css`, `gallery.ts`
- Modify: `desktop/design/desktop-design-system.md` (the Harness Device section only)
- Test: `device-app/ui/src/screens.test.ts`, `gallery.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Screen = 'install' | 'sign_in' | 'orca'
  export type Phase = 'offer' | 'working' | 'browser' | 'failed' | 'asking' | 'approve' | 'done'
  export interface View { screen: Screen; phase: Phase; lines: string[]; update?: true }
  export type Action = 'retry' | 'sign_in' | 'later' | 'cancel' | 'connect_orca'
  ```
  - `render` draws the four Orca phases as "The screen, as drawn" says. Every grant reaches the page through `textContent`.
  - On the Orca screen `render` focuses nothing. The other screens keep the primary button focused.
  - The grants' list scrolls inside the content; the heading and the buttons stay. The window's tokens only, and no `color-mix()`.

- [ ] **Step 1: Write the failing tests.**
  - `screens.test.ts`:
    - `orca: asking, the grants, Connect, done`: `asking` has the heading `Connect Orca`, the spinner, `Asking Orca…` and no button; `approve` has `Orca will let Harness Device:`, one list item per line in order, and `Cancel`, `Connect`; a click on `Connect` calls `act` once, with `'connect_orca'` and nothing else; `done` has `Orca connected.` and `Done`, which sends `'cancel'`.
    - `orca: Cancel sends cancel`.
    - `orca: an update says so`: with `update: true`, the heading is `Update Orca connection` in each phase and the button is `Update`.
    - `orca: a failure is one line and Close`: `Orca isn't running.` is the alert; `Close` sends `'cancel'`.
    - `orca: no button has the focus`, in each of the four phases.
    - `orca: the grants are drawn as text`: `<img src=x onerror=alert(1)>` makes no `img`.
    - `orca: ten lines of 300 characters are all in the list`.
    - The table of `the primary button is the one the contract names` gains the four phases: `Connect` for `approve`, `Done` for `done`, none for `asking` and `failed`.
  - `gallery.test.ts`: `STATES` has 14; the pairs gain `orca.asking`, `orca.approve`, `orca.done`, `orca.failed`; one frame a theme is still `focused`, and it is Sign in's.
- [ ] **Step 2: Run** `cd device-app/ui && npm test`. Expected: FAIL (the Orca screen draws nothing).
- [ ] **Step 3: Implement.** The gallery's six new states: `Orca · asking`; `Orca · connect` (the two lines Orca 1.4.262 lists for this plugin); `Orca · update, long` (`update: true`, ten long lines, so the list scrolls); `Orca · done`; `Orca · not running`; `Orca · failed`.
- [ ] **Step 4: The design doc**, in the same commit: the window has three screens; the menu drawing gains `Connect Orca…` under `Signed in`; one bullet for the two rows (one or neither, under the sign-in row, above Sound; `Cancel` keeps the row); one bullet for the Orca screen (each phase's words, Orca's own lines in a list that scrolls, and no focused button, since a Return typed in another app's habit must approve nothing); the gallery sentence says the primary button is focused except on the Orca screen.
- [ ] **Step 5: Run** `npm test && npm run typecheck && npm run build && npm run gallery`. Expected: PASS, and both bundles build.
- [ ] **Step 6: Commit** `Harness Device: the window's Orca screen`.

### Task 12: Say it in the guides

**Layer:** repo files. **Depends on:** none. **Effort:** `medium`. **No behavior:** one commit.

**Files:**
- Modify: `device-app/AGENTS.md`, `plugins/harness-device-orca/README.md`

- [ ] **Step 1: `device-app/AGENTS.md`.**
  - The first paragraph: the window has three screens, and the app offers `Connect Orca…` once when Orca runs without Harness's plugin.
  - **Fixed arguments:** the webview sends one of five action names (`retry`, `sign_in`, `later`, `cancel`, `connect_orca`). One argument is not fixed text: the fingerprint after `--approve`. It is the CLI's own answer, held to `^ap1-[0-9a-f]{32}$` in Rust, never anything from the webview, and the log's name of the run leaves it out.
  - **One log, redacted:** nothing Orca lists is logged, only `orca: <state>` and `orca connect: <answer>`.
- [ ] **Step 2: The plugin's README**, under Install: the Harness menu-bar app offers `Connect Orca…`, shows the access Orca lists, and installs on Connect; a later CLI brings the plugin current by itself, and asks again only when Orca does. The `orca plugin install` commands stay, for people without the app.
- [ ] **Step 3: Commit** `docs: Connect Orca in the Harness app's guide and the plugin's README`.

## The pull request's body

- **Platforms:** macOS and Linux (the CLI and the app); Windows answers `absent` and runs nothing.
- **Where the folder is:** `orca-plugin/` in the CLI's data folder. If Task 6 took the fallback, say so: it is `join(deps.dataDir, 'orca-plugin')` in `command.ts`, and chore/harness-paths moves it into the paths module.
- **Data:** `orcaConnected` in `dial-skill.json` is never deleted; the folder is replaced whole and holds one copy. A CLI from before this change carries only the keys it knows, so it drops `orcaConnected` at its next write of that file: after a downgrade and an upgrade, a person who removed the plugin can be offered it once more.
- **Evidence:** each task's red and green commits; the local gates and the checks below, with the run link; the gallery in both themes.
- **UI checklist** (`desktop/design/desktop-design-system.md`), ticked. It is not a Desktop feature: its click-through test is `screens.test.ts`.
- **Release:** the CLI first, then the app, which needs the CLI's two commands. The PM asks Diego before either; no task releases.
- **Diego's steps:** Verification 4.

## Verification

**Platforms the pull request names:** the CLI on macOS (this Mac) and Linux (PR CI, and check 1 on the workflow's runners). The app's rules on Linux (PR CI) and macOS (this Mac); its window is drawn on macOS only in check 4. Windows: `status` is `absent` (Task 4).

**Never touched by a session:** Diego's Orca (no `orca plugin install`, `update`, `enable`, `disable`, `uninstall` or `restart`, and no `harness device orca …` outside check 1's isolation), his data folder (`~/.harness`), his installed Harness menu-bar app and its state, his dial, any backend, production. No screenshots.

**Temporary workflow:** none. The one long check is the CLI's end-to-end suite, which has a workflow of the repo's own that starts by hand on a branch (`.github/workflows/cli-e2e.yml`); it takes every `e2e/**/*.e2e.ts`, so Task 7's file needs no workflow edit and stays in its nightly run. The app has no end-to-end check a runner could run: check 4 needs a real Orca and a person's eye.

**Turns.** The tester asks the orchestrator before the one hand-started GitHub run (check 1).

**Local gates**, recorded in the pull request (PR CI does not run them all, or runs them on Linux only), on this Mac at the final head:
- `cd cli && npm run typecheck && npx vitest run src/devices/orcaPluginBundle.spec.ts src/devices/vscodeExtensionBundle.spec.ts src/devices/dialSkillFiles.spec.ts src/devices/orcaPluginFolder.spec.ts src/devices/orcaPlugin.spec.ts src/devices/orcaHomes.spec.ts src/deviceClaude/command.spec.ts`.
- `npx vitest run src/architecture.spec.ts src/leanEntry.spec.ts`, and `git diff --stat "$(git merge-base HEAD origin/main)" -- cli/src/core cli/src/services cli/src/cable cli/src/devices/orcaHomes.ts cli/src/architecture.coreFiles.txt` prints nothing: the core and the devices process are unchanged.
- `python3 -m unittest discover -s scripts/tests -p 'test_*.py'`.
- `cd device-app/ui && npm ci && npm run typecheck && npm test && npm run build && npm run gallery`.
- `cd device-app/src-tauri && cargo test --locked`: the repo's rule for any `device-app/` change, since PR CI compiles only its Linux code.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit; its output goes in the pull request's body. For this plan's paths `--list` prints `{}` (checked 2026-11-18): no coverage gate, serial, PTY, shell or Desktop macOS check is selected.
- Not needed: `npm run test:core`, `test:harnessd` and the other coverage gates (nothing under `src/core/`, `src/services/` or `src/harnessd/` changes); `npm run test:vscode` (neither file it names changes: Task 1 only imports `extensionVersion`); `make desktop-test` (no Desktop code); the release scripts' tests.

**1. The built CLI and a fake Orca** (Task 7)
- Where: this Mac, at the final head, and once on GitHub. No account, no sign-in, no backend, no daemon.
- Build: nothing by hand. `E2E_BUNDLE=1` builds one `cli.js` as the release ships it.
- Run: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceOrcaConnect.e2e.ts e2e/deviceNotify.e2e.ts e2e/dialStream.e2e.ts`. The last two prove the changed router under `notify` and `orca link`.
- Isolation, the suite's own (`cli/e2e/harness/daemon.ts`, cli/AGENTS.md rules 5 and 6):
  - a throwaway home and data folder, so the plugin's folder and `dial-skill.json` are the test's;
  - the fake `orca` in the harness's launcher, which is first on `PATH` and is also `HARNESS_ORCA_APP_BIN`: neither `PATH` nor `/Applications` can reach the real Orca, and the fake's log holds every call;
  - no daemon is started for the new file.
- A person sees: every test passes, none skipped. In the new file `status` goes `offer`, `current`, `behind`, `off` as the fake's list changes; `connect` prints Orca's lines and passes no `--approve`; only `connect --approve` ends in `done` and writes the record.
- Skipped or not run: report it as not verified, never as passed.
- On GitHub, by hand, once on the final head: Actions → CLI end to end → Run workflow, branch `feat/device-app-connect-orca` (`.github/workflows/cli-e2e.yml`). Its shards are Linux, which is the check of "Linux: the CLI commands work where `orca` is on `PATH`". Every shard passes. The link goes in the pull request.

**2. The app, from the row to connected, against the fake `harness`**
- `from_the_row_to_orca_connected` (Task 10), inside the local gate `cargo test --locked` on this Mac and in PR CI on Linux: the app's rules and its runner, with `testing::Fake` answering each JSON line. No window is drawn and no real CLI is run.
- On GitHub: PR CI's `device-app-checks`, by itself.
- A debug build of the app is not run by a session: it would share Diego's installed app's bundle id, state and login item.

**3. In PR CI, by itself:** `cli-typecheck` and `cli-tests` (Tasks 1 to 6, on Linux), `companion-subsystems` and `pty-checks` (any `cli/` change), `device-app-checks` (Tasks 8 to 11: the window's typecheck, Vitest and bundle, then `cargo test`), `desktop-tests` (the design doc is under `desktop/`), `process-checks` (the planner's test, the docs). Nothing is started by hand.

**4. In Diego's own Orca (needs Diego himself: his Orca, his click, his eye).** The only check against a real Orca. No session and no test runs any of it.
1. Build both from the branch: `cd cli && npm ci && node build-bundle.mjs` (gives `cli/dist/cli.js`); `cd device-app/ui && npm ci && npm run build`, then `cd ../src-tauri && cargo tauri build --debug`.
2. Write a two-line launcher, `#!/bin/sh` and `exec node <repo>/cli/dist/cli.js "$@"`, and make it executable. Quit the installed Harness menu-bar app. Start the debug app's binary with `HARNESS_DEVICE_CLI=<the launcher>` (a debug build reads it). Once the CLI is released and installed, no launcher is needed: the debug app finds it, and step 6 runs `harness`.
3. With Orca running and the plugin not installed, open the menu: `Connect Orca…` is under `Signed in`. If the plugin is installed by hand from a checkout, the row reads `Update Orca connection…` instead; `orca plugin uninstall local.harness-device` first shows the first-time path.
4. Click it: the window shows `Orca will let Harness Device:` and Orca's own lines. `Cancel`: nothing is installed (`orca plugin list`), and the row stays.
5. Click it again, then `Connect`: `Orca connected.`, `Done`, and the row is gone. Orca shows the Harness Device panel.
6. `<the launcher> device orca status --json` prints `{"orca":"current"}`. `behind` here means Orca recorded the folder under another spelling (Review Focus 1): report it.
7. Remove it (`orca plugin uninstall local.harness-device`), then restart the debug app: no row comes back.
8. The look, in both themes: `cd device-app/ui && npm run gallery && open gallery.html`.

**5. Numbers** (root rule 4, idle work), held by specs:
- at rest: nothing new runs. No timer and no poll (`a_tick_never_asks_orca`);
- per menu open, at most once in five minutes: one `harness device orca status`, which runs Orca's CLI three times, or once while Orca is not running (Task 4: `an Orca that is not reachable is asked status alone`);
- the tester records, from check 1's run, how long `status` took against the fake.

**6. Against production:** none, and never.
