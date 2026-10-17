# One person, many agents

A study of how software gets built when one person directs a swarm of AI agents, and what Harness should be for it. October 17, 2026. The evidence comes from:
- our pilot, one owner directing a lead agent and ~14 builders;
- Harness's own repo, a different shape: a few people each driving agents, no lead;
- how frontier labs and agent-heavy companies work today;
- the research on multi-agent systems.

## The answer on one page

**Agents can now run the middle of software development:** planning, building, reviewing and integrating. In the pilot, one owner, one lead agent and ~14 builders went from ~11 to ~177 PRs a day (~165 merged) in three days, working every hour of the week. The frontier labs report the same shape internally: Anthropic says Claude wrote more than 80% of its merged code by May 2026, and by August ~30,000 agents ran at once on its main internal platform. OpenAI built a product with zero hand-written code.

**People hold the two ends, and the bottleneck moves there.** Someone has to **want** something (goals, priorities, taste, what to trade) and **observe** whether it worked (real people, real devices, real conditions), and answer for both. Once building is nearly free, throughput is set by:
1. verification: CI, devices, review, real-world checks;
2. integration;
3. compute and model capacity;
4. the lead's coordination;
5. **the owner's attention**, which is the final limit.

Every scaled operation, inside and outside the pilot, names review and attention as the scarce resource. In the pilot, **most of the cost came from things there was only one of**: one reviewer, one subscription carrying the reviewer and the lead, one integration device, one lead dispatching, one 1,500-comment thread. Compute limits (runners, disk) were fixed within a day; the single points never were. The record shows which one set the output: **review and merge** ([14](14-which-gate.md)). At full size merges held at ~9 an hour whatever the queue, and fell to 0–2 an hour whenever the gatekeepers hit a usage limit.

**Other people add value through what one owner can't supply:**
- **knowledge outside the model,** e.g. a hardware fact that ended days of agents chasing a non-software problem;
- **contact with reality:** two hours with a person at the device found ~7 faults that hundreds of synthetic tests missed;
- **experience-based process design,** which grew the swarm from 4 to 15 agents;
- **business facts,** one of which overturned a wrong lead decision;
- **taste and physical work.**

Not capacity: the owner can buy that.

**It doesn't work everywhere yet.**
- Industry data shows more output with worse quality: +54% bugs per developer, about 3× incidents per PR.
- No peer-reviewed study of large swarms on real codebases exists.
- There's no verified one-person billion-dollar company.
- The pilot showed its own traps: merged work that ran nowhere (37 of 89 switches off), a lead that was a single point of failure, a coordination thread of 1 M characters, test gaming, unattended physical risk.

**Verification is what buys autonomy,** and it has to be measured per swarm. Harness's own repo shows the other side: with no lead and no reviewer, 98% of PRs are merged by their own author and up to ~14% fix something merged in the previous three days.

**What Harness should be: the place where a person runs swarms.**
- **Not another agent:** the labs win that.
- **Not a better single-vendor swarm:** in 2026 every lab shipped a lead with workers inside its own subscription (Claude Code, Codex, Cursor, Devin, Antigravity).
- **Not chat for large human teams:** Slack, GitHub and Linear own that and give it away. We feed them.

Instead, a vendor-neutral, multi-machine swarm layer:
- **a floor** of live terminals, with ⌘⏎ to visit any desk;
- **the owner's desk:** brief, decision packets, try-it;
- **native tasks** with leases and verified states;
- **delivery and waking;**
- **capacity:** machines, subscriptions, CI, devices;
- **a verification ladder;**
- **trust between people.**

The target is **swarm owners**: people already running 5+ agents on 2+ machines who coordinate by hand. Customer zero is Harness's own owner. Individuals expect the wrapper to be free (one popular orchestrator shut down for lack of a business model), so the charge comes when a second person joins the floor, and then by capacity.

## The owner's questions, answered directly

**Is this the end of human programmers? Can one person and a bunch of agents get everything done?**
- **Programming as typing code: yes, mostly gone.** The labs report 75–80%+ of merged code written by agents, OpenAI built a product with none written by hand, and the pilot's ~177 PRs a day had no human-written code.
- **Programming as deciding what a system should do and proving it does: no, it grows.** Someone still has to want the thing, judge whether it works in the real world, and answer for it.
- **One person can run the whole build of a product,** as the pilot shows. Literally alone works when the product's oracle is its users and no hardware is involved: a web product, an app, a developer tool. Where reality is physical or the domain is far from the owner's knowledge, a handful of people stays, for knowledge, reality and judgment, not programming. Far fewer people per product; far more products ([09 §2½](09-at-scale.md)). **The programmer goes extinct before the owner, the user and the verifier do.**
- **How far it goes depends on the oracle,** whatever says a change is right ([03 §6½](03-first-principles.md)). Where a machine can judge (a compiler, a test suite, a reference), agents run nearly alone. Where only reality or a person can judge (a noisy room, whether motion looks alive, whether people want it), the pace is how often reality can be sampled.
- **What's not proven:** quality at this volume (industry data shows more bugs and incidents), swarms running for weeks without drift, and any one-person billion-dollar company.

**If there are other people, how do they add big value, beyond adding machines and agents the owner could add alone?**

Through what the owner can't buy:
- **judgment in a domain,** at the swarm's speed: a second decider, not a second builder;
- **knowledge outside the model:** one hardware fact ended days of agents chasing a non-software problem;
- **contact with reality:** two hours at a device found ~7 faults that hundreds of tests missed;
- **process design from experience:** one member's rules took the pilot from 4 to 15 agents;
- **business facts:** one overturned a wrong decision by the lead;
- **dissent, taste, access, and hands.**

In one line: **people are the oracle where no machine can judge, and they turn their judgments into tests so nobody has to make them again.** A person who only adds capacity adds nothing the owner couldn't buy ([03 §5](03-first-principles.md), [01 §6](01-pilot-evidence.md)).

The owner's own limit is set by how decisions arrive. Questions in a thread cap one owner at about 13 workers. Packets with a recommendation, plus a brief that pre-decides, raise the cap about tenfold ([03 §4](03-first-principles.md)).

**What are the bottlenecks: compute, disk, API, subscriptions, VMs, CI?**
- **All of them showed up, in both shapes,** but **compute was the cheap part:** runner queues and full disks were fixed within a day once named.
- **The expensive limits were single points:** one reviewer, one subscription carrying both gatekeepers, one integration device, one lead dispatching, one thread.
- **Review and merge set the output** ([14](14-which-gate.md)). Builders' idle time looked like the largest cost, but 45 of 64 "my list is empty" reports came from builders whose own work was waiting in review. Widen review first; faster dispatch only lengthens the queue.
- **Each gate has a builder count where it saturates:** CI near runners ÷ 0.58, one reviewer near 15, one lead near 15. Past that, more builders only lengthen the queue ([04](04-bottlenecks.md)).

**How do frontier labs and other teams build, and what do their people do?**
- **The same shape:** agents write most of the code; people verify and decide whether to ship, set direction, program the "factory" (rules, tests, sandboxes), and own risk and production.
- **Review is everyone's named bottleneck.** Hierarchy beats peers in every serious report. Reliable units of delegation are about an hour of work ([02](02-how-others-build.md)).

**Which market: a "Slack of development" for big teams, or a solo tool against Claude Code and Codex?**
- **Neither.** The solo swarm is now free inside every lab's subscription, and team chat belongs to Slack, GitHub and Linear, who give agents away.
- **The open position is the vendor-neutral swarm layer:** every lab's agents, on every machine you own, as one crew, with capacity, cost and verification.
- **The audience is the new shape of organization:** a few owners, each running swarms. It starts with one owner, spreads when they share the floor, and grows into companies ([10](10-strategy.md)).

## The documents
| | |
|---|---|
| [01 · The pilot](01-pilot-evidence.md) | What one owner, one lead and ~15 agents did: throughput, process, people, failures |
| [01b · Harness's own repo](01b-harness-repo.md) | The other shape: a few people each driving agents, no lead. Same walls, and almost no review |
| [02 · How others build](02-how-others-build.md) | Frontier labs, agent-heavy companies, the research, the counter-evidence |
| [03 · First principles](03-first-principles.md) | The loop, the migrating bottleneck, the owner's attention, what people add, the autonomy dial |
| [04 · Bottlenecks](04-bottlenecks.md) | Every resource limit the pilot hit: CPU, disk, CI, VMs, subscriptions, devices, people |
| [05 · The framework](05-framework.md) | Brief, roles, tasks, the verification ladder, liveness, scaling, memory, metrics, safety |
| [06 · Swarm in Harness](06-harness-swarm.md) | The product: floor, panel, YOU box, workers, tasks, delivery, capacity, primitives, order of building |
| [07 · What breaks at scale](07-risks.md) | Goodhart, test gaming, entropy, comprehension debt, single points, security, cost, pace over safety |
| [08 · Experiments](08-experiments.md) | Nine falsifiable hypotheses for the next projects, and what would change the design |
| [09 · At scale](09-at-scale.md) | What becomes cheap and scarce, what programmers become, organizations as portfolios of swarms |
| [10 · Strategy](10-strategy.md) | Which market: the one-person tool, "Slack for dev teams", or the swarm layer |
| [11 · Default playbook](11-default-playbook.md) | What every new swarm starts with: rules for workers, the lead, the reviewer, the tester, the people |
| [12 · Economics](12-economics.md) | What a swarm costs per change, and why it rests on flat-rate plans today |
| [13 · The first slice](13-first-slice.md) | The smallest Swarm worth building, on parts Harness already ships, and how it's judged |
| [14 · Which gate](14-which-gate.md) | An audit of the pilot's record: review and merge set the output; most idle builders were waiting on review, not on the lead |
| [floor.html](floor.html) | A clickable mockup of the Swarm floor: desks, ⌘⏎ zoom, the panel, decision packets |
| [sources/](sources/) | The research reports behind 01b, 02 and 10: the Harness repo, the landscape, frontier practice and the market |

## The next step is an experiment, not more design
Four rule changes on the pilot test the study's top claims with no new code ([08 §0](08-experiments.md)):
1. a reviewer pool: a second reviewer, and builders whose work is waiting review the oldest PR first;
2. the reviewer on a different subscription from the lead;
3. the lead never waits on the owner;
4. builders pull their next task instead of waiting for the lead.

If they hold, build the smallest slice ([13](13-first-slice.md): Swarm tab, floor, `harness task next`, an inbox per worker) and judge it on the owner's own swarms within days. Harness's previous agent-team design skipped this step, and the first real team ignored it.

## Decisions for the owner
1. **Market:** the swarm layer (recommended), entered through swarm owners and grown into companies.
2. **Pricing:** free for one person; charge when a second person joins the floor, then by capacity, not seats.
3. **Where tasks live:** on the swarm owner's machine, relayed encrypted (recommended), or on the backend.
4. **Words:** "worker" or "agent" on the floor; "Swarm" as the feature's name. It echoes Docker Swarm, which lost to Kubernetes, so decide now.
5. **First version:** Swarm tab and floor with People; then native tasks, the YOU box, and delivery. Judged by whether it removes the walls on the owner's own swarms.
