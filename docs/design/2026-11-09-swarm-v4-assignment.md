# Swarm v4: who builds what, and when

Status: the solver is built and tested (`cli/src/superTabs/assign/`); its inputs and outputs are next (below).

anh Dee, 2026-11-09: "this is a classic optimization problem. N tasks. M machines with cpu ssd token. how do we best
assign them." "The bottleneck is a combination of cpu disk token etc." Assignment is the core of a Swarm: the right task
to the right builder, at the right time, so the team's work ships soonest without choking a machine or draining
anyone's subscription.

## The problem

A Swarm v4 team's tasks are its repository's GitHub issues; its builders are long-lived agents, each on its person's
machine, each running one task at a time with its model. Given:

- **tasks**: minutes of work, what each holds of its machine while it runs (CPU, memory, disk), what it spends of its
  subscription's windows, the least model quality it takes, its priority, when it is ready, the tasks it waits on, the
  files it changes, and who must not do it (its author; a review is never read by its build's model family);
- **builders**: their machine, their models (speed, policy cost, quality, subscription), how much faster they are on a
  part they know, and when their work in progress ends;
- **machines**: CPU, memory and disk for Swarm work, after their person's own reserve;
- **subscriptions**: each window's percent left, its resets, and the reserve its person keeps;

find, for every task, its builder, model and start, so that the priority-weighted finish time is least, then the cost,
and at no minute does a builder run two tasks, a machine go past its CPU, memory or disk, a limited model run past its
limit, two builders change the same file, or a window be spent past its reserve.

This is a multi-mode resource-constrained project scheduling problem: NP-hard, and well studied.

## The method

- **Exact constraints, one place.** `schedule.ts` is a serial schedule builder: tasks in a given order, each at the
  earliest minute every constraint allows. A 5-hour window refills at each reset; a task spanning a reset spends each
  window its share of its minutes. For regular objectives such as these, some order gives an optimal plan, so searching
  over orders, builders and models searches over every plan worth having.
- **A strong first plan.** List scheduling by weight, then by the work waiting behind each task (the critical path), each
  task where it ends soonest, the cheaper on a tie.
- **Local search.** Simulated annealing over the moves that matter: another builder or model, with or without a new place
  in the order; two tasks' places; a task's place; two tasks' builders. Four chains, the first from the list plan, the
  others from shuffled priorities. Seeded and bounded by iterations and time.
- **Stable plans.** Running work is fixed; moving a queued task costs a switching penalty, so a new plan changes the last
  only where it gains.

## Evidence

- **Optimal on small problems.** Twelve random problems (2 to 3 builders on one machine sharing CPU and memory, 4 tasks,
  dependencies, a shared file, a 5-hour window with a reserve, parts a builder knows): the search's plan scores exactly the
  best over every order, builder and model (brute force).
- **The real night of 2026-10-26** (42 tasks, 6 machines, 5 models, 7 accounts; the redacted instance the v3 prototype
  committed, `fixtures/2026-10-26-night.json`). The v3 prototype solved it exactly with CP-SAT in Python: finish 800
  minutes, which is the critical path and so the least possible, at cost 7,440. Today's route then took 1,100 minutes at
  7,600, and the night's actual picks 800 minutes at 10,100.

  | Plan | Finish (min) | Cost | Time |
  | --- | --- | --- | --- |
  | v3 CP-SAT, proven optimal | 800 | 7,440 | 0.14 s |
  | **this solver** | **800** | **7,460** (+0.3%) | 0.6 s |
  | the route then | 1,100 | 7,600 | – |
  | the night's picks | 800 | 10,100 | – |

  It also models what the prototype left out: with each account's 5-hour windows, the night still finishes in 800
  minutes, every window within its reserve.

## Code and prompt

Code is everything that can be counted or checked; the PM's guide keeps only judgement (standard 13).

- **Code**: the solver; reading tasks from GitHub, builders from the roster, machines from their reports and windows from
  each subscription's usage; estimates learned from finished tasks; applying `builder:<name>` with the PM's own `gh` and
  saying why; moving work when a builder stops, stalls or runs out of quota; picking reviewers; the measures.
- **Prompt**: breaking a request into tasks, one pull request each; labelling what each touches and needs (`part:`,
  `needs:`, `size:`) and its priority; following a person who asks for a given builder. Code checks those labels: an
  issue missing them is not assigned and the PM is told why.

## Next

1. **Inputs.** Each daemon reports its subscription's windows (percent left and resets, nothing else) with its machine's
   free CPU, memory and disk; the server joins them with the roster into a crew view.
2. **Estimates.** Each finished task records its real minutes, peak CPU and memory, disk and spend, by part, size and
   model; estimates take the mean for time and the 80th percentile for memory and disk. Until then the route's size table.
3. **The assigner** in the PM's daemon: tasks labelled ready, the crew view, the solver, labels and one line of why.
4. **Moving work** and **reviewers**.
5. **Measures** in Desktop: time from label to merge, idle builder-minutes, quota left unspent at resets, overload minutes,
   holds and conflicts.
