# Store readers page by bytes (#4188)

## Why

The engines that keep their conversation in a SQLite store (OpenClaw, OpenCode, Kilo, Hermes, Devin) are read
through `sqliteReadAll` (`cli/src/lib/sqliteRead.ts`). In the core every read runs on a read thread
(`cli/src/lib/sqliteThread.ts`) that refuses a reply over the read's `maxBuffer` as `transient`. The readers retry a
`transient` read on the next poll, so a read that is refused for its size is refused on every poll, for good: the
reader is stuck and the pane shows nothing new, with one log line.

Today no reader's reply has a limit that fits what it asks for:

- **OpenClaw** reads 500 rows a page with a reply limit of `PAGE × MAX_EVENT_BYTES`, about 2 GB: no limit in
  practice. The lamp runs OpenClaw on a memory-tight ARM64 Linux box, where a page of large events held whole in a
  read thread is a real cost. A tighter limit on a page sized by row count alone could refuse a page every time.
  Worse, the 4 MiB the code calls the store's bound holds only for compressed rows: OpenClaw writes an event over
  4 MiB as plain `event_json` with no cap, so one row can be larger than any page budget.
- **OpenCode, Kilo, Hermes and Devin** do not page at all: each reads everything after its cursor (the whole session
  when it seeds or reads history) in one query against a fixed 32 MiB limit. A session with more than 32 MiB to read
  is `transient` forever: the live reader never seeds, history never loads. OpenCode rows of 7.5 MB are on record
  (`sqliteRead.ts`).
- **The session checkpoint** (`cli/src/lib/sessionCheckpoint.ts`), taken when a session is closed, reads each of the
  session's tables in one query against the same 32 MiB default. A session over it cannot be checkpointed, so it
  cannot be closed.

Same cause everywhere: an unbounded read against a fixed reply limit. The fix covers every one of them.

## Goals

1. Every store read of conversation rows is a page bounded by bytes as well as rows, and its reply limit is derived
   from that bound, so no page is ever refused for its size.
2. A row larger than the page budget never stops a reader: it is read on its own page when it fits the row cap, and
   stepped past (logged once, no content) when it does not. The cursor always moves.
3. Every caller gets the same result as today: the live tails, history, last turn, search, token usage and the
   checkpoint see the same rows in the same order, only read in more queries.
4. On the lamp, an OpenClaw read holds at most about one page budget (4 MiB) of rows in its read thread; more only
   when a single row is larger, and then only that row.

## Non-goals

- Bounding what a whole-conversation read holds in memory once read. History, last turn, search and the checkpoint
  still assemble the whole conversation (the history API windows it after reading it all); paging that is a separate
  change.
- The `sqlite3` CLI fallback and the caller's-thread `node:sqlite` path keep their behavior: they gain the paging
  (smaller replies), and the caller's-thread path still enforces no reply limit.
- Session listings and other small reads already capped by row count (`storePool`, `storeSource`, `sessionRepair`,
  `agentTokenUsage`, search's session list, `launchControl`) are not this cause and are left as they are.

## Anti-goals

- A reader that can stick on one row or one page, for any store content.
- Any row content in a log line, error or measure.
- A second way to page: the readers share one paging rule, not five copies of it.

## Design

### The paging rule (one shared primitive)

One helper beside `sqliteReadAll` builds and runs a byte-bounded page for a keyed table (the builder picks its shape
and name). A page, read after a cursor in key order:

- holds at most `N` rows (a count cap, as OpenClaw's 500 today);
- takes rows while the running total of their sizes, this row included, stays within the page budget `B`; the first
  row is always taken, so a page always moves the cursor;
- sizes every row in SQL without returning its payload (a running `sum() OVER (ORDER BY key)` over an inner query
  that is itself limited to `N` rows, then a join back on the key for the payloads of the rows kept, so payloads
  outside the page never reach the reply);
- returns a row whose size passes the row cap `R` with no payload and a flag, so the caller steps past it;
- says whether it is full: cut by count or by bytes. A caller reads again after the last row's key while it is full.

A page's reply is then at most `max(B, R)` of payload plus the rows' fixed overhead (column names and numbers, about
30 KB at 500 rows), and its `maxBuffer` is exactly that bound, derived from the same constants, so no page is refused
for its size.

A row's size is its payload's UTF-8 byte length. OpenClaw: `coalesce(event_utf8_bytes, <byte length of event_json>,
length(event_zstd))`, with hidden rows sized 0 (their payload is blanked already). The others: the byte length of
the payload columns the reader returns. The size expression must run on every SQLite the reader can meet, the CLI
fallback's included (`octet_length` is 3.43+; `length(CAST(x AS BLOB))` works everywhere); the builder measures which
reads the fewest overflow pages.

### Constants

One pair for every store and the checkpoint: page budget `B` = 4 MiB, row cap `R` = 32 MiB (my call).

- `B` = 4 MiB keeps a page, on the lamp too, near 4 MiB of rows.
- `R` = 32 MiB is today's whole-read limit for the other engines, so no row that is shown today is dropped
  (OpenCode rows of 7.5 MB exist; OpenClaw plain events over 4 MiB are read today). A row between `B` and `R` is read
  alone on its own page, so the memory a read holds grows past `B` only by that one row, only when it exists.
- The reply limit, `max(B, R)` plus overhead, is a refusal threshold, not an allocation: what a read holds is what its
  page's rows weigh.
- OpenClaw's `decode` keeps its 4 MiB cap when it inflates a compressed row: the store's CHECK bounds those at 4 MiB.
- A checkpoint must be complete: a row over `R` fails it with the existing error rather than dropping it.

`N` stays 500 rows for OpenClaw; the builder sets it for the others (a value whose fixed overhead stays small next to
`B`).

### OpenClaw (`cli/src/engines/openclaw/reader.ts`)

- `rowsSql` (the live and active-branch pages) becomes a byte-bounded page; `readPage`'s `full` is "cut by count or
  by bytes". `readActive`, `readOpenclawSince` and the live tail's one-page-per-poll keep their loops.
- A row over `R` comes back with no payload; `decode` logs it once through `unreadable()` (`too big`, its seq, no
  content) and the cursor moves past it, as for a hidden row.
- `IDS_SQL` (every event id of an earlier window, one row each, no limit today) pages by `seq` too, with a reply limit
  that fits its page.
- Every other query (`NODE_SQL`, `LAST_SEQ_SQL`, `PREVIOUS_SQL`, `NEWEST_HEADER_SQL`, `COLUMNS_SQL`, the schema reads)
  gets a reply limit that fits what it can return, instead of the 2 GB page limit. `NEWEST_HEADER_SQL` returns the
  header with no payload when it is over `R`, and then no header is borrowed.
- `event_utf8_bytes` joins `OPENCLAW_COLUMNS.transcript_events` (`contract.ts`), so a store without it is
  `unsupported`, as for any column the reader reads. It is in agent schema 27, the version the reader reads.
- The comments that call 4 MiB the bound of every row, and `MAX_PAGE_BYTES`, go.

### OpenCode, Kilo, Hermes, Devin

Each engine's `load…Messages` reads page after page from its cursor until a page is not full, and returns what it
returns today. The callers (live readers, history, last turn, search, `databaseHistory`) do not change.

- **Hermes** pages `messages` by `id`; **Devin** pages `message_nodes` by `row_id` (its `message_id` dedupe spans the
  pages of one call); **OpenCode 2** pages `session_message` by `(time_created, seq)`.
- **OpenCode 1 and Kilo** read `message LEFT JOIN part`. Their page unit is a message with all of its parts, sized as
  the message's data plus its parts' data, keyed by `(time_created, id)`, so a message is never split across pages.
- A unit over `R` is left out and logged once by its key, with no content, and the load's paging moves past it.
  It vanishes from what the load returns, with no stub (my call). A live reader whose own cursor is set from the units
  returned (the last finished message, the largest id) then pages over that one unit, without its payload, on each
  poll until a later unit comes; and if the dropped unit is the message that closes a turn, the turn closes with the
  next one. Both are accepted: such a unit is over 32 MiB, and today it stops that session's reads for good.

### Session checkpoint (`cli/src/lib/sessionCheckpoint.ts`)

The tables that hold a conversation's rows (`message`, `part`, `session_message`, `messages`, `message_nodes`,
`transcript_events`) are read in byte-bounded pages by their key and concatenated, so the checkpoint holds the same
rows as today. A row over `R` fails the checkpoint with the existing `SessionCheckpointError`. The pages of a table are
separate reads, not one snapshot (my call): the checkpoint is taken as the session closes, today's tables are already
separate reads, and a row added between pages is still read since the cursor follows the key. The one-row tables
(`session`, `sessions`, `session_v2`, `session_nodes`, `session_windows`) stay single reads.

### Failures and measures

- A dropped row is one log line per row (`[<engine>] <short session id> seq|id <key> unreadable · too big`), never its
  content, as `unreadable()` does today.
- A page refused for its size can no longer happen; any other `transient` keeps today's handling.
- No new metric: the paging adds no state anyone acts on beyond the log line.

### Data

No data is stored, synced or exposed that was not before: the readers read the same rows in smaller replies. No
Design section from the data checklist applies.

## Verification

- Unit specs per reader, with off-thread reads on (`enableOffThreadSqlite` / `resetOffThreadSqlite`, as
  `sqliteThread.spec.ts` does, since only that path enforces `maxBuffer`): a store whose rows add up to several page
  budgets is read whole across more than one page, in order, and no reply passes its limit. Covered for
  `readOpenclawHistory`, `readOpenclawSince`, the OpenClaw live reader, each of the four other engines' load, and the
  checkpoint.
- A row over the row cap: the reader steps past it, logs it once, reads every row after it, and does not stick on the
  next poll. The checkpoint fails with its error.
- Each spec fails on today's code (a reply over the limit, or a read that never completes).
- Numbers before and after: the time and the largest reply of reading a large OpenClaw window (thousands of rows,
  some of a few MiB) and a large OpenCode session, on the same machine.

## Platforms

The CLI daemon on macOS, Linux (the lamp's ARM64 box included) and Windows. Pure TypeScript and SQL on the store
readers; no native code, process or path handling. The new specs run on PR CI (Linux) and on this Mac; the Windows
machine is not used (my call: nothing platform-specific changes). The before/after numbers are taken on this Mac only
(my call): reply sizes do not depend on the machine.

## Calls made (not asked)

Ken's go covered the spec, the plan and the build; these are the main session's calls, for him to check:

- All five readers and the checkpoint are in this change, since they share the cause.
- Page budget `B` = 4 MiB per page; row cap `R` = 32 MiB. A row over `B` is read alone rather than dropped, so nothing
  shown today stops showing (OpenCode rows of 7.5 MB, OpenClaw plain events over 4 MiB). Only a row over `R` is
  stepped past. On the lamp a read holds more than `B` only while such a row is being read.
- A stepped-past row is one log line naming the engine, a short session id and the row's key: no path, no content,
  no stub in the transcript.
- OpenCode 1 and Kilo page by whole messages (a message with its parts), never splitting one.
- The checkpoint fails on a row over `R` instead of dropping it.

## Constraints from the builder check

- The paging SQL runs on any SQLite the readers can meet, the `sqlite3` CLI fallback's too: window functions need
  3.25, so a sizes-only query then a payload query is acceptable. The CLI's stdout is JSON-escaped, so its reply
  limit carries an allowance for escaping.
- OpenCode 1 and Kilo: today's `message LEFT JOIN part` repeats the message's `data` on every part row. A unit's
  reply returns the message's data once, and its size counts the per-part-row overhead.
- The bound never trusts `event_utf8_bytes` alone: nothing in the store ties it to a plain row's real length, and a
  wrong value must not make a page refused or a reader stick.
- A load that fails on a later page returns nothing (today's `null` / `transient`), never the pages already read: a
  partial seed brings back the #4065 replay.
- The checkpoint's OpenClaw rows are every column, with compressed rows as hex: its size counts every column it
  returns, the hex one at twice the blob's length.

## Left to the builder

- The helper's name, signature and where the SQL is built; whether the window-function query is one statement or
  two, as long as payloads outside the page never reach the reply.
- `N` for the engines other than OpenClaw, and the exact fixed-overhead allowance in `maxBuffer`.
- The byte-length expression, by measurement.
