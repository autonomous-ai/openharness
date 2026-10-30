# Which gate limited the pilot: an audit of its record

2026-10-17. [04](04-bottlenecks.md) ranked the pilot's bottlenecks by hours lost, and put "builders waiting for the lead" first. Hours lost and output lost aren't the same thing. If a builder sits idle while its work waits in review, a faster dispatcher only makes the review queue longer. This audit asks the record directly: **when builders went idle, where was their work, and what moved the merge rate?**

**Source:** the pilot's 538 PRs into the integration branch, with their ready, first-review and merge times; the 1,537 comments of the queue thread; and the builders' 64 "my list is empty" reports, found with 04's pattern. The lead's own reports are excluded, as in 04. Times are UTC. The script is [sources/audit_gates.py](sources/audit_gates.py); section numbers below (§1–§7) refer to its output. The raw data stays out of the repo.

## 1. Idle builders were mostly waiting on review, not on the lead
- **45 of the 64 reporters had their own PR ready and waiting** for review or merge at that moment; 30 had two or more (§6).
- **What the reports mention** (§2). These are keyword hits, so a report can count under several:

  | Mention | Reports |
  |---|---|
  | Review or merge | 56 |
  | A device | 37 |
  | CI | 35 |
  | The owner or a person | 12 |
  | Nothing | 1 |

- **The review queue was never empty.** Every report came while at least 10 PRs were ready but unmerged (median 17), about the same as at any half-hour (median 15) (§1).

"My list is empty" mostly meant "everything I made is waiting downstream". A builder with PRs in review isn't short of tasks. It's out of room.

## 2. The merge rate was set by the gatekeepers
- **At full size, merges ran at ~9–10 an hour** (from 16 Oct: median 9, p90 17, max 24 in catch-up bursts) (§7). The queue never emptied in that time, so the gate was busy throughout.
- **Widening review moved it.** In the 12 hours after builders started peer reviews (16 Oct 07:05), merges went from 6.4 to 12.3 an hour (§3). The swarm grew only from 13 to 16 agents posting, and that window included a 2.4-hour usage limit. This is suggestive rather than clean: the two windows differ in time of day too.
- **Usage limits on the account carrying the reviewer and the lead** (§4):

  | Window (UTC) | Merges an hour during | The same length just before |
  |---|---|---|
  | 16 Oct 11:27–13:51 | 0.8 | 12.5 |
  | 16 Oct 17:12–18:42 | 0.0 | 12.7 |
  | 17 Oct 03:27–04:43 | 2.4 | 11.8 |

- **The lead blocked on the owner** (16 Oct 20:14–23:40) **is a different kind of stop.** Merges fell only from 9.6 to 6.1 an hour, because review kept going, but empty-list reports went from 3 to 14. That stop hurt dispatch; the usage limits stopped output.
- **Throughput grew with the swarm, then flattened** (§5). It was 0.7 merges an hour with one agent posting and 7.5 with nine. It reached 13.5 at fifteen, when work ready but unmerged peaked at 51–57 (16 Oct 07–13 UTC). After that it held at 9–13.

## 3. What this changes
**The order of the bottlenecks.** By output lost rather than hours lost:
1. **Review and merge capacity,** including the gatekeepers' subscription. When it stopped, output stopped. When it was saturated, more builders only lengthened the queue.
2. **The device gate:** 37 of 64 idle reports mention a device, and work handed back to the lead's device merged 2.5× slower ([04](04-bottlenecks.md)).
3. **CI,** at the peaks.
4. **Dispatch through the lead,** mainly when the lead itself was stopped (14 idle reports in one 3.4-hour block).

**The experiments' order** ([08 §0](08-experiments.md)):
1. **E3, the reviewer pool,** first.
2. **E2, gatekeepers on separate subscriptions:** each of the three measured windows took merges to 0–2.4 an hour for 1.3–2.4 hours.
3. **E4, the lead never blocks.**
4. **E1, pull,** last. Pulling pays only once review has room: more tasks in hand with review saturated just lengthens the queue.

**The product's first slice** ([13](13-first-slice.md)) keeps native tasks and the inbox, which fix the missed messages and the unreadable thread. But its first measure moves from "empty-list wait" to **merges per hour against review capacity**, and the health line shows the review gate's saturation first.

**What idle builders should do** is what the pilot found by itself on 16 Oct: peer review. A builder whose work is stuck downstream should review the oldest PR in the queue, not open a new one. The playbook now says so.

## 4. Beyond what the record shows
The record covers 3–16 agents. [sources/capacity_sim.py](sources/capacity_sim.py) is a small queueing model of builders, CI, reviewers and the lead, fitted to the pilot. **It can't tell which gate bound the pilot by itself; the record above does.** Two fits match the pilot's ~165 merged a day:
- **One saturated reviewer.** PR wait comes out at 3.7 h, against 1.5 h observed. Pull changes nothing; a second reviewer raises output to ~215 a day.
- **Review with slack.** PR wait matches at 1.6 h, but then neither pull (+5%) nor a second reviewer moves output much.

The pilot's 3-day average hides that it ran at ~9–10 an hour once at full size (about 216–238 a day), with the queue never empty. That is the first case.

Further out, the model shows the limit moving: from reviewers, to runners (8 runners cap ~255 a day at 30 builders), to the lead's device checks. At 60 builders the lead is 92% busy and output stops at ~590 a day; moving device checks off the lead lifts it to ~770. These numbers show the shape, not a forecast.

**The rule that survives both the record and the model:** find the gate that's saturated, widen that one, and expect nothing from widening any other.
