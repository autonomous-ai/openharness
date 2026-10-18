# The second shape: Harness's own repo

2026-10-17. The pilot ([01](01-pilot-evidence.md)) is one owner, one lead and a swarm. Harness's own repository is the other common shape: **a few people, each driving several agents, with no lead and no shared queue.** Measured from:
- all 1,208 PRs merged Sep 15 – Oct 17;
- all 1,885 CI runs Oct 1–17, with job timing for 386 of them;
- the repo's process docs, handoffs, overnight reports and incident write-ups, most of them written by the agents.

Full report: [sources/harness-repo.md](sources/harness-repo.md). Accounts are "contributor A, B…"; contributor A is the owner's fleet.

## 1. The shape and its output
- **Who:** 18 authors in October, about 7 active accounts on a weekday and 1.6 at weekends. Contributor A's agents produced ~75% of merged PRs. At least ~60% of PR bodies are written by agents.
- **Output:** 55 merged PRs a weekday and 31 a weekend day in October, peaking at 99 in a day and 22 in an hour. Merges happen in every hour of the day; on weekdays the median gap is 12 minutes.
- **Speed per PR:** open → merge p50 **12 min**, p90 2.3 h. Agents open the PR when the work is done, under a minute after the first commit. Median size is 480 lines.

## 2. Two shapes side by side

| | The pilot | Harness's repo |
|---|---|---|
| **Structure** | Owner → one lead → ~14 builders, plus a reviewer and a tester | Several people, each with their own agents; no lead |
| **Merged PRs a day** | ~165 (~177 opened) | ~55 weekdays, ~31 weekends |
| **Open → merge, p50** | 1.5 h | 12 min |
| **Review** | A reviewer agent on every PR; 66% had findings, 22% three rounds or more | 98% merged by their own author; 0 approvals required; 1 of 354 PRs had a GitHub review; 27–49% record a review in the body |
| **Rework** | 18% of PRs were follow-ups to review | 4% of PRs fix one merged in the last 72 h (up to ~14% by a looser count); 88% by the same account that broke it |
| **Dispatch** | The lead: the most hours lost, though review set the output ([14](14-which-gate.md)) | Each person: none needed, and none shared |
| **Coordination** | A 1,500-comment thread | Git (PRs, status files, commit SHAs) plus a doorbell (`harness send`) |
| **First hard limit** | Review and merge, then the device ([14](14-which-gate.md)) | Shared CI runners |

The trade is visible:
- **The pilot's gates make each PR slower but catch more before merge.**
- **The repo's lack of gates makes each PR fast,** and pays in fix-forward and in a `main` that was knowingly red for long stretches before a gate existed.
- **Neither shape had a person reviewing code.** In both, review is done by agents or not at all.

## 3. The same walls
Different shapes, the same bottlenecks, in about the same order:

- **CI capacity.**
  - Early October a CLI PR ran 29 jobs (8 on macOS), twice once a merge queue existed. At the Oct 6 evening peak, jobs waited p50 4–5 min and p90 13–21 min for a runner, worst 39 min.
  - **44% of peak-hour job-minutes went to runs later cancelled.** One branch ran CI 61 times; agents started full CI by hand 356 times in a day.
  - The fix was CI scoped to the changed component, Linux only, on ready PRs only: p50 wait 0.1 min, ~4 jobs and ~3.5 min a run.
  - At 250 PRs a day, even today's lean CI would peak around 30 concurrent jobs.
- **Integration.**
  - Pairs of PRs, each green alone, broke `main` together, again and again.
  - One PR was rebased with conflicts eight times. The hottest files were touched by 60–112 PRs each in 17 days.
  - A merge queue fixed combined breakage but doubled CI, and was removed after about 7 hours. A merge helper that merges the exact reviewed head and verifies the merged tree replaced it.
- **Machines.**
  - Load averages of 180–400 "with other agents' suites on the same machine", and full disks.
  - Tests reached the real home folder and the real tmux server. Settings leaked from the supervising agent's environment into tests.
  - A dev daemon and a release daemon fought over the same panes. An 803 MB transcript read whole took the daemon out of memory for every agent on the machine.
- **Coordination.**
  - The first structured "Swarm" protocol was ignored by a real three-agent team and removed 13 days after it shipped.
  - Busy agents never received pushed messages. Introductions alone cost 387k input tokens for 215 output tokens. One agent was woken six times in 45 minutes for turns that said "noted".
  - What worked was Git plus a minimal doorbell that arrives at the next tool call.
- **The owner's attention.**
  - Every overnight report ends in decisions waiting on the owner.
  - The owner's desk reached 80 sessions on three machines, half of them stopped.
  - Autonomous goals didn't stop themselves.

## 4. What the repo learned, as rules
Each rule cost a measured incident to learn. The ones not already in the pilot's playbook:
1. **CI once per stable head.** Drafts run process checks only. "Ready" is an explicit step. "Read the failure, fix it, push once"; rerun only a recorded flaky test.
2. **Evidence tied to the exact source.**
   - A validation plan is chosen once.
   - Results are saved with the commit, tree and toolchain, and reused when nothing they cover changed (one check: 29.6 s → 3.9 s).
   - Known failures live in a registry, so nobody rediscovers the same 23.
3. **Merging is the critical section.** Merge the exact reviewed head, verify the merged tree, and integrate when `main` moves. One owner for `main`'s health.
4. **Split hot files before scaling out.** Conflict tables in plans (files, line ranges, order). New seams (service registration, a folder per engine). Shared baselines regenerated once per batch.
5. **Isolate every agent:** its own worktree, home folder, ports, tmux socket and a cleaned environment. Heavy suites at most two at a time, after a disk check. Never clean another session's files to make room.
6. **Done is external evidence.** Models claimed "done" before the signal arrived. Task state comes from PR, CI and merged-tree facts, never from an agent's report. Show "blocked" and "pending" differently from "failed": the draft gate made up two-thirds of sampled failures, which teaches everyone to ignore red.
7. **Independent review on the exact commit, recorded where the merge tool checks it.** Agent review found real defects on almost every PR it covered. A 20-round panel still missed a race found after merge, so review is a rung, not the ladder.
8. **A doorbell, not a protocol.** Message only when blocked, or when you changed something others depend on. A few lines, one message per settled finding. Pre-approve the reply command.
9. **Limit spawning.** Each agent may have 4 open children at depth 1, with 20 starts per 10 minutes and 40 per machine. An agent closes only what it started; idle children close after 30 minutes. Every started task carries who sent it.
10. **People own the irreversible, with mechanical guards.**
    - Releases were cut from stale checkouts 3 and 20 commits behind; a published version was rebuilt at the same URL; 16 CLI releases shipped in a day.
    - Now a release must contain the last release, versions are unique and published files never change.
    - Never type into another agent's pane. Never let an agent answer a permission prompt.
11. **Rules live in the repo and are re-read at the start of every task.** `AGENTS.md` changed 13 times in 5 days. Gate logic should run from the target branch, so an old branch can't carry old rules.
12. **Handoffs have a fixed form:**
    - the bar, the order of work, what merged, what's left (including broken and unpushed work), the rules, and how to land;
    - the next agent verifies what it inherits;
    - commits pushed after a squash-merge are caught automatically (five PRs exist only to land such commits).

## 5. A warning that applies to this study
An earlier design study for agent teams in this repo ran ~6.7 hours and produced ~333 KB of documents **without a live experiment.** Its scope grew until the owner asked whether the goal was almost done. The structured protocol it led to was ignored by the first real team and removed.

The lesson for this study: **the next step is an experiment on real swarms ([08](08-experiments.md)), not more design.** The smallest useful slice should be judged on the owner's own swarms within days.
