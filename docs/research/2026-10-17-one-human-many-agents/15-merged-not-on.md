# Merged is not on: what the pilot's switch census shows

2026-10-17. The pilot merged new behaviour behind switches that are off unless set, to keep merges fast ([05 §4](05-framework.md)). On the third day the owner asked "why off?", and a builder wrote a census of every switch: what it does, which PR added it, the device check that PR named, and whether a document records that check as passed. This audit reads that census and joins it with when each switch's PR merged.

**Source:** the pilot's own census as of 17 Oct (110 switches by its count; 112 table rows parsed), and the pilot's PR metadata. The script is [sources/audit_switches.py](sources/audit_switches.py). The raw data stays out of the repo.

## 1. Four in ten behaviours were merged but not on
The census's own count:

| State | Switches |
|---|---|
| On already, or right at its default | 49 |
| Proposed to turn on now (newest device record a pass) | 2 |
| **Off until a named check on a device** | **46** |
| Stays off (diagnostic, turned down, not needed) | 10 |
| A setting, not a behaviour | 3 |

**Of the 97 switches that turn a behaviour on, 46 (47%) were merged but waiting for their check.** The PR, the review and the merge were all done; the work counted as finished; and it ran nowhere.

## 2. What they were waiting for
Reading each "off until …" line (45 parsed):
- **33 need a run on a real device:** "off until its device minute", "until measured on a device", "until heard with the relay down".
- **12 need a person there too:** someone talking over it, a face at a distance, a hand on the arm, a busy room, two people at a table.
- **18 had never been run on any device,** by the census's own reading.
- **Median time since merge: 28 hours** (p90 45) for the 36 with a PR date. For comparison, the switches that were already on had merged a median 38 hours before.

None of these can be checked by CI, a reviewer or a test the builder writes. Their oracle is the device and the people around it. In the terms of [03 §6½](03-first-principles.md), they are **class C**.

## 3. Why it happened, from the record
- **The merge rule optimized the merge rate,** by design: "off unless set" let a change merge before any device check. Throughput counted merges, so 47% of finished-looking behaviour was invisible to the count.
- **The device gate was one device and the lead's time.** 102 PRs needed the lead's device ([04](04-bottlenecks.md)), and "what waits for the device already grows faster than it can be cleared" was written on the first day with four builders.
- **The census found more gaps behind the switches:** the device's repo unit set less than the docs said it ran, and some settings existed only in uncommitted drop-ins on the device.
- **A person found it, not an agent.** The census exists because the owner asked "why off?". No agent's report had surfaced it, because every agent's measure said "merged".

## 4. What this changes
- **Progress is "on and shown working",** not merged. The health line shows merged-but-off as a count and an age, as [06](06-harness-swarm.md) proposes. The pilot shows why it must be there from day one: 46 of 97 behaviours in three days.
- **Class C work needs a scheduled gate,** the same as review:
  - a device job queue that batches several switches into one run;
  - a hands queue that books the person and the room;
  - a cap on how much class C work merges ahead of its check.

  In the pilot, 46 waiting checks at a median of 28 hours means the device-and-person gate ran at well under the merge rate.
- **Measure the gap, then throttle to it.** When merged-but-off grows faster than checks clear it, stop merging new behaviour into that area and spend builders on making checks cheaper. That means recordings, simulators and scenarios: moving class C toward class B.
- **The owner's best question was about the measure, not the work.** "Why off?" was worth more than any review that day. The YOU box should invite exactly this kind of question by showing the gap, rather than waiting for the owner to notice it.
