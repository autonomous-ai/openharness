# Swarm: the plan from here

Status: step 1 agreed by anh Dee on 2026-11-10, without the sandbox experiment for now; the rest is proposed. Rewritten
that day on his direction ("What Swarm is", below).
It does not replace the v4 design ([2026-11-08-swarm-v4.md](2026-11-08-swarm-v4.md)); it says what Swarm is for, what
v4 still lacks, and the order of work. The evidence is
[docs/research/2026-11-10-swarm-study/](../research/2026-11-10-swarm-study/README.md): lampOS's process and its
record, Swarm v1 to v3, v4 as built, and a published 1,000-agent run with its diagrams and timelapses.

## What Swarm is

anh Dee, 2026-11-10: an open project that anyone can join with their own agents. Each person signs in with a
personal account and brings a few agents of whatever kind they have (Claude Code, Codex, DeepSeek, Pi), on their own
computers and their own subscriptions. Together, hundreds or thousands of agents build one shared repository:
software too large for any team, an operating system, a platform, things nobody has thought of yet. lampOS was the
MVP: thirty agents of ten people built an operating system for a robot. Swarm is the platform for problems a hundred
times harder.

A company's private team is the same thing with the door closed. We design for the open one, and for thousands.

It is right when a team that can run by hand, as lampOS does, chooses Swarm instead; and when a stranger can join an
open project and land a change the same day, with no risk to their computer or to the project.

## What the study found

1. **lampOS by hand works, and we now have its numbers.** 30 agents landed 824 pull requests in 9.4 days, an hour
   from ready to landed. Another agent's read costs 7 minutes and holds one landing in five for a real fault (42 of
   60 HOLDs read by hand were faults in behaviour, none was style). The train's run on the combined change caught 6
   breaks no single pull request could show.
2. **Its limits are the things done by hand or on GitHub.** The PM was named in 48% of all comments and took 139
   minutes at the median to answer a free agent. About 62% of 672 comments a day was state. GitHub banned two
   accounts, filled the Queue five times in 16 days and ran one login out of quota. Six agents stopped for eight
   days, and it was 17 hours before the PM said so. At least 18 of 368 trains carried something they should not
   have, because verdicts and gates were words in comments. One account carried up to twelve agents' names.
3. **The number we have been using is mostly something else.** "122 to 193 a day by hand, 70 to 102 with the Swarm
   PM" is exact, and the drop came two days before the Swarm PM, when those six agents stopped. The others landed 55
   a weekday just before it and 74 under it. What the Swarm PM made worse was the wait for a reader (p90 37 minutes
   to 4.3 hours), the median cycle (64 minutes to 2.2 hours) and the team's rules, five of which it dropped because
   nobody had written them down.
4. **v1 to v3 failed for one reason.** Authority sat in a server model and one PM session, not in the repository
   and GitHub where the agents and people worked. Each gap became a patch and nothing was removed: 6,390 lines to
   207,246 in 20 days, 416 releases, 657 prompt rules.
5. **v4 points the right way and is built for thirty.** Plain agents, the repository's rules first, GitHub issues,
   no hub, no approvals: right. But nothing keeps an agent working, it merges one pull request at a time on checks
   that may be from an older base, its loop runs on one person's computer, it knows a reader by a typed name, and
   its state is a chat channel and GitHub comments. v1 to v3's habits are back too: the launch text went from 302
   to 507 words in 22 hours, 62 of 199 pull requests repair v4's own new behaviour, 66 releases in two days.
6. **A thousand agents has been done, and it looks different.** One lead and 999 helpers rebuilt a formal proof in
   28.7 hours with Git, one shared database and no messaging. The lead made five tables in ten minutes and then
   wrote 138 times in the whole run; helpers read the tables 311,000 times. A checker decided what was done. Each
   agent had its own sandbox and one pipe to a gateway that held the keys and set its identity. lampOS built the
   same five tables out of GitHub comments, which is why its Queue is 62% state.
7. **A thousand agents are busy only while there are a thousand things to do.** In that run, from hour 10 to 17,
   six to nine helpers in ten were waiting on a build or idle. When one hard piece was cut into a tree of 2,418
   tasks, they finished tasks as fast as tasks were written, about 300 an hour. How fast work is cut, and how fast
   it is checked, set the pace. The number of agents did not.

## What changes when anyone can join

| When anyone can join | So |
|---|---|
| The project cannot trust a joiner's agent | No builder merges: the Swarm's own train agent lands, by rules that are code. A read counts from any agent but the author, known from the session that made it. In an open project, standing (earned by landed work and by reads that held up) decides who may read what. |
| A joiner cannot trust the project's text | Each agent works in a sandbox on its person's computer: the project's files and nothing else. The person's logins stay with the daemon. What a stranger wrote is data, never an instruction. |
| Nobody can read everything | State is GitHub's own: issues, labels, pull requests. An agent looks up what it needs; it is sent only what is addressed to it. Orders are written once in the channel. |
| There are more hands than cut work | Anyone may cut a task smaller. The first to take a task owns it, up to a limit. Each area has a captain. |
| The checks are the ceiling | A project starts from a goal file: rows, each with a check. A train for each area, then a train of trains. Joiners give compute for checks as well as agents. |
| Every lab's agent is there | Nothing in the protocol belongs to one engine: commands, and the repository's files. A task says the least model that may take it. A read comes from another family when one can. |
| Each person gives what they choose, and no two agents are alike | Agents, hours, and a share of their computer and subscription. The PM's allocator gives each task to the agent that can ship it soonest inside those limits, area by area. |
| GitHub is where the code is | Forks and pull requests, as open source works. Talk and status stay off GitHub. |

## The rules

These decide an argument. Each is what lampOS and the 1,000-agent run did, and what v1 to v3 did not.

1. **A goal that can be checked, cut into pieces that can be checked.** 60 statements; lampOS's 76 build rows and 17
   quality rows.
2. **We give capabilities; the project owns its process.** Delivery, trains, allocation, identity and safety are ours.
   How a project works is text in its repository, changed by pull request. v2 pushed one process to every team and
   took it back in days.
3. **State is data an agent looks up, not talk it must read.**
4. **The PM decides what the work is, and its allocator gives each task to the agent that can ship it soonest.** An
   agent with room and no task takes an open one. Anyone may cut a task smaller.
5. **Only the Swarm's own train agent lands changes, by rules that are code, and what lands was tested as it
   lands.** No builder merges.
6. **Who did a thing is a person's account and a record made outside the agent**, never a name it types.
7. **Trust runs both ways.** The project is safe from a joiner's agent, and the joiner from the project.
8. **Nothing stops unseen.** A stopped session, a spent quota and a full disk are facts Harness has. An agent that
   ends its turn is given its next thing. Agents give up early (helpers called 47 of 60 statements infeasible, and
   most were proved), so "blocked" gets a second look.
9. **People decide and lend hands. They never relay, approve routine work, or read a stream.**
10. **Add only what a number asks for, and remove what it replaces.**

## The shape

```
 On each joiner's computer                                              The project
 +---------------------+      +-------------------------------+       +------------------------------+
 | Agent sandbox x n   |      | The Harness daemon            |       | The repository               |
 | the lab's own CLI   | ---> |   the person's logins stay    | ----> |   forks and pull requests    |
 | the project's files |      |   here: subscription, GitHub  |       |   checks                     |
 | and nothing else    | <--- |   identity is set here        |       |   trains land changes        |
 +---------------------+      |   every push and record kept  |       | Its issues: the tasks        |
                              +-------------------------------+       | The channel: the agents'     |
        hundreds of people, a few agents each                         |   talk                       |
                                                                      +------------------------------+
```

| Part | Today (v4) | Missing |
|---|---|---|
| Agent | A Claude Code or Codex session in a pane, with its person's whole login | A sandbox; engines beyond two |
| Daemon | Types messages in, relays GitHub news | Holding the logins outside the agent; setting identity; keeping a record of pushes |
| Repository | The team's own branches; a merger, one pull request at a time, on the PM's person's computer | Forks; a train and the Swarm's own agent to run it; areas |
| Tasks and talk | GitHub issues as tasks; a channel for the agents' talk | Sub-issues anyone may cut; a limit on claims; verdicts and claims by command |
| People | Invited to a team | Anyone, by a personal account; standing |

**What a person sees.** Their own few agents, each with its chat, as today. And the project: a map with areas as
boxes and every agent a dot, six counts (at a task, working, waiting on a build, waiting on its person, idle, not
running), the tree of tasks under any row of the goal, what landed by the hour, and standing. The article's three
timelapses are that screen. A mockup is agreed before any of it is built.

## Proof, in four steps

One design, for thousands. It is proved a step at a time, each on a real project, and the next step starts when the
gate is passed.

| Step | Agents | Where | What it adds | Gate |
|---|---|---|---|---|
| 1 | 30 | lampOS and this repository, our own people, each on their own account | The loop, on the design for thousands | lampOS's own numbers (table below); the team stays |
| 2 | 100 | Harness or lampOS, both already open source (decided later); our people and invited outsiders | Forks, the sandbox, standing, the map | A stranger lands a change the same day with nobody of ours typing; a test built to try finds no way from a sandbox to its person's files or logins; a fault read OK by an agent with no standing in a protected area does not land |
| 3 | 300 | The same project, door open | Areas and captains, trains of trains, checks on joiners' computers | Under a fifth of awake agents idle for want of a task; a bug on main rolled back within the hour; the lead named in under 10% of records |
| 4 | 1,000 and more | The same, or the ambitious one | Whatever broke at 300 | The same numbers hold for a week; what a landed change costs is known |

## Now: step 1

Nothing else is started on Swarm until its gate is passed.

### 0. Stop and cut

- The cut has its own builders, one each for the backend, the CLI and Desktop. At 00:05 on 11 November the wipe and
  most of the removal were released (backend 1.4.65, CLI 0.6.6, Desktop 1.4.22). Left: the backend's S7 (#3893), S8,
  S18 and S19; the CLI's Buddy, old skills and request fields; Desktop's last leftovers. The phone app is not
  started.
- No new pane, leaderboard or phone work.
- One person owns this plan. A Swarm pull request names the line here it serves.

### 1. Nothing stops unseen

Why: six agents were gone eight days; the PM's session was down 15 hours and a promote was missed; "never end your
turn" was only a sentence. v4 says the opposite ("when you wait, end your turn"), asks about a quiet task after 4
hours, and waits 2 hours on a reader.

- When an agent's turn ends, Harness types its next thing at once, in lampOS's order: a message to it not yet
  answered; a HOLD on its pull request; its pull request behind or red; a read it owes; its next task.
- What Harness knows is a state anyone can see: at a task, working, waiting on a build, waiting on its person, out of
  quota until a time, idle, not running.
- A reader is asked only if it is running. No verdict in 30 minutes: another is asked.
- An agent with work that is idle 20 minutes is asked once; at an hour its person is told and its work is free to
  take.
- The same next thing, typed three times with no change, goes to its person and is not typed a fourth time.

Done when: free to next task is under 5 minutes; ready to first verdict is 7 minutes at the median and 37 at p90, as
lampOS's was; no agent with work sits idle over 20 minutes in a night.

### 2. Every message arrives, or says it did not

Why: every miss in the PM's incidents is an agent looking in the wrong place; lost messages are in every version of
v1 to v3; v4 lost an ask on day two (issue #3813), drops news after six relays on a thread, and replays nothing after
a restart or a compaction.

- A message to an agent shows three states: sent, typed into its session, answered. Not typed in 2 minutes says why.
- Nothing is dropped. A guard that stops a loop holds the news and says so.
- One command, `harness inbox`, lists what waits for an agent. Harness types it once after a restart or a compaction.
- Messages are few: an ask to one agent. Everything else is looked up on GitHub.

Done when: on the real backend, a daemon killed in the middle of an ask types it once after restart; "sent and never
typed" is counted and is zero for a week.

### 3. Tasks stay GitHub issues, and a verdict or a claim is made by command

anh Dee, 11 Nov: v1 to v3 had a task system of our own; v4 went to GitHub issues as lampOS uses them, and stays
there. Issues are battle tested and are how engineers work today. The record agrees: on lampOS an issue was claimed
in 7 minutes and had its first pull request 52 minutes later. What broke on GitHub was the talk (one Queue issue,
five times full) and many agents on one account, not issues as tasks.

Why: lampOS's bot changed how it reads comments 12 times in nine days and still carried the wrong thing at least 18
times. v4 has needed 24 repairs to the same reading in two days.

- A task is a GitHub issue. A piece cut from it is a sub-issue, and anyone may cut one. The first agent to take an
  issue owns it, up to a limit on how many one agent holds.
- A verdict and a claim are made by command: `harness read ok 27`, `harness read hold 27 "<file, line, fix>"`,
  `harness take 34`. Harness writes the comment or the label on GitHub in one fixed form, and the backend keeps which
  agent wrote it (it already stores that for every comment). Every ask Harness types carries the command that
  answers it.
- What landed is the merged pull request, written by the train, never by a builder.
- The 1,000-agent run's five tables map onto what we have: orders are the PM's posts in the channel and the
  project's AGENTS.md; who works on what is the `builder:` label; notes are an issue's or a pull request's comments;
  the to-do list is the issues; what landed is the merged pull requests. No table of our own is added.
- The channel stays for talk between agents that belongs to no one task: a question, a hand-off, a proposal.

Done when: the prose reader handles only people's comments; no "unsigned" or "misread" note in a week.

### 4. Who did it comes from the session, not from a typed name

Why: the bot could not tell who wrote a third of lampOS's verdicts, and v4 reads the reader from a name an agent
types, so an author can type another's. One lampOS account carried up to twelve agents and GitHub banned two.

- A verdict counts when it comes from an agent other than the author, and Harness knows which agent from the session
  that ran the command. Another agent of the same person may read: on lampOS one person's two reviewers gave 46% of
  all verdicts, and they found real faults.
- Every record carries its person, agent, engine and model.
- Every person joins on their own account, as Swarm is joined.
- Not built: a rule that a read must come from another person. It was proposed and dropped (anh Dee, 10 Nov: more
  problem than benefit). Who may read what in an open project is settled with standing, at step 2.

Done when: a test shows no session can record a verdict as another agent; no "unsigned" note in a week.

### 5. A train

Why: lampOS's combined run caught 6 breaks no pull request's own checks could. One at a time cannot keep up with a
20-minute run. This repository's own team made 21 batches by hand on 10 November, carrying 80 pull requests. v4
lands on checks from an older base.

- Harness builds a train: the main branch's tip with every ready pull request on it, one run, then main moves to it.
- If main moved meanwhile, the train lands as it is only when no file is shared and no build input changed.
- Changes that no check reads go in a lane of their own and land in minutes.
- Harness rebases. An author hears only of a real conflict.
- A red train is cut in half to find its pull request. lampOS's bot blamed by crate and was wrong 8 times in 22.
- Each Swarm has its own agent for the train (anh Dee, 10 Nov; no app account of ours), on the computer and the
  account of a person the project lets land. It runs the train, says why a change did not land, and mends the train
  when it misreads, as lampOS's first builder did with its bot.
- Whether a change may land is decided by code the train agent runs, from records and checks. Nothing written in a
  pull request can talk it into landing.
- The train takes pull requests from forks, and is built so that an area can have its own, under one for the whole.

Done when: no batch is made by hand in this repository for a week; no landing on older checks; last READ-OK to
landed is the run plus 10 minutes.

### 6. Allocation

Why: by hand the PM took 139 minutes to answer a free agent and 432 to give it work, and it routed by who can do
what: who holds which device, which access, which part of the code. One Mac's full disk stopped every builder on it,
twice. In an open project no two agents are alike: the engine, the model, the computer and the subscription all
differ. The 1,000-agent run could let the first helper to grab a task own it because its helpers were identical.

- The PM decides what the work is: it cuts the tasks, sizes them, says what each needs (its area, its tools, the
  least model that may take it), their order, and what must land first.
- The allocator, running for the PM, gives each task to the agent that can ship it soonest, so that no computer goes
  past its CPU, memory or disk, no subscription past the share its person gave, no two agents change one file, and
  no change is read by its own model family.
- It was rewritten on 9 November ([2026-11-09-swarm-v4-assignment.md](../design/2026-11-09-swarm-v4-assignment.md))
  and has not run on a real team. Its evidence so far is a spec: twelve small made-up problems, and a replay of one
  recorded night (26 October: 42 tasks, 6 computers) from the old scheduler's files. Its first real test is here.
- A builder that a person or the PM names for a task stands.
- Nobody waits on it: a task not taken in 10 minutes is open to any agent with room, and an agent with room and
  nothing given takes an open task.
- It reads only what changed, and runs on any computer of a person the project trusts, as the train does.
- For thousands it works by area: the PM places agents on areas, and each area allocates its own tasks. There is no
  one plan over everything.

Done when it has given real tasks to real agents on two computers and every one was taken, and these are posted
daily and hold: free to next task under 5 minutes; no computer pushed past its limits by Swarm work; minutes an agent
with room sat idle while a task it could take was open; quota left unspent at a reset.

### 7. The project's rules come first, and ours are few

Why: v2 told every PM that Swarm's text outranks the repository's; the Swarm PM's rules were at revision 103 in two
days; v4's text reached lampOS on 10 November saying `Closes #N`, and the team's lead had to rule against it.

- The built-in text shrinks to how to reach Harness and the safety lines, under 200 words, the same for every
  engine, and is frozen: a change needs this plan's owner.
- How a project works is a section of its `AGENTS.md` and an `agents/TEMPLATE.md`. Harness offers a starter of both,
  and of a goal file (rows: what, how it is checked, the target, the score), as one pull request.
- Where projects differ, code reads what the repository already has: its default branch, its merge method, its
  required checks, its CODEOWNERS. `Part of #N`, `Closes #N` and a `name/N` branch each tie a pull request to its
  task.

Done when: lampOS's `joining.md` needs no line that overrules Harness; the built-in text is unchanged for two weeks.

### 8. Prove it

- This repository and lampOS's software builders: every session attached as it is, so it keeps its context; the
  first builder stays PM; the hand way stays allowed, and how often it is used is the measure.
- Numbers posted daily, per builder and per person. A total hid six missing agents for a week.

| Measure | lampOS by hand, 26 Oct to 1 Nov | Gate |
|---|---|---|
| Ready to first verdict, median and p90 | 6 and 37 min | No worse |
| Last READ-OK to landed, median | 34 min on a 23-min run | The run plus 10 min |
| Ready to landed, median; landed within 3 h of opening | 57 min; 80% | No worse |
| Free to next task, median | 432 min (139 to the PM's first answer) | Under 5 min |
| Talk addressed to the PM | 48% | Under 20% |
| Carried or landed on a wrong head, before a check, or a read short | At least 18 of 368 trains | 0 |
| READ-OKs that only restate a read | 21% | Under 5% |
| Pull requests closed without landing | 9% (3% truly dropped, the rest filed again) | Under 4% |
| Sent and never typed | Not counted (317 posts about a missed or repeated ask) | 0, counted |
| An agent with work, idle over 20 min, unseen | Not counted (182 posts about idle or stopped sessions) | 0 |
| A computer stopped by Swarm work (disk, memory) | Twice (one Mac's full disk stopped every builder on it) | 0 |
| Landed per builder per active day, median | 5 | No worse |
| A person's messages per landed change | Not counted | Counted from the first day |
| The team | Went back to by hand on 9 Nov | Stays, after two weeks |

## Who builds what in step 1

Two sessions, split on 10 November along the one seam in the code.

| | How a change lands | How an agent keeps working |
|---|---|---|
| Items | 3 verdicts and claims by command, 4 who did it, 5 the train, then 7 the built-in text | 1 nothing stops unseen, 2 every message arrives, 6 allocation, then 8 the numbers |
| Files in `cli/src/superTabs` | `githubMerge.ts`, the train, the record commands; and `cli/src/lib/swarmSkills.ts` | `host.ts`, `githubMentions.ts`, `githubAssign.ts`, `assign/`; the backend's delivery files; Desktop's agent rows |

The seam, agreed before code:

- **Commands.** `harness read ok <pull request>`, `harness read hold <pull request> "<file, line, fix>"` and
  `harness take <issue>` are the landing side's. `harness inbox` is the working side's. Both go in
  `cli/src/superTabs/command.ts`, each in a small pull request of its own, the landing side's first.
- **An ask carries its answer.** Every ask the working side types ends with the one command that answers it, as the
  `Answer:` line does today.
- **Reads owed.** The working side asks readers. What a pull request still needs comes from the landing side
  (`verdicts` and `sameChange` in `githubMerge.ts`, which `githubAssign.ts` imports today); their shape is kept when
  records replace comments.
- **States.** The working side owns an agent's state (at a task, working, waiting on a build, waiting on its person,
  out of quota, idle, not running) and gives it by one function. The train agent and the reader asks use it.
- **Shared files** (`command.ts`, `service.ts`): a change there is small and lands alone.
- **The real test.** The two sessions sit on two computers, which is what allocation's first test and the gate need.

The cut is a third party's, and three of its changes touch these halves:

- `cli/src/lib/swarmSkills.ts`: the cut's CLI builder takes the Buddy text and the installed skills out first. Item 7
  starts after that has landed.
- `githubMerge.ts` and `githubAssign.ts`: #3708 (an author cannot read its own pull request under another spelling
  of its name) is open and green. It lands or is closed before either half changes those files.
- The backend: S7 (#3893) changes `turnEnd.ts`, `liveness.ts` and the schema, and S19 changes the schema again. The
  working side starts in the CLI and changes the backend's delivery files after S7 has landed. The landing side adds
  no collection before S19 has landed; it starts from the record the backend already keeps of which agent wrote each
  GitHub comment.

## Next

**Step 2, the door opens.**

- Joining: a link, a personal account, GitHub connected, how many agents and of which kind. Harness makes the fork
  and the sandbox, and the agent takes a starter task. Thirty minutes to the first pull request.
- Standing: earned by changes that landed and stayed, and by reads that held up; lost by a revert. It decides whose
  read counts in which area. The leaderboard already drops a ship that is reverted within seven days.
- The sandbox, before the door opens (skipped for now, anh Dee, 10 Nov): for each engine, the lightest one in which
  the lab's own CLI runs on its person's subscription with only the project's folder, the person's logins held by the
  daemon, and a network that reaches the model and the Git remote.
- Each computer reports what its person gives (agents, hours, a share of the computer and the subscription), and the
  allocator plans inside it.
- The map, from an agreed mockup.

**Step 3, areas.**

- The PM places agents on areas. A captain plans each area and cuts its tasks, and the area allocates them. Anyone
  may cut a task smaller.
- A train for each area's branch, each with its agent, and one above them. Gates by kind of change: docs, code, a
  protected area (a read from someone with standing there), turned on by default (a check on the real thing first).
- Checks on joiners' computers: a result counts when computers of different people agree.
- The lead is told the budget and the time left. A task called blocked or infeasible is offered again, cut smaller.
- Shared things (a device, a test account): Harness holds the lease.

**Step 4** is whatever broke at 300.

## Not answered yet

- Whether each engine can run in a sandbox on a personal subscription, and what each lab's terms say about agents
  working on a shared project. Looked at before step 2.
- Standing against one person with many accounts.
- What checks cost at a thousand agents, and who gives the compute.
- Which of the two opens first. lampOS needs a lamp for some checks and runs its CI on a computer of ours; Harness
  needs neither. Either way its goal is a file of rows, each with a check.

## How we build it

1. One owner, one plan, changed by pull request.
2. An addition names the number it moves and what it removes. No number, no build.
3. An experiment before a design, and a design before code.
4. The loop's paths are proved with real engines on the real backend before a release, not with fakes.
5. Swarm changes reach a pilot project once a day, in the morning. No night deadlines.
6. The hand way stays until a gate is passed. When Swarm is down, the team takes its work back at once.
7. Numbers per builder and per person, never only a total.

## Decisions for anh Dee

| # | Decide | Recommended |
|---|---|---|
| 1 | Swarm is an open project anyone joins with their own agents; a private team is one kind of it | Yours, 10 Nov |
| 2 | Every agent runs on its person's own account, computer and subscription | Yours, 10 Nov |
| 3 | Step 1, and no new Swarm feature until its gate | Agreed, 10 Nov (no sandbox experiment for now) |
| 4 | Tasks stay GitHub issues; no task system or table of our own | Yours, 11 Nov |
| 5 | A read counts from any agent but the author, known from its session; no other-person rule | Yours, 10 Nov |
| 6 | The built-in text cut to how to reach Harness, frozen; process and the goal file in the repository | Yes |
| 7 | Allocation is the PM's: it decides the work, its allocator gives each task to an agent, by area at this size | Yes |
| 8 | Each Swarm has its own agent that lands trains; no app account of ours | Yours, 10 Nov |
| 9 | The first open project: Harness or lampOS, both already open source | Decided later (yours, 10 Nov) |

## Not built

A workflow in server code. Decisions, approvals or inboxes for people. Role texts and manuals. A second place for
the issues people ask for. A hosted place to run people's agents. An app account of ours on GitHub. Our own agent
or model. Chat between people.
