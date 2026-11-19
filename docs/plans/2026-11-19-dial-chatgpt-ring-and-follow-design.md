# The ChatGPT app's page on the dial: its sidebar's threads, in its sidebar's order

Branch: `fix/dial-chatgpt-ring-and-follow`. Component: `cli/` (the devices process only). Platforms: macOS, where the
ChatGPT app (bundle `com.openai.codex`) and its link are; nothing changes on Linux or Windows.

## The bug

Diego (2026-11-19, CLI 0.6.71, firmware 0.1.4, the ChatGPT desktop app with its Codex tab):

1. "swipe trên app ChatGPT thứ tự chưa rõ ràng: chỉ swipe trong danh sách project, không swipe Recent". On the dial's
   ChatGPT page, swiping goes only through the sessions under the app's Projects, never through its Recent ones, and the
   order is not the app's.
2. "chọn session trên app ChatGPT, device không chuyển theo". Picking a session in the app does not move the dial.
   **Out of this branch** (the PM, 2026-11-19, decision 3): see "Out of scope".

## Why (read from the code, the daemon's log and the app's metadata on this Mac)

- **Where the ring's members come from.** The dial learns of a Codex session outside Harness in only two ways
  (`observed.ts`): its hooks, and the open scan every 60 s (`OPEN_SCAN_MS`, `scanOpen`), which lists a session whose
  `rollout-*.jsonl` a Codex process holds open (`lsof`, `engines/codex/adoption.ts` `owners.open`). The ChatGPT app's
  Codex holds a thread's rollout open only while that thread is loaded. The app's sidebar lists every thread whether it
  is loaded or not. On this Mac the app held 3 rollouts open (2 threads in a project, 1 projectless), while its sidebar
  also lists older projectless threads, terminal Codex threads and ChatGPT chats. The threads the app has not loaded
  have no process, so the dial never lists them, and those are mostly the Recent ones.
- **Where the ring's order comes from.** `DialRing` (`select.ts`) keeps each agent's place from when it entered, unless
  its app gives a rank (`CableHost.setRank`). Only Orca gives one (its tab order, `devices.ts`). The ChatGPT page has
  none, so its order is the order the scan and the hooks happened to find its sessions in, not the sidebar's.
- **What the app keeps, read on this Mac (field names, ids, flags and times only; no title, message or prompt read):**
  - `~/.codex/state_5.sqlite`, table `threads`, one row per thread: `id` (the thread id: a UUID, the Codex session id),
    `source` (`cli` a terminal, `vscode` the app and the editors, `exec` a script, a JSON object for a subagent or a
    guardian review), `archived` (0/1), `recency_at_ms`, `updated_at_ms`, `cwd`. It is a WAL store the app writes as
    turns run.
  - `~/.codex/.codex-global-state.json` (about 135 KB): `project-order`, a list of project ids in the sidebar's order,
    and `thread-project-assignments`, `{ <thread id>: { projectKind: 'local', projectId: <project id> } }`. A thread
    with no assignment is under Recent.
  - ChatGPT chats are not in `threads` (they have no Codex session), so nothing here reads them.
- **The link** that opens a thread is the one the dial's ChatGPT adapter already runs: `codex://threads/<thread id>`
  (`codexApp.ts`, OpenAI's documented deep link), checked against `CODEX_THREAD`.

## Decisions (the PM, 2026-11-19)

1. Read only metadata (id, project, time) from `~/.codex/state_5.sqlite` (table `threads`) and
   `~/.codex/.codex-global-state.json` (`project-order`, `thread-project-assignments`). Open the SQLite store read-only
   (`mode=ro`, or `immutable` while it is idle), never locking a file the app writes. A failed read gives the order as
   it is today.
2. List the sidebar's Codex threads even with no process: idle, a tap opens `codex://threads/<id>`, at most 16, no
   ChatGPT chats. They follow the `ended` and `resting` rules of `fix/dial-claude-app-idle-sessions` (this branch is
   rebased on it when it merges).
3. Following the session picked in the app (bug 2) is out of this branch. The PM asks Diego separately about
   Accessibility.

**Settled with this spec (the PM, 2026-11-19, as proposed):**

- **D4. A thread's name, the same with or without a process.** The PM's decision 1 names id, project and time; a row
  also needs a name. Proposed: Codex's own name for the thread from `~/.codex/session_index.jsonl`, through the reader
  Harness already has (`lib/sessionTitle.ts` `codexThreadName(threadId, home)`, the terminal sweep's) and the dial's
  title rule (`observedTitle.ts`); else the name of its folder (`basename(cwd)`, so `cwd` is read from `threads` too),
  the observed source's fallback today. The hooked copy of the same thread gets the same name through the observed
  source's existing pane names (`ObservedSource.setPaneNames('codex', …)`, keyed by the ChatGPT adapter's pane id, the
  thread id), so the row keeps its name as its process comes and goes. No name is logged.
- **D5. Which threads.** Proposed: `source` `cli` or `vscode` and `archived = 0`. That is a person's own threads, the
  ones the app's catalog lists beside its chats. `exec` (a script), subagents and guardian reviews are left out, as
  Harness's Codex history already does. A terminal thread is on the ChatGPT page while it rests. When it runs in a
  terminal, its hooked copy takes its row on that terminal's page, as today.
- **D6. Projects.** Proposed: a thread is under a project only through `thread-project-assignments` with `projectKind`
  `'local'` and a `projectId` in `project-order`; any other entry is Recent. `local-projects`' folders (`rootPaths`) are
  not read. If Diego's sidebar also groups threads by folder, that is a follow-up.
- **D7. Dials without app pages.** A dial that does not say `appFilter` swipes one ring of the whole machine (16 places,
  `cableHost.ts` `machineSnapshot`). Sixteen resting threads with recent times would push live idle agents out of it.
  Proposed: resting rows (this source's and the Claude app store's alike, the same cause) are left out of that single
  ring; they show on app pages only. Firmware 0.1.4 on the round dial says `appFilter`.

## The fix

### A listing source of the app's threads

A new listing source, `CodexAppSource` (`cli/src/cable/hosts/codexAppSource.ts`, id `codex-app`), and its reader
(`cli/src/cable/hosts/codexAppThreads.ts`), in the devices process beside `ClaudeAppSource` and `CmuxSource`. It runs
only on macOS, behind the observed agents' switch, while a dial is attached (`devices.ts`, as `cmuxSource`): started at
each attach, stopped at the last detach. It runs only when the ChatGPT app is installed: `ChatGPT.app` in
`/Applications` or `~/Applications` whose bundle id is `com.openai.codex`, checked at each attach, as cmux's source runs
only when cmux is found (the PM, 2026-11-19, plan question 2). A Mac with only the Codex CLI gets no ChatGPT page. The
daemon core is not touched.

Each thread it lists is one `HostAgent`:

| Field | Value |
|---|---|
| `id` | `observedAgentId('codex', threadId)`: the id the observed source gives the same session once its process runs, so the row keeps its id as the process comes and goes |
| `engine`, `sessionId` | `'codex'`, the thread id |
| `name` | D4 |
| `cwd` | the row's `cwd` |
| `host`, `app` | `'codex'`, `'codex'` (the ChatGPT page) |
| `state` | `'idle'`, `unseenDone: false`, no `lastAnswer` |
| `resting` | `true`: on the ChatGPT page, no weight in the dial's default app |
| `lastActivityAt` | `recency_at_ms`, else `updated_at_ms` |

**Listed:** the 16 threads with the newest `recency_at_ms` (D5's filter), in the sidebar's order (below). The newest
16, not the sidebar's first 16: a project with more threads than that would otherwise keep every Recent thread off the
dial.

### One row per session

- The registry folds a later copy with the same `engine` + `sessionId` (`registry.ts`). A ChatGPT thread's session id
  is its thread id, the same in the hook, the rollout and `threads`, so the session key alone folds the two copies; no
  pane key is needed.
- Once the app has loaded a thread (a person opened it, or the dial's tap did), the observed copy is the one listed,
  with its real state, answer, questions and voice. Codex has no SessionEnd hook (`engines/codex/hookContract.ts`), so
  that copy stays until the app's Codex process goes (`observed.ts` `tick()`), which is right: the app still holds the
  thread. A thread the app has not loaded is the source's idle copy, with the same id: no second row and no jump of the
  dial's pick when it loads.
- **An ended hooked copy** gives its row to the source's copy (`HostAgent.ended`, from
  `fix/dial-claude-app-idle-sessions`): for Codex this is a copy whose process went (the app quit), in the ~40 s before
  the observed source drops it.
- A copy the open scan found has `host: 'terminal'` until its first hook (`observed.ts`), as today: pre-existing, not
  changed here.

### The sidebar's order, as the ChatGPT page's rank

- **The order:** first the projects, in `project-order`, each one's threads newest `recency_at_ms` first; then Recent
  (threads with no assignment, or one naming a project not in `project-order`), newest first. A thread's time is
  `recency_at_ms`, else `updated_at_ms`, else 0 (last). Threads tied on time are ordered by thread id, descending, as
  the store's own index, so a read always gives the same order.
- **The rank:** `CableHost.setRank('codex', rank)`, a place per agent id (`observedAgentId('codex', threadId)`) for every
  row the query returns (at most 200), not only the 16 listed. When the source stops (the last detach) the rank is
  cleared (`setRank` takes `undefined` to delete it), so a later attach starts from the order as it is today until the
  first read. So a running thread's hooked copy has its sidebar place too, and the
  ring of the ChatGPT page is in the sidebar's order. An agent with no place (a thread too new to be in `threads`) comes
  after the ranked ones, as `DialRing` already does.
- **Holding still.** `DialRing` re-sorts only when its members change or a new rank object lands. The source makes a
  new rank only when the order of ids changes, not on every `recency_at_ms` write: a running turn writes its thread's
  time many times, and the dial must not move under the finger. A thread that gets a turn and moves up in the app's
  sidebar moves up on the dial too, once, as in the app.
- **A failed read** (no store, a missing table or column, a JSON file mid-write) leaves the last good rank and list as
  they are. With none yet, no rank is set and the source lists nothing, so the page is today's: its live sessions in
  the order they entered.

### What the dial can do with a thread's row

- `capabilities`: `status: true`, `voice: false`, `focus: true` on macOS, `answer: false`. **No voice:** a thread with
  no process has nothing to take the words. The source has no `send`, and the dial says what it says today for an agent
  with no voice.
- `focus` (a tap): `devices.ts` routes it as the observed source's tap:
  `opener.open(agentId, { bundle: APP_BUNDLES.codex, pane: { adapter: 'codex', id: threadId } })` through the ChatGPT
  adapter as the dial's verbs reach it. That adapter is built inline in `devices.ts`'s `adapters` today; it becomes a
  named `codexNoted` (`noting(createCodexAppAdapter(…))`, as `cmuxAppNoted`), used by both sources, so a tap notes the
  dial's move once (inside `noting`), never twice. The ChatGPT adapter's
  link opens the thread, and a failed link leaves the adapter's fallback to bring the app forward
  (`[device] open · codex · fallback`, as today). The app loads the thread, and its first hook gives the row to the
  observed copy.
- `hasPane`/`showPane` (a swipe while the ChatGPT app is in front): `codexNoted`'s `canShow`/`show` with the same
  pane, so a swipe shows the thread in the app, as a rest does for a thread with a process today.
- **The default page:** `resting` rows weigh nothing in the dial's default app (`select.ts`, `appFilter.ts`, from the
  other branch), so 16 resting threads never make ChatGPT the default page when it is not in front. ChatGPT in front
  still shows its page, and a pick on the dial still reaches it.
- The thread id is checked against `CODEX_THREAD` when it is read, and again by the adapter before each link
  (`appLink.ts`).

### Reading the app's metadata

- **Paths.** The Codex home the app uses: `join(homedir(), '.codex')`, computed once in `devices.ts` and handed to the
  source. It is not a Harness path, so it does not come from `harnessHome.ts`, and the e2e moves it with `HOME`. Files:
  `state_5.sqlite` and `.codex-global-state.json` there (and `session_index.jsonl` for D4).
- **SQLite:** each read opens its own connection and closes it before the read ends, so no handle outlives a read, an
  attach or the app (not `sqliteReadAll`, whose handle is cached for the process's life and would hold the app's
  `-wal`/`-shm` after it quits). It uses `node:sqlite` through `lib/sqliteBuiltin.ts` `builtinSqlite()` and
  `idleWalStore()`, both unchanged (the core loads that file; nothing is added to it): `readOnly: true`, the URI
  `immutable=1` when the store is idle (no `-wal`, so no `-shm` is made), else `mode=ro`, a WAL reader that never
  blocks the app's writer, with `PRAGMA busy_timeout = 50` (the binding is synchronous on the devices event loop). No
  binding is a failed read. One query, with no value from outside in it, served by the store's
  `idx_threads_recency_at_ms`:
  `SELECT id, source, cwd, recency_at_ms, updated_at_ms FROM threads WHERE archived = 0 AND source IN ('cli','vscode')
  ORDER BY recency_at_ms DESC, id DESC LIMIT 200`. A row whose `id` fails `CODEX_THREAD`, or whose `cwd` is not a
  non-empty string of at most 4,096 characters, is skipped and counted. A `transient` or `missing` answer is a failed read.
- **The JSON file:** a regular file (`lstat`, no link) of at most 1 MiB, read whole and parsed. Only `project-order` (a
  list of strings, at most 64 kept) and `thread-project-assignments` (an object, whose entries are kept only for the
  threads the query returned, with `projectId` a string) are taken. Nothing else of the parsed object is kept, read or
  logged. It is re-read only when its own size or mtime changed. A file whose size or mtime changed
  during its read (the app writing it) is a failed read: the last good list and rank stay. A file that held still and
  is too large, not JSON, or of the wrong shape counts as having no projects (every thread under Recent) until its next
  good read (the PM, 2026-11-19, plan question 1 (b)).
- **Names (D4):** `codexThreadName(threadId, home)` for each listed thread (it reads only what was appended since its
  last look, at most the index's last MiB).
- **Pushed, never polled.** One `fs.watch` on the Codex home itself (`watchNearest([home])`, never the home folder
  above it: on macOS a watch on a high folder wakes on every write below it, `folderWatch.ts`, which is why opencode's
  stops below `homedir()` too). An event naming `state_5.sqlite`, `state_5.sqlite-wal`, `.codex-global-state.json` or
  `session_index.jsonl`, or naming nothing, asks for a read; any other name does nothing. With no Codex home, nothing is
  watched and nothing listed; the next attach looks again. One read at a time; changes during a read give one more
  after it, at least 1 s after its start: Codex writes its WAL several times a second while any Codex turn runs (the
  app's or a terminal's), so a busy machine costs one read a second.
- **Told only when something changes.** `onChange` fires when the listed rows' ids, names, folders or order change.
  The rank is set when the order of ids changes. A new `recency_at_ms` alone tells nothing.

### Seams and docs

- `DevicesDeps.codexAppThreads` (as the Claude branch's `claudeAppStore`): the reader the source uses, so
  `devices.spec.ts` drives it and no test starts the real one on vitest's temporary `HOME`.
- The new source is named once in `devices.ts` (`services/AGENTS.md`); the devices row of `cli/AGENTS.md` and the
  `HostAgent.resting` comment in `types.ts` name it beside the Claude app's store;
  `docs/specs/2026-11-15-device-host-adapter.md` lists it.

### Log lines (counts and fixed words only: never a title, folder, path or id)

- `[codex-app] watch · on` / `· none`, once per change of whether the home is there.
- `[codex-app] listed · <n> threads · <p> in projects`, when either count changes.
- `[codex-app] read · <ms> ms · <rows> rows · <skipped> skipped`, at the first read of an attach and when a read is the
  slowest of this attach.
- `[codex-app] read · failed`, once per run of failed reads: the error is not said, as it can name the home's path and
  so the account's name.

## Out of scope

- **Following the thread picked in the app (bug 2).** The app writes nothing a file reader can follow when a person
  picks a thread. `.codex-global-state.json` was last written at 11:40 while Diego picked threads at 13:0x.
  `thread_read_receipts` has no time and changes only for a thread with unread turns. `thread-writer-locks/` changes
  only when a thread is first loaded. The dial still follows a prompt the person submits in the app while it is in
  front (`followPrompt`, as today). Accessibility (the window's title or its UI) is the PM's question to Diego.
- Words into a thread with no process, and any state but idle for it.
- ChatGPT chats; pinned threads and a custom order inside a project (`is_pinned`, `sidebar-project-thread-orders`):
  not among the fields the PM named; the order is project, then time.
- Anything written to the app's files: they are never written.
- Windows' and Linux's ChatGPT app: the dial's ChatGPT adapter is macOS-only today.

## Design (docs/feature-design-rules.md)

1. **Growth:** nothing is stored. The source holds at most 200 thread rows (each under 4.5 KiB with its folder), 64
   project ids and the names of the 16 listed threads, and `codexThreadName` the names it read of Codex's index (at most
   its last MiB, 10,000 names), in RAM, all dropped at the last detach with the rank.
2. **Concurrency:** one read at a time in the devices process. The SQLite read is a WAL reader (never blocks the app's
   writer) or immutable when the store is idle. The files are never written, so the app sees no lock.
3. **Read cost:** one indexed query of at most 200 rows, and the JSON file only when it changed. The plan measures a
   read with 20 and with 200 threads (median and p90 of 100 runs), and the time the binding blocks the event loop,
   before and after.
4. **Scale:** 10×: 2,000 threads in the store are still one `LIMIT 200` query. The 1 s floor between reads bounds a
   busy turn's writes to one read a second.
5. **Compatibility:** an app that renames the table, a column or a JSON key gives a failed or empty read. The dial then
   lists the sessions with a process as today. An older daemon has no source, and the dial needs no change (the rows are
   ordinary `HostAgent`s).
6. **Migration and rollback:** none; reverting the commit removes the rows and the rank.
7. **Audience:** the person's own metadata, read by the devices process under their own login, shown on their own
   dial. A name and folder go only to the dial, as the observed source's do.
8. **Identity:** the daemon's own user reads its own home; no other login.
9. **Failure:** each skip and failure is counted in a log line; nothing throws into the devices process.
10. **Platforms:** macOS only (`platform !== 'darwin'` builds no source; a unit test holds it).
11. **Measures:** the `listed` and `read` lines give the counts and the read time, with no content or identifiers.

## Tests (red first)

- `codexAppThreads.spec.ts`, against a fixture `state_5.sqlite` (made with `node:sqlite` in a temp folder, with the `threads` columns and the
  `idx_threads_recency_at_ms` index as Codex creates them) and a
  fixture JSON file: the query's filter (archived, `exec`, subagent and guardian rows left out); the sidebar order
  (projects in `project-order`, each newest first, then Recent; an assignment to an unknown project is Recent; ties by
  id); the newest 16 listed and every kept thread ranked; a bad id or folder skipped and counted; a JSON file too large,
  not JSON or of the wrong shape counts as no projects; a missing store or table is a failed read; no connection is left open after a read
  (the store's `-shm` is not held: a second writer connection can checkpoint and delete the WAL); D4's name and its
  fallback; a NULL time.
- `codexAppSource.spec.ts`: the agent's fields (id equals `observedAgentId('codex', id)`, `resting`, idle, no voice, no
  `send`); a tap opens the `codex` pane with the ChatGPT bundle; a swipe shows it; which events read and which do not;
  the 1 s coalescing; `onChange` and the rank only when the list or order changes (a new `recency_at_ms` alone changes
  neither); a failed read keeps the last good list and rank; start/stop; the home's wait.
- `registry.spec.ts`: an observed copy and a source copy of one thread are one row; an ended observed copy gives its
  row to the source's copy.
- `cableHost.spec.ts`: resting rows stay out of the single machine ring (D7); `setRank(app, undefined)` drops the rank.
- `observed.spec.ts`: a hooked ChatGPT thread takes the source's name through `setPaneNames('codex', …)`.
- `devices.spec.ts`: the source exists on macOS only, starts at attach and stops at the last detach; its rank reaches
  `setRank('codex', …)`; a row's tap notes the move and opens with the ChatGPT bundle and pane.

## Verification

**Platforms the pull request names:** macOS. Linux and Windows: nothing a person sees changes; a unit test with
`platform: 'linux'` holds that no source is built.

**End-to-end check (this Mac):** `cli/e2e/deviceCodexAppThreads.e2e.ts`, as `dialCodexApp.e2e.ts`: the real daemon
from the working tree, a fake dial on a pseudo-terminal, a throwaway `HOME` whose `.codex/` holds a fixture
`state_5.sqlite` (a project with two threads, three Recent threads, one archived, one `exec`) and a fixture
`.codex-global-state.json`, the fake `open` (`HARNESS_OPEN_BIN`) inside the daemon's root. A person sees: the ChatGPT
page lists the five threads, idle, the project's two first, then Recent newest first; swiping walks them in that order;
a tap runs the fake `open -b com.openai.codex codex://threads/<id>`; archiving one in the fixture removes its row within
a few seconds; giving a Recent thread a newer time moves it to the head of Recent once; the log has the `[codex-app]`
lines above and no title, folder or id.

**Never touched by a tester or a test:** the real ChatGPT app, its Application Support folder and its `~/.codex`,
`/usr/bin/open`, Diego's daemon and dial, any backend, production. No gate runs a real or renamed ChatGPT app on this
Mac.

**Required local gates** (recorded in the pull request): `cd cli && npm run typecheck && npx vitest run src/cable
src/services/devices.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts`; `npm run test:core`
(`services/devices.ts` changes); `python3 scripts/local-checks.py --run` from a clean tree at the final commit, its
receipt in the body before the push; `git diff --stat origin/main -- cli/src/core cli/src/architecture.coreFiles.txt`
prints nothing. The e2e file runs locally under the suite's own isolation; `cli-e2e.yml` only with the PM's turn.

**Diego's own check, after the merge** (his app, his dial, his eye; no tester runs it): the dial's ChatGPT page holds
his project's threads and his Recent Codex threads, in the sidebar's order; a tap on a resting one opens it in the app.

**Against production:** none.
