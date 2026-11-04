# Personal Swarm Lead Auto-Start Implementation Plan

> **For agentic workers:** The assigned Engineer implements this plan task by task in this session, test first
> (Swarm project instructions, Engineer role). No Execution Handoff.

**Goal:** In a person's Personal Swarm, a message sent in a project chat that has no Lead starts that project's Lead
on the person's own machine and is delivered to it once it runs, instead of "Not sent · this chat has no Lead".

**Architecture:** Desktop starts the Lead, the backend keeps the message and the one-start guarantee.

- The person's Desktop already starts a project's Product Manager on its own machine (`SuperTabLaunch`: a native
  start, then `agent.add` with `lead: true`). Only Desktop knows the project's repo folder: a Personal project's panes
  stay on the person's computers and the server learns only the project's name (`personal_projects.dart`). So the
  start stays on Desktop, run without the New Harness form.
- Backend `message.send`: a person's message in a Personal Swarm project chat with no Lead is recorded as waiting for
  the project's Lead (`project.leadWaiting`, ids and times only, at most 20).
- Backend `lead.claim` (new, person only, Personal Swarm only): the one start per project. The first claim answers
  `start`; while a claim from another machine is under 10 minutes old, a claim answers `waiting`. A claim from the
  same machine replaces its own (that Desktop's earlier attempt ended). A Team Swarm refuses it.
- When a Lead joins the project chat (`agent.add` with `lead`, or a Swarm-started Lead's `agent.started`), the
  waiting messages of the last 30 minutes are delivered to it (`lateDeliveries`, as a Buddy's waiting messages are),
  and the waiting list and claim are cleared.
- Desktop `PersonalLeadStarter`: on a send in the Personal Swarm's project chat with no Lead it claims, then starts the
  Lead on this Mac (or the person's machine whose pane holds the project's repo), in the repo's folder when the project
  has one, else a new folder in the default Harness projects folder, Claude Code first, else Codex. One start per
  project at a time on this Desktop, and the server's claim across Desktops.
- Desktop receipt: "Starting a Lead…" (muted, spinner) while a start runs; "Couldn't start a Lead: <reason> · Add a
  Lead" when it failed; a Team Swarm keeps "Not sent · this chat has no Lead · Add a Lead".

**Tech Stack:** TypeScript backend (Vitest), Flutter Desktop (widget tests with the memory store and a fake sign-in).

**Spec:** Swarm task #2633, conversation c85441c4d697a0af4e04631f (Huy, 11-04).

## Global Constraints

- Personal Swarm only; Team Swarms keep today's behaviour, message and receipt alike.
- Never more than one Lead start for one project at a time.
- Swarm code stays out of `cli/src/core`. Desktop tests use a memory store and a fake sign-in; no test signs out the
  real CLI.
- Harness Design Language: the receipt line keeps its existing form (14 px icon, 12 px metadata text, quiet link
  actions); copy follows the Naming System ("Lead" as the existing receipt says it).
- PR body's first line: `Requested by phamngochuy.1989@gmail.com through Harness.`

## Design

- Growth: `leadWaiting` holds at most 20 ids and is cleared when a Lead joins; entries older than 30 minutes are never
  delivered and are dropped on the next write. `leadClaim` is one record per project, replaced or cleared.
- Concurrency: both are written by commands, which run under the Swarm state's one lock, so two claims are ordered.
- Read cost: no new read; the late deliveries read each waiting message by its primary key (at most 20).
- Scale: 10x people means 10x Personal Swarms, each with its own state; nothing is shared between them.
- Compatibility: an older Desktop sends no claim and keeps "Not sent"; its message still waits for the Lead. The phone
  says "Waiting for a Lead · open Harness on your computer to start one" for a message the server keeps (River, 11-04);
  a phone with an older server keeps "Not sent". A newer Desktop against an older backend gets `lead.claim` refused as unknown and shows the start failed with
  Add a Lead.
- Migration and rollback: new optional fields only; a rollback leaves them unread.
- Audience: the server refuses `lead.claim` outside the owner's Personal Swarm and from anyone but a person who manages
  the project; deliveries go only to the Lead that joined, of the person's own messages. A Buddy reads no claim (it names
  a machine).
- Identity: the Lead runs on the person's own machine as them, through the existing local start.
- Failure: a refused claim or a failed start says why on the receipt with Add a Lead.
- Platforms: Desktop on macOS, Linux and Windows run the same code; the phone is unchanged.

## Review Focus

- A Team Swarm send is unchanged (no waiting record, no claim, same receipt).
- Two quick sends produce one native start and one claim.
- Late deliveries reach only the joined Lead and only the person's own main-chat messages.
- The start uses the repo folder on the machine that holds it, never a folder from another machine.

---

### Task 1: Backend: waiting messages and the claim

**Files:**
- Modify: `backend/src/superTabs/commands.ts`, `backend/src/superTabs/projects.ts`, `backend/src/superTabs/model.ts`,
  `backend/src/superTabs/store.ts`
- Test: `backend/src/superTabs/leadWaiting.test.ts`

**Interfaces:**
- `lead.claim { projectId, machineId }` → result `{ leadStart: 'start' | 'waiting' }`.
- `SwarmProject.leadWaiting?: Array<{ id: string; at: number }>`, `SwarmProject.leadClaim?: { id; machineId; at }`.
- `CommandEffects.lateDeliveries[].lead?: true`.

- [x] Failing tests: a Personal Swarm send with no Lead records the message; a claim answers `start`, a second from
      another machine `waiting`; `agent.add` as Lead (with a repo, and without) yields a late delivery of the message
      and clears both; a Team Swarm records nothing and refuses the claim.
- [x] Run them and watch them fail.
- [x] Implement; run the tests of the changed files.

### Task 2: Desktop: the starter

**Files:**
- Create: `desktop/lib/super_tabs/personal_lead.dart`
- Modify: `desktop/lib/super_tabs/view.dart` (send path)
- Test: `desktop/test/super_tab_personal_lead_test.dart`

**Interfaces:**
- `PersonalLeadStarter.of(app)`: `wants(c, conversationId)`, `afterSend(c, conversationId)`, `stateOf(...)` →
  starting / failed(reason).

- [x] Failing tests: a send with no Lead claims and starts one in the repo's folder (repo case) or a new Harness folder
      (no-repo case), and joins it as Lead; a failed start records the reason; two quick sends make one start; a Team
      Swarm starts nothing.
- [x] Run them and watch them fail.
- [x] Implement; run the tests of the changed files.

### Task 3: Desktop: the receipt note

**Files:**
- Modify: `desktop/lib/super_tabs/message_receipt.dart`
- Test: `desktop/test/super_tab_receipt_test.dart`, `desktop/test/super_tab_personal_lead_shots_test.dart`

- [x] Failing tests: "Starting a Lead…" while starting; "Couldn't start a Lead: <reason>" with Add a Lead after a
      failure; a Team Swarm still says "Not sent · this chat has no Lead".
- [x] Run them and watch them fail.
- [x] Implement; capture light and dark screenshots of both lines; run the receipt tests.

### Task 4: Phone: the waiting line (River, 11-04)

**Files:**
- Modify: `mobile/lib/swarm/model.dart`, `mobile/lib/swarm/swarm_message_receipt.dart`
- Test: `mobile/test/swarm/swarm_no_lead_receipt_test.dart`

- [x] Failing test: a message the server keeps for the Lead (`leadWaiting`) reads "Waiting for a Lead · open Harness on
      your computer to start one", without Not sent or Add a Lead.
- [x] Implement; run the phone receipt tests.
