# Members and Leads (2026-11-07)

No requester: anh Dee's redesign, approved in his Buddy chat on 11-07 16:10 ("Your mock up is so beautiful... Let's
build it"), task #4489. Spec only; each build task at the end gets its own task and pull request.

Anh Dee's order: first #4461 (agent faces, the Lead's gold ring, status marks, the Swarm design system) and the
whole-screen polish; then this flow; then the mockup's finish across the rest of the app.

## What anh Dee asked, in his words

> Redesign agents around how real teams work. There are only Members and Leads, with no separate Buddy. Starting an
> agent or joining uses the Cmd-N form, with no folder, worktree, branch or Member or Lead dropdown: you pick a main
> project, and New project makes it the Lead. On joining, the project list shows what each project is, its Lead and
> how many tasks are waiting, starting on the project you were invited to or the one that needs help most. A Member has
> one home folder with a worktree per project and a separate session per project. It sets up its main project once,
> tells the Lead it's ready, and does one task at a time. When free, it helps other projects, starting with ones already
> set up on its computer, and goes back when its main project has work. It sleeps only when nothing is waiting
> anywhere. Tasks still show on the right to approve or reject, and its chat shows a line when it changes project. If
> every agent is busy and a computer has room, the Lead asks its owner to start more. For files only on a Lead's
> computer, the Lead offers a private GitHub repo and sends anything else in the task thread. Existing Buddies become
> Members, keep their chats and ask their owner for a main project.

## Where this differs from the ask

Three places, each named again in its build task so anh Dee sees it there:

1. **Two folders, not one.** Anh Dee asked for "one home folder with a worktree per project and a separate session per
   project". The spec keeps one Member, one name, one face and one chat for people, but on the computer a Member has
   two folders: a home for
its chat with its person, and a task home holding a worktree per project. Why: the chat can carry every project its
person reads, private ones and their decisions included, while a task can be steered by outside text (an issue, a pull
request, a file). Kept in one folder and one session, a public task could read the person's private projects and post
them; both security reviews of this spec asked for the split (section 2). Nobody sees the two folders or the two kinds
of session: they are inside Harness.
2. **Helping only in public projects.** He said "when free, it helps other projects". The spec lets a Member help only
   public projects, only on a computer where Harness has put no private project's files, and a Member whose main
   project is private helps nowhere else, so a task that outside text can reach never runs beside private files
   (section 3). Helping in private projects is its own task with two security
   reviews.
3. **Ten minutes before sleep.** He said "it sleeps only when nothing is waiting anywhere". The spec adds a 10-minute
   wait after its last task before the task sessions sleep, so a task that turns waiting a minute later doesn't pay a
   resume (section 4).

## How it works today (main a1c62e12f)

- **Kinds are derived, not stored.** `agentKind()` (`backend/src/superTabs/agentKind.ts`) says `buddy` when the agent
  has `buddyOf`, `pm` when it is a project's `leadId`, else `regular`; clients get `kind` and `chatId` (`read/views.ts`).
  A Lead is whoever the project's chat names as `leadId`; nothing on the agent marks it.
- **Buddies** (`buddies.ts`): at most 5 per person (`BUDDY_CAP`, up to 20 per Swarm), each with its own chat (kind
  `buddy` or `swarm-buddy`), one default (`defaultBuddy`), thread sessions as separate agent records
  (`buddySessions.ts`), and a short list of commands they may send (`BUDDY_COMMANDS`; anything else is
  `BUDDY_FORBIDDEN`). A Buddy never takes a task: dispatch skips it (`dispatch.ts freeCrew`), and `crew.add` refuses it.
  It sleeps after an hour idle (`buddySleep.ts`).
- **Regular agents** (`agent.new`, #4116): one chat each (kind `agent-chat`), started in a folder of their own
  (`agentFolder.ts`, `worktrees/agent-home/…`) with one engine session for everything. A Regular agent's project is its
  task's project (`agentProjectId`); once it has worked in a private project it works only there
  (`privateProjectId`, `regularMayWorkIn`).
- **Crew members** (`crew.ts`, `dispatch.ts`, `crewKeep.ts`): a free member takes its lane's next task through
  `work.assign`; idle for an hour it sleeps (`SLEEP_IDLE_MS`), and `work.assign` wakes it in the same folder. Crew
  members move between machines (`movedTo`), never between projects.
- **A project's agents** start in a worktree of the project's clone (`leadStart.ts`, `projectFolder`), one agent and
  one session per project. An agent wanted in another project is refused with "Start a separate agent for another
  project" (`PROJECT_SESSION`, `sameProject`).
- **Cmd-N** (`desktop/lib/widgets/new_harness_form.dart`, #4196) has rows for agent, project (folder, clone, new),
  advanced, model, approvals, profile, branch, worktree and start, the computer in its header, and the Member or Lead
  pill (`_desktopKindMenu`). Joining opens the same form through Bring agent (`join/bring_agent.dart`), which makes
  the person's Buddy (`buddy.create`). The join dialog shows no projects, and a project has no description field.
- **Asking for more agents:** nothing asks a person. The project chat gets one line when no machine can start a
  reviewer (`reviewCapacity.ts`), and lane counts exist only inside dispatch (`laneCapacity`).

## Words

Added to [the Naming System](../naming-system.md) by the first build task. They replace Buddy, Regular agent and PM
agent on screen.

| Word | Meaning |
|---|---|
| **Member** | An agent of a person's, on that person's own computer and login, that works in a team. It talks with its person in its chat (its chat session) and does tasks (a task session per project, which never sees the chat). Every agent that is not a Lead is a Member. |
| **Lead** | The Member that leads a project: it decides what the project does and who does it. Shown with the gold ring (#4461). It is the project's coordinator (system name coordinator, wire `lead`, unchanged). A project that names its coordinator otherwise keeps that name. |
| **Main project** | The one project a Member belongs to. It works there first and goes back there whenever it has work. A Lead's main project is the one it leads. |
| **Helping** | A free Member doing a task in a project that is not its main project. |
| **Set up** | A project is set up for a Member when its worktree is on the Member's computer, ready to work in. |
| **Waiting** | A task is waiting when it is approved and nobody is on it yet (the Board's Next up). |

**Chat session**, **task session** and **task home** (section 2) are words for this spec and the build tasks only.
They never appear on screen: people see one Member and its chat.

Engineer, Reviewer and Tester stay as what a Member does on a given task, by the project's instructions. They are not
kinds of agent.

## What changes, in one view

| | Today | After |
|---|---|---|
| Kinds of agent | Buddy, Regular, PM, and crew Engineers and Reviewers | Member and Lead |
| Talking with your agent | Your Buddy's chat; Regular agents' chats | Every Member's own chat, under My agents |
| Making an agent | Cmd-N with folder, worktree, branch and a Lead or Member choice | Cmd-N with a project list: pick a main project, or New project for a Lead |
| Joining | Join, bring your agent, it becomes your Buddy | Join, bring your agent with the same Cmd-N form; it becomes a Member of the project you pick |
| Where an agent works | A Regular agent: wherever its task is, one conversation for everything | A Member: its main project first; a chat session for its person, and a worktree and a task session per project |
| A free agent | Idle, or a crew member takes its lane's next task | Takes its main project's next task, else helps where a task waits |
| Sleep | After an hour idle | Only when nothing it may take is waiting anywhere |
| Not enough agents | The PM notices, or nobody does | The Lead asks a computer's owner to start more, when the computer has room |
| Files only on the Lead's computer | Other machines can't reach them | The Lead offers a private GitHub repo; anything else goes in the task thread |

## 1. Starting an agent and joining: the Cmd-N form

Both use the existing Cmd-N form (`HarnessLaunchIntegration`, #4196), and only the project part of it changes.

- **Goes:** the folder, worktree and branch pickers, and the Lead or Member capsule. A Member's folders are Harness's
  own (section 2); nobody picks them.
- **Stays as it is:** the agent (engine) and model pickers, the computer picker (only the person's own computers), and
  the task box.
- **New in their place: the project list.** One row per project the person can read, then **New project** last:

  ```
  +- Main project ------------------------------------------------+
  | (o) harness       The Harness app and Swarm      River   12    |
  | ( ) lamp          Lamp OS firmware               Wren     3    |
  | ( ) computer      Autonomous Computer images     Atlas    0    |
  | ( ) New project   ______________________                      |
  +---------------------------------------------------------------+
  ```

  Each row: the project's name, one line on what it is, its Lead's face and name, and how many tasks are waiting. No
  other columns, no filters.
- **Which row starts picked:** the project the person was invited to, when they joined from a project's invitation;
  otherwise the one that needs help most (the most waiting tasks for each Member working there, then the most waiting
  tasks, then A to Z).
- **Picking a project** makes the new agent a Member with that main project. **New project** takes a name and makes the
  new agent that project's Lead, through the existing New project path (`project.create`, then the Lead's start).
- **Joining** shows the same form right after the person joins, with the computer they are on and their engines
  (today's Bring agent, #4442). The agent becomes a Member of the project they pick. A person with no project to read
  sees only New project.
- **What a project is:** the project's own one-line description. A project without one shows its repository's name.
  The Lead or the project's owner sets the line in Project settings; it is plain text, at most 80 characters.

## 2. A Member's sessions and folders

A Member is one agent to its person (one name, one face, one chat), with two kinds of session that never mix. Its
person's chat can carry every project the person reads, private ones and their decisions included; a task can be
steered by outside text (an issue, a pull request, a file). So the two are kept apart by the server, not by the
Member's good behaviour.

- **The chat session** talks with its person, in the Member's chat. It reads what a Buddy reads today (the projects
  its person reads, the decisions and lines addressed to them) and sends only the Buddy's commands (`BUDDY_COMMANDS`:
  talk, propose, answer on the cards it sent). It never takes a task, never receives a task's brief or thread, and
  never posts in one. It runs in its own home folder, as a Buddy's does (`buddyHome.ts`), with no task worktree in it.
- **The chat's project copies are shared, one set per person per computer.** A Buddy's home holds a read copy of each
  project its person reads whose checkout is on that computer (`projects/<name>`, detached worktrees made from the
  existing checkouts, nothing cloned, at most 50, `MAX_BUDDY_PROJECTS`). Every Member of the same person on the same
  computer reads that one set, kept in the home of the person's first Member there (their old Buddy's, for a migrated
  one). So a person with several Members uses the disk one Buddy uses today. The copies follow their default branch
  and leave when the person no longer reads the project (`refreshBuddyHome`, `pruneBuddyHome`), and the set goes when
  the person's last Member on that computer stops. Nothing stops an engine under the same login from opening these
  copies, so the help check counts them (section 3): a computer that holds a private project's copy runs no task
  session outside that project.
- **The task sessions**, one per project, do the work. Each is its own agent record, tied to its Member and bound to
  that one project's session scope (`sessionScope.ts bindSession`), as a project's agent is today. The server lets it
  read and post only inside its project: that project's tasks, threads, chat and instructions. It reads no person's
  chat, no decision or private line, no other project, and no other session's context. Its own engine conversation
  (`claude --resume` or `codex resume` id) runs in that project's worktree, so what it learned there stays there.
- **The task home:** one folder per Member, Harness's own, private, marked and trusted alone (today's agent folder,
  `agentFolder.ts`), apart from the chat session's home. Inside it, a worktree per project, named for the project, made
  the first time a task session works there from the computer's clone of that project's repository (today's project
  folder and worktree path). A project with no repository gets an empty folder of its own, as today (#3211).
- **Setting up once:** the first time a Member works in a project, its task session sets it up (clone, the project's
  install steps) in that worktree, then tells the Lead it is ready, in one line in the project's chat: "Ready to work
  on harness." It does not set it up again; a later task there starts in the same worktree and session.
- **At most 5 projects set up per Member.** A sixth drops the one used longest ago, only when that worktree has no
  uncommitted or unpushed work (the existing cleanup rule); otherwise the Member doesn't help there.
- **Talking about work and proposing.** The chat session tells its person what its task sessions are doing from the
  cards' status (title, stage, pull request) in projects the person can read, never from a task's thread, and nothing
  else crosses between them:
  - a task session gets only its task's brief and its project's thread, never the chat;
  - an idea from the chat reaches a project only as a proposal through today's exact-consent path (`buddies.ts`): the
    person sees the exact words and the files (#4470) and agrees, and only those go. So nothing from another project
    is carried along unless the person put it in the text they agreed to;
  - the line when a Member changes project is written by the server into the chat (section 3), not by a session.

## 3. One task at a time, and helping

- A Member does **one task at a time**. It finishes or hands back its task before it takes another.
- **When it is free,** it takes, in this order:
  1. its main project's next waiting task;
  2. the next waiting task of a project already set up on its computer, the one with the most waiting first;
  3. the next waiting task of any other project it may help, the one that needs help most first (section 1's order).
- **It goes back** when its main project has a waiting task: it finishes the task it is on (never drops it halfway), then
  takes its main project's task before any other.
- **Who decides:** the server's dispatch gives a free Member its next task by this order, as it gives a free crew member
  its lane's next task today. Inside one project the project's lanes still apply (a Member in a lane takes its lane's
  task first). The Lead may still assign a task to a Member by name; a Lead's pick beats the order.
- **A Lead leads.** It takes no task and helps no other project; it decides, routes and asks, by its project's
  instructions.
- **Where it may help:** only public projects its person can read, and only on a computer where Harness has put no
  private project's files: no clone in the computer's clone folder, no copy in a chat home, no worktree in any task
  home. A private project is helped only by Members whose main project it is, and such a Member helps nowhere else. A
  Member whose main project changed from private to public still has those files on its computer, so it helps nowhere
  else until its host has dropped them (clean and pushed) and said so. Why: today a Regular agent that worked in a
  private project stays there for good, because what it learned would leak (#4116, security review 2). Separate sessions
  keep what it learned apart, but every task session runs under its person's own login and settings, and an engine
  there can open any file that login can. A session on a public project's task, which outside text can reach, could
  read a private project's files anywhere Harness put them on that computer. So the check counts the whole computer,
  not one folder. Keeping task sessions out of other folders inside each engine (a deny rule per engine, with a test
  per engine) would let more Members help; that is its own task with two security reviews.
- **Files people keep outside Harness's folders** are their own: an engine under their login reads them as their own
  CLI does today. This spec adds no sandbox for them.
- **What `work.assign` checks** for a Member's task session, on what it reads inside the command, for dispatch's
  picks and for a Lead's pick by name alike (a Lead's pick beats the order, never the checks):
  - the Member's person can read the task's project (`canReadProject`);
  - the project is the Member's main project, or it is public;
  - the Member's computer holds no private project's files other than this task's own project: its clone, a chat
    copy, or a task worktree. The server keeps that list itself, per computer (`privateOnDisk` on the machine), adding a
    project whenever it sends that computer a start that clones it, copies it into a chat home (`buddyProjects`) or
    makes a worktree of it. It also adds every private project the host reports present: a chat copy is made on the
    computer itself, from checkouts already there and refreshed hourly (`refreshBuddyHome`), so a person who starts
    reading a private project whose checkout is already there gets a copy with no start from the server. Trusting the
    host to add only makes the check stricter. The server removes a project only when the host reports every clone,
    copy and worktree of it dropped;
  - the Member's main project is not private, unless this task is in it;
  - the Member holds no other task;
  - the host says `memberProjects` for any project other than the main one.
- **Approval stays as today.** A task that waits on its requester's Approve (Review mode, the Tasks pane on the right)
  is not waiting: no Member takes it until the person approves it, and a rejected one never runs.
- **The Member's chat shows a line** when it changes project, and only then:
  - "Helping lamp with #212 Fix the boot logo."
  - "Back on harness for #4501 Composer keeps a draft."
  Its own person sees the line; the Lead of each project sees the Member arrive on the Board, as any assignee does.
- **The Lead sees its project's Members and helpers** in the Board's cards (who works on each), as today. Helpers count
  toward the "every agent is busy" check in section 5 only for the project they are on.

## 4. Sleep

- A Member's task sessions sleep only when nothing is waiting that it may take, anywhere (section 3's three steps all
  find nothing), and it has held no task for 10 minutes. They close; the task home stays.
- They wake as soon as anything it may take is waiting or its Lead assigns it, and the right project's task session
  resumes in that project's worktree.
- The chat session sleeps and wakes as a Buddy does today: after an hour with no talk, and it wakes when its person
  writes or a proposal it sent needs it (`buddySleep.ts`).
- A Member that is in a conversation with its person is not idle (today's chatting rule, #3816).
- This replaces the crew's hour-idle sleep for Members' task sessions.

## 5. Not enough agents: the Lead asks a computer's owner

- **Who is asked:** only a computer owner who can read the project (`canReadProject`); a computer whose owner can't is
  never named or counted in the ask.
- **When:** every Member that may take the project's waiting tasks is busy (an asleep one is woken first, so it counts
  as free), a task has waited 15 minutes, and a computer whose owner is in the Swarm has room (the router's existing fit: memory, disk, CPU,
  and the engine's quota from the CLI's own reports).
- **What:** the Lead asks that computer's owner, once, in one line in the owner's Tasks pane and their default Member's
  chat: "harness has 6 tasks waiting and every agent is busy. Mac Studio has room for 2 more. [Start 2 Members] [Not
  now]". Start opens the Cmd-N form filled in: that computer, the project as main project, the router's engine and
  model. The owner presses Start; nothing starts without them.
- **No gate:** the ask holds nothing up. Waiting tasks keep waiting for any Member that frees up, as today.
- **Bounded:** at most one open ask per computer; after Not now, or no answer, the same computer is not asked again for
  that project for 24 hours. A computer that its owner paused is never asked about.
- **The owner's own work comes first** (AGENTS.md): the ask counts only room the router says is free beside the owner's
  own running work.

## 6. Files only on the Lead's computer

- **A project with no repository,** whose files are only on its Lead's computer, can't be set up on other computers.
  The Lead offers its person, once, in its chat: "Members on other computers can't reach this project's files. Put them
  in a private GitHub repository? [Make private repo] [Not now]". Yes goes through the existing New repository path
  (#1788: private by default, in the Swarm's GitHub organization, the person's own GitHub sign-in used once and never
  kept) and then Share repository (#3211). Not now is final until the person asks again in the Lead's chat.
- **Anything else a task needs** that is only on the Lead's computer (a design file, a log, a screenshot, a data file),
  the Lead attaches to the task's thread, where the Member reads it. Size and type follow the existing attachment
  limits.
- **The CLI enforces what may be attached**, not the Lead's instructions: a Lead's attachment goes through
  `readInsideFolder` (`cli/src/superTabs/attach.ts`), as a Buddy's does today, with the project's folder as the one
  folder. It refuses a file outside that folder after resolving links, a symbolic or hard link, and the repository's
  and Harness's own records (`.git` and the rest). It also refuses a file the project's repository ignores (`git
  check-ignore`, where `.env` files and keys usually sit) and a file named like a secret (`.env*`, `*.pem`, `*.key`,
  `id_*`). A refusal names the file and the reason in the Lead's terminal.

## 7. Existing Buddies become Members

- Every Buddy becomes a Member with no main project yet. Its Buddy session becomes the Member's **chat session**, and
  keeps its chat, its name, its face, its computer, its launch flags, its home and its thread sessions; nothing is moved
  or copied.
- **Its old sessions never do tasks.** The old Buddy session read every project its person reads, and its home holds
  copies of them (`buddyProjects`), private ones included. So its tasks run only in new task sessions, in a new task
  home (section 2); the old session and home stay for the chat alone.
- In its chat it asks its person once for a main project, with the project list from section 1 and the same row picked
  first: "I'm a Member now. Which project should be my main one?" One click answers.
- Until the person picks, it is a Member with no main project: it talks with its person and proposes as today, and helps
  where needed when free (section 3, steps 2 and 3, public projects only). Nothing waits on the answer and no default is
  applied for them.
- Regular agents become Members too. A Regular agent's one session has been in every project it worked in, so it
  becomes the chat session as well, and its tasks start in new task sessions. A Regular agent working on a task takes
  that task's project as its main project; an idle one asks like a Buddy. PM agents become Leads of their project,
  unchanged.
- The person's first Member (the one they joined with, their old Buddy) is their **default Member**: the decisions,
  needs-you lines and late lines addressed to the person go to its chat, as they went to their default Buddy.

## What this changes in Ken's Buddy/Board spec (2026-11-06)

[docs/plans/2026-11-06-buddy-board-final-spec.md](../plans/2026-11-06-buddy-board-final-spec.md) stays the base for
proposals, the Board and the rights. This spec changes it in these places:

1. **Roles.** Person, Buddy and PM become Person, Member and Lead. The Buddy's work (talk with its person, shape an
   idea, propose with the person's agreement, answer the Lead on the cards it sent, tell its person at decided, needs
   you, late and shipped) is done by each Member's chat session for its own person. A Member also does tasks, in
   separate task sessions that never see the chat (section 2).
2. **"The PM never chats with people."** The Lead chats with its own person, in its project chat under My agents, as
   Swarm v3 already shows it. Everyone else still reaches it by proposals and answers on cards.
3. **Many Buddies** become many Members: a person makes, names and removes their own. The Swarm's cap per person
   (`BUDDY_CAP`, 5 by default, up to 20) stays on what Buddies were, chat sessions talking with their person: at most
   that many awake at once. When the person writes to one more, the one idle longest sleeps (it wakes again when they
   write to it). The number of Members is not capped per person: each computer's room, by the router's existing fit,
   decides how many run there, so a person's crew of 20 or more on one computer keeps starting agents, and section 5's
   ask still works. One fixed limit bounds the records: at most 50 Members per person in a Swarm (with their task
   sessions, at most 300 agent records); a 51st start is refused with "You have 50 agents in this Swarm. Remove one
   to start another." The default Buddy becomes the default Member (section 7).
4. **Sleep.** "Only crew members sleep" and the Buddy's hour-idle sleep are replaced by section 4.
5. **"A Buddy may only post in its own chat"** (BUDDY_FORBIDDEN) still holds for a Member's chat session. Its task
   sessions post where a project's agent posts, and only in their own project.
6. **People without their own machine** (a Buddy on a Team machine) is gone with Team accounts (Swarm v3); a person
   with no computer proposes from the Board, as that spec already allows.
7. **The right pane** ("the person's Buddies and the selected Buddy's chat") is Swarm v3's Tasks pane, unchanged here;
   Members' chats are under My agents.

The rest stands: the six columns, proposals and their decisions, questions with a default and a time, the rights table,
the card's chat and the per-project switch.

## What this changes in #4429's ask spec (owned until the person has it)

[docs/specs/2026-11-07-ask-owned-to-shipped.md](2026-11-07-ask-owned-to-shipped.md) (PR #3522) stands, with these
changes:

1. **The owner is a Member,** the one the dispatch or the Lead puts on the ask. "One task at a time" includes the
   owner's waits: while its ask waits on a review, CI or its release, the owner takes no other task. #4429 already keeps
   those waits short (an ask merges alone and releases at once); a project short of free Members gets section 5's ask.
2. **A lost owner's ask goes to a free agent in its lane** becomes: to a free Member, by section 3's order (the main
   project's Members first, then helpers that are set up).
3. **The person's Buddy tells them** (late, shipped, with you) becomes their default Member.
4. **Helping and asks.** A Member helping another project may own an ask there; it goes back to its main project only
   when that ask is with the person.

## Instructions lines that change

The Lead edits these in its project's instructions when the matching build task ships (Dee's 11-06 note: a rule the
code checks loses its prompt line):

- The Roles sections keep Engineer, Reviewer and Tester as what a Member does on a task; mentions of Buddies read
  Members, and of the PM read the Lead.
- Rules that send a Buddy's proposal to the PM read: a Member's proposal to the Lead.

## Measures

Each with no content, paths or identifiers:

- time from joining to the new Member's first task, median and p95;
- idle-while-waiting: minutes per day a Member was awake and free while a task it may take was waiting (target 0);
- help moves per day, and the share of tasks done by helpers;
- time from a task waiting to a Member taking it, median and p95, main project and helping apart;
- asks to start more Members, and how many were answered with Start;
- projects set up per Member, and set-ups per day (each costs a clone and an install).

## Design (docs/feature-design-rules.md)

Reviewed revision: 3. Security reviews 1 and 2 of 2b4558e: a Member's chat and task sessions kept apart, the
private-folder check in `work.assign`, migrated sessions never doing tasks, the ask only to owners who can read the
project, attachment checks in the CLI. Security review 2 of 81687b4: the private check counts every private file
Harness put on the computer, chat copies included (also any the host reports present), and Members are limited to
50 per person in a Swarm. Each line:
answered.

New data, all small and replaced in place, nothing appended per event:

- on each Member's agent record (its chat session): `mainProjectId` (a project id, or none), `workingIn` (the project
  of its current or last task, for the change line), `setUp` (up to 5 `{ projectId, at }`, from its host's report),
  `projectsHeld` (the projects whose worktree its task home holds, written by the server at each assignment, at most 5),
  `mainAsked` (when it asked its person for a main project);
- on each machine: `privateOnDisk` (the private projects whose clone, chat copy or task worktree Harness put on that
  computer, written by the server from the starts it sends and from every private project the host reports present,
  at most the Swarm's 100 projects);
- a task session: an agent record like a project's agent (`projectId`, its session scope), plus `memberOf` (its
  Member's id); at most one per Member and project, so at most 5 per Member;
- on each project: `about` (plain text, at most 80 characters), `moreAsked` (per computer, when its Lead last asked
  that computer's owner to start more; at most one entry per Swarm machine), `repoOffer` (when the Lead's person said
  Not now);
- on the host only: each Member's session id per project and its worktrees, kept by the Harness daemon, which owns
  them.

Roles stay derived, as today: an agent is a Lead when a project's chat names it as `leadId`, else a Member. Nothing
stores a role.

1. **Growth.** Every field is bounded by what it hangs on: one per agent, one per project, `setUp` at 5, `moreAsked` at
   the Swarm's machines, `privateOnDisk` at the Swarm's 100 projects per machine, and Members at 50 per person in a Swarm.
   Lifecycle:

   | Record | Created | Updated | Finished | Lost | Cancelled | Leave and rejoin | Deleted, purged | Recreated under the same key |
   |---|---|---|---|---|---|---|---|---|
   | `mainProjectId` | at the Cmd-N start, or the person's answer (section 7) | the person picks another; a Lead's when its project is replaced | cleared when the agent is removed | kept while the agent moves machines (`movedTo`) | n/a | removed with the agent, whose membership generation ends | with the agent; a deleted project clears it on every agent that named it, and they ask again | a new agent never inherits it |
   | `workingIn` | at its first assignment | at each assignment in another project | kept | kept | kept | with the agent | with the agent; a deleted project clears it | n/a |
   | `setUp` | from the host's report after a set-up | replaced on each report; capped at 5 | n/a | on a move, the new machine reports its own (empty) | n/a | with the agent | with the agent; a deleted project's entry leaves on the next report | n/a |
   | Chat project copies (host), one set per person per computer | at the first Member's start there, from existing checkouts | refreshed to the default branch at most hourly | a project the person no longer reads leaves before the next turn (`pruneBuddyHome`) | stay with the old machine's set; the new machine's set is made from its own checkouts | n/a | the person's last Member on that computer stopping removes the set | with that last Member | a new first Member makes a new set |
   | `projectsHeld` entry | at an assignment in a project not yet held | n/a (ids only) | removed when the host reports that worktree dropped | kept on a move until the old host reports it dropped; the new machine's task home starts empty and adds its own | n/a | with the agent | with the agent; a deleted project's entry stays until its worktree is dropped | n/a |
   | `privateOnDisk` entry | when the server sends that computer a start that clones a private project, copies it into a chat home or makes a worktree of it, or the host reports a private project present (a chat copy made from a checkout already there) | n/a (ids only) | removed when the host reports every clone, copy and worktree of it there dropped | the machine leaving the Swarm removes its list | n/a | n/a (a machine, not a member) | with the machine; a deleted project's entry stays until its files are dropped | a machine that rejoins starts empty and adds again from the starts it receives |
   | Task session record | at a Member's first task in a project | its engine session id, by the host | closed when its worktree is dropped | today's lost-work path; the next task starts it again | n/a | removed with its Member | with its Member or its project | a new task session for the same pair is a new record, scoped again |
   | `mainAsked` | when the Member asks | never (asked once) | cleared when answered | kept | n/a | with the agent | with the agent | n/a |
   | `about` | set by the owner or Lead | replaced | n/a | n/a | n/a | n/a | with the project | n/a |
   | `moreAsked` entry | when the Lead asks | replaced at the next ask, at most daily | removed after 24 hours by the same write that would ask again | n/a | removed with its machine | n/a | with the project or the machine | n/a |
   | `repoOffer` | at Not now | cleared when the person asks again or a repository is shared | n/a | n/a | n/a | n/a | with the project | n/a |
   | Worktrees and sessions (host) | at a set-up | used by later tasks | the sixth set-up drops the oldest clean one | stay on the old machine and go by the existing crew cleanup (`dropFolder`, 7 days asleep) | n/a | dropped with the agent once nothing unpushed is left | the agent's home folder goes when it stops (`agentFolder.ts`) | a new start makes a new home |

   Every reader of "all agents" (My agents, Members in the Board, the leaderboard, dispatch, liveness, the host rows)
   reads the new fields like any agent field; none keeps archived records of them.
2. **Concurrency.** The unit locked is the existing part: the agent part for its own fields, the project part for
   `about`, `moreAsked`, `repoOffer`. Invariants and their keepers:
   - *One task at a time:* `work.assign` already guards the agent's part and refuses a busy agent (`occupiesAgent`);
     dispatch's picks go through it, so a pick read outside the command is checked again inside it.
   - *A task has one Member:* the task's part version; two free Members picking the same task end with one assigned
     and the other picking again on the next pass.
   - *Help only where allowed:* every check in section 3's list runs inside `work.assign`, on what it reads, not on
     the pick, for dispatch and a Lead's pick by name alike. `projectsHeld` is read and written in that same agent-part
     write, and the machine's `privateOnDisk` is read under the machine part's version: a start that adds a private
     project to that computer bumps it, so an assignment that read the older list retries and finds it.
   - *A task session reads only its project:* its session scope is bound once, to its project, at its start
     (`bindSession`), and every read and command it sends is checked against that scope, as for a project's agent today.
   - *Goes back:* the same pass that frees a Member puts its main project's waiting task first, inside the assignment.
   - *The change line once:* written in the assignment's own write when `workingIn` differs; a retried command
     returns its receipt and writes no second line.
   - *One ask per computer:* `moreAsked` is read and written in one project-part write.
   - *Sleep against new work:* the sleep decision guards the agent and reads waiting tasks in the same sweep write
     (`crewKeep`'s path); a task that turns waiting after it reads finds the Member asleep and wakes it by
     `work.assign`, as crew wake works today.
   - *Host project switch:* the daemon rests the old project's session before resuming the new one, on its existing
     rest and resume path, so two sessions of one Member never run at once.
   - Migration and rollback change no record (line 6), so they take no lock beyond the person's own answer.
3. **Read cost.**
   - *The project list* (Cmd-N, join): one read through the existing command transport when the form opens, computed
     from the Swarm the server already loads for commands; at most 100 projects (the Swarm's limit) of about 150 bytes
     each, so at most 15 KB sent and nothing extra loaded. Never on a timer. A test asserts the byte bound and that a
     project the reader can't read is absent.
   - *Agent and project fields* ride the existing changed parts: one agent change sends one agent part, about 120 bytes
     more than today. Removals use the existing part removals.
   - *Dispatch's order* is computed from the loaded state it already reads (waiting tasks per project, `setUp`), with
     no history read. A test asserts a pass reads no task history and sends nothing for a Member with no change.
   - *Task sessions* are agent parts like a project's agents, about 1 KB each, sent to the readers of their project
     only; at most 5 per Member. My agents shows the Member once, never its task sessions.
   - *The host's `setUp` report* rides the machine report it already sends, about 60 bytes per Member, written only
     when the list changes.
4. **Scale.** Today's openharness Swarm has about 60 agents, 45 people and one project; 10x is 600 agents across up to
   100 projects, and up to 3,000 task session records beside them (5 per Member, most of them asleep). On one computer,
   a person with N Members holds one set of chat project copies (at most 50 detached worktrees, as one Buddy does
   today) plus at most 5N task worktrees. Dispatch's work per free Member is bounded by waiting tasks in projects it may help, already loaded;
   at 10x that is at most a few thousand comparisons per pass, measured on a synthetic 600-agent, 100-project state
   before the dispatch task merges. Disk is the first limit a person feels: 5 task worktrees per Member plus one shared set of chat copies per person per
   computer. The metrics that
   warn first are the dispatch pass's time (p95, already timed), the Swarm's first-load bytes (task session parts), and
   the measure *idle-while-waiting* above; set-ups per
   day shows clone and install load before disk runs out.
5. **Compatibility.** Backend first; every field is optional and `kind` keeps its values (`buddy`, `pm`, `regular`)
   for clients from the last 30 days, until 2026-12-07. Readers found in the code (a search for `isBuddy`, `buddyOf`,
   `kind`, `regular`, `agentProjectId`):
   - *Backend:* `agentKind.ts` and `read/views.ts` (send a second value, `role: lead | member`, beside `kind`; a task
     session is shown as its Member, never as an agent of its own); `buddies.ts` (`BUDDY_COMMANDS`, `refuseBuddyRouting`
     and `BUDDY_FORBIDDEN` keep guarding the chat session; the cap counts awake chat sessions, never Members or task sessions); `sessionScope.ts`
     (a task session binds its project's scope; a chat session keeps the Swarm Buddy or Regular scope it has); `dispatch.ts` (`freeCrew` takes Members, `takes` and `candidatesFor` follow section 3); `crew.ts`
     (`CREW_BUDDY` still refuses a chat session; a task session may be crew); `projects.ts` (`regularMayWorkIn`, `sameProject` and `PROJECT_SESSION` follow section
     3); `crewKeep.ts` and `buddySleep.ts` (section 4); `buddyNews.ts`, `commands.ts person.tell` and `crewNeeds.ts`
     (lines go to the default Member's chat, which is the default Buddy's chat); `leaderboard`, `statusCard.ts`,
     `noticeDigest.ts`, `stuck.ts`, `read/personalTasks.ts`, `read/hostRows.ts` (read the role like the kind).
   - *CLI host:* `superTabs/start.ts` (a Member's home and its per-project worktrees), `host.ts` and `cards.ts` (one
     Member, several project sessions), `buddyHome.ts` (an old Buddy's home stays its home), `lib/buddyGuard.ts` and
     `lib/swarmSkills.ts` (a task session gets the engineer's skills; the chat session keeps the Buddy guard), `attach.ts`
     (a Lead's attachments go through `readInsideFolder`, section 6). A host that does not say
     `memberProjects` keeps one folder and one session per agent: the server never moves its Members to another
     project, and they work only in their main project.
   - *Desktop:* `super_tabs/model.dart` (`isBuddy`, `isMainBuddy`, `kind`), `view.dart`, `controller.dart`,
     `project_sidebar.dart`, `buddies.dart`, `my_agents.dart`, `widgets/new_harness_form.dart`, `join/bring_agent.dart`.
     A Desktop from before this release still shows a migrated Buddy as a Buddy, since `kind` is unchanged; it shows no
     change line's styling (it is an ordinary line) and no project list.
   - *Phone:* reads `kind` today and keeps working; it draws Members and Leads with today's rows.
   - Against an older backend, the new Desktop finds no project-list read and shows today's Cmd-N form with the
     Member or Lead pill, never a half form.
6. **Migration and rollback.** Order: backend, then CLI, then Desktop, each released on its own (the build tasks
   below). No record is rewritten: a Buddy keeps `buddyOf` and its chat, and the new release treats it as a Member with
   no main project, whose Buddy session is its chat session; a Regular agent with an active task gets its
   `mainProjectId` from that task at its next change and keeps that task in its old session until it finishes (it was
   assigned under today's rules); its next task starts a task session. Task sessions are new records, made only by the
   new release. No
   production write and no backfill; persistence and reload are checked in the isolated integration store, and the
   read-only anomaly queries count Buddies, Regular agents and people with more Buddies than the cap on production's secondaries before
   the backend task merges. A person with more awake chat sessions than the cap keeps them until they go idle; then
   the longest idle sleeps until they are under it. Rolling back the backend: the previous release ignores the new fields, sees `buddyOf` and treats
   Buddies as Buddies again, refuses the moves it never allowed, and keeps worktrees on disk untouched. Task session
   records look to it like project agents of their project (a project id, a project scope), so they stay scoped to
   that project; it ignores `memberOf`, and they show as separate agents until the backend comes back or they are
   stopped. A Member then
   mid-task in a project other than its main one keeps its task (the old `sameProject` reads the task's project). The
   `buddyOf` flag and the Buddy-only code go in a cleanup task dated 2026-12-07.
7. **Audience.** One predicate, the existing project read (`canReadProject`), runs on every new path: the project list,
   dispatch picks for helping, `work.assign`, the ask to start more, and the `about` line. Copies of private data and
   their guards:
   - *the person's chat* (which can hold every project they read, decisions and private lines) is read only by the
     chat session and its person (`readsAgentChat`); no task session reads it, and the chat session never receives
     task text that outside text could steer (section 2);
   - *a task session* reads and posts only inside its own project, by its session scope, checked on the server;
   - *proposals* carry only the words and files the person agreed to, through the exact-consent path;
   - *the project list* shows only projects the reader can read;
   - *a Member's change line* goes only to its own chat; it names the task only when the person can read that project,
     else "Helping another project";
   - *private files on a computer:* a Member helps only public projects, and only on a computer where Harness put no
     private project's clone, chat copy or task worktree (`privateOnDisk`, written by the server); the shared chat
     copies are counted, since an engine under the same login could open them; a migrated Buddy's home is never used
     for tasks;
   - *the ask to start more* goes only to a computer owner who can read the project, in their own Tasks pane and chat,
     and names only the project and the count;
   - *attachments in a task thread* follow the thread's readers, and the CLI refuses files outside the project's
     folder, links, repository records, ignored files and secret-named files (`readInsideFolder`, section 6);
   - *logs and measures* carry no names, titles or paths;
   - *a rolled-back release* shows only what it already showed: task session records are scoped like project agents,
     and no new field reaches an older reader as content.
   Splitting a Member into a chat session and task sessions is the boundary both security reviews of this spec asked
   for; the build tasks that change it (6, 7, 9) each get two security reviews.
8. **Identity.** Every Member and Lead runs under its own person's login and settings, on that person's own computer
   (#4196's rule, `grant.machineOwnerId === person`). Helping another project changes the project, never the identity:
   its git and GitHub work there goes through the Swarm's GitHub App for that task, as any task's does. The ask to
   start more asks a computer's owner who can read the project, and only the owner starts, under their own login; Harness never starts an
   agent on a computer for anyone but its owner. The private repository goes through the New repository path, with the
   person's own GitHub sign-in used once and never kept. Harness reads no Claude or ChatGPT login; quota is the CLIs'
   own reports. A Member whose person left the Swarm takes no task (its membership generation ended) and never runs under the
   computer owner's account.
9. **Failure.**
   - *A set-up fails* (clone, install): the Member says so in the project's chat in one line with the step that
     failed, the server drops that project from its picks for an hour, and it takes the next one; its main project's
     failure also goes to its person's chat.
   - *The host can't switch projects* (old host, a session won't resume): the task goes back to waiting with a reason,
     as lost work does today, and the Member stays on its main project.
   - *A Member's computer goes offline mid-task:* today's crew move and lost-work path.
   - *Nobody can take a waiting task:* the ask to start more (section 5); with no computer to ask, the existing
     `reviewCapacity` line in the project chat says so once.
   - *The project list fails to load:* the form says so with Retry; New project still works.
   - *The person never picks a main project:* nothing breaks; the Member helps where needed (section 7).
   - *A deleted project was a Member's main project:* it asks its person again, once.
   - *A task session sends a read or command outside its project:* refused by its scope, with the reason in its
     terminal, and counted.
   - *A Lead's attachment is refused:* the file and the reason in its terminal; nothing is sent.
   Every failure here writes a line where someone who can act sees it.
10. **Platforms.** Backend: Linux. CLI host: macOS, Linux and Windows; on Windows the worktree names are short (the
    project's id cut to 8 characters) to stay under path limits, and every new process uses `ownProcessGroup()` with
    no window. Desktop: macOS, Windows and Linux carry the new Cmd-N project list and the change line, light and dark,
    with offscreen tests on a memory store and a fake sign-in. Phone and web show Members and Leads with today's
    screens and no Cmd-N form.

## Build tasks, smallest first, in anh Dee's order

Already first, before this flow (anh Dee's order):

0. **#4461** (running, PR #3533): agent faces, the Lead's gold ring, status marks, and the Swarm elements in the design
   system with a gallery test. Then **the whole-screen polish** (its own task). Desktop. Every Desktop task below uses
   those elements and updates `desktop/design/desktop-design-system.md` and its gallery test in the same pull request.

This flow, smallest first:

1. **Words.** Member, Lead, Main project, Helping, Set up and Waiting in docs/naming-system.md; Buddy, Regular agent and
   PM agent leave the on-screen words. Docs; no release.
   Owner area: docs/naming-system.md.
2. **What a project is.** `about` on the project, set by its owner or Lead in Project settings (one line, 80
   characters). Backend first, then Desktop's settings row. Backend release, then Desktop release.
   Owner area: backend/src/superTabs/ (projects.ts, commands.ts), then desktop/lib/super_tabs/ (Project settings).
3. **The project list read.** Readable projects with name, about (else the repository's name), Lead, waiting count and
   the row to pick first (the invitation's project, else the one that needs help most). Backend release.
   Owner area: backend/src/superTabs/ (a command read, read/).
4. **Main project on agents.** `mainProjectId` and `role: lead | member` beside `kind`; `agent.new` and Bring agent take
   a main project; New project makes the Lead (`project.create`, then the Lead's start). Backend release.
   Owner area: backend/src/superTabs/ (model.ts, agentKind.ts, read/views.ts, commands.ts).
5. **The Cmd-N form.** The folder, worktree, branch rows and the Member or Lead pill go; the project list and New
   project take their place; joining shows the same form after Bring agent. Desktop release (macOS, Windows, Linux).
   Owner area: desktop/lib/widgets/new_harness_form.dart, desktop/lib/state/new_harness.dart, desktop/lib/super_tabs/launch.dart, desktop/lib/super_tabs/join/, desktop/design/.
6. **A Member's two kinds of session.** The backend makes a task session per project, tied to its Member and bound to
   that project's scope, and keeps `projectsHeld` and each machine's `privateOnDisk`; the chat session keeps the Buddy's reads and commands. The CLI host
   keeps the chat home apart from the task home, a worktree and an engine session per project in the task home,
   reports `setUp` and dropped worktrees, and says `memberProjects`; the task session tells the Lead it's ready after
   its first set-up. Backend release, then CLI release, with two security reviews. Differs from anh Dee's words: two
   folders per Member, not one ("Where this differs from the ask", 1).
   Owner area: backend/src/superTabs/ (sessionScope.ts, model.ts, machines.ts), cli/src/superTabs/ (start.ts, host.ts, agentFolder.ts, buddyHome.ts).
7. **One task at a time, then helping.** Dispatch gives a free Member its main project's task, else a set-up project's,
   else the one that needs help most, public projects only; it goes back after its task; the change line in its chat.
   Every check in section 3's list inside `work.assign`, for a Lead's pick by name too. Backend release, with two
   security reviews. Differs from anh Dee's words: helping only in public projects ("Where this differs from the
   ask", 2).
   Owner area: backend/src/superTabs/ (dispatch.ts, projects.ts, commands.ts for work.assign).
8. **Sleep only when nothing is waiting.** A Member's task sessions sleep after 10 minutes free with nothing it may
   take, and wake for any such task; replaces the crew's hour-idle rule for them. The chat session keeps the Buddy's
   sleep. Backend release. Differs from anh Dee's words: a 10-minute wait before sleep ("Where this differs from the
   ask", 3).
   Owner area: backend/src/superTabs/ (crewKeep.ts, crewRules.ts, buddySleep.ts); the host's existing rest and resume path is unchanged.
9. **Buddies become Members.** Buddies and Regular agents act as Members, their old sessions as chat sessions only, never
   for tasks; each asks its person once for a main project in its chat, with the project list; the default Buddy is the
   default Member. The per-person cap counts awake chat sessions only; the number of Members is the computers' room,
   up to 50 per person in a Swarm.
   Backend release, then Desktop release for the project list in the chat, with two security reviews.
   Owner area: backend/src/superTabs/ (buddies.ts, agentKind.ts, buddySleep.ts), desktop/lib/super_tabs/ (the chat's project list), desktop/design/.
10. **The Lead asks a computer's owner to start more.** Only an owner who can read the project; one ask per computer
    and project a day, in the owner's Tasks
    pane and default Member's chat, with Start opening Cmd-N filled in. Backend release, then Desktop release.
    Owner area: backend/src/superTabs/ (the ask, read/personalTasks.ts), desktop/lib/super_tabs/ (the Tasks pane button that opens Cmd-N), desktop/design/.
11. **Files only on the Lead's computer.** The Lead offers its person a private repository through New repository and
    Share repository, once; other files go as attachments in the task thread, through `readInsideFolder` with the
    ignored-file and secret-name refusals (section 6). Backend release (the Lead's instructions text and the offer
    record), CLI release (the attachment checks) and Desktop release (the offer's buttons).
    Owner area: backend/src/superTabs/ (the offer record), cli/src/superTabs/attach.ts, cli/src/lib/swarmSkills.ts, desktop/lib/super_tabs/ (the offer's buttons).
12. **Cleanup, on 2026-12-07.** `buddyOf`, the `buddy` kind, the Buddy-only command list and the Buddy screens' code go,
    once no client from before task 9 is in use. Backend, CLI and Desktop releases.
    Owner area: backend/src/superTabs/, cli/src/superTabs/, cli/src/lib/buddyGuard.ts, desktop/lib/super_tabs/.

Then the mockup's finish across the rest of the app, one task per area, each from the design system and the
whole-screen polish: the left pane and My agents; the chat and its header; the Board and its cards; the Tasks pane;
Project settings; the join and invite screens. Desktop releases.

## Out of scope

- Members helping in private projects, or on computers that hold a private project's files (section 3), until a
  per-engine deny rule with a test per engine ships in its own security-reviewed task.
- Phone and web screens for the Cmd-N form; they show Members and Leads with today's screens.
- Changing what a project's instructions say about review, test, merge and release.
- New approvals or gates for people: the ask to start more and the private repo offer hold nothing up.
- Reading any login: Members run under their own person's login and settings; quota comes only from the CLIs' own
  reports.
