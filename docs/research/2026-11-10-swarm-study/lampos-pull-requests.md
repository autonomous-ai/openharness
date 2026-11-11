# lampOS pull requests, 20 Oct to 10 Nov 2026: how the pipeline performed

> Part of the [Swarm study of 10 November 2026](README.md). Written by a research agent from GitHub's own data, read-only. The scripts and raw files it names were working files and are not kept here; each section says how its numbers were counted, so they can be counted again.

Study of `autonomous-ai/lampOS` (branch `lamp-voice`), read-only. Every number is computed from GitHub data by
throwaway scripts. Every table is pasted from their output, except the two hand-read ones (what 60 HOLDs
found, and what each `HOLD train` was).

## The short version

1. **The owner's daily figures are right, and they compare the four best days with three days.** Counting the PRs
   carried by merged trains plus the PRs merged directly, per UTC day, gives exactly 142, 193, 122, 134 for 27-30 Oct
   and 102, 87, 70 for 4-6 Nov. The same count gives 54 for Mon 26 Oct, 69 for Mon 2 Nov and 65 for Tue 3 Nov: three
   manual-period weekdays at or below the Swarm-PM days.
2. **The drop came on Mon 2 Nov, two days before the cutover.** Six agents on the first builder's own account
   (builders Second, Third, Fourth and Tests; readers Reviewer-two and Reviewer-three) went quiet on Sun 1 Nov
   afternoon. Five of them came back on 9 Nov, the day the first builder took the PM role back. In the peak week
   they landed 41 of the 121 PRs landed per weekday and gave 77% of all verdicts.
3. **Everyone else landed about as much under the Swarm PM as before it.** PRs landed per weekday by all other
   builders: 80 (26 Oct-1 Nov), 55 (2 Nov-4 Nov 11:00), 74 (Swarm PM), 96 (after).
4. **What did get worse after 1 Nov, and worst under the Swarm PM:** the slow end of reader latency (p90 from ready
   to first verdict 37 min, then 2.5 h, then 4.3 h; back to 62 min after), and the median cycle (64 min, 1.5 h,
   2.2 h; still 2.0 h after). Under the Swarm PM also: 57 issues opened and 59 closed on the cutover day, TWO READS
   asked on 20% of PRs (6% before), three PRs that asked two reads landed on one.
5. **A typical PR took an hour, and most of that hour was the train.** Manual phase, median: 7 min from ready to
   the first verdict, then 36 min from the last READ-OK to landed (10 min waiting for a train, 23 min the train's
   run). 76% landed within 3 h. The slow tail is rework: the 23% of PRs that got a HOLD hold 58% of all hours.
6. **Review finds real faults.** 23% of landed PRs got a HOLD. Of 60 HOLDs read by hand, 42 named a behavioural
   fault, 6 a missing or broken test, 3 a doc or contract mismatch, 9 a process condition, none style. A second
   reader, often reading another side of the change, held 15-19% of the heads a first reader had passed.
7. **The single train lane was the ceiling.** On 29-31 Oct a train was open 87-91% of the day, carrying 2 to 3
   PRs each. 16% of trains closed unmerged, but only 4% because their run failed.
8. **The main waste:** the same work filed twice (9% of PRs closed without landing in the manual phase, 20% before
   it; nothing was lost for all but 3%), reads restated after rebases (21% of READ-OKs), conflicts (7% of PRs told
   to rebase took 10 h instead of 64 min), and the bot blaming the wrong PR for a failed train (8 of 22).
9. **Size decides the outcome.** HOLD rate 3% under 50 lines, 53% over 1,500; median cycle 52 min against 4.8 h.
   The `size:s/m/l` labels were created late on 9 Nov (UTC) and are on no issue or PR, so they cannot be checked.
10. **Identity is by signature.** 5,193 verdicts came from 11 accounts; two accounts each sign for nine reader
    names. The bot's parser found no reader name on 3% of verdicts in the manual phase, 17% under the Swarm PM, 33%
    after.

## Method, data and limits

- **Data.** All 3,795 PRs created since 18 Oct (803 trains, 2,992 others, 103 of those generated "build rows" PRs)
  with their comments, review bodies, labels, files, head checks and close, ready and force-push events; all 674
  issues created since 12 Oct; `lamp-voice`'s 3,488 commits since 19 Oct; the Queue's comments (the six files in
  `../data`, plus #3504 and #3126 fetched here); the commit time of 3,497 heads that a verdict names. About 340
  GraphQL calls and no REST data calls. Raw responses are in `raw/`.
- **A census, not a sample.** Durations and shares cover every PR, not 200 of them. Hand-read samples are named
  where used: 60 HOLDs, 56 READ-OKs, 22 `HOLD train` comments, 14 fast READ-OKs.
- **Phases.** *Before*: 20-25 Oct. *Manual*: 26 Oct 00:00 to 4 Nov 11:00. *Swarm PM*: 4 Nov 11:00 to 9 Nov 09:34.
  *After*: 9 Nov 09:34 to 10 Nov 21:34, when the data ends. All times GMT+7; a "day" is a GMT+7 day.
- **The return is dated from the Queue.** 9 Nov, 09:34 (signed 09:4x): "the owner has stopped the PM agent (Faye).
  From now on the first builder is PM again, end to end, as before 4 Nov." Faye's last PM post is at 10:30 that day.
- **Landed** means merged directly, or carried by a merged train and then closed. Train 774 carried train 773's
  branch whole, so its 14 PRs count as landed with it.
- **A PR's phase** is the phase it was opened in, unless a table says otherwise.
- **Builders** are named from the `builder:` label, or the branch prefix when there is no label (924 of 2,992 PRs).
  **Readers** are named from the signature in the verdict, as the bot does, because builders share accounts.
  One builder label that reads like a person's name is written `harness-builder`.
- **Limits.**
  - **115 PRs that merged trains carried are no longer shown by GitHub** (their numbers do not resolve; 494
    numbers are missing in all, the last #4055). They are counted in throughput from the train bodies and are in
    no other measure. They landed on 23 Oct (41), 26 Oct (2), 27 Oct (32) and 28 Oct (40).
  - **Before 23 Oct** reads were prose, not markers: only 22% of *before* PRs carry a READ-OK. Review numbers for
    *before* cover those. The Queue of 20-22 Oct was not fetched.
  - ***After* is 36 hours**, and 38% of its PRs were still open when the data ends. Its durations are short-biased.
  - **A push that was later squashed away** leaves no event. The fixing push after a HOLD is dated by the first
    force-push, or by the commit time of the next head a verdict names.
  - **Reader effort** cannot be seen, only latency. **Faults found after landing** (on a lamp) are not in this data.
  - **Why the first builder's crew stopped on 1 Nov** is not in the PR data. The Queue only says they were away.

## 1. Throughput

**What landed, day by day.**

| day | phase | builder PRs landed on lamp-voice | by train | merged directly | of the train ones, no longer shown by GitHub | merged into another branch (not counted) | rows PRs (generated, not counted) | distinct builders (visible PRs) | trains merged | trains closed unmerged | commits on lamp-voice | lines +/- |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10-20 Tue | before | 136 | 0 | 136 | 0 | 75 | 1 | 14 | 0 | 0 | 271 | +116161 / -5428 |
| 10-21 Wed | before | 189 | 0 | 189 | 0 | 62 | 0 | 19 | 0 | 0 | 276 | +89480 / -5890 |
| 10-22 Thu | before | 176 | 0 | 176 | 0 | 4 | 6 | 20 | 1 | 0 | 255 | +139226 / -11250 |
| 10-23 Fri | before | 141 | 138 | 3 | 41 | 0 | 13 | 18 | 43 | 6 | 248 | +89072 / -5752 |
| 10-24 Sat | before | 50 | 40 | 10 | 0 | 0 | 8 | 8 | 36 | 10 | 92 | +139229 / -1138 |
| 10-25 Sun | before | 35 | 35 | 0 | 0 | 0 | 9 | 7 | 36 | 7 | 67 | +10098 / -1151 |
| 10-26 Mon | manual | 45 | 41 | 4 | 2 | 0 | 8 | 7 | 35 | 7 | 104 | +24138 / -1058 |
| 10-27 Tue | manual | 111 | 92 | 19 | 32 | 4 | 2 | 15 | 38 | 33 | 166 | +73761 / -2616 |
| 10-28 Wed | manual | 172 | 166 | 6 | 40 | 0 | 2 | 15 | 61 | 11 | 255 | +86615 / -4191 |
| 10-29 Thu | manual | 152 | 150 | 2 | 0 | 1 | 1 | 20 | 47 | 7 | 206 | +49945 / -3058 |
| 10-30 Fri | manual | 126 | 126 | 0 | 0 | 0 | 1 | 18 | 45 | 5 | 178 | +43050 / -3656 |
| 10-31 Sat | manual | 89 | 89 | 0 | 0 | 0 | 0 | 14 | 47 | 2 | 132 | +12635 / -1666 |
| 11-01 Sun | manual | 35 | 35 | 0 | 0 | 0 | 1 | 7 | 24 | 1 | 53 | +6646 / -348 |
| 11-02 Mon | manual | 54 | 54 | 0 | 0 | 3 | 1 | 11 | 28 | 4 | 87 | +15073 / -1512 |
| 11-03 Tue | manual | 64 | 64 | 0 | 0 | 0 | 3 | 15 | 35 | 10 | 105 | +39670 / -5542 |
| 11-04 Wed | manual, then Swarm PM from 11:00 | 77 | 77 | 0 | 0 | 0 | 1 | 15 | 36 | 4 | 127 | +54762 / -2843 |
| 11-05 Thu | Swarm PM | 109 | 109 | 0 | 0 | 1 | 1 | 24 | 39 | 6 | 170 | +51528 / -4967 |
| 11-06 Fri | Swarm PM | 44 | 44 | 0 | 0 | 0 | 2 | 13 | 32 | 2 | 76 | +13009 / -1316 |
| 11-07 Sat | Swarm PM | 54 | 54 | 0 | 0 | 0 | 1 | 9 | 34 | 3 | 96 | +43107 / -6781 |
| 11-08 Sun | Swarm PM | 8 | 8 | 0 | 0 | 0 | 0 | 4 | 9 | 0 | 20 | +2243 / -492 |
| 11-09 Mon | Swarm PM, then after from 09:34 | 78 | 78 | 0 | 0 | 1 | 1 | 18 | 27 | 4 | 149 | +30727 / -4213 |
| 11-10 Tue | after | 84 | 81 | 3 | 0 | 1 | 2 | 17 | 20 | 8 | 126 | +58971 / -5242 |

- 20-22 Oct came before the bot: PRs were merged one by one, and a fix or a rebase meant a new PR (section 4), so
  these counts are inflated by re-filed work.
- Weekday medians of builder PRs landed: 158 before, 111 manual (range 45-172), 77 on the cutover day, 109 and 44
  on 5 and 6 Nov, 78 on 9 Nov, 84 on 10 Nov by 21:34. Weekends: 50 and 35; 89 and 35; 54 and 8.
- By commits on `lamp-voice`, 20-23 Oct (248-276 a day) were above the best manual days (166-255 on 27-30 Oct).

| phase | days | weekday days | weekday PRs/day: min-max (median) | weekend PRs/day | weekday commits/day min-max (median) | weekday lines/day median |
|---|---|---|---|---|---|---|
| before (20-25 Oct) | 6 | 4 | 136-189 (158) | 50, 35 | 248-276 (263) | 108480 |
| manual (26 Oct-3 Nov, whole days) | 9 | 7 | 45-172 (111) | 89, 35 | 87-255 (166) | 46706 |
| cutover day 4 Nov | 1 | 1 | 77-77 (77) | - | 127-127 (127) | 57605 |
| Swarm PM (5-8 Nov, whole days) | 4 | 2 | 44-109 (76) | 54, 8 | 76-170 (123) | 35410 |
| return day 9 Nov | 1 | 1 | 78-78 (78) | - | 149-149 (149) | 34940 |
| after (10 Nov, to 21:34 GMT+7) | 1 | 1 | 84-84 (84) | - | 126-126 (126) | 64213 |

**The owner's figures.**

| count | manual weekdays 26, 27, 28, 29, 30 Oct, 2, 3 Nov | 4, 5, 6 Nov | 9, 10 Nov |
|---|---|---|---|
| **PRs carried by merged trains + PRs merged directly, UTC days (reproduces the owner's figures)** | 54, 142, 193, 122, 134, 69, 65 | 102, 87, 70 | 82, 83 |
| builder PRs landed, GMT+7 days (rows PRs left out, hidden ones in) | 45, 111, 172, 152, 126, 54, 64 | 77, 109, 44 | 78, 84 |
| commits on lamp-voice | 104, 166, 255, 206, 178, 87, 105 | 127, 170, 76 | 149, 126 |
| builder PRs opened | 60, 125, 145, 159, 168, 77, 86 | 81, 91, 89 | 110, 152 |
| builder PRs closed (landed or not) | 58, 97, 155, 164, 139, 72, 83 | 82, 118, 53 | 89, 101 |

- The first row reproduces "122-193" (27-30 Oct) and "70-102" (4-6 Nov) to the unit. It includes the generated
  rows PRs (1 to 13 a day) and the 115 PRs GitHub no longer shows. 10 Nov is counted to 14:34 UTC.
- By the same count, three of the seven manual weekdays (54, 69, 65) are below every Swarm-PM weekday.
- Section 7 shows why: the first builder's own four builders stopped landing on 2 Nov.

**Trains.** 803 train PRs: 673 merged, 130 closed unmerged (16%).

| phase | trains opened | merged | closed unmerged (share) | per day | PRs per merged train: median / p90 / max | open to merge: median / p90 | open to close (unmerged): median |
|---|---|---|---|---|---|---|---|
| 20-25 Oct (before) | 139 | 116 | 23 (17%) | 46.2 | 1 / 5 / 9 | 14 min / 23 min | 15 min |
| 26 Oct-4 Nov 11:00 (manual) | 455 | 375 | 80 (18%) | 48.1 | 2 / 4 / 18 | 22 min / 30 min | 15 min |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 158 | 140 | 18 (11%) | 32.0 | 1 / 4 / 9 | 28 min / 32 min | 22 min |
| 9 Nov 09:34-10 Nov (after) | 51 | 42 | 9 (18%) | 34.0 | 3 / 8 / 17 | 24 min / 30 min | 26 min |

- crate lane: 651 merged, open to merge median 22 min, p90 30 min, PRs per train median 2
- no-crates lane: 22 merged, open to merge median 16 min, p90 30 min, PRs per train median 1

- A train's run was 22 min at the median in the manual phase and 28 min under the Swarm PM; p90 30-32 min.
- Trains were small: a median of 2 PRs, because the bot cuts a train the moment anything is eligible.
- On 29, 30 and 31 Oct a crate train was open for 21.7, 21.9 and 21.0 hours of the day. One lane, one train at a
  time, back to back: that was the ceiling. At 2 to 3 PRs a train it is about 150 PRs a day.
- The no-crates lane (from 5 Nov) carried 23 PRs in 22 trains, 6 of them generated rows PRs. Of 31 docs-only PRs
  landed after it opened, 26 still rode the crate lane, because docs that tests read count as build inputs.

**Why a train closed unmerged.**

| reason | before | manual | Swarm PM | after | all |
|---|---|---|---|---|---|
| a carried PR got a HOLD while the train ran (its run was green or still going) | 11 | 18 | 8 | 1 | 38 |
| lamp-voice moved while it ran, so it was built again | 4 | 31 | 1 | 1 | 37 |
| its ARM64 run failed in a named crate | 2 | 13 | 3 | 1 | 19 |
| closed by hand by the PM (see below) | 2 | 11 | 0 | 1 | 14 |
| its checks had not finished in 45 min | 2 | 4 | 0 | 0 | 6 |
| a compile or lint error | 0 | 2 | 3 | 1 | 6 |
| its run failed with no failing test named | 2 | 1 | 2 | 0 | 5 |
| its run failed and a carried PR was held meanwhile | 0 | 0 | 1 | 3 | 4 |
| GitHub answered its merge with 5xx three times | 0 | 0 | 0 | 1 | 1 |

- Failing crates named on failed trains (count of trains): lamp-update 7, lamp-voice 5, lamp-voice-eval 3, lamp-memory 2, lamp-control 1, lamp-skills 1
- Train time spent on trains that never merged: 41.5 h in all (130 trains)

- Only 34 of 803 trains (4%) failed their own run. Six of those 34 merged unchanged on the next try (a flaky test
  or the runner).
- 37 were thrown away because `lamp-voice` moved under them; 31 of those in the manual phase. The 4 Nov change
  (merge as is when the files do not overlap) took it to 1 in each later phase.
- 42 were thrown away because a carried PR was held while the train ran.
- 14 were closed by hand by the PM: 6 to put a promote's or the lead's PRs first, 5 because a carried PR should
  not have ridden (a HOLD, a lamp run owed, two reads owed), 1 bot restart, 1 broken check, 1 folded into the
  next train.

**Who lands the work.**

| phase | PRs landed | distinct builders | top builder share | top 3 share | top 5 share | builders with >= 5% | median PRs per builder per active day | p90 |
|---|---|---|---|---|---|---|---|---|
| 20-25 Oct (before) | 686 | 26 | 20% | 40% | 53% | 9 | 6 | 16 |
| 26 Oct-4 Nov 11:00 (manual) | 790 | 30 | 12% | 31% | 47% | 8 | 5 | 14 |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 281 | 27 | 21% | 47% | 60% | 8 | 2 | 9 |
| 9 Nov 09:34-10 Nov (after) | 157 | 22 | 11% | 31% | 47% | 9 | 4 | 8 |

Top builders by PRs landed, per phase:
- 20-25 Oct (before): tests 138, first 70, seventh 63, sixth 46, third 44, el 43, second 37, friday 37, thirteen 36, fourth 34, twelve 33, jarvis 25
- 26 Oct-4 Nov 11:00 (manual): second 94, third 80, fourth 67, tests 64, seventh 64, friday 63, fourteen 45, sixth 42, el 36, first 35, thirteen 34, fifth 30
- 4 Nov 11:00-9 Nov 09:34 (Swarm PM): fourteen 60, friday 45, twelve 27, thirteen 20, el 18, harness-builder 18, first 18, sixth 15, blue 8, nine 7, fifth 7, seventh 5
- 9 Nov 09:34-10 Nov (after): ten 17, friday 16, fourteen 16, eighth 13, nine 12, blue 12, first 10, seventh 10, banana 9, harness-builder 7, second 6, sixth 5

- Broad, not a few. In the manual phase 30 builders landed work; the top one had 12%, the top five 47%; eight
  builders had 5% or more each. A builder landed a median of 5 PRs on a day it landed any (p90 14).
- Under the Swarm PM it narrowed: the top builder 21%, the top three 47%.
- Second, Third, Fourth and Tests together landed 305 of the manual phase's 790 (39%).

## 2. Cycle time

**The steps, per phase the PR was opened in.**

**20-25 Oct (before)**: 673 landed builder PRs; 148 (22%) carry a READ-OK marker; 186 opened as drafts (28%); 181 by train, 492 merged directly

| step | n | median | p75 | p90 |
|---|---|---|---|---|
| opened -> landed (whole cycle) | 673 | 52 min | 2.6 h | 7.5 h |
| ready -> landed (the pipeline's part) | 673 | 43 min | 2.0 h | 5.7 h |
| opened -> ready (drafts only) | 186 | 22 min | 42 min | 3.4 h |
| ready -> first verdict (reader latency) | 149 | 5 min | 12 min | 30 min |
| first verdict -> last READ-OK (all) | 148 | 20 min | 1.7 h | 6.5 h |
| first verdict -> last READ-OK (only PRs with a HOLD) | 58 | 2.0 h | 6.1 h | 16.0 h |
| last READ-OK -> landed | 148 | 24 min | 38 min | 51 min |
|   of which last READ-OK -> its train opened | 137 | 6 min | 17 min | 35 min |
|   of which the train's own run (open -> merge) | 137 | 16 min | 21 min | 23 min |

- Where the elapsed hours go (148 PRs with every step known, 646 PR-hours, spans add to 100%): draft 18%, ready to first verdict 15%, first verdict to last READ-OK 56%, last READ-OK to landed 11%
- The same for the 104 PRs opened ready (no draft time, 313 PR-hours): ready to first verdict 29%, first verdict to last READ-OK 56%, last READ-OK to landed 15%
- Within 'last READ-OK to landed' (137 train PRs): waiting for a train to pick it up 47%, the train's run 53%
- The slowest tenth (15 PRs, 56% of all PR-hours): draft 29%, ready to first verdict 14%, first verdict to last READ-OK 54%, last READ-OK to landed 2%

**26 Oct-4 Nov 11:00 (manual)**: 824 landed builder PRs; 813 (99%) carry a READ-OK marker; 210 opened as drafts (25%); 793 by train, 31 merged directly

| step | n | median | p75 | p90 |
|---|---|---|---|---|
| opened -> landed (whole cycle) | 824 | 69 min | 2.8 h | 17.6 h |
| ready -> landed (the pipeline's part) | 823 | 60 min | 2.1 h | 7.0 h |
| opened -> ready (drafts only) | 209 | 84 min | 7.8 h | 2.6 d |
| ready -> first verdict (reader latency) | 815 | 7 min | 16 min | 55 min |
| first verdict -> last READ-OK (all) | 813 | 10 min | 54 min | 4.8 h |
| first verdict -> last READ-OK (only PRs with a HOLD) | 184 | 1.9 h | 7.6 h | 24.9 h |
| last READ-OK -> landed | 813 | 36 min | 49 min | 60 min |
|   of which last READ-OK -> its train opened | 792 | 10 min | 22 min | 39 min |
|   of which the train's own run (open -> merge) | 792 | 23 min | 28 min | 29 min |

- Where the elapsed hours go (812 PRs with every step known, 6380 PR-hours, spans add to 100%): draft 39%, ready to first verdict 10%, first verdict to last READ-OK 39%, last READ-OK to landed 12%
- The same for the 605 PRs opened ready (no draft time, 1450 PR-hours): ready to first verdict 27%, first verdict to last READ-OK 43%, last READ-OK to landed 30%
- Within 'last READ-OK to landed' (791 train PRs): waiting for a train to pick it up 61%, the train's run 39%
- The slowest tenth (82 PRs, 76% of all PR-hours): draft 48%, ready to first verdict 6%, first verdict to last READ-OK 40%, last READ-OK to landed 5%

**4 Nov 11:00-9 Nov 09:34 (Swarm PM)**: 255 landed builder PRs; 255 (100%) carry a READ-OK marker; 25 opened as drafts (10%); 255 by train, 0 merged directly

| step | n | median | p75 | p90 |
|---|---|---|---|---|
| opened -> landed (whole cycle) | 255 | 2.2 h | 6.2 h | 15.2 h |
| ready -> landed (the pipeline's part) | 255 | 1.9 h | 5.3 h | 12.3 h |
| opened -> ready (drafts only) | 25 | 2.0 h | 8.2 h | 18.2 h |
| ready -> first verdict (reader latency) | 255 | 11 min | 54 min | 4.3 h |
| first verdict -> last READ-OK (all) | 255 | 14 min | 2.1 h | 5.5 h |
| first verdict -> last READ-OK (only PRs with a HOLD) | 82 | 2.2 h | 5.3 h | 16.3 h |
| last READ-OK -> landed | 255 | 45 min | 60 min | 84 min |
|   of which last READ-OK -> its train opened | 255 | 16 min | 30 min | 58 min |
|   of which the train's own run (open -> merge) | 255 | 28 min | 31 min | 32 min |

- Where the elapsed hours go (255 PRs with every step known, 1878 PR-hours, spans add to 100%): draft 5%, ready to first verdict 27%, first verdict to last READ-OK 47%, last READ-OK to landed 21%
- The same for the 230 PRs opened ready (no draft time, 1524 PR-hours): ready to first verdict 32%, first verdict to last READ-OK 44%, last READ-OK to landed 24%
- Within 'last READ-OK to landed' (255 train PRs): waiting for a train to pick it up 71%, the train's run 29%
- The slowest tenth (26 PRs, 61% of all PR-hours): draft 5%, ready to first verdict 28%, first verdict to last READ-OK 53%, last READ-OK to landed 15%

**9 Nov 09:34-10 Nov (after)**: 140 landed builder PRs; 137 (98%) carry a READ-OK marker; 15 opened as drafts (11%); 137 by train, 3 merged directly

| step | n | median | p75 | p90 |
|---|---|---|---|---|
| opened -> landed (whole cycle) | 140 | 2.0 h | 3.6 h | 8.0 h |
| ready -> landed (the pipeline's part) | 139 | 1.8 h | 3.4 h | 8.0 h |
| opened -> ready (drafts only) | 14 | 76 min | 2.1 h | 3.0 h |
| ready -> first verdict (reader latency) | 136 | 8 min | 25 min | 62 min |
| first verdict -> last READ-OK (all) | 137 | 13 min | 75 min | 3.4 h |
| first verdict -> last READ-OK (only PRs with a HOLD) | 34 | 1.6 h | 5.1 h | 18.3 h |
| last READ-OK -> landed | 137 | 60 min | 85 min | 2.4 h |
|   of which last READ-OK -> its train opened | 137 | 34 min | 54 min | 2.0 h |
|   of which the train's own run (open -> merge) | 137 | 26 min | 28 min | 30 min |

- Where the elapsed hours go (136 PRs with every step known, 499 PR-hours, spans add to 100%): draft 1%, ready to first verdict 11%, first verdict to last READ-OK 48%, last READ-OK to landed 40%
- The same for the 122 PRs opened ready (no draft time, 439 PR-hours): ready to first verdict 12%, first verdict to last READ-OK 47%, last READ-OK to landed 41%
- Within 'last READ-OK to landed' (136 train PRs): waiting for a train to pick it up 70%, the train's run 30%
- The slowest tenth (14 PRs, 44% of all PR-hours): draft 0%, ready to first verdict 4%, first verdict to last READ-OK 68%, last READ-OK to landed 28%

**Where the wait is (manual phase).**

- **Reader latency is small:** 7 min at the median from ready to the first verdict, 55 min at p90. 83% of PRs
  were named on the Queue before their first verdict, and a READ ASK was answered in 6 min at the median.
- **For a PR with no HOLD, the train is most of the wait:** 36 min from the last READ-OK to landed, of which
  10 min waiting for a train and 23 min its run. Ready to landed for these PRs is 54 min at the median.
- **Rework after a HOLD is the tail.** PRs with a HOLD (23%) took 2.8 h from ready to landed at the median
  (p90 27 h) and hold 58% of all ready-to-landed hours. The slowest tenth of PRs holds 76% of all PR-hours.
- **Drafts.** A quarter of manual-phase PRs were opened as drafts (to get a CI run) and stayed drafts for 84 min
  at the median, 2.6 days at p90. That is working time, not pipeline time; "ready to landed" leaves it out.
- **CI on the PR is not the gate.** The PR's own ARM64 run takes 16-19 min. 47% of final READ-OKs came while
  it was still running, and 27% of PRs rode a train that was opened before their own run had finished. The
  train's run is the real check; each change is built twice.

**Share landed within 1, 3, 12 and 24 hours.**

| phase opened | landed PRs | <=1 h | <=3 h | <=12 h | <=24 h | >24 h | all PRs opened at least 24 h before the data ends | of those landed <=1 h | <=3 h | <=12 h | <=24 h | ever |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 20-25 Oct (before) | 673 | 55% | 78% | 94% | 99% | 1% | 830 | 44% | 63% | 76% | 80% | 81% |
| 26 Oct-4 Nov 11:00 (manual) | 824 | 42% | 76% | 88% | 92% | 8% | 926 | 37% | 67% | 78% | 82% | 89% |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 255 | 22% | 57% | 87% | 93% | 7% | 287 | 19% | 51% | 78% | 82% | 89% |
| 9 Nov 09:34-10 Nov (after) | 140 | 19% | 65% | 94% | 98% | 2% | 88 | 15% | 44% | 62% | 65% | 68% |

**Weekday and weekend.**

| opened on | n | opened -> landed median | p90 | ready -> first verdict median | p90 |
|---|---|---|---|---|---|
| weekday | 1052 | 88 min | 15.6 h | 7 min | 88 min |
| weekend | 167 | 58 min | 9.0 h | 8 min | 1.6 h |

**The PR's own ARM64 run.**

| phase opened | n | median | p90 |
|---|---|---|---|
| 20-25 Oct (before) | 626 | 18 min | 21 min |
| 26 Oct-4 Nov 11:00 (manual) | 748 | 16 min | 20 min |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 235 | 19 min | 23 min |
| 9 Nov 09:34-10 Nov (after) | 134 | 19 min | 24 min |

**READ ASK and the Queue.** The Queue of 20-22 Oct was not fetched, so the *before* row undercounts.

| phase opened | landed PRs | with a READ ASK comment on the PR | with a READ ASK naming it on the Queue | first ask -> first verdict after it: median / p90 (n) | PRs named on the Queue before the first verdict |
|---|---|---|---|---|---|
| 20-25 Oct (before) | 673 | 0 (0%) | 4 (1%) | - / - (0) | 211 (31%) |
| 26 Oct-4 Nov 11:00 (manual) | 824 | 32 (4%) | 463 (56%) | 6 min / 29 min (409) | 681 (83%) |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 255 | 69 (27%) | 141 (55%) | 8 min / 2.2 h (162) | 211 (83%) |
| 9 Nov 09:34-10 Nov (after) | 140 | 36 (26%) | 58 (41%) | 5 min / 31 min (69) | 80 (57%) |

**Trains that did not merge.**

| phase opened | PRs landed by train | rode a train that did not merge first | median rides | p90 rides | max |
|---|---|---|---|---|---|
| 20-25 Oct (before) | 181 | 29 (16%) | 1 | 2 | 4 |
| 26 Oct-4 Nov 11:00 (manual) | 793 | 145 (18%) | 1 | 2 | 7 |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 255 | 32 (13%) | 1 | 2 | 3 |
| 9 Nov 09:34-10 Nov (after) | 137 | 20 (15%) | 1 | 3 | 5 |

## 3. Review

All 1,357 landed builder PRs that carry a marker were read by program (5,093 verdicts on PRs opened since 20 Oct).

**HOLDs and rounds.**

| phase | landed PRs | with any READ-OK/HOLD marker | with at least one HOLD (of those with markers) | HOLDs per PR: 0 / 1 / 2 / 3+ | heads read per PR: median / p90 / max | READ-OKs per PR: median / p90 | PRs with a HOLD after landing |
|---|---|---|---|---|---|---|---|
| 20-25 Oct (before) | 673 | 149 (22%) | 59 (40%) | 90 / 20 / 11 / 28 | 2 / 4 / 12 | 2 / 6 | 2 (0.3%) |
| 26 Oct-4 Nov 11:00 (manual) | 824 | 816 (99%) | 187 (23%) | 629 / 89 / 48 / 50 | 1 / 3 / 20 | 2 / 5 | 1 (0.1%) |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 255 | 255 (100%) | 82 (32%) | 173 / 49 / 21 / 12 | 1 / 3 / 8 | 2 / 4 | 1 (0.4%) |
| 9 Nov 09:34-10 Nov (after) | 140 | 137 (98%) | 34 (25%) | 103 / 15 / 9 / 10 | 1 / 4 / 12 | 2 / 5 | 3 (2.1%) |

**What review yields per PR.** A READ-OK is "with a finding" when it lists a P1-P3 or a nit of its own.

| phase opened | landed PRs with markers | a HOLD before landing | no HOLD, but a READ-OK lists a P1-P3 or nit | no finding listed by anyone | readers per PR: median / p90 | verdicts per PR: median / p90 |
|---|---|---|---|---|---|---|
| 20-25 Oct (before) | 149 | 59 (40%) | 51 (34%) | 39 (26%) | 2 / 3 | 2 / 10 |
| 26 Oct-4 Nov 11:00 (manual) | 816 | 187 (23%) | 327 (40%) | 302 (37%) | 2 / 3 | 2 / 6 |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 255 | 82 (32%) | 135 (53%) | 38 (15%) | 2 / 3 | 2 / 6 |
| 9 Nov 09:34-10 Nov (after) | 137 | 34 (25%) | 61 (45%) | 42 (31%) | 2 / 3 | 2 / 6 |

**From a HOLD to its fix and its re-read.**

| phase of the HOLD | HOLDs | HOLD -> fixing push: median / p90 (n) | fixing push -> same reader's next verdict: median / p90 (n) | HOLD -> same reader's next verdict: median / p90 (n) | next verdict by the same reader is a READ-OK | never answered by the same reader | first verdict on the new head is the same reader's |
|---|---|---|---|---|---|---|---|
| 20-25 Oct (before) | 247 | 24 min / 2.4 h (205) | 18 min / 69 min (146) | 28 min / 2.3 h (219) | 91 (37%) | 28 (11%) | 105 of 211 (50%) |
| 26 Oct-4 Nov 11:00 (manual) | 520 | 24 min / 3.7 h (472) | 13 min / 2.1 h (417) | 42 min / 4.9 h (474) | 293 (56%) | 46 (9%) | 249 of 470 (53%) |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 190 | 42 min / 3.6 h (180) | 16 min / 1.7 h (161) | 67 min / 5.5 h (166) | 131 (69%) | 24 (13%) | 75 of 180 (42%) |
| 9 Nov 09:34-10 Nov (after) | 226 | 18 min / 1.8 h (195) | 9 min / 59 min (165) | 29 min / 2.4 h (178) | 121 (54%) | 48 (21%) | 70 of 192 (36%) |

- A fix is pushed 24 min after a HOLD at the median (p90 3.7 h). The same reader's next verdict follows the push
  by 13 min at the median (p90 2.1 h).
- **The same reader clears its own HOLD**: 95% of the manual phase's HOLDs on PRs that landed were cleared by a
  READ-OK from the reader who posted them (the bot requires it). HOLD to that READ-OK: 61 min at the median,
  17 h at p90.
- But the *first* verdict on the fixed head comes from the same reader only about half the time (53% manual,
  42% Swarm PM, 36% after): another reader often gets there first, and the PR then waits for the holder anyway.
- 38% of same-reader re-reads in the manual phase were another HOLD (21% under the Swarm PM, 32% after).

**What a READ-OK says.**

| phase of the READ-OK | READ-OKs | a reader's first verdict on the PR | of those, no finding listed | of those, a P1-P3 / nit listed | lifting the reader's own HOLD | a restated read on a new head (carry) | carries as a share of all READ-OKs |
|---|---|---|---|---|---|---|---|
| 20-25 Oct (before) | 447 | 216 | 114 (53%) | 102 (47%) | 109 | 122 | 27% |
| 26 Oct-4 Nov 11:00 (manual) | 2062 | 1230 | 710 (58%) | 520 (42%) | 407 | 425 | 21% |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 694 | 372 | 116 (31%) | 256 (69%) | 189 | 133 | 19% |
| 9 Nov 09:34-10 Nov (after) | 624 | 318 | 146 (46%) | 172 (54%) | 217 | 89 | 14% |

- **58% of first READ-OKs in the manual phase list no finding at all**; 42% carry a P3 or a nit. Under the Swarm
  PM only 31% were clean. The classifier was checked by hand on 56 READ-OKs; after two pattern fixes it agrees
  on 54.
- **21% of all READ-OKs restate a read on a new head** after a rebase or a squash (27% before, 14% after).

**What 60 HOLDs found** (random, seed in `q3_sample.py`; 8 before, 26 manual, 13 Swarm PM, 13 after; each read
in full).

| what the HOLD named | before | manual | Swarm PM | after | all 60 |
|---|---|---|---|---|---|
| a behavioural fault: a named scenario in which the product does the wrong thing | 4 | 17 | 9 | 12 | 42 (70%) |
| a missing test, or a test of the PR's own that fails or is unsound | 2 | 2 | 2 | 0 | 6 (10%) |
| a doc, run sheet or contract that does not match the code | 0 | 1 | 1 | 1 | 3 (5%) |
| a process condition: rebase first, evidence owed, a second read owed | 2 | 6 | 1 | 0 | 9 (15%) |
| style | 0 | 0 | 0 | 0 | 0 |

- Of the 42 behavioural HOLDs, 7 repeat or confirm a fault another reader had already posted on that PR, so 35
  of 60 (58%) are first reports. At least ten concern privacy or physical safety.
- 7 of the 9 process HOLDs are one reader's (Reviewer-two): "P1/P2 none" followed by a condition. In the census,
  30% of that reader's 207 HOLDs open that way, against 1% (9 of 729) for everyone else.
- Read at PR level: 177 of the manual phase's 816 landed PRs (22%) had at least one HOLD that names a finding.

Examples:

- Behavioural, privacy P1: "A's name is told to someone who may not be A." <https://github.com/autonomous-ai/lampOS/pull/3792>
- Behavioural, compatibility: "an older lamp-eyes refuses the new unit and restarts in a loop." <https://github.com/autonomous-ai/lampOS/pull/3642>
- Behavioural, shown with a probe: "one held reminder starts a skill run every second for as long as it stays held." <https://github.com/autonomous-ai/lampOS/pull/3525>
- Behavioural, privacy P1: "the 'say' can read the person's mail and calendar, and their memory, aloud to whoever is at the desk." <https://github.com/autonomous-ai/lampOS/pull/6062>
- Missing test: "restoring `.or(line…)` or passing `None` for `carried` at the call site would still pass every test." <https://github.com/autonomous-ai/lampOS/pull/5325>
- Doc mismatch: "The table's climb row reads the refusal line as success, so a failed climb would be posted as 'the climb worked'." <https://github.com/autonomous-ai/lampOS/pull/4561>
- Process: "Readiness only: carry the offered head onto latest lamp-voice … Source P1/P2: none." <https://github.com/autonomous-ai/lampOS/pull/3449>

**What a second read buys.**

| phase | heads with a READ-OK and then another reader's verdict | the other reader also passed it | the other reader held it | PRs involved |
|---|---|---|---|---|
| 26 Oct-4 Nov 11:00 (manual) | 657 | 545 (83%) | 112 (17%) | 461 |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 238 | 191 (80%) | 47 (20%) | 169 |
| 9 Nov 09:34-10 Nov (after) | 177 | 132 (75%) | 45 (25%) | 118 |

- Leaving Reviewer-two out as the second reader, it is 137 of 894 (15%).
- Seven HOLDs say they replace the reader's own earlier READ-OK after another reader's finding, for example
  <https://github.com/autonomous-ai/lampOS/pull/5509> ("this replaces my READ-OK … Heron is right").

**Is review worth its latency?** Yes, on this data. It costs a clean PR 7 minutes at the median. It held about
one landed PR in five for a named finding, and four in five of the findings read were faults in behaviour, tests
or docs. Its real cost is not the first read but the rounds after a HOLD and the reads restated after rebases.

**Rubber-stamping.** No sign of bare stamps, and speed is weak evidence here because readers are agents.

| lines changed | first READ-OKs | head commit -> READ-OK: median / p10 (n with a known head time) | under 2 min after the head's commit | under 5 min | READ-OK text under 300 chars |
|---|---|---|---|---|---|
| 1-50 | 327 | 8 min / 2 min (326) | 39 (12.0%) | 122 (37.4%) | 11 (3%) |
| 51-200 | 336 | 14 min / 3 min (336) | 18 (5.4%) | 76 (22.6%) | 8 (2%) |
| 201-500 | 207 | 17 min / 4 min (205) | 6 (2.9%) | 33 (16.1%) | 2 (1%) |
| 501-1500 | 149 | 26 min / 5 min (149) | 1 (0.7%) | 18 (12.1%) | 3 (2%) |
| over 1500 | 63 | 33 min / 5 min (62) | 2 (3.2%) | 7 (11.3%) | 0 (0%) |

- 2% of first READ-OKs are under 300 characters.
- 14 first READ-OKs came within 3 min of the head's commit on a diff of 300 lines or more (of 322 such diffs).
  Read by hand: two restate a read of the same patch filed earlier
  (<https://github.com/autonomous-ai/lampOS/pull/3510>, <https://github.com/autonomous-ai/lampOS/pull/4884>),
  one is a verbatim extraction (<https://github.com/autonomous-ai/lampOS/pull/3515>), and all 14 name functions
  and lines.
- Depth cannot be read from speed. What a second reader adds (the table above) is the better measure: about one
  head in six. Reads are often scoped to one side of a change, so that is what a second pair of eyes adds, not
  the first reader's miss rate.

**Readers.**

| phase | verdicts (READ-OK + HOLD) | signed | distinct signed readers | top reader share | top 3 share | top 5 share | top 3 |
|---|---|---|---|---|---|---|---|
| 20-25 Oct (before) | 709 | 708 (100%) | 12 | 40% | 80% | 90% | reviewer-two 282, reviewer-three 155, reviewer-lead 129 |
| 26 Oct-4 Nov 11:00 (manual) | 2620 | 2616 (100%) | 25 | 27% | 61% | 72% | reviewer-three 716, reviewer-two 495, reviewer-lead 379 |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 907 | 792 (87%) | 22 | 24% | 50% | 72% | thirteen 189, reviewer-lead 114, el 96 |
| 9 Nov 09:34-10 Nov (after) | 857 | 741 (86%) | 22 | 22% | 52% | 65% | thirteen 161, second 149, reviewer-two 72 |

- All signed readers, 26 Oct on (verdicts): reviewer-three 769, reviewer-two 567, reviewer-lead 538, thirteen 460, second 265, third 195, first builder 181, el 157, fourth 144, fourteen 138, jarvis 120, tests 108, twelve 104, heron 93, seventh 48, harness-reviewer 46, sixth 38, banana 30, fifth 27, app only 26, mobile 17, friday 16, blue 15, eighth 12, nine 9, ten 8, faye 8, swarm reviewer 4, backend2 1, bench 1, harness-builder 1, backend 1, reviewer 1, wren 1

| reader | first verdicts | HOLD share |
|---|---|---|
| reviewer-three | 330 | 11% |
| reviewer-lead | 302 | 24% |
| reviewer-two | 223 | 15% |
| thirteen | 193 | 20% |
| second | 154 | 12% |
| first builder | 117 | 4% |
| third | 108 | 10% |
| fourth | 102 | 9% |
| el | 93 | 8% |
| fourteen | 93 | 13% |
| tests | 76 | 4% |
| jarvis | 62 | 11% |
| twelve | 59 | 10% |
| heron | 41 | 10% |

- 25 named readers in the manual phase; the top three gave 61% of verdicts, and two of them are on the first
  builder's account.
- 53 verdicts are signed with the PR's own builder name: 38 are HOLDs a builder put on its own PR as a brake
  ("lamp check pending", "two privacy reads only"), 15 are READ-OKs lifting them. No PR landed with its own
  builder as the only reader.

**TWO READS.**

TWO READS asked as the bot reads it: in the PR body, or in a comment that opens with TWO READS or carries a READ ASK.

| phase opened | landed PRs with markers | asking TWO READS | of those, with a HOLD | opened -> landed median | not asking: with a HOLD | opened -> landed median | TWO READS PRs landed with fewer than two distinct READ-OK readers |
|---|---|---|---|---|---|---|---|
| 20-25 Oct (before) | 149 | 0 (0%) | 0 (0%) | - | 59 (40%) | 69 min | 0 |
| 26 Oct-4 Nov 11:00 (manual) | 816 | 48 (6%) | 24 (50%) | 14.4 h | 163 (21%) | 66 min | 1 (#4945) |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 255 | 51 (20%) | 29 (57%) | 3.9 h | 53 (26%) | 1.8 h | 4 (#5185, #5278, #5337, #5580) |
| 9 Nov 09:34-10 Nov (after) | 137 | 21 (15%) | 6 (29%) | 3.8 h | 28 (24%) | 1.8 h | 0 |

- A PR that asks two reads is held half the time and takes far longer.
- Four real slips where two reads were asked and one READ-OK reader is on the PR: #4945, #5185, #5278, #5580
  (#5337's body says two reads do not apply). The bot's README records #5580.

## 4. Waste

**PRs closed without landing** (train-carried PRs are landed, not counted here).

| phase opened | PRs opened | landed | closed without landing | still open | of the closed: the same work landed under another PR (successor landed, or same title on lamp-voice) | closed and nothing landed |
|---|---|---|---|---|---|---|
| 20-25 Oct (before) | 1002 | 800 (80%) | 199 (20%) | 3 (0%) | 171 (86% of closed) | 28 (2.8% of opened) |
| 26 Oct-4 Nov 11:00 (manual) | 938 | 832 (89%) | 81 (9%) | 25 (3%) | 51 (63% of closed) | 30 (3.2% of opened) |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 294 | 256 (87%) | 15 (5%) | 23 (8%) | 10 (67% of closed) | 5 (1.7% of opened) |
| 9 Nov 09:34-10 Nov (after) | 251 | 142 (57%) | 14 (6%) | 95 (38%) | 9 (64% of closed) | 5 (2.0% of opened) |

| reason (from the closing comments) | before | manual | Swarm PM | after | all | median lines | had a READ-OK |
|---|---|---|---|---|---|---|---|
| refiled by its own builder | 116 | 29 | 6 | 5 | 156 | 291 | 32 (21%) |
| carried or taken over by another | 20 | 7 | 6 | 6 | 39 | 375 | 16 (41%) |
| declined, dropped or overtaken | 10 | 14 | 0 | 1 | 25 | 435 | 8 (32%) |
| same title landed under another PR | 16 | 5 | 0 | 0 | 21 | 306 | 6 (29%) |
| said to be on lamp-voice already | 7 | 9 | 1 | 1 | 18 | 398 | 9 (50%) |
| a draft or probe never meant to merge | 10 | 8 | 0 | 0 | 18 | 464 | 3 (17%) |
| stacked on another branch | 12 | 0 | 1 | 0 | 13 | 640 | 0 (0%) |
| no reason given | 7 | 4 | 1 | 1 | 13 | 211 | 4 (31%) |
| duplicate of another PR | 1 | 4 | 0 | 0 | 5 | 21 | 0 (0%) |
| no reason given (no comment) | 0 | 1 | 0 | 0 | 1 | 2584 | 0 (0%) |

- **Before 23 Oct, one PR in five was closed unlanded**, almost all re-filed: "force-push is refused", so each fix
  or rebase was a new PR (for example <https://github.com/autonomous-ai/lampOS/pull/2375>).
- **In the manual phase it is 9%**, and still mostly the same work filed again: after the bot's conflict note a
  session that "cannot force-push" pushes a new branch and opens a new PR, and readers restate their reads there
  (<https://github.com/autonomous-ai/lampOS/pull/4007>, <https://github.com/autonomous-ai/lampOS/pull/4295>,
  <https://github.com/autonomous-ai/lampOS/pull/5093>).
- **Work truly dropped is 2-3% of PRs** in every phase: declined by the PM or the lead, overtaken, or parked.
  40 such PRs since 26 Oct. Real duplicates of another builder's work: 5.
- 103 generated rows PRs went through the same pipeline; 39 never landed, each replaced by the next hour's.

**Rebases and conflicts.**

| phase opened | landed PRs | force-pushes per PR: mean / median / p90 / max | PRs force-pushed at least once | 3 times or more | bot 'conflicts with lamp-voice' notes | PRs told so | bot 'stacked on an open PR' notes | other comments asking for a rebase or naming a conflict | PRs with one |
|---|---|---|---|---|---|---|---|---|---|
| 20-25 Oct (before) | 800 | 1.0 / 0 / 3 / 13 | 341 (43%) | 102 (13%) | 26 | 13 (2%) | 1 | 156 | 110 (14%) |
| 26 Oct-4 Nov 11:00 (manual) | 832 | 0.9 / 0 / 3 / 21 | 284 (34%) | 87 (10%) | 95 | 57 (7%) | 13 | 101 | 69 (8%) |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 256 | 0.7 / 0 / 2 / 7 | 92 (36%) | 22 (9%) | 18 | 14 (5%) | 2 | 27 | 23 (9%) |
| 9 Nov 09:34-10 Nov (after) | 142 | 0.7 / 0 / 3 / 11 | 49 (35%) | 15 (11%) | 30 | 13 (9%) | 8 | 12 | 11 (8%) |

- All builder PRs since 20 Oct, landed or not: 2168 force-pushes on 909 PRs; 277 bot conflict notes on 142 PRs; 46 stacked notes.
- 26 Oct-4 Nov 11:00 (manual): opened -> landed median 10.0 h for the 55 train PRs the bot told to rebase, 64 min for the 737 others
- 4 Nov 11:00-9 Nov 09:34 (Swarm PM): opened -> landed median 4.6 h for the 14 train PRs the bot told to rebase, 2.0 h for the 241 others

- A third of landed PRs were force-pushed at least once, one in ten three times or more.
- The bot told 7% of manual-phase PRs that they conflict. Those took 10.0 h to land at the median, against 64 min.

**`HOLD train N`.** 22 comments on 22 PRs in three weeks. Each was read with what followed it.

| phase | HOLD train comments | PRs | compile or lint | test failed in its crate | in a dependent crate | no-crates checks | PR later landed | landed with no change to its head after the HOLD | next READ-OK after: median / p90 | HOLD -> landed median |
|---|---|---|---|---|---|---|---|---|---|---|
| 20-25 Oct (before) | 2 | 2 | 0 | 2 | 0 | 0 | 2 (100%) | 0 (0%) | 26 min / 27 min | 81 min |
| 26 Oct-4 Nov 11:00 (manual) | 14 | 14 | 2 | 7 | 5 | 0 | 14 (100%) | 9 (64%) | 11 min / 70 min | 50 min |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 4 | 4 | 3 | 1 | 0 | 0 | 4 (100%) | 1 (25%) | 41 min / 44 min | 86 min |
| 9 Nov 09:34-10 Nov (after) | 2 | 2 | 1 | 1 | 0 | 0 | 1 (50%) | 1 (50%) | 27 min / 27 min | 1.8 h |

| what it was | count | PRs |
|---|---|---|
| a real break that only shows when composed with what landed after the PR's base (a duplicate constant, a new struct field, a changed signature) | 6 | #3142, #4370, #4998, #5072, #5243, #5617 |
| a real break of the PR's own: its own test or census failed, or an older head was carried | 6 | #3371, #4166, #4207, #4688, #5070, #5945 |
| not this PR: another PR in the same train broke it | 8 | #4165, #4524, #4530, #4685, #4992, #5037, #5067, #5089 |
| a flaky test | 1 | #5363 |
| unclear | 1 | #5930 |

- The train's one run caught 12 real breaks; 6 of them no per-PR check could have seen.
- The bot blames by crate, and was wrong 8 times in 22. An innocent PR then needs a reader to restate its READ-OK:
  minutes at the median, 17 h in the worst case (<https://github.com/autonomous-ai/lampOS/pull/5089>).

**Issues taken, then returned or moved; taken and silent.**

| phase opened | issues taken | status:taken removed while open | builder label changed after it was taken | builder label changed at all | closed with no PR and not as not-planned |
|---|---|---|---|---|---|
| 20-25 Oct (before) | 90 | 29 (32%) | 9 (10%) | 27 | 41 |
| 26 Oct-4 Nov 11:00 (manual) | 109 | 8 (7%) | 9 (8%) | 23 | 23 |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 79 | 2 (3%) | 5 (6%) | 24 | 10 |
| 9 Nov 09:34-10 Nov (after) | 20 | 0 (0%) | 1 (5%) | 3 | 4 |

- Open issues labelled status:taken at the end of the data: 82. Last comment, PR opened/closed or claim more than 6 h ago: 68; more than 24 h: 53; more than 3 days: 32; more than 7 days: 20. Median idle 33.6 h.
- Open task issues in all: 158; with a builder label but not taken: 70; with no builder label: 6.

**Other waste in the data.**

- Reads restated on a new head: 21% of READ-OKs (section 3).
- `NEXT TRAIN` posts on the Queue, which the rules call "only an ask": 240 in the manual phase (4% of Queue
  comments), 140 under the Swarm PM (6%), 122 after (10%).
- The 4 Nov re-cut: 59 issues closed and 57 opened in one day, 28 of them "the rest of #N". Six days later 9 of
  the 28 were taken and 7 had a landed PR.
- Trains thrown away: 41.5 hours of train runs that never merged (130 trains).

## 5. Tasks

441 task issues since 20 Oct (Queues and channels left out).

**Opened, and by whom.** Accounts are shared, so "by whom" is by account. The PM's account also hosts builders.

| phase | issues | per weekday (median) | per weekend day | from the PM's account | from the lead's agent's account | other accounts | the Swarm app | labelled proposal |
|---|---|---|---|---|---|---|---|---|
| 20-25 Oct (before) | 125 | 16 | 3 | 118 (94%) | 0 (0%) | 7 (6%) | 0 | 3 |
| 26 Oct-4 Nov 11:00 (manual) | 148 | 16 | 5 | 103 (70%) | 31 (21%) | 14 (9%) | 0 | 14 |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 121 | 28 | 8 | 91 (75%) | 16 (13%) | 14 (12%) | 0 | 11 |
| 9 Nov 09:34-10 Nov (after) | 47 | 24 | - | 30 (64%) | 11 (23%) | 6 (13%) | 0 | 13 |

Per GMT+7 day: 10-20 23, 10-21 10, 10-22 87, 10-23 2, 10-24 3, 10-26 3, 10-27 36, 10-28 24, 10-29 17, 10-30 16, 10-31 5, 11-02 16, 11-03 20, 11-04 57, 11-05 12, 11-06 38, 11-07 8, 11-09 33, 11-10 31

- By account, 94% of issues came from the PM's account before 26 Oct and 64-75% after; the lead's agent's
  account opened 13-23%. So "only the PM opens issues" was not kept.
- Under the Swarm PM about 90 of the 121 bodies are signed by the PM agent.

**From opened to closed.**

| phase opened | issues | given a builder label | taken (status:taken) | opened -> taken: median / p90 | with a PR naming it | taken -> first PR: median / p90 | opened -> first PR: median / p90 | closed | opened -> closed: median / p90 | closed as not planned |
|---|---|---|---|---|---|---|---|---|---|---|
| 20-25 Oct (before) | 125 | 122 (98%) | 90 (72%) | 16 min / 7.8 h | 68 (54%) | 74 min / 23.3 h (n=55; 4 had a PR before the claim) | 3.3 h / 4.4 d | 109 (87%) | 24.0 h / 13.3 d | 12 |
| 26 Oct-4 Nov 11:00 (manual) | 148 | 141 (95%) | 109 (74%) | 7 min / 17.0 h | 112 (76%) | 52 min / 28.3 h (n=80; 10 had a PR before the claim) | 89 min / 39.8 h | 126 (85%) | 2.3 d / 7.1 d | 7 |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 121 | 117 (97%) | 79 (65%) | 6 min / 7.7 h | 71 (59%) | 1.9 h / 14.1 h (n=55; 6 had a PR before the claim) | 3.4 h / 47.7 h | 53 (44%) | 26.8 h / 2.8 d | 8 |
| 9 Nov 09:34-10 Nov (after) | 47 | 44 (94%) | 20 (43%) | 28 min / 64 min | 23 (49%) | 33 min / 6.0 h (n=9; 3 had a PR before the claim) | 35 min / 7.1 h | 11 (23%) | 16.3 h / 16.9 h | 0 |

- An issue is claimed within minutes (median 7 min) and its first PR opens 52 min after the claim at the median.
- It then stays open for days (median 2.3 days in the manual phase), because it closes only when the fix is
  promoted to stable.

**Body shape.** Every issue, not a sample of 100.

| phase opened | issues | median body length (chars) | p90 | why | wanted | hand back | most likely wrong | done when | what happens | the piece | what it blocks | all four of Why / Wanted / Hand back / Most likely wrong |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 12-19 Oct (the first task issues) | 221 | 1598 | 2648 | 25% | 15% | 16% | 12% | 3% | 1% | 0% | 0% | 22 (10%) |
| 20-25 Oct (before) | 125 | 654 | 1621 | 0% | 1% | 0% | 0% | 87% | 2% | 5% | 1% | 0 (0%) |
| 26 Oct-4 Nov 11:00 (manual) | 148 | 1333 | 2350 | 3% | 1% | 0% | 1% | 74% | 10% | 22% | 12% | 0 (0%) |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 121 | 971 | 2165 | 3% | 6% | 0% | 0% | 56% | 12% | 0% | 0% | 0 (0%) |
| 9 Nov 09:34-10 Nov (after) | 47 | 1490 | 2618 | 6% | 26% | 0% | 0% | 77% | 0% | 0% | 0% | 0 (0%) |

- Of the first issues (12-19 Oct), 25% have a Why heading and 10% have all four of Why / Wanted / Hand back /
  Most likely wrong. From 20 Oct none has all four: the shape is a short description and "Done when" (56-87%).
- Median body: 1,333 characters in the manual phase.

**PRs per issue.**

| phase opened | closed issues | with no PR | PRs per issue: median / p90 / max | landed PRs per issue: median / p90 | issues with 5 or more PRs |
|---|---|---|---|---|---|
| 20-25 Oct (before) | 109 | 49 (45%) | 1 / 4 / 45 | 0 / 3 | 10 (9%) |
| 26 Oct-4 Nov 11:00 (manual) | 126 | 28 (22%) | 1 / 5 / 58 | 1 / 4 | 14 (11%) |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 53 | 16 (30%) | 1 / 3 / 6 | 1 / 3 | 1 (2%) |
| 9 Nov 09:34-10 Nov (after) | 11 | 4 (36%) | 1 / 2 / 6 | 1 / 1 | 1 (9%) |

Builder PRs since 20 Oct whose body names a task issue near the top:

| phase opened | builder PRs | Part of #N | any form (Part of, For, Fixes, Closes, follow-up of) | a closing keyword (Fixes/Closes/Resolves), which the rule forbids |
|---|---|---|---|---|
| 20-25 Oct (before) | 1002 | 362 (36%) | 488 (49%) | 17 |
| 26 Oct-4 Nov 11:00 (manual) | 938 | 404 (43%) | 490 (52%) | 44 |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 294 | 74 (25%) | 145 (49%) | 39 |
| 9 Nov 09:34-10 Nov (after) | 251 | 56 (22%) | 79 (31%) | 10 |

- Only half of the PRs name a task issue. In the manual phase 17% name only the Queue ("For #3504 …"), 18% name
  another PR or issue in passing, 13% name nothing.
- "One PR per task" is not what happened: a median of 1, but 11% of closed issues had five or more, up to 58.
- Closing keywords, which the rule forbids, are on 44 manual-phase PRs and 39 Swarm-PM PRs. 10 of the 15 PRs the
  Swarm app opened say `Closes #N`.

**The 30-comment and 3-day rule.**

| phase opened | issues | over 30 comments | open over 3 days (or still open after 3 days) | either | over 100 comments | median comments |
|---|---|---|---|---|---|---|
| 20-25 Oct (before) | 125 | 8 (6%) | 58 (46%) | 60 (48%) | 0 | 6 |
| 26 Oct-4 Nov 11:00 (manual) | 148 | 8 (5%) | 74 (50%) | 76 (51%) | 0 | 6 |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 121 | 3 (2%) | 57 (47%) | 58 (48%) | 0 | 4 |
| 9 Nov 09:34-10 Nov (after) | 47 | 0 (0%) | 0 (0%) | 0 (0%) | 0 | 1 |

- Half of all issues pass 3 days (46-50%). Few pass 30 comments (2-6%).

**How many issues a builder held at once.**

| phase | builders holding any | builder-hours holding any | share of those hours with more than 4 | with more than 8 | highest at once (builder) | median of each builder's peak |
|---|---|---|---|---|---|---|
| 20-25 Oct (before) | 22 | 2523 | 6% | 0% | 9 (sixth) | 4 |
| 26 Oct-4 Nov 11:00 (manual) | 28 | 4635 | 20% | 3% | 11 (mobile) | 3 |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 28 | 2526 | 20% | 1% | 9 (thirteen) | 2 |
| 9 Nov 09:34-10 Nov (after) | 24 | 813 | 28% | 0% | 9 (harness-builder) | 2 |

Peak issues held at once, per builder (manual phase): mobile 11, tests 9, el 9, sixth 8, thirteen 7, fourth 6, seventh 6, jarvis 6, harness-builder 5, fifth 5, twelve 4, third 4, friday 4, migrate 3, second 3, first 3, backend2 2, nine 2, ten 2, eighth 2
Peak, Swarm PM phase: thirteen 9, tests 8, harness-builder 8, sixth 7, mobile 5, jarvis 5, twelve 5, migrate 4, swarm 4, first 4, friday 4, seventh 3, second 3, el 3, backend2 2, fifth 2, bench 2, tiers 2, nine 1, backend 1

- The limit of four was exceeded for a fifth of all builder-hours in the manual phase; peaks of 8 to 11.
- 82 issues are open and taken at the end of the data. On 53 of them nothing (no comment, no PR naming it) has
  happened for over 24 h; on 32 for over 3 days; on 20 for over 7 days. Since only half the PRs name their issue,
  this overstates silence somewhat.

## 6. Size and scope

| phase opened | landed PRs | lines changed (added + deleted): median / p75 / p90 / max | files: median / p90 / max | commits: median / p90 | docs only | touches a crate, Cargo or a workflow | other (scripts, skills, data) |
|---|---|---|---|---|---|---|---|
| 20-25 Oct (before) | 673 | 226 / 598 / 1294 / 107023 | 5 / 16 / 255 | 1 / 2 | 52 (8%) | 563 (84%) | 58 (9%) |
| 26 Oct-4 Nov 11:00 (manual) | 824 | 140 / 432 / 985 / 13729 | 4 / 14 / 103 | 1 / 3 | 96 (12%) | 648 (79%) | 80 (10%) |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 255 | 203 / 532 / 931 / 17596 | 5 / 13 / 59 | 1 / 4 | 12 (5%) | 211 (83%) | 32 (13%) |
| 9 Nov 09:34-10 Nov (after) | 140 | 138 / 379 / 1304 / 23856 | 4 / 13 / 49 | 1 / 2 | 23 (16%) | 91 (65%) | 26 (19%) |

**Does cycle time or the HOLD rate grow with size?** Yes, both, strongly. Reader latency does not.

**Manual phase, landed builder PRs** (n=824)

| lines changed | PRs | share with a HOLD | heads read: median | opened -> landed: median / p90 | ready -> first verdict: median / p90 | first verdict -> last READ-OK, PRs with a HOLD: median | landed within 3 h |
|---|---|---|---|---|---|---|---|
| 1-50 | 239 | 3% | 1 | 52 min / 2.1 h | 4 min / 21 min | 46 min | 92% |
| 51-200 | 233 | 15% | 1 | 64 min / 5.4 h | 8 min / 1.5 h | 89 min | 83% |
| 201-500 | 172 | 37% | 2 | 1.5 h / 15.6 h | 7 min / 55 min | 62 min | 72% |
| 501-1500 | 127 | 43% | 2 | 2.6 h / 2.3 d | 7 min / 1.6 h | 3.2 h | 55% |
| over 1500 | 53 | 53% | 2 | 4.8 h / 45.2 h | 11 min / 3.9 h | 4.9 h | 34% |

**Swarm PM phase, landed builder PRs** (n=255)

| lines changed | PRs | share with a HOLD | heads read: median | opened -> landed: median / p90 | ready -> first verdict: median / p90 | first verdict -> last READ-OK, PRs with a HOLD: median | landed within 3 h |
|---|---|---|---|---|---|---|---|
| 1-50 | 48 | 15% | 1 | 70 min / 6.8 h | 7 min / 4.2 h | 1.8 h | 79% |
| 51-200 | 79 | 18% | 1 | 81 min / 9.9 h | 13 min / 3.9 h | 41 min | 73% |
| 201-500 | 61 | 36% | 1 | 3.2 h / 24.4 h | 13 min / 5.3 h | 2.7 h | 46% |
| 501-1500 | 58 | 59% | 2 | 3.9 h / 45.9 h | 14 min / 2.7 h | 2.6 h | 33% |
| over 1500 | 9 | 56% | 2 | 5.5 h / 10.9 h | 36 min / 5.3 h | 3.9 h | 22% |

**26 Oct on, all phases together** (n=1219)

| lines changed | PRs | share with a HOLD | heads read: median | opened -> landed: median / p90 | ready -> first verdict: median / p90 | first verdict -> last READ-OK, PRs with a HOLD: median | landed within 3 h |
|---|---|---|---|---|---|---|---|
| 1-50 | 326 | 5% | 1 | 55 min / 3.5 h | 5 min / 28 min | 74 min | 88% |
| 51-200 | 357 | 15% | 1 | 70 min / 6.0 h | 9 min / 1.6 h | 69 min | 81% |
| 201-500 | 259 | 37% | 2 | 1.8 h / 15.5 h | 9 min / 1.6 h | 85 min | 65% |
| 501-1500 | 202 | 49% | 2 | 3.2 h / 47.2 h | 8 min / 1.9 h | 2.7 h | 47% |
| over 1500 | 75 | 55% | 2 | 5.5 h / 37.3 h | 11 min / 4.3 h | 5.0 h | 29% |

| kind | PRs | lines: median | share with a HOLD | opened -> landed: median / p90 | ready -> first verdict: median | last READ-OK -> landed: median |
|---|---|---|---|---|---|---|
| docs only (Markdown) | 131 | 12 | 7% | 55 min / 3.2 h | 6 min | 42 min |
| touches a crate, Cargo or a workflow | 950 | 220 | 29% | 1.6 h / 21.0 h | 8 min | 39 min |
| other (scripts, skills, data) | 138 | 94 | 16% | 64 min / 3.6 h | 6 min | 43 min |

Rank correlation (Spearman), 26 Oct on, n=1219: lines vs opened->landed 0.47; lines vs heads read 0.42; lines vs HOLD count 0.42; files vs opened->landed 0.38

- Docs-only PRs (median 12 lines) were held 7% of the time, yet waited 42 min after their READ-OK, as long as
  code: they rode the same trains.
- **Size labels.** `size:s`, `size:m` and `size:l` were created on 9 Nov at 19:21 UTC. They are on 0 issues and
  0 PRs. The data cannot say whether they match actual time. The table above is what actual size predicts.

## 7. What changed at the cutover

The manual phase is cut in two at Sun 1 Nov 18:00, when the first builder's own crew went quiet, so that the PM
change (B to C) can be read apart from the crew change (A to B, and C to D).

| measure | A. 26 Oct-1 Nov, first builder PM, its crew working | B. 2 Nov-4 Nov 11:00, first builder PM, its crew away | C. 4 Nov 11:00-9 Nov 09:34, Swarm PM, crew away | D. 9 Nov 09:34-10 Nov 21:34, first builder PM, crew back |
|---|---|---|---|---|
| weekdays in the span | 5.0 | 2.5 | 2.9 | 1.5 |
| builder PRs opened per weekday | 125 | 69 | 80 | 161 |
| builder PRs landed per weekday (hidden ones in) | 121 | 55 | 74 | 104 |
|   of which by Second, Third, Fourth, Tests | 41 | 0 | 0 | 8 |
|   by everyone else | 80 | 55 | 74 | 96 |
| distinct builders landing work in the span | 27 | 16 | 27 | 22 |
| trains opened per weekday | 58 | 37 | 38 | 34 |
| trains closed unmerged | 66 of 363 (18%) | 14 of 92 (15%) | 18 of 158 (11%) | 9 of 51 (18%) |
| PRs per merged train, mean | 2.4 | 1.8 | 2.1 | 3.8 |
| opened -> landed, median / p90 (PRs opened in the span) | 64 min / 10.1 h (n=669) | 1.5 h / 25.8 h (n=155) | 2.2 h / 15.2 h (n=255) | 2.0 h / 8.0 h (n=140) |
| ready -> landed, median / p90 | 57 min / 4.2 h | 72 min / 20.2 h | 1.9 h / 12.3 h | 1.8 h / 8.0 h |
| ready -> first verdict, median / p75 / p90 | 6 min / 14 min / 37 min | 9 min / 33 min / 2.5 h | 11 min / 54 min / 4.3 h | 8 min / 25 min / 62 min |
| first verdict later than 1 h after ready | 8% | 17% | 24% | 10% |
| last READ-OK -> landed, median / p90 | 34 min / 59 min | 41 min / 65 min | 45 min / 84 min | 60 min / 2.4 h |
| landed within 3 h of opening | 80% | 59% | 57% | 65% |
| landed PRs with a HOLD | 21% | 30% | 32% | 25% |
| verdicts (READ-OK + HOLD) per weekday | 395 | 162 | 252 | 556 |
|   share from readers on the first builder's account (its own reads included) | 79% | 10% | 10% | 41% |
| closed without landing (of PRs opened in the span) | 65 of 751 (9%) | 16 of 175 (9%) | 14 of 287 (5%) | 14 of 243 (6%) |
| still open at the end of the data | 17 (2%) | 4 (2%) | 18 (6%) | 89 (37%) |
| task issues opened per weekday | 19 | 19 | 38 | 33 |
| task issues closed per weekday | 12 | 21 | 32 | 17 |
| median lines per landed PR | 125 | 231 | 203 | 138 |

| day | builder PRs opened | landed | of which by Second, Third, Fourth, Tests | median opened -> landed of PRs landed that day | median ready -> first verdict of first verdicts that day | p90 | verdicts | of which by readers on the first builder's account | task issues opened | closed |
|---|---|---|---|---|---|---|---|---|---|---|
| 10-30 Fri | 163 | 126 | 59 | 65 min | 6 min | 31 min | 408 | 275 | 16 | 29 |
| 10-31 Sat | 95 | 89 | 67 | 57 min | 6 min | 21 min | 194 | 175 | 5 | 3 |
| 11-01 Sun | 37 | 35 | 32 | 52 min | 8 min | 13 min | 52 | 52 | 0 | 1 |
| 11-02 Mon | 72 | 54 | 0 | 66 min | 6 min | 1.7 h | 153 | 9 | 16 | 23 |
| 11-03 Tue | 79 | 64 | 0 | 1.7 h | 7 min | 36 min | 211 | 25 | 20 | 24 |
| 11-04 Wed | 78 | 77 | 0 | 3.6 h | 17 min | 2.9 h | 256 | 23 | 57 | 59 |
| 11-05 Thu | 89 | 109 | 0 | 2.7 h | 9 min | 2.8 h | 314 | 20 | 12 | 11 |
| 11-06 Fri | 81 | 44 | 0 | 89 min | 12 min | 2.4 h | 190 | 23 | 38 | 18 |
| 11-07 Sat | 49 | 54 | 0 | 2.0 h | 27 min | 6.4 h | 145 | 14 | 8 | 3 |
| 11-08 Sun | 3 | 8 | 0 | 20.8 h | 3.8 h | 25.0 h | 21 | 7 | 0 | 6 |
| 11-09 Mon | 106 | 78 | 5 | 2.6 h | 7 min | 52 min | 412 | 182 | 33 | 15 |
| 11-10 Tue | 144 | 84 | 7 | 2.3 h | 16 min | 1.9 h | 461 | 169 | 33 | 19 |

**Reading it.**

- **A to B (the crew leaves, PM unchanged):** landed per weekday 121 to 55. Verdicts per weekday 395 to 162.
  Reader latency p90 37 min to 2.5 h. Median cycle 64 min to 1.5 h.
- **B to C (the PM changes, crew still away):** landed per weekday 55 to 74. Reader latency p90 2.5 h to 4.3 h;
  a first verdict later than an hour on 24% of PRs. Median cycle 1.5 h to 2.2 h. Issues opened per weekday 19 to
  38. HOLD share about the same (30%, 32%). PRs closed without landing 9% to 5%. PRs were slower than in the
  manual phase in every size class (section 6), so it is not only that they were bigger or asked two reads.
- **C to D (the first builder is PM again, crew back):** PRs opened per weekday 80 to 161, landed 74 to 104.
  Reader latency p90 back to 62 min. Median cycle still 2.0 h: the wait moved to the train (60 min from the last
  READ-OK to landed, p90 2.4 h), with 34 trains a weekday against 58 in A.
- So the throughput gap the owner saw is mostly the crew on the first builder's account, on and off. The PR data
  does not show the other builders landing less under the Swarm PM than in the days just before it.
- B is 2.5 weekdays and D is 1.5; treat their numbers as rough. B was thin in other ways too: 16 builders landed
  work in it, against 27 in A and in C. D's durations are short-biased: 37% of its PRs were still open.
- What the PR data cannot judge is the PM's decisions. `joining.md` ("The PM's checks", 6 Nov) records five slips
  in the PM's first two days, among them three default-on PRs that trained before their lamp checks.

**What dates the return.**

- 4-6 Nov: the Swarm app opened 15 PRs. None after 6 Nov. Comments signed as a Swarm agent: 19, 13, 2, then none.
- 7-8 Nov: a weekend; the PM agent's Queue posts fall from 137 a day to 49 and 34.
- 9 Nov 09:34: the first builder's Queue post takes the PM role back. 10:30: the PM agent's handover post; its
  train bot stopped after train 739. 11:04: train 740, from the first builder's bot (a 71-minute gap).
- 9 Nov: Second, Third, Fourth, Reviewer-two and Reviewer-three post again, for the first time since 1 Nov.

## 8. What a product replacing this should keep or fix

**Keep.**

- **A blocking read by someone other than the author, tied to a commit, with file, line and fix.** It is fast
  (7 min) and it finds faults (section 3).
- **One run on the composed head before anything lands.** It caught 12 real breaks, 6 invisible to per-PR checks.
- **A read that carries over a rebase when the patch is the same.**
- **Two reads for privacy and default-changing work.** Those PRs were held 50-57% of the time.
- **Small changes.** 57% of landed PRs are 200 lines or fewer and land in about an hour.
- **Readers always on.** A fifth of landings and of verdicts happen between midnight and 07:00.

**Fix.**

- **Identity.** One login per agent, not a signature on a shared account. The bot could not name the reader on a
  third of verdicts by 10 Nov.

- Verdicts since 20 Oct: 5193, posted from 11 accounts. Reader names per account, largest first: 9, 9, 6, 5, 4, 3, 3, 2, 2, 1, 1.

| phase | verdicts | the bot's signer() finds a name | no name found by the bot | of those, a known reader's name is there in a form the bot does not read | no name at all |
|---|---|---|---|---|---|
| 20-25 Oct (before) | 758 | 750 (99%) | 8 (1%) | 7 | 1 |
| 26 Oct-4 Nov 11:00 (manual) | 2652 | 2561 (97%) | 91 (3%) | 88 | 3 |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 919 | 762 (83%) | 157 (17%) | 40 | 117 |
| 9 Nov 09:34-10 Nov (after) | 864 | 583 (67%) | 281 (33%) | 164 | 117 |

- **Verdicts as state, not text.** READ-OK, HOLD, TWO READS, "lamp check owed", "the PM's yes owed" are today all
  words in comments. HOLD doubles as a brake (38 self-HOLDs; one reader's "P1/P2 none" HOLDs). Make each a field.
- **Rebasing is the system's job.** Conflicts bounce to the builder, who often cannot force-push and files a new
  PR; readers then restate reads. That is the 9% closed unlanded, the 21% restated READ-OKs and the 10-hour PRs.
- **Train capacity.** One lane, small trains, back to back, was full on the best days. Batch more, or run trains
  side by side. Do not throw a finished run away because one carried PR was held (42 trains).
- **Blame by test, not by crate,** or bisect: 8 of 22 `HOLD train` went to the wrong PR.
- **Reader capacity is a single point of failure.** Two readers on one account gave 46% of manual-phase verdicts
  (55% in the peak week). When that account went quiet, the slow end of reader latency went from 37 min to hours.
  Show who can read now.
- **Routing by chat.** The Queue took 671 comments a day and filled an issue every 3-4 days; 8-13% of it is
  READ ASK, 4-10% NEXT TRAIN. A system should route both.

| phase | Queue comments | per day | opening with NEXT TRAIN | carrying READ ASK | the train bot's own lines | 'free: <name>' posts |
|---|---|---|---|---|---|---|
| 20-25 Oct (before) (Queue kept from 23 Oct only) | 2314 | 823 | 14 (1%) | 0 (0%) | 94 | 5 |
| 26 Oct-4 Nov 11:00 (manual) | 6345 | 671 | 240 (4%) | 511 (8%) | 376 | 58 |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 2198 | 445 | 140 (6%) | 213 (10%) | 137 | 0 |
| 9 Nov 09:34-10 Nov (after) | 1217 | 811 | 122 (10%) | 162 (13%) | 37 | 0 |

- **Tie each PR to its task when it is opened.** Half name none; most of the Swarm app's PRs used `Closes`.
- **Task state.** Half the issues outlive 3 days, a fifth of builder-hours are over the limit of four, and 32 taken
  issues have been silent for over 3 days. Re-cutting them in bulk (4 Nov) made 28 issues that mostly sat.
- **Do not make GitHub the record.** 115 landed PRs are no longer shown, and an issue stops at 2,500 comments.
- **Generated status is not a change.** 103 rows PRs rode the pipeline.
- **Measure per builder, not in total.** The headline number moved because six agents left and returned.

**Other measures.**

| phase opened | landed PRs | comments per PR: median / p90 / max | PRs with over 20 comments | all comments on those PRs | comments per landed PR, mean | of which the train bot's |
|---|---|---|---|---|---|---|
| 20-25 Oct (before) | 673 | 4 / 15 / 157 | 39 (6%) | 4712 | 7.0 | 164 |
| 26 Oct-4 Nov 11:00 (manual) | 824 | 4 / 16 / 130 | 52 (6%) | 6014 | 7.3 | 298 |
| 4 Nov 11:00-9 Nov 09:34 (Swarm PM) | 255 | 5 / 13 / 34 | 9 (4%) | 1684 | 6.6 | 24 |
| 9 Nov 09:34-10 Nov (after) | 140 | 4 / 15 / 47 | 9 (6%) | 965 | 6.9 | 39 |

| hours | share of landings |
|---|---|
| 00:00-06:59 | 20% |
| 07:00-11:59 | 18% |
| 12:00-17:59 | 34% |
| 18:00-23:59 | 28% |

- Verdicts posted between 00:00 and 06:59 GMT+7: 20% of all

- 57 of 1184 train PRs (4.8%) waited over 2 h between their last READ-OK and landing; over 6 h: 25.
- What the PR shows in that wait: nothing on the PR says why 20; rode trains that did not merge 16; still a draft when read 9; waiting for a lamp check or run 5; the bot said it conflicts 5; stacked on an open PR 1; waiting for a second read 1
