# Which market: the one-person shop, big teams, or the layer between

Draft, 2026-10-17. Tested against the market research in [sources/market.md](sources/market.md). Tags there: [P] primary, [S] secondary, [C] company claim, [B] background, [E] estimate. Numbers here keep the tag of their source.

## 1. Two proof points, one pattern
- **The pilot:** one owner, one lead agent and ~14 builders took a product from ~11 to ~177 PRs a day in three days (~165 merged), working around the clock.
- **Harness itself:** one owner directing agents launched about one new initiative a week for two months (CLI, desktop, mobile, store, devices, terminal UI, website, OS), with a few people owning some areas. That's ~27–55 merged PRs a weekday (September → October), peaking at 99.

Both are the same shape: **one person who wants something, a swarm that builds it, and a few people where judgment, knowledge or hands are needed.** Not a team of programmers.

## 2. What changed in 2026: the single-vendor swarm is free
Within eight months every lab shipped a lead with workers, inside its own subscription:

| Who | What | When |
|---|---|---|
| Claude Code | Agent teams (lead, teammates, shared task list, mailboxes); agent view; cross-session messaging, including across machines; Projects (cloud coordinator) | Feb; Sep 17 [P/S] |
| OpenAI | Codex app ("command center" for parallel agents); buying Ona for hours-long cloud runs | Feb 2; Jun 11 [S] |
| Cursor (now SpaceX) | Projects: a coordinator that "delegates tasks to thousands of subagents"; self-hosted workers | Sep 10; Mar 25 [P] |
| Cognition | Managed Devins; Windsurf became Devin Desktop, an "agent command center" | Mar 19; Jun 2 [P] |
| Google | Antigravity 2.0: parallel agents, subagent workflows | May 19 [S] |
| GitHub | Agent HQ and mission control: several vendors' agents, budgets, audit | Oct 2025 → Oct 2026 [P] |

And the people who coordinate work are adding agents as teammates, mostly for free:
- **Slack Code** (Aug 20): agents open code channels; free on every plan [S].
- **Linear:** agents create ~50% of work and are installed in 95% of paid workspaces [S].
- **GitHub:** "1 in 3 pull requests on GitHub now involves an agent" (Nadella) [P].

Three things follow:
- **Lead plus workers is table stakes,** not a product.
- **Each lab's swarm runs that lab's agents,** increasingly in that lab's cloud.
- **Neutral tools are getting scarce:** Cursor's cheapest plan is now Grok-only; OpenAI is buying Ona; Cognition bought Windsurf.

Several Harness features now have a Claude-only twin: messaging between sessions, phone control, a list of all sessions. They are Claude-only, for one account.

## 3. The three options, with the evidence

| | (a) The one-person shop | (b) "Slack of development" | (c) The swarm layer |
|---|---|---|---|
| **What it is** | A tool for one person running agents | Where large human teams work with agents | Where people run swarms: any vendor's agents, on any machines, with tasks, capacity, cost, verification and trust |
| **Size** | Small as a paid tool: low hundreds of thousands of power users × $15–25/month ≈ $20–70M a year [E]. Their money goes to the labs ($100–500/month). | Largest pool: Atlassian $6.6B/yr [P], GitHub $2B+ [B], Linear >$100M [P] | Medium and growing with agent spend: 5–10% of $1–5K/developer/year, 1–3M fleet runners ≈ $0.5–2B a year by 2027–28 [E] |
| **Who's there** | Every lab, free in the subscription; a dozen free orchestrators (Conductor, Superset, Emdash, Gas Town, Claude Squad) | Slack, GitHub, Linear, Atlassian, each owning a system of record, often free | GitHub Agent HQ (GitHub's cloud); Factory (enterprise, its own agents; $5B [P]); Superset (3 people, local); no one with all vendors + owned machines + real CLIs + operations |
| **Our right to win** | Moderate product, weak economics: labs absorb features in months | Low: no system of record, no enterprise sales | Strongest: real CLIs (new lab features arrive at once), ~15 engines, many machines, cross-engine messaging, sharing across accounts, the pilot |
| **Warning sign** | **Vibe Kanban shut down** (Apr 10): thousands of daily users, mostly free, "couldn't find a business model" [P] | The whole company has to switch; incumbents bundle it | GitHub becomes the good-enough neutral layer while labs pull work into their clouds |

## 4. The recommendation: (c), entered through the swarm owner

**Be the swarm layer: run every agent, from every lab, on every machine you own, as one crew, and know what it costs, what it's doing and whether its work is verified.**

- **Don't build the agent.** The labs out-build us every month. Harness runs their real CLIs, so each new lab feature works on our floor the day it ships. The pilot paired Claude builders with a Codex reviewer, which no lab will build for us.
- **Don't build a better single-vendor swarm.** It's what the labs now give away.
- **Don't build chat for human teams.** Slack, GitHub and Linear own it and give it away. **Feed them:** PRs to GitHub, issues to Linear, a channel in Slack. Our tasks stay native inside the swarm (where leases, verified states and waking live) and report outward.
- **Do own what the labs and GitHub structurally won't:**
  - every vendor at once;
  - the customer's own machines, devices and clouds;
  - capacity and cost across subscriptions, CI and machines;
  - verification before work reaches GitHub;
  - live terminals people can visit, across accounts.

**Why this is the gap.** The bottleneck has moved from writing code to running the fleet, and each fix is vendor-specific:
- Faros: about 2× the code changes, flat company metrics [P].
- Linear: "AI coding has made CI a bottleneck" [P].
- GitHub: agent sessions made flat pricing "no longer sustainable" [P].
- Claude's docs: ten agents use quota ~10× as fast [P].
- Enterprises name quality (32%) and security as the top barriers [P].

The pilot hit every one of these within four days ([04](04-bottlenecks.md)).

## 5. How it grows: owner → people around it → company
The path Slack, Figma and Cursor took: individual, then team, then enterprise.

1. **The owner, alone, on day one.** One person running 5–50 agents: a founder, a staff engineer, the pilot's owner, Harness's own owner. They need the floor, tasks, liveness and capacity across their own machines. Today they build this by hand with issues, timers and terminal grids.
2. **The share is the loop.** Figma spreads by a file link, Slack by a channel invite. A swarm spreads when the owner sends someone the floor: a domain expert, a tester, a person lending a machine or a device. To act there, they need a seat. Harness's shared tabs across accounts are the seed.
3. **The company.** A few owners, many swarms, shared capacity. They need:
   - capacity pools (machines, cloud VMs, subscriptions, CI);
   - budgets and cost per change;
   - policy and an audit log of every human and agent action;
   - verification infrastructure (device labs, test environments);
   - a view of every swarm.

   **The data model has to carry identity, audit and budgets from the first version.** Retrofitting them is where team tools die at the enterprise step.

## 6. Price at the share and on capacity, not per seat
- **Individuals:** free, or cheap. They spend on tokens and expect the wrapper to be free (Conductor, Emdash, Vibe Kanban).
- **Charge when a second person joins the floor,** the moment Slack and Figma charged.
- **Then by capacity:** worker-hours, machines or pools managed, plus controls (budgets, policy, audit, device labs). The market is moving this way too: GitHub went to usage, Microsoft to "per seat plus consumption" [P].
- **Test:** at least ~20% of active owners pay when they share their floor with a second person. Below that, the bottom-up path isn't there.

## 7. What has to be true, and what would change the call
- **Agents stay multi-vendor.** If one lab wins coding outright, neutrality is worth little. Today the split is Anthropic 54%, OpenAI 21% [P], and 25% of developers switched tools last year for quality [P].
- **The customer's own machines keep mattering.** If coding moves entirely into each lab's cloud, "your machines" matter less. So capacity must include cloud VMs and sandboxes too, and the floor must show cloud agents as desks (Projects threads, Codex cloud tasks, Devins).
- **Labs keep allowing third-party harnesses.** JetBrains Air reportedly can't use Anthropic subscriptions [S]. Running the real CLI, under the user's own login, is our protection; keep it that way.
- **We stay ahead on the swarm across vendors, machines and people.** Within 6–12 months, labs or GitHub may ship real cross-vendor capacity and verification. If they do, (c) shrinks to an on-prem niche.
- **Verification is the moat.** Anyone can run more agents; few can prove the result works. Devices, test environments and real-user loops as first-class resources is where we can lead, and Harness already builds hardware.

## 8. Customer zero
Harness's owner runs exactly this shape today: the pilot swarm, the desktop and mobile apps, the terminal UI, the OS, the website, each a swarm of agents. The walls in this study are walls hit this month: idle agents, missed tasks, review queues, CPU and disk limits, CI queues, no view of the whole floor. ("lol this is me", owner, 2026-10-17.)

So the first version is judged by one question: **does it remove these walls for the owner's own swarms?** The measurements in [08](08-experiments.md) run on those swarms first. The pilot team's people are the first to be invited onto a floor.

## 9. Open questions for the owner
- **The name.** "Swarm" echoes Docker Swarm, the orchestrator that lost to Kubernetes, and it was already the name of Harness's own first agent-team protocol, which was removed after 13 days ([01b](01b-harness-repo.md)). "Crew", "floor" or keeping "tab" are alternatives. It's cheap to decide now and expensive later.
- **Free for individuals, or paid from the start** to signal the professional tier?
- **Cloud capacity** (VMs we host) as a product, or only bring-your-own machines and clouds?
- **Verification infrastructure:** how far do we go? Device labs as a service, real-user testing?
- **Outbound integrations first:** GitHub (PRs, already used), Linear, or Slack Code?
