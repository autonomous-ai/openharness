# Local sign-in callback boundary

The daemon currently parses sign-in pages, retains phone-routing and callback state, and performs loopback HTTP
inside core (`core/terminals/browser.ts`, `lib/loopbackGet.ts`). Move that policy to the existing gateway process.
This is daemon routing, not mobile publishing or new Browser functionality. Public `browser_open` and
`browser_callback` payloads and successful/error replies remain compatible.

## Design

**Authority.** Core keeps accepted terminal input, current pane ownership and authenticated request provenance.
Gateway owns the last phone-routing choice, expected callbacks, URL parsing, redirect following and HTTP custody.
A payload never supplies its own owner/local status. `browser_open` remains local-only; callback remains owner-only
and bound to the gateway's authenticated stable peer identity. A matching port/path is consumed before the first GET,
so duplicate callbacks cannot replay the effect. No arbitrary core URL fetch or one-consumer core broker is added.

**Shared terminal facts.** Replace browser's direct typed callback and agent-cleanup's typed port with an existing
AgentLife observation of actual accepted person input. Both are real consumers of the same fact. Terminal authority
continues to reject watcher, malformed, out-of-order and refused input before observation. It must distinguish control
responses from person input and preserve accepted-input ordering; received network frames are not evidence. Models'
existing per-keystroke prewarm and terminal move-idle bookkeeping retain their current behavior.

The shared fact must preserve the most recent accepted writer across reconnects and avoid a frame on every keystroke.
Implementation review will compare keeping it with the existing terminal owner state versus AgentLife's bounded
live-agent observation. It may replace the current browser lastInput map and cleanup told set; it must not add a
parallel feature map, replay history or unbounded per-keystroke queue. Recovery must retain cleanup's protection of
an agent the person joined while the cleanup process was unavailable. A gateway restart must learn a valid current
source or explicitly have none; it may not silently retain a former owner's source. This shared seam is reviewed
and tested before moving the callback runtime.

**Routes.** Use the existing declared service request adapter. Its caller provenance and physical outstanding-call
limits remain shared. The old feature provider and switch cases are removed in the same change. Gateway resolves
the current pane through the existing agent-of-pane query, then rechecks its own incarnation and caller lifetime
before sending a page. It uses its authenticated remote-client identity for callbacks. The gateway's in-process
compatibility composition uses the same implementation, loaded only through the existing inline door.

**Growth and read cost.** Retain at most one routing source per current live agent, clearing ended/purged bindings.
Expected callbacks have the existing ten-minute lifetime and a finite total/per-peer count; saturation falls back to
the local browser before a page is sent, rather than sending a page whose callback cannot be admitted. No timer scans
all agents. Cleanup occurs on a bounded request pass and lifecycle events. URL/identity byte bounds must agree with
existing public admission limits; oversized values receive the existing bad/unsupported answer without logging them.
A replay has one owned HTTP request at a time, at most three same-port redirects, and a total deadline. Actual request
close retains its slot even after the logical request expires. Response bodies are not buffered or kept alive after
only their headers are needed. No new production datastore or dependency.

**Concurrency and failure.** Consume callback authority synchronously before awaiting network work. A peer change, agent end, request cancellation, deadline, or gateway replacement revokes subsequent effects. A later typing source changes where the next page opens; an already issued callback remains redeemable by its original authenticated peer until expiry, as before. Requests and retained callback
records are owned by one gateway incarnation; no stale completion can mutate the next one. Optional gateway failure
leaves terminal I/O and unrelated agents running. Missing gateway gives the declared route fallback, and the local
shim can open the computer's browser. Replay failures use fixed named logs with no URL, query, authorization code,
raw exception text or peer identity. A bounded failed callback is visible in its caller reply.

**Shim.** Browser shim rendering/writing leaves eager core startup. Reuse engineSetup/launch preparation, preserving
the existing path and shell prelude. Preparation is optional: missing shim leaves the engine's original browser.
Do not execute a browser or shell in core. The local fallback and previous-browser environment semantics stay intact.

**Compatibility and rollback.** No stored schema changes. Public requests, callback identity, TTL and same-port
redirect rules remain. New private worker composition is admitted together with its existing cohort; supported old
complete builds retain their old implementation. Any retained private adapter needs the first actual release plus
30 days, not a guessed date. Rollback sees the same shim pathname and no migrated credential files. Ephemeral
callback state is lost on gateway restart as a named unavailable result; no authentication code is persisted.

**Audience and identity.** Existing local/owner/guest guards run before routing. Page delivery uses the exact client
selected by accepted input and current pane facts. Only that stable authenticated peer may redeem its callback,
including a reconnect. Guest work does not use the machine owner's account. No new access to another user's files.

**Scale and measurement.** Compare 16/160/1,600 live agents and matched terminal input on the same sources. Record
core and gateway CPU, retained metadata, route latency and first-use behavior. Bound/cap/deadline refusals are named,
content-free events. No terminal hot-path slowdown is accepted without correction. A static import count is not
memory or isolation evidence.

**Platforms.** macOS and Linux daemon runtime, Windows portable behavior and compatibility code. Native Windows
verification is explicitly deferred by the owner. No Desktop/mobile UI change or publishing task is included.

## Selected verification before implementation

- Preserve existing browser route goldens, ownership, reconnect, one-use callback and same-port redirects.
- Failure-first tests for actual input provenance, first accepted input, takeover/reopen, service downtime/recovery,
  stale peer/pane/incarnation, queue/byte limits, reply deadlines versus physical HTTP close, and secret-free logs.
- Exercise both real service routing and explicit inline composition; the raw HTTP fixture uses private loopback
  listeners and no installed daemon. Prove gateway loss preserves another terminal's I/O in a packaged native case.
- Affected unit tests/types/architecture and per-file coverage; final mapped gates remain root's responsibility.
- Freeze the implementation and workload for before/after cost; retain every exit and cleanup receipt.

Current state: implementation and selected unit validation are underway in an isolated worktree. Native isolation, matched cost, independent review and final integration gates remain open; this document does not claim completed extraction.

### First shared seam selected before implementation

TerminalStreamManager already closes the former controlling stream on takeover and creates a new state on reopen.
Store only a first-person-input marker on that existing stream, scoped to its current agent. Emit one source fact
on that stream's first accepted person input, including a paste; terminal control replies, refused frames and watchers
emit none. Keep the existing per-input callback unchanged for prewarm/move bookkeeping. A failed source observer
must not interrupt input and may retry on the next person input. No new core source map or history is needed.

AgentLife will carry this fact to gateway and agent cleanup, replacing their direct core callbacks. Gateway loss
already closes its remote terminal streams, so a fresh remote controller emits a new first-input fact after recovery.
Local streams remaining through gateway loss belong to this computer and need no remote browser destination.
The bounded held-service notification path needs keyed replacement for repeated source facts of the same agent,
so reopening one stream cannot evict another agent's joined protection. Both gateway and cleanup use that shared
transport capability. Gateway itself owns any retained routing choice and removes it on agent end/purge.

### Implemented bounds and lifecycle

The gateway keeps at most 4,096 phone routing sources, 256 expected callbacks total and 8 per authenticated peer. Callback records retain the prior ten-minute lifetime. Agent ids are at most 128 characters, connection/peer ids 256, and raw/canonical request URLs 16,384 characters. Redirect URLs obey that same canonical bound. Overflow falls back before page delivery. Composer input carries no terminal source and preserves cleanup protection without rerouting pages.

Four physical HTTP requests are admitted per gateway process, including requests whose caller has ended but whose socket has not closed. The process-owned pool survives gateway replacement. One callback follows at most 3 same-port redirects under one 30-second deadline. Response headers are capped at 16 KiB; bodies are destroyed without buffering. Shutdown waits at most 5 seconds for actual close and reports CALLBACK_CLOSE_TIMEOUT; logical timeout does not release physical credit.

The browser shim writer now belongs to engineSetup, and only its pure shell prelude/path remains in the core import closure. Setup asks its connected core for the actual CLI command, waits at most 1 second for optional preparation before handling its first launch request, and ignores late/disconnected-core answers. Inline compatibility uses the same writer. The previous cleanup typed-event adapter remains solely for old cores until at least 30 days after the first published release containing this change; a release-derived retirement date must be recorded before removing it.

The selected second receipt passed 622 cases with one existing skip and types; it retained a failed coverage gate for one browser branch. The subsequent unrelated-agent lifecycle assertion passes, with browser.ts at 100% on all four metrics and types passing. The other 14 selected files were already at 100% in that second receipt.

Two packaged macOS cases pass: supervised gateway/engineSetup and explicit inline compatibility. They exercise encrypted terminal input, page routing, a callback with an endless body, same-port redirect, one-use redemption, gateway kill/reconnect, and unrelated local work without a core restart. A tightened rerun also asserts master exit zero, actual close, stdout/stderr EOF, private root removal, and propagates the daemon fixture's cleanup failures. Receipts: `.harness/validation/20261118T022041.238642Z-5901/receipt.json` (focused final coverage/types), `.harness/validation/20261118T022951.700174Z-15165/receipt.json` (packaged cases, 38 seconds). Earlier failed receipts remain retained. Matched hot-path cost and independent full review remain open.

**Terminal-only first use.** Engine setup remains on demand. A terminal-only pane opened on a fresh data directory before setup runs keeps its original local BROWSER for that pane, even if the shim appears later. This is the existing missing-shim fallback made reachable by removing the eager core writer; a new pane after setup uses the shim. Native agent preparation waits for optional setup as described above. The real-shell browserPrelude test covers both missing and present shim behavior. This optional phone-routing limitation is accepted for the extraction; terminal creation does not wake an optional component or depend on its success.
