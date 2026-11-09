# Swarm v4: build handoff

Read [2026-11-08-swarm-v4.md](2026-11-08-swarm-v4.md) first; it is the approved design. This file is how to build it.
Branch `swarm-v4`, worktree `.claude/worktrees/swarm-v4`. Nothing is pushed. anh Dee wants it built now, tiny and clean,
then a development build to review, then merge and release.

## Status, morning of 2026-11-09 (read this first)

anh Dee's direction, 2026-11-09: **v4 is built from scratch. Wipe out every v1/v2/v3 Swarm rule and screen; keep nothing
because it existed.** Desktop work only (no web, no phone). Keep the regular tab's Cmd-N form untouched.

Shipped:
- #3585 merged, backend v1.4.42 live: plain agents, channel rules, every agent gets one 1:1 chat with its person
  (agentChats.ts, via the time checks), PM's own chat, project delete fixed.
- That release stopped people's agents: the v3 idle stop (tidy.ts idleNotices) counted no 1:1 chat as activity.
  Hotfix #3586 (branch `swarm-v4-idle-hotfix`): idle stop deleted, no agent stops another, stops withdrawn once
  (agentStops.ts). **Merge and release the backend as soon as its CI passes** (`make release-backend` from a clean
  worktree at origin/main; anh Dee said ignore the release window: add `--urgent "<reason>"`).
- CLI 0.5.75 not released yet: release after the hotfix backend (`make release-cli`). Its 13 e2e failures on the Intel Mac
  are identical on 0.5.74 (checked), so not from v4.

Desktop (branch `swarm-v4-desktop`, not merged; PR not opened yet):
- Internal build run 42546605773: Intel `Harness-macos-1.4.9-fcfb3de.dmg`, Apple Silicon
  `Harness-macos-arm64-1.4.9-fcfb3de.dmg` (links on the run page). A copy opened from the disk image steps aside for the
  running Harness: copy Harness.app out of the image first to run both.
- Removed since the last note: Decisions, Mentions and Threads pages; GitHub setup for teammates.
- + New agent in a Swarm still uses the old v3 launch (launch.dart), which waits for the new session to appear on its
  computer and parks behind "Check status" on a remote one. A small new flow is on branch `swarm-v4-new-agent`
  (new_agent.dart, WIP, its tests fail): anh Dee reviews it later.

Next (anh Dee): wipe the v1/v2/v3 Swarm code and rules (Buddy, Decisions, proposals, crews, Members/Leads, idle and stuck
sweeps, PM schedule and digests, team machines, GitHub team access), server and Desktop, keeping only what v4 uses.

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
- Backend: a PM gets a chat of its own with its person when it joins its project, which holds its first request;
  `agentChatId` prefers an agent's own chat (a PM from before keeps the project chat). Agent chats take no task number.
  Deleting a project and Buddy news skip agent chats (both threw in a Swarm without its first project).
- CLI: a line in a project's channel is answered in its thread (`--reply-to`); answered below, a second agent was
  refused, as a line is answered once.
- Desktop: after starting an agent, its person lands in their chat with it (a PM's own chat too); an agent's person
  renames it by clicking its name in the chat's bar.
- No compact hook: Claude Code re-reads the repo's AGENTS.md after compaction (see above).

Ship order: backend first. Desktop v4 against today's backend opens a PM's row on the channel, where people cannot post.

Tests: Desktop Swarm suite 4,449 pass (`flutter test test/super_tab_* test/swarm_*`) and the rest of Desktop 7,780;
backend unit suite 6,488 (`src/superTabs` 3,934); CLI Swarm specs 2,771. Failures that are this machine's and also fail on main: CLI connectors, localSocket,
mcpShim; integration_test/super_tab_native_test.dart calls a method an earlier pull request removed.

Not done yet:
- Decisions, Mentions and Threads pages are still reachable from the narrow/web layout and the menu bar's notices; the
  backend still makes decisions and proposal cards. Remove them together (backend first).
- Buddy removal in CLI, backend and phone (422 files); Accept/Decline and personal tasks on the backend.
- Task numbers: a task's number is what its PM writes ("#12 ..."); nothing hands out numbers yet.
- The two-machine acceptance run needs a signed-in throwaway account on a second machine (anh Dee).
- Rename super tab to Swarm in code (anh Dee, 2026-11-08), as its own pull request at the end.
