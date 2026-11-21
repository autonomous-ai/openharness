# Desktop desk-state compatibility door

Status: source extraction and scoped validation complete; combined native and cost acceptance remain open.

The local WebSocket interpreted and retained `app_panes`, `app_swarms` and
`app_unread`, while `core/main.ts` retained another view for Devices restart.
Existing Desktop clients do not replay those lists when only Devices restarts.
They resend on their own socket reconnect or UI change. Removing the retained
state without a replacement would lose an unchanged desk after a Devices crash.

## Design

The three desk frame parsers, notification-read identity and old retention rules belong to the lazy
`lib/legacyDeviceWindowState.ts` owner, with pure normalization in
`lib/deviceWindowState.ts`, with the existing `lib/notificationRead.ts` helper.
`localWsServer.ts` reaches them through the bounded `lib/legacyDeviceWindowLoader.ts`
door. That loader is the only additional eager file; the three interpretation files
are excluded from the exact default core graph and tested file by file.
`core/main.ts` wires callbacks and reads that owner's snapshot for the unchanged
Devices replay contract; its independent pane/tab/unread variables are removed.

This remains component code and memory in the core process once an existing
Desktop sends a desk frame. It is an explicitly reviewed compatibility door,
not completed process isolation. No new Desktop capability, inactive protocol,
component journal or generic core cache is introduced.

### Data and identity

No data is newly persisted or exposed to another machine/account. The same local
owner socket supplies the same old public frame names and normalized fields.
`app_swarms` remains the ordinary-tabs compatibility payload; this change does
not restore the retired Swarm feature. Tab names, layout and notification text
remain RAM-only and are never newly logged.

Pane and tab rosters stay scoped to physical connections. Updates keep the old
latest-reporter ordering. Closing a background reporter does not change the
selected state; closing the latest restores the preceding live reporter. The
last reporter closing clears panes/tabs. The last unread snapshot deliberately
survives its reporting socket, as before. The old missing-foreground default,
24-tab/24-tile normalization and read-token handling are unchanged.

`app_swarms` still supplies all-tab session membership to the existing shared
OpenTabProtection. There is no unused `openAgents` reader: the current Desktop
does not supply that field, and this slice adds no Desktop migration.

### Lifetime, failure and bounds

The first lazy import must neither hold terminal input nor resurrect a closed
window. An accepted unread report survives a close during loading, while its
pane/tab membership is removed. Pending legacy frames must retain arrival order
across physical connections, including `agent_seen`; import failure must be
named and bounded. The final loader admission design and its caller tests are
recorded with validation evidence before integration.

The root review found a second consequence of that wait: an accepted `app_swarms`
report has not yet reached OpenTabProtection while its parser loads. Cleanup must
treat that physical window's membership as unknown, not as an empty list.
The shared cleanup guard will hold a window until its accepted roster is applied
or its physical connection closes. A load failure keeps the hold; a later valid
report can resolve it. Invalid reports cannot resolve evidence lost during a
failed load. This adds only per-window readiness metadata, not a feature snapshot.

The loader will admit one FIFO across physical connections, capped at 128 frames
and 8 MiB of copied JSON bytes, with a five-second first-load deadline. Terminal
dispatch never awaits it. The FIFO includes `agent_seen`, so a read notification
cannot overtake accepted unread state. Already parsed frames go directly to the
owner once loaded; only this finite loading interval copies and reparses bytes.
An import failure, deadline or overflow releases the complete pending attempt,
logs a content-free `LEGACY_DESK_*` reason and sends a bounded error to affected
live windows. A late import cannot adopt discarded work. A subsequent real desk
frame may make one further attempt; there is no retry timer or indefinite loop.
No terminal connection is closed merely to retry this optional feature.

Closing a window removes its pending cleanup hold. Accepted unread data still
survives that close; pane/tab membership is removed while draining any previously
accepted frames. Pending hold metadata is bounded by existing physical windows;
the aggregate input-retention limit is described below; physical-connection admission remains separate.
Stopping the loader cancels pending interpretation but does not release that hold;
the physical close does. Optional disconnect notifications cannot prevent roster
cleanup or backend unregister, and their failures log only `APP_DISCONNECT_FAILED`.
This does not claim that an older Desktop displays a newly introduced error
frame: operator logs are the failure surface, and cleanup reports its existing
`TABS_UNAVAILABLE` refusal while membership is unknown.

The existing public frame ceiling is 512 KiB. The correction below bounds the
encoded inputs backing current pane/tab/unread retention without truncating or
evicting accepted rows. It does not assert an exact heap or whole-core RAM limit.
The current transport's inbound Promise chain and physical connection count are
not aggregate admission bounds; they remain separate residuals.

No registry scan, periodic poll, timer-driven snapshot replay, disk write or new
network request is added. Before/after measurements cover first desk load,
ordinary updates, terminal traffic and retained heap. Root owns the final
combined runtime gate and the actual Devices restart acceptance.

### Retained-state bound correction, 19 November

The initial import FIFO is bounded, but successful loading removes that limit.
An owner can then keep a separate 512 KiB report for each physical window.
Before changing runtime code, the correction is defined as follows:

- Growth: the compatibility owner admits at most 128 pane/tab reporters and
  8 MiB of the encoded frames backing its current pane, tab and unread state.
  These reuse the existing first-load capacity. Replacing a report releases its
  former charge; closing a physical window releases its pane/tab charges. The
  one unread charge survives close, matching the existing public behavior.
  This is a bound on retained input, not an assertion about exact V8 heap size.
- Concurrency: admission and replacement are synchronous within the current
  owner callback. A refusal does not change the last accepted state or reporter
  ordering. Callback failure after admission does not erase its accounting.
- Read cost: charge the byte length already known at the transport boundary;
  do not reserialize, scan other reporters or poll. The owner keeps two small
  charges per reporter and one unread charge. No timer or process is added.
- Scale: 128 simultaneous reporting sockets and 8 MiB of current desk frames
  are explicit hard ceilings. A content-free `LEGACY_DESK_STATE_LIMIT` log
  identifies admission refusal. This does not claim a measured heap limit or
  bound the separate WebSocket inbound promise chain.
- Compatibility: all accepted old frame fields, order and reconnect behavior
  are unchanged. At the new aggregate ceiling, reject the whole incoming
  report; never truncate IDs or evict another live window. An unaccepted tab
  report keeps cleanup at its existing `TABS_UNAVAILABLE` refusal until a valid
  report fits or that physical connection closes. Capacity refusal is logged;
  no new error reply or automatic resend is introduced for older Desktop.
- Migration and rollback: no stored format changes. Restart clears the
  in-memory ledger and clients resend normally; rollback uses the old owner.
- Audience and identity: unchanged authenticated physical owner connections;
  no new account, login, network destination, stored content or telemetry.
- Failure: the loader contains the named limit error using its existing
  delivery-failure path. A later fitting report or close releases the existing
  membership hold. No automatic retry or terminal disconnect is introduced.
- Platforms: platform-neutral TypeScript in CLI macOS/Linux/Windows; native
  Windows remains explicitly deferred. Desktop/mobile source is unchanged.

Selected checks: actual loader/cleanup behavior at both limits, replacement and
close recovery, accepted unread lifetime, existing local-WebSocket callers,
normalization goldens, architecture and TypeScript. Measure unchanged ordinary
updates and retained heap with a private fixture before accepting the hot-path
change. This bounds the compatibility exception; it does not finish extraction.

### Removal condition

A follow-up must put all desk interpretation and retention into Devices and
provide ordering-safe recovery while existing terminal sockets remain connected.
An additive replay request alone is insufficient: after a restart, responses can
arrive in a different order and promote an older reporter over the previously
current one. An acknowledgement-only token also loses order if Devices crashes
between applying a frame and delivering its acknowledgement. A new component
journal would need a separate data, admission and performance review.

After that supported Desktop migration ships, preserve the previous thirty days
of clients. The actual release receipt must supply the compatibility expiry;
this source change invents no release or removal date. Then delete this door,
its normalization and retention, the legacy snapshot wiring, and its exact
architecture exception together.

## Validation and platforms

Selected checks: real local-WebSocket callers (normalization, latest/live close,
notification identity and terminal isolation), a deliberately held lazy import,
OpenTabProtection, DevicesLink replay, exact architecture closure, new-owner
coverage and TypeScript. No missing-module error is counted as a RED. The loading
lifetime caller and architecture gate first failed on the actual implementation.

Affected runtime: CLI macOS/Linux/Windows, with no new platform API. Validate
macOS here; root owns combined Linux validation and actual-process restart proof.
Native Windows is explicitly deferred by the owner. Desktop and mobile source
are untouched. No release is performed by this task.

## Evidence, 19 November

- Earlier actual held-import RED `20261118T234217.238021Z-45951`: a second terminal resize remains
  blocked behind the first desk frame. Architecture passes its explicit lazy boundary control.
- Root readiness RED `20261119T085832.861894Z-33026`: no pending-tab signal reaches cleanup while
  the accepted tab report awaits its owner. The assertion fails on a real selected local socket.
- `20261119T090324.974261Z-37975`: 143 checks pass, including the held-import caller; types pass.
  Two architecture expectations fail because notification identity also moved outside the eager
  graph. The exact inventory/door is updated to include that additional extraction.
- `20261119T090736.571461Z-42001`: 154 checks pass, one new fixture fails because its supposedly
  invalid token contains only valid alphabetic characters. The fixture now uses a space. Types pass.
  Incomplete normalization/fault coverage remains recorded rather than called complete.
- `20261119T091044.500935Z-45110`: all 171 checks in seven files pass; types pass. All five scoped
  runtime files reach 100% statements, branches, functions and lines. This includes the bounded
  loader, lazy owner, normalizers, unchanged notification identity helper and shared cleanup guard.
  The actual legacy wire/close/reporter goldens, held import, two import attempts, byte/frame limits,
  timeout, stale completion, malformed queued bytes, callback/refusal failures and cleanup holds run.
- `20261119T091608.249656Z-50395`: the actual cleanup preview caller refuses unknown membership
  with `TABS_UNAVAILABLE` and performs no inspection or stop; a valid roster resolves the hold.
- Shutdown RED `20261119T091723.745687Z-51592`: stopping the loader incorrectly allowed cleanup
  while the reporting window was still connected. The fix retains the hold until physical close.
- Disconnect RED `20261119T092357.499231Z-58349`: a throwing optional callback prevents backend
  unregister and escapes the socket close handler. The fix clears membership first and contains the
  optional notification failure. The first attempt `20261119T092237.462544Z-57081` used an incomplete
  fixture without its desk hook; it is not counted as the membership RED. The intervening batch
  `20261119T092305.010577Z-57389` passes 200 cases and types but fails that fixture.
- Final `20261119T092422.909031Z-58793`: all 201 tests in eight files pass, plus TypeScript.
  The five scoped modules reach 100% across all four metrics (270 statements, 210 branches,
  41 functions, 184 lines). This includes both corrected actual regression callers. Source review
  also confirms Devices reasserts focus after its changed ring is sent; core focus authority remains
  immediate and never waits for compatibility loading.

Optional presentation callbacks cannot prevent shared tab membership cleanup on physical close;
all maps are updated before guarded close effects. Unknown membership remains a named
TABS_UNAVAILABLE refusal, never an empty roster. No native restart, timing, aggregate retained-heap
or final combined coverage acceptance is claimed by those source-scoped checks.

The implementation review cleared the accounting and found that static inspection
of changed Desktop transport revisions does not prove every supported released
client's downstream error handling. The correction therefore logs capacity
refusal without sending `local_protocol_error` for this new persistent limit.
Other existing delivery failures retain their old replies. Shared cleanup still
shows its existing `TABS_UNAVAILABLE` refusal. This avoids adding reconnect
behavior at the ceiling without requiring a Desktop protocol migration. Each
refused report still has log/error-construction cost; inbound admission remains
an explicit residual.

### Retained-state correction evidence

- Independent design review: `/tmp/core-device-retention-bound-review/result.json`,
  receipt `20261119T180543.866088Z-25761`. The corrected callers use a distinct
  refused roster and establish a real refused membership hold before recovery.
  Admission precedes `hadPanes`, and invalid byte counts cannot poison the ledger.
- RED `20261119T180733.587721Z-27262`: both aggregate-capacity callers fail because
  the old owner never refuses. Revised RED `20261119T181146.626162Z-38595` preserves
  those two failures with the independent-review fixture corrections.
- Extended RED `20261119T181205.929268Z-39537`: all nine state-bound callers fail
  on missing refusal, including invalid byte accounting, order and close recovery.
- GREEN `20261119T181308.320371Z-42287`: 186 checks in eight files pass, including
  the actual local socket and exact architecture closure. All five scoped runtime
  modules reach 100% statements, branches, functions and lines. The separately
  named cleanup caller was not selected because that supplied path did not exist;
  its actual `core/agents/close.spec.ts` path and TypeScript remain to run.
- `errorKind` reads the fixed error code without its message or payload. Static
  inspection of all fifteen changed `ws_conn.dart` versions since 20 October
  found no `local_protocol_error` handler or reconnect in ordinary dispatch;
  request-error handling requires a matching request ID, which this notice lacks.
  Current app-state dispatch handles reconnect only for named transport events.
  This is source inspection, not a claim of native Desktop validation.

The compatibility door remains in-process on use. Its input retention is now
bounded. Final correction evidence:

- Capacity-reply RED `20261119T182516.432045Z-69587` fails on both new replies;
  the correction contains the refusal in the operator log. Cleanup stays held
  until the same window resends a fitting roster or closes, even if another
  window has since freed capacity.
- `20261119T182803.957117Z-73315` passes the actual Close cleanup caller and
  TypeScript. The final allocation correction passes 176 tests in eight files
  and TypeScript in `20261119T183815.232991Z-82220`; all five scoped runtime
  files retain 100% coverage across all four metrics. This selection replaces
  the earlier architecture check with the actual Close caller; it is not a
  repeat of that earlier test selection.
- The fixed V2 ABBA comparison found ordinary-update CPU +2.22% and elapsed
  time +1.68%. Its paired profile attributed 250 ms per million mixed updates
  to unread normalization. Replacing per-row `flatMap` temporary arrays with
  direct output appends preserves its golden behavior.
- Fixed V3 ABBA: one million identical mixed updates per arm, all twenty timed
  blocks retained. Mean CPU 3247.628 → 3192.692 ms (−1.69%); elapsed time
  2965.307 → 2884.202 ms (−2.74%). Both candidate arms are below both baseline
  arms. This accepts the correction's measured update cost, not whole-daemon
  performance or statistical equivalence. The baseline closure matches the
  committed `418d844` runtime. Frozen input SHA-256:
  `c9c6a759b33d455c1d5122a5a631c50b92835de8d91f9e06e3234ac057a20be0`.
  Results: `/tmp/core-device-retention-cost-v3/results/summary.json`.
- Retained-heap endpoints cover short-ID rosters at 8 MiB, unread surviving
  close, and 128 small reporters. The largest measured increase after GC is
  44,953,952 bytes baseline and 44,948,752 bytes candidate. These three shapes
  are not an exact heap ceiling, peak memory measurement or leak proof.
- Independent implementation review found no blocking runtime defect;
  benchmark-provenance and scope findings were resolved before V2/V3. Final
  delta review approves reply suppression and allocation removal, with no
  blocking or medium findings: `/tmp/core-device-retention-final-review/result.json`,
  receipt `20261119T184006.828051Z-83833`. The existing content-free
  `LEGACY_DESK_DELIVERY_FAILED · LEGACY_DESK_STATE_LIMIT` log names refusal.

Combined release acceptance and complete component-process extraction remain
open. No Desktop, mobile or native Windows validation is claimed by this slice.
