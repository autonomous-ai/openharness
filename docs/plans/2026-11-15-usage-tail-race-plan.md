# A superseded attach read no longer makes the next attach skip lines: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **diegodev phase 3**. Three tasks, each test-first: a red commit (the
> tests alone), then the code commit. They run one after the other, 1, 2, 3: all three change
> `cli/src/core/transcripts/attach.ts` and `cli/src/core/transcripts/attach.spec.ts`. Task 3's red commit does not
> typecheck, by design: its Step 2 says what `tsc` prints there. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An attach whose read ended before it installed a tail no longer costs the lines written before the next
attach: that attach folds the transcript only to where the earlier read stopped and tails from there, so each line
reaches the live stream once. On the inline path a session left with no tail is attached again by itself, five times
at most. And an attach that folded a transcript asks for the agent's usage to be read again, so a usage record already
on disk at the first read is no longer missed.

**Architecture:** One file of product code, `cli/src/core/transcripts/attach.ts`, in the core's process, and one line
of wiring in `cli/src/core/main.ts`. `createAttach` keeps, per session, where a read stopped when its attach then left
no tail (`supersededReads`: the transcript's path and a byte). `keepLiveNormalizer` writes it, and so does the worker
path's `catch` when the worker had answered; `historyEnd()` reads it after a held tail's offset and before a relaunch
mark; every attach that starts or takes over the session's tail drops it, and so does `forget`. Task 2 adds the inline
path's retry (`supersededRetries`, `retrySuperseded`): a plain attach after 1, 2, 4, 8 and 16 seconds, one waiting per
session, fenced by the superseded attach's own `current()`. Task 3 gives `createAttach` the usage port `createIngest`
already takes (`tokenUsage.changed`) and calls it once at the end of an attach that folded transcript content.

**Tech Stack:** TypeScript, Vitest 4.1.10 (the real `Watcher` and real transcript reads over temporary files, a fake
engine worker, fake `setTimeout`/`clearTimeout` for the retry's rhythm), the CLI end-to-end harness and its GitHub
workflow. No new dependency, no new file, no new import.

**Spec:** [docs/plans/2026-11-15-usage-tail-race-design.md](2026-11-15-usage-tail-race-design.md). Read it with this
plan, the root `AGENTS.md`, `cli/AGENTS.md` and `cli/src/core/AGENTS.md`. The spec is the authority.

## Global Constraints

- Files. Tasks 1 and 2: `cli/src/core/transcripts/attach.ts` and `cli/src/core/transcripts/attach.spec.ts`, nothing
  else. Task 3: those two, `cli/src/core/main.ts` (one property and its comment in the `createAttach` call), and one
  property in each of the four other specs that build the real attach with typed dependencies
  (`cli/src/core/transcripts/attach.runtime.spec.ts`, `cli/src/core/transcripts/attach.control.spec.ts`,
  `cli/src/core/transcripts/openclaw.spec.ts`, `cli/src/engines/otherTranscripts.golden.spec.ts`).
- No new file, so `cli/src/architecture.coreFiles.txt` does not change (`core/transcripts/attach.ts` is its line 124).
  No new import. `AttachDeps` gains one member, `tokenUsage` (Task 3); what `createAttach` returns does not change.
- Not touched: `cli/e2e/usageProcess.e2e.ts` and everything under `cli/e2e/`, `cli/src/watcher/watcher.ts`,
  `cli/src/lib/attachTranscript.ts`, `cli/src/core/engines/liveSessions.ts`, `cli/src/core/usageLink.ts`,
  `cli/src/core/transcripts/ingest.ts`, `cli/src/lib/registry.admission.spec.ts` (it casts its dependencies and runs
  no attach), `cli/src/testing/transcriptOracle.ts` (it builds no attach). No test fault inside the core.
- Remembered when all of these hold: the attach read the transcript, it holds no tail (`handover.hold === null`), it
  is not an interpretation-hold recovery, the session has a `transcriptPath`, and
  `!watcher.tails(sessionId, transcriptPath)`. Two places write it: `keepLiveNormalizer`, with `handover.next`, and
  the worker path's `catch` (`attach.ts:327`) when `remote.prepare` had returned a candidate, with
  `prepared.page.cursor.offset`. A `prepare` that threw remembers nothing. What is kept:
  `{ transcriptPath, offset }`, one entry per session.
- Inline, `handover.next = read.next` is set above the `try` that reads the profile's config (`attach.ts:360`), so a
  config read that throws after the transcript was read is remembered through `keepLiveNormalizer` like the others.
- Used, verbatim from the spec:
  `closes ? undefined : relaunch?.engineStarted ? relaunch.offset : handover.hold?.offset ?? unreadFrom ?? relaunchedAt`.
  `unreadFrom` is the entry's offset only when the entry's `transcriptPath` is the session's current one; an entry
  for another path is dropped.
- Dropped: when an attach installs the session's tail or takes over a held one (the block at `attach.ts:612`), when
  an attach only makes sure the tail runs (`attach.ts:226`, Decision 6), in `forget`, and for another path.
- The map holds 256 entries at most: a write that finds 256 clears it first, as `openclawFolderReads` is cleared
  (`core/agents/bind.ts:138`). In memory only.
- The retry (Task 2), inline only (`!remote`): scheduled when an attach returns through `keepLiveNormalizer` with a
  `transcriptPath`, no held tail, the watcher not tailing that transcript for the session, and no interpretation
  hold. Whether the attach read the transcript plays no part. Waits: 1 s, 2 s, 4 s, 8 s, 16 s. One pending per
  session. The timer is unref'd.
- The retry runs only while the superseded attach's own `current()` holds and
  `!watcher.tails(sessionId, transcriptPath)`; otherwise it does nothing. It calls
  `attachSession(<the row as it is then>, false, replayCursorFromStart, replayFromStart)` with the superseded
  attach's two flags.
- After the fifth retry is superseded, one line, verbatim, with `console.warn`:
  `[agent] <agent> transcript not tailed · its attach was superseded 5 times`, `<agent>` as `sid(agentId)`. The count
  then starts over (Decision 5).
- The count and a waiting timer go when an attach starts or takes over the session's tail, when an attach makes sure
  the tail runs, and in `forget`.
- A retry whose attach rejects logs with `console.error`, verbatim:
  `[agent] <agent> attach retry failed: <message>` (Decision 8).
- Usage (Task 3): `AttachDeps.tokenUsage: { changed(session: RegisteredSession): void }`, the member `IngestDeps`
  has (`ingest.ts:28`). Called once, as the last statement before `attachSessionNow` returns true at its end, when
  `lines.length || fromEnd?.content`. Never on the re-attach path (`attach.ts:225`), and never on a return before the
  end. The usage link's limit (`USAGE_REFRESH_MS`, 15 s, `core/usageLink.ts`) is not changed.
- `attach.ts` stays at 100% statements, branches, functions and lines (`npm run test:core`). `main.ts` is outside
  that gate (`vitest.core.config.ts`); the typecheck and the end-to-end suite cover its line.
- No fixed sleeps: the tests wait on a condition, and move a fake clock for the retry's rhythm.
- Comments say why, in plain sentences, and name the incident: `e2e/usageProcess.e2e.ts`, "explicit inline usage
  follows the same aggregate boundary", CLI end to end runs 43672659842 (shard 2, 2026-11-15) and 42225258676
  (shard 7, 2026-11-06); for the usage, the same test on a loaded Mac, 6 runs of 6 (2026-11-15).
- A failing test is a product bug: fix it where the behavior lives. Never skip or loosen a test. If a step's expected
  output does not match, stop and report.
- A commit adds its files by name. The two documents under `docs/plans/` are untracked here and are no task's.
- Cost, as the pull request states it in place of before-and-after numbers: no new work on a hot path. One map
  lookup per attach that folds, one map delete per tail started. A timer exists only after an inline attach left no
  tail: one per session at most, five in a row at most, then none. One call to the usage link per attach that folded
  content; the link turns any number of them into one read of that session's usage per 15 s, as it does for live
  lines. No new read, poll or process.
- Platforms: macOS, Linux and Windows; core logic only, the same on each. Tested on macOS (the developer Mac) and
  Linux (PR CI's unit suite, and one run of the CLI end-to-end workflow). One pull request; its body names the
  platforms and where each was tested, and carries each task's red and green output, the `harness-local-checks`
  fence and the end-to-end results.

## Found while reading the code

Checked at `be613c89a9`. All three tasks were rehearsed in a copy of `cli/` outside this worktree; nothing here was
changed, and the copy was removed after.

- **Baseline.** `cd cli && npx vitest run src/core/transcripts/attach.spec.ts`: `Tests  127 passed (127)`. The four
  specs that cover `attach.ts` (`attach.spec.ts`, `attach.runtime.spec.ts`, `attach.control.spec.ts`,
  `openclaw.spec.ts`): 178 tests, and `attach.ts` at 100% under the gate's config (520 statements, 435 branches, 92
  functions, 396 lines). This worktree has `cli/node_modules`.
- **Rehearsed**, from this plan's own code blocks, each task on the one before. Task 1: Step 1 alone,
  `9 failed | 135 passed (144)`; with Step 4, 144 pass and `attach.ts` is at 100% (538 statements, 452 branches, 94
  functions, 410 lines). Task 2: Step 1 alone, `9 failed | 146 passed (155)`, each of the nine failing at once on the
  timer count, none by timing out; with Step 4, 155 pass, three runs in a row, and `attach.ts` is at 100% (565, 466,
  98, 433). Task 3: Step 1 alone, `3 failed | 159 passed (162)`; with Step 4, 162 pass and `attach.ts` is at 100%
  (567, 470, 98, 434). The typecheck is clean at each step but Task 3's red commit (below). The whole
  `npm run test:core` on the final code: 248 files, 4222 tests, 100% everywhere, 3 min 4 s on this Mac while it
  carried other work.
- **Wrong versions fail.** Of Task 1 as first drafted, fourteen (no drop at the tail's install, in the re-attach
  path, in `forget`; another path ignored but kept; the entry before a held tail, after a relaunch mark, before a
  started engine; no cap, a cap off by one; remembered though tailed, in a recovery, with a hold; never remembered),
  and of what the PM's answer added, four (the worker's `catch` remembering with a hold or in a recovery, or a byte
  other than the candidate's cursor; `keepLiveNormalizer` without the hold check). Of Task 2, twenty (a reset attach,
  no flags, no binding fence, no tail fence, several pending, four or six attempts, the count kept after giving up,
  a constant or linear wait, the timer or the count kept on a tail, `forget` or the re-attach path or the install
  keeping the retry, the worker retried too, a retry with a hold or in a recovery, either log at another level). Of
  Task 3, eight (asked for every attach, on the re-attach path, before the profile's commit, where the tail is
  started, under `replayedFirstTurn`'s condition, for `fromEnd?.content` alone, for `lines.length` alone, twice).
  Each failed at least one of the new tests.
- **Four returns are remembered:** `attach.ts:402` (the worker's candidate refused at install, or its profile
  commit), `:413` (the inline `commitWith`), `:361` (the inline profile config, once `handover.next` is set above
  it) and the worker's `catch` at `:327` when the worker had answered. Every other `keepLiveNormalizer` call holds a
  tail, has not read yet (`:357`), folds an engine that is not read from its end (`:537`, agy), or is an
  interpretation recovery (`:633` to `:643`).
- **The worker's `catch` does not go through `keepLiveNormalizer` without a hold** (`:330` returns true), and a
  call there would log a kept normalizer that does not exist and ask `remote.retry` twice after a relaunch. So the
  condition and the write are two small functions of `attachSessionNow`, `leavesNoTail` and `rememberRead`, which
  both places call. `watcher.tails` is still asked once per return.
- **Moving `handover.next = read.next` above the config read changes nothing else.** Between the two places there
  is only the `try`, whose `catch` returns through `keepLiveNormalizer`, which releases a held tail itself and sets
  `handover.next` back to null, as today.
- **The worker's tail starts where its read ended, whatever `fromOffset` says.** For an engine a worker handles,
  `watcher.addSession` ignores `fromOffset` and follows the stream from the candidate's cursor
  (`core/engines/liveWatcher.ts:43`), which `remote.prepare(…, { end: X })` leaves at X. So the worker test's red
  assertion is the `end` asked of `prepare`.
- **X never splits a record.** `attachTranscript` clamps `end` to the file's size (`lib/attachTranscript.ts:130`) and
  answers `next` just past the last whole record, so a record the engine was still writing when the first read ended
  is the tail's, whole. `Watcher.addSession` starts at the file's end when `fromOffset` is past it
  (`watcher/watcher.ts:141`).
- **`current()` is the whole fence the spec lists for the retry.** It is the attach's lifetime in `lifetimes` and its
  `paneReadIdentity` (`attach.ts:731`), and `paneReadIdentity` names the agent, the `sessionId`, the engine, the
  `transcriptPath`, `boundAt`, the process, an identity hold, the evidence revision and the pane's routes
  (`core/transcripts/readIdentity.ts`). An interpretation hold raises the evidence revision, so a session that got
  one is no longer current. A plain attach joins one in flight only under the same identity
  (`lib/attachTracker.ts:73`), which the fence gives it.
- **A stale entry would be replayed by a recovery.** A session can have a parser and no tail (attached before its
  transcript was announced). A reset superseded then is remembered, and the next plain attach takes the re-attach
  path (`attach.ts:225`), which starts the tail itself. Left there, the entry would be read by a later
  interpretation recovery with no cuts, which removes the tail first (`:759`) and so holds none: it would fold only
  to the old byte and deliver everything after it live a second time. Hence Decision 6.
- **A retry after a superseded reset of a session that has its parser** takes that same re-attach path: it only
  makes sure the tail runs. The spec leaves that path as it is.
- **Four existing cases now start a retry:** `does not close or replay agy history after %s supersedes its capture`
  (`attach.spec.ts:973`), for `binding`, `forgotten`, `later binding` and `later normalizer` (since the final
  review's fence, Decision 7, only the two whose binding is unchanged start one), return through
  `keepLiveNormalizer('changed binding while its pane was read')` inline, with a transcript and no tail. Task 2 ends
  that test with `run.attach.forget(s.sessionId)`, as the recovery tests end theirs. No other existing test starts
  one: checked with a marker on the schedule across the six specs that build the real attach.
- **`vi.waitFor` moves a fake clock** by its interval at each look. The retry tests wait on `setImmediate` turns
  instead (`until`), which let a real file read finish while the fake clock stands still, so each wait is measured
  from where the retry before it ended.
- **Who builds the attach.** `core/main.ts:1347`, and six specs: `attach.spec.ts:143` (`setup`),
  `attach.runtime.spec.ts:37`, `attach.control.spec.ts:48`, `openclaw.spec.ts:101`,
  `engines/otherTranscripts.golden.spec.ts:237` and `lib/registry.admission.spec.ts:761`. The last casts two members
  to `AttachDeps` and runs no attach, so it needs nothing. `src/testing/transcriptOracle.ts` builds none.
- **`usageLink` is made after the attach in `runForeground`** (`main.ts:1611`, the attach at `:1347`), with no
  `await` between them, so the wiring is a closure read when an attach ends, as `questionWatcher` and `settled`
  beside it are (`main.ts:1363`, `:1371`), and as the ingest's and the funnel's own are (`:2418`, `:1883`).
- **What the link does with the call.** `port.changed` (`core/usageLink.ts`) reads at once when the session's usage
  was last read 15 s ago or more, or was never asked for; otherwise it sets one timer for the rest of the 15 s and
  ignores further calls until it fires (`usageLink.spec.ts`, `coalesces bursts into one bounded delayed read, …`).
  An engine it does not read (it takes Claude Code, Codex and OpenCode) is dropped there. So in
  `e2e/usageProcess.e2e.ts` a usage line folded as history is read within about 15 s of the attach, inside the
  test's 45 s.
- **Task 3's red commit does not typecheck,** and cannot: its tests name a member `AttachDeps` does not have yet.
  `npx tsc --noEmit` reports six errors there, each about `tokenUsage` (TS2353 five times, TS2339 once), and nothing
  else; Vitest does not typecheck, so the three new tests fail on their assertions. The code commit clears all six.
- **PR CI does not run `cli/e2e`.** `.github/workflows/cli-e2e.yml` runs nightly and by hand from a branch, the
  whole suite in eight shards, never one file (`docs/validation-and-release.md`, "What PR CI does not run").
- **`e2e/usageProcess.e2e.ts` on this Mac.** Before Task 3 existed, "explicit inline usage follows the same
  aggregate boundary" was run six times here (two at the base, four with Tasks 1 and 2): `usage 120` timed out every
  time, and "a new core receives an unchanged warm worker snapshot" failed the same way in both whole-file runs. The
  cause was the second window, now in the spec: the test writes its line as soon as `registry.json` names the
  transcript, and here the session's first read came 250 to 450 ms after it was bound (the Mac's one-minute load
  average was 14 to 22 on 10 cores), so the line was already in the file at that first read and was folded as
  history. In the two CI runs the first read came first (199 bytes) and the line fell between the two reads.
  With all three tasks the file was run here three more times, from a bundle with the process-image helper, as CI's
  flow is: `Tests  3 passed (3)` each time, in 91 to 98 s, at a one-minute load average of 12 to 17. A fourth run,
  on Tasks 1 and 2 alone, failed the same two tests on `usage 120` (`2 failed | 1 passed (3)`). So on this Mac Task 3
  is what turns the file green, and Task 1 is what the two CI runs needed.
- **Required local check for these paths** (`python3 scripts/local-checks.py --list …`, with Task 3's files):
  `cli-core` (`npm run test:core`) only. PR CI does not run it.

## Decisions

From the PM, approving the spec (2026-11-15):

1. The fix as the spec words it, for both paths: the inline one (`attach.ts:413`) and the engine worker's (`:402`,
   whose next attach is `remote.retry`'s).
2. In the same pull request, the inline retry, with a red test of its own.
3. `e2e/usageProcess.e2e.ts` is left unchanged, with no test fault in the core.
4. One task per fix, in a chain: the remembered offset, then the retry, then the usage (Decision 13). Each depends
   on the one before because they share `attach.ts` and `attach.spec.ts`.

Read from the spec's own words, and pinned by a test each:

5. Once the fifth retry is superseded the line is logged and the count starts over: "the next attach from any
   caller (a hook, the reconcile) starts it again" (`five times at most, …, and starts over with the next attach`).
6. "Dropped on tail install" covers every attach that starts the tail, the re-attach path's `addSession` at
   `attach.ts:228` included, not only line 621 (`forgets it when an attach only makes sure the tail runs`). That path
   itself is unchanged.
7. The retry's condition is the spec's, whatever reason the attach gave `keepLiveNormalizer`. So agy's
   `changed binding while its pane was read` schedules one too while the attach is still the binding's. Changed in
   the final review: an attach no longer the binding's (`current()` false) remembers no byte and schedules no retry,
   since one whose session was forgotten while it read its profile left both behind for the same id bound again
   (`remembers nothing, and tries nothing again, for a read whose session was forgotten while its profile was read`).

From the shape of the change:

8. A retry whose attach rejects is logged with `console.error`, in the words of the reader retry beside it
   (`attach.ts:210`), and is not tried again: a rejected attach was not superseded.
9. A retry that finds the binding changed, or the transcript tailed, does nothing, and drops the session's count.
   Changed in the final review: the count kept for the next binding made its first superseded attach wait two
   seconds, or, after a fifth retry that found the session bound anew, give up without trying, against the spec's
   "the next attach from any caller starts it again" (`counts from one second again for the session bound anew while
   its retry waited`). Its retry still waiting is replaced, not joined, by a superseded attach of another binding:
   joined, it did nothing when due and that attach was never tried again (`tries again the attach of the session
   bound anew, superseded while the earlier binding's retry waited`).
10. The line after the fifth retry is a `console.warn`, as `keepLiveNormalizer`'s own line is.
11. `retrySuperseded` is handed the superseded attach's `current` and `transcriptPath` as arguments, so it reads
    nothing of an attach but what it is given.
12. `attach.runtime.spec.ts` needs no new case: its superseded and failed cases hold a tail, so nothing is
    remembered and nothing is retried there. Task 3 adds only the `tokenUsage` member to its construction.

From the PM, answering the first draft's two questions (2026-11-15):

13. The usage is read again after an attach that folded transcript content: Task 3, red test first, after Task 2
    because it changes the same two files. The usage link's 15 s limit stays. One run of
    `.github/workflows/cli-e2e.yml` on the branch, on Linux, once the PM gives the runner turn; the local runs of
    `e2e/usageProcess.e2e.ts` stay as a comparison and are now expected to pass.
14. A read that ended before the attach failed for another reason is remembered too, in Task 1: inline, a profile
    config read that throws (`attach.ts:361`); on the worker path (`:327`) only when `remote.prepare` had returned a
    candidate, with its cursor's offset. A `prepare` that threw remembers nothing.

Added with those answers, the first from the spec's words and the rest from the shape of the change:

15. "An attach that returns early" is every return before the end of `attachSessionNow`: a pane that is gone, a read
    superseded or failed, and a binding that changed after the fold (`does not ask for an attach that returns early`).
    A superseded attach asks nothing; the attach that follows it (the retry, a hook's) folds and asks.
16. The usage call is the last statement before the final `return true`. Its condition is the one
    `replayedFirstTurn` is marked under (`attach.ts:657`) without `replayLive`. The spec names both places in one
    sentence; nothing returns or waits between them, so the two read the same.
17. The call passes the attach's own `session`: the row it attached, still the binding at that point (`current()`
    held at `attach.ts:631`, and nothing is awaited after it). The link copies the fields it keys on.
18. `tokenUsage` is required in `AttachDeps`, as it is in `IngestDeps`: no optional member for a choice the product
    has made. So every typed construction of the attach gains it in Task 3's red commit.
19. The worker's `catch` writes the entry itself (`leavesNoTail`, `rememberRead`) and is otherwise as it was: it
    still returns true with no hold, logs nothing new and asks `remote.retry` once.

## Open questions

None. The first draft's two are answered (Decisions 13 and 14).

## Review Focus

Each line names the test that pins it.

1. A record the engine was still writing when the superseded read ended is delivered once, whole, by the tail
   (Task 1, `folds the next attach only to where that read stopped, …: a record half written by then`).
2. A transcript rewritten shorter than the remembered byte: the read clamps to the new size and the tail starts at
   its end, with nothing thrown (Task 1, `starts the tail at the new end of a transcript rewritten shorter since`).
3. An entry that outlived a tail started by the re-attach path would make a later recovery deliver old lines again
   (Task 1, `forgets it when an attach only makes sure the tail runs`).
4. A retry that comes due while a hook's attach is reading joins it and folds nothing twice (Task 2,
   `one at a time for a session, and it joins an attach already reading`).
5. A session forgotten, or bound again, while its retry waits is never attached by it (Task 2,
   `never once the session is %s`).
6. A usage record already in the transcript at a session's first read is asked for once, by that attach, and a
   session attached again with nothing new to fold asks nothing (Task 3,
   `asks once for each attach that folded what a %s transcript held, …`). A session reset again and again, as Claude
   Code does when it compacts, costs one usage read per 15 s: the link's own test,
   `coalesces bursts into one bounded delayed read, …` (`core/usageLink.spec.ts`), which no task changes.
7. By eye: the retry timer's `unref()`; the comments name the runs; `replayCursorFromStart` is passed on as the spec
   says, though no Cursor attach returns through `keepLiveNormalizer`; the worker's `catch` still discards its
   candidate and asks `remote.retry` once; `main.ts` gains one property and its comment, and `usageLink.ts` and
   `ingest.ts` no line; no line of the engines' branches is in the diff; no existing test changed but the one
   `forget` line in Task 2 and the `tokenUsage` member in Task 3.

---

### Task 1: The next attach folds to where a superseded read stopped, and tails from there

**Depends on:** nothing. **Effort:** xhigh (the daemon core; the order of two reads of one transcript).

**Files:**
- Modify: `cli/src/core/transcripts/attach.ts` (after line 95; `forget`, line 115; the re-attach path, line 227;
  above `keepLiveNormalizer`, line 302, and in it, line 307; `historyEnd`, lines 313-315; the worker path's `catch`,
  line 328; the inline config read, lines 360-363; the tail's install, line 613)
- Test (must fail before the change): `cli/src/core/transcripts/attach.spec.ts` (a new `describe` before line 1112)

Every line number in this task is the base's (`be613c89a9`), before any edit of the task.

**Interfaces:**
- Consumes: `watcher.tails(sessionId: string, transcriptPath: string): boolean`, already in `AttachDeps['watcher']`;
  `handover: { hold: TailHold | null; next: number | null }`, already `attachSessionNow`'s.
- Produces, for Task 2. In `createAttach`: `supersededReads: Map<string, { transcriptPath: string; offset: number }>`.
  In `attachSessionNow`: `leavesNoTail(): boolean` and `rememberRead(offset: number): void`. In the spec, inside
  `describe('after a read that was superseded before it installed a tail')`: `ANSWER`, `supersede(run)`,
  `askedEnd(p)` and `unreadable`.

- [ ] **Step 1: Write the tests in `cli/src/core/transcripts/attach.spec.ts`**

Add this block as the last one of `describe('attaching a session')`, after `says when an attach is slow` (before the
closing `})` on line 1112). It uses the file's own `setup`, `remoteSetup`, `session`, `transcript`, `CLAUDE_PROMPT`
and imports; nothing is added to the imports.

```ts
  // The bind's attach read a new Codex rollout to byte 199 and was superseded by a write to the runtime profile before
  // it installed anything. The SessionStart hook's attach then folded the file to byte 385 and tailed from there, so the
  // `token_count` line written between the two reached nobody (e2e/usageProcess.e2e.ts, "explicit inline usage follows
  // the same aggregate boundary", CLI end to end runs 43672659842 shard 2 and 42225258676 shard 7).
  describe('after a read that was superseded before it installed a tail', () => {
    const ANSWER = { type: 'assistant', message: { id: 'usage-1', role: 'assistant', content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } } }
    /** The next inline attach reads its transcript, then finds its profile hydration no longer current. */
    const supersede = (run: ReturnType<typeof setup>) =>
      vi.mocked(run.deps.runtimeProfiles.beginHydrate).mockReturnValueOnce({ ...run.profile, commitWith: () => false })
    /** What the worker was last asked to read up to. */
    const askedEnd = (p: ReturnType<typeof remoteSetup>) => vi.mocked(p.remote.prepare).mock.lastCall![1].end
    /** A profile config read that fails once the transcript was read. */
    const unreadable = async (): Promise<void> => { throw new Error('unreadable') }

    it.each(['whole', 'half written'] as const)('folds the next attach only to where that read stopped, and delivers what was written since as live lines: a record %s by then', async written => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const watcher = new Watcher(), add = vi.spyOn(watcher, 'addSession')
      const run = setup({ watcher })
      const file = transcript([CLAUDE_PROMPT]), row = session('claude', file), read = statSync(file).size
      const answer = JSON.stringify(ANSWER) + '\n'
      // The engine was in the middle of its answer when the first read ended: that record is the tail's, whole.
      if (written === 'half written') appendFileSync(file, answer.slice(0, 40))
      const emit = vi.fn(), usage = vi.fn()
      createIngest({ liveFor, has: () => true, bySession: () => row, device: () => undefined,
        runtimeProfiles: { ingest: vi.fn() }, tokenUsage: { changed: usage }, normalizers: run.normalizers,
        announceTurnAborted: vi.fn(), emit, attachSession: run.attach.attachSession }).wireWatcher(watcher)
      try {
        supersede(run)
        expect(await run.attach.attachSession(row)).toBe(true)
        expect(add).not.toHaveBeenCalled()
        expect(run.normalizers.hasState(row.sessionId)).toBe(false)
        appendFileSync(file, written === 'whole' ? answer : answer.slice(40))
        // The SessionStart hook's attach, queued behind the bind's.
        expect(await run.attach.attachSession(row, true)).toBe(true)
        expect(add).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: row.sessionId }), { fromOffset: read })
        expect(log.mock.calls.map(([line]) => String(line)).filter(line => line.includes('read the transcript from its end'))).toEqual([
          expect.stringContaining(`· ${written === 'whole' ? read : read + 40} bytes`), expect.stringContaining(`· ${read} bytes`)])
        // History ends at the prompt: its turn is open, and nothing after it was folded.
        expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith(row.sessionId, [expect.objectContaining({ type: 'turn_started' })], { resumed: true })
        expect(usage).not.toHaveBeenCalled()
        await watcher.pollSession(row.sessionId)
        expect(usage).toHaveBeenCalledExactlyOnceWith(row)
        expect(emit).toHaveBeenCalledExactlyOnceWith(row.sessionId, expect.arrayContaining([expect.objectContaining({ type: 'turn_ended' })]))
        expect(run.normalizers.sessionTurnOpen(row.sessionId)).toBe(false)
      } finally { await watcher.stop() }
    })

    it('starts the tail at the new end of a transcript rewritten shorter since', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const run = setup()
      const file = transcript([CLAUDE_PROMPT, ANSWER]), row = session('claude', file)
      supersede(run)
      await run.attach.attachSession(row)
      writeFileSync(file, JSON.stringify(CLAUDE_PROMPT) + '\n')
      expect(await run.attach.attachSession(row, true)).toBe(true)
      expect(run.deps.watcher.addSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: row.sessionId }), { fromOffset: statSync(file).size })
      expect(run.normalizers.sessionTurnOpen(row.sessionId)).toBe(true)
    })

    it('asks the engine worker to read only that far when its candidate was superseded at install', async () => {
      const p = remoteSetup(), s = session('claude', '/private/transcript')
      vi.mocked(p.remote.install).mockReturnValueOnce(false)
      expect(await p.attach.attachSession(s)).toBe(true)
      expect(p.remote.retry).toHaveBeenCalledWith(s)
      expect(p.deps.watcher.addSession).not.toHaveBeenCalled()
      // The engine link's retry: a reset attach a second later (core/engines/liveSessions.ts `retry`).
      expect(await p.attach.attachSession(s, true)).toBe(true)
      expect(p.remote.prepare).toHaveBeenLastCalledWith(s, { live: false, end: 20 }, expect.any(Function), undefined)
      expect(p.deps.watcher.addSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: s.sessionId }), { fromOffset: 20 })
      expect(p.normalizers.liveParsers.get(s.sessionId)).toBe(p.handle)
    })

    it('uses what it remembered once: the attach after a tail is installed reads to the end again', async () => {
      const p = remoteSetup(), s = session('claude', '/private/transcript')
      vi.mocked(p.remote.install).mockReturnValueOnce(false)
      await p.attach.attachSession(s)
      await p.attach.attachSession(s, true)
      expect(askedEnd(p)).toBe(20)
      await p.attach.attachSession(s, true)
      expect(askedEnd(p)).toBeUndefined()
    })

    it('remembers a second superseded read\'s own end', async () => {
      const p = remoteSetup(), s = session('claude', '/private/transcript')
      vi.mocked(p.remote.install).mockReturnValueOnce(false).mockReturnValueOnce(false)
      await p.attach.attachSession(s)
      vi.mocked(p.remote.prepare).mockResolvedValueOnce({ ...p.candidate, page: { cursor: { offset: 16 }, lastStarted: null } } as unknown as PreparedLive)
      await p.attach.attachSession(s, true)
      expect(askedEnd(p)).toBe(20)
      await p.attach.attachSession(s, true)
      expect(askedEnd(p)).toBe(16)
    })

    it('reads to a held tail\'s offset first, and forgets what it remembered once it takes that tail over', async () => {
      const p = remoteSetup(), s = session('claude', '/private/transcript')
      vi.mocked(p.remote.install).mockReturnValueOnce(false)
      await p.attach.attachSession(s)
      const hold: TailHold = { offset: 12, expired: false, release: vi.fn() }
      vi.mocked(p.deps.watcher.hold).mockResolvedValueOnce(hold)
      vi.mocked(p.deps.watcher.tails).mockReturnValueOnce(true)
      await p.attach.attachSession(s, true)
      expect(askedEnd(p)).toBe(12)
      expect(p.deps.watcher.addSession).not.toHaveBeenCalled()
      await p.attach.attachSession(s, true)
      expect(askedEnd(p)).toBeUndefined()
    })

    it.each([false, true])('reads to it before a relaunch mark, unless a new engine was started on the conversation: %s', async restarted => {
      const marks = createRelaunchMarks()
      const p = remoteSetup(false, { relaunchMarks: marks }), s = session('claude', '/private/transcript')
      vi.mocked(p.remote.install).mockReturnValueOnce(false)
      await p.attach.attachSession(s)
      marks.note(s.sessionId, 30, restarted)
      await p.attach.attachSession(s, true)
      expect(askedEnd(p)).toBe(restarted ? 30 : 20)
    })

    it('forgets it with the session', async () => {
      const p = remoteSetup(), s = session('claude', '/private/transcript')
      vi.mocked(p.remote.install).mockReturnValueOnce(false)
      await p.attach.attachSession(s)
      p.attach.forget(s.sessionId)
      await p.attach.attachSession(s, true)
      expect(askedEnd(p)).toBeUndefined()
    })

    it('drops it for a conversation whose transcript is another file now', async () => {
      const p = remoteSetup(), s = session('claude', '/private/transcript')
      vi.mocked(p.remote.install).mockReturnValueOnce(false)
      await p.attach.attachSession(s)
      // An attach of the other file that reads nothing and installs nothing.
      vi.mocked(p.remote.prepare).mockRejectedValueOnce(new Error('ENGINE_UNAVAILABLE'))
      await p.attach.attachSession(session('claude', '/private/another'), true)
      await p.attach.attachSession(session('claude', '/private/transcript'), true)
      expect(vi.mocked(p.remote.prepare).mock.calls.map(call => call[1].end)).toEqual([undefined, undefined, undefined])
    })

    it('remembers nothing for a tail the session already has or held, a session with no transcript, or an interpretation recovery', async () => {
      const tailed = remoteSetup(), s = session('claude', '/private/transcript')
      vi.mocked(tailed.remote.install).mockReturnValueOnce(false)
      vi.mocked(tailed.deps.watcher.tails).mockReturnValueOnce(true)
      await tailed.attach.attachSession(s)
      await tailed.attach.attachSession(s, true)
      expect(askedEnd(tailed)).toBeUndefined()
      // A tail it held, gone by the time its candidate was refused: where delivery stopped is not where this read did.
      const gone = remoteSetup()
      vi.mocked(gone.remote.install).mockReturnValueOnce(false)
      vi.mocked(gone.deps.watcher.hold).mockResolvedValueOnce({ offset: 12, expired: false, release: vi.fn() })
      await gone.attach.attachSession(s, true)
      await gone.attach.attachSession(s, true)
      expect(askedEnd(gone)).toBeUndefined()
      const pathless = remoteSetup(), unannounced = session('claude')
      vi.mocked(pathless.remote.install).mockReturnValueOnce(false)
      await pathless.attach.attachSession(unannounced)
      await pathless.attach.attachSession(unannounced, true)
      expect(askedEnd(pathless)).toBeUndefined()
      const recovery = remoteSetup(), held = session('claude', '/private/transcript', { evidenceRevision: 2, interpretationHold: 'pending' })
      vi.mocked(recovery.remote.install).mockReturnValueOnce(false)
      await recovery.attach.attachSession(held)
      expect(held.interpretationHold).toContain('superseded while reading')
      vi.mocked(recovery.remote.prepare).mockClear()
      await recovery.attach.attachSession(held)
      expect(askedEnd(recovery)).toBeUndefined()
      recovery.attach.forget(held.sessionId)
    })

    it('forgets it when an attach only makes sure the tail runs', async () => {
      const p = remoteSetup(), s = session('claude', '/private/transcript')
      // A parser from before its transcript was announced, and no tail yet.
      p.normalizers.liveParsers.set(s.sessionId, { ...p.handle })
      vi.mocked(p.remote.install).mockReturnValueOnce(false)
      await p.attach.attachSession(s, true)
      await p.attach.attachSession(s)
      expect(p.deps.watcher.addSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: s.sessionId }), { fromStart: false })
      await p.attach.attachSession(s, true)
      expect(askedEnd(p)).toBeUndefined()
    })

    it('remembers where a read stopped whose runtime profile could not be read afterwards', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const run = setup()
      const file = transcript([CLAUDE_PROMPT]), row = session('claude', file), read = statSync(file).size
      vi.mocked(run.deps.runtimeProfiles.beginHydrate).mockReturnValueOnce({ ...run.profile, config: unreadable })
      expect(await run.attach.attachSession(row)).toBe(true)
      expect(run.deps.watcher.addSession).not.toHaveBeenCalled()
      appendFileSync(file, JSON.stringify(ANSWER) + '\n')
      expect(await run.attach.attachSession(row, true)).toBe(true)
      expect(run.deps.watcher.addSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: row.sessionId }), { fromOffset: read })
    })

    it('remembers where the engine worker read to when the runtime profile could not be read afterwards', async () => {
      const p = remoteSetup(), s = session('claude', '/private/transcript')
      vi.mocked(p.deps.runtimeProfiles.beginHydrate).mockReturnValueOnce({ ...p.profile, config: unreadable })
      expect(await p.attach.attachSession(s)).toBe(true)
      expect(p.remote.discard).toHaveBeenCalledExactlyOnceWith(p.candidate)
      expect(p.remote.retry).toHaveBeenCalledExactlyOnceWith(s)
      expect(p.deps.watcher.addSession).not.toHaveBeenCalled()
      await p.attach.attachSession(s, true)
      expect(askedEnd(p)).toBe(20)
    })

    it('remembers nothing of an engine worker that could not be reached, or of a failed profile read that held a tail or was a recovery', async () => {
      const unreached = remoteSetup(), s = session('claude', '/private/transcript')
      vi.mocked(unreached.remote.prepare).mockRejectedValueOnce(new Error('ENGINE_UNAVAILABLE'))
      expect(await unreached.attach.attachSession(s)).toBe(true)
      expect(unreached.remote.discard).not.toHaveBeenCalled()
      await unreached.attach.attachSession(s, true)
      expect(askedEnd(unreached)).toBeUndefined()
      const held = remoteSetup()
      vi.mocked(held.deps.runtimeProfiles.beginHydrate).mockReturnValueOnce({ ...held.profile, config: unreadable })
      vi.mocked(held.deps.watcher.hold).mockResolvedValueOnce({ offset: 12, expired: false, release: vi.fn() })
      await held.attach.attachSession(s, true)
      await held.attach.attachSession(s, true)
      expect(askedEnd(held)).toBeUndefined()
      const recovery = remoteSetup(), pending = session('claude', '/private/transcript', { evidenceRevision: 2, interpretationHold: 'pending' })
      vi.mocked(recovery.deps.runtimeProfiles.beginHydrate).mockReturnValueOnce({ ...recovery.profile, config: unreadable })
      await recovery.attach.attachSession(pending)
      await recovery.attach.attachSession(pending)
      expect(askedEnd(recovery)).toBeUndefined()
      recovery.attach.forget(pending.sessionId)
      // Inline, a tail it held: the hold's offset is where delivery stopped, and the tail goes on from there.
      const inline = setup(), file = transcript([CLAUDE_PROMPT]), row = session('claude', file)
      vi.mocked(inline.deps.runtimeProfiles.beginHydrate).mockReturnValueOnce({ ...inline.profile, config: unreadable })
      vi.mocked(inline.deps.watcher.hold).mockResolvedValueOnce({ offset: statSync(file).size, expired: false, release: vi.fn() })
      await inline.attach.attachSession(row, true)
      appendFileSync(file, JSON.stringify(ANSWER) + '\n')
      await inline.attach.attachSession(row, true)
      expect(inline.deps.watcher.addSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: row.sessionId }), { fromOffset: statSync(file).size })
    })

    it('remembers 256 reads at most: one more starts over', async () => {
      const p = remoteSetup()
      vi.mocked(p.remote.install).mockReturnValue(false)
      const rows = Array.from({ length: 257 }, (_, at) => session('claude', '/private/transcript', { agentId: `agent-${at}`, sessionId: `session-${at}` }))
      for (const row of rows) await p.attach.attachSession(row)
      vi.mocked(p.remote.install).mockReturnValue(true)
      await p.attach.attachSession(rows[0]!, true)
      expect(askedEnd(p)).toBeUndefined()
      await p.attach.attachSession(rows[256]!, true)
      expect(askedEnd(p)).toBe(20)
    })
  })
```

- [ ] **Step 2: Run the spec and see it fail**

From `cli/`:

```bash
npx vitest run src/core/transcripts/attach.spec.ts
npx tsc --noEmit
```

Expected: `Tests  9 failed | 135 passed (144)`, and `tsc` prints nothing. The nine:

- `folds the next attach only to where that read stopped, …` (both cases): `expected "addSession" to be called once
  with arguments`, the tail starting at the file's end instead of the read's
- `asks the engine worker to read only that far when its candidate was superseded at install`: the last `prepare`
  was asked `end: undefined`
- `uses what it remembered once: …`, `remembers a second superseded read's own end`,
  `remembers where the engine worker read to when the runtime profile could not be read afterwards`,
  `remembers 256 reads at most: one more starts over`: `expected undefined to be 20`
- `reads to it before a relaunch mark, …: false`: `expected 30 to be 20`
- `remembers where a read stopped whose runtime profile could not be read afterwards`:
  `expected "vi.fn()" to be called once with arguments`, the tail starting at the file's end

The other eight new cases pass already: they pin what must not be remembered, and what happens to a transcript
rewritten shorter, which is the same without the fix. Each fails against a version that remembers too much (Found
while reading the code, Wrong versions fail). All 127 existing tests pass.

- [ ] **Step 3: Commit the red tests**

```bash
git add cli/src/core/transcripts/attach.spec.ts
git commit -m "Core: tests for where a superseded attach read stopped, which the next attach folds to and tails from"
```

- [ ] **Step 4: Remember the read in `cli/src/core/transcripts/attach.ts`**

Nine edits.

**(a)** In `createAttach`, after `recoveryRetries` (line 95):

```ts
  /**
   * Where an attach read a session's transcript to, when it then installed no tail for it: its hydration was
   * superseded by a write to the runtime profile, the engine worker refused its candidate, or its profile's config
   * could not be read. The next attach found no tail to hold, so its history had no end: it folded the file to its
   * end, silently, and tailed from there, and every line written between the two reads reached nobody. A new Codex
   * agent's first `token_count` went that way, read to byte 199 by the bind's attach and folded to byte 385 by the
   * SessionStart hook's (e2e/usageProcess.e2e.ts, "explicit inline usage follows the same aggregate boundary", CLI
   * end to end runs 43672659842 shard 2 and 42225258676 shard 7); a message, a tool call or a turn's end goes the
   * same way. So the next attach of that transcript folds only to this byte and tails from it. One entry per
   * session, gone once a tail runs for it. At 256 the map starts over, as `openclawFolderReads` does
   * (agents/bind.ts): a session forgotten that way attaches as it did before. In memory only.
   */
  const supersededReads = new Map<string, { transcriptPath: string; offset: number }>()
```

**(b)** In `forget`, after `recoveryRetries.delete(sessionId)` (line 115):

```ts
    supersededReads.delete(sessionId)
```

**(c)** In the re-attach path, after `const unseen = neverFoldedHistory.delete(session.sessionId)` (line 227):

```ts
        // The tail this starts has its own position: an older read's end is no longer where history ends.
        supersededReads.delete(session.sessionId)
```

**(d)** In `attachSessionNow`, above the comment of `keepLiveNormalizer` (line 302). The worker's `catch` writes
the entry too and does not go through `keepLiveNormalizer`, so the condition and the write are two functions:

```ts
    // Whether this attach leaves its session's transcript with no tail, held or running. Never a recovery: it replays
    // its own boundaries (`closes`).
    const leavesNoTail = (): boolean => !handover.hold && !session.interpretationHold && !!session.transcriptPath
      && !watcher.tails(session.sessionId, session.transcriptPath)
    // A read that ended here is as far as the session's history goes, and no tail was left to read on from it: the
    // next attach folds to here and tails from here (`supersededReads`).
    const rememberRead = (offset: number): void => {
      if (supersededReads.size >= 256) supersededReads.clear()
      supersededReads.set(session.sessionId, { transcriptPath: session.transcriptPath!, offset })
    }
```

**(e)** In `keepLiveNormalizer`, after the `explainRecovery` line (307) and before `handover.hold?.release()`. It
must come before `handover.next = null`:

```ts
      if (handover.next !== null && leavesNoTail()) rememberRead(handover.next)
```

**(f)** `historyEnd` (lines 313-315). Three lines go in above its comment, and `unreadFrom` into its last term:

```ts
    // An earlier attach of this transcript read it to here and installed no tail (`supersededReads`): history ends
    // there, and what was written since is the tail's. One kept for another file is a conversation that moved on.
    const remembered = supersededReads.get(session.sessionId)
    if (remembered && remembered.transcriptPath !== session.transcriptPath) supersededReads.delete(session.sessionId)
    const unreadFrom = supersededReads.get(session.sessionId)?.offset
    // A surviving shell can leave its old tail installed. Its cursor is the old engine's delivery
    // position; a newly started engine's history ends at the launch boundary instead.
    const historyEnd = () => closes ? undefined : relaunch?.engineStarted ? relaunch.offset : handover.hold?.offset ?? unreadFrom ?? relaunchedAt
```

**(g)** The worker path's `catch` (line 328): its first line, `if (prepared) remote.discard(prepared)`, becomes

```ts
        if (prepared) {
          // The worker read the transcript and the profile's config then could not be read: the candidate's cursor
          // is where that read ended. A worker that could not be reached read nothing known.
          if (leavesNoTail()) rememberRead(prepared.page.cursor.offset)
          remote.discard(prepared)
        }
```

The two lines after it (`remote.retry(session)` and the `return`) stay as they are.

**(h)** The inline read (lines 360-363): `handover.next = read.next` moves from below `fromEnd = read` to above the
`try`, with its reason:

```ts
      if (!current()) return false
      // Set before the profile's config is read: a config that cannot be read leaves no tail either, and the read
      // before it ended here all the same (`supersededReads`).
      handover.next = read.next
      try { await profile.config?.() }
      catch { return keepLiveNormalizer('could not read its runtime profile') }
      fromEnd = read
      historyTurnOpen = take(stream.finish())
```

**(i)** Where the tail is installed, after `neverFoldedHistory.delete(session.sessionId)` (line 613):

```ts
      // A tail runs from here on, started below or taken over: what a superseded read left for this attach is spent.
      supersededReads.delete(session.sessionId)
```

- [ ] **Step 5: Run the specs and see them pass**

From `cli/`:

```bash
npx vitest run src/core/transcripts/attach.spec.ts src/core/transcripts/attach.runtime.spec.ts src/core/transcripts/attach.control.spec.ts src/core/transcripts/openclaw.spec.ts src/engines/otherTranscripts.golden.spec.ts src/lib/registry.admission.spec.ts src/architecture.spec.ts
npm run typecheck
npx vitest run --config vitest.core.config.ts src/core/transcripts/attach.spec.ts src/core/transcripts/attach.runtime.spec.ts src/core/transcripts/attach.control.spec.ts src/core/transcripts/openclaw.spec.ts --coverage.include=src/core/transcripts/attach.ts
git status --short
```

Expected: `Test Files  7 passed (7)`, `Tests  298 passed (298)` (`attach.spec.ts` is 144 of them), with no skipped
test that was not skipped before; `tsc` prints nothing; the coverage summary reads 100% for statements, branches,
functions and lines (538, 452, 94 and 410), over 195 tests; `git status` lists `attach.ts` as modified and, the
documents under `docs/plans/` aside, nothing else. The seven files are every spec that builds the real attach, and
the architecture check. The whole gate runs in Verification, once, on the final head.

- [ ] **Step 6: Commit the code**

```bash
git add cli/src/core/transcripts/attach.ts
git commit -m "Core: the attach after a superseded read folds to where that read stopped, and tails from there"
```

Report both commits, and the Step 2 (red) and Step 5 (green) outputs with the commit each ran on.

---

### Task 2: An inline attach that left no tail is tried again

**Depends on:** Task 1 (the same two files; its `supersededReads`, `leavesNoTail` and `rememberRead`, and its
`describe` with `ANSWER` and `supersede`). **Effort:** xhigh (the daemon core; a timer racing other callers' attaches).

**Files:**
- Modify: `cli/src/core/transcripts/attach.ts` (after `supersededReads`; `forget`; the re-attach path;
  `keepLiveNormalizer`; the tail's install)
- Test (must fail before the change): `cli/src/core/transcripts/attach.spec.ts` (a nested `describe` at the end of
  Task 1's; one line in `does not close or replay agy history after %s supersedes its capture`)

This task names its places by the code around them: Task 1 moved the line numbers.

**Interfaces:**
- Consumes: Task 1's `supersededReads` and its three `supersededReads.delete(…)` lines, and in `attachSessionNow`
  its `leavesNoTail(): boolean` and `rememberRead(offset: number): void`; in the spec, `ANSWER` and
  `supersede(run)`. Already there: `attachSession(session, reset?, replayCursorFromStart?, replayFromStart?)`,
  `resolve(agentId)`, `watcher.tails`, `sid`, and in `attachSessionNow` `current`, `remote`,
  `replayCursorFromStart`, `replayFromStart`.
- Produces: nothing outside `attach.ts`. In `createAttach`:
  `supersededRetries: Map<string, { attempts: number; timer?: ReturnType<typeof setTimeout> }>`,
  `forgetSupersededRetry(sessionId: string): void` and
  `retrySuperseded(session: RegisteredSession, transcriptPath: string, current: () => boolean, replayCursorFromStart: boolean, replayFromStart: boolean): void`.

- [ ] **Step 1: Write the tests in `cli/src/core/transcripts/attach.spec.ts`**

Add this block as the last one inside `describe('after a read that was superseded before it installed a tail')`,
after `remembers 256 reads at most: one more starts over`:

```ts
    // Without an engine worker nothing asked again: in both runs only the SessionStart hook's attach, which happened to
    // follow, gave the agent a stream at all. The worker's path has its link's retry (core/engines/liveSessions.ts).
    describe('inline, it is attached again', () => {
      const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      /** Lets a real read finish while the fake clock stands still. */
      const until = async (done: () => boolean): Promise<void> => { do await new Promise(resolve => setImmediate(resolve)); while (!done()) }
      const reads = (run: ReturnType<typeof setup>) => vi.mocked(run.deps.runtimeProfiles.beginHydrate).mock.calls.length
      /** The session has been read this many times, and no attach is still running. */
      const read = (run: ReturnType<typeof setup>, times: number) => until(() => reads(run) === times && !run.attach.attaches.attaching().length)
      const quiet = () => { vi.spyOn(console, 'log').mockImplementation(() => {}); return vi.spyOn(console, 'warn').mockImplementation(() => {}) }

      it('a second later, to where its read stopped: a line written meanwhile is delivered live', async () => {
        fakeTimers(); quiet()
        const watcher = new Watcher(), add = vi.spyOn(watcher, 'addSession')
        const run = setup({ watcher })
        const file = transcript([CLAUDE_PROMPT]), row = session('claude', file), end = statSync(file).size
        const emit = vi.fn(), usage = vi.fn()
        createIngest({ liveFor, has: () => true, bySession: () => row, device: () => undefined,
          runtimeProfiles: { ingest: vi.fn() }, tokenUsage: { changed: usage }, normalizers: run.normalizers,
          announceTurnAborted: vi.fn(), emit, attachSession: run.attach.attachSession }).wireWatcher(watcher)
        try {
          supersede(run)
          expect(await run.attach.attachSession(row)).toBe(true)
          appendFileSync(file, JSON.stringify(ANSWER) + '\n')
          expect(vi.getTimerCount()).toBe(1)
          await vi.advanceTimersByTimeAsync(999)
          expect(reads(run)).toBe(1)
          await vi.advanceTimersByTimeAsync(1)
          await read(run, 2)
          expect(add).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: row.sessionId }), { fromOffset: end })
          await watcher.pollSession(row.sessionId)
          expect(usage).toHaveBeenCalledExactlyOnceWith(row)
          expect(emit).toHaveBeenCalledExactlyOnceWith(row.sessionId, expect.arrayContaining([expect.objectContaining({ type: 'turn_ended' })]))
        } finally { await watcher.stop() }
      })

      it('with the replay flags of the attach it follows: a first turn born after its agent is replayed, once', async () => {
        fakeTimers(); quiet()
        const run = setup(), row = session('claude', transcript([CLAUDE_PROMPT]))
        supersede(run)
        await run.attach.attachSession(row, false, false, true)
        expect(run.deps.emit).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(1)
        await vi.advanceTimersByTimeAsync(1_000)
        await read(run, 2)
        expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith(row.sessionId, [expect.objectContaining({ type: 'turn_started' })])
        expect(run.attach.replayedFirstTurn.has(row.sessionId)).toBe(true)
      })

      it('five times at most, 1, 2, 4, 8 and 16 seconds apart, says so once, and starts over with the next attach', async () => {
        fakeTimers()
        const warn = quiet()
        const run = setup(), row = session('claude', transcript([CLAUDE_PROMPT]))
        vi.mocked(run.deps.runtimeProfiles.beginHydrate).mockReturnValue({ ...run.profile, commitWith: () => false })
        const gaveUp = () => warn.mock.calls.filter(([line]) => line === '[agent] claude-a transcript not tailed · its attach was superseded 5 times')
        await run.attach.attachSession(row)
        for (const [retry, wait] of [1_000, 2_000, 4_000, 8_000, 16_000].entries()) {
          expect(gaveUp()).toHaveLength(0)
          expect(vi.getTimerCount()).toBe(1)
          await vi.advanceTimersByTimeAsync(wait - 1)
          expect(reads(run)).toBe(retry + 1)
          await vi.advanceTimersByTimeAsync(1)
          await read(run, retry + 2)
        }
        expect(gaveUp()).toHaveLength(1)
        expect(vi.getTimerCount()).toBe(0)
        // A hook's attach, or the reconcile's, superseded in its turn: the count starts again.
        await run.attach.attachSession(row)
        expect(reads(run)).toBe(7)
        expect(vi.getTimerCount()).toBe(1)
        await vi.advanceTimersByTimeAsync(1_000)
        await read(run, 8)
        expect(gaveUp()).toHaveLength(1)
        run.attach.forget(row.sessionId)
        expect(vi.getTimerCount()).toBe(0)
      })

      it('one at a time for a session, and it joins an attach already reading', async () => {
        fakeTimers(); quiet()
        const run = setup(), row = session('claude', transcript([CLAUDE_PROMPT]))
        supersede(run); supersede(run)
        await run.attach.attachSession(row)
        // A hook's reset, superseded as well: the retry already waiting is the session's one.
        await run.attach.attachSession(row, true)
        expect(vi.getTimerCount()).toBe(1)
        let finish!: () => void
        vi.mocked(run.deps.terminalGone).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(false) }))
        const hooked = run.attach.attachSession(row)
        await vi.advanceTimersByTimeAsync(1_000)
        finish()
        expect(await hooked).toBe(true)
        await read(run, 3)
        expect(run.deps.watcher.addSession).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
      })

      it.each(['tailed', 'rebound', 'forgotten'] as const)('never once the session is %s', async change => {
        fakeTimers(); quiet()
        const run = setup(), row = session('claude', transcript([CLAUDE_PROMPT]))
        supersede(run)
        await run.attach.attachSession(row)
        if (change === 'tailed') vi.mocked(run.deps.watcher.tails).mockReturnValue(true)
        if (change === 'rebound') bindings.set(row.agentId, { ...row, boundAt: 2 })
        if (change === 'forgotten') run.attach.forget(row.sessionId)
        expect(vi.getTimerCount()).toBe(change === 'forgotten' ? 0 : 1)
        await vi.advanceTimersByTimeAsync(60_000)
        expect(run.deps.terminalGone).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
      })

      it('counts from one second again once a tail was installed, and waits no more once an attach made sure the tail runs', async () => {
        fakeTimers(); quiet()
        const run = setup(), row = session('claude', transcript([CLAUDE_PROMPT])), add = vi.mocked(run.deps.watcher.addSession)
        supersede(run)
        await run.attach.attachSession(row)
        expect(vi.getTimerCount()).toBe(1)
        // The hook's attach installs the tail before the retry is due.
        await run.attach.attachSession(row, true)
        expect(add).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
        // Later a reset is superseded with that tail gone. Its retry is one second away, not two; the session has its
        // parser, so the retry only makes sure the tail runs.
        supersede(run)
        await run.attach.attachSession(row, true)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(vi.getTimerCount()).toBe(0)
        await until(() => add.mock.calls.length === 2)
        expect(add).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: row.sessionId }), { fromStart: false })
        expect(reads(run)).toBe(3)
        // Superseded once more, and a hook's attach makes sure the tail runs before the retry is due.
        supersede(run)
        await run.attach.attachSession(row, true)
        expect(vi.getTimerCount()).toBe(1)
        await run.attach.attachSession(row)
        expect(add).toHaveBeenCalledTimes(3)
        expect(vi.getTimerCount()).toBe(0)
      })

      it('never for an engine worker\'s attach, a tail it held, or an interpretation recovery', async () => {
        fakeTimers(); quiet()
        const worker = remoteSetup(), s = session('claude', '/private/transcript')
        vi.mocked(worker.remote.install).mockReturnValueOnce(false)
        await worker.attach.attachSession(s)
        expect(vi.getTimerCount()).toBe(0)
        const held = setup(), tailed = session('claude', transcript([CLAUDE_PROMPT]), { agentId: 'held', sessionId: 'held-s' })
        supersede(held)
        vi.mocked(held.deps.watcher.hold).mockResolvedValueOnce({ offset: 1_000_000, expired: false, release: vi.fn() })
        await held.attach.attachSession(tailed, true)
        expect(vi.getTimerCount()).toBe(0)
        const recovery = setup(), pending = session('claude', transcript([]), { agentId: 'recovery', sessionId: 'recovery-s', evidenceRevision: 2, interpretationHold: 'pending' })
        vi.mocked(recovery.deps.runtimeProfiles.beginHydrate).mockReturnValue({ ...recovery.profile, commitWith: () => false })
        await recovery.attach.attachSession(pending)
        expect(pending.interpretationHold).toContain('superseded during watcher installation')
        // The recovery's own retry, one per conversation, and no other.
        expect(vi.getTimerCount()).toBe(1)
        recovery.attach.forget(pending.sessionId)
        expect(vi.getTimerCount()).toBe(0)
      })

      it.each([new Error('probe failed'), 'probe failed'])('says when it fails: %s', async error => {
        fakeTimers(); quiet()
        const log = vi.spyOn(console, 'error').mockImplementation(() => {})
        const run = setup(), row = session('claude', transcript([CLAUDE_PROMPT]))
        supersede(run)
        await run.attach.attachSession(row)
        expect(vi.getTimerCount()).toBe(1)
        vi.mocked(run.deps.terminalGone).mockRejectedValueOnce(error)
        await vi.advanceTimersByTimeAsync(1_000)
        await until(() => log.mock.calls.length > 0)
        expect(log.mock.calls).toEqual([['[agent] claude-a attach retry failed: probe failed']])
        expect(vi.getTimerCount()).toBe(0)
      })
    })
```

And end the test `does not close or replay agy history after %s supersedes its capture` with one line, after
`expect(run.deps.settled).not.toHaveBeenCalled()`: four of its cases will start a retry, and this ends it as the
recovery tests end theirs.

```ts
        run.attach.forget(s.sessionId)
```

- [ ] **Step 2: Run the spec and see it fail**

From `cli/`:

```bash
npx vitest run src/core/transcripts/attach.spec.ts
npx tsc --noEmit
```

Expected: `Tests  9 failed | 146 passed (155)` in about ten seconds, and `tsc` prints nothing. All nine fail on
`expected +0 to be 1`, the count of waiting timers, before any of them waits:

- `a second later, to where its read stopped: a line written meanwhile is delivered live`
- `with the replay flags of the attach it follows: a first turn born after its agent is replayed, once`
- `five times at most, 1, 2, 4, 8 and 16 seconds apart, says so once, and starts over with the next attach`
- `one at a time for a session, and it joins an attach already reading`
- `never once the session is tailed`, `never once the session is rebound`
- `counts from one second again once a tail was installed, and waits no more once an attach made sure the tail runs`
- `says when it fails` (both cases)

`never once the session is forgotten` and `never for an engine worker's attach, a tail it held, or an interpretation
recovery` pass already: they pin what must start no retry. All 144 tests of Task 1 pass.

- [ ] **Step 3: Commit the red tests**

```bash
git add cli/src/core/transcripts/attach.spec.ts
git commit -m "Core: tests for the retry of an inline attach that left its session with no tail"
```

- [ ] **Step 4: Try again in `cli/src/core/transcripts/attach.ts`**

Five edits.

**(a)** In `createAttach`, after `supersededReads`:

```ts
  /**
   * The retries of an inline attach that left no tail: how many were started for the session, and the one waiting.
   * The engine worker's path asks its link to attach again (core/engines/liveSessions.ts `retry`); inline, nothing
   * did, and a session whose first attach was superseded was streamed only if a hook happened to attach it
   * afterwards. In the two runs above the SessionStart hook's attach was that one.
   */
  const supersededRetries = new Map<string, { attempts: number; timer?: ReturnType<typeof setTimeout> }>()
  const forgetSupersededRetry = (sessionId: string): void => {
    clearTimeout(supersededRetries.get(sessionId)?.timer)
    supersededRetries.delete(sessionId)
  }
  /**
   * Attach the session again after 1, 2, 4, 8 and 16 seconds, one retry waiting at a time, then say so and stop
   * until the next attach asks. A plain attach with the flags of the one it follows: it joins an attach already
   * reading (lib/attachTracker.ts), and a first turn born after its agent is still replayed once.
   */
  const retrySuperseded = (session: RegisteredSession, transcriptPath: string, current: () => boolean, replayCursorFromStart: boolean, replayFromStart: boolean): void => {
    const sessionId = session.sessionId
    const retries = supersededRetries.get(sessionId) ?? { attempts: 0 }
    if (retries.timer) return
    if (retries.attempts === 5) {
      supersededRetries.delete(sessionId)
      console.warn(`[agent] ${sid(session.agentId)} transcript not tailed · its attach was superseded 5 times`)
      return
    }
    supersededRetries.set(sessionId, retries)
    retries.timer = setTimeout(() => {
      retries.timer = undefined
      // Only for the binding whose attach left no tail (`current`: its lifetime and its pane identity, which names
      // the conversation and its transcript), and only while nothing tails it: a hook's attach, a new conversation
      // or a forgotten session got there first.
      if (!current() || watcher.tails(sessionId, transcriptPath)) return
      void attachSession(resolve(session.agentId)!, false, replayCursorFromStart, replayFromStart).catch(error => console.error(
        `[agent] ${sid(session.agentId)} attach retry failed: ${error instanceof Error ? error.message : error}`))
    }, 1_000 * 2 ** retries.attempts++)
    retries.timer.unref()
  }
```

`attachSession` is declared further down; it is called only when a timer fires, long after both exist, as
`holdInterpretation` already calls it.

**(b)** In `forget`, after Task 1's `supersededReads.delete(sessionId)`:

```ts
    forgetSupersededRetry(sessionId)
```

**(c)** In the re-attach path, after Task 1's `supersededReads.delete(session.sessionId)`, and its comment now
reads:

```ts
        // The tail this starts has its own position: an older read's end is no longer where history ends, and
        // nothing is left to try again.
        supersededReads.delete(session.sessionId)
        forgetSupersededRetry(session.sessionId)
```

**(d)** In `keepLiveNormalizer`, Task 1's line `if (handover.next !== null && leavesNoTail()) rememberRead(handover.next)`
becomes two questions: whether a tail was left, then what the attach read.

```ts
      // No tail was left for this transcript. Inline, the next attach is asked for here; the engine worker's link
      // asks for its own, and a recovery has its own retry.
      if (leavesNoTail()) {
        if (handover.next !== null) rememberRead(handover.next)
        if (!remote) retrySuperseded(session, session.transcriptPath!, current, replayCursorFromStart, replayFromStart)
      }
```

The worker path's `catch` (Task 1, edit (g)) stays as it is: its link retries it.

**(e)** Where the tail is installed, after Task 1's `supersededReads.delete(session.sessionId)`, and its comment
now reads:

```ts
      // A tail runs from here on, started below or taken over: what a superseded read left for this attach is spent,
      // and nothing is left to try again.
      supersededReads.delete(session.sessionId)
      forgetSupersededRetry(session.sessionId)
```

- [ ] **Step 5: Run the specs and see them pass**

From `cli/`:

```bash
npx vitest run src/core/transcripts/attach.spec.ts src/core/transcripts/attach.runtime.spec.ts src/core/transcripts/attach.control.spec.ts src/core/transcripts/openclaw.spec.ts src/engines/otherTranscripts.golden.spec.ts src/lib/registry.admission.spec.ts src/architecture.spec.ts
npm run typecheck
npx vitest run --config vitest.core.config.ts src/core/transcripts/attach.spec.ts src/core/transcripts/attach.runtime.spec.ts src/core/transcripts/attach.control.spec.ts src/core/transcripts/openclaw.spec.ts --coverage.include=src/core/transcripts/attach.ts
git status --short
```

Expected: `Test Files  7 passed (7)`, `Tests  309 passed (309)` (`attach.spec.ts` is 155 of them), with no skipped
test that was not skipped before; `tsc` prints nothing; the coverage summary reads 100% for statements, branches,
functions and lines (565, 466, 98 and 433), over 206 tests; `git status` lists `attach.ts` as modified and, the
documents under `docs/plans/` aside, nothing else.

- [ ] **Step 6: Commit the code**

```bash
git add cli/src/core/transcripts/attach.ts
git commit -m "Core: an inline attach superseded before it installed a tail is tried again, five times at most"
```

Report both commits, and the Step 2 (red) and Step 5 (green) outputs with the commit each ran on.

---

### Task 3: An attach that folded a transcript asks for the usage to be read again

**Depends on:** Task 2 (the same two files, `attach.ts` and `attach.spec.ts`; nothing of its code). **Effort:**
high (one call and its port, in the daemon core; six files, five of them one line each).

**Files:**
- Modify: `cli/src/core/transcripts/attach.ts` (`AttachDeps`; `createAttach`'s parameters; the end of
  `attachSessionNow`)
- Modify: `cli/src/core/main.ts` (the `createAttach` call, after `settled`, line 1372 at the base)
- Test (must fail before the change): `cli/src/core/transcripts/attach.spec.ts` (`setup`'s dependencies; a new
  `describe` at the end of `describe('attaching a session')`)
- Test (their attach gains the member, no new case): `cli/src/core/transcripts/attach.runtime.spec.ts` (line 40),
  `cli/src/core/transcripts/attach.control.spec.ts` (line 59), `cli/src/core/transcripts/openclaw.spec.ts` (line 106),
  `cli/src/engines/otherTranscripts.golden.spec.ts` (line 257)

Tasks 1 and 2 touch none of the last five files, so their line numbers are the base's. `attach.ts` and
`attach.spec.ts` are named by the code around each place.

**Interfaces:**
- Consumes: `usageLink.port.changed(target)` in `runForeground` (`core/main.ts:1611`), as the ingest's wiring uses it
  (`main.ts:2418`). In the spec: `setup`, `remoteSetup`, `session`, `transcript`, `started`, `CLAUDE_PROMPT`,
  `bindings`, and the types `AttachDeps` and `PreparedLive`, all there already.
- Produces: `AttachDeps.tokenUsage: { changed(session: RegisteredSession): void }`, required.

- [ ] **Step 1: Write the tests**

In `cli/src/core/transcripts/attach.spec.ts`, two edits.

`setup`'s `deps` gain the port, after `emit: vi.fn(),`:

```ts
    tokenUsage: { changed: vi.fn() },
```

And this block goes in as the last one of `describe('attaching a session')`, after the closing `})` of
`describe('after a read that was superseded before it installed a tail')`:

```ts
  // An agent's usage is first read when its row is first listed, and again only when a line is delivered live
  // (ingest.ts). A line already in the transcript when the attach reads it is folded as history, so the usage stayed
  // as it was read before that line: unset, for good, in e2e/usageProcess.e2e.ts, "explicit inline usage follows the
  // same aggregate boundary", 6 runs of 6 on a loaded Mac (2026-11-15), where a session's first read came after the
  // test's write.
  describe('reading the usage again after it folded a transcript', () => {
    const asked = (run: { deps: AttachDeps }) => vi.mocked(run.deps.tokenUsage.changed)

    it.each(['claude', 'pi'] as const)('asks once for each attach that folded what a %s transcript held, and never for one that only makes sure the tail runs', async engine => {
      const run = setup(), row = session(engine, transcript([engine === 'claude' ? CLAUDE_PROMPT : { events: [started()], open: true }]))
      expect(await run.attach.attachSession(row)).toBe(true)
      expect(asked(run)).toHaveBeenCalledExactlyOnceWith(row)
      // The session has its normalizer now: this attach folds nothing.
      expect(await run.attach.attachSession(row)).toBe(true)
      expect(run.deps.watcher.addSession).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: row.sessionId }), { fromStart: false })
      expect(asked(run)).toHaveBeenCalledOnce()
      // A reset folds the transcript again.
      expect(await run.attach.attachSession(row, true)).toBe(true)
      expect(asked(run)).toHaveBeenCalledTimes(2)
    })

    it('asks once for an attach whose engine worker read content, and not for one whose worker read none', async () => {
      const p = remoteSetup(), s = session('claude', '/private/transcript')
      expect(await p.attach.attachSession(s)).toBe(true)
      expect(asked(p)).toHaveBeenCalledExactlyOnceWith(s)
      const none = remoteSetup()
      vi.mocked(none.remote.prepare).mockResolvedValueOnce({ ...none.candidate, records: 0, content: false } as PreparedLive)
      expect(await none.attach.attachSession(s, true)).toBe(true)
      expect(none.normalizers.liveParsers.get(s.sessionId)).toBe(none.handle)
      expect(asked(none)).not.toHaveBeenCalled()
    })

    it('does not ask for an attach that folded nothing: an empty transcript, even one replayed as a first turn, no transcript, or a store', async () => {
      const run = setup(), empty = session('claude', transcript([]))
      expect(await run.attach.attachSession(empty, false, false, true)).toBe(true)
      expect(run.attach.replayedFirstTurn.has(empty.sessionId)).toBe(true)
      expect(await run.attach.attachSession(session('pi'))).toBe(true)
      expect(await run.attach.attachSession(session('opencode'))).toBe(true)
      expect(run.normalizers.hasState('opencode-s')).toBe(true)
      expect(asked(run)).not.toHaveBeenCalled()
    })

    it.each(['a pane that is gone', 'a read that was superseded', 'a binding that changed while its tail was started'] as const)('does not ask for an attach that returns early: %s', async early => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const run = setup(), row = session('claude', transcript([CLAUDE_PROMPT]))
      if (early === 'a pane that is gone') vi.mocked(run.deps.terminalGone).mockResolvedValueOnce(true)
      if (early === 'a read that was superseded') vi.mocked(run.deps.runtimeProfiles.beginHydrate).mockReturnValueOnce({ ...run.profile, commitWith: () => false })
      // The transcript was folded and its parser installed by then: the attach is no longer the binding's, and says nothing for it.
      if (early === 'a binding that changed while its tail was started') vi.mocked(run.deps.watcher.addSession).mockImplementationOnce(async () => { bindings.set(row.agentId, { ...row, boundAt: 2 }) })
      expect(await run.attach.attachSession(row)).toBe(early === 'a read that was superseded')
      expect(asked(run)).not.toHaveBeenCalled()
      run.attach.forget(row.sessionId)
    })
  })
```

Then the four other constructions, one member each, so that the code commit typechecks and their attaches can end:

- `cli/src/core/transcripts/attach.runtime.spec.ts`, line 40: `captureTerminal: async () => null, emit, tokenUsage: { changed: vi.fn() }, announceTurnAborted: vi.fn(),`
- `cli/src/core/transcripts/attach.control.spec.ts`, line 59: `emit, settled, tokenUsage: { changed: vi.fn() }, announceTurnAborted: vi.fn(), questionWatcher: { start: vi.fn() }, terminalLabel: () => 'private fixture',`
- `cli/src/core/transcripts/openclaw.spec.ts`, line 106: `tokenUsage: { changed: vi.fn() }, announceTurnAborted, questionWatcher: { start: vi.fn() }, terminalLabel: () => 'tmux:%1',`
- `cli/src/engines/otherTranscripts.golden.spec.ts`, a new line after `emit: emit as never,` (line 257): `tokenUsage: { changed: () => {} },` It records nothing in `out`: the golden files do not change.

- [ ] **Step 2: Run the specs and see them fail**

From `cli/`:

```bash
npx vitest run src/core/transcripts/attach.spec.ts src/core/transcripts/attach.runtime.spec.ts src/core/transcripts/attach.control.spec.ts src/core/transcripts/openclaw.spec.ts src/engines/otherTranscripts.golden.spec.ts src/lib/registry.admission.spec.ts src/architecture.spec.ts
npx tsc --noEmit
```

Expected: `Test Files  1 failed | 6 passed (7)`, `Tests  3 failed | 313 passed (316)`, all three in `attach.spec.ts`,
each on `expected "vi.fn()" to be called once with arguments`:

- `asks once for each attach that folded what a claude transcript held, …` and the same for `pi`
- `asks once for an attach whose engine worker read content, and not for one whose worker read none`

The other four new cases pass already: they pin when nothing is asked. All 155 tests of Tasks 1 and 2 pass.

`tsc` does not pass at this commit, and is not meant to: it reports six errors, every one about `tokenUsage`, and
nothing else. Five are `TS2353 … 'tokenUsage' does not exist in type 'AttachDeps'` (one in each of the five specs)
and one is `TS2339: Property 'tokenUsage' does not exist on type 'AttachDeps'` (the new block's `asked`). Any other
error is a mistake in Step 1.

- [ ] **Step 3: Commit the red tests**

```bash
git add cli/src/core/transcripts/attach.spec.ts cli/src/core/transcripts/attach.runtime.spec.ts cli/src/core/transcripts/attach.control.spec.ts cli/src/core/transcripts/openclaw.spec.ts cli/src/engines/otherTranscripts.golden.spec.ts
git commit -m "Core: tests for the usage read again after an attach folded a transcript"
```

- [ ] **Step 4: Ask for the usage in `cli/src/core/transcripts/attach.ts`, and wire it in `cli/src/core/main.ts`**

Four edits.

**(a)** `AttachDeps`, after `emit`:

```ts
  /** The agent's token usage, which the usage service reads from the transcript (core/usageLink.ts): told to read it again. */
  tokenUsage: { changed(session: RegisteredSession): void }
```

**(b)** `createAttach`'s destructured parameters gain `tokenUsage`.

**(c)** The end of `attachSessionNow`: after the `settled?.(session.sessionId)` line and before the final
`return true`:

```ts
    // What this attach folded was never delivered as a line, and the usage is read again only for a line delivered
    // live (ingest.ts): an agent listed before its first usage record was folded here kept no usage until its next
    // live line (e2e/usageProcess.e2e.ts, "explicit inline usage follows the same aggregate boundary", 6 runs of 6
    // on a loaded Mac, 2026-11-15). The link reads a session at most once in 15 s (core/usageLink.ts), however often
    // it is attached.
    if (lines.length || fromEnd?.content) tokenUsage.changed(session)
```

**(d)** `cli/src/core/main.ts`, in the `createAttach({ … })` call, after `settled: (sessionId) => mirror.settled(sessionId),`:

```ts
    // Built further down: asked when an attach has folded a transcript, never now.
    tokenUsage: { changed: target => usageLink.port.changed(target) },
```

Wiring only (`cli/AGENTS.md`, rule 1): `usageLink` is made at `main.ts:1611`, after this call and with no `await`
between, and the closure runs when an attach ends.

- [ ] **Step 5: Run the specs and see them pass**

From `cli/`:

```bash
npx vitest run src/core/transcripts/attach.spec.ts src/core/transcripts/attach.runtime.spec.ts src/core/transcripts/attach.control.spec.ts src/core/transcripts/openclaw.spec.ts src/engines/otherTranscripts.golden.spec.ts src/lib/registry.admission.spec.ts src/architecture.spec.ts
npm run typecheck
npx vitest run --config vitest.core.config.ts src/core/transcripts/attach.spec.ts src/core/transcripts/attach.runtime.spec.ts src/core/transcripts/attach.control.spec.ts src/core/transcripts/openclaw.spec.ts --coverage.include=src/core/transcripts/attach.ts
git status --short
```

Expected: `Test Files  7 passed (7)`, `Tests  316 passed (316)` (`attach.spec.ts` is 162 of them), with no skipped
test that was not skipped before; `tsc` prints nothing; the coverage summary reads 100% for statements, branches,
functions and lines (567, 470, 98 and 434), over 213 tests; `git status` lists `attach.ts` and `main.ts` as modified
and, the documents under `docs/plans/` aside, nothing else.

- [ ] **Step 6: Commit the code**

```bash
git add cli/src/core/transcripts/attach.ts cli/src/core/main.ts
git commit -m "Core: an attach that folded a transcript asks for the agent's usage to be read again"
```

Report both commits, and the Step 2 (red) and Step 5 (green) outputs with the commit each ran on.

---

## Verification

All on the final head, after the review. Nothing here needs an account, a sign-in, a device or Diego himself, and
nothing touches production: every daemon under test is the end-to-end harness's own (`cli/e2e/harness/daemon.ts`: a
throwaway home and data folder, its own port, a private tmux server, fake Claude Code and Codex engines), as
`cli/AGENTS.md` rules 5 and 6 require; on GitHub the workflow adds its own backend with in-memory Mongo and Redis.
Nothing of the developer's daemon (port 18473), `~/.harness`, `~/.claude` or `~/.codex` is read.

PR CI runs `cli-typecheck` and `cli-tests` on Linux by itself, with `attach.spec.ts` in the default suite: start no
run for them. No temporary workflow is planned: checks 1 to 4 are short or are the repo's local receipt, and the long
one, check 5, is the repo's own workflow, which already runs every night.

1. **The typecheck, on the developer Mac.** From `cli/`: `npm run typecheck`. A person sees `tsc` print nothing and
   exit 0. Under a minute.

2. **The changed specs, on the developer Mac.** From `cli/`, the first command of Task 3's Step 5. A person sees
   `Test Files  7 passed (7)` and `Tests  316 passed (316)`. About half a minute.

3. **The core's coverage gate, on the developer Mac** (PR CI does not run it; the repo makes it a local receipt).
   From the repository root, on a clean tree at the final commit:

   ```bash
   python3 scripts/local-checks.py --run
   ```

   It runs `npm run test:core` in `cli/` (the only check these paths need) and prints one `harness-local-checks`
   fence. A person sees `"check": "cli-core"` with `"status": "passed"`, which means 100% in every file of
   `src/core/` and `src/services/`, `attach.ts` among them. Three to four minutes (the rehearsal: 248 files, 4222
   tests, 3 min 4 s on this Mac while it carried other work). The script refuses a tree with untracked files, so it
   runs once the two documents under `docs/plans/` are committed.
   Paste the fence into the pull request body before pushing the tested commit or marking the pull request ready.

4. **`e2e/usageProcess.e2e.ts`, on the developer Mac, against the harness's isolated daemon**, from a bundle that
   embeds the process-image helper, so discovery binds a Codex agent as it does on Linux and the flow is the one
   that failed. From `cli/` in this worktree, with tmux and Xcode's command line tools installed:

   ```bash
   python3 scripts/build-process-images.py --output "$TMPDIR/process-images.json"
   for run in 1 2 3; do
     env -u TMUX -u TMUX_PANE HARNESS_PROCESS_IMAGES_ARTIFACT="$TMPDIR/process-images.json" E2E_BUNDLE=1 \
       npx vitest run --config vitest.e2e.config.ts e2e/usageProcess.e2e.ts
   done
   rm "$TMPDIR/process-images.json"
   ```

   The harness isolates each run and removes its bundle; nothing else is set up or cleaned by hand. A whole-file run
   takes about a minute and a half.

   What a person should see: `Test Files  1 passed (1)` and `Tests  3 passed (3)` on each of the three runs, whatever
   the machine's load (the rehearsal: three runs, 91 to 98 s each, at a one-minute load average of 12 to 17 on 10
   cores). Without Task 3 this Mac failed "explicit inline usage follows the same aggregate boundary" in every run:
   two at the base, four with Tasks 1 and 2, and one more in this rehearsal. So three passes here are the
   comparison; the base is run again, the same way, from a second worktree at `be613c89a9` and never from a stash in
   this one, only if a run here fails.

   A failure is this branch's to explain, by the daemon log the test prints. For the agent whose usage did not come,
   find its first `read the transcript from its end · … · N bytes` and its `[watcher] tail … @M`:
   - M equal to that N, with the test's line after byte N: the line was written after the first read. Task 1's
     path: it should have been delivered live. If a
     `kept its live normalizer · the re-read was superseded while reading` line sits between two reads, the second
     read must carry the same byte count as the first; a larger one is the bug this branch fixes, still there.
   - The first read's N already past the test's line: the line was folded as history. Task 3's path: the usage
     should have been read again within about 15 s of the `attached · …` line. Say whether the daemon ran that long
     after it before the 45 s ran out.
   - No tail line at all for the agent: Task 2's path, the retry.

   Report the three results with the commit they ran on, and for a failure the log lines above and the base's result
   beside it. Never report a failure as the test's own timing: with all three tasks the test passes on either side
   of the first read.

5. **The CLI end-to-end suite, on GitHub's Linux runners, once**: the repo's own workflow,
   `.github/workflows/cli-e2e.yml` (CLI end to end), which PR CI does not run and which is where the failure was
   seen. It needs the branch on GitHub, and it holds nine runners for up to 45 minutes, so the tester starts it only
   after the PM has given the runner turn: ask through the main session, and start nothing before the answer.

   ```bash
   gh workflow run cli-e2e.yml --ref fix/usage-tail-race
   gh run list --workflow cli-e2e.yml --branch fix/usage-tail-race --limit 1
   gh run watch <run id> --exit-status
   ```

   Each shard builds its own bundle and runs its files one at a time against isolated daemons, a private tmux and
   the workflow's own backend with in-memory Mongo and Redis; it has `permissions: contents: read`, no secret, and
   publishes nothing. One run only: never start a second to get a green one.

   What a person should see: the eight `e2e (N)` jobs, `e2e (macOS, full disk)` and `e2e-summary` green, and in the
   shard that ran it `e2e/usageProcess.e2e.ts` with its three tests passed (the shard's log, or `result-N.json` in
   the `cli-e2e-shard-N` artifact). The workflow is advisory and the suite is not always green on `main`: for any
   test that fails, download `cli-e2e-daemon-logs-N`, name the file and the test, and compare with the last nightly
   run on `main` (`gh run list --workflow cli-e2e.yml --branch main --limit 3`). A failure in
   `e2e/usageProcess.e2e.ts`, or one whose daemon log shows an attach (`read the transcript from its end`,
   `kept its live normalizer`, `transcript not tailed`, `attach retry failed`) is this branch's to explain before
   the pull request is ready; one that also fails on `main`'s nightly is reported as such, with both run numbers.

The two windows themselves have no end-to-end check of their own: forcing a superseded read, or a first read that
comes after a line, needs a test fault inside the core, which the spec rules out. Task 1's tests reproduce the first
on a real `Watcher` and a real transcript, Task 2's on a fake clock, and Task 3's the second.

Windows gets no check of its own: the change is in the attach every platform shares, it reads only injected
dependencies and the transcript file, and no workflow runs this spec or the CLI end-to-end suite on Windows.
