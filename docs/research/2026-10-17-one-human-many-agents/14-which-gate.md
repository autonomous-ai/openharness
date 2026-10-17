# Which gate limited the pilot: an audit of its record

2026-10-17. [04](04-bottlenecks.md) ranked the pilot's bottlenecks by hours lost, and put "builders waiting for the lead" first. Hours lost and output lost aren't the same thing. If a builder sits idle while its work waits in review, a faster dispatcher only makes the review queue longer. This audit asks the record directly: **when builders went idle, where was their work, and what moved the merge rate?**

**Source:** the pilot's 538 PRs into the integration branch with their ready, first-review and merge times; the 1,537 comments of the queue thread; and 68 "my list is empty" reports, found with the same pattern as [04](04-bottlenecks.md). Times are UTC. The script is [sources/audit_gates.py](sources/audit_gates.py). The raw data stays out of the repo.

## 1. Idle builders were mostly waiting on review, not on the lead
- **Every one of the 68 empty-list reports** came while at least 10 PRs were ready but unmerged (median 17). That's about the same as at any half-hour (median 15): the queue was always there. The stronger evidence is the reporters' own work, below.
- **46 of 68 reporters had their own PR ready and waiting** for review or merge at that moment; 30 had two or more.
- **In their own words,** a report can name several causes:

  | Waiting on | Reports |
  |---|---|
  | Review or merge | 60 |
  | A device | 41 |
  | CI | 35 |
  | The owner or a person | 14 |
  | No reason given | 1 |

"My list is empty" mostly meant "everything I made is waiting downstream". A builder with three PRs in review isn't short of tasks. It's out of room.

## 2. The merge rate was set by the gatekeepers
- **At full size, merges held at ~9 an hour** (Oct 16 onward: median 9, p90 17, max 24 in catch-up bursts), whether 20+ PRs were waiting or fewer: 9 an hour against 8.5. A rate that doesn't move with the queue is a saturated server.
- **Usage limits on the account carrying the reviewer and the lead:**

  | Window (UTC) | Merges an hour during | The same length just before |
  |---|---|---|
  | 16 Oct 11:27–13:51 | 0.8 | 12.5 |
  | 16 Oct 17:12–18:42 | 0.0 | 12.7 |
  | 17 Oct 03:27–04:43 | 2.4 | 11.8 |

- **The lead blocked on the owner** (16 Oct 20:14–23:40) **is a different kind of stop.** Merges fell only from 9.6 to 6.1 an hour, because review kept going, but empty-list reports went from 3 to 14. That stop hurt dispatch; the usage limits stopped output.
- **Throughput grew with the swarm and then flattened:** 0.7 merges an hour with one agent posting; 7.5 with nine; 13.5 at fifteen. After that it held at 9–13, while the work ready but unmerged climbed to 51–57 on the morning of 16 Oct.

## 3. What this changes
**The order of the bottlenecks.** By output lost rather than hours lost:
1. **Review and merge capacity,** including the gatekeepers' subscription. When it stopped, output stopped. When it was saturated, more builders only lengthened the queue.
2. **The device gate:** 41 of 68 idle reports name a device, and work handed back to the lead's device merged 2.5× slower ([04](04-bottlenecks.md)).
3. **CI**, at the peaks.
4. **Dispatch through the lead,** mainly when the lead itself was stopped (14 idle reports in one 3.4-hour block).

**The experiments' order** ([08 §0](08-experiments.md)):
1. **E3, the reviewer pool,** first.
2. **E2, gatekeepers on separate subscriptions:** the windows above took output to nearly zero for 1.2–2.4 hours each.
3. **E4, the lead never blocks.**
4. **E1, pull,** last. Pulling pays only once review has room: more tasks in hand with review saturated just lengthens the queue.

**The product's first slice** ([13](13-first-slice.md)) keeps native tasks and the inbox, which fix the missed messages and the unreadable thread. But its first measure moves from "empty-list wait" to **merges per hour against review capacity**. The health line shows the review gate's saturation first.

**What idle builders should do** is what the pilot found by itself on 16 Oct: peer review. A builder whose work is stuck downstream should review the oldest PR in the queue, not open a new one. Make it the default in the playbook.

## 4. Beyond what the record shows
The record covers 3–16 agents. A small queueing model calibrated to it ([sources/capacity_sim.py](sources/capacity_sim.py)) reproduces the observed ~162 merged a day with one saturated reviewer. In that model:
- **Pull alone changes nothing** while review is saturated: idle time per builder falls from ~104 to ~13 minutes a day, and output stays at 162.
- **A second reviewer raises output to ~220 a day.**
- **Further out, the limit moves** from reviewers to runners (8 runners cap ~255 a day at 30 builders), then to the lead's device checks. At 60 builders the lead is 92% busy and output stops at ~590 a day; moving device checks off the lead lifts it to ~770.

The model shows the shape, not the numbers.

**The rule that survives both the record and the model:** find the gate that's saturated, widen that one, and expect nothing from widening any other.
