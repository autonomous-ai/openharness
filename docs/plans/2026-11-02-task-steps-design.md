# One request, one task: steps inside a task

Status: design, 2026-11-02. Requested by Ken. Builds on `2026-11-02-agent-context-design.md` (`mine`, `task GROUP`,
delivery lines), which shows steps once this lands.

## Why

Ken opened the openharness project's task list and saw one pull request as several tasks: #1835 (the build), #1918
"Review: PR #2494" and #1919 "Test: PR #2494". On prod (2026-11-02) the project's numbers reach #1919, but only 100
groups are not archived, and 88 of those have no assignment. Many are bookkeeping the PM opened: "Holder" (security
review), "Security review 2", "Merge batch", "Combined merge", one "PR triage" per outside pull request, "To do", and a
review and a test group per pull request. Only 21 have `reviewOf`; nothing else links a group to the request it serves.

Two causes:

- **The model.** A conversation holds exactly one `assignment` (one agent, one status, one result, one lease, one cost
  line). A Reviewer and a Tester therefore each need their own conversation, linked by `reviewOf`, with its own number,
  its own chat and its own row in every list.
- **The instructions.** Nothing tells the PM not to open groups for bookkeeping, or an Engineer to ask the same Reviewer
  again instead of opening "Review 2".

The PM also hears every step: a linked task's own agent setting `review` or `done` notifies the coordinator
(`commands.ts` `work.status`, `told`), though the Engineer is the one who acts on a verdict.

## What Ken decided

- One request is one task. Review, test and the like are **steps** of that task, each with its own agent and verdict
  (Ken chose "cách 2" over showing linked groups nested in the UI alone).
- The instructions change too, in the same design: the bookkeeping groups stop.
- As everywhere in the Swarm, the server names no step and checks no order. Which steps a task has, who works them and
  when, is the project's instructions'. The PM role always exists.
- Steps are not a software idea. The same model has to serve a marketing team's instructions as well as openharness's:
  no code, field or notice may name a pull request, a review, a test, an Engineer or a Reviewer (Ken, 2026-11-02).
- A task has an **owner** when it has an assignee, and the owner hears its steps. A task with no assignee is the
  coordinator's: its steps report to the PM (design call, proposed on Ken's "đề xuất đi"). Someone has to collect the
  verdicts and tell the PM once; with nobody, every step would reach the PM, which is the overload this design removes.

What it looks like for two teams, written only in their instructions:

- openharness: "The Engineer owns the task. When its pull request is ready it adds a Review step, and a Test step when a
  user sees the change." The list shows `#1835 Fix login — Review: passed · Test: 1 check failed`.
- A marketing team: "Each campaign is a task the Campaign Lead owns. The Lead adds Copy (a Copywriter) and Design (a
  Designer) in parallel, then Brand check (a Brand reviewer), then Schedule." The list shows `#42 Black Friday — Copy:
  passed · Design: working · Brand check: not started`.

## Goals

- The project's task list shows one row per request, with its steps' agents and verdicts on it.
- A step keeps what a task gives its agent today: liveness and lease (a dead Reviewer is found), its attempts, its
  cost and model, its checks, its place in `mine`.
- A step's messages are in the task's one chat, so its owner, every step's agent and the PM read one conversation.
- A step's progress goes to the task's owner, not the PM. The PM hears when a step needs a person or is stuck, when the
  owner tells it the task is ready, and every step of a task with no owner.
- The PM opens no group for bookkeeping.

## Non-goals

- Workflow in code: no fixed step names, no required order, no automatic review.
- Rewriting liveness, costs, evidence or the leaderboard around a new structure.
- Moving existing linked groups' messages into their tasks.

## Anti-goals

- A step that dies silently because nothing watches its agent (what "Reviewer joins the Engineer's group" would cost).
- An older Desktop, phone or daemon that breaks or loses messages while steps roll out.
- A PM that learns less than today: it still hears every `needs_human` and `blocked`.

## Part 1. The instructions (template only; ships first)

The template (`backend/src/superTabs/instructionsTemplate.ts`) changes as plain words a project may change. Until part 2
ships, a "step" is a linked task as today (`conversation.create` with `reviewOf`); the words stay true after it.

TEMPLATE_WORKFLOW becomes:

```
1. One request is one task. The PM opens it with its goal and "Done when" and assigns an Engineer; when no Engineer is
   free, it starts one. The PM opens no task to hold, batch, triage or list work: that goes in its notes or the project
   chat.
2. When the pull request is ready, the Engineer adds a review step to its task, and a test step when the change is
   something a user sees or uses (screens, CLI commands, install and release, sign-in, connections between machines,
   devices). It messages the Reviewer and the Tester directly. Review and test run in parallel. Refactors, docs and
   test-only changes get a review only. A task whose review plan asks for two reviews gets two review steps.
3. Findings go straight to the Engineer. The Engineer fixes them and asks the same Reviewer or Tester again in the same
   step; it adds no new step for a second round.
4. When the review passes, and the test passes where there is one, the Engineer tells the PM once.
5. The PM checks CI on the pull requests that passed, merges them, and tells the people who asked.
6. A task that needs a person, or a machine that is down, goes to the PM at once, by name.
7. Idle Engineers are stopped. Reviewers and Testers are kept while the work they checked is open.
```

The four agent-context lines (`2026-11-02-agent-context-design.md` section 3) join it in the same edit. Both specs
change one template; the plan writes it once.

**Reaching projects.** As the agent-context spec says: these words land before the instructions migration
(`scripts/swarm-instructions/migrate.ts --apply`) runs, so each project's copy carries them; and the revision-0 hash
fix there makes running daemons read them.

## Part 2. Steps (backend, CLI, Desktop, phone)

The model, in words any team's instructions can use:

- A **task** has a goal, checks, one chat and, when it is assigned, an **owner** (its assignee).
- A task has any number of **steps**. Each has a name the instructions give, an agent, its own status and result, and
  its own checks as its verdict.
- Anyone in the project who may open a linked task today may add a step to an open task, at any time: when the task is
  opened, or later. Steps run in parallel or one after another as the instructions say; the server orders nothing.
- A step's progress reaches the task's owner, or the coordinator when the task has none.

### Storage: a step is a linked group, shown inside its task

Design call. A step stays a conversation row with `reviewOf` naming its task, with its own number and its own rows, so
everything that works on linked tasks today keeps working unchanged: its `assignment`, lease and liveness
(`liveness.ts`), attempts (`store.ts` attempts read), costs (`costs/read.ts`), checks, decisions, catch-up
(`catchUp.ts`), the PM's reports (`projectUpdates.ts`), the leaderboard (`stats.ts` counts only groups without
`reviewOf` as requests), and every writer of rows (liveness notices, tidy and cancel lines, terminal turns,
`native.ts`). What is new is one field, and how readers show it:

```ts
// Conversation
/** A step of the task `reviewOf` names (task steps design): its name as the instructions give it, in any language.
 *  Readers show it inside its task, never as a task of its own. Absent on a linked group opened before steps. */
step?: string
```

Why not one chat in storage (the first draft wrote a step's rows into its task): every writer of rows would have to
follow the redirect (status and lost notices, decisions, cancel and archive lines, terminal turns), and the task's
catch-up, reports and delivery `assignmentId` would read a step's rows as the task's own. Agents already talk in the
task's group: a Reviewer or Tester checks and posts there (`renewOwnTask`, `liveness.ts` ~148). What stays in the step's
own conversation is its brief and the system rows of its work; readers merge them into the task's view.

- **Opening one:** `conversation.create` gains `step` (1-40 characters, free text), allowed only with `reviewOf`, on a
  task of the same project (as `reviewOf` already requires) that is not itself a step (one level). It takes a number as
  every group does (`numberConversations`, `commands.ts` 674), so commands may name it, and so a rollback leaves nothing
  to renumber. Readers show it as `#<task number> · <step>`. The opener joins the task (`agentIds`), as it joins its
  own review today.
- **Assigning one:** `work.assign` on a step as on any task; its agent joins the task, so it reads and posts there.
- **A second round** keeps the step open: its agent stays `working` while the owner fixes, as Reviewers do today
  (`changesRequestedAt`, `waitingForRevision`, `revisionReady`, `liveness.ts` 109-138, which already key on `reviewOf`).
  A `done` step may still be assigned again (`commands.ts` ~2686, an attempt row), which the instructions may ask for.
- **Verdicts:** as today. A step's agent passes or fails the task's checks (`work.check` in the task, which already
  marks its own step waiting, `commands.ts` ~2901), and the step's own checks when it was opened with some; its status
  and result say how it ended.
- **Archive and sleep:** a step archives and sleeps with its task, never on its own clock. The archive pass
  (`archive.ts` ~100) and the sleep sweep (`sweeps.ts` 74, 98) skip a step while its task is active and not archived;
  when its task archives, its steps archive in the same write, open ones cancelled with the task's reason. Otherwise a
  `done` step with no pull request of its own archives within one pass (`settled([])`), a second round then fails
  `ARCHIVED`, and a dormant step drops out of the read with its verdict.

### Who hears a step

The task's **owner** is its assignee's agent while the task's assignment is open work, else nobody.

- **Status** (`work.status`, `told`), when a step's own agent sets it: `review` and `done` go to the owner, not the
  coordinator; with no owner, to the coordinator. `needs_human` and `blocked` go to the coordinator as today, and to the
  owner. Someone else changing a step's work: unchanged.
- **Unnamed posts** (`message.send`): a step's agent posting with no recipient, in its step (`workerToLead`) or in its
  task (`memberToLead`), reaches the owner; with no owner, the coordinator. An agent that holds no open step there keeps
  today's rule (`memberToLead`, the 10-29 prod-watch fix: a moved agent's posts still reach the PM).
- **Reports** (`projectUpdates.ts`): a step stays in the PM's scheduled reports as today, named `#<task> · <step>`, so
  the PM learns no less; it is no longer woken by each step's progress.
- Linked groups opened before steps (no `step`) keep today's rules.

This is the notice Ken was offered on 2026-11-02 ("remove the automatic review notices to the PM"), scoped to steps.

### Nothing in code names a kind of work

- `jobKindOf` (`evidence/jobKind.ts`) reads every linked group as `review`, so a Design step would be compared with
  reviews when models are ranked. A step takes its job kind as any task does (its route word, else `general`); a linked
  group opened before steps stays `review`. The job kinds list itself (components of this repository) is outside this
  design.
- Copy shown to people names the step by its own name ("Copy: passed"), never "review" or "test". The status label
  `Ready for review` (`STATUS_LABELS.review`) is shown on a step as `Ready` (design call: the status's meaning is the
  instructions'; for the task itself the label stays).
- The Harness tools skill says "add a step to a task" and shows one example step, never a list of step names.

### Reads

- **Swarm read and `status`:** steps are groups and stay in the read, so nothing new is fetched. `status` prints a
  task's steps under it instead of as rows of their own.
- **`mine`** (agent-context spec): a step's agent sees `#1835 "Fix login" · Review — working` with the step's id; the
  owner sees its task with its steps' agents and statuses on one line; the coordinator's open work counts tasks,
  not steps.
- **`task GROUP`:** a task lists its steps (name, agent, status, checks' verdicts, the latest result's first line, the
  step id). Given a step's id, it shows its task with that step marked.
- **Deliveries:** a row of a step's own says `In task #1835 "Fix login", step Review (conversation <step id>).`; a row
  in the task says the task. Reply commands stay with the row's own conversation, as today.
- **`messages TASK`:** the task's rows with its steps' rows merged in by time, each step row tagged with its step's
  name (a read of each step, as the agent; a task has a few). `messages STEP` reads the step alone.

### Clients

Desktop and the phone (`linked_tasks.dart` is kept byte-identical on both):

- The task list hides steps as rows. The task's row shows its steps line (`superTabLinkedLine` already builds "Review:
  passed · Test: 1 check failed") with each step's agent.
- Opening a task shows its steps above the chat: name, agent, status, checks; tapping one opens that agent's pane.
- The task's chat merges its steps' rows by time, each with its step's name beside the author (one message read per
  step when the task opens, then the steps' changes as any group's).
- Linked groups opened before steps show as today.

## Design

- **Growth**: steps are groups and go as groups go, but only with their task: archived with it, then dormant, then
  deleted with the Swarm. Fewer groups than today: one step replaces each review, test and re-review group, and the
  bookkeeping groups stop.
- **Concurrency**: as today, guarded writes per part (`parts/commit.ts` 224-283). Archiving a task writes its steps'
  parts in the same write (`parts/touches.ts` gains a task's steps for archive and cancel); nothing else touches more
  than today.
- **Read cost**: no new backend reads. Steps are in the Swarm read already; a task's merged chat reads each step's
  messages once when opened (a task has a few steps), then only what changed.
- **Scale**: a task with 10 steps is 10 groups, as 10 linked tasks are today, and opening it reads 10 small pages. The
  metric that warns first: groups per project in the Swarm read (`/changes` size), which falls with this design.
- **Compatibility**:
  - Old daemons and agents: a step is a linked task, as today; every command they send works.
  - An older Desktop or phone: shows a step as a numbered linked task, its own chat as today.
  - An older backend never receives `step`: the CLI sends it only when the Swarm read says the backend has steps (a
    capability flag on the read).
- **Migration and rollback**: no data migration; existing linked groups stay as they are. Rollback of the backend:
  `step` is an unknown field the old backend keeps; steps read as linked tasks, numbered as they already are, and may
  archive on their own clock again.
- **Audience**: every read is as the reader. A step is readable exactly when its task is. A private chat cannot hold
  steps: `conversation.create` already refuses `reviewOf` on a group with an audience (`commands.ts` 1698).
- **Identity**: actors as today; a step's agent acts as itself.
- **Failure**: opening a step on a task that is missing, archived, another project's, or itself a step is refused with
  the reason. A step whose read fails leaves the merged chat with the task's rows and says which step is missing.
- **Platforms**: backend and daemon on every platform; Desktop (macOS, Windows, Linux, web) and the phone share
  `linked_tasks.dart`.

## Order

1. Part 1 (template) with the agent-context template lines and the revision-0 hash fix; before the migration runs.
2. Backend: `step`, archive and sleep with the task, its notices and unnamed posts, `jobKindOf`, the capability flag.
3. CLI: `mine`, `task`, deliveries, `status` and merged `messages` with steps; the Harness tools skill says how to add
   a step (one skill-update notice).
4. Desktop and the phone.

Each ships on its own: before 2 the words mean linked tasks; before 3 and 4 a step shows as a linked task.

## Tests

- Backend: opening a step (numbered, joins the task), with a name in any language; refused with no `reviewOf`, on a
  step, on another project's task, on an archived task; a `done` step is neither archived nor put to sleep while its
  task is active, and archives with its task, open ones cancelled; `review` and `done` from a step's agent reach the
  owner and not the coordinator, and the coordinator when the task has no owner or its work is finished; `blocked`
  reaches both; a step agent's unnamed post in its step or its task reaches the owner, and a moved agent's still the
  coordinator; a step's job kind is its route word's, an old linked group's `review`; an old linked group keeps
  today's rules; a second round keeps the step `working` across the owner's fix; liveness marks a step's dead agent
  lost; reports name a step as `#<task> · <step>`.
- CLI: `status`, `mine`, `task` and the "where" line with steps; `messages TASK` merges steps' rows by time and tags
  them; `step` is sent only to a backend that has it.
- Clients: the list hides steps and shows the steps line; the task's steps panel; the merged chat with step names;
  an old linked group shows as today; parity test for `linked_tasks.dart`.
- Template: Workflow has the seven lines above.

## Left to the builder

- The capability flag's name and where in the read it sits.
- The steps panel's layout on Desktop and the phone, within the existing task header.
- Whether `status` prints steps nested or as one line per task.
