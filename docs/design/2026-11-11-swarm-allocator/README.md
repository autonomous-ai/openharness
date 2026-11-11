# Swarm: the allocator, redesigned

Status: **proposed, for anh Dee's decision. Nothing here is built.** Once agreed it replaces the method of
[who builds what, and when](../2026-11-09-swarm-v4-assignment.md), and that document changes with the first step built.

anh Dee, 2026-11-11: "this is the heart of this product … a really good solver that helps people save 80% token cost
and ship 10x faster because of efficient resource allocation (not just token but CI, end to end testing, CPU heavy
tasks)." "Should we use code/algo to build solver? Should we use llm? Or … jev? Or a combination?"

## The answer in short

1. **Not a bigger solver: a controller of flow.** A change goes cut → build → check → read → land. What lands in a day
   is set by the slowest stage. What a landed change costs is set by everything done twice. The allocator keeps the
   slowest stage fed, and keeps the others from making work that cannot land.
2. **Four decisions, all code**: what may start (flow), who does it and with which model (match), what each scarce
   thing is worth right now (prices), and what we believe about a task (estimates, learned from finished work).
3. **Decide late, on the agent's own computer.** The coordinator offers. The agent's daemon checks its own machine
   and subscription, accepts, and claims the task in its person's name.
4. **The PM cuts and values work. Jev turns words into the project's vocabulary. Neither assigns.** No LLM sits in
   the loop.
5. **Today's search goes.** In a first experiment a twenty-line rule finished the same work 10 to 30% sooner than
   it, with the same or less work done ([below](#the-first-experiment)).

## What is wrong today

- It plans a month ahead for work it plans again every minute. Only the next two tasks of each agent are ever used.
- Its inputs are guesses. What a size costs in minutes, cores and tokens is a fixed table; every model counts the
  same; a task in hand is "half its size" however long it has run.
- Cost and quality are not in what it minimises, and "finished" ends at the builder, not at landing.
- Nothing measures a plan against what happened.
- It runs on one person's computer and writes other people's labels.

## What the evidence says

Numbers in brackets are the [sources](#sources).

1. **Plans decay; rules hold.** An agent's run of the same task spreads about twofold, thirtyfold at worst [5]. Under
   such spread, fixed optimal sequences "quickly deteriorate" and rules that decide at the moment do as well or
   better [1]. Giving each task where it costs least, then ordering by weight over expected time, has a proven bound
   on unlike machines [2]. Solving again every minute gains no more than a few well-timed solves [3]. A learned
   (RL) scheduler's gain did not reproduce [4].
2. **Nobody can price a task from its words.** Agents' own forecasts of their token use correlate at most 0.39 with
   what they use [5]. A task's text predicts its difficulty weakly (0.63); a few cheap turns of work predict it much
   better (0.78) [6].
3. **Writers collide.** Two changes in flight conflict 5% of the time, sixteen 40% [7]. Pull requests by different
   agents conflict 41.7% of the time, by the same agent 19.8% [8]. Two agents on one feature succeed half as often as
   one [9]. On lampOS the 7% of changes told they conflict took 10 hours instead of 64 minutes, and 21% of READ-OKs
   only restate a read on a new head [24].
4. **Size decides.** lampOS: a HOLD on 3% of changes of 50 lines or fewer, on 53% over 1,500; 52 minutes against 4.8
   hours. The 23% that got a HOLD hold 58% of all hours [24].
5. **The land path is the ceiling.** One serial check of 15 minutes lands 96 changes a day whatever the agents. A
   single queue lost 95% of throughput at Uber; batching by predicted pass and independence recovered it [7]. GitHub
   lands groups of 30 and more [10]. Stripe allows a change two rounds of CI [11].
6. **Planning is cheap; doing is the bill.** The planner was 4% of tokens at Factory [12] and $0.46 of $124.70 at
   Anthropic [13]. List prices are 4× apart between the top two tiers and 80× to the smallest [15]. The cheapest of
   three models lands about three quarters of what the best does on SWE-bench Verified, at a third of the cost [14].
7. **The cache is most of the input.** A cached read costs 0.025 to 0.1 of input, a write 1.25 to 2. In one trace
   95.7% of input was cached reads, and 81% of the rest was context seen before. A change of model or effort in a
   session reads the whole conversation again uncached; sessions in different folders share no cache [16].
8. **Nobody schedules other people's machines and subscriptions.** Every large run found used its operator's own
   machines with metered billing [22]. Systems for donated machines put the owner's rules first, let the machine pull, and
   keep the match apart from the claim [17]. No source covers five-hour and weekly windows. This ground is open.

## The design

```text
 The PM (top model)                                   GitHub: the truth
 cuts work small, by area, with a check;              tasks, who took what, pull requests, verdicts,
 sets its value; is told what is starved or stuck     what landed, and what each landed change cost
        |                                                        ^
        v                                                        | claims, in its person's name
 +--------------------------------------+   offers    +-----------------------------------+
 | Coordinator: one daemon for a crew   | ----------> | Each person's daemon              |
 |  flow       what may start           |             |  measures its agents' work        |
 |  match      the best item for a free | <---------- |  prices its subscription and      |
 |             agent, and its model     | free, busy, |  its machine                      |
 |  estimates  from finished work       | prices      |  accepts or declines; claims      |
 +--------------------------------------+             +-----------------------------------+
```

### 1. Flow: what may start

- **Least work left to land goes first.** A free agent's best item is the one with the most value for the minutes
  it still needs: a hold on its own change, a read, then a new build. This is the match's own order (below), not a
  rule of its own. It finishes before it starts.
- **A lane starts no more than it can land.** A lane is an area with its own train, or the whole repository while
  it has one. No new build starts in a lane while its changes in flight (taken, not landed) are more than it lands
  in its usual hours from taken to landed (two, to begin). An agent the cap frees reads, fixes, builds in its second
  area, or rests. Resting costs nothing. A change that waits to land goes stale, and is read and checked again.
- **Writers in an area are paced like a network link.** At most W changes are in build at once in an area, by
  different agents. W starts at 2, goes up by one after ten landings with no conflict, and halves when a change there
  is told it conflicts. A task that follows another in the same area goes to the agent that built the first.
- **A train is sized by its riders' risk.** A change whose chance of breaking the run is q rides with at most
  1/q − 1 others: only then does adding it raise the landings expected of the run. q comes from its class's record.
  On lampOS 34 of 803 trains broke by their own run at 2 to 3 riders, about 2% a change, so a train of 20 was safe.
  Ours already carries up to 20.

### 2. Match: who does it, and with which model

When an agent is free the coordinator looks at every item it may do. First the filters, which are never traded:

- the tools and the system the task needs are on its machine, and the machine has the cores, memory and disk free now;
- its subscription's windows have room for the task's 90th percentile, above its person's reserve;
- a read is never of its own change, nor by its build's model family;
- what the task waits on has **landed** (today a task is given as soon as what it waits on is taken);
- its lane and its area have room (flow).

Then the score, for the item on this agent with each model it may run:

| Term | Is |
|---|---|
| `v` | The item's value: its priority's weight (p0 8, p1 4, p2 2, none 1) plus the weights of what waits on it |
| `T` | The minutes this agent needs with this model: the class's estimate, and its own record in the area |
| `P` | The chance it lands with no hold: the record of the class and the model, and the agent's own |
| `c` | What a minute of this agent costs now: its subscription's price for the tokens a minute, its machine's price, and what its own area's queue loses while it is away |

1. **Is it worth doing here?** Only if waiting for the agent that does it best costs more than the extra work here:
   `v × wait > (v + c) × T/P − (v + c*) × T*/P*`. The starred terms are the same item on that agent, and `wait` is
   when one like it could start, from what they hold and what is ahead of the item.
2. **Which first?** Of those, the one with the most `v × P / T`, raised a little for each hour it has waited, so a
   wrong estimate cannot starve a task.

Several agents free at once take the assignment with the highest total; a crew is small, so it is exact. Every offer
carries its reason in one line: "to Pip: it would wait 50 minutes for Ada, and costs Pip 12 more", or "left for Ada:
free in 10 minutes, at half the tokens".

**Bound late.** The offer goes to the agent's own daemon. It checks what only it knows (the machine now, the window
now, its person's rules), then claims with `take` in its person's name, with the model chosen. Or it declines, and the
next agent is offered. The coordinator writes nothing for another person. Lists two deep go, and with them the label
and comment of every task given and taken back.

### 3. Prices: what each scarce thing is worth now

One number for each scarce thing, moved by what is measured: for budgets, one such number a resource, updated as it
is used, is near the best that can be done [18]. A price of 0 means spend it. Closed means do not start.

- **A subscription's window** (five hours, a week, a model's own). Room is the percent left above the person's
  reserve. Need is what the Swarm will spend before the reset at its present rate, plus what tasks in hand still
  expect. The price is 0 while need is under four fifths of room: it would lapse unused, so use it. It rises as need
  nears room, and the window closes when the room is less than the smallest task's 90th percentile, so no agent is
  stranded mid-task. It is worked out on the person's own computer from what their CLI reports, and only the price
  leaves it.
- **A machine**: from the cores and memory free now, its person's own work included.
- **An agent's minute**: from what waits in its own area.
- **CI**: from how long check runs wait.
- **A person who pays by the token** sets a budget for the day. It is priced as a window is.

Prices are why there is no "cheap or fast" setting. Each person says what they give (a reserve, a budget), the
project says what matters (priorities), and the prices follow.

### 4. Estimates, and the ledger they come from

- **The ledger.** For each task its builder's own daemon counts: minutes in hand, tokens by model and kind (input,
  output, cached read, cache write), cores and memory used, check rounds, holds, lines changed. Harness writes them
  in one line of the comment it already posts when a change lands. Each daemon counts its agents' tokens today
  (`lib/agentTokenUsage.ts`); nothing ties the count to a task.
- **Estimates** are by class (kind of work, area, size) and model: minutes, tokens, cores, memory, the chance of
  landing with no hold. Each is the recent record, pulled toward the project's average while a class has few. The
  PM's size label is the first guess; the record replaces it. Coarse is enough: an order by size beats a size-blind
  one even with poor estimates, and the mean of the last two runs beat people's own estimates [19].
- **Guards against a wrong estimate.** Waiting raises a task's place. A task at twice its expected time is priced
  again as a long one, and its builder is asked once: split, or go on. At its class's 95th percentile the PM is
  told. A task is never given to a second builder while the first holds it.

### 5. The model, and the session

Most tokens are decided here, by one rule: **choose at the task's start, change nothing within it.**

- **The cheapest model that is good enough, by the record.** A task starts on the cheapest model whose record for its
  class is within five points of the best. Until there is a record, a table from public results stands in. It steps
  up one tier on evidence only: two failed check rounds, a second hold, or twice the expected time. A step up is a
  new session on the same branch, told what failed.
- **The top model** cuts work, reads risky changes, and takes the steps up.
- **A cheaper model is tried only with slack**: small p2 tasks, in a lane under its cap.
- **One session for a task, through its fixes.** A fix goes to its author.
- **Nothing wakes a parked agent but work.** What is said to it is kept and typed with its next task. An agent with
  nothing in hand is parked with an empty context, so waking it is cheap. (A decision below: it forgets what was said
  in passing.)

Why not predict difficulty and send each task to its tier? Because the words predict it weakly (evidence 2). The
record of checks and holds is the judge, as it is of everything else.

### 6. Who decides what: code, the LLM, Jev

| Decision | By | Because |
|---|---|---|
| Cutting work small and apart; areas; value; what waits on what | The PM, on the top model | It needs understanding, and planning is a few percent of the spend |
| A task's area in the project's own labels; an agent's "Works on" as labels; a likely duplicate, or overlap with work in flight | Jev, as a first guess the outcome overrules | Typed choices with probabilities, about $0.0002 and 0.6 s each. Taken only when it is sure, as ⌘B's router takes it; without it the PM's label stands |
| What may start; who; which model; prices; a train's size | Code | Arithmetic on every event, in milliseconds, the same answer twice, a reason in one line, never past a person's reserve |
| Whether a model is good enough for a class | The record: checks and holds | Words predict difficulty weakly |
| Not used | An LLM in the loop; a learned (RL) policy; auctions between agents | Tokens and seconds on every event, for arithmetic; a gain that did not reproduce [4]; a communication problem a coordinator does not have |

### 7. Where it runs, and how it grows

- **Each person's daemon** measures, prices, accepts, claims, and sets the model and the session. What is private
  stays there.
- **The coordinator** is one daemon for a crew: today the PM's person's. It reads GitHub for what changed, keeps the
  estimates and the flow, and makes offers. Another daemon of the project takes its place when it goes quiet (a
  lease). While none answers, an agent pulls the best item of the last ranking it was sent.
- **The Swarm's server** relays offers and prices, as it relays messages. It keeps nothing new.
- **GitHub** holds commitments and the ledger. Offers and prices never go through it: fewer writes than today.

| Agents | Shape |
|---|---|
| 10 to 30 | One crew, one coordinator |
| 100 to 300 | A crew for each area, its captain's daemon the coordinator, its own train. The PM moves agents between areas by their queues. Each agent has a home area and one more: a chain of two gets most of what everyone doing everything would [20] |
| 1,000 and more | Areas of areas. Every match is still the size of a crew; reads are of what changed; a ranking scores a sample, as Borg and Kubernetes do [21] |

## What it replaces

- **Goes:** the annealing search and its month-long timeline (`assign/search.ts`, `schedule.ts`); lists two deep; tasks
  labelled for a builder and taken back; the fixed table of what a size costs; the PM's person's login labelling
  other people's tasks.
- **Stays:** the labels (`part:`, `size:`, `needs:`, p0 to p2), `take` and `split`, trains, a read by another model
  family, the 20% reserve.

## What it should move

| Lever | What it saves | Whose | How sure |
|---|---|---|---|
| The cheapest model good enough, stepping up on evidence | Tokens: 40 to 60% against the top model for everything | Allocation | Medium: the prices are the vendors' own; the rest is benchmarks and vendors' runs |
| One session a task, the model fixed, nothing waking a parked agent | Tokens: 10 to 20% of the rest | Allocation | The mechanics are documented; the size rests on one lab's trace |
| Small tasks, few writers in one area, a fix to its author | Rework: lampOS's holds were 58% of all hours, and a conflict turned 64 minutes into 10 hours | The PM cuts; allocation paces | lampOS's record |
| A lane's cap, and trains by risk | Reads made again (21% of lampOS's READ-OKs); runs that never landed (130 of 803 trains, 41.5 hours of CI); a land path of 20 a run, not 2 to 3 | Allocation | lampOS, Uber, GitHub |
| Work matched to the agent that does it best, decided late | Build work: about 40% less than first come; finished 10 to 30% sooner than today's solver | Allocation | Our experiment, which is a model |
| No wait between tasks | lampOS waited a median 139 minutes from free to the next task; v4 already gives within a minute | Allocation, built | lampOS's record |

What that adds up to, said plainly:

- **80% of tokens** is reachable against "the top model for everything, one long session, first come", as a stack of
  the first three rows. Against what careful people already run (a middle model, caching on) the room is nearer 20 to
  40%. On a subscription a token saved is not a dollar saved: the measure is landed changes per window.
- **Ten times faster** cannot come from the model (faster inference is about 1.3× end to end, by a trace's 13 s of
  model to 18 s of tools a step [23]) or from the allocator alone. It needs all of: no wait between tasks (built),
  work cut small and apart (the PM), a land path that batches (built to 20 a run; by risk next), and more agents put
  to use without colliding (flow). The allocator's own share is a few times, not ten.
- **What nobody else has** is other people's machines and subscriptions, scheduled with their owners' rules first.

## The first experiment

One claim tested on our own solver: that deciding late, by a rule, finishes work as soon as the planned search.
[`experiment.mts`](experiment.mts) runs both on the same days (from `cli/`:
`npx tsx ../docs/design/2026-11-11-swarm-allocator/experiment.mts`).

- **The days.** 12 builders on 6 machines. 80 tasks (a light day) or 160 (more than they can do) arrive over ten
  hours, with sizes, priorities and four areas at random; one in ten waits on another. A builder is twice as fast in
  its own area. With noise, a task's minutes spread as agents' runs do, and three labels in ten are a size off.
- **The solver** is today's: `solve` with every search step run, lists two deep, the ten-minute take-back, a task in
  hand counted as half its size.
- **The rule.** When a builder is free it takes the task with the most weight for its minutes. A task another kind of
  builder does faster is left for one, unless waiting costs more than the extra work.

Weighted minutes from a task's arrival to its end, and builder-minutes of work, means of three seeds:

| Day | First come | Today's solver | The rule | The rule against the solver |
|---|---|---|---|---|
| Light, no noise | 90 min, 6,732 | 59 min, 4,152 | 53 min, 4,110 | 10% sooner, the same work |
| Light, noise | 91 min, 6,669 | 60 min, 4,046 | 52 min, 3,948 | 13% sooner, 2% less work |
| Light, heavy noise | 81 min, 6,397 | 59 min, 3,875 | 50 min, 3,839 | 15% sooner, the same work |
| Heavy, no noise | 320 min, 14,106 | 122 min, 8,700 | 85 min, 8,652 | 30% sooner, the same work |
| Heavy, noise | 313 min, 13,595 | 115 min, 8,484 | 89 min, 8,319 | 23% sooner, 2% less work |

What it shows, and what it does not:

- **Fit is worth a great deal.** Against first come, giving work to the agent that does it best takes about 40% off
  the work and 40 to 70% off the time. Allocation matters as much as anh Dee says.
- **The search is not where that value is.** A rule that decides late does better on every day tried, and most when
  the team is behind. With its full second on the light noisy day the solver's result does not change (65 against
  57, two seeds).
- **Pricing an agent's minute matters when the team is behind.** On heavy days a price from the agent's own queue,
  or a fixed one, takes a further 2 to 12% off the work. The rule's ten-seed runs are in the script's output.
- **It is a model.** The twofold speed in an agent's own area is today's assumption, not a measurement. There are no
  reads, checks, holds, models or tokens in it. Those are the replay harness's to add, set to lampOS's record.

## Build order

Each step is its own pull request, says the number it must move, and shows it in replay before it ships.

0. **Experiments, no product code.** (a) The replay harness: this experiment grown to the whole path (reads, checks,
   holds, trains, models, tokens), set to lampOS's record. (b) Jev's answers on area and overlap, against lampOS's
   history of issues and pull requests. (c) Fifty closed tasks run again on three tiers with the project's tests as
   the judge: the first table of what each tier lands.
1. **The ledger and the scoreboard.** Measure; change nothing.
2. **Three faults in today's allocator**, which are fixes to what ships: a task is given before what it waits on has
   landed; projects in one Swarm plan the same agents without seeing each other; a label's spelling decides an area.
3. **The match on events, bound late.** It removes the search and the lists two deep.
4. **Estimates from the ledger.**
5. **Prices**: a subscription's windows, the machine.
6. **The model for each task**, stepping up on evidence.
7. **Flow**: a lane's cap, writers in an area, trains by risk.
8. **Crews and captains** (the Swarm plan's step 3).

The scoreboard of step 1, which every later step is judged by: changes landed a day, and per agent; tokens per
landed change, and landed changes per window; minutes at each stage (waiting to start, building, waiting for a read,
fixing, waiting to land); the share of tokens spent after the first push; conflicts; CI minutes per landed change;
agent-minutes free while an item it could do waited, and why.

## Decisions for anh Dee

| # | Decision | I recommend |
|---|---|---|
| 1 | The objective: the most landed value an hour within what each person gives, with prices from their budgets and no "cheap or fast" setting | Yes |
| 2 | Harness picks the model for each task, within the agent's subscription; a person can pin one | Yes: it is the largest saving |
| 3 | Where the ledger is written: in Harness's landing comment on GitHub (anyone can rebuild the estimates; a public project's costs are public), or in the Swarm | GitHub |
| 4 | Jev reads a task's title and text | Yes for a public project; a private project's owner chooses |
| 5 | An agent with nothing in hand is parked with an empty context | Yes, once the ledger shows what waking costs |
| 6 | The three faults of step 2 now, before the rest | Yes |
| 7 | The experiments of step 0 before any product code | Yes: they decide steps 3 to 7 |

## Risks

- **Thin records at first.** A class with three finished tasks says little. Estimates lean on the project's average,
  and on a public table for models, until the ledger fills.
- **Prices can swing** when a window holds a few large tasks. The 90th-percentile filter is the hard stop, and the
  price is smoothed.
- **The PM is still the one who cuts.** At a thousand agents that is the ceiling the allocator cannot lift. It can
  only say which area is starved. Captains are step 8.
- **A changed model may surprise an agent's person.** The offer's reason names the model and why; a pin overrides it.
- **Clients of the last 30 days** expect a label given to them. The coordinator keeps labelling for a daemon that
  does not speak offers, until the date that can go.
- **The model is not the world.** The experiment's gains hold in replay, or the step does not ship.

## Sources

Read on 2026-11-11 by three research agents. Figures are as their reports give them from the pages named; what they
could not read at its source is left out. "(abstract)" marks a paper read only so far.

1. Lawrence and Sewell 1997, heuristic versus optimal schedules under uncertainty, doi 10.1016/S0272-6963(96)00090-3.
2. Gupta, Moseley, Uetz, Xie 2020, greedy stochastic scheduling on unrelated machines, arxiv.org/abs/1703.01634.
3. Bumpensanti and Wang 2020, re-solving heuristics, arxiv.org/abs/1802.06192 (abstract).
4. A 2026 reconstruction of Decima, arxiv.org/abs/2606.16555 (a preprint).
5. Agents' token use and their own forecasts of it, arxiv.org/abs/2604.22750.
6. Routing by a task's text against a few turns of work, arxiv.org/abs/2607.00053.
7. Ananthanarayanan et al. 2019, Uber SubmitQueue, EuroSys.
8. Conflicts between agents' pull requests, arxiv.org/abs/2607.04697.
9. CooperBench, arxiv.org/abs/2601.13295.
10. GitHub's merge queue, github.blog, 2024.
11. Stripe, Minions, stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents.
12. Factory, Missions, factory.com/news/missions-architecture.
13. Anthropic, harness design for long-running apps, anthropic.com/engineering/harness-design-long-running-apps.
14. Applied Compute, an agentic model router, appliedcompute.com/research/agentic-model-router (a vendor's own).
15. Anthropic's price list, platform.claude.com/docs/en/about-claude/pricing.
16. Claude Code on prompt caching, code.claude.com/docs/en/prompt-caching; a trace of one agent's input,
    syfi.cs.washington.edu/blog/2026-06-25-tracelab.
17. Raman, Livny, Solomon 1998 (HTCondor matchmaking); Anderson, BOINC, arxiv.org/abs/1903.01699.
18. Balseiro, Lu, Mirrokni, budget pacing by one multiplier a resource, arxiv.org/abs/2011.10124 (abstract).
19. Dell'Amico et al., scheduling with poor size estimates, arxiv.org/abs/1410.6122; Tsafrir, Etsion, Feitelson 2007.
20. Jordan and Graves 1995, limited flexibility (abstract).
21. Verma et al. 2015 (Borg); kubernetes.io, scheduler performance tuning.
22. Cursor, cursor.com/blog/scaling-agents; Anthropic, anthropic.com/engineering/building-c-compiler.
23. Claude Code's fast mode, code.claude.com/docs/en/fast-mode.
24. lampOS's own record: [the Swarm study](../../research/2026-11-10-swarm-study/README.md).
