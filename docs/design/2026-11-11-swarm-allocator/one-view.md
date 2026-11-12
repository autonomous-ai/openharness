# One view of an agent across a Swarm's projects: the options

Package 11 of [the build list](BUILD.md). Status: **option (a) chosen and built** (#4144). The choice was anh Dee's to
make (BUILD.md: "which way package 11 goes"); he was not there to make it, and under his "take care of it all" the
session that built it chose (a), for the reasons below. The others stay open to him: changing to one replaces how the
counts are read (`githubAssign.ts` `elsewhere`), and the rule that uses them (`assign/crew.ts` `hasRoom`) stays.

## The fault

Every regular agent builds for every public project of its Swarm (`assign/crew.ts` `crewOf`). Each project is planned
by its own PM's person's computer, over its own repository, and none sees the others. So an agent in a Swarm of three
public projects is given one task building by each of them at once (two each before package 2): three plans, each
sure the agent is free.

## The options

| | What it is | Reads | State on the server | What a person must do | What it cannot do |
|---|---|---|---|---|---|
| (a) | Each allocator counts what its builders build in the Swarm's other repositories it can read | For each builder it is about to give a task to, its own list in each other project's repository, asked with its ETag: free while nothing of its changed | None | Nothing | See a repository the PM's person cannot read: there the agent counts as building nothing, and it is said once in the log |
| (b) | The server, which knows the roster, says how many tasks each agent holds | None on GitHub | A count for each agent, written by every PM's daemon each time it gives or a task closes | Nothing | Stay true without a task record of our own: tasks are GitHub issues (the plan's decision 4), so the count is a second copy that drifts |
| (c) | An agent builds for one project at a time, as its person chooses | None | One field on the agent | Choose, and choose again when a project runs dry | Give an idle agent the other project's work: it is the allocator's job, handed back to the person. And it needs a screen |

## The choice: (a)

- It keeps state where the plan says state is: GitHub's own issues and labels. (b) adds the table the plan says not to build.
- It asks nothing of a person and adds no screen. (c) does both, and leaves agents idle beside open work.
- Its cost is bounded and small: a conditional read in each other project of the Swarm, which is a handful, for each
  builder a pass is about to give a task to; a 304, which GitHub does not count, while nothing of that builder's there
  changed.
- Its gap is honest and narrow. A repository the PM's person cannot read: two plans can then still give one agent a task
  each, as before, for that pair only, and the log says so. A private project the PM's person is not in is never seen
  at all, so nothing is said of it: only that project's own plan, if it can read this one, keeps the agent to one task.

One race remains in (a) and (b): two plans about to give the agent a task at the same moment both see it free. In
(a) each reads the agent's lists just before it writes its label, so the moment is one GitHub round trip. The agent then
holds two tasks building, one from each, and neither plan gives it more. (c) has no such race: an agent there is in one
project's plan alone. The claim's limit of four (`githubClaim.ts`) counts the tasks taken in the one repository a take
names, so it bounds each project, not the Swarm.

## What was built

- **Where the other projects are found.** The PM reads only its own project, so the projects come from the Swarm as
  its PM's person reads it (every public project, and the private ones that person is in), read by what changed as
  every Swarm read is. A closed tab's project is left out: nobody plans it.
- **When, and whose lists.** A builder's lists elsewhere are read only just before a pass gives it a task, or takes one
  back for it: for no other builder, and not on a pass with nothing to give. For it, its own list in each other
  repository: the issues and pull requests that carry its label (`labels=builder:<name>`, as `githubClaim.ts` reads a
  builder's own), one page, asked with its ETag. A label with a comma, which GitHub reads as "and", is looked for among
  the repository's 300 newest open items, as a claim does. One computer leading several of the Swarm's projects reads
  each list once a pass. A task this computer gave there that GitHub's list does not show yet counts as given. The first
  version read every repository's whole open list each pass, and the second every builder's with room: in a busy Swarm
  of twelve builders and ten other projects, 120 requests every pass in its person's name (reviews of #4144).
- **What counts.** Only building, as package 2 defines it, on what that list shows: a builder's task there (its label,
  not one waiting on pieces cut off it) is building unless an open pull request of its that GitHub says is not a draft
  names it ("Closes #N"). Its verdicts there are not read: they are each pull request's comments and the server's
  records of who made each, several reads for each pull request of another project. So a reader's HOLD there counts as
  in review, as failed checks already do here: its builder may be given a task here while it fixes that. A pull request
  tied to its task only by its branch, which the list does not show, leaves its task building: its builder waits.
- **A builder found building elsewhere** is not given the task; the task is planned again next pass, for another. The
  builder is busy in the plan for as long as the plan counts that work (half a task's size taken, its whole size while
  only given), and has no room here until it is read again: fifteen minutes on at the latest, when a pass is next about
  to give it a task, a 304 while nothing of its changed. So one that finishes early is given a task here within fifteen
  minutes, where waiting for the estimate kept one that finished a large task in eight minutes idle for four hours
  (review of #4144). Read again each pass instead, every builder busy elsewhere that a project had work for was read
  every pass, which was the volume this replaces.
- **Four open stays each project's own.** What waits there for its read or its merge counts for nothing here: counted
  against a builder's four everywhere, a project whose merger is off would cap its builders in every other project
  (review of #4144). The day's post counts in hand only the project's own: a public channel never counts a private
  project's tasks. A builder never about to be given a task is not read, so the PM's numbers can call it waiting while
  it builds in another project, as before this package.
- **Bounds and failures.** At most ten of the Swarm's other projects a pass, past which the rest are said once and
  count as nothing. A repository the login cannot read, or whose list GitHub refuses (one with its issues turned off),
  is said once and counts as nothing; it is asked again after a wait that grows to a quarter of an hour, ten minutes at
  least for one it cannot read. A Swarm that cannot be read is said once and counts as nothing, and the project is
  planned all the same. GitHub failing on its own side or limiting the login stops the pass, as for the project's own.
- **The count**, per project a PM leads. A pass reads at most ten requests for each builder it is about to give a task
  to (one task a builder a pass), all at once, so none on a pass with nothing to give. A builder is read at most once a
  task it is given, and once each fifteen minutes at the most while it builds elsewhere and the project has work for it. With
  twelve builders that are always busy in other projects while this one always has work: at most 4 reads an hour each,
  480 an hour in all, 11,520 a day, against 172,800 before; each is a 304, which GitHub does not count, while nothing of
  that builder's there changed. With a project that gives a hundred tasks a day: 1,000 more. No write.
- **The race.** Two PMs' plans give one builder a task each only when both are about to give it one within one GitHub
  round trip: each reads its lists in all the other repositories at once, then writes its label. Read one after another,
  that was a round trip for each repository, about five seconds at eleven projects. Two passes started at the same
  instant race every time (the loop test runs them so: three times in two hours, each time a builder held one task from
  each project, given in the same minute, and no pass after gave it another). Two computers' passes fall at their own
  seconds of the minute: for a builder both are about to give a task, about twice a round trip in sixty seconds, under
  2% at half a second.
