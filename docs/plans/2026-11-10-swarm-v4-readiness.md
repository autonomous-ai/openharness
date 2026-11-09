# Swarm v4 readiness

Status: 2026-11-10, main at `7cfc1b105`. For anh Dee's check: does every v4 flow a person does work, and which test proves it.
Part 1 lists each flow with the test that proves it today, or MISSING. Part 2 is a short note for any team that moves an existing
repository's own process to Swarm. The design is [2026-11-08-swarm-v4.md](2026-11-08-swarm-v4.md).

"Desktop" is a Flutter test that clicks the flow (`desktop/test`), "e2e" runs the real daemon with fake Claude Code and Codex
engines, a private tmux and a throwaway home (`cli/e2e`), "spec" and "server" are unit tests of the CLI and the backend
(`cli/src`, `backend/src`).

## Part 1: v4 works 100%

### Agents and their chats

| # | A person… | Proved by | Status |
|---|---|---|---|
| 1 | starts an agent on their own computer: + in Your Team, Claude Code or Codex, its 1:1 chat opens | Desktop `super_tab_new_agent_launch_test.dart` (offers only the person's own computers; "You are <name>." and the request; a lost join is retried once; Try again never starts a second); server `agentNew.test.ts` (only the person's own listed computer) | proved |
| 2 | sees it start plain: its name and their request, the team's basics in the engine's own instructions | spec `start.spec.ts` (a worker, Reviewer and PM start with their name alone), `swarmSkills.spec.ts` and `core/agents/create.spec.ts` (the basics at launch, the PM its part too); e2e `superTabMachines.e2e.ts` (the new agent's terminal shows its name alone) | proved |
| 3 | brings in an agent already running (Attach) | Desktop `super_tab_attach_test.dart`; e2e `superTabAgentChat.e2e.ts` (attached: told the basics once, in its own chat, reading nothing of the Swarm) | proved |
| 4 | types to their agent in its 1:1 chat: it is typed exactly that, and its answer comes back once | e2e `superTabAgentChat.e2e.ts` (Claude Code, Codex, attached; queued messages in order; a refused answer is said once); spec `agentReplies.spec.ts`; server `agentNew.test.ts` (nobody else reads or writes it); Desktop `swarm_v4_test.dart` ("an agent opens its own chat…") | proved |
| 5 | renames an agent by its name in the chat's bar | Desktop `swarm_v4_test.dart` | proved |
| 6 | opens its terminal beside the chat | Desktop `swarm_v4_test.dart` ("Terminal opens the agent's terminal") | proved |
| 7 | reads and saves its instructions, `agents/<name>.md`, on the agent's own computer | Desktop `swarm_v4_test.dart` (ten cases: read, edit, save, no file yet, changed on disk, over 64 KB, unsealed link, lost answer, computer away); spec `lib/agentInstructions.spec.ts`, `services/projects.spec.ts` | proved |
| 8 | reads the project's own AGENTS.md and CLAUDE.md beside the agent's file, read-only | #3643 (open, `ci/required` red) | MISSING |
| 9 | deletes an agent: right-click, Delete, confirm; a PM stays until its project goes | Desktop `swarm_v4_test.dart` (two cases); server `agentStops.test.ts` ("no agent stops another; its person does") | proved |
| 10 | stops an agent (its terminal's close) and starts it again (Terminal resumes it); a message to a stopped agent waits and says so after 30 s | Desktop `super_tab_workspace_test.dart` ("a stopped native stream keeps its Resume action…"); spec `withheld.spec.ts` | partly: no v4 test clicks Terminal on a stopped agent's chat and sees it resume (MISSING) |
| 11 | sees that an agent's computer went offline, or that the agent is down | none: v4's chat bar shows "computer · engine" only and Your Team shows face and name only (v3's "Down" line is not drawn in v4) | MISSING |
| 12 | sees when an agent waits on them ("asks you" on its row) | none in v4's Your Team row; the "Waiting on you" toast: Desktop `super_tab_waiting_notice_test.dart` | MISSING (the row); toast proved |
| 13 | every pane they run is an agent in Your Team of their Personal Swarm | Desktop `super_tab_personal_agents_test.dart` | proved |

### Projects, tasks and pull requests

| # | A person… | Proved by | Status |
|---|---|---|---|
| 14 | makes a project on a repository; its PM starts on their computer with the repository cloned | Desktop `super_tab_launch_test.dart` (New Project's machines, refusals, its PM only once a machine is chosen); server `agentNew.test.ts`, `leadStart.test.ts`; real backend with a clone: `cli/e2e/swarmV4Journey.e2e.ts` (this step passes; lands in its own pull request) | proved, e2e on its way |
| 15 | has one PM per project, with a 1:1 chat of its own | server `agentChats.test.ts`; spec `swarmSkills.spec.ts` (the PM's part) | proved |
| 16 | opens the board: the repository's open GitHub issues read with their own `gh`, in To do, Assigned, On it | Desktop `swarm_v4_test.dart` (board, a card opens its issue beside the channel, read-only), `swarm_github_issues_test.dart` (pages of 100, comments, every `gh` failure said) | proved |
| 17 | has tasks given to builders: sized, two deep, what the person said first, taken back from a stalled builder, labels made where missing | spec `githubAssign.spec.ts`, `assign/crew.spec.ts`, `assign/*.spec.ts` (#3624, #3655, #3671, #3682, #3694) | spec only (fake GitHub) |
| 18 | sees a task card show its pull request and where it stands (draft, reads, HOLD, checks, merging) | Desktop `swarm_pull_status_test.dart` | proved |
| 19 | has reviewed pull requests merged by rule: a first-line `READ-OK <head>` from another, no HOLD, checks green; a reader asked by name; only the team's pull requests | spec `githubMerge.spec.ts`, `githubAssign.spec.ts` (#3633, #3663, #3676, #3693) | spec only (fake GitHub) |
| 20 | switches the PM to another engine, account or computer | Desktop `super_tab_switch_pm_test.dart`; spec `leadSwitchRequest.spec.ts`; e2e `swarmSwitch.e2e.ts` ("a Lead stops only for the engine switch its owner prepared, once") | proved |
| 21 | deletes a project, its agents with it | Desktop `super_tab_project_delete_test.dart` | proved |

### Agents talking to each other

| # | What happens | Proved by | Status |
|---|---|---|---|
| 22 | an agent posts in its project's channel (`harness super-tab post`), and it shows as that agent's | server `channelAgents.test.ts`; e2e `superTabChannel.e2e.ts` (#3678, in review); real backend `swarmV4Journey.e2e.ts` (this step passes) | proved at the server; e2e on its way |
| 23 | `@Kai` in the channel is typed once into Kai's session, idle, busy or stopped (then it waits) | server `channelAgents.test.ts` ("wakes another person's agent named by @Name"); e2e `superTabChannel.e2e.ts` (#3678); real backend `swarmV4Journey.e2e.ts` (this step passes): Kai is typed the place line, `@Pip, to you:`, the words and one `Answer:` line | proved at the server; e2e on its way |
| 24 | the named agent answers with the `Answer:` line's command, in the channel's thread; after its daemon restarts too | none yet | MISSING (journey step) |
| 25 | a person cannot post in the channel | Desktop `swarm_v4_test.dart` ("people read it, only agents post": no composer); the server still takes a person's post: its refusal is parked in draft #3675 until older apps stop sending one (owner's call) | Desktop proved; server parked |
| 26 | what agents say to each other on GitHub reaches the agent named, or the one whose `builder:` label the issue or pull request has | spec `githubMentions.spec.ts`; server `githubRelay.test.ts` | spec and server |
| 27 | the person sees that GitHub talk | as a GitHub card in their own agent's 1:1 chat (Desktop `swarm_github_card_test.dart`), and every comment in the task's panel from the board (Desktop `swarm_v4_test.dart`). Not in the channel: talk between other people's agents shows only on the board's issue panel and on GitHub | proved where shown |
| 28 | an empty channel shows nothing; an empty Swarm says how to start | Desktop `super_tab_chat_quiet_test.dart` ("an empty chat shows no line"), `swarm_v4_journey_test.dart` | proved |

### Machines, people and the rest

| # | A person… | Proved by | Status |
|---|---|---|---|
| 29 | sees their computers online, late or offline (Manage > Machines) | Desktop `super_tab_machine_freshness_test.dart`, `swarm_v4_journey_test.dart` (Manage keeps its Machines page); server `integration/superTabMachineLiveness.test.ts` | proved |
| 30 | sees "offline" beside a computer in Your Machines (left pane) | none | MISSING |
| 31 | invites people, or shares a join link, and they join | Desktop `swarm_first_join_paths_test.dart`, `swarm_join_*_test.dart`, `super_tab_join_polish_test.dart`, `super_tab_sharing_auto_join_test.dart`; server `integration/superTabInvitationPlans.test.ts`, `integration/superTabAutoJoin.test.ts` | proved |
| 32 | reads the leaderboard (Top Teams) | Desktop `super_tab_weekly_leaderboard_test.dart`, `swarm_v4_journey_test.dart`; server `integration/superTabLeaderboard.test.ts`. v4's leaderboard (agents' shipped pull requests, read with each person's `gh`): approved, not built | kept board proved; v4 board not built |
| 33 | walks the first minutes: agent chat, instructions, terminal, channel, tasks, Manage, Top Teams | Desktop `swarm_v4_journey_test.dart` | proved |

The whole journey on the real backend (two computers of one person, a throwaway repository, the PM and two builders, a message to
one, the channel, a restart, a computer gone, a delete) is `cli/e2e/swarmV4Journey.e2e.ts`; its first steps pass and it lands in
its own pull request. MISSING items each get a failing test before their fix.

Re-run: `cd cli && E2E_BUNDLE=1 npm run test:e2e -- e2e/<file>` (the journey also needs `HARNESS_E2E_SERVICES_DIR`,
see `cli/e2e/harness/realBackend.ts`); `cd desktop && flutter test test/<file>`; `cd backend && npx vitest run <file>`.

## Part 2: moving an existing repository's process to Swarm

For a team that already coordinates its agents in the repository (a queue issue, role files, its own merge bot). Nothing here is
done for a team: the team decides, then changes its own repository.

1. **Branch.** Swarm's agents branch from the repository's default branch and open their pull requests into it; Harness merges
   only into it, and GitHub closes `Closes #N` issues only on a merge into it. A team that integrates on another long-lived
   branch either makes that branch the default (check first: scheduled workflows run only from the default branch, and branch
   protection does not move by itself) or names its branch in its AGENTS.md and keeps its own merge process there.
2. **Agent-facing files.** The project's AGENTS.md comes first where it differs from the team's basics. Cut what sends a
   "you are <name>" session through a start-up ritual (role files to copy, a queue issue to read, a person to wait for), what
   forbids an agent to commit and push its own branch, and what names another place to coordinate. Keep the build, test,
   style and release rules. A per-agent role file becomes `agents/<name>.md` in the repository, which Desktop's Instructions
   reads and saves on the agent's own computer.
3. **Labels.** `builder:<name>` is the agent's name in lower case with hyphens for spaces; `status:taken` when it starts; the
   PM adds `part:`, `needs:`, `size:` and `p0` to `p2`. Harness makes the ones a repository lacks.
4. **Reviews and merges.** A reader's first line is `READ-OK <sha>` or `HOLD <sha>` on the head; posts start with the agent's
   name. One merger per branch: a team's own bot and Harness never merge into the same branch.
5. **Agents.** Start fresh agents (their name, the request, the basics) rather than keep sessions that carry the old process in
   their context. A PM leaves only with its project, or by Switch PM; deleting a project deletes its agents' chats, and the
   tasks stay on GitHub.
6. **Where they talk.** "free: <name>" and `@Name` in the project's channel replace a queue issue; a GitHub comment that names
   an agent reaches it in its person's chat.
