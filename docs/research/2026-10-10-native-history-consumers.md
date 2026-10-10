# Native history consumers: baseline and completion scope

The remaining path-only native-history consumers are reviewed deletion and Change
agent handoff. They must use the same complete native identity and home evidence as
binding and lifecycle control. Unavailable or changed evidence must not authorize
reading another conversation, deleting history or publishing a partial handoff.
This is part of the existing [completion checklist](2026-10-09-daemon-core-completion.md).

## Former-code golden

`nativeConsumers.golden.spec.ts` was recorded from unmodified main
`526d6bb9d081a5e8afbefd21ddefb28586570adc` on October 10 at 09:46 UTC, before any
implementation move. Its 38 observations explicitly pin Linux and macOS, the clock,
UTC, private fixture paths and allocated-block facts. Host binaries, including Node,
tmux and git, are forbidden. The actual native files, inspection/deletion helpers,
handoff provider, transcript reader and document writer run in the fixture.

The record covers Claude, default/moved/profile Codex, Pi and terminal history;
verified missing-file cleanup; and twelve own, fork-parent and discovered-conversation
handoffs across the two platforms. Only disposable files created by this test are
deleted. Workspace folders remain. Recording and unchanged replay passed, followed
by typecheck; an initial typecheck required acknowledging the filesystem API's optional
missing-stat result in the fixture wrapper.

## Reviewed history deletion

The first migration is reviewed history deletion. It uses the eager native transcript
proof shared by binding and lifecycle control, including the current home catalog,
conversation header and physical file. A review keeps immutable identity and earns
fresh evidence before Stop, after Stop and immediately before unlinking. Missing-file
cleanup proves absence in the same owned physical parent on every boundary; it cannot
silently switch to a recreated parent or an unavailable catalog. File identities use
exact bigint device/inode values.

Unavailable evidence preserves an unexpired confirmation until native history has
been deleted, including after Stop or a completed worktree removal. The reply carries
its reason, reports completed work and is retryable; recovery permits the same
confirmation for the remaining stage. Completed worktree removal is never replayed.
A changed binding or runtime cannot reuse the old review. Appended turns of the exact
conversation remain eligible for the person's confirmed deletion. The bounded review
map refuses excess previews rather than evicting an unexpired or in-flight confirmation.

Independent review of the first implementation found a pathname/inode race, missing
ownership revalidation after the worktree await, healthy Pi combined-deletion failure
and confirmation eviction under capacity pressure. The corrections bind canonical
path and inode through one verified route, retain typed final-read holds, recheck saved
and shared ownership before erase and preserve pending confirmations. Pi gets a narrow
operation-owned workspace-removal proof: completion permits only the removed physical
subtree to disappear; observed external ancestors, aliases, transcript identity and
header workspace remain fixed. A recreated root is held. A new explicit review of an
already absent Pi workspace requires a proven absent leaf under its present, owned
parent. It cannot infer absence from a dangling alias or missing ancestor.

The former implementation failed behavioral assertions for wrong/incomplete/delegated
headers, changed same-inode headers, unavailable home catalogs, missing-file cleanup
and lost confirmation recovery. The first new incomplete-header fixture accidentally
used a complete JSON object without a newline; the native Codex header contract accepts
that complete record. The regression now supplies actually incomplete JSON. One legacy
spec now requires the earlier hold before Stop instead of the former refusal after
Stop. All healthy golden artifacts remain unchanged.

### Validation selected before the final run

Typecheck, architecture, full core/services coverage and harnessd coverage; the native
consumer golden, native-history authority/deletion, purge, checkpoint, worktree deletion,
transcript-binding and native path/descriptor consumers. The full private `ends` and `serviceProcesses` lanes cover
both native engines, held deletion and same-confirmation recovery, plus search outage
and recovery. Tests use disposable homes/ports and explicitly private tmux sockets;
`TMUX` and `TMUX_PANE` are unset. No owner data is read or deleted.

Sixteen deliberate wiring faults must fail behavioral assertions after their passing
baseline, including a broken healthy golden result. Matched inspection/deletion costs
use two revisions, the same host/toolchain and four private workloads, each sample in
its own process. CPU, memory and latency are reported without inventing a performance
threshold. Final results, independent exact-head review and merge evidence follow.

## Remaining handoff migration

Carry exact native identity through asynchronous handoff reads and final publication. Retain the former healthy
golden unchanged; add concrete incomplete, replaced-file, changed-catalog and stale
ownership regressions, with assertion-failing wiring mutations. Select coverage,
affected private lifecycle/handoff acceptance and matched cost checks before running
them. Independent exact-head/base review and all required CI checks precede the
authorized merge. No release is authorized.
