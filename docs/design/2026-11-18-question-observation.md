# Shared question observation

The core owns questions. Actual application and tool connections own the interest in seeing them. This cut
replaces the Wi-Fi contribution to that interest with the device component's real local client, including its
initial state and reconnect reconciliation. It does not finish the remaining relay, recap presence, focus,
transcript or stream extraction in [package 12](2026-11-15-core-plan/wifi-input.md).

## Design

**Growth.** Reuse the local and remote connection lifetimes. Windows and remote apps observe all questions;
tools keep their existing eight named metadata watches and may explicitly observe question content. Content
observation and metadata watches share the existing 64-tool admission budget, counting a connection once.
Opted-in windows share that same 64 explicit-observation budget; ordinary window connection admission stays
unchanged. One exact count of implicit legacy windows avoids scanning their uncapped population. There is no
new global observer map, window connection cap, per-agent copy of an all scope, durable schema or
production datastore. Each bounded snapshot owns one iterator, canceled on replacement, disconnect or deadline.
The authoritative question map remains session state; pressure never truncates a question or deletes it.

**Concurrency.** The physical connection and observation generation fence every yield and callback. One
snapshot row may be outstanding at a time. Advance only after the actual send callback and a `setImmediate`
boundary. Live upserts and closes use the same ordered socket; each snapshot row is read from current state
immediately before its synchronous send. A repeated row is idempotent. Begin/end generation frames let the
receiver reconcile existing records in place, without a second complete map or an array of final IDs. An
incomplete snapshot never claims absence. Closes name the original question ID and cannot close a replacement.

**Read cost and scale.** Subscribe once, walk the existing map without copying it, then push changes. There is
no new polling, transcript read, replay effect or per-request Registry scan. New observation traffic uses the
same physical-socket accounting owner as client streams, with a distinct declared budget, not a fake service:

- Maximum serialized frame and aggregate outstanding bytes: 16 MiB each, globally across all physical
  observation connections and replacement generations.
- At most 256 outstanding frames per physical connection and 4,096 globally.
- Initial snapshot deadline: 20 seconds total, the existing local tool request budget; progress does not reset it.
- Capacity/deadline refusal closes only that observer with 1013. Charges retire only on the send callback or
  physical close, exactly once; logical unregister, timeout and replacement do not release transport ownership.

These are provisional implementation capacities approved for tests and measurement, not performance acceptance.
Measure ordinary 1/16/160-agent cases, the admitted maximum frame, 64 tools and replacement/saturation. Report
count/byte high water, refusals, snapshot completion and latency without content, IDs or paths. Compare CPU,
latency and memory before/after in a coordinated quiet slot. The existing unbounded app connection count and
authoritative question count remain explicit residuals.

**Serialized census.** Hosted screen replies are bounded to 1,048,576 serialized bytes. Question shaping can
repeat the question as key, text and permission dialog, giving a conservative three times source size plus
envelope/identities. Generated pane question IDs are fixed hashes, repeated in notification metadata. Default
Cloud service input is bounded to 6,295,552 bytes, but its accepted `cloud_q_` request ID has no length cap and
is duplicated in the output. Including both outer agent/session IDs and envelope gives a conservative
12,595,200-byte output bound. Built-in provider samples are smaller but do not replace this contract.

Inline Cloud and legacy admitted Registry IDs have no production aggregate length bound. Their new observation
frame may therefore be refused visibly while the legacy behavior remains intact. Count the exact JSON bytes
before allocating its serialized string, including escapes and lone surrogates, stopping as soon as the limit
is exceeded and without unbounded temporary arrays or strings. Never silently trim those fields.

**Compatibility.** Real existing windows/remote apps and named tools must use the shared interest contract in
this slice; the device component cannot be its sole consumer. Metadata `agents_watch` behavior stays intact,
including its bounds. The existing unsolicited full replay on ordinary tool `machine_select` is preserved;
changing that public behavior requires its own caller test and compatibility note. New observer clients opt in
with `questionProtocol: 1` at select, suppressing only their legacy replay before their bounded subscription.
The connected frame confirms that version. An old daemon without that confirmation is visibly unsupported
before the helper subscribes; its already-triggered legacy output is an old-server limitation, not a bounded path.

The legacy application adapter sends exactly the old question rows followed by one complete
`commander_questions_open` ID list. Mobile interprets each such list as the whole state: paging it or sending
an empty list before rows incorrectly closes still-open questions and changes notification timing. This old
adapter remains **unbounded**. Its removal date must derive from the first shipped public clients that support
the new generation protocol, not from unshipped code dated today. No mobile implementation or broad public
client migration belongs to this slice. Cloud questions remain local-only; gateway guest filtering is retained.

**Migration and rollback.** No persisted data changes. Disconnect destroys scopes/iterators. A component facing
an unsupported observer reports unavailable; it never selects itself as a window, commander or dial. The
existing immutable private-worker cohort gate handles private cutover. It does not retire public app compatibility.

**Audience and identity.** Only authenticated local connections may request the new content observation. A
remote request cannot claim local authority. Existing app and guest audience checks remain. Observation is
read-only and grants no answer/input lease. Existing core session/engine checks continue to own every answer.

**Failure.** Malformed scope replacement preserves the current one; admission refuses by name. Capacity,
disconnect, oversized state and incomplete snapshots are unavailable, never successful readiness. No input
effect is retried. A device component owns one shared observation snapshot. At most one hello waits per real
relay client; duplicate pending hello is refused. After awaiting readiness, check the original client
incarnation/identity before replying. Preserve `hello_result` before replay/events. Validate the existing relay
client bound rather than adding a speculative cap.

**Platforms.** Common TypeScript over the existing authenticated Unix socket or Windows named pipe; no TCP
fallback, new launcher or native API. Explicit inline mode uses the same observation client semantics. Native
Windows process-isolation evidence is a separate integration gate; host mocks do not prove it.

## Actual component cutover

`startWifi` owns the local tool observation while it has a real relay audience. The external adapter uses the
configured local connector and authenticated machine selection; inline uses the same socket. No Wi-Fi entry
is added to a core daemon-query allowlist. A reconnect completes the snapshot before advertising restored
readiness. Existing device question records receive generation marks in place, and repeated IDs do not create
duplicate `question.open` notifications when their question and permission content are identical. A same-ID
content update remains a live event. The consumer retains the old cloud choice-only policy in its process.

Once that client is functional, stop question frames at the former Wi-Fi card adapter and remove
`wifiCore.connected()` only from the question-interest predicate. Keep summary/tool/error cards and unrelated
recap/presence/feed behavior until their own extraction. The old route and new route must not both feed questions.

## Checks selected before implementation

Focused red/green tests cover actual window/remote/named-tool registration and cleanup, shared admission,
legacy frame order, Wi-Fi as the only observer including a nonfocused agent, initial/reconnect question state,
stale close and replacement ordering, physical callback/close accounting, JSON escaping/oversize, snapshot
deadline and saturation, cloud/guest audience, duplicate hello and identity change during readiness. Run one
worker after the coordinator releases its quiet benchmark slot. Required core coverage, architecture, e2e,
typecheck and before/after cost checks remain integration gates; do not claim them from focused tests.

## Focused implementation evidence

The focused gate passes 196 tests in 12 files with one worker. Each changed covered core/service file
(`questionObservation`, `questions`, `toolWatches`, `wifi`, `wifiProcess`) has 100% statement, branch,
function and line coverage. TypeScript and the architecture suite pass. Caller regressions cover an
opted-in window receiving one scoped path, repeated select, same-ID replacement, independent metadata
admission, malformed helper frames, same-ID content updates and the last pending hello leaving.

Exact preflight counting rejects accessors and callable `toJSON` before they can change the serialized
value. A counting or serialization failure stays inside the physical sink and settles its callback once.
The existing two-mode Wi-Fi e2e question case now closes its only window before asking from the device;
its real-daemon run, merged stream accounting, full core gate and cost acceptance remain pending.
