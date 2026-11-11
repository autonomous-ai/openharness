# When an agent needs a person, the person is told in the Swarm: plan

> Written by the Engineer per the project instructions (writing-plans, then test-driven-development task by task). No
> Execution Handoff: the Engineer implements it.

**Goal:** An agent in a task that waits at a prompt in its terminal reaches the person that task needs, under Decisions
(Desktop's red count and row, the phone's notice), and the row clears once the agent moves on. Agents are told never to
ask a person only in their terminal. Task #3029, requested by Gray.

**Architecture:** The backend already keeps `agent.alerting` with `prompt` while a host sees its agent at a prompt
(cli `superTabs/terminal.ts`, after 3 minutes) and drops it when the prompt goes. A new pure function
(`backend/src/superTabs/promptWaits.ts`) derives, on each person's read, the prompts that wait for them: an agent at a
prompt whose active task names them as its requester (a step's, the task it reviews), or whose task needs a device on
the agent's machine and they own that machine; only in tasks they still read. It goes out as `derived.promptsWaiting`.
Nothing is stored. Desktop lists these as rows on the Decisions page and counts them in the sidebar's red count. The
agent's last lines are read on demand through the existing `agent.screen` request, which checks who may read the
terminal (`terminal.ts mayDrive`). The row's button opens the terminal through `openAgentTerminal`. The phone adds each
as a need, so it raises the same local notice as other needs. The skill text gets one line in every role.

**Tech Stack:** TypeScript (backend, vitest), Dart/Flutter (Desktop and phone widget tests with the in-memory
`ConversationServer`), CLI skill text (vitest).

**Spec:** the task's brief (#3029) and River's added piece: opening Decisions for one need lights its row for a moment.

## Design

- growth: nothing is stored. A row exists while `alerting` holds `prompt` and the task is active.
- concurrency: N/A, because it is read-only and derived inside each read from the state that read already loaded.
- read cost: one pass over agents that are alerting (few), then one conversation lookup each, per person read. No database read.
- scale: at 10x agents, the pass is still O(agents). The first warning would be read latency on `/changes`, which is already measured.
- compatibility: `promptsWaiting` is a new optional field. Older Desktops and phones ignore it, and newer apps read an
  older backend's missing field as none. An old app's count does not change.
- migration + rollback: none. Rolling back the backend removes the field, and apps show nothing.
- audience: the server picks each reader's rows. A row needs the reader to be the task's requester or the device
  machine's owner, and to still read the task (`canReadGroup`). Agents get no field. No screen text goes in the read;
  last lines come only through `agent.screen`, under `mayDrive`.
- identity: the person comes from the task's `requesterId` and the agent's `machineOwnerId`, never from a login.
- failure: when the terminal read is refused or fails (Team account, machine offline), the row still shows and says it
  cannot show the lines. The button then opens the task.
- platforms: backend; Desktop on macOS, Windows and Linux (Flutter); phone (iOS/Android, local notices).

## Global Constraints

- Only the task's own people are told; nothing about other projects.
- No screen text stored or sent in reads; the PM's alert row is unchanged.
- Swarm code stays out of `cli/src/core`. Desktop tests use a memory store and a fake sign-in.

## Review Focus

- Who is told (`promptWaits.ts taskPerson`), and that a reader who lost the task is told nothing.
- That last lines go only through `agent.screen` (mayDrive), never in the read.

## Tasks

### Task 1: Backend: prompts that wait for a person, in their read

**Files:** `backend/src/superTabs/promptWaits.ts` (new), `promptWaits.test.ts` (new), `read/views.ts`, `read/contract.ts`.
**Interfaces:** `promptWaits(state, person): PromptWait[]`; `Derived.promptsWaiting?: PromptWait[]`.

- [ ] Failing tests: requester told and PM still told, cleared on `active: false`; others, the machine owner without a
      device, and a reader who lost the task are not told; the device machine owner is told; a step's task requester is told;
      the field is on a person's read only.
- [ ] Implement; run `promptWaits.test.ts`, `terminal.test.ts`, `read/views.test.ts`.

### Task 2: Skill text: never ask a person only in your terminal

**Files:** `cli/src/lib/swarmSkills.ts`, `cli/src/lib/swarmSkills.spec.ts`.

- [ ] Failing test: every role in both modes has the line once (post the ask in the task, tag the person, set needs_human).
- [ ] Add the line under each role's "Who a post reaches". (The brief names a Desktop copy of this text. None exists in
      `desktop/`: Desktop launches agents through the CLI, which writes these files.)

### Task 3: Desktop: the Decisions row, the count, last lines, the highlight

**Files:** `desktop/lib/super_tabs/model.dart`, `parts.dart`, `activity.dart`, `decisions_page.dart`, a new
`prompt_lines.dart` (the screen read), tests in `desktop/test/super_tab_prompt_waits_test.dart` and the fixture.

- [ ] Failing widget tests: a prompt wait shows as a Decisions row with its agent, task and last lines, and counts in the
      sidebar; its button opens the terminal; it leaves once the read drops it; a refused screen read says so; opening the
      page for one need lights its row.
- [ ] Implement; light and dark screenshots of the row.

### Task 4: Phone: the notice

**Files:** `mobile/lib/swarm/model.dart`, `parts.dart`, `swarm_inbox.dart`, `swarm_notices.dart`, a test.

- [ ] Failing test: a prompt wait in a read becomes a need that announces once ("X is waiting at a prompt"), and goes when
      the read drops it.
- [ ] Implement.
