# Project instructions: one document defines a project's roles, workflow and routing

Status: design, 2026-10-30. Requested by Ken.

## Why

Three problems showed up the same day, and they share one cause: how a Swarm project works is fixed in code.

**Routing is decided by the server, and changing it needs a release.** On 2026-10-30 tasks waited all morning for review.
The Product Manager (PM) wanted to start an Opus Reviewer for Claude builds, and the server refused: a review had to run on
another engine than its Builder, and Codex machines counted as able to start one while Codex was out of quota until 4 Nov.
The PM worked around it outside the Swarm and told Ken "the server blocks it, there is no route". Each change Ken asked for
needed code, review and a backend release. Routing is decided in four places the PM does not control: the routing policy
(quality 1-3, cost 1-100, floors, quota reserve; owner only), the owner's hard rules (six fixed kinds), review and step-up
rules in code, and a task's machine and device requirement. Each is enforced twice, in the backend
(`backend/src/superTabs/rules.ts`, `stepUp.ts`, `commands.ts` `refusal`) and in the CLI's route
(`cli/src/superTabs/route.ts`, `routeCommand.ts`), and the two drift.

The same day added more of the same, each a reasonable request turned into server code: #2313 dropped the other-engine
review rule; #2314 made every build need quality 3 (`buildRefusal`, `BUILD_REFUSED`), let grid models build only low-risk
docs, tests or fixtures (`GRID_BUILDS`), turned Sonnet and Haiku off in the default table and let only a Reviewer pass a
review's checks. Each needed a release; under this design each would have been one sentence in the document.

**Every message goes through the PM.** Ken watched the PM's terminal receive a message every few seconds, filling Opus's
1M context:

- every post an agent makes in a task is also delivered to the PM (`commands.ts` `message.send`: `workerToLead`,
  `memberToLead`);
- an agent may only name recipients in its own conversation (`INVALID_RECIPIENT`); a review runs in its own group that the
  Builder is not in, so Builder and Reviewer cannot talk and everything relays through the PM;
- each server notice (review opened with no free Reviewer, task lost or stalled, step-up, recording gap, Buddy proposal)
  wakes the PM separately (`terminal.ts` `toLead`, `liveness.ts`, `autoReview.ts`, `native.ts`).

**Roles are three fixed kinds.** A project's custom role set (`projects.ts` `ProjectRole`, up to 20 roles with their own
text) still makes every role a `lead`, `builder` or `reviewer`, and the server behaves by kind: only `reviewer` agents
are picked for automatic reviews, kept after their task, credited for reviews (`ship.ts`) and tidied differently; the
lead is always the PM. A team cannot define "QA on the device", "Designer" or "dev1 and rev1 always pair".

## What Ken decided

1. **One instruction document per project defines everything**: its roles, its workflow (who does what, who tells whom
   and when, when the PM gathers work) and its routing (models, machines, preferences). Roles, workflow and routing are
   all flexible; the examples people write are not something the code knows.
2. **Agents read it and work by it.** The PM starts new agents in the roles the document defines and runs the work as it
   says; every agent reads its own role's part.
3. **With no instructions of its own, a project runs on a built-in template** that describes today's behavior plus a
   Tester role. People
   guide the PM afterwards in chat, and the PM keeps the document up to date.
4. **Every member** of the Swarm may change the document, directly or by asking the PM.
5. **The server locks no role, workflow or routing rule.** It enforces facts and access only (below).
6. **Agents message each other directly**, and a message reaches only the agents it names; the server stops copying
   agents' messages to the PM.
7. **Server notices still go to the PM, at once.** They are about three an hour, so gathering them would only add delay;
   there is no notice period (Ken, 2026-10-30: an option nobody needs is code nobody should keep).
8. The routing table ("Routing for this Swarm") and the separate custom roles editor go; the document replaces both.
9. A task's machine or device need is part of the instructions too; whether a device is connected stays as information.

## Goals

- A member changes how a project works (a role, a step of the workflow, a routing preference) by editing one document or
  saying one sentence to the PM, effective at once, with no release.
- Agents coordinate directly as the document says, so the PM hears only what it needs.
- The PM is woken by people, by agents that address it, and by server notices, no longer by copies of agents' posts.
- Every member sees, in one place, what every agent works by, and who changed what and when.

## Non-goals

- Access and safety rules stay: who can read a project, Team account access (`teamWorkCheck`), Buddy guards and
  allow-list, the starts-pending cap.
- Buddies keep their own fixed role and guards; they are not defined by the document (they read it, as members' helpers).
- A visual workflow editor, a state machine or a flow chart. The document is text.
- How the PM's machine is chosen (#2228) does not change.
- Cost records, route decisions, the leaderboard and the nightly reflection keep recording; only what they enforced goes.

## Anti-goals (a failure even if it works)

- An agent answering "the server blocks it" for a role, workflow or routing choice.
- A behavior that exists only in code, so a member cannot change it in words.
- A document only one person can see or change, or that changes without anyone being able to tell who changed it.
- Agents talking in a loop with nobody noticing, burning quota.
- Losing what teams already set: rules, policy notes and custom role texts survive in the document, in their own words.

## What the server still enforces: facts and access only

A start, assignment or message is refused only when it cannot happen or breaks an access rule:

- the machine is offline, removed, or paused by its owner;
- the engine is not signed in or is suspended there; the model is not served there (a grid model whose host is down);
- a recipient or conversation is outside the sender's project, or the sender may not read it;
- the access and safety rules under Non-goals;
- the Swarm's and project's own settings, which stay coordinator-or-person (see the inventory below).

Quota is information, not a gate.

## The instruction document

### Shape and storage

- One Markdown document per project, at most 64 KB (today's limit for one role's text). Stored outside the Swarm state,
  as custom role texts are today (`SuperTabRoleText`, read by `store.ts` `roleText`), in a new per-project record with a
  revision number.
- The state keeps only its revision and a short hash, so reads stay light and agents know when to refresh.
- Every save keeps the previous version: the last 50 revisions, each with who wrote it (`writtenBy`: a member or the PM),
  whose words it carries (`askedBy`), when, and a one-line summary of the change. Older revisions are deleted.
- The document is free text. The template suggests three sections (Roles, Workflow, Routing) and one heading per role, so
  people and agents find things, but nothing parses or requires them.

### Who changes it

- Any member who can read the project edits it from Desktop, or asks the PM in the project chat or through their Buddy. The
  server checks only that the actor can read the project (`readProject`) and that the save is on the latest revision
  (otherwise it is refused with the current text, to merge and save again).
- The PM edits it when a member asks; `askedBy` names the member, and no quoted message is needed (the `askedIn` check and
  `RULE_MESSAGE_MS` go).
- Every save posts one line in the project chat with its summary ("Dee changed the instructions: Reviews run on Opus."),
  so the team sees it without opening the document.
- Conflicts in content: when a request contradicts the document, the PM changes the document, says so and tells the
  author of the line it replaced. It never silently keeps both.

### The built-in template (default instructions for software projects)

Today's Default and Harness orchestration skill texts (`cli/src/lib/swarmSkills.ts`) become one template document, with
one change Ken asked for: a **Tester** role. Its content, in substance (the wording is the builder's):

**Roles**

- **PM**: talks with people, turns requests into tasks with a "Done when", starts and assigns agents by these
  instructions, keeps the instructions up to date when members ask, merges work that passed review and test, reports
  progress. Does not write the code itself.
- **Engineer**: does one task on its own branch, opens a pull request, and asks for review and test directly.
- **Reviewer**: reads the pull request's code against the task and the codebase, and gives a verdict with findings. Never
  the Engineer of the same task.
- **Tester**: does not read the code. Takes the pull request's branch, builds and runs it as a user would, where the change
  runs (Desktop on a Mac; the CLI on a Mac and a Linux box; the web in a browser; the phone app in a simulator; firmware on
  the device plugged into a machine), follows the task's "Done when", and gives a verdict with evidence (screenshots, logs,
  commands run) and, for a failure, the steps that reproduce it.

**Workflow**

1. The PM opens a task with its goal and "Done when", and assigns an Engineer (starting one when none is free).
2. When the pull request is ready, the Engineer opens its review and, when the change is something a user sees or uses
   (screens, CLI commands, install and release, sign-in, connections between machines, devices), its test, and messages
   the Reviewer and the Tester directly. Review and test run **in parallel**. Refactors, docs and test-only changes get a
   review only.
3. Findings go straight to the Engineer. The Engineer fixes and asks again; the Reviewer re-reads what changed, and the
   Tester re-tests when the fix changes behavior.
4. When the review passes, and the test passes where there is one, the Engineer tells the PM once.
5. The PM checks CI on the passed pull requests and merges them, and tells the people who asked.
6. A task that needs a person, or a machine that is down, goes to the PM at once by name. Idle Engineers are stopped;
   Reviewers and Testers are kept while the work they checked is open.

**Routing**

- Engineers run on Opus high or Codex Astra xhigh, whichever has quota at the better price; no engine preference, no
  Sonnet or Haiku Engineers (Ken and Dee, 2026-10-30, #2314).
- Reviewers run on a model at least as strong as the Engineer's, on either engine, never on a grid model.
- Low-risk docs, tests and fixtures go to a model on the Swarm's grid first, moving to Opus or Astra after a failed
  review.
- A Tester runs on a machine that has what the change needs (a Mac for Desktop, the machine the device is plugged into for
  firmware); that comes before model choice. A mid-strength model is enough for most testing.

- A new project starts with a copy of the template in its document (design call: a copy, so the team edits its own; the
  template's later improvements are offered to the PM as a suggested change, never applied silently).

### How agents read it

- Every agent gets two skills in its workspace, refreshed by the existing skill refresh (`swarmSkills.ts`
  `refreshSwarmSkill`, which already installs and versions custom role texts):
  - **Harness tools** (built in, no workflow): how to use the Harness CLI's `harness super-tab` commands: send messages,
    create and assign tasks, start agents, route, report status, read the document. The same for every agent. It follows
    the code: it changes in the same CLI release as the commands it describes, and nobody writes it by hand.
  - **Project instructions**: the project's document as it is, plus one line naming the agent's role.
- When the document changes, each active agent of the project gets one short notice ("The project's instructions changed:
  <summary>. Re-read your role.") and its skill file is refreshed.
- `harness super-tab instructions` prints the current document; `harness super-tab route` prints it above its ranking.

## PM notes: the small things it is told

The instruction document is the big, shared one. Beside it, the coordinator keeps **notes**: small, often temporary things
a member tells it, such as "don't use Codex on machine A" (Ken, 2026-10-30). Today the PM can only keep these in its own
engine's memory on the machine it runs on, which is lost when it moves or starts a fresh session.

- Per project, stored on the server beside the document (not in the coordinator's machine), so they survive a restart or a
  move.
- A note: `{ id, text (1-300 chars), askedBy (member), at, expiresAt? }`. At most 100 per project; an expired note is
  deleted. The coordinator may give one an end ("until tonight") when the member's words say so.
- **The coordinator writes them freely**, with no approval and no chat announcement, so they cost nobody attention.
- **Every member sees them and can delete one** (not edit), under the document in the Instructions panel, as "PM's notes",
  with who asked and when. A wrong or stale note is removed, and the coordinator is told it was.
- When a note and the document disagree, the coordinator follows the newer, and offers to change the document when the
  note is meant to last.
- Agents read them with the document: `harness super-tab route` and `harness super-tab instructions` print them; they are
  not part of the instructions skill file, so frequent notes do not refresh every agent's skill.

## Roles

- An agent carries a **role name** (free text, at most 40 characters, as role names are today) chosen when it is started.
  The server stores and shows it and checks nothing against the document, which it does not parse. An agent whose role
  is not in the document says so to the PM.
- The PM starts agents in the roles the document defines, with the models and machines the document and the route
  suggest. People can still start or add an agent in any role by hand.
- **Every project always has a PM** (Ken, 2026-10-30), created with the project and never removable by the document.
  The document may rename it and say what it does, but not drop it; a document with no PM section leaves the PM running on
  the template's PM part. Elsewhere in this document the PM is called the coordinator.
- **One coordinator per project** stays as a server concept (today's project Lead, `leadConversationId`/`leadId`): the agent
  people talk to when they address no one, and the one that receives the server's notices. Its role name and everything it
  does come from the document ("PM" in the template). Its first start, from New Project, keeps today's machine choice
  (#2228) and the built-in model default (Opus 5.5 xhigh, #2274), since the document cannot choose a model before any
  agent reads it (design call).
- **Any agent of the project may do what only the coordinator may do today** (design call: who does it is workflow, not
  access): create a task (`conversation.create`, `work.define`), assign it (`work.assign`), add an agent to a task
  (`conversation.agent`), start an agent (`agent.start`) and record a route (`route.record`). `controls()`/`LEAD_REQUIRED`
  and `ROUTE_REQUIRED` go. What stays is access (the agent belongs to the project and may read the conversation) and the
  facts (machine slots, the starts-pending cap). So a document can say "an Engineer whose work is ready opens its own
  review and starts or assigns the reviewer", and it works without the coordinator.
- What the server did by role kind becomes generic or moves to the document (design calls):
  - **Automatic reviews** (`autoReview.ts`): no longer a server step. The template's workflow has the agent whose work is
    ready open the review task itself, linked to its work (`reviewOf`, kept), and assign or start the reviewer. That is as
    immediate as today, with no coordinator in between.
  - **Checks**: who may pass a task's check is workflow. `INDEPENDENT_REVIEW` and the `independent` flag go (Ken,
    2026-10-30: the server validates nothing about the flow). The template says a reviewer, not the agent that did the
    work, passes a review's verdict.
  - **Review credit** (`ship.ts`, leaderboard): whoever passes a check on another agent's task gets review credit,
    whatever its role name.
  - **Idle agents** (`tidy.ts`, `workDecision`): the server stops no agent for being idle. An agent that has belonged to
    no open task for 15 minutes is reported to the coordinator as idle; the coordinator stops or keeps it as the
    document says (the template: stop idle Engineers, keep Reviewers and Testers while the work they checked is open).
  - `REVIEWER_NOT_LEAD`, `requireCustomRole`, `chosenRole` and the `lead | builder | reviewer` kind go. Role defaults per
    role (`roleDefaults`) move into the document's routing.

## Agents message each other

- An agent may post in any open conversation of its own project and name as recipients any agents of that project,
  including ones not in that conversation. A recipient not yet in the conversation joins it (design call), so delivery
  (`store.ts` `deliveryAllowed`), replying (`postable`) and passing checks keep their membership rules unchanged. People
  reading the conversation see the message as today.
- A message that names agents reaches exactly those agents: no copy to the coordinator (`memberToLead` stops adding it).
- A message that names no one goes to its default addressee, as today: an agent's to the coordinator (below), the
  coordinator's to the task's assigned agent (`leadToWorker`, with its bounce limit), a person's as before.
- **An agent's post that names no one is never lost**: it is posted, and goes to the coordinator as a notice. This covers today's skills and old CLIs, whose agents never name anyone (a monitoring agent's "the
  backend worker is down" alarm reached no one for 4 h 50 min on 10-29 when such a post went nowhere).
- A person's message is unchanged: it reaches the agent it addresses, or the coordinator when it addresses none.
- **Loop notice** (design call): when two agents exchange more than 20 messages in 30 minutes with no state change on
  their tasks and no person in between, the pair is reported to the coordinator as "these agents may be talking in
  a loop". Delivery is not held; the coordinator decides. `leadWorkerBounced` goes.

## Server notices to the coordinator

Measured on the openharness Swarm, 24 hours to 2026-10-30 06:40 UTC: the PM received 486 messages (about 20 an hour,
43 at the busiest hour): 198 agents' posts copied to it by the server (194 from Builders), 174 from people, 51 Buddy
proposals and 63 server notices (52 status changes such as Ready for review or Done, 8 automatic reviews, 2 start
timeouts, 1 terminal alert). The copies are the load; the notices are about three an hour.

- Server notices (a task's status change, a task lost or stalled, a failed start, a terminal alert, a recording gap, an idle
  agent, a possible loop, an agent's post that named no one) are **delivered to the coordinator at once by default**, as
  today.
- People's messages, Buddy proposals (a person's request) and agents' messages that name the coordinator are always
  delivered at once; they are not notices.
- The project's update cadence (`updateMinutes`, `projectUpdates.ts`) and the daily digest (`digest.ts`) are unchanged.

## Routing

- The route ranks candidates as advice; the coordinator (or whichever role the document gives routing to) follows the
  document and, where it says nothing, chooses by strength, quota and price. A route decision records the document
  revision it relied on.
- **Model catalog** (design call): a reviewed, read-only list in the backend beside `costs/prices.ts` and
  `benchmarkPriors/`, of each engine's models and offered efforts (today's default rows after #2314: Opus high and xhigh, Codex default, GPT-6.1 Sol, Astra xhigh; Sonnet and Haiku
  listed but not offered by default, which the template says in words), with a strength rating; grid
  models keep today's built-in ratings as catalog data. Adding a model is a data change. A model a member names that is
  not in the catalog may still be started; the route lists it unrated. The backend serves catalog, priors and prices to the
  CLI in one read.
- The CLI's route (`routeCommand.ts`, `route.ts`, `planInput.ts`) filters by facts only: no owner rules (`broken`), task
  requirement (`unmet`), review floors or other-engine rule, step-up floor, difficulty floor or quota reserve. It ranks by
  strength, price, quota fit and idle agents.
- The server no longer steps tasks up or cancels a Builder (`stepUp.ts`): a failed first review or failed grid start is a
  notice to the coordinator with the failure, the model and the findings; the document's workflow says what happens next.
- Task requirements (`TaskRequirement`) are not enforced. A start may still ask its machine to check devices; the result
  is reported on the start and in the route.

## The nightly routing reflection

The nightly reflection (#2276, #2316: `costs/reflection.ts`) proposes up to three routing changes to the project owner,
and a Yes today only puts the change on a list the Lead is reminded of each night for 30 days. Under this design a Yes
is a change to the document: the coordinator writes the approved change into the Routing section (announced like any
save, `askedBy` the owner who said Yes). The separate approved list, its nightly reminder and the lapsed-approval recall
go; the reflection reads the document instead to tell whether the last 7 days routed as it says. Proposals and their
evidence are unchanged.

## Server changes, in brief

- `commands.ts`: `refusal`/`ruled` keep the fact checks only (`RULE_BROKEN`, `REQUIREMENT_UNMET`, `REVIEW_REFUSED`,
  `STEPPED_UP` and `BUILD_REFUSED` go); `message.send` takes project-wide recipients without copies
  to the coordinator, with the loop notice; role kinds removed from `agent.add`/`agent.start`/assignment paths; new
  commands `instructions.save` (text, base revision, summary, askedBy).
- `rules.ts` (`broken`, `unmet`, `reviewRefusal`, `buildRefusal`, `GRID_BUILDS`), the role checks in `commands.ts`
  (`assignable`: `REVIEWER_NOT_ASSIGNABLE`, `REVIEW_GROUP`; `work.check`: only a Reviewer or person passes a review's
  checks, `INDEPENDENT_REVIEW`), `routingPolicy.ts` (policy, override, endpoints), the rule commands, `autoReview.ts`'s automatic step,
  `stepUp.ts`'s floors, `reviewCapacity.ts`'s engine logic: removed. Old CLIs' `rule.set` appends the rule's text to the
  document's Routing section; `rule.remove` is accepted and does nothing.
- New store record for the document and its revisions; the project read carries revision and hash.

## What this replaces in main (inventory at d48e2cba5)

A read of backend, CLI, clients and docs at d48e2cba5 found every place that fixes roles, workflow or routing in code.
All of it goes or turns neutral in this work, so no old rule keeps running beside the instructions. The rule for each
item: keep it only if it is a fact (the machine, engine or model cannot do it) or access (who may read, the Swarm's own
settings, Team accounts, Buddy guards, the starts-pending cap); otherwise it goes, or its text moves to the template.

### Kept as access: the Swarm's and project's own settings

Removing `controls()` must not let any agent change the Swarm itself. These stay coordinator-or-person, as today:
`tab.rename`, `tab.pause`, `tab.project`, `project.repository`, `project.cadence`, `project.digest`, `project.report`.
The team-access check when an agent is added to a task (`commands.ts` `requireTeamWork`, today only for Reviewers) applies
to every agent added. `machine.engineResume` stays the machine owner's.

### Backend (`backend/src/superTabs/`)

Refusals that go (each would make an agent say "the server blocks it"):

- `model.ts` `requireWorkerDecisions` / `WORKER_DECISION_REQUIRED`: starts, assignments and routes are no longer held
  while a finished worker awaits keep or stop; a finished worker is an idle notice.
- `engineHealth.ts` quota at 100% → `machines.ts` `ENGINE_UNAVAILABLE`: quota is shown, not refused. Signed out and
  suspended stay.
- `store.ts` `start()` / `githubStart()` `LEAD_REQUIRED`: the agent that made a start, the coordinator or a person may
  resume it.
- `REVIEW_OPEN`, `REVIEW_PENDING`, `REVIEW_TARGET`: a task may have several linked tasks (`reviewOf`) open at once, so
  review and test run in parallel.
- `CHECKS_PENDING`, `BRIEF_REQUIRED`: checks are information; Done is the agent's statement.
- `INDEPENDENT_REVIEW` (all three), `assignable` (`REVIEWER_NOT_ASSIGNABLE`, `REVIEW_GROUP`), `REVIEWER_NOT_LEAD`,
  `ROLE_*`, `requireCustomRole`, `chosenRole`, `keepUsedRoles`.
- `OVERRIDE_REASON_REQUIRED`, `ROUTE_REQUIRED`; a route decision is optional and following another candidate needs no
  reason (it is still recorded).
- `refusal`/`ruled` codes `RULE_BROKEN`, `REQUIREMENT_UNMET`, `REVIEW_REFUSED`, `STEPPED_UP`, `BUILD_REFUSED`; `rules.ts`,
  `stepUp.ts` floors, `routingPolicy.ts`, rule commands, `tab.routingPolicy`, `project.skills` and `project.roles.*`
  (skill modes and custom role sets are replaced by the document).

Coordinator-only actions that any agent of the project may now do: `conversation.create`, `work.define`, `work.assign`,
`conversation.agent`, `agent.add`, `agent.start`, `agent.startDispatch`, `route.record`, `work.status`, `work.cancel`,
`agent.release`, `conversation.rename`/`requester`/`merged`/`archive` (`MERGE_RECORDER` goes), `person.tell`
(`TELL_FORBIDDEN`), `decision.ask` (`decisions.ts` `DECISION_FORBIDDEN`), tagging people (`mentions.ts`
`MENTION_FORBIDDEN`), `agent.avatar`, and reading or typing in another agent's terminal of the same project
(`terminal.ts` `mayDrive` `LEAD_REQUIRED`; `TERMINAL_PRIVATE` stays).

Automatic workflow the server stops doing:

- copies to the coordinator: `workerToLead`, `memberToLead`, every recorded terminal turn (`native.ts` 224-226), Ready for
  review copied to the group's Reviewers by kind (`commands.ts` 2279-2280);
- `autoReview.ts` opening and assigning reviews; `stepUp.ts` closing attempts; `tidy.ts` idle stops; the failed-review
  hand-back to Working (`commands.ts` 2386-2388, `liveness.ts` `reviewFoundProblems`); `native.ts` setting a task to
  blocked on a recording gap (the gap is a notice); reflection's approved list and nightly reminder;
- `conversation.create` now adds the agent that created the task to it, so an Engineer that opens its own review is in it.

Role-shaped bookkeeping that becomes generic:

- `leadActed` / `leadAction` (orphaned-task alerts, "PM reassigned it" lines) records the action of any agent;
- `liveness.ts` `waitingForReview` stops matching the words "ready for review": a task whose agent set the waiting status
  (today's `review` status, shown as "Waiting on others" with the agent's note) is not lost while it waits;
- `ship.ts` / leaderboard: "built by" is the task's assignee, "reviewed by" whoever passed a check on it;
- the coordinator's name (`leadStart.ts` `LEAD_NAME`, `commands.ts` 456, `startFailure.ts`) comes from a new project field,
  `coordinatorName` (default "Product Manager"), which the coordinator sets from the document; clients use it too;
- notice texts state facts only, never the next step ("Assign it to another agent now", "Route it again", "Hand this task
  over", "Fix them, then hand it over"): `liveness.ts`, `terminal.ts`, `stepUp.ts`, `commands.ts`, `store.ts`.

The Leads conversation (coordinators of the Swarm's projects) stays as a place, and `alertOverlaps` becomes a plain
notice to both coordinators without prescribing "agree an order".

### CLI (`cli/src/`)

- `superTabs/host.ts` `prompt()` (typed into every delivered message) and `SUPER_TAB_REPLY_STYLE`: all workflow text goes
  ("Leads route only when…", "Each task needs goal, changes…", skill names by role, keep/stop advice); what remains is
  how to reply, which belongs to Harness tools.
- `superTabs/start.ts` launch prompts (`leadPrompt`, worker and reviewer prompts): one neutral line, "Read your role in the
  project's instructions."
- `superTabs/command.ts` `post`: gains `--to <agent>` (repeatable) to name recipients; without it a post goes to the
  coordinator as a notice. This is required for step 1.
- `superTabs/service.ts` `taskCommand` `TASK_REQUIRED` (five-part tasks): goes; the template says what a good task has.
- `superTabs/route.ts` and `routeCommand.ts`: besides the filters listed under Routing, these go: high difficulty taking
  only the strongest (`route.ts` 469), showing only the first fit group (475-476), exhausted-window refusals
  (`routeCommand.ts` 120/560, `capacity.ts` 163, `planInput.ts` 102-107; shown as quota instead), the coordinator never
  being a candidate (220-221), the lost-task lockout (303-307), the failed-machine stall filter (46-71) and account
  avoidance (336-339, `route.ts` 471) as filters (both shown as notes), soft rules and grid-first (`softOf`), the
  on-machine-first preference beyond price, `NAMED_OFF`, `needsPush = !review`, and the `next` hint's fixed role names.
- `superTabs/start.ts` `startElsewhere`: a failed start is no longer restarted on another machine by itself; the agent
  that made it (and the coordinator, as a notice) is told, and decides.
- `superTabs/limitResume.ts` (typing "continue" when a usage limit resets) stays: it resumes the same agent's own work and
  chooses nothing (design call).
- `lib/codingModel.ts` + `superTabs/machines.ts` `fleetOn`/`refusedOn` (grid models under 7B or 10 tok/s never offered):
  shown as a note on the model, not a refusal.
- Lead-only commands and help (`screen`, `type`, `person.tell`, `decision.ask`, `--mention`, `work.cancel`, `LEAD_HELP`)
  follow the backend; help texts lose their workflow lines (`react` emoji rules, `release` "prefer stop", `leads` "agree an
  order", `startRequest` fixed names).
- `lib/swarmSkills.ts`: split into the fixed Harness tools skill (command usage, reactions mechanics, requests and Done
  mechanics, cards, threads, shared machines and secrets) and the template (every role section, rewritten: no "never
  start a reviewer for your own work", no "only you open tasks", no "never merge", no automatic-review lines, no fixed role
  names). The Buddy skill stays, and a Buddy also gets the project's document. The built-in texts stay in the CLI for a new
  CLI on an old backend.
- `lib/savedSkill.ts` `SwarmRole`, `core/agents/create.ts`, `core/agents/launches.ts`: the `lead|dev|review` enum becomes
  `coordinator | agent | buddy` plus a role name, and the install writes the two skills.
- `tools/scheduler/` (`swarm.py`, `solver.py`): floor, `independent_of` and reserve stop being constraints.

### Desktop, web and phone

- Remove: `routing_policy_form.dart`, `routing_policy.dart`, `settings/sections/routing_section.dart` and its Settings rail
  entry, the "Swarm routing" menu items (`view.dart`), `roles_editor.dart` (with its copies of the skill texts), the skill
  set picker in `project_options.dart`.
- The Instructions menu item and panel are shown to every member (today owner-only: `view.dart` 2192-2193,
  `project_options.dart` `canManage`).
- `launch_prompt.dart`: one neutral line, as the CLI's.
- Starting or adding an agent (`launch.dart`, `new_harness_form.dart` Role field, `actions.dart`): a free-text role with
  suggestions taken from the document's role headings (a client-side hint; nothing is checked). The daemon payload
  (`harness_launch_integration.dart`, `app_state.dart`, `new_harness.dart`) sends the role name instead of
  `swarmRole`/`swarmSkillMode`.
- Reviews in the UI (`controller.dart` `reviewLine`, `model.dart` `reviewers`/`isReviewer`, `review_verdict.dart`, phone
  `swarm_live_card_facts.dart`): show a task's linked tasks and their checks' results, not agents by kind or a parsed
  "Ready:" line.
- Client-side gates that go: `coding_model.dart` `codingRefusal` (shown as a note), New Project's model list from the
  routing policy (`lead_placement.dart` `LeadModelList`; the catalog instead), quota as a refusal (`machines.dart`
  `_noQuotaLeft`, `lead_placement.dart` 136-138; shown as information). `kLeadEngines` (Claude and Codex) stays: those are
  the engines Harness runs.
- Names: every "Product Manager"/"PM"/"Lead" in copy reads `coordinatorName`; role badges show the role name, shortened
  to fit; the phone's coordinator avatar keys on `isLead`, not the label `'PM'`.
- Copy that states a fixed workflow is rewritten as fact: `swarm_resource_preview.dart` ("the PM can start Builders"),
  `local_models.dart` ("the product manager can then give simple tasks"), `task_status.dart` on both platforms ("PM
  reassigned it").
- Route rows: drop "Below quality floor", "Quality floor N", "Policy order (Jev …)", "Policy notes applied"; show the
  instructions revision the route relied on.
- `work_details.dart`: shows the task as written, not five fixed sections; "Requires an independent check" goes.

### Docs

Rewritten: `docs/swarms.md` (Routing, Starting work, People/agents/machines, Buddies, Leaderboard, Cost records,
Avatars; new Messaging and Notices sections), `docs/naming-system.md` (the three-role table and "Instructions"),
`docs/feature-design-rules.md` 164 ("Reviewer (another engine)"), `docs/benchmark-priors.md` (owner override).
Marked replaced: `docs/plans/2026-10-22-swarm-rules-routing.md`, `2026-10-22-swarm-lead-dev-skills.md`,
`2026-10-19-super-tab-routing-v1.md` and its spec, `2026-10-21-swarm-routing-phase1.md`,
`2026-10-22-swarm-legacy-role-skills.md`, `2026-10-22-worker-release.md`, `2026-10-22-five-part-tasks.md`,
`2026-10-23-swarm-local-models.md`; `docs/pr-triage/roles.md` and `docs/specs/2026-10-30-buddy-read-access.md` updated.

## Desktop and phone

- An **Instructions** panel on the project replaces both the "Routing for this Swarm" form
  (`desktop/lib/super_tabs/routing_policy_form.dart`, `settings/sections/routing_section.dart`) and the custom roles editor:
  a Markdown editor, the revision history with author, date and summary, a view of any earlier revision with "restore",
  and the PM's notes below the document (view and delete).
- Agents show their role name where they show "Engineer" or "Reviewer" today.
- Phone shows the document read-only on the project screen.
- Route rows (`route_row.dart`) stop showing floors and quality numbers.

## Migration

A one-off job after the backend deploy (like `dropLegacy.ts`), idempotent and re-runnable, per project:

- a project on a built-in skill set gets a copy of the template;
- a project with a custom role set gets a document built from its role texts, one section per role under the role's name,
  plus the template's Workflow and Routing sections;
- the project's rules, policy notes and policy differences from the default become lines in the Routing section, in the
  owner's words where they exist ("Claude Haiku is off." where they do not); nothing is dropped for length within 64 KB,
  and a project that would exceed it keeps its rules' text and links the rest to an archived revision;
- every agent gets a role name: its custom role's name, else "PM", "Engineer" or "Reviewer" from its kind;
- open tasks' machine and device requirements are not written into the document; the route prints them to the
  coordinator as a note on that task until it closes.

Until the job has run for a project, it runs on the template's behavior with no hard rules. Old data (rules, policy rows,
role texts) is left in place, unread, for one release, then deleted.

## Design

- **Growth**: one document of at most 64 KB per project plus at most 50 revisions, and at most 100 notes of 300 characters
  (expired ones deleted); older revisions and the document go
  with the project.
- **Concurrency**: a save is a compare-and-set on the project's revision (refused on a stale base, with the current text);
  role names change through Swarm commands at the Swarm write level.
- **Read cost**: the state carries only revision and hash; the text is read when it changes (agents' skill refresh,
  Desktop opening the panel), never on each poll.
- **Scale**: 64 KB times projects per Swarm in the separate collection, not in the state. Messages to the coordinator drop
  by the copies of agents' posts (198 of 486 a day on the openharness Swarm); the coordinator's received-message
  rate per hour is the metric to watch (expected about 40% lower from the copies alone). A pair over 20 messages per 30 minutes is reported to the coordinator.
- **Compatibility**: an old CLI keeps installing built-in role skills and routing with its own filters and the default
  policy (the endpoint returns the default, no rules), stricter than needed but never refused; its agents still send
  role kinds, which the server maps to role names. An old Desktop shows the old forms; saves are accepted and folded into
  the document (rules) or ignored with a note to update (policy numbers). A new CLI on an old backend runs the built-in
  skills as today.
- **Migration and rollback**: additive; rolling back the backend restores old behavior from the untouched rules, policy and
  role texts; documents and notices written meanwhile are unread. The job is idempotent.
- **Audience**: every document and note read, save and delete checks the actor can read the project; only the coordinator writes
  notes; recipients must be agents of the
  sender's project; Buddies change the document only through their member's request to the coordinator.
- **Identity**: `askedBy` is the member, never the machine owner's login; a coordinator save carries the member it acted
  for.
- **Failure**: every save posts in the project chat; a stale save is refused with the current text; a line an agent could
  not follow is said where it acted; a possible loop is reported to the coordinator; a project the migration fails on is logged and retried.
- **Platforms**: server and CLI logic is the same on every host; Desktop (macOS, Windows, Linux) edits; phone reads.

## Order of work

1. Backend and CLI: direct messages between agents, no copies to the coordinator, loop notice.
   Includes `post --to` and the `native.ts` per-turn copies; the workflow text in `host.ts` `prompt()` goes with the
   template (step 3), since today's skills still rely on it.
   Ships alone and relieves the PM at once, under today's roles, together with the built-in skill texts updated to name
   recipients (the Engineer names its reviewer and, when it needs it at once, the PM). Posts that name no one go to
   the coordinator as a notice, so nothing from old CLIs is lost.
2. Backend: the document, revisions, save and read, chat notices; PM notes; role names on agents; migration job.
3. CLI: two skills per agent (Harness tools, Project instructions), refresh on change, `instructions` command; the template
   written from today's skill texts.
4. Backend and CLI: role kinds removed (auto review, review credit, tidy, keep/stop); routing enforcement removed; model
   catalog; route as advice.
5. Desktop and phone: Instructions panel replaces the routing form and the custom roles editor; role names shown.
6. Docs: `docs/swarms.md` (roles, messaging, notices, routing) rewritten; earlier plans
   (`2026-10-22-swarm-rules-routing.md`, `2026-10-22-swarm-lead-dev-skills.md`) marked replaced.

#2313 and #2314 are merged (main at d48e2cba5); this builds on them and removes what they enforce.

## Left to the builder

- Exact command, field and file names; the panel's layout within the design system; the wording of notices.
- How the template is worded, as long as it says what the template section says and stays well under 64 KB.
- The catalog's file layout and the read that serves it to the CLI; how the ranking weighs priors against measured pass
  rates.
