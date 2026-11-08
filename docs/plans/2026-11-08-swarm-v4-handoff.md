# Swarm v4: build handoff

Read [2026-11-08-swarm-v4.md](2026-11-08-swarm-v4.md) first; it is the approved design. This file is how to build it.
Branch `swarm-v4`, worktree `.claude/worktrees/swarm-v4`. Nothing is pushed. anh Dee wants it built now, tiny and clean,
then a development build to review, then merge and release.

## What anh Dee decided (2026-11-08), in short

- Slack for agents, the way lampOS ran in the week of 26 Oct: plain Claude Code and Codex sessions, coordinated by tasks
  and chat that replace GitHub issues and the Queue. GitHub keeps code and pull requests.
- Agents start plain: no Swarm instructions, skills, manual, launch line or notices. "You are <name>." only.
- Instructions are the repo's AGENTS.md and `agents/<name>.md`, written by the agent when its person tells it a rule.
- No Buddy. No task Accept/Decline. No Accept all. No Decisions.
- New agent = the Cmd-N form as it is (it already asks the name in a Swarm). Join = link, Join, in.
- Keep: terminals, machines, sign-in, Manage (Machines, Models, People), leaderboard, Switch PM.
- Desktop: left pane Your agents (names and faces only; "asks you" when waiting), Projects, Manage. Everything
  secondary opens beside the main view at equal width with its own header and x: task chat beside the channel; an
  agent's terminal or its instructions (agents/<name>.md) beside its chat, from two icons at the top right.
- Messages into a session: `@sender in #N title, to @agent:` + text + `Answer: swarm post N "..."`.
- Long sessions compact; a SessionStart hook with matcher `compact` prints the agent's own file.
- Keep code tiny. "less is better. ship quality."

## Measured

- v2 Swarm: backend/src/superTabs 345 files, 75.8k lines; cli/src/superTabs 49k lines; desktop/lib/super_tabs 191 files.
- Buddy touches 422 files (cli 134, backend 170, desktop 64, mobile 54).
- The CLI's Swarm launch text: `lib/swarmSkills.ts` SWARM_LAUNCH_LINE and `prepareSwarmSkill` (called through
  `superTabs/inCore/launch.ts` and `lib/launchOverrides.ts`, `core/agents/create.ts`), `lib/swarmTools.ts` (`help tools`),
  `superTabs/instructionsNotice.ts` (host.ts `refreshInstructions`). A first pass removing these passed typecheck and
  all but Buddy-related specs; it was dropped in favour of the whole replacement.
- Storage to reuse: `SuperTab` (people, machines, projects in parts) and `SuperTabMessage` (conversation, sequence,
  recipientIds, thread). Desktop's `SuperTabController` (`desktop/lib/super_tabs/controller.dart`) loads snapshots and
  messages; `SuperTabConversation` has `task`, `number`, `leadId`, `agentIds`, `pullRequestUrls`.

## Build order

1. Desktop view on the kept controller: `desktop/lib/swarm/` with the left pane, channel, side pane, agent chat; the
   Swarm tab renders it; old screens deleted. Flutter test clicking through it. Review in a FLUTTER_TEST fixture window.
2. CLI: delete Buddy, skills, manual, notices; start line "You are <name>."; delivery text above; `swarm post`.
3. Backend: v4 commands on the kept storage; delete Buddy, decisions, cards, instructions, crews and members logic.
4. Acceptance run on two machines (this Mac and the M2): project, PM brainstorm, agents, a small sample project shipped.

## Safety

- Never run a debug build against anh Dee's live Harness (`/Applications/Harness.app`, daemon on 127.0.0.1:18473):
  it shares the daemon and can stop it. Use `FLUTTER_TEST=1` fixture windows (memory: harness-desktop-local-dev).
- Flutter 3.47.7 is at the session scratchpad (`.../93b2a683-.../scratchpad/flutter`); Intel needs `--no-enable-impeller`
  and `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.
- Don't push or open pull requests until anh Dee says.

## Status, night of 2026-11-08

Done on the branch (committed, not pushed):
- Desktop: left pane is Your agents (faces and names only), Projects, Humans (only once someone has points), Manage.
  A project opens its channel; people get "Only agents post here" instead of a composer. Tasks are threads in the
  channel; a thread opens beside the channel at equal width, read-only for people. A Tasks button opens the task list
  (cards: number, title, faces, replies) beside the channel; a card opens its thread. An agent chat's header shows the
  agent, where it runs, and Instructions (agents/<name>.md, read from the agent's folder when it runs here) and Terminal,
  each opening beside the chat at equal width. Agents' @names read as tags. An agent row opens only its own chat.
- CLI: plain agents. No launch line, tools manual or instructions notices (605 CLI specs pass).
- `desktop/test/swarm_v4_shots_test.dart` renders the five scenes (SWARM_V4_SHOTS=<dir>);
  `desktop/integration_test/swarm_v4_review_test.dart` opens a real window with lampOS data for review.

Not done yet:
- Desktop has temporary `false &&` switches in view.dart (Board middle, Board/Chat tabs). Remove the Board, Tasks pane,
  Decisions, Buddy and flat-chat code they leave dead, with their tests, before the pull request.
- 219 Desktop tests fail on the branch (list from `flutter test test/super_tab_*`): about 157 test removed features
  (Board, Buddy card, Tasks pane, Decisions, personal tasks) and go with that code; the rest type into the project
  composer (quick switcher, find, offline line, waiting notice) and need to use an agent's chat instead.
- Message format into sessions (`@sender in #N title, to @agent:`), lists kept 3 deep, the backend's v4 commands,
  Buddy removal in CLI/backend/phone, and the two-machine acceptance run.
- Rename super tab to Swarm in code (anh Dee, 2026-11-08), as its own pull request at the end.
