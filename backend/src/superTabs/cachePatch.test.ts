import { describe, expect, it } from 'vitest'
import { stableId } from './model.js'
import { baseRule, boardRule, cacheDigest, dormantAgentRule, lightDormantAgentRule, feedRule, startsOfRule, dormantProjectRule, dormantRule, finishedStartsRule, groupRule, machinesRule } from './cachePatch.js'
import type { GroupData, Part, PartKind, SwarmParts } from './parts/index.js'
import { projectLightGroup } from './parts/lightSelect.js'
import type { SwarmDelta } from './parts/load.js'

// Part<never> fits any entry's list in these tests.
const part = (kind: PartKind, key: string, version: number, data: unknown, extra: Partial<Part> = {}): Part<never> =>
  ({ kind, key, version, changedAt: version * 1_000, ordinal: version, data, ...extra }) as Part<never>
const delta = (parts: Part[], head: SwarmDelta['head'] = null): SwarmDelta => ({ parts, head })

function base(): SwarmParts {
  return {
    tabId: 't1', head: part('head', 'head', 3, { name: 'Swarm' }),
    members: [part('member', 'p1', 1, { id: 'p1' })], agents: [part('agent', 'a1', 2, { id: 'a1' }), part('agent', 'a2', 2, { id: 'a2' })],
    groups: [part('group', 'g1', 4, { id: 'g1', title: 'One' }), part('group', 'g2', 4, { id: 'g2', title: 'Two' })],
    machines: [], starts: [part('start', 's1', 1, { id: 's1' })], progress: [],
    sequenceBase: 10, visibilityEpoch: 1, groupCounter: 2,
  }
}

describe('baseRule', () => {
  it('replaces a newer part by key, adds a new one, and keeps the unchanged ones as they were', () => {
    const held = base()
    const next = baseRule.apply(held, delta([part('group', 'g1', 5, { id: 'g1', title: 'Uno' }), part('agent', 'a3', 1, { id: 'a3' })])) as SwarmParts
    expect(next.groups.map(g => [g.key, g.version])).toEqual([['g1', 5], ['g2', 4]])
    expect(next.agents.map(a => a.key)).toEqual(['a1', 'a2', 'a3'])
    expect(next.groups[1]).toBe(held.groups[1])
    expect(next.members).toBe(held.members)
    expect(next.agents[0]).toBe(held.agents[0])
  })

  it('an older or equal version is ignored', () => {
    const held = base()
    expect(baseRule.apply(held, delta([part('group', 'g1', 4, { id: 'g1', title: 'Stale' }), part('agent', 'a1', 1, { id: 'a1', old: true })]))).toBe(held)
  })

  it('a tombstone removes', () => {
    const next = baseRule.apply(base(), delta([part('agent', 'a2', 3, { id: 'a2' }, { deleted: true })])) as SwarmParts
    expect(next.agents.map(a => a.key)).toEqual(['a1'])
  })

  it('a group put to sleep leaves the base and joins dormant', () => {
    const sleep = part('group', 'g2', 5, { id: 'g2', title: 'Two', dormant: true }, { dormant: true })
    const next = baseRule.apply(base(), delta([sleep])) as SwarmParts
    expect(next.groups.map(g => g.key)).toEqual(['g1'])
    expect((dormantRule.apply([], delta([sleep])) as Part[]).map(g => g.key)).toEqual(['g2'])
  })

  it('a woken group leaves dormant and joins the base', () => {
    const held = base(), dormant = [part('group', 'g9', 6, { id: 'g9', dormant: true }, { dormant: true })]
    const woken = part('group', 'g9', 7, { id: 'g9' })
    expect((baseRule.apply(held, delta([woken])) as SwarmParts).groups.map(g => g.key)).toEqual(['g1', 'g2', 'g9'])
    expect(dormantRule.apply(dormant, delta([woken]))).toEqual([])
  })

  it('a start that finishes moves from the base to finished-starts', () => {
    const done = part('start', 's1', 2, { id: 's1', harnessId: 'h1' })
    expect((baseRule.apply(base(), delta([done])) as SwarmParts).starts).toEqual([])
    expect((finishedStartsRule.apply([], delta([done])) as Part[]).map(s => s.key)).toEqual(['s1'])
    // Still running: it stays in the base and never enters finished-starts.
    const running = part('start', 's1', 2, { id: 's1', harnessId: null })
    expect((baseRule.apply(base(), delta([running])) as SwarmParts).starts.map(s => s.version)).toEqual([2])
    expect(finishedStartsRule.apply([], delta([running]))).toEqual([])
  })

  it('the 7-day expiry tombstone leaves finished-starts', () => {
    const held = [part('start', 's9', 3, { id: 's9', harnessId: 'h9' })]
    expect(finishedStartsRule.apply(held, delta([part('start', 's9', 4, { id: 's9', harnessId: 'h9' }, { deleted: true })]))).toEqual([])
  })

  it('head data and its columns are patched; machine parts are not the base\'s', () => {
    const next = baseRule.apply(base(), delta([part('head', 'head', 4, { name: 'Renamed' }), part('machine', 'm1', 1, {})],
      { groupCounter: 3, visibilityEpoch: 1, sequenceBase: 10 })) as SwarmParts
    expect(next.head.data).toEqual({ name: 'Renamed' })
    expect(next.groupCounter).toBe(3)
    expect(next.machines).toEqual([])
  })

  it('a visibilityEpoch change asks for a reload', () => {
    expect(baseRule.apply(base(), delta([part('head', 'head', 4, { name: 'Swarm' })], { groupCounter: 2, visibilityEpoch: 2, sequenceBase: 10 }))).toBe('reload')
  })

  it('keeps a part in the shape a load gives: no readAt', () => {
    const next = machinesRule.apply([], delta([part('machine', 'm1', 2, { machineId: 'm1' }, { readAt: 5_000 })])) as Part[]
    expect(next[0]).not.toHaveProperty('readAt')
  })
})

describe('the other rules', () => {
  it('machinesRule replaces by key and drops a tombstone', () => {
    const held = [part('machine', 'm1', 1, { machineId: 'm1' }), part('machine', 'm2', 1, { machineId: 'm2' })]
    const next = machinesRule.apply(held, delta([part('machine', 'm1', 2, { machineId: 'm1', x: 1 }), part('machine', 'm2', 2, {}, { deleted: true })])) as Part[]
    expect(next.map(m => [m.key, m.version])).toEqual([['m1', 2]])
  })

  it('groupRule ignores other keys and empties on a tombstone', () => {
    const held = [part('group', 'g1', 1, { id: 'g1' })]
    expect(groupRule('g1').apply(held, delta([part('group', 'g2', 9, { id: 'g2' })]))).toBe(held)
    expect(groupRule('g1').apply(held, delta([part('group', 'g1', 2, { id: 'g1' }, { deleted: true })]))).toEqual([])
    expect(groupRule('g3').apply([], delta([part('group', 'g3', 1, { id: 'g3' })]))).toHaveLength(1)
  })

})

describe('cacheDigest', () => {
  it('ignores part order and versions but not data', () => {
    const same = { changedAt: 1_000, ordinal: 1 }
    const a = [part('group', 'g1', 1, { x: 1 }, same), part('group', 'g2', 1, { y: [1, 2] }, same)]
    const b = [part('group', 'g2', 7, { y: [1, 2] }, same), part('group', 'g1', 3, { x: 1 }, same)]
    expect(cacheDigest({ groups: a, n: 1 })).toBe(cacheDigest({ n: 1, groups: b }))
    expect(cacheDigest(a)).not.toBe(cacheDigest([part('group', 'g1', 1, { x: 2 }, same), a[1]]))
    expect(cacheDigest({ y: [2, 1] })).not.toBe(cacheDigest({ y: [1, 2] }))
  })
})

describe('dormant selections', () => {
  const asleep = (key: string, version: number, agentIds: string[], projectId?: string) =>
    part('group', key, version, { id: key, agentIds, ...projectId ? { projectId } : {} }, { dormant: true })

  it('an agent removed while its selection is held: its rewritten groups leave the selection', () => {
    const held = [asleep('g1', 1, ['a1', 'a2']), asleep('g2', 1, ['a1'])]
    const next = dormantAgentRule('a1').apply(held, delta([asleep('g1', 2, ['a2']), asleep('g2', 2, [])])) as Part[]
    expect(next).toEqual([])
  })

  it('a woken group leaves every dormant selection', () => {
    const held = [asleep('g1', 1, ['a1'], 'p1')]
    const woken = part('group', 'g1', 2, { id: 'g1', agentIds: ['a1'], projectId: 'p1' })
    expect(dormantAgentRule('a1').apply(held, delta([woken]))).toEqual([])
    expect(dormantProjectRule('p1').apply(held, delta([woken]))).toEqual([])
  })

  it('a group put to sleep joins its agents\' and project\'s selections, and lead takes groups with no project', () => {
    const sleep = asleep('g5', 3, ['a7'])
    expect((dormantAgentRule('a7').apply([], delta([sleep])) as Part[]).map(g => g.key)).toEqual(['g5'])
    expect((dormantProjectRule('lead').apply([], delta([sleep])) as Part[]).map(g => g.key)).toEqual(['g5'])
    expect(dormantProjectRule('p1').apply([], delta([sleep]))).toEqual([])
    expect(dormantAgentRule('a8').apply([], delta([sleep]))).toEqual([])
  })
})

describe('lightDormantAgentRule (B4, #2597)', () => {
  const whole = (key: string, version: number, agentIds: string[], dormant = true) => part('group', key, version, { id: key, title: key, kind: 'task', agentIds,
    brief: 'a long brief', checks: [{ id: 'c1', description: 'Works', independent: false, status: 'pending' }], archived: false, audience: null, assignment: null },
    dormant ? { dormant: true } : {}) as Part<GroupData>

  it('holds a changed quiet conversation of the agent light, as a light load gives it', () => {
    const next = lightDormantAgentRule('a1').apply([], delta([whole('g1', 2, ['a1'])])) as Part<GroupData>[]
    expect(next).toEqual([projectLightGroup(whole('g1', 2, ['a1']))])
    expect(next[0]!.data!.brief).toBe('')
    expect(next[0]!.data!.checks).toEqual([])
  })

  it('lets go of one the agent left or that woke, and keeps the held list when nothing newer came', () => {
    const held = [projectLightGroup(whole('g1', 2, ['a1'])), projectLightGroup(whole('g2', 2, ['a1']))]
    expect((lightDormantAgentRule('a1').apply(held, delta([whole('g1', 3, ['a2']), whole('g2', 3, ['a1'], false)])) as Part[])).toEqual([])
    expect(lightDormantAgentRule('a1').apply(held, delta([whole('g1', 2, ['a1']), whole('g9', 1, ['a2'])]))).toBe(held)
  })
})

describe('feedRule (spec 2026-11-02 poll cost, Part 1.1)', () => {
  it('keeps tombstones, dormant groups and readAt, takes the newer version', () => {
    const held = { from: 500, parts: [part('group', 'g1', 1, { a: 1 }), part('machine', 'm1', 1, {}, { readAt: 900 })] }
    const next = feedRule.apply(held, delta([
      part('group', 'g1', 2, { a: 2 }),
      part('group', 'g2', 3, {}, { dormant: true }),
      part('agent', 'a9', 4, {}, { deleted: true }),
      part('machine', 'm1', 2, {}, { readAt: 2_000 }),
      part('group', 'g1', 1, { stale: true }),
    ])) as { from: number; parts: Part[] }
    expect(next.from).toBe(500)
    expect(next.parts.map(p => [p.kind, p.key, p.version]).sort()).toEqual([['agent', 'a9', 4], ['group', 'g1', 2], ['group', 'g2', 3], ['machine', 'm1', 2]])
    expect(next.parts.find(p => p.key === 'a9')!.deleted).toBe(true)
    expect(next.parts.find(p => p.key === 'g2')!.dormant).toBe(true)
    expect(next.parts.find(p => p.key === 'm1')!.readAt).toBe(2_000)
  })

  it('returns what it holds when nothing is newer', () => {
    const held = { from: 0, parts: [part('group', 'g1', 5, {})] }
    expect(feedRule.apply(held, delta([part('group', 'g1', 5, {})]))).toBe(held)
  })
})

describe('startsOfRule (spec 2026-11-02 poll cost, Part 1.4)', () => {
  const start = (key: string, version: number, harnessId: string | null, extra: Partial<Part> = {}) =>
    part('start', key, version, { id: key, harnessId, request: { machineId: 'm1', conversationId: 'c' } }, extra)
  const agentOf = (harness: string) => stableId('m1', harness)

  it('follows starts in and out of the agent list', () => {
    const rule = startsOfRule([agentOf('h1')])
    const held = [start('s1', 1, 'h1')]
    expect((rule.apply(held, delta([start('s2', 1, 'h1')])) as Part[]).map(s => s.key)).toEqual(['s1', 's2'])
    expect(rule.apply(held, delta([start('s1', 2, 'h1', { deleted: true })]))).toEqual([])
    expect(rule.apply(held, delta([start('s1', 2, 'h9')]))).toEqual([])
    expect(rule.apply(held, delta([start('s3', 1, 'h7')]))).toBe(held)
  })
})

describe('boardRule (task #2674)', () => {
  const FLOOR = Date.UTC(2026, 8, 28)
  const at = (days: number) => new Date(FLOOR + days * 86_400_000).toISOString()
  const group = (key: string, version: number, opts: { dormant?: boolean; projectId?: string; lastActivityAt?: string; deleted?: boolean } = {}) =>
    part('group', key, version, { id: key, title: key, kind: 'task', brief: 'a long brief', agentIds: ['a1'], checks: [], archived: false,
      requesterId: 'p1', pullRequestUrls: ['https://github.com/o/r/pull/1'], ledger: { askedAt: 1, shippedAt: 2 },
      assignment: { id: 'w1', status: 'done', result: 'a long result', execution: { machineId: 'm' } },
      ...opts.projectId ? { projectId: opts.projectId } : {}, lastActivityAt: opts.lastActivityAt ?? at(3) },
    { ...opts.dormant === false ? {} : { dormant: true }, ...opts.deleted ? { deleted: true } : {} }) as Part<GroupData>

  it('holds a quiet conversation of the projects active since the floor with the board\'s fields only', () => {
    const [held] = boardRule(['lead'], FLOOR).apply([], delta([group('g1', 2)])) as Part<GroupData>[]
    expect(held).toMatchObject({ key: 'g1', version: 2, dormant: true })
    expect(held!.data).toEqual({ id: 'g1', title: 'g1', kind: 'task', archived: false, requesterId: 'p1',
      pullRequestUrls: ['https://github.com/o/r/pull/1'], ledger: { askedAt: 1, shippedAt: 2 }, assignment: { id: 'w1', status: 'done' },
      lastActivityAt: at(3) })
  })

  it('leaves out one of another project, one quiet since before the floor, one awake and one removed', () => {
    const rule = boardRule(['lead', 'p2'], FLOOR)
    expect(rule.apply([], delta([group('g1', 1, { projectId: 'p3' }), group('g2', 1, { lastActivityAt: at(-1) }),
      group('g3', 1, { dormant: false }), group('g4', 1, { deleted: true })]))).toEqual([])
    expect((rule.apply([], delta([group('g5', 1, { projectId: 'p2' })])) as Part[]).map(g => g.key)).toEqual(['g5'])
  })

  it('lets go of a held one that woke, moved project or was removed, and keeps the held list when nothing newer came', () => {
    const rule = boardRule(['lead'], FLOOR)
    const held = rule.apply([], delta([group('g1', 1), group('g2', 1), group('g3', 1)])) as Part<GroupData>[]
    expect(rule.apply(held, delta([group('g1', 2, { dormant: false }), group('g2', 2, { projectId: 'p9' }), group('g3', 2, { deleted: true })]))).toEqual([])
    expect(rule.apply(held, delta([group('g1', 1), group('g9', 1, { projectId: 'p9' })]))).toBe(held)
  })
})
