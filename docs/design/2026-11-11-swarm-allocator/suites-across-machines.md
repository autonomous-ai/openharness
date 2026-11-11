# Suites across machines

Status: **designed 12 November. Its first slice is built; the part that runs code on people's computers waits**
([slices](#slices)). Package 10 of [the allocator](BUILD.md). For private teams only.

anh Dee, 11 November: "end to end testing with runners … takes forever on one machine." CI splits its suites over 4,
6 and 8 runners by recorded durations. The suites CI does not run (Desktop on macOS, the coverage gates, VM tests) run
on one computer, in turn. A Swarm has many people's computers.

## In short

1. **The project lists its shards** in `agents/SUITES.md`: a row for each, with its name, what its computer needs,
   and its command. The file is read at the exact commit it is for.
2. **The PM's person's Harness gives each shard to a computer** as it builds a train, by what each computer last
   reported. One comment on the train says who runs what.
3. **That computer's own Harness runs it**: the train's exact commit, in a folder of its own, as its person, one
   shard at a time, for 30 minutes at most.
4. **The result is a commit status on the train's tip**, `suite: <shard>`, in the name of the person whose computer
   ran it. The train already waits for a status and stops on a failed one.
5. **A computer that is away costs nothing.** A shard no computer took is not run for that train, and the train says
   so where it says it landed.
6. **Only in a private repository, and never for a train that carries a fork's pull request.** A computer runs a
   shard only on the word of the project's coordinator, which the Swarm's server vouches for.

Built so far: lines 1 and 4, by hand. The file is read; a person or an agent runs a shard and says its result with
one command. Nothing built so far runs code on anyone's computer.

## What is measured, modelled and assumed

Measured, in this repository:

- Desktop's VM suite on one Mac: 6 min 51 s for 526 files, 8 workers, 16 logical cores, on 2 October
  ([record](../../performance/2026-10-03-desktop-vm-runner.md)). The suite is 954 files today, 6,735 s of file time
  on CI's Linux runners (`scripts/desktop-test-durations.json`). Nobody has recorded today's suite on a Mac.
- 517 landings in 7 days, 2.9 pull requests a landed train, 65 of 215 trains and batches closed without landing
  ([the design](README.md)). So about 36 trains a day.
- A train waits 90 minutes at most for its checks. Its checks count as passed 3 minutes after its tip is first seen,
  at the earliest. GitHub news reads a repository every 20 seconds. A computer is down after 45 seconds without a
  report.
- On GitHub, tried on 12 November: a commit's combined status does not say who set each status; the list of its
  statuses does. A commit is found by 7 digits of its id, and answers with its whole id and its tree. A file is read
  at a commit.
- In the train's own spec, before this change: a train with one status on its tip and no check of its own landed. Any
  status read as its CI having started ([the train](#the-train)).

Modelled:

- Wall time over two computers is the slower half plus the time to take the ask (20 s) and check the commit out.
  One computer runs the halves in turn. From CI's file times, today's Desktop suite with 8 workers is about 14
  minutes on one computer and 7 on each of two. A Mac is not CI's runner: the proof measures it.
- Writes to GitHub a day ([below](#writes-to-github)).

Assumed, and checked by the proof:

- That a second computer has the toolchain and warm dependencies, so a half costs half.
- That a suite's shards do not share a port, a device or an account.
- That a computer which is up takes its shards within the 3 minutes a train's checks need at least.
- That GitHub counts a status as it counts any write when it limits an account.

## The file

`agents/SUITES.md`, in the project's own repository, changed by pull request as any file.

```markdown
# Suites

| Shard | Needs | Command |
|---|---|---|
| desktop-macos-1 | macos, flutter | `python3 scripts/test-desktop.py --shard 1/2` |
| desktop-macos-2 | macos, flutter | `python3 scripts/test-desktop.py --shard 2/2` |
```

A row is a table line of three cells whose third is a command in backticks. Any other line is none.

- **Name**: 1 to 60 of lower-case letters, digits and `. _ - /`, a letter or digit first. A name is typed in a
  command and is part of a check's name on GitHub, so it is never free text. A name written twice counts once.
- **Needs**: none, or up to 8 words with commas between, each of letters, digits and `_ . + -`. They are the words
  `needs:` labels use: `macos`, `linux`, `windows`, `gpu`, a tool the computer reports. Read in lower case. A
  computer reports seven tools today (git, node, npm, flutter, gh, cargo, python3): a need for another is met by no
  computer until its report names it.
- **Command**: words of letters, digits and `_ . / : = @ % + , -`, with spaces between. It is run without a
  shell, so it runs the same on macOS, Linux and Windows. Quotes, pipes and variables go in a script of the
  repository, which is read and landed as any change.
- **Bounds**: 20 rows; a line of over 1,000 characters is no row; a file GitHub does not send whole (over 1 MB) has
  none. Read in time by its length, as the goal file is.
- **Where it is read**: at the commit it is for. A change to the file takes effect on the train that carries it, with
  the code it was written for.

A row that breaks a rule is no row. Today the command that says a result names the rows it could read. The
coordinator will tell the PM once which rows it could not.

## Who gives a shard, and to which computer

One coordinator: the Harness of the person whose agent is the project's PM, where the train is built. It decides
when it has built a train's tip.

It gives no shard when GitHub says the repository is not private, or when the train carries a pull request from a
fork. A project that lists shards lands nothing alone: one ready pull request rides a train of one, so there is a tip
to test.

A shard goes to a computer:

- of a builder of the project's crew, so one that already runs this repository's code for its own person;
- that is up, and whose person is not stopping it;
- whose last report has every need of the row, says it runs shards (a name in the report's `capabilities`, which
  the server takes already), and has the disk a start asks for;
- with the fewest shards of this train so far, then the most cores. Three a train at most, in turn: three times 30
  minutes is what a train waits.

A shard no computer can take is not given. The PM is told once for each cause, not for each train.

The coordinator then writes one comment on the train's pull request: the tip, and each shard with the computer it is
for, named by a short hash of its machine id. Never by an agent's name: GitHub news types a comment that names an
agent to that agent. It records the comment with the Swarm's server as the PM's, as a verdict's comment is recorded.

Once package 16 has landed the comment becomes an offer on the server. The computer then checks its own room before
it takes a shard, and one it declines goes to another.

## What runs on a person's computer

GitHub news already reads the repository's comments on each person's computer. It hands the coordinator's comment to
the runner, a part of the Swarm's service, and types nothing to an agent. The daemon's core is not touched.

Before anything runs, the runner checks, with its person's own `gh`:

- the server says the project's PM wrote this comment, and GitHub says nobody changed it since;
- the comment is on an open pull request of this repository's own train branch, whose tip is the commit named;
- the repository is private, and is a project that an agent of this computer's own person builds here;
- this computer is named, is not paused, and has the memory, disk and tools a start would need.

Then:

| | |
|---|---|
| As whom | The person the computer belongs to: the user its Harness runs as. Never for another person's agent |
| Which commit | The train's tip, fetched from the repository with that person's own git login, checked out exactly |
| Which folder | One folder a project, under Harness's worktrees. Tracked files are the commit's; untracked ones are removed; what git ignores (dependencies, build output) stays, as a CI cache does |
| Which command | The row's, read from the checkout itself. The comment carries names only |
| How | The command's words, no shell, its own process group, hidden on Windows, no input |
| Environment | The person's own path, home and language. None of Harness's variables, no token. Plus the shard's name and the commit |
| Output | A log on that computer, the last megabyte, for the last 20 runs. It is sent nowhere |
| How many | One at a time on a computer: a test runner takes every core |
| Deadline | 30 minutes, then the whole process group is ended |

What stops it: the deadline; its person pausing the computer for the Swarm, which ends the run and takes no more;
Harness stopping. A train that closes does not: the run ends by itself within the deadline.

It is not a sandbox. The command can read what its person can read. That is why this is for a private team: the code
was written by the repository's collaborators and read by another agent, and the person's own agent runs the same
tests under the same login an hour later.

## How the result is said on GitHub

A commit status on the exact commit. Context `suite: <shard>`. The description is fixed words and numbers ("passed
in 12 min"), never the command's output.

| State | Who sets it | When | Built |
|---|---|---|---|
| `success`, `failure` | Any computer of the team, by command | The hand way: `harness super-tab suite passed\|failed OWNER/REPO SHA SHARD` | Yes |
| `pending` | The computer that took the shard | As it takes the ask | No |
| `success`, `failure` | The same computer | The command ended with 0, or with anything else. Past 30 minutes is a failure | No |
| `error` | The same computer | It could not run it: no room, a tool missing, Harness restarted, its person stopped it | No |

Each is set with that computer's person's own `gh` login, so GitHub says whose it is.

The command, as built, refuses with nothing said: a repository that is no project of the agent's; one GitHub does
not call private; a commit GitHub does not know there; a shard the file does not list at that commit. The same
result again is one status. One login says one shard's result on one commit five times at most. Its description
is "passed, said by Pip": the agent that ran the command, so a result said by hand is told from one Harness ran.

**A forged "passed".** GitHub lets anyone who can push set any status on any commit. A member, or a member's agent,
can say a shard passed that never ran. A private team accepts that:

- every collaborator can already push any branch and set any status, and GitHub's own check box believes them;
- GitHub keeps who set each status;
- what it risks is a break landing. It runs no code anywhere and shows nobody's files;
- before this, these suites held no landing at all.

An open project cannot accept it. There a result counts when computers of different people agree, each in a sandbox.
Neither is built.

## The train

It reads a suite's status as it reads every status (`githubMerge.ts` `checksOf`): pending waits, a failure closes
the train as red, a success passes. Two lines are new, one built and one that waits:

- **Built: a suite's result is never the repository's CI having started.** The train does not land a tip that has
  no check of its own while its riders had theirs: Actions can take minutes to make a run. Any status on the tip
  ended that wait. A shard that passes in a minute would have landed a train its CI never ran. Now a `suite:` status
  counts as a check and not as CI. A status a collaborator sets by hand under another name still ends the wait: that
  is the train's to close.
- **Waits: `error` under `suite:` is "not run"**, and counts for nothing. It comes with the runner, which is the
  only thing that says it.

## Away, slow, or lying

| The computer | What happens |
|---|---|
| Is down when the train is built | It is not chosen. Its report is 45 seconds old at most |
| Goes away before it takes the ask | Nothing is pending, so the train does not wait. The shard is not run for this train. The note that says the train landed names it |
| Has no room, or lacks a tool after all | `error`, with the numbers. Not run for this train |
| Takes it, then sleeps | The status stays pending. The train closes after its own 90 minutes and is built again; the computer is down by then |
| Is slow | Past 30 minutes the run is ended and fails. A slow computer and a hung test look the same, as on CI |
| Restarts Harness mid-run | Its runs in flight are kept in a small file. At its next start each is said `error` |
| Says passed without running | The forged pass above |
| Says failed wrongly | The train is red and splits, as for any failed check. GitHub shows whose computer said it; its person pauses it |
| Records the coordinator's comment as its own before the coordinator does | The server keeps the first record, so no computer takes the ask. Nothing runs, and the shards are not run for that train |

A shard that is not run can let a break land. The next train then fails on it, and its riders are told their train
failed. That is how a broken main looks today. The day's numbers count trains that landed with a shard not run. If
that count is not near none, the train should wait for every row: a decision for anh Dee, below.

## A result kept for its tree

A result is kept where it was said: on the commit, by GitHub.

- The same result said twice for a commit is one status. Built.
- A train built again with the same content has a new tip and the same tree. The coordinator compares the new tip's
  tree with the trees of the three trains it closed last. Where one is the same, a shard that passed there is not
  given again, and the comment says which commit it passed on. A failure is not carried over: a red train's riders
  never ride again as the same tree.
- A train landed as a merge commit leaves main with the tip's tree. Its results are main's.

## Writes to GitHub

Each thing is said once, when it changes. Nothing is written on a timer.

| Who | What | How many |
|---|---|---|
| The PM's person | One comment a train that has shards to give | About 36 a day here |
| Each computer's person | Two statuses a shard it runs: taken, ended | 4 shards and 36 trains: 288 a day, over all the computers |

Stuck cases:

- No computer answers: the comment, and nothing else.
- A shard always fails: each rider fails alone once and rides no more until it changes. The writes end with the
  riders.
- A computer takes a shard and hangs: one failure, at its deadline.
- Harness restarts in a loop: one `error` for each run in flight, once.
- The hand command sent again and again: the same result is one status, and five is the most for a shard on a
  commit.

GitHub keeps at most 1,000 statuses for one context on one commit. A run adds three at most.

## Every way this could run code where its person did not mean it

| The way | How it is closed |
|---|---|
| A stranger's code: an open project, or a fork's pull request | Private repositories only, by GitHub's own word. A train with a fork's rider is given no shard |
| A commit no train built: any branch a collaborator pushed | The runner acts only on a comment the server records as the PM's. Only the PM's person's own Harness can record one, and it does so only for a tip it built |
| A typed comment in the same words, or an agent told to post one | The same record. An agent's commands record only comments that begin in their own fixed words; a comment changed after it was written is refused |
| A command that is not the repository's | The comment carries no command. The command is the row's, at that commit, as words with no shell |
| The wrong computer, or one outside the project | A computer runs only what names it, for a project its own person's agent builds there |
| Another person's work under this login | Never on a computer for another person's agent, nor as a guest |
| More than its person lent | One at a time, 30 minutes, the memory and disk a start needs, and Pause |
| After its person said stop | Pause ends the run; so does stopping Harness |
| An old ask read again after a restart | A run is known by its repository, commit and shard. One with a result from this login is not run again, and the train must be open |
| The checkout itself | Git's hooks are the clone's own, never the commit's. Submodules are not fetched |
| The command that says a result (built) | It runs nothing |

Two are not closed, and are named:

- **The PM's person.** Their computer lands every change already. They are the team's root of trust.
- **A teammate's change read by that teammate's second agent.** It lands that way today, and then runs on every
  teammate's computer at their next pull. A shard runs it one train earlier.

## Data and design

For the whole design:

- **Growth.** Nothing new is stored on the server but one comment record a train, in the collection that holds
  them, which expires after 90 days. On GitHub: statuses, which are the commit's; one comment on a pull request that
  closes within hours. On a computer: one folder a project, removed by the sweep that removes idle worktrees; the
  runs in flight (20 at most); the logs of the last 20 runs.
- **Concurrency.** One coordinator writes the comment; one train is open at a time. A computer runs one shard at a
  time. A run is keyed by repository, commit and shard, so the same ask twice is one run.
- **Read cost.** The coordinator reads the file once for a train it built, and three commits for a tree. Nothing
  each pass. The runner reads nothing until GitHub news hands it a comment.
- **Scale.** Ten times today is 360 trains a day; at 20 shards, 14,400 statuses a day over all the computers and
  360 comments from the PM's person. What warns first: statuses said by one person in an hour, and GitHub's own
  refusals, which stop a pass by name today.
- **Compatibility.** The server does not change. A computer says it runs shards in its report; one that does not is
  never given one. An older daemon's GitHub news does nothing with the comment: it names no agent. The file is a
  contract: it is only extended.
- **Migration and rollback.** Nothing to migrate. Rolled back, the coordinator stops giving. An `error` status on
  an open train's tip then reads as failed: one train closed red, once.
- **Audience.** The repository's collaborators, as GitHub enforces it. A log never leaves its computer. The server
  gains ids only.
- **Identity.** A shard runs as the person the computer belongs to, and the status is that person's. Never another
  person's login.
- **Failure.** Each has a name and a place it is seen: not private, no computer for a shard (the PM, once), not run
  (the status, with why), past its deadline, restarted, a comment the server does not vouch for (that computer's
  log).
- **Platforms.** Below.

For the slice that is built:

- **Growth, concurrency, scale.** It stores nothing. One call reads GitHub four times and writes one status, on a
  person's command. Two of the same command at once are one.
- **Compatibility, rollback.** A daemon from before it answers the command "invalid request". Rolled back, the
  statuses stay on their commits and the train reads them as any status; the train's wait for CI is as it was.
- **Audience, identity.** A private repository's collaborators. The status is the login of the person whose
  computer the command ran on, only for that person's own agent.
- **Failure.** Each refusal has a code and says that nothing was said.
- **Platforms.** The same on macOS, Linux and Windows: it starts no process.

## Windows, macOS and Linux

One way to run on all three: the command's words, no shell. On Windows the run is hidden (`ownProcessGroup()`, never
`detached: true`), a `.cmd` or `.bat` program is found as an engine's is, and the whole tree is ended at the
deadline. Before it ships on Windows the windows of a run are recorded on the signed build, as the Windows rules ask.
The proof is on macOS first: the suite it splits needs a Mac.

## What is left out

- **An agent as the runner.** It costs tokens and its turn, an engine ends a long command by itself (Claude Code at
  ten minutes), and the result would be its word. A program can run a command and read its exit code.
- **A deadline in the file.** Every shard has 30 minutes. One that needs more is two shards.
- **Durations.** The project's own command splits its suite. Harness packs shards by count.
- **A shell.** One way to run on three systems.
- **A check that the status came from the computer it was given to.** A private team does not need it; an open
  project needs more than it.
- **A check that the hand command's caller stands on the commit it names.** The command takes its word, as a
  READ-OK takes a reader's.
- **A new table, a new server route, a new process.** None is needed.
- **A switch for a person to turn this on.** A computer whose person's agent builds a private project already runs
  its tests. Pause stops it. This is a decision for anh Dee, below.
- **Output on GitHub.** Test output can hold a secret. The author runs the row's command to see it.
- **A starter file**, as the goal has. The format is above.

## Slices

1. **Built: the file, the command that says a result, and the train's line.** `cli/src/superTabs/suites.ts` reads
   the rows. `harness super-tab suite passed|failed OWNER/REPO SHA SHARD` (`githubSuite.ts`) says a shard's result
   on the exact commit, as a verdict is said. `checksOf` no longer reads a suite's result as CI having started. It
   runs nothing. It can hold a landing (a failure is a failed check) and can make nothing land. A person or an agent
   runs the shard by hand.
2. **Waits: the ask and the runner.** The coordinator's comment, the runner, the `error` line in `checksOf`, the
   train of one, and the numbers. This is the part that runs code on a person's computer. It ships after a review
   that hunts for the ways in the table above.
3. **Waits for package 16: the offer.** The comment becomes an offer; a computer declines what it has no room for.
4. **Not built: an open project.** A sandbox, and agreement between computers of different people.

## The proof's plan

**The suite.** Desktop's VM tests on macOS, which CI runs on Linux only
([what PR CI does not run](../../validation-and-release.md#what-pr-ci-does-not-run)): `make desktop-test`, which is
`python3 scripts/test-desktop.py`. The one recorded time on one Mac is 6 min 51 s for 526 files on 2 October. Today
it is 954 files; the time on one Mac is the proof's first number.

**The split.** Two rows, `python3 scripts/test-desktop.py --shard 1/2` and `--shard 2/2`. The script splits the files
by measured time, longest first onto the lighter half, so the halves are even.

**The run.** One commit. One computer runs both halves in turn; then two computers run one each, started together.
Wall time is from the first start to the last result. GitHub's time on each status is the end.

**What is not here yet.**

- A private repository with this repository's tree. This one is public, and the command refuses a public one.
- A second Mac with the pinned Flutter SDK and the suite's dependencies in place.
- Both computers in one Swarm project on that repository, each person's `gh` a collaborator of it.
- For a run nobody starts by hand: slice 2.

With slice 1 alone the proof runs by hand: each computer runs its half and says its result with the command.

## Decisions for anh Dee

| # | Decision | I recommend |
|---|---|---|
| 1 | A shard no computer took: the train lands without it and says so, or the train waits | Lands without it, counted in the day's numbers. Make it wait if the count is not near none |
| 2 | A computer runs shards when its person's agent builds the project there, or only after its person turns it on | No new switch; Pause stops it. A switch needs a screen, and a render first |
| 3 | Slice 2 runs code on people's computers | Build it next, with the review the build document asks of this package |
