# First principles: what is left for people when agents build software

2026-10-17. The reasoning. The evidence it rests on is in [01](01-pilot-evidence.md) (the pilot) and [02](02-how-others-build.md) (everyone else).

## 1. Software development is a loop

```
  want ──▶ plan ──▶ build ──▶ verify ──▶ integrate ──▶ ship ──▶ observe ─┐
   ▲                                                                    │
   └──────────────────────────── learn ◀────────────────────────────────┘
```

| Stage | Produces | October 2026 |
|---|---|---|
| **want** | a goal worth reaching, and what to trade for it | people; agents propose |
| **plan** | tasks with a bar for done | agents. The pilot's lead plans for ~14 builders. |
| **build** | changes | agents |
| **verify** | evidence a change meets its bar | agents and machines up to the limit of the oracle; past it, devices, real conditions, people |
| **integrate** | one working whole | agents, through one merge stream |
| **ship** | the change in users' hands | agents can; a person answers for it |
| **observe** | what happened when people used it | people using it; agents read the signals |
| **learn** | the next want | people |

Agents now run the middle. Two things decide what the loop is worth: **the ends** (want and observe, with accountability across both) and **the stages that are still physical or scarce** (verify, integrate, ship).

## 2. Why the ends stay human

**Want.** An agent pursues a goal; it has no stake in which goal. "Ship by Black Friday with less, or January with everything" is a trade between values. In the pilot, every big redirection came from a person: "make it the most fun creature to interact with", "wide first, deep later", "ship by Black Friday". Without them the agents optimized what they could measure. Their own record from the first day is about turn-taking milliseconds.

**Observe.** The only real test is people using it; everything an agent can check is a proxy.
- In the pilot, two hours of the owner at the device found about seven faults that hundreds of played-audio tests had missed.
- A one-hour visit by the hardware team found accented English transcribed in the wrong script, and a stop button the agents' notes said didn't exist.
- Elsewhere, maintainers would reject about half of agent patches that pass the benchmark's tests (METR, 2026).

**Accountability** sits across both ends. Keys, money, publishing, physical safety: in the pilot each of these waited for the owner ("publishing can't be undone, and we lose nothing by waiting").

## 3. Throughput is the minimum over stages

A swarm is a pipeline. Its output is set by its narrowest stage, and work queues in front of that stage (Little's law). In the pilot, measured over three days:
- **Build** scaled ~15×, from ~11 to ~177 PRs a day. That came from working every hour of the week (~3.7× alone), ~14 parallel builders, and no person in the dispatch loop.
- **Verify and integrate** scaled less. Median PR wait went from 7 minutes to 1.5 hours, with ~24 PRs waiting at any time (up to 67). CI ran ~630 target-architecture builds a day, and a quarter were cancelled by newer pushes.
- **Want and observe** stayed at one person's pace. The lead sat blocked 3.4 hours overnight waiting for the owner, and weekend work waited for Sunday.

Every scaled report outside agrees: Superset says "most of our agents spend more time waiting for us to review their work than they spend doing it". OpenAI's zero-hand-written-code team calls human attention "the scarce resource". So **the bottleneck migrates**, roughly in this order:
1. **Verification:** CI, devices, reviewers, real-world checks.
2. **Integration:** one merge stream. 20–42% of concurrent agent PR pairs conflict in public data.
3. **Compute per worker:** CPU, disk, build caches, VMs.
4. **Model capacity:** subscriptions, rate limits, money. The pilot's owner account hit its limits and stopped the lead, the reviewer and a builder at the same time.
5. **Coordination:** the lead's attention, and the channel. The pilot's queue took 1.03 M characters in four days, and builders missed tasks in it.
6. **The owner's attention.** This is the final bottleneck: every other one can be bought or engineered away.

## 4. Spending the owner's attention well
- **Pre-decided decisions.** The lead brings options, a recommendation and evidence, and the owner answers in a word.
- **Batching.** Decisions wait in a queue the owner clears on their own schedule.
- **A standing brief.** Direction written once ("wide first, deep later" settled hundreds of choices).
- **Taste as data.** Each judgment becomes a rule or an example, so the next one is pre-decided.
- **Decision latency** is measured, because the swarm waits on it.
- **Live terminals are for drill-down.** The owner's main surface is decisions and evidence. (Our owner watches terminals and keeps them; the design makes room for both.)

**The attention budget sets how many workers one owner can run.** An illustration, not a measurement:
- Suppose the owner spends **A** minutes a day on decisions; each worker finishes **k** tasks a day; a share **e** of tasks needs a decision; and each decision takes **t** minutes.
- Then the owner can keep up with at most **N ≈ A ÷ (k × e × t)** workers.

| Decisions arrive as | t | e | Workers one owner sustains (A = 120 min, k = 3) |
|---|---|---|---|
| Questions in a thread | ~10 min | 30% | ~13 |
| Packets with a recommendation | ~3 min | 30% | ~44 |
| Packets, plus a standing brief that pre-decides | ~3 min | 10% | ~130 |

The pilot sat near the first row: ~13 builders, with about 91 messages in 34 threads waiting on the owner over three days. That's 34 of ~120 tasks, so e ≈ 0.3. The owner's minutes per decision aren't in the record, because the owner answered in a private chat with the lead. **Packet quality (t) and the brief (e) move the limit by an order of magnitude;** more machines don't move it at all. That's why the YOU box and the brief are the product's core, not features.

## 5. What other people add, beyond capacity
The owner can buy machines, subscriptions and agents alone. In the pilot, value that needed another person was:

| Value | Pilot evidence | Weight |
|---|---|---|
| **Knowledge outside the model and the repo** | The hardware team: the microphone gets no speaker reference and its clock drifts. That was the root cause of echo and stop-word failures the agents had chased in software for days. Also: servos should let go under overload, the touch strip is unreliable, there's no clock battery. | decisive |
| **Contact with reality** | Real voices, accents, faces, rooms, noise. Each surfaced faults that synthetic tests couldn't. | decisive |
| **Process design from experience** | A member who had run agents on the previous product proposed the two rules that let the swarm grow from 4 to 15: tasks as issues, and only the lead opens them. | decisive |
| **Business facts** | "The voice key belongs to the user": it reversed a lead decision that would have shipped devices with Wi-Fi but no voice. "Old devices are set up with the mobile app": the agents' setup study had missed this for three days. | high |
| **Physical work and safety** | Weighing (3.0 kg, against the agents' model of 1.5), power cuts with a hand on the device, "motors still" after an unattended drift | high |
| **Taste** | A member's verdicts on motion clips; "alive, not a machine" | high |
| **Access** | ssh, sudo, sign-ins, quotas, private repos. Mostly gatekeeping. | medium |
| **Capacity** | Members' accounts and machines produced about half the merged PRs and kept going while the owner's account was rate-limited | medium; the owner could buy it, but not the presence |

So a second person is worth having for **knowledge, reality, judgment and experience**, not for typing or capacity. The biggest one, **judgment bandwidth**, isn't fully in the pilot yet: members acted mostly as hands and relays, and the report asks whether their domain skills were used at all. A person who owns a domain (direction and taste for "motion" or "voice") multiplies the scarcest resource.

## 6. The autonomy dial

| Level | The person… | Fits |
|---|---|---|
| 1 | approves each task before it starts | new teams, high stakes |
| 2 | approves merges or releases | most teams today |
| 3 | decides what the lead escalates | the pilot now |
| 4 | sets goals, judges results on a cadence | strong verification; OpenAI's harness team is near here, with most human review after merge |

**Verification quality is what buys autonomy.** Public evidence agrees: the strongest "agents did it all" results are greenfield or have a near-perfect oracle (a C compiler against GCC's tests). Gaming the verifier rises with capability.

## 6½. Autonomy is bounded by the cost of the oracle
An oracle is whatever says a change is right. How cheap it is decides how much of the work can run without people. Sort a project's work by oracle before choosing its autonomy:

| Class | The oracle | Examples | Autonomy |
|---|---|---|---|
| **A. A machine oracle exists** | A reference implementation, a compiler, a spec, an existing test suite, a baseline to compare against | Ports, migrations, performance work, reproducing a reported bug, a C compiler against GCC's tests | Level 4: people sample the results |
| **B. An oracle can be built** | Hidden scenarios, golden recordings, cloned third-party services, simulators, property tests | StrongDM's holdout scenarios; OpenAI's "harness engineering"; the pilot's played-audio tests | Level 3–4, after the oracle is built. **Building it is the owner's first job.** |
| **C. The oracle is reality or a person** | Real users, real rooms, hardware physics, taste, the market | How a voice feels in a noisy room; whether motion looks alive; whether people want it | Bounded by how often reality can be sampled: batch it, route it, schedule it into the hours people are there |

- **A swarm's long-run productivity is how fast it turns class C into class B.** Each person's judgment, captured as a test, a recording or a rule, is a judgment nobody has to make again. This is "taste as data" (§4), and it's the most valuable thing a person does in a swarm.
- **The pilot was heavy in class C:** voice, motion and setup on real devices. That's why 37 of 89 switches sat merged but off: the oracle that could turn them on was a device and a person. A web back end with good tests is mostly A and B, so it would run at higher autonomy with fewer people.
- **For the next million projects,** this is the first question to ask, before choosing how many workers to run: what fraction of the work has a cheap oracle?

## 7. What the evidence doesn't yet show
- **No peer-reviewed study of large swarms on real codebases.** Controlled work stops at two agents or one manager with a few workers. Everything bigger is vendor or practitioner reporting, the pilot included.
- **Org-wide data shows more output with worse quality:** +54% bugs per developer and about 3× incidents per PR at high-adoption teams (Faros 2026); higher instability (DORA 2025).
- **Single agents match multi-agent systems at equal token budgets** on reasoning tasks (Stanford 2026). Much multi-agent gain is extra compute; coding parallelizes less than research.
- **No verified one-person billion-dollar company** as of October 2026.

So the thesis is plausible and early. It has to be measured per swarm, not assumed ([08](08-experiments.md)).

## 8. Predictions (to test)
1. Working around the clock is permanent and worth ~3–4× a human team's hours before any parallelism.
2. In a well-run swarm, verification and integration take most of the wall-clock time and a growing share of compute.
3. A lead saturates around 10–20 workers; then swarms split by domain, with a lead per domain.
4. The scarce skills become **wanting well, judging well and designing verification**: product sense, taste, oracles.
5. Teams will compete on verification infrastructure (devices, environments, real-user loops) more than on build capacity.
6. Projects will be planned by oracle class: the share of work with a cheap oracle will predict a swarm's autonomy and its people per product better than its size will.
