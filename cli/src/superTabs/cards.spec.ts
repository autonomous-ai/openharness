import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'
import { lastLeadMessage, leadsOf, SwarmCards, type SwarmCard } from './cards.js'
import { swarmReply } from './fixtures/read/index.js'

const agent = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, harnessId: `h-${id}`, machineId: 'm1', machineOwnerId: 'me', configuration: { engine: 'claude' }, ...over })
const conv = (id: string, leadId: string | null, over: Record<string, unknown> = {}) =>
  ({ id, projectId: id.replace(/^lead-?/, '') || 'lead', leadId, archived: false, assignment: null, lastMessageSequence: 0, ...over })
/** A two-project Swarm: `web` (Lead a1) and `mobile` (Lead a2). */
const swarm = (over: Record<string, unknown> = {}) => ({
  name: 'openharness', paused: false, ownerId: 'me',
  people: [{ id: 'me', email: 'me@x.io' }, { id: 'sam', email: 'sam@x.io' }],
  projects: [{ id: 'web', name: 'web', leadConversationId: 'lead-web' }, { id: 'mobile', name: 'mobile', leadConversationId: 'lead-mobile' }],
  agents: [agent('a1'), agent('a2')],
  conversations: [conv('lead-web', 'a1', { projectId: 'web' }), conv('lead-mobile', 'a2', { projectId: 'mobile' })],
  ...over,
})
const idle = () => ({ inTurn: false })
const work = (id: string, status: string) => conv(`w-${id}`, null, { projectId: id, assignment: { status } })

describe('leadsOf', () => {
  it('picks one Lead per project through its lead conversation, in project order', () => {
    const { count, leads } = leadsOf(swarm(), 'm1', idle)
    expect(count).toBe(2)
    expect(leads.map(l => [l.id, l.projectId, l.project, l.engine, l.local, l.state])).toEqual([['a1', 'web', 'web', 'claude', 'h-a1', 'done'], ['a2', 'mobile', 'mobile', 'claude', 'h-a2', 'done']])
  })

  it('reads an old tab without projects as the one `lead` project, and skips a project with no Lead agent', () => {
    const old = { name: 'Old', agents: [agent('a1')], people: [], conversations: [{ id: 'lead', leadId: 'a1', assignment: null }] }
    expect(leadsOf(old, 'm1', idle).leads.map(l => [l.id, l.projectId, l.project])).toEqual([['a1', 'lead', 'Old']])
    const headless = swarm({ conversations: [conv('lead-web', 'a1', { projectId: 'web' }), conv('lead-mobile', null, { projectId: 'mobile' })] })
    expect(leadsOf(headless, 'm1', idle)).toMatchObject({ count: 1, leads: [{ id: 'a1' }] })
  })

  it('reads the status: ask beats stuck beats work; a local turn carries since; a remote one works on an assignment', () => {
    const asks = swarm({ conversations: [...swarm().conversations, work('web', 'needs_human'), work('web', 'blocked')] })
    expect(leadsOf(asks, 'm1', idle).leads[0]).toMatchObject({ id: 'a1', state: 'ask' })
    const stuck = swarm({ conversations: [...swarm().conversations, work('web', 'working'), work('web', 'blocked')] })
    expect(leadsOf(stuck, 'm1', idle).leads[0]).toMatchObject({ id: 'a1', state: 'stuck' })
    const turn = leadsOf(swarm(), 'm1', h => ({ inTurn: h === 'h-a2', since: 134 })).leads
    expect(turn[0]).toEqual(expect.objectContaining({ id: 'a2', state: 'work', since: 134 }))
    expect(turn[1]).not.toHaveProperty('since')
    const remote = swarm({ agents: [agent('a1', { machineId: 'm2', machineOwnerId: 'sam' }), agent('a2')], conversations: [...swarm().conversations, work('web', 'working')] })
    const [first] = leadsOf(remote, 'm1', idle).leads
    expect(first).toMatchObject({ id: 'a1', state: 'work', local: '' })
    expect(first).not.toHaveProperty('since')
    expect(leadsOf(swarm({ conversations: [...swarm().conversations, work('web', 'review')] }), 'm1', idle).leads[0].state).toBe('work')
  })

  // The app's working mark is each agent's own live turn (the Lead's and every worker's); the card says a project works when any of its agents is in a turn
  // here, and goes by its open assignments for agents this machine cannot see.
  it('reads a project as work when any of its agents is in a turn here, whatever its Lead and assignments say', () => {
    const inTurn = (...ids: string[]) => (h: string) => ({ inTurn: ids.includes(h) })
    const withWorkers = (over: Record<string, unknown> = {}) => swarm({
      agents: [agent('a1'), agent('a2'), agent('b1', { projectId: 'web' }), agent('b2', { projectId: 'mobile' })],
      conversations: [...swarm().conversations, work('web', 'done'), conv('w-old', null, { projectId: 'mobile', agentIds: ['b2'], assignment: { status: 'done' } })],
      ...over,
    })
    // Lead idle, its worker in a turn
    expect(leadsOf(withWorkers(), 'm1', inTurn('h-b1')).leads.map(l => [l.project, l.state])).toEqual([['web', 'work'], ['mobile', 'done']])
    // every assignment done, a worker still in a turn (one known only through its group, as the app's roster finds it)
    const noProjectId = withWorkers({ agents: [agent('a1'), agent('a2'), agent('b2')] })
    expect(Object.fromEntries(leadsOf(noProjectId, 'm1', inTurn('h-b2')).leads.map(l => [l.project, l.state]))).toEqual({ web: 'done', mobile: 'work' })
    // the clock is the project's earliest turn here: the worker's when only it works, else whichever began first
    const since = (map: Record<string, number>) => (h: string) => h in map ? { inTurn: true, since: map[h] } : { inTurn: false }
    expect(leadsOf(withWorkers(), 'm1', since({ 'h-b1': 40 })).leads[0]).toMatchObject({ project: 'web', state: 'work', since: 40 })
    expect(leadsOf(withWorkers(), 'm1', since({ 'h-a1': 5, 'h-b1': 40 })).leads[0]).toMatchObject({ project: 'web', state: 'work', since: 40 })
    expect(leadsOf(withWorkers(), 'm1', since({ 'h-a1': 90, 'h-b1': 40 })).leads[0]).toMatchObject({ project: 'web', state: 'work', since: 90 })
    // nobody in a turn and nothing open: done
    expect(leadsOf(withWorkers(), 'm1', idle).leads.map(l => l.state)).toEqual(['done', 'done'])
    // a worker on another machine has no turn here: its project goes by its assignment
    const remoteWorker = withWorkers({ agents: [agent('a1'), agent('a2'), agent('b1', { projectId: 'web', machineId: 'm2' })] })
    expect(leadsOf(remoteWorker, 'm1', inTurn('h-b1')).leads[0].state).toBe('done')
    // a Lead on another machine: its local worker's turn counts, otherwise its assignments
    const remoteLead = withWorkers({ agents: [agent('a1', { machineId: 'm2', machineOwnerId: 'sam' }), agent('a2'), agent('b1', { projectId: 'web' })] })
    expect(leadsOf(remoteLead, 'm1', inTurn('h-b1')).leads[0]).toMatchObject({ id: 'a1', state: 'work', local: '' })
    expect(leadsOf(remoteLead, 'm1', idle).leads[0].state).toBe('done')
    // ask and stuck still come first
    const asks = withWorkers({ conversations: [...withWorkers().conversations as unknown[], work('web', 'needs_human')] })
    expect(leadsOf(asks, 'm1', inTurn('h-b1')).leads[0].state).toBe('ask')
  })

  it('calls a harness local only on this machine and live here; names an owner only when it is not the signed-in person', () => {
    const remote = swarm({ agents: [agent('a1', { machineId: 'm2', machineOwnerId: 'sam' }), agent('a2', { machineOwnerId: 'sam' })] })
    const byId = Object.fromEntries(leadsOf(remote, 'm1', idle, 'me').leads.map(l => [l.id, l]))
    expect(byId.a1).toMatchObject({ local: '', owner: 'sam@x.io' })
    expect(byId.a2).toMatchObject({ local: 'h-a2', owner: 'sam@x.io' })
    expect(leadsOf(swarm(), 'm1', idle, 'me').leads.map(l => l.owner)).toEqual(['', ''])
    expect(leadsOf(swarm(), 'm1', () => null).leads.map(l => l.local)).toEqual(['', ''])
  })

  it('orders ask, stuck, work, done with ties in project order, and caps at 12 Leads', () => {
    const projects = Array.from({ length: 13 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, leadConversationId: `lead-p${i}` }))
    const many = swarm({ projects, agents: projects.map((_, i) => agent(`a${i}`)),
      conversations: [...projects.map((p, i) => conv(p.leadConversationId, `a${i}`, { projectId: p.id })), work('p5', 'blocked'), work('p9', 'needs_human'), work('p2', 'working'), work('p7', 'needs_human')] })
    const { count, leads } = leadsOf(many, 'm1', idle)
    expect(count).toBe(13)
    expect(leads).toHaveLength(12)
    expect(leads.slice(0, 5).map(l => [l.project, l.state])).toEqual([['P7', 'ask'], ['P9', 'ask'], ['P5', 'stuck'], ['P2', 'work'], ['P0', 'done']])
  })

  it('gives each Lead its project\'s index as `order`, whatever place urgency gives it', () => {
    const three = swarm({
      projects: [...swarm().projects, { id: 'api', name: 'api', leadConversationId: 'lead-api' }],
      agents: [agent('a1'), agent('a2'), agent('a3')],
      conversations: [...swarm().conversations, conv('lead-api', 'a3', { projectId: 'api' }), work('mobile', 'needs_human'), work('api', 'working')],
    })
    expect(leadsOf(three, 'm1', idle).leads.map(l => [l.project, l.state, l.order])).toEqual([['mobile', 'ask', 1], ['api', 'work', 2], ['web', 'done', 0]])
    // The 12 most urgent of 13 keep their own index: the one left out leaves a gap.
    const projects = Array.from({ length: 13 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, leadConversationId: `lead-p${i}` }))
    const many = swarm({ projects, agents: projects.map((_, i) => agent(`a${i}`)),
      conversations: [...projects.map((p, i) => conv(p.leadConversationId, `a${i}`, { projectId: p.id })), ...projects.slice(1).map(p => work(p.id, 'working'))] })
    expect(leadsOf(many, 'm1', idle).leads.map(l => l.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    const old = { name: 'Old', agents: [agent('a1')], people: [], conversations: [{ id: 'lead', leadId: 'a1', assignment: null }] }
    expect(leadsOf(old, 'm1', idle).leads[0].order).toBe(0)
  })

  it('cuts a name to 48 bytes on a character boundary and reads a paused Swarm as done', () => {
    const named = swarm({ projects: [{ id: 'web', name: `${'a'.repeat(47)}éé`, leadConversationId: 'lead-web' }] })
    expect(leadsOf(named, 'm1', idle).leads[0].project).toBe('a'.repeat(47))
    const paused = swarm({ paused: true, conversations: [...swarm().conversations, work('web', 'needs_human')] })
    expect(leadsOf(paused, 'm1', () => ({ inTurn: true })).leads.map(l => l.state)).toEqual(['done', 'done'])
  })
})

describe('lastLeadMessage', () => {
  const row = (sequence: number, over: Record<string, unknown> = {}) => ({ sequence, text: `t${sequence}`, author: { kind: 'agent', id: 'a1' }, createdAt: '2026-10-22T00:00:00.000Z', ...over })
  it('takes the newest row the Lead wrote, skipping system rows and other authors', () => {
    const rows = [row(1), row(2, { source: { kind: 'native' } }), row(3, { author: { id: 'a2' } }), row(4, { text: 7 })]
    expect(lastLeadMessage(rows, 'a1')).toEqual({ text: 't1', at: Date.parse('2026-10-22T00:00:00.000Z') / 1000 })
    expect(lastLeadMessage([row(5), row(1)], 'a1')?.text).toBe('t5')
    expect(lastLeadMessage([row(1, { createdAt: 1_000_500 })], 'a1')?.at).toBe(1000)
    expect(lastLeadMessage([row(1, { createdAt: 'x' })], 'a1')?.at).toBe(0)
  })
  it('is null when the Lead has said nothing', () => {
    expect(lastLeadMessage([], 'a1')).toBeNull()
    expect(lastLeadMessage([row(1, { author: { id: 'a2' } })], 'a1')).toBeNull()
  })
})

/** A fake backend: tabs by id with the time each last changed, a message store per conversation, and call counting. */
function setup(tabs: Record<string, { lastChangedAt: number; state: Record<string, unknown> }>, extra: { activity?: Record<string, 'working' | 'idle'>; elapsed?: number; messages?: (path: string) => unknown } = {}) {
  const calls: string[] = []
  const failing = new Map<string, number>()
  let listFails = false
  let pages: Record<string, { next: string | null }> = {}
  let pageSize = 0
  const call = vi.fn(async (method: string, path: string, _body?: unknown) => {
    calls.push(`${method} ${path}`)
    const [route, query] = path.split('?')
    if (route === '/api/super-tabs/list') {
      if (listFails) throw new Error('offline')
      const ids = Object.keys(tabs).sort(), after = new URLSearchParams(query).get('after')
      const rest = ids.filter(id => !after || id > after)
      let page = pages[after ?? '']?.next !== undefined ? rest.slice(0, 1) : rest
      let next = pages[after ?? ''] ? pages[after ?? ''].next : null
      if (pageSize) { page = rest.slice(0, pageSize); next = page.length < rest.length ? page[page.length - 1] : null }
      return { status: 200, body: { success: true, data: { tabs: page.map(id => ({ id, name: String(tabs[id].state.name), ownerId: 'me', lastChangedAt: tabs[id].lastChangedAt, paused: false })), next } } }
    }
    const tab = /^\/api\/super-tabs\/([^/]+)\/(parts|changes)$/.exec(route)
    if (tab) {
      const code = failing.get(tab[1])
      if (code) return { status: code, body: { success: false, error: { code: 'FORBIDDEN', message: 'no' } } }
      // A tab is read by parts (design 2026-10-26 4.3): a fake keeps no history, so every changes read asks for a first load.
      return { status: 200, body: { success: true, data: swarmReply(path, tabs[tab[1]].state, { lastChangedAt: tabs[tab[1]].lastChangedAt }) } }
    }
    // The real messages page: { messages, next }, `next` the (sequence, id) cursor of the page before.
    return { status: 200, body: { success: true, data: { ...(extra.messages?.(path) ?? { messages: [], next: null }) as object } } }
  })
  const core = fakeCore({
    account: { backend: call as unknown as CoreApi['account']['backend'], identity: vi.fn(async () => ({ accountId: 'me', email: 'me@x.io' })) },
    agents: { byAgent: vi.fn((id: string) => (id.startsWith('h-') ? { agentId: id } : undefined) as never),
      activity: vi.fn(async () => extra.activity ?? {}),
      activitySnapshot: vi.fn(async () => ({ text: '', elapsedSeconds: extra.elapsed })) },
  })
  let clock = 1_000_000
  const cards = new SwarmCards(core, 'm1', { now: () => clock, intervalMs: 5000 })
  const seen: SwarmCard[][] = []
  cards.onCards = c => seen.push(c)
  return { cards, calls, seen, call, core, failing, tabs, paginate: (p: typeof pages) => { pages = p }, pageBy: (n: number) => { pageSize = n }, breakList: (v = true) => { listFails = v }, advance: (ms: number) => { clock += ms } }
}
/** Each read of a tab, named by the tab: a changes read, or a first load that no changes read of it asked for. */
function detailReads(calls: string[]): string[] {
  const reloading = new Set<string>(), reads: string[] = []
  for (const call of calls) {
    const [, tab, kind] = /^(GET \/api\/super-tabs\/[^/]+)\/(parts|changes)/.exec(call) ?? []
    if (!tab) continue
    if (kind === 'changes') { reloading.add(tab); reads.push(tab) } else if (!reloading.delete(tab)) reads.push(tab)
  }
  return reads
}

afterEach(() => { vi.useRealTimers() })

describe('SwarmCards.tick', () => {
  it('lists, reads every tab once, then reads only a tab whose change time moved', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: swarm() }, t2: { lastChangedAt: 4, state: swarm({ name: 'other' }) } })
    await t.cards.tick()
    expect(detailReads(t.calls)).toEqual(['GET /api/super-tabs/t1', 'GET /api/super-tabs/t2'])
    expect(t.seen).toHaveLength(1)
    expect(t.seen[0].map(c => [c.id, c.name, c.count])).toEqual([['t1', 'openharness', 2], ['t2', 'other', 2]])
    t.calls.length = 0
    await t.cards.tick()
    expect(detailReads(t.calls)).toEqual([])
    expect(t.seen).toHaveLength(1)
    t.tabs.t2.lastChangedAt = 5
    t.tabs.t2.state = swarm({ name: 'renamed' })
    t.calls.length = 0
    await t.cards.tick()
    expect(detailReads(t.calls)).toEqual(['GET /api/super-tabs/t2'])
    expect(t.seen.at(-1)?.[1].name).toBe('renamed')
  })

  it('follows `next` through the pages of the list and keeps the first 16 tabs', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: swarm() }, t2: { lastChangedAt: 1, state: swarm() } })
    t.paginate({ '': { next: 't1' }, t1: { next: null } })
    await t.cards.tick()
    expect(t.calls.filter(c => c.includes('?after='))).toEqual(['GET /api/super-tabs/list?after=t1'])
    const wide = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`t${String(i).padStart(2, '0')}`, { lastChangedAt: 1, state: swarm() }]))
    const w = setup(wide)
    await w.cards.tick()
    expect(w.seen[0]).toHaveLength(16)
    expect(detailReads(w.calls)).toHaveLength(16)
  })

  it('drops a tab gone from the list, keeps the last cards when the list fails, and drops only a tab that answers 403', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: swarm() }, t2: { lastChangedAt: 1, state: swarm({ name: 'two' }) } })
    await t.cards.tick()
    t.breakList()
    await t.cards.tick()
    expect(t.seen).toHaveLength(1)
    t.breakList(false)
    t.failing.set('t2', 403)
    t.tabs.t2.lastChangedAt = 2
    await t.cards.tick()
    expect(t.seen.at(-1)?.map(c => c.id)).toEqual(['t1'])
    t.failing.set('t1', 401)
    t.tabs.t1.lastChangedAt = 2
    t.failing.delete('t2')
    await t.cards.tick()
    expect(t.seen.at(-1)?.map(c => c.id)).toEqual(['t2'])
    delete t.tabs.t2
    await t.cards.tick()
    expect(t.seen.at(-1)).toEqual([])
  })

  it('keeps a tab it already read when another failure happens on re-read', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: swarm() } })
    await t.cards.tick()
    t.failing.set('t1', 500)
    t.tabs.t1.lastChangedAt = 2
    await t.cards.tick()
    expect(t.seen).toHaveLength(1)
    await t.cards.tick()
    expect(t.seen).toHaveLength(1)
  })

  it('keeps a paused tab as a card with every Lead done', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: swarm({ paused: true, conversations: [...swarm().conversations, work('web', 'needs_human')] }) } })
    await t.cards.tick()
    expect(t.seen[0][0].leads.map(l => l.state)).toEqual(['done', 'done'])
  })

  it('shows a local Lead in a turn as work, counting `since` from the footer timer, and re-sends only on a change other than since', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: swarm() } }, { activity: { 'h-a1': 'working' }, elapsed: 20 })
    await t.cards.tick()
    expect(t.seen[0][0].leads[0]).toMatchObject({ id: 'a1', state: 'work', since: 20 })
    t.advance(5000)
    await t.cards.tick()
    expect(t.seen).toHaveLength(1)
    vi.mocked(t.core.agents.activity).mockResolvedValue({})
    await t.cards.tick()
    expect(t.seen).toHaveLength(2)
    expect(t.seen[1][0].leads[0].state).toBe('done')
  })

  it('re-sends when the clock\'s turn changes (the Lead\'s ends, a worker\'s goes on), not while the same turn runs', async () => {
    const state = swarm({ agents: [agent('a1'), agent('a2'), agent('b1', { projectId: 'web' })] })
    const t = setup({ t1: { lastChangedAt: 1, state } }, { activity: { 'h-a1': 'working' }, elapsed: 90 })
    await t.cards.tick()
    expect(t.seen[0][0].leads[0]).toMatchObject({ project: 'web', state: 'work', since: 90 })
    // the worker starts too: the Lead's earlier turn is still the clock, nothing to send
    vi.mocked(t.core.agents.activity).mockResolvedValue({ 'h-a1': 'working', 'h-b1': 'working' })
    vi.mocked(t.core.agents.activitySnapshot!).mockResolvedValue({ text: '', elapsedSeconds: 10 })
    t.advance(5000)
    await t.cards.tick()
    expect(t.seen).toHaveLength(1)
    // the Lead's turn ends, the worker's goes on: same state, another start, so the Pro is told
    vi.mocked(t.core.agents.activity).mockResolvedValue({ 'h-b1': 'working' })
    t.advance(5000)
    await t.cards.tick()
    expect(t.seen).toHaveLength(2)
    expect(t.seen[1][0].leads[0]).toMatchObject({ project: 'web', state: 'work', since: 15 })
    t.advance(5000)
    await t.cards.tick()
    expect(t.seen).toHaveLength(2)
  })

  it('sends a turn that just began as 1 s in, never 0 (the Pro shows no clock for 0)', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: swarm() } }, { activity: { 'h-a1': 'working' }, elapsed: 0 })
    await t.cards.tick()
    expect(t.seen[0][0].leads[0]).toMatchObject({ id: 'a1', state: 'work', since: 1 })
  })

  it('names a remote Lead\'s owner using the signed-in account', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: swarm({ agents: [agent('a1', { machineId: 'm2', machineOwnerId: 'sam' }), agent('a2')] }) } })
    await t.cards.tick()
    expect(t.seen[0][0].leads.find(l => l.id === 'a1')).toMatchObject({ owner: 'sam@x.io', local: '' })
  })
})

describe('SwarmCards.recap', () => {
  const msg = (sequence: number, who: string, over: Record<string, unknown> = {}) =>
    ({ id: `x${sequence}`, sequence, text: `m${sequence}`, author: { id: who }, createdAt: '2026-10-22T00:00:00.000Z', ...over })
  const withSequence = (n: number) => swarm({ conversations: [conv('lead-web', 'a1', { projectId: 'web', lastMessageSequence: n }), conv('lead-mobile', 'a2', { projectId: 'mobile' })] })

  // Design 4.6: a page ends on a (sequence, id) pair, so a page edge inside messages of equal sequence skips none of them.
  it('reads the newest page, falls back one page with the page\'s own cursor, then says none', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: withSequence(9) } }, { messages: path => path.includes('before=7&beforeId=x7')
      ? { messages: [msg(5, 'a1'), msg(6, 'a2')], next: null } : { messages: [msg(7, 'a2'), msg(8, 'a2', { source: {} })], next: { sequence: 7, id: 'x7' } } })
    await t.cards.tick()
    const recap = await t.cards.recap('t1', 'a1')
    expect(recap).toEqual({ tabId: 't1', leadId: 'a1', text: 'm5', at: Date.parse('2026-10-22T00:00:00.000Z') / 1000, none: false })
    expect(t.calls.filter(c => c.includes('/messages'))).toEqual([
      'GET /api/super-tabs/t1/conversations/lead-web/messages', 'GET /api/super-tabs/t1/conversations/lead-web/messages?before=7&beforeId=x7'])
    const none = setup({ t1: { lastChangedAt: 1, state: withSequence(9) } }, { messages: () => ({ messages: [msg(7, 'a2')], next: { sequence: 7, id: 'x7' } }) })
    await none.cards.tick()
    expect(await none.cards.recap('t1', 'a1')).toMatchObject({ none: true, text: '', at: 0 })
    const empty = setup({ t1: { lastChangedAt: 1, state: withSequence(0) } })
    await empty.cards.tick()
    expect(await empty.cards.recap('t1', 'a1')).toMatchObject({ none: true })
    expect(empty.calls.filter(c => c.includes('/messages'))).toHaveLength(1)
  })

  it('answers again from memory while the conversation has not moved, and cuts the text at 1,500 bytes', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: withSequence(3) } }, { messages: () => ({ messages: [msg(3, 'a1', { text: `${'x'.repeat(1499)}éé` })], next: null }) })
    await t.cards.tick()
    const first = await t.cards.recap('t1', 'a1')
    expect(Buffer.byteLength(first.text)).toBe(1499)
    t.calls.length = 0
    expect(await t.cards.recap('t1', 'a1')).toBe(first)
    expect(t.calls).toEqual([])
  })

  it('reads the tab itself when it was not polled yet, and refuses unknown ids and Leads', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: withSequence(1) } }, { messages: () => ({ messages: [msg(1, 'a1')], next: null }) })
    expect((await t.cards.recap('t1', 'a1')).none).toBe(false)
    expect((await t.cards.recap('t1', 'nobody')).none).toBe(true)
    expect((await t.cards.recap('bad id', 'a1')).none).toBe(true)
  })

  it('pushes the open Lead\'s new recap once when its conversation advanced', async () => {
    let latest = 1
    const t = setup({ t1: { lastChangedAt: 1, state: withSequence(1) } }, { messages: () => ({ messages: [msg(latest, 'a1')], next: null }) })
    const pushed: string[] = []
    t.cards.onRecap = r => pushed.push(r.text)
    await t.cards.tick()
    t.cards.open('s1', 't1', 'a1')
    await t.cards.tick()
    expect(pushed).toEqual([])
    latest = 2
    t.tabs.t1.lastChangedAt = 2
    t.tabs.t1.state = withSequence(2)
    await t.cards.tick()
    await t.cards.tick()
    expect(pushed).toEqual(['m2'])
    t.cards.open('s1', 't1', null)
    t.tabs.t1.lastChangedAt = 3
    t.tabs.t1.state = withSequence(3)
    await t.cards.tick()
    expect(pushed).toEqual(['m2'])
  })
})

describe('SwarmCards.say', () => {
  it('posts the words as the person in the Lead\'s conversation of a harness here, and is false for any other harness', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: swarm({ agents: [agent('a1', { machineId: 'm2' }), agent('a2')] }) } })
    await t.cards.tick()
    expect(await t.cards.say('h-a2', 'ship it')).toBe(true)
    const post = t.call.mock.calls.find(c => c[0] === 'POST')!
    expect(post[1]).toBe('/api/super-tabs/t1/commands')
    expect(post[2]).toMatchObject({ operationId: expect.stringMatching(/^pro-voice-/),
      command: { type: 'message.send', conversationId: 'lead-mobile', text: 'ship it', replyTo: null, recipientIds: [] } })
    expect(post[2]).not.toHaveProperty('asAgentId')
    expect(await t.cards.say('h-a1', 'x')).toBe(false)   // that Lead runs on another machine
    expect(await t.cards.say('h-zz', 'x')).toBe(false)
    expect(t.call.mock.calls.filter(c => c[0] === 'POST')).toHaveLength(1)
  })
})

describe('SwarmCards.post', () => {
  const people = [{ id: 'me', email: 'me@x.io', role: 'owner' }, { id: 'sam', email: 'sam@x.io', role: 'collaborator' }]
  const chat = (id: string, over: Record<string, unknown> = {}) => conv(id, null, { projectId: 'web', ...over })
  const posts = (t: ReturnType<typeof setup>) => t.call.mock.calls.filter(c => c[0] === 'POST')

  it('posts spoken words as the person in a conversation they can post in, under the device\'s own operation id', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: swarm({ people, conversations: [...swarm().conversations,
      chat('pm-me', { audience: { people: [{ id: 'me', generation: 'g1' }] } })] }) } })
    expect(await t.cards.post('t1', 'lead-web', 'ship it', 'u1')).toEqual({ ok: true })
    expect(await t.cards.post('t1', 'pm-me', 'only for the PM', 'u2')).toEqual({ ok: true })
    expect(posts(t).map(c => [c[1], c[2]])).toEqual([
      ['/api/super-tabs/t1/commands', { operationId: 'device-voice-u1',
        command: { type: 'message.send', conversationId: 'lead-web', text: 'ship it', replyTo: null, recipientIds: [] } }],
      ['/api/super-tabs/t1/commands', { operationId: 'device-voice-u2',
        command: { type: 'message.send', conversationId: 'pm-me', text: 'only for the PM', replyTo: null, recipientIds: [] } }],
    ])
  })

  it('refuses, without posting, where the person cannot post: read-only, archived, someone else\'s private chat, gone', async () => {
    const t = setup({
      ro: { lastChangedAt: 1, state: swarm({ people: [{ id: 'me', email: 'me@x.io', role: 'viewer' }, people[1]] }) },
      t1: { lastChangedAt: 1, state: swarm({ people, conversations: [...swarm().conversations, chat('old', { archived: true }),
        chat('pm-sam', { audience: { people: [{ id: 'sam', generation: 'g1' }] } })] }) },
      out: { lastChangedAt: 1, state: swarm({ people: [people[1]] }) },
    })
    expect(await t.cards.post('ro', 'lead-web', 'x', 'u1')).toEqual({ ok: false, error: 'You can only read this Swarm.' })
    expect(await t.cards.post('t1', 'old', 'x', 'u2')).toEqual({ ok: false, error: 'That conversation is archived.' })
    expect(await t.cards.post('t1', 'pm-sam', 'x', 'u3')).toEqual({ ok: false, error: 'That conversation is not yours to post in.' })
    expect(await t.cards.post('t1', 'gone', 'x', 'u4')).toEqual({ ok: false, error: 'That conversation is no longer there.' })
    expect(await t.cards.post('out', 'lead-web', 'x', 'u5')).toEqual({ ok: false, error: 'You are no longer in this Swarm.' })
    t.failing.set('t1', 403)
    expect(await t.cards.post('t1', 'lead-web', 'x', 'u6')).toEqual({ ok: false, error: 'Could not read the Swarm. Try again.' })
    expect(posts(t)).toEqual([])
  })

  it('says a refused post did not go, and an unconfirmed one may have', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: swarm({ people }) } })
    const read = t.call.getMockImplementation()!
    let answer: () => Promise<unknown> = async () => ({ status: 403, body: { success: false, error: { code: 'READ_ONLY', message: 'no' } } })
    t.call.mockImplementation((async (method: string, path: string, body?: unknown) => method === 'POST' ? answer() : read(method, path, body)) as typeof read)
    expect(await t.cards.post('t1', 'lead-web', 'x', 'u1')).toEqual({ ok: false, error: 'The Swarm refused that message.' })
    answer = async () => { throw new Error('socket hang up') }
    expect(await t.cards.post('t1', 'lead-web', 'x', 'u2')).toEqual({ ok: false, error: 'Could not confirm it was posted. Check the Swarm chat.' })
    answer = async () => ({ status: 502, body: { success: false, error: { code: 'BACKEND_UNAVAILABLE', message: 'no' } } })
    expect(await t.cards.post('t1', 'lead-web', 'x', 'u3')).toEqual({ ok: false, error: 'Could not confirm it was posted. Check the Swarm chat.' })
  })
})

describe('SwarmCards.want', () => {
  it('polls every interval while wanted and not at all after want(false)', async () => {
    vi.useFakeTimers()
    const t = setup({ t1: { lastChangedAt: 1, state: swarm() } })
    t.cards.want(true)
    t.cards.want(true)
    await vi.advanceTimersByTimeAsync(0)
    const listed = () => t.calls.filter(c => c === 'GET /api/super-tabs/list').length
    expect(listed()).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(listed()).toBe(2)
    t.cards.want(false)
    t.calls.length = 0
    await vi.advanceTimersByTimeAsync(20_000)
    expect(t.calls).toEqual([])
  })
})

describe('SwarmCards polling cost and choice', () => {
  const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${String(i).padStart(2, '0')}`, { lastChangedAt: 1, state: swarm({ name: `S${i}` }) }]))

  it('stops paging the list once 16 tabs are in hand', async () => {
    const t = setup(many(40))
    t.pageBy(8)
    await t.cards.tick()
    expect(t.calls.filter(c => c.startsWith('GET /api/super-tabs/list')).length).toBe(2)
    expect(t.seen[0]).toHaveLength(16)
  })

  it('reads the Swarms in `include` first, paging on until they are found, then the rest of the list', async () => {
    const t = setup(many(40))
    t.pageBy(8)
    t.cards.want(true, ['t35', 't02'])
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    expect(t.seen[0].map(c => c.id).slice(0, 4)).toEqual(['t35', 't02', 't00', 't01'])
    expect(t.seen[0]).toHaveLength(16)
    t.cards.want(false)
  })

  it('always reads again a tab whose list row has no numeric change time', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: swarm() } })
    ;(t.tabs.t1 as { lastChangedAt: unknown }).lastChangedAt = undefined
    await t.cards.tick()
    t.calls.length = 0
    await t.cards.tick()
    expect(detailReads(t.calls)).toEqual(['GET /api/super-tabs/t1'])
  })

  it('leaves out a Swarm, a project or a harness whose id the Pro cannot hold (over 47 characters)', async () => {
    const long = 'x'.repeat(48)
    const t = setup({ [long]: { lastChangedAt: 1, state: swarm() }, t1: { lastChangedAt: 1, state: swarm({
      projects: [{ id: long, name: 'long', leadConversationId: 'lead-web' }, { id: 'mobile', name: 'mobile', leadConversationId: 'lead-mobile' }],
      agents: [agent('a1'), agent('a2', { harnessId: long })] }) } })
    await t.cards.tick()
    expect(t.seen[0].map(c => c.id)).toEqual(['t1'])
    expect(t.seen[0][0].leads.map(l => [l.id, l.local])).toEqual([['a2', '']])
  })
})

describe('SwarmCards open recaps and recap reads', () => {
  const msg = (sequence: number, who: string) => ({ sequence, text: `m${sequence}`, author: { id: who }, createdAt: '2026-10-22T00:00:00.000Z' })
  const withSequence = (n: number) => swarm({ conversations: [conv('lead-web', 'a1', { projectId: 'web', lastMessageSequence: n }), conv('lead-mobile', 'a2', { projectId: 'mobile' })] })

  it('keeps the open Lead per session: one Pro closing does not stop another\'s pushes, and one push serves both', async () => {
    let latest = 1
    const t = setup({ t1: { lastChangedAt: 1, state: withSequence(1) } }, { messages: () => ({ messages: [msg(latest, 'a1')], next: null }) })
    const pushed: string[] = []
    t.cards.onRecap = r => pushed.push(r.text)
    await t.cards.tick()
    t.cards.open('s1', 't1', 'a1')
    t.cards.open('s2', 't1', 'a1')
    t.cards.open('s1', 't1', null)
    latest = 2; t.tabs.t1.lastChangedAt = 2; t.tabs.t1.state = withSequence(2)
    await t.cards.tick()
    expect(pushed).toEqual(['m2'])
    t.cards.open('s2', 't1', null)
    latest = 3; t.tabs.t1.lastChangedAt = 3; t.tabs.t1.state = withSequence(3)
    await t.cards.tick()
    expect(pushed).toEqual(['m2'])
  })

  it('does not count a push as done before the recap was read: a failed read is tried again next tick', async () => {
    let fail = true, latest = 1
    const t = setup({ t1: { lastChangedAt: 1, state: withSequence(1) } }, { messages: path => {
      if (fail && latest === 2) throw new Error('offline')
      void path
      return { messages: [msg(latest, 'a1')], next: null }
    } })
    const pushed: string[] = []
    t.cards.onRecap = r => pushed.push(r.text)
    await t.cards.tick()
    t.cards.open('s1', 't1', 'a1')
    latest = 2; t.tabs.t1.lastChangedAt = 2; t.tabs.t1.state = withSequence(2)
    await t.cards.tick()
    expect(pushed).toEqual([])
    fail = false
    await t.cards.tick()
    expect(pushed).toEqual(['m2'])
  })

  it('opened before the tab was read: the first read is the baseline and the next change is pushed', async () => {
    let latest = 1
    const t = setup({ t1: { lastChangedAt: 1, state: withSequence(1) } }, { messages: () => ({ messages: [msg(latest, 'a1')], next: null }) })
    const pushed: string[] = []
    t.cards.onRecap = r => pushed.push(r.text)
    t.cards.open('s1', 't1', 'a1')
    await t.cards.tick()
    expect(pushed).toEqual([])
    latest = 2; t.tabs.t1.lastChangedAt = 2; t.tabs.t1.state = withSequence(2)
    await t.cards.tick()
    expect(pushed).toEqual(['m2'])
  })

  it('has at most two recap reads in flight and refuses a third', async () => {
    const release: Array<() => void> = []
    const t = setup({ t1: { lastChangedAt: 1, state: swarm({ conversations: [conv('lead-web', 'a1', { projectId: 'web', lastMessageSequence: 4 }), conv('lead-mobile', 'a2', { projectId: 'mobile', lastMessageSequence: 4 })],
      agents: [agent('a1'), agent('a2'), agent('a3')] }) } }, {
      messages: () => new Promise(resolve => { release.push(() => resolve({ messages: [msg(4, 'a1'), msg(4, 'a2')], next: null })) }) as never })
    // The fake backend returns the promise's value as data.
    await t.cards.tick()
    const a = t.cards.recap('t1', 'a1'), b = t.cards.recap('t1', 'a2')
    await vi.waitFor(() => expect(release).toHaveLength(2))
    await expect(t.cards.recap('t1', 'a1')).rejects.toThrow()
    release.forEach(r => r())
    await Promise.all([a, b])
  })

  it('forgets the recap of a Lead whose tab is gone', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: withSequence(2) }, t2: { lastChangedAt: 1, state: swarm() } }, { messages: () => ({ messages: [msg(2, 'a1')], next: null }) })
    await t.cards.tick()
    await t.cards.recap('t1', 'a1')
    delete t.tabs.t1
    await t.cards.tick()
    t.calls.length = 0
    t.tabs.t1 = { lastChangedAt: 1, state: withSequence(2) }
    await t.cards.tick()
    await t.cards.recap('t1', 'a1')
    expect(t.calls.filter(c => c.includes('/messages'))).toHaveLength(1)
  })
})
