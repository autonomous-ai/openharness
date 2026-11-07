# Every agent in My agents opens a private chat with it, Leads included (#4664) — plan

> Written by the writing-plans skill; the Engineer implements it task by task, test first, in this pull request.

**Goal:** anh Dee (21:23, 11-07): clicking a Lead in My agents opened its project chat, clicking a Member a private chat.
One rule, like iMessage: an agent is a direct message, a project is a group chat. Every row in My agents opens the
person's private chat with that agent; the project chat opens from Projects and from one quiet link in the Lead's chat
header.

**Architecture:** A Lead's private chat is the chat a Member already has: an `agent-chat` conversation whose audience is
its person, with the agent in it (`projects.ts readsAgentChat`: only that person and that agent read it, server
enforced). `agentKind.ts agentChatId` stops naming a Lead's project chat and names its private chat, or none yet. A new
person command, `agent.chat {agentId}`, opens that chat for one of the reader's own Leads, once (a second call returns the
same chat). Desktop sends it when a Lead row with no chat is clicked, then opens the chat it names. The Lead keeps leading
and posting in its project chat as today; nothing about the project chat changes.

**Tech Stack:** TypeScript backend (vitest), Flutter Desktop (widget tests).

**Spec:** docs/specs/2026-11-07-members-and-leads.md, change 2 (updated in this pull request).

## Design

- growth: one conversation per Lead a person opens it for; at most one per (person, agent), so bounded by the person's
  agents. Removing the agent leaves it empty, as a Member's chat (no new cleanup path).
- concurrency: the command runs in the Super Tab's one command transaction, as `agent.new` does; the existing chat is
  looked up first, so a repeat or a second window gets the same chat.
- read cost: `agentChatId` keeps its one lookup per agent per read; no new read.
- scale: 10x Leads is 10x of these chats, each one conversation row, far under the 100-project cap per Swarm.
- compatibility: backend first. An old client gets no `chatId` for a Lead without a private chat and falls back to the
  project chat, as today (`my_agents.dart superTabAgentChat`); with one, it opens it as a Member's. The new client against
  the old backend gets the project chat as `chatId` and opens it, as today. `agent.chat` is a new command type; nothing
  published changes.
- migration and rollback: none. Rolling back leaves the opened chats readable as Member chats.
- audience: server enforced by `readsAgentChat` (the person at their membership, and the agent while it runs on their own
  account and computer); the command refuses anyone but the agent's own person, and an agent not on their own computer.
- identity: the agent runs under its own person's login; nothing changes.
- failure: each refusal has a code and a sentence the row's click shows.
- platforms: backend; Desktop (macOS, Linux, Windows, web share the code).

## Global Constraints

- Only the person and that Lead read the new chat; no other agent posts there.
- The Lead's project posting, its project chat and every other path stay as they are.
- Copy by desktop/design/desktop-design-system.md; the header link is the existing `QuietLink`, documented there.

## Review Focus

- `agent.chat` authorization: actor is the agent's person, the agent runs on their own account and computer, leads a
  project, and is in their My agents.
- Old clients and the old backend both keep working.

## Tasks

### Task 1: agentChatId names a Lead's private chat, never its project chat

**Files:** backend/src/superTabs/agentKind.ts, backend/src/superTabs/agentKind.test.ts
**Interfaces:** `agentChatId(state, agent): string | null` (unchanged signature).

- [ ] Test: a Lead with no private chat has none; with one, it is that chat. Fails on the project-chat line.
- [ ] Code: drop the project-chat branch.

### Task 2: agent.chat opens the person's private chat with their Lead

**Files:** backend/src/superTabs/commands.ts, backend/src/superTabs/agentChat.test.ts
**Interfaces:** command `{ type: 'agent.chat', agentId }` → result `{ conversationId }`.

- [ ] Test: the person opens it; a second call returns the same chat; another person, an agent, a non-Lead and an agent on
  another computer are refused; only the person and the Lead read it; the person's post there reaches the Lead; the Lead
  posts there and still in its project chat.
- [ ] Code: the command and its schema.

### Task 3: Desktop opens a Lead's private chat, with its project chat a link away

**Files:** desktop/lib/super_tabs/my_agents.dart, project_sidebar.dart, view.dart, controller.dart,
chat/agent_chat_header.dart, desktop/design/desktop-design-system.md, desktop tests.

- [ ] Click-through test: click a Lead in My agents, see its private chat; click the header's "<project> chat", see the
  project chat. Fails first.
- [ ] Code: a Lead row with no chat sends `agent.chat` and opens what it names; the header's quiet link for a Lead.
- [ ] Design doc and its gallery test name the header link.

### Task 4: the spec says a Lead chats with its person in their private chat

**Files:** docs/specs/2026-11-07-members-and-leads.md

- [ ] Change 2's line.
