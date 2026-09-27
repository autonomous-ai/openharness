# Session search: finding a harness by what happened in it

2026-09-26. Why ⌘P could not find the session you wanted, what was built instead, and how it
measures on one machine's real sessions (184 harnesses, 77 transcripts, 4.4 GB of JSONL).

## The problem

⌘P searched two things, both in the app:

- the catalog: name, agent title, project, branch, folder, machine, engine;
- the preview cache: the last three asks and the latest recap, fetched for the first 32 sessions
  per machine only.

The daemon kept nothing older than three turns, and nothing searched the transcripts. Known-item
test: take something you asked mid-session and search for its two rarest words. The app found the
session **0%** of the time. A full-transcript keyword index found it **100%** top-1.

The ranking made it worse:

- **Recency beat relevance.** Every match was sorted by last activity, so a weak match on a newer
  session buried the session named for the word: the harness named `hn` came 6th of 166 matches.
- **Scattered letters matched through folder paths.** `auth` matched every
  `.../autonomous-harness/...` folder: 81 matches, none about auth.
- **Preview text matched fragments.** `port` matched "support", "report", "important".

## What was built

```
 transcripts on each machine        daemon, per machine (cli/src/lib/sessionSearch/)       desktop app
 ─────────────────────────         ─────────────────────────────────────────────           ───────────
 ~/.claude/projects/*.jsonl  ──►  engine's own normalizer ─► turns ─► SQLite FTS5  ◄── session_search
 ~/.codex/sessions/*.jsonl        (from a saved offset;       │       session-search.db      (E2EE, every
 cursor, pi, amp, grok, …          tool output skipped)       │       0600                   connected
                                                              ▼                               machine)
                                                     `harness search` reads it too    merge with name
                                                                                      matches, snippet
```

### Where: each machine's daemon

Transcripts stay on the machine that ran the agent; the app talks only to the CLI. Each daemon
indexes its own sessions and answers `session_search`. The app asks every connected machine in
parallel and merges. Only the hits for a query leave a machine, sealed like every other RPC.

### What is indexed

One row per turn: what was asked, the answer, and the tool calls' paths, commands and queries.
A header row per session holds its name, title and last two folder names, so "mobile swipe" finds
the session named Mobile whose swipe discussion came later.

- **Reuse, not a parser per format.** A pass runs the engine's own incremental normalizer, the one
  the live view uses, over the transcript. Every JSONL engine (Claude, Codex, Cursor, Pi, Amp,
  Grok, Muse, Agy, Copilot, Command Code) comes for free, cleaning included. The engines that keep
  history in a database (OpenCode, Kilo, Hermes, Devin) go through the readers and replay
  normalizers `session_get` uses, read whole when the session changed.
- **Left out:** tool output, reasoning, images. Tool-output records are recognised by their first
  kilobyte and skipped unparsed. Across all 76 real transcripts, asks, answers, turn times and
  offsets come out identical with and without the skip.
- **Beyond the normalizer (Claude):** a message typed while the agent works is written as a
  `queued_command` attachment, and a `/goal` only as the meta line that turns its Stop hook on.
  The live view leaves both out, so the index reads them itself.
- **Cleaned:** harness wrappers removed, whitespace folded, secrets blanked with the CLI's
  redactor, encoded blobs dropped. Asks are capped at 8 KB. A row holds up to 12 KB of answer and
  4 KB of tool text; a longer turn goes on in continuation rows, split between lines.

### Keeping it fresh

One code path for backfill and live updates. A pass reads from the session's saved resume point,
the opening byte of its last turn, which may still be growing. A turn starting or ending in a live
session queues its pass 1.5 s later. A sweep runs 15 s after boot and every 10 minutes. A file that
shrank is re-read from the start; an agent that no longer exists is dropped with its sessions.
Passes run one at a time, read 1 MB chunks and yield every 12 ms.

Measured: the first backfill of 4.4 GB took **4.7 s**, with a longest event-loop stall of 48 ms. A
sweep with nothing new takes 0.1 s. The index is 11 MB. Resuming from the last turn's offset
reproduces that turn exactly for all 76 transcripts.

### Keyword, not vectors

SQLite FTS5 with BM25 (`node:sqlite`, already in the managed Node 22.23; no new dependency).

- ⌘P queries are one to three words typed live, and often exact tokens: codenames, files
  (`swarm_search.dart`), ids (`OH-14`, `#189`). BM25 is exact on those; embeddings blur them.
- Every word matches as a prefix, so results update while typing. Words are split the way the
  index splits them, so `swarm_search.dart` is a phrase of its parts.
- Embeddings would need a local model on every machine, a slower backfill and more storage, and
  cloud embeddings are out because transcripts hold code and secrets. They stay a later option,
  as a second retriever fused by rank, if logged misses show vocabulary mismatch.

### Ranking

In the daemon:

1. Sessions with one turn holding every word, ranked by that turn's BM25. Column weights:
   name 6, ask 4, answer 1.5, tools 1. Each session's first two turns count 1.2×.
2. Then sessions holding every word, but spread across turns, at half weight.
3. Relevance relative to the best hit, blended 80/20 with recency (half-life 10 days).
4. For each hit, a snippet built from the stored turn: the ask first, then the name, the answer,
   the tools.

In the app, a hit is one more kind of match:

- Name matches rank first, as before.
- A turn holding every word ranks under name and context matches.
- Words spread across a conversation come next, and letters scattered across a name come last:
  real words anywhere are better evidence.
- Hits from several machines merge by reciprocal rank. Each daemon scores against its own best
  hit, so a machine's first is treated as another's first, and activity breaks the tie.

The row shows the matched words on its line, fzf-style (`> …`, `$ …`), and the preview says where
they were found and when. Requests are
debounced 110 ms and stale answers dropped. The best row stays selected as hits arrive, unless you
have moved. A machine that cannot answer, because it is offline or runs an older CLI, adds nothing.

### When: "dial last week"

People remember a session by roughly when as often as by what. The app reads a time phrase out of
the query and sends every machine the same window in this computer's time zone:

- today, yesterday, this or last week or month;
- N days or weeks ago, a few days ago (loosely: a day, or half a week, either side);
- a weekday with "on" or "last": "on monday", "last friday". A bare weekday stays a word, so a
  harness named "Friday deploy" is still found by name.

Only sessions worked on in that window are searched: any turn then, not only the matching one. So
"the dial one from last week" is a session about the dial that was open last week. The remaining
words are matched as usual. A time alone ("yesterday") lists what was worked on then, each row
showing what was asked.

## Measured

### Accuracy on real sessions

Known-item queries sample a turn and take words from it; top-1 means a session where that was
actually said comes first. Topic queries take two words from each session's auto-title and search
an index with every name removed, so only what was said can find it.

| Query | n | Top 1 | Top 3 | Top 10 |
|---|---|---|---|---|
| Two rare words you typed | 102 | 85% | 92% | 100% |
| Two words from the answer | 99 | 99% | 100% | 100% |
| One word you typed | 71 | 52% | 89% | 100% |
| Typing: 4-letter prefixes of two words | 102 | 73% | 88% | 99% |
| Topic, from the title, names removed | 69 | 59% | 74% | 84% |

These numbers come from one frozen snapshot. The queries are sampled from the data, so a snapshot
taken an hour earlier, with the same ranking, read 5 points higher on some rows: treat ±5 as
noise.

A single word is ambiguous by nature: it usually appears in several sessions, and top-3 is the
fairer number. Tuning is recorded in the code:

- Counting a session's opening ask for more took topic queries from 46% to 61% top-1.
- Weighting sessions by how many turns match helped single words but hurt everything else, so it
  was dropped.
- Scoring whole sessions as one document was worse on every row, so it was dropped.

### Ranking fix in ⌘P (app only)

On 184 real harnesses:

| Query | Before | After |
|---|---|---|
| `hn` | the harness named hn 6th of 166 | 1st |
| `x post` | an unrelated firmware session first | the X posts session first, 4 matches |
| `cmd o` | the Cmd O session 3rd | 1st |
| `store` | 84 matches | 10, all Store sessions |
| `auth` | 81 matches | 3 |

### Speed

| Index | p50 | p95 | Max | Size |
|---|---|---|---|---|
| Real, 1.7k turns | 1.7 ms | 3.4 ms | 6 ms | 11 MB |
| Synthetic, 102k turns (60× real) | 18 ms | — | 72 ms | 667 MB |
| Same, with a time window | 15–70 ms | — | 200 ms | |

Getting there:

- Rank inside FTS5 before joining.
- For a word in more than 30k turns, skip the BM25 sort, which barely discriminates there. Take the
  3,000 newest matching turns by turn time and let recency decide. Not the highest rowids: a
  backfill writes the newest sessions first.
- The slowest queries left are a time with no words over a wide window, and a very common word
  inside a window: up to 200 ms at 100k turns.
- A window's sessions are read once and kept while the window stays the same, keystroke to
  keystroke.
- Build snippets from the stored turn: FTS5's `snippet()` re-read a common word's whole posting
  list for every hit, 250 ms for 30 hits.
- Prefix indexes for 2–4 letters: dropping to 2 letters saves 25% of the size but makes `the*`
  926 ms at 100k turns.

Two gotchas:

- `node:sqlite` binds a JS number as REAL, and FTS5 silently ignores a REAL `rowid =` constraint
  beside `MATCH`. Every row came back, so every hit had the same snippet. The fix is
  `CAST(? AS INTEGER)`.
- FTS5 refuses `bm25()` inside an aggregate, even in a subquery that gets flattened.
- `rowid IN (…)` beside `MATCH` runs a posting-list lookup per value: 3,000 ids took 72 seconds.

## Tested end to end

The branch's daemon ran on the development Mac in isolation, beside the real one: its own HOME,
port 28473 and tmux socket, fed a copy of the stopped sessions. Their transcripts were read in
place, read-only, and nothing was resumed or spawned. Two harnesses drove it:

- **A protocol client that speaks what the app speaks:** local WebSocket, `machine_select`, then
  `session_search`. Real queries answered in 1–18 ms. Typing "retention cohorts" a key at a time
  peaked at 7 ms. 60 concurrent requests were all answered, each with its own answer. Hostile input
  (FTS5 syntax, SQL, quotes, a 5,000-character query, wrong payload types, bad windows) never
  errored or took the daemon down.
- **Cmd-P's own code against it** (`desktop/test/session_search_daemon_e2e_test.dart`, opt-in):
  the app's `WsConn`, catalog and search controller over the real index. 23 cases cover names,
  conversations, time phrases, prefixes, codenames, file names and "nothing". Each keystroke
  reaches results in about 130 ms, most of it the 110 ms pause-in-typing debounce, with the best
  row selected.

What it found, all fixed:

- **Injected messages counted as yours.** Sub-agent hand-backs and harness notices were 6% of what
  the index held as the person's asks.
- **A time alone showed agent text.** It showed an agent's report instead of the last thing the
  person asked then.
- **Paste markers leaked** into snippets.
- **Two scattered letters matched everything:** "hn" hit 182 rows. They are now initials only, for
  harness rows.
- **Keystrokes got slower** from the stricter letter check. Fixed; 2,000 harnesses are at parity
  with main.
- **Command search lost "kb".** Short curated lists (commands, machines, projects, models, Store)
  keep main's letter matching; command search is identical to main on 30 short queries.

Also by design: a leading `#` in Cmd-P opens projects, so type issue numbers without it ("issue
189", "pr #368").

## Tested live

On 2026-09-27 main's daemon replaced the development Mac's real one: the machine's own sessions,
live, with the app attached. The index built in about 12 s, including a 346 MB Codex rollout. It
found three things the sandbox runs could not, because they come from long, busy sessions:

- **Messages typed mid-turn were lost.** Claude Code writes them as `queued_command` attachments,
  which the normalizer skips. There were 405 of them on this machine. The one asking "keyword or
  vectors or embeddings?" is what this project was built on, and it was not findable.
- **A `/goal` was lost** the same way: it exists only in the meta line that activates the goal.
- **The middle of a long turn was lost.** The overnight turn that built this kept its first 3 KB
  and last 9 KB of answer, so "fts5 bm25" found nothing in it. Continuation rows keep all of it.

On one machine's sessions, the fixes took the index from 1,851 to 2,376 rows and from 12 MB to
17 MB. The first build takes 5.5 s, and its longest stall is 38–47 ms once a long first pass
writes 32 rows per transaction (130 ms in one). On one query set drawn from the old index, accuracy
is unchanged (two rare words 88% → 88%, answer words 99% → 99%, prefixes 71% → 72%, one word 62% →
58%). That set can only ask about what both indexes hold; the gains are in what the old one did not.

The live run also showed the daemon crash-looping out of memory, which is not search: after a
restart, the first `SessionStart` from a long session replayed its whole transcript live (3,553
events from the 346 MB rollout). The replay was meant only for a first turn announced before its
file existed. This machine's log has 28 out-of-memory crashes since 2026-09-23, on every build
including the v0.3.1 release. It is fixed separately.

## The preview

⌘P's preview shows the selected session the way its terminal does: bottom-anchored, newest turn at
the bottom, scrolled up for older ones (shift-↑/↓, page up/down), like fzf's `--preview` showing
the file itself rather than a summary. The daemon serves it from the same index (`session_tail`),
so a preview reads no transcript: 0.4 ms for a real session's last page, 1–20 ms over the local
socket, about 0.4 s from another machine over the relay.

- **The last ~16,000 characters**, about five screens, then 16,000 more each time the list nears
  its top. A session is fetched once per ⌘P opening, when its row is selected; nothing refreshes
  while ⌘P stays open, not even for a working agent. The app keeps the last 20 sessions previewed
  and warms the next two rows while one is selected.
- **The latest ask stays in view.** After a long autonomous turn it is many rows up, so it is
  pinned above the turns whenever its own line is not showing.
- **An older match says where it was** ("Matched earlier · 1d ago") above the turns, and the
  searched words are bold in them.
- **A working agent's turn so far** is included: the request brings that session's index up to
  date first, waiting at most 400 ms. A question waiting on the person sits below the latest turn.
- **Stored text keeps its line breaks and indentation** so answers read as written; search folds
  them. Claude Code's label and 800-character instruction around another agent's message are
  dropped: they were never said in the conversation. Schema 7 rebuilds each index once.
- Group rows, and machines whose CLI predates `session_tail`, keep the excerpt preview.

## Conversations Harness did not start

⌘P also finds Claude Code and Codex conversations run in a terminal or in the engines' own apps, and
Enter opens one as a harness resuming it (`lib/sessionSearch/external.ts`).

- **Found on disk.** Every local Codex session, whether from the terminal, the Codex app or a
  script, is a rollout under `~/.codex/sessions/YYYY/MM/DD/`. Its first line says who wrote it:
  `source` `cli` (terminal) or `vscode` (the Codex app, `originator` "Codex Desktop", and the
  editors). Thread names are in `~/.codex/session_index.jsonl`. Claude Code's are under
  `~/.claude/projects/<folder>/`, with `entrypoint` `cli` or `claude-desktop`. Claude's title is
  the latest `ai-title` in the transcript, unless the person renamed it (`custom-title`).
- **Only what a person started.** Codex `exec` runs (scripts), sub-agent threads, and Claude's
  `sdk-cli` sessions (programs, Harness's own summaries among them) are left out. On one machine:
  about 210 of 1,227 files, plus a session any Harness agent already has is skipped.
- **Shown only when a search matches one**, marked `not in Harness`, and previewed like any session.
- **Open elsewhere** is known exactly. A running Claude Code keeps `~/.claude/sessions/<pid>.json`
  naming its session, and a running Codex holds its rollout open (`lsof`). The process's terminal
  (`ps -o tty`) tells a terminal from an app: the engines' apps have none. One open in an app
  cannot be opened here and is not offered on the welcome page.
- **Taking one over from a terminal.** Most people's sessions are open in a terminal before they
  meet Harness, so those can be moved. Opening one asks first:
  - **Idle** (between turns): *Move Here* stops the terminal's process and resumes the session in
    Harness. Nothing is lost: every finished turn is already on disk.
  - **Mid-turn**: *Wait* opens the harness pane at once. The pane says it is waiting, the daemon
    stops the terminal's process when the turn ends, and the pane then resumes it. Ctrl-C in the
    pane, or closing it, leaves the session where it was. *Take Over Now* stops the turn and
    resumes with a first message of `continue`.
  - **Mid-turn is read the same way:** Claude Code's record says `idle` between turns. A Codex
    rollout's last `task_started`, `task_complete` or `turn_aborted` event says where its turn
    stands.
  - **Stopping** is SIGTERM, then SIGKILL after five seconds. Tested on the real TUIs: both quit
    cleanly and restore the terminal, except that Codex leaves its cursor hidden, so the daemon
    writes the show-cursor sequence to that terminal.
  - The daemon stops the process last, once nothing else can refuse the launch. It never stops an
    app's.
- **Resuming** is `agent_create` with `resumeSessionId`: a new pane runs `claude --resume <id>` or
  `codex resume <id>` in the session's own folder, named after its title. It is refused if the
  session is already a harness, or its folder is gone (Codex app threads live in folders people
  tidy away). An open one is refused with `SESSION_OPEN_IN_TERMINAL` or
  `SESSION_BUSY_IN_TERMINAL` until `takeOver` (`idle`, `now` or `wait`) says how to take it over,
  or with `SESSION_OPEN_ELSEWHERE` when an app has it.
- ChatGPT conversations and Codex cloud tasks are not on disk, so they cannot be found.
- **The welcome page lists them too.** An empty tab shows up to nine rows beside its shortcuts,
  numbered like the terminal client's home: the harnesses you were just with and these
  conversations from every machine (a `session_search` with the last 30 days and no words), each
  just a name and an age. A narrow window puts the shortcuts under the list; with nothing to offer
  the page is the shortcuts alone. A new user's first screen is their existing Claude Code and
  Codex work, one key away.

Checked on one machine's real folders through a sandboxed daemon: the Codex app's threads and
terminal sessions were found by what was said in them. A session open in a terminal was refused.
Stand-in engines confirmed the resume launch (`codex resume <id>`, `claude --resume <id>`, each in
its session's folder); no real conversation was touched.

Take-over was checked the same way against made-up sessions, held by stand-in processes in their
own terminals:
- Opened without a choice, a busy Codex session was refused as busy and an idle Claude one as
  open, and both processes were left alone.
- *Move Here* stopped the Claude one and resumed it.
- *Wait* opened a pane saying it was waiting. When `task_complete` was appended to the rollout,
  the daemon stopped the Codex process within two seconds and the pane resumed it.
- *Take Over Now* resumed with `continue`.
- Each terminal got its cursor back.

## Protocol

`session_search { query, limit, from?, to? }` → `{ hits: [{ agentId, sessionId, engine, turn, at,
lastAt, field, snippet, together, score }], indexed, pending, tookMs }`. `from` and `to` are epoch
ms.

- Matched words in the snippet are wrapped in `\u0002 … \u0003`.
- `session_search` and `session_search_result` are in the E2EE type sets (`cli/src/lib/e2ee/core.ts`,
  `desktop/lib/e2ee/envelope.dart`). That **re-pins the interop keystone**, so the browser client
  and the device must re-derive from the new `core.ts`.
- A Node without `node:sqlite` answers `SEARCH_UNAVAILABLE`.

`session_tail { sessionId, beforeTurn?, maxChars? }` → `{ sessionId, rows: [{ turn, at, ask,
answer, tools }], hasMore, total, lastAt, lastAsk? }`: a session's latest rows, oldest first, up to
16,000 characters (64,000 at most). `beforeTurn` pages up from the first row the client has, and
`lastAsk` (the latest row with an ask) comes with the last page. It is in the same E2EE sets, which
re-pinned the keystone again. `NOT_INDEXED` for a session the index does not hold.

`harness search <words> [--limit N] [--json]` reads the same index from a shell, and reads the same
time phrases (`harness search dial last week`). It is read-only: it never migrates or deletes the
index the daemon owns.

## Not yet

- **Untitled sessions** ("Claude harness 9-26 13:41") are now found by their content, but a
  generated title from the first ask would help the name match as well.
- **A natural-language "ask" mode** for fuzzy memory ("the one last week where we fixed dial
  scrolling"): let the daemon's existing LLM router pick from the top keyword and recency
  candidates. Explicit and slower, never in the type-ahead path.
- **Local measurement:** log `(query, chosen row, its rank)` on this computer only, never sent
  anywhere. Its mean reciprocal rank decides whether embeddings are worth adding.
