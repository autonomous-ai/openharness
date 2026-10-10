# Daemon core completion checklist

This is the remaining completion scope as of October 9, after the six extraction phases in the [handoff](2026-10-08-daemon-separation-handoff.md). The architecture must be safe under unavailable dependencies and changing session ownership. Source size is a reference, not a gate. The [progress history](2026-10-09-daemon-separation-progress.md) records landed work and timing; individual PRs carry exact-head review and validation receipts. No release is authorized.

## Landed foundations

- [x] Crash resume preserves the interrupted turn boundary (#1072).
- [x] DSH preparation runs through Store and held boot launches (#1073).
- [x] Grid assignment and saved APIs use the models boundary without delaying discovery (#1076).
- [x] Usage and external sessions run in their services (#1078, #1081).
- [x] The legacy runtime profile manager is removed (#1088).
- [x] Same-millisecond pane labels cannot collide (#1091).
- [x] Capture ownership is checked after asynchronous reads (#1093).
- [x] Kilo, Hermes, native identity, Muse/Pi repair, OpenCode control and native hook declarations are eager where session control requires them (#1095, #1097, #1104, #1106, #1110, #1111).
- [x] Launch preparation gathers dependencies before local writes and commits under current ownership (#1113).
- [x] Bounded repair pools and native headers hold incomplete evidence; Stop/Close preserve intent (#1114, merged as `138ae6766` at 13:59:26 UTC).
- [x] Exact Cursor/Grok locations, Copilot/agy process claims and discovery retries retain incomplete evidence (#1118, merged as `902ab6038` at 15:01:46 UTC).

- [x] Fresh bounded Hermes pools and Stop home preservation (#1120, merged as `a847441e5` at 16:39:44 UTC).
- [x] Complete exact Claude/Codex/Pi resume pools and typed Pi Close recovery (#1123, merged as `fb834fb18` at 17:14:15 UTC).

- [x] Fresh complete native home catalog evidence (#1126); durable writers and legacy consumers remain below.
- [x] Complete native descriptor/process/header ownership evidence (#1131, merged as `9eafacf3b` at October 10 00:33:06 UTC).
- [x] Durable engine-home adoption, crash recovery and core retry (#1132, merged as `c7d460b1d` at October 10 01:43:24 UTC).
- [x] Saved-binding file/header/root evidence and ordered interpretation recovery (#1133, merged as `a2a7874f3` at October 10 05:16:31 UTC).
- [x] Atomic native hook admission and live Stop ownership (#1137, merged as `9618c2e2c` at October 10 08:36:54 UTC).

## Remaining blockers

1. **Complete native identity and retry.** Exact transcript lookup and native lock/descriptor enumeration are landed. Durable home adoption and its staged registry batch are [landed](2026-10-10-durable-home-adoption.md). Saved-binding file/header/root evidence and visible retry are [landed](2026-10-10-saved-binding-evidence.md). Atomic registration and live hook ownership are [landed](2026-10-10-native-hook-admission.md). Stop/Resume/Close transcript authority is [landed as #1139](2026-10-10-control-transcript-authority.md); reviewed history deletion is [under validation](2026-10-10-native-history-consumers.md); restart-persistent hook delivery, remaining saved-home consumers and legacy native-client acknowledgement/order still require migration. The [catalog audit](2026-10-09-native-home-catalog.md) records its fresh-evidence boundary and required remaining caller/writer migration. The native Hermes pool is landed; optional home promotion and shared handle-cache lifetime still need their authority/resource audit. An unreadable or truncated pool cannot prove absence or uniqueness. Every binding entry and transcript poll retains pending work, isolates a failed lookup, and retries without blocking sibling sessions or readiness. Surface the hold reason through the shared session state.
2. **Complete native launch preparation.** Probe executable/version facts asynchronously with a deadline and one confirmed executable snapshot per launch. Failed hook writes/removals hold launch, preserve foreign configuration and are checked consistently by create, fork, restart, retarget, restore and upgrades. Do not memoize an unavailable version as a permanent answer.
3. **Durable manual lifecycle intent and mutation authority.** Preserve create/fork/restart/retarget requests across unavailable services and daemon restart. Publish generated configuration atomically after dependencies are ready. Check immutable session ownership after every relevant await and before native writes, signals and publication. Reconcile unconfirmed OpenCode v2 mutations read-only; unreadable catalogs must not authorize mutation. Cover v1 missing-row/rollback cases and report a confirmed native change followed by failed respawn truthfully.
4. **Close, turns and input stay in core.** Audit OpenCode v2 Close checkpointing against its current conversation store; unavailable checkpoint/activity evidence keeps the live session with its reason. Finish per-engine Stop/turn facts, authority across asynchronous drains, Cursor pending-task persistence, agy backstop control, input verification declarations, and Pi header/argv and unwritten-conversation handling.
5. **Final architecture acceptance.** Exercise startup, discovery, binding, launch, resume, Stop, hook admission, turn closing and Close with required services absent, stalled, disconnected and recovered. Verify readiness remains independent, pending work survives without partial writes or archival, and stale completions cannot affect a replacement session. Run the relevant coverage gates, unchanged goldens and assertion-failing wiring mutations, affected private e2e/chaos lanes, and matched runtime-cost measurements. Obtain independent review and merge every completed change.

These groups are the completion bar, not a requirement for one PR per group. Update each with landed evidence; do not mark a group complete while its named cases remain open. Any additional blocker must identify a concrete violation of the stated architecture and its reproducer. Unrelated enhancements and cosmetic cleanup are outside this checklist. The six unreachable pane drivers retain the owner's existing decision and do not block completion. The interim search optimization was superseded by moving external sessions into the search process.

## Estimate and accounting

The working estimate given to the owner on October 9 is two to three more focused days, with moderate confidence; durable lifecycle intent and retargeting are the largest uncertainties. This is an estimate, not a claim that implementation or validation is complete. Track implementation, validation, independent review/CI waiting, merge and publication separately. The original request began October 8 at 23:26:41 UTC. Publication remains zero.
