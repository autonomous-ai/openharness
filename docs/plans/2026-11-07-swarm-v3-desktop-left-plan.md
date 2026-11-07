# Swarm v3 Desktop: My agents on the left, chat or Board/Chat in the middle: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** The Desktop's left pane and middle follow anh Dee's Swarm v3 spec (task #4118, requested by Dee through Harness; the
spec is shared by all v3 tasks and written to `docs/specs/2026-11-07-swarm-v3.md` by #V3-backend's first PR): left is org
switching, Decisions, My agents (the person's Buddy first, then the agents on their own account, a crown right next to a PM's
name, bold for unread with no dots or counts, and + New agent), then collapsible Projects, closed unless the person has no
agents; Mentions goes. The middle is the chat with the selected agent, or the selected project's Board and Chat tabs, Board
first. The right pane (Tasks) is task #4119's.

**Architecture:** Delta to what the app shows today (`project_sidebar.dart`, `view.dart`), nothing else redesigned.
- Rows: the Mentions row leaves. Projects becomes a heading with a chevron (the Buddies group already folds this way:
  `buddiesGroupOpen`); it starts closed when the person has an agent, open when they have none.
- My agents: a heading with + New agent, then the person's Buddy first (the existing Buddy row), then each agent they brought
  (`contributorId` is the reader, a Buddy of another person excluded). A row is the agent's face and name, a crown right after
  the name of a PM (`snapshot.isLead`), the name bold while its chat has unread, no dot and no count (the existing unread rule).
- Opening an agent: its chat in the middle. A PM's is its project's chat; a Regular agent's is the task it works on now; the
  Buddy's is the Buddy chat. An agent with no chat yet opens nothing and says so on its row's tooltip.
- + New agent: a two-choice menu, Regular or PM, which hands the choice to the creation flow (`onNewAgent(kind)`), where #4116
  shapes the rest (the engine, the computer you are on).
- Middle: unchanged where it already is the spec: a project shows Board and Chat tabs, Board first (main's #3787 and #3820); an
  agent's chat fills the middle.

**Tech Stack:** Dart and Flutter widget tests with the fake Swarm of `test/support/super_tab_fixture.dart`.

**Spec:** Task #4118's brief (anh Dee 2026-11-07 00:05 VN); the Quiet Swarm sidebar (#2996); #3787's Board.

## Assumptions to confirm (no backend contract is published yet)

- An agent's role: `snapshot.isLead(agentId)` for a PM (today's rule), Regular otherwise; a v3 server's own field is read when
  it appears. Own agents are found by `contributorId == accountId` (the person the agent was brought by).
- A Regular agent has no chat of its own today: its task chat stands for it.

## Mockup (for anh Dee; his look follows after merge)

```
 +------------------------+
 | <  >                   |
 | [ Company v ]          |
 | Decisions              |   Mentions is gone
 |                        |
 | My agents          [+] |   + opens: Regular | PM
 | (B) Buddy              |   the Buddy first
 | (A) Kestrel            |   an agent: face and name
 | (A) Orion  [crown]     |   a PM: crown right after the name
 | (A) **Finch**          |   bold = unread, no dot, no count
 |                        |
 | > Projects             |   closed while you have agents
 |                        |
 | Manage                 |
 +------------------------+
```

## Global Constraints

- PR body first line: "Requested by dee through Harness." Draft early, ready as soon as tested; release window 09:00 VN.
- Owns `desktop/lib/super_tabs/` and `desktop/test/`. Right pane is #4119's; Team accounts' removal is #4120's.
- Harness design language (`scripts/check-ui-style.py`), light and dark. docs/windows-rules.md: no process, no window.
- Desktop tests use a memory store and a fake sign-in. No fixed sleeps. No login or credential is read or shown.

## Design

N/A for stored data: Desktop stores one local preference (whether Projects is open), as `buddiesGroupOpen` is kept today, and
nothing is sent. Compatibility: an older server has no role field and the same agents; the list reads what it reads today.
Audience: only the person's own agents are listed (the server's read decides what they see); identity is the person's own
account, never the machine owner's. Failure: an agent with no chat opens nothing and says why. Platforms: one Dart path for
Desktop macOS, Linux, Windows.

## Review Focus

- The left pane matches the spec: no Mentions, My agents with the Buddy first, crown beside a PM's name, bold unread with no
  dot or count, Projects collapsed by default only while the person has an agent.
- Only the person's own agents are listed; nobody else's agent, and no login or credential, is read.
- Selecting an agent shows its chat in the middle; a project still shows Board and Chat, Board first.

## Task 1: Mentions goes, Projects folds

**Files:** `desktop/lib/super_tabs/project_sidebar.dart`, `controller.dart`, tests.

- [ ] Failing tests: no Mentions row; Projects is closed when the person has an agent and open when they have none; its heading
  toggles it and the choice is kept.
- [ ] Remove the row, fold Projects. Commit.

## Task 2: My agents

**Files:** `desktop/lib/super_tabs/project_sidebar.dart`, new `desktop/lib/super_tabs/my_agents.dart`, tests.

- [ ] Failing tests: the section lists the Buddy first, then the person's own agents and no one else's; a PM has a crown right
  after its name, a Regular agent has none; a name is bold with unread and plain without, with no dot and no number; + New
  agent offers Regular and PM and hands the choice to the creation flow.
- [ ] The section and its rows. Commit.

## Task 3: the middle follows the selected agent

**Files:** `desktop/lib/super_tabs/view.dart`, `controller.dart`, tests.

- [ ] Failing tests: selecting a PM opens its project's chat in the middle; a Regular agent opens its task's chat; the Buddy its
  chat; a project still opens Board and Chat, Board first.
- [ ] Selection to chat. Commit.

## Task 4: screenshots

- [ ] Light and dark screenshots of the left pane (agents present, none, a PM with a crown, unread) and of the middle.
