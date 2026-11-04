import { describe, expect, it, vi } from 'vitest'
import { stableId, type AgentStart } from './model.js'
import type { Part } from './parts/index.js'
import { deriveLight, namedStarts, readChanged, readDelta, readLastChangedAt, readLastChangedAts, readLight, readLightGroups, readMachines, readParts } from './cachedReads.js'
import { CacheView } from './cache.js'
import { baseRule, dormantRule, feedRule, machinesRule } from './cachePatch.js'

/** A start, finished once it has a harness. `untouchable`: reading its request throws, so a test sees the read hash its
 *  agent (stableId, a sha256 of the request's machine and the harness). */
const start = (key: string, done: boolean, untouchable = false): Part<AgentStart> => {
  const data = { id: key, harnessId: done ? `${key}-harness` : null } as Record<string, unknown>
  Object.defineProperty(data, 'request', { enumerable: true, configurable: true, get: () => {
    if (untouchable) throw new Error(`read the request of ${key}`)
    return { machineId: 'host', conversationId: 'c' }
  } })
  return { kind: 'start', key, version: 1, changedAt: 1, ordinal: 1, data: data as unknown as AgentStart }
}

describe('the starts a read keeps (cachedReads.ts namedStarts)', () => {
  it('keeps the unfinished starts without hashing any finished one when no agent is named (prod 10-30: 873 a messages read)', () => {
    const finished = Array.from({ length: 1000 }, (_, i) => start(`old-${i}`, true, true)), hot = [start('queued', false)]
    expect(namedStarts(hot, finished, {}).map(s => s.key)).toEqual(['queued'])
    expect(namedStarts(hot, finished, { startIds: ['old-3'] }).map(s => s.key).sort()).toEqual(['old-3', 'queued'])
  })

  it('keeps the finished starts named by id or by the agent they started, and every one for a first load', () => {
    const finished = Array.from({ length: 10 }, (_, i) => start(`old-${i}`, true)), hot = [start('queued', false)]
    const agent = stableId('host', 'old-7-harness')
    expect(namedStarts(hot, finished, { startIds: ['old-3'], startAgentIds: [agent] }).map(s => s.key).sort()).toEqual(['old-3', 'old-7', 'queued'])
    expect(namedStarts(hot, finished, { includeRecentStarts: true })).toEqual([...hot, ...finished])
  })

  it('a start held in both lists (patched at different moments) comes once, its newer version', () => {
    const hot = [{ ...start('s1', false), version: 2 }], finished = [{ ...start('s1', true), version: 3 }, start('old-1', true)]
    expect(namedStarts(hot, finished, { includeRecentStarts: true }).map(s => [s.key, s.version])).toEqual([['s1', 3], ['old-1', 1]])
    expect(namedStarts(hot, finished, { startIds: ['s1'] }).map(s => [s.key, s.version])).toEqual([['s1', 3]])
    expect(namedStarts([{ ...start('s2', false), version: 5 }], [{ ...start('s2', true), version: 4 }], { startIds: ['s2'] }).map(s => s.version)).toEqual([5])
  })

  it('works out each finished start\'s agent once per held list', () => {
    let reads = 0
    const finished = Array.from({ length: 5 }, (_, i) => {
      const part = start(`old-${i}`, true)
      const data = part.data as unknown as Record<string, unknown>, request = data.request
      Object.defineProperty(data, 'request', { enumerable: true, get: () => { reads++; return request } })
      return part
    })
    const agent = stableId('host', 'old-2-harness')
    expect(namedStarts([], finished, { startAgentIds: [agent] }).map(s => s.key)).toEqual(['old-2'])
    expect(namedStarts([], finished, { startAgentIds: [agent] }).map(s => s.key)).toEqual(['old-2'])
    expect(reads).toBe(5)
  })
})

describe('finished starts are read only by the reads that name them (spec 2026-11-02, Phase 2)', () => {
  function stubView(hot: Part<AgentStart>[], finished: Part<AgentStart>[]) {
    const view = new CacheView(null, null), names: string[] = []
    vi.spyOn(view, 'get').mockImplementation(async (_tabId, name) => {
      names.push(name)
      if (name === 'parts') return { tabId: 't', head: {}, members: [], agents: [], groups: [], machines: [], starts: hot, progress: [] }
      if (name === 'finished-starts') return finished
      return []
    })
    return { view, names }
  }
  const hot = [start('queued', false)], finished = [start('old-1', true), start('old-2', true)]

  it('a read naming nothing never loads finished starts', async () => {
    const { view, names } = stubView(hot, finished)
    expect((await readParts({} as never, view, 't')).starts.map(s => s.key)).toEqual(['queued'])
    expect((await readParts({} as never, view, 't', { startIds: ['queued'] })).starts.map(s => s.key)).toEqual(['queued'])
    expect(names).not.toContain('finished-starts')
  })

  it('first loads, a named finished start and an agent\'s starts read them', async () => {
    const { view, names } = stubView(hot, finished)
    expect((await readParts({} as never, view, 't', { includeRecentStarts: true })).starts.map(s => s.key)).toEqual(['queued', 'old-1', 'old-2'])
    expect((await readParts({} as never, view, 't', { startIds: ['old-2'] })).starts.map(s => s.key)).toEqual(['queued', 'old-2'])
    expect((await readParts({} as never, view, 't', { startAgentIds: [stableId('host', 'old-1-harness')] })).starts.map(s => s.key)).toEqual(['queued', 'old-1'])
    expect(names.filter(n => n === 'finished-starts')).toHaveLength(3)
  })
})

describe('which entries a refresh patches (spec 2026-11-02, Phase 1)', () => {
  it('each patchable read passes its rule, and the derived selections none', async () => {
    const view = new CacheView(null, null)
    const rules = new Map<string, unknown>()
    vi.spyOn(view, 'get').mockImplementation(async (_tabId, name, _scope, _load, patch) => {
      rules.set(name.startsWith('light:') ? 'light:' : name, patch)
      if (name === 'parts') return { tabId: 't', head: {}, members: [], agents: [], groups: [], machines: [], starts: [], progress: [] }
      if (name === 'feed') return { from: 0, parts: [] }
      if (name === 'lastChangedAt') return null
      if (name.startsWith('light:')) return { groups: [], starts: [] }
      if (name.startsWith('light-group:')) return null
      return []
    })
    Object.defineProperty(view, 'available', { get: () => true })
    const db = {} as never
    await readParts(db, view, 't', { allGroups: true, groupIds: ['g1'] })
    await readMachines(db, view, 't')
    await readLastChangedAt(db, view, 't')
    await readLastChangedAts(db, view, ['t'])
    await readLight(db, view, 't', {})
    await readLightGroups(db, view, 't', ['g2'])
    await readChanged(db, view, 't', 0)
    expect(rules.get('parts')).toBe(baseRule)
    expect(rules.get('machines')).toBe(machinesRule)
    expect(rules.get('dormant')).toBe(dormantRule)
    expect((rules.get('group:g1') as { kinds: unknown }).kinds).toEqual(['group'])
    // Tiny and batched per read: dropped and read again (final review: its delta cost more than the read).
    expect(rules.get('lastChangedAt')).toBeUndefined()
    expect(rules.get('light:')).toBeUndefined()
    expect(rules.get('light-group:g2')).toBeUndefined()
    expect(rules.get('feed')).toBe(feedRule)
  })
})

describe('dormant groups by the selection a read names (spec 2026-11-02, Phase 2)', () => {
  const group = (key: string, agentIds: string[], projectId?: string) => ({ _id: `t:${key}`, tabId: 't', key, version: 1, changedAt: { $date: '2026-11-01T00:00:00Z' },
    ordinal: 1, deleted: false, dormant: true, data: { id: key, agentIds, ...projectId ? { projectId } : {} } })
  function scene() {
    const rows = [group('g1', ['a1']), group('g2', ['a1', 'a2'], 'p1'), group('g3', ['a3'], 'p1'), group('g4', ['a2'])]
    const pipelines: unknown[] = []
    const db = { swarmGroup: { aggregateRaw: vi.fn(async ({ pipeline }: { pipeline: Array<{ $match: Record<string, unknown> }> }) => {
      pipelines.push(pipeline[0]!.$match)
      const match = pipeline[0]!.$match as { agentIds?: { $in: string[] }; projectId?: { $in: Array<string | null> } }
      return rows.filter(r => (!match.agentIds || r.data.agentIds.some(id => match.agentIds!.$in.includes(id)))
        && (!match.projectId || match.projectId.$in.includes((r.data as { projectId?: string }).projectId ?? null)))
    }) } } as never
    const view = new CacheView(null, null), names: string[] = []
    vi.spyOn(view, 'get').mockImplementation(async (_tabId, name, _scope, load) => {
      names.push(name)
      if (name === 'parts') return { tabId: 't', head: {}, members: [], agents: [], groups: [], machines: [], starts: [], progress: [] }
      if (name === 'machines') return []
      return load()
    })
    return { db, view, names, pipelines }
  }

  it('a read naming one agent loads that agent\'s dormant groups only', async () => {
    const { db, view, names, pipelines } = scene()
    const read = await readParts(db, view, 't', { agentIds: ['a2'] })
    expect(read.groups.map(g => g.key).sort()).toEqual(['g2', 'g4'])
    expect(names).toContain('dormant:agent:a2')
    expect(names).not.toContain('dormant')
    expect(pipelines).toEqual([{ tabId: 't', deleted: false, agentIds: { $in: ['a2'] }, dormant: true }])
  })

  it('several agents and projects merge without duplicates', async () => {
    const { db, view, names } = scene()
    const read = await readParts(db, view, 't', { agentIds: ['a1', 'a2'], projectIds: ['p1'] })
    expect(read.groups.map(g => g.key).sort()).toEqual(['g1', 'g2', 'g3', 'g4'])
    expect(names.filter(n => n.startsWith('dormant:')).sort()).toEqual(['dormant:agent:a1', 'dormant:agent:a2', 'dormant:project:p1'])
  })

  it('lead includes groups stored with no project', async () => {
    const { db, view, pipelines } = scene()
    const read = await readParts(db, view, 't', { projectIds: ['lead'] })
    expect(read.groups.map(g => g.key).sort()).toEqual(['g1', 'g4'])
    expect(pipelines).toEqual([{ tabId: 't', deleted: false, projectId: { $in: ['lead', null] }, dormant: true }])
  })

  it('allGroups keeps the whole dormant entry', async () => {
    const { db, view, names } = scene()
    expect((await readParts(db, view, 't', { allGroups: true, agentIds: ['a1'] })).groups).toHaveLength(4)
    expect(names.filter(n => n.startsWith('dormant'))).toEqual(['dormant'])
  })
})

describe('the delta a refresh reads', () => {
  it('is one snapshot: read in a transaction', async () => {
    const aggregateRaw = vi.fn(async () => [])
    const tx = Object.fromEntries(['swarmHead', 'swarmMember', 'swarmAgent', 'swarmGroup', 'swarmMachine', 'swarmStart', 'swarmProgress'].map(m => [m, { aggregateRaw }]))
    const db = { $transaction: vi.fn(async (body: (tx: unknown) => Promise<unknown>) => body(tx)) }
    expect(await readDelta(db as never)('t', 5, ['group', 'start'])).toEqual({ parts: [], head: null, hostDigests: new Map() })
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(aggregateRaw).toHaveBeenCalledTimes(2)
  })
})

describe('light and host state derived from held entries (spec 2026-11-02 poll cost, Part 1.2)', () => {
  const g = (key: string, data: Record<string, unknown>, dormant = false) => ({ kind: 'group', key, version: 1, changedAt: 1, ordinal: 1,
    ...dormant ? { dormant: true } : {}, data: { id: key, agentIds: [], archived: false, title: key, ...data } })
  const base = { tabId: 't', head: { kind: 'head', key: 'head', version: 1, changedAt: 1, ordinal: 0, data: { projects: [{ id: 'p1', leadConversationId: 'lead1' }], invitations: [] } },
    members: [], agents: [{ kind: 'agent', key: 'a1', version: 1, changedAt: 1, ordinal: 1, data: { id: 'a1', machineId: 'm1', projectId: 'p1', workDecision: 'stop' } },
      { kind: 'agent', key: 'a2', version: 1, changedAt: 1, ordinal: 1, data: { id: 'a2', machineId: 'm2', projectId: 'p1', workDecision: 'stop' } }],
    groups: [g('run', { agentIds: ['a2'], assignment: { id: 'w', agentId: 'a2', status: 'working', execution: { machineId: 'm2', harnessId: 'h', machineOwnerId: 'o' } } }),
      g('idle', { agentIds: ['a1'] })],
    machines: [], starts: [], progress: [], sequenceBase: 0, visibilityEpoch: 0, groupCounter: 0 }
  // Any touch of the database fails the test: a derived read must come from what the cache holds.
  const db = new Proxy({}, { get: (_t, key) => { throw new Error(`read the database: ${String(key)}`) } }) as never
  function stub(extra: Record<string, unknown> = {}, patching = true) {
    const view = new CacheView(null, null), names: string[] = []
    Object.defineProperty(view, 'available', { get: () => true })
    Object.defineProperty(view, 'patching', { get: () => patching })
    vi.spyOn(view, 'get').mockImplementation(async (_tabId, name) => {
      names.push(name)
      if (name === 'parts') return base
      if (name === 'machines') return []
      if (name in extra) return extra[name]
      if (name.startsWith('light-group:')) return null
      if (name.startsWith('dormant:agent:')) return []
      throw new Error(`unexpected entry ${name}`)
    })
    return { view, names }
  }

  it('the light base derives from the held base and reads no Swarm collection', async () => {
    const { view } = stub({ 'light-group:lead1': g('lead1', { brief: '' }, true) })
    const light = await deriveLight(db, view, 't', { groups: 'working' })
    expect(light.groups.map(x => x.key).sort()).toEqual(['lead1', 'run'])
    expect(light.groups.find(x => x.key === 'run')!.data!.brief).toBe('')
  })

  it('host state takes the machine\'s agents\' dormant conversations from light-dormant:agent entries (B4)', async () => {
    const { view, names } = stub({ 'light-dormant:agent:a1': [g('old', { agentIds: ['a1'] }, true)] })
    const light = await deriveLight(db, view, 't', { groups: 'working', machineId: 'm1' })
    expect(names).toContain('light-dormant:agent:a1')
    expect(light.groups.map(x => x.key).sort()).toEqual(['idle', 'old', 'run'])
  })

  it('readLight derives on a cache miss instead of reading Mongo', async () => {
    const { view } = stub({ 'light-group:lead1': null })
    const get = vi.mocked(view.get)
    const fallback = get.getMockImplementation()!
    get.mockImplementation(async (tabId, name, scope, load, patch) => name.startsWith('light:') ? load() : fallback(tabId, name, scope, load, patch))
    const light = await readLight(db, view, 't', { groups: 'working' })
    expect(light.groups.map(x => x.key)).toEqual(['run'])
  })

  it('a cache that does not patch reads the light base as before: deriving it would load the whole base on every bump', async () => {
    const { view } = stub({}, false)
    const get = vi.mocked(view.get)
    const fallback = get.getMockImplementation()!
    get.mockImplementation(async (tabId, name, scope, load, patch) => name.startsWith('light:') ? load() : fallback(tabId, name, scope, load, patch))
    await expect(readLight(db, view, 't', { groups: 'working' })).rejects.toThrow('read the database: $transaction')
  })

  it('a machine whose agents all left derives no conversation of theirs', async () => {
    const { view, names } = stub()
    const light = await deriveLight(db, view, 't', { groups: 'working', machineId: 'gone' })
    expect(names.filter(n => n.startsWith('light-dormant:agent:'))).toEqual([])
    expect(light.groups.map(x => x.key)).toEqual(['run'])
  })
})
