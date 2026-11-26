# Claude Code's plugin installs without git, and voice says how to reach Claude Code — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Status:** approved by the PM (2026-11-26): the 8 tasks, and the 7 questions answered as recommended (Decisions
from the PM, at the end).

**Goal:** The `harness-device` plugin installs from a folder Harness writes (no git, no GitHub); a failed plugin step
logs why in a fixed word; voice at a Claude Code session the dial cannot reach shows the fix on the dial.

**Architecture:**
- **The build carries the marketplace.** `cli/scripts/lib/claudePluginBundle.mjs` reads `.claude-plugin/marketplace.json`,
  `plugins/harness-device/` and `plugins/harness/` into `__CLAUDE_PLUGIN__`, as Orca's plugin is carried.
- **One crash-safe writer for both plugin folders.** `devices/orcaPluginFolder.ts` becomes `devices/pluginFolder.ts`
  (`ensurePluginFolder`), which also writes executables 0700 and compares modes off Windows.
- **`devices/claudePlugin.ts` adds the folder, not GitHub.** It writes `harnessPath('claude-marketplace')` before an
  install or update, runs `marketplace add ./claude-marketplace` from the folder's parent, and gives each failure a
  fixed `reason`. The git lookup, `NO_GIT` and the `git` step go.
- **Voice:** `cable/hosts/observed.ts` gives every live Claude Code agent `v` and, with no route, one of two sentences;
  `cable/cableSession.ts` refuses a voice start at an agent with `v` whose host gives a sentence.
- **Nothing in the daemon core.** The only core-process file touched is `config/harnessHome.ts` (one table entry).

**Tech Stack:** TypeScript (Node, Vitest 4) in `cli/`, plain ESM build scripts, Python (`scripts/ci-plan.py`).

**Spec:** [docs/plans/2026-11-26-dial-claude-plugin-install-design.md](2026-11-26-dial-claude-plugin-install-design.md),
approved by the PM. Its design points 1–4 and the PM's decisions in the brief are not reopened here: the marketplace
name stays `openharness` and a GitHub-sourced one is never removed; no firmware change; the two sentences below; no
Command Line Tools check, and the git lookup on the install path goes entirely.

## Base

- **Written against** `fix/dial-claude-plugin-install` at `76a23256c0` (`origin/main` with #4637 and #4641). Tasks
  name code by name, never by line. If a name below is gone, stop and report.
- **#4641** made a mod "ready" for 5 s after its last poll closed (`READY_MS`, `cable/hosts/inbox.ts`; was 35 s), has
  the core hold a mod's poll while no dial watches and end it `{}` as one starts watching, and refuses words a ready
  mod missed with `<name> is not listening yet. Try again in a moment.` So a running mod is ready by the time a dial
  is plugged in, and the restart sentence below is reached only when the plugin is on in the session's home and its
  mod has no poll open and none closed in the last 5 s: a session started before the install, a mod waiting out its
  60 s retry after a refused poll, or the devices just restarted. #4641's sentence stays as it is: it is the words'
  failure after a ready start, this plan's sentences are the start's refusal.
- A task that names a failing test is two commits: the test, red, then the change. The message given is the second's.
  A task marked "one commit" changes no behavior.
- **Dependencies.** The worktree has no `cli/node_modules`: install them as the implementer's definition says.
- **Between Task 3 and Tasks 4–5** the callers of `claudeSetUp`, `claudeUpdate` and `claudeEnable` still pass `git`
  and no folder: `dialPluginSetup.spec.ts`, `dialSetup.spec.ts`, `devices.spec.ts` and `command.spec.ts` are red there,
  and the typecheck too. Tasks 4 and 5 make them green; nothing is pushed in between.

## Global Constraints

- **The Mac is reserved for another eval (~1.5 h):** no `npm test`, no `npm run build`, no `tsc`/typecheck, no
  `local-checks`, no e2e. Only targeted Vitest runs of the changed spec files, each under a minute, e.g.
  `cd cli && npx vitest run src/devices/claudePlugin.spec.ts`; one named Python test for `scripts/ci-plan.py`.
  Typecheck runs on CI.
- Never run a real `claude` or `codex`: fakes only. Never touch the developer's real `~/.claude`, real Harness data
  folder or the running Harness. A test that writes the marketplace folder gives it a throwaway path.
- Never `pgrep -f`, `ps aux`, `ps -o args`/`command`.
- Marketplace name `openharness`; plugin id `harness-device@openharness` (the mod names it, `device.js` `PLUGIN_ID`).
- Copy, verbatim: `Voice needs Harness in Claude Code. Run: harness device claude enable` and
  `Restart Claude Code for voice.` (vendor name **Claude Code** intact, docs/naming-system.md).
- Reasons are fixed words only: `timeout`, `no answer`, `no xcode tools`, `no git`, `network`, `exists`, `exit <n>`,
  and for the folder its error's code (`EACCES`). Claude Code's stderr is never logged.
- The log line is `[device] dial setup · claude · failed · <step> · <reason>`, or `· <step>` alone with no reason. The
  tally's day counts stay keyed by `failed`.
- Folders 0700, files 0600, listed executables 0700; Windows neither sets nor compares modes.
- macOS, Linux and Windows alike; `claude plugin` runs with no shell through `claudeRunner`.
- Comments say why, in plain sentences (cli/AGENTS.md rule 7). No dead code: a replacement removes the old.

## Decisions the plan makes (the spec left them open)

1. **Names.** `ensurePluginFolder`, `readClaudePluginBundle`, `carriedClaudePlugin`, `failureReason`, `failureWords`,
   `ClaudePluginFiles`, `ClaudePluginSource`, `folderFailed`, `claudePluginState` on `ObservedActions` (Interfaces
   below).
2. **The executable list is fixed in the build script** (`hooks/asked`), and its spec holds it to the checkout's own
   modes, so a Windows build carries the same bytes.
3. **The version's hash** is SHA-256 over `JSON.stringify` of that plugin's carried `[path inside the plugin, text]`
   pairs, sorted by path, `plugin.json` as read from disk; its first 8 hex digits.
4. **Text only.** A carried file that is not UTF-8 text fails the build, naming it, so no image is shipped mangled.
5. **Where the folder is written.** `install()` writes it first, before the marketplace list; `claudeUpdate` writes it
   right after Claude Code is found supported, before the plugin list. An update's failed write rides on the result as
   `folderFailed: <code>`, counted beside the update's own outcome.
6. **From the sources** the devices' pass returns before it looks for Claude Code: nothing run, counted or recorded.
7. **The writer sets modes explicitly** (`fchmodSync`, `chmodSync`) off Windows, so no umask makes a folder differ at
   every run.
8. **Windows coverage of the writer** is a `pluginFolder.windows.real.spec.ts` listed in `windows.yml` and
   `WINDOWS_SPECS`; the runner's `cwd` gets a case in the existing `claudePlugin.windows.real.spec.ts`.
9. **End to end.** The fake Claude Code (`cli/e2e/harness/fakeEngine.mjs`) learns `marketplace add <local path>` in
   place of the GitHub add; the e2e files that assert a Claude agent's missing `v` change with the caps.

## Review Focus

1. **A computer that already has `openharness` from GitHub:** no add, no `marketplace remove`, the folder still
   written, the install with its one `marketplace update` retry as today (Task 3).
2. **A transcript path not shaped `<home>/projects/<slug>/<id>.jsonl`** (none, relative, with `..`, another extension):
   the default home's settings decide, never a folder the path does not plainly name (Task 6).
3. **A FIFO, folder or device at `<home>/settings.json`:** never opened, reads as not on, so the enable sentence
   (Task 6).
4. **A question, form, search or draft voice at a Claude Code agent with no route:** not refused; those have their
   own targets (Task 7).
5. **A binary file under a carried plugin folder** (a PNG in `plugins/harness/assets/`): the build fails naming it
   (Task 2).

## File structure

| File | Change |
|---|---|
| `cli/src/devices/pluginFolder.ts` (from `orcaPluginFolder.ts`) | shared writer, executables, modes |
| `cli/scripts/lib/claudePluginBundle.mjs` (new) | the marketplace cli.js carries |
| `cli/build.mjs`, `cli/build-bundle.mjs` | define `__CLAUDE_PLUGIN__` |
| `cli/src/config/harnessHome.ts` | `'claude-marketplace': 'data'` |
| `cli/src/devices/claudePlugin.ts` | local add, folder, reasons, runner `cwd` and `timedOut` |
| `cli/src/cable/dialPluginSetup.ts`, `cable/dialSetup.ts` | folder in, git out, reasons counted |
| `cli/src/services/devices.ts` | wiring: the plugin source; `claudeHome` and the state reader for observed |
| `cli/src/deviceClaude/command.ts`, `cli/src/cli.ts` | `enable` writes the folder, prints the reason |
| `cli/src/cable/hosts/observed.ts`, `hosts/claudeRenderer.ts`, `devices/dialSkill.ts` | caps, sentences, reader |
| `cli/src/cable/cableSession.ts` | refusal at a voice start with `v` |
| `cli/e2e/harness/fakeEngine.mjs` and five e2e files | local add, caps |
| `scripts/ci-plan.py`, `.github/workflows/windows.yml`, `cli/AGENTS.md` | CI mapping, Windows spec, docs |

## Tasks

| # | Task | Depends on | Effort |
|---|---|---|---|
| 1 | One plugin folder writer: `ensurePluginFolder` with executables and modes | none | xhigh |
| 2 | The marketplace inside cli.js: `__CLAUDE_PLUGIN__` | 1 | high |
| 3 | `claudePlugin.ts`: the local marketplace, the folder, a reason for each failure | 1 | high |
| 4 | The devices' setup: the folder in, git out, the reason counted | 3 | high |
| 5 | `harness device claude enable`: the folder, the reason, no git | 3 | high |
| 6 | Observed: every live Claude Code agent takes voice; the two sentences | none | xhigh |
| 7 | The session refuses a voice start whose host gives a sentence | none | medium |
| 8 | End to end: the local add and the voice sentences | 2, 4, 5, 6, 7 | high |

**Longest chain:** 1 → 3 → 4 → 8 and 1 → 3 → 5 → 8 (four). Tasks 1, 6 and 7 start at once; 2 and 3 run side by side
after 1; 4 and 5 after 3.

**Tasks that share files** (never two of a group at once):
- `cli/src/deviceClaude/command.spec.ts`: 1, 5.
- `scripts/ci-plan.py`, `scripts/tests/test_ci_plan.py`: 1, 2.
- `cli/src/services/devices.ts`, `devices.spec.ts`, `cli/AGENTS.md`: 4, 6.

---

### Task 1: One plugin folder writer: `ensurePluginFolder` with executables and modes

**Depends on:** none. **Effort:** xhigh (a crash-safe writer two processes run at once; file modes).

**Files:**
- Rename (`git mv`) and modify: `cli/src/devices/orcaPluginFolder.ts` → `cli/src/devices/pluginFolder.ts`,
  `cli/src/devices/orcaPluginFolder.spec.ts` → `cli/src/devices/pluginFolder.spec.ts`
- Create: `cli/src/devices/pluginFolder.windows.real.spec.ts`
- Modify: `cli/src/devices/orcaPlugin.ts`, `cli/src/devices/orcaPluginBundle.spec.ts`,
  `cli/scripts/lib/orcaPluginBundle.mjs` (its SEGMENT comment), `cli/src/deviceClaude/command.spec.ts` (the two tests
  that name `orcaPluginFolder`), `.github/workflows/windows.yml` (its spec list), `scripts/ci-plan.py`
  (`WINDOWS_SPECS`)

**Interfaces — Produces:**

```ts
// cli/src/devices/pluginFolder.ts — the one export
/** Makes [folder] hold exactly [files], [executable] (keys of files) 0700, other files 0600, folders 0700; writes only
 *  when bytes or, off Windows, modes differ. Never throws: a failure is its error's code; a bad key, or an executable
 *  that names no file, is `EINVAL`. */
export function ensurePluginFolder(folder: string, files: Readonly<Record<string, string>>, executable: readonly string[]): 'same' | 'written' | { failed: string }
```

- [ ] **Step 1: Rename and write the failing tests.** `git mv` both files; the spec imports `ensurePluginFolder` from
  `./pluginFolder.js` and its existing cases pass `[]`. Add, in `'the plugin's folder'` (renamed from `'the Orca
  plugin's folder'`):
  - `it('an executable is written 0700, beside files 0600 and folders 0700')`: `{ 'hooks/asked': '#!/bin/sh\n',
    'hooks/hooks.json': '{}' }` with `['hooks/asked']` is `'written'`; `statSync(...).mode & 0o777` is `0o700` for
    `hooks/asked`, the folder and `hooks/`, and `0o600` for `hooks/hooks.json`.
  - `it('a mode changed on disk is written anew; the same bytes and modes write nothing')`: after a write,
    `chmodSync(asked, 0o600)` gives `'written'` and `0o700` again; `chmodSync(hooks.json, 0o644)` the same; a third
    call is `'same'` and keeps the inodes.
  - `it('an executable that names no file writes nothing')`: `['hooks/other']` is `{ failed: 'EINVAL' }`, no folder.
  - `it('a umask that strips owner bits still writes 0700 and 0600, and a second run is same')`: under
    `process.umask(0o177)` (restored after), the modes are as above and a second call is `'same'`.
  - `pluginFolder.windows.real.spec.ts`, `describe.runIf(process.platform === 'win32')`: a write with
    `['hooks/asked']` is `'written'`, each file's bytes are its text, and a second call is `'same'` (modes are not
    compared there).
  - `command.spec.ts`: the two tests that name `orcaPluginFolder` name `pluginFolder` (pattern, sample line, file list).
  - Run `cd scripts/tests && python3 -m unittest test_ci_plan.SelectionTests.test_the_windows_spec_list_is_windows_ymls`
    after adding the new spec to `windows.yml`'s `$paths` and `WINDOWS_SPECS`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/pluginFolder.spec.ts`. Expected: FAIL (no module
  `./pluginFolder.js`; then the mode cases).
- [ ] **Step 3: Implement** in `pluginFolder.ts`: the tree keeps each file's wanted mode; `holds()` also compares
  `info.mode & 0o777` (folders included) when `process.platform !== 'win32'`; `put()` sets modes with `fchmodSync` and
  `chmodSync` off Windows. The header says both callers (Orca's folder, Claude Code's marketplace). `orcaPlugin.ts`
  calls `ensurePluginFolder(deps.folder, files, [])`; `orcaPluginBundle.mjs`'s comment names `pluginFolder.ts`.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/devices/pluginFolder.spec.ts src/devices/orcaPluginBundle.spec.ts
  src/devices/orcaPlugin.spec.ts` and `npx vitest run src/deviceClaude/command.spec.ts -t "pluginFolder|names the home
  folder"`, and the Python test above. Expected: PASS.
- [ ] **Step 5: Commit** `Plugin folders: one writer for Orca's and Claude Code's, with executables and modes`.

### Task 2: The marketplace inside cli.js: `__CLAUDE_PLUGIN__`

**Depends on:** 1 (the spec writes the carried files with `ensurePluginFolder`). **Effort:** high.

**Files:**
- Create: `cli/scripts/lib/claudePluginBundle.mjs`, `cli/src/devices/claudePluginBundle.spec.ts`
- Modify: `cli/build.mjs`, `cli/build-bundle.mjs`, `scripts/ci-plan.py`, `scripts/tests/test_ci_plan.py`

**Interfaces — Produces:**

```js
// cli/scripts/lib/claudePluginBundle.mjs
/** JSON of { files: { [path in the marketplace folder]: text }, executable: string[] }. [root] is the repository's
 *  root; a test hands its own. Throws on a name the folder writer would not take, or a file that is not UTF-8 text. */
export function readClaudePluginBundle(version, root = REPO_ROOT)
// both builds: __CLAUDE_PLUGIN__: JSON.stringify(readClaudePluginBundle(version))
```

Carried, by key: `.claude-plugin/marketplace.json` (the repository's own text); `plugins/harness-device/`:
`.claude-plugin/plugin.json`, every file under `hooks/`, `README.md` (never `test/`); `plugins/harness/`:
`.claude-plugin/plugin.json`, `.mcp.json` (Claude Code's; never `mcp.json`, which is Cursor's: PM decision 1), every
file under `skills/` and `assets/`, `README.md` (never `.codex-plugin/` or `.cursor-plugin/`). Each `plugin.json` is
the file's own JSON with `version: <extensionVersion(version)>+<hash8>` (Decision 3; PM decision 5: `extensionVersion`
from `vscodeExtensionBundle.mjs`, as `orcaPluginBundle.mjs` imports it, so `0.6.66-dev.0123456` gives
`0.6.66-dev.g0123456+<hash8>`), written `JSON.stringify(manifest, null, 2) + '\n'`. `executable` is
`['plugins/harness-device/hooks/asked']`. Posix keys, sorted; SEGMENT as in `orcaPluginBundle.mjs`.

- [ ] **Step 1: Write the failing tests** in `claudePluginBundle.spec.ts`, modelled on `orcaPluginBundle.spec.ts`:
  - `it('carries the marketplace and each plugin\'s files, and nothing else')`: the keys equal the list above, built
    from a listing of the two folders; none starts `plugins/harness-device/test/`.
  - `it('the marketplace is the repository\'s own')`: its text is `.claude-plugin/marketplace.json`'s; parsed, `name`
    is `openharness` and `plugins` holds `{ name: 'harness', source: './plugins/harness' }` and
    `{ name: 'harness-device', source: './plugins/harness-device' }`.
  - `it('each plugin.json carries the build\'s version and the hash of its own files')`: each matches
    `^1\.2\.3\+[0-9a-f]{8}$` and is otherwise the file's; two calls give the same; in a test root (copies of the two
    folders and the marketplace), one changed byte in `plugins/harness-device/hooks/device.js` changes that plugin's
    version alone.
  - `it('a dev version is made semver as the extension\'s is')` (PM decision 5): `0.6.66-dev.0123456` gives each
    `plugin.json` a version matching `^0\.6\.66-dev\.g0123456\+[0-9a-f]{8}$`.
  - `it('the harness plugin carries Claude Code\'s .mcp.json, not Cursor\'s mcp.json')` (PM decision 1): the keys
    hold `plugins/harness/.mcp.json` with the checkout's text and no `plugins/harness/mcp.json`.
  - `it('hooks/asked alone is executable, as in the checkout')`: `executable` is `['plugins/harness-device/hooks/asked']`;
    off Windows, that file's mode in the checkout has `0o100` and no other carried file's does.
  - `it('the folder writer takes every key the build carries')`: `ensurePluginFolder(<tmp>/claude-marketplace, files,
    executable)` is `'written'`.
  - `it('a name the folder would not take, or a file that is not text, fails the build')`: a test root with
    `hooks/my hook` throws `/takes/`; one with `assets/logo.png` holding `0x89 0x50 0x4e 0x47 0xff` throws `/text/`.
  - `it('a build run from another folder is the same bytes')` and `it('both builds inline it')`
    (`/__CLAUDE_PLUGIN__: JSON\.stringify\(readClaudePluginBundle\(version\)\)/` in `build.mjs` and `build-bundle.mjs`).
  - `test_ci_plan.py`: `test_the_claude_code_plugins_belong_to_the_cli_suite`, beside the Orca one:
    `planner.owners(path) == {"cli"}` and `"cli"` in `planner.select([path])[0]` for
    `plugins/harness-device/hooks/device.js` and `plugins/harness/skills/harness/SKILL.md`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/claudePluginBundle.spec.ts` and
  `cd scripts/tests && python3 -m unittest test_ci_plan.SelectionTests.test_the_claude_code_plugins_belong_to_the_cli_suite`.
  Expected: FAIL (no module; owners empty).
- [ ] **Step 3: Implement** `claudePluginBundle.mjs` (an include list per plugin, a trailing `/` read recursively);
  the define in both builds, with a comment beside `__ORCA_PLUGIN__`'s; `ALSO.update({"plugins/harness-device/": "cli",
  "plugins/harness/": "cli"})` in `ci-plan.py` with a one-line why (the CLI's build inlines both).
- [ ] **Step 4: Run** the Step 2 commands. Expected: PASS.
- [ ] **Step 5: Commit** `The CLI carries Claude Code's marketplace: both plugins, versioned by their files`.

### Task 3: `claudePlugin.ts`: the local marketplace, the folder, a reason for each failure

**Depends on:** 1. **Effort:** high.

**Files:**
- Modify: `cli/src/devices/claudePlugin.ts`, `cli/src/config/harnessHome.ts`
- Test: `cli/src/devices/claudePlugin.spec.ts`, `cli/src/devices/claudePlugin.windows.real.spec.ts`,
  `cli/src/config/harnessHome.spec.ts`

**Interfaces — Consumes:** `ensurePluginFolder` (Task 1). **Produces:**

```ts
export interface ClaudeAnswer { code: number | null; stdout: string; stderr: string; refused?: true; timedOut?: true }
export type ClaudeRun = (args: string[], timeoutMs: number, cwd?: string) => Promise<ClaudeAnswer>
/** What cli.js carries for the marketplace folder (scripts/lib/claudePluginBundle.mjs). */
export interface ClaudePluginFiles { files: Readonly<Record<string, string>>; executable: readonly string[] }
/** The folder and what cli.js carries for it; files() is null in a run from the sources. */
export interface ClaudePluginSource { folder: string; files(): ClaudePluginFiles | null }
export interface ClaudeInstallDeps extends ClaudeDeps { folder: string; files: ClaudePluginFiles }   // `git` is gone
export type ClaudeStep = 'unsupported' | 'launcher' | 'list' | 'folder' | 'marketplace' | 'install' | 'enable' | 'disable' | 'uninstall' | 'update'
export type ClaudeResult = { ok: true } | { ok: false; error: string; step: ClaudeStep; reason?: string }
export type ClaudeFailure = Extract<ClaudeResult, { ok: false }>
/** [folderFailed]: the code of an update's folder write that failed and did not stop it. */
export type ClaudeSetup = ({ ok: true; outcome: 'installed' | 'updated' | 'current' | 'absent' } | ClaudeFailure) & { folderFailed?: string }
export function failureReason(answer: ClaudeAnswer): string       // the table below
export function failureWords(failure: ClaudeFailure): string      // `<step> · <reason>`, or `<step>`
export function carriedClaudePlugin(): ClaudePluginFiles | null   // __CLAUDE_PLUGIN__, null from the sources
export function claudeEnable(deps: ClaudeInstallDeps): Promise<ClaudeResult>
export function claudeSetUp(deps: ClaudeInstallDeps): Promise<ClaudeSetup>
export function claudeUpdate(deps: ClaudeInstallDeps): Promise<ClaudeSetup>
// harnessHome.ts: HARNESS_ENTRIES gains 'claude-marketplace': 'data'
```

`failureReason`, the first that holds (the spec's table): `code === null` → `timedOut ? 'timeout' : 'no answer'`;
stderr `/xcrun: error|invalid active developer path|CommandLineTools/` → `no xcode tools`; `/(?<!\.)\bgit\b/` (a `git` right after a
`.`, as in `openharness.git`, does not count: PM decision 2) and `/not found|ENOENT|unsafe location|is not recognized/`
→ `no git`; `/Could not resolve host|Failed to connect|
Connection timed out|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|SSL|TLS/i` → `network`;
`/already added from a different source|already exists/` → `exists`; else `` `exit ${code}` `` (a list that exits 0
with no JSON reads `exit 0`, as the table's last row gives). `failure()` takes the whole answer and sets `reason`;
`UNSUPPORTED`, `LAUNCHER` and the folder's failure keep theirs as below. The folder's failure is
`{ ok: false, step: 'folder', reason: <code>, error: FOLDER_ERROR }`, with `FOLDER_ERROR` = `Harness could not write
Claude Code's plugin folder.` (PM decision 4); `enable` prints it with its reason (Task 5).

- [ ] **Step 1: Write the failing tests** in `claudePlugin.spec.ts`. `fakeClaude` records each call's `cwd`; `FILES` is
  a two-file `ClaudePluginFiles` (`.claude-plugin/marketplace.json`, `plugins/harness-device/hooks/asked` executable);
  `folder` is `<throwaway>/claude-marketplace`. Existing enable/setUp/update cases pass `{ folder, files: FILES }` and
  lose `git`; the `NO_GIT` cases go.
  - `it('the first install writes the folder and adds it from its parent as ./claude-marketplace')`: `claudeEnable`
    is `{ ok: true }`; `writes()` is `['plugin marketplace add ./claude-marketplace', 'plugin install
    harness-device@openharness --scope user']`; the add's `cwd` is `dirname(folder)`; no call holds
    `autonomous-ai/openharness` or `--sparse`; the folder holds `FILES`, and off Windows `asked` is `0o700`. The same
    for `claudeSetUp` (`outcome: 'installed'`).
  - `it('with openharness there, from GitHub or from the folder, nothing is added and nothing removed')` (Review
    Focus 1): for a GitHub and a directory entry in `marketplace list --json`, `writes()` is `[install]`, no call starts
    `plugin marketplace remove`, and the folder is written before the install; a stale install still runs
    `marketplace update openharness` once and installs again.
  - `it('a folder that cannot be written stops the install, with its code')`: parent `0o500` →
    `{ ok: false, step: 'folder', reason: 'EACCES', error: "Harness could not write Claude Code's plugin folder." }`
    (PM decision 4) and `writes()` is `[]`.
  - `it('a failed call says why in a fixed word')`: `failureReason` over the table, one row each: `xcrun: error:
    invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: …` → `no xcode tools`;
    `spawn git ENOENT` and `'git' is not recognized as an internal or external command` → `no git`;
    `fatal: repository 'https://github.com/autonomous-ai/openharness.git/' not found` (code 128) → `exit 128`, not
    `no git` (PM decision 2);
    `fatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com` → `network`;
    `Marketplace 'openharness' is already added from a different source` → `exists`; `Error: github.com not found`
    (code 1) → `exit 1`; `{ code: null, timedOut: true }` → `timeout`; `{ code: null }` → `no answer`. Through
    `claudeEnable`, a failed add is `{ ok: false, step: 'marketplace', error: <its first stderr line>, reason }`.
  - `it('the update writes the folder before marketplace update')`: at the `plugin marketplace update openharness`
    call, `join(folder, '.claude-plugin/marketplace.json')` exists; the result is as today.
  - `it('an update whose folder cannot be written still updates, and gives the code')`: parent `0o500` →
    `{ ok: true, outcome: 'updated', folderFailed: 'EACCES' }`, `writes()` is `[pull, update]`.
  - Runner, in `'claudeRun'`: `it('a call given a folder runs in it')` (a script printing `pwd`; stdout is the
    folder's real path); the two past-its-time cases and the never-closes case, each ended by the deadline, answer
    `{ code: null, …, timedOut: true }`; the start that throws has no `timedOut`.
  - `it('from the sources no plugin is carried')`: `carriedClaudePlugin()` is `null`.
  - `claudePlugin.windows.real.spec.ts`: `it('a call given a folder runs in it')`: the stand-in `claude.exe` (node)
    with `['-e', 'process.stdout.write(process.cwd())']`, `15_000`, `<profile>` → stdout `<profile>`.
  - `harnessHome.spec.ts`: `TABLE` gains `'claude-marketplace': 'data'`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/claudePlugin.spec.ts src/config/harnessHome.spec.ts`.
  Expected: FAIL (the GitHub add runs; no `reason`, `timedOut`, `folderFailed`; the table differs).
- [ ] **Step 3: Implement.** `claudeRunner` passes `cwd` to `execFile` and sets `timedOut: true` in its deadline alone;
  `install()` writes the folder first, then adds `./${basename(folder)}` with `cwd: dirname(folder)` when no
  `openharness` is listed; `claudeUpdate` writes it after `supportedRun`; `NO_GIT`, the `git` step, `git()` and the
  stale "Its manifest carries no version" comment go; the header and `FETCH_MS`' comment no longer say GitHub for the
  add. `harnessHome.ts` gains the entry.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `Claude Code's plugin: added from Harness's folder, and each failure says why`.

### Task 4: The devices' setup: the folder in, git out, the reason counted

**Depends on:** 3. **Effort:** high.

**Files:**
- Modify: `cli/src/cable/dialPluginSetup.ts`, `cli/src/cable/dialSetup.ts`, `cli/src/services/devices.ts`,
  `cli/AGENTS.md` (the devices row's plugin sentence)
- Test: `cli/src/cable/dialPluginSetup.spec.ts`, `cli/src/cable/dialSetup.spec.ts`, `cli/src/services/devices.spec.ts`

**Interfaces — Consumes:** Task 3's. **Produces:** `DialPluginSetupDeps.plugin: ClaudePluginSource` (replaces `git`);
`DialSetupDeps.claudePlugin: ClaudePluginSource` (replaces `git`); `DevicesDeps.claudePlugin?: ClaudePluginSource`
(replaces `git?`), defaulting to `{ folder: harnessPath('claude-marketplace', homedir()), files: carriedClaudePlugin }`.

- [ ] **Step 1: Write the failing tests.**
  - `dialPluginSetup.spec.ts`: `rig()` gives `plugin: { folder: <throwaway>/claude-marketplace, files: () => state.files }`
    (`FILES` by default); `ADD` is `plugin marketplace add ./claude-marketplace`; the existing counts gain their reason
    (`['failed', 'install · exit 1']` for the fake's `Error: no network`). New:
    - `it('a failed step counts its step and reason')`: an add failing with `Could not resolve host: github.com` →
      `[['failed', 'marketplace · network']]`; an Orca home's enable failing → `['failed', 'enable · exit 1']`; a failed
      undo → `['failed', 'uninstall · exit 1']`.
    - `it('from the sources a pass runs no claude, and counts and records nothing')`: `state.files = null` →
      `state.lookups` 0, `counted` `[]`, `state.recorded` undefined.
    - `it('an update whose folder cannot be written counts it and still updates and records')`: recorded
      `'0.6.58'`, parent `0o500` → `[['failed', 'folder · EACCES'], ['updated']]`, recorded `'0.6.59'`.
    - The `'no git …'` cases and `gitLookups` go.
  - `dialSetup.spec.ts`: deps give `claudePlugin` in place of `git`; the existing flow asserts the add of
    `./claude-marketplace`.
  - `devices.spec.ts`: `start()` gives `claudePlugin: { folder: join(dataDir, 'claude-marketplace'), files: () => FILES }`
    unless the spec says, `null` leaving it out (never the real home's folder); `git` goes from `start()`.
    `'with no claude given…'` passes its own `claudePlugin`. New:
    `it('with no plugin source given, a run from the sources sets nothing up')`: `claudePlugin: null` and a fake
    `claude` → the fake is never run and no `[device] dial setup · claude` line is logged.
    `it('a failed plugin step is logged with its reason, and no line of Claude Code\'s')`: the add fails with
    `fatal: unable to access '/Users/x/…': Could not resolve host` → the log has
    `[device] dial setup · claude · failed · marketplace · network` and no `/Users/x`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/dialPluginSetup.spec.ts src/cable/dialSetup.spec.ts` and
  `npx vitest run src/services/devices.spec.ts -t "plugin|dial setup|claude given"`. Expected: FAIL.
- [ ] **Step 3: Implement.** `dialPluginSetup.ts`: `noGit` and its block go; `run()` returns `false` when `wanted` and
  `deps.plugin.files()` is null, before `deps.claude()`; `claudeSetUp`/`claudeUpdate` get `{ run, platform, folder,
  files }`; every count of a `ClaudeFailure` uses `failureWords`; `done.folderFailed` is counted
  `` `folder · ${code}` `` with no hour. `dialSetup.ts` passes `claudePlugin` as `plugin`. `devices.ts`: the default
  above, `findGit` and its import go, the dep's comment says what it is now. `cli/AGENTS.md`: the devices row's
  sentence on `claude plugin` says it writes the marketplace cli.js carries to `claude-marketplace` in Harness's data
  folder (`devices/pluginFolder.ts`), adds it as `openharness` where Claude Code has none (one from GitHub is kept),
  each call up to 60 s, and counts a failed step `failed · <step> · <reason>` in fixed words; the `findGit` and
  `failed · no git` words go.
- [ ] **Step 4: Run** the Step 2 commands. Expected: PASS. Every new `??` in `devices.ts` has both sides run
  (`test:core`'s 100% per file, run later in its slot).
- [ ] **Step 5: Commit** `Dial setup: Claude Code's plugin from Harness's folder, failures counted with their reason`.

### Task 5: `harness device claude enable`: the folder, the reason, no git

**Depends on:** 3. **Effort:** high.

**Files:**
- Modify: `cli/src/deviceClaude/command.ts`, `cli/src/cli.ts`
- Test: `cli/src/deviceClaude/command.spec.ts`

**Interfaces — Consumes:** Task 3's. **Produces:** `DeviceDeps.claudeFiles(): ClaudePluginFiles | null` (replaces
`git`); the folder is `harnessPath('claude-marketplace', deps.home)`, as Orca's is. `cli.ts` passes
`claudeFiles: carriedClaudePlugin` and drops `git: () => findGit()` and its import.

- [ ] **Step 1: Write the failing tests** in `command.spec.ts` (deps: `claudeFiles: () => FILES`, `git` gone; `home`
  is the test's throwaway):
  - `it('enable writes the folder and adds it, with no git')`: the writes are the add of `./claude-marketplace` (its
    `cwd` the folder's parent) then the install; `harnessPath('claude-marketplace', home)` holds
    `.claude-plugin/marketplace.json`.
  - `it('enable that fails prints Claude Code\'s line and its reason')`: the add fails with `xcrun: error: invalid
    active developer path` → `err` is `['xcrun: error: invalid active developer path (no xcode tools)']`, exit 1.
  - `it('enable from the sources runs no claude')` (PM decision 3): `claudeFiles: () => null` → `err` is
    `['This Harness build carries no Claude Code plugin.']`, exit 1, no `claude` call.
  - `it('enable that cannot write the folder says so, with its code')` (PM decision 4): `home`'s data folder's parent
    `0o500` → `err` is `["Harness could not write Claude Code's plugin folder. (EACCES)"]`, exit 1, no `claude` write.
  - `'enable with no git says to install it'` goes.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/deviceClaude/command.spec.ts -t "enable"`. Expected: FAIL.
- [ ] **Step 3: Implement** in `command.ts`'s `enable`: null files print `This Harness build carries no Claude Code
  plugin.` and exit 1 before any `claude` call; `claudeEnable({ run, platform,
  folder, files })`; on failure `deps.err(result.reason ? `${result.error} (${result.reason})` : result.error)`.
- [ ] **Step 4: Run** the Step 2 command, then without `-t`. Expected: PASS.
- [ ] **Step 5: Commit** `harness device claude enable: writes Harness's folder, and says why a step failed`.

### Task 6: Observed: every live Claude Code agent takes voice; the two sentences

**Depends on:** none. **Effort:** xhigh (a synchronous read of a hook-given path at a voice start).

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts`, `cli/src/cable/hosts/claudeRenderer.ts` (export `homeOf`),
  `cli/src/devices/dialSkill.ts` (the reader), `cli/src/services/devices.ts` (wiring), `cli/AGENTS.md` (the devices
  row's voice words)
- Test: `cli/src/cable/hosts/observed.spec.ts`, `cli/src/devices/dialSkill.spec.ts`,
  `cli/src/cable/hosts/scannedApp.spec.ts` (its `ObservedActions` fake), `cli/src/services/devices.spec.ts`; and
  `cli/src/cable/cableHost.spec.ts`, `cli/src/cable/hosts/registry.spec.ts` only where a run shows an observed Claude
  Code agent's caps (their fakes that set caps stay)

**Interfaces — Produces:**

```ts
// observed.ts
export const CLAUDE_PLUGIN_OFF = 'Voice needs Harness in Claude Code. Run: harness device claude enable'
export const CLAUDE_RESTART = 'Restart Claude Code for voice.'
export interface ObservedActions {
  // …as today, plus:
  /** dirname(CLAUDE_PROJECTS_DIR): the home of a session whose transcript path names none. */
  claudeHome: string
  /** devices/dialSkill.ts claudePluginState: read only at a voice start, never for caps. */
  claudePluginState(settingsPath: string): 'on' | 'off' | 'unknown'
}
// claudeRenderer.ts: export function homeOf(transcriptPath: string | undefined): string | undefined
```

- [ ] **Step 1: Write the failing tests.**
  - `observed.spec.ts` (its actions fake gains both members; `claudePluginState` a `vi.fn` returning per path):
    - `it('a live Claude Code agent with no route takes voice; an ended one, or another engine, does not')`.
    - `it('with no route and the plugin not on in its own home, the enable sentence')`: transcript
      `<home>/projects/p/s.jsonl` → the reader is asked `join(<home>, 'settings.json')` alone; `'off'` and `'unknown'`
      give `CLAUDE_PLUGIN_OFF`.
    - `it('with the plugin on and no mod polling, the restart sentence')`: no poll open and none closed in the last
      5 s (the fake's `modReady` false) → `CLAUDE_RESTART`; `modReady` true → undefined.
    - `it('with no transcript path, or one of another shape, the default home decides')` (Review Focus 2):
      undefined, `projects/p/s.jsonl`, `<home>/projects/../x/s.jsonl`, `<home>/projects/p/s.txt` → the reader is asked
      `join(claudeHome, 'settings.json')`.
    - `it('an agent with a route gives no sentence and reads no settings')`: mod ready, a pane that types, a Codex
      queue → undefined, reader not called.
    - `it('an adapter\'s sentence comes first')`: an Orca chat pane → `'Type in Orca for chats.'`, reader not called.
    - `it('caps read no settings')`: `capabilities()` for such an agent never calls the reader.
    - Existing cases that assert a Claude Code agent's `voice: false` with no route change to `true`.
  - `dialSkill.spec.ts` (Review Focus 3): its `node:fs` mock also hooks `openSync`;
    `it('claudePluginState opens no FIFO, folder or device: it looks first')`: a FIFO, a folder and `/dev/null` read
    `'unknown'` and `openSync` is never called with them; a regular file is still read once.
  - `devices.spec.ts`: `it('Claude Code outside Harness with no route lists v, and its refusal names the fix')`: an
    observed Claude agent whose default home's `settings.json` has the plugin on → caps hold `v`, and
    `host.voiceRefusal(id)` is `CLAUDE_RESTART`; with the settings file absent, `CLAUDE_PLUGIN_OFF`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts src/devices/dialSkill.spec.ts
  src/cable/hosts/scannedApp.spec.ts` and `npx vitest run src/services/devices.spec.ts -t "no route"`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `observed.ts`, a private `routed(e, actions)` (`first(e, words)`, `modReady`,
  `queueable`); `capabilities().voice` is `live && (engine === 'claude' || routed)`; `voiceRefusal` runs for a live
  agent that is not `routed`, adapters first, then for Claude Code `claudePluginState(join(homeOf(e.transcriptPath) ??
  claudeHome, 'settings.json')) !== 'on' ? CLAUDE_PLUGIN_OFF : CLAUDE_RESTART`, with a comment that "Restart" also shows
  while a mod waits out its 60 s retry or right after the devices restarted (accepted: a restart always fixes it; see
  Base, #4641). `send()` and its `not listening yet` refusal are not touched. `dialSkill.ts` `pluginEntry` stats the path (a regular file, as the
  renderer's `readSettings`) before `openSync`, and opens with `O_NOCTTY` too. `devices.ts` passes
  `claudeHome: dirname(env.CLAUDE_PROJECTS_DIR)` and `claudePluginState`. `cli/AGENTS.md`'s devices row says a live
  Claude Code session no route reaches takes voice and is refused with the two sentences, its own home's
  `settings.json` read at the voice start alone, up to 1 MiB, a regular file only.
- [ ] **Step 4: Run** the Step 2 commands, and `npx vitest run src/cable/cableHost.spec.ts
  src/cable/hosts/registry.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: voice at a Claude Code session it cannot reach says how to reach it`.

### Task 7: The session refuses a voice start whose host gives a sentence

**Depends on:** none (the host's `voiceRefusal` exists). **Effort:** medium.

**Files:**
- Modify: `cli/src/cable/cableSession.ts`
- Test: `cli/src/cable/cableSession.spec.ts`

- [ ] **Step 1: Write the failing tests** beside `"dictation to an agent there that takes no voice is refused…"`:
  - `it("dictation to an agent with voice whose host refuses it is refused in the host's words")`: the agent's caps
    `sv`, `host.voiceRefusal` gives `'Restart Claude Code for voice.'` → at `voice.end` the dial gets
    `{ t: 'voice.error', uploadId: 'u1', message: 'Restart Claude Code for voice.' }`; audio frames sent after the
    start are dropped: `transcribe` and `sendTurn` are never called.
  - `it('a question voice at such an agent is not refused')` (Review Focus 4): the same host, a question voice →
    `transcribe` is called and no `voice.error` carries the sentence.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts -t "refuse"`. Expected: FAIL (the
  dictation is transcribed and sent).
- [ ] **Step 3: Implement** at the voice start: for a plain dictation target (no form, search, draft or question), a
  sentence from `host.voiceRefusal(agentId, asItself)` refuses as the missing-`v` path does, its sentence the message;
  the `CableHost.voiceRefusal` comment says it is asked for an agent with `v` too.
- [ ] **Step 4: Run** the Step 2 command, then the whole file. Expected: PASS.
- [ ] **Step 5: Commit** `Dial voice: a refusal the host gives stops the words at the start`.

### Task 8: End to end: the local add and the voice sentences

**Depends on:** 2, 4, 5, 6, 7. **Effort:** high.

**Files:**
- Modify: `cli/e2e/harness/fakeEngine.mjs`, `cli/e2e/deviceDialSkill.e2e.ts`, `cli/e2e/deviceWithoutApp.e2e.ts`,
  `cli/e2e/deviceClaudeOrca.e2e.ts`, `cli/e2e/dialHostOrcaPane.e2e.ts`, `cli/e2e/dialHostKitty.e2e.ts`,
  `cli/e2e/harness/modInbox.ts` (PM decision 6)

These run on PR CI only (`linux-e2e` for the changed files and the canary, `dial-hosts` for the two `dialHost*` files):
the Mac is reserved. The red is the suite as it stands against Tasks 2–7: the fake refuses `./claude-marketplace`,
and five assertions expect no `v`.

- [ ] **Step 1: The fake Claude Code.** `marketplace add <path>` (a path starting `./`, `../`, `/` or `~/`, as Claude
  Code's docs take) resolves it against the process's `cwd`, fails as Claude Code does unless it holds
  `.claude-plugin/marketplace.json` named `openharness`, and records `{ name, source: 'directory', path }`; `marketplace
  list --json` answers that record; `list --json` gives `harness-device`'s `version` from that folder's
  `plugins/harness-device/.claude-plugin/plugin.json`. The GitHub add goes: the product no longer runs it.
- [ ] **Step 2: Goal 1 end to end.** In `deviceDialSkill.e2e.ts`'s first-attach case: the plugin calls hold
  `plugin marketplace add ./claude-marketplace` and none holds `--sparse` or `autonomous-ai/openharness`; the daemon's
  folder (`harnessPath('claude-marketplace', d.env.HOME, process.platform, thisComputer(d.env))`) holds
  `.claude-plugin/marketplace.json`; off Windows its
  `plugins/harness-device/hooks/asked` is `0o700`.
- [ ] **Step 3: Goal 3 end to end.** In `deviceWithoutApp.e2e.ts`: caps `s` → `sv` and `sf` → `svf` for Claude Code
  outside Harness; `first?.caps` holds `v`; the waits named "voice once its mod polls" become, with no product change
(PM decision 6), a helper in `harness/modInbox.ts` that speaks again while the dial answers `Restart Claude Code for
voice.` (and sends `turn.send` again until the poll answers), within the existing 45 s waits, never a fixed sleep. New case
  `it('voice at Claude Code in Ghostty, with no route, says how to reach it')`: its home's settings without the plugin
  → `voice.error` `Voice needs Harness in Claude Code. Run: harness device claude enable`; with it on and no poll →
  `Restart Claude Code for voice.`; no path in the log. `deviceClaudeOrca.e2e.ts`: its mod-poll wait through the same helper.
  `dialHostOrcaPane.e2e.ts` (the held pane) and `dialHostKitty.e2e.ts` (remote control off): the Claude Code rows hold
  `v`, and words to them are refused with one of the two sentences.
- [ ] **Step 4: Run.** Nothing locally. After the PR opens, read `linux-e2e` and `dial-hosts`. Expected: PASS.
- [ ] **Step 5: Commit** `End to end: the plugin added from Harness's folder, and the dial's words to Claude Code`.

---

## Verification

1. **Windows VM, real Claude Code** (spec, Platforms). Held for the PM's machine slot; run by the PM side on the
   Ken-side Windows ARM64 VM (one VM at a time; send the PR, the head SHA and these steps). Isolation: the VM's owned
   test user (no person's profile), Claude Code ≥ 2.1.287 signed in with a test account, no `openharness` marketplace
   before; the CLI built at the head with `cd cli && npm ci && node build-bundle.mjs` (a run from the sources carries
   no plugin), run as that user; no production backend is involved.
   1. `harness device claude enable` → exit 0.
   2. `claude plugin marketplace list --json` → `openharness` at the absolute path of `claude-marketplace` in that
      user's Harness data folder.
   3. `claude plugin list --json` → `harness-device@openharness`, user scope, enabled, version `<cli version>+<8 hex>`.
   4. `claude plugin install harness@openharness --scope user` → installs from the same folder, no network asked.
   5. A new Claude Code session, under Git Bash and again with PowerShell alone, asked for a tool call that needs
      approval → the hook runs `harness device claude asked` (the devices' log, or a dial on the VM, shows the waiting
      prompt; `claude --debug` shows the PermissionRequest hook exit 0).
   6. `harness device claude disable` → the plugin is uninstalled; the marketplace stays.
   Pass: every step as stated. No GitHub workflow can run this (it needs a signed-in Claude Code).
2. **Linux VM, real Claude Code** (PM decision 7). Run by the PM side on the Ken-side Ubuntu GNOME Wayland VM, on the
   final head, together with the Windows VM check (one VM at a time): a check held for the PM, not a tester's.
   Isolation as in 1 (the VM's test user, a test-account Claude Code, no `openharness` before, the CLI built at the
   head). Steps 1–5 of check 1 (step 5 in a plain shell), plus: after step 1, `stat -c %a` on
   `plugins/harness-device/hooks/asked`, both in the Harness data folder's `claude-marketplace` and wherever
   `claude plugin list --json` says the plugin loads from, is `700`. Pass: those steps as stated, and the hook runs
   (`claude --debug` shows the PermissionRequest hook exit 0, no `Permission denied`).
3. **A Mac without the Command Line Tools: not possible here.** No such test Mac exists; the affected Mac is the
   owner's own. What stands in: `claudePlugin.spec.ts` (the add never names GitHub or `--sparse`, and asks for no git;
   `xcrun: error: invalid active developer path` reads `no xcode tools`), `dialPluginSetup.spec.ts` (no git lookup; the
   count carries the reason), `devices.spec.ts` (the log line), and `deviceDialSkill.e2e.ts` on `linux-e2e` (the local
   add through the fake). After release, the owner may check on their own Mac: `harness device claude status --json`
   says `installed: true`, and voice to a Claude Code session in Terminal says `Restart Claude Code for voice.` until
   the session restarts, then reaches it. **Needs the owner themselves** (their login, their eye).
4. **Local gates PR CI does not run** — need a PM Mac slot: `npm run test:core` (`src/services/devices.ts` is touched;
   100% per file), through `python3 scripts/local-checks.py --run` from a clean tree at the final commit, its receipts
   pasted into the PR. No GitHub workflow runs it.
5. **GitHub.** PR CI on its own: the CLI's Linux unit suite and typecheck, `windows-e2e` (x64, and arm64 since
   `windows.yml` changes: the new Windows specs run there), `linux-e2e` (the changed e2e files, the canary, the dial
   app eval's six files since `cable/hosts/` changes), `dial-hosts`. By hand, once, on the final head: the full CLI end
   to end (**Actions → CLI end to end → Run workflow**, `cli-e2e.yml`), as the caps change reaches e2e files the PR
   does not change. Proposal: none.

## Decisions from the PM (2026-11-26)

1. **`plugins/harness/`'s MCP file** is `.mcp.json` (Claude Code's), not `mcp.json` (Cursor's) (Task 2).
2. **`no git`** does not count a `git` right after a `.`, so `openharness.git` in a "repository not found" line is not
   `no git` (Task 3).
3. **`enable` in a build that carries no plugin** runs no `claude`, prints `This Harness build carries no Claude Code
   plugin.` and exits 1 (Task 5).
4. **`enable` that cannot write the folder** prints `Harness could not write Claude Code's plugin folder. (<code>)`
   (Tasks 3, 5).
5. **A dev version** goes through `extensionVersion`, e.g. `0.6.66-dev.g0123456+<hash>` (Task 2).
6. **The e2e readiness signal:** no product change. The e2e tests speak again while the dial says `Restart Claude Code
   for voice.`, within the existing 45 s waits (Task 8).
7. **A real Claude Code check on the Ubuntu VM** is added: `hooks/asked` stays executable after Claude Code installs
   from the local folder, and the hook runs. Done by the PM side on the final head with the Windows VM check; held for
   the PM, not a tester's (Verification 2).
