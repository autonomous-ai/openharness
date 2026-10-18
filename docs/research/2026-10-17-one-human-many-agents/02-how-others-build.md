# How others build with agents (October 2026)

2026-10-17. What frontier labs, leading software companies and the people running agent fleets actually do, and what the controlled research says. Claims are marked by how they are known: **measured** (with a method), **reported** (a company's own account, often with a stake in the answer), or **claimed**. Full sources are in the two research reports kept with this study ([landscape](sources/landscape.md), [frontier practice](sources/frontier-practice.md)).

## 1. The labs build their software mostly with agents, and review is their bottleneck

| Organization | What they say | How it's known |
|---|---|---|
| **Anthropic** | Claude authored >80% of merged code by May 2026. Lines merged per engineer are ~8× 2024, which they say overstates productivity. By August, ~30,000 agents ran at once on the main internal platform. Claude "leads" 26% of model-R&D tasks, and none fully autonomously. The named bottleneck is **human code review**. At the "Claude leads" level, the engineer "reads the write-up, skims the change, and decides whether to ship. The agent doesn't deploy." Most staff can fully delegate only 0–20% of their work. | reported, partly measured ([recursive self-improvement](https://www.anthropic.com/institute/recursive-self-improvement), [measuring pace](https://www.anthropic.com/institute/measuring-pace-of-ai-development), [study](https://www.anthropic.com/research/how-ai-is-transforming-work-at-anthropic)) |
| **OpenAI** | One team built a product over 5 months with **zero hand-written code**: ~1M lines and ~1,500 PRs, 3 engineers growing to 7, no human review before merge, humans cutting releases. The first ~6 weeks were ~10× slower than hand-coding. "The only fundamentally scarce thing is the synchronous human attention of my team." Company-wide: ~10× load on CI and version control, with review routed by risk. | reported ([harness engineering](https://openai.com/index/harness-engineering/), [Latent Space](https://latent.space/p/harness-eng), [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/openai-software-factory)) |
| **Google** | 75% of new code is AI-generated and engineer-approved. In one migration, review became the main bottleneck. | claimed / reported ([Semafor](https://www.semafor.com/article/04/24/2026/google-ceo-says-75-of-companys-new-code-is-ai-generated), [arXiv](https://arxiv.org/html/2501.06972v1)) |
| **GitHub** | Planning for **30× capacity** because of agent workflows. Incidents doubled year on year. A merge-queue regression silently reverted ~2,092 PRs. | reported ([LeadDev](https://leaddev.com/software-quality/whats-gone-wrong-at-github)) |

"Percent of code written by AI" isn't comparable across companies: some count characters typed, others lines merged, PRs, or commits "with assistance". The consistent signal is in what they say about **review, verification and infrastructure**.

## 2. Companies running fleets

| Company | Practice |
|---|---|
| **Stripe** | Unattended agents on pre-warmed dev boxes, triggered from Slack. 1,000+ merged PRs a week with no human-written code, **all reviewed by people**. CI picks from 3M+ tests; **after two CI rounds the task goes back to a person.** |
| **Coinbase** | Engineers run 5–10 agents each. Core cryptography is reviewed "one line at a time" by people. Reorganized into AI-native "pods" as small as one person. |
| **Ramp** | A background agent writes ~75% of merged PRs. Verification uses tests, telemetry, feature-flag queries, screenshots and live previews. |
| **Cursor** (research run) | Several hundred agents built a browser for a week, peaking at ~1,000 commits an hour. Flat coordination through a shared file collapsed: "Twenty agents would slow down to the effective throughput of two or three." What worked was planners, sub-planners and workers. A central integrator and a judge became bottlenecks and were removed. "Taste, judgement, and direction came from humans." |
| **Anthropic** (C compiler) | 16 agents, two weeks, under $20k. 100k lines of Rust that builds Linux. "Most of my effort went into designing the environment." It worked because GCC was a near-perfect oracle. |
| **StrongDM** | "Code must not be written by humans. Code must not be reviewed by humans." It works from specs, with **holdout scenarios hidden from the coding agents** and cloned third-party services. ≥$1,000 of tokens per engineer per day. |
| **Individuals** | The Claude Code lead runs 10–15 sessions. Gas Town runs 20–30 agents over tmux, with a merge-queue agent and patrol agents that unstick others ("expensive as hell"). One open-source author made 6,600+ commits in a month with 5–10 agents. |

## 3. What people do in the most agent-heavy organizations
Ranked by how consistently they report it:
1. **Verify and decide whether to ship:** read the write-up and evidence, skim the diff, approve or send back. Review is routed by risk, so people take security, cryptography, core runtime and deploys.
2. **Decide what to build and why:** goals, taste, the scoring rubric, which results to trust.
3. **Program the factory:** rules files, tools, linters, structural tests, sandboxes, hidden scenarios. When an agent fails, ask "what capability, context, or structure is missing?"
4. **Split and dispatch work, then triage what comes back:** typically 4–10 agents per person, 20–30 at the edge.
5. **Own risk and production:** deploy rights, incidents, security and legal sign-off.
6. **Domain judgment:** experts embedded because "developers can't always judge quality in those domains".
7. **The hardest engineering:** new architecture, deep refactors, debugging what agents got wrong.
8. **(Shrinking) writing code by hand, mentoring.** The organizations themselves call this a risk.

## 4. What the research says about many agents
- **Hierarchy works; peers fail.** Independent agents amplified errors 17.2× and a central coordinator held it to 4.4×. Every variant was 39–70% worse on sequential tasks (Google, [arXiv 2512.08296](https://arxiv.org/abs/2512.08296); measured, not on coding). Flat peer swarms failed in every serious write-up (Cursor, Cognition, MAST).
- **Much of the gain is more tokens.** Token usage alone explained 80% of the variance on one research benchmark (Anthropic). At equal budgets, single agents match multi-agent systems on reasoning (Stanford 2026). Coding parallelizes less than research.
- **Size tasks to what finishes reliably.** At 50% reliability frontier models handle tasks of ~6–16 hours; at 80% that drops to ~1–3 hours (METR). Reliable units of delegation are about an hour.
- **Tests aren't the bar.** Maintainers would reject about half of agent patches that pass SWE-bench's tests (METR). Test gaming is rising: GPT-5.6's cheating made its horizon unmeasurable, and agents exploited contradictory tests 76% of the time on one benchmark.
- **Conflicts and duplicates are structural.** 20–42% of concurrent agent PR pairs conflict. 23% of rejected agent PRs are duplicates.
- **Isolation plus observation helps.** Agents in separate worktrees, seeing each other's commits and test output (not chat), cut destructive edits ~47% (ESEM 2026, two agents).
- **No peer-reviewed study of large swarms on real codebases exists.** Everything at 16+ agents, our pilot included, is vendor or practitioner reporting.

## 5. Quality, cost and people: the counter-evidence
- **Quality:** high-AI-adoption teams show +54% bugs per developer, about 3× incidents per PR, 5× review time, and 11.7% fewer deployments (Faros 2026, 22k developers; correlational). DORA 2025: more throughput and more instability.
- **Incidents** come down to permissions: an agent deleted a production volume and backups in 9 seconds using an unrelated token in its workspace (PocketOS); an agent "deleted and recreated" an environment (AWS Kiro, disputed).
- **Productivity studies:** METR's 2025 trial found experienced developers 19% slower. The 2026 follow-up was inconclusive: 30–50% of developers withheld tasks they didn't want to do without AI. Anthropic's own trial found 17% lower comprehension when learning with AI.
- **Cost:** multi-agent work uses ~4–15× the tokens of chat. Observed spend runs from ~$90 per agent-day (the compiler) to $1,000 per engineer-day (StrongDM). A 100-agent factory used ~20M tokens per merged PR.
- **Capacity:**
  - Anthropic added weekly caps in August 2025 because some users ran Claude Code 24/7.
  - OpenAI paused new $200 Pro sign-ups in September 2026 for capacity.
  - Rate-limit sizing assumes few concurrent users per seat, and a swarm breaks that by design.
- **People:** employment of 22–25-year-old software developers is ~20% below its late-2022 peak, while older cohorts are stable (Stanford). Entry-level postings were 4.5% of US software postings in Q1 2026. There's no broad displacement yet. AI-native startups are ~25% smaller and flatter at comparable valuations (INSEAD/HBS 2026).
- **No verified one-person billion-dollar company** exists as of October 2026.

## 6. What this means for us
Every scaled operation converges on the same shape, and it is the pilot's shape:
1. **A person's attention is the scarce resource,** spent on decisions with evidence, not on watching.
2. **Hierarchy:** a lead, workers with separate areas, one test-gated merge lane.
3. **Verification decides how much autonomy is safe:** risk-routed review, hidden scenarios, reviewers on a different model, read-only tests, real-world checks.
4. **Infrastructure saturates:** CI, git hosting, disk, provider limits.
5. **People increasingly program the factory** (rules, tools, oracles), not the product.

Nobody has yet made this a product that works across vendors, machines and people. The labs' tools stop at their own models and clouds; the platforms stop at their own trackers. That gap is where Harness fits ([10](10-strategy.md)).
