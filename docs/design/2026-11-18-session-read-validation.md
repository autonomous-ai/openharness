# One component session-record boundary

## Design

The frozen v7 comparison matched complete outputs but did not accept full-refresh performance. At 1600
registered rows its fixed descriptive median WiFi refresh was 53.856 -> 185.893 ms wall and
53.933 -> 173.750 ms CPU. Core production alone was 52.926 -> 49.694 ms wall and 55.059 -> 31.987 ms CPU.
Those source/synthetic-transport measurements are not native socket acceptance; the packet stays immutable.

Current remote Devices refresh calls readCoreSessions then readSessionView. Remote WiFi calls
readCoreSessions through a synthetic CoreApi.agents.readSessions override, then readWifiView and
readSessionView. Both walk every full record with checked/boundedJsonBytes twice. Inline WiFi calls
readWifiView directly and requires its existing malformed-source validation. WiFi's current wrapper
reads machine and hasWindow between the two checks, so deleting either check alone loses a boundary.

Replace the component transport adapter with an explicitly unknown-valued raw record source, retaining
its physical transport call, synchronous settlement and no-queue behavior. readSessionView is the sole
checked boundary; after validation, before projection, it may call a typed component observer. This
observer cannot see an executable/malformed header or row. No new core API, wire record, resource bound,
catalog, cache, brand, retention map or authority is added.

Devices composes this source directly with its existing provisional projection. WiFi's process injects
one component-owned view reader into its existing component dependencies instead of synthesizing a
typed CoreApi reader. It captures the existing owner/core/machine binding; the typed observer checks
that binding on every record and checks header machine before any projection. It records hasWindow
locally, publishes lastView only after exact end/read settlement and a final binding check, and clears
only the current owner's window cache on failure. A stale completion cannot clear the replacement's
view. No lookup, identity handshake, cancellation or durable Create semantics change.

Inline WiFi defaults to readWifiView(CoreApi.agents.readSessions) and crosses the same one checked
boundary. readSessionView still owns record order/count, duplicate ids, complete end, byte admission,
provisional retention and successful-settlement commit. Physical acknowledgement happens only after
validation, owner checks and synchronous projection accept; throwing never acknowledges the record.

Actual-caller RED counts full-record bounded validation through the real WiFi adapter/view chain:
one begin, row and end must have one validation each instead of two. Selected controls retain malformed,
oversized/accessor/proxy, wrong machine, rebound/deleted ownership, identity ABA, incomplete end, failed
transport, current-owner window invalidation/recovery, inline malformed-source refusal and physical send
credit semantics. The next cost comparison requires separate review and quiet coordination; this count
correction alone does not lift v7's performance hold. Windows remains deferred and mobile excluded.


## Source checkpoint

Built in `/tmp/harness-core-session-read-once` atop frozen Create checkpoint `b2ee8435d9`.
Actual WiFi caller RED `20261118T160350.403307Z-27403` failed with six full-record validations for three
records, while the projected row matched. Initial GREEN `20261118T160515.442621Z-28977` passed 250
behavior tests in seven files; types correctly failed because one test collector still promised typed
rather than unknown records. Its declaration was corrected, without weakening the production boundary.

Final gate `20261118T160658.352196Z-31509` passes all selected behavior cases, architecture and types;
all five changed services files have 100% statements, branches, functions and lines. The actual WiFi and
Devices adapters each validate begin/row/end exactly three times in total. Additional controls assert
validation before typed observation, observation before projection, and no acknowledgement after owner
refusal. Existing current-owner-only invalidation, malformed/header/machine, reconnect/ABA, complete-end,
inline validation, resource bounds and durable Create lifecycle controls remain passing.
Plan: `/tmp/core-session-read-once-final-plan-20261118.json`; coverage configuration:
`/tmp/core-session-read-once-coverage-20261118.config.ts`.

This is source count/correctness evidence. Native Store Create preparation and v8 matched cost
remeasurement remain separate and unexecuted; the immutable v7 performance hold is not lifted here.
