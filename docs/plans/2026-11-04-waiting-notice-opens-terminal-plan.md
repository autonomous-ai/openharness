# Waiting on you opens the agent's terminal Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). One independent review on the pull request.

**Goal:** One click on a "Waiting on you" notice for a Swarm agent opens that agent's terminal beside its task chat,
focused on the prompt it waits on. The notice can be the toast, the bell's Notifications list, or Activity's
"<agent> is waiting on you" row. When no chat can hold the terminal, the Swarm view says why (task #2792, Huy,
2026-11-04).

**Architecture:** Today the toast (`AgentAlertBanners` → `AppNotifier.revealAgentFromAlert`) reveals a pane, or adds
the agent to the active tab. When that tab is a Swarm tab, `SuperTabWorkspace._syncTerminal` closes any pane that is not
one of its chat's terminals, so the click undoes itself and nothing opens.

- `revealAgentFromAlert` first looks for a Swarm agent with that machine and harness id in the loaded Swarms
  (`superTabs.loadedControllers`). When it finds one, it brings that Swarm's tab forward (`openSuperTab`) and asks the
  controller to open the agent's terminal (`SuperTabController.openAgentTerminal`, a request the view on screen takes,
  like `openNotice`). An agent no Swarm holds keeps the old path, which now opens a new tab when the current one is a
  Swarm tab.
- `SuperTabWorkspace` takes the request with #2951's rules (`superTabAgentTerminalGroups`). It picks the chat where the
  agent's work waits on the reader, else the one on screen, else the first, then opens and focuses the terminal there
  (`_focusAgent`). With no chat, it shows `superTabOpenTerminalBlocked`'s reason.
- Activity's agent row opens its task and asks for the assignee's terminal the same way.
- The bell's Notifications list falls back to `revealAgentFromAlert` for an agent that is not one of this window's
  panes, which is a Swarm agent.

**Tech Stack:** Flutter (Desktop and web share this code), widget tests on `SuperTabLaunchFixture` (memory store, fake
sign-in).

**Spec:** task #2792's brief.

## Global Constraints

- Red first for each click and for the not-allowed case.
- Reuse #2951's `superTabAgentTerminalGroups` and `superTabOpenTerminalBlocked`; no second rule for where a terminal
  can open.
- No backend change: the backend already opens a terminal only in a chat that holds the agent.
- Desktop tests use a memory store and a fake sign-in; screenshots offscreen, light and dark.

## Design

- growth: N/A because nothing is stored; the request is one field cleared when taken.
- concurrency: N/A because it is UI state on the main isolate.
- read cost: N/A because no read is added; it looks only at the loaded Swarms' snapshots.
- scale: N/A because it scans the loaded Swarms' agents once per click.
- compatibility: N/A because no wire or saved format changes.
- migration + rollback: N/A because nothing is stored; revert the commit.
- audience: the server decides which agents and chats the reader's snapshot holds, and which terminals open.
- identity: N/A because no login is used.
- failure: a chat that can't hold the terminal says why, and a terminal that fails to attach shows the workspace's
  existing error with Retry.
- platforms: macOS, Linux, Windows and web (shared Flutter code).

## Review Focus

- The Swarm agent is matched by machine id and harness id, the same pair the workspace's panes use.
- An agent no loaded Swarm holds keeps today's behaviour, and no longer adds a pane to a Swarm tab that would close it.
- Which chat is chosen when several hold the agent.

## Task 1: the toast opens a Swarm agent's terminal at its prompt

**Files:** desktop/lib/state/app_state.dart, desktop/lib/super_tabs/controller.dart,
desktop/lib/super_tabs/workspace.dart, desktop/test/super_tab_waiting_notice_test.dart

**Interfaces:** `SuperTabController.openAgentTerminal(String agentId, {String? conversationId})` and its
`agentTerminalRequest`.

- [ ] Test: a Swarm tab on another chat; a toast for Nova (waiting in its task) is clicked; the task is selected and
      Nova's terminal is the focused pane.
- [ ] Test: the toast for an agent no chat holds brings its Swarm forward and shows the reason; no pane is added.
- [ ] Run red, commit; implement; run green, commit.

## Task 2: Activity's row and the bell's list do the same

**Files:** desktop/lib/super_tabs/activity.dart, desktop/lib/super_tabs/activity_view.dart,
desktop/lib/screens/swarm_screen.dart, desktop/test/super_tab_waiting_notice_test.dart

- [ ] Test: Activity's "Nova is waiting on you" opens the task with Nova's terminal focused.
- [ ] Test: the bell's row for a Swarm agent opens its terminal there.
- [ ] Shots: the task with the terminal open, and the reason, light and dark.
- [ ] Run red, commit; implement; run green, commit.
