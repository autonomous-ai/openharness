# Native mutation authority

The next part of the daemon completion checklist addresses a concrete native
mutation failure: OpenCode v2's model switch may have committed even when its
reply or subsequent read is unavailable. Repeating the write can overwrite a
later native choice. An unreadable model catalog also currently permits a write.
Retarget retains a mutable registry row across asynchronous reads, so an old
request can act after its conversation or process changes.

The healthy protocol is recorded from main `f0875b08a` in
`cli/src/engines/nativeMutation.golden.spec.ts`, before implementation changes.
It exercises the eager launch-control entry and the declared native protocol on
pinned Linux and Darwin platforms, with private homes, UTC, fixture paths and no
host executable. The existing OpenCode launch/retarget golden remains an
additional production-wiring check.

The intended correction is to retain uncertain writes for read-only
reconciliation, refuse mutation without complete required catalog evidence,
and check immutable operation ownership before native effects and publication.
Failure tests must show the old violation first. This does not claim that manual
lifecycle requests or hook delivery are already durable across a daemon crash.

## Prior phase

The asynchronous version probe and concurrent hook-installation fix landed as
[#1149](https://github.com/autonomous-ai/openharness/pull/1149),
`f0875b08a75e8b1895e2c2fea50b32fed05cadbe`, October 10 at 16:14:29 UTC.
Independent exact-head review, 25 assertion-failing wiring mutations, all local
coverage gates, automatic CI and the full private end-to-end workflow passed.
The final main integration also passed 82 Memories tests and five rebuilt daemon
tests. The merge helper verified the complete tested tree. No release occurred.

This phase began October 10 at 16:15 UTC. Implementation, validation, review/CI
waiting and merge durations will be recorded separately in its PR.

## Implemented boundary

The eager native model controller keeps at most 256 live pending conversation
receipts. Catalog failure prevents dispatch. A lost write reply is followed only
by reads, including on later requests; an unresolved receipt is never evicted to
make room for another write. Store/folder changes and legacy version fallback
cannot bypass it. Confirmation must name the exact session and requested model.
Native command resolution is asynchronous, children have time/output bounds and
closed stdin, and a retry retains its selected executable path.

Retarget snapshots the registry row and restart revision, rechecks ownership
after asynchronous preparation, and passes that authority into the final signal
and tmux write boundaries. Its discovery hold belongs to the operation through
publication. A slow confirmation cannot expire it, and an older finally cannot
release a newer Stop's hold. Replies distinguish a confirmed or uncertain native
change from a later replacement failure.

The initial five fault tests failed on the former implementation. Independent
review then found across-request replay, wrong-session confirmation, release of a
newer Stop hold, hidden partial effects, version-fallback bypass, and expiry of a
still-owned route. Each has an assertion-based reproduction and a regression.
The first complete private daemon run passed all eight tests in the eager
OpenCode/hooks lanes, including lost replies, unavailable confirmations, another
native choice, and Stop during a pending read. It exercises a private native API
fixture and the actual daemon, not a new claim about vendor API semantics.

The healthy native-mutation and existing launch golden artifacts remain
unchanged. Mutation tests deliberately break protocol fields, admission, live
receipt retention, response identity, version fallback, stream closure, session
ownership, route lifetime, failure reporting and final tmux/signal fences.

## Still unfinished

These receipts survive requests in one live core, not a daemon crash. Manual
lifecycle intent still needs its durable journal. Retaining an executable path
does not provide the whole-launch inode snapshot. Unknown-version retry policy,
v1 SQLite uncertainty/missing-row handling, durable hook preparation, and atomic
generated-configuration publication remain on the completion checklist. This
change must not be described as completing those boundaries or the whole refactor.
