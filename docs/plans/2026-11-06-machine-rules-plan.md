# The route applies the four machine rules from the project's rules: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** The four Machines rules of the project's Routing instructions run as code from the project's rules record, not
from text the PM applies by hand (task #3964, part 2 of #3576, requested by ken15 through Harness):

1. a machine is away on some weekdays between some local times: nothing starts or is handed work there then;
2. phone app work runs on a named machine first (its "at most 4 agents there" is that machine's own agent limit,
   which the Swarm already keeps: no second way);
3. no agent of a named engine runs on a named machine;
4. no Reviewer runs on a named machine.

**Builds on:** #3296 (the route's pick by the Routing order), on its branch until it merges.

**Architecture:** The record (policy.ts `ProjectRules`) gains `machines`, a list of machine rules by machine id, written by
the people who write the rest of it (rules.set, unchanged rights). Machine ids and hours are project data, never source
(River, 11-05). One pure module, `machineRules.ts`, says why a machine refuses a piece of work now
(`machineRuleRefusal`, replacing crewKeep.ts's) and which machines a lane's work goes to first (`firstMachines`). The backend
applies it where it hands out work:

- `agent.start` refuses a new agent a rule forbids (`MACHINE_RULE`, with the rule's why);
- `work.assign` refuses work a rule forbids for that agent's machine (a review step on a no-Reviewer machine, anything on an
  away machine);
- lane dispatch (dispatch.ts `candidatesFor`) skips what a rule refuses, and leaves a first-machine lane's task to a free
  member there while one takes it;
- the crew keeper's moves (crewKeep.ts) read each crew project's rules, as their comment waited for;
- the route (cli/src/superTabs/routeCommand.ts) reads the rules alone (`GET …/projects/:id/machine-rules`, new: the newest
  revision by one indexed read, never the 50-revision history), leaves out each candidate a rule refuses with its why, and
  ranks a lane's first machine first in step 1 of the order (routePick.ts). A no-Reviewer rule refuses reviews only: a Test
  step is not a review.

**Tech Stack:** TypeScript backend and CLI, vitest.

## Global Constraints

- No change to who may set the rules. Old clients keep working: a save without `machines` keeps the current ones; a record
  without them has no machine rule.
- The server enforces the rules; the route only shows them.
- Swarm code stays out of cli/src/core. Temp files only in `mktemp -d` folders.

## Design

- growth: at most 50 machine rules per project, inside the record's 16 KB, kept with its 50 revisions (policyStore.ts).
- concurrency: rules.set's revision check, as today; starts and assignments read the current revision in their transaction.
- read cost: `agent.start` and `work.assign` add one indexed read of the newest revision (as `conversation.create` does);
  dispatch reads it once per project per pass, as today; the crew sweep one per crew project, only when a member needs a
  machine; the route one indexed read of the newest revision, beside its other reads.
- scale: 10x starts is 10x one indexed row read; the warn line is the start's p95.
- compatibility: the backend ships first. An older CLI route does not read the rules and still lists a refused candidate;
  the server refuses its start with the why. An older client saving the record without `machines` keeps them. This CLI
  against an older backend gets a 404 for the rules read: it says the instructions' Machines rules still apply.
- migration + rollback: none; a record without `machines` has none. Rolled back after a save with `machines`, the older
  strict schema reads that revision as invalid (`RULES_INVALID`) until someone saves the rules again without them (its repair
  path): so nobody saves machine rules until this backend has stayed out a day. Stated in the PR.
- audience: the record is read by who reads the project today; machine ids are already in the Swarm read.
- identity: N/A because nothing runs as anyone new.
- failure: every refusal names the rule's why; a rules read that fails keeps the route's candidates and says so.
- platforms: backend; the CLI route on macOS, Linux and Windows.

## Review Focus

- A record without `machines`, and an old client's save, behave exactly as before.
- Away hours in the rule's time zone, on its weekdays only.
- No path hands out work a rule refuses: start, assign, dispatch.

## Task 1: the record holds machine rules

**Files:** backend/src/superTabs/{policy.ts, crewRules.ts, commands.ts}, policy.test.ts, commands.test.ts

- [x] Test: the record accepts each of the four kinds and refuses a bad one (time, zone, engine); a save without `machines`
  keeps the current ones; one with `[]` clears them.
- [x] Watch it fail; commit. Code; watch it pass; commit.

## Task 2: why a machine refuses work, and where a lane goes first

**Files:** backend/src/superTabs/{machineRules.ts, crewKeep.ts}, machineRules.test.ts

- [x] Test per rule: away inside and outside its window and day, in its zone; an engine refused; a review refused; a lane's
  first machines.
- [x] Watch it fail; commit. Code; watch it pass; commit.

## Task 3: starts, assignments and dispatch follow the rules

**Files:** backend/src/superTabs/{commands.ts, store.ts, dispatch.ts}, machineRules.commands.test.ts, dispatch.test.ts

- [x] Test: each rule refuses the start or assignment it names, with its why; dispatch skips it; a phone task waits for the
  phone machine's free member and goes to another only when none is free.
- [x] Watch it fail; commit. Code; watch it pass; commit.

## Task 4: the route's candidates follow the rules (CLI; the PM kept it in this task, 11-06)

**Files:** backend/src/{routes/superTabs.ts, superTabs/store.ts} (the machine-rules read), integration/superTabProjectRules.test.ts;
cli/src/superTabs/{machineRules.ts, service.ts, routeCommand.ts, routePick.ts}, routeCommand.spec.ts, serviceReads.spec.ts

- [x] Test: each rule leaves out the candidate it refuses, with its why; the lane's first machine is picked over an equal
  other; a rules read that fails leaves the candidates as before and says so.
- [x] Watch it fail; commit. Code; watch it pass; commit.
