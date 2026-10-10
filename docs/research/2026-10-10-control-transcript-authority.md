# Native transcript authority through Stop, Resume and Close

This step of the [completion checklist](2026-10-09-daemon-core-completion.md)
extends eager native evidence from binding to the lifecycle consumers. An unreadable,
incomplete, replaced or differently owned conversation holds the operation with its
reason. It cannot authorize a signal, launch, archive or partially published checkpoint.
No service or lazily loaded interpreter owns these decisions.

## Former-code goldens

Commit `340ab59ad9ca60fd36f2fb26645885b278941f4a` records the capture/checkpoint golden
from main `cc4983e1893494a653f84d861950efe5d6913590`, before implementation. Its 32
observations cover Claude, default/moved/profile/aliased Codex, written/unwritten Pi
and terminal sessions. Commit `6c06b697` separately records six healthy Resume
observations from main `0b2dd18f8`, before the Resume move. Both explicitly pin Linux
and macOS, the clock, private paths and placeholder binaries under `TZ=UTC TMPDIR=/tmp`.
Neither artifact changes in this implementation.

## Authority and publication

`controlTranscriptEvidence` retains the original physical file key and earns fresh,
bounded path, catalog and native-header evidence at each boundary. A long asynchronous
operation does not borrow an expired proof; an ordinary body append can still be valid.
Claude and Pi opening declarations run eagerly. The opening is tied to the descriptor
that supplied its bytes and compared with the saved proof's file key. Every consumed
identity, workspace and delegation field must agree. Pi also proves its canonical
workspace. An incomplete opening or an incomplete native-home catalog holds control.

Checkpoints open and retain their source descriptor, compare its key with the native
proof before reading, and copy in bounded chunks. The source snapshot is taken again
after asynchronous backup inspection. Reuse requires the physical key, exact size and
nanosecond change time as well as a private regular backup. Same-size body rewrites
cannot reuse stale history. Open, read, stat and close failures retain the previous
checkpoint and draft. Draft publication follows successful source closure and fresh
authority; manifest publication follows the completed private copy. Ordinary output
storage failures remain distinct from unavailable native identity.

Stop fences both the binding revision and the precise process birth across its awaits.
Native brokers and process helpers may contain callback errors, so the typed hold is
retained separately and checked before any next effect. The final archive receives the
proven parent conversation path, even if a delayed hook saved the prior child path.

Resume proves the saved source before preparation and carries a current-ownership
callback through configuration and the actual tmux dispatch boundary. A conversation
claimed by another live agent during permission or backend checks cannot acquire a
second writer. A reservation is released when dispatch is known not to have started;
once dispatch may have occurred, its uncertainty remains reserved for reconciliation.
The proven synchronous history repair can replace a file, so Resume earns new evidence
after that repair before its next await.

Close treats changed or unavailable activity drains as a hold. A failed activity read
clears obsolete idle evidence and preserves the waiting plan and its reason. Even a
secondary reason-publication failure keeps the preceding intent for the next tick.

## Regression and review evidence

Private composed tests exercise the real Registry, stopped store, checkpoint store,
native broker and tmux backend. They cover physical file substitution, ancestor
replacement and restoration, conflicting opening records, body rewrites, failures at
each source descriptor operation, contained grant/signal errors, competing conversation
ownership and uncertainty after dispatch. A regression run on former implementation
`ef13de889` fails by assertion when an ancestor moves away and back around opening the
checkpoint source: that code copied from the wrong descriptor while pathname checks
matched. The corrected implementation holds before writing history.

Independent review found and verified corrections for descriptor-bound copy authority,
contained native holds, final archive identity, opening-file substitution, contradictory
delegation and a new conversation owner before dispatch. The reviewer approved runtime
head `7ce86bc1558ff59fe44ce5cb8732ef2f60904f92` against base
`526d6bb9d081a5e8afbefd21ddefb28586570adc`, conditional on final gates and CI. Review was
read-only and independent of implementation. Both golden artifacts were checked byte
for byte, and the incoming router wiring was reviewed for interaction.

## Matched runtime cost

The [workload](../../cli/scripts/handoff-2026-10-08/control-transcript-cost.ts) compared
main `526d6bb9d081a5e8afbefd21ddefb28586570adc` with runtime head
`7ce86bc1558ff59fe44ce5cb8732ef2f60904f92`, using Node 22.23.2 on the same macOS x64
host, pinned Linux evidence, UTC and private `/tmp` homes. Forty-two fresh processes
ran alone, interleaving three samples per revision and workload. Each revision confirmed
645 operations. The [raw measurements](2026-10-10-control-transcript-cost.json) retain
every latency, CPU total, source byte count and outcome.

Numbers below are former → candidate. Latency is the median of the operation samples;
CPU is median per-operation CPU across the three processes; memory is median peak RSS
of those processes, including setup/imports. Setup, fixture writes and post-operation
byte-hash verification are outside operation timing. Checkpoint-large and reuse use
8 MiB bodies. Stop uses a confirmed absent process and private placeholder pane deletion;
Resume measures a dependency-held preparation, not a full vendor startup.

| Workload | Latency (ms) | CPU per operation (ms) | Peak RSS (MiB) |
| --- | ---: | ---: | ---: |
| capture-codex | 0.32 → 2.25 | 0.37 → 3.32 | 101.05 → 112.52 |
| capture-claude | 0.29 → 2.31 | 0.37 → 3.40 | 103.20 → 113.20 |
| checkpoint-small | 98.31 → 103.00 | 4.67 → 11.47 | 103.11 → 107.00 |
| checkpoint-large | 181.16 → 153.84 | 67.90 → 43.58 | 166.52 → 169.77 |
| checkpoint-reuse | 38.99 → 45.39 | 2.51 → 8.09 | 159.84 → 166.95 |
| stop | 98.33 → 107.63 | 4.69 → 15.20 | 105.58 → 116.95 |
| resume-held | 39.93 → 42.32 | 2.19 → 5.03 | 116.99 → 114.92 |

Fresh capture proof adds about 2 ms median latency; the complete Stop path adds about
9 ms on this workload. Checkpoint source verification and reuse incur more CPU. The
large copy was faster in these samples, which is not a claim about other filesystems
or larger histories. This is a same-host cost comparison, not a new performance gate;
the bounded-read and failure-isolation tests remain mandatory.

The standalone benchmark now retains an event-loop handle until its awaited work
finishes. Its first attempt exited at the daemon's unreferenced Stop timer and supplied
no complete measurement set. The final run completed 09:37:47–09:40:10 UTC. No other
validation ran concurrently.

## Validation and timing

On the frozen runtime head, receipt `20261010T092933.619874Z-98787` passed typecheck,
architecture and 274 affected tests in ten files, core/services at 100% in every file
(2,148 tests in 167 files), and harnessd at 100% in every file (265 passed, one existing
skip). Receipt `20261010T093105.734148Z-8974` passed all 602 Resume and composed native
tests in fourteen files, including both unchanged goldens, with 100% Resume coverage.
Resume ran alone to avoid contention. The deterministic input scopes exclude research
writeups and the standalone handoff measurement/mutation scripts, which these checks
do not load; they include runtime, tests, build/configuration, dependency and toolchain
inputs.

Earlier receipts were mixed, not full passes: three missing Resume coverage branches
needed meaningful regression cases, and the 512 MiB repair fixture exceeded its 30-second
deadline while competing with coverage. Its unchanged case passed alone in 19.8 seconds;
the other 288 cases in that earlier affected run passed. A focused run initially hit
sandbox uptime restrictions and a real alias-opening regression, both diagnosed before
the subsequent authorized green runs.

All 29 initial deliberately broken wiring variants failed by assertion after their unchanged
baseline passed, using `cli/scripts/handoff-2026-10-08/mutate-control-authority.py` in
an owned disposable worktree. The runner restores each changed file and requires a
behavioral assertion, not a compile failure. This includes the former-code golden
connections as well as physical identity, opening records, draft/checkpoint publication,
Stop grants and signals, Resume ownership/dispatch and Close retry.

The first ready-PR Linux run found three fixture failures. Two checkpoint tests used
non-JSON text in place of a native Codex header; their fixture now contains a matching
`session_meta` record. The older session-store golden also recorded successful capture
for an unknown Claude conversation and a delegated Codex rollout. These are named safety
corrections, not healthy compatibility cases. Its artifact stays byte-identical: the
test first asserts each exact former answer, then requires `IDENTITY_UNAVAILABLE` and
the unchanged original input. The child case retains its original null path; it does
not synthesize the formerly discovered delegated path after catching an error. All 18
tests in the two affected files pass. Removing this older golden's saved-conversation
hold also failed by assertion after its unchanged baseline passed, bringing the total
to 30 proven mutations. No product code changed for these fixture corrections.

Private acceptance covers the complete `ends`, `machine`, `races`, `enginehomes`,
`chaos` and `tmuxsocket` lanes, including the original mid-turn tmux crash and new
Claude/Codex unavailable-identity recovery cases. These use isolated daemon ports,
homes and explicit private tmux servers; the owner's daemon, homes and tmux server
are never targets. [PR #1139](https://github.com/autonomous-ai/openharness/pull/1139)
records their final exact-source receipt, automatic CI, review attestation and guarded
merge result. They remain required before landing.

Capture/checkpoint golden recording began at 07:45 UTC on October 10; the Resume golden
was recorded at 08:22. Implementation and independent review continued through the
09:24 corrections and clean integration of main. The successful unit gate occupied
09:29:33–09:30:54; the successful Resume gate took 90.7 seconds from 09:31:05. These
intervals overlap other work and are not added to estimate elapsed request time. The
original request began October 8 at 23:26:41; this continuation resumed October 9 at
22:25:51. CI/review waiting, merge and publication are tracked separately in the PR.
Publication remains zero. No release is authorized.
