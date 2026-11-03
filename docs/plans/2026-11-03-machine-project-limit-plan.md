# A machine's owner chooses which projects may use it Implementation Plan

> Way of working: this project's instructions (Engineer role): implemented by the Engineer task by task, each failing test
> committed before its code; two independent reviews on the pull request (one a security review: it changes who may run
> work where). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A contributed machine's owner can limit it to some of the Swarm's projects (default: all, as today); routing
leaves it out for any other project's work and says why, and a start, an assignment or an agent joining there for another
project is refused.

**Architecture:** The machine's contribution gets an optional `projects` list, set by a new owner-only command
`machine.projects` (or the Lead passing on the owner's own chat message, as `machine.engineResume` does). One check,
`machineProjectRefusal`, reads the list (a Mac's Harness Team account reads its Mac's) and is called from `teamWorkCheck`,
which already guards assignment, agents joining a task, the route's recorded candidates, review capacity and restores, and
from `admitMachineStart` for every start with a project (Product Managers included; a Buddy is its owner's own and is not
limited). The CLI route reads the list from the Swarm state and leaves the machine out with the same sentence. Desktop shows
"Projects that may use it" in the owner's machine details.

**Tech Stack:** TypeScript (backend Fastify/Prisma, CLI), Vitest, Flutter (Desktop).

**Spec:** Task #2390 brief (Tony, 11-03) and the mockup River posted to Tony on 11-03 (default 17:30 VN: build as shown):

```
 MacBooks-MacBook-Pro-19 (yours)              4 of 8 slots free
 Projects that may use it:  ( ) All projects   (•) Only:
                            [x] openharness  [ ] lampos  [ ] spaceship
                            [ ] computer     [ ] physical-router
```

## Global Constraints

- Default all: a machine whose owner never set the list serves every project, exactly as today.
- Only the machine's owner changes it, or the project's Lead passing on a chat message the owner wrote in the last day
  (`askedIn`, as `machine.engineResume`).
- Route reason, as the brief words it: `<machine> runs only <projects>.`
- Existing agents on the machine keep running; they take no new task for a project not on the list.
- PR body first line: "Requested by tony@autonomous.ai through Harness."
- Swarm code stays out of `cli/src/core`. Desktop tests use a memory store and a fake sign-in.

## Design

- **Growth:** at most one list per contributed machine (≤ 32 machines, each list ≤ the Swarm's projects); it goes with the
  machine. A deleted project's id is dropped from every list by `project.delete`.
- **Concurrency:** one command on the Swarm's state, under the Swarm's existing write lock, as `machine.pause`.
- **Read cost:** nothing new is read: the list rides in the machine record every read already has.
- **Scale:** 10x projects is a longer list on a 32-machine cap; the check is a list lookup per candidate.
- **Compatibility:** older CLIs don't leave the machine out of their route; the backend still refuses the pick
  (`route.record` → "Route again") and every start or assignment. Older Desktops don't show the setting; the list stays.
- **Migration + rollback:** none: absent means all. Rolling back ignores the field (all projects again).
- **Audience:** the server enforces it on every start, assignment and join; the CLI and Desktop only display it. A reader
  sees only the ids of projects they may read; the route sentence names only public projects and counts the rest
  ("and 1 other project"), so a private project's name never reaches another project's readers.
- **Identity:** the owner is the machine's contributor (`pool.contributorId`), never the machine account's login.
- **Failure:** a refused start or assignment says why (`MACHINE_PROJECTS`, 403); a machine whose list names only deleted
  projects serves none and says so.
- **Platforms:** backend, CLI route, Desktop (macOS/Windows/Linux same widget).

## Review Focus

- A Mac's Harness Team account (a separate pool with `hostMachineId`) must follow its Mac's list, both ways.
- Saving the machine's settings again (`machine.contribute` re-sent by Desktop) must keep the list.
- A teammate (not the owner), a Lead without the owner's message, or a Lead quoting someone else's message cannot change it.
- A project Lead's own start (Product Manager) on a limited machine is refused for another project.
- A private project's name must not appear in another project's route reason.

---

### Task 1: The list and its command (backend)

**Files:**
- Modify: `backend/src/superTabs/machines.ts` (`ContributedMachine.projects?: string[]`, `machineProjectRefusal`)
- Modify: `backend/src/superTabs/commands.ts` (schema + `machine.projects` case; keep on `machine.contribute`; drop ids on
  `project.delete`; askedIn read check)
- Modify: `backend/src/superTabs/model.ts` (`visibleState`: only readable project ids)
- Test: `backend/src/superTabs/machineProjects.test.ts` (unit, on the commands fixture used by `teamRouting.test.ts`)

**Interfaces:**
- Produces: command `{ type: 'machine.projects', machineId, projectIds: string[] | null, askedIn? }` (`null`: all);
  `machineProjectRefusal(state, machineId, project): TeamWorkRefusal | null` with code `MACHINE_PROJECTS`.

- [ ] Failing tests: `the owner limits their machine to some projects, and all again`; `a teammate, a Lead without the
  owner's message, and a Lead quoting another person are refused`; `the Lead passing on the owner's message sets it`;
  `saving the machine again keeps the list`; `a deleted project leaves every list`; `a reader sees only project ids they
  may read`; `unknown or unreadable project ids are refused`.
- [ ] Run red: `cd backend && npm test -- src/superTabs/machineProjects.test.ts`. Commit.
- [ ] Implement; run green; commit.

### Task 2: Enforcement (backend)

**Files:**
- Modify: `backend/src/superTabs/machines.ts` (`teamWorkCheck` first asks `machineProjectRefusal`; `admitMachineStart`
  refuses a start with a project, Product Managers included, Buddies not)
- Test: `backend/src/superTabs/machineProjects.test.ts`; `backend/integration/superTabTeam.test.ts` (one end-to-end case)

- [ ] Failing tests: `a machine limited to openharness refuses a start for lampos, and takes openharness's`; `refuses a
  Product Manager start for another project`; `refuses assigning another project's task to an agent there, and an agent
  there joining it`; `route.record leaves it out with "runs only openharness" and refuses it as the pick`; `a Mac's Team
  account follows its Mac's list`; `a private project is counted, not named, in the reason`; `with no list, every project
  as before`; integration: `Tony's machine, set to openharness only, gets no agent for another project's task`.
- [ ] Run red (unit + `npm run test:super-tabs -- integration/superTabTeam.test.ts`). Commit.
- [ ] Implement; run green; commit.

### Task 3: The route leaves it out (CLI)

**Files:**
- Modify: `cli/src/superTabs/routeCommand.ts` (pool shaping: `projectRefused` from `state.machines[].projects`; new and
  member reasons)
- Test: `cli/src/superTabs/routeCommand.spec.ts`

- [ ] Failing test: `leaves a machine limited to other projects out, new agents and members alike, saying why`, and the
  same machine is offered for a project on its list.
- [ ] Run red: `cd cli && npx vitest run src/superTabs/routeCommand.spec.ts`. Commit. Implement; green; commit.

### Task 4: Manage > Machines (Desktop)

**Files:**
- Modify: `desktop/lib/super_tabs/machines.dart` (owner's machine details: "Projects that may use it" — All projects /
  Only: one checkbox per project; sends `machine.projects`; a teammate sees the line read-only)
- Test: `desktop/test/super_tab_machine_projects_test.dart` (widget test + golden screenshot)

- [ ] Failing widget test: the owner picks Only, ticks openharness, and the command carries `['<openharness id>']`; All sends
  `null`; a teammate sees no controls. Commit red.
- [ ] Implement as the mockup; green; screenshot into the PR; `python3 scripts/check-ui-style.py --only desktop/lib/super_tabs`.

### Task 5: Before Ready

- [ ] Backend unit (`npm test`), full Super Tab integration suite (`npm run test:super-tabs`), typecheck; CLI route specs and
  typecheck; Desktop widget tests touching machines.
- [ ] Red/green PR comment; Ready; two Reviewers by Routing (one security).
