# Phone Start Lead card Implementation Plan

> This plan follows the project's own way of working (project instructions, Engineer): each plan task commits its
> failing test before its code, and the pull request's one review step is the independent review. There is no
> execution handoff; the Engineer implements it.

**Goal:** In a Personal Swarm, the phone's empty project chat with no Lead shows Desktop's Start card (#2815): pick
one of the person's computers and Claude Code or Codex (only the ones signed in there), Start Lead, then Starting…,
or "Couldn’t start a Lead: <reason>" and Start Lead again.

**Architecture:** Desktop starts a Personal project's Lead itself (`desktop/lib/super_tabs/personal_lead.dart`):
`lead.claim` (backend `leadStart.ts`), then the person's computer starts the agent in the project's repo folder (or a
new folder in its Harness projects folder) over Desktop's connection to it, then `agent.add` joins it as Lead. The
Swarm's own start (`lead.start`) can't serve a Personal project: it needs the project's repository on the server, and
a Personal project never sends one (`personal_projects.dart`). The phone has the same connection to the person's
computers (`AppNotifier.createAgent`), so it runs Desktop's three steps: it runs nothing itself, the computer does.
No backend change.

**Tech Stack:** Flutter (mobile/), widget tests with the Swarm fixture server (`test/swarm/swarm_fixture.dart`) and
a fake of the person's computers; `AppNotifier` rig tests (`test/app_state_agent_rpcs_test.dart`) for the computer
call.

**Spec:** Swarm task #2941's brief (Huy, 11-04), quoted in the pull request; Desktop's card plan
`docs/plans/2026-11-04-personal-lead-start-card-plan.md`.

## Global Constraints

- Only a Personal Swarm (named `Personal`, owned by the reader, no one else in it, Desktop's `PersonalProjects.eligible`)
  shows the card, in a project's own chat that is open, has no Lead, and the reader can write. Team Swarms unchanged;
  the server refuses `lead.claim` outside a Personal Swarm anyway (`PERSONAL_SWARM_ONLY`).
- Computers: the person's own connected computers (never shared, never a Harness Team account, never one waiting for a
  link). Engines: Claude Code, then Codex, each only when installed (or installable) and not signed out there; an
  engine list not read yet offers Claude Code, as Desktop does.
- Folder: the project's repo folder on that computer when one of its agents there works in a checkout whose remote
  makes this project's id (`personal-repo-<sha256 24>`, Desktop's `personalProjectOperation`), else a new folder in the
  Harness projects folder.
- Copy, as Desktop: "This project has no Lead yet", "Start Lead", "Starting…", "Folder: <path>", "A new folder in your
  Harness projects folder", "Couldn’t start a Lead: <reason>", "Can’t start a Lead: <reason>". The last line on the
  phone is "Or send a message below: the Lead reads it when it starts." (a phone message waits for the Lead and
  doesn't start it; told to Huy with the mockup).
- The start sends what Desktop's sends: `lead.claim {projectId, machineId}`; the computer's `agent_create` with
  `engine`, `cwd` or the generated project folder (label `Lead`, the project's name), `permissionMode: full`,
  `swarmRole: lead`, `swarmSkillMode` (the project's), Desktop's Lead launch prompt, and for Claude `model: opus`,
  `effort: xhigh`; then `agent.add {conversationId, machineId, harnessId, name: Lead, lead: true, project, configuration}`.
- Harness design language: the phone's theme tokens only (`grid.App*`), no new numeric `EdgeInsets`, `Color` or radius.
- Never install on anyone's phone; screenshots come from widget tests in light and dark.

## Review Focus

- Start Lead tapped twice, or a second tap while the claim is out: one claim, one computer start.
- The computer started the agent and `agent.add` failed: Start Lead again joins that same agent, never starts a
  second one.
- Another of the person's machines holds the claim (`leadStart: waiting`): the card shows Starting…, and the phone
  starts nothing.
- None of the person's computers is connected, or no engine is signed in on the one picked: the card says why and
  offers no Start.
- The Lead joins while the card shows (another machine started it): the card goes on the next read.
- A failed join, then another computer picked: Start again claims the kept harness's computer and joins it; the card
  shows that computer and engine and offers no other until it joins (review of #3029).

Known limits (review of #3029, Minor): the harness kept for a failed join lives in memory only, so after the app
restarts Start Lead starts a second one; Desktop resumes its journal, the phone has none. The new folder is
`ProjectFolderRequest.forTask(projectName)` where Desktop sends `generated(label: Lead, name: projectName)`: both send
the project's name as a suggested folder name the computer numbers past one that exists.

---

### Task 1: The start, as Desktop runs it

**Files:**
- Create: `mobile/lib/swarm/swarm_lead_start.dart`
- Test: `mobile/test/swarm/swarm_lead_start_test.dart`

**Interfaces:**
- Produces: `typedef SwarmLeadComputer = ({String id, String name, List<String> engines, Map<String, String> folders})`,
  `folders` keyed by normalized remote (`github.com/owner/repo`).
- Produces: `typedef SwarmLeadLaunch = ({String engine, String? folder, String projectName, String prompt, String skillMode})`.
- Produces: `typedef SwarmLeadStarted = ({String harnessId, String? cwd, String? remote})`: the harness started, and the
  folder and remote it reports (for `agent.add`'s `project`).
- Produces: `abstract interface class SwarmLeadComputers implements Listenable { List<SwarmLeadComputer> get leadComputers;
  Future<SwarmLeadStarted> startLead(String machineId, SwarmLeadLaunch launch); }`: throws a `SuperTabFailure` with the
  reason.
- Produces: `bool swarmWantsLeadStart(SwarmReader reader, String chatId)`.
- Produces: `String? swarmNormalizedRemote(String? remote)` and `String swarmPersonalProjectOperation(String repo)`
  (ports of Desktop's `normalizedRemote` and `personalProjectOperation`).
- Produces: `typedef SwarmLeadPlan = ({String machineId, String engine, String? folder})`;
  `SwarmLeadPlan swarmLeadPlan(SwarmReader reader, SwarmLeadComputers computers, String chatId, {String? machineId, String? engine})`,
  throwing `SuperTabFailure('NO_MACHINE', 'none of your computers is online')` or `('NO_ENGINE', 'Claude Code and Codex
  aren’t signed in on <name>')`.
- Produces: `class SwarmLeadStatus { starting | failed(reason) }` and `class SwarmLeadStarter extends ChangeNotifier`
  with `static SwarmLeadStarter of(SwarmReader reader)`, `SwarmLeadStatus? statusOf(String chatId)`,
  `Future<void> start(SwarmReader reader, SwarmLeadComputers computers, String chatId, {required String machineId, required String engine})`.
- Produces: `String swarmLeadLaunchPrompt({required String tabId, required String conversationId})`, Desktop's
  `superTabLaunchPrompt(lead: true)` word for word.

- [ ] **Step 1: Write the failing tests** in `swarm_lead_start_test.dart`, on the Swarm fixture server with a Personal
  Swarm (`name: Personal`, owner `me`, only `me`) and a fake `SwarmLeadComputers`:
  - `wants a Lead only in a Personal Swarm's empty project chat`: true for the project chat with no Lead; false with a
    Lead joined, in a Team Swarm (another person in it, or another name), in a task chat, for a reader who can't write.
  - `the plan is the repo's folder on the picked computer, else a new one`: folders keyed by the remote whose
    `swarmPersonalProjectOperation` is the project's id give that folder; another computer gives null.
  - `the plan says why there is nothing to start on`: no computers → `none of your computers is online`; a computer
    with no engines → `Claude Code and Codex aren’t signed in on Studio`.
  - `start claims, starts on the computer, then joins it as Lead`: commands sent in order `lead.claim`
    (`projectId`, `machineId`), then `startLead` with engine `codex`, the folder, the project's name, the prompt and
    skill mode, then `agent.add` with `harnessId` from `startLead`, `name: Lead`, `lead: true`, `project.cwd`.
  - `two taps make one claim and one start`.
  - `a claim another machine holds starts nothing here and shows starting`.
  - `a failure shows its reason, and Start again joins the agent already started`: `agent.add` refused with
    `This project already has its Lead.` → status failed with `This project already has its Lead`; a second start
    sends `lead.claim` and `agent.add` again but no second `startLead`.
- [ ] **Step 2: Run them and watch them fail:** `flutter test test/swarm/swarm_lead_start_test.dart` fails to compile
  (no `swarm_lead_start.dart`).
- [ ] **Step 3: Implement** the interfaces above. The started harness is kept per chat until its join succeeds.
- [ ] **Step 4: Run them and watch them pass** (same command).
- [ ] **Step 5: Commit** the tests, then the code.

### Task 2: The card in the empty project chat

**Files:**
- Create: `mobile/lib/swarm/swarm_lead_start_card.dart`
- Modify: `mobile/lib/swarm/swarm_conversation_page.dart` (the `No messages yet.` branch)
- Test: `mobile/test/swarm/swarm_lead_start_card_test.dart`

**Interfaces:**
- Consumes: Task 1's `swarmWantsLeadStart`, `swarmLeadPlan`, `SwarmLeadStarter`, `SwarmLeadComputers`.
- Produces: `SwarmLeadStartCard({required SwarmReader reader, required SwarmLeadComputers computers, required String chatId})`,
  keyed `swarm-lead-start`; its fields `swarm-lead-start-machine`, `swarm-lead-start-engine`, button
  `swarm-lead-start-button`, lines `swarm-lead-start-folder`, `swarm-lead-start-error`, `swarm-lead-start-unavailable`.

- [ ] **Step 1: Write the failing tests** in `swarm_lead_start_card_test.dart`, opening the conversation page on the
  fixture with `SwarmScope` computers that implement `SwarmLeadComputers`:
  - `an empty Personal project chat shows the Start card with the person's computers and signed-in engines`: card
    with `This project has no Lead yet`, machine field `Studio`, picking lists `Studio` and `Air`, engine field lists only
    the engines of the picked computer (`Claude Code` only on Air), `Folder: /Users/me/games`.
  - `Start sends Desktop's start and shows Starting…`: tap → `lead.claim` then `startLead` on the picked computer and
    engine, button reads `Starting…` and is disabled.
  - `a failed start shows its reason and Start Lead tries again`: `startLead` throws `Codex isn’t signed in` →
    `Couldn’t start a Lead: Codex isn’t signed in`; tap again → a second `startLead`.
  - `no computer online says why and offers no Start`.
  - `a Team Swarm's project chat shows no card` and `a project with a Lead shows no card`.
  - With `LEAD_CARD_SHOTS=<dir>`, light and dark screenshots of the card ready, starting and failed.
- [ ] **Step 2: Run them and watch them fail:** `flutter test test/swarm/swarm_lead_start_card_test.dart` fails
  (no `swarm-lead-start`).
- [ ] **Step 3: Implement** the card with the phone's theme tokens: a title, a full-width machine field, an engine
  field, the folder line, a full-width filled button, the error line and the message line. In the conversation page,
  show it in place of `No messages yet.` while `swarmWantsLeadStart` holds and `SwarmScope.computersOf(context)` is a
  `SwarmLeadComputers`.
- [ ] **Step 4: Run them and watch them pass,** then the files that draw the conversation page:
  `flutter test test/swarm/swarm_conversation_test.dart test/swarm/swarm_chat_agents_test.dart`.
- [ ] **Step 5: Commit** the tests, then the code.

### Task 3: The app's computers start the Lead

**Files:**
- Modify: `mobile/lib/state/app_state.dart` (`createAgent`: `swarmRole`, `swarmSkillMode`, `launchModel`)
- Modify: `mobile/lib/swarm/swarm_computers.dart` (`AppSwarmComputers implements SwarmLeadComputers`)
- Test: `mobile/test/app_state_agent_rpcs_test.dart`, `mobile/test/swarm/swarm_lead_computers_test.dart`

**Interfaces:**
- Consumes: Task 1's `SwarmLeadComputers`, `SwarmLeadComputer`, `SwarmLeadLaunch`, `swarmNormalizedRemote`.
- Produces: `AppNotifier.createAgent(..., String? swarmRole, String? swarmSkillMode, ({String model, String? effort})? launchModel)`,
  sending `swarmRole`/`swarmSkillMode` for claude and codex only, and `model`/`effort`, as Desktop's.

- [ ] **Step 1: Write the failing tests:**
  - In `app_state_agent_rpcs_test.dart`, `a Swarm Lead's create carries its role, skill mode and model`:
    `agent_create` has `swarmRole: lead`, `swarmSkillMode: default`, `model: opus`, `effort: xhigh`; a terminal's has
    none of the Swarm keys.
  - In `swarm_lead_computers_test.dart`, on the `AppNotifier` rig: `leadComputers lists the person's own connected
    computers with their signed-in engines and repo folders` (a Team account and a shared computer left out; an
    engine signed out left out; an agent's `project.remote` and `root` give `folders`), and `startLead creates the
    agent in the folder, or a generated Lead folder, and answers its id`.
- [ ] **Step 2: Run them and watch them fail:** `flutter test test/app_state_agent_rpcs_test.dart
  test/swarm/swarm_lead_computers_test.dart`.
- [ ] **Step 3: Implement.** `startLead` calls `createAgent` with `permissionMode: 'full'`, `prompt`,
  `swarmRole: 'lead'`, `swarmSkillMode`, Claude's `launchModel` `(model: 'opus', effort: 'xhigh')`, and either
  `folder` or `ProjectFolderRequest.forTask`-style generated folder named after the project; a failure string becomes
  `SuperTabFailure('CREATE_FAILED', failure)`; no agent id becomes `the computer didn’t say which harness it started`.
- [ ] **Step 4: Run them and watch them pass,** then `flutter test test/swarm/swarm_lead_start_card_test.dart`.
- [ ] **Step 5: Commit** the tests, then the code.
