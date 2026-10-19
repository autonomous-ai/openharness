# Bottlenecks: every wall the pilot hit

2026-10-17. What slowed or broke the pilot swarm, by resource, with what it cost and what Harness should do about each. The data covers 14 Oct 16:40 to 17 Oct 22:34 (local time, +07):
- the queue thread's 1,537 comments;
- 775 issues and PRs with 6,532 comments;
- 538 PRs into the integration branch;
- 3,849 CI runs, and job timings for a one-in-three sample of the target-architecture runs;
- the process documents, role files and builders' work logs.

Over that window the swarm grew from 3 to 16 agents on 5 accounts and 5 devices. It merged 491 PRs into the integration branch, with a median of 1.6 h from open to merge (1.5 h across all of the repo's PRs, Oct 15–17; see [01](01-pilot-evidence.md)). Costs marked *est.* are estimates; the method is in the source report.

## 1. The finding: single points, not compute

**Most of the cost came from things there was only one of:**
- one lead dispatching, deciding and integrating;
- one reviewer;
- one subscription carrying both of them;
- one integration device;
- one shared office machine;
- one 1,500-comment thread.

**Compute was real but cheap to fix.** The runner queue and the full disk were each fixed within about a day once someone named them. The single points were only ever widened by new rules, and they were still the largest cost when the data ends.

This is the most important input to the design. A swarm product that adds machines and runners helps less than one that removes serial points: dispatch without the lead, a reviewer pool, gatekeepers on separate subscriptions, devices as booked resources, a task store instead of a thread.

## 2. The ten largest, by hours lost

**Read with [14](14-which-gate.md).** This ranking counts hours lost. By output lost, the order changes: review and merge (#2) and the gatekeepers' usage limits (#3) set the merge rate. Most of #1's empty lists were builders whose own work was waiting in review: 45 of 64 had a PR ready and waiting at that moment.


| # | Bottleneck | Evidence | Cost *est.* | What Harness does |
|---|---|---|---|---|
| 1 | **Dispatch through one lead** | 64 "my list is empty" reports, answered after a median 23 min (mean 107, max 738). 52 idle nudges from the lead. Dispatch stopped 03:14–06:40 while the lead waited on one question to the owner. | ~24 builder-hours of detected silence; up to ~74 waiting for a task | A backlog workers pull from under rules; lists kept three deep automatically; a deputy lead; a lead's question to the owner never stops dispatch |
| 2 | **Review and merge capacity** | First review p90 107 min, 26% past the 30-min target. Up to 58 PRs ready but unmerged. PRs handed back to the lead merged in 3.3 h, against 1.3 h. | Hours per PR, and more rebases and CI rounds because of it | Merge authority by change class; a reviewer pool with failover; a live board of first-review waits |
| 3 | **Usage limits on the account carrying both gatekeepers** | 4 windows of 1.2–2.4 h, plus a 2–3 h silence. Activity −75–85%; zero merges in two of those hours. | ~25–30 agent-hours, and the rest of the swarm slowed | Quota and burn rate per account; gatekeepers placed on separate subscriptions; a standby that takes over the queue |
| 4 | **Flaky and load-sensitive tests on shared machines** | Load averages up to 144. 48 re-runs, 179 "passes alone" explanations, 22% of new issues. | 12–24 runner-hours; the tests builder's two days; builders stopped trusting local gates | A flaky-test registry that labels red runs; load recorded with each result; heavy suites through slots |
| 5 | **Target-architecture CI** | 30-min runs. After a fan-out to four runners each, PR runs waited up to 105 min. Real-clock tests left off PRs for ~44 h. A CI fix sat ~35 h with another team. | ~26 h of 15–100-min feedback loops across 9+ builders | CI as a metered shared resource; warn before a workflow change exceeds the runners; show the coverage gap as a tracked risk |
| 6 | **One integration device, and contention for the others** | 102 PRs needed the lead's device. 157 booking messages across four separate protocols; two sessions on one device at once. | 2–3× merge latency for device-gated work | Devices as first-class resources: owner, parts, leases that expire with the session, a job queue per device |
| 7 | **People: hands, presence, decisions, other teams** | 235 deferrals "to Monday". A setup decision took ~30 h, then was reversed. One sudo wait ~5 h. 27% of activity happened when nobody could lend hands. | Days of slip for anything needing a device or a decision; rework after reversals | A hands queue that batches into staffed hours; decision packets with what each blocks; work built on a provisional decision is marked |
| 8 | **The shared office machine: disk and build folders** | ≤10% free disk for ~51 h; 4+ builds or installs killed, the integration install among them. Shared build folders made 11% of the reviewer's checks wrong. ~435 GB reclaimed. | 4–8 agent-hours plus 1.5–3.5 reviewer-hours; more lost trust | A disk budget per machine; builds refused below a threshold; cleanup when a task closes; a build folder per worktree by default |
| 9 | **Integration-branch breakage and rebase churn** | 4 times, two PRs that each passed alone broke the branch together. 171 threads needed rebases; 536 force-pushes. 60% of merge commits never got their own CI run. | ~1 h with every PR red; an extra CI round for a third of PRs | A merge queue tested on the real head; one claimed fixer when the branch is red; hot-file warnings before work starts |
| 10 | **The coordination thread outgrew what agents can read** | ~260k tokens in 3.2 days. 50 admissions of a missed message; one builder missed three tasks by reading only the first page. | ~1 M tokens an hour of re-reading; hours of misdirected work | An inbox per agent with read state; native tasks; "new since your last read" |

**Next five:**
- the motor-safety freeze and other hardware faults (no motion on any device for ~5 h; hand tests moved ~2.5 days);
- false failures from emulating the target architecture (~2.5 days of noise in local gates);
- a device's provider key out of quota (~14 h without a voice);
- package-registry download failures in CI;
- access (commits held for a person, private repos, sandbox reruns).

**Not bottlenecks here:**
- GitHub API rate limits;
- memory on builder machines;
- claim races;
- office network outages.

## 3. The capacity model
Each gate has a builder count where it saturates. Past the smallest one, more builders only lengthen the queue: the pilot carried 24–67 waiting PRs.

| Gate | Pilot numbers | Saturates at |
|---|---|---|
| **Builders** | 0.61 PRs per builder-hour, idle included | — |
| **CI** | 4.1 runs per PR; 35 runner-minutes per builder-hour | ≈ R / 0.58 builders for R runners. 8 runners → ~14 builders, which matches "eleven runs queued behind eight" on 15 Oct. |
| **Reviewer** | ~0.6 PRs per builder-hour; ~6–7 min per PR | ~15 builders per reviewer |
| **Lead** | ~40 tasks and ~93 comments a day for ~13 builders | ~15 builders, then split by domain |
| **Devices** | One integration device; every change users would notice needs device minutes | By the share of changes needing a device |
| **Owner** | Not counted; one 3.4 h overnight wait stopped dispatch | Latency matters more than count |

**Little's law ties them together:** work waiting = arrival rate × time waiting. With ~24 PRs waiting and ~3.1 h in review, the queue drains at ~7.7 an hour, close to the ~7.5 merged. Halving review time halves the work in progress at the same throughput, which means fewer stale branches, conflicts and rebases.

**Amdahl's law sets the ceiling:** the serial parts (the lead's decisions, the integration device, the owner's answers) bound the whole, however many builders run.

**What Harness should do:** show each gate's saturation point live, and tell the lead which gate to widen next. "Add a reviewer" is the right advice at 16 builders; "add a builder" isn't.

## 4. By resource
Short version of each class. The source report has the dates, quotes and threads.

### Compute
- **CI.**
  - Every run was red for the first 2 h 40 min because of the container, not the code.
  - A fan-out to four runners per push filled the queue within 20 minutes.
  - Paid larger runners were approved and dropped within an hour ("CPU is not the real problem").
  - Runs got shorter by moving 123 real-clock tests to nightly, which let regressions merge green for ~44 h until the tests moved onto a test clock.
  - Builders started 106 runs by hand and opened throwaway PRs just to get a run.
  - About 25% of runs were cancelled.
- **CPU on shared machines.** Load averages of 6–144 made timed tests fail "a different one each time". "No retries" was the right rule: each flake got an issue and a deterministic fix, and a test counted as fixed after 60 runs alone and 10 under load.
- **Disk.**
  - The office machine hosted the lead, two builders, the reviewer, tests and a VM on a 466 GB disk. It sat at ≤10% free for ~51 h.
  - 103 GB of it was temporary files, 46 GB of those the agents' own scratch folders: the agent tool's own leak.
  - The fix was an owner rule written at 23:05 ("below 20 GB free, clean before you build"). After it, no machine ran out of space again.
- **Build folders and container volumes.** Shared folders served stale binaries, including "0 passed" green runs and another review's crate. A container silently mounted another agent's volumes for ~5 h.
- **Emulation and toolchains.**
  - Local target-architecture builds ran under qemu and produced false failures for ~2.5 days. The fix took ~1.5 h of work, 13.5 h after it was first asked for.
  - Two builders had the wrong toolchain and could only gate through CI, at 15–30 min an answer.
  - The agent sandbox refused local sockets, so 7+ gate runs were repeated.
- **Memory.** Not a limit on builders. The one finding: 52 idle sessions holding 17 GB, started by the product under test and never closed.

### Model capacity
All of the stops were on the owner's account, which carried the lead, the reviewer and two builders. When it hit a limit, dispatch and review stopped together, so builders on other accounts stalled too. **One subscription carrying every gatekeeper is a single point.**

### Devices
- **One integration device:** "what waits for the device already grows faster than it can be cleared", with four builders.
- **Four booking protocols ran at once:** owner files, a lock script (which took 21 h of review and still let two sessions hold one device), hold comments on the thread, and a loans file. 157 booking messages in all.
- **Hardware faults ate device time and evidence:** storage stalls, a camera that wouldn't reopen, heat throttling, a USB hub drop that took the mic, servos, speaker and camera, a dead air sensor, a full RAM log that killed the voice.
- **The motor-safety freeze:** one bad register read stopped all motion for ~5 h overnight while the owner's answer waited.

### People
- **Hands were scarce:** "nobody is at the device tonight", the office's midday nap, the weekend. Work needing hands was batched into the owner's fixed slots.
- **About 91 messages in 34 threads waited on an owner decision.** Some were relayed through other people "in chat".
- **Other human teams** (devops, hardware, backend) were in ~113 messages. A CI fix waited ~35 h for one of them.
- **Members paused their own agents:** "takes no new task until its person starts it again".

### Access
- Commits waited for a person until the owner's standing exception.
- Every ssh needed a person's yes; keys were installed by hand; sudo waited ~5 h; a sign-in took ~2 h.
- A provider key out of quota left a device without a voice for ~14 h, and the lead rightly refused to handle keys.
- Member accounts couldn't see two private repos, so the work moved within 10 minutes to agents on the owner's machine.

### Outside services
- Package downloads failed in CI and killed 4–6+ shards.
- A company backend was slow and briefly down; the rule became "design so nothing depends on it".
- GitHub had no rate limits. The trouble was paging: agents read the first 100 comments, not the newest.

### Coordination
The thread reached ~260k tokens. Wake-ups every 10–15 minutes across 16 agents re-read it at ~1 M tokens an hour.
- "Never end a turn without a wake-up", an idle watch and lists three deep were all added after idle builders were found.
- Task creation was moved to the lead alone. Issues opened by members fell from 14 to 2 a day, and problems went into the thread as proposals; "no answer means not taken up."
- Claims on tasks stopped being used on the third day. 101 PRs cite the thread, not a task, as their source.

### Integration
- **Merges every few minutes at peak.** The next merge cancelled the previous merge's run, so 60% of merge commits were never checked on their own. Cancelled runs showed as failures.
- **Hot files** were the documents each PR had to update and a few central sources. Rebase-only merging meant every rebase was a force-push and a new CI run.

## 4½. The same walls in a different shape
Harness's own repo has no lead and no shared queue, just a few people each driving agents ([01b](01b-harness-repo.md)). It hit the compute walls first, in the same order:
- **CI:** 29 jobs per PR saturated the runners at ~55 PRs a weekday, with waits of p90 13–21 min at peak. **44% of peak job-minutes went to runs later cancelled.** CI scoped to the changed component, on ready PRs only, fixed it: p50 wait 0.1 min.
- **Integration:** pairs of green PRs broke `main` together. Hot files were touched by 60–112 PRs in 17 days.
- **Machines:** load averages of 180–400 from other agents' suites; full disks; tests leaking into the real home and tmux server.

The repo had none of the pilot's single points (no lead, no reviewer), so its cost moved elsewhere: almost no review (98% self-merged) and more fix-forward. **Remove the single point and the gate goes with it, unless something replaces it.** That is why the design keeps the gates but multiplies them: pull instead of dispatch, a reviewer pool instead of one reviewer.

## 5. What the team learned, as rules
These rules are worth shipping as defaults ([11](11-default-playbook.md)), because each cost the pilot hours to discover:
- One build folder and one container volume per checkout; clean below 20 GB free; delete a task's outputs when it's done.
- No retries on flaky tests: an issue and a deterministic fix.
- The target-architecture CI run is the authority over local emulation.
- Read the newest messages, not the first page.
- A known flaky test doesn't hold a change back; re-run once at most.
- Behaviour users would notice merges behind a switch, off until shown on a device.
- No spending, accounts or keys by agents: the task says so and the next task is taken.
- Back up what a device runs before installing; sync before a power test.

## 6. What this means for Harness
In order of cost removed:
1. **Remove the serial points.**
   - Workers pull from a backlog under rules, so dispatch doesn't wait on the lead.
   - A deputy lead takes over when the lead stops.
   - A reviewer pool with failover.
   - Gatekeepers on different subscriptions or engines.
2. **Tasks and inboxes instead of a thread:** native tasks with leases, an inbox per agent with read state, "new since your last read".
3. **Devices and people as booked resources:** leases that expire with the session, a job queue per device, a hands queue that batches into staffed hours, decision packets.
4. **Capacity as a live view:** CI queue and runner use, quota and burn per account, disk per machine, each gate's saturation point.
5. **Machine hygiene by default:** a build folder and container namespace per worktree; cleanup when a task closes; refuse heavy work below a disk threshold; load-aware slots for heavy suites.
6. **Access as grants:** scoped, time-limited approvals (ssh, sudo, keys, repos) on the right person's phone. An access check when a task is assigned, so a 404 surfaces before the work starts.
7. **Integration safety:** a merge queue on the real head; one claimed fixer when the branch is red; never show cancelled as failed.
