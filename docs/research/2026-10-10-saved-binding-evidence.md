# Saved binding evidence and recovery

This step of the [completion checklist](2026-10-09-daemon-core-completion.md) moves
saved-binding validation and Codex parent repair onto eager native evidence. A
partial, unreadable, changing or ambiguous source keeps the original session id,
transcript and ownership with a visible `identityHold`. The next discovery pass
retries that same live binding without waiting for an optional engine worker.
Daemon readiness and sibling sessions remain independent.

## Former-code evidence

`8cd510844e4e152d28d6486e65b5572508a86a07` records the healthy binding golden in its own
commit, before implementation. It was recorded from then-main `9eafacf3b` and replayed
unchanged after integrating main `c7d460b1d` (#1132). The artifact contains fourteen
observations: seven each under pinned Linux and macOS platforms. It covers saved
rows, path admission, moved/profile homes, Stop capture and terminal registration.
The fixture fixes the clock, uses UTC and `/tmp`, and forbids host subprocesses.
Neither that artifact nor older golden artifacts are re-recorded for this change.
Three older unit fixtures gain the complete native `cwd` field their healthy Codex
header was missing; the parser contract is unchanged.

## Boundary

`engines/transcriptBindings.ts` owns saved path/header admission and parent repair.
`kit/nativeFiles.ts` retains a fresh bounded descriptor, header and directory proof
for one operation. Native path resolution and first-record parsing are shared with
existing descriptor evidence. The resolver observes aliases component by component;
a matching spelling alone never establishes directory membership. Reads use the
opened file identity, owner, type and stable complete header. Ordinary body appends
after a completed read remain valid. Exhausted read, candidate, directory or time
budgets hold the decision.

A registry load stages all rows. Its explicit root scopes share present, absent and
alias ancestry within that operation only. Each row retains its own file/header
proof; one row's failure does not hold its siblings. Final row proofs, then root
scopes and the fresh catalog proof, run before any row is indexed. A failed root
scope restores every affected staged binding. There is no cross-operation root
cache. Parent repair must examine the complete declared walk pool, including
candidates excluded by metadata; the existing dotted-directory exclusion remains
part of that declared lookup contract.

The initial independent primitive review found three defects, corrected with
regressions: missing announced files needed a retained parent-owner check; parent
repair needed physical membership checks after following links; and a dangling
leaf alias could borrow its original parent's authority. The last is an explicit
safety correction to an existing unsafe corner, not a healthy golden change.
A genuinely absent leaf is distinguished from an existing dangling alias.

`Registry.revalidateBinding` retries a held saved binding without rebuilding the
registry or restarting the daemon. Successful registration or proven binding
release clears its transient hold. Discovery contains registration/read failures,
announces changed reasons, and does not archive, unbind or save unavailable evidence.

The composed review found three further defects. Held rows could enter attachment;
recovery could retain an inline parser of the old path; and cleanup after releasing
the session index lost its agent key. Discovery and interpretation now defer held
bindings, delayed reads lose authority when a hold arrives, and recovery rebuilds
both unchanged and repaired paths without replaying saved history as a new turn.
Agent-scoped input and scopes use the retained agent id during cleanup.

Review also found a concurrent-write hazard. Revalidation now stages its candidate
without changing the live row or indices. Inside the registry write lock it compares
the exact durable baseline, re-verifies native evidence and commits before publishing.
A peer's newer binding is preserved. A complete discovery batch may commit there;
an incomplete batch or failed write holds the retry. Two independent Registry
instances cover same-path recovery, release and parent repair against a peer write.

## Validation plan and progress

The required plan is typecheck; architecture; core/services and harnessd per-file
100% statements/branches; touched binding, registry, path/header and native golden
specs; composed resume coverage run alone; private engine-home, machine and chaos
lanes; and the available private tmux fixture rows. Automatic ready-PR CI supplies
the full Linux default suite. Mutation checks run only in a separate disposable
worktree after their unchanged baseline passes. Runtime measurements run alone,
interleaving former and candidate processes on the same fixtures and Node toolchain.

Development checks have passed 102 focused tests, including unchanged binding and
session-store goldens. The new private e2e proves that an incomplete saved Codex
header retains its binding and visible hold while readiness and a Claude sibling
work, then recovers in place and takes a turn without another daemon restart.
The e2e fixture initially read a transcript path from a public frame which correctly
does not expose it; it now reads only its disposable daemon's private registry.
An initial registry unit run was invalidated by macOS sandbox rejection of uptime;
the authorized rerun isolated one incomplete healthy header fixture, now corrected.
Final receipts, exact-head review and measured results follow before landing.

The initial full validation receipt `20261010T021955.961388Z-42225` passed types,
274 focused tests in 14 files, architecture, core/services (1,960 tests, 100%),
harnessd (265 tests, 100%; one existing skip), 35 private engine-home/machine/chaos
cases and 57 private tmux cases. Fifteen installed-vendor tmux cases are explicitly
excluded because those tools are not installed in the fixture. After the composed
review corrections, core/services passed 1,977 tests in 163 files at 100% statements,
branches, functions and lines (27 seconds, October 10 02:40 UTC); typecheck passed.
The current e2e case additionally appends a valid turn under the incomplete header,
asserts no held-session turn is emitted, and runs with workers and explicit inline
mode. Final affected lanes and composed resume are rerun after these changes.

## Matched runtime cost

The [raw measurements](2026-10-10-binding-evidence-cost.json) compare main `c7d460b1d`
and this implementation, using Node 22.23.2 on macOS x64. Three interleaved fresh-process
repetitions of `937e9e6d4` ran alone 04:08:13–04:09:34 UTC (36 processes). Each process measured five
complete operations after fixture setup. The registry workloads completed all 12,030
row decisions; native descriptor workloads produced the expected unique bindings or
ambiguity holds in all 90 calls. No held result was counted as a successful binding.

| Whole operation | Former median latency ms | Candidate median latency ms | Former/candidate process CPU ms | Former/candidate peak RSS MiB |
| --- | ---: | ---: | ---: | ---: |
| One saved row, one home | 42.46 | 44.36 | 18.50 / 22.99 | 95.26 / 94.07 |
| 200 saved rows, one home | 83.07 | 96.19 | 275.07 / 361.36 | 195.11 / 131.97 |
| 200 saved rows, 63 homes | 168.87 | 131.08 | 667.31 / 538.08 | 142.89 / 132.12 |
| Native descriptor, one file | 516.32 | 517.63 | 135.69 / 138.57 | 107.00 / 104.49 |
| Native descriptor, duplicate handles | 521.47 | 514.99 | 140.80 / 139.69 | 106.90 / 104.10 |
| Native descriptor, competing files | 516.94 | 518.96 | 142.02 / 139.93 | 108.25 / 110.04 |

Latency covers a complete load or native lookup, including final proofs. CPU is the
median for a process's five operations; peak RSS is the median of process peaks.
The single-home batch pays for complete file/header evidence; sharing roots within
the operation reduces the former many-home traversal cost. These samples are cost
evidence for the specified workloads, not a host-independent performance gate.
The later first-Cancel correction affects neither measured import/call path; these
measurements do not cover active cancellation latency.

## Remaining scope and timing

This does not complete native identity as a group. Registration/hook admission still
uses its former entry boundary: its strict replacement must retain pending prompt
deliveries and commit admission before crediting them. The draft strict registration
was kept out of this change so a newly held file cannot become an unhandled HTTP
error or lost hook. Remaining Stop/resume/checkpoint consumers, saved-home selection,
Hermes optional home promotion, Cursor pending discovery visibility, launch facts,
durable lifecycle intent and the other named completion groups remain open.

## Recovery control review corrections

The independent composed review found that replacing interpretation could lose a
Cancel or apply it to a later turn. Core now retains ordered cancellation boundaries
for the conversation, including the first ordinary Cancel before any outage, successful replacement,
another reset, repaired path, and worker reconstruction. A new explicit Cancel can supersede a rewritten file;
an automatic retry cannot move the old decision to a later file position. Each
boundary records the regular file's device/inode and a digest of at most 1 KiB at
the beginning and boundary. This samples those bytes; it is not a digest of the
entire preceding transcript. Replay also checks its actual opened descriptor.
Incomplete or changed evidence keeps interpretation held with a reason.

The replacement is staged behind a core control handle. Parser, runtime profile and
watcher installation complete before the registry clears its interpretation hold.
Every await is fenced by a copied binding/evidence revision and the session lifetime.
Clearing a hold without authority cannot release the watcher's pending bytes.
Cancellation remains eager, never waits on a worker, and cancelled history does not
produce a completion recap. New prompts after the recorded boundary remain open.

Uncorrelated Stop is deliberately retained as an explicit hold. An empty parser or
an older completed turn does not establish which turn a delayed Stop belongs to.
Existing positive stale Claude timestamps remain usable; otherwise a subsequent
explicit Cancel resolves the hold. Exact per-engine Stop correlation remains in
completion group 4. Legacy readers that cannot replay ordered file boundaries hold
that interpretation rather than apply the cancellation to a guessed turn. Durable
control intent across daemon restart remains part of the lifecycle completion work.

The former core HTTP hook-admission golden was recorded separately from main
`c7d460b1d` in `d331c49a4`; its twenty Linux/macOS observations and artifact are
unchanged. Additional actual-composition regressions cover both inline parsing and
the real worker request/transport/reconstruction path. At 04:00 UTC, 209 affected
core tests passed at 100% coverage for the changed attachment, replacement-control
and turn-hook modules. Full gates, private lanes, mutations and review are still
required on the final source before this PR can land.

The task resumed October 9 at 22:25:51 UTC. This step's golden was committed October
10 at 01:39:46 UTC, while the preceding independent adoption validation finished.
Implementation and preliminary review corrections followed the #1132 merge at
01:43:24. Validation, independent review/CI waiting and merge time are recorded
separately in the PR and final receipts. Publication remains zero; no release is
authorized.
