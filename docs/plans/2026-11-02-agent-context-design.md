# Agents know their work and their conversations

Status: design, 2026-11-02. Requested by Ken. Replaces the draft `2026-11-02-delivery-context-design.md` (merged in).

## Why

Ken sees agents forget their task: which one they are on, and how far it got. The PM loses track when several people
answer one thread, and agents answering each other, or the PM and an agent, lack the context between their messages.

What an agent has today:

- **Deliveries** (`cli/src/superTabs/host.ts` `prompt()`): the conversation's id (24 hex characters, never its name or
  task number), the message's id, author and text, the one message a reply answers (quoted up to 600 characters,
  `repliedTo()`), and the commands to read and answer. Nothing says which task the agent itself is assigned, how a
  thread began, or that others replied in it.
- **Tools** (`harness super-tab`, help in `cli/src/superTabs/service.ts` `HELP`): `status` returns everything the agent
  may read: every person and agent, and every active conversation of its own project with its task (an agent reads only
  its project's groups, `canReadProject`; over a hundred on the openharness project), with no "mine" view;
  `messages GROUP [--thread ROOT]`, `message GROUP ID`, `instructions`, `decisions`, `costs`. No command shows one task
  with its checks and earlier attempts, though the backend serves the attempts
  (`GET /api/super-tabs/:tab/conversations/:id/attempts`).
- Agents do not fetch what they are not told exists: the delivery once gave only a command to read the message a reply
  answers, agents skipped it, and a Lead took Ken's "GO" as approving a different plan (why `repliedTo()` quotes it now).

## What Ken decided

- Harness gives tools and facts; how an agent works (when to look, what to read before acting) is the project's
  instructions'. The same split as the rest of the Swarm: the server and the CLI decide no workflow.
- Deliveries carry a few short pointers to their context, and the agent (an LLM) decides what more to read.
- One design for both: the task an agent works on, and the conversation a message belongs to.

## Goals

- An agent can always learn, in one short command, what it is assigned and how far each task got.
- A PM can see its project's open work in one short command, without reading the whole Swarm.
- From a delivery alone, an agent knows which task or chat a message belongs to, which task it is itself on, whether the
  message sits in a thread others have written in, and how to read more.
- The instructions tell agents when to use these; a project can change that.

## Non-goals

- Pushing whole threads, conversations or task histories into a terminal.
- Summarising with a model.
- New server state or endpoints beyond small read fields; workflow rules in code.

## Anti-goals

- A delivery so long that the message is lost in it.
- An agent seeing, through a tool or a delivery, anything it could not read itself (every read is `asAgentId`).
- A delivery held back because its context could not be read.

## Words used below

- **Open work**: an assignment whose status is not finished (`activeWork` in `backend/src/superTabs/model.ts`; finished
  is `done`, `stopped`, `cancelled`, `lost`, `FINISHED` in `parts/light.ts`). Design call: "your work" and `mine` list
  open work only. A reused Engineer keeps `assignment.agentId` on its old finished task until that task goes dormant,
  and listing it ("task #11 (done)") is the confusion this design is for.
- **Coordinator**: the agent that leads the project (`isLead` in `service.ts`, the project's Lead conversation). Every
  task group's `leadId` is that agent, so `swarmRoleFor` in `host.ts` agrees.
- **Updated**: when the task's group last changed (`groupChangedAt` from `SwarmReads`; reads carry no
  `lastActivityAt`, and an assignment has no update time).

## 1. Tools (CLI, the same for every agent but a Buddy)

### `harness super-tab mine`

What this agent works on, compact (design call: a short table, not JSON, at most one line per task):

- its open work, not archived: `#<number> <title> — <status>, updated <time>; last result: <first line, up to 160
  characters>; PR <url>` (status and result from its `assignment`, PR from `pullRequestUrls`);
- every review or test task linked to that work (`reviewOf` either way) that is open, with its assignee and status;
- for the coordinator: every open task of its project instead (not archived), with its assignee;
- an empty list says so ("No task is assigned to you."), and the coordinator's ends with how many tasks are open.

Read from the Swarm read the CLI already makes for `status` (`reads.read(tabId, agentId)`), filtered and shaped on the
daemon. No new endpoint. The read holds active groups only: a finished task quiet for a day, or one archived by hand,
is dormant (`sweeps.ts` `sleepQuietGroups`, `commands.ts` ~1801) and is not listed, which suits a list of open work. An
archived group still in the read (`archived: true`) is filtered out.

### `harness super-tab task GROUP`

One task, as its readers need it:

The group comes from the Swarm read when it is active, else from `GET /api/super-tabs/:tab/groups/:id?asAgentId=…`,
which serves active and dormant groups and answers 404 for one the agent may not read (as `routeHistory` in
`cli/src/superTabs/service.ts` ~603 already does; reuse it). It shows:

- number, title, project, status, assignee, PR links, updated;
- the task: `goal`, `changes`, `constraints`, `owns`, `requires`, `review` (`WorkTask`), else the `brief`, cut to 1,500
  characters with the command for the rest (`status` for an active one). There is no "Done when" field: a template's
  "Done when" is words in the brief, and the acceptance criteria are the checks;
- its checks: each `description`, passed (`passedBy` set: by whom, the actor's name from `state.agents` or the
  person) or not, and the evidence's first line (a failed check keeps its evidence with `passedBy` null,
  `commands.ts` ~2884; the read does not say who failed it);
- its attempts, newest first, at most 10: the current one from `assignment`, then earlier ones from the backend's
  `attempts` read (`store.ts` ~2540; a row is written when an assignment is replaced, at most 50, newest first, each
  `{agentId, status, result ≤500, createdAt}`): assignee (by name, or the id when the agent is gone), status, the
  result's first line, when;
- its linked tasks (`reviewOf` either way) with assignee and status;
- the commands to read its conversation (`messages GROUP`) and a thread (`--thread ROOT`).

### Help and the Harness tools skill

`HELP` gains `mine` and `task`; the fixed Harness tools skill (`SWARM_TOOLS_SKILL`, `cli/src/lib/swarmTools.ts`, every
agent but a Buddy, the PM included, in every project) lists them, and `messages GROUP --thread ROOT` in its Read list.
Changing that text moves its version, so each running agent gets one skill-update notice. The skill says what each tool
returns, not when to use it; that is the instructions'.

## 2. Deliveries say where they are (CLI)

In `prompt()`, before the message (`Message <id> from <author>:`), at most four short lines, each only when it applies:

1. **Where:** `In <place> (conversation <id>).` The place is the task's number and title (`task #12 "Fix login"`), a
   review's title (`"Review: Fix login"`), the project chat (`the project chat of <project>`), a Buddy chat (`<person>'s
   Buddy chat`) or the Leads conversation; the id alone when the name is not known.
2. **Your work:** `You are assigned task #<n> "<title>" (<status>).` for each task assigned to the receiving agent (at
   most three, then "and N more: mine"), or nothing when it has none. The coordinator gets `Open tasks in your project:
   <count>; mine lists them.` instead.
3. **Thread:** whenever the message is in a thread (its `thread` is set and is not its own id) that has replies besides
   it. Desktop and the phone answer in a thread with `replyTo` set to the root (`desktop/lib/super_tabs/controller.dart`
   ~1538, `mobile/lib/swarm/swarm_thread.dart` ~523), so this is the common case:
   `In a thread <root author> started (<time UTC>): "<the root's first line, up to 200 characters>" — <N> replies so
   far, from <up to three authors>. Read the whole thread before acting on it: <command> messages <group> --thread
   <root>`. N counts every reply when read, the delivered one and any that came after included ("so far"). Without
   counts, the line keeps the root's line and the command.
4. **Reply:** today's quote of the message it answers (`repliedTo()`), unchanged.

A Buddy's thread session gets lines 1 and 4 only (design call: its whole chat is one thread, and it holds no tasks).

**What is read.**

- Lines 1 and 2 come from the Swarm read (`cli/src/superTabs/swarmReads.ts`; the host's rows carry only `tabName` and
  the agent, `backend/src/superTabs/read/hostRows.ts`). Design call: read it fresh for each delivery, no time cache.
  `SwarmReads` already keeps each (tab, agent) store and fetches only `/changes` since its cursor, so a read is one
  small call plus `reassemble()`; a 60 s cache could build the delivery announcing a `work.assign` from a read taken
  before it, without the new task.
- Line 3 needs no backend change: a one-message read (`messages?asAgentId=…&messageId=…`, the one `repliedTo()` makes)
  returns that message's thread summary (`backend/src/superTabs/store.ts` ~2456 from each row's `thread`; a top-level
  message's `thread` is its own id, ~2293; `threads.ts` `threadSummaries`). The reply to the root needs no new read; a
  reply to a later reply, or a thread message with no `replyTo`, needs one read of the root.
- A root or a task this agent may not read comes back empty, and its line is left out; the delivery always goes.

## 3. Instructions: when to use them (the template)

The template's Workflow (`backend/src/superTabs/instructionsTemplate.ts`) gains, as plain workflow a project may change:

- "Before acting after a pause, or when unsure what you are working on, run `mine`."
- "Before saying your work is done, read `task GROUP` and check that every check has passed."
- "In a thread others have written in, read the thread before acting on it, unless the delivery already says enough."
- "The PM reads `mine` for progress, not `status`."

**Reaching projects.** On prod (v1.3.78_backend, 2026-11-02) no project has saved instructions
(`SuperTabInstructions` is empty) and every one reads the template, revision 0. Two things decide whether the new lines
reach agents:

- The migration (`scripts/swarm-instructions/migrate.ts --apply`, not yet run) gives every older project its own
  document, copied from the template current at that time, and new projects and Swarms already save one at creation
  (`commands.ts` ~1334, `store.ts` ~939). Design call: these lines land before the migration runs, so the copies
  carry them; after that, a template change reaches only new projects.
- The daemon reads the text once per (project, revision) (`instructionTexts`, `host.ts` ~1435). At revision 0 the
  revision never moves and the host row's hash is null (`hostRows.ts` 87), so a running daemon keeps the template it
  first read until it restarts. Part of this design: at revision 0 the host row carries the template's hash, and the
  daemon reads again when the hash moves. The same gap held back #2495's routing lines from running agents.

## Design

- **Growth**: N/A because nothing is stored; the daemon keeps the Swarm stores `SwarmReads` already keeps.
- **Concurrency**: N/A because nothing is written.
- **Read cost**: `mine` and lines 1-2 reuse the Swarm read (one `/changes` call per delivery, only what changed);
  `task` is one Swarm read (or one group read for a dormant task) and one `attempts` read when asked; line 3 at most
  one one-message read per threaded delivery; the template hash is a constant per backend build.
- **Scale**: the Swarm read grows with the Swarm; the warning metric is the daemon's delivery latency and the
  `/changes` read time.
- **Compatibility**: an older backend without thread summaries on a one-message page gives line 3 without counts; an
  older daemon writes today's delivery and lacks the new commands; agents with an older skill learn the commands at
  the skill update.
- **Migration and rollback**: none for data. Order: the template lines ship before the instructions migration is
  applied. Rollback is the previous CLI and backend; an older daemon ignores the hash and behaves as today.
- **Audience**: every read is as the receiving agent; an agent-only notice never quotes or points (as today).
- **Identity**: the agent's own.
- **Failure**: an unreadable name, task or root leaves its line out, logged once per delivery; `mine` and `task` say
  what they could not read.
- **Platforms**: daemon-side; the same everywhere.

## Tests

- `mine`: an Engineer with two tasks, one done; a Reviewer with a linked review; the coordinator's open project work;
  an agent with none; archived tasks left out; lines within their caps.
- `task GROUP`: checks passed, failed with evidence, and untouched; the current attempt and earlier ones (newest first,
  at most 10, a removed agent by id); linked tasks; a long brief cut with its pointer.
- `prompt()`: place line for each kind of conversation; "your work" lines for an Engineer, the coordinator and an agent
  with none; thread line for a reply to the root (no extra read), a reply to a later reply (one read), a thread's only
  reply (none) and a Buddy's thread session (none); an unreadable root still delivers; a `work.assign` delivered right after it names the new task.
- `swarmTools.ts` lists `mine`, `task` and `--thread`; the template's Workflow has the four lines.
- Instructions: a host row at revision 0 carries the template's hash; a daemon holding revision 0 reads the text again
  when the hash moves, and not when it stays.
- `mine` lists no finished task (a reused Engineer's old `done` task), and `task` serves a dormant task from the group
  read and refuses a group the agent may not read.
