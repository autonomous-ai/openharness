# Keep failed first tasks from spinning the shared writer

The final integration review found ordinary messages can be repeatedly removed from the queue and returned to it after a first task fails before its paste. Admission checks `firstTaskAhead`, while the chained write checks `firstTask`; their disagreement can starve the core's event loop. One shared predicate must hold ordinary messages for every outstanding first task, including a failed preflight, and let the first task itself proceed.

## Design

No new persisted data, queue, timer, component, process, dependency, account identity or client contract. Existing queue item and byte limits, request correlation, original expiry, writer authority and first-task handover remain. A disposable process regression bounds the old starvation failure externally and proves a timer still fires for messages queued before or after failed preflight. Relevant input, binding and core tests remain required.

The review also requested the Close proof lifetime. Stop captures native database evidence before its checkpoint callback, so awaiting an optional conversation-empty observation there can spend the proof's three-second budget. Keep the actual saved row for the Close result, finish both checkpoints and the native stop, then ask whether that saved conversation is empty. The observation never delays a live native proof or this Close's export. A stopped process identity is removed from the observation snapshot: only its confirmed folder may supply a negative result. Unknown remains conservative. No new storage, migration or rollback protocol; reverting restores the former sequence. macOS/Linux share the implementation; native Windows validation remains user-deferred.

Native open-file discovery itself already shares a three-second `NativeEvidenceBudget` across its descriptor probe and verification; supply that source in the re-review. Original performance holds and broader acceptance work remain open.

## Evidence

The queued-before failure starved the child until its external 8 s kill (`20261120T121612.113464Z-87150`). After correcting a missing submission-policy fixture, the queued-after variant did the same (`20261120T121717.993299Z-88081`). The Close ordering, matching-turn handover and personal followup lease cases also failed before the fixes. A separate busy-composer case initially used an invalid Claude screen; with its real framing it passes before the correction and is preservation evidence, not a regression RED.

The corrected input/Close selection passes 514 tests and TypeScript (`20261120T122000.930506Z-90523`). Binding, turns, deliveries, registry first tasks, Stop, native proofs, checkpoints and architecture pass another 574 tests (`20261120T122138.631052Z-91868`). Both locked database readers additionally prove their answer is a transient lock failure, not a missing reader (`20261120T122517.235177Z-95746`).

The unified predicate makes `firstTaskAhead` redundant: every true assignment also holds `firstTask`, and all priority decisions now use that claim. Removing the flag and its one redundant Stop check preserves 353 input tests and TypeScript (`20261120T122609.291670Z-96551`). The primary correction and this small deletion have separate independent reviews in progress. Final packaged validation and original-baseline performance comparisons remain outstanding.
