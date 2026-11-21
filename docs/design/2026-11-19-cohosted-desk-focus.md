# Current window authority for a cohosted desk step

The packaged macOS Wi-Fi acceptance test reproduced `FOCUS_UNAVAILABLE` while its Desktop window was open. Temporary boolean-only tracing showed Wi-Fi's current view had a window, while the Devices desk still held its startup view without one. The cohosted direct call skipped the refresh already performed by the mixed-process request handler. The desk then checked window authority before its agent-list read could refresh it.

## Design

Refresh the Devices process view before invoking its published desk step. Keep the existing physical-owner, caller, five-second deadline and post-await window checks. The change belongs entirely to the Devices process; the core gains no state or protocol. A failed read refuses the effect. Scrolling remains a stream on its existing window facts.

- Growth: no new state or retained records; the existing single-flight bounded snapshot and work budget apply.
- Concurrency: the process shares one in-flight read; each step retains its existing owner and caller fences through settlement.
- Read cost: one fresh existing advertised-session read before direct step authorization. Record this added cohosted cost; combined performance acceptance remains open. No idle work is added.
- Scale: existing bounded session records, five-second step deadline and snapshot limits apply at 10x; named timeout/backpressure diagnostics identify exhaustion.
- Compatibility: no public frame, request, stored format or backend change. Existing success/refusal shapes and mixed hosting stay supported.
- Migration and rollback: no migration; reverting the change restores the old stale-window behavior without changing stored data.
- Audience and identity: the existing verified core connection, machine, published desk owner and requesting caller remain required. No new login or authority.
- Failure: failed refresh returns the existing unavailable result; expired, disconnected or replaced callers cannot move focus.
- Platforms: TypeScript path affects macOS, Linux and Windows. Native macOS acceptance runs here; Linux acceptance remains scheduled, native Windows is explicitly deferred by the user.

## Evidence

Native failure: `20261119T124439.233606Z-32400` (48 passed, two Wi-Fi failures, six skipped). Focus reproduction: `20261119T125112.125453Z-51721`. Boolean-only localization: `20261119T125249.018058Z-56373`; instrumentation removed before the fix. Two unit REDs covering window arrival and departure: `20261119T125516.736338Z-59730`.

The corrected caller run `20261119T125806.818827Z-62701` passes all 913 cases in five files, TypeScript, and all eight packaged native Wi-Fi scenarios (186.1 seconds). Caller tests cover failed refresh, caller revocation, disconnect, stop and expiry during the read. The intermediate sandbox run `20261119T125617.004554Z-60814` is retained as failed: its socket test and cleanup census lacked OS permissions; it is not passing evidence.
