# Swarm: the allocator, after its audit

Status: **second version, 11 November, being built package by package**; each package's pull request says what
landed. anh Dee, the same day: "let's have another session build this", and "do not park anything, build it all":
[what to build, in order](BUILD.md). It
follows an audit of today's allocator, three reads of published work, one experiment, two independent critiques of the
first version, and the four walls anh Dee named. The first version is in pull request #4050's commits (`4f943f728f`).

anh Dee, 2026-11-11: "this is the heart of this product … a really good solver that helps people save 80% token cost
and ship 10x faster because of efficient resource allocation (not just token but CI, end to end testing, CPU heavy
tasks)." And the walls we hit: "as soon as an agent merge, all other agents have to rework their code because of
conflicts"; "with multiple agents, it's CPU constraint"; "end to end testing with runners … takes forever on one
machine"; "agents create worktrees, so disk and storage go out fast."

## In short

1. **The solver stays.** The first version said to replace its search with a rule. The critiques showed the search
   is as good as the rule. What loses time is giving an agent a second task ahead of the one it is building.
2. **The allocator's first job is the four walls**: merging, CPU, end-to-end tests, disk. They are capacity, and no
   choice of who builds what gets past them.
3. **Fix what the solver is fed and when it commits**: five faults in today's allocator, found in its code.
4. **Measure before the rest.** What an agent's own area is worth, what a task costs in tokens, and whether a cheaper
   model lands the same work are not known. The first version assumed them.
5. **After the walls, each with what it needs first**: prices for subscriptions, a model for each task, offers
   accepted on the agent's own computer, Jev, a public record of costs.

## What the first version got wrong

| It said | What was found |
|---|---|
| A twenty-line rule beats today's solver by 10 to 30%, so the search goes | The same solver holding one task ahead of each builder, not two, gets nearly all of that. With a machine's cores as the product plans them, the solver and the rule are level, and the second critique found the search 11 to 25% ahead of its own first plan on heavy days (its own runs: the script has no flag for it). What costs time is the second task ahead: 0 to 6% on light days and 17 to 19% on heavy ones with the cores the product plans (3 to 12% and 21 to 26% at 6) |
| Matching work to the agent that does it best saves about 40% of the work | That restates the experiment's assumption that an agent is twice as fast in its own area. At 1.5× it is 25%, at 1.2× 13%, at none 0. Nobody has measured it |
| A lane starts no more than it lands in its usual hours | That is its own average, used as a ceiling: it can never grow, and it ratchets down. In the critique's simulation it took 113 landings a day to 88, 26 or 6 |
| Writers in an area go up by one, and halve on a conflict | At lampOS's 7% conflict rate it sits at one writer for 43% of landings, and a project with one area gets two builders |
| A change with break chance q rides with 1/q − 1 others, so 20 is safe at 2% | Only if a run is all or nothing and breaks are independent. At 1.9% a train of 20 passes 68% of the time; counting changes held mid-run, about 42% |
| The agent's own daemon claims the task, and the server keeps nothing new | GitHub labels cannot be set "only if unset", so two daemons can claim one task. Who may coordinate, and who sees prices, was not said. Both need a small record the server keeps |
| Harness picks the model for each task | An agent is one session with one model. `/model` typed in its pane changes its person's default. Model routing was built in v1 to v3 in eight designs and removed on 10 November (#3908) |
| A subscription's price is worked out from its window | Claude's window is known only after a reply, and is unknown after an hour or a reset |
| 80% of tokens is reachable as a stack of three levers | Two of them stack to 46 to 68%, against the worst baseline, at API prices, from vendors' figures and one trace. Per subscription window nothing is measured |
| The allocator's own share of "ten times faster" is a few times | Unmeasured. The 139 minutes lampOS waited from free to the next task is 65 cases of the PM's reply time |
| A size's cost is a fixed table | Its minutes are learned from finished tasks already. Its cores, memory and tokens are fixed |

## The four walls, measured

On this repository and anh Dee's computer, 11 November.

| Wall | What is there | Why |
|---|---|---|
| Merging | 517 landings on main in 7 days, up to 123 a day and 10 in an hour. One file (`backend/src/superTabs/commands.ts`) is touched by a quarter of them, `store.ts` by 22%, `model.ts` by 16%, `view.dart` (5,234 lines) by 15%; three test files of over 4,000 lines are in the top fourteen. Since 4 November 65 of 215 batches and trains (178 batches made by hand, 38 of the server's old train; the new train has not run here yet) were closed without landing, carrying 161 riders (104 changes); a landed one carries 2.9 | A few very large central files, so changes in flight touch the same file. And each landing puts every other change behind main, to be updated, rebuilt and read again |
| CPU | 12 cores, 155 worktrees of this repository. This week's fix: "the unit suite passes on a loaded Mac" (#3927) | Each agent's build and test tools take every core, and each landing makes all of them rebuild at once |
| End-to-end tests | CI splits its suites over 4, 6 and 8 runners (Desktop's six and the backend's four by recorded durations, the CLI's by its runner's own split). The suites CI does not run (Desktop on macOS, the coverage gates, VM tests) run on one computer | One computer, in turn |
| Disk | 114 Harness worktrees of this repository hold 109 GB: 1 GB each on average, 11 GB the largest. 215 GB are free | Each session gets a worktree with its own dependencies and build output, and nothing removes it when its work lands |

## What is known, and what is not

Known:

- **Holding a second task ahead costs time.** In a model of building only, a list two deep costs 0 to 6% of
  priority-weighted time on light days and 17 to 19% on heavy ones against a list one deep, with the cores the product
  plans ([the experiment](#the-experiment)).
- **Today's allocator has five faults** ([below](#1-the-solver-stays-what-it-is-fed-and-when-it-commits)).
- **Writers collide, and it grows faster than agents do.** Two changes in flight conflict 5% of the time, sixteen 40%
  [1]. Pull requests open at the same time in one repository conflict 41.7% of the time when different agents wrote
  them, 19.8% when one did [2]. On lampOS the 7% told
  they conflict took 10 hours instead of 64 minutes, and 21% of READ-OKs only restate a read on a new head [8].
- **The land path is the ceiling.** One serial check of 15 minutes lands 96 changes a day whatever the agents.
  Batching by predicted pass and independence is how others raised it [1][3].
- **Planning is cheap and doing is the bill** (4% of tokens at Factory [4]), and **the cache is most of the
  input** [5].
- **Nobody schedules other people's machines and subscriptions** [6][7]. This ground is open.

Not known, with how each would be found:

| Question | How |
|---|---|
| Is an agent faster, or held less, in an area it has worked in? | lampOS's record: a builder's later tasks in an area against its first |
| What does a task cost in tokens, by model and by stage? | Nothing counts it. The server's cost record went with v3 on 10 November (#3908); each daemon still counts its own conversations |
| Does a cheaper model land the same work? | Fifty closed tasks run again on three tiers, the project's tests the judge |
| What does a list one deep do with reads and landings in the loop? | The model ends at the build. Live, on our own Swarm, the week after against the week before on the scoreboard: the change ships on, with no switch between two rules |
| How do conflicts follow overlap here? | GitHub: which changes were told they were behind or in conflict, and on which files |
| Where does a change wait here? | GitHub's own timestamps, stage by stage |

## The design

### 1. The solver stays: what it is fed, and when it commits

`assign/search.ts` and `schedule.ts` stay. Five faults go:

1. **A change waiting for its read fills its builder's list.** A builder with two changes in review is given nothing
   until one lands, and is not counted idle. (Read in `assign/crew.ts` `readProblem` and in `nextThing.ts`; a test
   must confirm it.) Its list should count what it is building. The bound on its open changes stays: four, as `take`
   has.
2. **A second task is given ahead.** The next task should be given when the builder is free to build it: when its
   pull request is up, or its turn ends with nothing in hand.
3. **A task is given as soon as what it waits on is taken.** It should wait until that change is up for reading, and
   then go to the same builder, built on that branch (the merger already lands a stack in order); or until it lands.
4. **Projects in one Swarm plan the same agents blind.** A builder's list should count its tasks in all of them.
5. **An area matches by exact spelling.** `part:Backend`, `backend` and "backend engine" are three areas.

And one mismatch: the plan keeps a machine within its cores, but nothing checks cores when a task is taken. Either
the daemon checks, or the plan stops counting them.

### 2. The merge wall

- **Behind is not a reason to rework.** A change that only trails main rides the train as it is. Today's merger asks
  it to update first where the repository requires up-to-date branches.
- **Only the train lands.** A landing beside it moves main under the running train, which is then closed and built
  again. Here 65 of 215 batches and trains were closed without landing, for several causes: the scoreboard counts
  them by cause first.
- **A train ejects and goes on.** Riders are sorted by risk; one that breaks or is held is dropped and the next train
  is built at once without it. Today that run is lost: whether the rest can land on it is the trains package's
  question. A change that is being changed does not ride.
- **A hot file has one writer at a time.** Hot is measured: a file more than a tenth of recent landings touch. A second task on it
  waits, or is built on the first's branch by the same agent. The PM is told the list, and cuts tasks to split those
  files by feature.
- **The cap on changes in flight comes from what the land path can carry** (a train's size, its runs an hour), never
  from what it landed.

### 3. CPU, tests and disk

Each is the machine's own daemon's work, and each is the positioning line made literal: a machine takes work only
when it has the memory, disk and tools the job needs.

- **CPU.** One budget of cores a machine: each agent is started with its share, and a heavy run ranks below its
  person's own work. With behind no longer a reason to rebuild, the herd after each landing goes too.
- **End-to-end tests.** The suites CI does not run are split across the Swarm's machines as CI splits its own, once
  for a train and not for each change, with a result kept for the exact source it ran on. A private team can do this
  now. An open project needs the sandbox first, which was set aside on 11 November.
- **Disk.** A worktree Harness made, whose branch has landed (its pull request merged, as GitHub says: a squash
  leaves git nothing to tell by) and which holds nothing uncommitted, is removed. Build
  output of idle worktrees goes oldest first. New worktrees are copy-on-write clones of a warm one, so dependencies
  cost nothing until they change.

### 4. The scoreboard

From GitHub alone, with no record of our own: where a change waits (to start, building, for its read, in fixes, to
land), conflicts and on which files, trains lost and why (a train closed without landing says why in its title), and
builders free while work they could do waited. It goes in the day's post, and every change above is judged by it.
Package 1 builds the waits for a read and to land, the counts and the trains; the waits to start, building and in
fixes come with a task's boundaries (package 12), and a conflict's files with hot files (package 8).

### 5. After the walls, and what each needs first

| Idea | Needs first |
|---|---|
| A price for each subscription window, worked out on its person's computer | A window's use known between replies; a rule for "unknown"; proof it does not swing with a few large tasks |
| A model for each task, stepping up on evidence | The tiers experiment; sessions Harness starts for a task, not `/model` in a pane; why v3's eight designs went |
| Offers accepted on the agent's own computer | An offer record on the server, one live for a task at a time, with an expiry; a plan for 30 days of older daemons |
| Jev for a task's area | Its answers checked against lampOS's history; a private project's owner's choice |
| A cost for each landed change, in public | Tokens counted for a task at all; where it is kept; what a public project shows of a person's use |
| The worth of an agent's own area | The first question in the table above |

## How a change is proven

- **In the model**, where it can see the effect: who is given what, and when.
- **Live, week against week**, where it cannot (reads, conflicts, CI): the change ships on, with no switch, on our
  own Swarm, and the scoreboard's week after is read against its week before.

## Order

As anh Dee asked on 11 November, everything is built, in this order ([the packages](BUILD.md)):

1 the scoreboard; 2 one task building, at most four open; 3 a task waits for what it depends on; 4 behind is not a
reason to rework; 5 an area is its label; 6 disk; 7 CPU; 8 hot files; 9 trains; 10 end-to-end tests across machines,
for private teams; 11 one view of an agent across a Swarm's projects; 12 tokens for a task and the cost on a landed
change; 13 Jev for a task's area; 14 a model for each task; 15 a price for a subscription's window; 16 offers accepted
on the agent's own computer. The measurements in the table of what is not known are each package's first step.

## Decisions for anh Dee

| # | Decision | I recommend |
|---|---|---|
| 1 | Keep the solver, and change what it is fed and when it commits | Yes |
| 2 | The order above: the walls before any new method | Yes |
| 3 | Remove a landed, clean worktree that Harness made | Yes |
| 4 | A budget of cores for each machine's agents | Yes |
| 5 | Only the train lands on a Swarm's project | Yes |
| 6 | Count tokens for a task again, on its person's own computer first | Yes: no saving can be claimed without it |
| 7 | The three measurements: an area's worth, the tiers, a list one deep week against week | Yes, as each package's first step |

## The experiment

[`experiment.mts`](experiment.mts) runs today's solver and simple rules on the same simulated days (from `cli/`; its
head says how to vary it). The tables below are
`SEEDS=1,2,3 CASES=0:0:80,0.7:0.3:80,1:0.3:80,0:0:160,0.7:0.3:160 ONLY=fifo,solver,solver1,priced0 npx tsx ../docs/design/2026-11-11-swarm-allocator/experiment.mts`,
with `CORES=8` for the second. The solver's rows vary a little with the computer: its search stops on a wall clock.

- **The days.** 12 builders on 6 machines. 80 tasks (a light day) or 160 (more than they can do) arrive over ten
  hours. A builder is assumed twice as fast in its own area. With noise, minutes spread as agents' runs do, and three
  labels in ten are a size off.
- **It ends at the build.** No reads, checks, holds, landings, models or tokens. And a task starts the minute it is
  given: in the product a builder with nothing waits a pass (up to 60 s) and GitHub's news (20 s) for it, about the
  size of the light days' gain.

Priority-weighted minutes from a task's arrival to the end of its build, means of three seeds, with a machine's cores
at 6 (the script's default):

| Day | First come | Solver, two ahead (today) | Solver, one ahead | Rule, decided when free |
|---|---|---|---|---|
| Light, no noise | 90 | 59 | 57 | 53 |
| Light, noise | 91 | 60 | 55 | 52 |
| Light, heavy noise | 81 | 59 | 52 | 50 |
| Heavy, no noise | 320 | 123 | 91 | 85 |
| Heavy, noise | 313 | 119 | 94 | 89 |

At 8 cores, which the product plans with when a machine reports none (the review's run of 11 November, on this
branch):

| Day | First come | Solver, two ahead (today) | Solver, one ahead | Rule, decided when free |
|---|---|---|---|---|
| Light, no noise | 93 | 53 | 53 | 53 |
| Light, noise | 90 | 54 | 51 | 51 |
| Light, heavy noise | 85 | 51 | 49 | 49 |
| Heavy, no noise | 324 | 103 | 83 | 85 |
| Heavy, noise | 293 | 104 | 86 | 86 |

- **One ahead, not two, is the gain**: 0 to 6% on light days and 17 to 19% on heavy ones at 8 cores; 3 to 12% and 21
  to 26% at 6. "One ahead" is a list one deep: a task is given only to a builder with nothing.
- **The rule's last 4 to 7% at 6 cores is not real.** With 6 cores two large tasks cannot share a machine, and the
  table holds the solver's builder to that. The product plans with a machine's cores (8 when unreported) and checks
  none when a task is taken. At 8 cores the one-ahead solver and the rule are level. The second critique found the
  same over more seeds, and the search 11 to 25% ahead of its own first plan on heavy days.
- **Both tables give the solver today's fixed guesses** of a size's minutes and an area's speed. Given the real
  speeds, the rule scores 55, 53, 50, 98 and 91.
- **First come is far behind either**, but by how much rests on the assumed twofold speed in an agent's own area.

## Sources

Read on 2026-11-11 by three research agents; figures are as their reports give them from the pages named. The two
critiques' runs were checked against this experiment's own.

1. Ananthanarayanan et al. 2019, Uber SubmitQueue, EuroSys.
2. Conflicts between agents' pull requests, arxiv.org/abs/2607.04697.
3. GitHub's merge queue, github.blog, 2024.
4. Factory, Missions, factory.com/news/missions-architecture.
5. Claude Code on prompt caching, code.claude.com/docs/en/prompt-caching; a trace of one agent's input,
    syfi.cs.washington.edu/blog/2026-06-25-tracelab.
6. Raman, Livny, Solomon 1998 (HTCondor matchmaking); Anderson, BOINC, arxiv.org/abs/1903.01699.
7. Cursor, cursor.com/blog/scaling-agents; Anthropic, anthropic.com/engineering/building-c-compiler.
8. lampOS's own record: [the Swarm study](../../research/2026-11-10-swarm-study/README.md).
