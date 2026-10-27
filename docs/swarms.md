# Private Swarms

A Swarm is an invite-only collaborative tab. Regular tabs and multiple Swarms
share the existing tab bar. Each Swarm contains projects, people, agents and
contributed machines.

![A project lead chat, expandable workgroups and shared resources](images/swarms/projects.png)

This screenshot uses fixture conversations and resources.

## Starting work

Press **Cmd-S** to create a Swarm and its first project. The form reuses New
Harness: choose the engine, machine, repository and existing launch settings,
write the request, and choose the project's visibility. Store uses
**Cmd-Control-S**.

Use **+ Project** in the left sidebar to create another project in the current
Swarm. It uses the same form and creates a separate lead session. Clicking a
project name opens its lead chat. Its chevron expands numbered workgroups.
The lead can create and coordinate those workgroups; people usually work
through the project lead.

The center toolbar switches between chat, terminals and pull requests. The
project's vertical menu contains rename, details, sharing, update cadence and
Swarm routing. A workgroup keeps its own details, rename and archive actions.
Pull requests in a project lead view include that project's workgroups. Linked
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

A machine contribution is a workspace grant for this Swarm. The host prepares
each project's repository before starting an agent. A project on another
machine needs a shared GitHub repository; a local-only folder is not silently
replaced with an unrelated directory. The project records its lead checkout's
GitHub `origin` as an HTTPS address when the lead starts. If a project has no
address yet, its owner or lead can share one once with `project.repository`.
An address that is already shared is not replaced.

Each host clones with its owner's own GitHub access; Harness never passes
credentials between machines. If GitHub refuses the shared address, the host
tries the other transport (HTTPS or SSH) once. For a private repository, every
contributing owner needs access to it on that machine, either through
`gh auth login` and `gh auth setup-git` or through an SSH key.

The lead starts new agents only on the Swarm's listed machines: every
contributed machine, plus every machine an agent of the Swarm already runs on
(the lead's own machine is always one of them). To make another machine
available, a person adds it to the Swarm under Machines; the host then clones
the project there.

A Builder starts in a new worktree of the project's checkout on that machine.
The host clones a project once and reuses the checkout, so it is not kept up to
date. A start that names no `branchRef` therefore bases its worktree on the
repository's default branch (`origin/HEAD`, else `origin/main` or
`origin/master`), fetched first, rather than on whatever commit the checkout was
left on. If the fetch fails (offline, access refused), the worktree starts from
the copy of that branch the checkout already has; a repository with no `origin`
default branch starts from the checkout's current commit, as before. The lead
passes `branchRef` (`refs/remotes/origin/BRANCH`, fetched first, or
`refs/heads/BRANCH`) to start from another branch, such as the integration
branch the work builds on. This is the Swarm start only: New Harness in Desktop
and the CLI still starts from the folder's current commit unless a branch is
chosen. On the lead's own machine the same rule applies, so work that is only in
the lead's checkout (unpushed commits) reaches a Builder through `branchRef`.

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
status dot where the project chevrons sit, the name where project names start (a computer's
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
owner's account. The owner contributes the machine or an agent. The lead's
routing policy still determines eligible engines, capacity and model choices.

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

## Chat with PM

Each person has a private chat with each project's product manager, next to the
shared project chat, for their own questions and answers. In Desktop and the
web app it is **Chat with PM**, the first entry under an expanded project. The
first click opens a private conversation for that person alone, named after
them, with the project's product manager in it. Later clicks, other windows and
other devices open the same one: the request that creates it is the same for
each person and project, and the server answers a repeat with the conversation
it already made.

It behaves like the project chat: replies, attachments, the unread mark and the
product manager's tags in Notifications. Only that person and the product
manager read it. Other members, the project's owner and the Swarm's owner
included, never receive it, its messages or its notifications. The chat is
chat only: no work is assigned in it, and only the product manager joins it
among agents. As with any session, the owner of the machine running the
product manager can see what its terminal shows.

## Calling a person

Agents do all the work they can. They call a person only for judgement (a
decision with trade-offs), taste (how it should look or feel), knowledge
(something only that person knows) or hands (a device, a sign-in, an approval).
Every call names one person and asks one clear thing, so nobody has to watch
the chat to find out they are needed.

**Roles on a piece of work.** The requester asked for it and gets the result.
The partner, when the work needs one, is the person it needs for judgement,
taste, knowledge or hands; the product manager names them on the group, next to
the Engineer, and picks them from the areas each person covers in the project
(devices, mobile, product and so on). Each person sets their own areas, or the
project's owner does, and members see them. The Engineer does the work, a
Reviewer from another model family checks it, and the product manager routes it
and keeps people out of the details unless they are needed.

**Three ways to reach a person.**

| Kind | When | What the person gets | How they answer |
|---|---|---|---|
| Decision | judgement, taste, knowledge | A batch of questions, each with 2 to 5 options, the agent's recommendation and what it unblocks | One tap per question, and an optional note |
| Hands-on | a device, a sign-in, an approval | The steps to take and what the agent does next | Done, Can't now (until a time, with a note), or a note |
| Mention | anything else | An @mention in a message | A normal reply |

Decisions and hands-on requests wait at the top of the person's Chat with PM
and count on their badge; their device shows hands-on requests, and decisions
and mentions if they opt in. A group records who it is waiting on, so a phone
or Desktop alerts that person rather than the project's owner. The product manager or
the Engineer on its own task asks; the asking agent and the product manager
get a notice when it is answered, and read the answer through their own decisions read.

**Escalation.** An agent keeps working on its recommendation, marked
provisional, while it waits, and never asks the same thing twice. A request
still open after 30 minutes reminds its person, on their devices too; after 2
hours the product manager is told to ask someone else or go on with the recommendation.
Each step happens once, however many servers check. The checks run while the
Swarm is working, whenever one of its machines reports or its product manager
checks in; a Swarm with neither has no agent waiting on an answer.

**Mentions.** Anyone who can post in a project's conversation can mention a
person or an agent there. A mentioned person is notified and finds the
conversation in their Notifications. Mentioning someone who cannot read the
conversation is refused with a reason, and never shows them the conversation.

**For people.** Answer from wherever you are: Desktop, the web, your phone or
your device. "Can't now" is a fine answer: the agent waits or asks someone
else. Set your status ("focus", "out until 2pm") so agents and the product manager
route around you.

Nothing private goes in a decision or a hands-on request; private matters go
through Chat with PM. A device hears only that a person is needed (the
request, the person and its kind), never what was asked.

## Lead updates

The default update cadence is five minutes; the project menu also offers one,
fifteen and thirty minutes. New workgroup reports mark the project for an update.
The existing delivery poll asks its lead to consolidate those reports at its
next natural checkpoint. Idle projects do not generate scheduled updates, and
an outstanding request prevents duplicates.

The lead uses `project.report` to acknowledge the request and post a useful
summary, or `text: null` when nothing merits another message. Human questions,
serious blockers and completion are reported immediately. This does not start
a second summarizing model or forward every terminal turn.

## Compatibility and rollout

The internal `superTab` storage keys and `harness super-tab` command stay stable.
Existing tabs are read as a single project without rewriting their conversation
IDs or messages. Existing regular tabs retain their behavior.

Use the matching backend, CLI and Desktop versions together for this feature:

1. Generate the backend Prisma client and apply its additive schema, including
   `SuperTabSessionScope`, before serving the new project commands.
2. Update participating hosts to the CLI with Swarm-scoped contributions and
   project checkout preparation. A host on an older CLI ignores the request for
   the default branch and starts Builders from its checkout's current commit. A host older than
   the immediate reports still reports, and picks up a waiting start, only every 15 seconds.
3. Install the Desktop build with the project sidebar and Cmd-S entry point.

A signed internal Desktop artifact alone does not update the backend or host
CLI. Validate the coordinated versions in an internal environment before a
public Desktop release.

When the server has the Harness GitHub App, an agent working on another person's
project pushes and opens pull requests with a one-hour token for that project's
repository, instead of its computer's own GitHub login. See
[Swarm GitHub App](swarm-github-app.md) for setup.
