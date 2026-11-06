// cli/src/superTabs/routePick.spec.ts
import { describe, expect, it } from 'vitest'
import { PM_ACCOUNT_NOTE } from './pmAccounts.js'
import { pickByOrder, type PickInput } from './routePick.js'
import { decide, decideByOrder, recordOf, type Assessment, type Catalog, type Choice, type Shown } from './route.js'

const NOW = 1_000_000_000, H = 3_600_000, D = 86_400_000
const catalog: Catalog = { grid: { strength: 2, models: [{ model: 'kimi k3', strength: 2 }] }, models: [
  { engine: 'claude', model: 'sonnet', effort: 'high', strength: 2, cost: 2, offered: true },
  { engine: 'claude', model: 'opus', effort: 'high', strength: 3, cost: 3, offered: true },
  { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', strength: 2, cost: 2, offered: true },
  { engine: 'codex', model: 'gpt-6-astra', effort: 'xhigh', strength: 3, cost: 3, offered: true },
] }
const small = (patch: Partial<Assessment> = {}): Assessment => ({ difficulty: 'low', risk: 'low', size: 'small', why: 'Fix a typo.', kind: 'fix',
  needs: { tools: [], devices: [] }, ...patch })
const big = (patch: Partial<Assessment> = {}): Assessment => small({ difficulty: 'high', size: 'large', why: 'Rebuild the sync.', kind: 'feature', ...patch })

let n = 0
/** A shown candidate: a new Claude Sonnet on its own account unless the patch says otherwise. [left] and [resets] are the weekly window. */
function row(patch: Partial<Shown> & { left?: number | null; resets?: number | null; account?: string; agents?: number } = {}): Shown {
  const { left = 50, resets = NOW + 3 * D, account, agents, ...rest } = patch
  const id = `c${n++}`
  return { id, title: id, label: id, kind: 'new', machineId: 'm1', machineName: 'mac-1', engine: 'claude', model: 'sonnet', effort: 'high', quality: 2, cost: 2,
    quota: { known: left !== null, leftPercent: left, resetsAt: resets, account: account ?? id,
      windows: left === null ? [] : [{ name: 'weekly', leftPercent: left, resetsAt: resets }] },
    activity: 'new agent', known: true, refusals: [], notes: [], load: { agents: agents ?? 0, freeMemoryBytes: null, hasFolder: null },
    fit: { status: 'fits', coverage: null, effectiveCost: 2, expiring: 0, spend: { '5-hour': 0, weekly: 0 }, account: account ?? id }, ...rest } as Shown
}
const grid = (patch: Partial<Shown> = {}): Shown => row({ model: 'default', effort: 'default', cost: 1, gridModel: 'moonshotai/kimi-k3', gridName: 'swarm', gridLabel: 'Kimi K3',
  gridKind: 'api', quota: { known: false, leftPercent: null, resetsAt: null }, ...patch })
const opus = (patch: Parameters<typeof row>[0] = {}) => row({ model: 'opus', quality: 3, cost: 3, ...patch })
const astra = (patch: Parameters<typeof row>[0] = {}) => row({ engine: 'codex', model: 'gpt-6-astra', effort: 'xhigh', quality: 3, cost: 3, ...patch })
const sol = (patch: Parameters<typeof row>[0] = {}) => row({ engine: 'codex', model: 'gpt-6.1-sol', ...patch })
const pick = (shown: Shown[], assessment: Assessment = small(), extra: Partial<PickInput> = {}) =>
  pickByOrder({ shown, catalog, assessment, now: NOW, conversationId: 'g1', ...extra })

describe('pickByOrder step 1: what the work needs', () => {
  it('small work goes to a grid model when one is offered, else to Sonnet or Sol at high effort', () => {
    const g = grid(), s = row(), o = opus()
    expect(pick([s, o, g])!.id).toBe(g.id)
    expect(pick([o, s])!.id).toBe(s.id)
  })

  it('big, hard or risky work goes to Opus high or Astra xhigh, never to a grid model or the smaller model', () => {
    const o = opus(), a = astra(), s = row(), g = grid()
    expect([o.id, a.id]).toContain(pick([s, g, o, a], big())!.id)
    expect(pick([s, g, o], big({ difficulty: 'low', risk: 'high', size: 'small' }))!.id).toBe(o.id)
  })

  it('a review goes to the strong tier and never to a grid model, even when nothing else is offered', () => {
    const o = opus(), g = grid()
    expect(pick([g, o], small({ kind: 'review' }))!.id).toBe(o.id)
    expect(pick([g], small({ kind: 'review' }))).toBeNull()
  })

  it('a model at the wrong effort comes after one at the tier\'s effort', () => {
    const low = row({ effort: 'medium' }), high = row()
    expect(pick([low, high])!.id).toBe(high.id)
  })
})

describe('pickByOrder step 2: accounts with weekly quota left', () => {
  it('takes the account resetting soonest, then the one with the most left', () => {
    const later = row({ left: 90, resets: NOW + 5 * D }), sooner = row({ left: 20, resets: NOW + 1 * D }), soonerMore = row({ left: 60, resets: NOW + 1 * D })
    expect(pick([later, sooner, soonerMore])!.id).toBe(soonerMore.id)
    expect(pick([later, sooner])!.id).toBe(sooner.id)
  })

  it('leaves out an account under 5% for big work and under 2% for small work, a review or a test', () => {
    const low = row({ left: 4, resets: NOW + 1 * D }), fine = row({ left: 30, resets: NOW + 4 * D })
    expect(pick([low, fine])!.id).toBe(low.id)
    const lowO = opus({ left: 4, resets: NOW + 1 * D }), fineO = opus({ left: 30, resets: NOW + 4 * D })
    expect(pick([lowO, fineO], big())!.id).toBe(fineO.id)
    const nearZero = row({ left: 1, resets: NOW + 1 * D })
    expect(pick([nearZero, fine])!.id).toBe(fine.id)
    expect(pick([lowO, fineO], small({ kind: 'review' }))!.id).toBe(lowO.id)
    expect(pick([opus({ left: 1.5, resets: NOW + 1 * D }), fineO], small({ kind: 'test' }))!.id).toBe(fineO.id)
  })

  it('an account that runs a PM takes no new work under 20%', () => {
    const pm = row({ left: 15, resets: NOW + 1 * D, notes: [PM_ACCOUNT_NOTE(['lamp (Faye)'])] }), other = row({ left: 40, resets: NOW + 4 * D })
    expect(pick([pm, other])!.id).toBe(other.id)
    const pmRich = row({ left: 25, resets: NOW + 1 * D, notes: [PM_ACCOUNT_NOTE(['lamp (Faye)'])] })
    expect(pick([pmRich, other])!.id).toBe(pmRich.id)
  })

  it('an account whose quota is unknown comes after every account with a reading, and is picked when it is all there is', () => {
    const unknown = row({ left: null, resets: null }), known = row({ left: 10, resets: NOW + 6 * D })
    expect(pick([unknown, known])!.id).toBe(known.id)
    expect(pick([unknown])!.id).toBe(unknown.id)
  })

  it('names no pick when no account has the quota the work needs', () => {
    expect(pick([row({ left: 1 }), row({ left: 0 })])).toBeNull()
  })

  it('a later step never overrides an earlier one: a better account loses to a better-fitting model', () => {
    const rightModel = row({ left: 10, resets: NOW + 6 * D }), wrongModel = opus({ left: 90, resets: NOW + 1 * D })
    expect(pick([wrongModel, rightModel])!.id).toBe(rightModel.id)
  })
})

describe('pickByOrder step 3: an idle agent is reused only between equals', () => {
  const idle = (patch: Parameters<typeof row>[0] = {}) => row({ kind: 'member', agentId: 'ada', name: 'Ada', activity: 'idle', ...patch })

  it('reuses an idle agent over a new one on the same account', () => {
    const member = idle({ account: 'acct' }), fresh = row({ account: 'acct' })
    expect(pick([fresh, member])!.id).toBe(member.id)
  })

  it('does not reuse an idle agent on a worse account: a better account wins first', () => {
    const member = idle({ left: 20, resets: NOW + 5 * D }), fresh = row({ left: 20, resets: NOW + 1 * D })
    expect(pick([member, fresh])!.id).toBe(fresh.id)
  })

  it('reuses the same reviewer for its next round, and an agent for work that follows on, whatever its account', () => {
    const member = idle({ left: 20, resets: NOW + 5 * D, earlier: [{ group: 'g1', outcome: 'changes requested' }] }), fresh = opus({ left: 90, resets: NOW + 1 * D })
    expect(pick([fresh, { ...member, model: 'opus', quality: 3 } as Shown], small({ kind: 'review' }))!.id).toBe(member.id)
    const other = idle({ left: 20, resets: NOW + 5 * D, earlier: [{ group: 'g9', outcome: 'done' }] })
    expect(pick([fresh, { ...other, model: 'opus', quality: 3 } as Shown], small({ kind: 'review' }))!.id).toBe(fresh.id)
    expect(pick([row({ left: 90, resets: NOW + 1 * D }), member])!.id).toBe(member.id)
  })

  it('the exception still needs the model and the quota the work needs', () => {
    const wrong = idle({ model: 'haiku', earlier: [{ group: 'g1', outcome: 'done' }] }), fresh = row()
    expect(pick([wrong, fresh])!.id).toBe(fresh.id)
  })
})

describe('pickByOrder step 4: fewer agents working, then price', () => {
  it('between equals takes the machine with fewer agents working', () => {
    const busy = row({ account: 'acct', agents: 3, machineId: 'm1' }), quiet = row({ account: 'acct', agents: 1, machineId: 'm2' })
    expect(pick([busy, quiet])!.id).toBe(quiet.id)
  })

  it('then the lower price', () => {
    const dear = opus({ account: 'acct', agents: 1 }), cheap = astra({ account: 'acct', agents: 1, cost: 2 })
    expect(pick([dear, cheap], big())!.id).toBe(cheap.id)
  })
})

describe('pickByOrder reasons', () => {
  it('gives one reason per step, in order, that names what decided it', () => {
    const a = row({ left: 20, resets: NOW + 1 * D }), b = row({ left: 60, resets: NOW + 4 * D })
    const result = pick([b, a])!
    expect(result.id).toBe(a.id)
    expect(result.reasons).toHaveLength(4)
    expect(result.reasons[0]).toMatch(/^1\. Need:/)
    expect(result.reasons[1]).toMatch(/^2\. Quota:.*resets soonest/)
    expect(result.reasons[2]).toMatch(/^3\. Idle:/)
    expect(result.reasons[3]).toMatch(/^4\. Load and price:/)
  })

  it('names nothing for a route with no candidate', () => {
    expect(pick([])).toBeNull()
  })
})

describe('the pick in the verdict and the record', () => {
  const choice = (shown: Shown[]): Choice => ({ shown, excluded: [], floor: 1, belowFloor: false })

  it('a route with a pick says via order, names the pick and its reasons, and records both', () => {
    const a = row({ left: 20, resets: NOW + 1 * D }), b = row({ left: 60, resets: NOW + 4 * D })
    const c = choice([b, a]), picked = pick(c.shown)
    const verdict = decideByOrder(c, picked)
    expect(verdict).toMatchObject({ via: 'order', p: null, pick: a.id, reasons: picked!.reasons })
    expect(verdict.why.length).toBeLessThanOrEqual(300)
    for (const shape of ['current', 'unquoted'] as const) expect(recordOf(c, verdict, small(), shape)).toMatchObject({ pick: a.id, via: 'order', why: verdict.why })
  })

  it('a route with nothing to pick, or one candidate, is as it was: no pick', () => {
    const only = choice([row()])
    expect(decideByOrder(only, pick(only.shown))).toEqual(decide(only))
    const two = choice([row({ left: 0 }), row({ left: 1 })])
    expect(decideByOrder(two, pick(two.shown))).toEqual(decide(two))
    expect(recordOf(two, decide(two), small())).not.toHaveProperty('pick')
  })
})
