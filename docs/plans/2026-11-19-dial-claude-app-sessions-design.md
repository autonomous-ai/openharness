# The Claude app's Code sessions on the dial, with or without a process

Branch: `fix/dial-claude-app-idle-sessions`. Component: `cli/` (the devices process only). Platforms: macOS, where the
Claude app's Code store and its link are; nothing changes on Linux or Windows.

## The bug

Diego (2026-11-19, CLI 0.6.70): "Claude app vẫn chưa ổn định, có 3 session mà trên device show có 1" (the Claude app has
3 sessions, the dial shows 1).

## Why (read from the code, the app and the store's metadata)

- The dial learns of a session outside Harness from its process: the open scan (`observed.ts` `scanOpen`, through
  `openSessions.owners()`) and its hooks. The Claude app (6.6395.1) runs a Claude Code process only for the Code
  session in use: one live record in `~/.claude/sessions/<pid>.json` with `entrypoint: 'claude-desktop'`. The app's
  other open sessions have no process, so the dial lists one.
- The app keeps one file per Code session, whatever runs:
  `~/Library/Application Support/Claude/claude-code-sessions/<account uuid>/<org uuid>/local_<uuid>.json` (about
  40 KB each). Read on this Mac, field names, ids, flags and times only:
  - the file's name is the app's session id, `local_<uuid>`, and its `sessionId` field says the same;
  - its `cliSessionId` is the Claude Code session's id: for the one live session, `record.sessionId ==
    store.cliSessionId` and `record.hostSessionId == store.sessionId ==` the file's name;
  - `isArchived: true` for an archived session (the app also lists it in `archived-sessions.idx`);
  - a deleted session's file is gone, a 13-byte `deleted_<uuid>` left in its place;
  - `lastActivityAt` (ms), `cwd`, `title` (the name the app shows; `titleSource` `user` when the person named it).
  - The app's own main process checks each of these fields' types as it reads the file
    (`typeof e.isArchived != "boolean"`, `typeof e.lastActivityAt != "number"`, `typeof e.title != "string"`).
- Which sessions the app itself offers: its Dock and tray menus' "continue" item and its Spotlight index take every
  session that is not archived, newest `lastActivityAt` first, the Spotlight index the first 50, with no time window
  (the app's main process, `Rzi`/`zzi`, read in `app.asar` 6.6395.1).
- The link: those same menus open a session with `claude://code/continue?session=<sessionId>` (the app's
  `vW(Code, "/continue", …, {session})`), and its handler finds the session among every session that is not archived,
  with no process needed. It is the link the dial's Claude adapter already runs (`claudeApp.ts`, `CLAUDE_SESSION`).

## Decisions (the PM, 2026-11-19)

1. **Which sessions:** every session that is not archived, newest `lastActivityAt` first, at most 16. No time window, as
   the app's own menus.
2. **Its name:** the store's `title` when it has one, through the dial's title rule (`observedTitle.ts`), the same name
   the dial shows today from the live session's process record, so a row keeps its name as its process comes and goes;
   with none, the folder's name (`basename(cwd)`). No message or prompt is read; no title or folder is logged.
3. **Every account folder** is read. A session of an account the app is not signed in to: its tap brings the app only.
4. **A session with no process is idle.** Nothing in the store (`interruptedAwaitingPerson`, `waiting-input/`) makes
   it `needs-you`.
5. The approach below and the end-to-end check in Verification.
6. `HostAgent.ended`: an ended copy gives its row to another source's live copy, for every listing source.
7. `HostAgent.resting`: a store row weighs nothing in the dial's default app (`select.ts`).
8. A session whose store and hook ids still differ when its process ends moves the dial's pick to the store row's id:
   accepted.
9. A resting row counts for the app in front; it weighs nothing only in the default app (1b).
10. The end-to-end file also runs a session with a fake process: one row while it runs, the same id idle once it ends.
11. Verification: one hand-started `cli-e2e.yml` run in phase 4 (the PM gives the turn) and `deviceCmux.e2e.ts` locally.
12. (Final review, the main session) A store row's `lastActivityAt` is its sort time, `min(lastActivityAt, mtime)`: a
    timestamp the app wrote ahead of the clock cannot pin a row first on the dial's ring.
13. (Final review, the main session) A `harness device notify` card for a Claude app session stays when its process
    ends, since the session's row stays: it ends at a tap, the next turn or after 24 h, as for any listed agent.

## The fix

### A listing source of the app's store

A new listing source, `ClaudeAppSource` (`cli/src/cable/hosts/claudeAppSource.ts`, id `claude-app`), and its store
reader (`cli/src/cable/hosts/claudeAppStore.ts`), in the devices process beside `CmuxSource` and `OpencodeSource`. It
runs only on macOS, behind the observed agents' switch, while a dial is attached (`devices.ts`, as `cmuxSource`):
started at each attach, stopped at the last detach. The daemon core is not touched.

Each session it keeps is one `HostAgent`:

| Field | Value |
|---|---|
| `id` | `observedAgentId('claude', cliSessionId)`: the very id the observed source gives the same session once its process runs, so the dial's row keeps its id as the process comes and goes |
| `engine`, `sessionId` | `'claude'`, `cliSessionId` |
| `paneKeys` | `['claude-app:<local id>']` |
| `name` | `observedTitle(title) ?? basename(cwd) || 'claude'` |
| `cwd` | the store's `cwd` |
| `host`, `app` | `'claude'`, `'claude'` (the Claude app's page) |
| `state` | `'idle'`, `unseenDone: false`, no `lastAnswer` |
| `resting` | `true`: on the Claude page, but no weight in the dial's default app (below) |
| `lastActivityAt` | the store's `lastActivityAt` |

### One row per session

- The registry already merges sources, the observed source's copy before any listing source's (`registry.ts`
  `strength`), folding a later copy with the same `engine` + `sessionId` or a shared pane key.
- The Claude app's adapter gains `paneKey(pane) = 'claude-app:' + pane.id` (`adapter.ts`: "Only an app with such a
  source has one"), so an observed session placed in the app (its hook's `CLAUDE_CODE_HOST_SESSION_ID`, or its record's
  `hostSessionId` before its first hook) carries the same key as the store's row. Two keys fold it: the session id, and
  the app's own id should the app write a new `cliSessionId` a moment after its process starts.
- So a session with a process shows the observed copy, with its real state, answer, questions and voice; with none,
  the store's idle copy, with the same id: no second row, no jump of the dial's pick.
- **An ended copy folds nothing.** After its process ends, the observed source keeps a session listed until its `tick()`
  drops it (`END_DELAY_MS` 10 s, ticks every 30 s: up to about 40 s). It is not live, so it has no tap, no swipe and no
  voice, yet today it would fold the store's copy that can open the session. `HostAgent` gains `ended?: true`, set by
  `ObservedSource.list()` for an entry that is not `live()`. In `HostRegistry.entries()`, a copy with `ended` takes no
  key and is listed only when no other source lists a copy with its session key or one of its pane keys; otherwise that
  copy is listed in its place. This holds for every listing source (herdr, cmux, opencode), the same cause: an ended
  hook copy never hides a live one.
- **One file per Claude Code session.** Two store files with one `cliSessionId` (the app's copy of a session): the one
  with the newest `lastActivityAt` is kept, the other counted as skipped.
- **Where the ids differ.** `/clear` gives the session a new Claude Code id (`record.ts`). The app's file then names the
  new id too; until it does, the pane key folds the two while the observed copy is live and placed in the app. A
  session whose store and hook ids still differ when its process ends shows the store's id from then on, so the dial's
  pick moves to that row's id. That case is accepted, not handled.

### What the dial can do with a store row

- `capabilities`: `status: true`, `voice: false`, `focus` and `answer` as below. **No voice:** a session with no process
  has nothing to take the words; the source has no `send`. The dial says what it says today for an agent with no voice.
- `focus` (a tap): `devices.ts` routes it as the observed source's tap is routed: `noteMove()`, `noteLink(agentId)` (so
  the app's attach after the link is the dial's own echo, not the person's pick), then
  `opener.open(agentId, { bundle: APP_BUNDLES.claude, pane: { adapter: 'claude', id: <local id> } })`. The pane runs the
  Claude adapter's link; a link that fails leaves the opener's fallback to bring the app by the bundle
  (`[device] open · claude · fallback`, as today). The app opens the session and starts its process; the observed source
  then hears its hook and takes the row. `focus: true` on macOS.
- `hasPane`/`showPane` (a swipe while the Claude app is in front): the Claude adapter's `canShow`/`show` through its
  noted copy, which `devices.ts` builds inline in the observed source's `adapters` list today: it becomes a named
  `claudeNoted` (as `cmuxAppNoted`), used by both sources, so a swipe shows the session in the app and notes the link,
  as for a session with a process.
- **The dial's default page.** A row with no process is on the Claude app's page but weighs nothing in the dial's
  default app (`AppFilter.fallback`, which picks the app with the most known agents): `HostAgent` gains
  `resting?: true`, set on every store row, and the counts the default reads leave such rows out, as they leave out
  `appPending` ones today. So 16 idle sessions never make the Claude app the default when it is not in front; the
  Claude app in front still shows its page: a resting row counts for the app in front wherever the dial asks whether
  that app has agents to show (`appFilter.ts`, `cableHost.ts`), whatever order the store's first read and the dial's
  first list come in (PM, 2026-11-19, 1b); a pick on the dial still reaches it.
- **The app's settle** (`claudeSettled` in `devices.ts`): it turns the dial to the session the app last attached while
  that session is listed on the Claude page. A store row keeps it listed after its process ends, which is right: the
  app still holds that session; an archived or deleted one leaves the list and the settle drops it, as today.
- The local id is checked against `CLAUDE_SESSION` when it is read and again by the adapter before each link
  (`appLink.ts`).

### Reading the store

- **Paths.** The store root is `join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions')`,
  computed once in `devices.ts` and handed to the source (not a Harness path, so not `harnessHome.ts`'s; the e2e moves it
  with `HOME`).
- **Folders.** The root's account folders, and each one's org folders: at most 8 accounts and 8 orgs each are read;
  more is counted in one line. Only real folders, never a link (`lstat`).
- **Files.** In each org folder, names matching `^local_[A-Za-z0-9-]{1,64}\.json$` only, at most 1,024 a folder.
  `deleted_*`, `archived-sessions.idx`, `scheduled-tasks.json`, `waiting-input/` are never opened.
- **Each file:** a regular file (`lstat`, no link), at most 1 MiB, read whole and parsed as JSON. Taken: `sessionId`
  (must equal the file's name), `cliSessionId` (a UUID), `cwd` (a non-empty string of at most 4,096 characters),
  `isArchived` (`true` drops it; absent is not archived), `lastActivityAt` (a finite number; else the file's mtime),
  `title` (a string, else none). Nothing else of the parsed object is kept, read or logged. A file that is too large,
  not JSON (the app mid-write), or with a field of the wrong type is skipped and counted, and read again at its next
  change.
- **What the source holds.** Every `local_*.json` name it has seen, with its size and mtime (from `lstat`), and, for a
  file parsed, its fields. A file's sort time is `min(lastActivityAt, mtime)` once parsed and its mtime before: no
  file's session can be newer than its mtime, so the rule below holds whatever the app writes.
- **A read** walks every held file newest sort time first. A file whose size and mtime match what it was parsed at
  counts from what is held; a new or changed one is parsed. The walk stops once 16 sessions not archived are counted
  and the next file's mtime is older than the 16th's sort time, or after 256 parses. A walk cut by the 256 asks for one
  more read (the same coalescing below), so the rest is parsed with no change event; the `over` line counts it.
  Listed: the counted sessions, newest sort time first, at most 16. Archiving one of the 16 makes the walk go on to the
  next file, parsing it if it was never parsed.
- **What a change re-reads.** At start, and at an event with no file name: every folder is listed again (names, then
  `lstat` each). An event in an org folder naming a `local_*.json` file: that file alone is `lstat`ed (gone: forgotten).
  An event naming anything else in an org folder (`deleted_*`, `archived-sessions.idx`, `scheduled-tasks.json`,
  `waiting-input`, a temp file) does nothing: an archive or a delete also writes or removes the session's own
  `local_*.json`, and a write by temp file and rename names the final file too. An event in the root or an account
  folder: the folders are listed again and the watches set again.
- **Pushed, never polled.** A non-recursive `fs.watch` on the root, each account folder and each org folder read (at
  most 1 + 8 + 64), set again as folders come and go. With no root (none yet, or removed), `watchNearest([root, the
  Claude app's folder])` waits for it: macOS gives a non-recursive watch only the folder's own entries, so the app's
  busy subfolders (its caches, IndexedDB) wake nothing, and the wait ends as the app first makes the store. One read at
  a time; changes during a read give one more after it, at least 250 ms after its start (`cmuxSource`'s rule): a
  working turn writes its file several times a second.
- **Told only when the list changes.** `onChange` fires when the listed rows' ids, names, folders or order change, not
  for a new `lastActivityAt` alone: a working turn's writes would otherwise run the dial's merge on every write. Its
  row is the observed copy then anyway.
- **Failures stay quiet.** No store, no folder, an unreadable file: the source lists what it can (none at all is an
  empty list), and the observed source works as today.

### Log lines (counts and fixed words only: never a title, folder, path or id)

- `[claude-app] watch · on` / `· none`, once per change of whether the root is there.
- `[claude-app] listed · <n> sessions`, when the count changes.
- `[claude-app] read · <ms> ms · <parsed> parsed · <skipped> skipped`, at the first read of an attach and when a read
  is the slowest of this attach.
- `[claude-app] over · <n>` when a bound above cut something.

## Out of scope

- Words into a session with no process, and any state but idle for it (decision 4).
- Windows' and Linux's Claude app: the dial's Claude adapter is macOS-only today.
- The Claude app's Cowork sessions and its chats; the store's titles of archived sessions; anything written to the
  store (it is never written).
- The app's own sidebar rule beyond what its menus show (the sidebar lives in the app's web bundle).

## Design (docs/feature-design-rules.md)

1. **Growth:** nothing is stored. The source holds at most 64 × 1,024 file stats and the parsed fields of the
   files read (each under 4 KiB kept), in RAM, dropped at the last detach.
2. **Concurrency:** one read at a time in the devices process; a write by the app during a read is a skipped file, read
   again at its next change. The store is never written, so the app sees no lock.
3. **Read cost:** an event naming a session's file `lstat`s and parses that file alone (one, for a working turn);
   only an event with no name, or a folder's, lists the folders again. The plan measures a read of 16 files and of 200 files, and one changed file, before and after.
4. **Scale:** 10×: 160 sessions in one folder is 160 stats and one parse a change. The bounds above cut first, and the
   `over` line says so.
5. **Compatibility:** an app that renames or drops a field: its files are skipped and counted, the dial lists the
   sessions with a process as today. An older daemon has no source; the dial needs no change (the rows are
   ordinary `HostAgent`s).
6. **Migration and rollback:** none; reverting the commit removes the rows.
7. **Audience:** the person's own store, read by the devices process under their own login, shown on their own dial,
   as today's rows. The title and folder go only to the dial, as the observed source's do.
8. **Identity:** the daemon's own user reads its own home; no other login.
9. **Failure:** each skip and cut is counted in a log line; nothing throws into the devices process.
10. **Platforms:** macOS only (the source is not built elsewhere: `platform !== 'darwin'` gives no source, a unit test
    holds it).

## Tests (red first)

- `claudeAppStore.spec.ts`, against a fixture store in a temp folder: the fields read and their forms; archived and
  deleted sessions gone; a file mid-write, too large, a link, a wrong `sessionId`, or a bad `cliSessionId` skipped and
  counted; two files with one `cliSessionId` give one session; only new or changed files parsed; the walk stops as
  written (an older file is never parsed, a newer write is, archiving one of the 16 parses the next); a walk cut at 256
  asks for one more read; the 8/8/1,024/16/256 bounds; newest sort time first.
- `claudeAppSource.spec.ts`: the agent's fields (the id equals `observedAgentId('claude', cliSessionId)`, `resting`);
  idle, no voice, no `send`; focus and show route the `local_…` pane; which event re-reads what; the coalescing;
  `onChange` only when the list changes; start/stop; the root's wait and its removal.
- `registry.spec.ts`: an observed copy and a store copy of one session are one row, by session id and by the pane key
  alone; an ended observed copy gives its row to a live copy of another source (store, and herdr as a second case) and
  is listed alone when none has one; with no live copy elsewhere, herdr's, cmux's and opencode's rows merge exactly as
  before (one case each, PM 2026-11-19).
- `observed.spec.ts`: `list()` marks an ended entry `ended`.
- `select.spec.ts`: a `resting` agent counts on its app's page but not among the known agents.
- `claudeApp.spec.ts`: `paneKey`.
- `devices.spec.ts`: the source exists on macOS only, starts at attach, stops at the last detach; a store row's tap
  notes the move and the link and opens with the Claude bundle and pane; its swipe goes through `claudeNoted`.

## Verification

**Platforms the pull request names:** macOS. Linux and Windows: nothing a person sees changes; the unit tests with
`platform: 'linux'` hold that no source is built.

**End-to-end check (this Mac):** `cli/e2e/deviceClaudeAppSessions.e2e.ts`, as `deviceCmux.e2e.ts`: the real daemon from
the working tree, a fake dial on a pseudo-terminal, a throwaway `HOME` holding a fixture store (three sessions, one
archived, one deleted tombstone), the fake `open` (`HARNESS_OPEN_BIN`) inside the daemon's root. A person sees: the
Claude app's page lists the two sessions that are not archived, idle, by title and by folder; a tap runs the fake
`open -b com.anthropic.claudefordesktop claude://code/continue?session=local_…`; archiving one in the fixture removes its
row within a second; the log has the `[claude-app]` lines above and no title or folder.

**Never touched by a tester or a test:** the real Claude app or its Application Support folder, `/usr/bin/open`,
`~/.claude`, Diego's daemon and dial, any backend, production. No gate runs a real or renamed Claude app on this Mac.

**Required local gates** (recorded in the pull request): `cd cli && npm run typecheck && npx vitest run src/cable
src/services/devices.spec.ts src/architecture.spec.ts`; `npm run test:core` (`services/devices.ts` changes);
`python3 scripts/local-checks.py --run` from a clean tree at the final commit, its receipt in the body before the push;
`git diff --stat origin/main -- cli/src/core cli/src/architecture.coreFiles.txt` prints nothing.

**Diego's own check, after the merge** (his app, his dial, his eye; no tester runs it): his three Code sessions show on
the dial's Claude page, two idle; a tap on one opens it in the app.

**Against production:** none.
