# How Harness stores harnesses and sessions: an audit

2026-10-10. Read from the code on `main` (0b2dd18f) and checked against one real Mac's data folder
(`~/.harness/cli/data`), read only. Every number below was measured, not estimated.

## The stores

| Store | What it holds | Written by | Read by |
|---|---|---|---|
| `registry.json` | Live harnesses: id, engine, folder, conversation id, transcript path, pane | `lib/registry.ts` | everything live |
| `stopped-agents/<id>.json` | Stopped harnesses: the same record, kept as durable history | `lib/stoppedAgents.ts`: Stop (`stopAgentService.ts:99`), forget (`core/agents/forget.ts:76`), exited and abandoned sessions | resume, Cmd-P (`agents_list` with `includeStopped`), search sources |
| `stopped-agents/<id>.resume` | A resume in progress (crash guard) | `beginResume` | resume; one older than the readiness budget is taken over (`resumeAgentService.ts:65`) |
| `session-search.db` | Every conversation's turns, full-text indexed | search service (`services/search.ts`, `lib/sessionSearch/`) | Cmd-P content search, `hn` session picker, previews, Memories |
| engine transcripts | The conversations themselves (`~/.claude/projects`, `~/.codex/sessions`, …) | the engines | resume, the index |

A harness's life: created → `registry.json`; Stop → record saved to `stopped-agents/` (kept forever);
Resume → back in `registry.json` (the archive stays, hidden while live by `available()`,
`stoppedAgents.ts:239`); Delete with session data → transcript, checkpoints, index rows and the archive
removed (`purgeAgentService.ts:318-329`, `core/agents/lifecycle.ts:65`).

The search index follows the records: its sources are `core.agents.all()` = live **and** stopped
(`core/api.ts:1409`, `services/search.ts:80`), and each sweep drops rows whose harness no longer exists
(`indexer.ts:234-243`). On this Mac every one of 165 indexed Harness conversations has a record
(17 live, 148 stopped). Cmd-P, resume and the `hn` picker read folders from those records, never from
the index.

## What is wrong

### 1. A test run can write into the real data folder (fix)

`vitest.setup.ts` gives every spec a throwaway home and data folder, but only when vitest runs from
`cli/`. Run from the repository root it finds no config, skips the setup, and every spec uses the real
`~/.harness`, `~/.claude` and `~/.codex`. Proved with the repo's own isolation spec and a fake `HOME`:
from `cli/`, 6 of 6 pass; from the root, 5 of 6 fail. Nothing in `config/env.ts` refuses.

On this Mac, 19 records in `stopped-agents/` carry `stopAgentService.spec.ts`'s exact fixture (pid 77,
`startMarker: 'fixture'`, folder `/tmp`, session id `saved` or `latest`), all written at 15:37:22 on
2026-09-26. Cmd-P lists 17 of them as stopped "Codex harness 9-26 15:37" rows. Which command wrote them
is not recorded; running a spec from the root is the one path found that would.

**Fix:** `config/env.ts` refuses to load under Vitest unless `vitest.setup.ts` marked the run isolated,
so a mistaken run fails at once instead of writing. Then remove the 19 fixture files (with the owner's
yes: it is their data folder).

### 2. One conversation, two or three stopped rows (fix)

The daemon answers Cmd-P with 414 rows. Apart from the fixtures, 18 conversations appear in more than one
stopped record. The app keys rows by harness id (`app_state.dart:9683`), so each shows. They come from a
conversation bound by a second harness: `source` is `terminal-resume`, `resume`, `compact` or
`process-repair` on the later record. While one copy runs the other is hidden (`available()`); when both
are stopped both show, and neither copy's history can be deleted, because delete refuses a conversation
another harness uses (`purgeAgentService.ts:240`, which is the right guard).

**Fix:** apply the registry's own newest-bind-wins rule to stopped records (see Decision below).

### 3. The index keeps no folder or title for Harness conversations (fix, for Memories)

`externalFields` (`indexer.ts:76`) writes `cwd` and `title` only for conversations Harness did not start.
All 165 Harness rows have both empty; outside rows have them. That is 5,072 of 9,928 indexed messages on
this Mac (and 3,940 of the 4,000 most recent). Cmd-P does not need them (it joins to the records), but
Memories reads the index directly, so it cannot place half of a person's messages in a project.

**Fix:** the search service already has `s.cwd` and `s.title` for every Harness source
(`services/search.ts:80-92`); the indexer writes them for Harness rows too. The header stays as it is.

## Checked and fine

- **Leftover resume reservations** (8, 13 to 19 days old): a later resume takes them over
  (`resumeAgentService.ts:65-71`). Harmless files.
- **The same harness in both stores** (14): by design; the archive is hidden while the harness is live.
- **Index rows without a record:** none. Delete removes rows at once; sweeps remove the rest.
- **Deleting shared history:** refused while another harness holds the conversation.

## Watch, no change now

- `stopped-agents/` only grows: 399 records (490 KB) in about three weeks. Each Cmd-P open lists them all;
  the parse cache holds 2,048 records (`stoppedAgents.ts:12`). At this rate that is reached in about
  three months; measure `agents_list` then.
- 186 stopped harnesses never had a conversation (113 terminals, 73 agents). Cmd-P lists them; whether a
  never-used harness belongs in history is a product call.

## Decision (after a full study of the code)

**Keep the layout. Apply the registry's own ownership rule to stopped records. Nothing else changes now.**

### Why the layout stays

`registry.json` is the process table: "one per supported top-level engine process in a tmux pane … lives
exactly as long as that process", persisted only so a live agent survives an update restart
(`lib/registry.ts:1-13`). `stopped-agents/` is durable history (`lib/stoppedAgents.ts:1`). The process
table must change several rows in one atomic write — a pane taken from one agent by another
(`openProcessAgent`), a conversation moved with its displaced owner (`save`'s `bindingCommit.displaced`),
checked after every write so no two rows own a process, pane or conversation (`validatedRows`) — while three
writers share it: the daemon, the engine hook (`cli/hook/notify.mjs` `writeRegistry`) and a peer daemon on the
same data folder (`reconcileUnconfirmed`). History has one writer and never changes rows together.

| Alternative | Verdict |
|---|---|
| One file per harness | Loses the atomic multi-row write: a crash between two files leaves a pane or conversation with two owners or none. Needs a journal. Rejected. |
| Stopped rows inside `registry.json` | Keeps atomicity, but every process-table write and every hook read would carry all history (13× today's bytes, growing). Rejected. |
| SQLite | Transactions and per-row writes, but brings a native module into the core and the hook, which the architecture keeps out (search runs in its own process for that reason). No user-visible gain now. Rejected. |
| One read API over both stores | Every consumer already compares by harness id, so a harness in both stores (live plus its own record) is handled correctly everywhere (`available()`, the search indexer's fresher-record rule, delete's `agentId !==` checks, `worktreeDeletion.ts:93`). A refactor with no bug behind it, in the busiest code. Not now. |

### The fix

For running harnesses the registry already enforces one owner per conversation: "The same engine session
cannot belong to two agents … The newest bind wins", and an agent left with no session and no process is
removed because it "can only sit in the list as a second row for the same work" (`registry.ts:1818`,
`register`'s `orphaned`). Stopped records were never held to that rule, which is the whole source of the 18
duplicated conversations. Every new binding — engine hook or process scan — lands in one place,
`handleRegistered` (`core/agents/bind.ts:88`), which already saves the binding harness's own record. There:

- a stopped record of **another** harness holding the same conversation (engine, Codex home, Hermes home,
  session id) is removed and the apps are told (`agent_deleted`), as the registry does for a live orphan;
- not when that harness is running (its record follows it on its next bind or stop), not while it has a resume
  in flight (its reservation), not for terminals, not for a record without a conversation;
- the conversation's name follows it (names are keyed by session id on purpose, `registry.ts:2488`), its
  transcript is untouched, and the new owner's row resumes it.

A one-time pass at start clears the duplicates that exist (newest binding wins; a running owner always wins),
backing up every removed record first. That also makes `session_get`'s lookup by conversation
deterministic (`core/transcripts/history.ts:130`) and lets delete erase a conversation's history again.

### Not now, with the numbers

The stopped store grows ~20 records a day. Measured on this Mac: listing 400 records takes 21 ms warm; at
4,000 it takes 144 ms, because the parse cache holds 2,048 (`stoppedAgents.ts:12`). That is about three months
away. Retention (or an index) is decided then, with the measurement, not now.
