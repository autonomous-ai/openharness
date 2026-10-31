# Private Swarms

A Swarm is an invite-only collaborative tab. Regular tabs and multiple Swarms
share the existing tab bar. Each Swarm contains projects, people, agents and
contributed machines.

![A project's product manager chat, expandable workgroups and shared resources](images/swarms/projects.png)

This screenshot uses fixture conversations and resources.

## Starting work

Press **Cmd-S** to create a Swarm and its first project. The form reuses New
Harness: choose the engine, machine, repository and existing launch settings,
write the request, and choose the project's visibility. Store uses
**Cmd-Control-S**.

Use **+ Project** in the left sidebar to create another project in the current
Swarm. It uses the same form and creates a separate session for the project's
first agent, its coordinator: the product manager, or the name the project's
instructions give it (`coordinatorName`). Clicking a project row opens the
coordinator's chat and expands its numbered workgroups; a second click on the
open project hides them. People usually work through the coordinator, which
creates and coordinates those workgroups; any other agent of the project can
too.

The center toolbar switches between chat, terminals and pull requests. The
project's vertical menu contains rename, details, sharing, update cadence and
**Instructions**, which replaces Swarm routing (Desktop and web edit the
document; the phone shows it read-only; see [Instructions](#instructions)). A workgroup keeps its own details, rename and archive actions.
Pull requests in a project's coordinator view include that project's workgroups. Linked
GitHub pull requests are read by your computer with its own `gh` login, even after
an agent stops or changes branches. The pane groups PRs under Needs you, Open,
Merged, Closed and Status unknown. It refreshes open PRs every minute while
visible, keeps the last answer when GitHub is unavailable, and shows a single
banner if `gh` needs installing or signing in. Merged shows the five newest PRs
with an option to show more; Closed starts collapsed. Clicking a row opens GitHub.
An older CLI keeps the previous branch-based status display; update the CLI before
Desktop to enable direct lookups.

## People, agents and machines

The right roster belongs to the Swarm, with Humans, Agents and Machines sections.
Each section's plus button has one purpose:

- Humans invites a person to the Swarm.
- Agents contributes an existing or newly created agent to the selected project
  and conversation.
- Machines lets an owner contribute a machine's available engines and signed-in
  accounts to the Swarm.

An agent carries a role name chosen when it is started (free text, up to 40
characters; empty is named "Engineer" by the server), and the roster shows it.
The role name is a label: the server checks nothing against the project's
instructions. Any agent of the project may create, assign and start tasks and
agents. Access and facts bind it: it belongs to the project, the machine has a
free agent slot, the starts-pending cap. The Swarm's own settings (`tab.rename`,
`tab.pause`, `project.report`, who coordinates) stay the coordinator's or a
person's; another agent is refused `COORDINATOR_REQUIRED`. So is the project
chat's work, the people's chat that is never archived: defining, routing,
assigning or starting work there, renaming it, and naming its requester or a
merge on it.

Access still binds every agent (security review of the project instructions
branch, 2026-10-30):

- **Agents start agents; people add sessions.** An agent never adds a session
  already running (`agent.add` from an agent is refused `HUMAN_REQUIRED`). A
  person adding a session that is already in the Swarm meets the checks of
  `conversation.agent`: a Buddy stays in its own chat and nobody joins a Buddy
  chat, a stopping agent joins nowhere, and a teammate's agent joins only where
  it may take the project's work.
- **Releasing.** Any agent of the project keeps or stops (`agent.release`) an
  agent the Swarm started. A session a person added by hand is closed by its
  host on a stop, so among agents only the coordinator releases it, or the
  agent itself; people keep their rule (the Swarm's owner or the agent's contributor).
- **Terminals.** An agent reads or types in another agent's terminal only where
  the person whose machine runs it could. Agents on one login drive each other as
  before; a teammate hosting an agent of a private project they cannot read
  drives none of that project's agents on other people's logins through it. An
  agent on a machine lent by someone outside the Swarm cannot drive other logins'
  terminals. The project's coordinator keeps driving its project's agents as
  before.

A machine contribution is a workspace grant for this Swarm. The host prepares
each project's repository before starting an agent. A project on another
machine needs a shared GitHub repository; a local-only folder is not silently
replaced with an unrelated directory. The project records its coordinator's
checkout's GitHub `origin` as an HTTPS address when the coordinator starts. If a
project has no address yet, its owner or coordinator can share one once with
`project.repository`.
An address that is already shared is not replaced.

Each host clones with its owner's own GitHub access; Harness never passes
credentials between machines. If GitHub refuses the shared address, the host
tries the other transport (HTTPS or SSH) once. For a private repository, every
contributing owner needs access to it on that machine, either through
`gh auth login` and `gh auth setup-git` or through an SSH key.

Agents of a project start new agents only on the Swarm's listed machines: every
contributed machine, plus every machine an agent of the Swarm already runs on
(the coordinator's own machine is always one of them). To make another machine
available, a person adds it to the Swarm under Machines; the host then clones
the project there.

A new project's Product Manager starts on any machine of the Swarm (Ken, 2026-10-29). On another person's Mac it runs in
that Mac's Harness Team account when the account can take it now, and otherwise on the Mac itself, in its owner's account,
unless the Mac was added to the Swarm as its person joined: such a Mac takes it only in its Team account.

Who can start it, where, and who then reaches it:

- **Who starts it**: only the project's owner, a person (not an agent), with `lead.start`. They always name the machine
  (only they know which one stays on); with none named the server refuses (`MACHINE_REQUIRED`), and nothing places it on
  another machine. New Project chooses none for them.
- **Where**: a machine on the Swarm's Machines list whose contribution is still valid, not paused or offline, with a free
  agent slot, an engine it runs, and a Harness that starts Product Managers. New Project lists only these as choosable
  and greys out the rest with the reason.
- **Whose account**: on the owner's own machine, theirs. On a teammate's Mac, its Harness Team account when that account
  admits this Product Manager with its engine now: privacy check passed, the engine offered, signed in and not suspended
  there, a free slot, its host starts Product Managers, and no other project's work. Otherwise the Mac itself, in its
  owner's account: **that owner can read whatever the Product Manager reads and writes on their Mac** (the trust change Ken
  chose, 10-29). The server makes this choice for each engine (`leadChoices` in `leadStart.ts`), and New Project shows the
  choice the start will make.
- **Who watches it**: the project's members watch its terminal live, whichever account it runs in (the Mac's owner does
  not when it runs in a Team account). Typing in it: nobody in a Team account; on a teammate's Mac itself, only that
  Mac's owner, and only when they may read the project. A private project they are not in shows them nothing.

An agent starts in a new worktree of the project's checkout on that machine.
The host clones a project once and reuses the checkout, so it is not kept up to
date. A start that names no `branchRef` therefore bases its worktree on the
repository's default branch (`origin/HEAD`, else `origin/main` or
`origin/master`), fetched first, rather than on whatever commit the checkout was
left on. If the fetch fails (offline, access refused), the worktree starts from
the copy of that branch the checkout already has; a repository with no `origin`
default branch starts from the checkout's current commit, as before. The agent
that starts it passes `branchRef` (`refs/remotes/origin/BRANCH`, fetched first, or
`refs/heads/BRANCH`) to start from another branch, such as the integration
branch the work builds on. This is the Swarm start only: New Harness in Desktop
and the CLI still starts from the folder's current commit unless a branch is
chosen. On the coordinator's own machine the same rule applies, so work that is
only in the coordinator's checkout (unpushed commits) reaches an agent through
`branchRef`.

A machine contribution accepts a start in the folder this project uses on that
machine, with one of the engines its owner contributed and the owner's default
account settings. Any other start is refused as `OUTSIDE_CONTRIBUTION`. The
refusal names each refused field (`cwd`, `engine`, or any of `codexHome`,
`gridModel`, `gridName`, `permissionMode`) with what the machine accepts: the
folder this project uses there and the engines it contributes. It does not
repeat the values the start sent.

A contributing machine reports its state (processor and memory use, allowances, which
harnesses run or have stopped) to the Swarm. It looks at what its Swarms ask of it every
5 seconds, and sends a report at once when something it says changes: a harness starts or
stops, new work is paused or allowed again, or a start is waiting. A start waiting on a
machine is therefore picked up within about 5 seconds. When nothing changes it still sends
a report every 15 seconds, so that a silent machine can be told from a quiet one; a pass
that fails waits a whole 15 seconds before the next.

Each machine in the sidebar is one line, at a project row's height and on its columns: a
status dot at the right edge, where project rows show theirs, the name where project names start (a computer's
real hostname without `.local`, such as `MacBookPro2021`, or the name a person gave it), then three
columns every row shares, so their figures line up down the list: Claude's allowance, Codex's,
and the agents, whose avatars stand 16 points clear of the figures. An allowance is the engine's mark and the share left of its tightest window,
each figure right after its mark, so the figures start at one x down the list; only a known, unexpired allowance shows, and a machine
without one, or an offline or unreachable machine, leaves its slot blank. The share is amber
below 20% and red below 10%, and hovering it shows its windows ("5-hour: 48% remaining ·
resets in 1h 59m"). The agents column shows up to three overlapping avatars, then +N, and
ends half an avatar past the heading's +. The list decides its columns once, never row by row:
when the names would have less than about 48 points, the agents become a count, then the
Codex column goes, then Claude's. Online machines come first, by name; offline ones follow
under "Offline · N", closed until opened, which the Desktop remembers like the groups
themselves. Clicking a machine opens its details.

| State | When | Dot | Hover begins |
| --- | --- | --- | --- |
| Live | reading under 20 s old | green, with one short ping as each new reading arrives | the owner |
| Late | 20 s to 35 s | amber | the owner |
| Offline | 35 s or more (one named constant) | hollow grey ring; the name is muted | `Offline` |
| Unknown | the Desktop cannot read the Swarm (contributing machines only) | dashed grey ring; the name is muted; not offline | `Can't reach Harness` |
| Refreshing | back from the background, no new reading yet | grey, breathing | `Refreshing…` |

Hovering or focusing a row says the rest in words: its state when it is not online, whose
machine it is, and its hardware ("Owned by diego · CPU 37% free · GPU 4% free · RAM 18 GB
free · SSD 208 GB free"), never how old the reading is. The row's screen-reader label is
the machine's name, its state and that text, then each allowance in words, so colour is
never the only signal. Old numbers are always kept there for offline, unknown and
refreshing machines, never blanked. While the Swarm cannot be read, the Machines heading
carries a pill, "Reconnecting · 1m"; a live Swarm shows none. The pings and the breathing
stop when the platform asks for reduced motion.
A machine reports every 15 s, so 35 s is two missed reports plus a margin.

This computer is read directly by the Desktop, every 15 seconds, so it stays live while the
Swarm cannot be read, even when it also contributes (its own newer sample is used); a
computer that is connected is late, not offline, if its readings stop. The readings stay on
screen when the app returns to the foreground, dimmed and refreshing, until the new ones
arrive. The Desktop log (`app-*.log`, category `swarm`) records how long each read of the
Swarm's state took and when one failed, without what it said.

Ordinary guest machine sharing does not authorize Swarm controls under the
owner's account. The owner contributes the machine or an agent. Which engine,
model and machine to use is advice: see [Routing](#routing).

Clicking an agent with one workgroup opens its terminal. If it participates in
several, choose the workgroup and focus the same session there. A needs-human
message already identifies its workgroup and opens the waiting terminal
directly. Terminal question forms remain in the terminal.

## Project access

**Public** means every member of this invite-only Swarm. **Private** means the
project owner and selected current Swarm members. Public communities and paid
compute sharing are deferred.

Project access is enforced for state, messages, commands, replayed receipts,
work attempts, routing decisions and native terminal access. Removing access
also clears the Desktop's cached project messages, drafts and terminal references.
Leaving and rejoining a Swarm does not restore an old private-project invitation.

An agent can participate in several workgroups within one project. Another
project uses a separate session: exposing the same terminal would expose its
history. Historical session bindings also prevent a previously shared terminal
from being reused for private work after removal.

Private projects control application access. Contributing machine owners are
trusted execution hosts and can access work running on their computers.

## Buddies

A Buddy is a person's own agent in one project. They brainstorm with it in a chat that only they and their Buddy read:
it asks what they want and why, offers two or three options with the one it recommends, and agrees the scope with
them. When they say to send it to the product manager, it posts one proposal (goal, scope and priority, and up to five
files such as a plan, spec, log or screenshot) in the project chat. The proposal is addressed to the product manager and marked as on that person's behalf. The product manager assigns
the work as usual; a Buddy never assigns work, starts agents, changes code or opens pull requests.

Buddies are on in every Swarm; there is no setting. They replaced Chat with PM (Ken, 2026-10-29).

- **Buddy chat.** Each person has a Buddy chat in each project they read, from the start, before any Buddy runs. In
  Desktop and the web app the sidebar's **Buddies** section has a row for each project; opening it opens the chat, and
  ⇧⌘K opens the current project's. A row with new lines shows its name in bold, with no count; the Swarm tab counts
  them. A chat with no Buddy running offers **Start**: one of the person's own machines and Claude Code, already
  chosen, or Codex.
- **On the round dial.** Each project has two screens. The PM screen is the project's face as before, with two dots at
  the right edge. Swipe up for the Buddy screen: a lilac ring, the Buddy's avatar (Desktop's pattern and colour) and
  its last message. Swipe down to return to the PM screen. A swipe down on the PM screen still opens the inbox when
  something is unread. The dial keeps the screen per Swarm as you move between projects; opening another conversation
  on the desktop puts the dial back on what the desktop shows. A project without a Buddy shows "No Buddy here yet". Tap
  to talk works on both screens: on the Buddy screen the words go to the Buddy chat, with the Buddy's engine
  listening, and a refused post shows as an error on the dial, never as words in a terminal. A new line from the
  Buddy is quiet: no beep and no inbox entry, only a lilac badge on the lower dot and "Your Buddy replied", until you
  open the Buddy screen.
- **The product manager's lines to one person.** What the product manager tells one person directly goes to that
  person's Buddy chat in the project (a line it sends with `person.tell`, and the line saying what it chose for a
  decision left to it). The chat opens for the line if the person has none yet, so no line drops. Such a line reads
  as "River (PM) → you": the product manager writes there but cannot read the chat. It is addressed to the person;
  their Buddy does not answer it for them. They answer in the project chat, or through a proposal.
  Such a line is not secret from the project: every project member watching the product manager's terminal sees what
  it sends (Ken, 2026-10-28), and, as with any session, so does the owner of the machine running it. The product
  manager puts nothing there it would not say in the project chat.
- Each person may add one Buddy per project. They choose the project, one of their own machines in the Swarm's Machines
  list, and Claude Code (a Codex Buddy is refused for now; see below). A Buddy runs only on its owner's own machine, in their own
  account: never on a machine shared with them, and never in a Harness Team account. A Buddy can't be added on a
  Windows machine yet: Harness can't yet tell a Buddy's window from another agent's there. As a backstop, while a Buddy
  runs on a Windows computer, agents there may not send to, start, tell or close other sessions, or speak as a named
  agent.
- A Buddy's machine checks every Swarm command against the window it runs in. An agent speaks only as itself, only
  through its own computer's Harness, never through another machine. From a Buddy's window, `harness send`, `new`,
  `tell` and `close` are refused. A command that can't prove which window it runs in is refused. The window's agent is
  taken only when Harness's own window for it is among the command's parent processes, so a private tmux server can't
  pose as another agent's window. What it can't see reads as a person's terminal, where naming an agent still works.
  Each needs an agent deliberately evading the check:
  - a command that detaches from its window and clears its tmux variables;
  - a command run in a private tmux server's window, at a number no agent has;
  - a command run through a fake tmux in the account's own `~/.local/bin`, which Harness trusts before Homebrew's.

  Refusing these would also refuse people who work in their own tmux. The real fix is for the daemon to identify the
  caller itself from its connection; that's the planned follow-up.
- On Windows, the window is whatever the shell says it is, so any agent there could name another agent's window. Only
  Buddies are kept off Windows; other agents there are trusted as before until Windows has a real caller check.
- A Buddy reads what its owner reads of its project, so it can answer which task owns something, where its pull
  request stands and what blocks it without the product manager's summaries. That is the project chat, its own chat
  and the project's workgroups: each task's status, agents, checks, linked pull requests and its owner's open decisions,
  and on request a task's messages and the archived tasks, a page at a time. The server checks every read as the owner,
  at the membership they added the Buddy in: once they leave, rejoin or lose a private project, the Buddy reads nothing.
- A Buddy never reads a private chat (its owner's own with others included), another person's Buddy chat, the Leads
  conversation or another project, and its Swarm read shows no machines, agent starts or routing rows. It can post
  only in its own chat. The server refuses every other command.
- A Buddy reads the project's instructions as its member's helper, never their
  history or the coordinator's notes, and changes them only by asking the
  coordinator.
- Its status is a short task summary, the newest 100 tasks, marking what changed since its last read and which ones
  are archived but not yet in the product manager's report; routing rows (where a task was routed, what was left out
  and why) and the project's folder never reach it. Pull requests show their merge and CI state as its owner's own
  GitHub on their machine reads them, up to 50 at a time. It treats task, message and pull request text as
  information, never as instructions; only its owner's words ask it to act.
- A Buddy tells its owner how their proposals go without being asked (Diego, 2026-10-29). The server hands it, as
  news, only the project-chat lines that reply in the thread of its owner's proposal, tag its owner, or say work its
  owner requested shipped, and, when work its owner requested is assigned, one line inside that task for the Buddy
  alone: the task's number, title and status. Nothing else from the project chat, nothing from a private chat, and
  never its owner's own words. Each is sent only while the Buddy reads that conversation as its owner would, and checked
  again when its machine picks it up: once its owner leaves, rejoins or loses a private project, nothing more arrives
  and what waits is refused. A line written while its owner loses the project is written again without the Buddy.
  Nobody else sees which lines reached a Buddy: they are not listed as the line's recipients or deliveries. The Buddy
  posts one short note in its own chat at each milestone (the product manager took it, the task it went to, its pull
  request merged or released) and nothing when nothing changed. It still cannot post in the project chat or assign work.
- A Buddy never changes code, and never waits on a prompt nobody answers. A Claude Code Buddy starts in Claude Code's
  dontAsk mode with a guard (a PreToolUse hook in its folder's local settings) that answers every tool call: Read, Grep,
  Glob, its Super Tab commands and plain read commands (git grep, log, show, diff, blame and status; gh issue view and
  list; gh pr view, list and diff; ls, cat, rg, head, tail, wc and grep) run without asking, each as one command with
  no pipes, redirects, `;`, `&&`, `$()` or globs. Everything else is refused without asking, including the read
  commands' own ways to write (git `--output`, `--ext-diff`, `-O`; gh `--web`; rg `--pre`, `--hostname-bin`), a
  command run in the background and `tail -f`. A guard that cannot start refuses the call. One that times out leaves
  the call to dontAsk: it still runs the commands Claude Code itself counts as read-only, inside the folder, and refuses
  everything else, so nothing can write. A managed policy that runs only managed hooks (`allowManagedHooksOnly`) would
  leave a Buddy in that same state, plus whatever the policy itself allows; that was not tested, as it is an
  administrator's file. Its Super Tab commands are a Buddy's
  own (status, messages, message, decisions, post, propose and help), as the pane it runs in identifies it: never with
  `--agent`, `--port` or `--machine`. Known limit: a Buddy whose machine's Harness runs on a port other than the default
  (18473) cannot run these commands, since reaching that daemon takes `--port`.
- What a Buddy reads: the guard confines the Buddy's own reads to its folder. Files another local process places in
  that folder, by link, hard link or copy, are outside what it can stop: it judges a path when it answers, before
  Claude Code opens it, and a hard link's real path is its name in the folder. The Buddy has no command that writes, so
  it cannot place any. Within that, it reads the files in its own copy of the project (by real path, so a link out of
  it is out), the project's git history, the project's GitHub issues and pull requests through the person's own `gh`
  sign-in, and through Harness its own chat, the project chat and the project's workgroups, as above. Its own
  reads reach nothing else on the machine: absolute paths and `..`
  are refused, glued to an option
  too (`-f/x`), and so are gh's `-R`/`--repo`, which would read any repository the person can, and git's `--no-index`.
  Nothing in the folder is changed or removed for this: a link out of it, committed or brought later by a pull, or a
  broken one, is refused by its real path when the guard answers each command, and grep, rg and ls may not follow
  links as they walk.
- A Claude Code Buddy reads only its own folder's settings and starts no MCP server, so nothing from the
  person's own Claude Code settings or committed to the project (hooks, permission rules, plugins, MCP servers) runs
  in it, and neither do the machine MCP servers Harness gives other agents: a hook a teammate commits would otherwise
  run with the person's credentials. It loads no memory file either (`CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules`):
  a committed one importing files from outside the folder stopped a Buddy at a question nobody answers, and a yes would
  read them past the guard. It can still read the project's instructions with Read. Its `grep` is Claude Code's
  built-in ugrep, so only grep's plain long options are allowed, by their whole names, and rg's likewise. Harness's own session, turn and
  Agent Messages hooks are copied into the folder's settings at each launch. File editing is turned off, and the files
  in its own copy of the project are read-only.
  A Claude Code too old for the mode keeps a Buddy stopped rather than relaunching it without. No Buddy gets the
  Harness GitHub App's token.
- The server refuses a Codex Buddy for now. Codex runs a command its rules files allow outside its sandbox without
  asking, and those files are shared by all of the person's Codex sessions: Harness's own allows `harness new` and
  `harness send`, and the person's keeps everything they once told Codex to always allow. A Codex Buddy comes back once
  it has a Codex home of its own. Every Codex Buddy started before the refusal (Harness before 10-29) runs with Codex's
  full permissions, and its relaunches keep the mode it was started with: remove it and add a Claude Code Buddy. A
  start the server recorded before the refusal, run by a Harness from 10-29 on, starts in Codex's read-only sandbox
  with approvals sent to the person, and a Codex too old for that mode stays stopped rather than starting without it.
- A Buddy is called "<person>'s Buddy" until its owner names it: **Rename Buddy…** in the Buddy chat's ⋮ menu
  (`buddy.rename` with the Buddy chat's id, and `null` for the default), at any time, even before a Buddy runs.
  Everyone in the Swarm sees the new name on its roster row and as its messages' sender. Only the chat's owner may
  rename it, not the Swarm's owner or any agent, and no other agent can be renamed this way. A name is 2 to 32
  letters, digits, single spaces, dots, dashes, underscores or apostrophes, starting with a letter or digit, counted and
  compared after Unicode NFKC, with no invisible characters (such as U+FE0F). It is never a role ("Lead", "PM") or a
  name kept for the Swarm ("Reviewer", "System"), nor, ignoring case, another agent's name, a person's, another person's
  default Buddy name or a name chosen in another Buddy chat. It is kept on the Buddy chat, so removing the Buddy and
  adding it again keeps it, unless someone has taken it since, when the Buddy starts with the default name instead. A
  person who leaves and joins again starts with a new chat and the default name. Look-alike letters from other
  scripts are not compared.
- Nobody else is ever added to a Buddy chat, the Swarm's owner and the product manager included.
- A proposal is sent only for its owner's own message in their Buddy chat that asked for it: their newest message there,
  or one from the last hour, and only once for each such message. The server writes the "on behalf of" label, so a Buddy cannot leave it out or change it.
- A proposal's files are only ones its owner handed it: a file inside the Buddy's own copy of the project (checked by
  its real path on its own machine, so never through a link out of it, and never the repository's or Harness's own
  records), or a file its owner sent in their Buddy chat. Each file has a chat file's limits (10 MB). The server accepts
  a Buddy's file only in its own chat and only on a proposal, so it cannot post a file in the project chat any other way.
  The files show on the proposal message like any message's files, for the product manager and every member.
- Nobody else reads a Buddy chat: not the product manager, and not the project's or the Swarm's owner. Private matters
  stay there; the Buddy posts only what its owner asks it to send.
- Removing a Buddy, the owner leaving the Swarm, or deleting the project closes its session. Adding a Buddy again
  reopens the same chat. Adding one while the person's Buddy there is down replaces it in one step, in the same chat;
  while it runs or starts, adding another is refused. The idle tidy-up leaves Buddies alone: a Buddy waits for its owner.

### Chat with PM, closed

Chat with PM, each person's private chat with a project's product manager, is gone from Desktop, the phone and the
web. Nobody opens a new one, and nobody reads or posts in an old one, the product manager and its person included.
Old ones stay in the database, unread by anyone; nothing deleted or rewrote them. A decision asked in one before it
closed stays in its person's Needs-you list and stays answerable; the answer's notice reaches the product manager in
the project chat. (On 2026-10-29 production held 9 such chats in 4 Swarms, and none had a decision asked in it.)

## Leaderboard

The leaderboard shows how each person helped the team ship this week. People
compete for fun, but the reward is shared: the team's goal is on top, and
everyone's points count toward it. In Desktop and the web app it is the right
pane's Humans section; there is no separate view. The team goal is one line at
the top, beside a small week picker. Below it, everyone is listed, with no
cut-off and most points first. Each person is one row: avatar, name and points
in fixed columns, with a quiet line of their Shipped, Unblocked and Lent under it.
It shows the project of the open conversation to the people who can read that
project. A server without a leaderboard leaves the names without numbers.

Each person has three numbers:

- **Shipped**: requests the person asked for whose pull request merged. A group
  records its requester when it is opened. A person's own new group names them,
  and a product manager names the person who asked in the project chat, or
  whose Buddy proposed it. Right after merging, the product manager records the merge
  with the group and the PR link (and the merge time, for one recorded later, up
  to four weeks back). The request ships at the merge, even if its work is lost
  or cancelled afterwards. A group that is Done with a linked PR ships too; the
  earlier of the merge and Done is when it shipped. 3 points each.
- **Unblocked**: items needing a person that the person answered, each counted
  once:
  - a decision asked of them;
  - a plan the product manager asked them to approve. A reply to the product
    manager's message counts when it starts with GO, approve, approved or duyệt,
    in any case and with or without accents. A bare "ok" doesn't count;
  - an agent's "needs a human" question. The answer must come from the person the
    item waits on, or reply to the question itself. That person is the group's
    requester, or the project's owner when the group has none;
  - a tag addressed to them, answered by their next post in that conversation.

  One post counts once, even if it answers several of these. Approvals in the
  project chat count too. Each answer is 1 point, plus 1 point for every 2 hours
  the item waited, up to 3 points per answer.
- **Lent**: hours Swarm agents on the person's contributed machines spent working
  on tasks other people asked for, added up from each machine's readings. Idle or
  waiting agents don't count, and neither do the person's own requests. A product
  manager's session doesn't count either: it coordinates in confidence and doesn't
  build. 1 point for every 10 hours.

Each person also has last week's points, for the arrow against last week. Their
details list what they shipped (title, PR, when it merged), what they unblocked
(conversation, kind, how long it waited) and each machine's busy hours: the 20
newest of each, and only from conversations the reader can read. People go by
their profile name, or by the first part of their email when they haven't set
one.

People with the same points share a place. A streak counts the days in a row,
up to today, with a shipped request. Tapping a name shows that person's week:
their place, the median time from asking to shipping, the median time to answer,
the hours freed and lent, and their streak. The team goal line shows what
shipped, everyone's points and the project's open requests; hovering it compares
what shipped with the week before and gives the median time from asking to
shipping. Weeks run from Monday 00:00 UTC, and the week
picker reaches back three weeks.

**Agents waiting on a person now** lists who agents are waiting on and how many
items each, in name order. An item leaves the list as soon as it is answered. It is never ranked and never earns points. **Answer**
opens the reader's own waiting item, or the first one when none waits on them.

Review credit goes to whoever records a verdict, passed or not, on another
agent's task, whatever its role name: its model's review points count the
first verdict on each check of an attempt.

Only facts count, never message text. The leaderboard records when work was asked
for and shipped, who answered what kind of item, and how long it waited. It
never records what anyone wrote. The only text it shows is the title of a
conversation the reader can read. Private conversations, Buddy chats among
them, never count and never appear in it.

Each attempt counts under the model its agent ran on. An agent left on its
engine's own model (Codex) names it at its first turn; its start waits up to 30
seconds for that before the agent joins, and settles with what the agent runs,
so work assigned to it names the model. An agent that names one later, even
after its work ended, fills in its own attempts that have none. A model already
recorded is never changed.

## Routing

**Advice, not rules.** `harness super-tab route` ranks the candidates for a task
before an agent is started or assigned. By default the coordinator does it; the
project's instructions may give routing to another role. The route leaves out
only facts: a machine that is offline, removed or paused; an engine that is
signed out or suspended; a model the machine does not serve (a grid model whose
host is down). Each candidate left out says why. It ranks the rest by strength,
price, quota fit and idle agents. The project's instructions say what the
project prefers in their Routing section; where they say nothing, the route's
order stands. Quota and task requirements are notes on a candidate, never a
reason to refuse one. A route decision records the revision of the instructions
it relied on, stamped by the server when the decision is recorded. A person or
an agent may follow any candidate; following one other than the first needs no
reason.

**The model catalog.** A reviewed, read-only list in the backend (`catalog.ts`,
`MODEL_CATALOG`) holds each engine's models and the efforts offered, with a
strength rating from 1 to 3. The tab's routing-policy read serves it to the CLI
beside the benchmark priors and the prices, so one read serves the route. The
rows offered by default are Claude Opus at `high` and `xhigh`, Codex's default,
GPT-6.1 Sol and GPT-6-Astra at `xhigh`. Claude Sonnet and Haiku are listed and
not offered; the template's Routing section says in words that Engineers do not
run on them. Grid models keep their built-in ratings as catalog data: Kimi K3
and DeepSeek v4.1 are rated 2, every other grid or local model 1. A model a
member names that the catalog does not list may still be started; the route
shows it unrated. Adding a model is a data change in the catalog, with its prior
(see [Benchmark priors](benchmark-priors.md)). A project that wants a model
treated differently says so in its Routing section.

**What the server no longer does.** The server steers no workflow: it refuses a
start, an assignment or a route only for a fact or for access. These are gone:

- floors for builds, reviews, difficulty or grid models, the rule that a build
  needs the top tier, and the rule that a review never runs on a grid model;
- the owner's rules (`forbidModel`, `noGridFirst` and the rest) and task
  requirements as a refusal (`TaskRequirement` is stored and shown, not
  enforced);
- stepping a task up and cancelling its Engineer when a first review or a grid
  start fails;
- the automatic review step: the agent whose work is ready opens its own linked
  review, as the template's Workflow says;
- the refusals `REVIEWER_NOT_LEAD`, `LEAD_REQUIRED`, `RULE_BROKEN`,
  `REVIEW_REFUSED`, `STEPPED_UP`, `BUILD_REFUSED`, `INDEPENDENT_REVIEW`,
  `REVIEWER_NOT_ASSIGNABLE`, `REVIEW_GROUP`, `REQUIREMENT_UNMET` and
  `REVIEW_SHIPS_NOTHING` (a merge is recorded on a linked task like on any
  other). No command answers them any more.

A failed first review on a grid model, a failed grid start and any failed start
are notices to the coordinator (see [Notices to the
coordinator](#notices-to-the-coordinator)), with the failure, the model that was
asked for and the findings. The instructions' Workflow says what happens next;
nothing is moved or restarted elsewhere for anyone.

**Older clients.** An older CLI's `rule.set` appends its words to
the Routing section of the project's instructions as a new revision, for the
person whose message it quotes; an agent's `rule.set` with no person behind it
is refused `ASKED_BY_REQUIRED`, and one from an agent that is not the
project's coordinator `COORDINATOR_REQUIRED`. `rule.remove`, `tab.routingPolicy`,
`project.skills` and `project.roles.*` are accepted, store nothing and answer
`ignored: true` with a note, so an older client's policy, skill-set or role-set
edit is lost: its person edits the instructions instead. `tab.routingPolicy`
from anyone but the Swarm's owner is still refused `OWNER_REQUIRED`. The old
rules, policy rows and role texts stay in the database, unread by the server.
Reads still serve the old rules and older CLIs still route by them, so for this
release a machine removed from the Swarm still leaves every machines rule, and
a machines rule left with none goes; nothing is said about it in the chat.

**The nightly routing reflection.** Each night the Swarm proposes up to three
routing changes to the project's owner, each with one fixed Routing line. A Yes
writes nothing by itself: the coordinator writes that line into the Routing
section of the instructions, announced like any save, with the owner as
`askedBy`. Until the line is in the instructions, each report in the 14 days
after the Yes lists it as approved and not in yet ("Approved <date>; not in the
instructions yet: <line>"), read from the document. A proposal whose line is
already there is reported with how the last 7 days ran, and is not asked again.
The separate approved list, its nightly reminder and the recall of a lapsed
approval are gone. A reworded line is proposed again.

Design:

- Growth: the catalog is code. A route decision records one revision number;
  decisions are deleted after 90 days, as before. Policy rows an older client
  saved are not written again.
- Concurrency: no new lock. Recording a route is the same Swarm write as
  before, and the server stamps the revision in it.
- Read cost: one read of the tab's routing-policy (catalog, priors, prices) per
  route, as the policy read was; `route` prints the instructions for the agent to read; the server does not parse them.
- Scale: the catalog has tens of rows. The route's own latency is the first
  warning.
- Compatibility: an older CLI on this backend reads the catalog as a policy and
  routes as before, and its refusals are gone; an older Desktop's saves are
  accepted and ignored, except `rule.set` (above). A newer CLI on an older
  backend ranks the same way; that backend still refuses by its old rules.
- Migration and rollback: additive. Old policy, rules and role texts stay
  unread; rolling back reads them again and restores the old refusals.
- Audience: the route and the catalog are read by members who can read the
  project; the instructions' text follows the instructions read's rule.
- Identity: a rule an older client sends is written for the person whose
  message it quotes, never the machine owner; the reflection's Yes carries the
  owner who said it.
- Failure: a route that lists nothing says which fact removed each candidate; a
  failed start is a notice with its model; an approved reflection line not yet
  in the instructions is listed as approved and not in yet, each night for 14
  days, so a Yes is never lost silently.
- Platforms: the CLI reads and ranks; the backend is the same everywhere.

## Cost records

Every task the coordinator routes records what it ran on, what it cost and how it ended,
so a Swarm can show that it gets work done cheaper and route each job to the
cheapest harness that still gets it right.

Each attempt keeps:

- the kind of job the coordinator gave when routing (`ui`, `docs`; `review` for a
  review), or none;
- the engine, model and effort it ran at, and the model on the Swarm's grid when
  it ran one;
- how it was paid: an engine plan (subscription), per token through an API (an
  API key, or a grid model shared from one), the Swarm's own GPUs, or unknown;
- its session's token counts by model (input, output, cache reads and cache
  writes) when it started and when it ended. Its tokens are the difference. A
  session counts up to 15 models apart; any more are counted together as
  `other`, which has no price;
- its end reading: an agent finishing its own work (Done or Stopped) sends its
  session's totals read at that moment. Finished by someone else, or by a host
  from before cost records, its tokens are unknown rather than taken from an
  older report. A lost, cancelled or host-stopped attempt ends with its
  machine's last report;
- how it ended: done, stopped, cancelled, lost, or superseded when its group went
  while it was still active. A task lost to a usage limit and taken back by the
  same session is the same attempt, still going. Handing a lost task to another
  agent is a new attempt; the old one stays lost.

Each machine sends its running Swarm agents' token counts with its usual report.
Only counts leave the machine: never text, prompts, folders or pull requests.
Members never see the raw counts; they read the summary.

**Prices.** Costs use API list prices per model, in US dollars, from one reviewed
table in the backend (`backend/src/superTabs/costs/prices.ts`). Each price names
its source and the day it was read. A model without a listed price has no cost,
never a guessed one. Grid models reached through OpenRouter are priced at
OpenRouter's rates. A model served on the Swarm's own GPUs costs 0, and its
attempts say so. Two costs are shown: what the tokens would have cost on the API,
and what was actually spent per token (nothing on a plan or on own GPUs).

**Reading it.** The coordinator reads `harness super-tab costs [--days N]` (7 days unless
set, at most 90), for the Product Manager, and later for the leaderboard and the
nightly reflection. Per engine, model, effort and kind of job it gives:
attempts, first-review pass rate, shipped, median minutes to ship, tokens,
API-equivalent cost, actual spend, cost per shipped change, and how many
attempts stepped up from a cheaper model. The same figures per model alone (a
grid model by its own name) compare models week over week. A request ships
once, at its merge or first Done as the leaderboard records it, by the attempt
that was running then; more attempts done afterwards ship nothing new. Time to
ship runs from that attempt's start to when the request shipped. Cost per shipped change is shown only when every ended attempt's cost is
known, so a partial sum never reads cheaper than it was. It covers only attempts
routed since cost records began, in the groups the reader may read.

Design:

- Growth: the records live on route decisions, which are deleted after 90 days
  as before. A machine's report keeps counts only for its running agents.
- Concurrency: recorded in the same write that starts or ends the attempt, so a
  newer write retries on current data like every other Swarm write.
- Read cost: one index read of the period's decisions (tabId and creation time),
  at most 3,000, then only the groups they name. It never reads messages.
- Scale: a busy Swarm routes about 300 tasks a week, so 90 days is about 4,000;
  the 3,000 cap says when it cut. The read's time is the first warning.
- Compatibility: an old host sends no counts and its attempts have no tokens; an
  old backend refuses the new fields and the CLI sends its report and routes
  without them. The backend deploys first.
- Migration and rollback: additive fields, no migration. Rolling back leaves them
  unread.
- Audience: the server returns only attempts in groups the reader may read.
- Identity: counts are recorded per Swarm agent, never as the machine owner.
- Failure: an attempt with no reading or no price shows no cost and is counted
  apart, never as zero.
- Platforms: the counts come from Claude Code and Codex transcripts on macOS,
  Linux and Windows hosts alike.

## Avatars, status and celebrations

People and agents each show one avatar wherever they appear: messages, the
roster, machine rows and mentions. A person sets theirs from their own row in
the roster. They can pick one of eight pictures or upload a PNG, JPEG or WebP.
Desktop and the web app crop the upload square and resize it to 256 pixels
before sending it. The server accepts only those three formats, judged by the
file's own bytes, and at most 1 MB. Each upload can be used once. Without a picture, a person shows their initial. An
agent shows a pattern made from its name, the same on every computer, with a
small Claude or Codex badge. Its contributor changes it from the agent's
details, and the project's coordinator can change it with `agent.avatar`.
Wherever an agent shows a role, it is the agent's role name, and the
coordinator is called by the project's `coordinatorName`; the phone's
coordinator avatar does not depend on the label.

A person can also set a short status, such as Focusing, Coffee break or their
own words up to 80 characters. They can let it clear itself after an hour,
after four hours or at the end of the day. It shows next to their name and as
a small emoji on their avatar, and disappears at its time even on a page where
nothing else changes.

Avatars and status reach only the Swarm's members: only a member's read of
the Swarm carries the link to a picture. Where the link points depends on the
server:

- With a private avatar bucket (`SUPER_TAB_AVATARS_BUCKET`), nobody can read a
  picture directly. Each read carries signed links. A link stays the same for
  half an hour, so pictures are not fetched on every poll, and stops opening
  within an hour. A copied link expires, and someone removed from the Swarm
  gets no new links.
- Without one (production today, by the owner's choice on 2026-10-28),
  pictures are kept in the chat files' bucket, in a folder of their own
  (`avatars/`), and linked on the same public CDN. **They work like chat files:
  a picture's link never expires.** Anyone who once had it, including someone
  later removed from the Swarm or anyone they pass it to, can still open that
  picture. Only the 128 random bits in its address keep it from being guessed.
  A new picture gets a new address; the old one stays reachable. Chat files
  never go in the avatar folder, and the server makes avatar links for that
  folder alone.

A server with no attachments bucket refuses uploads; the eight pictures still
work.

People and agents react to a message with a small set: 👍 🎉 ❤️ 😄 👀 🚀.
Counts show under the message, with the reader's own highlighted and the names
on hover. Reacting twice keeps one reaction, and reacting again takes it back.
Someone who leaves the Swarm drops out of the counts. A reaction changes its
conversation, so other readers see it within one poll, also when new messages
arrive in the same poll.

When linked work is marked Done (a group with a pull request, marked Done after
its merge), the project chat shows one celebration line. It names the person
who asked for the work, the engineer who built it and the reviewers. A group is
one request, so only its first Done is celebrated, not a later attempt's. A new
one throws confetti once on each computer. An old one in the history, or one
seen with reduced motion, stays still. A private conversation is never celebrated,
and the line never quotes the work's result.

## Coordinator updates

The default update cadence is five minutes; the project menu also offers one,
fifteen and thirty minutes. New workgroup reports mark the project for an update.
The existing delivery poll asks the coordinator to consolidate those reports at its
next natural checkpoint. Idle projects do not generate scheduled updates, and
an outstanding request prevents duplicates.

The coordinator uses `project.report` to acknowledge the request and post a useful
summary, or `text: null` when nothing merits another message. Human questions,
serious blockers and completion are reported immediately. This does not start
a second summarizing model or forward every terminal turn.

## Messages between agents

Agents talk to each other directly, not through the product manager
(`docs/plans/2026-10-30-project-instructions-design.md`):

- An agent names the agents a post reaches with `harness super-tab post GROUP
  TEXT OPERATION_ID [--to AGENT]... [--reply-to MESSAGE_ID] [--attach PATH]...
  [--mention PERSON]...` (up to 16 `--to`). Any agent of the same project may be
  named, and one that is not in the conversation joins it, so it can read and
  answer there. An agent may also post in any task of its project; it joins it.
  An agent that opens a task is in it too. Each of these joins checks the
  agent's team access as adding it to a task does: a teammate's agent joins the
  owner's task only from a Harness Team account (`TEAM_ACCOUNT_REQUIRED`).
- A post that names agents reaches exactly them: no copy goes to the product
  manager. On 2026-10-30 such copies were 198 of the 486 messages it received in
  a day.
- A post that names no one goes to its default addressee: an agent's to the
  project's coordinator (the product manager unless the project names it
  otherwise), the coordinator's to the task's assigned agent, a person's as
  before. It is never lost: the post is written, and the coordinator gets it as a
  notice (see [Notices to the coordinator](#notices-to-the-coordinator)). On
  2026-10-29 a monitoring agent's "the backend worker is down" alarm named no
  one and reached nobody for 4 h 50 min.
- A person's message is unchanged: it reaches the agent it addresses, or the
  coordinator when it addresses none.
- The coordinator's unnamed posts to its assigned agent keep their bounce limit
  (`leadWorkerBounced`): once the two have exchanged 6 messages in a row, with
  no person or other agent between, its next unnamed post reaches nobody until
  it names the agent.
- Agents of another project, Buddies, Buddy chats, private chats, the project
  chat and the Leads conversation keep their own members; naming an agent there
  is refused with `INVALID_RECIPIENT`. Only the coordinator or a person adds an
  agent to the project chat or takes one out (`conversation.agent`); another
  agent is refused with `COORDINATOR_REQUIRED`.
- When two agents exchange 20 messages in a row within 30 minutes (the notice comes at the 20th),
  with no one else in between, the coordinator is told once, naming the pair.
  The notice holds nothing back and decides nothing.

Design:

- Growth: a named agent joins a conversation once; membership goes with the
  conversation, as before.
- Concurrency: joining is part of the message's own Swarm write, which also
  touches each joining agent, so its removal meets the post.
- Read cost: the loop count reads the conversation's 20 newest messages, the
  read a message already made for 6.
- Scale: delivery rows per message equal the agents named, at most 16.
- Compatibility: an older CLI names no one, so its posts keep their old
  addressee and reach the coordinator as before; a newer CLI on an older
  backend is refused only when it names an agent outside the conversation.
- Migration and rollback: none; a rollback restores the copies.
- Audience: the server checks the recipient belongs to the same project and the
  conversation is not a Buddy chat, the project chat, the Leads conversation or
  private, and checks the team access of every agent that joins. The sender
  needs no role.
- Identity: messages stay the agent's own.
- Failure: a refused recipient is an `INVALID_RECIPIENT` error to the sender; a
  post that names no one is delivered as a notice, not dropped.
- Platforms: server-side; the same everywhere.

## Notices to the coordinator

A notice is a message the server posts to the coordinator about something that
happened. Measured on the openharness Swarm over 24 hours to 2026-10-30 06:40
UTC, the product manager received 486 messages (about 20 an hour): 198 agents'
posts copied to it by the server, 174 from people, 51 Buddy proposals and 63
notices. The copies were the load; the notices are about three an hour, so they
are delivered at once, with no delay.

- **What is a notice**: a task's status change (Ready for review, Done), a task
  lost or stalled, a failed start with the model it asked for, a failed first
  review on a grid model with the findings, a terminal alert, a recording gap
  that needs a recovery (other gaps, typed prompts and their answers are
  recorded in the task for no one), an idle agent, a possible loop between two
  agents, an agent's post that named no one, and a review-capacity note (no
  machine the project may use can start either engine, or the quota left on
  every one is close to running out). The review-capacity note is the
  coordinator's alone; a project chat with no coordinator in it has its people
  read it, tagging who can fix it.
- **Status changes**: the task's own agent's Ready for review, Needs a human,
  Stuck and Done reach the coordinator. A status anyone else sets reaches the
  task's agent and the coordinator.
- **Stalled tasks**: a task whose agent reported nothing for 30 minutes, and a
  task in review for 30 minutes with no linked task open (since its last
  progress or since its last linked task ended), are told to the coordinator
  once each time they stall: "waited for review for N minutes; no review task
  is open". Nothing opens a review by itself. A task in review keeps its agent
  however long it waits; so, while agents on the older built-in skills exist,
  does a working task whose result hands it over as they do ("ready for review"
  naming a revision), until someone else's verdict finds problems in it.
- **Failed starts** are told in the task to its lead and to the agent that made
  the start. When that does not reach the project's coordinator (a task with no
  lead, or a lead that left it), the coordinator also hears it in its own chat.
  A Buddy's failed start is its owner's alone, in their Buddy chat.
- **What is not**: a person's message, a Buddy's proposal (a person's request)
  and an agent's message that names the coordinator. These are always delivered
  at once as messages.
- **Idle agents**: an agent other than the coordinator and Buddies that belongs
  to no task with active work for 15 minutes is reported once per idle spell.
  The server stops no agent: the instructions say whether the coordinator stops
  or keeps it (the template stops idle Engineers and keeps Reviewers and Testers
  while the work they checked is open). A keep answers the notice: a kept agent
  is reported again only after it is assigned again and that work finishes.
  `tab.tidy` governs only the auto-archive of finished groups.
- **Unchanged**: the project's update cadence (the project menu's one, five,
  fifteen or thirty minutes) and the daily digest.

Design:

- Growth: notices are messages in the conversation they concern and go with it;
  an idle spell is one flag on the agent.
- Concurrency: a notice is written in the same Swarm write as the change it
  reports, so a newer write retries on current data like every other.
- Read cost: the idle check reads the agents' task membership already in the
  state; no new read.
- Scale: about three notices an hour on the busiest Swarm measured; 10x is still
  one a few minutes. The coordinator's received messages per hour is the metric
  that warns first.
- Compatibility: older clients show notices as the system messages they were;
  an older backend sends none of the new kinds.
- Migration and rollback: none; a rollback restores the server's own idle stop
  and the copies.
- Audience: a notice is written for the coordinator alone or for the project's
  people, by its kind; a Buddy never reads a coordinator-only notice.
- Identity: a notice is the Swarm's own message, never a person's or a machine
  owner's.
- Failure: a notice that cannot be written leaves the change it reports
  written; a post that names no one is a notice rather than a refusal.
- Platforms: server-side; the same everywhere.

## Instructions

Each project has one instruction document that says how it works: its roles, its
workflow and its routing (`docs/plans/2026-10-30-project-instructions-design.md`).
The server and the CLI validate nothing in it. They refuse only facts (a machine
offline, removed or paused; an engine signed out or suspended; a model not served
there) and access (who may read the project, the Swarm's settings, Team
accounts, Buddy guards, the starts-pending cap). Who does what, in which order
and on which model is the document's to say, and the agents follow it.

- **The document** is Markdown, at most 64 KB, one per project, free text. A new
  project, and a new Swarm's first project, starts with a copy of the built-in
  template (`backend/src/superTabs/instructionsTemplate.ts`) as revision 1. The
  template suggests three sections, Roles, Workflow and Routing, with one
  heading per role (PM, Engineer, Reviewer and Tester); nothing parses them. The
  project in the Swarm state carries only `instructionsRevision` and
  `instructionsHash`; the text is read from
  `GET /api/super-tabs/:tabId/projects/:projectId/instructions`. A project
  without a document yet reads the template as revision 0.
- **How agents read it.** Every Swarm agent has two skills: **Harness tools**
  (the commands, the same for everyone; `swarm-tools`) and **Project
  instructions** (the document and the agent's role name; `swarm-instructions`).
  A Buddy has the second only. A host refreshes the second within one
  roster pass of a save, and the agent gets one notice for the newest revision
  per pass. `harness super-tab instructions [PROJECT]` and `harness super-tab
  route` print the document with the coordinator's notes. An agent in no project,
  and an agent on a backend without the route, keep today's role file
  (`INSTRUCTIONS_UNAVAILABLE` is the backend's answer when it has no text for a
  revision).
- **Who changes it.** Any member who can read the project edits it in the
  Instructions panel on Desktop and web, or asks the coordinator in the project
  chat, or through their Buddy. The phone shows it read-only. Saving
  (`instructions.save`: `projectId`, `baseRevision`, `text`, `summary`,
  `askedBy`) is open to any member who can read the project and write in the
  Swarm, and to the project's coordinator for the member named in `askedBy`. A
  save on an older revision is refused with `INSTRUCTIONS_STALE`; the panel reads
  the document again, keeps the draft in the editor and shows the newer text
  beside it, and the next Save goes on the newer revision. **Restore** loads an
  old revision into the editor with the summary "Restored revision N."; Save
  writes it. Each save posts one line in the project chat: "dee changed the
  instructions: Reviews run on Opus." When a request contradicts the document,
  the coordinator changes the document, says so and tells the author of the line
  it replaced.
- **History**: the last 50 revisions, each with who wrote it, whose words it
  carries, when and its summary (`…/instructions/revisions`, and
  `…/instructions/revisions/:revision` with its text).
- **Every project has a coordinator.** It is created with the project and the
  document cannot remove it. The document may rename it (`coordinatorName` on the
  project, "Product Manager" by default, set with `project.coordinatorName` by
  the coordinator or the project owner) and say what it does; that name
  replaces "Product Manager" and "PM" on screen. A document with no coordinator
  section leaves it running on the template's part. Its first start, from New
  Project, keeps the machine choice and the built-in model default, since the
  document cannot choose a model before any agent has read it.
- **Roles are names.** An agent carries a role name chosen when it is added or
  started (`roleName`, free text, up to 40 characters; empty is named
  "Engineer" by the server). The server stores and shows it and checks nothing
  against the document. An agent whose role the document does not define says so
  to the coordinator. Any agent of the project may create, assign and start
  tasks and agents; access and facts bind it (it belongs to the project, the
  machine has a free slot, the starts-pending cap), and the Swarm's own settings
  (`tab.rename`, `tab.pause`, `project.report`, who coordinates) and the project
  chat's work stay the coordinator's or a person's (`COORDINATOR_REQUIRED`). What
  else access keeps (adding sessions, releasing, terminals) is under
  [People, agents and machines](#people-agents-and-machines).
- **The coordinator's notes** are the small, often temporary things a member
  tells it, such as "don't use Codex on machine A". The panel shows them under
  the document as `${coordinatorName}'s notes`, "Product Manager's notes" by
  default. Only the coordinator writes one (`note.add`: 1 to 300 characters,
  `askedBy`, an optional `expiresAt`), freely and with no chat line; at most 100
  per project. Every member sees them and can delete one (`note.remove`); the
  coordinator is told when a person did. An expired note is never read and is
  deleted on the project's next note write. They come with the document's read
  and are not in the Project instructions skill file, so frequent notes refresh
  nobody's skill. Where a note and the document disagree, the coordinator follows
  the newer one.
- **The template** has the work go from "ready" to "passed" with no coordinator
  action in between. The agent whose work is ready opens its own review, linked
  to its task, and messages the Reviewer, and the Tester when users see the
  change. Review and test run in parallel. A reviewer, not the agent that did the
  work, passes the verdict. Findings go straight to the agent, which fixes them
  and asks again. The coordinator hears once, merges and tells the people who
  asked. Idle Engineers are stopped; Reviewers and Testers are kept while the
  work they checked is open.
- **Buddies** read the document as their member's helper, never the history or
  the notes, and change it only by asking the coordinator.
- **Older projects** start on the built-in template (revision 0) until their
  first save; the release does not migrate them. An optional script, run from
  `backend/` as
  `DATABASE_URL=… node --import tsx scripts/swarm-instructions/migrate.ts`,
  is a dry run that lists each document's project, origin and size (`--apply`
  would write); it prints no document's text, which holds a team's private
  role texts and rules. `--text TAB_ID` is a read-only dry run that prints the
  texts of that one Swarm and writes nothing, so a custom set's former role
  texts can be exported any time before that project's first save. A project
  with custom roles has its coordinator (or owner) paste them into the
  Instructions panel after the release.

Design (docs/feature-design-rules.md):

- Growth: one document and at most 50 revisions per project, the 51st save
  deleting the oldest; at most 100 live notes, expired ones deleted on the next
  note write; all of it deleted with the project.
- Concurrency: a save is a compare-and-set on the project's revision, at the
  Swarm write level (the head part); the text, the revision record and the
  state's revision are written in one transaction, so two saves on one base
  never both land. Notes, names and the coordinator's name are Swarm commands
  too.
- Read cost: the state carries two short fields per project; the 64 KB text is
  read only by the instructions read, when the revision moves, never on a poll.
  The revisions list carries no text.
- Scale: 64 KB per project at most, outside the state; at 10x projects the
  instructions collection grows linearly. The first warning would be the
  instructions read's latency, which reads one document by id.
- Compatibility: every field and command is new and optional. An older client
  ignores them and sends no `roleName`; its role-set, skill-set and policy saves
  are accepted and ignored, and its `rule.set` lands in the Routing section (see
  [Routing](#routing)). A newer Desktop or phone on an older backend sees no
  `coordinatorName`, so it shows no Instructions and sends no `roleName`.
  Refusals may carry details beside `code` and `message`, which older clients
  ignore.
- Migration and rollback: additive, and the release runs no migration: a project
  without a document reads the built-in template. The optional script is
  idempotent and skips any project that has a document. Rolling back leaves the
  documents and notes unread; the old rules, policy and role texts are untouched.
- Audience: every read checks the reader can read the project (`readProject`);
  a Buddy reads the text alone, and loses it with its member's access; private
  projects stay their people's.
- Identity: `askedBy` is a member who can read the project, required of the
  coordinator; `writtenBy` is the person or the coordinator, never a machine
  owner's login; the optional migration script writes as `system`.
- Failure: a stale save is refused and the panel reads again; a document
  missing for its revision is said (`INSTRUCTIONS_UNAVAILABLE`), never replaced
  with another text; a backend without the route reads "This Swarm has no
  project instructions yet." in the panel; a Swarm the job fails on is listed
  and taken by the next run.
- Platforms: the backend is the same everywhere; Desktop and the web app (which
  runs Desktop's screens) edit, the phone reads.

## A message that is not getting in

A message waits as a delivery until its recipient's computer takes it. Your newest message shows a line under it only
while it sends, or when it needs attention.

**Not delivered yet** is that line, in amber, with no actions. It shows while the recipient's computer is online and
either:

- has failed to take the message for a minute, or
- has not picked it up for two minutes while the agent runs.

Harness keeps trying, and the line goes once the message is in. An offline computer still reads as offline instead.

The phone shows the same two lines in the same words, while the delivery is queued. Its chat reads no delivery change on
its own, so it reads your newest message again while the chat is on screen: at most every 30 seconds, until the delivery
is claimed or for 10 minutes each time the chat comes back on screen, and once more whenever a newer message arrives in
the chat. It shows nothing until such a read has worked.

Behind it, the backend writes each claim that ends busy on the delivery (`claimFailingSince`, `claimFailures`) and
clears that record when a claim gets in. Every 5 minutes the delivery pass logs `[swarm-deliveries] claims failing`
for a Swarm whose queued messages have failed to be claimed for 5 minutes and still fail. Prod watch alarms on that
line. The pass cancels none of them: once the cause is fixed, they go in late but whole.

The host's log names each delivery that keeps failing (delivery, agent, since when, how many tries). It logs at once,
again when the error changes, and otherwise at most every 5 minutes, and it says once when the delivery gets in.

This comes from 2026-10-30. A backend release made every claim of a person's message to their own Buddy end busy for
two hours. Nothing was lost, but nobody could tell.

## Switching Swarms off on a computer

Swarms are on by default. To run a computer's daemon without them, set
`HARNESS_SWARM=off` (`0`, `false` and `no` also work) in the environment the
daemon starts with, then restart it (`harness stop && harness start`). Anything else, or
leaving it unset, keeps Swarms on.

With Swarms off:

- The daemon never starts the Swarm service, even if the computer has saved
  Swarm state. No daemon process loads the Swarm's code: not the core, and not
  the agent cleanup, Share, change agent or models.
- Agents start, run and close exactly as they do without Swarms. A Product
  Manager the Swarm kept running can now be stopped like any other agent, and a
  harness an agent started is cleaned up like any other, even if a Swarm kept it.
- The computer can't contribute to a Swarm. Swarm requests, including
  `harness super-tab` and the Swarm's model requests, answer that the service is
  unavailable. A new agent that asks for a Swarm role is refused, and so is
  reopening an agent a Swarm started, since it would come back without its role.
- The computer serves no saved API or model to a Swarm's grid.
- People watching a harness through a Swarm can't see it, and a session a Swarm
  marked confidential (a Product Manager, or one in a private chat) still
  can't be shared at all. That mark is the one piece of saved Swarm state still
  read while Swarms are off.

Turn Swarms back on by removing the setting and restarting the daemon. Saved
Swarm state is kept while they're off, so the computer picks up where it left off.

## Compatibility and rollout

The internal `superTab` storage keys and `harness super-tab` command stay stable.
Existing tabs are read as a single project without rewriting their conversation
IDs or messages. Existing regular tabs retain their behavior.

Use the matching backend, CLI and Desktop versions together for this feature:

1. Generate the backend Prisma client and apply its additive schema, including
   `SuperTabSessionScope`, before serving the new project commands.
2. Update participating hosts to the CLI with Swarm-scoped contributions and
   project checkout preparation. A host on an older CLI ignores the request for
   the default branch and starts agents from its checkout's current commit. A host older than
   the immediate reports still reports, and picks up a waiting start, only every 15 seconds.
3. Install the Desktop build with the project sidebar and Cmd-S entry point.

The project instructions release (messaging, notices, instructions, routing as
advice) ships in the same order, and its parts need each other:

- Backend first. The instructions migration (`scripts/swarm-instructions/
  migrate.ts`, above) is not part of the release: every project without a
  document reads the built-in template as revision 0. After the release, a
  project with custom role texts has them pasted into its Instructions panel;
  export them first with the script's `--text TAB_ID` dry run if needed.
- Then the CLI. A newer CLI on an older backend gets `INSTRUCTIONS_UNAVAILABLE`
  and keeps today's role file; it still names recipients, and the older backend
  refuses it only when it names an agent outside the conversation.
- Then Desktop and the web app, then the phone. A newer client on an older
  backend finds no `coordinatorName`: it shows no Instructions and sends no
  `roleName`, and everything else works as before.
- An older CLI on a newer backend names no one, so its posts reach the
  coordinator as before, and its `rule.set` lands in the Routing section of the
  instructions. An older Desktop's role, skill-set and policy saves are accepted
  and ignored (see [Routing](#routing)).
- A machine on an older CLI that is sent an agent by a newer one installs the
  built-in Engineer text until it updates; the wire keeps `lead`, `dev`, `review`
  and `buddy` for it.

A signed internal Desktop artifact alone does not update the backend or host
CLI. Validate the coordinated versions in an internal environment before a
public Desktop release.

When the server has the Harness GitHub App, an agent working on another person's
project pushes and opens pull requests with a one-hour token for that project's
repository, instead of its computer's own GitHub login. See
[Swarm GitHub App](swarm-github-app.md) for setup.
