# Clear only the awaited input's composer

Independent reviews found the clear path could treat an earlier ordinary message as a queued first task, losing that message and settling its receipt from the task's paste. Text equality alone also confuses two requests with identical words. A final capture could outlive task confirmation and overwrite a later message's observation.

## Design

Use the existing input operation to identify whether the accepted paste was a first-task write; adopted tasks already have their own marker. Match that ownership as well as the fingerprint when selecting first-task retry and clear behavior. Keep the existing clearing flag across all writers and drains, and release queued work when the clear interval ends. Preserve the exact first-task claim and awaited content across clear awaits. An ordinary message keeps its caller, original receipt and expiry when returned to the existing queue.

No new queue, timer, file, process, dependency, account identity, public contract or persisted format. One optional first-task marker on an existing operation replaces unsafe content-only inference. Existing bounds and failure reporting remain. Migration/rollback is a code revert, with no stored data change. macOS/Linux share the code; Windows native validation remains user-deferred. Write regressions before changes, including different and identical texts, confirmation during final capture, pending handover confirmation and a control command during a lease retry. No performance or release hold is waived.
