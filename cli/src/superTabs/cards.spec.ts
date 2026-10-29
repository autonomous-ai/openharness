import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'
import { lastAgentMessage, leadsOf, SwarmCards, type SwarmCard } from './cards.js'
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

/** `web`'s three kinds of chat: its Lead conversation, the reader's Buddy chat (where the PM's private lines land since
 *  Buddies replaced Chat with PM, 10-29), and a group. The backend sends a Buddy chat to its owner alone. */
const pm = (over: Record<string, unknown> = {}) => conv('pm-web', null, { projectId: 'web', kind: 'buddy', buddyOwnerId: 'me', agentIds: [], ...over })
/** The reader's Buddy, as the backend names it (buddies.ts). */
const buddy = (over: Record<string, unknown> = {}) => agent('y1', { name: "diego's Buddy", buddyOf: { personId: 'me', generation: 'g1' }, configuration: { engine: 'codex' }, ...over })
const group = (over: Record<string, unknown> = {}) => conv('g-web', null, { projectId: 'web', title: 'Fix login', agentIds: ['b1'], assignment: { status: 'working' }, ...over })
const chats = (over: Record<string, unknown> = {}) => swarm({
  agents: [agent('a1'), agent('a2'), agent('b1', { projectId: 'web' })],
  conversations: [...swarm().conversations, pm(), group()],
  ...over,
})

describe('leadsOf chats', () => {
  const chatOf = (state: Record<string, unknown>, focus?: string, live: Parameters<typeof leadsOf>[2] = idle) =>
    leadsOf(state, 'm1', live, 'me', focus).leads.find(l => l.projectId === 'web')!.chat

  it('opens each project on its Lead chat', () => {
    expect(leadsOf(chats(), 'm1', idle).leads.map(l => l.chat)).toEqual([
      { kind: 'lead', id: 'lead-web', name: 'Lead', working: false }, { kind: 'lead', id: 'lead-mobile', name: 'Lead', working: false }])
  })

  it('follows the window to the reader\'s Buddy chat in the project', () => {
    expect(chatOf(chats(), 'pm-web')).toEqual({ kind: 'pm', id: 'pm-web', name: 'PM', working: false })
    // The other project keeps its Lead chat.
    expect(leadsOf(chats(), 'm1', idle, 'me', 'pm-web').leads.find(l => l.projectId === 'mobile')!.chat).toMatchObject({ kind: 'lead', id: 'lead-mobile' })
  })

  it('follows the window to a group', () => {
    expect(chatOf(chats(), 'g-web')).toEqual({ kind: 'group', id: 'g-web', name: 'Fix login', working: true })
    const long = chats({ conversations: [...swarm().conversations, group({ title: `${'g'.repeat(47)}éé` })] })
    expect(chatOf(long, 'g-web')!.name).toBe('g'.repeat(47))
    for (const status of ['review', 'needs_human', 'blocked', 'done']) {
      const other = chats({ conversations: [...swarm().conversations, group({ assignment: { status } })] })
      expect(chatOf(other, 'g-web')).toMatchObject({ kind: 'group', working: false })
    }
    // `since` comes from a live turn of one of the group's agents here, and only while the group works.
    const turn = (h: string) => h === 'h-b1' ? { inTurn: true, since: 42 } : { inTurn: false }
    expect(chatOf(chats(), 'g-web', turn)).toEqual({ kind: 'group', id: 'g-web', name: 'Fix login', working: true, since: 42 })
    expect(chatOf(chats(), 'g-web', h => h === 'h-a1' ? { inTurn: true, since: 9 } : { inTurn: false })).not.toHaveProperty('since')
    const done = chats({ conversations: [...swarm().conversations, group({ assignment: { status: 'done' } })] })
    expect(chatOf(done, 'g-web', turn)).not.toHaveProperty('since')
  })

  it('ignores a focus outside the project', () => {
    const lead = { kind: 'lead', id: 'lead-web', name: 'Lead', working: false }
    // another project's conversation, an unknown id, an archived group
    const mobileGroup = conv('g-mobile', null, { projectId: 'mobile', title: 'App', agentIds: [], assignment: { status: 'working' } })
    const state = chats({ conversations: [...swarm().conversations, pm(), group(), mobileGroup] })
    expect(chatOf(state, 'g-mobile')).toEqual(lead)
    expect(chatOf(state, 'nope')).toEqual(lead)
    expect(chatOf(chats({ conversations: [...swarm().conversations, group({ archived: true })] }), 'g-web')).toEqual(lead)
    // and the Lead's own conversation is the Lead chat
    expect(chatOf(state, 'lead-web')).toEqual(lead)
  })

  it('keeps today\'s state for old devices whatever the chat', () => {
    const asks = chats({ conversations: [...swarm().conversations, pm(), group({ assignment: { status: 'needs_human' } })] })
    expect(leadsOf(asks, 'm1', idle, 'me', 'pm-web').leads[0]).toMatchObject({ projectId: 'web', state: 'ask', chat: { kind: 'pm' } })
  })
})

describe('lastAgentMessage', () => {
  const row = (sequence: number, over: Record<string, unknown> = {}) => ({ id: `m${sequence}`, sequence, text: `t${sequence}`, author: { kind: 'agent', id: 'a1' }, createdAt: '2026-10-22T00:00:00.000Z', ...over })
  const lead = new Set(['a1'])
  it('takes the newest row the Lead wrote, skipping system rows and other authors', () => {
    const rows = [row(1), row(2, { source: { kind: 'native' } }), row(3, { author: { id: 'a2' } }), row(4, { text: 7 })]
    expect(lastAgentMessage(rows, lead)).toEqual({ text: 't1', at: Date.parse('2026-10-22T00:00:00.000Z') / 1000, id: 'm1', sequence: 1 })
    expect(lastAgentMessage([row(5), row(1)], lead)?.text).toBe('t5')
    expect(lastAgentMessage([row(1, { createdAt: 1_000_500 })], lead)?.at).toBe(1000)
    expect(lastAgentMessage([row(1, { createdAt: 'x' })], lead)?.at).toBe(0)
  })
  it('takes the newest row by any of the chat\'s agents, skipping the person and source rows', () => {
    const group = new Set(['b1', 'b2'])
    const rows = [row(1, { author: { id: 'b1' } }), row(2, { author: { id: 'b2' } }), row(3, { author: { kind: 'person', id: 'me' } }), row(4, { author: { id: 'b1' }, source: { kind: 'system' } }), row(5)]
    expect(lastAgentMessage(rows, group)).toMatchObject({ text: 't2', id: 'm2', sequence: 2 })
  })
  it('is null when the chat\'s agents have said nothing', () => {
    expect(lastAgentMessage([], lead)).toBeNull()
    expect(lastAgentMessage([row(1, { author: { id: 'a2' } })], lead)).toBeNull()
  })
})

/** A fake backend: tabs by id with the time each last changed, a message store per conversation, and call counting. */
function setup(tabs: Record<string, { lastChangedAt: number; state: Record<string, unknown> }>, extra: { activity?: Record<string, 'working' | 'idle'>; elapsed?: number; messages?: (path: string) => unknown; post?: () => { status: number; body: Record<string, unknown> } } = {}) {
  const calls: string[] = []
  const failing = new Map<string, number>()
  let listFails = false
  let pages: Record<string, { next: string | null }> = {}
  let pageSize = 0
  const call = vi.fn(async (method: string, path: string, _body?: unknown) => {
    calls.push(`${method} ${path}`)
    if (method === 'POST' && extra.post) return extra.post()
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
  const log = vi.fn()
  const cards = new SwarmCards(core, 'm1', { now: () => clock, intervalMs: 5000, log })
  const seen: SwarmCard[][] = []
  cards.onCards = c => seen.push(c)
  return { cards, calls, seen, call, core, failing, tabs, log, paginate: (p: typeof pages) => { pages = p }, pageBy: (n: number) => { pageSize = n }, breakList: (v = true) => { listFails = v }, advance: (ms: number) => { clock += ms } }
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
    expect(await t.cards.say('h-a2', 'ship it')).toEqual({ said: true })
    const post = t.call.mock.calls.find(c => c[0] === 'POST')!
    expect(post[1]).toBe('/api/super-tabs/t1/commands')
    expect(post[2]).toMatchObject({ operationId: expect.stringMatching(/^pro-voice-/),
      command: { type: 'message.send', conversationId: 'lead-mobile', text: 'ship it', replyTo: null, recipientIds: [] } })
    expect(post[2]).not.toHaveProperty('asAgentId')
    expect(await t.cards.say('h-a1', 'x')).toEqual({ said: false })   // that Lead runs on another machine
    expect(await t.cards.say('h-zz', 'x')).toEqual({ said: false })
    expect(t.call.mock.calls.filter(c => c[0] === 'POST')).toHaveLength(1)
  })

  // A refused post was typed into the Lead's terminal instead (spec 2026-10-29 Voice): the dial is told the refusal now.
  it('say reports a 403 as refused with the backend\'s message', async () => {
    let answer = { status: 403, body: { success: false, error: { code: 'PM_CHAT_READ_ONLY', message: 'Chat with PM is read-only.' } } }
    const t = setup({ t1: { lastChangedAt: 1, state: swarm() } }, { post: () => answer })
    await t.cards.tick()
    expect(await t.cards.say('h-a1', 'ship it')).toEqual({ said: false, refused: { code: 'PM_CHAT_READ_ONLY', message: 'Chat with PM is read-only.' } })
    answer = { status: 409, body: { success: false, error: { code: 'BUDDIES_OFF', message: 'Buddies are off in this Swarm.' } } }
    expect(await t.cards.say('h-a1', 'ship it', 'buddy')).toEqual({ said: false, refused: { code: 'BUDDIES_OFF', message: 'Buddies are off in this Swarm.' } })
    // An unreachable backend is not a refusal: it fails as before, and the caller may fall back.
    answer = { status: 503, body: { success: false, error: { code: 'BACKEND_UNAVAILABLE', message: 'down' } } }
    await expect(t.cards.say('h-a1', 'ship it')).rejects.toThrow('down')
    t.call.mockImplementationOnce(async () => { throw new Error('offline') })
    await expect(t.cards.say('h-a1', 'ship it')).rejects.toThrow('offline')
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

/** `web` with its three chats at the given sequences, each conversation's page served from `pages` (newest first or not: the code orders). */
/** With `withBuddy`, the Swarm has Buddies on and the reader's Buddy (`y1`, "diego's Buddy" on Codex) is in their `web` chat. */
function chatSwarm(pages: Record<string, unknown[] | (() => unknown[])>, withBuddy = false) {
  const state = (lead = 1, pmSeq = 1, groupSeq = 1) => chats({
    ...(withBuddy ? { buddies: true, agents: [...chats().agents as object[], buddy()] } : {}),
    conversations: [
      conv('lead-web', 'a1', { projectId: 'web', lastMessageSequence: lead }), conv('lead-mobile', 'a2', { projectId: 'mobile' }),
      pm({ lastMessageSequence: pmSeq, ...(withBuddy ? { agentIds: ['y1'] } : {}) }), group({ lastMessageSequence: groupSeq })] })
  const t = setup({ t1: { lastChangedAt: 1, state: state() } }, { messages: path => {
    const page = pages[/conversations\/([^/]+)\/messages/.exec(path)?.[1] ?? ''] ?? []
    return { messages: typeof page === 'function' ? page() : page, next: null }
  } })
  const move = async (lead: number, pmSeq = 1, groupSeq = 1) => { t.tabs.t1.lastChangedAt++; t.tabs.t1.state = state(lead, pmSeq, groupSeq); await t.cards.tick() }
  const webLead = (cards = t.seen.at(-1)) => cards?.[0].leads.find(l => l.id === 'a1')
  const reads = (conversation: string) => t.calls.filter(c => c.includes(`/conversations/${conversation}/messages`)).length
  return { ...t, move, webLead, reads }
}
const said = (sequence: number, who: string, over: Record<string, unknown> = {}) =>
  ({ id: `x${sequence}`, sequence, text: `m${sequence}`, author: { kind: 'agent', id: who }, source: null, createdAt: '2026-10-22T00:00:00.000Z', ...over })
const saidAt = Date.parse('2026-10-22T00:00:00.000Z') / 1000

describe('SwarmCards notices', () => {
  it('records a baseline on the first read and sends no notice', async () => {
    const t = chatSwarm({ 'lead-web': [said(1, 'a1')], 'pm-web': [said(1, 'a1')] })
    await t.cards.tick()
    await t.cards.tick()
    expect(t.webLead()).not.toHaveProperty('notice')
    expect(t.reads('lead-web') + t.reads('pm-web')).toBe(0)
  })

  it('notices a new Lead message in the Lead conversation', async () => {
    const t = chatSwarm({ 'lead-web': [said(1, 'a1'), said(2, 'a1')] })
    await t.cards.tick()
    await t.move(2)
    expect(t.webLead()?.notice).toEqual({ chat: 'lead', chatId: 'lead-web', id: 'x2', text: 'm2', at: saidAt })
    expect(t.reads('lead-web')).toBe(1)
    // Nothing moved: no read and the same notice.
    await t.cards.tick()
    expect(t.reads('lead-web')).toBe(1)
  })

  it('notices a new private line from the Lead in the reader\'s Buddy chat', async () => {
    const t = chatSwarm({ 'pm-web': [said(2, 'a1', { text: `${'p'.repeat(1499)}éé` })] })
    await t.cards.tick()
    await t.move(1, 2)
    expect(t.webLead()?.notice).toEqual({ chat: 'pm', chatId: 'pm-web', id: 'x2', text: 'p'.repeat(1499), at: saidAt })
  })

  it('never notices a group message, the person\'s message or a system row', async () => {
    const t = chatSwarm({
      'lead-web': [said(2, 'me', { author: { kind: 'person', id: 'me' } }), said(3, 'a1', { source: { kind: 'system' } }), said(4, 'b1')],
      'g-web': [said(2, 'b1')],
    })
    await t.cards.tick()
    await t.move(4, 1, 2)
    expect(t.webLead()).not.toHaveProperty('notice')
    // Groups are never watched: their pages are not read for alerts.
    expect(t.reads('g-web')).toBe(0)
  })

  it('marks a notice from a thread reply, so the dial alerts for it while that chat is open', async () => {
    const t = chatSwarm({ 'lead-web': [said(2, 'a1', { thread: 'x1', replyTo: 'x1' })], 'pm-web': [said(2, 'a1', { thread: 'x1', alsoInChat: true })] })
    await t.cards.tick()
    await t.move(2)
    expect(t.webLead()?.notice).toEqual({ chat: 'lead', chatId: 'lead-web', id: 'x2', text: 'm2', at: saidAt, thread: true })
    const pm = chatSwarm({ 'pm-web': [said(2, 'a1', { thread: 'x1', alsoInChat: true })] })
    await pm.cards.tick()
    await pm.move(1, 2)
    expect(pm.webLead()?.notice).toMatchObject({ chat: 'pm', id: 'x2', thread: true })
  })

  it('one notice for the newest of two messages', async () => {
    const t = chatSwarm({ 'lead-web': [said(3, 'a1'), said(2, 'a1')] })
    await t.cards.tick()
    await t.move(3)
    const notices = t.seen.map(c => t.webLead(c)?.notice?.id).filter(Boolean)
    expect(notices).toEqual(['x3'])
  })

  it('takes the newer of a Lead and a PM message that land in one read', async () => {
    const t = chatSwarm({ 'lead-web': [said(2, 'a1', { createdAt: '2026-10-22T00:05:00.000Z' })], 'pm-web': [said(2, 'a1', { createdAt: '2026-10-22T00:01:00.000Z' })] })
    await t.cards.tick()
    await t.move(2, 2)
    expect(t.webLead()?.notice).toMatchObject({ chat: 'lead', chatId: 'lead-web' })
  })

  it('drops a held notice when its Swarm leaves the cards', async () => {
    const t = chatSwarm({ 'lead-web': [said(2, 'a1')] })
    await t.cards.tick()
    await t.move(2)
    expect(t.webLead()?.notice).toMatchObject({ id: 'x2' })
    const gone = t.tabs.t1
    delete t.tabs.t1
    await t.cards.tick()
    t.tabs.t1 = gone
    await t.cards.tick()
    expect(t.webLead()).not.toHaveProperty('notice')
  })

  it('a failed read keeps the baseline', async () => {
    let fail = true
    const t = chatSwarm({ 'lead-web': () => { if (fail) throw new Error('offline'); return [said(2, 'a1')] } })
    await t.cards.tick()
    await t.move(2)
    await t.cards.tick()
    expect(t.webLead()).not.toHaveProperty('notice')
    // Logged once for the run of failures, not every 5 s.
    expect(t.log).toHaveBeenCalledOnce()
    fail = false
    await t.cards.tick()
    expect(t.webLead()?.notice).toMatchObject({ chat: 'lead', id: 'x2' })
  })

  it('reads a page only for a message after the baseline, and takes none from before it', async () => {
    // The page still holds the Lead's older message; only the person wrote since.
    const t = chatSwarm({ 'lead-web': [said(1, 'a1'), said(2, 'me', { author: { kind: 'person', id: 'me' } })] })
    await t.cards.tick()
    await t.move(2)
    expect(t.webLead()).not.toHaveProperty('notice')
  })

  it('starts a fresh baseline after the devices go, and forgets a tab that leaves the cards', async () => {
    const t = chatSwarm({ 'lead-web': [said(2, 'a1')] })
    await t.cards.tick()
    t.cards.want(false)
    await t.move(2)
    expect(t.webLead()).not.toHaveProperty('notice')
    const gone = t.tabs.t1
    delete t.tabs.t1
    await t.cards.tick()
    t.tabs.t1 = gone
    await t.move(3)
    expect(t.webLead()).not.toHaveProperty('notice')
  })
})

describe('SwarmCards chats', () => {
  const groupSays = [said(1, 'b1'), said(2, 'me', { author: { kind: 'person', id: 'me' } })]

  it('follows a focus change at once, without reading the backend again', async () => {
    const t = chatSwarm({})
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.calls.length = 0
    t.cards.want(true, [], { tabId: 't1', conversationId: 'g-web' })
    expect(t.webLead()?.chat).toMatchObject({ kind: 'group', id: 'g-web' })
    expect(t.calls).toEqual([])
    // A focus on another Swarm leaves this one on its Lead chat; a bad id is no focus.
    t.cards.want(true, [], { tabId: 't2', conversationId: 'g-web' })
    expect(t.webLead()?.chat).toMatchObject({ kind: 'lead' })
    t.cards.want(true, [], { tabId: 't1', conversationId: 'bad id' })
    expect(t.webLead()?.chat).toMatchObject({ kind: 'lead' })
    t.cards.want(false)
  })

  it('recap with chat reads the face chat and names its chatId', async () => {
    const t = chatSwarm({ 'g-web': groupSays, 'pm-web': [said(1, 'a1', { text: 'from the PM' })] })
    t.cards.want(true, [], { tabId: 't1', conversationId: 'g-web' })
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    expect(await t.cards.recap('t1', 'a1', true)).toEqual({ tabId: 't1', leadId: 'a1', text: 'm1', at: saidAt, none: false, chatId: 'g-web' })
    t.cards.want(true, [], { tabId: 't1', conversationId: 'pm-web' })
    expect(await t.cards.recap('t1', 'a1', true)).toMatchObject({ text: 'from the PM', chatId: 'pm-web' })
    t.cards.want(false)
  })

  it('recap without chat is today\'s Lead recap', async () => {
    const t = chatSwarm({ 'lead-web': [said(1, 'a1', { text: 'lead says' })], 'g-web': groupSays })
    t.cards.want(true, [], { tabId: 't1', conversationId: 'g-web' })
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    const recap = await t.cards.recap('t1', 'a1')
    expect(recap).toEqual({ tabId: 't1', leadId: 'a1', text: 'lead says', at: saidAt, none: false })
    expect(t.reads('g-web')).toBe(0)
    t.cards.want(false)
  })

  it('pushes the new chat\'s recap to a dial that has the Lead open with chat when the face changes', async () => {
    const t = chatSwarm({ 'lead-web': [said(1, 'a1', { text: 'lead says' })], 'g-web': groupSays })
    const pushed: Array<{ text: string; chatId?: string }> = []
    t.cards.onRecap = r => pushed.push({ text: r.text, ...(r.chatId ? { chatId: r.chatId } : {}) })
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.cards.open('s1', 't1', 'a1', true)
    t.cards.open('s2', 't1', 'a1')
    t.cards.want(true, [], { tabId: 't1', conversationId: 'g-web' })
    await vi.waitFor(() => expect(pushed).toEqual([{ text: 'm1', chatId: 'g-web' }]))
    // The group moves on: the chat session is told; the Lead conversation did not move, so the Pro is not.
    groupSays.push(said(3, 'b1', { text: 'done' }))
    await t.move(1, 1, 3)
    expect(pushed).toEqual([{ text: 'm1', chatId: 'g-web' }, { text: 'done', chatId: 'g-web' }])
    t.cards.want(false)
  })

  it('say with chat posts message.send to the face chat', async () => {
    const t = chatSwarm({})
    t.cards.want(true, [], { tabId: 't1', conversationId: 'pm-web' })
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    expect(await t.cards.say('h-a1', 'to the PM', true)).toEqual({ said: true })
    expect(await t.cards.say('h-a1', 'to the Lead')).toEqual({ said: true })
    const posts = t.call.mock.calls.filter(c => c[0] === 'POST').map(c => (c[2] as { command: { conversationId: string; text: string } }).command)
    expect(posts.map(p => [p.conversationId, p.text])).toEqual([['pm-web', 'to the PM'], ['lead-web', 'to the Lead']])
    t.cards.want(false)
  })
})

// A Swarm Reviewer on another computer failing every turn took over the round dial with the engine's raw error (2026-10-28):
// the devices ask whether the agent a card names is one of a Swarm's workers, and are answered from the Swarms read last.
describe('SwarmCards.worker', () => {
  /** The Swarm's record of starting a harness on a machine, as the backend keeps it. */
  const started = (id: string, harnessId: string, machineId: string, over: Record<string, unknown> = {}) =>
    ({ id, creationId: `super-${id}`, harnessId, request: { machineId, name: 'Builder' }, error: null, ...over })
  // h1 is a session the person opened by hand and added as an Engineer: no start of the Swarm's names it.
  type Rows = Record<'agents' | 'conversations' | 'starts', Array<Record<string, unknown>>>
  const roster = (more: Partial<Rows> = {}) => swarm({
    agents: [agent('a1'), agent('b1', { machineId: 'm2' }), agent('r1', { machineId: 'm2', role: 'reviewer' }), agent('b2', { machineId: 'm1' }),
      agent('h1', { machineId: 'm2' }), ...more.agents ?? []],
    conversations: [conv('lead-web', 'a1', { projectId: 'web' }), conv('w-web', null, { projectId: 'web', agentIds: ['b1', 'r1', 'h1'] }),
      ...more.conversations ?? []],
    starts: [started('s1', 'h-b1', 'm2'), started('s2', 'h-r1', 'm2'), started('s3', 'h-b2', 'm1'),
      // Not proof that the Swarm started h1: a start that failed, one on another machine, one under another creation id.
      started('s4', 'h-h1', 'm2', { error: 'Its machine did not start it within 3 minutes.' }), started('s5', 'h-h1', 'm1'),
      started('s6', 'h-h1', 'm2', { creationId: 'other' }), ...more.starts ?? []],
  })

  it('says yes for a Builder or Reviewer on the machine the card came from, and no for its Lead', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: roster() } })
    await t.cards.tick()
    expect(t.cards.worker('m2', 'h-b1')).toBe(true)
    expect(t.cards.worker('m2', 'h-r1')).toBe(true)
    expect(t.cards.worker('m1', 'h-a1')).toBe(false)
  })

  it('says no for a member the person started by hand and added, the rule this computer\'s own workers follow', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: roster() } })
    await t.cards.tick()
    expect(t.cards.worker('m2', 'h-h1')).toBe(false)
    expect(t.cards.worker('m1', 'h-b2')).toBe(true)
  })

  // A Buddy is started by the Swarm and leads nothing, yet it is its owner's own agent (combination review of batch #2043).
  it('says no for a Buddy, whose failures on another of its owner\'s computers stay on the owner\'s dial', async () => {
    const owner = { personId: 'p1', generation: 'g1' }
    const state = roster({
      agents: [agent('y1', { machineId: 'm2', buddyOf: owner })],
      conversations: [conv('buddy-p1', null, { projectId: 'web', kind: 'buddy', agentIds: ['y1'] })],
      starts: [started('s7', 'h-y1', 'm2', { request: { machineId: 'm2', name: 'Buddy', buddyOf: owner } })],
    })
    const t = setup({ t1: { lastChangedAt: 1, state } })
    await t.cards.tick()
    expect(t.cards.worker('m2', 'h-y1')).toBe(false)
    expect(t.cards.worker('m2', 'h-b1')).toBe(true)
  })

  it('matches the machine as well as the harness, and knows nothing before a read or of an agent no Swarm lists', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: roster() } })
    expect(t.cards.worker('m2', 'h-b1')).toBe(false)
    await t.cards.tick()
    expect(t.cards.worker('m1', 'h-b1')).toBe(false)
    expect(t.cards.worker('m2', 'h-nobody')).toBe(false)
  })
})

// Round dial PM and Buddy screens (spec 2026-10-29-round-dial-pm-buddy): a dial that speaks swarmBuddy keeps a side per
// Swarm, sees the reader's own Buddy chat as `buddy`, and gets each Lead's buddy block; every other dial keeps today's face.
describe('leadsOf Buddies', () => {
  const on = (over: Record<string, unknown> = {}) => chats({ buddies: true, agents: [...chats().agents as object[], buddy()],
    conversations: [...swarm().conversations, pm({ agentIds: ['y1'] }), group()], ...over })
  const web = (state: Record<string, unknown>, focus?: string, side?: 'pm' | 'buddy') =>
    leadsOf(state, 'm1', idle, 'me', focus, side).leads.find(l => l.projectId === 'web')!

  it('gives each Lead a buddy block for the reader\'s own Buddy, with Desktop\'s avatar', () => {
    expect(web(on()).buddy).toEqual({ chatId: 'pm-web', name: "diego's Buddy", engine: 'codex', cells: 25513, color: '#d6a79a', live: true })
    // The project with no Buddy chat has no block.
    expect(leadsOf(on(), 'm1', idle, 'me').leads.find(l => l.projectId === 'mobile')).not.toHaveProperty('buddy')
    // A Buddy that is down is still the Buddy; its display name is the one Desktop draws and shows.
    const down = on({ agents: [...chats().agents as object[], buddy({ downSince: '2026-10-29T00:00:00.000Z', displayName: "ken's Buddy" })] })
    expect(web(down).buddy).toEqual({ chatId: 'pm-web', name: "ken's Buddy", engine: 'codex', cells: 30735, color: '#d69abb', live: false })
  })

  it('marks buddies only while the Swarm has them on', () => {
    expect(leadsOf(on(), 'm1', idle, 'me').leads.map(l => l.buddies)).toEqual([true, true])
    const off = on({ buddies: undefined })
    expect(web(off)).not.toHaveProperty('buddies')
    expect(web(off)).not.toHaveProperty('buddy')
    expect(web(off)).not.toHaveProperty('sideChat')
    // And with Buddies off a dial's side changes nothing: the face is today's.
    expect(web(off, undefined, 'buddy').chat).toEqual({ kind: 'lead', id: 'lead-web', name: 'Lead', working: false })
  })

  it('shows no buddy block for a Buddy chat with no Buddy agent', () => {
    const removed = on({ agents: chats().agents })
    expect(web(removed)).not.toHaveProperty('buddy')
    // Its screen is still the Buddy chat (the dial draws the empty state), and nothing is said there.
    expect(web(removed, undefined, 'buddy').sideChat).toEqual({ kind: 'buddy', id: 'pm-web', name: 'Buddy', working: false })
  })

  it('never takes another person\'s Buddy chat or Buddy for a face or a block', () => {
    const sams = (over: Record<string, unknown> = {}) => on({ agents: [...chats().agents as object[], buddy({ buddyOf: { personId: 'sam', generation: 'g2' } })],
      conversations: [...swarm().conversations, pm({ agentIds: ['y1'], buddyOwnerId: 'sam' }), group()], ...over })
    const lead = { kind: 'lead', id: 'lead-web', name: 'Lead', working: false }
    for (const side of [undefined, 'pm', 'buddy'] as const) {
      const l = web(sams(), 'pm-web', side)
      expect([l.chat, l.sideChat]).toEqual([lead, lead])
      expect(l).not.toHaveProperty('buddy')
    }
    // Sam's Buddy in the reader's own chat (an agent id reused or misfiled) is not the reader's Buddy either.
    const misfiled = on({ agents: [...chats().agents as object[], buddy({ buddyOf: { personId: 'sam', generation: 'g2' } })] })
    expect(web(misfiled)).not.toHaveProperty('buddy')
    // With nobody signed in, no Buddy chat is anyone's.
    expect(leadsOf(on(), 'm1', idle, undefined, 'pm-web').leads.find(l => l.projectId === 'web')).toMatchObject({ chat: lead, sideChat: lead })
  })

  it('never puts a read-only Chat with PM on the face while Buddies are on', () => {
    const chatWithPm = conv('cpm-web', null, { projectId: 'web', agentIds: ['a1'], audience: { people: [{ id: 'me' }] } })
    const state = on({ conversations: [...swarm().conversations, pm({ agentIds: ['y1'] }), chatWithPm] })
    expect(web(state, 'cpm-web')).toMatchObject({ chat: { kind: 'lead' }, sideChat: { kind: 'lead' } })
    // With Buddies off it is today's: a conversation of the project the window has open.
    expect(web(on({ buddies: undefined, conversations: state.conversations }), 'cpm-web').chat).toMatchObject({ kind: 'group', id: 'cpm-web' })
  })

  it('keeps today\'s face for a dial without swarmBuddy: the Buddy chat the window has open is `pm`, whatever the side', () => {
    for (const side of [undefined, 'pm', 'buddy'] as const) {
      expect(web(on(), 'pm-web', side).chat).toEqual({ kind: 'pm', id: 'pm-web', name: 'PM', working: false })
      expect(web(on(), undefined, side).chat).toEqual({ kind: 'lead', id: 'lead-web', name: 'Lead', working: false })
    }
  })

  it('shows a swarmBuddy dial the Buddy chat the window has open as `buddy`, unless the dial swiped back to the PM', () => {
    expect(web(on(), 'pm-web').sideChat).toEqual({ kind: 'buddy', id: 'pm-web', name: "diego's Buddy", working: false })
    expect(web(on(), 'pm-web', 'pm').sideChat).toEqual({ kind: 'lead', id: 'lead-web', name: 'Lead', working: false })
    // A group the window has open stays the PM screen's face on the PM side, and the Buddy side shows the Buddy chat.
    expect(web(on(), 'g-web').sideChat).toMatchObject({ kind: 'group', id: 'g-web' })
    expect(web(on(), 'g-web', 'buddy').sideChat).toMatchObject({ kind: 'buddy', id: 'pm-web' })
  })
})

describe('SwarmCards Buddy side', () => {
  const buddySays = [said(1, 'a1', { text: 'from the PM' }), said(2, 'y1', { text: 'from the Buddy' }), said(3, 'me', { author: { kind: 'person', id: 'me' }, text: 'mine' })]

  it('puts the Buddy chat on the face on the buddy side, and its recap is the Buddy\'s last message', async () => {
    const t = chatSwarm({ 'pm-web': buddySays }, true)
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.calls.length = 0
    t.cards.side('t1', 'buddy')
    expect(t.webLead()?.sideChat).toEqual({ kind: 'buddy', id: 'pm-web', name: "diego's Buddy", working: false })
    // Rebuilt from the last reads, with no request; an older dial's face did not move.
    expect(t.calls).toEqual([])
    expect(t.webLead()?.chat).toMatchObject({ kind: 'lead' })
    expect(await t.cards.recap('t1', 'a1', 'buddy')).toEqual({ tabId: 't1', leadId: 'a1', text: 'from the Buddy', at: saidAt, none: false, chatId: 'pm-web', buddy: true })
    t.cards.want(false)
  })

  it('keeps the Lead face on the buddy side when the project has no Buddy chat', async () => {
    const t = chatSwarm({}, true)
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.cards.side('t1', 'buddy')
    expect(t.seen.at(-1)?.[0].leads.find(l => l.id === 'a2')?.sideChat).toEqual({ kind: 'lead', id: 'lead-mobile', name: 'Lead', working: false })
    t.cards.want(false)
  })

  it('a later desktop focus clears the dial\'s side', async () => {
    const t = chatSwarm({}, true)
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.cards.side('t1', 'buddy')
    t.cards.want(true, [], { tabId: 't1', conversationId: 'lead-web' })
    expect(t.webLead()?.sideChat).toMatchObject({ kind: 'lead' })
    // Review Focus 1: the desktop opens the Buddy chat (the Buddy screen), then the person swipes down: the swipe wins.
    t.cards.want(true, [], { tabId: 't1', conversationId: 'pm-web' })
    expect(t.webLead()?.sideChat).toMatchObject({ kind: 'buddy' })
    t.cards.side('t1', 'pm')
    expect(t.webLead()?.sideChat).toMatchObject({ kind: 'lead', id: 'lead-web' })
    // The same focus said again is no change; the desktop's next one clears the side.
    t.cards.want(true, [], { tabId: 't1', conversationId: 'pm-web' })
    expect(t.webLead()?.sideChat).toMatchObject({ kind: 'lead' })
    t.cards.want(true, [], { tabId: 't1', conversationId: 'g-web' })
    t.cards.want(true, [], { tabId: 't1', conversationId: 'pm-web' })
    expect(t.webLead()?.sideChat).toMatchObject({ kind: 'buddy' })
    t.cards.want(false)
  })

  it('keeps the side per Swarm, refuses a bad tab or side, and forgets every side when the devices go', async () => {
    const t = chatSwarm({}, true)
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.cards.side('t2', 'buddy')
    t.cards.side('bad id', 'buddy')
    t.cards.side('t1', 'sideways' as 'pm')
    expect(t.webLead()?.sideChat).toMatchObject({ kind: 'lead' })
    t.cards.side('t1', 'buddy')
    expect(t.webLead()?.sideChat).toMatchObject({ kind: 'buddy' })
    t.cards.want(false)
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.webLead()?.sideChat).toMatchObject({ kind: 'lead' }))
    t.cards.want(false)
  })

  it('keeps an older dial\'s recap of the Buddy chat on the PM\'s lines, and the new dial\'s on the Buddy\'s', async () => {
    const t = chatSwarm({ 'pm-web': buddySays }, true)
    t.cards.want(true, [], { tabId: 't1', conversationId: 'pm-web' })
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    expect(await t.cards.recap('t1', 'a1', true)).toEqual({ tabId: 't1', leadId: 'a1', text: 'from the PM', at: saidAt, none: false, chatId: 'pm-web' })
    expect(await t.cards.recap('t1', 'a1', 'buddy')).toMatchObject({ text: 'from the Buddy', chatId: 'pm-web', buddy: true })
    // Each answer is remembered apart: asking again reads nothing.
    const reads = t.reads('pm-web')
    expect(await t.cards.recap('t1', 'a1', true)).toMatchObject({ text: 'from the PM' })
    expect(await t.cards.recap('t1', 'a1', 'buddy')).toMatchObject({ text: 'from the Buddy' })
    expect(t.reads('pm-web')).toBe(reads)
    t.cards.want(false)
  })

  it('pushes the Buddy face\'s recap to the dial that has it open when the side changes, and only that one', async () => {
    const t = chatSwarm({ 'lead-web': [said(1, 'a1', { text: 'lead says' })], 'pm-web': buddySays }, true)
    const pushed: Array<{ text: string; buddy?: true }> = []
    t.cards.onRecap = r => pushed.push({ text: r.text, ...(r.buddy ? { buddy: r.buddy } : {}) })
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.cards.open('s1', 't1', 'a1', 'buddy')
    t.cards.open('s2', 't1', 'a1', true)
    t.cards.side('t1', 'buddy')
    await vi.waitFor(() => expect(pushed).toEqual([{ text: 'from the Buddy', buddy: true }]))
    t.cards.want(false)
  })

  it('say on the buddy side posts message.send to the Buddy chat', async () => {
    const t = chatSwarm({}, true)
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.cards.side('t1', 'buddy')
    expect(await t.cards.say('h-a1', 'to my Buddy', 'buddy')).toEqual({ said: true })
    expect(await t.cards.say('h-a1', 'to the Lead', true)).toEqual({ said: true })
    const posts = t.call.mock.calls.filter(c => c[0] === 'POST').map(c => (c[2] as { command: { conversationId: string; text: string } }).command)
    expect(posts.map(p => [p.conversationId, p.text])).toEqual([['pm-web', 'to my Buddy'], ['lead-web', 'to the Lead']])
    t.cards.want(false)
  })

  it('say posts only into the chat the words were spoken to, and refuses them once the face moved on', async () => {
    const t = chatSwarm({}, true)
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.cards.side('t1', 'buddy')
    expect(await t.cards.say('h-a1', 'to my Buddy', 'buddy', 'pm-web')).toEqual({ said: true })
    // The window opened the Lead after the words were spoken to the Buddy: they are not posted in the project's chat.
    t.cards.want(true, [], { tabId: 't1', conversationId: 'lead-web' })
    expect(await t.cards.say('h-a1', 'still for my Buddy', 'buddy', 'pm-web')).toEqual({ said: false,
      refused: { code: 'CHAT_MOVED', message: 'That chat is no longer on the dial. Say it again.' } })
    const posts = t.call.mock.calls.filter(c => c[0] === 'POST').map(c => (c[2] as { command: { conversationId: string } }).command.conversationId)
    expect(posts).toEqual(['pm-web'])
    t.cards.want(false)
  })
})

// Privacy edges reviews keep finding (Lead, 10-29): an answer read for one reader, or while access lasted, is never given
// after it ended.
describe('SwarmCards access ending while a read is out', () => {
  const buddySays = [said(1, 'a1', { text: 'from the PM' }), said(2, 'y1', { text: 'from the Buddy' })]
  /** The next messages read waits until `release`. */
  const held = (t: ReturnType<typeof chatSwarm>) => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    t.call.mockImplementationOnce(async () => { await gate; return { status: 200, body: { success: true, data: { messages: buddySays, next: null } } } })
    return () => release()
  }

  it('drops a recap read in flight when access to its Swarm is lost, and keeps nothing of it', async () => {
    const t = chatSwarm({ 'pm-web': buddySays }, true)
    await t.cards.tick()
    t.cards.side('t1', 'buddy')
    const release = held(t)
    const pending = t.cards.recap('t1', 'a1', 'buddy')
    t.failing.set('t1', 403)
    t.tabs.t1.lastChangedAt++
    await t.cards.tick()
    release()
    expect(await pending).toEqual({ tabId: 't1', leadId: 'a1', text: '', at: 0, none: true })
    // Access back: the side is forgotten with the Swarm, and the recap is read again, never served from the dropped one.
    t.failing.delete('t1')
    t.tabs.t1.lastChangedAt++
    await t.cards.tick()
    const reads = t.reads('pm-web')
    expect(await t.cards.recap('t1', 'a1', 'buddy')).toMatchObject({ chatId: 'lead-web', none: true })
    t.cards.side('t1', 'buddy')
    expect(await t.cards.recap('t1', 'a1', 'buddy')).toMatchObject({ text: 'from the Buddy', chatId: 'pm-web' })
    expect(t.reads('pm-web')).toBe(reads + 1)
  })

  it('drops a recap read in flight when another person signs in', async () => {
    const t = chatSwarm({ 'pm-web': buddySays }, true)
    await t.cards.tick()
    t.cards.side('t1', 'buddy')
    const release = held(t)
    const pending = t.cards.recap('t1', 'a1', 'buddy')
    vi.mocked(t.core.account.identity).mockResolvedValue({ accountId: 'sam', email: 'sam@x.io' } as never)
    t.tabs.t1.lastChangedAt++
    await t.cards.tick()
    release()
    expect(await pending).toEqual({ tabId: 't1', leadId: 'a1', text: '', at: 0, none: true })
  })
})

describe('SwarmCards Buddy notices', () => {
  it('raises a buddy notice for the Buddy\'s new message, never for the owner\'s', async () => {
    const t = chatSwarm({ 'pm-web': [said(2, 'y1', { text: 'an idea' }), said(3, 'me', { author: { kind: 'person', id: 'me' } })] }, true)
    await t.cards.tick()
    await t.move(1, 3)
    expect(t.webLead()?.buddyNotice).toEqual({ chat: 'buddy', chatId: 'pm-web', id: 'x2', text: 'an idea', at: saidAt })
    // The Buddy's word is quiet: it is not the Lead's notice.
    expect(t.webLead()).not.toHaveProperty('notice')
    const mine = chatSwarm({ 'pm-web': [said(2, 'me', { author: { kind: 'person', id: 'me' } })] }, true)
    await mine.cards.tick()
    await mine.move(1, 2)
    expect(mine.webLead()).not.toHaveProperty('buddyNotice')
  })

  it('keeps the PM\'s private line as the Lead\'s notice when the Buddy speaks after it', async () => {
    const t = chatSwarm({ 'pm-web': [said(2, 'a1', { text: 'from the PM' }), said(3, 'y1', { text: 'from the Buddy' })] }, true)
    await t.cards.tick()
    await t.move(1, 3)
    expect(t.webLead()).toMatchObject({ notice: { chat: 'pm', id: 'x2' }, buddyNotice: { chat: 'buddy', id: 'x3' } })
  })

  it('raises no buddy notice while Buddies are off, or from another person\'s Buddy chat', async () => {
    const off = chatSwarm({ 'pm-web': [said(2, 'y1')] })
    await off.cards.tick()
    await off.move(1, 2)
    expect(off.webLead()).not.toHaveProperty('buddyNotice')
    // Sam's Buddy chat, were it ever sent here: not watched, not read.
    const t = setup({ t1: { lastChangedAt: 1, state: chats({ buddies: true, agents: [...chats().agents as object[], buddy({ buddyOf: { personId: 'sam', generation: 'g2' } })],
      conversations: [...swarm().conversations, pm({ agentIds: ['y1'], buddyOwnerId: 'sam', lastMessageSequence: 1 })] }) } },
    { messages: () => ({ messages: [said(2, 'y1'), said(3, 'a1')], next: null }) })
    await t.cards.tick()
    t.tabs.t1.lastChangedAt++
    t.tabs.t1.state = chats({ buddies: true, agents: [...chats().agents as object[], buddy({ buddyOf: { personId: 'sam', generation: 'g2' } })],
      conversations: [...swarm().conversations, pm({ agentIds: ['y1'], buddyOwnerId: 'sam', lastMessageSequence: 3 })] })
    await t.cards.tick()
    const lead = t.seen.at(-1)?.[0].leads.find(l => l.id === 'a1')
    expect(lead).not.toHaveProperty('buddyNotice')
    expect(lead).not.toHaveProperty('notice')
    expect(t.calls.filter(c => c.includes('/conversations/pm-web/messages'))).toEqual([])
  })

  it('drops a held buddy notice when access to the Swarm is lost', async () => {
    const t = chatSwarm({ 'pm-web': [said(2, 'y1')] }, true)
    await t.cards.tick()
    await t.move(1, 2)
    expect(t.webLead()?.buddyNotice).toMatchObject({ id: 'x2' })
    t.failing.set('t1', 403)
    t.tabs.t1.lastChangedAt++
    await t.cards.tick()
    expect(t.seen.at(-1)).toEqual([])
    t.failing.delete('t1')
    t.tabs.t1.lastChangedAt++
    await t.cards.tick()
    expect(t.webLead()).not.toHaveProperty('buddyNotice')
  })
})
