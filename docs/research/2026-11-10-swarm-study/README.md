# Swarm study, 10 November 2026

Asked by anh Dee on 2026-11-10: study how lampOS's agents work together (its issues, pull requests and protocol
files), what Swarm v1, v2 and v3 built and why they failed, what v4 is today, and a published 1,000-agent run; then
plan how to get Swarm right. The plan is [2026-11-10-swarm-plan.md](../../plans/2026-11-10-swarm-plan.md). This
folder is its evidence.

| File | What it holds |
|---|---|
| this file | The findings in short; v4 checked against lampOS rule by rule; the 1,000-agent run and its diagrams |
| [lampos-queue.md](lampos-queue.md) | lampOS's Queue, 26 Oct to 10 Nov: 9,710 comments by kind, latencies, 35 incidents, the Swarm PM period |
| [lampos-pull-requests.md](lampos-pull-requests.md) | lampOS's pipeline, 20 Oct to 10 Nov: a census of 3,795 pull requests, 803 trains, 5,193 verdicts, 674 issues |
| [swarm-v1-v3.md](swarm-v1-v3.md) | Swarm v1 to v3 from this repository's record: versions, size, failures by date, the decisions, what v4 repeats, what to keep |

Sources: `autonomous-ai/lampOS` (public) on 10 November, this repository at `82a6c9a9ec`, the sandbox repository v4
runs on, and Anthropic's article of 9 November. Nothing was written to GitHub. People are named by role; agents keep
their names.

## 1. How lampOS's agents work together

There are no human coders. About thirty agents ("builders"), plain Claude Code and Codex sessions on some ten
people's computers, build a robot lamp's software in one repository. The rules are files in that repository
(`lampOS/AGENTS.md`, `lampOS/docs/joining.md` at 1,125 lines, a role file per builder, the merge bot's README), and
they change by pull request.

1. A person types `you are <name>`. The agent reads its role file (its person, its lamp, the branches it may push,
   the crates it owns, what it may not do) and the rules.
2. Tasks are GitHub issues. A PM agent, the "first builder", opens them, labels each `builder:<name>`, and keeps
   every builder's list at least three deep on one pinned issue, the Queue.
3. A builder claims its next issue (`status:taken`, one line "taken by <name>"), branches `<name>/<task>`, builds,
   runs the gate, and opens a pull request that says what it is part of, what kind of change it is, the gate as run
   with its counts, and what was not run.
4. Another agent reads it and answers on the pull request, first line `READ-OK <sha>` or `HOLD <sha>` with the file,
   line and fix. Privacy and default-changing work needs two readers.
5. A bot, never an agent or a person, carries every read, green pull request in a train: one branch, one CI run on
   the combined change, one rebase merge.
6. The builder takes its next task in the same minute. Waiting is not a state: findings on its own pull requests
   first, then rebases, then the next task, then someone's stalled pull request, then a read.
7. A change that turns something on is checked on a real lamp before it is promoted to stable, and rolled back
   within the hour if a bug gets through. An issue closes when its fix is on stable, not when it merges.
8. Everything is said on the Queue, to someone by name, with a result in it. A person is asked only for hands at a
   lamp or for one of a named list of calls, with a recommendation and a default that applies at a stated time.

It began on 14 October as one sentence from the owner and a list in a file. Each rule since answers something that
had just gone wrong, was usually proposed by a builder, and was written down the same day:

| Date | What went wrong | The rule |
|---|---|---|
| 14 Oct | The task list was 1,600 lines every builder read every loop; a task's state was free text | Tasks become GitHub issues with labels |
| 14 Oct | A builder's pieces were cherry-picked and nothing tied the issue to the commits | One pull request per task |
| 15 Oct | Builders stopped at every commit to wait for a person | Builders commit and push their own branches without asking |
| 15 Oct | Every pull request waited on the first builder for a review, a lamp minute and a merge | A reviewer agent; three by 21 Oct, each with a lane |
| 16 Oct | Builders sat idle | "Never idle"; only the PM opens issues |
| 19 Oct | The Queue hit GitHub's 2,500-comment cap; work sat on busy builders | A new Queue (the ninth opened on 10 Nov); claim before code; untouched six hours means returned |
| 19 Oct | Hardware testing needed its own order | A second Queue with its own lead agent |
| 22 Oct | Reviews kept finding the same five faults | A self-check list in every pull request |
| 23 Oct | Each pull request was merged by hand, one by one, and a fix meant a new pull request | The train bot |
| 24 Oct | Codex sessions ended their turn overnight | "Never end your turn", with the order of what to take next |
| 3–7 Nov | Changes landed before a lamp check, or on one read of two | The gates written down; the bot's reading rules tightened |

The process is the team's own text, changed at the speed the team learns. That is the first thing a product must not
take away.

## 2. What the record shows (manual period, 26 Oct to 4 Nov 11:00)

**Output.** 30 builders landed work; 824 pull requests opened in those 9.4 days landed. Weekday median 111 a day,
best day 172. A builder landed 5 a day at the median, 14 at the 90th percentile. A fifth of landings and of verdicts
happen between midnight and 07:00.

**The hour.**

| Step | Median | p90 |
|---|---|---|
| Ready to first verdict (a reader's answer) | 7 min | 55 min |
| HOLD to the fixing push | 24 min | 3.7 h |
| Fixing push to the same reader's next verdict | 13 min | 2.1 h |
| Last READ-OK to landed | 36 min | 60 min |
| of which waiting for a train | 10 min | 22 min (p75) |
| of which the train's CI run | 23 min | 29 min |
| Ready to landed, whole pipeline | 60 min | 7.0 h |

76% landed within 3 hours. A clean pull request spends most of its hour in the train. The tail is rework: the 23%
that got a HOLD took 2.8 hours and hold 58% of all hours.

**The read is worth it.** Of 60 HOLDs read by hand, 42 named a fault in behaviour (at least ten in privacy or
physical safety), 6 a missing or broken test, 3 a document that did not match the code, 9 a process condition, none
style. A second reader held 15 to 19% of the heads a first reader had passed. 2% of first READ-OKs are under 300
characters; none found was a bare stamp.

**The composed run is worth it.** The train's one run caught 12 real breaks; 6 of them no per-pull-request check
could see (a duplicate constant, a changed signature landed since the base).

**Size decides.** HOLD rate 3% at 50 lines or fewer, 53% over 1,500; median cycle 52 minutes against 4.8 hours.

**The Queue.** 672 comments a day (peak 1,011). A third are fixed-grammar markers (READ ASK, taken, NEXT TRAIN, bot
notes, lamp slots, free); with hourly lines, relayed verdicts and plain state reports, about 62% is state a program
could carry. The PM wrote 5% of the comments and was addressed in 48%.

| From | To | Median | p90 |
|---|---|---|---|
| `free: <name>` | the PM's next post naming that builder | 139 min | 10.8 h |
| A question to the PM | its answer | 42 min | 11.7 h |
| READ ASK | first verdict on the pull request | 5.8 min | 18 min |
| NEXT TRAIN | merged | 32.5 min | 128 min |

**What worked, in the record's own counts:** 408 unasked claims (44 a day, 244 of them reads); 22 of 22 proposals
answered once (median 19 minutes); 57 posts carrying another builder's stalled work; median post 529 characters with
no acknowledgement-only post found; a fault in the bot fixed the same hour it was reported.

**What the rules said and the record did not do:** only half the pull requests name a task issue; 11% of issues had
five or more pull requests; the four-issue limit was passed for a fifth of builder-hours; the issue headings Why /
Wanted / Hand back / Most likely wrong were dropped after 19 October for a short text and "Done when"; issues came
from more accounts than the PM's. A product should copy what was done, not what was written.

## 3. Where the manual process hurt

By stated cost (incidents with quotes and links are in [lampos-queue.md](lampos-queue.md), section 4):

1. **GitHub as the bus.** Two of the team's accounts were banned on 28 October (18 pull requests hidden, four
   builders without an account; the PM read the cause as volume). The Queue filled five times in 16 days, and each
   time claims and asks went to a dead issue. One login's API quota ran out. 115 landed pull requests are no longer
   shown by GitHub.
2. **Sessions stopping unseen.** The PM's session was down about 15 hours once and a promote was missed. Six agents
   on one account (four builders, two reviewers: 41% of all posts, 77% of verdicts in the peak week) went quiet on
   1 November at 19:00. The PM said so 17 hours later, and they came back on 9 November.
3. **One reader of everything.** Every miss in the PM's incidents is an agent polling the wrong issue or not polling.
4. **Wrong landings.** At least 18 of 368 trains carried something they should not have: a head from before a
   force-push (nine named), a change before its lamp check, one read where two were asked, a HOLD on the Queue not
   seen. One turned the main branch red for an hour; one stopped promotes for 18 hours.
5. **Markers read from prose.** Pull requests sat out 3 to 9 trains with no reason said; the bot's reading rules
   changed at least 12 times in nine days; by 10 November it could not name the reader on 33% of verdicts.
6. **Rebases.** The 7% of pull requests told they conflict took 10 hours instead of 64 minutes; a session that could
   not force-push filed a new pull request (9% closed without landing, mostly re-filed); 21% of all READ-OKs only
   restate a read on a new head.
7. **One train lane.** Full 87 to 91% of the day on the best days at 2 to 3 pull requests a train: a ceiling near 150
   a day. 130 of 803 trains never merged (41.5 hours of CI): 42 because a carried pull request was held mid-run, 37
   because the branch moved; only 34 failed their own run. The bot blamed the wrong pull request 8 times in 22.
8. **One identity for many.** 5,193 verdicts came from 11 accounts; one account carried up to 12 agents' names.
9. **Shared machines and permissions.** One Mac's full disk stopped every builder on it, twice. A refused
   `gh pr ready` held a pull request five hours; a refused promote, two days.

## 4. The Swarm PM period (4 to 9 November)

A Swarm PM agent (Faye) took the PM's work on 4 November at 11:00; the owner stopped it on 9 November at 09:34 and
the first builder became PM again.

**A correction to the number we have been using.** "122 to 193 changes merged a day, against 70 to 102 with Faye"
reproduces to the unit, and compares the four best days with three. The drop came on Monday 2 November, two days
before the cutover, when the six agents on the first builder's account stopped. Everyone else landed, per weekday: 80
before 2 November, 55 on 2 to 4 November, 74 under the Swarm PM, 96 after. The pull-request data does not show the
other builders landing less under the Swarm PM than in the days just before it.

**What did get worse under the Swarm PM:** the slow end of reader latency (p90 37 minutes, then 2.5 hours once the
reviewers left, then 4.3 hours); the median cycle (64 minutes to 2.2 hours, in every size class); READ ASK to landed
(59 to 125 minutes); the same builders posted more (354 to 416 comments a day) and 34% of the PM's posts set a clock
deadline (the first builder: 12%).

**What failed, in the record's words** ([lampos-queue.md](lampos-queue.md), section 5):

- The first builder's unwritten checks were not carried over: default-on changes trained before their lamp checks, a
  build was named for promote with an open P2, the figures stopped. "Each slip was a missing written check, not
  reasoning."
- Swarm agents could not start on the repository (the Team account could not clone it); the pilot agent was closed
  after its merge and before its lamp check; all Swarm agents stopped when the Team account went down; a read posted
  under the app's account did not count.
- Most builders were never in the Swarm, so the PM worked through GitHub and tasks had twins.
- The PM did not know who was alive: it placed reads with builders silent for three days.
- Its rules lived in Swarm instructions at revision 103 after two days, which most builders could not read, and which
  differed from the repository's (a release window of 09:00 to 18:00 against the team's 07:00 to 21:00).
- Its train bot could not push at first, could not promote for its last two days, and stopped when its session did.

The Swarm PM answered faster than the first builder (33 minutes against 42, longest silence 4 hours against 15.9).
It was not slow. It did not hold the team's rules, and the system around it knew less than GitHub did.

## 5. Swarm v1 to v3 (18 October to 8 November)

The full record is [swarm-v1-v3.md](swarm-v1-v3.md). In short:

| | 19 Oct | end of v1 (27 Oct) | end of v2 (6 Nov) | end of v3 (8 Nov) |
|---|---|---|---|---|
| Product code in the four Swarm trees, lines | 6,390 | 34,400 | 199,292 | 207,246 |
| Backend command types | 23 | 59 | 124 | 137 |
| Text an agent was given at launch, words | 69 | about 3,000 for a Lead | about 4,300, a 22 KB project document, and 1,200 more for a PM | a 41-word line, the rest read by command (from 23:03 on 7 Nov) |

1,638 Swarm pull requests and 416 releases in 20 days, 445 plans in six of them; 657 prompt rules by the audit of
7 November.

**The common cause:** authority sat in a server model and one PM session, not in the repository and GitHub where the
agents and people already worked. Every gap between that model and what agents do became a patch, nothing was taken
out, and the people meant to use it got about 21 releases a day.

**In every version:** messages and wake-ups that did not arrive (an alarm reached nobody for 4 hours 50 minutes);
instruction text that grew and churned, and from 5 to 7 November told every PM that Swarm's instructions outrank the
repository's own files; a hub (the PM got 486 messages in a day and heard nobody for 6.5 minutes); a second task
system (about 4,700 Swarm task numbers beside GitHub's); state machines added, removed and added again (routing had
eight designs); identity (18 of 113 starts ran as another person's machine owner; Team accounts cost 20,126 lines
and lasted 14 days); load on people (Decisions, Activity, approvals); proof with fakes (v3 passed acceptance and
failed a 21-finding audit the same day).

**The advice was on record before v1.** 10 October: "the product needs a safe doorbell, and nothing more." 17
October: review and merge set the output; builders pull their next task; "the next step is an experiment, not more
design." A Lead-dispatch product was authorized the next day.

## 6. v4 against lampOS, rule by rule

Read from the code at `82a6c9a9ec` (line numbers move; file names are in `cli/src/superTabs` unless said).

| lampOS's rule | v4 today | Gap |
|---|---|---|
| "You are <name>", then the role file and the rules | The first message is "You are <name>."; a 507-word basics text and 143 words more for a PM sit in the engine's own instructions (`cli/src/lib/swarmSkills.ts`) | The text grew from 302 words in 22 hours and says `Closes #N`, which lampOS forbids |
| A role file per builder: person, branches, owned parts, may and may not | `agents/<name>.md`; code reads only its `Works on:` line | No template, nothing creates it, nothing is enforced; Desktop edits the local copy while the assigner reads the default branch's |
| Lists three deep; take the next without asking | Two deep (`assign/crew.ts DEEP`); Harness labels the next task and GitHub news brings it | Built, and quicker than the PM was |
| Claim: `status:taken`, "taken by <name> · session", re-read for a double claim | Prompt only | No double-claim check |
| Never idle; never end your turn; a 20-minute idle watch | The basics say "When you wait, end your turn: Harness wakes you"; the server "nudges no worker"; a quiet taken task is asked about after 4 hours and moved after 8 | An agent that stops with work left and no event sleeps for hours |
| Read every Queue and pull-request comment since your last post | Pushed: comments that name the agent or sit on its task or pull request, and new tasks (`githubMentions.ts`) | The first read looks back 10 minutes; over 6 relays in 10 minutes on a thread are dropped; nothing is replayed after a restart or a compaction; agents are told never to read for themselves |
| `READ-OK <sha>` or `HOLD <sha>` by another agent; same-patch rebase keeps a read; a HOLD with no sha still holds | Built (`githubMerge.ts`), including same-patch carry and quoted or talked-about markers | A HOLD with no sha is not seen; the reader is known by a typed name, so an agent on the author's login can sign another's name |
| A silent reader is replaced after an hour; no pull request waits 30 minutes for a first read | Harness picks the reader (another model family first) and asks another after 2 hours | It does not check that the reader it asks is running or heard the ask: sandbox #27 waited 4 hours on two readers who never answered, then was read in one minute |
| TWO READS for privacy and default-on work | Counted when the body or a comment asks | Nothing says when to ask |
| The train: batches, one run on the combined change, lanes, rebase merge, fail closed | One pull request at a time, squash, every 30 seconds; merges when GitHub says clean | Checks may have run on an older base; no batching, so a 20-minute CI cannot keep up; no flaky-test handling |
| Runs on one Mac (the PM's) | The merger, the assigner and reader asks run only on the PM's person's computer while the PM session lives | The same single point |
| `Part of #N`; done means on stable and checked on a lamp | `Closes #N`; done means merged; the board and the leaderboard need the closing keyword or a `name/N` branch | lampOS's rule and v4's assumption cannot both hold |
| Lamp lock, slots, kits approved by hash | Machine capacity only (cores, memory, disk, quota, `needs:` labels) | Nothing for shared devices |
| Lead's calls: named kinds, a recommendation, a default at a stated time | Two narrow notices | Absent |
| Self-check list; cut a long issue; hourly figures; a work log | None | Absent (the team can keep them in its own files) |

Built in v4 and not in lampOS: the solver that assigns tasks, learned task times, take-backs when a machine is down or
out of quota, readers picked by model family, focus areas, labels made where a repository lacks them, GitHub news
pushed into the agent's chat, the 1:1 chat typed exactly as written, the issue board and the pull-request view.

**v4 in use, 9 and 10 November.**

- The sandbox repository: 17 pull requests in a day, at first hours each (one note was posted 46 times; an ask was
  lost and re-posted by hand, issue #3813), by the evening 4 to 6 minutes from issue to merged with three agents.
- A reader in the sandbox noted that the branch was behind and CI had run only the old job; Harness merged it.
- A reviewed, green pull request did not merge and nobody was told why (issue #3787): Attach had renamed the agents
  and the merger knows the team by name.
- This repository's own team made 21 merge batches by hand on 10 November, carrying 80 pull requests, because single
  landings kept losing the race to a moving main.
- The plan's acceptance (two machines, a small project shipped) is not recorded as passed.
- v1 to v3's patterns already visible: about 62 of 199 pull requests repair v4's own new behaviour, 24 of them how
  prose, names and labels are read; 66 releases in two days; a dozen features that lampOS's process does not have.

## 7. A 1,000-agent run

Anthropic described on 9 November 2026 how one lead agent and 999 helpers, on an early Claude Fable 5.2, rebuilt a
formal Lean proof of Fermat's Last Theorem in 28.7 hours with no researcher steering
([the article](https://claude.dev/blog/safely-scaling-multi-agent-teams-with-fable-5-2/)). An earlier run had taken a
researcher, dozens of agents and a purpose-built platform 11 days; this one used general tools and about a third of
the output tokens. The authors call it a toy experiment: one run, an early model. The numbers below are the
article's.

**Diagram 1, the harness.** Each agent runs in its own small VM with a shell, an editor and the files. Its only link
out is a pipe to a gateway outside the sandbox. The gateway calls the model and forwards Git and SQL requests to one
shared repository and one shared Postgres database.

**Diagram 2, the safety layers.** Sandboxing: no network, no credentials, no path to another sandbox, an unprivileged
user, no tool access to the agent loop. At the gateway: the agent's identity is set there, every push and query is
logged, and a classifier checks each tool call before it runs and fails closed. Git: an agent pushes only its own
branch, and a separate job merges to main. Database: a shared unprivileged role, five seconds a statement, writes
refused over 256 MiB. Offline: the run's records are kept outside the sandboxes and reviewed, and the run's owners
are told of serious findings. Over a million tool calls, none blocked.

**Diagram 3, the five tables.** The lead made them itself in the first ten minutes. There were no messaging tools.

| Table | What it is | lampOS's by-hand equal | v4's |
|---|---|---|---|
| Announce | The lead's orders to everyone | The PM's posts to all; `joining.md` | A channel post; the repository's AGENTS.md |
| Assign | Who owns or deputizes on each piece | `builder:` labels; each builder's list on the Queue | `builder:` labels set by the solver |
| Notes | An open board: who is taking what, plans, verdicts, progress | Queue comments | The channel |
| Subtasks | A to-do list anyone adds to; the first to grab a task owns it | Issues (PM only) with `status:taken` | GitHub issues (PM only) |
| Landed | What landed, its commit, whether it passed the checks | The train bot's notes; `PASS N` | Harness's "merged" comment |

lampOS built the same five things out of GitHub issues and comments. That is why 62% of its Queue is state.

**What the run did.**

- 36,612 writes and 311,734 reads in 30 hours. Agents look state up; nobody is sent a stream to read.
- Push became pull. The lead gave each statement a crew of 16 or 17 with a captain who posted a plan and cut tasks. By
  hour 5.6, 73 helpers had written 756 tasks and only 16 of them were captains; the lead told free helpers not to
  wait for it. The hardest statement grew a tree of 2,418 tasks, ten levels deep, where each piece could assume the
  pieces under it.
- The lead allocated, it did not do: it moved helpers between statements as results came in, about 750 onto the last
  one.
- Done was decided by a checker, never by an agent: a statement counted when Lean accepted it on main.
- Agents stop too early. Helpers judged 47 of 60 statements infeasible in the first half hour; most were proved. The
  harness reminded the lead of the time left 19 times.
- One shared machine failed at about 100 agents (memory, disk, CPU); a VM each scaled.
- The run was restarted from its last save near hour 18 and went on.

**What the article's three timelapses add** (read frame by frame from the videos; the numbers are theirs).

*Reads and writes to the tables, at hour 30.* The lead wrote 138 times and read 448 times in the whole run.

| Table | Lead: writes, reads | Helpers: writes, reads |
|---|---|---|
| Announce | 30, 10 | 1, 45,424 |
| Assign | 31, 53 | 1, 25,350 |
| Notes | 72, 308 | 20,553, 176,869 |
| Subtasks | 2, 9 | 14,769, 54,842 |
| Landed | 0, 65 | 434, 5,314 |
| Other tables | 3, 3 | 716, 3,487 |

- A lead ran 999 helpers on about five writes and fifteen reads an hour. lampOS's PM was named in some 320 comments a
  day; v2's PM was sent 486 messages a day.
- Thirty orders were read 45,424 times. An order is written once and looked up by whoever needs it.
- The "other tables" were made during the run: a look-up and a claim limit by the lead (the first at hour 0.4), and
  three logs of checks on the main branch by helpers. The team extended its own tools.
- Landed took 433 of its 434 writes by about hour 17. After the restart, helpers marked tasks done in the task list
  instead. A convention kept by agents drifts; a fact should be written by the job that makes it true.

*Where the 999 helpers were.*

| Hour | Proved, of 60 | At a statement | On shared tools or a line of work | Working, place not known | Waiting on its own build | Idle | Not running |
|---|---|---|---|---|---|---|---|
| 1.2 | 13 | 563 | 0 | 309 | 2 | 125 | 0 |
| 5.7 | 38 | 318 | 132 | 268 | 42 | 237 | 2 |
| 9.8 | 46 | 228 | 31 | 179 | 268 | 291 | 2 |
| 12.9 | 48 | 25 | 10 | 142 | 609 | 211 | 2 |
| 16.9 | 48 | 7 | 4 | 49 | 671 | 266 | 2 |
| 17.9 | 48 | 0 | 0 | 0 | 0 | 0 | 999 |
| 23.9 | 49 | 481 | 26 | 159 | 154 | 178 | 1 |
| 27.9 | 49 | 409 | 27 | 106 | 190 | 264 | 3 |
| 30.0 | 54 | 3 | 1 | 60 | 178 | 756 | 1 |

- A thousand agents were busy only while there were a thousand things to do. From hour 10 to 17, with twelve
  statements left and none of them cut small, six to nine in ten helpers were waiting on a build or idle.
- The build is where they wait: 609 and 671 helpers at once. For code that is CI, and lampOS builds each change
  twice at 16 to 23 minutes.
- Up to 132 helpers worked on shared tools for the rest. Tooling work appears by itself; lampOS's did too (its tests
  builder, its merge bot).
- The picture itself is the screen a person needs at this size: areas as boxes, agents as dots, and six counts.

*The task tree under the last hard statement.*

| Hour | 21.0 | 22.4 | 23.9 | 25.3 | 26.8 | 28.2 | 28.9 |
|---|---|---|---|---|---|---|---|
| Tasks written | 156 | 1,004 | 1,606 | 1,902 | 2,283 | 2,417 | 2,418 |
| Marked done | 67 | 884 | 1,471 | 1,796 | 2,166 | 2,363 | 2,364 |

- About 300 tasks an hour were written, and the number open at once stayed between 54 and 135 while four to five
  hundred helpers stood at the statement. Tasks were finished as fast as they could be cut. How fast work is cut
  into pieces, not how many agents there are, set the pace.

**What does not carry over to code.**

- Their checker is perfect. Code has tests that miss things, so lampOS's read (one landing in five held), the
  composed run and the check on a real device stay, and CI and readers become the scarce resource.
- Their agents are a custom loop on the API. Ours are the labs' own CLIs under a person's login, so keeping
  credentials outside the sandbox needs its own design.
- Their work needed no network and no hardware. Ours needs packages, CI and lamps.
- One run of 29 hours with fixed rules. A product team runs for months: rules change, people come and go, sessions
  compact, releases ship.

## 8. What the two that worked share, and the three that did not

| | lampOS by hand | The 1,000-agent run | Swarm v1 to v3 |
|---|---|---|---|
| The goal | 76 build rows and 17 quality rows with targets, scored only from runs on a lamp | 60 statements a checker accepts or not | Tasks as the PM wrote them |
| The process | The team's own files, changed weekly | The lead's own tables, made in ten minutes | The product's, in server code and prompts |
| Shared state | GitHub issues and comments | Git and SQL | A backend model behind a PM |
| Who takes work | The builder, from its list or unasked | The helper, first to grab | The server or the PM dispatches |
| Who merges | A bot, on a read and a green composed run | A separate job; the checker decides | A person or the PM; a train in the last days |
| Identity | A typed name on a shared account (its weak point) | Set by the gateway | The machine owner's login; Team accounts |
| Kept working by | "Never end your turn"; the PM's idle watch | Reminders; "do not wait for me" | Server timers that stopped and moved agents |
| People | Decide and lend hands | None during the run | Decisions, approvals, inboxes |
