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
| (a) | Each allocator counts what its builders build in the Swarm's other repositories it can read | For each builder with room in the project, its own list in each other project's repository each pass, asked with its ETag: free while nothing of its changed | None | Nothing | See a repository the PM's person cannot read: there the agent counts as building nothing, and it is said once in the log |
| (b) | The server, which knows the roster, says how many tasks each agent holds | None on GitHub | A count for each agent, written by every PM's daemon each time it gives or a task closes | Nothing | Stay true without a task record of our own: tasks are GitHub issues (the plan's decision 4), so the count is a second copy that drifts |
| (c) | An agent builds for one project at a time, as its person chooses | None | One field on the agent | Choose, and choose again when a project runs dry | Give an idle agent the other project's work: it is the allocator's job, handed back to the person. And it needs a screen |

## The choice: (a)

- It keeps state where the plan says state is: GitHub's own issues and labels. (b) adds the table the plan says not to build.
- It asks nothing of a person and adds no screen. (c) does both, and leaves agents idle beside open work.
- Its cost is bounded and small: a conditional read a pass for each builder with room, in each other project of the
  Swarm, which is a handful; a 304, which GitHub does not count, while nothing of that builder's there changed.
- Its gap is honest and narrow. A repository the PM's person cannot read: two plans can then still give one agent a task
  each, as before, for that pair only, and the log says so. A private project the PM's person is not in is never seen
  at all, so nothing is said of it: only that project's own plan, if it can read this one, keeps the agent to one task.

One race remains in (a) and (b): two plans that pass in the same minute both see the agent free. The agent then holds
two tasks building, and each plan sees the other's label on its next pass and gives it no more. (c) has no such race:
an agent there is in one project's plan alone. The claim's limit of four (`githubClaim.ts`) counts the tasks taken in
the one repository a take names, so it bounds each project, not the Swarm.

## What was built

- **Where the other projects are found.** The PM reads only its own project, so the projects come from the Swarm as
  its PM's person reads it (every public project, and the private ones that person is in), read by what changed as
  every Swarm read is. A closed tab's project is left out: nobody plans it.
- **Whose lists, and how.** Only the builders with room in the project are read: one that builds a task there, or holds
  four there, is given nothing whatever it does elsewhere. For each, its own list in each other repository: the issues
  and pull requests that carry its label (`labels=builder:<name>`, as `githubClaim.ts` reads a builder's own), one page,
  asked with its ETag. A whole repository's open list was read at first; GitHub lists it newest first, so in a busy
  repository every page answered 200 each pass, and at the bound that was up to 6,000 counted requests an hour against
  the login's 5,000 (review of #4144). A task this computer gave there (a project led here too) that GitHub's list does
  not show yet counts as given.
- **What counts.** Only building, as package 2 defines it, on what that list shows: a builder's task there (its label,
  not one waiting on pieces cut off it) is building unless an open pull request of the team that GitHub says is not a
  draft names it ("Closes #N"). A task building there leaves its builder no room here, and keeps it busy in the plan as
  one here does: half its size taken, its whole size given. Its verdicts there are not read: they are each pull
  request's comments and the server's records of who made each, several reads a pass for each pull request of another
  project. So a reader's HOLD there counts as in review, as failed checks already do here: its builder may be given a
  task here while it fixes that. A pull request tied to its task only by its branch, which the list does not show,
  leaves its task building: its builder waits, never gets two.
- **Four open stays each project's own.** What waits there for its read or its merge counts for nothing here: counted
  against a builder's four everywhere, a project whose merger is off would cap its builders in every other project
  (review of #4144). The day's post counts in hand only the project's own: a public channel never counts a private
  project's tasks.
- **Bounds and failures.** At most ten of the Swarm's other projects a pass, past which the rest are said once and
  count as nothing. A repository the login cannot read, or whose list GitHub refuses (one with its issues turned off),
  is said once and counts as nothing; it is asked again after a wait that grows to a quarter of an hour, ten minutes at
  least for one it cannot read. A Swarm that cannot be read is said once and counts as nothing, and the project is
  planned all the same; it is read again next pass, as the PM's own read is. GitHub failing on its own side or limiting
  the login stops the pass, as for the project's own.
- **The count.** Requests a pass, for one project a PM leads with four builders with room (the most it reads); counted
  is what answers 200, not a 304:

  | Projects in the Swarm | Requests a pass | A day | Counted a day, as builders work | Counted at most |
  |---|---|---|---|---|
  | 2 | 4 | 5,760 | about 600 | 5,760 |
  | 5 | 16 | 23,040 | about 600 | 23,040 |
  | 11 | 40 | 57,600 | about 600 | 57,600 (2,400 an hour) |

  A builder's list there changes only when its own tasks or pull requests there do, and it works in one project at a
  time, so about one of its lists answers 200 when it pushes or is answered; "as builders work" assumes that every ten
  minutes for each. The most needs every builder's list in every repository to change every minute; with twelve
  builders with room at eleven projects that would be 7,200 an hour, over the login's 5,000, and is the case that would
  ask for this design again. A builder with no room reads nothing, nor does a pass with none. A repository that cannot be
  read: at most 144 a day. No write.
