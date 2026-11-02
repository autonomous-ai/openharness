# Agent context and task steps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents know their work and their conversations (`mine`, `task`, delivery lines), and one request is one task
whose review, test or any other work runs as steps inside it.

**Architecture:** Five phases, each shippable on its own: (A) the template and the revision-0 instructions refresh,
(B) CLI tools and delivery lines, (C) backend steps (a `step` field on a linked group; archive, sleep, notices and job
kind follow it), (D) CLI views of steps, (E) Desktop and phone. A step stays a linked conversation (`reviewOf`) with its
own number and rows; readers show it inside its task and merge its rows into the task's chat.

**Tech Stack:** backend TypeScript (Fastify, Prisma on MongoDB, zod, vitest); CLI daemon TypeScript (vitest); Flutter
(Desktop `desktop/`, phone `mobile/`).

**Spec:** `docs/plans/2026-11-02-agent-context-design.md` and `docs/plans/2026-11-02-task-steps-design.md`. Read both.

## Global Constraints

- No code, field, notice or copy names a pull request, review, test, Engineer or Reviewer as a kind of step; a step's
  name is free text (1-40 characters, any language) the instructions give. Template text (phase A) is the exception.
- The server decides no workflow: no fixed step names, no order, no automatic step.
- Every read is as the agent (`asAgentId`); a delivery never waits on a read that fails: its line is left out.
- "Open work" is `activeWork` (`backend/src/superTabs/model.ts`); finished is `done`, `stopped`, `cancelled`, `lost`.
- Do not edit `cli/src/lib/e2ee/core.ts`. Do not bulk `dart format lib` or `test`; format only files you touched.
- Backend tests: `cd backend && npx prisma generate` once, then
  `NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= npx vitest run <files>`.
- CLI tests: `cd cli && npx vitest run <files>`; `npm run typecheck` before each commit.
- Comments say why, in plain sentences, naming the incident or spec (cli/AGENTS.md rule 7).
- Docs and code comments in English.
- Linked groups opened before steps (no `step` field) keep every behavior they have today.
- Known red on main, not ours: `cli/src/superTabs/buddyHome.spec.ts` on macOS/Node 23.

## Review Focus

1. A step whose task is archived by hand while the step is `working`: the step must be cancelled with the task's
   reason in the same write, never left active in an archived task (Task 8 test `archiving a task by hand cancels its working step`).
2. A reused agent whose old finished task still names it: `mine` and the "your work" line must not list that task
   (Task 3 test `mine leaves out a reused agent's finished task`).
3. A step name with quotes, emoji or Vietnamese diacritics reaching deliveries and shell commands: lines must keep it
   intact and shell-quote it (Task 12 test `a step name with quotes and diacritics is shown and quoted`).
4. A task with a step whose message read fails (403, network): `messages TASK` still returns the task's rows and names
   the missing step (Task 12 test `an unreadable step leaves the task's rows and says which step is missing`).
5. An old daemon sending `conversation.create` with `step` to an old backend: the CLI drops `step` when the read has no
   `steps: true`, so the command succeeds as a linked task (Task 12 test `step is dropped for a backend without steps`).

---

## Phase A. Template and the revision-0 refresh

### Task 1: Template Workflow

**Files:**
- Modify: `backend/src/superTabs/instructionsTemplate.ts` (`TEMPLATE_WORKFLOW`, lines 44-56)
- Test: `backend/src/superTabs/instructions.test.ts`

**Interfaces:**
- Produces: `TEMPLATE_WORKFLOW` with eleven numbered lines: the seven of the task-steps spec Part 1, then the four of
  the agent-context spec section 3, as lines 8-11.

- [ ] **Step 1: Write the failing test** `the template workflow has one task per request, steps, and the context tools`:

```ts
expect(TEMPLATE_WORKFLOW).toContain('1. One request is one task.')
expect(TEMPLATE_WORKFLOW).toContain('The PM opens no task to hold, batch, triage or list work')
expect(TEMPLATE_WORKFLOW).toContain('adds a review step to its task')
expect(TEMPLATE_WORKFLOW).toContain('it adds no new step for a second round')
expect(TEMPLATE_WORKFLOW).toContain('run `mine`')
expect(TEMPLATE_WORKFLOW).toContain('read `task GROUP`')
expect(TEMPLATE_WORKFLOW).toContain('read the thread before acting on it')
expect(TEMPLATE_WORKFLOW).toContain('The PM reads `mine` for progress, not `status`.')
expect(TEMPLATE_WORKFLOW.split('\n').filter(l => /^\d+\. /.test(l))).toHaveLength(11)
```

- [ ] **Step 2: Run it and see it fail.** `npx vitest run src/superTabs/instructions.test.ts` → FAIL.
- [ ] **Step 3: Replace `TEMPLATE_WORKFLOW`** with the spec's seven lines verbatim (task-steps spec, Part 1 code
  block), then lines 8-11, wrapped at 120 columns like the rest of the file:
  `8. Before acting after a pause, or when unsure what you are working on, run \`mine\`.`
  `9. Before saying your work is done, read \`task GROUP\` and check that every check has passed.`
  `10. In a thread others have written in, read the thread before acting on it, unless the delivery already says enough.`
  `11. The PM reads \`mine\` for progress, not \`status\`.`
- [ ] **Step 4: Run the instructions, migration and catalog tests.**
  `npx vitest run src/superTabs/instructions.test.ts src/superTabs/migration src/superTabs/routingPolicy.test.ts` → PASS.
  Update any snapshot or exact-text expectation of the old workflow to the new text; no other change.
- [ ] **Step 5: Commit** `Template: one request is one task, its review and test are steps; agents read mine and task`.

### Task 2: Running daemons pick up a changed template

**Files:**
- Modify: `backend/src/superTabs/read/hostRows.ts:87`, `backend/src/superTabs/store.ts:2072`
- Modify: `cli/src/superTabs/host.ts` (`instructionTexts` type at 475, `refreshInstructions` at ~1431)
- Test: `backend/src/superTabs/read/views.test.ts` (or the host rows test beside it), `cli/src/superTabs/host.spec.ts`

**Interfaces:**
- Consumes: `FIRST_INSTRUCTIONS.instructionsHash` (`backend/src/superTabs/instructions.ts:28`), the hash of
  `INSTRUCTIONS_TEMPLATE`.
- Produces: host rows and `GET …/instructions` give `hash: FIRST_INSTRUCTIONS.instructionsHash` at revision 0 (never
  null). The CLI's held text is `{ revision: number; hash: string | null; text: string; history: …; failedSince?: number }`.

- [ ] **Step 1: Backend failing test** `a project with no saved instructions names the template's hash`: a host row for
  an agent of a project with `instructionsRevision` absent has `instructions.revision === 0` and
  `instructions.hash === FIRST_INSTRUCTIONS.instructionsHash`; the instructions read answers the same hash with
  `template: true`.
- [ ] **Step 2: Run it, see it fail; implement** `hash: home.instructionsHash ?? (revision 0 ? FIRST_INSTRUCTIONS.instructionsHash : null)`
  in `hostRows.ts`, and `hash: stored?.hash ?? FIRST_INSTRUCTIONS.instructionsHash` in `store.ts:2072`. Run → PASS.
- [ ] **Step 3: CLI failing tests** in `host.spec.ts`:
  - `a template change at revision 0 is read again`: roster 1 gives `{revision: 0, hash: 'a'}`, roster 2 `{revision: 0, hash: 'b'}`;
    the instructions GET is called twice and the installed text is the second answer's.
  - `the same revision and hash is not read again`: two rosters with `{revision: 0, hash: 'a'}` → one GET.
- [ ] **Step 4: Implement** in `refreshInstructions`: read again when `held?.revision !== doc.revision || held.hash !== doc.hash`;
  store `hash: doc.hash` in `held`. Comment: the 2026-11-02 rollout of #2495, where running agents kept the old template
  because revision 0 never moves. Run `npx vitest run src/superTabs/host.spec.ts` → PASS (or only the known reds).
- [ ] **Step 5: Commit** `Instructions: a template change reaches running agents at revision 0`.

## Phase B. CLI tools and delivery lines

### Task 3: `mine` and `task` views (pure)

**Files:**
- Create: `cli/src/superTabs/agentContext.ts`
- Test: `cli/src/superTabs/agentContext.spec.ts`

**Interfaces:**
- Consumes: a Swarm read `state` (`SwarmRead.state`, `cli/src/superTabs/swarmReads.ts`), `groupChangedAt: ReadonlyMap<string, number>`.
- Produces:

```ts
export interface TaskLine { id: string; number: number | null; title: string; status: string; agentName: string | null
  updatedAt: number | null; result: string | null; pullRequestUrls: string[]; step: string | null; taskId: string | null }
export const FINISHED_STATUSES: readonly string[] // ['done', 'stopped', 'cancelled', 'lost'], as backend FINISHED
export function openWorkOf(state: Record<string, unknown>, agentId: string): TaskLine[]
export function projectOpenWork(state: Record<string, unknown>, agentId: string): TaskLine[] // the coordinator's project
export function isCoordinator(state: Record<string, unknown>, agentId: string): boolean    // service.ts isLead, moved here
export function mineText(state: Record<string, unknown>, groupChangedAt: ReadonlyMap<string, number>, agentId: string, now: number): string
export function taskText(group: Record<string, unknown>, state: Record<string, unknown>,
  attempts: Array<Record<string, unknown>> | null, groupChangedAt: ReadonlyMap<string, number>, now: number): string
```

- [ ] **Step 1: Failing tests** (fixture builders in the spec file; times as `now - 5 * 60_000` print "5 min ago"):
  - `mine lists an agent's open task with status, update time, result and PR`: line equals
    `#12 Fix login — working, updated 5 min ago; last result: Tests pass on main; PR https://github.com/o/r/pull/7`.
  - `mine leaves out a reused agent's finished task`: agent holds #11 `done` and #12 `working` → only #12.
  - `mine leaves out archived tasks` (archived: true, status working).
  - `mine lists linked tasks of its work with their assignee`: #13 `reviewOf` #12, assignee Rev1 working → a line
    `  linked: #13 Review: Fix login — Rev1, working`.
  - `the coordinator's mine lists its project's open tasks and counts them`: ends with `3 open tasks.`; other
    projects' tasks are absent.
  - `mine with nothing says so`: `No task is assigned to you.`
  - `a result is cut to its first line and 160 characters`.
  - `task shows goal, checks, attempts and linked tasks`: checks print `✓ <description> — by Rev1` /
    `✗ <description> — <evidence first line>` / `· <description>`; attempts newest first, current first, at most 10; a
    removed agent shows by id; a brief over 1,500 characters ends with `… (cut; the whole brief: status)`.
- [ ] **Step 2: Run, see them fail.** `npx vitest run src/superTabs/agentContext.spec.ts`.
- [ ] **Step 3: Implement** the functions. Move `isLead` from `service.ts:142` into `isCoordinator` and import it
  back. Relative times: under 1 min "just now", minutes, hours, else the UTC date `YYYY-MM-DD HH:MM UTC`.
- [ ] **Step 4: Run → PASS; `npm run typecheck`.**
- [ ] **Step 5: Commit** `CLI: mine and task views of an agent's work`.

### Task 4: Wire `mine` and `task`, help and the tools skill

**Files:**
- Modify: `cli/src/superTabs/command.ts` (`parseSuperTabArgs`, beside `decisions` at ~198)
- Modify: `cli/src/superTabs/service.ts` (`HELP` at 68; action handlers beside `routeHistory` at 601)
- Modify: `cli/src/lib/swarmTools.ts` (`SWARM_TOOLS_SKILL` Read list)
- Test: `cli/src/superTabs/command.spec.ts`, `cli/src/superTabs/service.spec.ts`, the swarm tools spec

**Interfaces:**
- Consumes: Task 3 functions; the `routeHistory` group read (`GET ${path}/groups/:id?asAgentId`, 403/404 → not found)
  and attempts read. Extract them from `routeHistory` into `readGroupAsAgent(core, path, id, identity)` and
  `readAttempts(core, path, id, identity)` in `service.ts`, used by both.
- Produces: actions `mine` (`{ action: 'mine' }`) and `task` (`{ action: 'task', conversationId }`), each answering
  `{ ok: true, value: string }`.

- [ ] **Step 1: Failing tests:** `parses mine` (`['mine']` → `{action:'mine'}`), `parses task GROUP`, `task without a
  group is a usage error`; service: `mine answers the text`, `task reads a dormant group from the group read`,
  `task of an unreadable group answers NOT_FOUND`; skill text contains `mine`, `task GROUP` and
  `messages GROUP --thread ROOT`; `HELP.mine` and `HELP.task` exist.
- [ ] **Step 2: Run, fail; implement.** `task` uses the active group from `reads.read` when present, else
  `readGroupAsAgent`. The printer prints a string value as is (check `superTabCommand`'s print path handles a string;
  if it JSON-encodes, print strings raw).
- [ ] **Step 3: Run** `npx vitest run src/superTabs/command.spec.ts src/superTabs/service.spec.ts src/lib` → PASS.
- [ ] **Step 4: Commit** `CLI: mine and task commands, in help and the tools skill`.

### Task 5: Deliveries say where they are

**Files:**
- Modify: `cli/src/superTabs/host.ts` (`prompt()` at ~1922, the caller at ~1730, `repliedTo()` at 1875)
- Create: `cli/src/superTabs/deliveryContext.ts`
- Test: `cli/src/superTabs/deliveryContext.spec.ts`, `cli/src/superTabs/host.spec.ts`

**Interfaces:**
- Consumes: `SwarmReads.read(tabId, agentId)` (fresh per delivery, no time cache); Task 3 `openWorkOf`,
  `projectOpenWork`, `isCoordinator`; the one-message read `repliedTo()` already makes (its `thread` summary).
- Produces:

```ts
export function placeLine(state: Record<string, unknown>, groupId: string): string | null
// `In task #12 "Fix login" (conversation <id>).` | `In "Review: Fix login" (conversation <id>).` |
// `In the project chat of <project> (conversation <id>).` | `In <person>'s Buddy chat (conversation <id>).`
export function workLine(state: Record<string, unknown>, agentId: string): string | null
// `You are assigned task #12 "Fix login" (working).` up to three, then ` And N more: mine.`;
// coordinator: `Open tasks in your project: N; mine lists them.`
export function threadLine(root: { author: string; createdAt: string; text: string }, replies: number,
  authors: string[], readCommand: string): string
// `In a thread <author> started (<YYYY-MM-DD HH:MM> UTC): "<first line ≤200>" — <N> replies so far, from <≤3 authors>.
//  Read the whole thread before acting on it: <readCommand>`
```

- [ ] **Step 1: Failing tests** for each line form above; `workLine` for an agent with none → null; `threadLine`
  without counts keeps the root's line and the command; a Buddy's thread session gets the place and reply lines only.
  In `host.spec.ts`: `a delivery whose read fails still goes, without its lines`; `a reply to the root needs no extra
  read`; `a reply to a later reply reads the root once`; `a work.assign delivered right after it names the new task`.
- [ ] **Step 2: Run, fail; implement.** In the caller, read the Swarm once per delivery (catch → no lines, logged once
  per delivery); put the lines before `Message <id> from <author>:`, then the existing quote.
- [ ] **Step 3: Run** `npx vitest run src/superTabs/deliveryContext.spec.ts src/superTabs/host.spec.ts` → PASS.
- [ ] **Step 4: Commit** `CLI: a delivery says its task, the agent's own work and its thread`.

## Phase C. Backend steps

### Task 6: The `step` field and opening a step

**Files:**
- Modify: `backend/src/superTabs/model.ts` (`Conversation`, beside `reviewOf` at 294)
- Modify: `backend/src/superTabs/commands.ts` (schema at 172; `conversation.create` at 1685-1735)
- Modify: `backend/src/superTabs/parts/light.ts` (add `step` wherever `reviewOf` is listed, line 30)
- Modify: `backend/src/superTabs/read/service.ts:101` and the `/changes` answer: `steps: true` beside `githubApp`
- Modify: `backend/src/superTabs/read/contract.ts` (`steps?: true`)
- Test: `backend/src/superTabs/commands.test.ts`, `backend/src/superTabs/read/changes.test.ts`

**Interfaces:**
- Produces: `Conversation.step?: string`; `conversation.create` accepts `step: z.string().trim().min(1).max(40)`
  (optional); reads carry `steps: true`. `isStep(group): boolean` = `!!group.step && !!group.reviewOf`, exported from
  `model.ts`. `stepsOf(state, taskId): Conversation[]` = groups with `reviewOf === taskId && step`, exported from
  `model.ts`.

- [ ] **Step 1: Failing tests:** `a step opens on a task of its project, numbered, its opener in the task`
  (`step: 'Thiết kế "v2" 🎨'` kept byte for byte; `number` set; opener in the task's `agentIds`); refused with
  `INVALID_REQUEST` when `step` has no `reviewOf`; refused `NOT_FOUND` on another project's task; refused on a task
  that is itself a step (`STEP_OF_STEP`, 400, "A step belongs to a task, not to another step."); refused on an archived
  task (as `open()` refuses today); the read and `/changes` carry `steps: true`.
- [ ] **Step 2: Run, fail; implement.** The opener joining the task: add it to the reviewed task's `agentIds` with
  `teamJoin` when it is not the coordinator.
- [ ] **Step 3: Run** `npx vitest run src/superTabs/commands.test.ts src/superTabs/read` → PASS.
- [ ] **Step 4: Commit** `Swarm: a task's step is a linked group with a name`.

### Task 7: Assigning a step joins its agent to the task

**Files:**
- Modify: `backend/src/superTabs/commands.ts` (`work.assign`, membership at ~2705)
- Test: `backend/src/superTabs/commands.test.ts`

- [ ] **Step 1: Failing test** `a step's agent joins its task`: `work.assign` on a step → the agent is in the step's and
  the task's `agentIds`. `a done step may be assigned again` → an attempt row, status `working`. `a step stays working
  across its owner's fix round`: the step's agent fails a task check, its quiet time does not count
  (`waitingForRevision`), the owner's next `review` clears it (`revisionReady`), and liveness does not mark it lost
  (`liveness.test.ts`; these already key on `reviewOf`, so this pins them for steps).
- [ ] **Step 2: Run, fail; implement** with `joinsProject` (`commands.ts:597`) on the task; run → PASS.
- [ ] **Step 3: Commit** `Swarm: a step's agent joins its task's chat`.

### Task 8: A step archives and sleeps only with its task

**Files:**
- Modify: `backend/src/superTabs/parts/write.ts:72` (`workFinished` false for a step)
- Modify: `backend/src/superTabs/sweeps.ts` (`sleepQuietGroups`, line 73)
- Create helper in `backend/src/superTabs/tidy.ts`: `closeSteps(state, task, reason: string, now: number): Conversation[]`
- Modify callers that archive a task: `commands.ts:1798` (archive by hand), `commands.ts:2828` (`work.cancel`),
  `store.ts:3406` (`archiveFinished`); `parts/touches.ts` gains the task's steps for those writes.
- Test: `backend/src/superTabs/archive.test.ts`, `backend/src/superTabs/tidy.test.ts`, `backend/src/superTabs/commands.test.ts`,
  the sweeps test beside `sweepsThreadMarks.test.ts`

**Interfaces:**
- Produces: `closeSteps` archives every step of `task`; an open one is cancelled first with
  `` `${reason}` `` as its result and a system row `"<task title>" was closed: <reason>.` in the step.

- [ ] **Step 1: Failing tests:**
  - `a done step with no pull request is not archived while its task is active` (archive pass after 31 min).
  - `a done step does not sleep while its task is active` (sweep after a day).
  - `a step sleeps once its task is archived`.
  - `archiving a task by hand cancels its working step` (same write: step `cancelled`, `archived: true`).
  - `cancelling a task closes its steps`; `archiveFinished closes the task's steps`.
  - `an old linked group (no step) archives on its own clock as today`.
- [ ] **Step 2: Run, fail; implement.** In the sweep, a candidate step reads its task's row (`db.swarmGroup.findUnique`
  by `tabId_key`, cached per pass) and sleeps only when the task is archived or dormant.
- [ ] **Step 3: Run** `npx vitest run src/superTabs/archive.test.ts src/superTabs/tidy.test.ts src/superTabs/commands.test.ts src/superTabs/sweepsThreadMarks.test.ts` → PASS.
- [ ] **Step 4: Commit** `Swarm: a step archives and sleeps with its task`.

### Task 9: Who hears a step

**Files:**
- Modify: `backend/src/superTabs/commands.ts` (`work.status` `told` at ~2777; `message.send` `workerToLead` and
  `memberToLead` at ~2492-2504; the status label at ~2773)
- Create in `model.ts`: `taskOwner(state, step): string | null` (the task's assignee while its work is open, else null)
- Test: `backend/src/superTabs/commands.test.ts`

- [ ] **Step 1: Failing tests:**
  - `a step's review and done reach the task's owner, not the coordinator`.
  - `with no owner, a step's done reaches the coordinator` (task unassigned; and task `done`).
  - `a step's blocked reaches the coordinator and the owner`.
  - `a step agent's unnamed post in its step reaches the owner`; `… in its task reaches the owner`.
  - `an agent with no open step in the task still reaches the coordinator` (the 10-29 rule).
  - `a step's review row reads Ready, not Ready for review`.
  - `an old linked group keeps today's notices`.
- [ ] **Step 2: Run, fail; implement.** For a step: `told` = `review`/`done` → `[owner ?? lead]`;
  `needs_human`/`blocked` → `[lead, owner]`. Unnamed posts: `workerToLead` in a step → owner ?? lead; `memberToLead` in a
  task when the poster holds an open step of it → owner ?? lead. Label: `isStep(group) && status === 'review' ? 'Ready' : STATUS_LABELS[status]`.
  Comment the Ken 2026-11-02 overload ("the PM's terminal gets a message every few seconds").
- [ ] **Step 3: Run → PASS. Commit** `Swarm: a step tells its task's owner, the PM only what needs it`.

### Task 10: Job kind and reports name a step by its task

**Files:**
- Modify: `backend/src/superTabs/evidence/jobKind.ts:31-32`
- Modify: `backend/src/superTabs/projectUpdates.ts:76-79` (the "#N after S" list)
- Test: `backend/src/superTabs/evidence/*.test.ts` (jobKind's), `backend/src/superTabs/projectStatus.test.ts` or the
  project updates test

- [ ] **Step 1: Failing tests:** `a step's job kind is its route word's, else general` (`step: 'Design'`, route word
  `docs` → `docs`; none → `general`); `an old linked group is review`; the PM's report names a step
  `#1835 · Review after 12`.
- [ ] **Step 2: Run, fail; implement** (`jobKindOf` takes `step` in its `Pick`; a step skips the `review` branch).
- [ ] **Step 3: Run → PASS. Commit** `Swarm: a step is ranked as its own kind of work and named by its task`.

## Phase D. CLI views of steps

### Task 11: `status`, `mine`, `task` and the place line show steps

**Files:**
- Modify: `cli/src/superTabs/agentContext.ts`, `cli/src/superTabs/deliveryContext.ts`, `cli/src/superTabs/service.ts`
  (`statusView` at 150)
- Test: their specs

- [ ] **Step 1: Failing tests:**
  - `status prints a task's steps under it, not as rows` (each group in `conversations` with `step` moves under its task as `steps: [...]`).
  - `mine shows a step's agent its step by its task`: `#1835 "Fix login" · Review — working (step <id>)`.
  - `mine shows the owner its task's steps on one line`: `  steps: Review: Rev1, working · Test: Tester, done`.
  - `the coordinator's open work counts tasks, not steps`.
  - `task lists its steps` (name, agent, status, checks, result's first line, id); `task STEP shows its task with the step marked` (`▶ Review`).
  - `a step's row says its task and step`: `In task #1835 "Fix login", step Review (conversation <step id>).`
- [ ] **Step 2: Run, fail; implement. Run → PASS. Commit** `CLI: steps shown inside their task`.

### Task 12: Merged `messages TASK`, adding a step, and old backends

**Files:**
- Modify: `cli/src/superTabs/service.ts` (`messages` handler at 665; the `command` handler at ~680; `HELP.commands`
  example at 104)
- Modify: `cli/src/lib/swarmTools.ts` (one line: how to add a step, one example)
- Test: `cli/src/superTabs/service.spec.ts`, the swarm tools spec

**Interfaces:**
- Produces: `messages TASK` (no `--before`, no `--thread`) answers the task's page with each step's latest page merged
  in by `createdAt`, each step row with `step: '<name>'`; `stepsMissing: ['<name>']` when a step's read failed.

- [ ] **Step 1: Failing tests:**
  - `messages of a task merges its steps' rows by time and tags them`.
  - `an unreadable step leaves the task's rows and says which step is missing`.
  - `messages of a step reads the step alone`.
  - `step is dropped for a backend without steps` (read without `steps: true`; the sent command has `reviewOf`, no `step`).
  - `a step name with quotes and diacritics is shown and quoted` (`Thiết kế "v2"` in a place line and in the
    `--thread` / `messages` command it prints, through `shellQuote`).
  - the tools skill's step line names no step kind list (`expect(SWARM_TOOLS_SKILL).not.toMatch(/Review, Test/)`).
- [ ] **Step 2: Run, fail; implement.** HELP example: `{ type: 'conversation.create', title: 'Step name', reviewOf: 'GROUP', step: 'Step name', task: {...} }`
  replacing the `Review: Outcome` example's wording with neutral words; the skill line: "Add a step to a task: create
  a conversation with `reviewOf` set to the task and `step` set to the step's name from your instructions, then
  assign it." Changing the skill moves its version (one update notice per agent); keep it to this one line.
- [ ] **Step 3: Run** `npx vitest run src/superTabs src/lib` (known reds only) and `npm run typecheck` → PASS.
- [ ] **Step 4: Commit** `CLI: a task's messages include its steps; adding a step`.

## Phase E. Desktop and phone

### Task 13: Steps in the task list

**Files:**
- Modify: `desktop/lib/super_tabs/model.dart` (`reviewOf` at 317/385: add `step`), the phone's `mobile/lib/swarm/model.dart`
- Modify: `desktop/lib/super_tabs/linked_tasks.dart` and `mobile/lib/swarm/linked_tasks.dart` (byte-identical)
- Modify: `desktop/lib/super_tabs/project_sidebar.dart:1253` (`superTabOpenWorkgroups`), `mobile/lib/swarm/swarm_project_page.dart:68-72`
- Test: `desktop/test/super_tabs/` (linked tasks and sidebar tests), `mobile/test/swarm/desktop_parity_test.dart`

**Interfaces:**
- Produces: `SuperTabConversation.step` (`String?`); `superTabLinkedLine` prints a step as `<step> (<agent>): <state>`
  and a linked group without `step` as today (`#14 Review PR 12: passed`); `superTabIsStep(conversation)`.

- [ ] **Step 1: Failing tests:** `the sidebar hides steps and keeps old linked groups`; `the steps line names each
  step and its agent` (`Copy (Writer): passed · Design (Designer): working`); phone list the same; parity test passes
  with both files identical.
- [ ] **Step 2: Run** (`cd desktop && flutter test test/super_tabs/<files>`; `cd mobile && flutter test test/swarm/<files>`)
  → FAIL; implement; run → PASS. `dart format` the touched files only.
- [ ] **Step 3: Commit** `Desktop, phone: a task's steps sit on its row, not in the list`.

### Task 14: Steps panel and the merged chat

**Files:**
- Modify: Desktop's task header and message loader (`desktop/lib/super_tabs/controller.dart` ~3518 and ~3698, the
  selected group's view in `view.dart`); phone's `mobile/lib/swarm/swarm_chat_cache.dart` and the chat page
- Create: `desktop/lib/super_tabs/task_steps.dart` and `mobile/lib/swarm/task_steps.dart` (byte-identical: the merge
  and the panel rows' text), added to the parity test
- Test: `desktop/test/super_tabs/task_steps_test.dart`, `mobile/test/swarm/task_steps_test.dart`

**Interfaces:**
- Produces: `List<SuperTabMessage> superTabMergeSteps(List<SuperTabMessage> task, Map<String, List<SuperTabMessage>> steps,
  Map<String, String> stepNames)` (by `createdAt`, then id; each step row carries its step name for the row label);
  `String superTabStepRow(SuperTabConversation step, SuperTabSnapshot snapshot)` (`Review · Rev1 · working · 2 of 3 checks passed`).

- [ ] **Step 1: Failing tests:** `steps' rows merge into the task's by time with their step's name`; `a step whose
  read fails leaves the task's rows`; `the panel row shows name, agent, status and checks`; tapping a row opens the
  step agent's pane (widget test on Desktop).
- [ ] **Step 2: Run, fail; implement.** Opening a task reads each step's latest page once, then follows each step's
  changes as any group's; a step row shows its step's name beside the author.
- [ ] **Step 3: Run → PASS; `dart format` touched files. Commit** `Desktop, phone: a task shows its steps and their messages`.

## Shipping order

1. Phase A (Tasks 1-2): backend then CLI, before `scripts/swarm-instructions/migrate.ts --apply` runs on prod.
2. Phase B (Tasks 3-5): CLI.
3. Phase C (Tasks 6-10): backend.
4. Phase D (Tasks 11-12): CLI.
5. Phase E (Tasks 13-14): Desktop and phone.

Validation per phase: the touched tests above, then for backend phases the whole `src/superTabs` vitest run; for CLI
phases `npx vitest run src/superTabs src/lib` plus `npm run typecheck`; for clients `flutter test` of `test/super_tabs`
and `test/swarm`. Record what ran in the PR.
