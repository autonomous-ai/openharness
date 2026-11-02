# The PM hears routine notices in one message every 5 minutes: plan

Design: [2026-11-02-pm-notice-digest-design.md](2026-11-02-pm-notice-digest-design.md) (Ken). Backend only; no client changes:
Desktop and the phone show nothing for a delivery status they do not know (`message_receipt.dart`, `swarm_message_receipt.dart`).

## Decisions left to the builder

- `DIGEST_KINDS`, `NOTICE_DIGEST_MS` and the digest's wording live in a new `backend/src/superTabs/noticeDigest.ts`.
- Each line carries full ids, as `harness super-tab message GROUP MESSAGE_ID` needs them. Whitespace in a notice collapses to one
  line, so a worker's result cannot forge a digest line.

## Found while reading the code, beyond the design

These keep to the design's goals ("nothing lost", no notice held forever):

1. **Dormant groups at digest time.** A coordinator's poll loads only awake groups; `deliveryAllowed` refuses a group missing from
   the state, so a gathered row in a group asleep since would be cancelled. A due digest loads its rows' groups first (one `ensure`,
   shared with the morning digest's, since a second `ensure` would drop the first's groups).
2. **Any lead change, not only `conversation.agent`.** Today `conversation.agent` refuses to replace a live PM (`LEAD_PROTECTED`);
   the lead changes on removal, and #2527 will add a switch. The requeue compares each project chat's lead before and after every
   command in `execute` (`requeueFormerLeads`), so every path is covered, and its tests call that step with the two states.
3. **A reply to a gathered notice answers it.** The coordinator may read and answer a notice before its digest; the reply moves the
   row to `answered`, as it does a queued one, and the digest does not name it again.
4. **A merged update request already stored.** `writeMessages` keeps a stored message of the same id and source, which would lose the
   lines, and fails on a different source, which would stop every poll. An update request whose id is already stored is not merged.
5. **Gathered rows carry the store's clock.** `createdAt` is set from `this.now()`, the time the release and the backstop measure from.
6. **A Done outlives its sender (review).** Done is how the coordinator hears, once, and its agent may be stopped within the 5 minutes.
   A sender's removal leaves gathered rows to the digest. A Done whose sender alone fails the checks is named by its label and ids,
   with no result; a routine notice is cancelled. Past the 30 minutes no host could be handed it, so it ends there.
7. **Paused Swarm.** Delivery is not paused by a pause, so a digest still goes out: it stands for deliveries that would have gone.

## Steps (test first)

1. Integration tests in `backend/integration/superTabNoticeDigest.test.ts` for every case the design lists; watch them fail.
2. `noticeDigest.ts`: which messages are gathered, each line, the digest's text and draft. Unit tests in `noticeDigest.test.ts`.
3. `commands.ts`: `source.status` on `work.status` rows. `model.ts`: `NOTICE_READERS['notice-digest']`.
4. `store.ts writeMessages`: `status: 'gathered'`, no announcement.
5. `store.ts fullDeliveries`: release; merge with a due update request.
6. `pageReads.ts`: `CANCELLABLE_DELIVERY`, used by every cancel (store.ts, native.ts). `deliveryCompaction.ts`: `digested` is final.
7. `store.ts deliver`: refuses `gathered` and `digested`.
8. `store.ts execute` (`requeueFormerLeads`): a lead change requeues.
9. `deliverySettle.ts` and `store.ts settleDeliveries`: 30-minute backstop; an unreachable gathered row is cancelled.
10. Update existing tests that expected a routine notice to reach the coordinator's inbox at once.
11. Full Super Tab integration suite (`npm run test:super-tabs`), red/green evidence on the PR, rollback note in the PR.
