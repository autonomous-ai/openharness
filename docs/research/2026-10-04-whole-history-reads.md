# Whole-history reads in the daemon

October 4, 2026, at `076aff72a` (main after #715). Every place the daemon reads an agent's
whole conversation at once: a read whose cost grows with the conversation, not with what it
serves. This is the work list for "bounded reads for every other engine" in the
[harnessd design](../design/2026-10-03-harnessd.md#bounded-work), and the allowlist a guard
test will start from and shrink.

Paths are under `cli/src`. Specs, `testing/` and `scripts/` are left out. "File engines" means
Cursor, Muse, Amp, Grok, agy, Copilot, pi and Command Code; Claude Code and Codex take the
bounded paths.

## The hot paths, first

These run per event, per poll or per page, and grow with the conversation:

1. **Cursor's live tail** (`watcher/watcher.ts:430`, `readCursor`) reads and splits the whole
   file on every change, every heartbeat drain while a turn is open (twice every 5 s) and every
   5-minute reconcile.
2. **Cursor's sub-agents** (`engines/cursor/subagent.ts:182`) read each whole child transcript
   on every history page, and poll it every 250 ms to 1 s while a Task runs.
3. **The recap of every file engine** (`cli.ts:3019`) reads the whole transcript at every turn
   end, with or without a device.
4. **History pages of every file engine** (`backendSocket.ts:2368`) read the whole transcript
   before cutting the page; Muse, Amp, Grok, agy and Copilot have no page cut at all.
5. **The database engines** (OpenCode, Kilo, Hermes, Devin) load a whole session, synchronously
   on the event loop, for the recap (`cli.ts:3011–3014`), for search on every turn event
   (`cli.ts:3042–3047` → `lib/sessionSearch/indexer.ts:467`) and for every history page
   (`backendSocket.ts:2238`, `:2259`, `:2280`, `:2305`).
6. **OpenCode's and Kilo's live poll** (`engines/opencode/reader.ts:205`,
   `engines/kilo/reader.ts:214`) re-reads the whole running turn, tool output included, every
   second.
7. **Devin's live poll** (`engines/devin/reader.ts:192`) gets roughly the whole conversation
   back after each inference, because Devin re-persists the chain.
8. **Codex's child rollouts** (`engines/codex/subagent.ts:164`) are read whole, synchronously,
   for each sub-agent completion seen live or on a page.
9. **Copilot's and Muse's session repair** (`lib/sessionRepair.ts:267`, `:313`) read whole
   candidate files every 5 s, then every 60 s, while a pane is unbound. Copilot uses five lines of
   each.

## The low-level readers

- **`tailFile(path, Infinity)`** (`lib/transcriptTail.ts:189–198`) streams every non-blank line
  into one array. Its only callers are the three file-engine sites below. A finite `n` reads
  backward in 64 KB chunks.
- **`tailFileUntil`** (`lib/transcriptTail.ts:167`) reads back to the last prompt, and to the
  start of the file when there is none. It serves the Claude Code and Codex recaps.
- **`sqliteReadAll`** (`lib/sqliteRead.ts:249`) runs `node:sqlite`'s `prepare(sql).all()`
  synchronously on the event loop, with no row or byte limit. Without that module it spawns
  `sqlite3 -json` (5 s timeout, 32 MB output cap; over the cap reads as nothing).

## The shared file-engine sites

- **Attach** (`cli.ts:2526`, `attachSessionNow` when not from the end): every line through the
  normalizer, `runtimeProfiles.hydrate`, and for Copilot `copilotHistoryTurnOpen`. Once per
  attach: restore, re-activation, pane open, reset, rebind.
- **Recap** (`cli.ts:3019`, `readLastTurn`): every turn end.
- **History pages** (`backendSocket.ts:2368`): the whole file, then the window
  (`windowCursorLines`, `windowPiLines`, `windowCommandCodeLines`, `windowRawLines`).

## The database sites

`readOpencodeMessages` (`engines/opencode/reader.ts:40`), `readKiloMessages`
(`engines/kilo/reader.ts:43`), `readHermesMessages` (`engines/hermes/reader.ts:49`) and
`readDevinMessages` (`engines/devin/reader.ts:60`) have no limit and run through
`sqliteReadAll`. Shared callers:

- the recap, per turn end (`cli.ts:3011–3014`);
- `databaseHistory` (`cli.ts:3042–3047`), which feeds search's `historyPass` on every turn start
  and end (debounced 1.5 s) and the handoff (`lib/agentHandoff.ts:730` →
  `lib/sessionSearch/sessionTurns.ts:137`);
- history pages, windowed in JS after the whole read;
- the close checkpoint (`lib/sessionCheckpoint.ts:39`, `SELECT *` for the session, stringified
  whole at `:143`), twice per close;
- storage size (`lib/purgeAgentService.ts:111`), an aggregate over every byte of the session, from
  purge review and from storage telemetry at most once a minute per agent.

## Per engine

**Claude Code.** Bounded: attach, history pages, the live tail, the recap, activity (2 MB tail),
project detection (2 MB head), session repair (256 KB head), external search (32 MB head).
Edge cases that still read the whole file: a from-start attach (`lib/attachTranscript.ts:132`),
a transcript with no turn opener (`:197`), a file that shrank under two walks (`:274`); the line
index's first look at a path (`lib/transcriptPages.ts:169–188`, cached for 256 paths); an unknown
or stale cursor (`:419–436`); a from-start tail (`watcher/watcher.ts:158`, `:412`); a recap
with no prompt in the file (`lib/transcriptTail.ts:167`). Elsewhere:
- sub-agent stats on every history page (`backendSocket.ts:401`, `:411`), streamed, no size
  bound;
- the token-usage backfill (`lib/agentTokenUsage.ts:274`, `:333`), from byte 0 on a cold cache
  or a rewrite, files over 128 MB skipped, incremental after;
- the search indexer's first pass (`lib/sessionSearch/indexer.ts:395`, `:401`), streamed in 1 MB
  chunks, incremental after;
- the handoff (`lib/sessionSearch/sessionTurns.ts:127`), the whole transcript, with a 5 s
  deadline and no size bound;
- the close checkpoint's file copy (`lib/sessionCheckpoint.ts:133`), a clone, not a JS read.

**Codex.** Bounded as Claude Code, plus external search (1 MB head, 4 MB tail) and rollout meta
(128 KB). Also:
- child rollouts (`engines/codex/subagent.ts:162`), synchronous `readFileSync` and split;
- resume repair (`engines/codex/portableHistory.ts:150`), which scans the whole rollout with
  synchronous reads, once to inspect and again to copy, on restore, restart, retarget and resume.

The token usage, search, handoff and checkpoint items above apply too.

**OpenCode.** Attach (`engines/opencode/reader.ts:126`); the 1 s live poll re-reads the running
turn (`:205`; its cursor moves only past closed messages); sub-agent counts read the whole child
session per finished task (`:266`); external search (`lib/sessionSearch/externals/opencode.ts:129`);
the shared database sites.

**Grok.** The file-engine sites, with no page cut. External search reads until the first prompt
(`lib/sessionSearch/externals/grok.ts:91`, `:94`).

**pi.** The file-engine sites; the page is cut after the whole read. Titles read from 0 the first
time, then incrementally (`lib/sessionSearch/externals/pi.ts:90`, `:95`).

**agy.** The file-engine sites, with no page cut. External search reads agy's cross-conversation
`history.jsonl` whole, cached per file stamp (`lib/sessionSearch/externals/agy.ts:35`, `:37`).

**Amp.** The file-engine sites. History pages also run `amp threads export` and parse the whole
output (`engines/amp/threadExport.ts:50`, `:66`; 32 MB and 20 s caps).

**Command Code.** The file-engine sites; the page is cut after the whole read.

**Copilot.** The file-engine sites, plus `copilotHistoryTurnOpen` at attach. Session repair
(`lib/sessionRepair.ts:260`, `:267`) reads up to 400 candidate files whole and uses five lines
of each; it serves reconcile repair, handoff discovery and resume identity. External search reads
until the first prompt (`lib/sessionSearch/externals/copilot.ts:187`, `:193`).

**Cursor.** The file-engine sites; the live tail (`watcher/watcher.ts:141` keeps the whole file;
`:428`, `:430` re-read and diff it on every change, heartbeat drain and reconcile); sub-agent
children (`engines/cursor/subagent.ts:174–183`) read whole on every page and polled during a
Task. Store metadata reads are bounded (`LIMIT 1`).

**Devin.** Attach reads every row, duplicates included (`engines/devin/reader.ts:135`); the 1 s
poll (`:192`) is bounded by row id in name only, since the chain is re-persisted each inference;
external search (`lib/sessionSearch/externals/devin.ts:144`); the shared database sites. The error
log is bounded.

**Hermes.** Attach (`engines/hermes/reader.ts:138`); the live poll is bounded by id (`:168`);
external search reads every session in a compression chain (`lib/sessionSearch/externals/hermes.ts:374`);
the shared database sites.

**Kilo.** As OpenCode: attach (`engines/kilo/reader.ts:135`), the 1 s poll re-reads the running
turn (`:214`), sub-agent counts (`:275`), external search, the shared database sites.

**Muse.** The file-engine sites, with no page cut. Session repair (`lib/sessionRepair.ts:313`,
`:322`) reads candidate files whole while a pane is unbound, which is the only way a Muse pane
gets bound; external search stops at the first run (`lib/sessionSearch/externals/muse.ts:75`,
`:78`).

There is no Gemini, Qwen, Factory or Kimi engine. `ENGINES`: claude, codex, cursor, opencode, pi,
hermes, commandcode, devin, muse, amp, kilo, grok, agy, copilot, terminal.

## Left out

Not one agent's conversation, or already bounded: Codex's `session_index.jsonl` readers, the
daemon's own recap store, harness.log, lock, pid and config files, the external store-listing
SQL and search store queries (both have `LIMIT`), and artifact hashing.

## Table

| File | Line | Engine | Trigger | Hot path | Bounded |
|---|---|---|---|---|---|
| cli.ts | 2526 | file engines | attach | once per attach | no |
| cli.ts | 3019 | file engines | recap | every turn end | no |
| backendSocket.ts | 2368 | file engines | history page | every page | no; five engines have no page cut |
| backendSocket.ts | 411 | Claude Code | page, sub-agent stats | every page | no (streamed) |
| lib/agentTokenUsage.ts | 333 | Claude Code, Codex | token backfill | once per session | over 128 MB skipped; incremental after |
| lib/sessionSearch/indexer.ts | 401 | file engines | search first pass, or after a shrink | no | no (streamed; incremental after) |
| lib/sessionSearch/indexer.ts | 467 | database engines | search, every turn event | yes | no |
| lib/sessionSearch/sessionTurns.ts | 127, 137 | all | handoff | no | 5 s deadline only |
| engines/codex/subagent.ts | 164 | Codex | sub-agent done | yes | no; synchronous |
| engines/codex/portableHistory.ts | 175, 190 | Codex | resume, restore, retarget | no | no; synchronous |
| engines/opencode/reader.ts | 126, 205, 266 | OpenCode | attach, 1 s poll, sub-agent done | poll: yes | no; the poll re-reads the running turn; synchronous |
| engines/kilo/reader.ts | 135, 214, 275 | Kilo | as OpenCode | poll: yes | as OpenCode |
| engines/hermes/reader.ts | 138, 168 | Hermes | attach, poll | poll: yes | attach no; poll yes |
| engines/devin/reader.ts | 135, 192 | Devin | attach, poll | poll: yes | no; the chain is re-persisted |
| cli.ts | 3011–3014 | database engines | recap | every turn end | no; synchronous |
| cli.ts | 3044–3047 | database engines | search, handoff | search: yes | no |
| backendSocket.ts | 2238, 2259, 2280, 2305 | database engines | history page | every page | no (windowed in JS) |
| lib/sessionCheckpoint.ts | 39, 143 | database engines | close, twice | no | no; synchronous |
| lib/purgeAgentService.ts | 111 | database engines | purge review, storage telemetry | at most once a minute per agent | SQL aggregate; synchronous |
| engines/amp/threadExport.ts | 66 | Amp | history page | every page | 32 MB output cap |
| watcher/watcher.ts | 141, 430 | Cursor | attach; every change, drain, reconcile | yes | no |
| watcher/watcher.ts | 158, 412 | any, from the start | first replay | no | no |
| engines/cursor/subagent.ts | 182 | Cursor | every page; Task poll | yes | no |
| lib/sessionRepair.ts | 267 | Copilot | repair, discovery, resume identity | repeated | no; uses five lines |
| lib/sessionRepair.ts | 313 | Muse | repair while unbound | repeated | no |
| lib/attachTranscript.ts | 132, 197, 274 | Claude Code, Codex | attach edge cases | no | no |
| lib/transcriptPages.ts | 180, 431 | any with a transcript; Claude Code | first look; stale cursor | no; per request | incremental after; to the start at worst |
| lib/transcriptTail.ts | 171 | Claude Code, Codex | recap | every turn end | to the last prompt; whole file if none |
