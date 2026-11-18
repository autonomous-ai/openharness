# Error cards in recaps

## Design

The core publishes the same app `error` frame with its original message, agent and database-session
address. It no longer formats a device card. Input rejection and native turn failure then notify the
existing recaps lifecycle with a `failure` event containing only the captured agent/session ids,
optional engine, original message and optional distinct `failureSummary`. These are current session
facts, not a new query, retained catalog or feature-specific broker. No formatter or service code is
loaded by the core.

`InputDeps.failure` and `createEventFunnel`'s `failure` callback receive this captured value after the
unchanged app publication, in the same phase where the old commander frame was constructed. The
composition delegates to `TurnRecaps.failure`; that forwards the existing `RecapsPort.lifecycle` notice
with current watcher facts. No await, request map or replay is introduced. A stopped or failed recaps
component costs this optional card; it cannot suppress the preceding app error or interrupt session
input/error settlement.

The recaps component moves the existing `deviceErrorText` implementation verbatim out of core. It
formats `failureSummary ?? message` with the captured engine and constructs the exact old
`commander_event { agentId, dbSessionId, payload: { kind: 'error', text } }`. The common existing card
publisher sends the immutable frame to its WiFi gateway peer and through `core.clients.turnCard` for
cable and legacy gateway recipients. Failure cards retain their old unconditional delivery while the
component is available: they bypass the summary/processing watcher gate. WiFi continues to ignore the
recaps-tagged copy on its session feed, so the direct peer is the only WiFi delivery. No new recipient,
caller-selected address, publisher rights or public fields are added. Raw and short failure messages
remain distinct; an empty supplied failureSummary is not replaced by the original message.

Only the new failure notice is byte-counted before serialization against the existing 4 MiB recaps
buffer allowance, and its size plus pending bytes must fit before notification. No truncation or
unbounded queue is added. Inline and external recaps validate the same string-only failure shape and
4 MiB maximum before formatting. Oversized/malformed optional cards are refused by fixed diagnostic
code without logging message content or ids; app errors remain unchanged. The existing throttle on
recaps-link drops still bounds diagnostic volume. Failure records are never added to the component's
session map, recap history, replay state or disk.

The unreleased worker contract remains 3. This variant alone does not claim new mixed-artifact
admission: the final combined build's separately reviewed capability/plan change is the cohort boundary.

### Session addressing

Every recaps commander card keeps its captured agent/session address. At the existing CoreApi
`clients.turnCard` publisher, the registry must still contain that exact pair immediately before
publication. This is shared by all recaps card kinds, not an error-only rule, and retains no state.
The check linearizes at that synchronous registry read. Cloud's separately admitted publisher and
session-addressed app summary frames keep their existing paths.

The direct WiFi peer does not traverse that publisher. After the existing summary/feed barrier, it
resolves the captured agent with the existing generation/machine-fenced conversation query, checks the
returned agent/session pair and rechecks its peer/feed/core owner before emitting. This linearizes at
the query's existing core read, after applying its prior service-notice prefix; it cannot promise that
another process will not mutate after replying. Unknown, deleted and rebound sessions are dropped.

The cable consumer retains a predicate for session-addressed local commander cards, reading its
existing advertised rows (including Cloud rows). It checks before translation, on entry to its existing
per-agent queue and after delayed token/tier work. No extra refresh, queue or cache is added. This read
linearizes at the component's current advertised view. Legacy cards without a session address keep
their existing behavior; malformed supplied addresses refuse. Remote fleet and question paths stay
unchanged. All card kinds retain same-session delivery, including inactive registered sessions.

## Validation

Actual REDs first: input and native failure must keep raw app frames, invoke the raw lifecycle callback
(including a distinct failureSummary), and produce no core commander frame. Recaps must emit the exact
old formatted card through both existing recipients once, including no watcher, absent peer, empty
summary, missing engine and reentrant publication controls. Off/failing recaps must leave app/input
behavior working. Bounds tests exercise oversize, queued-byte exhaustion, malformed data and recovery
without retained failure replay. Existing formatter cases move with the implementation.

Selected source gates include input, funnel, recaps core facade/link and component/process, their real
WiFi/card consumers, architecture import/file accounting, per-file coverage and types. The parent
reviews the implementation diff before commit. Packaged/native checks and timing remain coordinated
integration work; Windows validation is deferred and mobile is excluded by the user.

Session-fence REDs cover same-session cards, rebound/deleted/unknown addresses at the core publisher,
WiFi's held resolve and existing disconnect/peer/core guards, plus cable cards waiting behind a held
summary and a summary changing session during its tier decision. These use real consumer methods;
there is no simulated new authority or sleep-based ordering.

### Source evidence, 2026-11-18

Pinned Node 24.22.2 and the existing immutable main-86558 dependencies were used. The actual REDs are
`/tmp/core-error-card-red-actual-20261118.log` (three failure-routing assertions),
`/tmp/core-error-card-session-red-20261118.log` (five publisher cases and the cable queue case),
`/tmp/core-error-card-session-wifi-red-confirmed-20261118.log` (three real peer cases), and
`/tmp/core-error-card-bound-red-20261118.log` (complete notice plus queued bytes). Earlier malformed
test insertions and peer fixtures that omitted required `fullText: null` remain failed fixture evidence,
not behavior REDs.

The first 814-test gate passed. Receipt `20261118T084135.150170Z-97977` then passed 942 tests and the
134-test architecture/cohort selection, but failed coverage and fixture types. Corrected caller
fixtures and the expanded existing caller selection passed 1,205 tests and types in receipt
`20261118T134759.582514Z-12588`; its coverage gate still lacked one existing Messages API function.
Receipt `20261118T134954.331360Z-14385` passed that function's real Messages caller (17 tests), merged
the unchanged-source coverage, and enforced 100% statements, branches, functions and lines for all
nine selected runtime files. No failed gate is described as passing. The unchanged architecture/cohort
result is reused; composition `main.ts` remains covered by architecture and later packaged validation.

This is source validation on macOS. The new process hop and per-card WiFi resolve have not been
accepted by a packaged or timing run. Those runs remain parent-coordinated, alongside the separate
complete-view transfer gap; this slice does not claim those acceptance steps are complete.
