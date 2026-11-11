# Agent card: Open terminal says why it can't open — plan

**Goal:** On an agent's card (and its Details), Open terminal either opens the agent's terminal or says plainly, in
place, why it can't. Today it closes the card and nothing happens for an agent that no open conversation holds
(thaibao56, 11-04, #2738).

**Architecture:** The card's Open terminal goes through the roster to the workspace's `_chooseAgentGroup`, which looks
for the open conversations holding the agent and returns silently when there are none. The backend opens a terminal
only in a conversation that holds the agent (`backend/src/superTabs/native.ts`, `AGENT_UNAVAILABLE`), and a dormant
conversation is not in the Swarm's snapshot, so there is nothing the Desktop can open for such an agent. One helper,
`superTabAgentTerminalGroups`, names the conversations a terminal can open in; the card, Details, the workspace and the
group picker all read it. With none, the card's and Details' Open terminal is disabled and a line under the actions
says why.

**Tech Stack:** Flutter (desktop/lib/super_tabs), widget tests with the memory-store fixtures.

**Spec:** Task #2738 brief.

This plan is carried out by the Engineer directly, test first; there is no execution handoff.

## Global Constraints

- Desktop only; no backend change. Other card buttons unchanged.
- Desktop tests use a memory store and a fake sign-in; screenshots offscreen in light and dark.

## Review Focus

- The helper matches what the backend accepts (an open, non-archived conversation holding the agent).
- No path that used to open a terminal is now disabled.

## Task 1: the card and Details say why Open terminal can't open

**Files:** `desktop/lib/super_tabs/agent_details.dart`, `desktop/lib/super_tabs/workspace.dart`,
`desktop/lib/super_tabs/agent_group_picker.dart`, `desktop/test/super_tab_roster_test.dart`.

**Interfaces:** `List<SuperTabConversation> superTabAgentTerminalGroups(SuperTabController, String agentId)`;
`String? superTabOpenTerminalBlocked(SuperTabController, SuperTabAgent)`.

- [ ] Failing widget test: Finn, in no open conversation, has a disabled Open terminal on its card and in Details,
      with the reason shown; once a conversation holds Finn, Open terminal is enabled and opens it. Light and dark
      captures of the card.
- [ ] Run it and watch it fail.
- [ ] Add the helper and use it in the card, Details, the workspace's chooser and the group picker.
- [ ] Run the roster, workspace and group-picker tests.
