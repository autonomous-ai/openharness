# The ChatGPT app's page on the dial: its sidebar's threads, in its sidebar's order — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(dial): <the task's message> (red)` once its failing tests have been run and seen to fail, then `dial: <the task's message>`. A task with no red test is one commit. No task pushes or merges.

**Goal:** On macOS, the dial's ChatGPT page lists the app's Codex threads with or without a process (at most 16, idle, resting), and its ring is in the app's sidebar order: projects first, then Recent.

**Architecture:**
- **A reader** (`cli/src/cable/hosts/codexAppThreads.ts`) reads id, source, folder and times from `~/.codex/state_5.sqlite` (one indexed query, its own read-only connection opened and closed per read) and the project order from `~/.codex/.codex-global-state.json`. It names each listed thread (D4) and puts them in the sidebar's order.
- **A listing source** (`cli/src/cable/hosts/codexAppSource.ts`, id `codex-app`) turns the newest 16 into resting `HostAgent`s under `observedAgentId('codex', threadId)`. It reads when one watch on `~/.codex` tells it to, at most once a second. It hands the order to `CableHost.setRank('codex', …)` and the names to `ObservedSource.setPaneNames('codex', …)`.
- **The devices** (`cli/src/services/devices.ts`) build it on macOS behind the observed agents' switch. At each attach they look for the ChatGPT app (`ChatGPT.app` in `/Applications` or `~/Applications` whose bundle id is `com.openai.codex`): found, the source starts; not found, it is not started (stopped if running). It stops at the last detach. A tap goes through the opener to a named `codexNoted` adapter.
- **The dial host** (`cli/src/cable/cableHost.ts`) takes `setRank(app, undefined)`. Its single machine ring leaves resting rows out (D7).
- Nothing goes through the core. No firmware, Desktop or UI copy changes. Nothing is stored or written.

**Tech Stack:** TypeScript daemon (Node 22.23 / 24.22, `node:sqlite` through `lib/sqliteBuiltin.ts`), vitest, the CLI's end-to-end harness (`cli/e2e/harness`).

**Spec:** `docs/plans/2026-11-19-dial-chatgpt-ring-and-follow-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` and `cli/src/services/AGENTS.md`, and also #4485's spec, `docs/plans/2026-11-19-dial-claude-app-sessions-design.md` (in its worktree until it merges: `/Users/duynguyen/orca/workspaces/autonomous-harness/dial-claudeapp-sessions`).

**Open questions:** none. The draft's two are settled by the PM (2026-11-19) and folded into T1, T6, T9 and T11 ("Settled questions", at the end of this plan).

## Base

- `fix/dial-chatgpt-ring-and-follow` at `91f60b6a7b` (`origin/main`). The spec and this plan are untracked. The main session commits them; no task does.
- **#4485 (`fix/dial-claude-app-idle-sessions`) is open and not merged.** It adds `HostAgent.resting` and `HostAgent.ended`, the registry's ended rule, `AppCounts.inFront` (`select.ts`, `appFilter.ts`), `ClaudeAppSource` and its wiring in `devices.ts`. Tasks that need any of these depend on **T0** (rebase on `main` once #4485 merges). Every other task starts at once on the current base. Never copy #4485's code into this branch.
- The tasks name functions, never lines. If a name differs after T0 (#4485 may change in review), the implementer follows the code and says so in its report.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| T0 Rebase on `main` once #4485 merges | the whole branch (no other task runs during it) | none (gate: #4485 merged) | high | none: a rebase, no commit of its own |
| T1 The reader: the app's threads, their names and the sidebar's order | `cli/src/cable/hosts/codexAppThreads.ts`, `codexAppThreads.spec.ts`, `cli/src/testing/codexAppFixture.ts` | none | xhigh | `codexAppThreads.spec.ts` |
| T2 `setRank(app, undefined)` drops the app's rank | `cli/src/cable/cableHost.ts`, `cableHost.spec.ts` | none | medium | `cableHost.spec.ts`, red by `npm run typecheck` |
| T3 The ChatGPT adapter is named `codexNoted` | `cli/src/services/devices.ts` | none | medium | none: no behavior, one commit |
| T4 Pin: a hooked ChatGPT thread takes the `codex` pane names | `cli/src/cable/hosts/observed.spec.ts` | none | medium | none: pins today's behavior, one commit |
| T5 The read's numbers | `cli/scripts/benchmark-codex-app-threads.ts` | T1 | medium | none: a script, one commit |
| T6 The listing source `CodexAppSource` | `cli/src/cable/hosts/codexAppSource.ts`, `codexAppSource.spec.ts` | T0, T1 | xhigh | `codexAppSource.spec.ts` |
| T7 Pin: one row per ChatGPT thread in the registry | `cli/src/cable/hosts/registry.spec.ts` | T0 | medium | none: pins #4485's rules, one commit |
| T8 D7: the single machine ring leaves resting rows out | `cli/src/cable/cableHost.ts`, `cableHost.spec.ts` | T0, T2 | high | `cableHost.spec.ts` |
| T9 The devices run the source | `cli/src/services/devices.ts`, `devices.spec.ts` | T0, T3, T6 | xhigh | `devices.spec.ts` |
| T10 Say it in the docs | `cli/AGENTS.md`, `cli/src/cable/hosts/types.ts` (comments only), `docs/specs/2026-11-15-device-host-adapter.md` | T0 | medium | none: docs, one commit |
| T11 End to end: the ChatGPT page from a fixture `~/.codex` | `cli/e2e/deviceCodexAppThreads.e2e.ts`, `cli/e2e/harness/daemon.ts` | T1, T9 | high | none: the end-to-end test of T1 to T9, one commit |

**Longest chain:** four tasks: T1 → T6 → T9 → T11, or T0 → T6 → T9 → T11.

- T1, T2, T3 and T4 share no file and start at once. T0 runs whenever #4485 has merged and nothing else is running. Each of T1 to T4 may land before or after it.
- Shared files, each pair ordered by a dependency: `cableHost.ts`/`cableHost.spec.ts` (T2 → T8), `devices.ts` (T3 → T9).
- T7, T8 and T10 share no file and run beside T6 once T0 is done.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/services/devices.ts` | **Devices service process** | 100% per file (`npm run test:core`) |
| `cli/src/cable/hosts/codexAppThreads.ts`, `codexAppSource.ts`, `cli/src/cable/cableHost.ts` | **Devices service process** | Their specs |
| `cli/src/testing/codexAppFixture.ts` | Test helper (specs, the benchmark, the e2e) | none |
| `cli/scripts/benchmark-codex-app-threads.ts` | A script run by hand, on a fixture in a throwaway home | none |
| `cli/e2e/deviceCodexAppThreads.e2e.ts` | Test: the real daemon, a fake dial, a fixture `~/.codex` and a fake `~/Applications/ChatGPT.app` | Local, this Mac |
| `cli/e2e/harness/daemon.ts` | Test harness: every daemon under test gets `HARNESS_APPLICATIONS_DIR` inside its root | The e2e suite |
| `cli/AGENTS.md`, `docs/specs/…host-adapter.md`, `types.ts` comments | No process | none |

No file under `cli/src/core/` changes and `cli/src/architecture.coreFiles.txt` gains no line. `cli/src/lib/sqliteBuiltin.ts` and `cli/src/lib/sessionTitle.ts` are unchanged: the core loads both. `cable/hosts/observed.ts`, `codexApp.ts`, `select.ts`, `appFilter.ts`, `registry.ts` and the firmware do not change.

## Before starting

- This worktree has no `cli/node_modules`: run `cd cli && npm ci` once. Run it again after T0 if `package-lock.json` changed.
- The schema below is Codex's own, read from the public `codex-cli 0.169.0` binary's migrations on this Mac (`strings`), not from anyone's `~/.codex`. No test, script or person on this task reads the real `~/.codex`.

## Global Constraints

- **The core does not change** (see Layers). Every check here runs in the devices process.
- **The app's files are never written.** SQLite opens `readOnly: true`: the URI `immutable=1` while the store is idle (`idleWalStore`), else the plain path (SQLite's `mode=ro`). `PRAGMA busy_timeout = 50`. Each read opens its own connection and closes it before the read ends. Never `sqliteReadAll`/`readBuiltin`, whose handle is cached for the process's life.
- **Paths:** the Codex home is `join(homedir(), '.codex')`, computed once in `devices.ts`. It is never `env.CODEX_HOME` and never from `harnessHome.ts`. Its files are `state_5.sqlite`, `.codex-global-state.json` and `session_index.jsonl`.
- **One watch:** `watchNearest([codexHome])`, never the home folder above it.
- **Bounds:** 16 listed (`MAX_LISTED`), 200 rows (`MAX_ROWS`), 64 project ids (`MAX_PROJECTS`), the JSON file at most 1 MiB (`MAX_STATE_BYTES = 1_048_576`), a folder at most 4,096 characters (`MAX_CWD`), at least 1 s between two read starts (`GAP_MS = 1_000`).
- **The query, verbatim:** `SELECT id, source, cwd, recency_at_ms, updated_at_ms FROM threads WHERE archived = 0 AND source IN ('cli','vscode') ORDER BY recency_at_ms DESC LIMIT 200`. No value from outside goes into it.
- **Log lines, exactly these four forms; never a title, name, folder, path, id or error text:** `[codex-app] watch · on` / `[codex-app] watch · none`; `[codex-app] listed · <n> threads · <p> in projects`; `[codex-app] read · <ms> ms · <rows> rows · <skipped> skipped`; `[codex-app] read · failed`.
- **Where it runs:** macOS only (`apps.platform === 'darwin'`), behind `HARNESS_DEVICE_OBSERVED`, only while a dial is attached, and only when the ChatGPT app is installed, looked for at each attach: `<apps>/ChatGPT.app`, then `~/Applications/ChatGPT.app`, whose `Contents/Info.plist` gives `CFBundleIdentifier` `com.openai.codex` (`APP_BUNDLES.codex`). `<apps>` is `/Applications`, or the absolute path `HARNESS_APPLICATIONS_DIR` names (the end-to-end tests' seam; a relative one is ignored, as `codexQueue.ts` `appCodexCandidates` does). The id is read by `readBundleId` (`cable/hosts/scannedApp.ts`, unchanged: `plutil -extract CFBundleIdentifier raw`, XML or binary, 1 s timeout, a checked id) through `DevicesDeps.bundleId`.
- **A failed read** is the whole read's `{ ok: false }`: the source keeps its last good list and rank. The JSON file is a failed read only when its size, mtime or file changed during its read (the app writing it). A JSON file that held still and is missing, too large, not JSON, of the wrong shape, a link or not a regular file means no projects (every thread under Recent) until its next good read (the PM, question 1 (b)).
- **Rows:** `HostAgent` with `id: observedAgentId('codex', threadId)`, `engine: 'codex'`, `sessionId: threadId`, `host: 'codex'`, `app: 'codex'`, `state: 'idle'`, `unseenDone: false`, `resting: true`, no `lastAnswer`, no `paneKeys`. Caps `{ status: true, voice: false, focus: true, answer: false }`. No `send`.
- **Tests never touch** the real ChatGPT app (its `/Applications/ChatGPT.app` Info.plist included: devices.spec's fake `bundleId`; the e2e's `HARNESS_APPLICATIONS_DIR`), its Application Support folder, the real `~/.codex`, `/usr/bin/open` (devices.spec's fake `run`; the e2e's `HARNESS_OPEN_BIN`), port 18473 or Diego's daemon and dial. Fixtures live in a temp folder or in vitest's or the e2e's throwaway `HOME`.

## Review Focus

These are the inputs and failures most likely to hurt a person, which the spec implies but its tests do not name. Each has its test in the task named.

1. **The app holds its store locked** (a checkpoint, or Codex in exclusive locking mode) past `busy_timeout`. Expected: a failed read in well under a second, the last good list kept, one `read · failed` line, nothing thrown. Tests: T1 `a store the app holds locked is a failed read, within a second`; T6 `a failed read keeps the last good list and rank`.
2. **Attach and detach churn while a read is under way** (two dials, a loose cable). Expected: a read started before a stop takes nothing, and a start meanwhile never runs a second read beside it. Test: T6 `a read started before a stop takes nothing, and a start meanwhile waits for it`.
3. **One of the app's files is a FIFO, a link or a folder.** Expected: the store is a failed read and the JSON file means no projects. Neither ever waits on an open. Tests: T1 `a store that is a FIFO is a failed read and never waits`; T1 `a JSON file that held still and is too large, not JSON, of the wrong shape, a link or a FIFO counts as no projects`.
4. **Rows Codex has not backfilled:** `recency_at_ms` is `NOT NULL DEFAULT 0` and `updated_at_ms` may be NULL. Expected: such a row falls back to `updated_at_ms`, else 0, and sorts last, always in the same order. Test: T1 `a thread's time is recency_at_ms, else updated_at_ms, else 0`.
5. **A folder of `/` or one ending in `/`** gives an empty `basename`. Expected: the row is named `codex`, never an empty name. Test: T1 in `D4: Codex's own name, else the folder's, never the store's title`.
6. **The app writes `.codex-global-state.json` while it is read** (appended, or a new file renamed over it). Expected: a failed read, so the projects do not flash to Recent and back; the next read parses it once it holds still. Test: T1 `a JSON file that changes during its read is a failed read; once it holds still it is parsed`.
7. **A dial goes while the app is looked for** (the look is a `plutil` run, up to 1 s). Expected: a look that lands after a detach, or after a newer attach's look began, starts nothing. Test: T9 `a detach while the app is looked for starts nothing; the next attach looks again`.

## Decided here, where the spec was silent

1. **A time of 0 is no time.** Codex 0.169.0 declares `recency_at_ms INTEGER NOT NULL DEFAULT 0` and `updated_at_ms INTEGER` (nullable). The spec's "else" can only mean "not a positive number". So a thread's time is `recency_at_ms` when it is > 0, else `updated_at_ms` when it is > 0, else 0. The spec's "a NULL time" test is a row with `recency_at_ms = 0` and `updated_at_ms = NULL`.
2. **When the JSON file is parsed again.** It is parsed again when its size or mtime changed, and also when the query returned a thread id the last parse was not filtered for. This keeps both of the spec's rules: entries are kept only for the threads the query returned, and the file is not re-read for nothing. Without the second trigger, an old project thread that gets a turn and comes back into the 200 would sit under Recent until the app next wrote the file. A read that saw the file change under it keeps no parse, so the next read parses it again (the app's write also wakes the watch for one).
3. **Shape of the JSON keys.** A missing or non-array `project-order`, or a missing or non-object `thread-project-assignments`, is the wrong shape: no projects. Non-string entries of `project-order` are skipped. An assignment whose `projectKind` is not `'local'`, or whose `projectId` is not a string in the kept `project-order`, is Recent (D6).
4. **Ties** are broken in JavaScript by thread id, descending as a string: the store's index order, whatever SQLite returns.
5. **Pane names.** The source gives `{ title: name, renamed: false }` per listed thread id, and an **empty** `placed` map. Codex's hooks carry no title (`hook/notify.mjs` reads `session_title`, which Claude Code sends), so the hooked copy shows the source's name (`observed.ts` `nameOf`). An empty `placed` places no thread at the ChatGPT pane, so a terminal thread's tap stays its terminal's (D5).
6. **The reader owns `there()`** (whether `~/.codex` is a folder now). `DevicesDeps.codexAppThreads` therefore answers it too, and devices.spec never touches the temporary `HOME`.
7. **The `listed` line counts the listed rows** (at most 16): `n`, and `p` of them under a project. It is said again at each attach (reset at stop), as the Claude app's source does.
8. **The source's tap calls no `noteMove`.** `opener.open` reaches `codexNoted.focus`, which notes the move once: the spec's "once, never twice".
9. **A store path that is not a regular file** is a failed read without opening it. SQLite's open waits on a FIFO forever (`sqliteBuiltin.ts` says why).
10. **What "changed during its read" is.** The descriptor's `fstat` before the read, its `fstat` after it and the path's `lstat` after it must give the same size and `mtimeMs`, and the path the descriptor's `ino`. Anything else (an append, a file renamed over it, the path gone) is a failed read. This is checked only for a file that was opened and read; one that fails before its read (missing, a link, not a regular file, too large) held still.
11. **How the app is looked for.** The candidates are fixed and checked in order, stopping at the first whose id is `com.openai.codex`. No `stat` comes first: `plutil` on a missing bundle fails and `readBundleId` gives none. The look says no log line: the spec's four forms stay the only `[codex-app]` lines, and with no app the page is today's. A look is dropped when it lands after the dial went or after a newer attach's look began (a count of looks, as `orcaRing` guards Orca's read).

---

### Task T0: Rebase on `main` once #4485 merges

**Files:** the whole branch. No other task runs while it does.

**Interfaces:**
- Produces, from #4485, for T6 to T10: `HostAgent.resting?: true`, `HostAgent.ended?: true` (`types.ts`); the registry's ended rule (`registry.ts`); `AppCounts.inFront` (`appFilter.ts`, `select.ts`); `ClaudeAppSource` built and wired in `devices.ts` (`claudeAppSource`, `claudeNoted`, the `APP_BUNDLES` import).

- [ ] **Step 1:** Wait until `gh pr view 4485 --json state -q .state` prints `MERGED` and no other task is running.
- [ ] **Step 2:** `git fetch origin && git rebase origin/main`. Conflicts to expect, each "keep both":
  - `cli/src/services/devices.ts`, the `adapters` array (if T3 landed). Take #4485's shape and put `codexNoted` straight after `claudeNoted`: `...[wezterm, orca].map(noting), claudeNoted, codexNoted, ...[vscode, cursor, cursorFolder, tabs].map(noting)`. The order wezterm, orca, claude, codex, vscode, cursor, cursor folder, tabs is kept.
  - `cli/src/cable/cableHost.spec.ts` (if T2 landed) and `cli/src/cable/hosts/observed.spec.ts` (if T4 landed): tests added beside each other.
- [ ] **Step 3:** `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts`. Expected: no type error, all pass.
- [ ] **Step 4:** Confirm the names under Interfaces exist (`grep -n "resting?: true\|ended?: true" src/cable/hosts/types.ts`, `grep -n "inFront" src/cable/hosts/appFilter.ts`, `grep -n "claudeAppSource\|claudeNoted\|APP_BUNDLES" src/services/devices.ts`). Report the new head SHA and any name that differs. No push.

### Task T1: The reader — the app's threads, their names and the sidebar's order

**Files:**
- Create: `cli/src/testing/codexAppFixture.ts`
- Create: `cli/src/cable/hosts/codexAppThreads.ts`
- Test: `cli/src/cable/hosts/codexAppThreads.spec.ts`

**Interfaces:**
- Consumes: `builtinSqlite()`, `idleWalStore()`, `DatabaseConstructor` (`lib/sqliteBuiltin.ts`, unchanged); `codexThreadName(threadId, home)` (`lib/sessionTitle.ts`, unchanged); `observedTitle` (`observedTitle.ts`); `CODEX_THREAD` (`codexQueue.ts`).
- Produces, in `codexAppThreads.ts`:
  ```ts
  export const MAX_LISTED = 16, MAX_ROWS = 200, MAX_PROJECTS = 64, MAX_STATE_BYTES = 1_048_576, MAX_CWD = 4_096
  export interface CodexAppThread {
    id: string          // checked against CODEX_THREAD: the Codex session id
    cwd: string
    name: string        // D4: observedTitle(codexThreadName(id, home)) ?? (basename(cwd) || 'codex')
    at: number          // Decided 1
    inProject: boolean  // under a project of project-order (D6), else Recent
  }
  export type CodexAppRead =
    | { ok: true; order: readonly string[]; listed: readonly CodexAppThread[]; rows: number; skipped: number }
    | { ok: false }
  /** For tests: the store's binding, and the one read of the JSON file's open descriptor. */
  export interface CodexAppSeams {
    sqlite?: () => DatabaseConstructor | null       // default builtinSqlite
    readState?: (fd: number, max: number) => Buffer  // default: readSync from position 0, at most max bytes
  }
  export class CodexAppThreads {
    constructor(home: string, seams?: CodexAppSeams)
    there(): boolean               // home is a folder now
    read(): Promise<CodexAppRead>  // never throws
    forget(): void                 // drops the JSON file's last parse (the last detach)
  }
  ```
  `order` is every kept thread id (at most 200, bad rows skipped) in sidebar order. `listed` is the newest 16 of them by `at` (ties by id, descending), given in sidebar order. `rows` is what the query returned. `skipped` is how many rows had a bad id or folder.
- Produces, in `cli/src/testing/codexAppFixture.ts`, for T1, T5 and T11:
  ```ts
  export const NEVER_READ: string  // a sentinel written to title, name, first_user_message and preview of every row
  export interface FixtureThread { id: string; cwd: string; source?: string /* 'vscode' */; archived?: 0 | 1;
    recencyAtMs?: number /* 0 */; updatedAtMs?: number | null /* null */ }
  export function codexAppFixture(home: string): {
    readonly home: string
    threads(rows: readonly FixtureThread[]): void  // makes the store (WAL) and its index when missing, INSERT OR REPLACE, closes
    update(id: string, fields: Partial<Pick<FixtureThread, 'archived' | 'recencyAtMs' | 'updatedAtMs'>>): void
    state(state: { projectOrder?: unknown; assignments?: unknown; padTo?: number } | string): void // temp file renamed over
    name(id: string, threadName: string): void     // appends {"id","thread_name"} to session_index.jsonl
    writer(): { exec(sql: string): void; close(): void } // a connection held open
  }
  ```
  The fixture opens connections through `builtinSqlite()` with `{ readOnly: false }`. `state` writes `{ 'project-order', 'thread-project-assignments' }` and pads it with spaces to `padTo` bytes. It creates this subset of Codex 0.169.0's table, with the same constraints:
  ```sql
  CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL,
    title TEXT NOT NULL, sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0, first_user_message TEXT NOT NULL DEFAULT '', updated_at_ms INTEGER,
    preview TEXT NOT NULL DEFAULT '', recency_at_ms INTEGER NOT NULL DEFAULT 0, name TEXT);
  CREATE INDEX idx_threads_recency_at_ms ON threads(recency_at_ms DESC, id DESC);
  PRAGMA journal_mode = WAL;
  ```

- [ ] **Step 1: Write the failing tests** in `codexAppThreads.spec.ts`. Each runs on a fixture in a fresh `mkdtempSync` folder and calls `resetCodexThreadNames()` before it. UUIDs are lowercase.
  - `the query keeps cli and vscode threads that are not archived`: rows of `vscode`, `cli`, `exec`, `'{"subagent":{"thread_spawn":{}}}'`, a guardian JSON source, and one `vscode` with `archived: 1`. `order` holds only the `vscode` and `cli` ids.
  - `the sidebar order: projects in project-order, each newest first, then Recent newest first`. `project-order: ['P2', 'P1']`. Two threads in each project. An assignment to `'P9'` (not in the order) and one with `projectKind: 'remote'` both go under Recent. Two Recent threads share one time. `order` is `[P2 newer, P2 older, P1 newer, P1 older, Recent by time, the tie by id descending]`.
  - `the newest 16 are listed in the sidebar order, and every kept thread is in the order`: 10 old threads in a project and 10 newer Recent ones. `listed` is the 16 newest (the 10 Recent and the 6 newest project threads), project ones first. `order.length === 20`. Each listed `inProject` is right.
  - `at most 200 rows are read`: 205 rows. `rows === 200`, `order.length === 200`, and the 5 oldest are absent.
  - `a row with a bad id or folder is skipped and counted`: an id `'NOT-A-UUID'`, an uppercase UUID, a `cwd` of `''` and one of 4,097 characters. `skipped === 4`, and none of them is in `order`.
  - `a JSON file that held still and is too large, not JSON, of the wrong shape, a link or a FIFO counts as no projects` (`it.each`). Cases: `padTo: MAX_STATE_BYTES + 1`, `'{"project-order":'`, `{ projectOrder: 'P1' }`, a symlink to a good file, and a FIFO (`execFileSync('mkfifo', …)`). Each read is `ok: true` with every thread `inProject: false`, and the read returns. A second read with the file untouched is the same (it is not parsed again: its stamp is kept).
  - `a JSON file that changes during its read is a failed read; once it holds still it is parsed` (`it.each`, Decided 10). A good file with `p1` assigned to `P`. The reader is built with a `readState` that, on its first call only, changes the file through its path and then reads the descriptor with `readSync`. Cases: it appends 10 spaces (`appendFileSync`); it renames a new good file over the path (`state()`). That read is `{ ok: false }`. The next read (the seam now only reads) is `ok: true` with `p1` `inProject: true`. A third case: the first read parses a good file, then a read whose seam appends is `{ ok: false }`, not a read with no projects.
  - `the JSON file is parsed again only when its size or mtime changed, or a thread it was not parsed for comes`. Rewrite it with the same size and other content, then `utimesSync` back to the old mtime: the order is unchanged. Change the mtime: the order changes. With the file untouched, insert a newer thread assigned in it: it is under its project.
  - `at most 64 project ids are kept`: `project-order` of 70 ids. A thread assigned to the 65th is Recent.
  - `a missing store, a missing table or a missing column is a failed read`: no file; the table renamed (`ALTER TABLE threads RENAME TO t2`); a store made without `recency_at_ms`. Each is `{ ok: false }`.
  - `no SQLite binding is a failed read`: `new CodexAppThreads(home, { sqlite: () => null })` gives `{ ok: false }`.
  - `no connection outlives a read: a writer can checkpoint and remove the WAL after it`. Hold `writer()` with a write, so `-wal` exists. Read: `ok: true`. Then the writer runs `PRAGMA wal_checkpoint(TRUNCATE)` and closes. `existsSync(store + '-wal')` and `existsSync(store + '-shm')` are both false.
  - `an idle store is read immutable and leaves no -wal or -shm`: after `threads()` closed, a read leaves neither file.
  - `a store the app holds locked is a failed read, within a second`. The writer runs `PRAGMA locking_mode = EXCLUSIVE`, then a write, and stays open. The read is `{ ok: false }` and takes under 1,000 ms (`performance.now()`). After the writer closes, the next read is `ok: true`.
  - `a store that is a FIFO is a failed read and never waits`: `state_5.sqlite` is a FIFO. The result is `{ ok: false }`.
  - `D4: Codex's own name, else the folder's, never the store's title`. `name(id, 'Fix the build')` names one thread, and a 100-character name is cut by `observedTitle` to 64. Others get `basename(cwd)`. A `cwd` of `'/'` gives `'codex'`. `JSON.stringify(result)` never contains `NEVER_READ`.
  - `a thread's time is recency_at_ms, else updated_at_ms, else 0`. `a` (recency 400), `b` (recency 0, updated 500) and `c` (recency 0, updated NULL) are all Recent. `order` is `[b, a, c]`, and `listed` gives `at` values `500, 400, 0`.
  - `there() is whether the home is a folder`: false with none, false for a file, true once made.
- [ ] **Step 2: Run them to see them fail.** Run: `cd cli && npx vitest run src/cable/hosts/codexAppThreads.spec.ts`. Expected: FAIL, as `codexAppThreads.js` does not exist. Commit the red (the spec and the fixture helper).
- [ ] **Step 3: Implement `CodexAppThreads`** in `codexAppThreads.ts`:
  - **SQLite.** Stat the store first: not a regular file means a failed read. `immutable = idleWalStore(path)`. When immutable, open `pathToFileURL(path)` with `search = 'immutable=1'`, else the plain path; both `{ readOnly: true }`. Then `PRAGMA busy_timeout = 50`, the Global Constraints' query, and `close()` in a `finally`. Any throw is `{ ok: false }`.
  - **The JSON file.** `lstat` it first and parse it again only by Decided 2. Open it with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, `fstat` it (a regular file, at most 1 MiB) and read at most `MAX_STATE_BYTES + 1` bytes from that descriptor through `seams.readState`. Then check it held still (Decided 10): if not, the whole read is `{ ok: false }` and the last parse is kept untouched, with no new stamp. A file that held still and fails (missing, a link, not a regular file, too large, not JSON, the wrong shape) is a parse with no projects, kept under its stamp until its next change. A good parse keeps only `{ stamp, order (≤ 64), assignments for this read's ids, ids }`. Close the descriptor in a `finally`.
  - **Order and names** by "The sidebar's order" in the spec, Decided 1, 3 and 4. Names only for `listed`. Nothing is logged here.
- [ ] **Step 4: Run the tests to see them pass.** Run: `npx vitest run src/cable/hosts/codexAppThreads.spec.ts && npm run typecheck`. Expected: PASS, no type error.
- [ ] **Step 5: Commit** `dial: the ChatGPT app's threads, read from its metadata in its sidebar's order`.

### Task T2: `setRank(app, undefined)` drops the app's rank

**Files:** Modify `cli/src/cable/cableHost.ts` (`DaemonCableHost.setRank`). Test: `cli/src/cable/cableHost.spec.ts` (beside `the same rank read again moves nobody, and a new rank reorders`).

**Interfaces:** Produces `setRank(app: string, rank: RingRank | undefined): void`, where `undefined` deletes the app's entry.

- [ ] **Step 1: Write the failing test** `a rank set to undefined is dropped: an agent that enters next takes no place from it`. On `mixed()`, `setRank('orca', new Map([['o4', 0], ['o3', 1], ['o1', 2], ['o2', 3]]))` reads `['o3', 'o1', 'o2']` with `{ apps: true }`. Then `setRank('orca', undefined)`, push `agent('o4', 'orca')`, and the read is `['o3', 'o1', 'o2', 'o4']`.
- [ ] **Step 2: Run it to see it fail.** Run: `cd cli && npm run typecheck`. Expected: TS2345 at the new call (`undefined` is not a `RingRank`). The vitest run alone passes, as a Map holding `undefined` already reads as no rank: the change is the signature and a `delete`, so no entry is held for nothing. Commit the red.
- [ ] **Step 3:** `if (rank) this.ranks.set(app, rank); else this.ranks.delete(app)`. The doc comment says `undefined` drops it.
- [ ] **Step 4:** `npm run typecheck && npx vitest run src/cable/cableHost.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: setRank takes undefined, which drops the app's rank`.

### Task T3: The ChatGPT adapter is named `codexNoted`

**Files:** Modify `cli/src/services/devices.ts` (beside `cmuxAppNoted`, and the `adapters` array).

**Interfaces:** Produces `const codexApp = createCodexAppAdapter({ ...apps, bin: openBin, inFront: () => cableHost.latestFront() === 'codex', log })` and `const codexNoted = noting(codexApp)`. T9 uses `codexApp.canShow` and `codexNoted.show!`.

- [ ] **Step 1:** Move the inline `createCodexAppAdapter(…)` out of the `.map(noting)` array into the two names above. Keep the comment "No echo to guard: the Codex app sends no attach…" on `codexNoted`. Put `codexNoted` in the array between the claude entry and VS Code: `[herdrNoted, tmux, herdrAppNoted, cmuxAppNoted, ...[wezterm, orca, claude].map(noting), codexNoted, ...[vscode, cursor, cursorFolder, tabs].map(noting)]`. The order of the adapters is unchanged.
- [ ] **Step 2:** `cd cli && npm run typecheck && npx vitest run src/services/devices.spec.ts && npm run test:core`. Expected: all pass, and `devices.ts` stays at 100%.
- [ ] **Step 3: Commit** `dial: the ChatGPT app's noted adapter has a name, for a second source to reach it`.

### Task T4: Pin — a hooked ChatGPT thread takes the `codex` pane names

**Files:** Test: `cli/src/cable/hosts/observed.spec.ts` (beside `an agent in a pane with a name, and none of its own, is called by it`, using the ChatGPT setup with `inApp`/`pane` and `THREAD`).

**Interfaces:** Consumes `ObservedSource.setPaneNames(adapter, names, placed)`, unchanged. T9 relies on what these tests hold.

- [ ] **Step 1: Write the tests.**
  - `a hooked ChatGPT thread is called by the codex pane names, and keeps the name at its next hook`. After `session-start` with `__CFBundleIdentifier: 'com.openai.codex'`, `setPaneNames('codex', named([THREAD, 'Fix the build']), none)`. `list()[0].name` is `'Fix the build'`, and it still is after a `turn-start`.
  - `an empty placed map places no Codex thread at the codex pane: a terminal thread keeps its folder's name and its tap`. A Codex thread in Ghostty (no codex pane), named in the map, keeps `basename(cwd)`, and `placedAt(id, 'codex')` is undefined.
- [ ] **Step 2:** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts`. Expected: PASS on the current code. If either fails, stop and report: the spec's D4 assumed this seam works as is.
- [ ] **Step 3: Commit** `test(dial): a hooked ChatGPT thread takes the name its pane is given`.

### Task T5: The read's numbers

**Files:** Create `cli/scripts/benchmark-codex-app-threads.ts`.

**Interfaces:** Consumes `CodexAppThreads` and `codexAppFixture` (T1).

- [ ] **Step 1: Write the script**, modelled on #4485's `cli/scripts/benchmark-claude-app-store.ts`. It sets a throwaway `HOME` (and the `ADAPTER_*` and `HARNESS_AUTH_DIR` folders) before any module of the tree loads, and removes it in a `finally`. Its usage line: `node --import tsx scripts/benchmark-codex-app-threads.ts [output.json]`. The fixture homes hold 20, 200 and 2,000 threads (half in 4 projects), a `.codex-global-state.json` padded to 135,000 bytes and a `session_index.jsonl` naming every thread. Cases, each 100 runs, reporting `medianMs` and `p90Ms`:
  - `warm-20`, `warm-200`, `warm-2000`: one reader, store idle (immutable).
  - `warm-200-wal`: a `writer()` held open with a write, so the read is `mode=ro`.
  - `first-200`: a new `CodexAppThreads` each run, so the JSON file is parsed each time.
  - **The event loop's block, before and after:** `monitorEventLoopDelay({ resolution: 1 })` over 100 `setImmediate` turns with no read (before), then over 100 `warm-200` reads one per turn (after). Report each run's max and p99 in ms.

  It prints and writes `{ node, platform, arch, cases, loop: { before, after } }`.
- [ ] **Step 2:** `cd cli && node --import tsx scripts/benchmark-codex-app-threads.ts "$TMPDIR/codex-app-bench.json"`. Expected: the JSON prints. Keep it for the pull request's body.
- [ ] **Step 3: Commit** `bench(dial): a script that measures the ChatGPT app threads' read`.

### Task T6: The listing source `CodexAppSource`

**Files:**
- Create: `cli/src/cable/hosts/codexAppSource.ts`
- Test: `cli/src/cable/hosts/codexAppSource.spec.ts`

**Interfaces:**
- Consumes: `CodexAppThreads`, `CodexAppRead` (T1); `HostAgent.resting` (T0); `observedAgentId`, `PaneName` (`observed.ts`); `RingRank` (`select.ts`); `Caps`, `HostSource`, `PaneSwitch` (`types.ts`).
- Produces:
  ```ts
  export interface CodexAppSourceDeps {
    threads: Pick<CodexAppThreads, 'there' | 'read' | 'forget'>
    watch(changed: (file?: string) => void): () => void  // devices.ts binds it to watchNearest([codexHome])
    after(ms: number, run: () => void): () => void
    focus(threadId: string, agentId: string): Promise<boolean>
    canShow(threadId: string): boolean
    show(threadId: string, agentId: string): Promise<PaneSwitch>
    rank(rank: RingRank | undefined): void               // devices.ts: cableHost.setRank('codex', rank)
    monotonic(): number
    log(line: string): void
  }
  export class CodexAppSource implements HostSource {
    readonly id = 'codex-app'
    start(): void; stop(): void
    onChange(listener: () => void): () => void
    list(): HostAgent[]; capabilities(): Caps
    focus(agent: HostAgent): Promise<boolean>; hasPane(agent: HostAgent): boolean; showPane(agent: HostAgent): Promise<PaneSwitch>
    paneNames(): ReadonlyMap<string, PaneName>  // thread id → { title: name, renamed: false } for the listed rows
  }
  ```

- [ ] **Step 1: Write the failing tests** with a fake `threads` the test answers. It can hold a read until landed and records `there`, `read` and `forget`. `after` is a fake clock and `watch` records its `changed`.
  - `each listed thread is an idle resting row under the observed id, with no voice and no send`. The fields are those of Global Constraints' "Rows", with `name`, `cwd` and `lastActivityAt = at` from the read. `capabilities()` is as there, and `'send' in source` is false.
  - `a tap opens the thread through focus; a swipe asks canShow and shows it`. `focus(row)` calls `deps.focus(threadId, agentId)`, `hasPane` calls `canShow(threadId)` and `showPane` calls `show(threadId, agentId)`. An id it does not list gives `false` / `false` / `'failed'`.
  - `an event naming the store, its WAL, the global state, the session index or nothing reads; any other name does nothing` (`it.each` over `state_5.sqlite`, `state_5.sqlite-wal`, `.codex-global-state.json`, `session_index.jsonl` and `undefined`, against `state_5.sqlite-shm`, `logs_2.sqlite` and `sessions`).
  - `one read at a time, and changes during it give one more, at least 1 s after its start`. Three events during a held read; land it. At 999 ms no read; at 1,000 ms exactly one.
  - `onChange and the rank only when the list or the order changes; a new time alone changes neither`. The same order with new `at` values: no `onChange` and no `rank` call, but `list()` shows the new `lastActivityAt`. A new name: `onChange`, no `rank`. A new order of the kept ids (one outside the 16 moves): `rank` once, with a new `Map` giving each `observedAgentId('codex', id)` its index in `order`.
  - `a failed read keeps the last good list and rank, and says read · failed once a run`. ok, failed, failed, ok, failed: two `read · failed` lines, and the list and rank stay those of the last ok. One of the failed reads stands for a JSON file the app wrote mid-read (T1 gives it as `{ ok: false }`, the PM's question 1 (b)): the source tells such a read from no other, and needs no code of its own for it.
  - `a good read with no projects is taken: its order replaces the last`. ok with `p1` in a project (order `[p1, r1]`), then ok with every thread under Recent (order `[r1, p1]`, as T1 gives for a JSON file that held still and is not JSON): `rank` is called with the new order and `listed · 2 threads · 0 in projects` is said.
  - `with no good read yet, nothing is listed and no rank is set`.
  - `stop drops the rows (told once), the rank, the watch and the reader's memory`. After stop: `rank(undefined)`, the watch's stop called, `forget()` called, `list()` empty, `paneNames()` empty, one `onChange`.
  - `the home's wait`. With `there()` false: `[codex-app] watch · none`, no watch, no read. The next start with `there()` true: `watch · on`, the watch, a read. Starting again in the same state says no watch line.
  - `a read started before a stop takes nothing, and a start meanwhile waits for it` (Review Focus 2). Hold a read; stop; start: no second `read` call until the held one lands. Its result is not listed, then the new start's read runs.
  - `its lines are counts and fixed words`. `listed · 3 threads · 1 in projects` when either count changes, said again after a stop and start. `read · <ms> ms · <rows> rows · <skipped> skipped` at the first read of a start and at a slower one, not at a faster one. No line contains a name, folder or id from the fixture.
  - `paneNames() names each listed thread, renamed false`.
- [ ] **Step 2: Run them to see them fail.** Run: `cd cli && npx vitest run src/cable/hosts/codexAppSource.spec.ts`. Expected: FAIL, the module missing. Commit the red.
- [ ] **Step 3: Implement `CodexAppSource`.** Its pass state follows #4485's `ClaudeAppSource` (`under`, `tooSoon`, `again`, a `stops` count, `there` kept across a detach) with `GAP_MS = 1_000`. Store the watched names in one `ReadonlySet`. The rows' shape for `onChange` is `[id, name, cwd]` in order. The order key is `order.join('\n')`. The read's `ms` is measured with `deps.monotonic`. Its file comment says why reads are pushed and floored at 1 s: Codex writes its WAL several times a second during any turn.
- [ ] **Step 4:** `npx vitest run src/cable/hosts/codexAppSource.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: the ChatGPT app's threads are a listing source, resting, in its sidebar's order`.

### Task T7: Pin — one row per ChatGPT thread in the registry

**Files:** Test: `cli/src/cable/hosts/registry.spec.ts`.

**Interfaces:** Consumes `HostRegistry`, `HostAgent.ended` (T0). A fake source with `id: 'codex-app'`.

- [ ] **Step 1: Write the tests.**
  - `an observed copy and a codex-app copy of one ChatGPT thread are one row, the observed one`: same `engine: 'codex'`, `sessionId`, `id`, no `paneKeys`.
  - `an ended observed copy gives its row to the codex-app copy of its thread`: the observed copy with `ended: true`. The entry listed is the codex-app one.
- [ ] **Step 2:** `cd cli && npx vitest run src/cable/hosts/registry.spec.ts`. Expected: PASS on #4485's registry. If either fails, stop and report.
- [ ] **Step 3: Commit** `test(dial): a ChatGPT thread hooked and listed is one row`.

### Task T8: D7 — the single machine ring leaves resting rows out

**Files:** Modify `cli/src/cable/cableHost.ts` (`machineSnapshot`, the `this.ring.select(listed)` branch only). Test: `cli/src/cable/cableHost.spec.ts`.

**Interfaces:** Consumes `HostAgent.resting` (T0).

- [ ] **Step 1: Write the failing test** `a dial that does not say appFilter swipes no resting row; the app's page still lists them`. Agents: `g1` live in Ghostty, then `c1`, `c2` and `c3` resting on `codex` with newer `lastActivityAt`. `listAgentSnapshot()` gives `['g1']` and `total: 1`. After `pickApp('codex')`, `listAgentSnapshot({ apps: true })` lists `c1`, `c2` and `c3`.
- [ ] **Step 2:** `cd cli && npx vitest run src/cable/cableHost.spec.ts`. Expected: FAIL, the single ring listing four. Commit the red.
- [ ] **Step 3:** `this.ring.select(listed.filter((a) => !a.resting))`, with a comment on why: 16 resting threads would push live idle agents out of the 16 places (D7). The app rings and `counts` are untouched.
- [ ] **Step 4:** `npx vitest run src/cable/cableHost.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: a dial with one ring of the whole machine lists no resting row`.

### Task T9: The devices run the source

**Files:** Modify `cli/src/services/devices.ts`. Test: `cli/src/services/devices.spec.ts` (a new `describe("the ChatGPT app's threads, from its metadata (docs/plans/2026-11-19-dial-chatgpt-ring-and-follow-design.md)")`, shaped as #4485's `withStore` block; the hooked thread as the existing `inCodexApp` helper builds one).

**Interfaces:**
- Consumes: `CodexAppSource`, `CodexAppSourceDeps` (T6); `CodexAppThreads` (T1); `codexApp`, `codexNoted` (T3); `setRank(app, undefined)` (T2); `observed.setPaneNames` (T4); `readBundleId` (`cable/hosts/scannedApp.ts`, unchanged; `devices.ts` already imports from that module); `APP_BUNDLES.codex` (T0).
- Produces:
  - `DevicesDeps.codexAppThreads?: CodexAppSourceDeps['threads']` ("For this service's tests: the reader of the ChatGPT app's threads").
  - `DevicesDeps.bundleId?: (app: string) => Promise<string | undefined>` ("For this service's tests: an app bundle's id from its Info.plist; `readBundleId` (cable/hosts/scannedApp.ts) by default"). No test reads a real app's Info.plist.
  - The env seam `HARNESS_APPLICATIONS_DIR`: an absolute path read in place of `/Applications` when the ChatGPT app is looked for; for the end-to-end tests (T11), as `HARNESS_OPEN_BIN` is.

- [ ] **Step 1: Write the failing tests.** `start()` passes `codexAppThreads: over.codexAppThreads ?? noCodexApp`, where `noCodexApp` answers `there: () => false`, so no test reads vitest's temporary `HOME`, and `bundleId: over.bundleId ?? (async () => undefined)`, so no test runs `plutil`. The block's fake reader answers `there: () => true` and a `read` the test sets. The block's `bundleId` fake records each path asked, answers `'com.openai.codex'` for `APPS = join('/Applications', 'ChatGPT.app')` unless the test says otherwise, and can hold an answer until landed. Each test stubs `HARNESS_APPLICATIONS_DIR` unset (`vi.stubEnv`, restored after). After an attach, a test waits for the look to land (`until`, no sleep) before it asserts. `THREAD` is a lowercase UUID and `ID = observedAgentId('codex', THREAD)`. `opened = (id) => ['/usr/bin/open', ['-b', 'com.openai.codex', `codex://threads/${id}`], 10_000]`.
  - `on macOS with a dial attached the app's threads are listed sf, idle, on the ChatGPT page, the Codex home alone watched; detached, the source stops, its watch closes, the reader forgets and the rank goes`. Nothing is read and no app looked for before attach. After it, `listed()` is `[{ id: ID, name: 'Fix the build', caps: 'sf' }]` and `appOf(ID) === 'codex'`. `watchedFolders.calls` holds `[[join(homedir(), '.codex')], fn]`, and no call names `homedir()` alone. After detach: `listed()` is empty, the watch is stopped, `forget` was called, and a `vi.spyOn(host(), 'setRank')` was last called with `('codex', undefined)`.
  - `off macOS, or with HARNESS_DEVICE_OBSERVED off, there is no source` (`it.each`, as #4485's): the fake's `there` and `read` are never called, and no app is looked for.
  - `the source runs only with the ChatGPT app installed, looked for in /Applications, then ~/Applications` (`it.each`, the PM's question 2). Cases, each the paths asked in order and whether the source starts:
    - the app in `/Applications`: asked `[APPS]` alone; starts (`there` and `read` called, the row listed);
    - in `~/Applications` alone (`APPS` answers undefined, `join(homedir(), 'Applications', 'ChatGPT.app')` answers the id): asked both, in that order; starts;
    - neither: asked both; not started (`there` and `read` never called, no `[codex-app]` line, `listed()` empty);
    - a `ChatGPT.app` of another id in both (`'com.openai.chat'`): asked both; not started.
  - `the app is looked for at each attach: gone at the next attach, the source is stopped; back, it starts`. Attach with the app: listed. Detach. Attach with `bundleId` answering undefined: `listed()` empty and no new `read`. Detach, then attach with the app: listed again.
  - `a detach while the app is looked for starts nothing; the next attach looks again` (Review Focus 7). Hold the look; detach; land it with the id: `there` and `read` never called and `listed()` empty. Attach again: a second look, and the row is listed. Also: attach (held look 1), detach, attach (look 2 answers undefined), land look 1 with the id: nothing starts.
  - `HARNESS_APPLICATIONS_DIR, when absolute, is looked in for the app in place of /Applications; a relative one is ignored` (`it.each`). `'/tmp/apps'` → asked `join('/tmp/apps', 'ChatGPT.app')` then `~/Applications`'s, never `APPS`. `'apps'` → asked `APPS` first.
  - `the ChatGPT page's ring is in the reader's order, a hooked thread's copy in its place too`. The fake's `listed` is A, B, C (A newest) and its `order` is `[B, A, C]`. Then a hooked copy of A arrives (`port.observed`, ChatGPT hints). With `{ apps: true }` and the codex page shown, ids are `[B, A, C]` as agent ids, before and after the hook.
  - `a tap on a thread row is one open of its link with the ChatGPT bundle, and the dial's own move`. `openAgent(ID)` runs `orcaRuns` `[opened(THREAD)]`. The settle echo is the Claude app's alone, so the move shows through the tab report: a Terminal tab report waits for Terminal's settle (`tabReported`), the tap comes, then Terminal settles, and the log says `[device] tab · skipped · echo` (`followTab` reads `report.moves !== dialMoves`; see the tests around `nine selects inside 2 s keep the newest eight`).
  - `a tap whose link fails brings the app by its bundle, said in one line with no id`: `[opened(THREAD), ['/usr/bin/open', ['-b', 'com.openai.codex'], 10_000]]`, `[device] open · codex · fallback`, and no log line contains `THREAD`.
  - `a rest with the ChatGPT app in front shows the thread by its link; with another app in front it has no pane`.
  - `a hooked ChatGPT thread the reader lists is one row, under the same id, named as the reader names it`. After `session-start` with `cwd: '/work/api'`, `listed()` holds one row with `id: ID` and `name: 'Fix the build'`, not `'api'`. Its caps are the hooked copy's own: assert the id and name only.
- [ ] **Step 2:** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: the new tests FAIL (no source), the rest pass. Commit the red.
- [ ] **Step 3: Wire it in `devices.ts`.**
  - `const codexAppHome = join(homedir(), '.codex')`. Its comment says it is the app's Codex home, not Harness's `CODEX_HOME`.
  - After `claudeAppSource`: `const codexAppSource = observed && apps.platform === 'darwin' ? new CodexAppSource({…}) : null`, with:
    - `threads: deps.codexAppThreads ?? new CodexAppThreads(codexAppHome)`
    - `watch: (changed) => watchNearest([codexAppHome], changed)`
    - `after: timerIn('codex-app')`
    - `focus: (threadId, agentId) => opener.open(agentId, { bundle: APP_BUNDLES.codex, pane: codexPane(threadId) })`, with no `noteMove` (Decided 8)
    - `canShow: (threadId) => codexApp.canShow(codexPane(threadId))`
    - `show: (threadId, agentId) => codexNoted.show!(codexPane(threadId), agentId)`
    - `rank: (rank) => cableHost.setRank('codex', rank)`
    - `monotonic`, `log`
  - `codexPane = (threadId: string): Pane => ({ adapter: codexApp.id, id: threadId })`.
  - Append `codexAppSource` to the `HostRegistry` list after `claudeAppSource`.
  - `codexAppSource?.onChange` → `part.call('codex-app', () => observed.setPaneNames('codex', codexAppSource.paneNames(), new Map()))` and `part.call('dial', outsideTurn)`.
  - Beside `openBin`: `const appsDir = process.env.HARNESS_APPLICATIONS_DIR`, and `const chatGptApps = [join(appsDir && isAbsolute(appsDir) ? appsDir : '/Applications', 'ChatGPT.app'), join(homedir(), 'Applications', 'ChatGPT.app')]`. Its comment says why the seam exists: `/Applications` is the computer's whatever the home, so the end-to-end harness points it inside the daemon's root (as `HARNESS_CODEX_APP_BIN`, `codexQueue.ts`).
  - `const bundleId = deps.bundleId ?? ((app: string) => readBundleId(app))` and `async function chatGptInstalled(): Promise<boolean>`: for each of `chatGptApps` in order, `true` at the first whose `await bundleId(app) === APP_BUNDLES.codex`; else `false` (Decided 11).
  - In `dialAttached`, beside cmux's line (inside the same `observed` guard): `if (codexAppSource) part.call('codex-app', () => { const look = ++codexAppLooks; if (!on) return codexAppSource.stop(); return chatGptInstalled().then((found) => { if (look !== codexAppLooks) return; found ? codexAppSource.start() : codexAppSource.stop() }) })`, with `let codexAppLooks = 0` beside `cmuxFound`. Its comment says: only with the ChatGPT app installed, looked for at each attach as cmux's is, so a Mac with only Codex CLI gets no ChatGPT page of threads a tap cannot open; a look that lands after the dial went or after a newer look began starts nothing. The `dialAttached` doc comment names the source too.
  - No other test's log changes: `start()`'s default `bundleId` finds no app, so the source never starts outside the new block. If one does change, the default is not wired: fix that, never the other test.
- [ ] **Step 4:** `npx vitest run src/services/devices.spec.ts && npm run typecheck && npm run test:core`. Expected: PASS, and `devices.ts` at 100%.
- [ ] **Step 5: Commit** `dial: the ChatGPT app's threads are on its page, in its sidebar's order`.

### Task T10: Say it in the docs

**Files:** `cli/AGENTS.md` (the devices row), `cli/src/cable/hosts/types.ts` (comments only), `docs/specs/2026-11-15-device-host-adapter.md`.

- [ ] **Step 1:** In `cli/AGENTS.md`'s devices row, after the Claude app's clause, add one clause. It says: the ChatGPT app's Codex threads, with or without a process, listed from the app's own metadata (`~/.codex/state_5.sqlite`, table `threads`, read only on a connection opened and closed at each read, and `.codex-global-state.json`'s project order) when one of them changes, at most one read a second, while a dial is attached, on macOS, with the ChatGPT app installed (looked for at each attach), in the app's sidebar order (`cable/hosts/codexAppSource.ts`, `codexAppThreads.ts`), and opened by the ChatGPT app's link (`cable/hosts/codexApp.ts`). Rows with no process show on their app's page only, never in the single ring of a dial that does not say `appFilter`.
- [ ] **Step 2:** In `types.ts`, `HostAgent.resting` names `codexAppSource.ts` beside `claudeAppSource.ts` and says it is left out of the single machine ring (`cableHost.ts` `machineSnapshot`). `HostSource.id` lists `codex-app`.
- [ ] **Step 3:** In the host adapter spec, the de-duplication row lists the ChatGPT app's threads among the listing sources. A paragraph beside the Claude app's says those threads come from a listing source of the app's metadata, folded with the hooked copy by session id (the thread id) and ranked in the app's sidebar order ([ChatGPT app](../plans/2026-11-19-dial-chatgpt-ring-and-follow-design.md)).
- [ ] **Step 4:** `cd cli && npm run typecheck`. Expected: no error. **Commit** `docs(dial): the ChatGPT app's threads reach the dial from its metadata`.

### Task T11: End to end — the ChatGPT page from a fixture `~/.codex`

**Files:** Create `cli/e2e/deviceCodexAppThreads.e2e.ts`, modelled on `cli/e2e/dialCodexApp.e2e.ts` and #4485's `cli/e2e/deviceClaudeAppSessions.e2e.ts` (`rosters`, `showing`, `said`, `sourceLines`). Modify `cli/e2e/harness/daemon.ts` (`daemonEnvironment`, beside `HARNESS_CODEX_APP_BIN`).

**Interfaces:** Consumes `codexAppFixture`, `NEVER_READ` (T1); `observedAgentId`; `IsolatedDaemon`, `Desk`, `until`; `HARNESS_APPLICATIONS_DIR` (T9).

- [ ] **Step 0: Every daemon under test looks for the ChatGPT app inside its root.** In `daemonEnvironment`, beside `HARNESS_CODEX_APP_BIN`, set `HARNESS_APPLICATIONS_DIR: join(own, 'Applications')`, missing until a test writes its own. Its comment, in the shape of the `HARNESS_CODEX_APP_BIN` one: nor does a fake dial's attach start the ChatGPT app's source on the developer's app (`services/devices.ts`): `/Applications` is the computer's, whatever the home, so the devices look there in its place; `~/Applications` is already the throwaway home's. So no e2e file passes or fails by whether this Mac has the ChatGPT app.
- [ ] **Step 1: Write the test**, `describe.skipIf(process.platform !== 'darwin')`, with one dial of `{ appFilter: 'v1' }`.
  - **Before the daemon starts:** `HARNESS_OPEN_BIN`, `HARNESS_APPLICATIONS_DIR` and `HOME` are inside `d.root`, and `HARNESS_APPLICATIONS_DIR` holds no `ChatGPT.app`. The fake app: `join(d.env.HOME!, 'Applications', 'ChatGPT.app', 'Contents', 'Info.plist')`, an XML plist whose `CFBundleIdentifier` is `com.openai.codex` (and nothing else of the app). The daemon's real `plutil` reads it. The fixture goes in `join(d.env.HOME!, '.codex')`, checked inside `d.root`. That is not `d.env.CODEX_HOME`, which the harness sets to `<root>/codex`.
  - **The fixture:** project `P` with threads `p1` (now − 5 s) and `p2` (now − 6 s); Recent `r1`, `r2` and `r3` (now − 1, 2 and 3 s); `a1` archived and `e1` with source `exec`, both newer. `project-order: ['P']` with `p1` and `p2` assigned. `session_index.jsonl` names `p1` `Fixture Named`.
  - **The steps:**
    1. The `apps` message shows `codex`. Rows are `[p1, p2, r1, r2, r3]` as agent ids with `caps: 'sf'`, `p1` named `Fixture Named` and the rest by their folders.
    2. A `focus` on each row runs no `open`, as nothing is in front.
    3. `agent.open` on `r1` makes `d.opens()` equal `[['-b', 'com.openai.codex', `codex://threads/${r1}`]]`.
    4. `update(r2, { archived: 1 })`: `[codex-app] listed · 4 threads · 2 in projects` is said and rows become `[p1, p2, r1, r3]`. Log the time from the write to that line and to the list, as #4485's test does.
    5. `update(r3, { recencyAtMs: Date.now() })`: rows become `[p1, p2, r3, r1]`.
    6. Every `[codex-app]` line matches `/^\[codex-app\] (watch · (on|none)|listed · \d+ threads · \d+ in projects|read · \d+ ms · \d+ rows · \d+ skipped|read · failed)$/`. The whole log contains none of `NEVER_READ`, `Fixture Named`, a fixture folder or a thread id. `d.opens()` is still the one open.
- [ ] **Step 2:** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceCodexAppThreads.e2e.ts`. Expected: PASS on this Mac. Keep the timing line for the pull request.
  Also run `e2e/dialCodexApp.e2e.ts` once: with the harness's `HARNESS_APPLICATIONS_DIR` it passes whether or not this Mac has the ChatGPT app.
- [ ] **Step 3: Commit** `e2e: the ChatGPT app's threads on the dial, from a fixture ~/.codex`.

## Settled questions (the PM, 2026-11-19; the spec carries both)

1. **A `.codex-global-state.json` that is not JSON: (b).** A file whose size or mtime changed during its read is a failed read: the last good list and rank stay. A file that held still and is too large, not JSON or of the wrong shape means no projects (every thread under Recent) until its next good read. Folded into: Global Constraints ("A failed read"); Decided 2 and 10; Review Focus 6; T1's `CodexAppSeams.readState`, its Step 3 JSON part, its `held still` case and its new `changes during its read` case; T6's failed-read case and its new `a good read with no projects is taken` case (no T6 code changes).
2. **The source runs only when the ChatGPT app is installed: yes.** `ChatGPT.app` in `/Applications` or `~/Applications` whose bundle id is `com.openai.codex`, looked for at each attach, as cmux's `cmuxFound`. No app: the source is not started (stopped if running). The id comes from the bundle's `Contents/Info.plist` through the existing `readBundleId` (`scannedApp.ts`: `plutil -extract CFBundleIdentifier raw -o -`, binary or XML, 1 s timeout) behind `DevicesDeps.bundleId`, so no unit test reads a real app. `/Applications` has the seam `HARNESS_APPLICATIONS_DIR`, set inside every e2e daemon's root by the harness. Folded into: Architecture; Global Constraints ("Where it runs", "Tests never touch"); Decided 11; Review Focus 7; T9 (Interfaces, five new cases, Step 3); T10 Step 1's clause; T11 (Step 0, the fake `~/Applications/ChatGPT.app`); Verification.

## The pull request's body

- Platforms: macOS, where the source runs. Linux and Windows: nothing changes, and a devices.spec case with `platform: 'linux'` holds that no source is built.
- The red-then-green commits of T1, T2, T6, T8 and T9.
- T5's JSON (median and p90 of 100 runs for 20, 200 and 2,000 threads; the event loop before and after).
- T11's run and its timing line.
- The local gates below, with `local-checks.py`'s receipt.
- `git diff --stat origin/main -- cli/src/core cli/src/architecture.coreFiles.txt cli/src/lib/sqliteBuiltin.ts cli/src/lib/sessionTitle.ts` printing nothing.

## Verification

**Platforms:** macOS only. On Linux and Windows nothing a person sees changes (T9's `it.each`).

**Required local gates**, at the final head, recorded in the pull request:
- `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts`.
- `cd cli && npm run test:core`: `services/devices.ts` changes, and it must stay at 100%.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit, with its receipt in the body before the push.
- `git diff --stat origin/main -- cli/src/core cli/src/architecture.coreFiles.txt cli/src/lib/sqliteBuiltin.ts cli/src/lib/sessionTitle.ts` prints nothing.

**End-to-end check (this Mac, a devcrew tester):**
- **What runs:** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceCodexAppThreads.e2e.ts e2e/dialCodexApp.e2e.ts e2e/deviceClaudeAppSessions.e2e.ts`. The new file is the check. The other two hold the shared seams: the ChatGPT page's hooked rows, and the Claude app's resting rows with D7 in place.
- **Isolation:** the suite's own (`e2e/harness/daemon.ts`). That means the real daemon from the working tree on a private port, a throwaway `HOME` under its root holding the fixture `.codex/` and a fake `Applications/ChatGPT.app/Contents/Info.plist` (bundle id `com.openai.codex`, nothing else), `HARNESS_APPLICATIONS_DIR` inside the root in place of `/Applications` (T11 Step 0), `CODEX_HOME` at `<root>/codex`, and the fake `open` (`HARNESS_OPEN_BIN`) inside the root. The result does not depend on whether this Mac has the real ChatGPT app. There is no backend.
- **What a person sees** in the test's assertions: the page appears because the fake app is found; the ChatGPT page lists the five threads, idle, the project's two first, then Recent newest first. A turn walks them in that order. A tap runs the fake `open -b com.openai.codex codex://threads/<id>`. Archiving one removes its row within a few seconds. A Recent thread given a newer time moves to the head of Recent. The log holds the `[codex-app]` lines and no title, folder or id.
- **Where else:** these files run on this Mac only. `cli-e2e.yml` (CLI end to end, run by hand from a branch) runs on Linux, where the new file is skipped, so it proves nothing for this change. Start it only with the PM's turn.
- **No temporary workflow:** the check is one short file that needs macOS, and it runs here under the suite's isolation.

**Numbers (this Mac):** T5's script, its JSON in the body.

**Never touched by a tester or a test:** the real ChatGPT app (its `/Applications/ChatGPT.app` Info.plist included), its Application Support folder, the real `~/.codex`, `/usr/bin/open`, Diego's daemon and dial, any backend, production. No gate runs a real or renamed ChatGPT app.

**Diego's own check, after the merge** (his app, his dial, his eye; no tester runs it): the dial's ChatGPT page holds his project's threads and his Recent Codex threads, in the sidebar's order, and a tap on a resting one opens it in the app.

**Against production:** none.

## Follow-ups (proposals, not this branch)

- Following the thread picked in the app (bug 2): the PM's Accessibility question to Diego.
- Threads grouped by folder (`local-projects`' `rootPaths`), pinned threads and a custom order inside a project, if Diego's sidebar shows them (D6).
