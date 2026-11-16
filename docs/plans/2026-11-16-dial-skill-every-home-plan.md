# Harness Device: the dial skill in every agent home — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** draft, no open question. The orchestrator's answers of 2026-11-16 are under Decided.

**Goal:** While Claude Code or Codex is On in the Harness Device menu, Harness itself writes `skills/dial/SKILL.md` into every home that engine's sessions use, removes its own copies on Turn off, and the menu turns an engine on directly, with no offer window.

**Architecture:**
- **One skill, one marker.** `devices/dialSkill.ts` holds the text and the write, check and remove of one home's file. Harness knows its own file by a YAML comment line in the frontmatter, never by exact bytes.
- **Two small files** in the daemon's data dir: `dial-skill.json` (On or Off per engine, written by the `harness device` command) and `dial-skill-homes.json` (the skills folders the devices service wrote into, written by that service).
- **Two writers.** The command writes and removes the default home at Turn on and Turn off. The devices service, in its own process, writes the other homes at its start and, for Codex, at the open scan, from the rollout path a running Codex or its app-server holds open. A scan that finds `dial-skill.json` changed runs the start pass again.
- **The app** drops its Claude Code and Codex offer screens: the menu's **Turn on** runs `enable`, and the status row says `Turning on…` or `Could not turn on`.

**Tech Stack:** TypeScript CLI and daemon (Node, vitest, `cli/`); Rust and Tauri 2 (`device-app/src-tauri`); plain TypeScript window (`device-app/ui`).

**Spec:** [docs/plans/2026-11-16-dial-skill-every-home-design.md](2026-11-16-dial-skill-every-home-design.md). It replaces pull request 2 of [the notify design](2026-11-16-dial-agent-notify-design.md)'s Release order.

## Base

- Branch `feat/dial-skill-every-home`, from `main` at `266e814cde`. No release: the orchestrator installs locally after the merge.
- Before the first task: `cd cli && npm ci` and `cd device-app/ui && npm ci && npm run build` (the app's binary embeds `ui/dist`). One `CARGO_TARGET_DIR` outside the repository compiles Tauri's dependencies once.
- Tasks name code by name, never by line. If a name below is gone, stop and report.
- Never touched by a task, a test or a check: the person's daemon (port 18473), `~/.harness`, its LaunchAgent, `Harness.app`, `~/.claude`, `~/.codex`, and any Codex or Claude Code the person runs.

## Layers

| Files | Layer and process | Gate |
|---|---|---|
| `cli/src/devices/dialSkill.ts`, `devices/dialSkillFiles.ts` | Shared by the `harness` command and the devices process | their specs (PR CI) |
| `cli/src/deviceClaude/command.ts`, `deviceClaude/plugin.ts` | The `harness` command's own process | `command.spec.ts` |
| `cli/src/cable/codexRolloutHome.ts`, `cable/dialSkillWriter.ts`, `cable/hosts/observed.ts` | The devices process | their specs |
| `cli/src/services/devices.ts` | The devices process | its spec; `npm run test:core`, 100% per file (local gate) |
| `device-app/src-tauri/src/*.rs`, `device-app/ui/src/*` | Harness Device, a process of its own | `cargo test --locked` (PR CI on Linux, macOS by hand); the window's vitest |

Nothing under `cli/src/core/` or `cli/src/harnessd/` changes, and `cli/src/architecture.coreFiles.txt` gains no line.

## Global Constraints

- **Never read another process's environment** (`ps -E`, `/proc/<pid>/environ`, `KERN_PROCARGS2`, `tmux show-environment`). A home comes from a setting of the daemon's own, `engine-homes.json`, or a rollout path the scan already has. `src/architecture.environment.spec.ts` stays green.
- **The marker line**, exact: `# Written by Harness. Turn off the agent in Harness Device to remove it.`
- **Ours** is a regular file, not a link, at most 4 KiB, whose frontmatter holds that exact line. Anything else at the path is the person's: never written over, never removed. Reading uses `O_NOFOLLOW | O_NONBLOCK` and the size bound.
- **Writing:** the `dial` folder 0700, a temp file 0600 renamed into place. Exactly `DIAL_SKILL` already there: nothing is written.
- **Removing:** only ours, then the `dial` folder only if empty. `skills/` and the home stay.
- **`<dataDir>/dial-skill.json`:** `{"claude":true|false,"codex":true|false}`, read with a 1 KiB bound, written by the command alone through a 0600 temp file and a rename. Missing or bad: no answer.
- **`<dataDir>/dial-skill-homes.json`:** `{"claude":[…],"codex":[…]}`, resolved skills folders, at most 64 per engine, written by the devices service alone.
- **On, for the devices service:** Claude Code: the file does not say `claude: false` and `enabledPlugins["harness-device@openharness"] === true` in the default home's `settings.json`, read strictly with a 1 MiB bound (missing or bad is Off). Codex: the file says `codex: true`.
- **A rollout path** is at most 1024 bytes, absolute, normalised, with no `..` and no control character. It is exactly `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl` (four digits, two, two) and the home is five levels up, never a search for `sessions`. `archived_sessions/` is not accepted. The home is not the data dir or under it, and it is an existing directory the daemon's uid owns (`stat`).
- **Owners:** every owner the scan read, with or without a row, server owners (no terminal) included; never a Harness-run one (`harness`) or one placed from its arguments (`fromArgs`).
- **Logs:** counts and reasons only. `dial skill: claude wrote 2 removed 0, codex wrote 1 removed 0` for a pass that changed something; a refused path with its reason (`shape`, `owner`, `missing`); the full list with its count. Never a path or a home's name, in a log, a metric, the relay or the dial.
- **Windows:** nothing is written. `enable` refuses as today.
- **Copy:** `Claude Code: On`, `Off`, `Turning on…`, `Turning off…`, `Could not turn on`, `Could not turn off` (the same after `Codex:`); **Turn on** with no `…`; **Turn off**. Stderr: `Codex already has a skill named dial that Harness did not write; it stays.`
- **The plugin** `plugins/harness-device` keeps its hook and gets no skill; its hook, mod and README do not change.
- **`device-app/AGENTS.md`:** thin over the CLI, fixed arguments built in Rust, one log, redacted.
- **Repo rules:** a test that fails first, no fixed sleeps, comments say why, tests use throwaway homes and data folders.

## Review Focus

1. **A `dial` folder, or a `skills` folder, that is a link.** A person may link `skills/dial` to a folder of their own: nothing is written through it. A linked `skills/` is followed only to a directory this user owns. Task 1 (`leaves the person's file`, `a skills folder that is not this user's directory is refused`).
2. **A homes list damaged or edited by hand** (a relative path, `..`, 70 entries, not JSON): Turn off must remove nothing the list may not hold. Task 2 (`homes: only absolute, normalised paths`), Task 5 (`disable … keeps a person's skill`).
3. **A home whose path has a space or a non-ASCII letter** (`…/Application Support/orca/…`). A space resolves. `lsof` can print a name escaped (`lib/nativeConversation.ts` says so of macOS); such a home fails as `missing`, and nothing is made anywhere. Task 3 (`accepted`), Task 6 (`refused paths`).
4. **Turn on while a session already runs in another home, or Turn off then Turn on while the service runs.** The service saw that home while the engine was Off, or handled it before the Turn off, and must still write it at the next scan. Task 6 (`a home is not handled while Off`, `a changed dial-skill.json runs the start pass again`).
5. **A person who never answered the old offer.** An old `state.json` has `askedClaude: false`: no window opens, and the rows read Off with **Turn on**. Task 10 (`no_offer_screen_at_first_run`, `a_state_file_with_the_old_offer_keys_loads`).

## Decided (the orchestrator, 2026-11-16)

Not reopened: no read of another process's environment; Claude homes are the default and the adopted ones, Codex homes those plus rollout homes from the open scan; no core change; writes at `enable`, the devices service's start and the open scan; nothing on Windows; the plugin gets no skill; one text, `DIAL_SKILL`, with a YAML comment marker; the offer screens, `TurnOn`, `NotNow`, `askedClaude` and `askedCodex` go; no release.

The draft's three questions, answered (the spec's "Where it is written" says the same):

1. **No row is needed.** Every owner the scan read is offered, except a Harness-run one and one placed from its arguments. The path rule is strict: only `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl`, exact levels, the home five up; `archived_sessions/` is not accepted. The home must be an existing directory the daemon's uid owns, not the data dir or under it. Each pass drops the listed homes whose skills folder no longer exists, so they do not fill the 64. Tasks 3, 4, 6.
2. **Server owners count.** Codex app-server and codex-acp owners (no terminal) give homes too. Harness-run owners and paths in the data dir are still dropped. Tasks 3, 6, 7, 8.
3. **A changed `dial-skill.json` restarts the pass.** Each scan `stat`s it once; when it changed, the service reads it again, forgets its handled homes and runs the start pass again. Task 6.

The planner's own decisions below stand, among them: the inline mode (`HARNESSD_SERVICES=none`) writes nothing; a `dial` folder that is a link is the person's; only the command's default home is made when missing.

## Decided here, where the spec left it to the builder

1. **The frontmatter test.** The file's first line is `---`, and a line before the next `---` line equals the marker. Lines end with `\n`: a CRLF copy is the person's.
2. **A `dial` that is a link, or not a directory, is the person's.** Harness makes a real folder.
3. **The skills folder's owner is checked by the command too**, with the one resolver. The default home is made when missing (`mkdir -p`, 0700), as `codex enable` does today. Any other home must already exist.
4. **Modules.** The two files have one module, `devices/dialSkillFiles.ts`; the home from a rollout path is a pure function, `cable/codexRolloutHome.ts`; the service's side is `cable/dialSkillWriter.ts`.
5. **Error copy, by today's pattern:** `Could not write the Claude Code skill.`, `Could not remove the Claude Code skill.`, the same two for Codex (unchanged), `Could not save the dial setting.`, and `Claude Code already has a skill named dial that Harness did not write; it stays.`
6. **Which owners give a home** (answers 1 and 2): `engine === 'codex'`, not `harness`, not `fromArgs`; `tty` is not looked at. `harness` is set only on an owner with a terminal (`lib/sessionSearch/external.ts`), so the app-server of a Harness-run Codex in an agent profile's own `CODEX_HOME` carries no such flag, and that home gets the skill like any other. Its rollouts in the daemon's own home or under the data dir change nothing.
7. **The writer runs only in the devices' own process** (`deps.listen` given). With the devices inside the core (`HARNESSD_SERVICES=none`, Harness OS) there is no listener, `harness device notify` prints `no dial`, and the core's process writes nothing: the Windows reason.
8. **Listed** is a folder that holds ours after a pass, written now or already there. A folder whose removal failed stays listed. A listed folder that no longer exists is dropped at each pass, and nothing is made again: a pass is the start pass, and a scan that is about to list a new home (so a full list first makes room). A scan that lists nothing does no file work for the list. A home whose listing could not be saved gets its skill removed again.
9. **Handled.** A home is handled once it was written, found ours or found the person's while the engine is On, never while it is Off. When the service reads Off it empties the list and forgets that engine's handled homes. A scan whose `stat` of `dial-skill.json` (inode, size, mtime) differs from the last one forgets both engines' handled homes and runs the start pass before it looks at its owners (answer 3); the first `stat` is taken at `started()`, and a missing file is a value of its own.
10. **Log bounds.** A refusal is said once per home (`shape` once per run), the full list once per run.
11. **The scan handles Codex only.** Claude Code's homes are written at the service's start (the spec's table).
12. **The app.** `EngineChange` in `AppState` holds a change that runs or failed. Under a failure the action row is the one the last status read gives. The first screen waits for the account's answer alone.

## Design check (docs/feature-design-rules.md)

1. **Growth.** Two files written over. The list holds at most 64 folders an engine; Turn off empties it, and a folder that is gone is dropped at each pass. In memory: at most 64 handled homes an engine.
2. **Concurrency.** One writer a file. Each write is a temp file and a rename. The service reads On right before a write and again after listing it (the spec's race). Two engines turned on in the same millisecond can lose one answer in `dial-skill.json`; the status read after each change shows it.
3. **Read cost.** `dial-skill.json` 1 KiB, `settings.json` 1 MiB, the list 256 KiB, a skill file 4 KiB, each read once per use. A scan costs one `stat` of `dial-skill.json` and a set lookup per owner once its home is handled; no timer is added.
4. **Scale.** 10x today's homes (a few) is under the cap of 64. The full-list log line warns first.
5. **Compatibility.** An older app reads `enabled` from `status` as before. An older CLI has no `dial-skill.json`: Claude Code follows the plugin entry, Codex is Off. An old `state.json` loads.
6. **Migration and rollback.** None: no released CLI wrote the unmarked skill. A rolled-back CLI leaves the marked files; they hold a comment line it ignores.
7. **Audience.** Local files of the person's own account, 0600. No path leaves the computer.
8. **Identity.** Every write runs as the person. A folder another user owns is refused.
9. **Failure.** `enable` and `disable` exit 1 with one line; the menu row reads `Could not turn on`. The service counts, never throws, and a failed removal stays listed.
10. **Platforms.** macOS and Linux. Windows: nothing written. Harness Device: macOS, and Linux in CI.

## Tasks at a glance

| # | Task | Depends on | Effort |
|---|---|---|---|
| 1 | The skill and one home's file (`devices/dialSkill.ts`) | none | xhigh |
| 2 | The two files (`devices/dialSkillFiles.ts`) | none | xhigh |
| 3 | A Codex home from a rollout path (`cable/codexRolloutHome.ts`) | none | xhigh |
| 4 | The scan says who holds what (`cable/hosts/observed.ts`) | none | medium |
| 5 | The command (`deviceClaude/command.ts`) | 1, 2 | xhigh |
| 6 | The devices' writer (`cable/dialSkillWriter.ts`) | 1, 2, 3 | xhigh |
| 7 | The devices service starts and feeds it (`services/devices.ts`) | 4, 6 | high |
| 8 | End to end on the isolated daemon (`cli/e2e`) | 5, 7 | high |
| 9 | App: the engine rows | none | high |
| 10 | App: no offer windows | 9 | high |
| 11 | Window: two screens | none | high |
| 12 | The docs | none | medium |

Longest chain: 1 → 6 → 7 → 8. Tasks 9 and 10 share `types.rs`, `model.rs` and `app.rs`, so 10 waits for 9.

---

### Task 1: The skill and one home's file

**Layer:** shared by the command and the devices process. **Depends on:** none. **Effort:** `xhigh` (it writes into the person's agent homes).

**Red test:** `cli/src/devices/dialSkill.spec.ts` (new).

**Files:**
- Create: `cli/src/devices/dialSkill.ts`, `cli/src/devices/dialSkill.spec.ts`
- `cli/src/devices/codexSkill.ts` stays until Task 5 deletes it: `command.ts` still imports it.

**Interfaces:**
- Produces:
  ```ts
  export const DIAL_SKILL_DESCRIPTION: string   // codexSkill.ts's, unchanged
  export const DIAL_SKILL_MARKER = '# Written by Harness. Turn off the agent in Harness Device to remove it.'
  export const DIAL_SKILL: string               // codexSkill.ts's text, the marker as the frontmatter's third line
  export const DIAL_PLUGIN_ID = 'harness-device@openharness'
  /** 'ok', or why a path is no folder of this user's. */
  export function ownDirectory(path: string, uid?: number): 'ok' | 'missing' | 'owner'
  /** `<home>/skills` through its link. null: not a directory this user owns, or missing and not made. */
  export function skillsFolderOf(home: string, make: boolean, uid?: number): string | null
  export function skillHeld(skills: string): 'ours' | 'none' | 'theirs'
  export function writeSkill(skills: string): 'written' | 'same' | 'theirs' | 'failed'
  export function removeSkill(skills: string): 'removed' | 'none' | 'theirs' | 'failed'
  /** Claude Code's own record that the plugin is on, read strictly: a missing or bad file is false. */
  export function claudePluginEnabled(settingsPath: string): boolean
  ```
- `uid` defaults to `process.getuid?.() ?? -1`, so a platform with none owns nothing.
- The file is `join(skills, 'dial', 'SKILL.md')`. The frontmatter, exactly:
  ```text
  ---
  name: dial
  description: "<JSON.stringify(DIAL_SKILL_DESCRIPTION)>"
  # Written by Harness. Turn off the agent in Harness Device to remove it.
  ---
  ```
- `skillsFolderOf`: `realpath(<home>/skills)` when it exists, which must be a directory `uid` owns. Missing and `make`: `mkdir -p` (0700), then its realpath. A dangling link or a file is null.
- `writeSkill` makes `dial` (0700, not recursive) and never follows a `dial` that is a link. No function throws, and no result holds a path.
- The module imports only `node:` modules.

- [ ] **Step 1: Write the failing tests** (a throwaway home each).
  - `the skill's front matter is YAML a loader reads, with the marker`: the frontmatter parsed with `yaml` is `{ name: 'dial', description: DIAL_SKILL_DESCRIPTION }`; `DIAL_SKILL.split('\n')[3]` is the marker; the body holds `harness device notify "<what you need, in one line>"`; the text is at most 4096 bytes.
  - `writes into an empty home, 0700 and 0600`: `skills` and `dial` are 0700, the file is `DIAL_SKILL` at 0600, `dial` holds only `SKILL.md`; a second `writeSkill` is `'same'` and keeps the inode.
  - `writes over ours with older bytes`: a marked file with another body becomes exactly `DIAL_SKILL`.
  - `leaves the person's file`: no marker; the marker only in the body; a CRLF copy; a link to a file of exactly `DIAL_SKILL`; a FIFO (the call returns at once); a marked file over 4 KiB; a folder at `SKILL.md`; a `dial` that is a link to a folder. Each is `'theirs'` for all three calls, its `lstat` (inode, mode, mtime) is unchanged, and the link's target gains no file.
  - `removes only ours, then the empty dial folder, never skills`: a sibling `skills/other/SKILL.md` stays; `skills` stays when empty; `dial` stays beside a `notes.md`; nothing there is `'none'`.
  - `a linked skills folder is followed, and two homes linked to one folder are one`: both homes resolve to the same string.
  - `a skills folder that is not this user's directory is refused`: a file, a dangling link, and `uid + 1` are null; nothing is made.
  - `a missing home`: `make` true makes `<home>/skills`; `make` false is null and makes nothing.
  - `a write or a removal that fails says failed`: `dial` at 0500.
  - `claudePluginEnabled`: true only for `{"enabledPlugins":{"harness-device@openharness":true}}`; false for a missing file, bad JSON, an array, the entry `false`, absent or `"true"`, a file over 1 MiB, and a folder.
  - `it imports only node modules`: every import specifier in the source starts with `node:`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/dialSkill.spec.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement.** `held()` and `written()` of `codexSkill.ts` are the model: keep their comments' reasons.
- [ ] **Step 4: Run** the same, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: the dial skill is one file Harness knows by its marker line`.

### Task 2: The two files

**Layer:** shared. **Depends on:** none. **Effort:** `xhigh` (stored data; the list names folders a later Turn off acts on).

**Red test:** `cli/src/devices/dialSkillFiles.spec.ts` (new).

**Files:**
- Create: `cli/src/devices/dialSkillFiles.ts`, `cli/src/devices/dialSkillFiles.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DialEngine = 'claude' | 'codex'
  export const DIAL_SKILL_FILE = 'dial-skill.json'
  export const DIAL_SKILL_HOMES_FILE = 'dial-skill-homes.json'
  export const MAX_HOMES = 64
  /** A key is absent when the file gives that engine no answer. */
  export interface DialSkillAnswers { claude?: boolean; codex?: boolean }
  export function readAnswers(dataDir: string): DialSkillAnswers
  /** undefined once saved; else the error's code (EACCES), never its message, which names the path. */
  export function writeAnswer(dataDir: string, engine: DialEngine, on: boolean): string | undefined
  export interface DialSkillHomes { claude: string[]; codex: string[] }
  export function readHomes(dataDir: string): DialSkillHomes
  export function writeHomes(dataDir: string, homes: DialSkillHomes): string | undefined
  ```
- `readAnswers`: 1 KiB bound (one byte past it tells a longer file), only a boolean is an answer. `writeAnswer` reads the file right before it writes and keeps the other engine's answer.
- `readHomes`: 256 KiB bound; keeps a string that is absolute, equal to its `resolve()`, with no control character and at most 1024 bytes; no duplicates; the first 64 an engine. Anything else reads as two empty lists.
- Both writes: `<file>.<pid>.tmp` at 0600, then a rename, as `cable/notifyMode.ts`.

- [ ] **Step 1: Write the failing tests** (a throwaway data dir each).
  - `answers: missing, bad or oversized reads as no answer`: no file, `not json`, `[]`, `{"claude":"yes","codex":1}` and a file over 1 KiB are all `{}`.
  - `an answer is written whole, 0600, and keeps the other engine's`: `codex` true then `claude` false reads `{ claude: false, codex: true }`; the mode is 0600; the folder holds only the file.
  - `a write that fails says its code and leaves the file`: a 0500 data dir gives `'EACCES'`.
  - `homes: only absolute, normalised paths, at most 64 an engine`: a relative path, one with `..`, one with `\n`, one of 2000 bytes, a number, a duplicate and 70 good ones read as the first 64 good ones; `{` reads as two empty lists.
  - `homes are written whole, 0600`: a round trip; 70 given are 64 kept.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/dialSkillFiles.spec.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: where On and the written homes are kept`.

### Task 3: A Codex home from a rollout path

**Layer:** the devices process (pure). **Depends on:** none. **Effort:** `xhigh` (the path is another process's, from `lsof`).

**Red test:** `cli/src/cable/codexRolloutHome.spec.ts` (new).

**Files:**
- Create: `cli/src/cable/codexRolloutHome.ts`, `cli/src/cable/codexRolloutHome.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  import type { SessionOwner } from '../lib/sessionSearch/external.js'   // type only
  export type RolloutOwner = Pick<SessionOwner, 'engine' | 'record' | 'tty' | 'harness' | 'fromArgs'>
  /** Whether the scan's owner is one a home is taken from. */
  export function takesOwner(owner: RolloutOwner): boolean
  /** The home a rollout path is in, or null when the path fails a rule (`shape`). Reads no file. */
  export function rolloutHome(record: string, dataDir: string): string | null
  ```
- `takesOwner`: `engine === 'codex'`, not `harness`, not `fromArgs` (decision 6). `tty` is not read: a server owner counts.
- `rolloutHome`: the Global Constraints' path rules, on path segments: only `sessions/YYYY/MM/DD/rollout-*.jsonl`, the home five up, never the filesystem root, never the data dir or under it. The home's `stat` (exists, a directory, the daemon's uid) is Task 6's, through `ownDirectory`: this function stays pure.

- [ ] **Step 1: Write the failing tests.**
  - `accepted`: `/h/sessions/2026/11/16/rollout-a.jsonl` is `/h`; `/Users/a/sessions/codex/sessions/2026/11/16/rollout-a.jsonl` is `/Users/a/sessions/codex`; a home with a space and one with `nhà` resolve; a home that holds the data dir (`/h` with the data dir `/h/x`) is `/h`.
  - `rejected`: a relative path; one with `..`; `//` and a trailing `/.`; a control character; 1025 bytes; `<dataDir>/sessions/2026/11/16/rollout-a.jsonl` (the home is the data dir) and `<dataDir>/codex/sessions/2026/11/16/rollout-a.jsonl` (under it); `/sessions/2026/11/16/rollout-a.jsonl` (the root); `/h/archived_sessions/rollout-a.jsonl`; `/h/archived_sessions/2026/11/16/rollout-a.jsonl`; `sessions/2026/11/rollout-a.jsonl`; `sessions/26/11/16/…`; `sessions/2026/11/16/x/rollout-a.jsonl`; a name that is not `rollout-*.jsonl`. Each is null.
  - `owners`: a Codex in a terminal and a Codex server with no terminal (`tty: null`, as Codex 0.167.1's app-server and codex-acp read) are taken; a Harness one, one placed from arguments and a Claude Code one are not.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/codexRolloutHome.spec.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: a Codex home is read off the rollout path, by fixed levels`.

### Task 4: The scan says who holds what

**Layer:** the devices process. **Depends on:** none. **Effort:** `medium`.

**Red test:** `cli/src/cable/hosts/observed.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts`, `cli/src/cable/hosts/observed.spec.ts`

**Interfaces:**
- Produces, on `ObservedDeps`:
  ```ts
  /** Every owner a scan read, before any is listed. Absent, nothing is told. */
  scanned?(owners: ReadonlyMap<string, SessionOwner>): void
  ```
- `scanOnce` calls it once, right after `openSessions.owners()` answers and before its `open.size` return, so an owner with no row, or none at all, still reaches it (answer 1). `observed.ts` holds no rule about a home or a skill.

- [ ] **Step 1: Write the failing test** `scanOpen hands every owner it read to scanned, once a scan`: with a Harness-run owner, one already listed, one with no row and one with no terminal, `scanned` gets the same map once; a scan whose owners are all Harness-run (so `open` is empty) still calls it; a second scan calls it again; a source built without it scans as before.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts -t 'scanned'`. Expected: FAIL (never called).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/observed.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: the open scan says which process holds which session`.

### Task 5: The command

**Layer:** the `harness` command. **Depends on:** 1, 2. **Effort:** `xhigh` (it removes files from the person's homes, in a fixed order).

**Red test:** `cli/src/deviceClaude/command.spec.ts`.

**Files:**
- Modify: `cli/src/deviceClaude/command.ts`, `cli/src/deviceClaude/command.spec.ts`, `cli/src/deviceClaude/plugin.ts`
- Delete: `cli/src/devices/codexSkill.ts`, `cli/src/devices/codexSkill.spec.ts`

**Interfaces:**
- Consumes: Task 1's `skillsFolderOf`, `writeSkill`, `removeSkill`, `DIAL_PLUGIN_ID`; Task 2's `readAnswers`, `writeAnswer`, `readHomes`.
- `DeviceDeps` and `cli.ts` do not change. The default home: Claude Code's is `dirname(claudeSettingsPath())`, Codex's is `deps.codexHome`. `plugin.ts`'s `PLUGIN_ID` becomes `DIAL_PLUGIN_ID`.
- The rules:
  - `claude status`: `enabled` is the plugin's `enabled` and the file not saying `claude: false`.
  - `codex status`: `{ supported, installed, enabled }`, `enabled` the file saying `codex: true`.
  - `enable`: Claude Code's plugin first, as today, and Codex's two refusals as today; a refusal or a failure ends it. Then On is saved (`Could not save the dial setting.` ends it), then the skill goes into the default home with `skillsFolderOf(home, true)`. `'theirs'`: the "it stays" line on stderr, exit 0. No folder, or `'failed'`: `Could not write the <engine> skill.`, exit 1.
  - `disable`, in this order, each step run whatever the one before did: Off is saved; Claude Code's plugin is uninstalled as today; the skill is removed from the default home (`skillsFolderOf(home, false)`) and from each folder `readHomes` gives that engine. Exit 1 with the first error, else 0. The command never writes the homes list.
- `DEVICE_USAGE`'s five lines:
  ```text
  harness device claude enable           install the plugin, or turn it on, and write the dial skill (Claude Code 2.1.287 or later)
  harness device claude disable          uninstall the plugin and remove the dial skill
  harness device codex status [--json]   whether the dial is on for Codex
  harness device codex enable            write the dial skill into Codex's home
  harness device codex disable           remove the dial skill from every Codex home
  ```

- [ ] **Step 1: Write the failing tests** (`command.spec.ts`'s throwaway `CLAUDE_CONFIG_DIR`, a throwaway Codex home and data dir).
  - `claude enable writes the skill into the default home and sets On`: the file is `DIAL_SKILL`; `dial-skill.json` reads `{ claude: true }`; exit 0, nothing printed.
  - `an enable that fails writes nothing`: a failed install, Windows, and Codex not installed leave no skill and no `dial-skill.json`.
  - `enable over a person's skill sets On, skips that home and exits 0`: both engines; stderr is the one line; the file is unchanged.
  - `claude disable writes Off first, then uninstalls, then removes, and keeps a person's skill`: the fake `claude` sees `claude: false` in the file and the skill still there when `plugin uninstall` runs; afterwards the default folder and two listed ones hold no skill, a listed folder with a person's skill keeps it, and the homes file is byte for byte as it was.
  - `a failing step still runs the rest`: an uninstall that fails with `x` still removes the skills, exit 1, stderr `x`; a data dir that cannot be written still uninstalls and removes, stderr `Could not save the dial setting.`
  - `claude status`: plugin on and no file is `enabled: true`; plugin on and `claude: false` is false; plugin off and `claude: true` is false.
  - `codex`: `status` is `enabled: false` with no file even when our skill is in the home; `enable` sets On and writes; `disable` sets Off and removes the default and listed folders; `status` follows.
  - `the usage names the dial skill`, beside `command.spec.ts`'s usage test.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/deviceClaude/command.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `command.ts`'s head comment says what `enable` and `disable` now write. `grep -rn codexSkill cli/src` prints nothing.
- [ ] **Step 4: Run** `npx vitest run src/deviceClaude src/devices && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: Turn on writes the dial skill for Claude Code and Codex, and Turn off removes every copy`.

### Task 6: The devices' writer

**Layer:** the devices process. **Depends on:** 1, 2, 3. **Effort:** `xhigh` (a race with Turn off; a file per home of the person's).

**Red test:** `cli/src/cable/dialSkillWriter.spec.ts` (new).

**Files:**
- Create: `cli/src/cable/dialSkillWriter.ts`, `cli/src/cable/dialSkillWriter.spec.ts`

**Interfaces:**
- Consumes: Tasks 1, 2 and 3, by their signatures.
- Produces:
  ```ts
  export interface DialSkillWriterDeps {
    dataDir: string
    platform: NodeJS.Platform
    uid: number
    /** The daemon's own homes: dirname(env.CLAUDE_PROJECTS_DIR), env.CODEX_HOME. */
    claudeHome: string
    codexHome: string
    /** The adopted homes, read at each start pass (lib/engineHomes.ts movedEngineHomes). */
    adopted(): { claude: string[]; codex: string[] }
    /** dial-skill.json, read anew at each call. */
    answers(): DialSkillAnswers
    log(line: string): void
  }
  export interface DialSkillWriter {
    /** The devices service started. */
    started(): void
    /** The open scan read these owners. */
    scanned(owners: Iterable<RolloutOwner>): void
  }
  export function createDialSkillWriter(deps: DialSkillWriterDeps): DialSkillWriter
  ```
- The rules:
  - On: the Global Constraints' rule, from `deps.answers()` and `claudePluginEnabled(join(claudeHome, 'settings.json'))`.
  - The start pass, per engine: first the listed folders that no longer exist are dropped. On: the default home, each adopted home that `ownDirectory` says is ok, and each listed folder. Off: each listed folder has ours removed, the list is emptied and the handled homes are forgotten (decisions 8 and 9). `started()` runs it and takes the first `stat` of `<dataDir>/dial-skill.json`.
  - `scanned`, first: one `stat` of `dial-skill.json` (inode, size, mtime; missing is its own value). Different from the last: forget both engines' handled homes and run the start pass. Then Codex only: an owner `takesOwner` refuses is skipped; `rolloutHome` null is a `shape` refusal; a home already handled costs a set lookup and nothing else; a new one is checked with `ownDirectory` (`missing`, `owner`), then handled as below. Off, read for a new home: as the start pass's Off.
  - One home: resolve its skills folder (`make` true: the home exists, its `skills/` may not); a folder already done is one write; before listing a new folder, the listed folders that no longer exist are dropped, and a list still full (64) writes nothing; read On, write, list, save the list, read On again, and remove what was just written when it is Off by then.
  - The handled homes are a set of at most 64 an engine: full, no new home is handled.
  - Log lines, exactly: `dial skill: claude wrote 2 removed 0, codex wrote 1 removed 0`; `dial skill: path refused (shape)`, `(owner)`, `(missing)`; `dial skill: codex list full (64)`.
  - `win32`: both calls do nothing. Neither call throws.

- [ ] **Step 1: Write the failing tests** (throwaway homes and data dir; `answers` and `uid` given by the test).
  - `at start it writes the default, adopted and listed homes of an engine that is On`: six folders hold `DIAL_SKILL`; the list names each resolved folder; the log is the one counts line.
  - `Claude On needs the strict plugin entry`: no `settings.json`, the entry gone, and `claude: false` beside a true entry each write nothing.
  - `Codex with no answer is Off`.
  - `a Codex owner in a new CODEX_HOME gets the skill, and its home is listed`: one with a terminal, and one server owner (`tty: null`) in a third home; both written, both listed.
  - `a profile linked to another home's skills is one write`: `wrote 1`, listed once.
  - `Off at a moment removes the listed ones and empties the list`: ours go, a person's stays, `removed 2`.
  - `the race: Off set between the write and the recheck removes the new one`: `answers` says On, then Off; the file is gone and not listed.
  - `a known home costs no file work on the next scan`: the skill deleted by hand between two scans is still missing, and `answers` is not called again (the file's `stat` is unchanged).
  - `a home is not handled while Off`: a scan while Off writes nothing; On at the next scan writes it.
  - `a changed dial-skill.json runs the start pass again`, with the real file (`writeAnswer`, so a change is a new inode; no sleep) and `answers: () => readAnswers(dataDir)`: (a) Codex On, a scan writes `<other>`; then Off and the command's removal (`removeSkill` on each listed folder), then On, both before the next scan; that scan writes the default home and `<other>` again, `wrote 2`. (b) The same with one scan between Off and On: it empties the list; the scan after On writes the default home and, from its owners, `<other>` again. (c) A scan with the file untouched calls `answers` no more.
  - `a full list writes no new home, and says so once` over two scans.
  - `refused paths give a reason and no path`: `shape` (an `archived_sessions/` path, a home under the data dir), `owner` (another `uid`), `missing` (a home that was deleted); one line each over two scans; no log line holds the test's temp folder.
  - `a listed folder that is gone is dropped at each pass, and nothing is made again`: at the start pass; and with 64 listed, one of them deleted, a scan's new home is written and listed (64 kept).
  - `a home whose listing cannot be saved keeps no skill`: a 0500 data dir; the call returns.
  - `on Windows nothing is written`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/dialSkillWriter.spec.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement.** Synchronous, as `dialSkill.ts` is.
- [ ] **Step 4: Run** the same, then `npx vitest run src/architecture.environment.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: the devices write the dial skill into each home in use, and take it out when the agent is turned off`.

### Task 7: The devices service starts and feeds it

**Layer:** the devices process. **Depends on:** 4, 6. **Effort:** `high`.

**Red test:** `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `createDialSkillWriter` (Task 6), `ObservedDeps.scanned` (Task 4), `readAnswers` (Task 2), `movedEngineHomes` (`lib/engineHomes.ts`).
- `startDevices` builds the writer only when `deps.listen` is given (decision 7), with `core.dataDir`, `apps.platform`, `process.getuid?.() ?? -1`, `dirname(env.CLAUDE_PROJECTS_DIR)`, `env.CODEX_HOME`, `movedEngineHomes`, `() => readAnswers(core.dataDir)` and `log`.
- Both calls go through `part.call('skill', …)`: `started()` once in `startDevices`, `scanned(owners.values())` from the observed source's `scanned`. A fault there is never the dial's.

- [ ] **Step 1: Write the failing tests** (`devices.spec.ts`'s mocked `OpenSessions`; `env.CLAUDE_PROJECTS_DIR` and `env.CODEX_HOME` pointed at throwaway folders and put back).
  - `the dial skill is written as the devices start`: with `codex: true` in the data dir, `<codex home>/skills/dial/SKILL.md` is `DIAL_SKILL` once `startDevices` returned.
  - `a scan's owners reach the writer`: a server owner (`tty: null`, no row) with a rollout in a new home; after the dial attaches, that home holds the skill.
  - `with the devices inside the core nothing is written`: no `listen`.
  - `a writer that fails costs the dial nothing`: `faults: new Set(['skill'])`; the cable still starts.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts -t 'dial skill'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run test:core` (100% per file), then `npx vitest run src/architecture.spec.ts src/leanEntry.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: the devices service writes the dial skill at its start and at each open scan`.

### Task 8: End to end on the isolated daemon

**Layer:** `cli/e2e`. **Depends on:** 5, 7. **Effort:** `high`.

**Red test:** none: it adds a check and changes no behavior. One commit. To show it can fail, run it once with Task 7's `scanned` line taken out locally (not committed): case 2 fails.

**Files:**
- Create: `cli/e2e/deviceDialSkill.e2e.ts`
- `cli/e2e/harness/outsideAgent.ts` no longer changes: a server owner counts (answer 2), so the holder needs no terminal and no `PTY` snippet.

**The cases**, on `IsolatedDaemon` with a fake dial (`Desk`, as `deviceNotify.e2e.ts`):
- **Before anything is turned on,** the daemon under test gets an `lsof` in its own `bin` (first on its `PATH`; `lib/processTable.ts` runs `lsof` by name) that runs the system one and keeps only names under `realpath(d.root)`. The test then runs `lsof -n -P -Fpn -c codex -c Codex` through that `PATH` and fails unless every name is under the root. Without this the scan would see a Codex the developer runs and write into their real home. On Linux the scan reads `/proc`, and the runner holds no one's Codex.
- **The holder** is a process named `codex` with no terminal, as Codex 0.167.1's app-server: Node under that name (a link to `process.execPath` in the test's root, the technique of `fakeApp()` in `outsideAgent.ts`), spawned with piped stdio, running a script that sets `process.title` on Linux, opens one rollout read-only and waits for stdin to close. The rollout is `<home>/sessions/2026/11/16/rollout-2026-11-16T00-00-00-<uuid>.jsonl`.
- `Claude Code's skill is written as the devices start`: `settings.json` with the plugin entry in `dirname(d.env.CLAUDE_PROJECTS_DIR)` before the start; once the dial is plugged, that home holds `DIAL_SKILL` and the log has `dial skill: claude wrote 1 removed 0, codex wrote 0 removed 0`.
- `a Codex in another home gets the skill once the scan sees it, Turn off removes every copy, and Turn on brings it back`: the real command from source (`CLI_ENTRY`, as `deviceNotify.e2e.ts`) runs `device codex enable`; a holder runs in `<root>/codex-other`, another in `<root>/codex-mine`, which holds a person's own `skills/dial/SKILL.md`, and a third holds `<root>/codex-old/archived_sessions/rollout-…jsonl`; the dial is plugged. Then `<root>/codex-other/skills/dial/SKILL.md` is `DIAL_SKILL`, `dial-skill-homes.json`'s `codex` list names that folder and the default home's, and neither `codex-mine`'s nor `codex-old`'s, the person's file is unchanged, and `<root>/codex-old` has no `skills/`. `device codex disable` then leaves no file of Harness's in the default home or `codex-other`, the person's file as it was, and `codex: false`. `device codex enable` again, the dial unplugged and plugged (an attach runs a scan): `codex-other` holds `DIAL_SKILL` again, with no daemon restart. No `dial skill:` line of the log holds `codex-other`.
- `a real Codex app-server's rollout gives its home`, `it.runIf(!!process.env.E2E_REAL_CODEX)` (the precedent: `E2E_BUNDLE_PATH` in `otherEngines.e2e.ts`); `E2E_REAL_CODEX` is the path of a real `codex` binary. Not in CI: no runner has Codex. `device codex enable`; then the real Codex starts in a private tmux server under the root (`tmux -L` a name of the test's own, `-f /dev/null`, `TMUX` and `TMUX_PANE` unset) with only `HOME=<root>/home`, `CODEX_HOME=<root>/codex-real`, `PATH` and `PROBE_KEY=none` in its environment, in `<root>/work`. `<root>/codex-real/config.toml` is check 5's: `model_provider = "probe"`, `[model_providers.probe]` with `base_url = "http://127.0.0.1:9/v1"` and `env_key = "PROBE_KEY"`, and `<root>/work` trusted. The test types `hi` and Enter, and waits (bounded, 60 s, by polling the filtered `lsof`, no fixed sleep) until a `rollout-*.jsonl` under `<root>/codex-real/sessions/` is held; the holder's command line holds `app-server` (logged as a yes or no, never the path). Then the dial is plugged, and `<root>/codex-real/skills/dial/SKILL.md` is `DIAL_SKILL`. Afterwards: the tmux server is killed, and each process whose executable path is under the root is stopped (`SIGTERM`, then `SIGKILL` after a bounded wait).

- [ ] **Step 1: Write the test file.**
- [ ] **Step 2: Run** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceDialSkill.e2e.ts`. Expected: PASS, twice in a row; the real-Codex case is skipped.
- [ ] **Step 3: Run it once without Task 7's `scanned` line.** Expected: case 2 FAILS. Put the line back.
- [ ] **Step 4: Run** the real case on this Mac, after `codex --version` prints `codex-cli 0.167.1`: `cd cli && E2E_REAL_CODEX="$(command -v codex)" TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceDialSkill.e2e.ts -t 'real Codex'`. Expected: PASS, and the case's cleanup ends with an assertion that no process's executable path is under its root. If Codex holds no rollout before a model answers, the case fails at its wait: stop and report it as not verified, with that reason, for the orchestrator to decide.
- [ ] **Step 5: Commit** `Dial: the dial skill end to end, on a daemon and homes of the test's own`.

### Task 9: App: the engine rows

**Layer:** Harness Device (Rust). **Depends on:** none. **Effort:** `high`.

**Red test:** `model.rs` and `app.rs` tests.

**Files:**
- Modify: `device-app/src-tauri/src/types.rs`, `model.rs`, `app.rs`

**Interfaces:**
- Produces:
  ```rust
  /// A Claude Code or Codex change, as its menu rows show it. Running(true) turns on; Failed(true) was a turn-on.
  #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
  pub enum EngineChange { #[default] None, Running(bool), Failed(bool) }
  // AppState gains: pub claude_change: EngineChange, pub codex_change: EngineChange
  ```
- `App`'s `setting` and `codex_setting` go: `set_claude` and `set_codex` set `Running(on)` and refuse while one runs. `ClaudeSet` and `CodexSet` are heard only while `Running(on)`: `Ok` gives `None`, `Err` gives `Failed(on)`, and both push the engine's read. `Cli(false)` resets both.
- `menu`, per engine: `Running(true)` is the one row `Claude Code: Turning on…`, `Running(false)` `Claude Code: Turning off…`, with no action row. `Failed(on)` is `Claude Code: Could not turn on` (or `off`) over the action row of the last status. Else `On` over **Turn off**, or `Off` over **Turn on** (no `…`).
- The Claude Code rows show when `claude.supported`: `available()` becomes that. Codex's show when `supported && installed`, as today.
- The window's part stays until Task 10: `due` reads the same `available()`, and the `Set` events still save and move the offer screens. `screens_are_due_in_order`'s not-installed case follows the new rule.

- [ ] **Step 1: Write the failing tests.**
  - `the_claude_rows`: Off is `["Claude Code: Off", "Turn on"]`; supported and not installed shows the Off rows; not supported, or no status, shows none.
  - `the_change_rows`: the four states for each engine, as above; while one runs the row after it is not that engine's action.
  - `the_codex_rows`: **Turn on** with no `…`.
  - `a_change_shows_in_the_menu_until_it_ends`: `Menu(ClaudeOff)` gives `SetClaude(false)` and a menu with `Claude Code: Turning off…`; `ClaudeSet(Ok)` gives `ReadClaude`.
  - `a_failed_change_reads_again_and_shows_its_row`: `ClaudeSet(Err)` gives `ReadClaude` and `Claude Code: Could not turn off` over **Turn off**; the next click clears it. The same for Codex.
  - The tests that asked `setting` (`a_second_click_runs_nothing_twice`, the two relaunch tests, `a_cli_that_goes_away_ends_what_needed_it`) pass on the new field.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked --lib`. Expected: FAIL (does not compile: no `EngineChange`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: an agent's rows say a change that runs or failed, and show for Claude Code before its plugin is installed`.

### Task 10: App: no offer windows

**Layer:** Harness Device (Rust). **Depends on:** 9. **Effort:** `high`.

**Red test:** `types.rs`, `model.rs`, `app.rs`, `state.rs` and `runner.rs` tests.

**Files:**
- Modify: `device-app/src-tauri/src/types.rs`, `model.rs`, `app.rs`, `state.rs`, `runner.rs`

**Interfaces:**
- `Screen` is `Install | SignIn`. `Action` is `Retry | SignIn | Later | Cancel`. `Saved` loses `asked_claude` and `asked_codex`; `state.json` is `{ "version", "cliSeen", "askedSignIn", "loginItem" }`.
- `due`: Install, then Sign in. `Menu(ClaudeOn)` and `Menu(CodexOn)` call `set_claude(true)` and `set_codex(true)`. The Claude Code and Codex arms of `act`, `WindowClosed` and `view_of` go, and the `Set` events no longer save or show anything.
- `first_answers` becomes `awaiting_account: bool`: the first screen is chosen at the account's first answer.

- [ ] **Step 1: Write the failing tests.**
  - `the_window_may_ask_four_things`: `turn_on` and `not_now` are refused.
  - `state_json_keys`: the four keys.
  - `a_state_file_with_the_old_offer_keys_loads` (`state.rs`): `{"version":1,"cliSeen":true,"askedSignIn":true,"askedClaude":true,"askedCodex":false,"loginItem":true}` loads with no log line.
  - `only_install_and_sign_in_are_due` (`model.rs`): Claude Code and Codex off with nothing asked is `None` once sign-in was asked.
  - `no_offer_screen_at_first_run`: signed in, both engines off: no `Show`.
  - `the_first_screen_waits_for_the_account_alone`.
  - `turn_on_in_the_menu_runs_enable_with_no_window`: `Menu(ClaudeOn)` gives `SetClaude(true)`, no `Show`, and `Claude Code: Turning on…`; `ClaudeSet(Ok)` gives `ReadClaude` and no `Save`; the status then gives `Claude Code: On` over **Turn off**. The same for Codex.
  - `a_failed_enable_shows_the_rows_error_and_no_window`.
  - `later_is_remembered`, and `closing_the_window_on_an_offer_is_later` for Sign in alone.
  - `turn_on_from_the_menu_runs_enable_and_opens_no_window` (`runner.rs`, unix): the app and the runner against `tests/fake-harness`, as `from_start_to_dial_connected`. The status script says off, `Menu(ClaudeOn)` is handled, the status script is rewritten to on. No effect is `Show(Some(_))`, the menus pass through Off, `Turning on…` and On, and `calls.log` holds `device claude enable` once.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked`. Expected: FAIL (does not compile).
- [ ] **Step 3: Implement.** The tests of the removed screens go with them.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: Turn on in the menu turns an agent on, with no window`.

### Task 11: Window: two screens

**Layer:** Harness Device (the window). **Depends on:** none. **Effort:** `high`.

**Red test:** `gallery.test.ts`, `screens.test.ts`.

**Files:**
- Modify: `device-app/ui/src/api.ts`, `screens.ts`, `gallery.ts`, `api.test.ts`, `screens.test.ts`, `gallery.test.ts`

**Interfaces:**
- `Screen` is `'install' | 'sign_in'`; `Action` is `'retry' | 'sign_in' | 'later' | 'cancel'`. `FACES` loses its six `claude.*` and `codex.*` entries, `STATES` its six.

- [ ] **Step 1: Write the failing tests.**
  - `gallery.test.ts`: `STATES` has 8 entries, and the pairs are the six of Install and Sign in.
  - `screens.test.ts`, `a screen Rust no longer sends draws nothing`: `{ screen: 'claude', phase: 'offer' }` and the Codex one, cast, leave the page empty. The Claude Code and Codex cases go; the cases that borrowed `claude` (first line shown, primary button, outside text, the screen reader, focus) use Sign in.
  - `api.test.ts`: `act('later')`.
- [ ] **Step 2: Run** `cd device-app/ui && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** `screens.ts`'s head comment says two screens.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run build && npm run gallery`. Expected: PASS, both bundles built.
- [ ] **Step 5: Commit** `Harness Device: the window has two screens, Install and Sign in`.

### Task 12: The docs

**Layer:** docs. **Depends on:** none. **Effort:** `medium`. **Red test:** none; one commit.

**Files:**
- Modify: `docs/plans/2026-11-13-device-menubar-design.md`, `desktop/design/desktop-design-system.md`, `device-app/AGENTS.md`, `docs/cli.md`, `docs/plans/2026-11-16-dial-agent-notify-design.md`

- [ ] **Step 1: Edit.**
  - `2026-11-13-device-menubar-design.md`: Goal 3 (sign-in is offered once; Claude Code and Codex are turned on and off in the menu); the two screens, in "Decided in this brainstorm" and "Window and UI"; the Claude Code section (no offer; **Turn on** runs `enable`; the rows while a change runs or after it failed; shown when supported); the Menu table's Claude Code and Codex rows; the window's close rule; the State file's keys (an old file's `askedClaude` and `askedCodex` are ignored); Testing. Each points at the new design.
  - `desktop-design-system.md`, Harness Device: sign-in is the one offer; the window has two screens, Install and Sign in; a rule for an agent in the menu (a disabled status row with the six states of the Global Constraints' copy, and one action row unless a change runs; an action that opens no window has no `…`).
  - `device-app/AGENTS.md`: the intro, "two screens", "one of four action names".
  - `docs/cli.md`: a `harness device claude status|enable|disable` row and the Codex row: `enable` writes the `dial` skill into the default home; while the agent is on, the devices service writes it into the other homes it knows; `disable` removes every copy Harness wrote; a `dial` skill the person wrote is never changed.
  - `2026-11-16-dial-agent-notify-design.md`, Release order: one line under item 2, that it was replaced by this design and #4386 was closed.
- [ ] **Step 2: Check** `grep -n 'four screens\|six action\|Turn on…\|askedClaude' device-app/AGENTS.md desktop/design/desktop-design-system.md` prints nothing.
- [ ] **Step 3: Commit** `Docs: the dial skill in every agent home, and a menu that turns an agent on directly`.

---

## Verification

Every check is automated and needs no person. None touches the person's daemon (18473), `~/.harness`, its LaunchAgent, `Harness.app`, `~/.claude` or `~/.codex`.

**Platforms the pull request names:** the command and the devices' writer on macOS and Linux (PR CI's unit suites on Linux; checks 3 and 5 on this Mac; check 3 also on Linux runners). Windows: nothing is written, proved with the platform injected (Tasks 5 and 6); no workflow runs these specs there. Harness Device on macOS (gate 2 and check 4) and Linux (PR CI). Desktop, the phone, the website, the Orca plugin and the firmware: no code changes.

**Temporary workflow:** none. The long check, the end-to-end suite, has its workflow (`.github/workflows/cli-e2e.yml`), and the nightly run takes the new file from then on. Harness Device's tests run in PR CI (`device-app-checks`).

**1. In PR CI, nothing started by hand.** The CLI's typecheck and unit suite run Tasks 1 to 7 on Linux, with `architecture.spec.ts`, `architecture.environment.spec.ts` and `leanEntry.spec.ts`. `device-app-checks` runs Tasks 9 to 11 (the window's typecheck and vitest, then `cargo test --locked` on Linux). The Desktop suite runs by itself, as one doc under `desktop/` changes.

**2. Local gates,** recorded in the pull request (PR CI does not run them):
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit: `cli-core` (`npm run test:core`, 100% per file for `services/devices.ts`).
- `(cd device-app/ui && npm ci && npm run build) && cd device-app/src-tauri && cargo test --locked`, on this Mac (`docs/validation-and-release.md`, "Harness Device on macOS").
- `git diff --stat 266e814cde -- cli/src/core cli/src/harnessd cli/src/architecture.coreFiles.txt plugins` prints nothing. A line means the branch broke its own rule: stop and report.

**3. The devices service on a real daemon with a fake dial**
- Run, on this Mac, at the final head: `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceDialSkill.e2e.ts e2e/deviceNotify.e2e.ts e2e/deviceCodex.e2e.ts e2e/deviceWithoutApp.e2e.ts`. The first is new; the others run the scan and the command this branch touches.
- Isolation (`cli/AGENTS.md` rule 6; `docs/development.md`, "Isolated end-to-end testing"): the suite's `IsolatedDaemon`, with a throwaway home, data folder and auth folder, its own port and tmux server, engine homes inside its root, signed out, the backend at `127.0.0.1:9`. The dial is a fake on a pseudo-terminal (`HARNESSD_TEST_DIAL_PORT`). The new file also gives its daemon an `lsof` that shows only files under the test's root, and fails before Codex is turned on if any other name shows: the person's own Codex is never seen.
- What passes: every test; the new file's real-Codex case is skipped here (check 6 runs it). In the new file, a `codex` with no terminal that holds a rollout in `<root>/codex-other` gets `skills/dial/SKILL.md` after the dial is plugged, `dial-skill-homes.json` names that folder, an `archived_sessions/` rollout gives no home, `device codex disable` removes it and leaves a person's own skill, and `device codex enable` with a replug brings it back.
- On GitHub, by hand, once at the final head: Actions → CLI end to end → Run workflow, branch `feat/dial-skill-every-home`. Eight Linux shards; every shard passes. Report the run link.

**4. The app against the fake CLI.** `cargo test --locked` of gate 2 runs `turn_on_from_the_menu_runs_enable_and_opens_no_window`: the real reducer and runner against `device-app/src-tauri/tests/fake-harness` in a temp folder. It passes when no window is shown, the menus read Off, `Turning on…` and On, and the fake's `calls.log` holds `device claude enable` once. `cd device-app/ui && npm test && npm run gallery` passes and builds the gallery with eight states. On GitHub: PR CI's `device-app-checks`, on Linux.

**5. The real Claude Code 2.1.325 and Codex 0.167.1 list the skill, with no restart, and drop it**
- Why on this Mac: it needs these two engines as installed here. No login is used and no model is called: each engine is pointed at `http://127.0.0.1:9`, where nothing listens.
- Isolation: one throwaway folder with a short path, `T=$(mktemp -d /private/tmp/ds.XXXXXX)` (a tmux socket's path has little room). Every command runs under `env -i` with only: `HOME=$T/home`, a `PATH` of Node's folder, the two engines' folders and the system folders, `ADAPTER_DATA_DIR=$T/data`, `ADAPTER_RUNTIME_DIR=$T/runtime`, `HARNESS_AUTH_DIR=$T/auth`, `ADAPTER_COMPUTER_ID_FILE=$T/computer-id`, `PORT=18999`, `CLAUDE_CONFIG_DIR=$T/claude`, `CODEX_HOME=$T/codex`, `CLAUDE_PATH` and `CODEX_PATH` set to the two real binaries. `env -i` also keeps the calling session's own plugin settings out. The CLI runs from source: `cd cli && node --import tsx src/cli.ts device …`. The two sessions run in `$T/work`. No daemon is started.
- Set up:
  - `claude plugin marketplace add <this checkout>`: the marketplace `openharness` from a local folder, so `enable` fetches nothing.
  - `$T/claude/.claude.json`: `hasCompletedOnboarding: true`, a `theme`, `customApiKeyResponses.approved` holding the last 20 characters of a made-up key, and `projects[<the real path of $T/work>].hasTrustDialogAccepted: true`.
  - `$T/codex/config.toml`: `model_provider = "probe"`, a `[model_providers.probe]` with `base_url = "http://127.0.0.1:9/v1"` and `env_key = "PROBE_KEY"`, and `[projects."<the real path of $T/work>"] trust_level = "trusted"`.
  - A private tmux server (`TMUX_TMPDIR=$T/t`, `tmux -L dialskill -f /dev/null`, `TMUX` and `TMUX_PANE` unset) with two windows: `claude` with the made-up key in `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL=http://127.0.0.1:9` and `DISABLE_AUTOUPDATER=1`; and `codex` with `PROBE_KEY=none`.
- Run and expect, reading each pane with `capture-pane`:
  1. Claude Code: type `/skills`, Enter: `No skills found`. Escape. Codex: type `$dia`: `no matches`. Escape, Ctrl-U.
  2. `device claude enable` and `device codex enable`: exit 0. `$T/claude/skills/dial/SKILL.md` and `$T/codex/skills/dial/SKILL.md` hold the marker line; `$T/data/dial-skill.json` is `{"claude":true,"codex":true}`; `device claude status --json` and `device codex status --json` say `"enabled":true`.
  3. In the same two sessions, not restarted: `/skills` lists `dial`; `$dia` lists `dial  [Skill]`.
  4. A new start lists it too: `claude -p --output-format stream-json --verbose hi`, with the same key and base URL, prints a first line whose `skills` holds `dial`; `codex debug prompt-input hi` holds `- dial: The person has a Harness dial`.
  5. `device claude disable` and `device codex disable`: exit 0; both files and both `dial` folders are gone, `skills/` stays; `/skills` reads `No skills found` and `$dia` `no matches` in the same sessions; `claude plugin list --json` holds no `harness-device`.
  6. A person's own skill: write a `skills/dial/SKILL.md` with no marker into both homes, run both `enable`: exit 0, the "it stays" line on stderr, both files unchanged; both `disable` leave them.
- Afterwards: `tmux -L dialskill kill-server`. Codex leaves a managed app-server running from `$T/codex/packages/app-server-daemon/`: stop each process whose executable path is under `$T/codex` (check the path first; `kill`, then `kill -9` if it is still there after a few seconds). Then `rm -rf "$T"`. `ps` shows no process with `$T` in its path.
- Not done, for whatever reason: report it as not verified, never as passed.
- On GitHub: none. No runner has these two engines at these versions.

**6. The scan learns a home from a real Codex 0.167.1 app-server**
- Why on this Mac: it needs Codex 0.167.1 as installed here (`codex --version`), and macOS's `lsof`. No login is used and no model is called (`http://127.0.0.1:9`).
- Run, at the final head: Task 8's Step 4, `cd cli && E2E_REAL_CODEX="$(command -v codex)" TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceDialSkill.e2e.ts -t 'real Codex'`.
- Isolation: check 3's `IsolatedDaemon` and its root-only `lsof`, so neither the person's own Codex nor the person's daemon is seen or touched; the real Codex runs under the root with its own `HOME`, `CODEX_HOME` and private tmux server, and its managed app-server, which lives under that `CODEX_HOME`, is stopped by the case's cleanup.
- What passes: Codex's app-server holds a rollout under `<root>/codex-real/sessions/`, and once the fake dial is plugged `<root>/codex-real/skills/dial/SKILL.md` is `DIAL_SKILL`; no process is left under the root.
- If Codex opens no rollout before a model answers, the case cannot pass offline: report it as not verified, with that reason. Never point it at a real account or backend to make it pass.
- On GitHub: none. No runner has Codex 0.167.1.

**Not checked end to end:** the real menu drawn by macOS (no person; the rows are proved in the reducer and the runner). Codex's other server, codex-acp, is covered by the unit tests only (Tasks 3 and 6, a `tty: null` owner): it is not installed here.
