# Harness Device: Claude Code and Codex reach the dial with no setting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** ready. The draft's six questions were answered on 2026-11-17 (the spec's Decided, "Plan answers"): five as drafted; the skill's marker line changes (Task 1).

**Goal:** From the first dial attached on a computer, the devices service sets Claude Code and Codex up to ring it, once, with nothing to press; what the person removes stays removed; the menu-bar app has no agent rows.

**Architecture:**
- **Two records, one writer each**, in the daemon's data dir. `dial-setup.json` is the devices service's: a dial attached here once, the CLI version that last set Claude Code's plugin up, and the skills folders it wrote. `dial-skill.json` stays the `harness device` command's: what `disable` removed, and the folders `enable` wrote.
- **Three small parts in the devices' own process** (`cli/src/cable/`): the homes (the skill file, once a home), the plugin (once a computer, through Claude Code's own `claude plugin`), and one composer the service calls at its start, at a dial's attach and at each open scan.
- **Removal is read, never asked:** a recorded home whose skill is gone, a plugin recorded as set up that is no longer on, or `disable`'s mark. `enable` is the way back.
- **The app** loses its Claude Code and Codex rows and every `device claude|codex` call.

**Tech Stack:** TypeScript CLI and daemon (Node, vitest, `cli/`); Rust and Tauri 2 (`device-app/src-tauri`).

**Spec:** [docs/plans/2026-11-17-dial-agents-always-on-design.md](2026-11-17-dial-agents-always-on-design.md). It changes what [#4389's design](2026-11-16-dial-skill-every-home-design.md) built (CLI 0.6.58, Device 0.1.1).

## Base

- Branch `feat/dial-agents-always-on`, from `main` at `16a92abfab`. No release.
- Before the first task: `cd cli && npm ci`; `cd device-app/ui && npm ci && npm run build` (the app's binary embeds `ui/dist`). One `CARGO_TARGET_DIR` outside the repository compiles Tauri's dependencies once.
- Tasks name code by name, never by line. If a name below is gone, stop and report.
- A task that names failing tests is two commits: the tests, red, then the change. The message given is the second's.
- Never touched by a task, a test or a check: the person's daemon (port 18473), `~/.harness`, `~/.claude`, `~/.codex`, the running Harness Device app, and any Claude Code or Codex the person runs.

## Layers

| Files | Process | Gate |
|---|---|---|
| `cli/src/devices/dialSkill.ts`, `dialSkillFiles.ts`, `claudePlugin.ts` | shared by the `harness` command and the devices process | their specs (PR CI) |
| `cli/src/deviceClaude/command.ts`, `plugin.ts` | the `harness` command's own process | their specs |
| `cli/src/cable/dialHomeSetup.ts`, `dialPluginSetup.ts`, `dialSetup.ts`, `engineTally.ts`, `notices.ts` | the devices process | their specs |
| `cli/src/services/devices.ts` | the devices process | its spec; `npm run test:core`, 100% per file (local gate) |
| `device-app/src-tauri/src/*.rs` | Harness Device | `cargo test --locked` (PR CI on Linux, a Mac by hand) |

Nothing under `cli/src/core/` or `cli/src/harnessd/` changes, and `cli/src/architecture.coreFiles.txt` gains no line. `src/architecture.spec.ts` and `src/leanEntry.spec.ts` stay green.

## File structure

| File | Is |
|---|---|
| `cli/src/devices/dialSkillFiles.ts` | the two records: shapes, bounds, read and write |
| `cli/src/devices/dialSkill.ts` | one home's skill file: write, refresh, remove; whether an engine's homes get it |
| `cli/src/devices/claudePlugin.ts` (new, from `deviceClaude/plugin.ts`) | every `claude plugin` call: find, status, enable, disable, update |
| `cli/src/deviceClaude/plugin.ts` | what is left: `claudeSettingsPath`, `claudePluginOn` (the hook's and the mod's readers) |
| `cli/src/cable/dialHomeSetup.ts` (new, replaces `dialSkillWriter.ts`) | the skill in each home, once; owns `dial-setup.json` |
| `cli/src/cable/dialPluginSetup.ts` (new) | the plugin, once a computer, kept current, retried at most hourly |
| `cli/src/cable/dialSetup.ts` (new) | the order of the two at a start, an attach and a scan |
| `cli/src/cable/engineTally.ts` (new) | a day's counts per engine, said in the log |

## Global Constraints

- **When:** nothing is read from or written into an agent's home, and no `claude` is looked for, until a dial has attached on this computer once (`"dial": true` saved in `dial-setup.json`). From then on: at the devices service's start, at each attach, and at each open scan (60 s while a dial is attached).
- **Once:** a home's skill is written when its resolved skills folder is not in the record. The plugin is installed or enabled when the record has no `plugin`. Neither is done a second time by the service.
- **Removed stays removed:** a recorded folder whose skill file is gone is left alone; a plugin the record says was set up is never installed or enabled again; an engine `disable` marked gets nothing.
- **Kept current:** Harness's own skill file in a recorded folder whose bytes differ from `DIAL_SKILL` is written again; the plugin is brought current once after each CLI update. Never what was removed.
- **Failures:** counted and logged with a fixed reason word, never Claude Code's own text or a path; retried no sooner than 3 600 000 ms later; never a window.
- **`DIAL_SKILL`'s marker line**, exact: `# Written by Harness. Remove it with harness device claude disable or harness device codex disable.` The rest of `DIAL_SKILL` does not change.
- **Ours** is a regular file, not a link, at most 4 KiB, lines ending in `\n`, whose first line is `---` and one of whose lines before the next `---` starts with `# Written by Harness.` (the period included). One rule, no list of markers: the files 0.6.58 wrote (`# Written by Harness. Turn off the agent in Harness Device to remove it.`) are ours, so a write, a refresh or a `disable` treats them as Harness's. Anything else at the path is the person's: never written over, never removed. Harness's other files open `# Written by Harness,`, `# Written by Harness:` or `# Written by Harness (`, and none sits at `skills/dial/SKILL.md`.
- **Old answers:** the booleans `claude` and `codex` at the top of `dial-skill.json`, and all of `dial-skill-homes.json`, are never read. No branch reads, converts or deletes them; the command's next write of `dial-skill.json` leaves the booleans out.
- **Records:** 0600, written whole to a temp file and renamed; read with a 256 KiB bound; at most 64 folders an engine, each `listable`. A missing or damaged file reads as an empty record.
- **Claude Code is found** by `installedEngineBin('claude', await agentCommandOwnershipSnapshotAsync())` (`lib/engineBin.ts`, the lookup the daemon uses for its own agents, which reads the person's interactive PATH), in the devices process. Never by the app, never from the app's PATH.
- **Plugin calls**, fixed arguments, no shell: Claude Code 2.1.287 or later on macOS or Linux; `harness-device@openharness`; marketplace `autonomous-ai/openharness`; 60 s for a call that fetches, 15 s for the rest.
- **Windows:** nothing is written and nothing is run.
- **Logs and measures:** counts and fixed words only. Never a path, a home's name, a session, or a line an agent wrote.
- **Tests:** throwaway homes, data dirs and PATH; a fake `claude` (a `ClaudeRun` that answers from a table, or a script in a throwaway PATH). `services/devices.spec.ts`'s `start()` always passes a `claude` that finds none unless the test gives its own, so no test ever runs a `claude` from the developer's PATH.
- **Repo rules:** a test that fails first, no fixed sleeps, comments say why, copy short.

## Design (docs/feature-design-rules.md)

Reviewed revision: ______  Reviewer: ______

**What is stored.** Two local files of the person's own account, and the skill file (Harness's text) in each home.

```
dial-setup.json   {"dial":true,"plugin":"0.6.59","homes":{"claude":["/…/skills"],"codex":["/…/skills"]}}
dial-skill.json   {"removed":{"codex":true},"homes":{"claude":[],"codex":["/…/skills"]}}
```

1. **Growth.**

| Record | Made | Changed | Leaves | Made again |
|---|---|---|---|---|
| `dial` | first attach | never | with the data dir (`harness uninstall`) | next attach |
| `plugin` | the plugin is first set up | each CLI version that brings it current | with the data dir | the first attach after that, when Claude Code is found |
| a folder in `dial-setup.json` `homes` | the service wrote the skill there, or found exactly `DIAL_SKILL` there | never | its home is gone; or the engine is off (`disable`, or Claude Code's plugin off) and the skill was taken out | the home seen again while the engine is on |
| `removed.<engine>` | `disable` | never | `enable` | next `disable` |
| a folder in `dial-skill.json` `homes` | `enable` wrote it | never | `disable` removed the skill there | next `enable` |

   At most 64 folders an engine in each file; a full list writes no new home and counts `failed · full`. Every reader of all folders (the service's passes, `enable`, `disable`) reads at most 128 paths.
2. **Concurrency.** One writer a file: the devices process (single-threaded; the plugin's step saves through the homes' in-memory record) and the command. Whole-file rename, so a reader sees one version. Invariants: (a) no home is touched before `dial` is saved (Task 5); (b) a skill the service wrote is in the record, or taken out again when the record cannot be saved (carried over); (c) `disable` wins a race: its mark is read right before each write and again after it, and the plugin's install checks it again when it ends (Tasks 5, 7).
3. **Read cost.** A scan with every home handled: two `stat` calls (the stamp of `dial-skill.json` and Claude Code's `settings.json`) and, while a default home is missing, one `stat` for it; no file read, no process. Task 6 holds it with a test. A removal reaches the service through the stamp.
4. **Scale.** Ten times today's few homes fits the 64. The count that warns first: `failed` with `full` in the day's tally.
5. **Compatibility.** Readers of the new fields, by search: `readSetup` (homes setup; the command's `status`, `enable`, `disable`), `readRemoved` (the same). Device 0.1.1 with this CLI: its rows still run `status`, `enable` and `disable`, which keep their shape. This app with CLI 0.6.58: no rows, and the agents stay as that CLI's menu left them. No backend, relay, window or phone reads any of it.
6. **Migration and rollback.** None, and no order between the CLI and the app. Rolled back to 0.6.58: it never reads `dial-setup.json`; a `dial-skill.json` this command rewrote holds no boolean, which 0.6.58 reads as no answer (Claude Code follows its plugin, Codex is Off until **Turn on**). 0.6.58 knows only its own exact marker line, so a skill file this CLI wrote is the person's to it: left in place, neither rewritten nor removed by its Turn off. Production data: N/A because nothing is on a server; old-format files are test fixtures (Tasks 1, 5).
7. **Audience.** No server. The files are 0600 in the person's data dir. No path leaves the computer or reaches a log, the tally, the relay or the dial.
8. **Identity.** Everything runs as the daemon's OS user. A home another uid owns is refused (`owner`, carried over). `claude plugin` runs as that user and needs no sign-in.
9. **Failure.**

| Fails | Seen as | Recovers |
|---|---|---|
| plugin install or update (no network, old Claude Code) | `[device] dial setup · claude · failed · <reason>`, the day's `failed` | next scan an hour or more later; `harness device claude enable` prints Claude Code's own line |
| a home not writable, a full list, a record not saved | `[device] dial setup · codex · failed · write` (or `full`, `save`) | the same; nothing unrecorded is left written |
| `claude` not found | nothing | asked again at the next scan |
| a record damaged by hand | reads empty: the next attach sets up again, which can put back what was removed | written whole by rename, so Harness never damages it |

10. **Platforms.** macOS and Linux alike. Windows: nothing written, nothing run. The app's menu: macOS (and its Linux build).

## Review Focus

1. **The daemon was started from a shell that sets `CLAUDE_CONFIG_DIR`** (an Orca profile): the plugin must go into the home whose `settings.json` the service reads, not the shell's. Task 2 (`claudeFound … CLAUDE_CONFIG_DIR`).
2. **Claude Code installed with npm under a Node the daemon's PATH lacks** (launchd's bare PATH): `#!/usr/bin/env node` must still resolve. Task 2 (`… its folder first on PATH`).
3. **The person deletes the whole `skills` folder**, not only `dial/SKILL.md`: it is not made again. Task 6.
4. **`harness device claude disable` lands while the install runs** (up to a minute): the plugin is taken out again and nothing is recorded. Task 7.
5. **A `claude` older than 2.1.287, or one that answers nothing** (every end-to-end daemon's fake is 2.1.270): one `--version` call, no `plugin` call, one `failed · unsupported`, the next try an hour later. Tasks 2, 7.

## Tasks

| # | Task | Depends on | Effort |
|---|---|---|---|
| 1 | The two records and a home's refresh | none | xhigh |
| 2 | Claude Code's plugin, callable from the devices process | none | xhigh |
| 3 | The day's tally per engine, and `notify` in it | none | high |
| 4 | Harness Device: no agent rows | none | high |
| 5 | Homes: the record and the first attach | 1 | xhigh |
| 6 | Homes: removed stays removed, kept current | 5 | xhigh |
| 7 | The plugin, once a computer | 1, 2 | xhigh |
| 8 | The command: `disable` marks, `enable` brings back | 1, 2 | xhigh |
| 9 | Dial setup in the devices service | 3, 6, 7 | xhigh |
| 10 | The old names go | 8, 9 | medium |
| 11 | End to end | 8, 9 | high |

Longest chain: 1 → 5 → 6 → 9 → 10 (five). A task that shares a file with another depends on it: 5 and 6 (`dialHomeSetup.ts`); 2 and 8 (`command.ts`); 3 and 9 (`services/devices.ts`); 1 and 10.

---

### Task 1: The two records and a home's refresh

**Depends on:** none. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/devices/dialSkillFiles.ts`, `cli/src/devices/dialSkill.ts`
- Test: `cli/src/devices/dialSkillFiles.spec.ts`, `cli/src/devices/dialSkill.spec.ts`

Additive but for the marker line and the rule that knows it: nothing else existing changes or goes (Task 10 removes the old names once nothing calls them).

**Interfaces — Produces:**

```ts
// devices/dialSkillFiles.ts
export const DIAL_SETUP_FILE = 'dial-setup.json'
export const SETUP_COUNTS = ['set up', 'updated', 'failed', 'left removed'] as const
export type SetupCount = typeof SETUP_COUNTS[number]
/** What `harness device <engine> disable` removed; a key is absent when it removed nothing. */
export interface DialRemoved { claude?: true; codex?: true }
export interface DialSetupRecord { dial: boolean; plugin?: string; homes: DialSkillHomes }
export function readRemoved(dataDir: string): DialRemoved
/** undefined once saved, else the error's code. [written], when given, becomes the folders the command wrote for [engine]. */
export function writeRemoved(dataDir: string, engine: DialEngine, removed: boolean, written?: string[]): string | undefined
export function readSetup(dataDir: string): DialSetupRecord
export function writeSetup(dataDir: string, record: DialSetupRecord): string | undefined

// devices/dialSkill.ts
/** A recorded home: Harness's own file with other bytes is written again; one that is gone was removed by the person. */
export function refreshSkill(skills: string): 'updated' | 'same' | 'gone' | 'theirs' | 'failed'
/** Never once `disable` removed it; Codex otherwise; Claude Code while its plugin is on. */
export function skillWanted(engine: 'claude' | 'codex', removed: boolean, claudeSettings: string): boolean
// DIAL_SKILL: its marker line is the new one (Global Constraints); DIAL_SKILL_MARKER stays private.
```

- `marked()` (what `writeSkill`, `removeSkill` and `refreshSkill` all read through `held()`) matches a front-matter line that starts with `# Written by Harness.`, not the one exact line. `plugins/harness-device` ships no skill text (its hooks only), so nothing outside `dialSkill.ts` holds the line; the e2e files import `DIAL_SKILL`.

- `dial-skill.json` on disk: `{"removed":{"codex":true},"homes":{…}}`; `removed` and `homes` are left out when empty; `readWritten` is unchanged.
- `plugin` is kept only when it is a string matching `/^[0-9A-Za-z.+-]{1,64}$/`.

- [ ] **Step 1: Write the failing tests**

```ts
it('the old menu\'s answers are not read', () => {
  writeFileSync(join(dir, 'dial-skill.json'), '{"claude":false,"codex":true}')
  expect(readRemoved(dir)).toEqual({})
})
it('a removal is saved, cleared, and keeps the folders the command wrote; the old answers leave the file', () => {
  writeFileSync(join(dir, 'dial-skill.json'), '{"codex":false,"homes":{"claude":[],"codex":["/a/skills"]}}')
  expect(writeRemoved(dir, 'codex', true)).toBeUndefined()
  expect(JSON.parse(readFileSync(join(dir, 'dial-skill.json'), 'utf8'))).toEqual({ removed: { codex: true }, homes: { claude: [], codex: ['/a/skills'] } })
  writeRemoved(dir, 'codex', false, [])
  expect(JSON.parse(readFileSync(join(dir, 'dial-skill.json'), 'utf8'))).toEqual({})
})
it('a missing, damaged or oversized dial-setup.json is an empty record', () => {
  expect(readSetup(dir)).toEqual({ dial: false, homes: { claude: [], codex: [] } })
})
it('the record is written whole, 0600: the dial, the plugin\'s version, 64 listable folders an engine at most', …)
it('a plugin value that is no version is dropped', …)          // "plugin": true, "plugin": "../x"
it('refreshSkill writes Harness\'s own file again when its bytes differ', …)   // 'updated', the file is DIAL_SKILL
it('refreshSkill leaves a home whose skill is gone, and makes nothing', …)     // 'gone', no dial folder
it('refreshSkill leaves the person\'s own file', …)                             // 'theirs', bytes unchanged
it('skillWanted: Codex unless removed; Claude Code with its plugin on and not removed', …)
// dialSkill.spec.ts: MARKER becomes the new line; the old one is a fixture, OLD_MARKER
it('the skill\'s marker line names the disable commands', () => {
  expect(DIAL_SKILL.split('\n')[3]).toBe('# Written by Harness. Remove it with harness device claude disable or harness device codex disable.')
})
it('a file 0.6.58 wrote is ours: written over, refreshed, removed', () => {
  const old = `---\nname: dial\ndescription: older\n${OLD_MARKER}\n---\n\nOlder.\n`
  for (const [act, result] of [[writeSkill, 'written'], [refreshSkill, 'updated'], [removeSkill, 'removed']] as const) {
    const skills = skillsAt(); const path = skillOf(skills, old)
    expect(act(skills)).toBe(result)
    if (result !== 'removed') expect(readFileSync(path, 'utf8')).toBe(DIAL_SKILL)
    else expect(existsSync(path)).toBe(false)
  }
})
// 'leaves the person\'s file' gains, each 'theirs' to writeSkill, removeSkill and refreshSkill, bytes unchanged:
//   no front-matter line starting '# Written by Harness.'
//   '# Written by Harness, which rewrites it: do not edit.' (the Codex rules file's opening)
//   '# Written by Harness: …' and '# Written by Harness' with nothing after it
//   '  # Written by Harness. …' (indented: the line does not start with it)
//   '# Written by Harness. …' only in the body, after the closing '---' (carried over with the new line)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/dialSkillFiles.spec.ts src/devices/dialSkill.spec.ts`. Expected: FAIL (the names are not exported).
- [ ] **Step 3: Implement** the signatures above and the new marker line. `refreshSkill` shares `writeSkill`'s temp-file write; it reads through the same `held()`. `marked()` is a prefix match on a whole front-matter line, its comment saying why: one rule knows every release's line.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: where a dial's setup and a removal are kept, a home's skill refreshed, and its line names disable`.

### Task 2: Claude Code's plugin, callable from the devices process

**Depends on:** none. **Effort:** xhigh.

**Files:**
- Create: `cli/src/devices/claudePlugin.ts`, `cli/src/devices/claudePlugin.spec.ts`
- Modify: `cli/src/deviceClaude/plugin.ts`, `cli/src/deviceClaude/plugin.spec.ts` (keep only `claudeSettingsPath`, `claudePluginOn` and their tests), `cli/src/deviceClaude/command.ts` and `command.spec.ts` (imports only), `cli/src/cli.ts` (import only)

Why it moves: `command.spec.ts` holds that no file under `core/`, `services/` or `cable/` imports `deviceClaude/`, and the devices process must now make these calls. That test stays as it is.

**Interfaces — Produces** (`devices/claudePlugin.ts`; `MARKETPLACE`, `MIN_CLAUDE`, `ClaudeRun`, `ClaudeDeps`, `ClaudeStatus`, `claudeRun`, `claudeStatus` move unchanged):

```ts
export type ClaudeStep = 'unsupported' | 'marketplace' | 'install' | 'enable' | 'uninstall' | 'update'
export type ClaudeResult = { ok: true } | { ok: false; error: string; step: ClaudeStep }
export type ClaudeUpdate = { ok: true; outcome: 'updated' | 'current' | 'absent' } | { ok: false; error: string; step: ClaudeStep }
/** [bin] run with no shell, its stdin closed; [env] the child's environment, the process's own by default. */
export function claudeRunner(bin: string, env?: NodeJS.ProcessEnv): ClaudeRun
/** Claude Code as the daemon finds it for its own agents; null when it is not on this computer or the lookup failed. */
export function claudeFound(home: string): Promise<ClaudeRun | null>
export function claudeEnable(deps: ClaudeDeps): Promise<ClaudeResult>
export function claudeDisable(deps: ClaudeDeps): Promise<ClaudeResult>
export function claudeUpdate(deps: ClaudeDeps): Promise<ClaudeUpdate>
```

- `claudeEnable` and `claudeUpdate` ask `--version` first and run nothing more when it is not supported (`step: 'unsupported'`). `claudeStatus` still asks both, for `status`.
- `claudeUpdate`: no user-scope entry, or one not enabled: `absent`, nothing run. Else `plugin marketplace update openharness` (60 s; fails as `marketplace`), `plugin update harness-device@openharness --scope user` (60 s; fails as `update`), then `plugin list --json`: `updated` when the entry's `version` differs from before, else `current`.
- `claudeFound(home)`: the lookup in Global Constraints. The child's `PATH` is the folder `claude` is in, then the process's own. Its `CLAUDE_CONFIG_DIR` is `home`, or absent when `home` is `join(homedir(), '.claude')`, whatever the daemon's own environment holds.
- The file's header says: the command's process and the devices' process; never the core's.

- [ ] **Step 1: Write the failing tests** in `devices/claudePlugin.spec.ts` (the moved cases come with their `fakeClaude` helper):

```ts
it('enable with an old Claude Code asks its version and nothing else', async () => {
  const claude = fakeClaude({}, '2.1.286 (Claude Code)')
  expect(await claudeEnable({ run: claude.run, platform: 'darwin' }))
    .toEqual({ ok: false, error: 'Claude Code 2.1.287 or later is needed.', step: 'unsupported' })
  expect(claude.calls.map((call) => call.args)).toEqual(['--version'])
})
it('a failure names its step', …)   // marketplace add → 'marketplace'; install → 'install'; plugin enable → 'enable'; uninstall → 'uninstall'
it('update pulls the marketplace, then the plugin, and is updated when its version changed', async () => {
  // plugin list --json answers version '16a92abfab3f' before and '9f2c1d0e7a4b' after
  expect(claude.writes()).toEqual(['plugin marketplace update openharness', 'plugin update harness-device@openharness --scope user'])
  expect(result).toEqual({ ok: true, outcome: 'updated' })
})
it('update with the same version after is current', …)
it('update of a plugin the person uninstalled or disabled runs nothing: absent', …)   // writes() is []
it('claudeFound runs the claude the lookup finds, its folder first on PATH, CLAUDE_CONFIG_DIR naming the home', …)
it('claudeFound with ~/.claude as the home passes no CLAUDE_CONFIG_DIR, though the process has one', …)
it('claudeFound is null when no claude is found', …)
```

  The three `claudeFound` cases use a script in a throwaway folder that prints `$CLAUDE_CONFIG_DIR` and the first entry of `$PATH`, with `PATH` and `HOME` stubbed to that folder, as `plugin.spec.ts`'s `throwawayPath()` does today.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/claudePlugin.spec.ts`. Expected: FAIL (no such file).
- [ ] **Step 3: Implement.** Move the code, then add the three new functions and the `step` on each failure.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/devices/claudePlugin.spec.ts src/deviceClaude && npx tsc --noEmit`. Expected: PASS, no type error.
- [ ] **Step 5: Commit** `Dial: Claude Code's plugin calls, for the command and the devices alike`.

### Task 3: The day's tally per engine, and `notify` in it

**Depends on:** none. **Effort:** high.

**Files:**
- Create: `cli/src/cable/engineTally.ts`, `cli/src/cable/engineTally.spec.ts`
- Modify: `cli/src/lib/notifyTier.ts`, `cli/src/cable/notices.ts`, `cli/src/services/devices.ts`
- Test: `cli/src/cable/notices.spec.ts`, `cli/src/services/devices.spec.ts`; `cli/src/lib/notifyTier.spec.ts` stays green unchanged

The existing measure is `createTally` (`lib/notifyTier.ts`): one line an event, then the person's local day's running counts, read from the log. This is the same, per engine.

**Interfaces — Produces:**

```ts
// lib/notifyTier.ts: the day createTally already uses, shared
export function localDay(at: number): string          // local YYYY-MM-DD
// cable/engineTally.ts
export function createEngineTally<E extends string, K extends string>(label: string, engines: readonly E[],
  kinds: readonly K[], log: (line: string) => void, now?: () => number): (engine: E, kind: K, reason?: string) => void
// cable/notices.ts: NoticesDeps.log goes; in its place
count(engine: 'claude' | 'codex' | 'agent', result: NoticeResult): void
```

Lines, exact (a new local day starts every count at 0; the reason is on the event's line only):

```
[device] notify · claude · shown
[device] notify · day 2026-11-17 · claude shown 1 no dial 0 limited 0 · codex shown 0 no dial 0 limited 0 · agent shown 0 no dial 0 limited 0
[device] dial setup · claude · failed · install
[device] dial setup · day 2026-11-17 · claude set up 0 updated 0 failed 1 left removed 0 · codex set up 2 updated 0 failed 0 left removed 0
```

`services/devices.ts` gives `Notices` `count: createEngineTally('[device] notify', ['claude', 'codex', 'agent'], ['shown', 'no dial', 'limited'], log)`. `agent` is a caller that is neither, as today's line names it.

- [ ] **Step 1: Write the failing tests**

```ts
// engineTally.spec.ts
it('an event is one line, then the day\'s counts for every engine', …)   // the two notify lines above, exactly
it('a new local day starts at zero', …)                                    // now() moved past local midnight
it('a reason is on the event\'s line and not the day\'s', …)
// notices.spec.ts: the three existing log expectations become
expect(counted).toEqual([['claude', 'shown'], ['claude', 'limited'], ['agent', 'no dial']])
// devices.spec.ts
it('a notice is counted in the day\'s tally, by engine', () => {
  expect(logs).toContain('[device] notify · agent · no dial')
  expect(logs).toContainEqual(expect.stringMatching(/^\[device\] notify · day \d{4}-\d\d-\d\d · claude shown 0 no dial 0 limited 0 · codex shown 0 no dial 0 limited 0 · agent shown 0 no dial 1 limited 0$/))
})
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/engineTally.spec.ts src/cable/notices.spec.ts src/services/devices.spec.ts`. Expected: FAIL in the new cases.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/engineTally.spec.ts src/cable/notices.spec.ts src/lib/notifyTier.spec.ts src/services/devices.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: a day's tally per engine, with what notify answered`.

### Task 4: Harness Device: no agent rows

**Depends on:** none. **Effort:** high.

**Files:**
- Modify: `device-app/src-tauri/src/model.rs`, `types.rs`, `app.rs`, `runner.rs`, `main.rs`, `cli.rs`, `lib.rs`
- Delete: `device-app/src-tauri/src/engine.rs`
- Docs: `desktop/design/desktop-design-system.md`, `device-app/AGENTS.md`, `device-app/RELEASE.md`, `docs/plans/2026-11-13-device-menubar-design.md`, `docs/naming-system.md`

What goes, with its tests: `engine.rs`; `ClaudeStatus`, `CodexStatus`, `EngineChange`; `MenuAction::{ClaudeOn, ClaudeOff, CodexOn, CodexOff}` and their menu ids; `AppState.{claude, codex, claude_change, codex_change}`; `Event::{Claude, Codex, ClaudeSet, CodexSet}`; `Effect::{ReadClaude, ReadCodex, SetClaude, SetCodex}`; `engine_rows`, `available`, `codex_available`, `set_claude`, `set_codex`; `CHANGE_DEADLINE`. `relaunch_waits` no longer names an engine change, and `STATUS_DEADLINE`'s comment names `auth status` alone. `Saved` and `state.rs` do not change: an old file's `askedClaude` and `askedCodex` are still ignored. The window (`device-app/ui`) and its gallery do not change: neither draws a menu row.

The menu, exact (a row with nothing to say is absent, as today):

```
Dial connected · 0.1.0
Signed in
✓ Sound
  Notifications ▸
─────────────
  Open Harness
  Quit
```

- [ ] **Step 1: Write the failing tests** (they compile against today's types):

```rust
// model.rs
#[test]
fn the_whole_menu() {
    assert_eq!(menu(&state()), vec![
        text("Dial connected · 0.0.95"), text("Signed in"), Separator,
        act(MenuAction::OpenHarness, "Open Harness"), act(MenuAction::Quit, "Quit"),
    ]);
}
#[test]
fn no_agent_rows_in_any_state() {
    // every CliState × Daemon × dial (none, attached, with Sound and Notifications) × signed_in
    for state in states() {
        let line = menu_log(&menu(&state));
        for word in ["Claude Code", "Codex", "Turn on", "Turn off", "Turning"] {
            assert!(!line.contains(word), "{line}");
        }
    }
}
// the_menu_as_a_log_line
"Dial connected · 0.0.95 | Signed in | Sound ✓ | Notifications: All | Open Harness | Quit"
// runner.rs, from_start_to_dial_connected
assert!(w.fake.calls().iter().all(|call| !call.starts_with("device ")));
// main.rs, every_menu_action_has_its_own_id
assert_eq!(ids.len(), 9);
```

- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked`. Expected: FAIL on those tests.
- [ ] **Step 3: Implement.** Remove the rows, then everything in the list above that the compiler and `cargo clippy --all-targets -- -D warnings` then name as unused. Every other test that named an agent row or call is deleted or loses that row. `cli.rs`'s process-kill test keeps an argv the fake has no script for, not `device claude status`.
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test --locked && cargo clippy --all-targets -- -D warnings && grep -rn "claude\|codex" src --include="*.rs" -i`. Expected: PASS; the grep shows no status, row, action or call: only the lines that say an old state file's `askedClaude` and `askedCodex` are ignored (`state.rs`, `types.rs`) and `account.rs`'s comment.
- [ ] **Step 5: Docs.**
  - `desktop/design/desktop-design-system.md`, Harness Device: the opening says "Claude Code and Codex need no setting: Harness sets them up once a dial is plugged in." The bullet "An agent in the menu is a disabled status row…" goes. The menu sketch above is added under "Its menu is the native menu."
  - `device-app/AGENTS.md`: the first paragraph ends "…and offers sign-in once. It has no row for Claude Code or Codex: the devices service sets them up."
  - `device-app/RELEASE.md`: "a Claude Code change or" leaves the relaunch sentence.
  - `docs/plans/2026-11-13-device-menubar-design.md`: every line that says the menu turns Claude Code or Codex on or off (goal 3, the screens list, the `engine.rs` line, the Claude Code section, the Menu table's two rows, Window and UI, Testing) says there is no row, and links this design.
  - `docs/naming-system.md`, Harness Device: "its status, sign-in, Sound and Notifications".
- [ ] **Step 6: Commit** `Harness Device: no Claude Code or Codex rows`.

### Task 5: Homes: the record and the first attach

**Depends on:** 1. **Effort:** xhigh.

**Files:**
- Create: `cli/src/cable/dialHomeSetup.ts`, `cli/src/cable/dialHomeSetup.spec.ts`

Start from a copy of `cable/dialSkillWriter.ts` and its spec, which stay wired until Task 9 deletes them. Every case of the old spec is carried over with the new deps, except those the tests below change: where it set On it writes `dial-setup.json` with `dial: true`, where it set Off it calls `writeRemoved(dataDir, engine, true)`, and where it read the list it reads `readSetup(dataDir).homes`.

**Interfaces:**
- Consumes (Task 1): `readSetup`, `writeSetup`, `readRemoved`'s type `DialRemoved`, `skillWanted`, `readWritten`.
- Produces:

```ts
export interface DialHomeSetupDeps {
  dataDir: string; platform: NodeJS.Platform; uid: number
  claudeHome: string; codexHome: string
  adopted(): { claude: string[]; codex: string[] }
  /** dial-skill.json's removals, read anew at each call. */
  removed(): DialRemoved
  log(line: string): void
}
export interface DialHomeSetup {
  started(): void
  /** The first dial of the fleet attached. */
  attached(): void
  scanned(owners: Iterable<RolloutOwner>): void
  /** A dial attached here once, and `disable` has not removed [engine]. */
  wanted(engine: DialEngine): boolean
  /** The CLI version that last set the plugin up or brought it current; undefined: never on this computer. */
  plugin(): string | undefined
  /** false when the record could not be saved. */
  recordPlugin(version: string): boolean
}
export function createDialHomeSetup(deps: DialHomeSetupDeps): DialHomeSetup
```

Rules that differ from the old writer:
- The record is `dial-setup.json` (`readSetup`, `writeSetup`); `dial-skill-homes.json` is never read.
- Without `dial` in the record, `started()` and `scanned()` do nothing: no home is looked at.
- `attached()` saves `dial: true` when the record lacks it, before anything else; a save that fails logs `dial setup: record not saved` and does nothing more. Then it runs the start pass.
- An engine is on when `dial` is recorded and `skillWanted(engine, removed()[engine] === true, <claudeHome>/settings.json)`. Not on is handled as the old Off: ours taken out of every folder it may be in, the record emptied for that engine but for a failed removal.
- A save of the homes keeps `dial` and `plugin`; `recordPlugin` keeps `dial` and the homes.

- [ ] **Step 1: Write the failing tests**

```ts
it('a computer that never had a dial gets nothing: a start and a scan write no skill and no record', () => {
  const { writer, codexHome, dataDir } = rig()
  writer.started(); writer.scanned([ownerIn(other)])
  expect(existsSync(join(codexHome, 'skills'))).toBe(false)
  expect(existsSync(join(dataDir, 'dial-setup.json'))).toBe(false)
})
it('the first attach records the dial, then writes Codex\'s default and adopted homes, with no answer anywhere', () => {
  writer.attached()
  expect(readSetup(dataDir)).toEqual({ dial: true, homes: { claude: [], codex: sorted([skillsOf(codexHome), skillsOf(adopted)]) } })
})
it('a record that cannot be saved at the first attach writes nothing', …)        // read-only data dir
it('once a dial attached, a start sets up with no dial attached', …)             // dial-setup.json {"dial":true}
it('the old menu\'s false is not a removal, and its homes list is not read', …)  // dial-skill.json {"codex":false}; dial-skill-homes.json listing a home
it('Claude Code\'s homes are written only while its plugin is on', …)
it('disable\'s removal takes the skill out of every recorded home and empties that engine\'s record', …)   // writeRemoved(dataDir, 'codex', true)
it('the plugin\'s version is saved beside the dial and the homes, and a home recorded later keeps it', () => {
  expect(writer.recordPlugin('0.6.59')).toBe(true)
  expect(readSetup(dataDir).plugin).toBe('0.6.59')
})
it('wanted: not before a dial, not after disable', …)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/dialHomeSetup.spec.ts`. Expected: FAIL (no such file).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS, the carried cases too.
- [ ] **Step 5: Commit** `Dial: homes are set up from the first dial attached, with no answer asked`.

### Task 6: Homes: removed stays removed, kept current

**Depends on:** 5. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/cable/dialHomeSetup.ts`, `cli/src/cable/dialHomeSetup.spec.ts`

**Interfaces:**
- Consumes (Task 1): `refreshSkill`, `SetupCount`.
- Produces: `DialHomeSetupDeps` gains

```ts
now(): number                                                           // monotonic ms
count(engine: DialEngine, kind: SetupCount, reason?: string): void
```

Rules:
- A recorded folder is refreshed, never written anew (`refreshSkill`): `updated` counts `updated`; `gone` is left alone, stays recorded, and counts `left removed` once a run; `theirs` and `same` count nothing.
- A recorded folder that is gone leaves the record only when its home (its parent folder) is gone too. With the home still there it stays recorded, nothing is made, and it counts `left removed` once a run.
- A new home: `written` counts `set up`; exactly `DIAL_SKILL` already there is recorded and counts nothing.
- Each scan looks at the default home of each engine that is on and neither handled nor refused: one `stat`, then a new home's write when it is there.
- Refused homes are tried again once the refused set is 3 600 000 ms old; each try that fails counts `failed` with `write`, `full` or `save`.
- An engine `disable` removed counts `left removed` once, until `dial-skill.json` changes.
- The pass's line (`dial skill: claude wrote …`) stays; `updated` counts as wrote.

- [ ] **Step 1: Write the failing tests**

```ts
it('a recorded home whose skill was deleted is not written again: at a start, an attach and a scan', () => {
  rmSync(skillFile(home))
  writer.started(); writer.attached(); writer.scanned([ownerIn(home)])
  expect(existsSync(skillFile(home))).toBe(false)
  expect(counted).toEqual([['codex', 'left removed']])
})
it('a recorded home whose skills folder was deleted is not made again while its home is there', …)
it('a recorded folder whose home is gone leaves the record, and that home made again is a new home', …)
it('0.6.58\'s file, the old marker line, in a recorded home is written again', …)       // the file is DIAL_SKILL; counted [['codex', 'updated']]
it('a new home counts set up; one already holding DIAL_SKILL is recorded and counts nothing', …)
it('a Codex default home that appears after the start is written at the next scan', …)
it('a home that could not be written is tried again no sooner than an hour later', () => {
  // now() at 0: failed · write. At 3_599_999: no call into the home. At 3_600_000: tried again.
})
it('once the removal is cleared in dial-skill.json, the next scan writes that engine\'s homes again', …)   // enable's path
it('an engine disable removed counts left removed once', …)
it('a scan with every home handled does no file work but the two stamps', …)     // as the old spec's "a known home costs no file work"
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/dialHomeSetup.spec.ts`. Expected: FAIL on the new cases.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: a home's removed skill stays removed, and Harness's own is kept current`.

### Task 7: The plugin, once a computer

**Depends on:** 1, 2. **Effort:** xhigh.

**Files:**
- Create: `cli/src/cable/dialPluginSetup.ts`, `cli/src/cable/dialPluginSetup.spec.ts`

**Interfaces:**
- Consumes: `claudeEnable`, `claudeDisable`, `claudeUpdate`, `ClaudeRun` (Task 2); `SetupCount` (Task 1).
- Produces:

```ts
export interface DialPluginSetupDeps {
  platform: NodeJS.Platform
  /** This CLI's version. */
  version: string
  claude(): Promise<ClaudeRun | null>
  /** A dial attached here once, and `disable` has not removed Claude Code; read anew at each call. */
  wanted(): boolean
  recorded(): string | undefined
  record(version: string): boolean
  now(): number
  count(kind: SetupCount, reason?: string): void
}
/** One pass at a time; never rejects. true: this pass installed, enabled or updated the plugin. */
export interface DialPluginSetup { pass(): Promise<boolean> }
export function createDialPluginSetup(deps: DialPluginSetupDeps): DialPluginSetup
```

A pass, in order; each line that returns runs nothing after it:
1. Windows, a pass already running, `!wanted()`, `now()` before the retry time, or `recorded() === version`: false. No lookup, no process.
2. `claude()` is null: false. Nothing counted: it is asked again at the next pass.
3. Nothing recorded: `claudeEnable`. On ok, `wanted()` is read again: false now means a `disable` landed, so `claudeDisable` runs and nothing is recorded. Else `record(version)`, count `set up`, true.
4. Another version recorded: `claudeUpdate`. `updated`: record, count `updated`, true. `current`: record, false. `absent`: record, count `left removed`, false.
5. A failure (a result's `step`; `save` when the record is not saved; `error` for a throw): count `failed` with that word, and the retry time is `now() + 3_600_000`.

- [ ] **Step 1: Write the failing tests**

```ts
it('installs once, records this CLI\'s version and counts set up', async () => {
  expect(await setup.pass()).toBe(true)
  expect(claude.writes()).toEqual(['plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins', 'plugin install harness-device@openharness --scope user'])
  expect(recorded).toBe('0.6.59'); expect(counted).toEqual([['set up']])
  await setup.pass()
  expect(claude.calls).toHaveLength(before)          // nothing more is run
})
it('a computer that never had a dial, or a removed Claude Code: no lookup', …)      // claude() never called
it('claude appearing later is set up at the next pass', …)                          // null, then a run
it('a plugin the person uninstalled is not installed again', …)                     // recorded '0.6.59', version '0.6.59': no call
it('after a CLI update the plugin is brought current once', …)                      // recorded '0.6.58' → update → '0.6.59', [['updated']]
it('after a CLI update an uninstalled plugin is left removed, and asked no more', …) // absent → [['left removed']], recorded '0.6.59'
it('a failed install is counted with its step and tried no sooner than an hour later', async () => {
  // install exits 1 → [['failed', 'install']]; at 3_599_999 no call; at 3_600_000 the calls run again
})
it('an old Claude Code: one --version, failed · unsupported', …)
it('disable landing while the install runs: the plugin is uninstalled again, nothing recorded', …)
it('two passes at once run one install', …)
it('a record that is not saved is failed · save', …)
it('on Windows nothing is looked for', …)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/dialPluginSetup.spec.ts`. Expected: FAIL (no such file).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: Claude Code's plugin is set up once a computer, and kept current`.

### Task 8: The command: `disable` marks, `enable` brings back

**Depends on:** 1, 2. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/deviceClaude/command.ts`, `cli/src/deviceClaude/command.spec.ts`, `docs/cli.md`, `plugins/harness-device/README.md`

**Interfaces — Consumes (Tasks 1, 2):** `readRemoved`, `writeRemoved`, `readSetup`, `readWritten`, `skillWanted`; `claudeEnable`, `claudeDisable`, `claudeStatus`. `DeviceDeps` and `cli.ts` do not change.

- `disable`: `writeRemoved(dataDir, engine, true)` first; Claude Code's plugin uninstalled; ours removed from the default home's folder, each folder `enable` wrote and each folder in `readSetup(dataDir).homes[engine]`. Each step runs whatever the one before did; the first error is printed; `homes` keeps only a folder whose removal failed.
- `enable`: Claude Code's plugin first, as today. Then `writeRemoved(dataDir, engine, false)` before anything is made; the default home's folder recorded, then written; then the skill written into each folder of `readSetup(dataDir).homes[engine]` that is a directory of this user's, so what the person removed comes back.
- The other engine holds its skill in a folder (so a shared one keeps it) when `skillWanted(other, …)` and a dial attached here once or `enable` wrote a folder for it.
- `status`: Claude Code `enabled` is the plugin on and not removed. Codex `enabled` is not removed, and a dial attached here once or `enable` wrote a folder.
- `DEVICE_USAGE`, exact:

```
Harness device (with a dial plugged in, Claude Code and Codex are set up to ring it; these take that away or bring it back):
  harness device claude status [--json]  whether the dial is on for Claude Code (its harness-device plugin on, and not removed), and its version
  harness device claude enable           set Claude Code up again: the plugin and the dial skill (Claude Code 2.1.287 or later)
  harness device claude disable          remove the plugin and the dial skill; Harness leaves them removed
  harness device codex status [--json]   whether the dial is on for Codex
  harness device codex enable            set Codex up again: the dial skill in its homes
  harness device codex disable           remove the dial skill Harness wrote; Harness leaves it removed
```

- [ ] **Step 1: Write the failing tests**

```ts
it('disable marks the removal before it removes, and status reads off', async () => {
  expect((await device(['codex', 'disable'], { dataDir })).code).toBe(0)
  expect(answers(dataDir)).toEqual({ removed: { codex: true } })
  expect(JSON.parse((await device(['codex', 'status', '--json'], { dataDir })).out[0]).enabled).toBe(false)
})
it('enable clears the removal and writes the skill back into every recorded home the person cleared', …)   // dial-setup.json lists two homes, both without a skill
it('disable removes the skill from the homes the devices service recorded', …)                              // dial-setup.json, not dial-skill-homes.json
it('codex status: on once a dial attached or enable wrote; the old menu\'s false is not read', …)
it('claude status: on with the plugin on and no removal', …)
it('disable keeps the skill in a folder the other engine holds it in', …)
it('a failing step still runs the rest', …)                                                                   // carried over, with the removal mark
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/deviceClaude/command.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Then `docs/cli.md`'s two rows say what `status`, `enable` and `disable` now do and that setup is automatic from the first dial; `plugins/harness-device/README.md` says the same in one line above `harness device claude enable`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: disable marks a removal Harness leaves alone, and enable brings it back`.

### Task 9: Dial setup in the devices service

**Depends on:** 3, 6, 7. **Effort:** xhigh.

**Files:**
- Create: `cli/src/cable/dialSetup.ts`, `cli/src/cable/dialSetup.spec.ts`
- Modify: `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts`, `cli/AGENTS.md` (the devices row of The processes)
- Delete: `cli/src/cable/dialSkillWriter.ts`, `cli/src/cable/dialSkillWriter.spec.ts`

**Interfaces:**
- Consumes: `createDialHomeSetup` (Task 6), `createDialPluginSetup` (Task 7), `createEngineTally` (Task 3), `claudeFound` (Task 2), `readRemoved`, `SETUP_COUNTS` (Task 1), `VERSION` (`cli/src/version.ts`).
- Produces:

```ts
// cable/dialSetup.ts
export interface DialSetupDeps extends DialHomeSetupDeps {
  /** Claude Code as the daemon finds it, for this Claude Code home. */
  claude(home: string): Promise<ClaudeRun | null>
  version: string
}
export interface DialSetup {
  started(): Promise<void>
  attached(): Promise<void>
  scanned(owners: Iterable<RolloutOwner>): Promise<void>
}
export function createDialSetup(deps: DialSetupDeps): DialSetup
// services/devices.ts: DevicesDeps gains
claude?: (home: string) => Promise<ClaudeRun | null>        // claudeFound by default
```

- A moment is the homes first, then the plugin's pass; when that pass returns true the homes are looked at once more (`scanned([])`), so Claude Code's skill follows its plugin in the same moment.
- The plugin's deps come from the homes: `wanted: () => homes.wanted('claude')`, `recorded: () => homes.plugin()`, `record: (version) => homes.recordPlugin(version)`, `claude: () => deps.claude(deps.claudeHome)`, `count: (kind, reason) => deps.count('claude', kind, reason)`.
- `services/devices.ts`: `createDialSetup` where `createDialSkillWriter` was, only with a listener as today, under the part name `skill`; `removed: () => readRemoved(core.dataDir)`, `now: monotonic`, `count: createEngineTally('[device] dial setup', ['claude', 'codex'], SETUP_COUNTS, log)`. `watching(true)` calls `attached()` before `dialAttached(on)`, so the scan the attach starts finds the dial recorded.
- The spec's `start()` passes `claude: over.claude ?? (async () => null)`; one case leaves it out, with `PATH` and `HOME` stubbed to an empty throwaway folder.

- [ ] **Step 1: Write the failing tests**

```ts
// dialSetup.spec.ts: throwaway homes, a fake claude whose install writes the plugin's entry into <claudeHome>/settings.json
it('the first attach sets Codex\'s homes up and installs the plugin, and Claude Code\'s skill follows in the same moment', async () => {
  await setup.attached()
  expect(hasSkill(codexHome)).toBe(true)
  expect(claude.writes()).toContain('plugin install harness-device@openharness --scope user')
  expect(hasSkill(claudeHome)).toBe(true)
  expect(readSetup(dataDir)).toMatchObject({ dial: true, plugin: '0.6.59' })
})
it('a computer that never had a dial gets nothing, and claude is not looked for', …)     // started(), scanned([])
it('claude appearing later is set up at the next scan', …)
it('a plugin uninstalled through /plugin is not installed again, and its skill goes', …)  // the entry leaves settings.json
it('disable, then a scan: nothing is written and nothing is run', …)
it('enable after a removal: the next scan writes Codex\'s other homes again', …)
it('a failed install is tried again no sooner than an hour later', …)
// devices.spec.ts
it('a dial\'s first attach sets the agents up', …)                 // seen.host.watching!(true): the Codex home's skill, the fake claude's install, '[device] dial setup · codex · set up' and its day line in the log
it('the devices\' start on a computer that never had a dial writes nothing', …)
it('a scan\'s owners reach the dial setup', …)                     // carried over
it('with no claude given, the daemon\'s own lookup is used and finds none', …)
it('with the devices inside the core nothing is set up', …)        // carried over
it('a dial setup that fails costs the dial nothing', …)            // carried over, fault `skill`
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/dialSetup.spec.ts src/services/devices.spec.ts`. Expected: FAIL in the new cases.
- [ ] **Step 3: Implement,** delete the old writer and its spec, and write the devices row of `cli/AGENTS.md`: from the first dial attached on this computer, the dial skill in each Claude Code and Codex home and Claude Code's `harness-device` plugin, once (`cable/dialSetup.ts`), recorded in `dial-setup.json`.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable src/services/devices.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Numbers for the pull request.** On this Mac, with a throwaway PATH that holds no `claude`: the time of one `claudeFound()` call, median of 20, and of one `scanned([])` with every home handled. Both go in the pull request beside the 60 s interval they run at.
- [ ] **Step 6: Commit** `Dial: from the first dial attached, the devices set Claude Code and Codex up`.

### Task 10: The old names go

**Depends on:** 8, 9. **Effort:** medium.

No behavior change: one commit, no red test.

**Files:**
- Modify: `cli/src/devices/dialSkillFiles.ts`, `cli/src/devices/dialSkillFiles.spec.ts`, `cli/src/devices/dialSkill.ts`, `cli/src/devices/dialSkill.spec.ts`

- [ ] **Step 1:** Remove `DIAL_SKILL_HOMES_FILE`, `DialSkillAnswers`, `readAnswers`, `writeAnswer`, `readHomes`, `writeHomes` and `skillOn`, with their spec cases. Both files' headers say what each record is now.
- [ ] **Step 2: Run** `cd cli && grep -rn "readAnswers\|writeAnswer\|readHomes\|writeHomes\|skillOn\|DIAL_SKILL_HOMES_FILE\|DialSkillAnswers\|dialSkillWriter" src; npx tsc --noEmit && npx vitest run src/devices src/deviceClaude src/cable/dialHomeSetup.spec.ts`. Expected: the grep prints nothing; PASS.
- [ ] **Step 3: Commit** `Dial: the On answers and the homes list are gone`.

### Task 11: End to end

**Depends on:** 8, 9. **Effort:** high.

The proof on a real daemon; it changes no behavior: one commit, no red test.

**Files:**
- Modify: `cli/e2e/deviceDialSkill.e2e.ts`, `cli/e2e/harness/fakeEngine.mjs`, `cli/e2e/harness/daemon.ts`

- `fakeEngine.mjs`: `claude plugin …` is answered as Claude Code 2.1.326 answers it and is never a launch (nothing in `launch-argv`): `list --json`, `marketplace list --json`, `marketplace add`, `marketplace update`, `install`, `enable`, `uninstall`, `update`. Its state is a file under the daemon's root; each call is appended to `<root>/claude-plugin-calls`; install, enable and uninstall write `enabledPlugins` in the `settings.json` of `CLAUDE_CONFIG_DIR`, else of the fake's Claude home. Anything outside the root throws, as the fake's `codex queue` does.
- `daemon.ts`: `DaemonOptions.claudeVersion?: string`, handed to the Claude shim as `version`.
- The file's cases, each on a daemon of its own with a fake dial (`Desk`), the `lsof` filter it has today, and `claudeVersion: '2.1.287'`:
  1. A dial's first attach, with no command run: the Codex home and the Claude Code home hold `DIAL_SKILL`; the call ledger has `plugin install harness-device@openharness --scope user`; `dial-setup.json` has `dial: true` and a `plugin`; the log has a `[device] dial setup · day ` line.
  2. A Codex in another home is set up once the scan sees its rollout; a person's own `dial` skill there stays; its skill deleted and the dial plugged in again: still deleted. `device codex disable` removes every copy and `dial-skill.json` is `{"removed":{"codex":true}}`; plugged in again: nothing written. `device codex enable`: every home has it again.
  3. `claude plugin uninstall harness-device@openharness --scope user`, run as the person would: after the next attach the ledger holds no second install and the Claude Code home holds no skill.
  4. With `E2E_REAL_CODEX`: a real Codex's home is set up, with no `enable`.
  - No line of the log that holds `dial s` holds the root's path.

- [ ] **Step 1: Write** the fake's `plugin` branch and the four cases.
- [ ] **Step 2: Run** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceDialSkill.e2e.ts e2e/deviceNotify.e2e.ts e2e/deviceCodex.e2e.ts`. Expected: PASS (the other two plug a dial too, and now have their throwaway Codex home set up).
- [ ] **Step 3: Commit** `Dial: setup from the first attach, end to end`.

---

## Verification

PR CI runs by itself on the pull request and needs no start: `cli-typecheck`, `cli-tests`, `companions` and `pty-checks` (a `cli/` change selects them), `device-app-checks` (Linux) and `process-checks`, under `ci/required`.

| # | Check | Where | Isolation | What a person sees |
|---|---|---|---|---|
| 1 | **CLI end to end**, the whole suite once at the final head, in phase 4 (started by hand; the go is given): `gh workflow run cli-e2e.yml --ref feat/dial-agents-always-on` (Actions → CLI end to end → Run workflow) | GitHub, eight Linux shards and the macOS runner | each daemon under a throwaway root on a port of its own, a fake dial on a pseudo-terminal, fake `claude` and `codex`; no backend, no account, never port 18473 | every shard green; `e2e-summary` lists `e2e/deviceDialSkill.e2e.ts` passed. Some twenty files plug a fake dial, and each of their daemons now sets its throwaway Codex home up and asks its fake `claude` (2.1.270) for its version: a file red here and green in main's last nightly run is this change's |
| 2 | **Harness Device on a Mac** (PR CI compiles its Linux code only): `cd device-app/ui && npm ci && npm run build && cd ../src-tauri && cargo test --locked` | a Mac, locally | the fake CLI only; no daemon, no app launched | `test result: ok`, 0 failed |
| 3 | **`cli-core` receipt**: `python3 scripts/local-checks.py --run` from a clean tree at the final commit; its output goes into the pull request body. `cli/src/core/` is not touched, but `npm run test:core` also holds `cli/src/services/` to 100% a file, and `services/devices.ts` is where the attach is wired | a Mac or Linux, locally | vitest's throwaway home and data dir | one `harness-local-checks` fence, `cli-core` passed |
| 4 | **The real `claude plugin` words this change adds**, in a throwaway config dir: `export CLAUDE_CONFIG_DIR=$(mktemp -d)`, then `claude plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins`, `claude plugin install harness-device@openharness --scope user`, `claude plugin marketplace update openharness`, `claude plugin update harness-device@openharness --scope user`, `claude plugin list --json`; then `rm -rf "$CLAUDE_CONFIG_DIR"` | a Mac or Linux with Claude Code 2.1.287 or later and a network; no sign-in, no account | only that folder is written; `~/.claude` is never read or written | each command exits 0; the list holds `harness-device@openharness`, scope `user`, enabled |
| 5 | **By hand, Ken only** (his Mac, his dial, his own Claude Code and Codex; this branch's CLI as his daemon and this branch's Harness Device build, no release) | Ken's Mac | his real homes: a check only he can do | (a) the menu is Dial, Signed in, Sound, Notifications, Open Harness, Quit, with no Claude Code or Codex row. (b) With the dial plugged in and nothing pressed: `~/.claude/skills/dial/SKILL.md` is there, its marker line naming the two `disable` commands (0.6.58's file rewritten), and `claude plugin list` shows harness-device on; a Codex started with a new `CODEX_HOME` has `skills/dial/SKILL.md` within a minute. (c) `/plugin` uninstall of harness-device in Claude Code: a minute later it is still uninstalled and the skill is gone from `~/.claude/skills`. (d) `harness device claude enable` brings both back. (e) The daemon's log holds a `[device] dial setup · day` line |

No temporary workflow: the one long check has its own workflow, started by hand once. No check runs against production: nothing here calls a backend.

In the pull request: the red-then-green commits, checks 1 to 4 with their links or output, Task 9's two numbers, and the platforms (macOS and Linux; Windows writes nothing; the app's menu on macOS).

## Open questions

None; answered 2026-11-17, see the spec's Decided, "Plan answers".
