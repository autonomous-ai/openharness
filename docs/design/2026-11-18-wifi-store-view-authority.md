# Store readiness after Wi-Fi creation

## Design

The packaged Store Create cases on frozen `839a6ede62` failed on 2026-11-18. Inline creation opened the actual pane, then Store immediately evaluated a complete view captured before creation and persisted `AGENT_UNAVAILABLE`. A read already in progress for `operation.get` can have the same stale membership. The supervised `DSH_UNAVAILABLE` failure has a separate Store identity cause, owned by its correction.

Wi-Fi already owns `notices` and `applied`, its one in-flight complete read, and its component/connection lifetime. A successful create increments that existing notice authority and schedules the existing read before returning the successful create result. Earlier reads cannot satisfy the new revision. Initial `applied = -1` represents no completed view. No new revision, catalog, cache, queue, timer or core rule is introduced.

The existing synchronous Store agent reader gains one mandatory `agentsCurrent()` predicate. The sole runtime chain is `startWifi` → `createDeviceStore` → `AutonomousDeviceStore`; the adapter forwards both callbacks. Wi-Fi derives freshness from `!stopped && coreConnected && applied === notices`. Synchronous direct test providers explicitly return true. There is no optional fallback.

Store defers readiness/missing-agent decisions and durable reveal delivery while the predicate is false. A known created agent remains journalled in launch state; reading cannot erase its receipt, turn it into an uncertain create, or retry it. A fresh complete view restores the existing ready/starting/unavailable decisions. A genuinely removed agent or mismatched package/workspace is still refused. Reveals check current evidence for each queued operation, including reentrant lifetime changes. Workspace prechecks and the core's final canonical admission are unchanged.

The predicate is a component-local freshness fact, not an atomic distributed snapshot or grant to create. No persisted schema, public frame, private query, cohort or transport changes. A failed refresh keeps the successful create outcome and blocks presentation until a subsequent complete read succeeds. Disconnect/stop blocks stale view use. Same-machine durable work retains its existing authority; known successful completion after stop is still a known result, with no new refresh.

## Validation

Actual caller RED on unchanged839 runtime: `.harness/validation/20261118T162157.870560Z-52360/receipt.json`, actual exit1. Real Wi-Fi + real Store + real creation receipt returned `needs_user_action/AGENT_UNAVAILABLE` instead of `running/launch` while a pre-create read was held. The created receipt was already present. This is separate from the frozen two-case native failure packet `/tmp/core-wifi-store-create-native-839a6ede62`.

Selected source controls: held old read, failed read and recovery, duplicate key no replay, no initial/stopped/disconnected authority, actual removed/rebound facts, unchanged reveal recovery and receipts. Final selected gate `.harness/validation/20261118T162508.704297Z-55891/receipt.json` passed: 258 tests across seven caller files, `wifi.ts` 100% statements/branches/functions/lines, 36 architecture controls, and types. Store library guards are exercised by the selected actual-caller and direct Store suites; the mandatory per-file service coverage gate covers `wifi.ts`. The source tests ran only after the coordinated quiet window was released. The packaged Store cases remain failed/unaccepted until the corrected combined artifact passes; no native rerun or timing is part of this source change. Windows execution is deferred by the user; mobile is excluded.
