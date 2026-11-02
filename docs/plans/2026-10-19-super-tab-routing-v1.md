# Super Tab Routing v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> Replaced by [2026-10-30-project-instructions-design.md](2026-10-30-project-instructions-design.md): the instruction document and agents' direct messages
> replace what this describes. Kept as history; do not build from it.

**Goal:** Before a Super Tab Lead starts or assigns work, `harness super-tab route` filters what cannot run the task, lets Jev choose among the rest with full context, falls back to a fixed policy order, records the decision, and shows it in the conversation where a person can change it.

**Architecture:** The backend owns the routing policy (account default plus a per-tab override), the decision log (`SuperTabRouteDecision`) and the commands that link decisions to starts and assignments. The CLI owns candidate collection, the hard filter, the policy order and the Jev call, as a pure core (`cli/src/superTabs/route.ts`) driven by a thin orchestrator (`routeCommand.ts`) and two new Super Tab service actions. The Desktop renders route messages, the Change override and the policy forms.

**Tech Stack:** TypeScript (Fastify, Prisma on MongoDB, zod, vitest) in `backend/` and `cli/`; Flutter/Dart in `desktop/`.

**Spec:** `docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md`

## Global Constraints

- Engines routed in v1: `claude` and `codex` only (the only engines with quota readings and model control).
- Quality is an integer 1–3; cost is an integer 1–100; `quotaReserve` is 0–90 (percent); `notes` at most 500 characters.
- Default `floor`: `{low: 1, medium: 2, high: 3}`; a `high` risk raises the floor by one, to at most 3.
- Default `quotaReserve`: `10`.
- Policy order (fixed, not configurable): meets floor → lowest cost → most quota left (tightest window) → earliest reset → member before new agent → stable by title.
- At most 12 candidates shown to Jev; exactly one candidate → no Jev call (`via: 'only'`).
- Jev pick accepted with `jevPick(answer, ids, true)` from `cli/src/lib/routeDecide.ts` (p ≥ 0.6, or a clear lead with ≥ 6 options); otherwise the policy order (`via: 'order'`).
- Jev timeout: 3 seconds (`AbortSignal.timeout(3000)`), no retry.
- Hosted Jev limits (`backend/src/routes/jevRoute.ts`): `state` is at most 4 string keys and 17,000 characters in total; each criterion at most 640 characters; instructions at most 1,500 characters.
- Text limits: Lead `why` ≤ 300, brief cut at 2000, `notes` ≤ 500, override `reason` ≤ 300.
- At most 30 `route.record` per tab per rolling hour (`RATE_LIMITED`, 429). One open decision per group (a newer one supersedes it). Decision records are pruned after 90 days.
- Jev never receives emails, tokens, credentials or transcripts.
- Visible copy in English, following `docs/naming-system.md` (**Super Tab**, **Lead**).
- Tests never call the real Jev or OpenRouter; tests never touch the developer's daemon (port 18473), `~/.harness`, `~/.claude`, `~/.codex` or the real tmux server.
- Ship as one change: backend → CLI → Desktop. No part merges on its own.
- Do not commit until the owner asks; each task's "Commit" step is a local commit only when the owner has authorized commits for this branch.

## Rulings made while planning (deviations from the spec text, to be folded back into the spec)

1. **Model selection for new agents.** `agent_create` accepts no model or effort. A start request gains optional `model` and `effort`; after the agent is created, `start.ts` applies them with `agent_update {agentId, selectedModel: encodeRuntimeProfile(...)}`. A policy row whose `model` and `effort` are both `default` launches the engine as configured and skips `agent_update`. The default catalog uses `default` for Codex because Codex model slugs come from each machine's `models_cache.json`.
2. **Outcomes.** `done`, `stopped` and `superseded` only. The spec's `reassigned` is dropped: an override is recorded in its own `override` field, and a re-route supersedes.
3. **Lead overrides post a message** (`source.kind: 'route-override'`), because route rows are immutable messages.
4. **Expanding a route row** reads `GET /api/super-tabs/:tabId/route-decisions/:decisionId`, besides the list endpoint the spec names.
5. **Account policy endpoint** is `/api/super-tabs/routing-policy` (GET and POST), not `/api/routing-policy`, so the Desktop and CLI reach it through the existing Super Tab backend passthrough (`cli/src/superTabs/service.ts` path regex) without a new daemon route.
6. **Candidates' quality for members** comes from the policy row matching engine + model + effort, then engine + model; a member matching no row is quality 1, cost 1 (conservative: it rarely meets a floor).

## Review Focus

1. A tab where every machine is offline or every engine is exhausted → `route` returns `NO_CANDIDATE` with one exclusion reason per candidate, never an empty success. (Task 6, test "returns NO_CANDIDATE with reasons".)
2. Jev answers with a probability map missing one option, or picks an id it was not shown → treated as unsure, policy order wins. (Task 5, test "broken Jev answers fall back to order".)
3. A person presses Change on an old decision after a newer route superseded it → refused with `ROUTE_CLOSED`, and the Desktop shows the error instead of silently doing nothing. (Task 3 test "override of a closed decision"; Task 8 test "Change shows the refusal".)
4. Codex `resetsAt` arrives as epoch seconds and Claude's as an ISO string → both order correctly by earliest reset. (Task 5, test "normalizes reset times".)
5. A Lead passes a `routeDecisionId` from another group to `work.assign` → refused, not silently linked. (Task 4, test "decision from another group".)

---

## File Structure

**Backend**
- Create `backend/src/superTabs/routingPolicy.ts` — policy zod schemas, built-in default, field-by-field merge with warnings.
- Create `backend/src/superTabs/routingPolicy.test.ts`.
- Create `backend/src/superTabs/routeRecord.ts` — route decision zod schemas and types shared by commands and store.
- Create `backend/src/superTabs/routeDecisions.ts` — transactional writes of decision effects, supersede, prune, outcomes, reads.
- Modify `backend/src/superTabs/model.ts` — `SuperTabState.routingPolicy?`, `MessageDraft.source?`, `CommandEffects.routeDecisions`, route types.
- Modify `backend/src/superTabs/commands.ts` — `tab.routingPolicy`, `route.record`, `route.override`; `routeDecisionId`/`overrideReason` on `work.assign` and `agent.start`; `model`/`effort` on start requests.
- Modify `backend/src/superTabs/commands.test.ts`.
- Modify `backend/src/superTabs/store.ts` — load decision context, write effects, message `source`, outcomes, account policy and effective policy reads.
- Modify `backend/src/routes/superTabs.ts` — four routes.
- Modify `backend/prisma/schema.prisma` — `RoutingPolicy`, `SuperTabRouteDecision`.
- Modify `backend/integration/superTabs.test.ts`.

**CLI**
- Create `cli/src/superTabs/route.ts` — pure routing core.
- Create `cli/src/superTabs/route.spec.ts`.
- Create `cli/src/superTabs/routeCommand.ts` — orchestrates context, probes, Jev, record.
- Create `cli/src/superTabs/routeCommand.spec.ts`.
- Create `cli/vitest.super-tabs.config.ts` and script `test:super-tabs` — 100% per file for the new files.
- Modify `cli/src/superTabs/service.ts` (+ spec) — actions `routeContext`, `routeJev`; HELP.
- Modify `cli/src/superTabs/command.ts` (+ spec) — `route GROUP JSON`.
- Modify `cli/src/superTabs/start.ts` (+ spec) — `routeDecisionId`/`overrideReason` passthrough; apply `model`/`effort`.
- Modify `cli/src/superTabs/host.ts` — delivery prompt names `route`.
- Create `cli/e2e/superTabRoute.e2e.ts`; modify `cli/e2e/harness/fakeBackend.ts` (`/api/route/jev`).

**Desktop**
- Create `desktop/lib/super_tabs/routing_policy.dart` — Dart policy model.
- Create `desktop/lib/super_tabs/routing_policy_form.dart` — shared form.
- Create `desktop/lib/super_tabs/route_row.dart` — route and override rows, Change dialog, expand.
- Create `desktop/lib/settings/sections/routing_section.dart`.
- Modify `desktop/lib/super_tabs/model.dart`, `view.dart`, `launch.dart`, `desktop/lib/settings/settings_section.dart`, `desktop/lib/settings/settings_body.dart`.
- Tests: `desktop/test/super_tab_route_test.dart`, `desktop/test/routing_policy_test.dart`, update `desktop/test/settings_section_test.dart`.

---

## Phase A — Backend

### Task 1: Routing policy core

**Files:**
- Create: `backend/src/superTabs/routingPolicy.ts`
- Test: `backend/src/superTabs/routingPolicy.test.ts`

**Interfaces:**
- Produces:
  - `routingPolicySchema` (zod), `routingOverrideSchema` (zod, partial, no `version`)
  - `type RoutingPolicy`, `type RoutingOverride`, `type RoutingModel`
  - `DEFAULT_ROUTING_POLICY: RoutingPolicy`
  - `effectivePolicy(account: unknown, override: unknown): { policy: RoutingPolicy; warnings: string[]; overridden: Array<keyof RoutingOverride> }`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/superTabs/routingPolicy.test.ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTING_POLICY, effectivePolicy, routingOverrideSchema, routingPolicySchema } from './routingPolicy.js'

describe('routing policy', () => {
  it('ships a valid default that needs no setup', () => {
    expect(routingPolicySchema.parse(DEFAULT_ROUTING_POLICY)).toEqual(DEFAULT_ROUTING_POLICY)
    expect(DEFAULT_ROUTING_POLICY.floor).toEqual({ low: 1, medium: 2, high: 3 })
    expect(DEFAULT_ROUTING_POLICY.quotaReserve).toBe(10)
    expect(DEFAULT_ROUTING_POLICY.notes).toBe('')
    expect(new Set(DEFAULT_ROUTING_POLICY.models.map(m => m.engine))).toEqual(new Set(['claude', 'codex']))
  })

  it('uses the default when the account has none, and merges a tab override field by field', () => {
    expect(effectivePolicy(null, null)).toEqual({ policy: DEFAULT_ROUTING_POLICY, warnings: [], overridden: [] })
    const account = { ...DEFAULT_ROUTING_POLICY, quotaReserve: 20, notes: 'Frontend prefers Claude.' }
    const result = effectivePolicy(account, { notes: 'Long jobs on remote-1.' })
    expect(result.policy.quotaReserve).toBe(20)
    expect(result.policy.notes).toBe('Long jobs on remote-1.')
    expect(result.overridden).toEqual(['notes'])
    expect(result.warnings).toEqual([])
  })

  it('falls back to the default with a warning for a corrupt account policy or override', () => {
    const corrupt = effectivePolicy({ version: 9 }, { floor: { low: 7 } })
    expect(corrupt.policy).toEqual(DEFAULT_ROUTING_POLICY)
    expect(corrupt.warnings).toEqual([
      'The account routing policy is unreadable; the built-in default applies.',
      'This Super Tab routing override is unreadable and was ignored.',
    ])
  })

  it('rejects out-of-range values and unknown engines', () => {
    const bad = (patch: Record<string, unknown>) => routingPolicySchema.safeParse({ ...DEFAULT_ROUTING_POLICY, ...patch }).success
    expect(bad({ quotaReserve: 91 })).toBe(false)
    expect(bad({ notes: 'x'.repeat(501) })).toBe(false)
    expect(bad({ floor: { low: 0, medium: 2, high: 3 } })).toBe(false)
    expect(bad({ models: [{ ...DEFAULT_ROUTING_POLICY.models[0], engine: 'cursor' }] })).toBe(false)
    expect(bad({ models: [{ ...DEFAULT_ROUTING_POLICY.models[0], cost: 0 }] })).toBe(false)
    expect(bad({ models: [] })).toBe(false)
    expect(routingOverrideSchema.safeParse({ version: 1 }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/superTabs/routingPolicy.test.ts`
Expected: FAIL with "Failed to load url ./routingPolicy.js" (module missing).

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/superTabs/routingPolicy.ts
/** Super Tab routing policy (docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md).
 * The account default applies to every tab its owner creates; a tab owner may override single fields.
 * Every field has a built-in default so routing works before anyone opens the form. */
import { z } from 'zod'

const quality = z.number().int().min(1).max(3)
const modelRow = z.object({
  engine: z.enum(['claude', 'codex']),
  // `default` keeps the engine's own configured model or effort; no runtime switch is made.
  model: z.string().trim().min(1).max(200),
  effort: z.string().trim().min(1).max(80),
  quality,
  cost: z.number().int().min(1).max(100),
  enabled: z.boolean(),
}).strict()
const fields = {
  models: z.array(modelRow).min(1).max(40),
  floor: z.object({ low: quality, medium: quality, high: quality }).strict(),
  quotaReserve: z.number().int().min(0).max(90),
  notes: z.string().trim().max(500),
}
export const routingPolicySchema = z.object({ version: z.literal(1), ...fields }).strict()
export const routingOverrideSchema = z.object(fields).partial().strict()
export type RoutingPolicy = z.infer<typeof routingPolicySchema>
export type RoutingOverride = z.infer<typeof routingOverrideSchema>
export type RoutingModel = RoutingPolicy['models'][number]

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  version: 1,
  models: [
    { engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3, enabled: true },
    { engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2, enabled: true },
    { engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2, cost: 2, enabled: true },
    { engine: 'claude', model: 'haiku', effort: 'auto', quality: 1, cost: 1, enabled: true },
  ],
  floor: { low: 1, medium: 2, high: 3 },
  quotaReserve: 10,
  notes: '',
}

export function effectivePolicy(account: unknown, override: unknown) {
  const warnings: string[] = []
  let policy = DEFAULT_ROUTING_POLICY
  if (account !== null && account !== undefined) {
    const parsed = routingPolicySchema.safeParse(account)
    if (parsed.success) policy = parsed.data
    else warnings.push('The account routing policy is unreadable; the built-in default applies.')
  }
  const overridden: Array<keyof RoutingOverride> = []
  if (override !== null && override !== undefined) {
    const parsed = routingOverrideSchema.safeParse(override)
    if (!parsed.success) warnings.push('This Super Tab routing override is unreadable and was ignored.')
    else {
      policy = { ...policy, ...parsed.data }
      overridden.push(...(Object.keys(parsed.data) as Array<keyof RoutingOverride>))
    }
  }
  return { policy, warnings, overridden }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/superTabs/routingPolicy.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/superTabs/routingPolicy.ts backend/src/superTabs/routingPolicy.test.ts
git commit -m "Super Tab routing: policy schema, default and merge"
```

---

### Task 2: Account policy storage, tab override and effective-policy routes

**Files:**
- Modify: `backend/prisma/schema.prisma` (after `model SuperTabRun`)
- Modify: `backend/src/superTabs/model.ts` (`SuperTabState`)
- Modify: `backend/src/superTabs/commands.ts` (schema + switch)
- Modify: `backend/src/superTabs/store.ts` (new methods)
- Modify: `backend/src/routes/superTabs.ts`
- Test: `backend/src/superTabs/commands.test.ts`, `backend/integration/superTabs.test.ts`

**Interfaces:**
- Consumes: `routingPolicySchema`, `routingOverrideSchema`, `effectivePolicy`, `DEFAULT_ROUTING_POLICY` (Task 1).
- Produces:
  - Command `{ type: 'tab.routingPolicy', policy: RoutingOverride | null }` (owner only).
  - `SuperTabStore.accountPolicy(user): Promise<{ policy: RoutingPolicy; revision: number; isDefault: boolean }>`
  - `SuperTabStore.saveAccountPolicy(user, revision: number, policy: RoutingPolicy): Promise<{ policy; revision; isDefault: false }>`
  - `SuperTabStore.tabPolicy(user, tabId, asAgentId?): Promise<{ policy: RoutingPolicy; warnings: string[]; overridden: string[]; override: RoutingOverride | null }>`
  - Routes: `GET /api/super-tabs/routing-policy`, `POST /api/super-tabs/routing-policy` body `{ revision, policy }`, `GET /api/super-tabs/:tabId/routing-policy?asAgentId=`.

- [ ] **Step 1: Write the failing unit test** (append to `backend/src/superTabs/commands.test.ts`, using its existing `fixture()` helper and its `run(command, actor, context)`)

```ts
describe('tab.routingPolicy', () => {
  it('lets only the owner set or clear the tab override', () => {
    const f = fixture()
    f.run({ type: 'tab.routingPolicy', policy: { quotaReserve: 25 } })
    expect(f.state.routingPolicy).toEqual({ quotaReserve: 25 })
    f.invite('collaborator')
    expect(() => f.run({ type: 'tab.routingPolicy', policy: { notes: 'x' } }, f.collaborator)).toThrow('Only the Super Tab owner')
    f.run({ type: 'tab.routingPolicy', policy: null })
    expect(f.state.routingPolicy).toBeUndefined()
  })
  it('refuses an invalid override', () => {
    const f = fixture()
    expect(() => f.run({ type: 'tab.routingPolicy', policy: { quotaReserve: 99 } } as never)).toThrow()
  })
})
```

If `fixture()` in `commands.test.ts` names its state, owner or collaborator differently, use its names; the assertions stay the same.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/superTabs/commands.test.ts -t "tab.routingPolicy"`
Expected: FAIL (zod: invalid discriminator `tab.routingPolicy`).

- [ ] **Step 3: Implement the command**

In `backend/src/superTabs/model.ts`, add to `SuperTabState`:

```ts
  /** Fields this tab overrides from its owner's account routing policy (routingPolicy.ts). */
  routingPolicy?: import('./routingPolicy.js').RoutingOverride
```

In `backend/src/superTabs/commands.ts`, import and add to `commandSchema`:

```ts
import { routingOverrideSchema } from './routingPolicy.js'
// ...
  z.object({ type: z.literal('tab.routingPolicy'), policy: routingOverrideSchema.nullable() }).strict(),
```

and to the `switch` in `applyCommand`:

```ts
    case 'tab.routingPolicy':
      if (actor.kind !== 'person' || actor.userId !== state.ownerId) fail('OWNER_REQUIRED', 'Only the Super Tab owner can change its routing policy.', 403)
      if (command.policy && Object.keys(command.policy).length) state.routingPolicy = command.policy
      else delete state.routingPolicy
      break
```

- [ ] **Step 4: Run the unit test**

Run: `cd backend && npx vitest run src/superTabs/commands.test.ts -t "tab.routingPolicy"`
Expected: PASS.

- [ ] **Step 5: Add the Prisma model**

```prisma
// One routing policy document per account and environment (superTabs/routingPolicy.ts).
model RoutingPolicy {
  id            String   @id @map("_id")
  userId        String
  autonomousEnv String
  revision      Int      @default(0)
  policy        Json
  updatedAt     DateTime @updatedAt

  @@unique([userId, autonomousEnv])
}
```

Run: `cd backend && npx prisma generate`
Expected: "Generated Prisma Client".

- [ ] **Step 6: Write the failing integration test** (append inside the existing `describe` of `backend/integration/superTabs.test.ts`)

```ts
  it('stores the account routing policy with revisions and merges the owner policy into each tab', async () => {
    const initial = await store.accountPolicy(owner)
    expect(initial).toEqual({ policy: DEFAULT_ROUTING_POLICY, revision: 0, isDefault: true })
    const saved = await store.saveAccountPolicy(owner, 0, { ...DEFAULT_ROUTING_POLICY, quotaReserve: 30 })
    expect(saved.revision).toBe(1)
    await expect(store.saveAccountPolicy(owner, 0, DEFAULT_ROUTING_POLICY)).rejects.toMatchObject({ code: 'REVISION_CHANGED' })
    const { tab, lead } = await fixture()
    await run(tab, { type: 'tab.routingPolicy', policy: { notes: 'Prefer remote-1.' } })
    await invite(tab, 'viewer')
    // A member reads the owner's policy, never their own account's.
    await store.saveAccountPolicy(peer, 0, { ...DEFAULT_ROUTING_POLICY, quotaReserve: 5 })
    for (const [user, asAgent] of [[owner, undefined], [peer, undefined], [host, lead]] as const) {
      const effective = await store.tabPolicy(user, tab, asAgent)
      expect(effective.policy.quotaReserve).toBe(30)
      expect(effective.policy.notes).toBe('Prefer remote-1.')
      expect(effective.overridden).toEqual(['notes'])
    }
  })
```

Add `import { DEFAULT_ROUTING_POLICY } from '../src/superTabs/routingPolicy.js'` at the top.

- [ ] **Step 7: Run it to verify it fails**

Run: `cd backend && npm run test:super-tabs -- -t "account routing policy"`
Expected: FAIL (`store.accountPolicy is not a function`).

- [ ] **Step 8: Implement the store methods** (in `SuperTabStore`, `backend/src/superTabs/store.ts`)

```ts
import { DEFAULT_ROUTING_POLICY, effectivePolicy, routingPolicySchema, type RoutingPolicy } from './routingPolicy.js'
// ...
  private policyId(user: AuthUser) { return stableId('routing-policy', user.sub, user.autonomousEnv) }

  async accountPolicy(user: AuthUser) {
    const row = await this.db.routingPolicy.findUnique({ where: { id: this.policyId(user) } })
    if (!row) return { policy: DEFAULT_ROUTING_POLICY, revision: 0, isDefault: true }
    const { policy } = effectivePolicy(row.policy, null)
    return { policy, revision: row.revision, isDefault: false }
  }

  async saveAccountPolicy(user: AuthUser, revision: number, input: RoutingPolicy) {
    const policy = routingPolicySchema.parse(input)
    return transaction(this.db, async tx => {
      const id = this.policyId(user)
      const row = await tx.routingPolicy.findUnique({ where: { id } })
      if ((row?.revision ?? 0) !== revision) fail('REVISION_CHANGED', 'The routing policy changed elsewhere. Reload it and try again.')
      const next = revision + 1
      if (row) await tx.routingPolicy.update({ where: { id, revision }, data: { revision: next, policy: json(policy) } })
      else await tx.routingPolicy.create({ data: { id, userId: user.sub, autonomousEnv: user.autonomousEnv, revision: next, policy: json(policy) } })
      return { policy, revision: next, isDefault: false as const }
    })
  }

  async tabPolicy(user: AuthUser, tabId: string, asAgentId?: string) {
    return transaction(this.db, async tx => {
      const row = await this.row(tx, user, tabId)
      const state = stateOf(row)
      author(state, await this.actor(tx, user, state, asAgentId))
      const account = await tx.routingPolicy.findUnique({ where: { id: stableId('routing-policy', state.ownerId, state.environment) } })
      return { ...effectivePolicy(account?.policy ?? null, state.routingPolicy ?? null), override: state.routingPolicy ?? null }
    })
  }
```

`author`, `stableId` and `fail` are already imported in `store.ts` from `./model.js`; add any that are not.

- [ ] **Step 9: Add the routes** (in `superTabRoutes`, `backend/src/routes/superTabs.ts`, before the `'/api/super-tabs/:tabId'` GET)

```ts
import { routingPolicySchema } from '../superTabs/routingPolicy.js'
// ...
const savePolicy = z.object({ revision: z.number().int().nonnegative().safe(), policy: routingPolicySchema }).strict()
// ...
  app.get('/api/super-tabs/routing-policy', (req, reply) => respond(reply, () => store.accountPolicy(req.user!)))
  app.post<{ Body: z.infer<typeof savePolicy> }>('/api/super-tabs/routing-policy', { preHandler: validateBody(savePolicy) },
    (req, reply) => respond(reply, () => store.saveAccountPolicy(req.user!, req.body.revision, req.body.policy)))
  app.get<{ Params: z.infer<typeof tabParams>; Querystring: z.infer<typeof agentQuery> }>('/api/super-tabs/:tabId/routing-policy',
    { preHandler: [validateParams(tabParams), validateQuery(agentQuery)] },
    (req, reply) => respond(reply, () => store.tabPolicy(req.user!, req.params.tabId, req.query.asAgentId)))
```

- [ ] **Step 10: Run the backend checks**

Run: `cd backend && npx tsc --noEmit -p . && npx vitest run src/superTabs && npm run test:super-tabs`
Expected: all PASS (the existing 21 integration tests plus the new one).

- [ ] **Step 11: Commit**

```bash
git add backend/prisma/schema.prisma backend/src/superTabs backend/src/routes/superTabs.ts backend/integration/superTabs.test.ts
git commit -m "Super Tab routing: account policy, tab override and effective policy"
```

---

### Task 3: Decision log, route messages and person override

**Files:**
- Create: `backend/src/superTabs/routeRecord.ts`
- Create: `backend/src/superTabs/routeDecisions.ts`
- Modify: `backend/prisma/schema.prisma`, `backend/src/superTabs/model.ts`, `backend/src/superTabs/commands.ts`, `backend/src/superTabs/store.ts`, `backend/src/routes/superTabs.ts`
- Test: `backend/src/superTabs/commands.test.ts`, `backend/integration/superTabs.test.ts`

**Interfaces:**
- Produces:
  - `routeRecordSchema` (zod) and types `RouteCandidate`, `RouteRecord`, `RouteFinal`, `RouteOverride`, `RouteDecision`, `RouteDecisionEffect` (in `routeRecord.ts`).
  - Commands `{ type: 'route.record', conversationId, decision: RouteRecord }` → `result.routeDecisionId`; `{ type: 'route.override', decisionId, candidateId, reason }`.
  - `MessageDraft.source?: Record<string, unknown>`; route messages carry `source.kind === 'route'` or `'route-override'`.
  - `CommandContext.recentRoutes?: number`, `CommandContext.routeDecision?: RouteDecision`.
  - `CommandEffects.routeDecisions: RouteDecisionEffect[]`.
  - Store: `routeDecisions(user, tabId)` (newest 100) and `routeDecision(user, tabId, decisionId)`; routes `GET /api/super-tabs/:tabId/route-decisions` and `GET /api/super-tabs/:tabId/route-decisions/:decisionId`.

- [ ] **Step 1: Write `routeRecord.ts`** (types and schema only; exercised by the tests in the next steps)

```ts
// backend/src/superTabs/routeRecord.ts
/** What `harness super-tab route` records (docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md). */
import { z } from 'zod'

const level = z.enum(['low', 'medium', 'high'])
const candidateId = z.string().regex(/^c\d{1,2}$/)
const machine = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
export const routeCandidateSchema = z.object({
  id: candidateId,
  kind: z.enum(['member', 'new']),
  agentId: machine.optional(),
  machineId: machine,
  engine: z.enum(['claude', 'codex']),
  model: z.string().min(1).max(200),
  effort: z.string().min(1).max(80),
  quality: z.number().int().min(1).max(3),
  cost: z.number().int().min(1).max(100),
  /** Short, for the conversation row: "Multiply · Claude opus high · remote-1". */
  title: z.string().trim().min(1).max(160),
  /** The criterion line Jev was shown. */
  label: z.string().trim().min(1).max(640),
}).strict().refine(c => (c.kind === 'member') === !!c.agentId, 'Members name their agent; new agents do not.')
export const routeRecordSchema = z.object({
  assessment: z.object({ difficulty: level, risk: level, why: z.string().trim().min(1).max(300) }).strict(),
  candidates: z.array(routeCandidateSchema).min(1).max(12),
  excluded: z.array(z.object({ title: z.string().trim().min(1).max(160), reason: z.string().trim().min(1).max(500) }).strict()).max(200),
  floor: z.number().int().min(1).max(3),
  notes: z.boolean(),
  pick: candidateId,
  via: z.enum(['jev', 'order', 'only']),
  p: z.number().min(0).max(1).nullable(),
  belowFloor: z.boolean(),
  why: z.string().trim().min(1).max(300),
}).strict().refine(d => d.candidates.some(c => c.id === d.pick), 'The pick must be one of the candidates.')
  .refine(d => new Set(d.candidates.map(c => c.id)).size === d.candidates.length, 'Candidate ids must be unique.')

export type RouteCandidate = z.infer<typeof routeCandidateSchema>
export type RouteRecord = z.infer<typeof routeRecordSchema>
export type RouteFinal =
  | { kind: 'member'; agentId: string; machineId: string }
  | { kind: 'new'; startId: string; machineId: string; engine: string; model: string; effort: string }
export interface RouteOverride { by: 'lead' | 'person'; actorKey: string; candidateId?: string; reason: string }
export interface RouteDecision {
  id: string; conversationId: string; record: RouteRecord
  final: RouteFinal | null; override: RouteOverride | null; assignmentId: string | null; outcome: string | null
}
export type RouteDecisionEffect =
  | { op: 'create'; id: string; conversationId: string; record: RouteRecord }
  | { op: 'override'; id: string; override: RouteOverride }
  | { op: 'final'; id: string; final: RouteFinal; override?: RouteOverride; assignmentId?: string }
export const routeTitle = (decision: RouteDecision, candidateId: string): string =>
  decision.record.candidates.find(c => c.id === candidateId)?.title ?? 'another candidate'
```

- [ ] **Step 2: Write the failing unit tests** (append to `backend/src/superTabs/commands.test.ts`; `lead` is the lead agent from the fixture and `leadActor` its `{kind:'agent', agentId, machineOwnerId:'host-owner'}` actor — use the fixture's real names)

```ts
const candidate = (id: string, patch: Record<string, unknown> = {}) => ({ id, kind: 'new', machineId: 'machine', engine: 'claude',
  model: 'opus', effort: 'high', quality: 3, cost: 3, title: `Title ${id}`, label: `Label ${id}`, ...patch })
const record = (patch: Record<string, unknown> = {}) => ({ assessment: { difficulty: 'high', risk: 'low', why: 'Schema change.' },
  candidates: [candidate('c0'), candidate('c1', { model: 'sonnet', quality: 2, cost: 2 })], excluded: [], floor: 3, notes: false,
  pick: 'c0', via: 'jev', p: 0.82, belowFloor: false, why: 'Highest quality within quota.', ...patch })

describe('route.record and route.override', () => {
  it('records a lead decision as a route message with its id', () => {
    const f = fixture()
    const effects = f.run({ type: 'route.record', conversationId: 'lead', decision: record() }, f.leadActor, { recentRoutes: 0 })
    expect(effects.result.routeDecisionId).toBeTruthy()
    expect(effects.routeDecisions).toEqual([{ op: 'create', id: effects.result.routeDecisionId, conversationId: 'lead', record: expect.objectContaining({ pick: 'c0' }) }])
    expect(effects.messages[0]).toMatchObject({ text: 'Routed to Title c0 — Jev 82% · "Highest quality within quota."',
      source: { kind: 'route', decisionId: effects.result.routeDecisionId, via: 'jev', p: 0.82, belowFloor: false,
        pick: { id: 'c0', title: 'Title c0' }, alternatives: [{ id: 'c1', title: 'Title c1' }] } })
  })
  it('refuses a pick outside the candidates, a non-lead agent and a busy hour', () => {
    const f = fixture()
    expect(() => f.run({ type: 'route.record', conversationId: 'lead', decision: record({ pick: 'c5' }) }, f.leadActor, { recentRoutes: 0 })).toThrow()
    expect(() => f.run({ type: 'route.record', conversationId: 'lead', decision: record() }, f.workerActor, { recentRoutes: 0 })).toThrow('coordinating lead')
    expect(() => f.run({ type: 'route.record', conversationId: 'lead', decision: record() }, f.leadActor, { recentRoutes: 30 })).toThrow('30 tasks')
  })
  it('lets a writer change an open decision with a reason and tells the lead', () => {
    const f = fixture()
    const decision = { id: 'd1', conversationId: 'lead', record: record(), final: null, override: null, assignmentId: null, outcome: null }
    const effects = f.run({ type: 'route.override', decisionId: 'd1', candidateId: 'c1', reason: 'Opus quota is needed elsewhere.' }, undefined, { routeDecision: decision })
    expect(effects.routeDecisions).toEqual([{ op: 'override', id: 'd1', override: expect.objectContaining({ by: 'person', candidateId: 'c1', reason: 'Opus quota is needed elsewhere.' }) }])
    expect(effects.messages[0].recipients).toEqual([f.lead])
    expect(effects.messages[0].text).toContain('chose Title c1 instead of Title c0. Hand this task over to it. Reason: Opus quota is needed elsewhere.')
    expect(effects.messages[0].source).toEqual({ kind: 'route-override', decisionId: 'd1', by: 'person' })
  })
  it('refuses an override by an agent, of a closed decision, or of the current choice', () => {
    const f = fixture()
    const open = { id: 'd1', conversationId: 'lead', record: record(), final: null, override: null, assignmentId: null, outcome: null }
    const command = { type: 'route.override', decisionId: 'd1', candidateId: 'c1', reason: 'Because.' } as const
    expect(() => f.run(command, f.leadActor, { routeDecision: open })).toThrow('A person')
    expect(() => f.run(command, undefined, { routeDecision: { ...open, outcome: 'superseded' } })).toThrow('no longer open')
    expect(() => f.run({ ...command, candidateId: 'c0' }, undefined, { routeDecision: open })).toThrow('already')
  })
})
```

`f.run(command, actor = owner, context = {})` must return the `CommandEffects`; if the fixture's `run` returns only the state, extend it to return the effects (keep existing callers working). If the fixture has no worker agent, add one with its existing `add(...)` helper as `f.workerActor`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/superTabs/commands.test.ts -t "route.record"`
Expected: FAIL (unknown command type).

- [ ] **Step 4: Implement model and command changes**

`backend/src/superTabs/model.ts`:

```ts
import type { RouteDecision, RouteDecisionEffect } from './routeRecord.js'
// MessageDraft gains:
  /** Structured row kind for clients; `native` is written by native.ts, `route`/`route-override` by commands. */
  source?: Record<string, unknown>
// CommandEffects gains:
  routeDecisions: RouteDecisionEffect[]
```

`backend/src/superTabs/commands.ts`:

```ts
import { routeRecordSchema, routeTitle, type RouteDecision } from './routeRecord.js'
const reason = z.string().trim().min(1).max(300)
// commandSchema additions:
  z.object({ type: z.literal('route.record'), conversationId: id, decision: routeRecordSchema }).strict(),
  z.object({ type: z.literal('route.override'), decisionId: id, candidateId: z.string().regex(/^c\d{1,2}$/), reason }).strict(),
// CommandContext additions:
  /** Route decisions this tab recorded in the last hour, counted by the store. */
  recentRoutes?: number
  /** The decision a command names, read from SuperTabRouteDecision by the store. */
  routeDecision?: RouteDecision
```

In `applyCommand`, initialise `routeDecisions: []` in `effects`, extend `message()` with an optional `source`:

```ts
  const message = (conversationId: string, body: string, recipients: string[] = [], replyTo: string | null = null, source?: Record<string, unknown>) => {
    effects.messages.push({ id: operationId, conversationId, author: sender, text: body, replyTo, recipients, ...(source ? { source } : {}) })
    result.messageId = operationId
  }
  const openDecision = (): RouteDecision => {
    const decision = context.routeDecision ?? fail('NOT_FOUND', 'This routing decision is unavailable.', 404)
    if (decision.outcome) fail('ROUTE_CLOSED', 'This routing decision is no longer open. Route the task again.')
    return decision
  }
```

and the cases:

```ts
    case 'route.record': {
      controls(state, actor, command.conversationId)
      open(state, command.conversationId)
      if ((context.recentRoutes ?? 0) >= 30) fail('RATE_LIMITED', 'This Super Tab routed 30 tasks in the last hour. Wait before routing again.', 429)
      const decision = command.decision
      const pick = decision.candidates.find(c => c.id === decision.pick)!
      const via = decision.via === 'jev' ? `Jev ${Math.round((decision.p ?? 0) * 100)}%`
        : decision.via === 'only' ? 'only candidate' : 'by policy order'
      effects.routeDecisions.push({ op: 'create', id: operationId, conversationId: command.conversationId, record: decision })
      result.routeDecisionId = operationId
      message(command.conversationId, `Routed to ${pick.title} — ${via} · "${decision.why}"`, [], null, {
        kind: 'route', decisionId: operationId, via: decision.via, p: decision.p, belowFloor: decision.belowFloor, why: decision.why,
        pick: { id: pick.id, title: pick.title },
        alternatives: decision.candidates.filter(c => c.id !== pick.id).map(c => ({ id: c.id, title: c.title })),
      })
      break
    }
    case 'route.override': {
      if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'A person changes a routing decision; the lead overrides when it starts or assigns.', 403)
      const decision = openDecision()
      controls(state, actor, decision.conversationId)
      open(state, decision.conversationId)
      const current = decision.override?.candidateId ?? decision.record.pick
      const chosen = decision.record.candidates.find(c => c.id === command.candidateId) ?? fail('NOT_FOUND', 'Choose one of this decision’s candidates.', 404)
      if (chosen.id === current) fail('ALREADY_CHOSEN', 'That candidate is already the choice.')
      if (chosen.kind === 'member' && !state.agents.some(a => a.id === chosen.agentId)) fail('CANDIDATE_UNAVAILABLE', 'That agent left this Super Tab. Choose another.')
      effects.routeDecisions.push({ op: 'override', id: decision.id, override: { by: 'person', actorKey: actorKey(actor), candidateId: chosen.id, reason: command.reason } })
      const lead = conversation(state, decision.conversationId).leadId
      message(decision.conversationId,
        `${sender.name} chose ${chosen.title} instead of ${routeTitle(decision, current)}. Hand this task over to it. Reason: ${command.reason}`,
        lead ? [lead] : [], null, { kind: 'route-override', decisionId: decision.id, by: 'person' })
      break
    }
```

`sender` is the existing `author(state, actor, ...)` result; for a person it carries `name`. If `Author` has no `name` for people, use `actor.email`.

- [ ] **Step 5: Run unit tests**

Run: `cd backend && npx vitest run src/superTabs/commands.test.ts`
Expected: PASS (all, including existing tests).

- [ ] **Step 6: Add the Prisma model and the transactional effects**

```prisma
// One `harness super-tab route` decision (superTabs/routeRecord.ts). Pruned after 90 days on write.
model SuperTabRouteDecision {
  id             String    @id @map("_id")
  tabId          String
  conversationId String
  record         Json
  final          Json?
  override       Json?
  assignmentId   String?
  outcome        String?
  outcomeAt      DateTime?
  createdAt      DateTime  @default(now())

  @@index([tabId, createdAt])
  @@index([tabId, conversationId, outcome])
  @@index([tabId, assignmentId])
}
```

Run: `cd backend && npx prisma generate`.

```ts
// backend/src/superTabs/routeDecisions.ts
/** Persistence for route decisions. Called inside SuperTabStore's transactions. */
import type { Prisma, SuperTabRouteDecision } from '@prisma/client'
import type { RouteDecision, RouteDecisionEffect, RouteFinal, RouteOverride, RouteRecord } from './routeRecord.js'

type Tx = Prisma.TransactionClient
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
export const RETENTION_MS = 90 * 24 * 60 * 60_000

export const decisionOf = (row: SuperTabRouteDecision): RouteDecision => ({
  id: row.id, conversationId: row.conversationId, record: row.record as unknown as RouteRecord,
  final: (row.final ?? null) as unknown as RouteFinal | null, override: (row.override ?? null) as unknown as RouteOverride | null,
  assignmentId: row.assignmentId, outcome: row.outcome,
})

export async function recentRoutes(tx: Tx, tabId: string, now: number): Promise<number> {
  return tx.superTabRouteDecision.count({ where: { tabId, createdAt: { gte: new Date(now - 60 * 60_000) } } })
}

export async function readDecision(tx: Tx, tabId: string, id: string): Promise<RouteDecision | undefined> {
  const row = await tx.superTabRouteDecision.findFirst({ where: { id, tabId } })
  return row ? decisionOf(row) : undefined
}

export async function writeRouteEffects(tx: Tx, tabId: string, effects: RouteDecisionEffect[], now: number): Promise<void> {
  for (const effect of effects) {
    if (effect.op === 'create') {
      // One open decision per group: a newer route supersedes the open one.
      await tx.superTabRouteDecision.updateMany({ where: { tabId, conversationId: effect.conversationId, outcome: null },
        data: { outcome: 'superseded', outcomeAt: new Date(now) } })
      await tx.superTabRouteDecision.create({ data: { id: effect.id, tabId, conversationId: effect.conversationId,
        record: json(effect.record), createdAt: new Date(now) } })
      await tx.superTabRouteDecision.deleteMany({ where: { tabId, createdAt: { lt: new Date(now - RETENTION_MS) } } })
    } else if (effect.op === 'override') {
      await tx.superTabRouteDecision.update({ where: { id: effect.id }, data: { override: json(effect.override) } })
    } else {
      await tx.superTabRouteDecision.update({ where: { id: effect.id }, data: {
        final: json(effect.final), ...(effect.override ? { override: json(effect.override) } : {}),
        ...(effect.assignmentId ? { assignmentId: effect.assignmentId } : {}),
      } })
    }
  }
}

export async function closeAssignment(tx: Tx, tabId: string, assignmentId: string, outcome: 'done' | 'stopped', now: number): Promise<void> {
  await tx.superTabRouteDecision.updateMany({ where: { tabId, assignmentId, outcome: null }, data: { outcome, outcomeAt: new Date(now) } })
}
```

In `store.execute` (`backend/src/superTabs/store.ts`), before `applyCommand`:

```ts
      if (command.type === 'route.record') context.recentRoutes = await recentRoutes(tx, tabId, context.now)
      const decisionId = command.type === 'route.override' ? command.decisionId
        : command.type === 'work.assign' || command.type === 'agent.start' ? command.routeDecisionId : undefined
      if (decisionId) context.routeDecision = await readDecision(tx, tabId, decisionId) ?? fail('NOT_FOUND', 'This routing decision is unavailable.', 404)
```

(`command.routeDecisionId` on `work.assign`/`agent.start` is added in Task 4; until then guard it with `'routeDecisionId' in command ? command.routeDecisionId : undefined` and simplify in Task 4.)

After the `superTab.update(...)` call:

```ts
      await writeRouteEffects(tx, tabId, effects.routeDecisions, context.now)
      if (command.type === 'work.status' && (command.status === 'done' || command.status === 'stopped')) {
        await closeAssignment(tx, tabId, command.assignmentId, command.status, context.now)
      }
```

and write `source` with each message:

```ts
        await tx.superTabMessage.create({ data: { id: message.id, tabId, conversationId: message.conversationId,
          sequence: revision, author: json(message.author), ...(message.source ? { source: json(message.source) } : {}),
          text: message.text, replyTo: message.replyTo, recipientIds: message.recipients } })
```

Add the reads:

```ts
  async routeDecisions(user: AuthUser, tabId: string) {
    return transaction(this.db, async tx => {
      const state = stateOf(await this.row(tx, user, tabId))
      author(state, await this.actor(tx, user, state))
      const rows = await tx.superTabRouteDecision.findMany({ where: { tabId }, orderBy: { createdAt: 'desc' }, take: 100 })
      return rows.map(row => ({ ...decisionOf(row), createdAt: row.createdAt, outcomeAt: row.outcomeAt }))
    })
  }
  async routeDecision(user: AuthUser, tabId: string, decisionId: string) {
    return transaction(this.db, async tx => {
      const state = stateOf(await this.row(tx, user, tabId))
      author(state, await this.actor(tx, user, state))
      return await readDecision(tx, tabId, decisionId) ?? fail('NOT_FOUND', 'This routing decision is unavailable.', 404)
    })
  }
```

Routes (`backend/src/routes/superTabs.ts`):

```ts
const decisionParams = tabParams.extend({ decisionId: id })
  app.get<{ Params: z.infer<typeof tabParams> }>('/api/super-tabs/:tabId/route-decisions', { preHandler: validateParams(tabParams) },
    (req, reply) => respond(reply, () => store.routeDecisions(req.user!, req.params.tabId)))
  app.get<{ Params: z.infer<typeof decisionParams> }>('/api/super-tabs/:tabId/route-decisions/:decisionId', { preHandler: validateParams(decisionParams) },
    (req, reply) => respond(reply, () => store.routeDecision(req.user!, req.params.tabId, req.params.decisionId)))
```

- [ ] **Step 7: Write the failing integration test**

```ts
  it('records, supersedes and lets a person change a route decision; a closed one refuses', async () => {
    const { tab, lead } = await fixture()
    const decision = { assessment: { difficulty: 'medium', risk: 'low', why: 'A small API change.' },
      candidates: [
        { id: 'c0', kind: 'member', agentId: lead, machineId: 'test-host', engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2, cost: 2, title: 'Lead · Claude sonnet medium · test-host', label: 'Member Lead' },
        { id: 'c1', kind: 'new', machineId: 'test-host', engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3, title: 'New agent · Claude opus high · test-host', label: 'New agent' },
      ], excluded: [{ title: 'New agent · Codex · test-host', reason: 'The selected agent engine is not installed on this machine.' }],
      floor: 2, notes: false, pick: 'c0', via: 'order', p: null, belowFloor: false, why: 'Cheapest candidate that meets the floor.' }
    const first = (await run(tab, { type: 'route.record', conversationId: 'lead', decision } as Command, host, lead)).result.routeDecisionId as string
    const second = (await run(tab, { type: 'route.record', conversationId: 'lead', decision } as Command, host, lead)).result.routeDecisionId as string
    expect((await store.routeDecision(owner, tab, first)).outcome).toBe('superseded')
    const rows = (await store.messages(owner, tab, 'lead', {})).messages
    expect(rows.at(-1)).toMatchObject({ source: { kind: 'route', decisionId: second, via: 'order' } })
    await expect(run(tab, { type: 'route.override', decisionId: first, candidateId: 'c1', reason: 'Needs Opus.' } as Command))
      .rejects.toMatchObject({ code: 'ROUTE_CLOSED' })
    await run(tab, { type: 'route.override', decisionId: second, candidateId: 'c1', reason: 'Needs Opus.' } as Command)
    expect((await store.routeDecision(owner, tab, second)).override).toMatchObject({ by: 'person', candidateId: 'c1' })
    expect((await store.deliveries(host, tab, lead)).length).toBeGreaterThan(0)
    await invite(tab, 'viewer')
    await expect(run(tab, { type: 'route.override', decisionId: second, candidateId: 'c0', reason: 'No.' } as Command, peer))
      .rejects.toMatchObject({ status: 403 })
    expect((await store.routeDecisions(owner, tab)).map(d => d.id)).toEqual([second, first])
  })

  it('limits route records to 30 per tab per hour', async () => {
    const { tab, lead } = await fixture()
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Docs.' },
      candidates: [{ id: 'c0', kind: 'new', machineId: 'test-host', engine: 'claude', model: 'haiku', effort: 'auto', quality: 1, cost: 1, title: 'New agent', label: 'New agent' }],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate.' }
    for (let i = 0; i < 30; i++) await run(tab, { type: 'route.record', conversationId: 'lead', decision } as Command, host, lead)
    await expect(run(tab, { type: 'route.record', conversationId: 'lead', decision } as Command, host, lead)).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 })
  })
```

- [ ] **Step 8: Run backend checks**

Run: `cd backend && npx tsc --noEmit -p . && npx vitest run src/superTabs && npm run test:super-tabs`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add backend
git commit -m "Super Tab routing: decision log, route messages and person override"
```

---

### Task 4: Link decisions to starts and assignments; model and effort on starts

**Files:**
- Modify: `backend/src/superTabs/commands.ts`, `backend/src/superTabs/model.ts` (`AgentStartRequest`), `backend/src/superTabs/store.ts` (simplify the Task 3 guard)
- Test: `backend/src/superTabs/commands.test.ts`, `backend/integration/superTabs.test.ts`

**Interfaces:**
- Consumes: `RouteDecision`, `RouteFinal`, `RouteOverride`, `routeTitle` (Task 3).
- Produces:
  - `work.assign` and `agent.start` accept optional `routeDecisionId` and `overrideReason` (≤ 300).
  - `startRequestSchema` accepts optional `model` (≤ 200) and `effort` (≤ 80); `AgentStartRequest` gains `model?: string; effort?: string`.
  - A mismatch with the expected candidate without `overrideReason` → `OVERRIDE_REASON_REQUIRED` (400). A decision from another group → `ROUTE_MISMATCH` (409).
  - With a reason, a Lead override posts `source: {kind: 'route-override', decisionId, by: 'lead'}`.

- [ ] **Step 1: Write the failing unit tests** (append to `commands.test.ts`; reuse `record()`/`candidate()` from Task 3)

```ts
describe('decisions linked to work', () => {
  const open = (patch: Record<string, unknown> = {}) => ({ id: 'd1', conversationId: 'lead', record: record(), final: null, override: null, assignmentId: null, outcome: null, ...patch })

  it('links an assignment of the picked member, and needs a reason otherwise', () => {
    const f = fixture()
    const member = record({ candidates: [candidate('c0', { kind: 'member', agentId: f.worker }), candidate('c1')], pick: 'c0' })
    f.define('lead')
    const linked = f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker, routeDecisionId: 'd1' }, f.leadActor, { routeDecision: open({ record: member }) })
    expect(linked.routeDecisions).toEqual([{ op: 'final', id: 'd1', final: { kind: 'member', agentId: f.worker, machineId: expect.any(String) }, assignmentId: linked.result.assignmentId }])
  })

  it('refuses a mismatch without a reason and records the lead override with one', () => {
    const f = fixture()
    f.define('lead')
    expect(() => f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker, routeDecisionId: 'd1' }, f.leadActor, { routeDecision: open() }))
      .toThrow('reason')
    const effects = f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker, routeDecisionId: 'd1', overrideReason: 'This worker already has the context.' }, f.leadActor, { routeDecision: open() })
    expect(effects.routeDecisions[0]).toMatchObject({ op: 'final', override: { by: 'lead', reason: 'This worker already has the context.' } })
    expect(effects.messages.some(m => m.source?.kind === 'route-override')).toBe(true)
  })

  it('refuses a decision from another group', () => {
    const f = fixture()
    f.define('lead')
    expect(() => f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker, routeDecisionId: 'd1', overrideReason: 'x' }, f.leadActor,
      { routeDecision: open({ conversationId: 'other' }) })).toThrow('another group')
  })

  it('links a start that matches the picked new agent, model and effort', () => {
    const f = fixture()
    const request = { conversationId: 'lead', machineId: 'machine', engine: 'claude', model: 'opus', effort: 'high', name: 'Builder', cwd: '/repo', worktree: false,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    const effects = f.run({ type: 'agent.start', request, routeDecisionId: 'd1' }, f.leadActor, { routeDecision: open(), contribution: f.contribution })
    expect(effects.routeDecisions).toEqual([{ op: 'final', id: 'd1', final: { kind: 'new', startId: effects.result.startId, machineId: 'machine', engine: 'claude', model: 'opus', effort: 'high' } }])
  })

  it('links the assignment of an agent started from the decision', () => {
    const f = fixture()
    f.define('lead')
    const started = open({ final: { kind: 'new', startId: f.startedFor(f.worker), machineId: 'machine', engine: 'claude', model: 'opus', effort: 'high' } })
    const effects = f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker, routeDecisionId: 'd1' }, f.leadActor, { routeDecision: started })
    expect(effects.routeDecisions[0]).toMatchObject({ op: 'final', assignmentId: effects.result.assignmentId })
    expect(effects.routeDecisions[0]).not.toHaveProperty('override')
  })
})
```

Fixture helpers needed (add to the test's `fixture()` if missing): `f.worker` (a non-lead agent id in conversation `lead` on machine `machine`), `f.define(group)` (runs `work.define` with one check), `f.contribution` (the `context.contribution` the fixture already passes for `agent.add`), and `f.startedFor(agentId)` which pushes a completed start into `state.starts` with that agent's `harnessId`/`machineId` and returns its id.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/superTabs/commands.test.ts -t "decisions linked"`
Expected: FAIL (`routeDecisionId` rejected by the strict schema).

- [ ] **Step 3: Implement**

Schema changes in `commands.ts`:

```ts
// startRequestSchema gains:
  model: z.string().trim().min(1).max(200).optional(), effort: z.string().trim().min(1).max(80).optional(),
// commandSchema:
  z.object({ type: z.literal('agent.start'), request: startRequestSchema, routeDecisionId: id.optional(), overrideReason: reason.optional() }).strict(),
  z.object({ type: z.literal('work.assign'), conversationId: id, agentId: id, routeDecisionId: id.optional(), overrideReason: reason.optional() }).strict(),
```

`model.ts` `AgentStartRequest` gains `model?: string` and `effort?: string`.

Helpers in `applyCommand` (after `openDecision`):

```ts
  /** The candidate a start or assignment should match, and whether it does. A mismatch needs the lead's reason. */
  const linkDecision = (conversationId: string, matches: (c: RouteCandidate, d: RouteDecision) => boolean,
    final: RouteFinal, reasonText: string | undefined, assignmentId?: string) => {
    const decision = openDecision()
    if (decision.conversationId !== conversationId) fail('ROUTE_MISMATCH', 'This routing decision belongs to another group.')
    const expected = decision.record.candidates.find(c => c.id === (decision.override?.candidateId ?? decision.record.pick))!
    const matched = matches(expected, decision)
    if (!matched && !reasonText) fail('OVERRIDE_REASON_REQUIRED', `Routing chose ${expected.title}. Pass overrideReason to choose otherwise.`, 400)
    const override: RouteOverride | undefined = matched ? undefined : { by: 'lead', actorKey: actorKey(actor), reason: reasonText! }
    effects.routeDecisions.push({ op: 'final', id: decision.id, final, ...(override ? { override } : {}), ...(assignmentId ? { assignmentId } : {}) })
    return { decision, expected, override }
  }
```

Import `RouteCandidate`, `RouteFinal`, `RouteOverride` types from `./routeRecord.js`.

In `case 'agent.start'`, after `result.startId = operationId`:

```ts
      if (command.routeDecisionId) {
        const r = command.request
        const model = r.model ?? 'default', effort = r.effort ?? 'default'
        const { decision, expected, override } = linkDecision(r.conversationId,
          c => c.kind === 'new' && c.machineId === r.machineId && c.engine === r.engine && c.model === model && c.effort === effort,
          { kind: 'new', startId: operationId, machineId: r.machineId, engine: r.engine, model, effort }, command.overrideReason)
        if (override) message(r.conversationId, `Lead started ${r.name} instead of ${expected.title}. Reason: ${override.reason}`, [], null,
          { kind: 'route-override', decisionId: decision.id, by: 'lead' })
      }
```

`message()` sets `result.messageId`; that is harmless here.

In `case 'work.assign'`, after `result.assignmentId = operationId` and **before** the existing `message(...)` call to the worker (so the worker's brief remains the last message and `result.messageId` stays the brief's id), compute the link; post the override note after the brief:

```ts
      let routeNote: { decisionId: string; text: string } | null = null
      if (command.routeDecisionId) {
        const started = (d: RouteDecision) => d.final?.kind === 'new' &&
          state.starts?.some(s => s.id === (d.final as { startId: string }).startId && s.harnessId === worker.harnessId && s.request.machineId === worker.machineId)
        const { decision, expected, override } = linkDecision(group.id,
          (c, d) => (c.kind === 'member' && c.agentId === worker.id) || (c.kind === 'new' && !!started(d)),
          { kind: 'member', agentId: worker.id, machineId: worker.machineId }, command.overrideReason, operationId)
        if (override) routeNote = { decisionId: decision.id, text: `Lead assigned ${worker.name} instead of ${expected.title}. Reason: ${override.reason}` }
      }
      // existing: message(group.id, `${group.brief}...`, [worker.id])
      if (routeNote) effects.messages.push({ id: stableId(operationId, 'route-override'), conversationId: group.id, author: sender,
        text: routeNote.text, replyTo: null, recipients: [], source: { kind: 'route-override', decisionId: routeNote.decisionId, by: 'lead' } })
```

The second message needs its own id (`stableId(operationId, 'route-override')`) because message ids are unique.

In `store.ts`, replace the Task 3 guard with the typed field:

```ts
      const decisionId = command.type === 'route.override' ? command.decisionId
        : command.type === 'work.assign' || command.type === 'agent.start' ? command.routeDecisionId : undefined
```

- [ ] **Step 4: Run unit tests**

Run: `cd backend && npx vitest run src/superTabs/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing integration test**

```ts
  it('closes a linked decision with the assignment outcome', async () => {
    const { tab, lead } = await fixture()
    const group = (await run(tab, { type: 'conversation.create', title: 'Build', brief: 'Build it.', checks: [{ description: 'Tests pass', independent: false }] })).result.conversationId as string
    const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Builder', configuration: config, lead: false })).result.agentId as string
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Small.' },
      candidates: [{ id: 'c0', kind: 'member', agentId: worker, machineId: 'test-host', engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2, cost: 2, title: 'Builder', label: 'Member Builder' }],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate.' }
    const routeDecisionId = (await run(tab, { type: 'route.record', conversationId: group, decision } as Command, host, lead)).result.routeDecisionId as string
    const assignmentId = (await run(tab, { type: 'work.assign', conversationId: group, agentId: worker, routeDecisionId } as Command, host, lead)).result.assignmentId as string
    expect(await store.routeDecision(owner, tab, routeDecisionId)).toMatchObject({ assignmentId, final: { kind: 'member', agentId: worker } })
    // Completing needs check evidence (existing rule); stopping needs a host receipt. Use the existing stop path:
    await store.stopped(host, tab, assignmentId, 'Stopped by fixture.')
    await run(tab, { type: 'work.status', conversationId: group, assignmentId, status: 'stopped', result: null } as Command, host, lead)
    expect((await store.routeDecision(owner, tab, routeDecisionId)).outcome).toBe('stopped')
  })
```

If `store.stopped(...)` needs a different argument shape, follow the existing integration test that stops an assignment.

- [ ] **Step 6: Run backend checks**

Run: `cd backend && npx tsc --noEmit -p . && npm test && npm run test:super-tabs`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add backend
git commit -m "Super Tab routing: link decisions to starts and assignments"
```

---

## Phase B — CLI

### Task 5: Pure routing core

**Files:**
- Create: `cli/src/superTabs/route.ts`
- Test: `cli/src/superTabs/route.spec.ts`
- Create: `cli/vitest.super-tabs.config.ts`; modify `cli/package.json` (script `test:super-tabs`)

**Interfaces:**
- Consumes: `jevPick` from `cli/src/lib/routeDecide.ts`; `JevChoice`, `JevChoiceAnswer` from `cli/src/lib/jev/jevClient.ts`; `quotaOf` shape from `cli/src/superTabs/capacity.ts`.
- Produces (exact names used by Task 6):

```ts
export type Level = 'low' | 'medium' | 'high'
export interface Assessment { difficulty: Level; risk: Level; why: string; needs: { tools: string[]; devices: string[]; cwd?: string } }
export interface PolicyModel { engine: 'claude' | 'codex'; model: string; effort: string; quality: number; cost: number; enabled: boolean }
export interface Policy { version: 1; models: PolicyModel[]; floor: Record<Level, number>; quotaReserve: number; notes: string }
export interface Quota { known: boolean; leftPercent: number | null; resetsAt: number | null }
export interface Probe {
  kind: 'member' | 'new'; agentId?: string; name?: string; machineId: string; machineName: string
  engine: 'claude' | 'codex'; model: string; effort: string; quality: number; cost: number
  quota: Quota; activity: string; known: boolean; refusals: string[]
}
export interface Shown extends Probe { id: string; title: string; label: string }
export interface Choice { shown: Shown[]; excluded: Array<{ title: string; reason: string }>; floor: number; belowFloor: boolean }
export interface Verdict { pick: Shown; via: 'jev' | 'order' | 'only'; p: number | null; why: string }
export function parseAssessment(value: unknown): Assessment | string        // string = error detail
export function floorFor(policy: Policy, a: Assessment): number
export function quotaOf2(q: { known: boolean; windows: Array<{ usedPercent: number; resetsAt: unknown }> }): Quota
export function rateFor(policy: Policy, engine: string, model: string | null, effort: string | null): { quality: number; cost: number }
export function choose(probes: Probe[], policy: Policy, a: Assessment): Choice | { error: 'NO_CANDIDATE'; excluded: Array<{ title: string; reason: string }> }
export function jevQuestion(input: { title: string; brief: string; checks: string[]; history: string[] }, a: Assessment, policy: Policy, choice: Choice):
  { state: Record<string, string>; questions: Record<string, JevChoice> }
export function decide(choice: Choice, answer: JevChoiceAnswer | undefined, unavailable: string | null): Verdict
export function recordOf(choice: Choice, verdict: Verdict, a: Assessment, policy: Policy): Record<string, unknown>   // routeRecordSchema payload
```

- [ ] **Step 1: Write the failing tests**

```ts
// cli/src/superTabs/route.spec.ts
import { describe, expect, it } from 'vitest'
import { choose, decide, floorFor, jevQuestion, parseAssessment, quotaOf2, rateFor, recordOf, type Assessment, type Policy, type Probe } from './route.js'

const policy: Policy = { version: 1, floor: { low: 1, medium: 2, high: 3 }, quotaReserve: 10, notes: 'Frontend prefers Claude.', models: [
  { engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3, enabled: true },
  { engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2, enabled: true },
  { engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2, cost: 2, enabled: true },
  { engine: 'claude', model: 'haiku', effort: 'auto', quality: 1, cost: 1, enabled: false },
] }
const a = (patch: Partial<Assessment> = {}): Assessment => ({ difficulty: 'medium', risk: 'low', why: 'API change.', needs: { tools: [], devices: [] }, ...patch })
const probe = (patch: Partial<Probe> = {}): Probe => ({ kind: 'new', machineId: 'm1', machineName: 'remote-1', engine: 'claude', model: 'sonnet',
  effort: 'medium', quality: 2, cost: 2, quota: { known: true, leftPercent: 50, resetsAt: 1_000 }, activity: 'new', known: true, refusals: [], ...patch })

describe('assessment and floor', () => {
  it('parses a Lead assessment and explains what is wrong', () => {
    expect(parseAssessment({ difficulty: 'high', risk: 'low', why: ' Schema. ', needs: { tools: ['git'] } }))
      .toEqual({ difficulty: 'high', risk: 'low', why: 'Schema.', needs: { tools: ['git'], devices: [] } })
    expect(parseAssessment({ difficulty: 'hard', risk: 'low', why: 'x' })).toContain('difficulty')
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x'.repeat(301) })).toContain('300')
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', needs: { cwd: 'relative' } })).toContain('absolute')
    expect(parseAssessment(null)).toContain('difficulty')
  })
  it('raises the floor by one for high risk, to at most 3', () => {
    expect(floorFor(policy, a())).toBe(2)
    expect(floorFor(policy, a({ risk: 'high' }))).toBe(3)
    expect(floorFor(policy, a({ difficulty: 'high', risk: 'high' }))).toBe(3)
  })
})

describe('quota and rates', () => {
  it('normalizes reset times from epoch seconds, milliseconds and ISO strings and uses the tightest window', () => {
    expect(quotaOf2({ known: true, windows: [{ usedPercent: 20, resetsAt: 1_800_000_000 }, { usedPercent: 70, resetsAt: '2026-10-19T12:00:00Z' }] }))
      .toEqual({ known: true, leftPercent: 30, resetsAt: Date.parse('2026-10-19T12:00:00Z') })
    expect(quotaOf2({ known: true, windows: [{ usedPercent: 10, resetsAt: 1_800_000_000 }] }).resetsAt).toBe(1_800_000_000_000)
    expect(quotaOf2({ known: true, windows: [{ usedPercent: 10, resetsAt: 1_800_000_000_000 }] }).resetsAt).toBe(1_800_000_000_000)
    expect(quotaOf2({ known: true, windows: [{ usedPercent: 10, resetsAt: 'soon' }] }).resetsAt).toBeNull()
    expect(quotaOf2({ known: false, windows: [] })).toEqual({ known: false, leftPercent: null, resetsAt: null })
  })
  it('rates a member by its policy row, then by model, else conservatively', () => {
    expect(rateFor(policy, 'claude', 'opus', 'high')).toEqual({ quality: 3, cost: 3 })
    expect(rateFor(policy, 'claude', 'opus', 'max')).toEqual({ quality: 3, cost: 3 })
    expect(rateFor(policy, 'claude', null, null)).toEqual({ quality: 1, cost: 1 })
  })
})

describe('choose', () => {
  it('returns NO_CANDIDATE with reasons when nothing can run', () => {
    expect(choose([probe({ refusals: ['Machine is offline.'] })], policy, a())).toEqual({ error: 'NO_CANDIDATE',
      excluded: [{ title: 'New agent · Claude sonnet medium · remote-1', reason: 'Machine is offline.' }] })
  })
  it('shows only floor-meeting candidates, ordered by cost, quota, reset and member first', () => {
    const r = choose([
      probe({ model: 'opus', effort: 'high', quality: 3, cost: 3 }),
      probe({ machineId: 'm2', machineName: 'mac', quota: { known: true, leftPercent: 80, resetsAt: 5_000 } }),
      probe({ quota: { known: true, leftPercent: 80, resetsAt: 2_000 } }),
      probe({ kind: 'member', agentId: 'a1', name: 'Multiply', quota: { known: true, leftPercent: 80, resetsAt: 2_000 }, activity: 'idle' }),
      probe({ model: 'haiku', effort: 'auto', quality: 1, cost: 1 }),
    ], policy, a())
    if ('error' in r) throw new Error('unexpected')
    expect(r.belowFloor).toBe(false)
    expect(r.shown.map(s => s.title)).toEqual([
      'Multiply · Claude sonnet medium · remote-1',
      'New agent · Claude sonnet medium · remote-1',
      'New agent · Claude sonnet medium · mac',
      'New agent · Claude sonnet medium · remote-1',
      'New agent · Claude opus high · remote-1',
    ])
    expect(r.shown.map(s => s.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])
  })
  it('marks belowFloor when nobody meets it, keeps the quota reserve, and prefers known candidates', () => {
    const r = choose([probe({ quality: 1 }), probe({ quality: 1, quota: { known: true, leftPercent: 5, resetsAt: null } })], policy, a({ difficulty: 'high' }))
    if ('error' in r) throw new Error('unexpected')
    expect(r.belowFloor).toBe(true)
    expect(r.shown).toHaveLength(1)
    const onlyReserve = choose([probe({ quota: { known: true, leftPercent: 5, resetsAt: null } })], policy, a())
    if ('error' in onlyReserve) throw new Error('unexpected')
    expect(onlyReserve.shown).toHaveLength(1)
    const unknown = choose([probe({ known: false, quota: { known: false, leftPercent: null, resetsAt: null } }), probe()], policy, a())
    if ('error' in unknown) throw new Error('unexpected')
    expect(unknown.shown.map(s => s.known)).toEqual([true])
  })
  it('shows at most 12 candidates', () => {
    const r = choose(Array.from({ length: 20 }, (_, i) => probe({ machineId: `m${i}`, machineName: `box-${String(i).padStart(2, '0')}` })), policy, a())
    if ('error' in r) throw new Error('unexpected')
    expect(r.shown).toHaveLength(12)
  })
})

describe('Jev context and verdict', () => {
  const choice = () => { const r = choose([probe({ kind: 'member', agentId: 'a1', name: 'Multiply', activity: 'idle' }), probe({ machineName: 'mac' })], policy, a()); if ('error' in r) throw new Error('x'); return r }
  it('builds at most four string keys within the hosted limits, with no email', () => {
    const q = jevQuestion({ title: 'Build', brief: 'b'.repeat(5000), checks: ['Tests pass', 'Docs updated'], history: ['Builder: stopped'] }, a(), policy, choice())
    expect(Object.keys(q.state)).toEqual(['task', 'lead', 'policy', 'history'])
    expect(Object.values(q.state).every(v => typeof v === 'string')).toBe(true)
    expect(Object.values(q.state).join('').length).toBeLessThanOrEqual(17_000)
    expect(q.state.task.length).toBeLessThan(5000)
    expect(q.state.policy).toContain('Frontend prefers Claude.')
    expect(Object.keys(q.questions.who.criteria)).toEqual(['c0', 'c1'])
    expect(Object.values(q.questions.who.criteria).every(v => v.length <= 640)).toBe(true)
    expect(q.questions.who.instructions.length).toBeLessThanOrEqual(1500)
    expect(JSON.stringify(q)).not.toMatch(/@/)
  })
  it('takes a sure Jev pick, falls back to order when unsure or unavailable, and skips Jev for one candidate', () => {
    const c = choice()
    expect(decide(c, { choice: 'c1', probabilities: { c0: 0.2, c1: 0.8 } }, null)).toMatchObject({ via: 'jev', p: 0.8, pick: { id: 'c1' } })
    expect(decide(c, { choice: 'c1', probabilities: { c0: 0.45, c1: 0.55 } }, null)).toMatchObject({ via: 'order', pick: { id: 'c0' }, why: expect.stringContaining('Jev unsure') })
    expect(decide(c, undefined, 'BUSY')).toMatchObject({ via: 'order', pick: { id: 'c0' }, why: expect.stringContaining('Jev unavailable') })
    const one = choose([probe()], policy, a()); if ('error' in one) throw new Error('x')
    expect(decide(one, undefined, null)).toMatchObject({ via: 'only', p: null })
  })
  it('broken Jev answers fall back to order', () => {
    const c = choice()
    expect(decide(c, { choice: 'c9', probabilities: { c0: 0.1, c9: 0.9 } }, null).via).toBe('order')
    expect(decide(c, { choice: 'c1', probabilities: { c1: 0.9 } }, null).via).toBe('order')
  })
  it('produces a record the backend schema accepts', () => {
    const c = choice(), v = decide(c, { choice: 'c1', probabilities: { c0: 0.2, c1: 0.8 } }, null)
    expect(recordOf(c, v, a(), policy)).toEqual({ assessment: { difficulty: 'medium', risk: 'low', why: 'API change.' },
      candidates: c.shown.map(s => ({ id: s.id, kind: s.kind, ...(s.agentId ? { agentId: s.agentId } : {}), machineId: s.machineId,
        engine: s.engine, model: s.model, effort: s.effort, quality: s.quality, cost: s.cost, title: s.title, label: s.label })),
      excluded: [], floor: 2, notes: true, pick: 'c1', via: 'jev', p: 0.8, belowFloor: false, why: v.why })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cli && npx vitest run src/superTabs/route.spec.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `route.ts`**

```ts
// cli/src/superTabs/route.ts
/** Super Tab routing v1, the pure half (docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md).
 * The system removes what cannot run the task, Jev chooses among the rest with the full context, and a
 * fixed policy order decides when Jev is unsure or unavailable. Jev's acceptance rule is the voice
 * router's (`jevPick`), tuned on the owner's desk on 2026-10-10. */
import { isAbsolute } from 'node:path'
import type { JevChoice, JevChoiceAnswer } from '../lib/jev/jevClient.js'
import { jevPick } from '../lib/routeDecide.js'

export type Level = 'low' | 'medium' | 'high'
export interface Assessment { difficulty: Level; risk: Level; why: string; needs: { tools: string[]; devices: string[]; cwd?: string } }
export interface PolicyModel { engine: 'claude' | 'codex'; model: string; effort: string; quality: number; cost: number; enabled: boolean }
export interface Policy { version: 1; models: PolicyModel[]; floor: Record<Level, number>; quotaReserve: number; notes: string }
export interface Quota { known: boolean; leftPercent: number | null; resetsAt: number | null }
export interface Probe {
  kind: 'member' | 'new'; agentId?: string; name?: string; machineId: string; machineName: string
  engine: 'claude' | 'codex'; model: string; effort: string; quality: number; cost: number
  quota: Quota; activity: string; known: boolean; refusals: string[]
}
export interface Shown extends Probe { id: string; title: string; label: string }
export interface Choice { shown: Shown[]; excluded: Array<{ title: string; reason: string }>; floor: number; belowFloor: boolean }
export interface Verdict { pick: Shown; via: 'jev' | 'order' | 'only'; p: number | null; why: string }

const LEVELS: Level[] = ['low', 'medium', 'high']
const MAX_SHOWN = 12
const ENGINE = { claude: 'Claude', codex: 'Codex' } as const
const cut = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1)}…`

export function parseAssessment(value: unknown): Assessment | string {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  if (!LEVELS.includes(v.difficulty as Level)) return 'Set difficulty to low, medium or high.'
  if (!LEVELS.includes(v.risk as Level)) return 'Set risk to low, medium or high.'
  const why = typeof v.why === 'string' ? v.why.trim() : ''
  if (!why || why.length > 300) return 'Give why in 1 to 300 characters.'
  const needs = (v.needs && typeof v.needs === 'object' ? v.needs : {}) as Record<string, unknown>
  const list = (x: unknown) => Array.isArray(x) && x.every(i => typeof i === 'string') ? x as string[] : []
  const cwd = needs.cwd
  if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd))) return 'needs.cwd must be an absolute path.'
  return { difficulty: v.difficulty as Level, risk: v.risk as Level, why, needs: { tools: list(needs.tools), devices: list(needs.devices), ...(cwd ? { cwd } : {}) } }
}

export const floorFor = (policy: Policy, a: Assessment): number => Math.min(3, policy.floor[a.difficulty] + (a.risk === 'high' ? 1 : 0))

/** Claude sends ISO strings, Codex epoch seconds; anything above 1e10 is already milliseconds. */
function resetMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e10 ? value : value * 1000
  if (typeof value === 'string') { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null }
  return null
}
export function quotaOf2(q: { known: boolean; windows: Array<{ usedPercent: number; resetsAt: unknown }> }): Quota {
  if (!q.known || !q.windows.length) return { known: false, leftPercent: null, resetsAt: null }
  const tightest = q.windows.reduce((x, y) => y.usedPercent > x.usedPercent ? y : x)
  return { known: true, leftPercent: Math.max(0, 100 - tightest.usedPercent), resetsAt: resetMs(tightest.resetsAt) }
}

export function rateFor(policy: Policy, engine: string, model: string | null, effort: string | null): { quality: number; cost: number } {
  const row = policy.models.find(m => m.engine === engine && m.model === (model ?? 'default') && m.effort === (effort ?? 'default'))
    ?? policy.models.find(m => m.engine === engine && m.model === (model ?? 'default'))
  return row ? { quality: row.quality, cost: row.cost } : { quality: 1, cost: 1 }
}

const titleOf = (p: Probe) => cut(`${p.kind === 'member' ? p.name ?? 'Member' : 'New agent'} · ${ENGINE[p.engine]} ${p.model} ${p.effort} · ${p.machineName}`, 160)
function quotaText(q: Quota): string {
  if (!q.known || q.leftPercent === null) return 'quota unknown'
  if (q.resetsAt === null) return `quota ${Math.round(q.leftPercent)}% left`
  return `quota ${Math.round(q.leftPercent)}% left, resets ${new Date(q.resetsAt).toISOString()}`
}
const labelOf = (p: Probe) => cut(`${p.kind === 'member' ? `Member ${p.name ?? ''}`.trim() : 'New agent'} · ${ENGINE[p.engine]} ${p.model} ${p.effort} · quality ${p.quality}, cost ${p.cost} · ${p.machineName} · ${p.activity} · ${quotaText(p.quota)}`, 640)

/** The fixed policy order (D): cheaper, then more quota left, then an earlier reset, then a member, then by title. */
function compare(x: Probe, y: Probe): number {
  return x.cost - y.cost
    || (y.quota.leftPercent ?? -1) - (x.quota.leftPercent ?? -1)
    || (x.quota.resetsAt ?? Infinity) - (y.quota.resetsAt ?? Infinity)
    || (x.kind === y.kind ? 0 : x.kind === 'member' ? -1 : 1)
    || titleOf(x).localeCompare(titleOf(y))
}

export function choose(probes: Probe[], policy: Policy, a: Assessment): Choice | { error: 'NO_CANDIDATE'; excluded: Array<{ title: string; reason: string }> } {
  const excluded = probes.filter(p => p.refusals.length).map(p => ({ title: titleOf(p), reason: p.refusals.join(' ') }))
  const viable = probes.filter(p => !p.refusals.length)
  if (!viable.length) return { error: 'NO_CANDIDATE', excluded }
  const known = viable.filter(p => p.known)
  const pool = known.length ? known : viable
  const reserved = pool.filter(p => p.quota.leftPercent === null || p.quota.leftPercent >= policy.quotaReserve)
  const funded = reserved.length ? reserved : pool
  const floor = floorFor(policy, a)
  const meeting = funded.filter(p => p.quality >= floor)
  const set = meeting.length ? meeting : funded
  const shown = [...set].sort(compare).slice(0, MAX_SHOWN)
    .map((p, i) => ({ ...p, id: `c${i}`, title: titleOf(p), label: labelOf(p) }))
  return { shown, excluded, floor, belowFloor: !meeting.length }
}

const INSTRUCTIONS = cut([
  'Choose the candidate that should do this task.',
  'The Lead assessed its difficulty and risk; every candidate shown meets the quality floor unless the policy says none does.',
  'Prefer lower cost, then more quota left and an earlier reset, unless the task, its history or the policy notes give a clear reason otherwise.',
  'A candidate that already failed or stopped on this task is a worse choice. An idle member already in the Super Tab saves a start.',
].join(' '), 1500)

export function jevQuestion(input: { title: string; brief: string; checks: string[]; history: string[] }, a: Assessment, policy: Policy, choice: Choice) {
  const state = {
    task: cut(`Group: ${cut(input.title, 160)}\nBrief: ${cut(input.brief, 2000)}\nChecks:\n${cut(input.checks.map(c => `- ${c}`).join('\n'), 2000)}`, 4400),
    lead: cut(`Difficulty: ${a.difficulty}. Risk: ${a.risk}. Why: ${a.why}. Needs tools: ${a.needs.tools.join(', ') || 'none'}; devices: ${a.needs.devices.join(', ') || 'none'}.`, 800),
    policy: cut(`Quality floor: ${choice.floor}${choice.belowFloor ? ' (no candidate meets it; all are shown)' : ''}. Notes: ${policy.notes || 'none'}`, 700),
    history: cut(input.history.length ? input.history.join('\n') : 'No earlier attempts.', 2000),
  }
  const questions: Record<string, JevChoice> = {
    who: { type: 'choice', instructions: INSTRUCTIONS, criteria: Object.fromEntries(choice.shown.map(s => [s.id, s.label])) },
  }
  return { state, questions }
}

export function decide(choice: Choice, answer: JevChoiceAnswer | undefined, unavailable: string | null): Verdict {
  const first = choice.shown[0]
  if (choice.shown.length === 1) return { pick: first, via: 'only', p: null, why: 'Only candidate that can run this task.' }
  const picked = unavailable ? undefined : jevPick(answer, choice.shown.map(s => s.id), true)
  if (picked) {
    const pick = choice.shown.find(s => s.id === picked)!
    return { pick, via: 'jev', p: answer!.probabilities[picked], why: `Jev chose ${pick.title}.` }
  }
  const reason = unavailable ? `Jev unavailable (${unavailable})` : 'Jev unsure'
  return { pick: first, via: 'order', p: null, why: `${reason}; first in the policy order.` }
}

export function recordOf(choice: Choice, verdict: Verdict, a: Assessment, policy: Policy): Record<string, unknown> {
  return {
    assessment: { difficulty: a.difficulty, risk: a.risk, why: a.why },
    candidates: choice.shown.map(s => ({ id: s.id, kind: s.kind, ...(s.agentId ? { agentId: s.agentId } : {}), machineId: s.machineId,
      engine: s.engine, model: s.model, effort: s.effort, quality: s.quality, cost: s.cost, title: s.title, label: s.label })),
    excluded: choice.excluded.slice(0, 200).map(e => ({ title: e.title, reason: cut(e.reason, 500) })),
    floor: choice.floor, notes: policy.notes.length > 0,
    pick: verdict.pick.id, via: verdict.via, p: verdict.p, belowFloor: choice.belowFloor, why: cut(verdict.why, 300),
  }
}
```

- [ ] **Step 4: Add the coverage gate**

```ts
// cli/vitest.super-tabs.config.ts
import { defineConfig } from 'vitest/config'
import base from './vitest.config.js'

/** Super Tab routing v1 (docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md): new files outside
 *  the core and services, which no other gate covers, held to 100% in every file. */
const FILES = ['src/superTabs/route.ts', 'src/superTabs/routeCommand.ts']
export default defineConfig({
  test: {
    ...base.test,
    include: FILES.map(f => f.replace(/\.ts$/, '.spec.ts')),
    coverage: { enabled: true, provider: 'v8', include: FILES, thresholds: { perFile: true, lines: 100, statements: 100, branches: 100, functions: 100 } },
  },
})
```

Add to `cli/package.json` scripts: `"test:super-tabs": "vitest run --config vitest.super-tabs.config.ts"`. Until Task 6 creates `routeCommand.ts`, list only `route.ts` in `FILES`; Task 6 adds the second entry.

- [ ] **Step 5: Run tests**

Run: `cd cli && npx tsc --noEmit -p . && npm run test:super-tabs`
Expected: PASS, 100% for `route.ts`. If a branch is uncovered, add the missing case to `route.spec.ts` (do not lower the threshold).

- [ ] **Step 6: Commit**

```bash
git add cli/src/superTabs/route.ts cli/src/superTabs/route.spec.ts cli/vitest.super-tabs.config.ts cli/package.json
git commit -m "Super Tab routing: pure candidate order, Jev context and verdict"
```

---

### Task 6: `harness super-tab route`, service actions and start passthrough

**Files:**
- Create: `cli/src/superTabs/routeCommand.ts`, `cli/src/superTabs/routeCommand.spec.ts`
- Modify: `cli/src/superTabs/service.ts` (+ `service.spec.ts`), `cli/src/superTabs/command.ts` (+ `command.spec.ts`), `cli/src/superTabs/start.ts` (+ `start.spec.ts`), `cli/vitest.super-tabs.config.ts`

**Interfaces:**
- Consumes: everything Task 5 produces; `inspectCapacity(target, request)` and `quotaOf` (`start.ts`, `capacity.ts`); `openDaemon`, `Where` (`cli/src/agentClient/daemon.ts`); `machineChoices` (`cli/src/lib/newCommand.ts`); `createJevDecide` (`cli/src/lib/jev/jevClient.ts`); `encodeRuntimeProfile` (`cli/src/engines/kit/runtime.ts`).
- Produces:
  - Service actions (after the caller is verified as a running contribution): `routeContext` → `{ ok: true, value: { tab, policy, machines } }`; `routeJev` `{ state, questions }` → `{ ok: true, value: { answers } }` or `{ ok: true, value: { unavailable: code } }`.
  - `routeTask(input: { tabId: string; conversationId: string; assessment: unknown }, scoped: ScopedRequest, where: Where, open?: typeof openDaemon, newId?: () => string): Promise<Record<string, unknown>>`
  - CLI verb: `harness super-tab --tab ID route GROUP JSON`.
  - `start OPERATION_ID JSON` accepts `routeDecisionId`, `overrideReason`, `model`, `effort` inside JSON.

- [ ] **Step 1: Write failing service tests** (append to `cli/src/superTabs/service.spec.ts`, using its existing `fakeCore` setup that already answers `GET /api/super-tabs/:tab?asAgentId=` with a state whose agent is running on this machine)

```ts
  it('returns the routing context to a verified contribution', async () => {
    const t = setup()   // the spec's existing helper; extend its backend mock with the two paths below
    t.answer('GET', `/api/super-tabs/tab/routing-policy?asAgentId=${t.agentId}`, { policy: { version: 1 }, warnings: [], overridden: [] })
    t.core.account.machines = vi.fn(async () => ({ status: 200, body: { success: true, data: { machines: [{ machineId: 'm1', name: 'remote-1', status: 'online' }], sharedMachines: [] } } }))
    const reply = await t.request({ action: 'routeContext', tabId: 'tab', harnessId: 'harness' })
    expect(reply).toEqual({ ok: true, value: { tab: expect.objectContaining({ state: expect.any(Object) }),
      policy: { policy: { version: 1 }, warnings: [], overridden: [] }, machines: [{ machineId: 'm1', name: 'remote-1' }] } })
  })
  it('asks Jev with a three-second limit and reports unavailability instead of failing', async () => {
    const decide = vi.fn(async () => ({ who: { choice: 'c1', probabilities: { c0: 0.2, c1: 0.8 } } }))
    const t = setup({ jev: () => decide })
    expect(await t.request({ action: 'routeJev', tabId: 'tab', harnessId: 'harness', state: { task: 't' }, questions: { who: {} } }))
      .toEqual({ ok: true, value: { answers: { who: { choice: 'c1', probabilities: { c0: 0.2, c1: 0.8 } } } } })
    expect(decide.mock.calls[0][2]).toBeInstanceOf(AbortSignal)
    decide.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'BUSY' }))
    expect(await t.request({ action: 'routeJev', tabId: 'tab', harnessId: 'harness', state: {}, questions: {} }))
      .toEqual({ ok: true, value: { unavailable: 'BUSY' } })
  })
```

If `service.spec.ts` has no `setup()` with `answer()`/`request()` helpers, write them at the top of the new `describe`: build `fakeCore({ account: { backend: vi.fn(async (method, path) => ...) } })` and call `superTabService(core, options).requests.super_tabs(payload, { owner: true, local: true }, new AbortController().signal)` as the existing tests in that file do.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd cli && npx vitest run src/superTabs/service.spec.ts -t "routing context|asks Jev"`
Expected: FAIL (`INVALID_REQUEST`).

- [ ] **Step 3: Implement the service actions** (`cli/src/superTabs/service.ts`)

```ts
import { createJevDecide, type JevDecide } from '../lib/jev/jevClient.js'
import { machineChoices } from '../lib/newCommand.js'
// SuperTabServiceOptions gains:
  /** Jev for `route`; Harness's hosted key through the backend when the person has no key of their own. */
  jev?: (core: CoreApi) => JevDecide
// after `if (payload.action === 'status') return { ok: true, value: answer }`:
        if (payload.action === 'routeContext') {
          const [policy, machines] = await Promise.all([
            backend(core, 'GET', `${path}/routing-policy?${identity}`),
            core.account.machines(),
          ])
          const data = object(object(machines.body).data)
          return { ok: true, value: { tab: answer, policy,
            machines: machineChoices(data, null).filter(m => !m.toAdd).map(m => ({ machineId: m.machineId, name: m.label })) } }
        }
        if (payload.action === 'routeJev') {
          const decide = (options.jev ?? (api => createJevDecide({ backend: (m, p, b) => api.account.backend(m, p, b) })))(core)
          try {
            // Routing never waits on Jev beyond three seconds; the policy order decides instead.
            return { ok: true, value: { answers: await decide(payload.state, object(payload.questions) as never, AbortSignal.timeout(3000)) } }
          } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'UNAVAILABLE'
            return { ok: true, value: { unavailable: code } }
          }
        }
```

`machineChoices` lists the account's own machines and the shared ones it may use; `toAdd` machines refuse this account, so they are dropped.

Add to `HELP`:

```ts
  route: 'route GROUP JSON: before starting or assigning work, choose who does it. JSON: {"difficulty":"low|medium|high","risk":"low|medium|high","why":"one sentence","needs":{"tools":[],"devices":[],"cwd":"/absolute/repo"}}. Start or assign the pick with its routeDecisionId; to choose otherwise, pass overrideReason.',
```

and in `startRequest` add `model: 'opus', effort: 'high', routeDecisionId: 'DECISION'`; in the `work.assign` entry of `commands` add `routeDecisionId: 'DECISION'`.

- [ ] **Step 4: Run service tests**

Run: `cd cli && npx vitest run src/superTabs/service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write failing `routeTask` tests** (`cli/src/superTabs/routeCommand.spec.ts`)

```ts
import { describe, expect, it, vi } from 'vitest'
import { routeTask } from './routeCommand.js'

const policy = { version: 1, floor: { low: 1, medium: 2, high: 3 }, quotaReserve: 10, notes: '', models: [
  { engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3, enabled: true },
  { engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2, cost: 2, enabled: true },
  { engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2, enabled: false },
] }
const tab = { revision: 3, state: { id: 'tab', agents: [
  { id: 'a1', name: 'Multiply', machineId: 'm1', harnessId: 'h1', configuration: { engine: 'claude', model: 'sonnet', effort: 'medium' } },
  { id: 'lead', name: 'Lead', machineId: 'm1', harnessId: 'hl', configuration: { engine: 'claude', model: 'opus', effort: 'high' } },
], conversations: [
  { id: 'lead', title: 'Lead', leadId: 'lead', agentIds: ['lead', 'a1'], archived: false, brief: '', checks: [], assignment: { id: 'x', agentId: 'lead', status: 'working' } },
  { id: 'g1', title: 'API', leadId: 'lead', agentIds: ['lead'], archived: false, brief: 'Add the endpoint.', checks: [{ description: 'Tests pass' }], assignment: null },
] } }
const usage = { providers: [{ provider: 'claude', outcome: 'answered', httpStatus: 200, account: 'acct', body: { five_hour: { utilization: 40, resets_at: '2026-10-19T12:00:00Z' }, seven_day: { utilization: 10 } } }] }
function daemon(machineId: string, options: { offline?: boolean; agents?: string[] } = {}) {
  return {
    machineId, close: vi.fn(),
    request: vi.fn(async (type: string) => {
      if (type === 'agents_list') return { agents: (options.agents ?? []).map(id => ({ id, terminal: { available: true } })) }
      if (type === 'super_tabs') return { resources: { memoryTotalBytes: 8e9, memoryUsedBytes: 1e9, cpuPercent: 10, projectDiskFreeBytes: 1e11 }, tools: {}, devices: {} }
      if (type === 'engines_probe') return { engines: [{ engine: 'claude', installed: true, signedIn: true }] }
      if (type === 'usage_read') return usage
      return {}
    }),
  }
}
function scoped(answers: { jev?: unknown; record?: unknown } = {}) {
  return vi.fn(async (payload: Record<string, any>) => {
    if (payload.action === 'routeContext') return { ok: true, value: { tab, policy: { policy, warnings: [] }, machines: [{ machineId: 'm1', name: 'remote-1' }, { machineId: 'm2', name: 'mac' }] } }
    if (payload.action === 'routeJev') return answers.jev ?? { ok: true, value: { answers: { who: { choice: 'c1', probabilities: { c0: 0.1, c1: 0.9 } } } } }
    if (payload.action === 'command') return answers.record ?? { ok: true, value: { result: { routeDecisionId: 'd1' } } }
    return { error: 'UNEXPECTED' }
  })
}
const where = { port: 1, dataDir: '/nonexistent', machineId: 'm1' }
const input = { tabId: 'tab', conversationId: 'g1', assessment: { difficulty: 'medium', risk: 'low', why: 'Endpoint.' } }

describe('routeTask', () => {
  it('collects members and new agents, asks Jev, records and returns the pick', async () => {
    const s = scoped()
    const open = vi.fn(async (_w: unknown, id: string) => daemon(id, { agents: id === 'm1' ? ['h1'] : [] }) as never)
    const result = await routeTask(input, s, where as never, open, () => 'op')
    expect(result).toMatchObject({ ok: true, routeDecisionId: 'd1', via: 'jev', pick: { id: 'c1' } })
    const record = s.mock.calls.find(c => c[0].action === 'command')![0]
    expect(record).toMatchObject({ operationId: 'route-op', command: { type: 'route.record', conversationId: 'g1' } })
    // The busy Lead is not a candidate; the idle member Multiply is.
    const titles = (record.command.decision.candidates as Array<{ title: string }>).map(c => c.title)
    expect(titles).toContain('Multiply · Claude sonnet medium · remote-1')
    expect(titles.some(t => t.startsWith('Lead'))).toBe(false)
  })
  it('returns NO_CANDIDATE with reasons when every machine is unreachable', async () => {
    const open = vi.fn(async () => { throw Object.assign(new Error('gone'), { code: 'MACHINE_UNAVAILABLE' }) })
    const result = await routeTask(input, scoped(), where as never, open as never)
    expect(result).toMatchObject({ error: 'NO_CANDIDATE' })
    expect((result.excluded as Array<{ reason: string }>).every(e => /offline or unreachable/.test(e.reason))).toBe(true)
  })
  it('falls back to the policy order when Jev is unavailable, and still routes when recording fails', async () => {
    const open = vi.fn(async (_w: unknown, id: string) => daemon(id, { agents: id === 'm1' ? ['h1'] : [] }) as never)
    const result = await routeTask(input, scoped({ jev: { ok: true, value: { unavailable: 'BUSY' } }, record: { error: 'BACKEND_UNAVAILABLE' } }), where as never, open)
    expect(result).toMatchObject({ ok: true, via: 'order', unrecorded: true })
    expect(result).not.toHaveProperty('routeDecisionId')
  })
  it('refuses an invalid assessment, an unknown group and a failed context read', async () => {
    const open = vi.fn()
    expect(await routeTask({ ...input, assessment: { difficulty: 'x' } }, scoped(), where as never, open as never)).toMatchObject({ error: 'INVALID_REQUEST' })
    expect(await routeTask({ ...input, conversationId: 'nope' }, scoped(), where as never, open as never)).toMatchObject({ error: 'NOT_FOUND' })
    const failing = vi.fn(async () => ({ error: 'AGENT_UNAVAILABLE', detail: 'x' }))
    expect(await routeTask(input, failing, where as never, open as never)).toMatchObject({ error: 'AGENT_UNAVAILABLE' })
  })
})
```

- [ ] **Step 6: Run to verify failure**

Run: `cd cli && npx vitest run src/superTabs/routeCommand.spec.ts`
Expected: FAIL (module missing).

- [ ] **Step 7: Implement `routeCommand.ts`**

```ts
// cli/src/superTabs/routeCommand.ts
/** `harness super-tab route GROUP JSON`: the Lead's routing step (docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md).
 * Reads the tab, the effective policy and the account's machines; probes each machine once per engine with
 * the same admission `start` uses; then orders, asks Jev, and records the decision in the tab. */
import { randomUUID } from 'node:crypto'
import { openDaemon, type Daemon, type Where } from '../agentClient/daemon.js'
import { inspectCapacity, type ScopedRequest } from './start.js'
import { object } from './wire.js'
import { choose, decide, jevQuestion, parseAssessment, quotaOf2, rateFor, recordOf, type Assessment, type Policy, type Probe } from './route.js'
import type { JevChoiceAnswer } from '../lib/jev/jevClient.js'

type Json = Record<string, unknown>
const ENGINES = ['claude', 'codex'] as const
const OFFLINE = 'Machine is offline or unreachable.'
const active = (assignment: unknown) => { const a = object(assignment); return !!a.id && !['done', 'stopped'].includes(String(a.status)) }

export async function routeTask(input: { tabId: string; conversationId: string; assessment: unknown }, scoped: ScopedRequest, where: Where,
  open: typeof openDaemon = openDaemon, newId: () => string = randomUUID): Promise<Json> {
  const assessment = parseAssessment(input.assessment)
  if (typeof assessment === 'string') return { error: 'INVALID_REQUEST', detail: assessment }
  const context = await scoped({ action: 'routeContext' })
  if (context.error || context.ok !== true) return context
  const value = object(context.value), state = object(object(value.tab).state), effective = object(value.policy)
  const policy = effective.policy as unknown as Policy
  const conversations = Array.isArray(state.conversations) ? state.conversations.map(object) : []
  const group = conversations.find(c => c.id === input.conversationId)
  if (!group) return { error: 'NOT_FOUND', detail: 'No such group in this Super Tab.' }
  const busy = new Set(conversations.filter(c => active(c.assignment)).map(c => String(object(c.assignment).agentId)))
  const members = (Array.isArray(state.agents) ? state.agents.map(object) : [])
    .filter(a => !busy.has(String(a.id)) && ENGINES.includes(String(object(a.configuration).engine) as never))
  const machines = new Map<string, string>()
  for (const m of Array.isArray(value.machines) ? value.machines.map(object) : []) machines.set(String(m.machineId), String(m.name))
  for (const m of members) if (!machines.has(String(m.machineId))) machines.set(String(m.machineId), String(m.machineId))
  const enabled = policy.models.filter(m => m.enabled)

  const probes = (await Promise.all([...machines].map(([machineId, machineName]) =>
    probeMachine(machineId, machineName, members.filter(m => m.machineId === machineId), enabled, policy, assessment, where, open)))).flat()
  const choice = choose(probes, policy, assessment)
  if ('error' in choice) return choice

  let answer: JevChoiceAnswer | undefined, unavailable: string | null = null
  if (choice.shown.length > 1) {
    const checks = Array.isArray(group.checks) ? group.checks.map(c => String(object(c).description ?? '')) : []
    // The group's last attempt, when it ended: a worker that stopped on this task is a worse choice.
    const last = object(group.assignment), agents = Array.isArray(state.agents) ? state.agents.map(object) : []
    const history = last.id && !active(last)
      ? [`${String(agents.find(a => a.id === last.agentId)?.name ?? 'An agent')}: ${String(last.status)}${typeof last.result === 'string' ? ` — ${last.result.slice(0, 300)}` : ''}`]
      : []
    const question = jevQuestion({ title: String(group.title ?? ''), brief: String(group.brief ?? ''), checks, history }, assessment, policy, choice)
    const reply = await scoped({ action: 'routeJev', ...question })
    const jev = object(reply.value)
    if (reply.ok !== true || typeof jev.unavailable === 'string') unavailable = typeof jev.unavailable === 'string' ? jev.unavailable : 'UNAVAILABLE'
    else answer = object(jev.answers).who as JevChoiceAnswer | undefined
  }
  const verdict = decide(choice, answer, unavailable)
  const recorded = await scoped({ action: 'command', operationId: `route-${newId()}`,
    command: { type: 'route.record', conversationId: input.conversationId, decision: recordOf(choice, verdict, assessment, policy) } })
  const routeDecisionId = recorded.ok === true ? object(object(recorded.value).result).routeDecisionId : undefined
  const publicOf = (s: typeof verdict.pick) => ({ id: s.id, kind: s.kind, ...(s.agentId ? { agentId: s.agentId } : {}), machineId: s.machineId,
    engine: s.engine, model: s.model, effort: s.effort, title: s.title })
  return {
    ok: true, ...(typeof routeDecisionId === 'string' ? { routeDecisionId } : { unrecorded: true }),
    pick: publicOf(verdict.pick), via: verdict.via, p: verdict.p, belowFloor: choice.belowFloor, why: verdict.why,
    alternatives: choice.shown.filter(s => s.id !== verdict.pick.id).slice(0, 2).map(publicOf),
    warnings: Array.isArray(effective.warnings) ? effective.warnings : [],
    next: verdict.pick.kind === 'member'
      ? `Assign with: command OPERATION_ID {"type":"work.assign","conversationId":"${input.conversationId}","agentId":"${verdict.pick.agentId}","routeDecisionId":"${routeDecisionId ?? ''}"}`
      : `Start with: start OPERATION_ID {..., "machineId":"${verdict.pick.machineId}","engine":"${verdict.pick.engine}","model":"${verdict.pick.model}","effort":"${verdict.pick.effort}","routeDecisionId":"${routeDecisionId ?? ''}"}, then assign the started agent with the same routeDecisionId.`,
  }
}

async function probeMachine(machineId: string, machineName: string, members: Json[], models: Policy['models'], policy: Policy,
  a: Assessment, where: Where, open: typeof openDaemon): Promise<Probe[]> {
  const engines = [...new Set([...models.map(m => m.engine), ...members.map(m => String(object(m.configuration).engine) as 'claude' | 'codex')])]
  const memberProbe = (m: Json, refusals: string[], quota = { known: false, leftPercent: null, resetsAt: null } as Probe['quota']): Probe => {
    const c = object(m.configuration), engine = String(c.engine) as 'claude' | 'codex'
    const model = typeof c.model === 'string' ? c.model : null, effort = typeof c.effort === 'string' ? c.effort : null
    return { kind: 'member', agentId: String(m.id), name: String(m.name ?? 'Member'), machineId, machineName, engine,
      model: model ?? 'default', effort: effort ?? 'default', ...rateFor(policy, engine, model, effort),
      quota, activity: 'idle', known: quota.known, refusals }
  }
  const newProbe = (m: Policy['models'][number], refusals: string[], quota: Probe['quota'], known: boolean): Probe => ({
    kind: 'new', machineId, machineName, engine: m.engine, model: m.model, effort: m.effort, quality: m.quality, cost: m.cost,
    quota, activity: 'new agent', known, refusals })
  let target: Daemon
  try { target = await open(where, machineId) } catch {
    return [...members.map(m => memberProbe(m, [OFFLINE])), ...models.map(m => newProbe(m, [OFFLINE], { known: false, leftPercent: null, resetsAt: null }, false))]
  }
  try {
    const listed = object(await target.request('agents_list', {}, 10_000).catch(() => ({})))
    const live = new Set((Array.isArray(listed.agents) ? listed.agents.map(object) : [])
      .filter(f => object(f.terminal).available !== false).map(f => String(f.id)))
    const byEngine = new Map<string, Awaited<ReturnType<typeof inspectCapacity>>>()
    for (const engine of engines) {
      byEngine.set(engine, await inspectCapacity(target, { engine, cwd: a.needs.cwd ?? '/', worktree: false,
        requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: a.needs.tools, devices: a.needs.devices, quotaRequired: false } }))
    }
    const probes: Probe[] = []
    for (const m of members) {
      const inspected = byEngine.get(String(object(m.configuration).engine))!
      const quota = quotaOf2(inspected.quota)
      const refusals = [
        ...(live.has(String(m.harnessId)) ? [] : ['Its terminal is not running.']),
        ...inspected.reasons.filter(r => /usage window|Required tool|Required device/.test(r)),
      ]
      probes.push(memberProbe(m, refusals, quota))
    }
    for (const m of models) {
      const inspected = byEngine.get(m.engine)!
      probes.push(newProbe(m, inspected.allowed ? [] : inspected.reasons, quotaOf2(inspected.quota), inspected.unknown.length === 0 && inspected.quota.known))
    }
    return probes
  } finally { target.close() }
}
```

Add `'src/superTabs/routeCommand.ts'` to `FILES` in `cli/vitest.super-tabs.config.ts`.

- [ ] **Step 8: Wire the verb** (`cli/src/superTabs/command.ts`)

Update `USAGE` to add `| route GROUP JSON`. In the parser, before the final `else if (!['status', 'help']...)`:

```ts
else if (action === 'route' && identifier(first) && second && positional.length === 3) {
  Object.assign(payload, { conversationId: first, assessment: JSON.parse(second) })
}
```

In `superTabCommand`, beside the `capacity` branch:

```ts
} else if (request.payload.action === 'route') {
  result = await routeTask({ tabId: String(request.payload.tabId), conversationId: String(request.payload.conversationId),
    assessment: request.payload.assessment }, scoped, request.where, deps.open)
```

Add `import { routeTask } from './routeCommand.js'`. In `command.spec.ts`, add `['route', 'g1']` and `['route', '../x', '{}']` to the invalid-argv list, and one valid parse test:

```ts
  it('parses route GROUP JSON', () => {
    expect(parseSuperTabArgs(['--tab', 'tab', 'route', 'g1', '{"difficulty":"low","risk":"low","why":"x"}']).payload)
      .toMatchObject({ action: 'route', conversationId: 'g1', assessment: { difficulty: 'low' } })
  })
```

(Use the parser's real exported name in `command.ts`; the spec file already imports it.)

- [ ] **Step 9: Start passthrough and model application** (`cli/src/superTabs/start.ts`)

In `startAgent`, replace the `agent.start` command build:

```ts
  if (input.action === 'start') {
    const { routeDecisionId, overrideReason, ...request } = object(input.request)
    const result = requireSuccess(await scoped({ action: 'command', operationId: input.operationId,
      command: { type: 'agent.start', request, ...(routeDecisionId ? { routeDecisionId } : {}), ...(overrideReason ? { overrideReason } : {}) } }))
    startId = object(result.result).startId
  }
```

After `if (native.state !== 'created') return {...}` and before reading `frame.selectedModel`:

```ts
    // agent_create takes no model or effort; a routed start applies them through the
    // ordinary runtime switch. `default` keeps what the engine launched with.
    let modelWarning: string | undefined
    const model = text(request.model), effort = text(request.effort)
    if (model && effort && !(model === 'default' && effort === 'default')) {
      const reply = await target.request('agent_update', { agentId: nativeId,
        selectedModel: encodeRuntimeProfile({ sessionId: String(nativeId), engine: String(request.engine) as never, model, effort: effort as never }) }, 60_000).catch(() => ({ error: 'MODEL_UNAVAILABLE' }))
      if (reply.error) modelWarning = `Started with the engine's own model; switching to ${model} ${effort} failed (${String(reply.error)}).`
      else Object.assign(frame, object(reply.agent))
    }
```

Add `...(modelWarning ? { modelWarning } : {})` to the final success return, and `import { encodeRuntimeProfile } from '../engines/kit/runtime.js'`.

Add tests to `start.spec.ts` with its existing fake daemon:
- a start with `routeDecisionId` and `overrideReason` sends them at the command's top level and not inside `request`;
- a start with `model: 'opus', effort: 'high'` calls `agent_update` with `selectedModel: 'runtime-v1:<harnessId>:claude:opus@high'`;
- `model: 'default', effort: 'default'` makes no `agent_update` call;
- an `agent_update` error returns `ok: true` with `modelWarning`.

- [ ] **Step 10: Run CLI checks**

Run: `cd cli && npx tsc --noEmit -p . && npm run test:super-tabs && npx vitest run src/superTabs && npm run test:core`
Expected: all PASS; `test:super-tabs` at 100% for both files.

- [ ] **Step 11: Commit**

```bash
git add cli
git commit -m "Super Tab routing: the route command, Jev and the routed start"
```

---

### Task 7: Lead instructions and the end-to-end route

**Files:**
- Modify: `desktop/lib/super_tabs/launch.dart` (Lead prompt, around lines 120–141)
- Modify: `cli/src/superTabs/host.ts` (`prompt()`, around line 318)
- Modify: `cli/e2e/harness/fakeBackend.ts` (add `/api/route/jev`)
- Create: `cli/e2e/superTabRoute.e2e.ts`
- Test: `desktop/test/super_tab_launch_test.dart` (prompt assertion)

**Interfaces:**
- Consumes: `harness super-tab route` (Task 6); backend shapes from Tasks 2–4.
- Produces: the Lead prompt line and the delivery prompt line naming `route`.

- [ ] **Step 1: Write the failing prompt test** (append to `desktop/test/super_tab_launch_test.dart`, next to the existing assertions on the Lead prompt text)

```dart
  test('the Lead prompt routes before starting or assigning work', () {
    final prompt = superTabLeadPromptForTest(tabId: 'tab');   // use the file's existing prompt builder or test seam
    expect(prompt, contains('route GROUP'));
    expect(prompt, contains('routeDecisionId'));
    expect(prompt, contains('overrideReason'));
  });
```

If `launch.dart` has no test seam for the prompt, assert on the prompt captured by the existing launch test's fake connection (`agent_create` payload `prompt`).

- [ ] **Step 2: Run to verify it fails**

Run: `cd desktop && flutter test test/super_tab_launch_test.dart`
Expected: FAIL (text missing).

- [ ] **Step 3: Add the instruction**

In `launch.dart`, after the sentence that begins `'For work groups, assignments, acceptance evidence and messages to other agents, use `$command help`. '`, add for the Lead variant:

```dart
'Before starting or assigning work, run `$command route GROUP JSON` with your difficulty and risk assessment, '
'then start or assign its pick with the routeDecisionId it returns. To choose otherwise, pass overrideReason. '
'If it answers NO_CANDIDATE, tell the person in the group why, using its reasons; do not guess another machine. '
```

Add one `routeCommand.spec.ts` case for the history line: a group whose `assignment` is `{id:'x', agentId:'a1', status:'stopped', result:'Tests failed.'}` makes the `routeJev` payload's `state.history` contain `Multiply: stopped — Tests failed.`.

In `host.ts` `prompt()`, change `Manage agreed work and delegation: ${command} help.` to `Manage agreed work and delegation: ${command} help. Route before starting or assigning: ${command} route GROUP JSON.`, and update the matching expectation in `host.spec.ts` if one asserts that sentence.

- [ ] **Step 4: Run the prompt tests**

Run: `cd desktop && flutter test test/super_tab_launch_test.dart && cd ../cli && npx vitest run src/superTabs/host.spec.ts`
Expected: PASS.

- [ ] **Step 5: Add the fake Jev route** (`cli/e2e/harness/fakeBackend.ts`)

Next to the `/api/experimental-settings` handler, add a public field and handler:

```ts
  /** `POST /api/route/jev`, Harness's hosted Jev. Unset answers 503 JEV_BUSY, which callers treat as unavailable. */
  jev: ((body: Record<string, any>) => Record<string, unknown>) | null = null
// in the request handler:
      if (req.url?.split('?')[0] === '/api/route/jev' && req.method === 'POST') {
        const body = await readJson(req)          // use the file's existing body reader
        if (!backend.jev) return send(res, 503, { success: false, error: { code: 'JEV_BUSY', message: 'Fixture Jev is off.' } })
        return send(res, 200, { success: true, data: backend.jev(body) })
      }
```

Use the file's real helpers for reading JSON and sending replies (the `/api/experimental-settings` handler shows them).

- [ ] **Step 6: Write the e2e test** (`cli/e2e/superTabRoute.e2e.ts`)

Model the setup on the first test in `cli/e2e/superTabs.e2e.ts` (same `ME`, `FakeBackend.start()`, `IsolatedDaemon.create(...)`, session file, `relay.superTabs` handler). The `relay.superTabs` handler must answer:

- `GET /api/super-tabs/TAB?asAgentId=…` → `{ data: { revision, state } }` with one idle member (a fake Claude harness created in the daemon, as the existing test creates one) and a group `g1` with a brief and one check;
- `GET /api/super-tabs/TAB/routing-policy?asAgentId=…` → `{ data: { policy: <Claude-only policy: sonnet medium q2 c2, opus high q3 c3>, warnings: [], overridden: [] } }`;
- `POST /api/super-tabs/TAB/commands` with `command.type === 'route.record'` → push the body to `records` and return `{ data: { revision, result: { routeDecisionId: 'd-' + records.length } } }`.

Two cases:

```ts
it('routes to Jev’s pick and records the decision', async () => {
  // setup as above; relay.jev = body => ({ who: { choice: 'c1', probabilities: { c0: 0.1, c1: 0.9 } } })
  const code = await superTabCommand({ argv: ['--tab', TAB, '--agent', leadAgentId, 'route', 'g1', JSON.stringify({ difficulty: 'medium', risk: 'low', why: 'Endpoint.' })] }, deps)
  expect(code).toBe(0)
  expect(records).toHaveLength(1)
  expect(records[0].command.decision).toMatchObject({ via: 'jev', pick: 'c1' })
})
it('falls back to the policy order when Jev is unavailable', async () => {
  // relay.jev = null
  // same call; expect records[0].command.decision.via === 'order' and pick === 'c0'
})
```

Call `superTabCommand` the way `superTabs.e2e.ts` does (its `deps`/printing capture), and read the printed JSON to assert `ok: true` and `routeDecisionId`.

- [ ] **Step 7: Run the e2e test**

Run: `cd cli && npx vitest run -c vitest.e2e.config.ts e2e/superTabRoute.e2e.ts`
Expected: 2 PASS. (Uses a private tmux server and data dir; never the developer's daemon.)

- [ ] **Step 8: Commit**

```bash
git add desktop/lib/super_tabs/launch.dart desktop/test/super_tab_launch_test.dart cli/src/superTabs/host.ts cli/src/superTabs/host.spec.ts cli/e2e
git commit -m "Super Tab routing: Lead instructions and an end-to-end route"
```

---

## Phase C — Desktop

### Task 8: Route rows and Change

**Files:**
- Create: `desktop/lib/super_tabs/route_row.dart`
- Modify: `desktop/lib/super_tabs/model.dart` (route getters on `SuperTabMessage`)
- Modify: `desktop/lib/super_tabs/view.dart` (`_message`, around line 1009)
- Test: `desktop/test/super_tab_route_test.dart`

**Interfaces:**
- Consumes: message `source` shapes from Tasks 3–4; `SuperTabController.command(Map)` and `request(method, path)`; `c.canWrite`.
- Produces:
  - `SuperTabMessage.route` → `SuperTabRoute?` (`decisionId`, `via`, `p`, `belowFloor`, `why`, `pick`, `alternatives`), `SuperTabMessage.routeOverride` → `bool`.
  - `SuperTabRouteRow({required SuperTabMessage message, required SuperTabRoute route, required SuperTabController controller})`.

- [ ] **Step 1: Write the failing widget tests**

```dart
// desktop/test/super_tab_route_test.dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/route_row.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

Map<String, dynamic> routeRow({String via = 'jev', double? p = 0.82, bool belowFloor = false}) => {
  'id': 'm1', 'conversationId': 'offline', 'text': 'Routed to Multiply', 'replyTo': null, 'sequence': 4,
  'author': {'kind': 'agent', 'id': 'lead', 'name': 'Lead'}, 'deliveries': const [],
  'source': {'kind': 'route', 'decisionId': 'd1', 'via': via, 'p': p, 'belowFloor': belowFloor, 'why': 'schema change, high risk',
    'pick': {'id': 'c0', 'title': 'Multiply · Claude opus high · remote-1'},
    'alternatives': [{'id': 'c1', 'title': 'New agent · Claude sonnet medium · mac'}]},
};

void main() {
  test('parses route sources', () {
    final message = SuperTabMessage.fromJson(routeRow());
    expect(message.route!.decisionId, 'd1');
    expect(message.route!.alternatives.single.title, startsWith('New agent'));
    expect(SuperTabMessage.fromJson({...routeRow(), 'source': {'kind': 'route-override', 'decisionId': 'd1', 'by': 'lead'}}).routeOverride, isTrue);
    expect(SuperTabMessage.fromJson({...routeRow(), 'source': {'kind': 'route', 'decisionId': 'd1'}}).route, isNull);
  });

  for (final c in [
    (via: 'jev', p: 0.82, below: false, text: 'Jev 82%'),
    (via: 'order', p: null, below: false, text: 'by policy order'),
    (via: 'only', p: null, below: true, text: 'Below quality floor'),
  ]) {
    testWidgets('renders ${c.via}', (tester) async {
      final f = SuperTabLaunchFixture();
      final controller = await f.app.superTabs.open(tabId);
      final message = SuperTabMessage.fromJson(routeRow(via: c.via, p: c.p, belowFloor: c.below));
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: SuperTabRouteRow(message: message, route: message.route!, controller: controller))));
      expect(find.textContaining('Routed to Multiply · Claude opus high · remote-1'), findsOneWidget);
      expect(find.textContaining(c.text), findsOneWidget);
      f.app.superTabs.dispose();
    });
  }

  testWidgets('Change needs write access and a reason, then sends route.override', (tester) async {
    final f = SuperTabLaunchFixture();
    final controller = await f.app.superTabs.open(tabId);
    await controller.refresh();
    final message = SuperTabMessage.fromJson(routeRow());
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SuperTabRouteRow(message: message, route: message.route!, controller: controller))));
    await tester.tap(find.text('Change'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('New agent · Claude sonnet medium · mac'));
    await tester.pumpAndSettle();
    final confirm = find.widgetWithText(FilledButton, 'Change');
    expect(tester.widget<FilledButton>(confirm).onPressed, isNull);
    await tester.enterText(find.byType(TextField), 'Opus quota is needed elsewhere.');
    await tester.pump();
    await tester.tap(confirm);
    await tester.pumpAndSettle();
    final sent = f.connection.calls.where((call) => (call.$2['path'] as String?)?.endsWith('/commands') == true).last.$2['body'] as Map;
    expect(sent['command'], {'type': 'route.override', 'decisionId': 'd1', 'candidateId': 'c1', 'reason': 'Opus quota is needed elsewhere.'});
    f.app.superTabs.dispose();
  });

  testWidgets('a viewer sees no Change', (tester) async {
    final f = SuperTabLaunchFixture();
    (f.connection.server.state['people'] as List)[0]['role'] = 'viewer';
    final controller = await f.app.superTabs.open(tabId);
    await controller.refresh();
    final message = SuperTabMessage.fromJson(routeRow());
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SuperTabRouteRow(message: message, route: message.route!, controller: controller))));
    expect(find.text('Change'), findsNothing);
    f.app.superTabs.dispose();
  });

  testWidgets('Change shows the refusal', (tester) async {
    final f = SuperTabLaunchFixture();
    f.connection.server.refuse = {'code': 'ROUTE_CLOSED', 'message': 'This routing decision is no longer open. Route the task again.'};
    final controller = await f.app.superTabs.open(tabId);
    await controller.refresh();
    final message = SuperTabMessage.fromJson(routeRow());
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SuperTabRouteRow(message: message, route: message.route!, controller: controller))));
    await tester.tap(find.text('Change'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('New agent'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Because.');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Change'));
    await tester.pumpAndSettle();
    expect(find.textContaining('no longer open'), findsOneWidget);
    f.app.superTabs.dispose();
  });
}
```

`SuperTabLaunchFixture`'s fake server (`super_tab_launch_test.dart`) may need a `refuse` field that makes the next `/commands` POST answer `{ok: false, error: code, detail: message}` the way the controller's other refusal tests expect; add it there if missing. Use how the controller surfaces command errors (`controller.error` or its snackbar) as the existing `super_tab_chat_test.dart` does.

- [ ] **Step 2: Run to verify failure**

Run: `cd desktop && flutter test test/super_tab_route_test.dart`
Expected: FAIL (missing file).

- [ ] **Step 3: Implement**

`model.dart` additions:

```dart
class SuperTabRouteChoice {
  const SuperTabRouteChoice(this.id, this.title);
  final String id, title;
}

class SuperTabRoute {
  SuperTabRoute._(this.decisionId, this.via, this.p, this.belowFloor, this.why, this.pick, this.alternatives);
  static SuperTabRoute? fromSource(Map<String, dynamic> s) {
    final pick = superTabMap(s['pick'] ?? const {});
    if (s['kind'] != 'route' || s['decisionId'] is! String || pick['id'] is! String || pick['title'] is! String) return null;
    return SuperTabRoute._(
      s['decisionId'] as String, s['via'] as String? ?? 'order', (s['p'] as num?)?.toDouble(), s['belowFloor'] == true,
      s['why'] as String? ?? '', SuperTabRouteChoice(pick['id'] as String, pick['title'] as String),
      [for (final a in (s['alternatives'] as List? ?? const []))
        if (a is Map && a['id'] is String && a['title'] is String) SuperTabRouteChoice(a['id'] as String, a['title'] as String)],
    );
  }
  final String decisionId, via, why;
  final double? p;
  final bool belowFloor;
  final SuperTabRouteChoice pick;
  final List<SuperTabRouteChoice> alternatives;
}
// in SuperTabMessage:
  SuperTabRoute? get route => SuperTabRoute.fromSource(source);
  bool get routeOverride => source['kind'] == 'route-override';
```

`route_row.dart`:

```dart
import 'dart:async';

import 'package:flutter/material.dart';

import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'model.dart';

/// One routing decision in the conversation: who was chosen, how, and why.
/// Writers can change it afterwards; the Lead is told to hand the task over.
class SuperTabRouteRow extends StatefulWidget {
  const SuperTabRouteRow({super.key, required this.message, required this.route, required this.controller});
  final SuperTabMessage message;
  final SuperTabRoute route;
  final SuperTabController controller;
  @override
  State<SuperTabRouteRow> createState() => _SuperTabRouteRowState();
}

class _SuperTabRouteRowState extends State<SuperTabRouteRow> {
  Map<String, dynamic>? _details;
  bool _expanded = false;

  String get _how => switch (widget.route.via) {
    'jev' => 'Jev ${((widget.route.p ?? 0) * 100).round()}%',
    'only' => 'only candidate',
    _ => widget.route.why.startsWith('Jev unavailable') ? 'by policy order (Jev unavailable)' : 'by policy order (Jev unsure)',
  };

  Future<void> _toggle() async {
    setState(() => _expanded = !_expanded);
    if (!_expanded || _details != null) return;
    try {
      final answer = await widget.controller.request('GET', '/api/super-tabs/${widget.controller.tabId}/route-decisions/${widget.route.decisionId}');
      if (mounted) setState(() => _details = answer);
    } catch (_) {
      if (mounted) setState(() => _details = const {'error': true});
    }
  }

  Future<void> _change() async {
    final choice = await showDialog<(SuperTabRouteChoice, String)>(context: context, builder: (_) => _ChangeDialog(route: widget.route));
    if (choice == null || !mounted) return;
    final messenger = ScaffoldMessenger.maybeOf(context);
    try {
      await widget.controller.command({'type': 'route.override', 'decisionId': widget.route.decisionId, 'candidateId': choice.$1.id, 'reason': choice.$2});
      final error = widget.controller.error;            // use the controller's real error field
      if (error != null) messenger?.showSnackBar(SnackBar(content: Text(error)));
    } catch (failure) {
      messenger?.showSnackBar(SnackBar(content: Text(failure.toString())));
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.route;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Wrap(spacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
          InkWell(onTap: _toggle, child: Text('Routed to ${r.pick.title} — $_how · "${r.why}"', style: DesktopChrome.metadata())),
          if (r.belowFloor)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(color: Colors.amber.withValues(alpha: 0.2), borderRadius: BorderRadius.circular(4)),
              child: Text('Below quality floor', style: DesktopChrome.metadata()),
            ),
          if (widget.controller.canWrite && r.alternatives.isNotEmpty)
            TextButton(onPressed: () => unawaited(_change()), child: const Text('Change')),
        ]),
        if (_expanded) _detailsView(),
      ]),
    );
  }

  Widget _detailsView() {
    final d = _details;
    if (d == null) return const Padding(padding: EdgeInsets.all(8), child: LinearProgressIndicator());
    if (d['error'] == true) return Text('Could not load this decision.', style: DesktopChrome.metadata());
    final record = superTabMap(d['record'] ?? const {});
    final candidates = (record['candidates'] as List? ?? const []).map((c) => superTabMap(c));
    final excluded = (record['excluded'] as List? ?? const []).map((c) => superTabMap(c));
    return Padding(
      padding: const EdgeInsets.only(left: 12, top: 4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Quality floor ${record['floor']}${record['notes'] == true ? ' · policy notes applied' : ''}', style: DesktopChrome.metadata()),
        for (final c in candidates) Text('${c['id']}: ${c['label']}', style: DesktopChrome.metadata()),
        for (final e in excluded) Text('Not possible: ${e['title']} — ${e['reason']}', style: DesktopChrome.metadata()),
      ]),
    );
  }
}

class _ChangeDialog extends StatefulWidget {
  const _ChangeDialog({required this.route});
  final SuperTabRoute route;
  @override
  State<_ChangeDialog> createState() => _ChangeDialogState();
}

class _ChangeDialogState extends State<_ChangeDialog> {
  SuperTabRouteChoice? _choice;
  final _reason = TextEditingController();
  @override
  void dispose() { _reason.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) {
    final ready = _choice != null && _reason.text.trim().isNotEmpty && _reason.text.trim().length <= 300;
    return AlertDialog(
      title: const Text('Change who does this task'),
      content: SizedBox(width: 480, child: Column(mainAxisSize: MainAxisSize.min, children: [
        for (final a in widget.route.alternatives)
          RadioListTile<SuperTabRouteChoice>(value: a, groupValue: _choice, title: Text(a.title), onChanged: (v) => setState(() => _choice = v)),
        TextField(controller: _reason, maxLength: 300, decoration: const InputDecoration(labelText: 'Reason'), onChanged: (_) => setState(() {})),
      ])),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(onPressed: ready ? () => Navigator.of(context).pop((_choice!, _reason.text.trim())) : null, child: const Text('Change')),
      ],
    );
  }
}
```

`controller.tabId`, `controller.request`, `controller.command` and `canWrite` exist (`controller.dart`). Replace `widget.controller.error` with how `SuperTabController` exposes the last command failure (read `retry()` in `controller.dart`).

In `view.dart` `_message(...)`, return the route row first:

```dart
    final route = message.route;
    if (route != null) {
      return SuperTabRouteRow(key: ValueKey('super-message-${message.id}'), message: message, route: route, controller: c);
    }
```

Override messages (`routeOverride`) render as ordinary rows; their text already names who chose what and why.

- [ ] **Step 4: Run tests**

Run: `cd desktop && flutter analyze lib/super_tabs test/super_tab_route_test.dart && flutter test test/super_tab_route_test.dart test/super_tab_chat_test.dart test/super_tab_view_test.dart`
Expected: no analyzer issues; all PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/lib/super_tabs desktop/test/super_tab_route_test.dart desktop/test/super_tab_launch_test.dart
git commit -m "Super Tab routing: route rows, details and Change"
```

---

### Task 9: Routing policy forms (Settings ▸ Routing and the Super Tab override)

**Files:**
- Create: `desktop/lib/super_tabs/routing_policy.dart`, `desktop/lib/super_tabs/routing_policy_form.dart`, `desktop/lib/settings/sections/routing_section.dart`
- Modify: `desktop/lib/settings/settings_section.dart`, `desktop/lib/settings/settings_body.dart`, `desktop/lib/super_tabs/view.dart` (sidebar footer, lines ~762–788)
- Test: `desktop/test/routing_policy_test.dart`, `desktop/test/settings_section_test.dart`

**Interfaces:**
- Consumes: backend `GET/POST /api/super-tabs/routing-policy`, `GET /api/super-tabs/:tabId/routing-policy`, command `tab.routingPolicy` (Task 2); `app.superTabs.map(method, path, {body})` (`SuperTabClient`).
- Produces:
  - `RoutingPolicy` (Dart) with `fromJson`, `toJson`, `copyWith`; `RoutingModel`.
  - `RoutingPolicyForm({required RoutingPolicy value, required ValueChanged<RoutingPolicy> onChanged, Set<String>? overridden, ValueChanged<String>? onUseDefault, bool readOnly = false})`.
  - `SettingsSection.routing` in the Agents group.
  - `showSuperTabRouting(BuildContext, SuperTabController, SuperTabClient)`.

- [ ] **Step 1: Write the failing tests**

```dart
// desktop/test/routing_policy_test.dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/routing_policy.dart';
import 'package:harness/super_tabs/routing_policy_form.dart';

final json = {
  'version': 1, 'floor': {'low': 1, 'medium': 2, 'high': 3}, 'quotaReserve': 10, 'notes': '',
  'models': [
    {'engine': 'claude', 'model': 'opus', 'effort': 'high', 'quality': 3, 'cost': 3, 'enabled': true},
    {'engine': 'codex', 'model': 'default', 'effort': 'default', 'quality': 3, 'cost': 2, 'enabled': true},
  ],
};

void main() {
  test('round-trips the backend policy', () {
    expect(RoutingPolicy.fromJson(json).toJson(), json);
  });

  testWidgets('edits a model, the floor, the reserve and the notes', (tester) async {
    RoutingPolicy? changed;
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(
      child: RoutingPolicyForm(value: RoutingPolicy.fromJson(json), onChanged: (v) => changed = v)))));
    await tester.tap(find.byKey(const ValueKey('routing-model-enabled-1')));
    await tester.pump();
    expect(changed!.models[1].enabled, isFalse);
    await tester.enterText(find.byKey(const ValueKey('routing-reserve')), '25');
    await tester.pump();
    expect(changed!.quotaReserve, 25);
    await tester.enterText(find.byKey(const ValueKey('routing-notes')), 'Frontend prefers Claude.');
    await tester.pump();
    expect(changed!.notes, 'Frontend prefers Claude.');
  });

  testWidgets('override mode offers Use account default per field and read-only hides edits', (tester) async {
    final used = <String>[];
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: RoutingPolicyForm(
      value: RoutingPolicy.fromJson(json), onChanged: (_) {}, overridden: const {'notes'}, onUseDefault: used.add)))));
    expect(find.text('Use account default'), findsOneWidget);
    await tester.tap(find.text('Use account default'));
    expect(used, ['notes']);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: RoutingPolicyForm(
      value: RoutingPolicy.fromJson(json), onChanged: (_) {}, readOnly: true)))));
    expect(tester.widget<Switch>(find.byKey(const ValueKey('routing-model-enabled-0'))).onChanged, isNull);
  });
}
```

In `desktop/test/settings_section_test.dart`, change the Agents group expectation to `[SettingsSection.connectors, SettingsSection.usage, SettingsSection.routing]`.

- [ ] **Step 2: Run to verify failure**

Run: `cd desktop && flutter test test/routing_policy_test.dart test/settings_section_test.dart`
Expected: FAIL.

- [ ] **Step 3: Implement the model**

```dart
// desktop/lib/super_tabs/routing_policy.dart
/// The Super Tab routing policy as the backend stores it (backend/src/superTabs/routingPolicy.ts).
class RoutingModel {
  const RoutingModel({required this.engine, required this.model, required this.effort, required this.quality, required this.cost, required this.enabled});
  factory RoutingModel.fromJson(Map<String, dynamic> j) => RoutingModel(engine: j['engine'] as String, model: j['model'] as String,
    effort: j['effort'] as String, quality: (j['quality'] as num).toInt(), cost: (j['cost'] as num).toInt(), enabled: j['enabled'] == true);
  final String engine, model, effort;
  final int quality, cost;
  final bool enabled;
  RoutingModel copyWith({int? quality, int? cost, bool? enabled}) => RoutingModel(engine: engine, model: model, effort: effort,
    quality: quality ?? this.quality, cost: cost ?? this.cost, enabled: enabled ?? this.enabled);
  Map<String, dynamic> toJson() => {'engine': engine, 'model': model, 'effort': effort, 'quality': quality, 'cost': cost, 'enabled': enabled};
  String get label => '${engine == 'claude' ? 'Claude' : 'Codex'} ${model == 'default' ? 'default model' : model}${effort == 'default' ? '' : ' $effort'}';
}

class RoutingPolicy {
  const RoutingPolicy({required this.models, required this.floor, required this.quotaReserve, required this.notes});
  factory RoutingPolicy.fromJson(Map<String, dynamic> j) {
    final floor = Map<String, dynamic>.from(j['floor'] as Map);
    return RoutingPolicy(
      models: [for (final m in j['models'] as List) RoutingModel.fromJson(Map<String, dynamic>.from(m as Map))],
      floor: {for (final k in const ['low', 'medium', 'high']) k: (floor[k] as num).toInt()},
      quotaReserve: (j['quotaReserve'] as num).toInt(), notes: j['notes'] as String? ?? '');
  }
  final List<RoutingModel> models;
  final Map<String, int> floor;
  final int quotaReserve;
  final String notes;
  RoutingPolicy copyWith({List<RoutingModel>? models, Map<String, int>? floor, int? quotaReserve, String? notes}) => RoutingPolicy(
    models: models ?? this.models, floor: floor ?? this.floor, quotaReserve: quotaReserve ?? this.quotaReserve, notes: notes ?? this.notes);
  Map<String, dynamic> toJson() => {'version': 1, 'floor': floor, 'quotaReserve': quotaReserve, 'notes': notes, 'models': [for (final m in models) m.toJson()]};
  /// Only the named fields, for a Super Tab override.
  Map<String, dynamic> fields(Set<String> names) => {for (final e in toJson().entries) if (names.contains(e.key)) e.key: e.value};
}
```

Make `toJson()` key order match the test's `json` map (Dart map equality ignores order, so `expect(..., json)` holds either way).

- [ ] **Step 4: Implement the form**

```dart
// desktop/lib/super_tabs/routing_policy_form.dart
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../widgets/desktop_chrome.dart';
import 'routing_policy.dart';

/// The routing policy editor, used by Settings ▸ Routing (account default) and
/// by a Super Tab's Routing dialog (override mode, with Use account default).
class RoutingPolicyForm extends StatelessWidget {
  const RoutingPolicyForm({super.key, required this.value, required this.onChanged, this.overridden, this.onUseDefault, this.readOnly = false});
  final RoutingPolicy value;
  final ValueChanged<RoutingPolicy> onChanged;
  final Set<String>? overridden;
  final ValueChanged<String>? onUseDefault;
  final bool readOnly;

  Widget _heading(String title, String field) => Row(children: [
    Expanded(child: Text(title, style: DesktopChrome.control())),
    if (overridden?.contains(field) == true && onUseDefault != null && !readOnly)
      TextButton(onPressed: () => onUseDefault!(field), child: const Text('Use account default')),
  ]);

  Widget _number(Key key, int current, int min, int max, ValueChanged<int> set) => SizedBox(width: 72, child: TextFormField(
    key: key, initialValue: '$current', enabled: !readOnly, keyboardType: TextInputType.number,
    inputFormatters: [FilteringTextInputFormatter.digitsOnly],
    onChanged: (text) { final n = int.tryParse(text); if (n != null && n >= min && n <= max) set(n); }));

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _heading('Models', 'models'),
      Text('Quality 1–3 and relative cost decide who is chosen. Turn a model off to never use it.', style: DesktopChrome.metadata()),
      for (final (i, m) in value.models.indexed)
        Row(children: [
          Switch(key: ValueKey('routing-model-enabled-$i'), value: m.enabled,
            onChanged: readOnly ? null : (on) => onChanged(value.copyWith(models: [...value.models]..[i] = m.copyWith(enabled: on)))),
          Expanded(child: Text(m.label)),
          Text('Quality ', style: DesktopChrome.metadata()),
          _number(ValueKey('routing-model-quality-$i'), m.quality, 1, 3, (q) => onChanged(value.copyWith(models: [...value.models]..[i] = m.copyWith(quality: q)))),
          Text(' Cost ', style: DesktopChrome.metadata()),
          _number(ValueKey('routing-model-cost-$i'), m.cost, 1, 100, (c) => onChanged(value.copyWith(models: [...value.models]..[i] = m.copyWith(cost: c)))),
        ]),
      const SizedBox(height: 12),
      _heading('Quality floor by difficulty', 'floor'),
      Row(children: [
        for (final level in const ['low', 'medium', 'high']) ...[
          Text('${level[0].toUpperCase()}${level.substring(1)} '),
          _number(ValueKey('routing-floor-$level'), value.floor[level]!, 1, 3, (n) => onChanged(value.copyWith(floor: {...value.floor, level: n}))),
          const SizedBox(width: 12),
        ],
      ]),
      Text('High risk raises the floor by one.', style: DesktopChrome.metadata()),
      const SizedBox(height: 12),
      _heading('Quota reserve', 'quotaReserve'),
      Row(children: [
        _number(const ValueKey('routing-reserve'), value.quotaReserve, 0, 90, (n) => onChanged(value.copyWith(quotaReserve: n))),
        const Text(' % — below this, an account is used only when nothing else can run the task.'),
      ]),
      const SizedBox(height: 12),
      _heading('Notes for Jev', 'notes'),
      TextFormField(key: const ValueKey('routing-notes'), initialValue: value.notes, enabled: !readOnly, maxLength: 500, maxLines: 3,
        decoration: const InputDecoration(hintText: 'For example: frontend prefers Claude; long jobs on remote-1.'),
        onChanged: (text) => onChanged(value.copyWith(notes: text))),
    ]);
  }
}
```

- [ ] **Step 5: Implement Settings ▸ Routing**

In `settings_section.dart`, add `routing(AppIcons.route, 'Routing', keywords: ['routing', 'models', 'quota', 'jev', 'super tab'])` (pick an existing `AppIcons` member if `route` does not exist, e.g. the one Connectors uses), and add it to the `'Agents'` group after `usage`. In `settings_body.dart`, add the `SettingsSection.routing => RoutingSection(app: ...)` case, passing what other sections receive.

```dart
// desktop/lib/settings/sections/routing_section.dart
import 'dart:async';

import 'package:flutter/material.dart';

import '../../shared/widgets/section_scaffold.dart';
import '../../state/app_state.dart';
import '../../super_tabs/routing_policy.dart';
import '../../super_tabs/routing_policy_form.dart';

/// The account's routing default for every Super Tab it owns.
class RoutingSection extends StatefulWidget {
  const RoutingSection({super.key, required this.app});
  final AppNotifier app;
  @override
  State<RoutingSection> createState() => _RoutingSectionState();
}

class _RoutingSectionState extends State<RoutingSection> {
  RoutingPolicy? _policy;
  int _revision = 0;
  String? _error;
  bool _saving = false;

  @override
  void initState() { super.initState(); unawaited(_load()); }

  Future<void> _load() async {
    try {
      final answer = await widget.app.superTabs.map('GET', '/api/super-tabs/routing-policy');
      if (!mounted) return;
      setState(() { _policy = RoutingPolicy.fromJson(Map<String, dynamic>.from(answer['policy'] as Map)); _revision = (answer['revision'] as num).toInt(); _error = null; });
    } catch (failure) {
      if (mounted) setState(() => _error = 'Could not load the routing policy. $failure');
    }
  }

  Future<void> _save() async {
    final policy = _policy;
    if (policy == null) return;
    setState(() => _saving = true);
    try {
      final answer = await widget.app.superTabs.map('POST', '/api/super-tabs/routing-policy', body: {'revision': _revision, 'policy': policy.toJson()});
      if (mounted) setState(() { _revision = (answer['revision'] as num).toInt(); _error = null; });
    } catch (failure) {
      if (mounted) setState(() => _error = 'Could not save. $failure');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final policy = _policy;
    return SectionScaffold(
      title: 'Routing',
      subtitle: 'How a Super Tab Lead chooses who does each task. Each Super Tab you own can override these.',
      child: SingleChildScrollView(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_error!)),
        if (policy == null && _error == null) const LinearProgressIndicator(),
        if (policy != null) ...[
          RoutingPolicyForm(value: policy, onChanged: (v) => setState(() => _policy = v)),
          const SizedBox(height: 12),
          FilledButton(onPressed: _saving ? null : () => unawaited(_save()), child: const Text('Save')),
        ],
      ])),
    );
  }
}
```

Use the real `SectionScaffold` import path and constructor (`shared/widgets/section_scaffold.dart`), and the real client field on `AppNotifier` (`superTabs`).

- [ ] **Step 6: Implement the Super Tab override**

In `view.dart`'s footer `Wrap`, after the Invite/People button, add:

```dart
TextButton(
  onPressed: c.snapshot != null ? () { _closeSidebar(); unawaited(showSuperTabRouting(context, c)); } : null,
  child: const Text('Routing'),
),
```

Add `showSuperTabRouting` to `route_row.dart` (it already imports the controller):

```dart
Future<void> showSuperTabRouting(BuildContext context, SuperTabController c) async {
  final answer = await c.request('GET', '/api/super-tabs/${c.tabId}/routing-policy');
  if (!context.mounted) return;
  var policy = RoutingPolicy.fromJson(superTabMap(answer['policy']));
  final overridden = {...(answer['overridden'] as List? ?? const []).cast<String>()};
  await showDialog<void>(context: context, builder: (dialogContext) => StatefulBuilder(builder: (context, update) => AlertDialog(
    title: const Text('Routing for this Super Tab'),
    content: SizedBox(width: 560, child: SingleChildScrollView(child: RoutingPolicyForm(
      value: policy, readOnly: !c.isOwner, overridden: overridden,
      onChanged: (v) => update(() { for (final f in _changedFields(policy, v)) overridden.add(f); policy = v; }),
      onUseDefault: (field) => update(() => overridden.remove(field)),
    ))),
    actions: [
      TextButton(onPressed: () => Navigator.of(dialogContext).pop(), child: Text(c.isOwner ? 'Cancel' : 'Close')),
      if (c.isOwner)
        FilledButton(onPressed: () async {
          await c.command({'type': 'tab.routingPolicy', 'policy': overridden.isEmpty ? null : policy.fields(overridden)});
          if (dialogContext.mounted) Navigator.of(dialogContext).pop();
        }, child: const Text('Save')),
    ],
  )));
}

Set<String> _changedFields(RoutingPolicy a, RoutingPolicy b) {
  final x = a.toJson(), y = b.toJson();
  return {for (final k in const ['models', 'floor', 'quotaReserve', 'notes']) if (x[k].toString() != y[k].toString()) k};
}
```

A field removed with **Use account default** keeps showing the merged value until the dialog reopens, which then reads the account value again; this is acceptable for v1.

Add a widget test to `routing_policy_test.dart` or `super_tab_route_test.dart`: open the dialog with the fixture (owner), change notes, Save → the last `/commands` body is `{'type': 'tab.routingPolicy', 'policy': {'notes': '...'}}`; as a viewer, no Save button.

- [ ] **Step 7: Run tests**

Run: `cd desktop && flutter analyze lib test && flutter test test/routing_policy_test.dart test/settings_section_test.dart test/settings_screen_test.dart test/settings_compact_test.dart test/super_tab_route_test.dart`
Expected: no analyzer issues; all PASS.

- [ ] **Step 8: Commit**

```bash
git add desktop
git commit -m "Super Tab routing: policy forms in Settings and each Super Tab"
```

---

## Phase D — Validation and delivery

### Task 10: Docs, full checks and the one manual Jev run

**Files:**
- Modify: `desktop/design/terminal-workspace.md` (one paragraph on route rows and Routing), `docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md` (fold in the planning rulings above)

- [ ] **Step 1: Update docs**

In the spec, apply the six rulings from the top of this plan (start `model`/`effort` via `agent_update`; outcomes `done|stopped|superseded`; Lead override messages; the decision read endpoint; `/api/super-tabs/routing-policy`; member rating). In `terminal-workspace.md`, add after the Super Tab paragraph:

```
A Lead routes each delegation with `harness super-tab route`. The decision appears in the
conversation as one row (who, how — Jev's confidence or the policy order — and why); owners and
collaborators can **Change** it with a reason, which tells the Lead to hand the task over.
Settings ▸ Routing holds the account's policy; a Super Tab's **Routing** overrides single fields.
```

- [ ] **Step 2: Run the affected suites together**

Run (in parallel, within the machine's capacity):
- `cd backend && npx tsc --noEmit -p . && npm test && npm run test:super-tabs`
- `cd cli && npx tsc --noEmit -p . && npm run test:super-tabs && npm run test:core && npx vitest run src/superTabs && npx vitest run -c vitest.e2e.config.ts e2e/superTabs.e2e.ts e2e/superTabRoute.e2e.ts` (Node 24: `PATH=$(dirname $(npx -y node@24 -e 'console.log(process.execPath)')):$PATH`)
- `cd desktop && flutter analyze && flutter test test/super_tab_*_test.dart test/routing_policy_test.dart test/settings_*_test.dart test/session_close_test.dart`

Expected: all PASS. Record the counts in the PR.

- [ ] **Step 3: One manual run with the real Jev**

On a test Super Tab (not the person's working tabs), with an isolated CLI build pointed at production, ask the Lead to route a small task and confirm the conversation shows the route row with `Jev NN%`. Record the tab, the decision id and the screenshot in the PR. Do not type into the person's real harnesses.

- [ ] **Step 4: Open the PR** (only when the owner asks)

Push the branch, open the PR with the validation record, keep it draft until the owner asks to mark it ready; then follow `AGENTS.md` (CI `ci/required`, independent review, `make merge-pr`, release backend → CLI → Desktop).
