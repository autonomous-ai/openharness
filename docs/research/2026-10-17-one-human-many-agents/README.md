# One person, many agents

A study of how software gets built when one person directs a swarm of AI agents, and what Harness should be for it. October 17, 2026. The evidence comes from:
- our pilot, one owner directing a lead agent and ~15 builders;
- Harness's own repo, a different shape: a few people each driving agents, no lead;
- how frontier labs and agent-heavy companies work today;
- the research on multi-agent systems.

## The answer on one page

**Agents can now run the middle of software development:** planning, building, reviewing and integrating. In the pilot, one owner, one lead agent and ~15 builders went from ~11 to ~177 PRs a day in three days, working every hour of the week. The frontier labs report the same shape internally: Anthropic says Claude wrote more than 80% of its merged code in May 2026, with ~30,000 agents running at once on its main internal platform. OpenAI built a product with zero hand-written code.

**People hold the two ends, and the bottleneck moves there.** Someone has to **want** something (goals, priorities, taste, what to trade) and **observe** whether it worked (real people, real devices, real conditions), and answer for both. Once building is nearly free, throughput is set by:
1. verification: CI, devices, review, real-world checks;
2. integration;
3. compute and model capacity;
4. the lead's coordination;
5. **the owner's attention**, which is the final limit.

Every scaled operation, inside and outside the pilot, names review and attention as the scarce resource. In the pilot, **most of the cost came from things there was only one of**: one lead dispatching, one reviewer, one subscription carrying both, one integration device, one 1,500-comment thread. Compute limits (runners, disk) were fixed within a day; the single points never were.

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
| [floor.html](floor.html) | A clickable mockup of the Swarm floor: desks, ⌘⏎ zoom, the panel, decision packets |
| [sources/](sources/) | The research reports behind 01b, 02 and 10: the Harness repo, the landscape, frontier practice and the market |

## The next step is an experiment, not more design
Four rule changes on the pilot test the study's top claims with no new code ([08 §0](08-experiments.md)):
1. builders pull their next task instead of waiting for the lead;
2. the reviewer on a different subscription from the lead;
3. a second reviewer;
4. the lead never waits on the owner.

If they hold, build the smallest slice (Swarm tab, floor, `harness task next`, an inbox per worker) and judge it on the owner's own swarms within days. Harness's previous agent-team design skipped this step, and the first real team ignored it.

## Decisions for the owner
1. **Market:** the swarm layer (recommended), entered through swarm owners and grown into companies.
2. **Pricing:** free for one person; charge when a second person joins the floor, then by capacity, not seats.
3. **Where tasks live:** on the swarm owner's machine, relayed encrypted (recommended), or on the backend.
4. **Words:** "worker" or "agent" on the floor; "Swarm" as the feature's name. It echoes Docker Swarm, which lost to Kubernetes, so decide now.
5. **First version:** Swarm tab and floor with People; then native tasks, the YOU box, and delivery. Judged by whether it removes the walls on the owner's own swarms.
