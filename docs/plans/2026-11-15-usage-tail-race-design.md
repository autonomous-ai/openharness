# A superseded attach read no longer makes the next attach skip lines

## The problem

`e2e/usageProcess.e2e.ts`, "explicit inline usage follows the same aggregate boundary", sometimes waits 45 s for
`usage 120` and fails: runs 43672659842 (shard 2, 2026-11-15) and 42225258676 (shard 7, 2026-11-06). Both daemon logs
show the same five lines, a few milliseconds apart:

```
[discovery] bound codex session …
[hooks] … SessionStart · engine=codex · isNew=false
[agent] … read the transcript from its end · turn @0 · profile @0 · 199 bytes
[agent] … kept its live normalizer · the re-read was superseded while reading
[agent] … read the transcript from its end · turn @0 · profile @0 · 385 bytes
[watcher] tail codex … @385
```

What happens, read in the code on `be613c89a9` (`cli/src/core/transcripts/attach.ts`):

1. The bind's attach (the first for the session, so no tail exists and `watcher.hold` returns null) reads the
   transcript from its end up to byte X = 199 (`attachTranscript`, line 348).
2. While it reads, the session's runtime profile takes a write (any `accepted()` in `lib/runtimeProfileState.ts`,
   e.g. a pane capture handed to the profile). The staged hydration is no longer current, so `commitWith` fails and
   the attach returns through `keepLiveNormalizer('was superseded while reading')` (line 413). It installs no parser
   and no tail. There is no live normalizer to keep: this was the first attach.
3. The test appends its `token_count` line (bytes 199..385) right after the agent is bound.
4. The SessionStart hook's attach, queued behind the first by `AttachTracker`, finds no tail to hold, so its history
   has no end (`historyEnd()` is undefined). It folds the file to its end (385) silently, as history, and tails from
   385. The `token_count` line was folded as history and never delivered as a line, so `tokenUsage.changed`
   (`ingest.ts:54`) never fires and the usage stays unset.

The window is between the superseded read's end (X) and the next read's end. Every line written in it is lost from
the live stream, not only usage: a message, a tool call, a turn's end. Real users hit it the same way.

The engine-worker path has the same window, wider: a candidate superseded at install (line 402) also returns without
a tail and asks `remote.retry`, which re-attaches a second later; that attach has no end either and tails from the end
of the file then.

## The fix

An attach whose read reached byte X but left no tail for the session's transcript remembers X; the next attach of
that session folds history only up to X and tails from X, so every line after X is delivered live into the new
normalizer, as it would have been had the first attach not been superseded.

- `createAttach` keeps a map `sessionId → { transcriptPath, offset }` (the superseded read's end, `handover.next`).
  It is written in `keepLiveNormalizer` when the attach read the transcript (`handover.next !== null`), holds no tail
  (`handover.hold === null`) and the watcher does not tail that transcript for the session
  (`!watcher.tails(sessionId, transcriptPath)`), and the attach is not an interpretation-hold recovery (those use
  their own boundaries, `closes`) and is still the binding's (`current()`): an attach whose session was forgotten
  while it read leaves nothing, so the same conversation bound again under its id inherits no byte and no retry
  (`agents/forget.ts`).
- `historyEnd()` uses it after a held tail and before a relaunch mark:
  `closes ? undefined : relaunch?.engineStarted ? relaunch.offset : handover.hold?.offset ?? unreadFrom ?? relaunchedAt`.
  It is used only when the entry's `transcriptPath` is the session's current one; an entry for another path is
  dropped.
- The read then ends at X (`attachTranscript` and the worker both clamp `end` to the file's size), `fromEnd.next` is
  X, and the tail starts there (`addSession({ fromOffset: fromEnd.next })`, which already starts at the end of a file
  that shrank below it).
- The entry is dropped when an attach installs the session's tail (line 621), when a held tail is taken over, and in
  `forget`. At most one entry per session, so the map is bounded by the registry. In memory only: a daemon restart
  re-attaches from the file's end as today.
- Nothing else changes: an attach that holds a tail keeps its hold's offset as today; the re-attach path (a session
  that already has its normalizer) is unchanged.

- The map holds at most 256 entries: `forget` drops a session's entry, and a write that finds 256 clears the map
  first, as `openclawFolderReads` is cleared. Losing an entry costs only today's behavior for that session.

The core grows no new mechanism: this is the attach's own handover offset, kept across the two attaches that
the supersede split. No new file, no new import, nothing in `architecture.coreFiles.txt`.

- A read that ended before the attach failed for another reason is remembered too (PM, 2026-11-15): inline, a
  profile config read that throws after the transcript was read (`attach.ts:361`) returns before `handover.next` is
  set today; `handover.next = read.next` moves above that `try`, so the read's end is remembered. On the worker path
  (`:327`) only when `remote.prepare` returned a candidate before the failure (its cursor is the read's end); a
  `prepare` that threw read nothing known, and nothing is remembered.

## A superseded inline attach is tried again

On the inline path (no engine worker: `HARNESSD_SERVICES=none`, or an engine with no worker) an attach that returns
through `keepLiveNormalizer` with no tail for the session's transcript leaves the session with no tail at all, and
nothing tries again: the worker path asks `remote.retry`, the inline path asks nothing. Unless a hook happens to attach
the session afterwards, nothing it writes is streamed until its next attach. In both CI runs the SessionStart hook
was that later attach; without it the agent would have shown nothing (PM, 2026-11-15: fixed here, same window).

- When an inline attach returns through `keepLiveNormalizer` with a `transcriptPath`, no held tail, the watcher not
  tailing that transcript for the session, and no interpretation hold, `createAttach` schedules one retry of that
  session (`setTimeout`, unref'd), at most one pending per session.
- Bounded, with backoff: attempts 1 to 5 wait 1 s, 2 s, 4 s, 8 s and 16 s (about 31 s in all). The count is per
  session and resets when an attach installs the session's tail. After the fifth, it logs
  `[agent] <agent> transcript not tailed · its attach was superseded 5 times` and tries no more; the next attach from
  any caller (a hook, the reconcile) starts it again.
- The retry re-reads the row as it is then (`resolve(session.agentId)`) and runs only while it is the same binding
  (same `sessionId` and `transcriptPath`, `paneReadIdentity` unchanged, its `lifetimes` entry the same) and the
  watcher still does not tail that transcript; otherwise it does nothing, and the count goes with that binding, so the
  next binding's first superseded attach waits 1 s again. It calls `attachSession(latest, false,
  replayCursorFromStart, replayFromStart)` with the first attach's replay flags, so a first turn born after its agent
  is still replayed once. A plain attach joins one already in flight, so a retry and a hook's attach never fold twice.
- Its read ends at the remembered X (above), so the retry loses no line either.
- `forget` clears the session's timer and count.

## Usage is read again after an attach folds a transcript

A second window, found running the end-to-end test on a loaded Mac (6 of 6 runs failed, at the base and with the fix
above): a line written before the attach's first read is folded as history by that read, as everything on disk is.
Usage is not read from the fold; the core asks the usage service to read the transcript again only when a line is
delivered live (`tokenUsage.changed`, `ingest.ts:54`). An agent whose usage was first read before that line (the apps
list it as soon as it is bound) keeps the old value until its next live line. In the test that is null, for good.

- `createAttach` takes `tokenUsage: { changed(session: RegisteredSession): void }` (the same port `createIngest`
  takes, `main.ts:1883`), and calls it once at the end of an attach that folded transcript content
  (`lines.length || fromEnd?.content`, where `replayedFirstTurn` is marked), before it returns true. Not on the
  re-attach path, which folds nothing, and not on an attach that returns early.
- The usage link's own rate limit (`USAGE_REFRESH_MS`, 15 s, `core/usageLink.ts`) stays as it is: a session attached
  again and again schedules at most one read per 15 s, never one per attach.
- Rule 7 of `cli/AGENTS.md` (the core grows nothing for a component): an agent's token usage is the core's, for
  every engine; its port already exists in `core/api.ts` and `ingest.ts` calls it. This adds a caller, not a
  mechanism.
- With it, `e2e/usageProcess.e2e.ts` passes whichever side of the first read its line lands on, and the file is left
  unchanged.

## Failure cases

- The file was rewritten shorter than X before the next attach: the read clamps to the new size and the tail starts
  at its end, as without the fix.
- The next attach is itself superseded: it re-records its own end (≤ the old X when it read to X), so the attach after
  it still starts there.
- The session's transcript path changed (a new conversation): the entry does not apply and is dropped.

## Tests (red first)

- `cli/src/core/transcripts/attach.spec.ts`, local (inline) path, real `Watcher`: a first attach whose
  `commitWith` fails after its read reached X; a line appended after X; the next attach (reset) folds up to X only,
  tails from X, and the appended line is delivered live (a `line` event into the new parser). Fails today: the tail
  starts at the file's end.
- The same for the worker path: a candidate whose `remote.install` returns false; the retry's `remote.prepare` is
  called with `end: X`, and the tail starts at X.
- Inline retry: a first attach superseded with no later caller is attached again after 1 s (fake timers), reads to
  X, tails from X, and a line appended meanwhile is delivered live. Fails today: nothing tails the session. Also: at
  most 5 attempts with the backoff above and the log line after the fifth; no retry when a tail was installed
  meanwhile, when the binding changed, after `forget`, or for an interpretation-hold attach.
- The map is cleared at 256 entries.
- A config read that throws after the read (inline `:361`; worker `:327` with a candidate) remembers the read's end.
- Usage: an attach that folded content calls `tokenUsage.changed` once; the re-attach path and an attach that returns
  early do not. Fails today: attach has no such call.
- The entry is used once: after the second attach installs its tail, a third attach takes the held tail's offset.
  `forget` drops it; a different transcript path ignores it.
- `npm run test:core` stays at 100% per file.

## The end-to-end test

`e2e/usageProcess.e2e.ts` is left as it is: with both fixes, a usage line written after the first read is delivered
live, and one written before it is read again after the attach, so the test no longer depends on the timing.
Forcing the windows end to end would need a test fault inside the core, which the core rules do not allow for one
test; the unit tests above reproduce them deterministically. PR CI does not run `cli/e2e`: one run of
`.github/workflows/cli-e2e.yml` on the branch, on Linux, when the PM gives the runner turn.

## Platforms

All: the change is in the daemon core's attach, with no platform-specific code.
