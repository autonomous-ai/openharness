# Daemon core takeover — October 10

## Work resumed — 14:13 UTC

The owner revoked the handoff and requested continued implementation and completion.
The stop instruction below is historical and superseded. Work continues on #1145;
the [implementation report](2026-10-10-native-handoff-authority.md) records the
subsequent corrections and validation. The remaining scope is unchanged in the
[completion checklist](2026-10-09-daemon-core-completion.md). No release is authorized.

## Historical handoff status — 13:29 UTC

At that time, the owner explicitly ended implementation because the
session had about one percent credit left. #1145 is **draft, open and unmerged**.
No release occurred. The refactor is not finished. No runtime edits were made
after `196012ec112da477cec9172dc8c7726f0041e482`; this final update is documentation
only. The previously described independent approval was conditional on green
remote gates, and those gates did not pass. Do not use it to merge this head.

The successor's first task is finishing #1145, not starting another extraction:

1. [Automatic CI 38055181285](https://github.com/autonomous-ai/openharness/actions/runs/38055181285)
   finished red. Typecheck, process checks, TUI, all four Desktop shards and CLI
   shards 1, 2 and 4 passed. CLI shard 3 failed two `lib/agentHandoff.spec.ts`
   publication cases: “does not leave the raw transcript path in the transcript
   file either” and “keeps the rest of the document when a git value carries a
   PEM header”. Both received `IDENTITY_UNAVAILABLE`; their durations were 458 ms
   and 321 ms. The full log is `.harness/native-handoff-ci-cli3-failed.log`.
2. Independent read-only review confirmed a concrete lifetime bug in
   `lib/handoffPublication.ts`: `sync()` and `createFile()` retain a 250 ms
   `NativeFiles` budget across successful `fsyncSync`/write work. An otherwise
   valid slow flush can expire that inspection budget while the original request
   still has time. The flattened CI error does **not prove** this caused both
   failures. **The fix has not been written or tested.** Retain original immutable
   route facts with `paths.snapshot()` before durability work and verify those
   same facts with a fresh bounded read budget afterward. Preserve descriptor and
   pathname keys, the original request deadline and every pre-publication fence.
   Do not increase global budgets or reset the request deadline. Add deterministic
   slow-fsync success, changed-route refusal and original-deadline expiry tests;
   the existing publication expiry tests should continue to hold safely.
3. [E2E 38054858895](https://github.com/autonomous-ai/openharness/actions/runs/38054858895)
   is red in several completed jobs. At handoff, Linux shards 4 and 5 were still
   running; shard 3 passed. Do not start a duplicate run. Read its final result
   and retained artifacts. Known failures include:
   - `handoff.e2e.ts`: the stopped Claude fork case fails at line 117 while
     deleting the unbound fork (`INTERNAL`), **before handoff preparation**.
   - `serviceProcesses.e2e.ts:441`: models/grid expected a `/v1` suffix that the
     actual returned base URL omitted.
   - `engineReaders.e2e.ts`: Codex shortened-history replay timed out.
   - `startupAttachExit.e2e.ts`: Claude resume returned `IDENTITY_UNAVAILABLE`.
   - `eagerHooks.e2e.ts` and four `enginehomes.e2e.ts` cases: native binding/hold
     assertions and recovery timed out or disagreed.
   - macOS full-disk: two failures, including first-start hook credential ENOSPC
     and an agent created while full failing to bind. Linux shard 8 also failed;
     its log had not yet been inspected.
   These have **not** been proven baseline failures or fixed. Do not dismiss or
   silently waive them. Downloaded logs are `.harness/e2e-<job-id>.log`; shard 1's
   complete daemon artifacts are in `.harness/e2e-logs-1/`.
4. Local broad validation remains blocked by the unchanged two-GiB disk guard
   (about 1.37 GiB available at final inspection). Do not lower it or clean other
   sessions' data. Earlier local receipts below remain evidence only for their
   recorded source/toolchain; they do not turn the failing Linux run green.
5. After corrections, obtain review of the new exact head/base, pass required
   checks and affected e2e, then use the reviewed merge command. Check fresh main
   first. No merge was attempted here.

No local test, mutation or implementation process is running. The read-only
reviewer finished. The manual e2e run above may continue remotely; converting
#1145 back to draft can also leave a process-only automatic CI run. The final
documentation push preserves this handoff on `codex/native-handoff-authority`.
Implementation ended before this note; 13:12–13:29 UTC was remote validation,
failure diagnosis and handoff work, with overlapping review/waiting. Merge and
publication time for #1145 are zero.

## Earlier implementation and validation record

Prepared at 13:10 UTC. The owner asked to finish the current handoff PR, document
everything, then stop for another agent. **Do not interpret this as permission to
release.** The daemon refactor is not completely finished. The remaining scope is
the [completion checklist](2026-10-09-daemon-core-completion.md); extraction is done,
but durable recovery and several session-control boundaries still need work.

First read the [original handoff](2026-10-08-daemon-separation-handoff.md), this note,
the completion checklist and the current PR's live state. This note is written
before final remote checks; #1145's Checks and PR body are the final merge receipts.
If #1145 is merged, start from fresh `origin/main`. If it is open, finish its stated
gates and reviewed merge before starting another item.

## Rules that remain in force

- Session control (Stop, binding, hook admission, turn closing, launch, discovery
  and resume) stays eager and does not depend on a service or lazy implementation.
  Readiness never waits on a service. Unavailable evidence holds the operation with
  its reason; it must not fail, archive or partially publish it.
- Golden first, in its own former-code commit. The artifact must pass unchanged;
  deliberately disconnected wiring must fail assertions, not just compilation.
  Pin `process.platform`, UTC and `/tmp`; replace host binaries with placeholders
  in golden observations. Linux CI portability matters.
- Run typecheck, architecture, core and harnessd coverage gates, affected specs and
  affected private e2e lanes. Core statements and branches must reach 100% per file.
  Choose checks once and reuse valid evidence only for its actual inputs/environment.
- Obtain independent review of the exact head and base, record it in the PR body,
  mark ready, and wait for every head check including `ci/required`. Merge with
  `make merge-pr ARGS="N --reviewed-head HEAD --reviewed-base BASE --merge"`.
  If main advances, integrate it, review interactions and rerun only invalidated
  checks. No merge queue setup and no manual duplicate automatic CI runs.
- Check `gh auth status` before GitHub work and use only the account authorized in
  the owner's task. Never push to `autonomous-circuit` or `autonomous-workshop`.
- **Never release**, including the earlier #1064 regression fix. The owner alone
  calls `make release-cli`.
- Work in an owned worktree. The main checkout contains someone else's changes;
  never edit, reset, clean or stash those. Never use bare `git stash`.
- Tests use private homes, daemon ports and tmux. Unset `TMUX` and `TMUX_PANE`, and
  ensure `TMUX_TMPDIR` exists. No port 18473, installed daemon, real engine homes or
  client that could open the owner's harnesses. Do not delete user data.
- This repository is public: no personal paths or real personal names/emails in
  fixtures or reports. Write reports under `docs/`. Keep owner updates short.
- Keep implementation, validation, review/CI waiting, merge and publication timing
  separate. Overlapping intervals are not additive. Publication is zero.

## Landed work and the current PR

The original six extraction phases and follow-ups are landed: crash resume #1072,
Store/DSH L3 #1073, models L2 #1076, usage/external sessions #1078/#1081,
legacy runtime manager removal #1088, same-millisecond pane collision #1091,
and capture ownership #1093. **Do not reimplement the pane collision fix.**
Subsequent eager-engine, native-evidence, launch preparation and home/binding work
is listed with PRs in the completion checklist. Stop/Resume/Close transcript
authority landed in #1139. Reviewed native history deletion landed in
[#1144](https://github.com/autonomous-ai/openharness/pull/1144), squash
`cb242cf4c7d21b7b7cd95ac727fedb30317e9878`, around 11:21 UTC October 10.
That was the latest fetched `origin/main` at this note's preparation.

Current work is [#1145](https://github.com/autonomous-ai/openharness/pull/1145),
branch `codex/native-handoff-authority`, titled
“Keep Change agent handoff publication under current core authority”.
The last runtime validation head is `4eea2be7dcceac7e978123170f54676cd2c56209`.
Documentation commits can follow it; inspect the PR's actual head rather than
assuming this SHA is the final reviewed head.

The owned worktree is `/tmp/harness-native-admission-baseline` (canonical macOS
prefix `/private/tmp`). All implementation is committed. Before final push, the
remote draft was still at `90b5049c6e68705bee8d1fe7a5d7bd103f08b11d`; the handoff
push includes subsequent fixes. Do not start from that earlier remote snapshot.

### What #1145 changes

Change agent previously could treat unavailable native history as empty, use a
mirror fallback or publish after its source/request changed. History interpretation
and Git commands remain in the edge process. Eager core publication owns the final
request, session, native-file, fork-ancestry and destination checks.

- `core/handoffDependencies.ts` composes core-owned discovery/selection witnesses
  with `core/handoffPublication.ts`. The latter validates bounded strict payloads,
  current complete session fingerprints, exact ancestry/cutoffs, ownership,
  deletion state, root/path/descriptor identity and content versions.
- `lib/nativeHandoffRead.ts` reads a borrowed native descriptor to its original
  finite end. It rechecks header/root/file evidence after the body; pathname
  replacement cannot lend authority to another descriptor.
- `lib/handoffAuthority.ts`, `handoffValidation.ts`, `handoffFiles.ts` and
  `handoffGit.ts` contain bounded wire facts, validation and filesystem evidence.
- `lib/handoffPublication.ts` maintains an owned durable receipt per intent.
  It uses token-owned locks for the project, receipt and shared Git exclusion;
  secure stages, fsync, exclusive links/atomic receipt replacement; and exact
  confirmation before acknowledging success. Empty results are durable too.
  Same-intent retries retain the originally reserved redacted snapshot.
- Publication yields between durable steps and revalidates after every yield.
  Separate cheap request checks immediately precede public links/renames and final
  success, so a deadline crossed during synchronous fsync cannot authorize an effect.
  Stop/readiness never join publication locks. Synchronous kernel calls cannot be
  forcibly cancelled; bounds and revalidation are practical safeguards.
- Interrupted exclusion staging can rebase before any document output is staged,
  retaining user contents and the reserved snapshot. Completed/output-staged
  transactions remain strict. A later empty candidate cannot erase a reserved
  nonempty Git effect. Old private stages are preserved.
- Service links retain the original five-second request deadline and exact
  connection/owner/request identity; late/replaced/disconnected work loses authority.
  Typed unavailable/conflict replies survive the process boundary.
- Desktop and TUI hold before Close on unavailable or malformed preparation;
  only explicit `UNSUPPORTED` uses compatibility fallback. A proven conflict
  requires explicit reselection. A held retry keeps its ID across reconnection.
- Delayed client replies cannot close a source whose session, creation, engine or
  project changed. TUI picker and held-intent authority use these same fields.
  Explicit reopening may discard a stale preparation only before Close was sent;
  uncertain Close/create operations keep their original receipt.

The [implementation report](2026-10-10-native-handoff-authority.md) contains the
design decisions, faults found during review, limitations and measured cost.

### Golden, review and validation evidence

The former-code golden is its own commit, `c8bb4d955`, before the move. It has
twelve Linux/macOS observations across inline and real JSON service composition,
own/fork/discovered history. Its artifact remains unchanged:

`cli/src/lib/__fixtures__/native-handoff.golden.json`

SHA-256: `b921e24e4e321820fa65f14852f48ff1648c2c82447a2ea131bd7a075e958f11`.

The corrected fixture, which isolates each project's daemon receipt directory,
was also replayed against the unchanged former runtime
`a61cba5bc967cbfd8e888995987cc42cbf6556ee`. The earlier native-consumers golden's
38 observations remain unchanged too.

Final local CLI validation at 13:02–13:08 UTC passed:

| Check | Result |
|---|---|
| TypeScript | Passed, 4.6 seconds |
| Full core | 2,310 tests / 169 files; 100% statements, branches, functions and lines; 100.7 seconds |
| Full harnessd | 265 passed, one existing skip; 100% coverage; 14.2 seconds |
| Affected integration/readers/goldens | 470 tests / 16 files; 204.8 seconds |
| Final TUI | 19 switch + 2 handoff tests passed; build and tests 96 seconds |
| Desktop | 70 switch cases, 5 additional source-fence cases, 40 reply cases passed in recorded runs |
| Desktop analysis | No warnings/errors; eleven existing bracing advisories in the larger state file |
| Wiring mutations | Unchanged baselines passed, then all 15 mutants failed behavioral assertions |

The affected set includes architecture, lean-entry, fork composition, real-Git
wire responsiveness, native goldens, native descriptors and transcript readers.
The initial affected run had five failures, all diagnosed and corrected: obsolete
BUSY/TIMEOUT response expectations, a concurrency fixture sharing one project,
three handoffs under one test timeout, and a stale-process expectation conflated
with a current process pointing to another directory. Request deadlines did not
change. The corrected three files separately passed all 195 cases before the
final full affected run. Do not describe the initial failed run as passing.

Independent read-only review approved exact head
`562a5630ab9eb6be0b6cf62de1f2b728938b590e` against
`cb242cf4c7d21b7b7cd95ac727fedb30317e9878`, conditional on remaining gates/CI.
`4eea2be7d` adds the result report and removes one blank EOF line; there is no
runtime behavior change. Final exact-head/base approval belongs in #1145's body.
Review ran no tests and made no edits.

The new private e2e cases cover both fake engines: corrupt their native header,
observe a held handoff with no publication or Close, restore the header, retry the
same intent and continue the conversation with one core start. Required local lanes
were `handoff.e2e.ts`, `lifecycle.e2e.ts` and the edge-host subset of
`serviceProcesses.e2e.ts`. **They did not run in the final local attempt:** the
two-GiB disk guard rejected the plan at 1.59 GiB, and free space kept falling.
Use the final GitHub e2e run linked in #1145 to establish acceptance; do not reuse
the earlier #1144 e2e result for this changed handoff behavior.

The draft automatic run `38051356814` passed process checks and deliberately failed
`ci/required` because component checks are deferred until ready-for-review. This
is not a CI defect or grounds for a manual duplicate CI run. Ready-PR checks and
the separate existing “CLI end to end” workflow are distinct evidence.

Cost samples are committed in `2026-10-10-native-handoff-cost.json` and reproduced
by `cli/scripts/handoff-2026-10-08/native-handoff-cost.ts`: eighteen fresh processes,
54 measured operations, pinned Node 22.23.2, identical 45,151-byte/20-turn input.
Mean own/fork handoff is about 0.50 seconds, retry 44 ms; maximum measured callback
delay 275 ms. These are **non-Git** projects; Git/exclusion paths are covered by
separate wire/e2e evidence. This records a cost increase, not a speed improvement.

### Local evidence and worktree care

Under the current worktree, ignored `.harness/` retains:

- `native-handoff-units.json`, `native-handoff-clients.json`,
  `native-handoff-e2e.json`: explicit plans, unchanged two-GiB guard.
- `validation/20261010T130225.014995Z-50065/receipt.json`: final CLI pass.
- `validation/20261010T125904.363303Z-34286/receipt.json`: final client pass.
- `validation/20261010T130755.057989Z-80515/receipt.json`: local e2e blocked
  before execution. `native-handoff-e2e-final.log` records the guard.
- `validation/20261010T124654.773624Z-72492/receipt.json`: earlier full core and
  harnessd pass with the diagnosed affected failures.
- `native-handoff-corrected-fixtures.log`, final Dart analysis and earlier client,
  mutation/cost/composition logs. Keep failures as evidence as well as successes.
- `preserved-worktrees/native-history-1144-evidence.tar.gz`: previous PR evidence,
  including its merge receipt and nested earlier archives. Its old worktree was
  retired only after it was clean and inactive.

The mutation worktree is `/tmp/harness-native-admission-mutants`, branch
`codex/native-handoff-mutants`, at `f0a4f0a5c`. Its ignored
`.harness/native-handoff-mutations.log` records all fifteen catches; files were
restored after every mutant. Its `.harness/former-handoff-golden/` preserves the
former fixture copies. No mutation run is active at this note's preparation.

Do not delete `/tmp/harness-daemon-separation-l3/cli/node_modules`: current and
evidence worktrees share that installation by symlink. The native-descriptor
evidence worktree retains `.harness/process-images-control-v1.json`. An older
`harness-native-descriptor-mutants-v1` worktree has unfinished modifications and
untracked files; leave it alone. Other sessions' temporary folders are not ours
to clean just because their names look related.

The current worktree is sparse: unrelated website/device/mobile sources and large
Desktop assets/design files were omitted to reclaim space. No tracked edits were
discarded. Restore needed paths before future component work. The current task's
finished Desktop and TUI generated build outputs were removed; their logs and
receipts are preserved. TUI will need to compile again if its source changes.

The local CLI toolchain used Node 22.23.2 (macOS x64), UTC, `/tmp`, existing private
tmux directory and `HARNESS_CONNECTIONS_PORT=0`, with tmux environment unset.
Tests create private engine homes. Desktop/TUI used `.harness/client-home`;
TUI dependency/toolchain caches were reused, with two compilation jobs and no
incremental/debug output. Never point fixture traffic at an installed client.

For reusable deterministic checks, the CLI plan declares all CLI and shared
build/config inputs; docs, Desktop and TUI are outside that scope. Use the prior
receipt with `--reuse` and inspect the diff. Do not mutate source during a formal
run. Native e2e requires current evidence. The worktree has no active local
validation process after the guard rejection; any active remote runs are linked
in #1145. Do not rerun an uncertain merge: inspect its PR state first.

## Work left for the next agent

These are existing completion items, not new tasks started during handoff.
Read the completion checklist and each linked implementation report before
choosing the next bounded PR. All moves need former-code goldens first.

1. **Durable native hook delivery and remaining identity consumers.** Live atomic
   admission is landed, but pending jobs, acknowledgement receipts and linked Stop
   closures in `hookServer.ts` / `core/engines/pendingAdmission.ts` are in memory.
   `hook/notify.mjs` accepts `session-start` HTTP 200 with `pending:true` as success;
   a native hook can exit before a held admission commits, then a core crash loses
   that queued delivery. Reproduce this before designing the durable journal.
   Preserve native delivery identity/order, current process authority, bounded
   capacity and replayable acknowledgements across restart; readiness must remain
   independent. Existing shell clients, generated OpenCode/Kilo/Pi/Amp plugins,
   saved-home consumers, Hermes home promotion and shared-handle lifetime remain
   in scope. Do not count reloading the old plugin as fixing its missing protocol.
2. **Native launch preparation.** Executable/version probes still need asynchronous
   bounds and one confirmed executable snapshot per launch. Audit permanent null
   version memoization, unavailable writes/removals and foreign hook configuration
   preservation across create/fork/restart/retarget/restore/upgrades.
3. **Durable manual lifecycle intent.** Preserve create/fork/restart/retarget across
   service outages/core restart, publish generated config atomically and recheck
   complete session authority after awaits and before effects. OpenCode v2
   unconfirmed mutation needs read-only reconciliation; audit v1 missing-row/
   rollback behavior and truthful reporting after native change but failed respawn.
4. **Close, turn and input authority.** OpenCode v2 Close needs current checkpoint/
   activity evidence; incomplete evidence holds the live session. Finish engine
   Stop/turn facts, async drain authority, Cursor task persistence/order, agy
   backstop, input declarations, Pi header/argv/unwritten history and durable
   Cancel/Stop recovery.
5. **Final acceptance matrix.** Required services absent, stalled, disconnected and
   recovered across startup/discovery/binding/launch/resume/Stop/hooks/turn closing/
   Close. Prove readiness independence, durable holds, no partial archive/write
   and no stale completion affecting a replacement. Include coverage, unchanged
   goldens, assertion mutants, private chaos/e2e, matched cost and independent review.

Read-only audit leads, **not completed implementations or proven new blockers**:
`resumeStoppedAgent.liveIdentity` / launch authority may omit transcript/home/
binding/evidence/process-start fields; `nativeVersion` uses synchronous probing
and unavailable versions may be memoized; OpenCode/Kilo mark sessions seen before
fetch settles; OpenCode v2 has a global busy flag/session set that can lose A→B→A;
Pi has process-global registration booleans; Amp's first global thread selection
needs examination. Each needs a focused reproducer before expanding scope.

No hook journal, launch-probe migration or new lifecycle change was started here.
The owner's final instruction is to finish the handoff and stop now. The next
agent owns completion of #1145 and the remaining checklist.

## Timing

The original request began October 8 at 23:26:41 UTC; work resumed October 9 at
22:25:51 UTC. The October 9 estimate was two to three focused days, with moderate
confidence, not a completion promise. Current report timestamps and validation
receipts separate implementation, test execution, independent review/CI waiting
and merge. At this note's preparation, final remote validation and merge are
pending. Read #1145's final body/merge receipt for their completion times.
No publication occurred and no release is authorized.
