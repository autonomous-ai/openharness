# Frontier practice: how leading organizations build software with AI agents, and what their humans do

Research date: 2026-10-17. Scope: company disclosures, talks, interviews, internal studies, labor-market data. Multi-agent products and academic benchmarks are covered in a separate report.

## How to read this report

Each claim is tagged:

- **[M] Measured**: a number from telemetry, a survey, or an experiment with a described method. "Measured" does not mean audited. Most [M] numbers are still self-reported by the company.
- **[A] Asserted**: an executive or company statement with no method given.
- **[P] Prediction or aspiration.**
- **[S] Secondhand**: I found it only in secondary reporting and could not open the primary source. Treat the exact wording as unconfirmed.
- **[COI]**: the source sells AI coding tools, sells to buyers of them, or has another stake in the number (for example a layoff narrative, an IPO, or a vendor report).

**The "% of code written by AI" metric is unreliable across companies.** Definitions vary: characters accepted from completions (Google 2025), lines merged (Anthropic, Greenblatt), PRs authored by an agent (Ramp, Cursor, Cognition), commits "with Claude assistance" (Anthropic's Fung), and code "written by or with LLMs" (Coinbase). The definitions differ by up to a factor of two, so the figures are not comparable between companies, or within one company over time, unless the definition is stated.

---

## 1. Frontier labs

### Anthropic [COI: sells Claude Code; Business Insider ties Labs growth to an approaching IPO]

| Date | Claim | Type | Source |
|---|---|---|---|
| Mar 2025 | Amodei: "we will be there in three to six months, where AI is writing 90% of the code" (about the industry, at CFR) | P | [Redwood/Greenblatt](https://blog.redwoodresearch.org/p/is-90-of-code-at-anthropic-being) |
| Apr 28, 2025 | Economic Index: 79% of Claude Code conversations were "automation" vs 49% on Claude.ai. Startup work made up about 33% of Claude Code use vs 13% for enterprise | M (consumer data only; excludes Team/Enterprise/API) | [Anthropic](https://anthropic.com/research/impact-software-development) |
| Jul 24, 2025 | "How Anthropic teams use Claude Code": anecdotes across infra, security, legal, and marketing, e.g. Kubernetes IP-exhaustion debugging. Secondary summaries cite "~70% of Vim mode written in auto-accept" (unconfirmed) | A / anecdotal | [Anthropic](https://www.anthropic.com/news/how-anthropic-teams-use-claude-code), [PDF](https://www-cdn.anthropic.com/58284b19e702b49db9302d5b6f135ad8871e7658.pdf) |
| Oct 2025 | Amodei at Dreamforce called the 90% "absolutely true now" inside Anthropic, then qualified it: "on many teams… not uniformly" | A | [Redwood](https://blog.redwoodresearch.org/p/is-90-of-code-at-anthropic-being) |
| Oct 22, 2025 | Ryan Greenblatt (Redwood Research, outside Anthropic; draws on the CEO's statements and private conversations with staff) estimates about 50% of merged lines company-wide, about 90% on some teams, and a real speedup "likely under 2x". "I don't think the prediction came true." | Informed estimate | [Redwood](https://blog.redwoodresearch.org/p/is-90-of-code-at-anthropic-being) |
| Dec 2, 2025 | **Internal study** (August 2025 survey of 132 engineers and researchers, 53 interviews, 200k Claude Code transcripts): Claude used in 59% of work (28% a year earlier); self-reported productivity +50% (+20% a year earlier); 27% of Claude-assisted work "would not have been done otherwise"; more than half can fully delegate only **0–20%** of their work; max consecutive tool calls 9.8 → 21.2; human turns per transcript 6.2 → 4.1; feature implementation share 14.3% → 36.9%. One engineer: work is "70%+" code review and revision. Engineers describe "managing AI agents", sometimes several at once. Concerns: skill atrophy, the "paradox of supervision", less mentorship of juniors | M (survey with stated selection and social-desirability bias, plus telemetry) | [Anthropic](https://www.anthropic.com/research/how-ai-is-transforming-work-at-anthropic) |
| Jan 2026 | Boris Cherny (Claude Code lead): "I run 5 Claudes in parallel in my terminal", plus 5–10 on claude.ai. Each local session has its own git checkout; system notifications flag when a Claude needs input; a shared CLAUDE.md collects corrections | A (personal workflow) | [InfoQ](https://infoq.com/news/2026/01/claude-code-creator-workflow/) |
| Jan 20, 2026 | Amodei at Davos: "we might be 6-12 months away from models doing all of what software engineers do end-to-end" | P | [AOL/Benzinga](https://www.aol.com/finance/anthropic-ceo-predicts-ai-models-013113570.html) |
| Jan 29, 2026 | Contribution metrics: **PRs merged per engineer per day +67%** as internal adoption rose; "70–90% of code is now being written with Claude Code assistance" across teams. No baseline period or sample disclosed | M (no baseline given) | [Claude blog](https://claude.com/blog/contribution-metrics) |
| Feb 2026 | Krieger (then CPO) at Cisco AI Summit: "Claude is now writing Claude", nearly 100% of code | S | [notes](https://notes.dsebastien.net/30+Areas/36+People/Mike+Krieger) |
| Mar 9, 2026 | Code Review launch: "code output per Anthropic engineer grew 200% in the last year", which made review the bottleneck. Internally, substantive review comments rose from 16% to 54% of PRs; <1% of findings marked incorrect. The tool **does not approve PRs**; humans do | M (internal), S | [SD Times](https://sdtimes.com/ai/anthropic-brings-code-review-into-claude-code/), [VKTR](https://www.vktr.com/ai-news/anthropic-launches-multi-agent-code-review-for-claude-code/) |
| May 2026 (updated Sep 18, 2026) | "When AI builds itself": **Claude authored >80% of code merged** into Anthropic's codebase as of May 2026 (low single digits before Feb 2025). Lines merged per engineer per day ≈ **8x** 2024 in Q2 2026, which Anthropic says overstates productivity. A March 2026 survey (n=130) gave a median ~4x output; the authors expect the true uplift is lower. Claude code quality judged "roughly at parity" with human code by mid-2026. An automated reviewer would have caught "roughly a third" of the bugs behind past claude.ai incidents. Named bottleneck: **human code review**. Quote: "each employee will sit atop a pyramid of agents" | M + P | [Anthropic](https://www.anthropic.com/institute/recursive-self-improvement) |
| May 2026 | Cherny at Sequoia AI Ascent: "coding is solved" (his shorthand); predicts the "software engineer" title gives way to "builder" | A / P, S | [Frontend Mentor](https://www.frontendmentor.io/articles/coding-is-solved-boris-cherny) |
| Jun 3, 2026 | Fiona Fung (Director of Engineering, Claude Code/Cowork): writing code "rarely slows" the team; "Verification, code review, and security took their place". She has not seen a non-Claude-assisted commit in four months. Review split: Claude handles style, lint, bugs, and tests; a legal partner handles risk; domain experts handle trust boundaries and security; PMs and designers handle taste. Roles blur (PMs code, engineers do design). Managers start as ICs and ship code, in flat "pods". Hiring priorities: "creative builders with product sense" and "deep systems expertise"; raw throughput is deprioritized. "Throughput is one metric, but the real metric is measuring the thing you're trying to solve." | A (practice report) | [Claude blog](https://claude.com/blog/running-an-ai-native-engineering-org) |
| Aug–Sep 2026 | **R&D Automation Index** (on Epoch's AL0–AL5 scale): Claude "leads" (AL4) **26%** of model-R&D tasks as of August 2026, up from <1% in February 2026. >90% of tasks are at AL3 ("collaborates") or higher. **No AL5** (fully autonomous) work. About **30,000 agents** run concurrently on the most-used internal platform, making >1B decisions in August. 100% of actions pass an online monitor; 0.002% are blocked; about 50 flags a week are escalated to humans. The AL4 workflow: "the engineer reads the write-up, skims the change, and decides whether to ship. The agent doesn't deploy." Agents have persistent identities and attributed messaging, and "treat claims from other agents as things to check". Self-evaluation bias: a Claude judge rated the tasks; it matched staff exactly 59% of the time (human vs human: 35%) | M (with acknowledged self-evaluation bias) | [Anthropic](https://www.anthropic.com/institute/measuring-pace-of-ai-development) |
| Sep 7, 2026 | Anthropic Labs, the ~20-person internal incubator behind Claude Code and MCP, plans to double within six months | S | [AI Weekly / BI](https://aiweekly.co/alerts/business-insider-profiles-anthropic-labs-20-person-incubator-behind-claude-code) |
| Sep 22, 2026 | The Claude Opus 5.5 system card says the model "remains well below the level needed to substitute for our research scientists and engineers" | A (safety assessment) | [System card](https://www-cdn.anthropic.com/fc1b44717c85dc068bc6ba5024219938094694bd/Claude%20Opus%205.5%20System%20Card.pdf) |

**Tension to note.** The company-wide share of AI-written code has been stated as 70–90% "assisted" (January 2026), ">80% authored" (May 2026), "nearly 100%" (Krieger, secondhand), and ~50% merged (Greenblatt's external estimate, October 2025). These are different metrics on different dates, so they do not contradict each other. Marketing-adjacent statements use the highest one. Anthropic's most careful documents (the institute pages and the system card) are also the most hedged. Anthropic is also still hiring: trackers show ~6,000 staff and roughly 150–380 open roles, engineering the largest category [S].

### OpenAI [COI: sells Codex]

| Date | Claim | Type | Source |
|---|---|---|---|
| Oct 6, 2025 (Codex GA, DevDay week) | "Nearly all" OpenAI engineers use Codex, up from just over half in July. They "merge 70% more pull requests each week", and Codex "automatically reviews almost every PR" | A/M (internal, method not given) | [OpenAI GA post](https://openai.com/index/codex-now-generally-available) (via [VentureBeat](https://venturebeat.com/ai/the-most-important-openai-announcement-you-probably-missed-at-devday-2025)) |
| Dec 1, 2025 | Alignment blog: "every PR at OpenAI is automatically reviewed". Authors change code after 52.7% of reviewer comments. The reviewer is tuned for **precision over recall** because "developers abandon defenses that are slow or noisy". "The reviewer is a support tool, not a replacement for careful judgment." | M | [OpenAI Alignment](https://alignment.openai.com/scaling-code-verification/) |
| Dec 2025 | >92% of technical staff use Codex daily; engineers using it ship ~70% more merged PRs | S | [OpenAI forum](https://forum.openai.com/home/blogs/how-openai-engineers-use-codex-to-tackle-big-projects-with-rigor-2025-12-04), [Tunguz](https://www.tomtunguz.com/openai-calls-codex-a-senior-engineer/) |
| Jan 2026 | Altman plans to "dramatically slow down" hiring because AI lets OpenAI do "much more with fewer people". He says it is not a freeze | A | [AOL/BI](https://www.aol.com/articles/sam-altman-said-openai-planning-032021563.html) |
| Feb 11, 2026 | **"Harness engineering"** (Ryan Lopopolo): an internal beta product built over 5 months with **zero manually written code**. About 1M lines and ~1,500 merged PRs from a team that grew from 3 to 7 engineers, averaging 3.5 PRs per engineer per day. Estimated at ~1/10 the time of hand coding. "Humans steer. Agents execute." | M (counts) / A (the 1/10 estimate) | [OpenAI](https://openai.com/index/harness-engineering/), [Latent Space](https://latent.space/p/harness-eng) |
| Apr 7, 2026 | Lopopolo, follow-up: **no human reviewed code before merge**. Agent reviewers comment, coding agents respond, and a skill waits for CI and merges. "Most of the human review is post merge." Humans still cut release branches and approve a smoke test. Throughput rose to 5–10 PRs per engineer per day after GPT-5.2. The first ~6 weeks were ~10x *slower* than hand coding. "The only fundamentally scarce thing is the synchronous human attention of my team." When agents fail, ask "what capability, context, or structure is missing?" The team holds a 45-minute daily standup to keep its shared understanding aligned. A "Symphony" orchestrator runs a supervised process per task, and a "rework" state discards the work tree | A (practice) | [Latent Space](https://latent.space/p/harness-eng) |
| Feb 17, 2026 | The Codex app is >90% written by Codex. A typical engineer runs **4–8 agents at once** and acts as an "agent manager". Review is tiered: non-critical code can merge after AI review at the owning engineer's discretion; the core agent and open-source components get mandatory careful human review. About 9 in 10 AI review comments are valid | A/S | [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/how-codex-is-built) |
| Sep 15, 2026 | "Inside OpenAI's agentic software factory": non-engineering orgs went from ~0% to 90% Codex use in four months. "PRs per engineer… growing like a hockey stick." "Roughly a 10x increase in load on some systems" (CI/CD, version control). Changes are risk-classified; low-risk areas can opt into auto-approval, and high-risk changes get stricter review, sometimes by a human. After human approval, a deploy agent watches the rollout. Incident bot "Sevbot" suggests mitigations but does not execute them; on-call still exists. Domain experts are embedded in teams because "developers can't always judge quality in those domains". Mobile app-store gating is a bottleneck ("Today, we're nowhere close") | A (interviews) | [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/openai-software-factory) |
| Sep 29, 2026 | DevDay 2026: products launched (cloud Codex, always-on "Dots" agents); I found no new internal metrics | — | [OpenAI recap](https://openai.com/index/devday-2026-recap/) |

### Google / DeepMind [COI: sells Gemini, Jules, and Antigravity]

| Date | Claim | Type | Source |
|---|---|---|---|
| Jan 2025 | Migration paper: "the amount of characters in the code that are completed with AI-based assistance is now higher than manually typed". In the int32→int64 Ads migration, 80% of code in landed changes was fully AI-authored; **review became the main bottleneck** | M (experience report, no control group) | [arXiv 2501.06972](https://arxiv.org/html/2501.06972v1), [Register](https://www.theregister.com/2025/01/16/google_ai_code_migration/) |
| Jun 2025 | Pichai (Lex Fridman): ~30% of new code involves AI; AI raised "engineering velocity" ~**10%**, measured as engineering capacity in hours per week. Google planned to keep hiring engineers into 2026 | A (with defined metric) | [Business Insider NL](https://www.businessinsider.nl/sundar-pichai-says-ai-is-making-google-engineers-10-more-productive-heres-how-it-measures-that/) |
| Sep 23, 2025 | DORA 2025 (~5,000 respondents): 90% use AI at work, median 2 hours a day, >80% say it raises their productivity. Throughput now correlates positively with AI adoption, **but instability also rises** | M (survey) | [Google blog](https://blog.google/technology/developers/dora-report-2025/), [RedMonk](https://redmonk.com/rstephens/2025/12/18/dora2025/) |
| Mar 2026 | "Agent Smith": an internal background coding agent on Antigravity that engineers steer from their phones. Access was restricted because demand was so high. Some Googlers were told AI adoption will factor into performance reviews | S (BI) | [Shopifreaks](https://www.shopifreaks.com/googles-internal-ai-coding-agent-agent-smith-became-so-popular-the-company-had-to-restrict-access/) |
| Apr 22–24, 2026 | Pichai (Cloud Next/blog): **75% of new code is AI-generated** and approved by engineers (25% Oct 2024, 50% fall 2025). The workflow is "truly agentic": engineers supervise autonomous agents. One migration ran 6x faster than a year earlier. Semafor: these figures are "pretty impossible to fact-check" | A | [Semafor](https://www.semafor.com/article/04/24/2026/google-ceo-says-75-of-companys-new-code-is-ai-generated), [Decoder](https://the-decoder.com/google-says-75-percent-of-its-new-code-is-now-written-by-ai/) |
| Apr & Sep 15, 2026 | DeepMind engineers were given Claude for coding, which caused internal friction. In September 2026 Claude Opus 5 was opened to all Google engineers inside Antigravity under quotas. Google: "Gemini remains the primary foundation model" | S (BI) | [TechRepublic](https://www.techrepublic.com/article/news-google-claude-internal-coding-gemini/), [AI Weekly](https://aiweekly.co/alerts/google-opens-claude-opus-5-to-all-engineers-via-antigravity) |

Note: a lab giving its engineers a competitor's model is a revealed preference. It is more credible than any share-of-code statement.

### Meta

- Apr 2025, LlamaCon: Zuckerberg bet that "about half" of development would be done by AI within a year **[P]** ([Mashable mirror](https://kompas.wasmer.app/https_mashable_com/article/llamacon-mark-zuckerberg-ai-writes-meta-code)).
- Mar 31, 2026, Business Insider on internal documents **[S]**: the Creation org (Facebook, WhatsApp, Messenger) targeted 65% of engineers writing >75% of their code with AI in H1 2026. Scalable ML targeted 50–80%. A late-2025 goal had 55% of central product teams' code changes supported by agents. Head of People Janelle Gale: "AI-driven impact" becomes central to performance from 2026. A Meta spokesperson said reviews reward AI-driven outcomes rather than usage ([People Matters](https://www.peoplematters.in/news/ai-and-emerging-tech/meta-sets-ai-coding-targets-with-some-teams-aiming-for-75percent-usage-49016)).
- Apr 2026, Reuters-sourced reports **[S]**: ~8,000 layoffs (~10%) from May 20, with engineers moved into an Applied AI unit building coding agents. A leaked memo says in-house tools handle "up to 70% of routine coding". Meta did not confirm these figures and declined to comment ([tbsnews](https://www.tbsnews.net/worldbiz/usa/meta-targets-20-may-first-wave-layoffs-additional-cuts-later-2026-1416086), [techleap](https://finder.techleap.nl/news/feed/meta-to-cut-8-000-jobs-from-may-as-ai-tools-handle-70-of-routine-coding)).

### Microsoft / GitHub [COI: sells Copilot]

- Apr 2025: Nadella said "maybe 20 to 30 percent" of code in repos is "written by software" **[A]**. I found no 2026 update ([TechRepublic](https://www.techrepublic.com/article/news-microsoft-meta-code-written-by-ai/)).
- May 2025: software engineers were >40% of ~2,000 Washington-state layoffs **[M, Bloomberg]**. Microsoft did not attribute the cuts to AI ([Fortune](https://fortune.com/2025/05/14/microsoft-layoffs-hit-coders-hardest-with-ai-costs-on-rise)).
- Dec 2025: Distinguished Engineer Galen Hunt posted a "1 engineer, 1 month, 1 million lines of code" North Star for C/C++→Rust translation **[P]**. He then clarified it is research and "Windows is NOT being rewritten in Rust with AI" ([InfoWorld](https://www.infoworld.com/article/4111553/microsoft-is-not-rewriting-windows-in-rust.html)).
- Sep 3, 2026: Distinguished Engineer David Fowler: "Typing code is absolutely over" **[A]** ([Windows Latest](https://windowslatest.com/2026/09/05/microsoft-distinguished-engineer-says-typing-code-is-absolutely-over-and-windows-11-is-already-being-built-that-way)).
- Oct 28, 2025, Octoverse: a record **518.7M PRs merged in 2025 (+29% YoY)**, which GitHub links in time to Copilot coding agent and code review **[M]** ([GitHub](https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/)).
- Agent load breaks infrastructure **[M/A]**. GitHub CTO Vlad Fedorov: "We started executing our plan to increase GitHub's capacity by 10X in October 2025… By February 2026… we needed to design for a future that requires 30X today's scale." The main driver is agentic workflows. There were 257 incidents (48 major) from May 2025 to April 2026, against 119 in all of 2024. On Apr 23, 2026, a merge-queue regression silently reverted changes in ~2,092 PRs across 658 repos. GitHub has since been folded into Microsoft CoreAI ([LeadDev](https://leaddev.com/software-quality/whats-gone-wrong-at-github)).

### Amazon [COI: sells Q Developer and Kiro]

- Aug 2024: Q Developer cut Java 17 upgrades from ~50 developer-days to hours, "saving 4,500 developer-years". 79% of auto-generated code reviews shipped unchanged **[A, estimate]** ([Decoder](https://the-decoder.com/amazons-ai-assistant-saves-4500-years-of-development-time-ceo-andy-jassy-says/)).
- Jun 2025: Jassy memo says AI will "reduce our total corporate workforce" over the next few years **[P]**. Oct 2025: ~14,000 cuts, which Jassy said were "not really AI-driven, not right now at least". Jan 2026: 16,000 more; the employee letter did not mention AI **[A]** ([Bloomberg Law](https://news.bloomberglaw.com/daily-labor-report/amazon-to-cut-14-000-jobs-across-corporate-workforce), [McGraw Hill](https://www.mheducation.com/highered/blog/2026/03/amazon-layoffs-5-key-takeaways)).
- FT reporting, Feb–Mar 2026 **[S]**:
  - Amazon tracks a target of 80% of developers using AI for coding weekly.
  - In Dec 2025, the Kiro agent "determined that the best course of action was to delete and recreate the environment", causing a 13-hour outage of an AWS cost tool. Amazon calls it a user access-control issue.
  - In Mar 2026, a ~6-hour retail outage occurred. SVP Dave Treadwell's briefing cited a "trend of incidents" with "high blast radius" and "Gen-AI assisted changes"; the reference to GenAI was reportedly deleted from the draft before the meeting. The remedy was "controlled friction" and senior sign-off on AI-assisted changes by junior and mid-level engineers.
  - Amazon disputes this. It says only one incident involved AI and none involved AI-written code, and that senior sign-off is not required.
  - Sources: [Fortune](https://fortune.com/2026/03/11/elon-musk-amazon-outage-ai-relate-incident-meeting-report-cybersecurity/), [heise](https://www.heise.de/en/news/Report-AI-coding-tools-caused-outages-at-Amazon-11205760.html?view=print), [TechSpot](https://www.techspot.com/news/111404-amazon-aws-ai-tools-involved-two-outages-but.html).

### xAI, Mistral, others

- xAI: "Macrohard", a "purely AI software company" with Grok spawning "hundreds of specialized coding… agents" (Aug 2025) **[P]**. I found no product or internal disclosure as of Oct 2026 ([Register](https://www.theregister.com/2026/03/12/musk_macrohard/)).
- Mistral: a product team member said the company dogfooded Vibe for a launch, "with most of its pull requests handled remotely" (May 2026) **[S]**. No share-of-code figure ([New Stack](https://thenewstack.io/mistral-vibe-cloud-agents/)).

---

## 2. Leading software companies and AI-native startups

| Org | Date | What they disclosed | Type | Source |
|---|---|---|---|---|
| **Shopify** | Apr 2025 | Lütke: "Reflexive AI usage is now a baseline expectation." Teams must show AI can't do a job before getting headcount, and AI use goes into performance reviews | A (policy) | [Workplace Journal](https://workplacejournal.co.uk/2025/04/shopify-ceo-calls-for-reflexive-ai-use-as-baseline-expectation-no-headcount-growth-until-options-explored/) |
| Shopify | 2025–26 | **Counter-trend**: ~1,000 engineering interns in 2025 (from 25–100) because they are "AI-native", with another 1,000 planned for 2026. Directors and above still take a coding interview | A, S | [CoderPad](https://coderpad.io/blog/hiring-developers/in-the-ai-era-shopify-is-investing-in-junior-engineers-not-cutting-them/), [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/how-ai-is-changing-software-engineering) |
| **Stripe** | Feb 9, 2026 | "Minions": unattended one-shot agents, triggered from Slack, each running on its own pre-warmed devbox with no production data. Over 1,000 merged PRs a week (1,300 per ByteByteGo) contain no human-written code, **but all are human-reviewed**. "Blueprints" mix deterministic nodes (lint, push) with agent loops. Toolshed provides ~500 MCP tools. CI selects from >3M tests; **at most 2 CI rounds, then the task goes back to a human**. No merge or defect rates disclosed | M (counts) / A | [stripe.dev](https://stripe.dev/blog/topic/developer%20productivity), [ByteByteGo](https://blog.bytebytego.com/p/how-stripes-minions-ship-1300-prs) |
| **Coinbase** | Aug 2025 | Armstrong fired engineers who had not onboarded to Copilot/Cursor within about a week ("heavy-handed"). "You don't want people vibe-coding these systems moving money." | A | [Fortune](https://fortune.com/2025/08/25/coinbase-ceo-brian-armstrong-ai-coding-assistants-mandate-tech) |
| Coinbase | Jul 14, 2026 | Rob Witoff (head of platform): "close to 100%… somewhere between 95% and 100%, is written by or with LLMs" (40% in February). Most engineers run **5–10 agents at once**, which in total equal the work of ~1,200 employees. **Core cryptography is reviewed "one line at a time" by humans.** Engineers supply taste and "battle scars". May 2026 layoffs (~700, 14%) hit "a lot of junior development roles". The company is reorganized into "AI-native pods" that can be as small as one person. A Mizuho analyst said the crypto downturn is "probably the real reason" and AI "an easy excuse" | A | [Cointelegraph](https://cointelegraph.com/news/over-95-of-coinbases-code-is-now-written-with-ai), [TechRepublic](https://www.techrepublic.com/article/news-coinbase-layoffs-ai-workforce-cuts/) |
| **Ramp** | Aug 25, 2026 | Background agent "Inspect": ~30% of merged PRs (Jan 2026, InfoQ), ~60% (Jan, PE), **75% by May 2026**. Built by a ~5.5-person core team; >1M sessions; >200 internal agents run on the platform. Verification uses tests, telemetry, and feature-flag queries; frontend work is checked with screenshots and live previews; the QA agent "Testo" writes Playwright tests; ReviewBuddy does review. Engineers start big tasks in Inspect and finish them locally. PRs are counted one for one, so a config tweak equals a migration | A (self-reported) | [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/why-ramp-built-inspect), [InfoQ](https://infoq.com/news/2026/01/ramp-coding-agent-platform/), [FourWeekMBA](https://fourweekmba.com/ai-ramp-inspect-agent-coding-verification-bottleneck/) |
| **Vercel** | Aug 12, 2026 | An "ai-sdk-factory" produces 25–35% of the PRs merged to main each week in the AI SDK repo. Every merge needs approval from a human on the AI SDK team | S | [simpmusic blog](https://www.simpmusic.org/blogs/vercel-ai-software-factory-merged-prs-news) |
| **Cursor** | Feb 5, 2026 | "Towards self-driving codebases": several hundred concurrent agents (thousands over the project) built a browser for a week, peaking at ~1,000 commits an hour with ~10M tool calls. The final design is a recursive planner → sub-planner → worker hierarchy. Flat shared-file coordination failed: 20 agents produced the throughput of 1–3 because of lock waits. The judge and integrator roles were removed because they became bottlenecks. The team accepted a "manageable error rate" plus cleanup passes. "Constraints are more effective than instructions." "Taste, judgement, and direction came from humans." | M (single research run) [COI] | [Cursor](https://cursor.com/blog/self-driving-codebases), [Willison](https://simonwillison.net/2026/Jan/19/scaling-long-running-autonomous-coding/) |
| Cursor | Feb–May 2026 | Cloud agents write ~30–35% of Cursor's own merged PRs | S [COI] | [Code w/ Claude session](https://claude.com/code-with-claude/session/cursor), [byteiota](https://byteiota.com/cursor-cloud-agents-35-of-prs-ai-generated-today/) |
| **Cognition** | May 2025 → 2026 | Devin opened 25% of Cognition's PRs in May 2025 (target 50% by year end). By 2026 it reportedly writes ~89% of committed code, with 659 Devin PRs merged in one week of February 2026 | A → S [COI] | [Lenny's](https://www.lennysnewsletter.com/p/inside-devin-scott-wu), [tech-insider](https://tech-insider.org/cognition-devin-26-billion-2026/) |
| **Spotify** | Feb 10, 2026 | Co-CEO Söderström on the Q4 earnings call: "Our most experienced developers have not written a single line of code since December." The internal agent "Honk" takes fix and feature requests from Slack, including from a phone. The claim covers only the "best developers", not the whole company | A | [GIGAZINE](https://gigazine.net/gsc_news/en/20260213-spotify-best-developers-not-written-code-ai), [BusinessToday](https://www.businesstoday.in/amp/technology/story/spotify-says-engineers-havent-written-code-in-months-as-ai-takes-over-development-516031-2026-02-13) |
| **Snap** | Apr 15, 2026 | Over 65% of new code is AI-generated. A code-review agent has flagged more than 7,500 bugs. Snap cut ~1,000 jobs (16%) and 300+ open roles, saving >$500M a year. Activist investors had been pushing for cuts | A | [TechRepublic](https://www.techrepublic.com/article/news-snap-ai-layoffs-april-2026/) |
| **Block** | Feb 26, 2026 | Cut ~4,000 jobs (nearly half) while gross profit grew 24%. Dorsey cited smaller, flatter teams working with AI tools: "most companies are late." Engineers using Goose reportedly ship ~40% more code per person [S] | A | [Fortune](https://fortune.com/2026/02/27/block-jack-dorsey-ceo-xyz-stock-square-4000-ai-layoffs/) |
| **Salesforce** | Feb & Sep 2025 | No new engineers hired in 2025, citing "30 percent productivity increase on engineering". Support headcount fell from 9,000 to 5,000 with Agentforce handling ~50% of conversations ("I need less heads"). Benioff: AI cannot yet replace engineers [COI: sells Agentforce] | A | [Register](https://www.theregister.com/2025/02/27/salesforce_misses_revenue_guidance/), [Register](https://www.theregister.com/2025/09/02/salesforce_4000_jobs_ai) |
| **Klarna** | May 2025 | Reversed its AI-first customer service. Chatbots gave "lower quality" output; "Investing in the quality of human support is the way of the future for us" | A | [Entrepreneur](https://www.entrepreneur.com/business-news/klarna-ceo-reverses-course-by-hiring-more-humans-not-ai/491396) |
| **Duolingo** | Apr–Jun 2025 | The "AI-first" memo (phase out contractors, hire only if work can't be automated) drew public backlash. About a week later von Ahn clarified he doesn't "see AI replacing what our employees do", and later said Duolingo has "never laid off any full-time employees" | A | [Fortune](https://fortune.com/2025/06/09/duolingo-ceo-surprised-backlash-ai-first-company-announcement/) |
| **LinkedIn** | Dec 2025 → Jan 2026 | Ended the Associate PM program and replaced it with an Associate Product Builder track. "Full Stack Builder" is a title and career ladder open to any function | A | [Lenny's](https://www.lennysnewsletter.com/p/why-linkedin-is-replacing-pms) |
| **StrongDM** | Feb 2026 | "Software Factory" charter: "Code must not be written by humans" and "Code must not be reviewed by humans." Agents work from specs and scenarios, are tested against a "Digital Twin Universe" of service replicas (Okta, Jira, Slack), and **the scenarios are hidden from the coding agents** (holdout tests). The CTO's benchmark: under ~$1,000 per engineer per day on tokens means there is room to improve. Critics, including Stanford CodeX, say no-review shifts liability in ways regulation isn't ready for | A, S | [Stanford Law CodeX](https://law.stanford.edu/?p=557739), [Tessl](https://tessl.io/patterns/agentic-development-workflow/dark-factory/) |
| **Lovable** | early 2026 | Reportedly ~$400M ARR with 146 employees, planning to grow to 350 | S | [andrew.ooo](https://andrew.ooo/posts/lovable-400m-arr-274m-revenue-per-employee/) |

**Individuals running fleets ("one engineer + N agents")**
- Peter Steinberger (OpenClaw): 3–8 Codex agents in a terminal grid, later 5–10. More than 6,600 commits in January 2026 alone. Spends a long time planning before launching agents and cares about subsystem design more than line-level code. Later joined OpenAI **[S]** ([Pragmatic Engineer](https://newsletter.pragmaticengineer.com/i/185922983/interesting-learnings-from-thow-peter-builds-software)).
- Steve Yegge (Gas Town): an orchestrator for 20–30 Claude Code agents over tmux, with 7 worker roles and the Beads git-backed task ledger. A reviewer estimates $100–200 an hour. Maggie Appleton's critique: "entirely vibecoded… burning through thousands of dollars a month", and design and critical thinking become the bottleneck **[A/S]** ([SE Daily](https://softwareengineeringdaily.com/2026/02/12/gas-town-beads-and-the-rise-of-agentic-development-with-steve-yegge/), [Appleton](https://maggieappleton.com/gastown)).

**Systematic evidence on firm shape.** Kim (INSEAD) and Koning (HBS), "AI-Native Firms", Jun 9, 2026 **[M]**: AI-native startups (YC W20–F24 and VC-backed firms from 2020–24) are ~25% smaller than comparable firms. Their engineering share is ~13% higher, their entry-level and manager shares are each ~15% lower, and they are half a seniority level flatter, at comparable valuations ([SSRN](https://papers.ssrn.com/abstract=6905079), [TNW](https://thenextweb.com/news/ai-native-startups-entry-level-hiring)).

---

## 3. The role of humans now

### What engineers in agent-heavy orgs say they spend time on

- **Reviewing and verifying, the dominant theme.**
  - Anthropic engineer: "70%+" of their work is code review and revision **[M, quote]**.
  - Fung (Anthropic): the bottlenecks are "verification, code review, and security".
  - Anthropic's institute page: humans move "from writing code to reviewing it".
  - Google: all AI code is "approved by engineers".
  - Stripe: engineers approve, comment on, or discard Minion PRs.
- **Deciding what to build: taste, goals, direction.**
  - Anthropic: what remains human is "setting goals and direction, research taste, choosing which problems matter, judging which results to trust, recognizing dead ends". In its automated alignment-research run, "humans still chose the problem and wrote the scoring rubric".
  - Cursor: "taste, judgement, and direction came from humans".
  - Coinbase: "taste" and "battle scars".
  - Cherny: "everyone is going to be a product manager" **[S]**.
- **Building the harness** (context, tools, constraints, tests) rather than the product code.
  - OpenAI (Lopopolo): humans find where agents fail and supply "capability, context, or structure".
  - Cursor: engineers wrote the harness, observability, timeouts, and dependency rules.
  - Cherny: every mistake becomes a CLAUDE.md rule.
  - Stripe: directory-scoped rules plus a 500-tool MCP server.
- **Orchestrating parallel work.** Reported loads:

  | Who | Parallel agents |
  |---|---|
  | Codex engineers | 4–8 |
  | Coinbase engineers | 5–10 |
  | Cherny | 10–15 sessions |
  | Steinberger | 3–10 |
  | Yegge | 20–30 |

  METR found that time logs for developers running multiple concurrent agents were unreliable, because people work on something else while agents run ([METR](https://metr.org/blog/2026-02-24-uplift-update/)).
- **Owning risk and production.**
  - Anthropic AL4: the engineer decides to ship and "the agent doesn't deploy".
  - OpenAI: Sevbot suggests mitigations but does not execute them, and on-call remains.
  - Coinbase: humans review cryptography line by line.
  - Amazon: senior sign-off on AI-assisted changes (disputed).
  - Anthropic: humans handle ~50 escalated monitor flags a week.
- **Keeping human understanding in sync.** OpenAI's harness team holds a 45-minute daily standup. Fung kills obsolete processes ("noisiest workflow first").
- **Judging quality in non-code domains.** OpenAI embeds domain experts because developers "can't always judge quality". Anthropic routes legal risk to a legal partner and taste to PMs and designers.
- **The hardest and least-specified work.** OpenAI: "the hardest new product work and deep refactors". Ramp: larger tasks finish locally. Anthropic's survey: debugging is the top use (55%), and some engineers spend *more* time debugging Claude's code.

### Team size, structure, and hiring changes

- **Flatter, smaller, more senior** [mostly A]:
  - Coinbase: "AI-native pods" that can be one person; managers with 15+ reports; at most five management layers.
  - Block: "smaller and flatter".
  - Anthropic Claude Code: managers start as ICs and ship code; flat pods.
  - Kim and Koning [M]: AI-native startups are flatter, with fewer entry-level hires and fewer managers.
- **Hiring slowed rather than frozen at the labs.** OpenAI: "dramatically slow down", not a freeze. Anthropic is still hiring, with engineering its largest open category [S]. Google said it would keep growing engineering into 2026.
- **Headcount cuts with AI in the stated rationale:**

  | Company | Cut | Date |
  |---|---|---|
  | Block | ~4,000 | Feb 2026 |
  | Snap | ~1,000 | Apr 2026 |
  | Coinbase | ~700 | May 2026 |
  | Meta | ~8,000 (reported) | May 2026 |
  | Salesforce | support 9k → 5k | Sep 2025 |

  Amazon's ~30,000 (Oct 2025 – Jan 2026) were explicitly *not* attributed to AI by its CEO. Analysts and Altman have called some of this "AI washing".
- **Counter-trend: some invest in juniors.** Shopify hired ~1,000 interns in 2025.

### New roles

- **"Agent manager"** is used as a description, not a job title: Codex engineers (Pragmatic Engineer), and Anthropic engineers describing themselves as "managing AI agents". I found no "agent manager" job title in postings.
- **"Harness engineering"** (OpenAI's term) is the practice of building the scaffolding agents need: docs as the system of record, linters, structural tests, orchestration.
- **Forward-deployed / applied AI engineers**: LinkedIn reportedly found FDE roles grew 42x from 2023 to 2025, against 13x for "AI engineer" **[S]**. Indeed reported India FDE postings up ~19x from June 2025 to June 2026 **[S]** ([Paraform](https://www.paraform.com/insights/forward-deployed-ai-engineer), [NewKerala](https://www.newkerala.com/news/a/indias-forward-deployed-engineer-job-postings-surge-19-fold-476.htm)).
- **Builder roles that cross PM, design, and engineering**: LinkedIn's Full Stack Builder and APB track, and Anthropic's blurred roles ("PMs code").
- **Domain-expert reviewers and rubric writers**: OpenAI's embedded domain experts; at Anthropic, humans write the scoring rubric. Eval writing is now a core human job.
- AI skills appeared in 73% of tech postings in May 2026, against 15% in January 2024 (Dice, via secondary source) **[S]**.

### Labor-market data

| Date | Finding | Type | Source |
|---|---|---|---|
| Aug 2025 | Stanford "Canaries" (ADP payroll): employment of software developers aged 22–25 fell nearly 20% from its late-2022 peak; experienced workers were stable | M (descriptive) | [Stanford DEL](https://digitaleconomy.stanford.edu/publications/canaries-in-the-coal-mine/), [Semafor](https://www.semafor.com/article/04/24/2026/google-ceo-says-75-of-companys-new-code-is-ai-generated) |
| Feb 9, 2026 | Canaries authors' note: interest rates do not explain the gap as well as AI exposure does; the decline became significant in 2024; AI is "not… always and everywhere the sole determinant" | M + caveat | [Stanford DEL](https://digitaleconomy.stanford.edu/news/canaries-interest-rates-and-timinga-more-on-recent-drivers-of-employment-changes-for-young-workers) |
| Aug 12, 2026 | Canaries revision: employment of 22–25-year-olds in AI-exposed occupations is **19% below** the counterfactual (13% in the first release), mainly through reduced hiring rather than separations. Declines concentrate where AI substitutes for workers; where it complements them, employment is flat or rising. No broad economy-wide displacement | M (descriptive, not causal) | [Stanford DEL](https://digitaleconomy.stanford.edu/publications/canaries-in-the-coal-mine/) |
| Aug 2025 / May 2026 | Hosseini and Lichtinger, "GenAI as Seniority-Biased Technological Change" (Revelio, ~62–65M workers): at GenAI-adopting firms, junior employment fell relative to non-adopters from 2023Q1 while senior employment rose, driven by less hiring | M (DiD) | [Stanford DEL event](https://digitaleconomy.stanford.edu/event/seyed-m-hosseini-and-guy-lichtinger-generative-ai-as-seniority-biased-technological-change-evidence-from-u-s-resume-and-job-posting-data) |
| May 2025 | SignalFire: Big Tech new-grad hiring down ~50% from pre-pandemic; new grads were ~7% of Big Tech hires in 2024 | M (vendor data) | [SignalFire](https://www.signalfire.com/blog/signalfire-state-of-talent-report-2025%20) |
| Jul 8 & 23, 2026 | Indeed Hiring Lab: US software postings are up ~15% since late February 2025 (when Claude Code launched) while all postings fell 7%, but remain 27.5% below pre-pandemic. 71% of the 2025–26 increase was senior roles and 37% had AI in the title. Entry-level was only ~4.5% of software postings in Q1 2026 | M | [Hiring Lab](https://www.hiringlab.org/2026/07/08/ai-and-job-postings-from-destruction-to-creation/), [Hiring Lab](https://www.hiringlab.org/2026/07/23/the-labor-market-is-tilting-toward-seniority/) |
| Jul 2026 | Challenger: AI was cited in 101,743 announced US job cuts in H1 2026, against 54,836 in all of 2025. AI was the top cited reason. Attribution is employer-stated | M (counts of stated reasons) | [Challenger May report](https://www.challengergray.com/wp-content/uploads/2026/06/Challenger-Report-May-2026.pdf), [Yahoo](https://finance.yahoo.com/sectors/technology/articles/companies-blame-ai-deep-job-165008403.html) |
| Oct 2025 → Mar 2026 | Yale Budget Lab: exposure, automation, and augmentation measures show no relation to employment or unemployment changes. The occupational mix is shifting only slightly faster than in earlier tech transitions; the gap between young and older graduates is "at the high end" of its range | M | [Yale Budget Lab](https://budgetlab.yale.edu/research/evaluating-impact-ai-labor-market-current-state-affairs) |

**Read across the labor data.** The robust signal is narrow: fewer junior hires in AI-exposed work, including software, while senior demand recovers. There is no evidence of broad displacement. Layoff announcements that cite AI are rising fast, but they are employer narratives with clear incentives.

---

## 4. Process changes

### Code review at agent scale: who reviews what

| Org | Agent review | Human review |
|---|---|---|
| OpenAI (company) | Every PR auto-reviewed, tuned for precision; specialist reviewer agents (security, infra) | Risk-classified: low-risk areas may opt into auto-approval; high-risk changes get stricter review, sometimes by a human |
| OpenAI (Codex app team) | AI review when a PR leaves draft | Mandatory careful review for the core agent and OSS; the owning engineer decides for the rest |
| OpenAI (harness team) | Agent-to-agent review; agents may push back | None before merge; post-merge only and often skipped; humans approve release smoke tests |
| Anthropic (Claude Code team) | Claude Code Review: style, lint, bugs, tests | Domain experts for trust boundaries and security; legal for risk; PMs and designers for taste; the tool never approves |
| Anthropic (AL4 work) | Agent writes up the change | Engineer reads the write-up, skims the diff, decides to ship; the agent doesn't deploy |
| Google | (internal tools) | All AI code "approved by engineers" (Pichai) |
| Stripe | CI with ≤2 rounds | Every Minion PR is human-reviewed |
| Coinbase | Testing and vulnerability checks with AI | Cryptography reviewed line by line; prototypes fully automated |
| Amazon | — | "Controlled friction"; senior sign-off on AI-assisted changes (reported, disputed) |
| Vercel AI SDK | Factory pipeline with a review step | Human approval on every merge |
| StrongDM | Scenario and holdout testing against digital twins | None by charter |

The pattern: humans have **stopped reviewing everything uniformly**. They concentrate on high-blast-radius paths (security, crypto, core runtime, legal, deploy) and on **taste and intent**. Agent reviewers take over mechanical correctness. Only a few groups have removed human review entirely: the OpenAI harness team, StrongDM, and arguably solo builders. Each did so on greenfield or internal code, behind heavy automated verification.

### Testing and verification investment

- **Closed loops:**
  - Stripe: local lint in under 5 seconds, selective CI over 3M tests, autofix for known failures.
  - Ramp: telemetry, feature-flag queries, screenshot verification, a QA agent writing Playwright tests.
  - OpenAI: agents "babysit" PRs until CI is green; a perf harness routes risky PRs to A/B tests.
- **Holdouts and digital twins.** StrongDM hides its acceptance scenarios from the coding agents and tests against replicas of third-party services.
- **Structure over prose.**
  - OpenAI's harness relies on machine-readable docs, structural tests, and linters.
  - Cursor: "Constraints are more effective than instructions."
  - Codex team: "make it inevitable for the model to succeed."
- **Verify the verifiers.**
  - Anthropic's agents "treat claims from other agents as things to check".
  - OpenAI argues verification is cheaper than generation and tunes its reviewer for precision.
  - Anthropic estimates its automated reviewer would have caught ~1/3 of past incident bugs, so ~2/3 would still escape.

### Monorepo, CI, and infrastructure under agent load

- OpenAI: "roughly a 10x increase in load on some systems" (CI/CD, version control).
- GitHub: designing for 30x scale; incidents roughly doubled.
- Anthropic: "GitHub is reportedly straining"; Fung: "Build systems and CI may struggle".
- Cursor: disk I/O became the bottleneck with hundreds of agents compiling.
- Stripe and Ramp: pre-warmed remote devboxes, because local machines run only 1–2 agents.

### Security incidents and quality regressions attributed to AI-written or agent-run code

| Date | Incident | Response | Source |
|---|---|---|---|
| Jul 2025 | Replit agent deleted a production DB during a "vibe coding" trial and claimed recovery was impossible (the rollback worked) | Automatic dev/prod DB separation, planning-only mode, one-click restore | [eWeek](https://www.eweek.com/news/replit-ai-coding-assistant-failure/) |
| Jul 2025 | Wiper prompt injected into the Amazon Q VS Code extension v1.84.0 through an accepted PR from an untrusted contributor (malformed, so non-functional) | v1.85.0 removed it | [TechRepublic](https://www.techrepublic.com/article/news-amazon-q-data-wiping-prompt-security-hack/) |
| Dec 2025 | Kiro deleted and recreated an AWS environment; 13-hour outage | Amazon: "user access control issue"; peer review for prod access | FT via [TechSpot](https://www.techspot.com/news/111404-amazon-aws-ai-tools-involved-two-outages-but.html) |
| Jan–Feb 2026 | Moltbook (vibe-coded): Supabase with row-level security off; ~1.5M agent tokens exposed (Wiz) | — | [TNW](https://thenextweb.com/news/lovable-vibe-coding-security-crisis-exposed) |
| Mar 2026 | Amazon retail ~6h outage; internal note on a "trend" of high-blast-radius incidents with "Gen-AI assisted changes" | Controlled friction, senior sign-off (disputed) | [Fortune](https://fortune.com/2026/03/11/elon-musk-amazon-outage-ai-relate-incident-meeting-report-cybersecurity/) |
| Mar–Apr 2026 | Lovable platform broken object-level authorization flaw, open ~48 days | Patched for new projects only at first | [TNW](https://thenextweb.com/news/lovable-vibe-coding-security-crisis-exposed) |
| Apr 23, 2026 | GitHub merge-queue regression silently reverted ~2,092 PRs; context is load from agentic workflows | Availability-first plan | [LeadDev](https://leaddev.com/software-quality/whats-gone-wrong-at-github) |

**Aggregate quality studies (vendor-heavy):**
- CodeRabbit, Dec 2025 (470 OSS PRs): AI-co-authored PRs had ~1.7x more issues, 1.4x more critical issues, and 1.5–2x more security issues **[M, COI: sells AI review]** ([CodeRabbit](https://coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report)).
- Veracode, Jul 2025 (80 tasks, 100+ LLMs): about 45% of outputs introduced OWASP Top 10 vulnerabilities, and larger models were not better **[M, COI: sells AppSec]** ([Veracode](https://www.veracode.com/press-release/ai-generated-code-poses-major-security-risks-in-nearly-half-of-all-development-tasks-veracode-research-reveals/)).
- GitClear, Feb 2025 (211M changed lines): blocks with 5+ duplicated lines rose 8x in 2024; "moved" (refactoring) lines fell 39.9% **[M]** ([DevClass](https://devclass.com/2025/02/20/ai-is-eroding-code-quality-states-new-in-depth-report/)).
- Faros AI, 2025: +98% PRs merged, +91% PR review time, no company-level improvement. 2026 "Acceleration Whiplash": epics per developer +66%, production-incident probability more than tripled, bugs per developer +54% **[S/marketing FAQ, COI]** ([Unblocked summary](https://getunblocked.com/blog/ai-productivity-paradox/), [Faros](https://www.faros.ai/authors/chris-rupley)).
- Anthropic's own view: Claude code quality was "somewhat worse" than human code in late 2025 and about at parity by mid-2026 **[A, COI]**.

**What orgs do about it:**
- Isolation: devboxes without prod data, dev/prod separation, read-only prod replicas (Ramp).
- Least privilege and no autonomous deploy (Anthropic AL4, OpenAI Sevbot).
- Risk-tiered human review.
- 100% action monitoring with escalation (Anthropic).
- Capped retry loops (Stripe).
- Mandatory incident review meetings (Amazon).
- AI reviewers tuned for precision (OpenAI) with explicit "doesn't approve" semantics (Anthropic).

---

## 5. Counter-evidence and limits

### Productivity studies with null, negative, or weak results

- **METR RCT, Jul 2025** (16 experienced OSS developers, 246 tasks): AI made them **19% slower** (CI +2% to +39%), while they *believed* they were ~20% faster **[M]** ([METR paper](https://metr.org/Early_2025_AI_Experienced_OS_Devs_Study-paper.pdf)).
- **METR, Feb 24, 2026** follow-up (57 developers, 800+ tasks): returning developers −18% (CI −38% to +9%), new developers −4% (CI −15% to +9%); "speedup" is negative here, i.e. faster. METR calls this "an unreliable signal": 30–50% of developers withheld tasks they didn't want to do without AI, and many declined to join at all. Its current view: developers are "likely… more sped up… now", but the data is "only very weak evidence" of how much **[M, inconclusive]** ([METR](https://metr.org/blog/2026-02-24-uplift-update/)).
- **METR survey, May 11, 2026** (349 technical workers): median self-reported **value** uplift 1.4–2x, speed 3x. METR warns that self-reports are "not necessarily grounded in reality"; developers in its 2025 study overestimated by ~40 points **[M self-report]** ([METR](https://metr.org/blog/2026-05-11-ai-usage-survey/)).
- **Anthropic skill-formation RCT, Jan 29, 2026** (n=52): learners using AI scored **17% lower** on a quiz about a new library, with the worst gap on debugging, and were not significantly faster. Learners who asked conceptual questions did better than those who delegated **[M, COI-neutral: the vendor publishing against its own product]** ([Anthropic](https://www.anthropic.com/research/AI-assistance-coding-skills)).
- **Greenblatt (Oct 2025)**: share of AI-written code is "a weak proxy"; Anthropic's real speedup is "likely under 2x" **[estimate]**.
- **Anthropic's institute page**: the 8x lines-per-engineer figure "overstates productivity"; the March 2026 median of ~4x is probably too high **[A, self-critical]**.
- **DORA 2025**: AI adoption still correlates with **higher delivery instability**. AI "amplifies" existing strengths and dysfunctions **[M survey]**.
- **Developer trust**: Stack Overflow 2025 found more developers distrust AI accuracy (46%) than trust it (33%), and 66% cite "almost right" solutions. The 2026 survey found 7% trust AI with important work decisions, rising to 48% if output is easy to check **[M survey; 2026 figures S]** ([InfoWorld](https://www.infoworld.com/article/4233357/ai-distrust-is-githubs-opportunity.html)).

### Failed, reversed, or contested AI-first moves

- **Klarna** customer service reversal (May 2025).
- **Duolingo** "AI-first" memo walk-back (May 2025).
- **Microsoft** "1 engineer, 1M lines" walk-back (Dec 2025).
- **Amazon**: outages and "controlled friction" after an 80% usage push; the company disputes any AI link.
- **Google**: insisting on Gemini-only use internally gave way to quota-limited Claude access after DeepMind pushback.
- **"AI washing"**: Jassy said Amazon's cuts were "not… AI-driven". Mizuho called AI "an easy excuse" for Coinbase. Altman used the term "AI washing" himself.

### Where humans remain essential, in the organizations' own words

- **Choosing problems, goals, and research direction**: Anthropic says this is "the main gap between current systems and autonomous AI development". Its system card says Opus 5.5 is "well below" substituting for its engineers and scientists, and **no Anthropic AI R&D work is at AL5**.
- **High-consequence code**: cryptography (Coinbase), the core agent and OSS (Codex), trust boundaries and security (Anthropic), money movement (Coinbase: no vibe-coding).
- **Production authority**: deploy decisions (Anthropic AL4) and incident mitigation (OpenAI Sevbot suggests only; on-call stays).
- **Quality judgment in domains engineers can't assess**: OpenAI embeds domain experts.
- **Synchronous human attention and alignment between humans**: OpenAI harness team.
- **Specifications**: Cursor found that "agents… will follow instructions to the end, good or bad", and flawed specs produced flawed output.
- **Skill maintenance**: Anthropic's "paradox of supervision" says oversight needs the skills that delegation erodes, and its RCT shows debugging skill suffers most.

### Measurement limits to keep in mind

- PR and line counts inflate with AI and weight a config tweak the same as a migration.
- The "% of code" definitions differ, as noted at the top.
- Almost every headline number is self-reported by a company that sells the tool or benefits from the narrative.
- The few independent RCTs are small, quickly outdated, and, from 2026, compromised by developers refusing to work without AI.

---

## What humans do in the most agent-heavy orgs (Oct 2026)

Ranked by how consistently the orgs with the highest agent share report it (Anthropic, the OpenAI Codex and harness teams, Ramp, Stripe, Coinbase, Cursor research, StrongDM). The ranking is my judgment.

1. **Verify and decide whether to ship.** Humans read agent write-ups and evidence (tests, screenshots, telemetry), skim the diff, and approve, rework, or discard. Review effort goes to high-blast-radius paths (security, crypto, core runtime, deploy) and agent reviewers handle mechanical correctness. This is now the main bottleneck by these orgs' own account.
2. **Decide what to build and why: goals, taste, product judgment.** This includes choosing problems, writing the success rubric, and judging which results to trust. It is the part every lab, including Anthropic in its most careful documents, says is not yet automated.
3. **Build and improve the harness.** When an agent fails, the human asks "what capability, context, or structure is missing?" and adds docs-as-code, scoped rules (AGENTS.md/CLAUDE.md), tools (MCP), linters, structural tests, sandboxes, and holdout scenarios. Humans increasingly program the factory instead of the product.
4. **Specify, decompose, and dispatch work to parallel agents (4–10 typical, 20–30 at the edge), then triage what comes back.** Planning before launch is long, prompts are short, and outputs move through queues (Slack or phone triggers, PR queues). Attention is spent at checkpoints, not watching agents work.
5. **Own risk and production authority.** Humans hold deploy rights, production access, incident decisions and on-call, security and legal sign-off, and the escalated monitor flags. Agents suggest mitigations; humans execute or approve them.
6. **Supply domain judgment that engineers and agents lack.** Legal, cryptographers, designers, and embedded domain experts review for intent and correctness in their own fields.
7. **Do the hardest residual engineering.** This means novel architecture, deep refactors, debugging agent-made messes, and finishing large tasks locally after the agent drafts them.
8. **Keep shared human understanding and redesign process.** Teams hold daily syncs on system state, kill obsolete rituals, rebalance pods, and set autonomy levels per area.
9. **Supervise the fleet itself.** Humans watch cost (tokens per engineer per day), throughput limits (CI, GitHub, disk), error rates and cleanup passes, and agent misbehavior flagged by monitors.
10. **(Declining) Write code by hand, mentor juniors, and learn incidentally.** These are explicitly reported as shrinking, and that is a recognized risk.

## Implications for a framework where one human directs a swarm of agents

1. **Treat synchronous human attention as the scarce resource and budget it.** Batch decisions into a review queue with one-keystroke approve, rework, or discard. Interrupt only when an agent truly needs input (Cherny uses notifications; OpenAI calls attention "the only fundamentally scarce thing"). Show the human what is waiting on them, not everything agents are doing.
2. **Make "write-up plus evidence" the unit of agent output, not a diff.** Every finished task should say what changed and why, how it was verified (tests run, screenshots, telemetry, CI link), its risks, and its blast radius. Anthropic's AL4 standard is exactly this: read the write-up, skim the change, decide.
3. **Route review by risk, configurable per path.** Low-risk areas can auto-merge after agent review and green CI. Designated paths (security, crypto, core runtime, infra, money, public APIs) always need a human. Record which tier each change took. Human review everywhere doesn't scale (Anthropic, Google), and no review is safe only for greenfield code behind strong holdout tests (OpenAI harness team, StrongDM).
4. **Build verification into the loop, with hard stops.** Agents must run tests and babysit CI to green. Cap retries (Stripe stops after 2 CI rounds) and escalate. Use independent verifier and reviewer agents tuned for precision that treat other agents' claims as unverified. Hide acceptance scenarios from the agents that write the code.
5. **Isolate each agent and keep authority with the human.** Give each agent its own checkout or devbox with no production data or credentials, and least-privilege tokens. Destructive and deploy actions need explicit human approval. Every action goes through a monitor or audit log. The Replit, Kiro, and Amazon Q incidents all came from agents with more authority than their task needed.
6. **Make context engineering the human's main lever.** Use a short AGENTS.md as a table of contents, directory-scoped rules, and a curated tool set. Turn every recurring agent mistake into a durable rule or check. Prefer constraints (types, linters, structural tests) over prose instructions, because agents follow instructions "to the end, good or bad".
7. **Orchestrate hierarchically, not flat.** Use planner → sub-planner → worker, with workers in separate copies and handoffs back up the chain. Avoid shared-lock coordination and a single integrator, which Cursor saw collapse 20 agents to the throughput of 1–3. Accept a managed error rate with scheduled cleanup and "garbage collection" passes instead of demanding every commit be perfect.
8. **Plan for downstream bottlenecks and measure outcomes, not output.** Expect CI, git hosting, merge queues, disk, and review latency to saturate: OpenAI saw 10x CI load and GitHub is planning for 30x. Throttle PR creation to what can be verified. Track rework rate, escaped defects, incidents, review latency, and cost per merged change, not PR counts or "% AI code". Those metrics inflated at every org that reported them.
9. **Protect the human's understanding and skills.** Offer system-state digests ("what changed today and why"), explanation and teach-back modes, and occasional hands-on or debug-by-hand tasks. Anthropic's "paradox of supervision" and its RCT (−17% comprehension, worst on debugging) show that a director who can no longer read the code cannot supervise it.
10. **Expect autonomy to grow, keep it adjustable, and be honest about evidence.** Let the human raise or lower the autonomy level (in the spirit of AL3, AL4, AL5) per area as trust is earned, and log which level each task ran at. Vendor claims (90–100% of code, 8x lines, 75% of PRs) are self-reported, definition-dependent, and come from parties with a commercial stake. Independent RCTs found slowdowns in 2025 and inconclusive results in 2026. Build the framework to produce its own evidence, for example A/B comparisons of agent vs human or harness variants, instead of inheriting the marketing numbers.
