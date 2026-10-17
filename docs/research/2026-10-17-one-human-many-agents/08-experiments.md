# Proving it: experiments for the next ten projects

Draft, 2026-10-17. Each claim in [03](03-first-principles.md) as something the next projects can confirm or break. A swarm's history is only as useful as what it records, so every project runs with the measurements in §1 from day one.

## 0. The first experiments, this week, with no new code
The study's top claims can be tested on the pilot with rule changes alone. Each one needs the owner's yes, because the pilot is a real project.

| # | Change | Measure (baseline from [04](04-bottlenecks.md)) | Keep it if |
|---|---|---|---|
In order of expected gain. The record shows review and merge set the pilot's output ([14](14-which-gate.md)), so widening it comes first.

| # | Change | Measure (baseline from [04](04-bottlenecks.md), [14](14-which-gate.md)) | Keep it if |
|---|---|---|---|
| E3 | **A reviewer pool:** a second reviewer on another engine, oldest PR first, and builders whose work is waiting review the oldest PR before opening a new one | Merges an hour at full size: ~9, flat whatever the queue; ready → first review p90 107 min | merges an hour rise with the swarm; first-review p90 under 30 min |
| E2 | **Gatekeepers on different subscriptions:** move the reviewer to another account than the lead | Merges an hour during a usage limit: 0–2.4, against ~12 before; 3 windows measured (04 counts 4), each 1.3–2.4 h | no window where merges stop |
| E4 | **The lead never waits on the owner:** a question becomes a written packet, and the lead carries on | One 3.4 h stop: empty-list reports 3 → 14, merges 9.6 → 6.1 an hour | no dispatch stop longer than 15 min |
| E1 | **Pull rule:** a builder with nothing in hand takes the oldest unowned open task in its area without waiting for the lead | Wait from "list empty" to the next task: median 23 min, mean 107, max 738 | median under 5 min, with no rise in work waiting for review |

E1 comes last on purpose. Most empty lists in the pilot meant the builder's own work was waiting in review; more tasks in hand would only have lengthened that queue.

If these hold, the product's first slice is confirmed before it's built. Then build the smallest slice (the Swarm tab, the floor, `harness task next` with leases, an inbox per worker, the review gate on the health line) and judge it on the owner's own swarms within days, by:
- merges an hour against review capacity;
- missed assignments;
- tokens spent on coordination per hour (~1 M an hour in the pilot).

Harness's earlier agent-team design ran 6.7 hours of documents without a live experiment, and the first real team ignored it ([01b §5](01b-harness-repo.md)). This study shouldn't repeat that.

## 1. Record from day one
- **Every task:** opened, claimed, first commit, PR opened, merged, done; its owner; its rework (follow-ups).
- **Every decision:** asked, answered, by whom; whether the lead's recommendation was taken.
- **Every human minute the swarm asked for:** decisions, hands, try-it, unblocking.
- **Resources:** CPU, disk and RAM per machine; CI queue and minutes; model usage and cost per worker; device bookings.
- **Outcomes:** escaped defects (found after merge by the owner, testers or users); the owner's try-it verdicts; user signals where there are users.

## 2. Hypotheses

| # | Hypothesis | Test | It's wrong if |
|---|---|---|---|
| H1 | Working around the clock alone gives ~3–4× a human team's hours | Compare merged changes per calendar day before and after a swarm, same project | gain under 2× after controlling for worker count |
| H2 | Verification and integration take most of the wall-clock time | Split task lead time into build, PR wait, review, CI and device stages | build is over 50% of lead time |
| H3 | One lead saturates around 10–20 workers | Add workers in steps of 4 under one lead; watch per-worker throughput and idle time | per-worker throughput holds flat past 25 |
| H4 | Owner decision latency is the final bottleneck | Measure work blocked on decisions; then batch decisions twice a day | blocked time under 5% |
| H5 | Merging behind flags keeps quality while cutting PR wait | A/B: flag-gated reviewer merges against lead-tested merges on similar tasks | escaped defects rise more than 20% |
| H6 | A reviewer on a different model catches more than one on the same model | Alternate reviewer engines weekly; count findings later confirmed real | same-model review finds as many confirmed issues |
| H7 | A second person adds most value as a domain owner, not as capacity | Projects with and without a human domain owner per area; compare escaped defects and the owner's verdicts | no difference beyond added worker count |
| H8 | Native tasks and delivery beat GitHub coordination | The same project with GitHub coordination, then Harness tasks; compare missed assignments, idle time, tokens spent coordinating | no measurable difference |
| H9 | Swarm output degrades without consolidation work | Track flag count, duplicate code, test time per week, with and without scheduled debt days | entropy flat without debt days |

## 3. Choosing the ten projects
A mix, so the framework isn't fitted to one shape:
- **Hardware-in-the-loop:** like the pilot. Devices are the scarce verifier.
- **Pure web or app:** verification is cheap, so integration and taste dominate.
- **Library or infrastructure:** correctness and compatibility dominate; real users are other programmers.
- **Greenfield vs a large existing codebase:** comprehension debt and architecture rules matter more in the second.
- **Solo owner vs owner plus domain owners:** to test H7.
- **Small (3–5 workers) vs large (15–30):** to test H3 and sub-swarms.

## 4. What would change the design
- **H2 false** (building still dominates): invest in workers' speed and model choice, not verification.
- **H3 false** (one lead scales to 50): skip sub-swarms; make the lead's tools stronger.
- **H4 false** (owners aren't the bottleneck): the YOU box can be simpler.
- **H7 false** (domain owners add nothing beyond capacity): the product focuses on one owner and lending capacity, not on teams of people.
- **H8 false** (GitHub coordination is as good): build integrations, not native tasks.
