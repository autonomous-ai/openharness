# Economics: what a swarm costs, and what it depends on

2026-10-17. A rough model with every assumption stated, not a measurement: the pilot doesn't record its spend. It answers one question: is "one person and a swarm" cheaper per unit of working software than a team, and what could change that?

## 1. The pilot's run rate (estimated)

| Item | Basis | Per day |
|---|---|---|
| **Model subscriptions** | ~16 agents (lead, ~13 builders, reviewer, tests) across 5 accounts. Assume ~8 flat-rate plans at $200/month, plus extras bought when limits bite. | ~$55–100 |
| **CI** | ~630 target-architecture runs a day × ~15 min ≈ 150 runner-hours including cancelled runs. At hosted ARM rates (~$0.005–0.03 per minute, depending on size). | ~$45–270 |
| **Machines** | ~6 computers plus 5 devices, owned already. Amortized. | ~$30–60 |
| **People** | The owner (full-time), four member people (part-time, mostly hands and access), hardware and DevOps visits | the dominant cost |
| **Output** | ~165 merged PRs a day, ~40 tasks | |

**Compute plus CI ≈ $130–430 a day**, about **$1–2.50 per merged PR** at flat subscription rates.

## 2. The same work at API prices
Flat-rate plans hide the real cost. Public reports put large swarms at **~20M tokens per merged PR** (a 100-agent factory), and multi-agent work at 4–15× chat. At ~20M tokens per PR and $3–15 per million tokens, ~165 merged PRs a day would cost **~$10k–50k a day** at list API prices. Even at a tenth of that, $1–5k a day, it's still an order of magnitude above the subscription run rate.

So **today's swarm economics rest on subsidized flat-rate plans.** Providers have already moved:
- Anthropic added weekly caps in August 2025 because of 24/7 background agents.
- OpenAI paused new Pro sign-ups for capacity in September 2026.
- The pilot's owner account hit its limits at the busiest hours.

## 2½. Price points in the market (October 2026)
From [sources/market.md](sources/market.md):

| What | Price | Note |
|---|---|---|
| Claude individual plans | Pro $17–20, Max from $100 a month | Weekly limits; ten agents use quota ~10× as fast |
| Claude Team Premium | $100–125 a seat a month | Enterprise: $20 a seat plus usage at API rates |
| Codex | Plus $20, Pro $100–500 a month; OpenAI's guidance $100–200 per developer a month | Token billing since April 2026 |
| GitHub Copilot | Usage-based since June 2026, with pooled budgets | Flat pricing was "no longer sustainable" once agent sessions arrived |
| A 12–30-agent orchestrator at API prices | ~$100 an hour reported | ~$2,400 a day if run around the clock |
| Agent spend per developer | ~$1–5K a year | |

The last two rows bracket the pilot. Run around the clock on API prices, a swarm its size costs about what the "tenth of list" row in §2 estimates. Run on flat plans, it costs a few hundred dollars a day. **The industry is moving from flat to metered pricing** (GitHub, OpenAI, Microsoft's "per seat plus consumption"). So the flat-rate advantage in §3 should be treated as temporary, and waste reduction as permanent.

## 3. Compared with a team
A team of ten engineers, each driving a few agents, costs ~$4–6k a day in salaries (~$12–18k a month each, fully loaded), plus the same kinds of compute. Harness's own repo runs about this shape and merges ~27–55 PRs a weekday. Under the stated assumptions:

| Shape | People cost / day | Compute / day | PRs / day | Cost / PR |
|---|---|---|---|---|
| Team of ~10, agents each | ~$5k | ~$0.5–1k | ~50 | ~$110–120 |
| Owner + swarm, flat plans | ~$1–1.5k | ~$0.15–0.45k | ~165 | ~$7–12 |
| Owner + swarm, API prices | ~$1–1.5k | ~$10–50k | ~165 | ~$65–310 |

A PR isn't a unit of value, so the real comparison is cost per change shown working. But even on this crude measure:
- **At flat rates, the swarm is ~10× cheaper per change than a team.**
- **At full API prices, it's comparable to a team, or worse.**

The business case therefore depends on three things:
1. **Model prices keep falling.** They have, by roughly an order of magnitude a year for a given capability, though frontier models stay expensive.
2. **Waste goes down.** Cancelled CI runs, duplicate work, rework, idle-but-awake agents, re-reading huge threads. In the pilot, 26% of CI was cancelled and 18% of PRs were follow-ups, and every coordination round re-read a 1 M-character thread.
3. **The verification ladder is cheap per rung.** Devices and people at the top are the expensive part, so the lower rungs must catch most problems.

## 4. What this means for Harness
- **Cost per surviving change is a headline metric.** Show it per swarm, per worker, per task.
- **Multiple accounts and providers are a feature,** not a workaround: keeping a swarm alive through any one limit is worth paying for.
- **Waste reduction is product value we can measure:**
  - routing replaces thread-reading;
  - leases replace idle polling;
  - CI runs only on ready PRs;
  - duplicate checks;
  - throttling creation to what the gates can verify.
- **Model routing:** strong models for the lead and the reviewer, cheaper ones for workers where the bar is machine-checkable.
- **Price Harness against the money it saves,** in compute waste and in people's time, not per seat.
