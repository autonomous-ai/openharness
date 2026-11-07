# Agents start with their owner's own permission settings: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** task #4215 (from anh Dee's Buddy's review of main 0413586e, Swarm v3). Every Swarm PM, agent and Buddy starts with
its owner's own Claude Code or Codex settings: Harness sends no permission mode unless the person chose one (Cmd-N, the
agent's menu, `harness new --mode`), and never writes full mode's warning acceptance into the person's settings. Anthropic
says to use `--dangerously-skip-permissions` only in isolated environments; a person's own Mac is not one.

**Findings, each verified on main 0413586e:**

1. Real. `cli/src/superTabs/start.ts:259`: `harness super-tab start` sends `permissionMode: 'full'` on every start.
2. Real, and a second site the review did not name: the machine host builds the launch with `bypassPermission: true` and
   `permissionMode: 'full'` whatever the request said (`cli/src/superTabs/start.ts:458-459`).
3. Real. `backend/src/superTabs/machines.ts:867` admits only `full`, and its refusal says "with full permissions for Swarm
   agents".
4. Real. `cli/src/core/agents/create.ts:314` writes `skipDangerousModePermissionPrompt: true` into the person's
   `~/.claude/settings.json` (or `CLAUDE_CONFIG_DIR`) for every Swarm agent in full mode (`engines/claude/launch.ts:57`).
5. Real (marked review). `harness new claude` with no `--mode` sends `permissionMode: 'auto'`: the parser defaults `mode` to
   `auto` and `newAgentPayload` sends it whenever the engine has that mode (`cli/src/lib/newCommand.ts:106,233-234`).

**Architecture:**

- Backend: `admitMachineStart` refuses any `permissionMode` on `agent.start`, in the words a CLI from before full mode already
  answers by sending the start again without it (`Refused: permissionMode (it runs with its own default account settings, so
  leave it out).`, last in the list). So CLIs from the last 30 days keep starting agents.
- CLI, the PM's side: the start request carries no `permissionMode`; the older-backend retry for that field and its warning go.
- CLI, the machine host: the launch payload has no `permissionMode` and `bypassPermission: false`, so the engine opens in the
  person's own default mode (no flag: `lib/engineLaunch.ts buildEngineLaunchArgv`). A Team-written start keeps `teamWritten`,
  its barrier against the branch's own settings, in a Team home that is no person's (no new start reaches one since #4120).
- Daemon: `acceptFullMode` and the contract behind it (`bypassAcceptance`, `recordAcceptanceIn`) are removed. A person who
  chooses full mode answers Claude Code's own warning once, as in their own terminal.
- Daemon: the Swarm folder trust (create.ts `trustSwarmFolder`, launches.ts `swarmAgent`) was keyed on full mode as a proxy
  for "the Swarm made this checkout". It is keyed on the Swarm role alone, with every other guard kept (local frame, a clone
  in the projects root or a worktree Harness made, Claude Code only). Without this, a PM in the person's own mode would sit at
  "Do you trust this folder?" again (2026-10-26, 2026-10-30).
- `harness new`: a mode is sent only when typed (`--mode`, `--plan`).

**Tech Stack:** TypeScript, vitest (cli and backend unit tests), backend integration tests.

**Spec:** the task's brief (#4215).

## Global Constraints

- Never read or print a secret or login.
- Test first: each plan task commits its failing test, then the code.
- Older CLIs (last 30 days) keep starting Swarm agents against the new backend.

## Review Focus

- An older CLI that sends `full` to the new backend: refused in the exact words it retries on, then admitted without it.
- A Swarm PM in the person's own mode in a fresh clone or worktree: still trusted, so it never sits at the trust question.
- A relayed (non-local) start, or a folder Harness did not make: still not trusted, whatever the role.
- A Team-written start: still `teamWritten`.
- `harness new` for an engine without a mode row: still no mode, as before.

## Clients (added by the PM, 2026-11-07)

Desktop's Cmd+S Swarm PM (`desktop/lib/super_tabs/launch.dart:129 forcedPermissionMode: 'full'`) and the phone's Swarm PM
(`mobile/lib/swarm/swarm_computers.dart:184`) forced full mode from the client; with the acceptance write gone, such a PM on
a machine that never accepted full mode would stop at Claude Code's warning. The PM put both in this task (Tasks 5 and 6).

---

### Task 1: the backend admits no permission mode on a Swarm start

**Files:**
- Modify: `backend/src/superTabs/machines.ts:866-871`
- Test: `backend/src/superTabs/machines.test.ts`, `backend/integration/superTabs.test.ts`, `backend/integration/superTabGithub.test.ts`

- [ ] Test: `refuses every permission mode, full included, in the words older CLIs retry without it`: for `full`, `ask`, `auto`,
  `bypass` the error is `OUTSIDE_CONTRIBUTION` and its message ends with
  `Refused: permissionMode (it runs with its own default account settings, so leave it out).`; a start without it is admitted.
  Integration requests drop `permissionMode: 'full'`; the queued request has no `permissionMode`.
- [ ] Run, see it fail; implement; run, see it pass; commit each.

### Task 2: a Swarm start sends no permission mode, and the host launches with none

**Files:**
- Modify: `cli/src/superTabs/start.ts:251-282, 458-459`
- Test: `cli/src/superTabs/start.spec.ts`

- [ ] Test: the `agent.start` request has no `permissionMode` (the heavy retry too); the host's `agent_create` payload has no
  `permissionMode` and `bypassPermission: false` for Claude and Codex, agent and Buddy; `teamWritten` unchanged. Tests of the
  removed older-backend retry are removed.
- [ ] Run, see it fail; implement; run, see it pass; commit each.

### Task 3: the daemon writes nothing into the person's settings, and still trusts a Swarm checkout

**Files:**
- Modify: `cli/src/core/agents/create.ts`, `cli/src/core/agents/launches.ts`, `cli/src/engines/launchPrep.ts`,
  `cli/src/engines/claude/launch.ts`, `cli/src/engines/facets/launch.ts`, `cli/src/engines/kit/folderTrust.ts`
- Test: `cli/src/core/agents/create.spec.ts`, `cli/src/core/agents/launches.spec.ts`, `cli/src/engines/launchPrep.spec.ts`,
  `cli/src/engines/kit/folderTrust.spec.ts`

- [ ] Test: a Swarm agent created with no mode, and one in full mode, leaves a real throwaway `CLAUDE_CONFIG_DIR/settings.json`
  untouched; a local Claude Swarm agent with no mode in a projects-root clone, a Harness worktree or a remote checkout is
  trusted; relayed, non-Swarm, a handed folder and Codex are not.
- [ ] Run, see it fail; implement (remove `acceptFullMode`, `bypassAcceptance`, `recordAcceptanceIn`; drop the mode condition
  from the two trust checks); run, see it pass; run `npm run test:core`; commit each.

### Task 4: `harness new` sends a mode only when typed

**Files:**
- Modify: `cli/src/lib/newCommand.ts:233-237`
- Test: `cli/src/lib/newCommand.spec.ts`

- [ ] Test: `harness new claude` and `harness new codex` send neither `permissionMode` nor `bypassPermission: true`;
  `--mode auto`, `--mode full`, `--plan` still send theirs.
- [ ] Run, see it fail; implement; run, see it pass; commit each.

### Task 5: Desktop starts a Swarm PM in the mode the person chose

**Files:**
- Modify: `desktop/lib/super_tabs/launch.dart`, `desktop/lib/state/harness_launch_integration.dart`,
  `desktop/lib/state/new_harness.dart`, `desktop/lib/super_tabs/personal_lead.dart`
- Test: `desktop/test/super_tab_launch_test.dart`, `desktop/test/super_tab_personal_lead_test.dart`

- [ ] Test: a new Swarm, new project and member start of Claude and Codex shows Permissions and sends the person's mode
  (`ask`, bypass off); OpenCode and Hermes members launch as their ordinary harness; the personal PM sends no mode and
  `bypassPermission: false` (Desktop's `createAgent` defaults it to true).
- [ ] Run, see it fail; remove `forcedPermissionMode`; the Permissions row is hidden only when the Swarm starts the PM on
  another machine (`leadThroughSwarm`), which cannot take a choice; run, see it pass; commit each.

### Task 6: the phone starts a Swarm PM with no mode

**Files:**
- Modify: `mobile/lib/swarm/swarm_computers.dart`
- Test: `mobile/test/swarm/swarm_lead_computers_test.dart`

- [ ] Test: `startLead` sends no `permissionMode` and `bypassPermission: false`.
- [ ] Run, see it fail; drop `permissionMode: 'full'`; run, see it pass; commit each.
