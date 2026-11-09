# Swarm v4: who builds what, and when

Status: built. The solver (`cli/src/superTabs/assign/search.ts`, `schedule.ts`) and the assigner that feeds it and applies
its plan (`assign/crew.ts`, `githubAssign.ts`) run in the Harness of the person whose agent is the project's PM. Learned
estimates, CPU cores and moving work are next (below).

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

## The assigner (built)

Every minute, in the PM's person's Harness, for each project its PM leads from there (`githubMerge.ts ledProjects`):

- **Tasks** are the repository's open issues the PM sized (`size:s`, `size:m`, `size:l`) that no builder holds. One a
  builder holds is queued on it, and one it took (`status:taken`) keeps it busy for half its size. An issue another team's
  label holds is left alone, as is any `builder:` label a person set. `part:` gives the task's part, `p0`-`p2` its weight
  (8, 4, 2; 1 for none), "after #N" in its text what must end first, and each `needs:` label a tool, system or GPU its
  builder's machine must report, else that builder never gets it.
- **Builders** are the project's regular Claude Code and Codex agents as the PM reads the Swarm (`crewOf`): never the PM,
  a Buddy, one stopping, one whose machine is down, or another private project's. A builder is quicker in a part where its
  label was on closed issues: 15% a task, 40% at most.
- **Machines** give Swarm work 75% of their memory and their project disk less 10 GB; CPU is 8 cores until machines report
  their count. **Subscriptions** are each machine's engine windows as it reported them, a 20% reserve kept for its person.
- **Sizes** until estimates are learned: s 30 minutes, 1 core, 2 GB, 1 GB, 3% of a 5-hour window; m 90, 2, 4 GB, 2 GB, 10%;
  l 240, 4, 8 GB, 4 GB, 25%; a weekly window spends a fifth of that.
- **The plan** is the solver's, from the last plan (so it changes only where it gains), in a second at most. Each builder
  gets the free tasks it starts next until it holds two: `builder:<name>` on the issue and one comment, "Harness, 15:40: for
  **Pip**: it can start now, and it finished 3 part:api tasks." GitHub news then brings each its task.
- **Failures** are said once: a label GitHub refused (tried again next pass), a task no builder can do and why, gh signed
  out or rate limited (as the merger: `githubRest.ts`).

## Next

1. **Estimates.** Each finished task records its real minutes, peak CPU and memory, disk and spend, by part, size and
   model; estimates take the mean for time and the 80th percentile for memory and disk.
2. **CPU cores** in each machine's report, so CPU is measured, not assumed.
3. **Works on**: what a person says their agent works on, beside what it learned.
4. **Moving work** when a builder stops, stalls or runs out of quota, and **reviewers**.
5. **Measures** in Desktop: time from label to merge, idle builder-minutes, quota left unspent at resets, overload minutes,
   holds and conflicts.
