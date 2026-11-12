# One view of an agent across a Swarm's projects: the options

Package 11 of [the build list](BUILD.md). Status: **option (a) chosen and built**. The choice was anh Dee's to make
(BUILD.md: "which way package 11 goes"); he was not there to make it, and under his "take care of it all" the session
that built it chose (a), for the reasons below. The others stay open to him: changing to one replaces how the counts
are read (`githubAssign.ts` `elsewhere`), and the rule that uses them (`assign/crew.ts` `hasRoom`) stays.

## The fault

Every regular agent builds for every public project of its Swarm (`assign/crew.ts` `crewOf`). Each project is planned
by its own PM's person's computer, over its own repository, and none sees the others. So an agent in a Swarm of three
public projects is given one task building by each of them at once (two each before package 2): three plans, each
sure the agent is free.

## The options

| | What it is | Reads | State on the server | What a person must do | What it cannot do |
|---|---|---|---|---|---|
| (a) | Each allocator counts its builders' open tasks in the Swarm's other repositories it can read | One list of open issues for each other project's repository each pass, asked with its ETag: free while nothing changed | None | Nothing | See a repository the PM's person cannot read: there the agent counts as holding nothing, and it is said once in the log |
| (b) | The server, which knows the roster, says how many tasks each agent holds | None on GitHub | A count for each agent, written by every PM's daemon each time it gives or a task closes | Nothing | Stay true without a task record of our own: tasks are GitHub issues (the plan's decision 4), so the count is a second copy that drifts |
| (c) | An agent builds for one project at a time, as its person chooses | None | One field on the agent | Choose, and choose again when a project runs dry | Give an idle agent the other project's work: it is the allocator's job, handed back to the person. And it needs a screen |

## The choice: (a)

- It keeps state where the plan says state is: GitHub's own issues and labels. (b) adds the table the plan says not to build.
- It asks nothing of a person and adds no screen. (c) does both, and leaves agents idle beside open work.
- Its cost is bounded and small: one conditional read a pass for each other project of the Swarm, which is a handful.
- Its gap is honest and narrow: a repository the PM's person cannot read. Two plans can then still give one agent a
  task each. That is today's behaviour, for that pair only, and the log says so.

One race remains in all three: two plans that pass in the same minute both see the agent free. The agent then holds
two tasks building, and each plan sees the other's label on its next pass and gives it no more. The claim's limit of
four (`githubClaim.ts`) counts the tasks taken in the one repository a take names, so it bounds each project, not the
Swarm.

## What was built

- **Where the other projects are found.** The PM reads only its own project, so the projects come from the Swarm as
  its PM's person reads it (every public project, and the private ones that person is in), read by what changed as
  every Swarm read is. A closed tab's project is left out: nobody plans it. A private project that person is not in is
  not seen at all.
- **The read.** Each other project's repository's open issues and pull requests, as its own allocator reads them: the
  same path, pages of a hundred up to ten, each asked with its ETag, so a 304 while nothing there changed. A project led
  on the same computer is read once a pass for both. A task this computer gave and GitHub's list does not show labelled
  yet counts as given there too.
- **What counts.** Package 2's rule, on what that one list shows: a builder's open tasks there (its label, not one
  waiting on pieces cut off it) are open; of those, building is all but the ones an open pull request of the team names
  ("Closes #N") that GitHub says is not a draft. A task building there keeps its builder busy in the plan as one here
  does: half its size taken, its whole size given. Its readers there are not asked, and its verdicts not read: they are
  the comments of each pull request and the server's records of who made each, a read a pass for each pull request of
  another project. So a reader's HOLD there counts as in review, as failed checks already do here; its builder may then
  be given a task here while it fixes that, and the four-open limit still holds. A pull request tied to its task only by
  its branch, which that list does not show, leaves its task building: its builder waits, never gets two.
- **Kept apart.** What a builder holds elsewhere counts for room only (`hasRoom`, and the four-open limit on which free
  task is planned on whom). The day's post counts in hand only the project's own: a public channel never counts a
  private project's tasks.
- **Bounds.** At most ten of the Swarm's other projects a pass, past which the rest are said once and count as
  nothing; ten pages each. A repository the login cannot read, or whose list GitHub refuses (one with its issues turned
  off), is said once and counts as nothing; it is asked again after a wait that grows to a quarter of an hour, ten
  minutes at least for one it cannot read. GitHub failing on its own side or limiting the login stops the pass, as for
  the project's own.
- **The count.** Per project a PM leads, a pass a minute: one request for each hundred open items of each other
  repository. A Swarm of two projects under a hundred open each: one a pass, 1,440 a day, each a 304 while nothing
  there changed; a repository of lampOS's size (259 open): three a pass. A project led on the same computer: none
  more. A repository that cannot be read or is refused: at most 144 a day. No write.
