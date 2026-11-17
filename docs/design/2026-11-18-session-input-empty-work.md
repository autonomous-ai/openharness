# Session input without empty queue work

## Design

The shared writer must keep its binding, caller, cancellation and uncertain-outcome checks. A bounded
profile of 2,000 tracked and correlated writes at 16 agents also found work with no queued message or
pending fingerprint to act on. `drainOne` can register an empty move-gate callback and start an async
drain. `dropExpired` replaces an empty queue with another empty array. `onTurnStarted` hashes a prompt
even when no delivery or submitted message needs matching.

Return when the queue is empty in `drainOne`, in `drainNow` when an earlier gate callback is consumed,
and in `dropExpired`. Keep the current-state checks and every nonempty queue branch. This changes no
ordering, capacity, deadline, refusal, writer release or dispatch check.

Compute the observed prompt hash lazily at each actual fingerprint comparison, sharing one optional
local value for that call. A callback can reenter synchronously, so a snapshot taken before callbacks
is not sufficient: a pending receipt found afterward must still compare the real prompt. Keep hash
creation for active input and all match, mismatch and early-start behavior.

No record, cache, subscription, timer, queue or schema is added. Prompt content has the same existing
owners and lifetime, with no new log or measure containing it. Public/device/journal formats and
rollback behavior are unchanged. These are common TypeScript paths on macOS, Linux and Windows;
host tests do not establish native Windows behavior.

## Evidence and checks

The source comparison is `11bca810e4b5f781d686308a6971a41dec83c629` to
`0c190a62ae26d614d975d7c20f31762d07b2e4aa`: two fresh owned processes, 160 preparation and 2,000
measured writes per route. Inspector CPU samples used 100 µs and allocation samples 32 KiB, including
collected objects. It is diagnostic evidence, not timing or retained-memory acceptance. The separate
nine-case comparison remains on performance hold.

`dropExpired` and `drainNow` sampled self time totals were 4.566 ms tracked and 11.348 ms correlated;
estimated self allocations were 3.411 MiB and 7.135 MiB. Fingerprinting and its native descendants
sampled 20.458 ms and 29.936 ms. Required input facts, resolve calls and binding/authority checks remain
explicit costs, and this correction does not promise to remove the entire measured difference.

RED checks cover empty move-gate work and standard array allocations without inspecting private
queues, and real prompt-hash calls when no match is pending. Preserve pending matches/mismatches,
early start during an in-flight write and callback reentry. Then run the focused controller, core input,
receipts, deliveries and real Wi-Fi bridge tests, applicable strict coverage and types. Any new cost
comparison requires reviewed frozen sources, unchanged declared counts and the coordinator's quiet slot.

Author validation: five new checks failed first (false move-gate activity, 400 empty array copies, two
unneeded observed hashes and one premature-start hash). All 293 focused behavior cases then passed,
including pending match/mismatch and callback reentry. Existing acknowledgement callers complete the
strict input/deliveries coverage at 100% on all four metrics; types pass. These are functional and
work-count checks, not an uninstrumented timing acceptance result.
