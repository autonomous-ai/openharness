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
Pull requests in a project lead view include that project's workgroups.

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
   project checkout preparation.
3. Install the Desktop build with the project sidebar and Cmd-S entry point.

A signed internal Desktop artifact alone does not update the backend or host
CLI. Validate the coordinated versions in an internal environment before a
public Desktop release.
