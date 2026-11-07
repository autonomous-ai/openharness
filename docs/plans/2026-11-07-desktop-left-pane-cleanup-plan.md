# Desktop left pane cleanup: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** Task #4192 (anh Dee 2026-11-07 06:05 VN, Desktop 1.3.87): the left pane is clean and a person's My agents list is
short and recognisable. No back and forward arrows under the org switcher; My agents folds with the same chevron as Projects,
remembered; the Buddy wears the same avatar as every agent, still first; My agents lists only the person's Buddy and the agents
running on their own account, so Team-account agents and stopped or finished agents leave it.

**Architecture:** Delta to what the app shows today.
- Server (`backend/src/superTabs/agentKind.ts`, `read/views.ts`): each agent's derived summary gains `myAgent`, whether it is
  in the reader's My agents: the reader's own Buddy, or an agent they brought (`contributorId`) that runs on their own account
  (not `onTeamAccount`), is running (no `downSince`, not asleep) and is not finished or being stopped (`workDecision` neither
  `awaiting` nor `stop`). A PM leading a project stays while its session restarts: its project chat is the person's. Every
  client reads the one rule.
- Desktop (`desktop/lib/super_tabs/`): `superTabMyAgents` lists by `myAgent` when the server sends it, else today's rule
  (an older backend; the fallback can go 2026-12-07). The board layout drops the arrows (⌘[ and ⌘] stay). My agents' heading
  takes `collapsed`/`onToggleCollapsed` like Projects, saved as `agentsGroupOpen` (open by default). The board's Buddy row is a
  `SuperTabBuddyRow` (the avatar every agent row has) instead of `_drawRow`'s robot icon.

**Tech Stack:** TypeScript and Vitest (backend); Dart and Flutter widget tests with the fake Swarm of
`test/support/super_tab_fixture.dart`; screenshots by `test/super_tab_v3_left_shots_test.dart`.

**Spec:** Task #4192's brief; the Swarm v3 left pane (#4118, `2026-11-07-swarm-v3-desktop-left-plan.md`); `agentKind` (#4116).

## Mockup

```
 +------------------------+
 | [ Company v ]          |   no < > under it
 | Decisions              |
 | Leaderboard            |
 |                        |
 | v My agents        [+] |   chevron folds it, remembered
 | (B) Buddy              |   the Buddy's own avatar, first
 | (A) Kestrel            |   only running agents on your account
 | (A) Orion  [crown]     |
 |  +  New agent          |
 |                        |
 | > Projects         [+] |
 +------------------------+
```

## Global Constraints

- Owns `desktop/lib/super_tabs/`; the server read is in scope by the brief ("filter on the server read so every client
  agrees"). Ships in Desktop 1.3.88 with #4191. Harness design tokens only; docs/windows-rules.md (no process, no window).
- Backend first: `myAgent` only extends the derived summary; an older Desktop ignores it, a new Desktop on an older backend
  keeps today's list.

## Review Focus

- `myAgent` is the reader's alone (actor), and costs no extra read: one pass over the visible agents.
- The Buddy row on the board still opens its chat in the middle, and the unopened Buddy still opens it on the server.

## Task 1: the server says which agents are the reader's

**Files:** `backend/src/superTabs/agentKind.ts`, `agentKind.test.ts`, `read/views.ts`, `read/contract.ts`, `read/views.test.ts`

**Interfaces:** `inMyAgents(state, actor, target): boolean`; `Derived.agents[id].myAgent: boolean`.

- [ ] Test: own running agent yes; another person's, a Team-account one, a down one, an asleep one, an awaiting or stopping
  one no; own Buddy yes, another's Buddy no; a down PM leading a project yes; an agent reader never. Derived carries it.
- [ ] Run, see it fail; commit.
- [ ] Implement; run `agentKind.test.ts` and `read/views.test.ts`; commit.

## Task 2: Desktop lists by the server's word

**Files:** `desktop/lib/super_tabs/model.dart`, `my_agents.dart`, `desktop/test/super_tab_v3_left_test.dart`

- [ ] Test: with `myAgent` sent, an agent marked false is not listed even when the reader brought it; without it, today's rule.
- [ ] Fail; commit. Implement; run the file; commit.

## Task 3: no arrows, My agents folds, the Buddy's avatar

**Files:** `desktop/lib/super_tabs/project_sidebar.dart`, `controller.dart`, `desktop/test/super_tab_v3_left_test.dart`

- [ ] Tests: the board has no `super-back`/`super-forward` (another layout keeps them); My agents' chevron hides and shows its
  rows and `agentsGroupOpen` is saved and read back; the board's Buddy row draws a `SuperTabAvatar` and no robot icon, first.
- [ ] Fail; commit. Implement; run the file and the sidebar tests that import what changed; commit.

## Task 4: pictures

- [ ] `super_tab_v3_left_shots_test.dart` gains a folded My agents scene; run with `SUPER_TAB_V3_LEFT_SHOTS` for light and
  dark; attach to the pull request.
