# Names a person already chose reach the Swarm Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). One independent review on the pull request.

**Goal:** An agent a person renamed before #3015 shows that name in the Swarm after its next connect, with no second
rename. An agent nobody renamed never sends its engine session title to the Swarm (task #2920, Darren).

**Architecture:** The daemon's `name` in an agent frame is the person's rename, else the name the agent was created with,
else the engine's session title (`projectDisplayName`); nothing says which. Builds on #3015's `agent.rename`.

- CLI: the agent frame gains `nameChosen`, true only when the name is in agent-names.json (`isNameChosen`, a rename kept
  by `registry.rename`). Cloud agents send false.
- Desktop: `Agent.nameChosen` is true, false, or null when the daemon is older. `SuperTabClient.syncChosenNames` sends a
  chosen name through #3015's `renameAgent` for each loaded Swarm agent on this person's own machine whose Swarm name
  differs, once per Swarm, agent and name. `AppNotifier` runs it when a Swarm loads and when a machine's agents change.

**Tech Stack:** TypeScript (cli, vitest), Flutter (Desktop and web share this code).

**Spec:** task #2920's brief.

## Global Constraints

- Red first for each acceptance check: a renamed agent's name reaches the Swarm with no rename; an unrenamed agent's
  title never does; a daemon without the flag sends nothing.
- Swarm code stays out of `cli/src/core`: the flag is in `cli/src/lib`'s frame, which is not Swarm code.
- Desktop tests use a memory store and a fake sign-in.

## Design

- growth: N/A because one extra boolean per agent frame; nothing accumulates. The sent-once memory is per run.
- concurrency: the Swarm applies each rename in its one transaction; a repeat of the same name is a no-op.
- read cost: N/A because no read is added; it compares names already loaded.
- scale: one command per agent per run at most, only for agents whose names differ.
- compatibility: an older daemon sends no flag, Desktop sends nothing; an older Desktop ignores the flag.
- migration + rollback: N/A because nothing is stored; revert the commits.
- audience: the Swarm enforces #3015's rule (contributor or machine owner); Desktop also sends only for agents it may
  rename.
- identity: the signed-in person's own commands, never the machine owner's login.
- failure: a refusal (a role's name, a name another agent has) is not retried this run and does not change the local
  name.
- platforms: all; shared Flutter code and the daemon.

## Review Focus

- `nameChosen` is true only for a rename, never for a title or a creation name.
- Nothing is sent for an agent whose daemon sent no flag, on a shared machine, or that this person may not rename.

## Task 1: the frame says when a name was chosen

**Files:** `cli/src/lib/registry.ts`, `cli/src/lib/agentFrame.ts`, `cli/src/lib/cloudAgents.ts`, their specs.

## Task 2: Desktop sends chosen names once

**Files:** `desktop/lib/core/models.dart`, `desktop/lib/super_tabs/client.dart`, `desktop/lib/state/app_state.dart`,
`desktop/test/super_tab_chosen_names_test.dart`.
