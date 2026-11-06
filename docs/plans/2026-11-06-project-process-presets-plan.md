# Project process presets implementation plan

> Implement task by task, test first, with a failing-test commit before each implementation commit and one independent pull-request review, following this project's Engineer instructions.

**Goal:** Let a project choose Simple or Full, keeping existing history and making Simple work finish without review, test, merge or release requirements.

**Architecture:** Keep the process beside the project in the existing head part; missing values mean Full. The command reducer enforces who changes it, and the board read publishes the preset's fixed columns. Task creation and automated steps use one shared process rule, including preservation of old Simple tasks after switching to Full. A single task-number watermark on the project preserves old tasks across repeated switches without loading or rewriting them.

**Tech Stack:** TypeScript, Zod, Vitest, existing MongoDB Swarm parts and version guards. No dependencies or collections.

**Spec:** Harness task #3896, conversation `e39be2ce9fc6e4dad2f0d9a7`: Simple has To do / Doing / Done; Full has Proposal / Next up / Working / Done / Merged / Shipped. Backend only; Desktop is separate. The implementation follows the brief’s asymmetric switch rule: Full→Simple simplifies existing tasks without changing open steps; Simple→Full affects only new tasks. The seed is restricted to the requesting Swarm and resolves exactly one existing project of each requested name; missing or ambiguous names refuse the entire seed. Its dry run reports the exact identities before application.

## Global Constraints

- Default Full; old commands and clients continue to work. No custom columns.
- Only the project owner and the Swarm owner (the existing top authority) change the process; agents and other members cannot.
- Never delete or rewrite open steps or task history. Simple→Full applies to new tasks only.
- Seed harness/lamp Full and scout/harness-gtm Simple only for the intended existing projects; never by an unscoped global name match.
- Own `backend/src/superTabs/`; no CLI or Desktop changes and no production writes in this task.
- Affected tests locally; backend unit and Super Tab integration suites in automatic PR CI. PM owns merge.

## Design (docs/feature-design-rules.md)

1. **Growth:** A bounded enum on each of at most 100 projects, with bounded task process metadata if needed. Created with its project/task, replaced on a setting change, retained through finish/loss/cancel/archive, deleted by the existing project/Swarm purge. Rejoining a person does not restore their ownership. No event list grows on switching.
2. **Concurrency:** Settings change the existing head version and guard the actor's membership. Task creation already advances the head's task-number counter. Ready and release creation must guard the head when their process decision depends on it; concurrent changes retry from fresh state. No all-task update.
3. **Read cost:** Read the already loaded head, at most 100 projects, and the named task. Fixed columns live only in read output, not storage. Parts readers receive the changed head; no task-history scan, added database query or index. Private project metadata stays filtered by `canReadProject`.
4. **Scale:** Constant metadata per project/task, no new fan-out. Measure reducer/read time on the same fixture before and after and report payload growth at 100 projects. Existing part latency/bytes measures reveal growth first.
5. **Compatibility:** Backend ships first. `project.create.process` is optional; the new `project.process` command is additive. Existing CLI and Desktop clients ignore new JSON fields and keep their existing board labels until the Desktop task ships. Work status values stay unchanged; no new enum reaches old clients. Parts reads expose fixed columns in the head; old full-state reads receive the same process defaults. New clients treat missing process/columns as Full and handle an old server's unsupported settings command visibly.
6. **Migration and rollback:** No mass migration or production write. An explicit seed helper will accept only unique exact names in Swarm c51479bd73b59e58176ad9e4, report their ids, and leave any owner's saved choice alone. Missing metadata remains Full. A rollback ignores new fields and resumes Full automation; existing steps and work remain readable. Seed application belongs to the authorized release, with its targets and dry-run evidence recorded before application. No production backup is available to this task; tests use legacy and dormant record fixtures.
7. **Audience:** Settings require the named person's current ownership (including membership generation) or Swarm ownership. Process metadata follows project visibility on full reads, parts and feeds. Changing a setting grants no chat access. No content, secret or private project data is added to notifications, agent prompts, logs, shares or other Swarms.
8. **Identity:** Commands use the authenticated person, never an agent's contributor or machine owner's identity. Missing identity is refused by existing author checks. No process start or subscription behavior changes.
9. **Failure:** Bad preset, unauthorized change and new forbidden steps return named command refusals. Existing operation receipts keep retries idempotent. A failed write leaves project/task data unchanged. Old steps can finish normally after a switch.
10. **Platforms:** Linux backend, locally tested on macOS; unchanged command protocol works for CLI on macOS/Linux/Windows and Desktop/web/phone. No UI or OS process code changes here.

## Review Focus

- Owner leave/rejoin and agents acting on behalf of an owner must not grant setting authority (Task 1).
- A private project's preset must not leak through board metadata (Task 1).
- Existing and dormant Simple tasks must stay Simple after a switch to Full, including repeated switches (Task 2).
- An old client sending Ready or explicitly opening a step must not reintroduce Simple review/test requirements; open Full steps survive (Task 2).
- Seeds must not overwrite an owner's choice or similarly named projects in another Swarm (Task 3).

## Task 1: Project settings and board contract

**Files:** `backend/src/superTabs/projects.ts`, `commands.ts`, `read/contract.ts`, `read/views.ts`, `model.ts`; new `process.ts` and `process.test.ts`.

**Interfaces:** `ProjectProcess = 'simple' | 'full'`; `project.create` gains optional `process`; `project.process {projectId, process}` changes the preset. `processOf(project)` supplies the Full default. `projectColumns(project)` returns fixed `{id, title}` columns. Head projects expose `process` and `columns`.

- [x] Commit command/read tests: creation default and explicit Simple; owner and Swarm owner can change; other people/agents and stale owners cannot; invalid values fail; three/six columns and private filtering.
- [x] Run `npm test -- src/superTabs/process.test.ts` and record red.
- [x] Implement the additive setting, authority and board read contract; announce the contract to the PM for Desktop coordination.
- [x] Run the new tests plus `projects.test.ts`, `read/views.test.ts` and typecheck; commit and push.

## Task 2: Task process and step lifecycle

**Files:** `process.ts`, `process.test.ts`, `model.ts`, `commands.ts`, `parts/touches.ts`, `parts/touches.test.ts`, `releases.ts`, `releases.test.ts`; `store.ts` only if its pre-read must skip Simple review work.

**Interfaces:** One `taskProcess(project, task)` rule used by every step producer; additive task metadata preserves Simple semantics when the project returns to Full. Existing `work.status done` remains the completion command, requiring no merge. Settings never mutate existing step records.

- [x] Preserve existing tasks with a task-number watermark when switching Simple→Full; follow the brief’s asymmetric rule while the optional clarification remains unanswered.
- [ ] Commit tests for Simple Ready opening no review/test steps, manual step refusal, Doing→Done without a merge, unchanged Full steps, preserved open steps, old Simple tasks after switching and reloading, and no new Simple release steps.
- [ ] Run the affected tests and record red.
- [ ] Implement the shared lifecycle rule and necessary concurrency guards.
- [ ] Run process, reviewSteps, release and touch tests; measure the changed hot path; commit and push.

## Task 3: Bounded seeds and handoff

**Files:** New `backend/src/superTabs/migration/projectProcesses.ts` and test, plus this plan.

**Interfaces:** A dry-run seed operation reads the requesting Swarm’s head by its primary key, resolves the four unique exact names, fills only absent process choices, reports the ids and changes no task or step history. Missing or duplicate names refuse all changes. An explicit apply uses the existing guarded-head write protocol; the release operator applies it only after the backend deploy and production authorization.

- [x] Commit tests that select only the four intended names within the requesting Swarm, refuse missing/ambiguous targets, set the requested presets, preserve saved choices and do nothing on a second run.
- [ ] Run and record red; implement the bounded seed helper; run and record green.
- [ ] Document authorized release application and rollback, final command/read examples, platforms, red/green and timing evidence in the PR.
- [ ] Mark the stable head Ready and record its acceptance evidence; let automatic CI and independent review finish before handing it back.

## Settings and read contract

Creation accepts `{"type":"project.create","name":"Scout","visibility":"public","process":"simple"}`; omission keeps Full. Settings accepts `{"type":"project.process","projectId":"PROJECT","process":"simple"}`. The Swarm owner can set a private project’s preset without gaining read access to it. Parts head projects and the legacy status read include `process` and `columns` (`[{id,title}]`): Simple ids `todo`, `doing`, `done`; Full ids `proposals`, `nextUp`, `working`, `done`, `merged`, `shipped`. The Desktop follow-up defaults missing fields to Full. No change to assignment status values.

Task 1 evidence: test-only commit `e890f351a`, 10 failed / 1 passed before implementation; afterward 81 passed across process, projects and read/views, with backend typecheck clean.

Task 2 initial evidence: corrected test-only commit `832dde613` has 11 failed / 17 passed in process and light projection; release regressions have 2 failed / 30 passed at `c393fb7b2`. The initial implementation passes 86 tests across process, reviewSteps, releases, touches and light, with backend typecheck clean. Repeated-switch coverage follows before the watermark implementation.
