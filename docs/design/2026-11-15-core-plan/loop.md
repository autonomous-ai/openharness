# The core's loop holds: notes

Packages 1 and 9 of [the plan](../2026-11-15-core-plan.md). Audit: section 3's first row and security 4.

## History waits and input ordering (15 November)

The engine-worker failure test exposed an existing coupling: `session_get` awaited its reader inside the
connection's command chain, so a frozen optional worker delayed a later message to another agent on that connection.
Start the read after the existing authorization and ordering gates, then let later commands proceed while the
reader answers. Mutating commands keep their order. History retains its request id and originating connection;
`core/transcripts/history.ts` rechecks the captured conversation identity before returning worker output.

### Design

- Growth and concurrency: no new persistent data, cache or queue. Admit at most 16 detached history requests
  across all connections before calling the provider, including store discovery and inline compatibility. Excess
  requests receive the existing `ENGINE_BUSY` error. One counter and at most 16 reply deadlines bound this work.
  A timed-out or disconnected read keeps its slot until its underlying operation actually settles; it cannot
  multiply filesystem work by retrying. A refused worker is never an inline fallback.
- Read cost and scale: the same history request reads the same bounded page. Measure message dispatch with a held
  history request before/after; unrelated input must proceed before that request settles, including at ten clients.
- Compatibility, migration and rollback: successful replies and error bodies keep their existing shapes. Only
  completion order changes for independent requests with their own ids. No stored format changes or migration.
- Audience and identity: existing local/remote authorization runs before the read starts; reply routing retains
  the original connection and drops replies to disconnected local clients. No new account or credential use.
- Failure: rejected reads receive the existing error reply and a content-free named log. A 60-second outer
  deadline bounds the reply even if store preparation hangs; it accommodates Amp's existing 25-second request
  plus 25-second parts budget. Timed-out replies are `ENGINE_UNAVAILABLE`, late results are discarded, and the
  existing worker timeout/restart still applies. None of those waits holds the connection's command chain.
- Platforms: shared TypeScript on macOS, Linux and Windows; no process-launch or platform-specific change.

## Step 1 (package 1): Codex's rollout read, bounded and asynchronous

Branch `core-loop-1`. A Codex resume read its whole rollout synchronously on the core's loop, twice when it repaired
(`engines/kit/resumeRepair.ts`, from `core/agents/launch.ts`), with `engines/resumeTranscript.ts` and
`engines/kit/zstdFrames.ts`; Codex's title index was read whole (`lib/sessionTitle.ts`). The step reads it in chunks,
with a size cap and a deadline, and a test holds the core's event loop on a large rollout made in a test home (it never
blocks more than about 50 ms).

Done (15 November, `core-loop-1`): 1 MiB at a time, within 1 GiB, a 16 MiB record and 60 s, the history replaced only
while its caller holds. A 200 MB rollout with an item to repair held the loop 2.4 s; now 8 ms (`core/agents/
launch.loop.spec.ts`), and 4.8 s to 134 ms on the real daemon at load 23 (`e2e/resumeRepair.e2e.ts`). Still holding
a resume's loop past 50 ms: discovery's engine command lookup (`lib/engineBin.ts` `commandCandidates`, 180 to 220 ms)
and the registry save (80 ms), for steps 3 and 4.

## Steps 2 to 5 (package 9): hand-over from step 1

Run `tools/repair-bench.mts` with `SRC=$PWD/src MB=200 REPAIR=1 npx tsx <path>` in `cli/` for before and after numbers;
`tools/longblocks.mjs` reads a `--cpu-prof` profile and names the longest loop holds.

### What still holds the loop during a real resume (measured, e2e with `--cpu-prof`, load 20)

1. `lib/engineBin.ts` `commandCandidates` (line ~149): `accessSync` on every PATH entry for every engine, called from
   discovery (`terminalAgentDiscovery.ts` `probeTerminalAgents` -> `paneEngineProcess.ts` `lookupPaneEngineProcess` ->
   `processTable.ts` `selectEngineProcess` -> `engineBinaryOwnershipSnapshot` / `agentCommandOwnershipSnapshot`):
   180-224 ms in one go. Not in the audit's list; it belongs with PR 3.
2. `lib/registry.ts` save under its lock: `fsyncSync` x3 plus `rmSync` of the lock, 80 ms (PR 4).
3. When these go, tighten the bound in `e2e/resumeRepair.e2e.ts` (now `< 1_000` ms) towards 100.

### PR 2 (core-loop-2): the repair in Codex's worker (engine-codex)

Goal: the worker reads and rewrites the rollout body. Core retains only the existing bounded native header identity proof and publication authority.

#### Design (15 November continuation; technically reviewed before implementation)

The worker must never rename the live history. A deadline is not revocable authority: a worker can publish after
Stop, lose its reply after publishing, or publish after a Watcher hold expired. Instead, the worker locates and
prepares; core validates and publishes. The existing snapshot transport supplies bounded, generation-fenced reads;
the native path evidence used by handoff publication supplies path and file identity checks. The handoff transaction
itself is not reused: its project documents and persisted conversation snapshots do not describe a history repair.

1. Core captures the resume's authority and an overall deadline. Only Codex's declared repair is supported. Two
   preparations may run, no queue, and another preparation for the same session/file is refused. A first bounded
   worker request locates the history in the session's profile, including the existing moved-home fallback. Core
   independently verifies the returned path is an owned regular file within its own derived profile roots, using
   canonical native path evidence and `staysInside` (including #4323's Windows drive containment). Existing native
   transcript evidence must also independently bind that file to the registered session: containment alone never
   authorizes rewriting another conversation. Repair uses the evidence helper's candidate-only policy on the first
   check and every later verification: a delegated/overwritten-child candidate is left unrepaired, never followed
   into parent-pool discovery in core. Stop/binding retain their existing parent-repair policy. No worker-supplied
   destination is accepted as write authority.
2. Core captures the original identity/version and assigns a unique adjacent staging directory name. The worker
   reserves one of its two durable cleanup slots before creating that private directory exclusively, then records its
   identity before writing. It opens only two fixed private files, `backup` and `history`, once; a completed token is
   never recreated. Its existing two bounded scans validate session metadata and every complete JSONL record, compare the
   scans' digests, preserve the partial final line, write the exact backup and repaired history, flush both and close
   their handles before answering. The answer contains only counts and the two files' identities/versions.
3. Only after a valid answer does core acquire `Watcher.hold`, so an expensive preparation never suspends delivery.
   The hold drains old-file reads. Core then checks its deadline, current resume/binding authority, hold expiry,
   original path/version, staging directory identity and both fixed files (owned regular files, private modes,
   one link, bounded lengths, reported identities/versions). It hard-links the backup to the existing unique backup
   name without overwriting an existing file, then
   atomically renames the prepared history and calls `setTail` in the same synchronous turn, before releasing the
   hold. No worker request or other await occurs between the last authority check and publication/tail adjustment.
4. A failed/lost/stale/oversized reply, worker death or hang, changed source, cancelled resume or expired hold cannot
   publish. Worker cleanup deletes only its staging files/directory after rechecking their retained identity, never
   the source or the final backup name. A lost completion acknowledgement therefore cannot delete published history
   or its backup. Cleanup racing publication either leaves the original unchanged (and possibly an extra valid
   backup) or removes only the private names after successful publication. A late worker may finish a private
   preparation but can never change the original. Duplicate replies do not repeat publication; a retried resume reads the current original, and the
   existing repair is idempotent. A core process crash after rename follows the existing restart/reattach path; no
   surviving worker has publication authority.

Growth: at most two preparations and four temporary history copies, each capped at 1 GiB; record cap remains 16 MiB.
The Codex worker owns two bounded private cleanup receipts (directory path, parent evidence, identity, token and owning worker PID),
durably reserved before directory creation and removed after cleanup. Startup recovers only those two entries,
never scans transcript trees. A crash between directory creation and durable recording of its identity leaves that
slot reserved if the directory exists: cleanup never guesses ownership. An uncleanable or invalid receipt reserves
its slot and reports `RESUME_REPAIR_CLEANUP_FAILED`, rather than letting abandoned files accumulate. Ready slots
have a bounded expiry and may be released early by an acknowledgement; lost acknowledgements do not leak slots.
Recovery never takes a still-live worker's slot. It rechecks only the two known slots on the next request after a
handover, so a previous worker's eventual exit can free capacity without polling or a core restart. Cleanup also
checks the exact recorded token before deleting a receipt, fencing late callbacks from newer work.
Existing successful private backups retain their current policy. Core gains no durable repair state.

Concurrency: core admission is by session and selected file, bounded globally to two; all original-file publication
and Watcher cursor changes stay under core's captured authority. Worker generation fencing rejects old replies.
Read cost: core reads no rollout body or repair receipts. It retains bounded native metadata and the existing session header proof. The worker reads the
selected file twice in 1 MiB chunks, no whole-history string, with the existing 60 s repair bound.
Scale: at 10x request rate, overflow refuses repair and resumes unchanged; active preparations, failed preparation
kind and maximum core loop hold are the first signals. No content, paths or account identifiers enter new metrics.
Compatibility: this is private versioned IPC, with no public client contract change. Missing worker capability means
explicitly unrepaired, never inline fallback. Explicit inline/older-master mode retains the existing implementation
behind a dynamic import outside the default core closure, with review/removal date 15 December 2026. No migration
of conversations is needed; rollback reads the same native history and successful backup formats.
Audience and identity: only an authenticated local owner/core request can prepare a repair; roots come from the
registered session's own profile, never another account's login. Core revalidates worker path claims locally.
Failure: unavailable repair is a named logged outcome and the resume proceeds unchanged; invalid/foreign/changed
history keeps its existing preparation refusal. Cleanup failures name the repair failure without logging content or
paths. No code guesses whether publication occurred from a lost worker reply, because only core publishes.
Platforms: macOS/Linux/Windows use the existing supervised engine-codex process and no new process launcher.
Windows handles close before metadata is returned; final fences must not compare close-sensitive change times.

Validation selected before code: failing behavior tests for late completion after cancellation/disconnect, lost reply,
duplicate/stale reply, original/stage substitution, hold expiry, cleanup/recovery and bounded overload; unchanged
repair/launch golden corpus; worker request and real-file preparation tests; 100% per-file changed core coverage;
architecture and lean-entry checks proving the parser/rewriter leave default core; isolated worker kill/hang resume
integration and a matched 200 MiB repair loop benchmark. Heavy runs use the shared validation lock, after engine
completion's turn. Native Windows execution is reported separately if no Windows test host is available.

The original hand-over below is historical guidance. The reviewed staging design above supersedes its suggestion
that the worker rename the original under a deadline.

- Copy the provider move, which is the same shape (a Codex file operation at resume/retarget time, in Codex's worker):
  `core/engines/providerMoves.ts` (core side), `engines/worker/providerMoveProtocol.ts` (version, capability name,
  in-flight, queued, wait, reply bytes, `accepts`/`valid` guards), `engines/worker/providerMoveRequests.ts` (worker
  side, `snapshotRequests`), registered in `engines/worker/process.ts`; wired in `core/main.ts` next to
  `createProviderMoves` (~line 779, `isolatedProviderMove`, `serviceLinksRef.call`). `core/engines/backgroundJobs.ts`
  is the same pattern for Claude Code (its "never throws, resumes anyway" log is the fallback to copy).
- Request: `{ sessionId, transcriptPath, codexHome }` (bounded strings). Reply: `{ repairedItems, repairedBytes?,
  unrepaired? }`, validated in the core (numbers bounded by the file's size). The worker runs today's
  `prepareResume`/`repairHistory` (it may use a bigger record bound there: its loop holds no session).
- Ordering (docs/design/2026-10-08-engine-remaining-facets.md): await the worker, then `setTail`, then spawn. The
  worker renames the file, so the core's `setTail(repairedBytes)` happens after the reply: check the watcher cannot read
  the shrunk file in between (pause the session's tail with `Watcher.hold` before the ask, release with the new
  offset), or the conversation replays into web/device (see `core/agents/launch.ts` comment).
- Lessons that apply: ask the worker before the first irreversible step (a restart kills the engine before preparing:
  check the worker is linked, `engineLinks`, before the kill, or accept that a down worker means "no repair");
  "not answered" is unknown, never "nothing to repair": log `[resume] … not repaired: Codex's worker did not answer ·
  the history is left as it is` and go on; the core keeps its own bound (the transport's `waitMs`), and a hung worker
  is recycled by the transport, never waited on past it.
- `current`: the core checks its operation's hold after the reply; the worker cannot see it. Give the request a
  deadline, and have the worker refuse to rename past it (the core's wait must be longer than the worker's deadline).
- Inline mode (`HARNESSD_SERVICES=none`, Harness OS) keeps the in-core path (`inline?.…For(engine)` like the others).
  The other fourteen engines have no repair; only Codex declares `resumeRepair` (`engines/codex/launch.ts:79`).
- Core files: `engines/kit/resumeRepair.ts` and `kit/sessionRecords.ts` (if nothing else needs it) leave the core's
  process: delete their lines in `architecture.coreFiles.txt`; run `architecture.spec.ts` and `leanEntry.spec.ts`
  (engine-codex's lean bundle gains them).
- Tests: the worker down (copy `e2e/serviceProcesses.e2e.ts`: SIGKILL and SIGSTOP the engine-codex process during a
  resume): the resume goes on unrepaired, says so, the core stays up. Keep `launch.loop.spec.ts` meaningful (the core
  now reads nothing; assert the worker got the ask and the core loop stays under 50 ms). The golden
  `engines/launchPrep.golden.spec.ts` must stay as recorded.
- Host move (Windows, `lib/hostMove/moveAgent.ts`): its prepare step is bounded at 5 s inside a move that must end
  under 120 s; a worker ask must fit in it (see the fix made in PR 1 for the same bound).

### PR 3 (core-loop-3): the login shell and `harness-pty version`, asynchronous with a deadline

Both still run in the core on main (checked 15 November):

- `lib/engineBin.ts:105-133` `interactivePathEntries`: `execFileSync(shell, ['-lic', 'printf …"$PATH"'], { timeout:
  5_000 })`, cached per shell and daemon PATH. Reached from `pathEntries` -> `commandCandidates` (sync, discovery and
  launches). Make it async: start the login shell once (at start, and when the daemon's PATH changes), keep the last
  answer, and answer `pathEntries` from the cache (empty until the first answer, which is what a failed shell gives
  today). Never two shells at once. The New dialog's own login shells are the edge host's since 13 November (engine
  probe): check nothing else in the core still runs one (`grep -rn "execFileSync\|spawnSync" lib/engineBin.ts
  lib/loginShellEnv.ts lib/userShell.ts`, and `core/main.ts` "[env] read … variables from the login shell").
- `lib/ptyHost/launch.ts:226` `runVersionCommand` (`execFileSync(binary, ['version'], { timeout: 5_000 })`) via
  `binaryVersion` (line 235): Windows' terminal host. Callers: `lib/updateCommand.ts:42` (CLI, not core) and the pty
  host launch path (find them: `grep -rn "binaryVersion\|readBinaryVersion" lib/ptyHost`). The asynchronous twin
  already exists: `lib/windows/ptyPayload.ts` `probeVersionLine`. Use it in the core's path; keep the CLI's sync one
  if only the CLI uses it.
- Also here (found by profiling, item 1 above): `commandCandidates`' `accessSync` per PATH entry. Cache the
  candidates per (command, PATH) for a short time, or resolve them with `fs.promises.access` off the frame path;
  discovery runs every pass. Measure before and after with the e2e profile (`tools/longblocks.mjs`).
- Platforms: the login shell is macOS and Linux; `harness-pty` is Windows only (test it on Windows, or say why not).

#### Step 3 design (15 November)

Discovery must await its first complete ownership lookup without blocking other sessions. The synchronous
compatibility helpers remain for pure callers; the core's terminal scan, pane lookup and native ownership read
use bounded asynchronous filesystem work, deduplicated within each lookup, with no retained executable identity.
Up to 128 directory generations cache candidate names only, at most 16,384 entries read per changed directory;
larger/unreadable directories use the fixed command list. Positive candidates revalidate every pass, including
chmod and symlink targets. A missing directory is checked again on the next pass.
Discovery shares OpenCode's existing asynchronous PATH capture. It retains bash -ic / zsh -lic; the separate
one-shot credential capture stays -lic, preserving which startup files run. Each capture is single-flight and
limited to 5 seconds (PATH 64 KiB, credentials 1 MiB); changed shell/PATH invalidates it. A failed capture
keeps daemon PATH and emits a named failure. PTY target discovery awaits the existing asynchronous version probe,
with a hard deadline, bounded shared flights/cache and executable identity checked before publishing an answer.

Design: no new stored or transmitted data. Growth is bounded transient work and cache only; no migration or
rollback is needed. Concurrency is one shell capture and bounded filesystem/version probes. Reads inspect only
configured command candidates, never a filesystem tree. The same discovery workload records loop delay and CPU
before/after; timeout tests prove hung children cannot hold core. Published protocols and the last 30 days of
clients are unchanged. All execution uses the daemon's existing account; no new audience or credentials.
Failures remain unknown rather than evidence that a process died. Platforms: shell on macOS/Linux, hidden PTY
probe on Windows; local validation on macOS, Windows-specific options checked in tests, native Windows recorded
separately when available.

Step 3 review (local commits `f3ca1c2857`, `d8041621e3`): the cached directory sets contain only requested command
names, never unrelated entries. The Windows Hermes launcher uses the shared extension order with asynchronous
checks too. A synchronous reader's old shell flight cannot answer a lookup for a changed PATH. Native conversation
proof keeps its existing remaining 3-second budget while shared ownership work has its own deadline; expiration is
unavailable evidence. Those four regressions were reproduced red, then 81 related tests passed. The earlier affected
set passed 440 tests (6 platform/opt-in skips). The core, PTY, shell, architecture/lean-entry and isolated resume gates
apply to the final integrated head; their results belong to its exact-head PR receipt. Publication and integration
remain the coordinator's.

Matched probe workload (`tools/probes-bench.mts`, Node 24.22.2, macOS, private home, 48 PATH directories), exact
2458 source plus its package/TypeScript metadata versus integrated 055ad source: 100 ownership snapshots took
1,281 -> 261 ms wall and 1,335 -> 412 ms core CPU; longest loop hold 18.3 -> 3.6 ms. A cold 200 ms fixture shell
held the loop 980 -> 2.8 ms (wall 980 -> 788 ms); three 200 ms PTY version children held it 563 -> 2.2 ms
(wall 1,633 -> 1,624 ms). PTY CPU was 35 -> 51 ms, not an improvement: the now-responsive 1 ms observer ran
1,358 times instead of 6, and its cost is included. No native Windows performance claim is made.
An earlier async-access implementation increased ownership CPU and was rejected; the directory-name cache above
is the measured fix. Core footprint at the original base: 539 files / 92,700 lines.

#### Step 3 acceptance checkpoint

The async probes are implemented in PR #4339; final integration/CI and merge remain. At clean `c3609c1276`,
the official runner passed 4,455 core tests with 100% per-file coverage, all 14 real terminal-contract cases
(including the locally built native macOS PTY), and ten real-shell startup cases. Newly combined process identity,
discovery and architecture checks passed 49 tests; typecheck passed. Native Windows execution is not claimed.
An initial runner invocation incorrectly supplied two worker-count flags to the terminal suite; its incomplete
receipt was discarded, the invocation corrected, and the actual complete runner passed at unchanged source.

Main `5fa7b95762` is integrated; its app adapters do not change probe runtime or the native PTY source. Final
exact-head receipts belong in the PR. The matched performance above remains tied to its stated runtime and
environment. Registry lock/save and creation-receipt retention are separate, unfinished steps.

### PR 4 (core-loop-4): the registry save never sleeps the loop

Status, 2026-11-16: first increment passed local functional acceptance and root
cost review; main `8ee115aa` is integrated, PR #4356 CI/merge pending. The whole
registry extraction is not complete.
The reviewed implementation contract is [registry persistence](../2026-11-16-registry-persistence.md).
It supersedes the old last-state-wins sketch below: saves merge competing snapshots
under the old mkdir/owner.json exclusion and rebase captured field intents without
losing peer updates. Lock wait/read/owner publication/temp write/fsync are asynchronous;
one active operation and at most 64 queued operations retain ownership through actual
I/O cleanup. Durable result delivery is separate from cleanup settlement. The five-second
queue/pre-publication deadline revokes an unentered write; it cannot interrupt the
remaining synchronous final authority/rename/directory-fsync section.

Strict replies/releases now use selected-owner candidates and refreshed native proof
for hooks, Resume, Close plans, launch readiness, HostMove, Stop/unbind, discovery
ownership and explicit core name/model choices. Discovery/restore exit proofs refresh
after image preparation; every displaced owner receives cleanup. The local review
checkpoint inventories observational component preferences; the six obsolete
synchronous APIs and their private release helper are removed. Four independent-review
caller races have focused red/green evidence, including real native hooks after fresh
fallback and Stop during revalidation. Source `f26ac6b1` integrates main `8eaa7614`
and the input cancellation/forget fix; an added overlap control keeps old receipts
from affecting a replacement session. All five mapped local gates and TypeScript
pass, with 100% required coverage; native registry compatibility/crash cases pass
16/16 and input safety passes 14/14 with the verified macOS native-control helper.
The earlier missing-helper failures remain recorded. Final main `8ee115aa` adds
only a Desktop test fixture and Windows documentation; source-equivalent evidence
is recorded with final integration, rather than rerunning unchanged broad suites.

Four fixed ABBA processes complete all 332 expected outcomes and cleanup. The
regular 80-save workload uses 923.37 -> 741.06 ms CPU (-19.74%); changed-160 save
p95 is 124.13 -> 80.18 ms and heartbeat p95 124.64 -> 3.01 ms. Tradeoffs are
changed-16 CPU +9.11% and changed-160 sampled peak RSS 119.55 -> 160.60 MiB.
Root accepted the increment with those costs visible, not every metric improved.
The [final acceptance and scale review](../2026-11-16-registry-persistence.md#final-local-acceptance-and-scale-review-2026-11-16)
retains the complete table, baseline limits and earlier failures. Native Linux and
Windows execution is unverified here; automatic PR Linux checks remain pending.
Unconfirmed rename retains whole-group recovery and
cannot authorize success, an old-engine rollback or archive deletion. Exit seals
admission and waits for actual settlement before listener/claim release.

Core import closure delta for this task: one added file, `lib/registryPersistence.ts`;
no new process, runtime dependency or feature door. Startup load and final synchronous
publication/fsync still block and remain explicit residual work. Full-image reads
have no finite production row/byte bound; the 160-row fixture is only a scale sample.
Step 5 receipt expiry/incremental scanning is untouched and remains open. The
original 83-sample baseline, invalid sandbox run and later failed comparisons stay
recorded; none is relabeled as the accepted final comparison.

- `lib/registry.ts:492-601` `withRegistryFileLock`: `mkdir` lock dir + `owner.json` (fsync), on `EEXIST` it waits with
  `sleepSync(20)` (`Atomics.wait`, line 501) up to `LOCK_BUDGET_MS` 2 s. `atomicWriteJson` (line 627): temp file
  fsync + rename + `syncStateDirectory` (`lib/secureState.ts:82`, a directory fsync). That is the three fsyncs.
- Who else takes this lock (the exclusion between processes must stay): `grep -rn "withRegistryFileLock\|LOCK_DIR"`;
  other daemons on one machine (`e2e/twodaemons.e2e.ts`), an older core during a handover (`e2e/updates.e2e.ts`), CLI
  commands. A new core must still exclude an older one, and the reverse (compatibility rule in the plan).
- Historical sketch (superseded by the reviewed Design above): an async lock using the same
  `mkdir` lock dir and owner file, waiting with timers, never `Atomics.wait`.
  `registry.transaction` callers expect the row change to apply synchronously (see `core/agents/hostMove.ts` `swap`):
  keep the in-memory change synchronous, make only the disk write async, and say what a crash in between loses.
- fsyncs: the temp file's fsync before the rename is what makes the rename durable (keep); the directory fsync makes
  the rename itself survive a power cut (keep, async); the owner file's fsync only protects the lock's own owner record
  (an ownerless lock is already treated as debris after 5 s: `OWNERLESS_STALE_MS`), so it can likely go. Prove each
  with a crash test (kill -9 between steps) and two writers (two processes saving in a loop: no lost row, no torn
  file).
- Show save time before and after (a bench of N saves, and the loop hold during them).

### PR 5 (core-loop-5): create receipts are deleted

- `lib/agentCreationReceipt.ts` `AgentCreationReceipts` (class at line 105): one file per creation id, never deleted.
  `pendingIntents()` (line 328) walks the whole folder with `opendir`; `core/agents/pendingLaunches.ts:96-123` scans it
  every 60 s, a bounded part per turn (493 receipts on the measured Mac).
- Readers and why (check each): `run` (a retried create with the same id never launches twice: the reason receipts
  exist), `status`, `has`, `creator`, `createdLaunchModel`, `scrubCreated` (`core/main.ts`, at a delete),
  `runIntent`/`pendingIntent`/`pendingIntents`/`cancelIntent` (held creates waiting for a service). The shell service
  keeps its own receipts in the edge host (`services/shellProcess.ts`): not this.
- Plan: a receipt that is final (created, failed) and older than the longest a client retries a create (find the
  client's retry window: Desktop's create retry, `agentClient/`) is deleted; pending intents are kept until they end.
  Keep pending intents apart (their own folder or an index) so the minute's scan reads only them. Bound the folder
  (a cap with oldest-final-first deletion). Migration: old receipts in the folder are swept once, bounded per pass.
- Test: a retried create inside the window still answers from its receipt; after it, the receipt is gone; the scan
  reads only pending ones (count the entries read).
- The plan (`docs/design/2026-11-15-core-plan/loop.md`, step 5): package 4 (git) wants a clone's progress shown
  through these receipts. Agree the shape with that package before changing what a receipt holds.
