# Pane capture authority

Runtime review found that pane polling and reconcile passed a mutable registry row
through an awaited capture. A rebind during that read let an old footer update the
new conversation. The same capture pattern was present at native-reader attach.
This is a pre-existing race, separate from the runtime profile extraction.

Commit `b73c05997` records failing tests against main: both leased and unleased
captures return an old pane after the session changes. The terminal boundary now
copies binding, process and route identity before waiting, and refuses changed
identity after lease validation or capture. Ordinary activity updates do not
invalidate the read.

Independent design review identified a second window: the registry can change in
a queued microtask after the terminal guard but before the profile consumer runs.
Profile owners therefore capture and consume under one operation. They retain the
original binding, state object and monotonically increasing evidence revision.
The local owner checks before ingestion; the worker owner checks before joining
its request queue, at dispatch, and when the worker returns. Forget, rebinding,
route/process changes and newer control/evidence invalidate the capture. An empty
or stale capture publishes nothing; an unavailable worker leaves accepted state
unchanged. No core control depends on a worker becoming available.

Reconcile, periodic profile polling and the five attach captures all use this
operation. Agy turn closing consumes the raw capture under separate binding, normalizer
identity and transcript/turn revision checks, before waiting for profile acceptance.
A newer chip update cannot suppress a valid idle-history close; a newer turn or
rebind cannot authorize closing or replaying the old history. The check is repeated
after the profile promise settles. Superseded history is distinct from a finished
turn: it produces neither replay nor a historical settlement notification. Returned
profile text is not an authority receipt. Native interpretation stays with the same owner; fixture bytes for
the runtime and transcript goldens stay unchanged.

Validation is planned before running: typecheck; architecture; core and harnessd
coverage at 100% statements and branches; affected terminal/profile/attach specs
and unchanged goldens; isolated e2e for readers, model control, models, core,
lifecycle and machine crash/resume. Deferred tests exercise the real terminal
boundary plus local profile owner, including the promise handoff window. Worker
tests cover control changes during capture, while queued and during its reply.
All runs use UTC, `/tmp` and private daemon/tmux/native-home fixtures. The first final-head run passed typecheck, core/harnessd at 100% and 205 affected
tests (`20261009T064606.422437Z-31957`). Independent review then required the
separate Agy turn decision above, covered by seven new attach races and a real
normalizer close/reopen revision test. Final receipts, exact-head review and merge
timing follow in the PR body.

## Previous follow-up completed

The same-millisecond pane fix (#1091) merged as `47d2f5a6b` at 06:38:42 UTC.
Its final head `c8650aa1f` was independently approved against `a9895b02c`.
Typecheck, core/harnessd/resume coverage, 137 affected tests and 22 complete
core/lifecycle/machine e2e cases passed. The earlier affected suite and Linux shard
failed an old migration assertion that expected timestamp-only labels; the final
test requires the correct prefix and UUID and exact returned rename arguments.
[Final CI](https://github.com/autonomous-ai/openharness/actions/runs/37894181341)
passed every selected check and `ci/required`.

Implementation/regression work ran approximately 06:24–06:28 UTC; the migration
expectation correction finished at 06:33. Validation and e2e ran 06:28–06:34,
overlapping independent review. CI waiting followed; merge ran 06:38:28–06:38:42.
The follow-up took about 15 minutes; total request elapsed through that merge was
7 hours 12 minutes 1 second. Publication remains zero.
