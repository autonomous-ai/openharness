# Market study: which market Harness should choose

Date: 2026-10-17. Question: (a) the one-person shop that runs swarms, (b) large teams that need a collaboration layer for humans and agents, or (c) a vendor-neutral control plane for agent swarms.

## How to read this report

Every claim carries a tag:

- **[P]**: primary source, fetched during this study (vendor docs, vendor blog, filing, earnings transcript).
- **[S]**: secondary source (press, analyst, blog, aggregator). Treat numbers as reported, not confirmed.
- **[C]**: company claim, self-reported and unaudited, even when it comes from a primary page.
- **[B]**: background knowledge, not re-verified in this session. The shared web-search budget ran out partway through; later items come from directly fetched pages or are tagged [B].
- **[E]**: my estimate.

---

## 1. Where the labs and big platforms are going

### Summary table

| Player | Running MANY agents | TEAMS of humans and agents | Pricing model |
|---|---|---|---|
| **Anthropic, Claude Code** | Agent teams: one lead, teammates, a shared task list, mailboxes. Experimental and off by default. Agent view (`claude agents`) supervises local background sessions. **Claude Code Projects** (Sep 17, 2026): a cloud coordinator that splits work into parallel threads with shared memory. | Cross-session messaging, including to your own sessions on other machines through Remote Control. Claude in Slack, and a founding agent of Slack Code. Projects is promised for Team and Enterprise but not shipped there yet. | Per seat plus usage. Pro $17-20, Max from $100, Team Standard $20/25, Team Premium $100/125, Enterprise $20/seat (20-seat minimum) plus usage at API rates. [P] |
| **OpenAI, Codex** | Codex app for macOS (Feb 2, 2026): a "command center" for parallel agents on worktrees, with automations [S]. Cloud tasks. Buying **Ona** (ex-Gitpod) so agents can run for hours or days with the laptop closed (announced Jun 11, 2026) [S]. | Slack and GitHub review integrations. Business workspace with admin, SSO, RBAC, and audit logs on Enterprise. | Seat with included allowance, plus credits billed per token. Plus $20, Pro $100/$200/$500, Business $20-25 per user, Enterprise by contract. [P] |
| **GitHub / Microsoft** | **Agent HQ** and mission control (announced Oct 28, 2025): assign, steer, and track several vendors' agents [P]. Claude and Codex in public preview on GitHub and VS Code from Feb 9, 2026, for Pro+ and Enterprise [S]. Copilot app plus "dynamic workflows" with parallel agents (Oct 1, 2026, public preview, all plans) [P]. | The control plane is "your agent governance layer": allowed agents, model access, audit logging, a metrics dashboard [P]. Slack and Linear integrations. | Usage-based since Jun 1, 2026 through AI Credits. Pro $10, Pro+ $39, Business $19/user, Enterprise $39/user. Credits are pooled, with budgets per enterprise, cost center, and user [P]. |
| **Google** | Antigravity 2.0 (I/O, May 19, 2026): a standalone desktop app for running agents in parallel, with subagent workflows and scheduled background tasks. Antigravity CLI replaces Gemini CLI [S]. Jules runs as an async PR agent [S]. | Not a team focus in what I found. | Bundled with Google AI plans [S]. |
| **Cursor (now SpaceX)** | Parallel and cloud agents. **Projects** (Sep 10, 2026): a coordinator that doesn't write code and "delegates tasks to thousands of subagents" on its own cloud computer [P]. Self-hosted cloud agents generally available Mar 25, 2026, with a Kubernetes operator and fleet API [P]. iOS remote control of local agents (Oct 6, 2026) [P]. | Projects can subscribe to Slack channels, schedules, and PRs [P]. Rollouts and Security Review for Teams and Enterprise (Sep 23, 2026) [P]. | The **Plus $8 tier is Grok-only** and Premium is $30. Teams from $30/user, Enterprise with pooled usage [P]. "Cursor is now a part of SpaceX" (blog, Aug 14, 2026) [P]. |
| **Cognition (Devin, Windsurf)** | Managed Devins (Mar 19, 2026): a coordinator that delegates to parallel Devins, each in its own VM [P]. Windsurf became **Devin Desktop**, an "agent command center" (Jun 2, 2026) [P]. It is reported to run Codex, Claude Agent, and other ACP agents [S]. | Enterprise partnerships (Infosys, Cognizant, Mercedes), FedRAMP High in process, and an "AI Productivity Guarantee" of up to $10M [P]. | Usage measured in ACUs, plus self-serve plans (Apr 14, 2026) [P]. |
| **Atlassian** | Rovo Dev coding agent [S]. | Rovo agents across Jira and Confluence. | Rovo Dev reportedly $20/dev/month with 2,000 credits [S, low confidence]. |
| **Linear** | Linear Agent, Coding Sessions that take a bug from triage to a reviewed fix (Jun 11, 2026), and Loops for recurring agent workflows (Jul 20, 2026) [P]. | Agents are first-class assignees. Agents create about 50% of work, up from about 3% a year earlier, and are installed in 95% of paid workspaces [S, citing Linear, Aug 2026]. | Agents are included in per-seat tiers [S]. |
| **Slack (Salesforce)** | Not an agent runtime. | **Slack Code** (Aug 20, 2026): agents open code channels with Conversation, Plan, Diffs, and Preview tabs, and a human approves merges. Founding agents are Claude, ChatGPT, Devin, GitHub Copilot, and Vercel. **Free on every Slack plan** [S]. | Free. Each agent needs its own license [S]. |
| **JetBrains** | Air, public preview Mar 2026: runs Codex, Claude Agent, Gemini CLI, and Junie concurrently through ACP, locally, in Docker, or in worktrees [S]. | Not a team focus yet. | Free preview with a JetBrains AI subscription. Reportedly, existing agent subscriptions work "except Anthropic" [S]. |
| **Warp** | Open-sourced its agentic development environment (Apr 28, 2026). Oz is its cloud orchestration layer. "Teams are moving from a handful of agents to dozens or hundreds" [P]. Works with Claude Code, Codex, Gemini CLI, and OpenCode [S]. | Shared session links, reviews, progress tracking [P]. | Not public. "Nearly one million developers" [C]. |
| **Factory** | Droids; Factory Environments, which start many sandboxes from one definition (Oct 12, 2026); and **OpenCompute**, a self-hosted sandbox orchestrator (Oct 14, 2026) [P]. | Model-agnostic enterprise "software factory" (Blackstone, Oct 15, 2026). Listed in the Claude and OpenAI marketplaces [P]. | Raised $200M at a $5B valuation (Sep 15, 2026) [P]. |
| **Replit** | Agent 4 with parallel tasks [S]. | Aimed at non-developers in companies [S]. | $9B valuation (Mar 2026). About $240M in 2025 revenue [S]. |
| **Amp** | "Orbs", one remote machine per agent thread, that wake on Linear issues, CI failures, or a schedule [P]. | Multiplayer orbs: teammates share control of the same agent and running app [P]. | Credits. Can run on a linked ChatGPT subscription [P]. Spun out of Sourcegraph in Dec 2025 [S]. |

### Claude Code in detail, the closest overlap with Harness

- **Agent teams** [P, docs]. One lead plus teammates, a shared task list with dependencies and file-locked claiming, and per-agent mailboxes. Split panes require tmux or iTerm2. Limits: experimental and disabled by default; one team per session; no nested teams; the lead is fixed; teammates are not restored on resume; "token costs scale linearly". The docs advise starting with 3-5 teammates.
- **Agent view** [P, docs]. `claude agents` lists every local background session on this machine, grouped by needs-input, working, and completed. It is local only, and "ten parallel agents use quota roughly ten times as fast as one."
- **Cross-session messaging** [P, docs]. `ListAgents` and `SendMessage` between your own sessions: on the same machine over a socket, and on other machines or in the cloud through Anthropic servers via Remote Control. Admins can turn it off in managed settings. **This is close to Harness's agent-to-agent messaging, but only for Claude sessions under one account.**
- **Remote Control** [S]. Research preview in Feb 2026 for Max users, controlling several sessions from the phone. Starting new sessions from the phone was reported in Aug 2026. Each machine appears as a device card.
- **Claude Code Projects** [S, VentureBeat, Sep 17, 2026]. A coordinator over parallel cloud threads with shared Project memory, steerable from the phone. Beta for Pro and Max; Team and Enterprise "eventually". **Local execution is not yet supported**, though Anthropic says it is coming "very soon".
- **Revenue** [P, Anthropic, Feb 12, 2026]. Claude Code run-rate "over $2.5 billion", more than doubled since the start of 2026, and "Claude Code business subscriptions quadrupled since the start of 2026." Anthropic's total run-rate is $14B, with a Series G of $30B at $380B.
- **Limits** [S]. Weekly limits were reset on Sep 14, 2026 and five-hour limits raised on Sep 22, 2026. Capacity remains a live constraint for users who run many agents.

### Takeaways from section 1 (my reading)

1. **Every lab and major tool has shipped the coordinator-plus-workers pattern within twelve months**: Claude agent teams (Feb 2026) and Projects (Sep 17), Codex app (Feb) plus Ona (Jun), managed Devins (Mar 19), Antigravity 2.0 (May 19), and Cursor Projects (Sep 10). A single-vendor "swarm" is now table stakes, not a product.
2. **Each lab's swarm runs on that lab's agents and, increasingly, in that lab's cloud.** Only GitHub, JetBrains, Cognition (Devin Desktop), Warp, and the startups in section 2 claim to be multi-vendor.
3. **Labs keep acquiring the tools.** Cognition bought Windsurf (2025), Anthropic bought Bun (Dec 2025), OpenAI is buying Ona (Jun 2026), and SpaceX bought Cursor (Aug 2026), whose cheapest tier is now Grok-only. Neutral tools are becoming scarcer.
4. **Platforms that own a system of record are adding agents as teammates**: GitHub (code), Linear (issues), Slack (conversation), Atlassian (Jira). Slack gives agent collaboration away free.
5. **Pricing is moving from per seat to seat plus consumption everywhere.** GitHub moved because "a quick chat question and a multi-hour autonomous coding session can cost the user the same amount… no longer sustainable" [P]. OpenAI moved to token billing in Apr 2026 [S]. Microsoft says it is "evolving our business model beyond per seat to per seat plus consumption" [P, FY26 Q4 call].
6. **Agents are now a large share of activity.** "1 in 3 pull requests on GitHub now involves an agent" and "GitHub Copilot now has 50 million users", Copilot revenue "+60% quarter-over-quarter" (Nadella, Jul 29, 2026) [P]. At Ramp, an internal coding agent produces 75% of merged PRs [P, Linear, Aug 31, 2026].

---

## 2. Startups in multi-agent orchestration and agent workspaces

| Company | Positioning | Funding / traction | Status, notes |
|---|---|---|---|
| **Conductor** (Melty Labs, YC S24) | Mac app for parallel Claude Code, Codex, and Cursor agents in isolated workspaces; review and merge [P] | Funding unverified ($2.8M vs ~$24.5M in directories) [S] | Active, v0.91. No team features on the home page [P]. |
| **Superset** (YC P26, 3 people) | "The workspace your agents run in, not a model provider." Claims 100+ parallel agents; Claude Code, Codex, OpenCode, any CLI agent [P] | YC only [S] | Free for 1 user. Pro $20 ($15 yearly) per active seat adds remote access, automations, Linear/Slack, mobile. Enterprise adds SSO, SCIM, audit, SOC 2 [P]. Elastic License (source-available) [S]. **Closest commercial analogue to Harness.** |
| **Emdash** (YC W26) | Open-source ADE: a worktree per task, 30+ agent providers, diff review [S, competitor page] | Undisclosed | Apache-2.0, free. |
| **Vibe Kanban** (bloop) | Kanban for Claude Code, Codex, Gemini, and Amp agents | "Thousands of software engineers use Vibe Kanban every day… the vast majority are free users" [P] | **Shut down Apr 10, 2026**: "couldn't find a business model that we could get excited about." Now community open source [P]. |
| **Sculptor** (Imbue) | Parallel agents in containers or worktrees | Imbue raised about $220M+ for broader research [S] | Free beta, modest adoption (about 213 stars) [S]. |
| **Omnara** (YC S25) | Mobile and web control of Claude Code and Codex sessions | About $500K [S] | Overlaps Claude Code Remote Control [S]. |
| **Claude Squad, Agent Farm** | Open-source tmux/worktree multiplexers | n/a | Free. |
| **Gas Town** (Steve Yegge) | OSS orchestrator, Jan 2026. Roles: Mayor (dispatch), Polecats, Crew, Witness (monitor), Refinery (merge). Scales to 20-30 agents across Claude Code, Codex, Gemini, and others [S] | OSS | About $100/hour token burn at 12-30 agents [S, commentary]. Followed by Gas City, an SDK [S]. |
| **Warp / Oz** | ADE plus cloud orchestration; open source | Sequoia, GV; "nearly 1M developers" [C] | See section 1. |
| **Amp** | Remote orbs, multiplayer | Spun out Dec 2025 [S] | See section 1. |
| **Factory** | Enterprise, model-agnostic, self-hosted | $200M at $5B (Sep 15, 2026) [P]. Earlier $150M Series C at $1.5B (Apr 2026) [S] | Fastest-rising independent enterprise player. |
| **Sycamore** | "Agentic orchestration layer" for large enterprises, coding to back-end | **$65M seed** (Coatue, Lightspeed), Mar 30, 2026 [P] | Enterprise-first, top-down. |
| **Ona** (ex-Gitpod) | Secure cloud environments for agents: VPC, audit trail on every human and AI action [S] | About $41M raised [S] | **Being acquired by OpenAI** (Jun 11, 2026), pending regulatory approval [S]. |
| Crystal/Nimbalyst, Terragon, Tembo, Boxd | Parallel-agent desktop or cloud tools | No reliable data found | Search budget ran out before these could be checked. |

**Pattern** (my reading):

- The independent tools have converged on one feature set: worktrees, parallel CLI agents, diff review, phone access, and Linear/Slack hooks. Most are free or $15-20 per seat.
- The individual tier does not monetize on its own (Vibe Kanban). Money in this category goes to enterprise-first players (Factory at $5B, Sycamore's $65M seed, Cognition at $48B) or to acquisitions by labs (Ona, Cursor).
- No independent company has clearly claimed the "neutral control plane for fleets across vendors and owned machines" position. Factory comes closest for enterprises, but it sells its own Droids and sandboxes. Superset comes closest for individuals and small teams, but it is a three-person company with a worktree-based local app.

---

## 3. Market sizes and analogies

### AI coding revenue (growth)

| Metric | Value | Date | Tag |
|---|---|---|---|
| Enterprise spend on coding AI | $4.0B in 2025 (55% of departmental AI), up from about $550M in 2024 | Menlo, Dec 9, 2025 | [P] |
| Coding model share | Anthropic 54%, OpenAI 21% | Menlo, Dec 2025 | [P] |
| Claude Code run-rate | > $2.5B, doubled since Jan 1 | Feb 12, 2026 | [P] |
| Cursor ARR | $1B (Nov 13, 2025, $29.3B valuation) [P]; $2B (Bloomberg, Mar 2, 2026, listed on Cursor's press page) [S]; acquired by SpaceX (Aug 14, 2026) [P] | | |
| Cognition run-rate | Crossed $1B (Sep 25, 2026); $48B valuation (Sep 8, 2026) | | [P] |
| GitHub Copilot | 50M users; revenue +60% QoQ after the usage-billing switch | Jul 29, 2026 | [P] |
| GitHub | $2B ARR | Jul 2024 | [B] |
| Codex | 5M+ weekly active users, about +400% YTD | Jun 2026 | [S, citing OpenAI] |
| Replit | About $240M revenue in 2025; $9B valuation | Mar 2026 | [S] |
| Combined AI coding tool run-rate | **On the order of $10-15B ARR in H2 2026** | | [E], sum of the above with growth |

### Developers (the base)

- About 30M professional developers worldwide (27M-47M depending on source). a16z's assumption-heavy framing puts the economic value of software development at $3T a year (Oct 9, 2025) [P].
- GitHub had 180M+ developers and 36M new in the year to Aug 2025 (Octoverse) [P], and 225M users in Jul 2026 [P].
- Stack Overflow 2026: 73% use coding assistants and agents daily; Claude Code (66%) and GitHub Copilot (59%) lead agent-tool usage [P].

### Collaboration tools (the "Slack of development" pool)

| Company | Size | Tag |
|---|---|---|
| Atlassian | $6.6B trailing-twelve-month revenue, +26%; 350K+ customers; 85%+ of the Fortune 500 (as of Jun 30, 2026) | [P] |
| Slack | About $0.9B revenue at its last standalone report (FY2021); acquired by Salesforce for $27.7B (announced Dec 2020) | [B] |
| GitHub | $2B ARR (Jul 2024) | [B] |
| Linear | > $100M ARR (Aug 26, 2026) [P]; 40,000 paying companies, 177% net revenue retention, $2.5B valuation in a secondary sale [S] | |
| Microsoft 365 Copilot | 30M+ paid seats (Jul 2026) | [P] |

### Control-plane analogies

- **Datadog** (observability across clouds): about $2.7B revenue in 2024 [B]. It is a neutral layer that charges on usage of infrastructure it does not own.
- **HashiCorp** (Terraform, a multi-cloud control plane): acquired by IBM for $6.4B (announced Apr 2024, closed Feb 2025) [B]. Neutrality across AWS, Azure, and GCP was the whole product.
- **Kubernetes ecosystem** [B]. Google open-sourced the orchestrator and gave it away. Mesosphere/D2iQ (DC/OS) lost and wound down in 2023, and **Docker Swarm lost** to Kubernetes. Value accrued to managed control planes from the platforms that own compute (EKS, GKE, AKS), to enterprise distributions (Red Hat OpenShift), and to adjacent layers (observability, security).
- **Lessons**: (1) A neutral control plane is valuable only when the underlying market really is multi-vendor. Clouds were, and coding agents are now. (2) The orchestrator itself tends to be commoditized or given away by a platform owner, and today GitHub Agent HQ is trying to be that platform owner. (3) Durable value sits in what the platform owner won't do: running across vendors and on the customer's own hardware, governance, cost, and verification.

---

## 4. What enterprises say they lack when adopting many coding agents

| Gap | Evidence |
|---|---|
| **Accuracy, quality, verification** | 87% of developers are concerned about agent accuracy (Stack Overflow 2025) [P]. "Quality is the production killer": it is the top blocker at 32% (LangChain, 1,340 respondents, published Jun 12, 2026) [P]. Faros (about 10,000 developers, 1,255 teams): engineers complete about twice as many code changes, "but company metrics remain flat" [P]. Linear: "AI coding has made CI a bottleneck" (Sep 21, 2026) [P]. Cognition published "Verifying Agentic Development" (May 29, 2026) and backs output with a refund guarantee [P]. DORA 2025: AI is "an amplifier" of the existing system [P]. |
| **Security, privacy, data residency** | 81% have security and privacy concerns about agents (Stack Overflow 2025) [P]. Security is the #2 barrier at enterprises with 2,000+ employees, at 24.9% (LangChain) [P]. Cursor built self-hosted agents because regulated companies "cannot let code, secrets, or build artifacts leave their environment" (Mar 25, 2026) [P]. Factory OpenCompute is self-hosted (Oct 2026) [P]. Ona sold VPC deployment with "audit trails on every human and AI action" [S]. |
| **Governance and audit** | GitHub's control plane offers allowed agents, model access, and audit logs [P]. Every enterprise tier now lists audit logs, SCIM, and RBAC (Codex, Cursor, Superset) [P]. Menlo expects requirements for "audit logs for agentic outcomes" [P]. Claude Code admins can disable cross-session messaging and agent teams through managed settings [P]. |
| **Cost control** | GitHub repriced to usage because agent sessions broke flat pricing, adding budgets per enterprise, cost center, and user [P]. Claude docs: agent teams "use significantly more tokens"; ten agents use quota about 10x as fast [P]. Gas Town: about $100/hour at 12-30 agents [S]. Gartner (Jun 25, 2025): >40% of agentic AI projects will be canceled by end of 2027 for "escalating costs, unclear business value or inadequate risk controls" [B; the fetch was blocked]. OpenAI guidance is $100-200 per developer per month for Codex [S]. |
| **Capacity** | Rate limits and weekly limits (Claude limits reset Sep 2026) [S]. Microsoft: "When it comes to running agents, CPUs are just as important as GPUs" [P]. Cursor, Factory, and Ona all sell "agents keep running when the laptop closes", meaning compute capacity for agents. |
| **Multi-vendor** | Stack Overflow 2026: in the past year 25% switched tools for better output and 11% because their organization required it [P]. Anthropic and OpenAI split coding share 54/21 [P]. GitHub, JetBrains, Cognition, Warp, and Factory all now advertise multi-agent or model-agnostic support, which is a demand signal. Cursor's capture by SpaceX (Grok-only entry tier) shows the risk of single-vendor tools. |
| **On-prem and own hardware** | Cursor self-hosted workers (Kubernetes operator) [P]. Factory OpenCompute [P]. Blackstone wanted agents "inside its existing technology environment and security controls" [P]. |
| **Collaboration and coordination** | Atlassian DevEx 2025 (3,500 respondents): 68% save >10 h/week with AI, yet 50% lose ≥10 h/week to "organizational inefficiencies"; 63% say leaders don't understand their pain (up from 44%) [P]. Slack frames Slack Code as turning solo terminal coding into team work: "AI only creates value when it's part of how a team actually works" [S]. |
| **True agent adoption is still early in enterprises** | Only 16% of enterprise deployments are "true agents" (Menlo, Dec 2025) [P]. 67% of companies with 10,000+ employees have some agent in production (LangChain) [P]. |

**Gap synthesis** (my reading): each vendor is building governance, cost, and verification for its own agents. What no one owns is **governance, capacity, cost, and verification across vendors and across the customer's own machines**: the operations layer for a fleet. That is the gap a neutral control plane would fill.

---

## 5. Bottom-up adoption dynamics

| Company | Path | What drove the jump to team and enterprise |
|---|---|---|
| **Slack** | A team adopts it, then neighbouring teams, then the company | The network effect inside a company. A free tier with a message-history cap creates conversion pressure as usage grows. S-1 (Apr 2019): 88K paid customers, 575 above $100K, 143% net dollar retention [B]. |
| **Figma** | A designer, then design team, then PMs and engineers through a shared link | Multiplayer by URL: every share brings in a new seat. S-1 (Jul 2025): about 13M monthly users, two-thirds not designers; 95% of the Fortune 500; 1,031 customers above $100K; 132% net dollar retention [B]. |
| **Notion** | An individual, then templates and community, then teams | A personal workspace that becomes a team wiki; reported to be around $500M annual revenue in 2025 [B]. |
| **Linear** | Opinionated speed for startups, growing with them as they grow | Won the companies that became large (OpenAI, Cursor, Cognition run on Linear [S]); 177% NRR [S]; now positions agents as first-class users [P]. |
| **Cursor** | Individual $20 self-serve, then team, then enterprise | Roughly $100M ARR in about 12 months with almost no sales team [B]. $1B by Nov 2025 [P]. Then it added Teams and Enterprise controls, self-hosted agents, and security review [P]. Its independence ended with the SpaceX acquisition. |
| **Claude Code** | An individual CLI, then business subscriptions | Business subscriptions grew 4x in about six weeks of 2026 [P]. More than half of revenue is reportedly enterprise [S]. Some adoption is now top-down: 11% of developers switched tools because their organization required it [P, Stack Overflow 2026]. |

### Implications for a swarm workspace

1. **The first user must get value on day one, alone.** For a swarm workspace that user is the person who owns a fleet: a founder, tech lead, or staff engineer running 5-50 agents. Harness's pilot (one owner, one lead, about 14 builders, about 165 merged PRs/day) is that user.
2. **The viral loop has to be a share.** Figma spreads through a file link and Slack through a channel invite. A swarm workspace spreads when the owner sends a reviewer, teammate, or manager a live view of the floor (on phone or web) and that person needs a seat to act. Harness's cross-account shared tabs are the seed of this loop.
3. **Charge at the moment of sharing, not at the individual tier.** Individuals spend their budget on tokens ($100-500/month to the labs) and expect the wrapper to be free (Vibe Kanban, Conductor, Emdash). Slack and Figma monetized when a second person needed in.
4. **Enterprise features follow team pull, but the data model must carry them from the start**: identity, an audit log of every human and agent action, budgets, and on-prem execution. Retrofitting them is what killed many team tools at the enterprise step.
5. **Integrate with systems of record rather than replace them.** Teams already live in GitHub, Linear, and Slack, and each now hosts agents. A swarm workspace should feed them (PRs, issues, Slack Code channels), not compete for the conversation.

---

## Market options assessed

### How Harness's capabilities compare with what is already covered

| Harness capability | Who else has it | Distinct? |
|---|---|---|
| Many parallel agents on one machine | Everyone: Claude agent view, Codex app, Cursor, Air, Conductor, Superset, Emdash | No |
| Lead/coordinator plus workers | Claude agent teams and Projects, Cursor Projects, managed Devins, Gas Town, Antigravity 2.0 | No, unless it is cross-vendor |
| Phone control | Claude Remote Control, Cursor iOS, Omnara, Superset, Amp | No |
| About 15 engines in one workspace | Agent HQ (a few vendors, GitHub cloud), Air (4), Devin Desktop (ACP), Warp, Superset/Emdash (any CLI agent) | Partly: broadest coverage among apps with live terminals |
| **Many owned machines with live, real CLI terminals** | Claude (Claude only, through Remote Control), Cursor self-hosted (Cursor agents, enterprise), Factory OpenCompute (Factory agents) | **Yes, when cross-vendor** |
| **Agent-to-agent messaging across engines and machines** | Claude cross-session messaging (Claude only, one account) | **Yes, when cross-vendor** |
| Shared live tabs across accounts | Slack Code channels, Amp multiplayer orbs, Superset Pro | Partly: the live terminal floor is distinct, but team collaboration is contested |
| **Capacity, cost, and verification across vendors** (planned Swarm) | Only vendor-specific versions: GitHub budgets, Cursor Security Review, Cognition verification | **Yes, and still open** |

### (a) The one-person shop that runs swarms

- **Size.** Small as a paid market for a workspace. Power users running many agents are probably in the low hundreds of thousands worldwide in 2026 [E]. At $15-25/month they are worth about $20-70M ARR [E]. Their real spend goes to the labs ($100-500/month on Max, Pro, or Ultra).
- **Competition.** The most intense of the three. Every lab has shipped a coordinator-plus-workers swarm within the last eight months, free inside the subscription: Claude Projects, Cursor Projects, Codex app plus Ona, managed Devins, Antigravity 2.0. A dozen free or cheap orchestrators (Conductor, Superset, Emdash, Gas Town, Claude Squad, Sculptor) fill the rest.
- **Right to win.** Moderate on product quality: many engines, owned machines, live terminals, phone, and the 177 PRs/day proof. Weak on economics. Labs absorb features within months: cross-session messaging, Remote Control, and agent view each mirror a Harness feature for Claude users.
- **Risks.** Feature absorption by labs. Low willingness to pay: Vibe Kanban shut down with thousands of daily users, mostly free. Labs restricting third-party use of subscriptions (JetBrains Air reportedly cannot use Anthropic subscriptions). Capacity limits set by each lab.

### (b) Large development teams: a collaboration layer for humans and agents ("Slack of development")

- **Size.** Largest pool of spend. Atlassian alone is $6.6B a year [P]; add Slack, GitHub ($2B+), and Linear ($100M+); Microsoft 365 Copilot has 30M+ paid seats.
- **Competition.** Owned by incumbents that hold the system of record and are moving fast, often for free:
  - Slack Code (Aug 20, 2026, free on every plan, with Claude, ChatGPT, Devin, Copilot, and Vercel as launch agents)
  - GitHub Agent HQ and mission control, plus the Copilot app with workflows
  - Linear: agents create about 50% of work and are installed in 95% of paid workspaces
  - Atlassian Rovo, and Microsoft Agent 365 (about 40M agents registered)
- **Right to win.** Low. Harness has no system of record (code, issues, or conversation) and no enterprise sales motion. It would ask whole organizations to change where they talk. Live terminal panes suit engineers who drive agents, not product managers, managers, and support staff.
- **Risks.** Long enterprise cycles. Two-sided adoption, where the whole team must switch. Incumbents bundle the feature for free. The surface where humans and agents collaborate is being settled now by Slack, GitHub, and Linear.

### (c) In between: a vendor-neutral control plane for agent fleets

- **Size.** Medium now, growing with agent spend. Agent spend per developer is already $1-5K a year (Claude Team Premium $1,200-1,500/year, Codex guidance $100-200/month). A neutral operations layer at 5-10% of fleet spend, or $30-60/seat/month for people who run fleets, gives a serviceable market of about $0.5-2B ARR by 2027-2028 if 1-3M developers run fleets [E]. Analogies: HashiCorp ($6.4B exit) and Datadog (about $2.7B revenue in 2024) [B].
- **Competition.**
  - GitHub Agent HQ: multi-vendor, but GitHub-cloud-centric and Copilot-billed.
  - Devin Desktop, JetBrains Air, and Warp/Oz: multi-agent clients, each tied to its own platform or agent.
  - Factory: an enterprise "software factory" with self-hosted compute, selling its own Droids.
  - Superset and Emdash: indie, local, and thin on operations.
  - Sycamore: enterprise orchestration, but top-down and broader than coding.
  - None combines cross-vendor support, owned machines, the real CLIs, and operations: capacity, cost, verification, and audit.
- **Right to win.** The strongest of the three:
  - Harness runs each lab's real CLI in a live terminal, so every new lab feature arrives at once instead of being re-implemented, and Harness does not depend on OAuth wrapping.
  - It already spans about 15 engines and many owned machines.
  - It has cross-engine, cross-machine messaging and cross-account sharing.
  - Its Swarm design targets the exact enterprise gaps (capacity, verification, cost) that each lab solves only for its own agents.
  - The pilot is a demonstrable result.
- **Risks.**
  - GitHub becomes the default neutral layer, as EKS did for Kubernetes.
  - Labs restrict third-party harnesses or push work into their own clouds (Projects, Ona), shrinking local fleets.
  - "Control plane" is an enterprise sale that a small team can't run early.
  - Labs keep shipping cross-session features (messaging, remote control) that cover the single-vendor 80% case.
  - Our own "Swarm" name repeats Docker Swarm, the orchestrator that lost.

---

## Recommendation

**Choose (c): the vendor-neutral control plane for agent fleets. Enter it bottom-up through the fleet owner, who is the buyer in (a), without selling (a)'s product.** The product promise: *run every agent, from every lab, on every machine you own, as one crew, and know what it costs, what it is doing, and whether its work is verified.* Do not build the "Slack of development" (b); feed Slack, GitHub, and Linear instead. Do not compete as a better single-vendor swarm (a).

### Strongest reasons

1. **A single-vendor swarm is now a commodity the labs give away.** In 2026, Claude Code (agent teams in Feb, Projects on Sep 17), Cursor (Projects on Sep 10, "thousands of subagents"), Cognition (managed Devins, Mar 19), OpenAI (Codex app in Feb, Ona in Jun), and Google (Antigravity 2.0, May 19) all shipped coordinator-plus-workers inside their own walls. The only durable position next to them is the one they structurally will not take: neutral across labs and running on the customer's own hardware.
2. **Neutrality is getting scarcer and more valuable.** Cursor is now part of SpaceX with a Grok-only entry tier, OpenAI is buying Ona, and Cognition bought Windsurf. Developers switch tools (25% switched for quality in the past year), enterprises split spend (Anthropic 54%, OpenAI 21% in coding), and multi-agent clients from GitHub, JetBrains, Cognition, and Warp show demand. HashiCorp and Datadog show what a neutral layer over a multi-vendor market can be worth.
3. **The bottleneck has moved from writing code to operating the fleet, and the available fixes are vendor-specific.**
   - Faros: about 2x the code changes, flat company metrics.
   - Linear: CI became the bottleneck.
   - GitHub: agent sessions made flat pricing "no longer sustainable", so it added budgets.
   - Claude: ten agents use about 10x the quota.
   - Enterprises name quality (32%) and security (#2) as the top barriers.

   Harness's planned Swarm work (capacity, verification, a floor of live terminals, native tasks) is that operations layer, and it is valuable precisely because it spans vendors.
4. **(b) is already taken by owners of systems of record, and they give it away.** Slack Code is free on every plan with five founding agents. Linear agents create about half of the work in its product. GitHub mission control sits in Copilot. Harness should be the fleet's engine room that reports into those surfaces, not a new place for the whole company to talk.
5. **There is a proven bottom-up path, and Harness already has the wedge.** Slack, Figma, and Cursor all went individual, then team, then enterprise. The owner running a fleet gets value alone (the 177 PRs/day pilot). The shared live floor (cross-account tabs) is the viral share that brings in a second seat, and that is where to charge. Governance, audit, budgets, and on-prem execution are the enterprise expansion.

### Biggest risk

**GitHub becomes the "good-enough" neutral control plane** (Agent HQ, mission control, Copilot app workflows, pooled budgets, audit, and "every major coding agent runs on the platform") **while the labs pull execution into their own clouds and restrict third-party harnesses.** That would squeeze Harness into a free local multiplexer, the Vibe Kanban outcome.

Mitigations:

- Own what GitHub and the labs won't: the customer's own machines, real CLIs with live terminals, cross-vendor capacity and cost, and verification before work reaches GitHub.
- Integrate with Agent HQ, Slack Code, and Linear as outputs instead of fighting them.
- Charge for team operations from the first team, not for individual use.

### What would change this call

- If the labs open first-class cross-vendor capacity and verification inside GitHub or their own apps within 6-12 months, (c) shrinks toward a niche on-prem tool.
- If owners in the pilot cohort will not pay for a second seat or for fleet operations (target: >20% of active owners convert when they share a floor), the bottom-up path is not there.

### Sources (main links)

**Anthropic / Claude Code**
- [Claude Code agent teams docs](https://code.claude.com/docs/en/agent-teams)
- [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
- [Agent view](https://code.claude.com/docs/en/agent-view)
- [VentureBeat on Claude Code Projects (Sep 17, 2026)](https://venturebeat.com/orchestration/anthropic-launches-claude-code-projects-an-always-on-conversation-that-remembers-and-delegates-your-long-running-dev-work)
- [Anthropic Series G (Feb 12, 2026)](https://www.anthropic.com/news/anthropic-raises-30-billion-series-g-funding-380-billion-post-money-valuation)
- [Claude pricing](https://claude.com/pricing)
- [Claude Code limits change](https://www.bleepingcomputer.com/news/artificial-intelligence/anthropic-is-cutting-claude-codes-current-weekly-limits-by-17-percent/)
- [Remote Control](https://gigazine.net/gsc_news/en/20260225-claude-code-remote-control)

**OpenAI / Codex**
- [Codex pricing](https://learn.chatgpt.com/docs/pricing)
- [Codex app](https://intuitionlabs.ai/articles/openai-codex-app-ai-coding-agents)
- [OpenAI acquires Ona](https://siliconangle.com/2026/06/11/openai-acquires-ai-agent-orchestration-startup-ona/), [The Decoder on Ona](https://the-decoder.com/openai-buys-ona-to-push-codex-toward-long-running-autonomous-coding-tasks/)

**GitHub / Microsoft**
- [Agent HQ](https://github.blog/news-insights/company-news/welcome-home-agents/)
- [Claude and Codex in Agent HQ](https://www.i-programmer.info/news/105-artificial-intelligence/18651-github-adds-claude-and-codex-to-agent-hq.html)
- [Copilot usage-based billing](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/)
- [Dynamic workflows](https://github.blog/changelog/2026-10-01-dynamic-workflows-in-copilot-cli-and-the-copilot-app/)
- [Microsoft FY26 Q4 call](https://www.fool.com/earnings/call-transcripts/2026/08/07/microsoft-msft-q4-2026-earnings-call-transcript/)
- [Octoverse 2025](https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/)

**Google**
- [Antigravity 2.0](https://pasqualepillitteri.it/en/news/2914/antigravity-2-0-google-io-2026-multi-agent-suite)

**Cursor**
- [Cursor changelog](https://cursor.com/changelog)
- [Projects](https://cursor.com/blog/projects)
- [Self-hosted agents](https://cursor.com/blog/self-hosted-cloud-agents)
- [Pricing](https://cursor.com/pricing)
- [Blog index (SpaceX, Bloomberg $2B)](https://cursor.com/blog)
- [Series D](https://cursor.com/blog/series-d)

**Cognition**
- [Cognition blog](https://cognition.com/blog)
- [Managed Devins](https://cognition.com/blog/devin-can-now-manage-devins)
- [Devin Desktop](https://runtimewire.com/article/cognition-turns-windsurf-into-devin-desktop-a-command-center-for-coding-agents)

**Collaboration platforms**
- [Atlassian IR](https://investors.atlassian.com/)
- [Rovo pricing](https://www.eesel.ai/blog/atlassian-intelligence-and-rovo-pricing-explained)
- [Linear Now](https://linear.app/now)
- [SaaStr on Linear agents](https://www.saastr.com/50-of-the-work-created-in-linear-is-now-created-by-agents-a-year-ago-it-was-3/)
- [Slack Code](https://salesforcedictionary.com/news/salesforce-news-august-21-2026-slack-code-multiplayer-coding)
- [Slack coding agents](https://slack.com/blog/developers/coding-agents-in-slack)

**Other platforms**
- [JetBrains Air](https://blog.jetbrains.com/air/2026/03/air-launches-as-public-preview-a-new-wave-of-dev-tooling-built-on-26-years-of-experience/)
- [Warp](https://www.warp.dev/newsroom/2026/4/28/warp-open-sources-its-agentic-development-environment)
- [Factory news](https://factory.com/news)
- [Replit (Sacra)](https://sacra.com/research/replit)
- [Amp](https://ampcode.com/)

**Orchestration startups**
- [Conductor](https://www.conductor.build/)
- [Superset pricing](https://superset.sh/pricing)
- [Vibe Kanban shutdown](https://vibekanban.com/blog/shutdown)
- [Sculptor](https://imbue.com/product/sculptor)
- [Omnara](https://ycombinator.com/companies/omnara)
- [Gas Town](https://pkg.go.dev/github.com/steveyegge/gastown)
- [Sycamore seed](https://techcrunch.com/2026/03/30/former-coatue-partner-raises-huge-65m-seed-for-enterprise-ai-agent-startup/)

**Surveys and market sizing**
- [Menlo 2025](https://menlovc.com/perspective/2025-the-state-of-generative-ai-in-the-enterprise/)
- [a16z dev stack](https://a16z.com/the-trillion-dollar-ai-software-development-stack/)
- [Stack Overflow 2025 AI](https://survey.stackoverflow.co/2025/ai)
- [Stack Overflow 2026 AI](https://survey.stackoverflow.co/2026/ai)
- [LangChain State of Agent Engineering](https://www.langchain.com/state-of-agent-engineering)
- [Faros AI productivity paradox](https://www.faros.ai/ai-productivity-paradox)
- [DORA 2025](https://dora.dev/research/2025/dora-report/)
- [Atlassian DevEx 2025](https://www.atlassian.com/blog/developer/developer-experience-report-2025)
- [Gartner agentic AI prediction (fetch blocked)](https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027)
