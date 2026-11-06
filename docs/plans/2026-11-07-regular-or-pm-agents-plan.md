# Regular or PM agents, and joining by bringing your own agent: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** Swarm v3's agent model on the server and the CLI host (task #4116, requested by Dee through Harness; spec
docs/specs/2026-11-07-swarm-v3.md, written by #4115): a new member joins and brings their own agent, which becomes their Buddy
with no add-machine step; "+ New agent" makes a Regular or a PM agent on the person's own computer and account; a PM names and
starts a project; a Regular agent is in no project, and the task it is given decides where it works. The Desktop screens are
#4118 and #4121.

**Architecture:**

- **Join and bring your agent:** unchanged. `buddy.create` with `setup` already records the computer as Buddy-only and starts
  the Buddy there (commands.ts addBuddyMachine). A test now pins it for a brand-new member.
- **Kind and chat** (agentKind.ts): each agent in the Swarm read says `kind` (`buddy` | `pm` | `regular`) and `chatId`, the chat
  its person talks to it in (`derived.agents`). Bold for unread is the client's: that chat's last message against its read mark.
- **`agent.new`** (commands.ts): a person's own agent on their own listed computer and account, the grant read from the
  machine's account row as a Buddy's is (store.ts contribution). A Buddy-only record does not count: Desktop adds the computer
  first, with no screen.
  - `kind: 'pm'`: a new project named `projectName`, made by the same helper as `project.create`, and its PM placed by
    placeLead, with no repository needed.
  - `kind: 'regular'`: a chat of kind `agent-chat` with its person alone, and a start marked `regular`. It starts in its
    person's home folder, as a Swarm Buddy does.
- **A Regular agent's project** (projects.ts): `agentProjectId` is its active task's project, else none. While idle it is seen
  only by its person, itself, and the PM of a project its person reads; such a PM may give it a task there (sameProject). It
  works in one project at a time.
- **An agent chat** is read and written by its person, at the membership it was opened in, and by their own agent in it.
  Nobody else reads it: not the Swarm's owner, a project's owner or PM, or another agent (projects.ts readsAgentChat).
- **The host:** a Regular start is listed apart (`regularStarts`, read/hostRows.ts), so an older host never launches it as a
  project's agent. `agent.new` is refused with "Update Harness" on a computer whose host does not say `regularAgent`. The CLI host
  launches it in a permanent folder of its own (agentFolder.ts) and prepares no project, token or clone for it.

**Tech Stack:** TypeScript backend and CLI, vitest.

## Global Constraints

- No code path reads a Claude or ChatGPT login. Identity is always the person's own, never the machine owner's.
- Who can read what stays as today; a Regular agent reaches only projects its person can read.
- Swarm code stays out of cli/src/core. Temp files only in `mktemp -d` folders.

## Design

- growth: one chat per Regular agent (capped by the Swarm's starts and its 100-project limit for PMs); a removed agent's chat
  stays as a conversation, read by its person.
- concurrency: the Swarm's usual write. A new chat and its start, or a project and its PM, land in one command.
- read cost: `kind` and `chatId` come from the loaded state (ledProject and one scan of the conversations), on the reads that
  already build `derived.agents`. A Regular agent's project is one scan for its active task.
- scale: 10x agents means 10x rows in `derived.agents`, inside the existing per-agent cost. The first warning would be the
  Swarm read's p95.
- compatibility: the backend ships first. An older app ignores `kind` and `chatId`. An older backend refuses `agent.new` as an
  invalid command type, and Desktop says "Update Harness". An older host never sees `regularStarts`. An older release reading
  an `agent-chat` parks it unchanged (model.ts KNOWN_KINDS) once it knows the kind; one from before parks it as unknown.
- migration and rollback: none. Rolled back, Regular agents and their chats stay as data. Their starts wait, and their chats are
  kept aside by the older release.
- audience: the server enforces it (readsAgentChat, canReadAgent, sameProject). Two security reviews.
- identity: the person's own account on their own computer (`grant.machineOwnerId === person`), never a share and never a Team
  account.
- failure: every refusal names what to do: add the computer, update Harness, name the project or the agent.
- platforms: backend; the CLI host on macOS, Linux and Windows (folder paths through agentFolder.ts).

## Review Focus

- Nobody but its person and their agent reads an agent chat.
- A Regular agent never takes a task in a project its person cannot read, and never two projects at once.
- `agent.new` never runs on another person's computer, a shared machine or a Team account.

## Tasks (all test first)

- [x] Kind and chat in the Swarm read.
- [x] Join and bring your agent, pinned for a new member.
- [x] `agent.new`: PM and Regular, own computer only, through the store.
- [x] A Regular agent's chat: its person and its agent only.
- [x] A Regular agent's task: only a project its person reads, one at a time.
- [x] The host: `regularStarts`, the `regularAgent` capability, a folder of its own.
- [ ] Left for after 09:00 if time runs out: a Regular agent working in the task's repository folder on its computer. Today it
  takes the task and works from its own folder.
