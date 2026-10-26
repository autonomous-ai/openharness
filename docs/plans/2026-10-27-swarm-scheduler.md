# Swarm scheduler prototype: one plan for every task at once

Status: prototype, not wired into routing (v2 E). Code: [`tools/scheduler/`](../../tools/scheduler/README.md).

## Why

Today's route places one task at a time. It takes the first candidate in a fixed order (cheaper in effect, stronger,
more quota room; [`route.ts`](../../cli/src/superTabs/route.ts) `choose`) and never looks at what else is queued. Dee's
goal is the global optimum for M tasks on N machines and their models, in this order:

1. **Quality**: every task gets a model at or above its floor (a hard limit).
2. **Finish time**: the time the last task ends (makespan), given dependencies, machine slots and model limits.
3. **Cost**: the policy cost of the work, among the plans with the least finish time.

The prototype solves that exactly with OR-Tools CP-SAT. It also gives the full set of plans where finish time can only
be bought with cost (the Pareto set). It compares its plan with today's route and with what the Swarm actually picked
on the night of 2026-10-26.

## Formulation

Inputs, in whole minutes:

- **Task** *t*: estimate *e_t*, floor *f_t*, kind, dependencies *D_t*, tasks it must differ from *I_t* (a review and
  its build), and weekly spend *s_t* at policy cost 2.
- **Machine** *m*: slots *S_m* and engines.
- **Model** *k*: engine, family, policy cost *c_k*, quality *q_k(kind)*, speed *v_k*, an optional limit *L_k* on tasks at
  once (a local model serves 1 Builder, a shared API 4), and whether it spends the machine's subscription.
- **Account** *a*: the machines and engines that share it, and the weekly quota *B_a* left after the reserve.

An option *(t, m, k)* exists when *k*'s engine is on *m* and *q_k(kind_t) ≥ f_t*, so the quality floor is enforced
by construction. Its duration is *d = ⌈e_t / v_k⌉*.

Variables: a boolean *x_tmk* per option, and integer *start_t* and *end_t*.

- Exactly one option per task: *Σ_mk x_tmk = 1*.
- An optional interval of length *d_tmk* at *start_t*, present when *x_tmk* is set; *end_t = start_t + d_tmk* when it is.
- Dependencies: *start_t ≥ end_p* for every *p ∈ D_t*.
- Slots: a cumulative constraint per machine, capacity *S_m*.
- Model limits: a cumulative constraint per model with a limit, capacity *L_k*.
- Review independence: for each *u ∈ I_t* and family *F*, at most one of *t* and *u* uses a model of *F*.
- Quota: for each account, *Σ x_tmk · s_t · c_k / 2 ≤ B_a* over the options that spend it (the route's
  `sizeUp` scaling).

Objectives, lexicographic: first minimise *M = max_t end_t*. Then fix *M ≤ M\** and minimise
*Σ x_tmk · c_k · e_t*. Both phases share one time limit (10 s by default), and each reports its bound. A
result is `OPTIMAL` only when both phases prove optimality. Otherwise it is `FEASIBLE` with the gap.

Pareto set: start with the lexicographic optimum *(M₁, C₁)*. Then repeat with *cost ≤ C_i − 1* until it is
infeasible. Each step gives the fastest plan that is cheaper than the last one, at its least cost, so every proven step
is on the front and the walk is exact.

## Baseline: today's route

`greedy.py` takes the tasks in routing order. For each one it keeps the options at or above the floor, and only the
strongest ones for a hard task. It prefers accounts that fit, then accounts whose quota is unknown, then accounts that
are short. It sorts by cost, then quality, then quota room left, then machine name, which is the route's policy order.
A review leaves out the family its build was given, as the Lead asks for that by name. Then every task starts as early
as its dependencies, slots and model limits allow, which is how the Swarm starts routed work.

Simplified from the route: there are no owner rules and no members (every pick is a new agent). When every account is
short, the baseline keeps the policy order instead of picking the candidate expected to get furthest. The route does
not look at slots, and the backend refuses a start on a full machine (`MACHINE_FULL`). The baseline queues the task
there instead, which flatters the route.

## Tonight's data

Sources: the Lead's route log (75 requests with difficulty, risk, size and kind) and a Swarm status snapshot (groups,
assignments, 7 machines with slots and quotas). The converter is `python -m scheduler convert`. Its hand-checked
inputs are in [`data/2026-10-26-night.config.json`](../../tools/scheduler/data/2026-10-26-night.config.json). The
result, [`data/2026-10-26-night.json`](../../tools/scheduler/data/2026-10-26-night.json), has 42 tasks, 7 machines,
5 models (Opus, Codex, Sonnet, Haiku and the shared DeepSeek API) and 9 accounts.

Read from the data: the machines, their slots and engines, the weekly quota left, each group's assignment (machine,
engine, model) and, for 12 groups, their own route request.

**Estimates**, which the comparison depends on:

| Input | Estimate |
| --- | --- |
| Task length and weekly spend | The route's size table: small 20 min, medium 60, large 180; weekly 1, 4 and 8 at cost 2 |
| 20 groups' assessments | 14 are named by a variable in the log and matched by time and title. 6 have no request of their own and reuse a neighbouring one (G5 takes G3's, fixes C2 and I3 take C1's) |
| 10 groups' assessments | No route request (research, G6, v1 liveness A and B, v2 A–E started directly): set by hand |
| Dependencies | Read from the titles: a review after its build, and the 1726 chain (G1 → review → G2/G3 → G4/G5/G3b → G6 → merge → final review → fixes → their reviews) |
| Policy | The default routing policy. The tab's effective policy is not in the snapshot |
| Speed | 1.0 for every model: there is no data |
| Accounts | Machines that report the same weekly reading are taken to share one account. The snapshot has no account keys |
| Starting quota | The snapshot is taken after the night. Every plan gets the quota left plus what the actual picks are expected to have spent |

Left out: 6 smoke tests and checks that a person pinned to one machine and model. The scheduler has nothing to
choose for them.

One limit applies to the whole comparison: it schedules the night's 42 tasks as one batch, known from the start. The
real night learned of them over ten hours, so the result shows what a plan made with hindsight could gain, not what
the route lost on any single decision.

## Results

Command: `python -m scheduler compare data/2026-10-26-night.json [--max-slots N]`, on an M-series Mac with 8 workers.
Cost is the policy cost × estimated minutes.

| Slots | Plan | Finish (min) | Cost | Solve |
| --- | --- | --- | --- | --- |
| as contributed (1–16) | exact | **800** (proven) | **7,440** (proven) | 0.15 s |
| | today's route | 1,020 | 7,460 | – |
| | tonight's picks | 800 | 10,100 | – |
| at most 2 per machine | exact | **800** | **7,440** | 0.19 s |
| | today's route | 1,020 | 7,460 | – |
| | tonight's picks | 1,000 | 10,100 | – |
| at most 1 per machine | exact | **800** | **7,440** | 0.22 s |
| | today's route | 1,340 | 7,460 | – |
| | tonight's picks | 1,840 | 10,100 | – |

No plan breaks a floor, a review's family rule or an account's quota. 800 minutes is the critical path of the 1726
chain, so no plan can finish sooner.

- **Against tonight's picks, the exact plan costs 26% less at the same finish time.** Tonight ran 25 tasks on Opus
  and 17 on Codex. The exact plan runs 22 on Codex, 14 on Opus and 6 on Sonnet. In the policy, Codex is as strong as
  Opus (quality 3) and cheaper (2 against 3). Opus is kept for the reviews of Codex work, and Sonnet for 6 of the 7
  tasks with floor 2. The saving relies on the policy's ratings. If Opus is in fact stronger for this work, the policy
  should say so, and the solver will follow it.
- **Against today's route, the exact plan finishes 22% sooner at the same cost, and 40% sooner with one slot per
  machine.** The route gives each task the account with the most room. It sent 9 tasks (1,260 minutes of work) to the one-slot
  MacBooks-MacBook-Pro-19, because its Codex account had 85% left, and they queue there. The exact plan sees the queue
  and gives that machine nine 20-minute reviews instead.
- **Tonight's picks are fragile under load.** They piled 21 tasks on Mac Studio and 14 on MacBookPro2021, which is
  fine with 16 and 8 slots, but at one slot per machine they finish at 1,840 minutes against 800.
- **The Pareto set has one point** on this night: the cheapest plan also reaches the critical path, so there is no
  trade-off to choose from. Generated busy nights have several (below).

### Solve time

Generated instances (`scheduler/bench.py`) are shaped like a busy night: builds with reviews (40%), chains, 1–4 slots
per machine, binding quotas, and six models that differ in strength, cost and speed (one is a local model serving one
Builder at a time). Three seeds each:

| Tasks × machines × models | Solve (s) | Result |
| --- | --- | --- |
| 30 × 8 × 6 (the brief's limit: 10 s) | 0.25, 0.27, 0.23 | all proven optimal |
| 60 × 12 × 6 | 1.12, 1.47, 1.42 | all proven optimal |
| 100 × 16 × 6 | 4.91, 3.93, 3.87 | all proven optimal |
| 150 × 20 × 6 | 8.64, 10.01, 9.73 | 1 proven; 2 found the least finish time but ran out of time on cost |

The Pareto set on 30 × 8 × 6 is exact and complete in 1.4–2.3 s. For seed 1, its 7 points run from 468 minutes at cost
3,860 to 509 minutes at 3,500: 41 more minutes saves 9%.

## What this suggests

- An exact global plan is cheap at the Swarm's size. Tonight solves in a fifth of a second, and 100 tasks in about 5 s.
  No performance work was needed.
- The largest gain on real data is not ordering but the choice of model under the policy, and the policy's ratings
  decide it. Rating Opus above Codex, or giving quality per task kind (the format already takes it), changes the plan.
- The route's blind spot is the queue: it ranks by quota room and ignores slots.

Next steps, if this goes ahead: offer the exact plan to the Lead as advice beside the route's pick, and re-solve
whenever a task arrives or finishes, with running tasks fixed. Learn task lengths and model speed from the attempts'
times instead of the size table. Read the tab's effective policy and account keys rather than estimating them.

Not modelled: 5-hour windows (they refill during a night, so a fixed budget would be wrong; modelling them needs
time-indexed use), owner rules, reusing an idle member, memory and disk.

## Validation

`cd tools/scheduler && python -m unittest discover -s tests -t .` (Python 3.9, `ortools==9.15.6755`): 59 tests.
Each constraint's test fails when that constraint is removed from the model and passes when it is restored. PR CI runs
process checks only for `tools/` and `docs/`.
