# Buddy model switch Implementation Plan

> **For agentic workers:** This plan is carried out by the task's Engineer by the project's instructions (Engineer role):
> task by task, each failing test committed before its code, one pull request, one independent review step at the end.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person switches their Buddy between their own Claude subscription and a model shared in the Swarm, and
back, keeping the Buddy chat and its conversation (or a fresh session when the conversation is too long).

**Architecture:** The person asks the server (`buddy.model`); the server checks the model against the Swarm's served
models and records a request on the Buddy's agent; the Buddy's host carries it out through its own daemon's existing
`agent_retarget` (respawn in place with `--resume`), measuring the conversation first and starting fresh when it does
not fit; the host reports `buddy.modelResult`, which sets `Agent.gridModel` and writes the line in the Buddy chat.

**Tech Stack:** TypeScript backend (vitest), TypeScript CLI/daemon (node:test specs), Flutter Desktop (flutter_test).

**Spec:** [docs/plans/2026-11-03-buddy-model-switch-design.md](2026-11-03-buddy-model-switch-design.md)

## Global Constraints

- PR body first line: "Requested by scholes@autonomous.ai through Harness."
- The Buddy guard and Buddy privacy rules stay as they are (docs/swarms.md, Buddies); two security reviews.
- Swarm code stays out of `cli/src/core`; the core change is generic (`fresh` and the remembered session on any pane).
- Never run a test that signs the Mac out of the real CLI; Desktop tests use a memory store and a fake sign-in.
- Before Ready: a failing-then-passing test for every risk below, red/green evidence in a PR comment, the full Super Tab
  integration suite (`npm run test:integration` per docs/validation-and-release.md) for the backend change.
- Copy, exact: `Your subscription`, `SHARED IN THIS SWARM`, `served by <machine>[, <machine>…]`, `<person>'s saved API`,
  `Switching to <model>…`, `not served now`,
  `Your Buddy now runs on <model>, served by <servers>.`,
  `Your Buddy started a fresh session on <model>: this conversation is too long for it (<window>K). Switch back to your subscription to continue the earlier one.`,
  `Your Buddy is back on your subscription.`,
  `Couldn't switch your Buddy: <reason>. It is still on <current>.`,
  `Your Buddy's computer didn't answer.`
- Fresh-session threshold: context tokens ≥ 80% of the target's context window. Unknown size or window: resume.
- Request lease: 10 minutes (`BUDDY_MODEL_LEASE_MS = 10 * 60_000`).
- Host capability name: `buddyModel`.
- Platforms: picker on Desktop (macOS/Linux/Windows), web, phone; switch on macOS and Linux hosts.

## Review Focus

1. A Buddy relaunched onto a grid model keeps every Buddy launch flag and gets no MCP server (the grid's web MCP) — the
   guard must hold on the grid. Test in Task 2.
2. The way home after a fresh move resumes the earlier session, not the grid one, and the registry rebinds the agent to
   it rather than minting a new agent. Test in Task 3.
3. A switch asked while the Buddy is mid-turn is refused with the reason, and the Buddy keeps running on its model.
   Test in Task 5.
4. A model that is served when picked but gone when the host carries it out is refused, not half-applied. Test in Task 5.
5. Someone other than the Buddy's owner (another member, the Swarm owner, the Buddy itself) cannot switch it, and a
   result for a stale request id is refused. Test in Task 1.

---

### Task 1: Backend — `buddy.model`, the request, the result and its lines

**Files:**
- Modify: `backend/src/superTabs/model.ts` (Agent: `modelRequest?`)
- Modify: `backend/src/superTabs/commands.ts` (schemas, handlers, `BUDDY_MODEL_CAPABILITY`)
- Modify: `backend/src/superTabs/buddies.ts` (`BUDDY_COMMANDS` gets `buddy.modelResult`; line texts)
- Modify: `backend/src/superTabs/tidy.ts` (expire a request past its lease)
- Modify: `backend/src/superTabs/closedAgents.ts` (strip `modelRequest`)
- Test: `backend/src/superTabs/buddyModel.test.ts`

**Interfaces:**
- Produces: command `{ type: 'buddy.model', gridModel: string | null }` (null = the subscription); the grid is always the
  Swarm's (`state.localModels.grid`).
- Produces: `Agent.modelRequest?: { id: string; gridModel: string | null; requestedBy: string; at: string }`.
- Produces: command `{ type: 'buddy.modelResult', agentId: string, requestId: string, ok: boolean, fresh?: boolean,
  contextWindow?: number, error?: string }` (error ≤ 300 chars, control characters removed).
- Produces: `Agent.gridModel` set on an ok result to a grid model, deleted on an ok result home.

- [ ] **Step 1: Write the failing tests** in `buddyModel.test.ts` (state built as `buddies.test.ts` builds a running
  Swarm Buddy on its owner's machine, the machine reporting `capabilities: [..., 'buddyModel']` and serving
  `deepseek-4.1-flash` on the Swarm grid from another member's machine):
  - `buddy.model` by the owner records `modelRequest { gridModel: 'deepseek-4.1-flash', requestedBy: owner }`.
  - refused `BUDDY_MODEL_UNAVAILABLE` for a model no fresh reading serves on the Swarm grid, for a `kind: shared` model of
    another grid, and when `localModels` is off.
  - refused `BUDDY_OWNER` for another member and for the Swarm's owner; refused `BUDDY_FORBIDDEN` when sent by the Buddy
    agent itself.
  - refused `BUDDY_SWITCHING` while a request is pending; `HOST_OUTDATED` when the machine lacks `buddyModel`;
    `BUDDY_MODEL_MACHINE` when the Buddy runs on a Buddy-only machine; `MACHINE_OFFLINE` when its reading is stale;
    `NO_BUDDY` with no running Buddy.
  - `buddy.modelResult` from the Buddy agent with the pending id and `ok` sets `gridModel`, clears `modelRequest`, and
    writes `Your Buddy now runs on DeepSeek 4.1 Flash, served by Ken's Mac Studio.` in the owner's Buddy chat only;
    with `fresh: true, contextWindow: 131072` writes the fresh-session line with `(128K)`; home with ok deletes
    `gridModel` and writes `Your Buddy is back on your subscription.`; `ok: false` writes the Couldn't-switch line and
    leaves `gridModel` as it was.
  - `buddy.modelResult` with another id → `STALE_SWITCH`; from another agent → `BUDDY_FORBIDDEN`/403.
  - tidy at `at + 10 min` clears the request and writes `Couldn't switch your Buddy: Your Buddy's computer didn't answer. It is still on your subscription.`
- [ ] **Step 2: Run to see them fail**
  Run: `cd backend && npm test -- src/superTabs/buddyModel.test.ts`
  Expected: FAIL (unknown command type `buddy.model`).
- [ ] **Step 3: Implement** the schemas next to `buddy.rename`; the handler checks, in order: person actor, the main
  Swarm Buddy of the actor (`mainBuddyOf`), its machine listed and not `buddyOnly`, fresh, capability, no pending
  request, and for a non-null model `servedLocalModels(state, now).some(l => l.model === gridModel)`. The result handler
  mirrors `agent.switchResult`. Server names: the machines serving the model now (`servedLocalModels`), each by its
  name; an `api` reading by `<person>'s saved API`.
- [ ] **Step 4: Run to see them pass** — same command, Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Swarm: a person asks to switch their Buddy's model; the server checks it and records the outcome (#2354)"`

### Task 2: CLI — a Buddy's grid launch carries no MCP server

**Files:**
- Modify: `cli/src/lib/launchOverrides.ts` (where the grid launch is built for a source)
- Test: `cli/src/lib/launchOverrides.spec.ts`

**Interfaces:**
- Consumes: `LaunchSource.swarmSkill.role === 'buddy'`, `GridLaunchOverride.mcpUrl`.

- [ ] **Step 1: Failing test** `a Buddy moved onto a grid gets no web MCP and keeps its Buddy launch`: build overrides
  for a Buddy source with a grid override carrying `mcpUrl`; assert `extraArgs` has no `--mcp-config` and no allow-web
  argument, `env` has no grid web key variable, and the Buddy's own args (permission mode, settings) are present as in
  the same source without a grid. A non-Buddy source with the same grid still gets `--mcp-config`.
- [ ] **Step 2: Run** `cd cli && node --test --import tsx src/lib/launchOverrides.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**: for a Buddy source the grid override is used without `mcpUrl`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `fix(cli): a Buddy on a grid model starts no MCP server, as on its own login (#2354)`

### Task 3: Daemon — `agent_retarget` can start fresh, and the way home reopens the session it left

**Files:**
- Modify: `cli/src/backendSocket.ts` (`agent_retarget`: `fresh: true` accepted with a grid target only)
- Modify: `cli/src/core/agents/retarget.ts` (`retargetAgent({ agentId, grid, fresh })`)
- Modify: `cli/src/lib/registry.ts` (`subscriptionSessionId`, `setSubscriptionSession(agentId, id | null)`)
- Test: `cli/src/core/agents/retarget.spec.ts`, `cli/src/backendSocket.spec.ts`

**Interfaces:**
- Produces: frame `agent_retarget { agentId, gridModel, gridName, fresh?: true }`; `fresh` with `clearGrid` →
  `INVALID_GRID`.
- Produces: `RegisteredSession.subscriptionSessionId?: string`.

- [ ] **Step 1: Failing tests** (retarget.spec.ts, with its existing fake pane/restart deps):
  - `a fresh move onto a grid relaunches without --resume and keeps the session it left`: `restartAgent` receives an
    empty session id; after success `registry.setSubscriptionSession(agentId, 'S1')`.
  - `the move home reopens the session a fresh move left`: a row on a grid with `subscriptionSessionId: 'S1'` and
    `sessionId: 'S2'`; clearGrid relaunches with `--resume S1`; after success the remembered session is cleared.
  - `a grid-to-grid move keeps the remembered session`; `a refused move leaves it unchanged`.
  - backendSocket.spec: `fresh` with `clearGrid` → `INVALID_GRID`; `fresh` is passed through to `onRetargetAgent`.
- [ ] **Step 2: Run** `cd cli && node --test --import tsx src/core/agents/retarget.spec.ts src/backendSocket.spec.ts` — FAIL.
- [ ] **Step 3: Implement**: `fresh` only when leaving the own login records the old id (a grid-to-grid fresh move keeps
  the earlier remembered one); home with a remembered id passes it as the session to resume.
- [ ] **Step 4: Run** — PASS. Also run `cd cli && npm run test:core`.
- [ ] **Step 5: Commit** — `feat(cli): a model switch can start a fresh session and the way home reopens the earlier one (#2354)`

### Task 4: CLI — how long a Claude Code conversation is now

**Files:**
- Create: `cli/src/lib/conversationSize.ts`
- Test: `cli/src/lib/conversationSize.spec.ts`

**Interfaces:**
- Produces: `conversationTokens(transcriptPath: string): Promise<number | null>` — the newest assistant entry's
  `usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`, read from at most the last
  256 KB; null when none is found or the file is unreadable.

- [ ] **Step 1: Failing tests**: a transcript whose last assistant usage sums to 150 000 → 150000; a later user entry
  after it does not change it; a 1 MB transcript whose newest usage is in the last 256 KB → found; none → null; a
  missing file → null.
- [ ] **Step 2: Run** `cd cli && node --test --import tsx src/lib/conversationSize.spec.ts` — FAIL.
- [ ] **Step 3: Implement** with a bounded read from the end (`open` + `read` at `size - 256 KB`), lines parsed newest first.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(cli): read how long a Claude Code conversation is from its transcript's tail (#2354)`

### Task 5: CLI host — carry out a Buddy's model request

**Files:**
- Create: `cli/src/superTabs/buddyModel.ts`
- Modify: `cli/src/superTabs/host.ts` (serve Buddy rows), `cli/src/superTabs/machines.ts` (`CAPABILITIES.push('buddyModel')`)
- Test: `cli/src/superTabs/buddyModel.spec.ts`

**Interfaces:**
- Consumes: Task 3's frame, Task 4's `conversationTokens`, Task 1's commands.
- Produces: `class BuddyModelRequests { serve(row: BuddyModelRow): Promise<void> }`, with deps `{ open, post, now, log,
  sessions(buddyAgentId): RegisteredSession[] }`; the done-ids record under `<dataDir>/super-tabs/buddy-model/`.

- [ ] **Step 1: Failing tests** (fake daemon answering `agent_retarget`, fake post):
  - a request to `deepseek-4.1-flash` with the target window 131072 and a 40 000-token conversation → one
    `agent_retarget { gridModel, gridName: <swarm grid>, }` without `fresh`, then `buddy.modelResult { ok: true }`.
  - a 120 000-token conversation → `fresh: true`, result `{ ok: true, fresh: true, contextWindow: 131072 }`.
  - unknown window or unreadable transcript → no `fresh`.
  - home → `agent_retarget { clearGrid: true }`.
  - a thread session of the same Buddy is moved too; one that fails is named in the result's error, the main move stands.
  - the daemon answers `AGENT_BUSY` → result `{ ok: false, error: 'Your Buddy is answering. Try again when it has finished' }`.
  - `GRID_UNAVAILABLE` → `{ ok: false, error: "<servers> isn't serving <model> now" }`.
  - the same request id seen again (and after a restart, from the record) → no second retarget.
- [ ] **Step 2: Run** `cd cli && node --test --import tsx src/superTabs/buddyModel.spec.ts` — FAIL.
- [ ] **Step 3: Implement**; the target's context window comes from the request's reading (server adds
  `contextWindow` to `modelRequest` from the serving reading) — add it to Task 1's request if missing.
- [ ] **Step 4: Run** — PASS; then `cd cli && npm run test:orchestrator` (host coverage gate).
- [ ] **Step 5: Commit** — `feat(cli): a Buddy's machine switches its model when its owner asks (#2354)`

### Task 6: Backend — a new thread session starts on the Buddy's model

**Files:**
- Modify: `backend/src/superTabs/commands.ts` (`message.send` with `newSession`)
- Test: `backend/src/superTabs/buddyModel.test.ts`

- [ ] **Step 1: Failing test**: with the main Buddy on `gridModel: 'deepseek-4.1-flash'`, a new thread session's start
  request carries `gridModel` and `gridName` = the Swarm grid and no `model`/`effort`; with the model no longer served
  it starts on the subscription.
- [ ] **Step 2: Run** `cd backend && npm test -- src/superTabs/buddyModel.test.ts` — FAIL.
- [ ] **Step 3: Implement** where the thread session's request copies the main Buddy's engine.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `Swarm: a Buddy's new thread session starts on the model its owner chose (#2354)`

### Task 7: Desktop/web/phone — the picker in the Buddy bar

**Files:**
- Create: `desktop/lib/super_tabs/buddy_model.dart` (offers + picker widget)
- Modify: `desktop/lib/super_tabs/buddies.dart` (`SuperTabBuddyBar`), `desktop/lib/super_tabs/controller.dart`
  (`switchBuddyModel(String? gridModel)`), `desktop/lib/super_tabs/model.dart` (`SuperTabAgent.gridModel`,
  `modelRequest`)
- Test: `desktop/test/super_tab_buddy_model_test.dart`

**Interfaces:**
- Produces: `List<BuddyModelOffer> buddyModelOffers(SuperTabSnapshot snapshot, {required DateTime now})` where
  `BuddyModelOffer = ({String model, String name, List<String> servedBy, bool api})`, from
  `superTabLocalModelRows` rows on the Swarm grid, grouped by model; `servedBy` is machine names for `local`, and
  `<person>'s saved API` for `api`.

- [ ] **Step 1: Failing widget tests** (memory store, fake sign-in, snapshot fixture as `super_tab_buddies_test.dart`):
  - the bar shows `Your subscription ▾ · Claude Code on <machine> · …`; opening it lists `Your subscription` checked,
    `SHARED IN THIS SWARM`, `DeepSeek 4.1 Flash  served by Ken's Mac Studio`, a two-machine model naming both, an API
    as `Diego's saved API`, and the footer line.
  - a `kind: shared` model, a stale reading and a starting model are not listed.
  - picking a model sends `buddy.model { gridModel }`; picking `Your subscription` sends `gridModel: null`.
  - with `modelRequest` pending the bar reads `Switching to DeepSeek 4.1 Flash…` and the picker is disabled.
  - on `gridModel` no longer served the bar reads `DeepSeek 4.1 Flash ▾ · not served now`.
  - on a Buddy-only machine the menu shows `Add <machine> to the Swarm's Machines to use shared models` and no models.
  - phone width: the menu opens as a sheet with finger-size rows.
- [ ] **Step 2: Run** `cd desktop && flutter test test/super_tab_buddy_model_test.dart` — FAIL.
- [ ] **Step 3: Implement** in the design language (DesktopChrome metadata/control styles, the shared menu anchor the ⋮
  menu uses; phone sheet as other phone menus).
- [ ] **Step 4: Run** — PASS; then `flutter analyze`, `scripts/check-ui-style` and `test/laid_out_list_test.dart`
  (Desktop guard tests before Ready).
- [ ] **Step 5: Commit** — `Desktop: a model picker in the Buddy bar names who serves each model (#2354)`; screenshots
  committed for the PR and removed in the next commit.

### Task 8: Docs

**Files:**
- Modify: `docs/swarms.md` (Buddies: a paragraph on switching the model, who serves it, fresh sessions, the guard on a grid)

- [ ] **Step 1:** Write the paragraph; **Step 2:** commit `Docs: a Buddy's model switch (#2354)`.

### Before Ready

- [ ] `cd backend && npm test` (unit), `npm run test:integration` — the full Super Tab integration suite.
- [ ] `cd cli && npm run test:core && npm run test:orchestrator` and the changed specs.
- [ ] Desktop changed tests + guard tests on this Mac.
- [ ] Red/green evidence comment on the PR, one line per risk with the failing and passing commit.
- [ ] Review steps: two security reviews (Buddy guard and privacy), and a test step on a Mac (Desktop) with a shared
  grid model: switch mid-conversation, keep chatting, switch back.
