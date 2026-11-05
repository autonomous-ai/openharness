# Every PM starts on Opus at xhigh unless a person picks another model — plan

> Way of working: the project's Engineer role (docs/plans plan, then test-first per task, one PR, one review).

**Goal:** A Product Manager (Lead) never ends up on its engine's own default model (e.g. Sonnet · medium, read from the
machine's or person's last-used Claude Code setting) unless a person picked that model for it. anh Dee saw "Sage · PM ·
Sonnet · medium" on 11-05.

**Architecture:** Every PM start path was traced:

| Path | Today |
| --- | --- |
| Desktop Start Lead card / New Project (`lead.start`, no model) | backend fills Opus xhigh (`withRoleDefaults`) — OK |
| Phone Start Lead / New Project / first message (`lead.start`) | same backend fill — OK |
| Personal project's first message (`lead.claim`, Desktop local start) | Desktop launches with `kLeadModel` flags — OK |
| Desktop New Harness as Lead | `leadLaunchModel` flags — OK |
| Swarm-hosted start on another machine (CLI host, `start.ts`) | launches with the backend's model/effort — OK |
| **Switch PM with Model "Default"** (`lead.switch`, Desktop and phone) | **no model → engine's own default** |
| **Keep-alive reopen / restore of a PM session** (CLI resume) | **launch flags were for the first launch only → engine's own default** |

Two fixes:
1. Backend `lead.switch`: a switch that names no model gets the coordinator's built-in default on its engine (Claude Opus
   at xhigh), exactly as `lead.start` does. A named model is kept (`leadEffort` fills its effort as today).
2. CLI: a session launched with a model and effort (`agent_create`'s launch model) records it on its registry row, and
   every relaunch of that row (resume, the Swarm's PM keep-alive, restore after restart) passes the same flags again. A
   model switch made through Harness (`agent_update` `selectedModel`) replaces the record, so a person's explicit pick
   survives the next relaunch too. A grid launch or a remembered `subscriptionModel` keeps precedence, as today.

**Tech Stack:** backend TypeScript (vitest), CLI TypeScript (vitest specs).

**Spec:** task #3395 brief (P1, anh Dee).

## Global Constraints

- Swarm code stays out of `cli/src/core`: the CLI change is a generic engine-launch fact (a session keeps the model it
  was launched with), not Swarm code. `cli/src/core/agents/create.ts` and `update.ts` only pass it through.
- `/model` is never typed into a pane (Claude Code would save it as the person's default); flags only.
- No new UI: Switch PM's "Default" now means the PM's default, which is what people read it as.

## Review Focus

- Registry rows are rebuilt from named fields on load and on every hook bind: the new field must survive both.
- No duplicate `--model` flags when a row has both a launch model and a `subscriptionModel` / grid launch.
- A person's explicit pick (switch model, runtime model switch) is never overwritten by the default.

## Task 1: backend — Switch PM with no model gets the PM default

**Files:** `backend/src/superTabs/commands.ts`, `backend/src/superTabs/leadSwitch.test.ts` (or `commands.test.ts`)

**Interfaces:** `lead.switch` → `pm.switchRequest.{model,effort}` and the moved start's `request.{model,effort}`.

- [ ] Failing test: a Claude switch naming no model records `model: 'opus', effort: 'xhigh'` on the switch request
      (same machine) and on the new start (another machine).
- [ ] Failing-safe test: a switch naming `sonnet` keeps `sonnet` (effort high), and a Codex switch with no model gets
      no Claude model.
- [ ] Code: `leadEffort(withRoleDefaults(command, BUILT_IN_ROLE_DEFAULTS.lead), name)`.

## Task 2: CLI — a session's launch model survives relaunch

**Files:** `cli/src/lib/registry.ts`, `cli/src/lib/launchOverrides.ts`, `cli/src/core/agents/create.ts`,
`cli/src/core/agents/update.ts`, their specs.

**Interfaces:** `RegisteredSession.launchModel?: LaunchModel`; `openPendingAgent({ launchModel })`;
`registry.setLaunchModel(agentId, launchModel | null)`; `LaunchSource.launchModel`.

- [ ] Failing test (registry): a row opened with a launch model keeps it across save/load and across a hook bind.
- [ ] Failing test (launchOverrides): a relaunch of a Claude row with launch model opus/xhigh carries
      `--model opus --effort xhigh`; with a grid launch or a `subscriptionModel` it carries no launch-model flags.
- [ ] Failing test (agent_update): a runtime model switch to sonnet/high records sonnet/high as the row's launch model.
- [ ] Code for each, in that order.
