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

## The task board

Each workgroup in the sidebar says what its task is doing, without asking the Lead. Its row has two
lines: the title, and one line with a status chip, the avatar of the agent on it, how long since it was
last active ("12 min ago") and, at the end, its pull request ("#1557 Draft"), shortened with an ellipsis
when the sidebar is narrow.

| Chip | The task |
| --- | --- |
| Needs you | the agent asked for a decision (`needs_human`) |
| Blocked | the agent cannot go on without help (`blocked`) |
| Review | the agent finished its part and it is being checked |
| Working | an agent is on it (also a worker the Swarm is still reconciling) |
| Not started | no assignment yet, or one planned and not begun |
| Done, Stopped, Cancelled | finished: gathered under the project's **Finished (N)** row, collapsed |

Within a project, rows go in that order, most recently active first in each; finished work is last,
under Finished. A compact filter above the projects offers each status some workgroup has, with
its count; choosing one narrows the list, choosing it again (or All) shows everything. The
pull request is read once for all the rows on screen, by this computer's own GitHub login (the
reader the Pull requests pane uses), and again every minute while one can still change. A row names
the last pull request link in its task's result, a check's evidence or its loaded messages; with a CLI that
has no pull request reader, or GitHub unreadable, the rows simply have no pull request state.

The time of last activity is the Swarm's own (`lastActivityAt` on a workgroup: its newest message, or
its assignment's last change). A Swarm service that does not send it leaves the age out. Roll the backend
out before the Desktop.

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
status dot where the project chevrons sit, the name where project names start, then a chip
for each model allowance and up to three of its agents, overlapping, then +N, the last
centered under the heading's +. A chip is the engine's mark and the share left of its tightest
window, Claude first, then Codex; only a known, unexpired allowance gets one, and an offline
or unreachable machine shows none. The share is amber below 20% and red below 10%, and
hovering a chip shows its windows ("5-hour: 48% remaining · resets in 1h 59m"). When the
line runs short, the name keeps about 56 points: the agents become +N first, then the Codex
chip goes, then the Claude one. Online machines come first, by name; offline ones follow
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
3. Install the Desktop build with the project sidebar and Cmd-S entry point. The task board's ages need the
   backend that sends `lastActivityAt` (additive, nothing to migrate); a Desktop that runs before it shows
   no ages, and a backend that runs before the Desktop is ignored by it.

A signed internal Desktop artifact alone does not update the backend or host
CLI. Validate the coordinated versions in an internal environment before a
public Desktop release.
