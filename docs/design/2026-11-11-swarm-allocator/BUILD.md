# The allocator after its audit: what to build

For the session that builds [the design](README.md). Read the design first, then this. The design says what and why;
this says in what order, how each piece is proven, and what was learned the hard way while it was designed.

anh Dee, 2026-11-11: "let's have another session build this", and of what the design had parked: "do not park
anything, build it all." So every part of the design is a package here, in an order where each rests on the ones
before it. What the two critiques found is not a reason to wait: it is each package's first step.

Three things still stop for his word, because they cannot be undone or they spend what is his: a rule that removes
files from people's disks (package 6), running the tiers experiment on his subscription (package 14), and Jev on a
private project (package 13). Two more are his to choose where he is there to choose: which way package 11 goes, and
the mockup of the choice package 14 adds to a screen.

## Before any code

1. Read the root `AGENTS.md` (the code standards, the tech limits, "Data and design"), `cli/AGENTS.md`,
   [the Swarm plan](../../plans/2026-11-10-swarm-plan.md) with its decisions of 11 November, and
   [today's assignment design](../2026-11-09-swarm-v4-assignment.md). For a package that touches them:
   `backend/AGENTS.md`, `desktop/AGENTS.md`, `docs/windows-rules.md`, and `cli/src/superTabs/capacity.ts` (a momentary
   CPU reading once refused every start).
2. Read the code a package names before changing it. This document's pointers were right on 11 November at `main`
   `bf903baa2f`; the code wins where they differ.
3. Run `experiment.mts` once (its head says how), so its numbers are yours to check and not this document's word.

## How each package is done

- **One package, one pull request**, from a branch off current `main`, as small as the package allows. Two kinds
  take more: where the server ships first (12 and 16: the server's, then the daemon's), and where a study comes
  first (6, 7, 11, 13 and 14: its write-up, then the code).
- **The failing test first.** The pull request shows it red, then green. Test at the layer where the behaviour
  lives, through what a caller sees.
- **The per-file gate.** `npx vitest run --config vitest.super-tabs.config.ts` in `cli/` holds the files its config
  lists to 100% a file: of the files these packages change, `pmNumbers.ts`, `nextThing.ts` and package 1's
  `scoreboard.ts`, and not `assign/crew.ts`, `githubAssign.ts`, `githubMerge.ts` or `githubTrain.ts`. A new file goes
  on its list. Elsewhere the proof is the spec and the mutation checks. PR CI does not run the gate; run it and
  record it.
- **Mutation checks.** For each line that decides something, break it, run its spec, and see the spec fail.
- **A review that is not yours.** A fresh agent, given the code and the rules and not your conclusions, until it says
  merge. Its verdict goes on the pull request. Packages 2, 3, 4, 8, 9, 10 and 16 touch what may land or be given:
  ask for a review that hunts for ways to land unread code or to give a task twice.
- **GitHub's behaviour is checked on GitHub.** Where a package rests on how GitHub acts (a stack after its base
  lands, a branch behind a protected base), try it in the private scratch repository first and put the trial in the
  pull request. If GitHub does not act as this document expects, stop and report. Do not add a rule to get round it.
- **A pull request's description** says what, why, the Design lines where data is stored, synced or shown, the
  evidence, and the platforms.
- **Land with the repository's tool** (`make merge-pr`), a ready pull request, green checks. A CLI-only change is
  released after it lands (`make release-cli`).
- **After each package**: three lines to anh Dee (what landed, the number it moved or will move, what is next), and
  the status lines of the design and of the plan's "Not built" list brought up to date.

## What was learned while designing it

- **Each rule added to answer a review was broken by the next review. The smaller designs passed.** When a review
  finds a hole, look for what to remove before what to add.
- **An assumption is not a finding.** The first version's "40% less work" was the experiment's own assumption read
  back. Say what is measured, what is a model, and what is assumed.
- **The model ends at the build.** It has no reads, checks, holds or landings. It can say who should be given what;
  it cannot say what a change does to conflicts or to waiting. Those are judged on the scoreboard, before and after.
- **No switch for a fix.** A change ships on and is judged by the scoreboard, week against week. That is why the
  scoreboard is first.
- **The PM's person's login does this work on GitHub.** lampOS had two accounts banned for volume. Every new read is
  bounded, and nothing new is read every minute.

## Packages, in order

### 1. The scoreboard

**Built** (#4064): `cli/src/superTabs/scoreboard.ts`. What follows is what was asked; where the build differs it says so
in *italics*.

**Why.** Everything after it is judged by it. Today's daily post has counts only.

**Today.** `cli/src/superTabs/pmNumbers.ts` (`numbersOf`, `dayLine`: the day's post in the project's channel, from
09:00 local), fed by `githubAssign.ts` `assign`. The merger keys its notes by kind (`githubMerge.ts` `NOTES`:
`behind`, `dirty`, `stacked`, `blocked`, `red`, …). Trains are pull requests titled `Train: …`
(`githubTrain.ts`). Why one closed without landing is only a line in the PM's daemon's log (`close`); only a red
one is marked, in its title.

**Change.** The day's post gains, for the team's own changes (as its counts are) of the last 24 hours:

- the median minutes a landed change spent from its pull request to its first verdict, and from its last READ-OK to
  landing;
- how many changes were told they were behind, and how many that they conflict;
- trains landed, and trains closed without landing, by cause (its checks failed, the base moved, a rider changed,
  it ran out of time). A train closed without landing says its cause in its title, as a red one does, with the
  write that closes it: no new write, and nothing to read but the closed list the pass has;
- the files most landings touched in the last seven days, when one is in more than a tenth of them, with its share.
  *The words count the landings read ("of the last 43 landings") and name no window: the closed list the pass reads is
  one page, which on a busy repository is hours. A file is named at three landings or more.*

Counts, medians and file paths only. Bounded: at most the newest 50 changes landed in the day are read for their
times, and the newest 50 landed in the week for their files, once a day, when the post is due. A part that cannot be
read is left out of the post and said once in the log.

**Proof.** Specs against a stand-in GitHub, as `pmNumbers.spec.ts` and `githubAssign.spec.ts` have; the gate; and the
line it would post for this repository's own last day, read from GitHub without posting anywhere.

**Not in it.** Tokens, costs, people's names beyond what the post names today, a new screen. The waits to start,
building and in fixes come with package 12's boundaries, and which files a conflict was on with package 8.

### 2. One task building, at most four open

**Built** (#4091): in `cli/src/superTabs/assign/crew.ts` (`heldTasks`, `hasRoom`), `githubAssign.ts` and `pmNumbers.ts`.
*`CLAIM_LIMIT` is defined in `assign/crew.ts`. No free task is planned on a builder that holds four. A pull request that
is red or in conflict counts as in review: the assigner reads no checks.*

**Why.** Two faults. A change waiting for its read fills its builder's list, so a builder with two in review is given
nothing and is not counted idle. And a second task is given ahead, which in the model costs 0 to 6% of
priority-weighted time on a light day and 17 to 19% on a heavy one with the cores the product plans (3 to 12% and 21
to 26% at 6).

**Today.** `assign/crew.ts`: `DEEP = 2`; `readProblem` counts every open task a builder holds in `open`, and counts a
taken one as busy for half its size, whether or not its pull request is up; `nextPicks(plan, read, deep)`.
`githubAssign.ts` plans only while some list is under `DEEP`. `pmNumbers.ts` calls a builder free by the same list.
`githubClaim.ts` `CLAIM_LIMIT = 4`. `nextThing.ts` `heldTask` already means "taken, with no pull request yet".
`PM_BASICS` (`cli/src/lib/swarmSkills.ts`) says Harness "keeps every builder's list two deep".

**Change.** For each builder, in a project:

- **building** is its tasks whose work is still its own to do: given or taken with no pull request yet, with a
  draft, or with one a reader's HOLD stands on. A task whose pull request waits for its readers or its merge is not
  (`askReaders`' `withReaders`, which the numbers count by already);
- **open** is all its open tasks.

A builder is given a task only when it has none building and fewer than `CLAIM_LIMIT` open. A builder with nothing
building is free now, whatever it has in review. The numbers call a builder free by the same rule: one with nothing
building and `CLAIM_LIMIT` open is given nothing, and is not counted, as today (its PM cannot end that wait by
opening tasks). `DEEP` goes, from every reader of a list: `readProblem`, `nextPicks`, the plan's gate in
`githubAssign.ts`, `openWaiting` and `readerFor`, and `pmNumbers.ts`. `experiment.mts` calls `nextPicks` with a depth
and builds its own read: it is this package's proof, and is kept running. `PM_BASICS` says what is true, and its
entry in `docs/prompt-rules-audit.md` follows. Until package 11 this is for each project: a builder of two public
projects holds one task building in each.

**First.** The test that shows the fault: a builder with two tasks whose pull requests wait for a read, and a free
sized task. Today nothing is given. If that test passes on `main`, the fault is not there: stop and say so.

**Proof.** Specs; the gate; `experiment.mts` (`solver` against `solver1`); the scoreboard the week after.

**Watch.** A pull request names its task by "Closes #N" or by its branch (`tasksOf`). One that names none leaves its
task building for good; the quiet ask after four hours is what catches it today. More changes in flight for each
builder may raise conflicts: the scoreboard says.

### 3. A task waits for what it depends on

**Built** (#4121): in `cli/src/superTabs/assign/crew.ts` (`readProblem`: `up`, `bases`, `looped`; `builtOn`),
`githubAssign.ts` (`askReaders`, the line that gives a task), `nextThing.ts` (the "Next:" line) and `githubMerge.ts`
(`earlierPull`). *It also waits while that builder holds four or lacks what the task needs. A task a builder holds
already is planned as before. Tasks whose "after" lines wait on each other are named to their PM. The merger gained a
rule: a pull request does not land while another open one of the team's is for a task its own task comes after. Built
on #B at one head, then #B held by a reader and fixed with a push, the second carried #B's earlier commits alone,
`carriedPull` found nothing, and the held code would have landed through it. The `stacked` note says which pull request
it waits for and no more: it said "then update it from main", and on GitHub a builder did, for a stack of three: three
pushes and runs of the checks, a note and a read more. The trial: by a merge commit the second landed with nothing done
by anyone; a squash under a stack merged clean. Package 4 is stopped (GitHub answers `behind` before `blocked`), so
where the base requires up-to-date branches the second is still told to update once it is behind.*

**Why.** A task that says "after #B" is given as soon as #B is taken, before #B has any code.

**Today.** `assign/crew.ts`: `dependsOn(body)`; in `readProblem` a dependency this plan does not hold (a taken task)
is dropped: "is not waited for here". And `nextPicks` gives a task while what it waits on is still free: of #1 and
#2 "after #1", both free, with two builders, both are given in one pass.

**Change.** For a task that names an open issue #B of the same repository:

- #B has an open pull request, not a draft, by a builder of the team: the task may be given only to that builder, and
  the line that gives it, and the line typed to the agent, say to build it on that pull request's branch;
- #B has no pull request yet: the task is not planned;
- that builder is away (stopping, down, out of quota), or two things it waits on are with different builders: it
  waits until they land;
- #B is closed: nothing to wait for.

**First, on GitHub.** In the scratch repository, land a stack through the real train: #B, and a change built on
#B's branch. The merger holds a change that carries another open pull request's commits (`githubMerge.ts`
`carriedPull`, its `stacked` note). See that the second lands after the first with nothing done by hand when the
train lands by a merge commit, and record what a squash does. Two cases to name in the record: in a quiet repository
#B is the only ready one and holds the base's tip, so it lands alone and squashed, and the second then carries
commits the base lacks; and where the base requires up-to-date branches the second is `behind` once #B lands, which
package 4 lets ride.

**Proof.** Specs in `crew.spec.ts` and `githubAssign.spec.ts`; the trial's record; the gate.

### 4. Behind is not a reason to rework

**Stopped** (#4085, a draft with the `hold` label), as "GitHub's behaviour is checked on GitHub" says. GitHub answers
`behind` before `blocked`: in two public repositories with up-to-date branches and a required review, every open pull
request behind its base read `behind` (14 of 14 in one, each with its review still required; 6 of 6 in the other, one
with no approving review and two required checks that never reported). So "only behind"
cannot be read from `mergeable_state`, and a change the repository's rules block would ride the train after the next
landing. Waits for anh Dee: drop it, or let a behind change ride only where the base's rules, read from GitHub, are its
checks and up-to-date branches alone. Where the base asks no up-to-date branches GitHub says `clean`, and the train
already carries such a change.

**Why.** Each landing puts every other change behind `main`; each is then told to update, rebuilds and runs CI again
(its READ-OK carries over a plain update: `sameChange`). On this repository `main` took up to ten landings in an
hour.

**Today.** `githubMerge.ts`: a pull request whose `mergeable_state` is `behind` is told `behind` and is not ready.
`nextThing.ts` types "Your … is behind …: merge … and push" to its builder. The train builds on the base's tip and
merges each rider there (`githubTrain.ts`), so the train's own pull request is never behind.

**Change.** A pull request whose only obstacle is `behind` is ready for a train. It never lands alone that way: the
path that lands one alone already asks that it hold the base's tip. A second path lands one alone and asks nothing:
a fork's pull request GitHub does not take into a train (`build`, then `mergeAlone`). A behind one must not reach
it: GitHub refuses it, and the repository's pass stops (`FORK_REFUSED`). Its builder is told nothing, and the
`behind` note and its typed line go if nothing else uses them.

**First, on GitHub.** In the scratch repository, with "Require branches to be up to date before merging" on: a rider
behind the base shows `behind`; a train carrying it lands; GitHub marks the rider merged.

**Proof.** Specs in the merger's and the train's; the trial's record. The scoreboard's count of changes told they
were behind goes to none by construction: it proves the release, not the change.

**Watch.** The reviews of #3909, #3974 and #3995 found ways to land unread code through a forged train or a moved
change. No check they added is loosened: a READ-OK on the head that rides, riders' heads fixed when the train is
built, a tip the train itself marked.

### 5. An area is its label, however it is spelled

**Built** (#4093): `partOf` in `cli/src/superTabs/assign/crew.ts`. *Also: `githubAssign.ts` makes no `part:` label for
an area the repository already has one for in its own spelling.*

**Why.** `part:Backend` and an agent's "Works on: backend" do not match; the label's side is compared as written.

**Change.** A `part:` label's value is read through `areaOf` wherever an area is read (`assign/crew.ts`: a task's
part, `contextOf`'s keys). Words that differ ("backend engine" and "backend") stay two
areas: mapping them is package 13's.

**Proof.** Specs; the gate.

### 6. Disk

**Not shipped.** Measured: the sweep's folder held 29 worktrees (21.6 GB); 116 more that agents made (56.4 GB) are
outside it; and its idle week never ended, as `git gc` rewrites every reflog. A first build (branch
`cli-worktree-disk`) freed dependencies and build output in idle worktrees; its review said hold: it deleted a folder
no rule names whenever each file in it was ignored on its own (`.env`, keys, a local database), and `build` is a name
people give their own folders.
The rule to bring anh Dee again: only `node_modules`, `.dart_tool` and `.next`, only where a `.gitignore` rule names the
folder itself, and the review's other findings closed first.

**Today.** Nothing removes a worktree on a timer: the workspaces service's sweep (`cli/src/lib/worktreeSweep.ts`, a
worktree Harness made when no live or stopped harness works in it, nothing is uncommitted, it was untouched for a week,
and no commit is only there) is gone since #4166, as it removed worktrees their person chose to keep. Cleaning up is
the person's, from the app (#711: #4167, #4168). On anh Dee's computer 114 worktrees of this repository hold 109 GB.

**First: find out why they stay.** For each kept worktree, which condition keeps it: a stopped harness, a week not
yet gone, something uncommitted or untracked, a commit only there. Count them and their gigabytes. Reading only: run
nothing that removes on his computer.

**Then the smallest change the numbers ask for.** Show anh Dee the rule in three lines before it ships: it removes
files. Likely candidates:

- in a worktree idle for some days, free what git ignores and a build remakes (dependencies, build output), and keep
  the checkout;
- remove a worktree whose branch has landed and which is clean, though a stopped harness could be resumed there.
  Landed as GitHub says: its pull request is merged, or was closed by a train that landed. A squash leaves git
  nothing to tell by;
- make a new worktree a copy-on-write clone of a warm one, so dependencies cost nothing until they change.

Any removal is priority 2 (data loss) if it is wrong. It is tested on fixtures on macOS, Linux and Windows, says what
it removed, and never forces.

**Proof.** The same count after the change, on the same computer; a fixture for each condition that keeps a worktree
and each that lets it go.

### 7. CPU

**Built** (#4150): the share, `swarmLaunch` in `cli/src/superTabs/inCore/launch.ts`, given as `HARNESS_CORES` at a
Swarm agent's first launch (`core/agents/create.ts`) and every relaunch (`lib/launchOverrides.ts`); this repository's
CLI suite takes half of it, never more than the machine has (`cli/src/testing/suiteWorkers.ts`). The plan counts no
cores (`assign/crew.ts` `SIZES`): the smaller way to settle the mismatch, as a check when a task is taken needs
package 16's offer. The study:
[docs/research/2026-11-11-agents-share-cpu.md](../../research/2026-11-11-agents-share-cpu.md). *Measured on one Mac of
16 threads: four runs at once of an eighth of the CLI's unit suite, each sized to the machine, failed 12 of 12; at half
a share 16 of 16 passed, taking 1.5 to 2.7 times as long. Not built: a lower priority (`nice -n 10` did not stop four
at once failing; macOS's background policy kept the person's own work quick and the runs failing) and the system's
controls on Linux and Windows (not tried). Agents started at the same moment count each other; each share is said in
the daemon's log, in counts. An agent keeps the share it was started with until it is relaunched.*

**Today.** Nothing limits what an agent's tools take. Each test runner sizes its workers to the whole machine (the
CLI's suite to half its cores, Desktop's to at most 12), whatever else runs there. And the plan keeps a machine
within its cores, but nothing checks cores when a task is taken: the design's "one mismatch".

**First: measure.** Several agents running this repository's unit suite at once on one computer: wall time and
failures, against one agent alone.

**Then find what cuts it**, by trying, on macOS, Linux and Windows: a share of the cores given to each agent through
the variables tools read for their workers; a lower priority for heavy runs under the person's own work; the
system's own controls for a group of processes. Write it up in `docs/research/` with the numbers. Then build the
smallest change that shows a gain, where a Swarm's agent is started (`superTabs/inCore/launch.ts`): a regular
session's launch is not changed. And settle the mismatch: the daemon checks cores as a task is taken, or the plan
stops counting them. No engine's own setting is changed.

**Proof.** The same measurement after the change, against before.

### 8. Hot files

**Built** (#4177): in `cli/src/superTabs/scoreboard.ts` (the files of the conflicts), `pmNumbers.ts` (the list kept
with the project's record, and the PM's clause) and `githubMerge.ts` (`near`, `tellNear`). *The list is kept with the
day's post's record and read nowhere else: a day with no post, or whose files were not read, keeps the last one. A
conflict's files are counted from when its task was given or taken (its branch is made then), else from its opening,
to its own landing: a conflict found as a train is built is with a rider that lands after the note, and the riders of
one train landed together. The PM's clause is said once for each list. The note promises no order ("#12 already
touches `F`, which most changes touch: read it before you change that file again"): the train lands changes that do
not conflict together, and tells a real conflict to its author. It is said once for each pull request, as it opens or
as such an overlap first shows (the list is named once a day, a draft becomes one up), and names the oldest three of
other builders' on their way to land (no draft, not on hold) and how many more. A files read GitHub does not give is
taken as none for that head, and said in the log: a note is no reason to stop landing. The third use is not built:
with no hold, a task given on another's branch names no "after #N", so nothing makes it wait for that one, and held
code that was fixed there with a push would land through it.*

**Why.** A quarter of this repository's landings touch one file, and three more files a seventh or more each.

**Change.** The scoreboard's list of hot files (package 1) is used three ways:

- the PM is told it when work runs short, in one clause, so it can cut tasks that split those files by feature;
- a pull request that touches a hot file another builder's open pull request already touches is told so once, when
  it opens: which pull request, which file, and that it lands after it;
- a task whose own text names a hot file is treated as waiting on the open change that touches it (package 3's
  rule) when one builder's open changes touch it: it goes to that builder, on that branch. When several builders'
  do, it is given as any task, and told of them when its pull request opens (the line above).

A file is matched by its path as written. Nothing guesses what a task will touch.

**First.** The scoreboard's count of conflicts gains the files: the ones a change told it conflicts shares with what
landed since its base.

**Proof.** Specs; the gate; the scoreboard's count of conflicts on those files.

### 9. Trains

**First.** A week of the scoreboard's causes for trains closed without landing, on the first project the new train
runs on. On this repository 65 of 215 were closed, but those were batches made by hand and the server's old train of
6 and 7 November; the new train has not run here. The reasons sampled there were a larger batch replacing a
smaller, a conflict with `main` in a hot file, a rider held, and a rebuild on a moved `main`.

**Then, for the causes the week shows**, the smallest of:

- a rider held or changed mid-run is dropped and the next train is built at once without it, if today's does not
  already;
- the rest of a run lands when a rider is dropped, where today the run is lost and the next train starts again;
- riders are ordered by risk (the size of the change, and the record of its class, which is its `part:` and `size:`
  labels together, of breaking a run), so a failed run's halves find the risky one sooner;
- no new task is given while more changes are in flight than the land path can carry in two hours (the riders a
  landed train carries there, at most the twenty a train takes, × its runs an hour × 2), with a floor of one task a
  builder. From capacity, never from what landed: what a lane
  landed in its usual time is only its own average, and used as a ceiling it ratchets down.

If the week shows the losses come from landings beside the train, say so to anh Dee: that is a project's rule, not
code.

**Watch.** As package 4: nothing that decides what may land is loosened.

**Proof.** The scoreboard's trains closed without landing, by cause, the week after against the week before.

### 10. End-to-end tests across machines

**Designed** (#4114, a draft held for anh Dee): the design and a first slice: a project's suites file, a shard's
result said by command as a commit status, and a suite's status read as a check. The next slice runs a train's code on
people's computers, in their name, with no sandbox: his to decide. Found by its red test: a train with any one commit
status on its tip and no check of its own lands on what CI never ran. Main still has it (`checksOf` in
`githubMerge.ts`): one green status from any bot lets a train land before CI starts. That draft closes it for `suite:`
statuses only.

**For private teams.** An open project needs the sandbox first, which was set aside on 11 November.

**Design first**, in the pull request's Design section:

- the project says in its own repository which commands are a suite's shards (the project owns its process);
- a shard goes to a machine as a task does today, by what its daemon last reported (its tools, its cores and
  disk), and is checked on the machine itself once package 16 has landed;
- it runs once for a train, on the train's exact commit, and its result is a commit status there, in the name of the
  person whose computer ran it;
- a result is kept for the source it ran on and not run again for the same tree;
- only for a repository that is private and whose members are its collaborators; never for a fork's code.

**Proof.** A suite of this repository that CI does not run, split over two computers: wall time against one.

### 11. One view of an agent across a Swarm's projects

**Why.** Every regular agent builds for every public project of its Swarm, and each project plans on its own PM's
person's computer, without seeing the others.

**First: the options, for anh Dee, in a page.** (a) Each allocator reads its builders' open tasks in the Swarm's
other repositories it can read. (b) The server, which knows the roster, says how many tasks each agent holds. (c) An
agent builds for one project at a time, as its person chooses. With what each costs in reads, in server state, and
in what a person must do. Then build the one he picks.

**Proof.** Specs; on a Swarm of two public projects, a builder holds one task building across both.

### 12. Tokens for a task, and the cost on a landed change

**Built** (#4109, the server's half, released in `v1.4.80_backend`; #4143, the daemon's):
`backend/src/superTabs/taskTokens.ts` and its two routes, kept 90 days; `cli/src/superTabs/taskTokens.ts`, which counts
each agent's tokens on its person's own computer, between the boundaries its turns' ends and its commands show, and
writes a row as a piece of work stops. *The landing comment says its builder, model (as code), minutes, tokens and fix
rounds on a private repository only (GitHub's `visibility: private`; an internal one is read by its whole enterprise);
on a public one it says none of them, and the rows stay on the server for the project's members (anh Dee's call, 12
November). Not built: the window's percent at each boundary (package 15's), and the tokens in the day's post.*

**Why.** No saving can be claimed, and no model or price chosen, without it. Each daemon counts its conversations'
tokens by model and kind (`cli/src/lib/agentTokenUsage.ts`); nothing ties a count to a task. The server's cost
record was removed with v3 on 10 November (#3908, #3917): read what it was, and say what is different here.

**Design first.** A task's boundaries are known to its builder's own daemon: taken, its pull request up, each fix,
landed; a read from its ask to its verdict. The count at each boundary gives the task's tokens, and the window's
percent at each gives what it spent of a subscription (package 15 uses that). The count is made on the builder's
person's own computer; what leaves it is the totals. A builder holds one task building and up to three in review
(package 2), and a fix on one in review interrupts the one building: a boundary is taken at each switch, and a
turn's tokens belong to the task it was typed for. Kept as a row on the Swarm's server
with an expiry, seen by the project's members, as its verdict records are (`backend/src/superTabs/githubComments.ts`).
The comment Harness posts when a change lands carries that change's totals: its builder, model, minutes, tokens and
fix rounds. On a public project that line is public: name it in the pull request for anh Dee.

**Proof.** Specs on both sides; the Design lines; a day of our own Swarm with tokens per landed change in the post.

### 13. Jev for a task's area

**First: is it right?** Its answers for a few hundred of lampOS's closed tasks, against the area their changes
touched. Ship it only if it is right more often than the label the task had.

**Then.** On the PM's person's daemon, when a sized task's area is missing or is no builder's, Jev is asked once
which of the project's own `part:` labels fits (kept by the task's text, so not asked twice), its answer taken only
when it is sure, as the ⌘B router takes it (`cli/src/lib/routeDecide.ts`), and written on the issue as the label with
one line saying so. The same for an agent's "Works on:" words. Bounded calls a day for a project. It uses the client
and route that exist (`cli/src/lib/jev/jevClient.ts`). Without an answer the PM's label stands. The hosted route
caps each account's calls for ⌘B (`backend/src/routes/jevRoute.ts`: a person presses ⌘B, a loop does not): the
bound on calls a day stays well inside it, and the pull request says the share it takes.

**Proof.** The check against lampOS's history; specs; a day of the labels it wrote on our own public project, read
by hand.

**Public repositories only**, until anh Dee decides for private ones: a task's title and text go to Jev.

### 14. A model for each task

**Designed** (#4113): [the design](model-for-each-task.md), [the tiers experiment's plan and cost](tiers-experiment.md)
and [the mockup of the one screen change](model-choice-mockup.html), kept on anh Dee's word of 12 November ("just take
care of it all"). The code waits for package 12's daemon half: the rule weighs nothing until a class has 20 finished
tasks on a model, from real rows. The experiment is not run now: only 17 of its 50 tasks may qualify, none is sized,
and it would take about 3¼ weeks of his subscription, a fifth of each window kept for him. It runs when 50 qualify, on
his word.

**Read first.** What v3's routing was and why it went: eight designs, removed in #3908. And
`cli/src/engines/claude/launch.ts`: `--model` and `--effort` are for the session (Codex's launch has neither);
`/model` typed in a pane becomes its person's default, so Harness types it only when a person changes a running
agent's model (`claude/modelControl.ts`), never for a task.

**Design first.**

- An agent whose person leaves the model to Harness (a new choice where an agent is added: a mockup and anh Dee's
  agreement before that code) is started for each task in a session with the model chosen. A fix resumes that
  session. A model a person chose is never changed.
- The choice is one pure function of the class's record (package 12) and the price list: the cheapest model whose
  share of changes landed with no hold is within five points of the best, once a class has enough finished tasks;
  before that, the table the server still serves (`routing-policy`).
- It steps up one tier on evidence only: two failed check rounds, a second hold, or twice the expected time. A step
  up is a new session on the same branch, told what failed.
- The top model cuts work, reads risky changes (one that touches a hot file, or whose class has broken a train) and
  takes the steps up.

No state machine, and no authority on the server: that is what v3's designs had.

**The tiers experiment** (fifty closed tasks on three tiers, the project's tests the judge) gives the first table.
Write its plan and cost; it runs on anh Dee's word.

**Proof.** Specs; a week of our own Swarm with tokens per landed change by model, and holds by model.

### 15. A price for a subscription's window

**Built** (#4111): the price, `priceOf` in `cli/src/superTabs/assign/schedule.ts`, counted in the plan's score. *Not built:
a spend learned by class and model, and the 90th percentile, which need package 12's rows from real days. Found, in
the model and by reading the code: the reserve is not kept today, since a task starts when it is given and nothing checks the window as it is taken; that
check is package 16's.*

**Today.** The solver already keeps each window above its person's reserve, with a fixed spend for each size (3, 10
and 25% of a five-hour window). Claude's window is known only after a reply, and is unknown after an hour or a reset;
unknown is never read as unused (`cli/src/services/usage.ts` `claudeReading`; pull request #3468).

**Change.**

- What a task spends of a window is learned by class and model, from package 12's boundaries.
- A task is never started on a window with less room than its class's 90th percentile.
- In the plan's cost a task's spend counts at the window's price: nothing where the window would lapse unused
  before its reset, more as the need until the reset nears the room.
- Unknown stays unknown.

**Proof.** Specs; the model, given windows (it has none today: its problem has no accounts and no spend); and the
critique's case, three to eight large tasks a window, shown not to swing.

That only the price leaves a person's computer waits for package 16: today the plan reads the percentages.

### 16. Offers accepted on the agent's own computer

**Begun**: the server's half (the offer record), not pushed.

**Why.** A machine takes work only when it has the room, checked where the truth is; a person's quota need not
leave their computer; a label is set by the one who does the work.

**Design first.** The server ships first, and clients of the last 30 days keep working.

- **One writer stays.** The coordinator is the PM's person's daemon, as today. No other daemon takes its place, and
  no agent pulls from an old ranking.
- **An offer is a record on the server**: one live for a task at a time (the server refuses a second), with an
  expiry. That record is the referee: GitHub labels cannot be set "only if unset".
- **The agent's daemon** checks its machine and its window, then takes the task in its person's name. `take` is let
  through by a live offer for that agent, where today it asks only that the builder's label is on the task.
- **Declined or expired**, the task is offered again.
- **A daemon that does not speak offers** is given tasks as today, until the date that can go.

Then the quota percentages come out of the machine's report, and package 15's price is what leaves. It is no
workflow in server code (the plan's "Not built"): the server referees one record and decides nothing.

**Proof.** Specs on both sides; the journey on the real backend with an older daemon beside a newer one.

**Review for** a task given twice, a task never given, and an offer forged by another member.

## Research, alongside

- **An area's worth.** *Study done; the learning discount removed, "Works on:" kept* ([the study](../../research/2026-11-12-area-worth/README.md)): in lampOS's record a
  builder was 1.12 times as fast in an area it had landed work in (0.85 to 1.49), and held no less often: no
  measurable difference. Neither the planned threefold spread nor the 40% learning discount is supported. anh Dee
  left the call to the session building this on 12 November. *Removed*: a builder is no quicker in a part for the tasks it finished
  there. The plan took 0.85, 0.70 and 0.60 of its time after 1, 2 and 3 or more; the record has 0.83, 0.93 and 0.90,
  each interval holding 1. Keeping a part's tasks on the builder that did them before gained no speed, drew more holds
  there (2 points a doubling) and left other builders idle. `readProblem` counts no closed issues by part, and the line
  that gives a task no longer says "it finished 2 part:api tasks". *Kept*: `FOCUS` and `AWAY` in `assign/crew.ts`, a
  person's "Works on:", a strong pull as before. It is a person steering their agent, which the study could not test (5
  role files named an area), and at 1.0 it would steer nothing. *The experiment* takes the study's estimate, 1.12, between a
  builder's own area and another, where it assumed two ([its rows under both](README.md#an-areas-speed-from-the-study)): one
  ahead still gains (4% on the light day, 14% on the heavy one), and if a named area is worth no more than a practised
  one, the kept guess costs the rule 6% and 13%.
  Asked: from lampOS's record on GitHub, read only: is a builder faster, or held less, on its later
  tasks in an area than on its first? Method and numbers in `docs/research/`. Then the experiment's assumed twofold
  speed, and the product's own guess (`FOCUS` and `AWAY` in `assign/crew.ts`: threefold), were to be replaced by what
  was found.

An idea beyond these packages goes to anh Dee as a proposal.
