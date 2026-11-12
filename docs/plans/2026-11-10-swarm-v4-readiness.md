# Swarm v4 readiness

Status: 2026-11-10, main at `7cfc1b105`. The Desktop citations checked again on 2026-11-11, main at `225e946c9`; the other
layers' citations are as of 2026-11-10. A Desktop test marked "(controller)" drives the app's model, not the screen: it
proves the logic, not the click. For anh Dee's check: does every v4 flow a person does work, and which test proves it.
Part 1 lists each flow with the test that proves it today, or MISSING. Part 2 is a short note for any team that moves an existing
repository's own process to Swarm. The design is [2026-11-08-swarm-v4.md](2026-11-08-swarm-v4.md).

"Desktop" is a Flutter test that clicks the flow (`desktop/test`), "e2e" runs the real daemon with fake Claude Code and Codex
engines, a private tmux and a throwaway home (`cli/e2e`), "spec" and "server" are unit tests of the CLI and the backend
(`cli/src`, `backend/src`).

## Part 1: v4 works 100%

### Agents and their chats

| # | A person… | Proved by | Status |
|---|---|---|---|
| 1 | starts an agent on their own computer: + in Your Team, Claude Code or Codex, its 1:1 chat opens | Desktop `swarm_v4_start_resume_test.dart` (+ in Your Team, Claude Code, a request and New agent: it starts as "You are <name>." and its row opens its chat), `swarm_v4_start_in_background_test.dart` (the form closes at once, the row says starting, then opens its chat; a failed start says so in red and reopens its form), `super_tab_v3_left_test.dart` ("the + on Your Team opens New agent"), `super_tab_new_agent_launch_test.dart` (controller: Claude Code and Codex offered, only the person's own computers, a lost join retried once, Try again never starts a second); server `agentNew.test.ts` | proved for Claude Code; Codex chosen only on the controller (MISSING: a click on Codex) |
| 2 | sees it start plain: its name and their request, the team's basics in the engine's own instructions | spec `start.spec.ts` (a worker, Reviewer and PM start with their name alone), `swarmSkills.spec.ts` and `core/agents/create.spec.ts` (the basics at launch, the PM its part too); e2e `superTabMachines.e2e.ts` (the new agent's terminal shows its name alone) | proved |
| 3 | brings in an agent already running (Attach) | Desktop `super_tab_attach_test.dart` (the picker of running agents; the one chosen joins with its own chat, which opens; a stopped session resumes as it joins), `super_tab_v3_left_test.dart` ("Attach, before the +, opens the picker of running agents"); e2e `superTabAgentChat.e2e.ts` (attached: told the basics once, in its own chat, reading nothing of the Swarm) | proved |
| 4 | types to their agent in its 1:1 chat: it is typed exactly that, and its answer comes back once | e2e `superTabAgentChat.e2e.ts` (Claude Code, Codex, attached; queued messages in order; a refused answer is said once); spec `agentReplies.spec.ts`; server `agentNew.test.ts` (nobody else reads or writes it); Desktop `swarm_v4_chat_test.dart` (the answer arrives under it; twenty sent at once arrive once each, in order; a reply sent twice shows once), `super_tab_receipt_test.dart` (Sending, Sent, Typed, then the answer) | proved |
| 5 | renames an agent by its name in the chat's bar | Desktop `swarm_v4_test.dart` ("its person renames an agent by its name in the bar") | proved |
| 6 | opens its terminal beside the chat | Desktop `swarm_v4_test.dart` ("Terminal opens the agent's terminal"), `swarm_pane_room_test.dart` (beside the chat or in its place, at 880x560, 1024x700 and 1280x800) | proved |
| 7 | reads and saves its instructions, `agents/<name>.md`, on the agent's own computer | Desktop `swarm_v4_test.dart` (read, edit, save, no file yet, changed on disk, over 64 KB, unsealed link, lost answer, computer away), `swarm_v4_instructions_test.dart` (a short file, no file yet, nearly 64 KB, each read failure with Try again); spec `lib/agentInstructions.spec.ts`, `services/projects.spec.ts` | proved |
| 8 | reads the project's own AGENTS.md and CLAUDE.md beside the agent's file, read-only | Desktop `swarm_instructions_shared_test.dart` (read only and whole, a CLAUDE.md linked to AGENTS.md named once, cut at 64 KB, a file not shown says why, an older computer shows the agent's own file alone) | proved |
| 9 | removes an agent from Your Team: right-click, Remove, confirm; shown in one of their tabs it keeps running there, else an idle session stops and a working one asks first, as closing a tab's last view; a PM stays until its project goes | Desktop `super_tab_attach_test.dart` (idle stops quietly; working asks, Cancel keeps it, Stop removes it; shown in a tab, only taken off the list; a refused stop keeps it), `swarm_v4_test.dart` ("its person removes an agent: right-click, Remove, confirm, gone"; Cancel keeps the agent, and a project's PM stays until its project goes), `swarm_v4_team_test.dart` (an agent far down among forty is removed from its row); server `agentStops.test.ts` ("no agent stops another; its person does") | proved |
| 10 | an agent stops when its session ends (its person quits it in its terminal), and Terminal starts it again (Resume); closing its terminal, or any view, never stops it; a message to a stopped agent waits, and its receipt says why two minutes on | Desktop `swarm_v4_start_resume_test.dart` ("closing an agent's terminal closes the view and leaves it running; its session ending stops it, and Terminal then offers Resume"; "a stopped agent from Your Team: its Terminal shows Resume, and Resume brings its session back"), `super_tab_receipt_test.dart` (a held message reads Sent, and two minutes on says why), `super_tab_workspace_test.dart` ("a stopped native stream keeps its Resume action…"), `swarm_engine_starting_test.dart` (controller: a stopped agent says stopped, not starting); spec `withheld.spec.ts` | proved |
| 11 | sees that an agent's computer went offline, or that the agent is down | Desktop `swarm_v4_chat_test.dart` ("writing to an agent whose computer is off"), `swarm_v4_channel_talk_test.dart` (an ask to an agent whose computer is off says so under it), `swarm_agent_info_test.dart` (Info says its computer went off), `swarm_agent_state_test.dart` (its row's grey face; controller: offline comes before on #N and free), `swarm_engine_starting_test.dart` (controller: a computer that is off says offline, not starting), `super_tab_personal_agents_test.dart` (a running pane's row says "computer · offline") | proved |
| 12 | sees when an agent waits on them ("asks you" on its row) | Desktop `swarm_v4_journey_test.dart` ("an agent that wrote to its person is what asks them, from read marks": the Swarm counts it, and reading its chat clears it), `swarm_dock_badge_test.dart` and `swarm_menu_bar_agents_test.dart` (the Dock and the menu bar count and list those agents), `swarm_needs_you_test.dart` (controller: the count); the "Waiting on you" toast: `super_tab_waiting_notice_test.dart` | partly: the counts proved; no test checks the row's bold name (MISSING) |
| 13 | every pane they run is an agent in Your Team of their Personal Swarm | Desktop `super_tab_personal_agents_test.dart`, `super_tab_personal_repo_projects_test.dart` (each repo their panes work in is a project) | proved |

### Projects, tasks and pull requests

| # | A person… | Proved by | Status |
|---|---|---|---|
| 14 | makes a project on a repository; its PM starts on their computer with the repository cloned | Desktop `super_tab_launch_test.dart` (New Project's machines, refusals, its PM only once a machine is chosen), `swarm_v4_start_in_background_test.dart` (the form closes at once and Projects shows it starting until its PM runs); server `agentNew.test.ts`, `leadStart.test.ts`; that the PM starts in the repository, cloned: only `cli/e2e/swarmV4Journey.e2e.ts` on the real backend, run by hand | Desktop proved; the clone only in the real-backend e2e |
| 15 | has one PM per project, with a 1:1 chat of its own | server `agentChats.test.ts`; spec `swarmSkills.spec.ts` (the PM's part) | proved |
| 16 | opens the board: the repository's open GitHub issues read with their own `gh`, in To do, Assigned, On it | Desktop `swarm_v4_test.dart` (Tasks is a board of the project's issues; a card opens its issue beside the channel, read-only), `swarm_v4_board_test.dart` (154 issues, the first hundred first; the three columns beside the channel; rate limits and failed reads with Try again; no open issue: three empty columns), `swarm_github_issues_test.dart` (pages of 100, comments, every `gh` failure said) | proved |
| 17 | has tasks given to builders: sized, one to build at a time and four open at most, what the person said first, taken back from a stalled builder, labels made where missing | spec `githubAssign.spec.ts`, `assign/crew.spec.ts`, `assign/*.spec.ts` (#3624, #3655, #3671, #3682, #3694) | spec only (fake GitHub) |
| 18 | sees a task card show its pull request and where it stands (draft, reads, HOLD, checks, merging) | Desktop `swarm_pull_status_test.dart`; the project's pull requests by who acts next, each opening its own chat: `swarm_v4_test.dart` ("⑂ shows the project's pull requests in three columns by who acts next") | proved |
| 19 | has reviewed pull requests merged by rule: a first-line `READ-OK <head>` from another, no HOLD, checks green; a reader asked by name; only the team's pull requests | spec `githubMerge.spec.ts`, `githubAssign.spec.ts` (#3633, #3663, #3676, #3693) | spec only (fake GitHub) |
| 20 | chooses the project's PM from their own agents in Project settings, and chooses again to switch it; nothing new is started | Desktop `super_tab_choose_pm_test.dart` (Project settings ▸ Product Manager: their agents, the PM `Current`, another project's PM not offered; Choose sends `project.pm` and opens the PM's chat; a channel with no PM offers Choose PM to its owner alone; a refusal is said); server `project.pm` (PS-B, #4077) | proved on Desktop; server with #4077 |
| 21 | deletes a project: its PM goes with it and the PM's session closes | Desktop `super_tab_project_delete_test.dart` (the project and its conversations go); server `commands.test.ts` ("lets only deleting its project take the Lead, and asks its host to close the session") | proved |

### Agents talking to each other

| # | What happens | Proved by | Status |
|---|---|---|---|
| 22 | an agent posts in its project's channel (`harness super-tab post`), and it shows as that agent's | server `channelAgents.test.ts`; e2e `superTabChannel.e2e.ts` (#3678, in review); real backend `swarmV4Journey.e2e.ts` (this step passes) | proved at the server; e2e on its way |
| 23 | `@Kai` in the channel is typed once into Kai's session, idle, busy or stopped (then it waits) | server `channelAgents.test.ts` ("wakes another person's agent named by @Name"); e2e `superTabChannel.e2e.ts` (#3678); real backend `swarmV4Journey.e2e.ts` (this step passes): Kai is typed the place line, `@Pip, to you:`, the words and one `Answer:` line | proved at the server; e2e on its way |
| 24 | the named agent answers with the `Answer:` line's command, in the channel's thread; after its daemon restarts too | none yet | MISSING (journey step) |
| 25 | a person cannot post in the channel | Desktop `swarm_v4_channel_test.dart` ("a person reads the channel and cannot post in it"), `swarm_v4_test.dart` (no composer: "people read it, only agents post"); the server refuses a person's post (`commands.ts`, `AGENTS_ONLY`), older Desktops exempt until 2026-12-11 (#3982) | proved |
| 26 | what agents say to each other on GitHub reaches the agent named, or the one whose `builder:` label the issue or pull request has | spec `githubMentions.spec.ts`; server `githubRelay.test.ts` | spec and server |
| 27 | the person sees that GitHub talk | as a GitHub card in their own agent's 1:1 chat (Desktop `swarm_github_card_test.dart`), and every comment in the task's panel from the board (Desktop `swarm_v4_test.dart`). Not in the channel: talk between other people's agents shows only on the board's issue panel and on GitHub | proved where shown |
| 28 | an empty channel says why; an empty Swarm says how to start | an empty channel: Desktop `swarm_v4_channel_talk_test.dart` ("a channel nobody has posted in says why", not while its first page is on its way, and never in an agent's chat). An empty Swarm: `swarm_v4_journey_test.dart` ("an empty Swarm says how to start"), `swarm_v4_first_test.dart` (two ways to start, and each starts) | proved |

### Machines, people and the rest

| # | A person… | Proved by | Status |
|---|---|---|---|
| 29 | sees their computers online, late or offline (Manage > Machines) | Desktop `super_tab_machine_freshness_test.dart`, `swarm_v4_journey_test.dart` (Manage keeps its Machines page); server `integration/superTabMachineLiveness.test.ts` | proved |
| 30 | sees "offline" beside a computer in Your Machines (left pane) | Desktop `super_tab_v3_left_test.dart` ("Your Machines lists this account's own computers, opens Manage, and says offline for one that is") | proved |
| 31 | invites people, or shares a join link, and they join | Desktop, in pieces: `swarm_first_join_widget_test.dart` (the join dialog, a dead link), `swarm_join_account_choice_test.dart` (joins as the signed-in account), `super_tab_join_polish_test.dart` (the dialog's words), `super_tab_sharing_auto_join_test.dart` (joining by email domain), `swarm_join_machine_test.dart` (controller); server `integration/superTabInvitationPlans.test.ts`, `integration/superTabAutoJoin.test.ts` | partly: no Desktop test sends an invite or a link and sees the person join (MISSING) |
| 32 | reads the leaderboard (Top Teams): people by how many of their agents ship | Desktop `super_tab_leaderboard_page_test.dart` (Top Teams opens it, this week and all time; a failed read keeps the board with Retry; an empty board shows nothing), `swarm_v4_journey_test.dart`; server `integration/superTabShipping.test.ts`, `superTabs/shipping/score.test.ts`; daemon `superTabs/shipping.spec.ts`, `shippingRead.spec.ts` | proved |
| 33 | walks the first minutes: agent chat, instructions, terminal, channel, tasks, Manage, Top Teams | Desktop `swarm_v4_journey_test.dart`; the smallest window: `swarm_v4_smallest_test.dart`; a narrow window's drawer: `swarm_v4_journey_test.dart` ("in a narrow window the left pane is a drawer") | proved |

The whole journey on the real backend (two computers of one person, a throwaway repository, the PM and two builders, a message to
one, the channel, a restart, a computer gone, a delete) is `cli/e2e/swarmV4Journey.e2e.ts`; its first steps pass and it lands in
its own pull request. MISSING items each get a failing test before their fix.

Re-run: `cd cli && E2E_BUNDLE=1 npm run test:e2e -- e2e/<file>` (the journey also needs `HARNESS_E2E_SERVICES_DIR`,
see `cli/e2e/harness/realBackend.ts`); `cd desktop && flutter test test/<file>`; `cd backend && npm test -- <file>` for `src`, and
`npm run test:super-tabs -- <file>` for `integration` (it starts its own MongoDB).

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
   PM adds `part:`, `needs:`, `size:` and `p0` to `p2`. Harness makes `status:taken`, `size:s|m|l`, `p0`-`p2`, each builder's
   label and the `part:` of the areas builders say they work on, where a repository lacks them; `needs:` labels the team makes.
4. **Reviews and merges.** A reader's first line is `READ-OK <sha>` or `HOLD <sha>` on the head; posts start with the agent's
   name. One merger per branch: a team's own bot and Harness never merge into the same branch.
5. **Agents.** Start fresh agents (their name, the request, the basics) rather than keep sessions that carry the old process in
   their context. A PM leaves only with its project, or when its project's owner chooses another; deleting a project takes its PM and the project's conversations,
   while builders and their chats with their people stay, and the tasks stay on GitHub.
6. **Where they talk.** "free: <name>" and `@Name` in the project's channel replace a queue issue; a GitHub comment that names
   an agent reaches it in its person's chat.
