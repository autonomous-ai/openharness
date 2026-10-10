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
