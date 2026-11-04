# Renaming a harness renames its agent in the Swarm Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). One independent review on the pull request.

**Goal:** A name a person gives an agent with Rename Harness shows in every reader's sidebar Agents list (and its
Idle group), at once, on Desktop, web and phone. A terminal title never becomes an agent's Swarm name (task #2912,
Darren, 2026-11-04).

**Architecture:** Today Rename Harness (`AppNotifier.renameAgent`) renames the harness on the Mac's daemon and nothing
else. The Swarm keeps the name the agent was added with (`agent.add`'s `name`), and `agent.add` sends the pane's
session title when the pane has no explicit name; that is the "cd /Users/…" row.

- Backend: one command, `agent.rename {agentId, name}`. Only a person who is the agent's contributor or its machine's
  owner may send it; a teammate, an agent (a Buddy included) and a Team session are refused. It sets the agent's
  `displayName`, the name every list reads (`agentNames.ts`, `SuperTabAgent.displayName` on the client).
- Desktop: after the daemon confirms a rename, `SuperTabClient.renameHarnessAgent(machineId, harnessId, name)` sends
  the command for each loaded Swarm that holds that harness. A refusal is shown on the rename dialog, which already
  shows the daemon's errors.
- Desktop: `agent.add` (`addSuperTabAgent`, the launch journal) sends the harness's explicit name, never its session
  title; an automatic name sends `Agent`, and the backend gives the agent a member name.

**Tech Stack:** TypeScript (backend, vitest), Flutter (Desktop and web share this code).

**Spec:** task #2912's brief and River's ruling in the task thread: the Swarm renames, not only the local row.

## Global Constraints

- Red first for the permission (owner yes; teammate, agent, Buddy and Team session no), the name another reader
  sees, and no terminal title on add.
- Names are words people read: cleaned like other commands' words (`WORDS`), not a role's name, not another agent's.
- Swarm code stays out of `cli/src/core`. Desktop tests use a memory store and a fake sign-in.

## Design

- growth: N/A because it replaces one existing field on an agent; nothing accumulates.
- concurrency: the Swarm's one transaction per command, as every command; two renames to one name never both pass.
- read cost: N/A because no read is added; the name rides the agents the Swarm already sends.
- scale: N/A because one command per rename by one person.
- compatibility: an older client never sends the command and keeps showing `displayName`; an older backend refuses the
  unknown command, so Desktop shows the refusal and the local rename stands.
- migration + rollback: N/A because no stored shape changes; revert the commit and names stay as last set.
- audience: the server enforces it: contributor or machine owner only, as `agent.remove` does.
- identity: the signed-in person's id, never the machine owner's login.
- failure: a refused rename says why on the rename dialog; the local name stands.
- platforms: shared Flutter code and the backend.

## Review Focus

- `agent.rename` refuses every actor but the agent's contributor or machine owner; the Buddy command allowlist
  (`buddies.ts`) does not include it.
- A name that is a role's or another agent's is refused.
- A rename in one Swarm does not touch another Swarm's agent.

## Task 1: backend `agent.rename`

**Files:** `backend/src/superTabs/commands.ts`, `backend/src/superTabs/agentNames.ts`,
`backend/src/superTabs/commands.test.ts`

- [ ] Failing tests: owner renames, a reader sees the new name; teammate, agent, Buddy refused; role and taken names
      refused; credentials cleaned.
- [ ] Add the schema, `WORDS` entry and the case.

## Task 2: Desktop sends the rename with the local rename

**Files:** `desktop/lib/super_tabs/client.dart`, `desktop/lib/state/app_state.dart`,
`desktop/test/super_tab_agent_rename_test.dart`

- [ ] Failing test: a rename of a harness in a loaded Swarm sends `agent.rename`; the sidebar row shows the new name.
- [ ] Add `renameHarnessAgent` and call it after the daemon confirms.

## Task 3: no terminal title on add

**Files:** `desktop/lib/super_tabs/actions.dart`, `desktop/lib/super_tabs/launch.dart`,
`desktop/test/super_tab_agent_rename_test.dart`

- [ ] Failing test: adding a harness with an automatic name sends `Agent`, with an explicit name sends it.
- [ ] Add one helper both use.
