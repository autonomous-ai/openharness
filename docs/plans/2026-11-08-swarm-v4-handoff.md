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
- Long sessions compact. No hook: Claude Code re-reads the repo's AGENTS.md after compaction, and it says "Read
  agents/<your name>.md first"; the summary keeps "You are <name>." (decided 2026-11-08 night: less is better).
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
- Desktop: left pane is Your agents (faces and names only, one type size with projects), Projects, Humans (only once
  someone has points), Manage. A project's row opens its channel; people get "Only agents post here" in place of a
  composer, and that line holds the chat's keyboard focus so Cmd+F and the unread keys work. Tasks are threads in the
  channel: a task stands on its own row, its replies line under its bubble; its thread opens beside the channel at
  equal width, read-only, titled by its number. The Tasks button lists the tasks as cards beside the channel; a card
  opens its thread. An agent's chat has one bar (face, name, machine · engine, Instructions, Terminal), each opening
  beside the chat at equal width; its person clicks the name to rename it. Agents' @names read as tags.
- Desktop code: the Board, Board/Chat tabs, flat chat, Tasks pane, Buddy card and list, proposal form and launch flags
  field are deleted with their tests (about 9k lines). The design doc and its gallery show v4.
- Desktop fixes found by tests: a project's row opened a Buddy chat (v3 leftover); a terminal beside an agent's chat
  was mounted twice (duplicate key, the view broke).
- Start line: "You are <name>." then the person's first message, the name being the one typed in the Cmd-N form; with no
  name, the message alone. Nothing else.
- CLI delivery: a message lands as the place line, `@sender, to you:`, the text, then one `Answer: ... post ...` line.
  No Swarm preamble or reply rules.
- Backend: a project's agents talk in its channel. Any agent of the project (not a Buddy, another project's or a stopping
  one) posts there and is reached by @Name, joining it then, with no join row (the PM's join row stays). Adding one by
  hand keeps #2207.
- No compact hook: Claude Code re-reads the repo's AGENTS.md after compaction (see above).

Tests: Desktop Swarm suite 4,449 pass (`flutter test test/super_tab_* test/swarm_*`); backend `src/superTabs` 3,931 pass;
CLI host and delivery specs pass. Failures that are this machine's and also fail on main: CLI connectors, localSocket,
mcpShim; integration_test/super_tab_native_test.dart calls a method an earlier pull request removed.

Not done yet:
- Decisions, Mentions and Threads pages are still reachable from the narrow/web layout and the menu bar's notices; the
  backend still makes decisions and proposal cards. Remove them together (backend first).
- Buddy removal in CLI, backend and phone (422 files); Accept/Decline and personal tasks on the backend.
- Task numbers: a task's number is what its PM writes ("#12 ..."); nothing hands out numbers yet.
- The two-machine acceptance run needs a signed-in throwaway account on a second machine (anh Dee).
- Rename super tab to Swarm in code (anh Dee, 2026-11-08), as its own pull request at the end.
