import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackendNotice, CoreApi } from '../core/api.js'
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
  it('picks one Lead per project through its lead conversation, in the app\'s project order', () => {
    const { count, leads } = leadsOf(swarm(), 'm1', idle)
    expect(count).toBe(2)
    expect(leads.map(l => [l.id, l.projectId, l.project, l.engine, l.local, l.state])).toEqual([['a2', 'mobile', 'mobile', 'claude', 'h-a2', 'done'], ['a1', 'web', 'web', 'claude', 'h-a1', 'done']])
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

  it('orders ask, stuck, work, done with ties in the app\'s project order, and caps at 12 Leads', () => {
    const projects = Array.from({ length: 13 }, (_, i) => ({ id: `p${i}`, name: `P${String(i).padStart(2, '0')}`, leadConversationId: `lead-p${i}` }))
    const many = swarm({ projects, agents: projects.map((_, i) => agent(`a${i}`)),
      conversations: [...projects.map((p, i) => conv(p.leadConversationId, `a${i}`, { projectId: p.id })), work('p5', 'blocked'), work('p9', 'needs_human'), work('p2', 'working'), work('p7', 'needs_human')] })
    const { count, leads } = leadsOf(many, 'm1', idle)
    expect(count).toBe(13)
    expect(leads).toHaveLength(12)
    expect(leads.slice(0, 5).map(l => [l.project, l.state])).toEqual([['P07', 'ask'], ['P09', 'ask'], ['P05', 'stuck'], ['P02', 'work'], ['P00', 'done']])
  })

  // Diego's dial, 2026-11-03: a swipe went by creation order while the app lists projects A to Z (project_sidebar.dart).
  it('orders Leads as the app lists projects: by name A to Z, whatever the case', () => {
    const named = swarm({
      projects: [{ id: 'z', name: 'Zeta', leadConversationId: 'lead-z' }, { id: 'a', name: 'alpha', leadConversationId: 'lead-a' }, { id: 'm', name: 'Mid', leadConversationId: 'lead-m' }],
      agents: [agent('a1'), agent('a2'), agent('a3')],
      conversations: [conv('lead-z', 'a1', { projectId: 'z' }), conv('lead-a', 'a2', { projectId: 'a' }), conv('lead-m', 'a3', { projectId: 'm' })],
    })
    expect(leadsOf(named, 'm1', idle).leads.map(l => [l.project, l.order])).toEqual([['alpha', 0], ['Mid', 1], ['Zeta', 2]])
  })

  it('keeps server order between projects whose names differ only in case', () => {
    const twins = swarm({ projects: [{ id: 'web', name: 'web', leadConversationId: 'lead-web' }, { id: 'mobile', name: 'Web', leadConversationId: 'lead-mobile' }] })
    expect(leadsOf(twins, 'm1', idle).leads.map(l => [l.projectId, l.order])).toEqual([['web', 0], ['mobile', 1]])
    const flipped = swarm({ projects: [{ id: 'mobile', name: 'Web', leadConversationId: 'lead-mobile' }, { id: 'web', name: 'web', leadConversationId: 'lead-web' }] })
    expect(leadsOf(flipped, 'm1', idle).leads.map(l => [l.projectId, l.order])).toEqual([['mobile', 0], ['web', 1]])
  })

  it('gives each Lead its project\'s place in the app\'s A to Z list as `order`, whatever place urgency gives it', () => {
    const three = swarm({
      projects: [...swarm().projects, { id: 'api', name: 'api', leadConversationId: 'lead-api' }],
      agents: [agent('a1'), agent('a2'), agent('a3')],
      conversations: [...swarm().conversations, conv('lead-api', 'a3', { projectId: 'api' }), work('mobile', 'needs_human'), work('api', 'working')],
    })
    expect(leadsOf(three, 'm1', idle).leads.map(l => [l.project, l.state, l.order])).toEqual([['mobile', 'ask', 1], ['api', 'work', 0], ['web', 'done', 2]])
    // The 12 most urgent of 13 keep their own place: the one left out leaves a gap.
    const projects = Array.from({ length: 13 }, (_, i) => ({ id: `p${i}`, name: `P${String(i).padStart(2, '0')}`, leadConversationId: `lead-p${i}` }))
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

// Diego's dial, 2026-11-03: the chat recap showed the PM's latest thread reply, not its latest message in the chat.
describe('lastAgentMessage in a chat or a thread', () => {
  const row = (sequence: number, over: Record<string, unknown> = {}) => ({ id: `m${sequence}`, sequence, text: `t${sequence}`, author: { kind: 'agent', id: 'a1' }, createdAt: '2026-10-22T00:00:00.000Z', ...over })
  const lead = new Set(['a1'])
  const rows = [row(1, { thread: 'm1' }), row(2), row(3, { thread: 'm1', alsoInChat: true }), row(4, { thread: 'm1' }), row(5, { thread: 'm9' })]

  it('in the chat, skips a thread reply but keeps a top-level message, one from before threads and a reply also sent to the chat', () => {
    expect(lastAgentMessage(rows, lead, 'chat')?.text).toBe('t3')
    expect(lastAgentMessage(rows.filter(r => r.sequence !== 3), lead, 'chat')?.text).toBe('t2')
    expect(lastAgentMessage([row(1, { thread: 'm1' }), row(4, { thread: 'm1' })], lead, 'chat')?.text).toBe('t1')
    // Unscoped, as the notices read: every row.
    expect(lastAgentMessage(rows, lead)?.text).toBe('t5')
  })

  it('in a thread, takes only that thread\'s rows, its root among them', () => {
    expect(lastAgentMessage(rows, lead, { thread: 'm1' })?.text).toBe('t4')
    expect(lastAgentMessage([row(1, { thread: 'm1' }), row(5, { thread: 'm9' })], lead, { thread: 'm1' })?.text).toBe('t1')
    expect(lastAgentMessage(rows, lead, { thread: 'nope' })).toBeNull()
  })
})

/** A fake backend: tabs by id with the time each last changed, a message store per conversation, and call counting. */
function setup(tabs: Record<string, { lastChangedAt: number; state: Record<string, unknown> }>, extra: { activity?: Record<string, 'working' | 'idle'>; elapsed?: number; messages?: (path: string) => unknown; post?: () => { status: number; body: Record<string, unknown> }; delayMs?: number; mentions?: (path: string) => unknown[]; decisions?: (path: string) => unknown[]; personal?: string[] } = {}) {
  const calls: string[] = []
  // Message reads in flight now and at most, for a backend whose reads take `delayMs`.
  let reading = 0, mostReading = 0
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
      return { status: 200, body: { success: true, data: { tabs: page.map(id => ({ id, name: String(tabs[id].state.name), ownerId: 'me', lastChangedAt: tabs[id].lastChangedAt, paused: false, ...(extra.personal?.includes(id) ? { personal: true } : {}) })), next } } }
    }
    const tab = /^\/api\/super-tabs\/([^/]+)\/(parts|changes)$/.exec(route)
    if (tab) {
      const code = failing.get(tab[1])
      if (code) return { status: code, body: { success: false, error: { code: 'FORBIDDEN', message: 'no' } } }
      // A tab is read by parts (design 2026-10-26 4.3): a fake keeps no history, so every changes read asks for a first load.
      return { status: 200, body: { success: true, data: swarmReply(path, tabs[tab[1]].state, { lastChangedAt: tabs[tab[1]].lastChangedAt }) } }
    }
    // The real messages page: { messages, next }, `next` the (sequence, id) cursor of the page before.
    reading++; mostReading = Math.max(mostReading, reading)
    try {
      if (extra.delayMs) await new Promise(resolve => setTimeout(resolve, extra.delayMs))
      // The reader's tags, as the backend lists them (mentions.ts listMentions).
      if (/^\/api\/super-tabs\/[^/]+\/mentions$/.test(route)) return { status: 200, body: { success: true, data: { mentions: extra.mentions?.(path) ?? [] } } }
      if (/^\/api\/super-tabs\/[^/]+\/decisions$/.test(route)) return { status: 200, body: { success: true, data: { more: false, decisions: extra.decisions?.(path) ?? [] } } }
      return { status: 200, body: { success: true, data: { ...(extra.messages?.(path) ?? { messages: [], next: null }) as object } } }
    } finally { reading-- }
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
  return { cards, calls, seen, call, core, failing, tabs, log, mostReading: () => mostReading, paginate: (p: typeof pages) => { pages = p }, pageBy: (n: number) => { pageSize = n }, breakList: (v = true) => { listFails = v }, advance: (ms: number) => { clock += ms } }
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

  it('holds the first list while a Swarm could not be read yet, and only for a minute: a list without it says it went', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: swarm() }, t2: { lastChangedAt: 1, state: swarm({ name: 'two' }) } })
    t.failing.set('t1', 500)
    await t.cards.tick()
    expect(t.seen).toEqual([])
    t.failing.delete('t1')
    await t.cards.tick()
    expect(t.seen.at(-1)?.map(c => c.id)).toEqual(['t1', 't2'])
    // Refused is an answer: no wait.
    const refused = setup({ t1: { lastChangedAt: 1, state: swarm() }, t2: { lastChangedAt: 1, state: swarm({ name: 'two' }) } })
    refused.failing.set('t1', 403)
    await refused.cards.tick()
    expect(refused.seen.at(-1)?.map(c => c.id)).toEqual(['t2'])
    // One that keeps failing does not hide the others for long.
    const stuck = setup({ t1: { lastChangedAt: 1, state: swarm() }, t2: { lastChangedAt: 1, state: swarm({ name: 'two' }) } })
    stuck.failing.set('t1', 500)
    await stuck.cards.tick()
    stuck.advance(59_000)
    await stuck.cards.tick()
    expect(stuck.seen).toEqual([])
    stuck.advance(2_000)
    await stuck.cards.tick()
    expect(stuck.seen.at(-1)?.map(c => c.id)).toEqual(['t2'])
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

  // Diego's dial, 2026-10-29: a Lead on another machine has no harness here, so the dial names it by its Swarm id.
  it('posts words for a Lead on another machine, named by its Swarm id, in its conversation as the person', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: swarm({ agents: [agent('a1', { machineId: 'm2' }), agent('a2')] }) } })
    await t.cards.tick()
    expect(await t.cards.say('a1', 'ship it')).toEqual({ said: true })
    const post = t.call.mock.calls.find(c => c[0] === 'POST')!
    expect(post[2]).toMatchObject({ command: { type: 'message.send', conversationId: 'lead-web', text: 'ship it' } })
    expect(post[2]).not.toHaveProperty('asAgentId')
    expect(await t.cards.say('zz', 'x')).toEqual({ said: false })
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

// Spec 2026-11-02-poll-cost Part 4.3: a Pro's cards read the Swarm list every 5 s, ignoring the server's pushes (prod
// 2026-11-02: about 200 of the 279 list reads a minute). While the server says it pushes Swarm changes, as it does to
// Desktop, the list is read when a Swarm's main parts change and every 2 minutes as the safety net.
describe('SwarmCards and the server\'s Swarm pushes', () => {
  it('cards read on push and every 2 minutes, every 5 s without the lease', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: swarm() } })
    let told: ((notice: BackendNotice) => void) | undefined
    const unsubscribe = vi.fn()
    vi.mocked(t.core.account.onNotice).mockImplementation(listener => { told = listener; return unsubscribe })
    const listed = () => t.calls.filter(c => c === 'GET /api/super-tabs/list').length
    // The cards' timer, every 5 s here, and their clock with it.
    const every5s = async (seconds: number) => { for (let s = 0; s < seconds; s += 5) { t.advance(5_000); await vi.advanceTimersByTimeAsync(5_000) } }
    vi.useFakeTimers()
    t.cards.want(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(listed()).toBe(1)
    // No lease: every tick.
    await every5s(10)
    expect(listed()).toBe(3)
    // The server says it pushes: read once now, then only when told or every 2 minutes.
    told!({ type: 'swarm_changed' })
    await every5s(5)
    expect(listed()).toBe(4)
    await every5s(60)
    expect(listed()).toBe(4)
    // A machine's reading changes nothing a card shows; a commit to a Swarm's main parts does.
    told!({ type: 'swarm_changed', tabId: 't1', lastChangedAt: 2, parts: ['machine'] })
    await every5s(5)
    expect(listed()).toBe(4)
    told!({ type: 'swarm_changed', tabId: 't1', lastChangedAt: 3, parts: ['main'] })
    await every5s(5)
    expect(listed()).toBe(5)
    await every5s(115)
    expect(listed()).toBe(5)
    await every5s(5)
    expect(listed()).toBe(6)
    // Five minutes without the server's word: every tick again.
    await every5s(240)
    const lapsed = listed()
    await every5s(10)
    expect(listed()).toBe(lapsed + 2)
    t.cards.want(false)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('under the lease, a Swarm the list could not read yet is read on the next tick, not 2 minutes later', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: swarm() }, t2: { lastChangedAt: 1, state: swarm({ name: 'two' }) } })
    let told: ((notice: BackendNotice) => void) | undefined
    vi.mocked(t.core.account.onNotice).mockImplementation(listener => { told = listener; return () => {} })
    const tick = async () => { t.advance(5_000); await vi.advanceTimersByTimeAsync(5_000) }
    t.failing.set('t1', 500)
    vi.useFakeTimers()
    t.cards.want(true)
    await vi.advanceTimersByTimeAsync(0)
    told!({ type: 'swarm_changed' })
    await tick()
    expect(t.seen).toEqual([])
    t.failing.delete('t1')
    await tick()
    expect(t.seen.at(-1)?.map(c => c.id)).toEqual(['t1', 't2'])
    t.cards.want(false)
  })

  it('reads the list again on the next tick after a list read that failed under the lease', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: swarm() } })
    let told: ((notice: BackendNotice) => void) | undefined
    vi.mocked(t.core.account.onNotice).mockImplementation(listener => { told = listener; return () => {} })
    const listed = () => t.calls.filter(c => c === 'GET /api/super-tabs/list').length
    const tick = async () => { t.advance(5_000); await vi.advanceTimersByTimeAsync(5_000) }
    vi.useFakeTimers()
    t.cards.want(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(listed()).toBe(1)
    told!({ type: 'swarm_changed' })
    t.breakList()
    await tick()
    expect(listed()).toBe(2)
    t.breakList(false)
    await tick()
    expect(listed()).toBe(3)
    await tick()
    expect(listed()).toBe(3)
    t.cards.want(false)
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

/** `web` with its three chats at the given sequences, each conversation's page served from `pages` (newest first or not: the code orders);
 *  a thread's page from `${conversation}#${root}`. */
/** With `withBuddy`, the Swarm has Buddies on and the reader's Buddy (`y1`, "diego's Buddy" on Codex) is in their `web` chat. */
function chatSwarm(pages: Record<string, unknown[] | (() => unknown[])>, withBuddy = false, delayMs = 0, post?: () => { status: number; body: Record<string, unknown> }) {
  const state = (lead = 1, pmSeq = 1, groupSeq = 1) => chats({
    ...(withBuddy ? { buddies: true, agents: [...chats().agents as object[], buddy()] } : {}),
    conversations: [
      conv('lead-web', 'a1', { projectId: 'web', lastMessageSequence: lead }), conv('lead-mobile', 'a2', { projectId: 'mobile' }),
      pm({ lastMessageSequence: pmSeq, ...(withBuddy ? { agentIds: ['y1'] } : {}) }), group({ lastMessageSequence: groupSeq })] })
  const t = setup({ t1: { lastChangedAt: 1, state: state() } }, { messages: path => {
    const id = /conversations\/([^/]+)\/messages/.exec(path)?.[1] ?? '', thread = /[?&]thread=([^&]+)/.exec(path)?.[1], one = /[?&]messageId=([^&]+)/.exec(path)?.[1]
    const page = pages[one ? `${id}@${one}` : thread ? `${id}#${thread}` : id] ?? []
    const rows = typeof page === 'function' ? page() : page
    return { messages: rows, next: null, ...((rows as { threads?: unknown }).threads ? { threads: (rows as { threads?: unknown }).threads } : {}) }
  }, delayMs, post })
  const move = async (lead: number, pmSeq = 1, groupSeq = 1) => { t.tabs.t1.lastChangedAt++; t.tabs.t1.state = state(lead, pmSeq, groupSeq); await t.cards.tick() }
  const webLead = (cards = t.seen.at(-1)) => cards?.[0].leads.find(l => l.id === 'a1')
  const reads = (conversation: string) => t.calls.filter(c => c.includes(`/conversations/${conversation}/messages`)).length
  return { ...t, move, webLead, reads }
}
const said = (sequence: number, who: string, over: Record<string, unknown> = {}) =>
  ({ id: `x${sequence}`, sequence, text: `m${sequence}`, author: { kind: 'agent', id: who }, source: null, createdAt: '2026-10-22T00:00:00.000Z', ...over })
const saidAt = Date.parse('2026-10-22T00:00:00.000Z') / 1000

describe('SwarmCards notices', () => {
  // Diego, 2026-11-04: the dial beeped all day for PM chatter in projects that had nothing to do with him. Only a tag is a
  // notice now (SwarmCards tag notices).
  it('raises no notice for a Lead\'s message in its Lead conversation or the reader\'s Buddy chat, in a thread or not', async () => {
    const t = chatSwarm({ 'lead-web': [said(2, 'a1')], 'pm-web': [said(3, 'a1', { thread: 'r1' })] })
    await t.cards.tick()
    await t.move(2, 3)
    await t.move(3, 4)
    expect(t.seen.flat().flatMap(c => c.leads).filter(l => l.notice)).toEqual([])
    // Nor is either read for one: the face's recap is read when a dial has it open.
    expect(t.reads('lead-web') + t.reads('pm-web')).toBe(0)
  })
})

/** A waiting tag of the reader's, as `/mentions?state=waiting` lists it (backend mentions.ts listMentions). */
const tag = (id: string, conversationId: string, over: Record<string, unknown> = {}) => ({ id, projectId: 'web', projectName: 'web',
  conversationId, conversationTitle: 'Fix login', messageId: `msg-${id}`, leadId: 'sam', leadName: 'Sam', text: '@me look',
  createdAt: '2026-10-22T00:00:00.000Z', resolvedAt: null, resolvedBy: null, threadId: null, messageSequence: 5, ...over })
type Tag = ReturnType<typeof tag>
/** The digest the backend gives a list of waiting tag ids (mentions.ts mentionsDigest). */
const digestOf = (ids: string[]) => createHash('sha256').update([...ids].sort().join('\n')).digest('base64url').slice(0, 16)
/** `web` with its three chats, and the reader's waiting tags behind the Swarm read's `mentionsDigest`. */
function tagSwarm(initial: Tag[] = []) {
  let waiting = initial, offline = false
  const state = (lead = 1) => ({ ...chats({ conversations: [conv('lead-web', 'a1', { projectId: 'web', lastMessageSequence: lead }),
    conv('lead-mobile', 'a2', { projectId: 'mobile' }), pm(), group()] }), mentionsDigest: digestOf(waiting.map(w => w.id)) })
  const t = setup({ t1: { lastChangedAt: 1, state: state() } }, { mentions: path => {
    expect(path).toBe('/api/super-tabs/t1/mentions?state=waiting')
    if (offline) throw new Error('offline')
    return waiting
  }, messages: () => ({ messages: [said(2, 'a1', { text: 'PM chatter' })], next: null }) })
  /** The tags waiting now; the Swarm's change time moves, as a new message moves it. */
  const tagged = async (...rows: Tag[]) => { waiting = rows; t.tabs.t1.lastChangedAt++; t.tabs.t1.state = state(); await t.cards.tick() }
  const said2 = async (lead: number) => { t.tabs.t1.lastChangedAt++; t.tabs.t1.state = state(lead); await t.cards.tick() }
  const mentionReads = () => t.calls.filter(c => c.includes('/mentions')).length
  const webLead = (cards = t.seen.at(-1)) => cards?.[0].leads.find(l => l.id === 'a1')
  return { ...t, tagged, said: said2, mentionReads, webLead, offline: (v: boolean) => { offline = v } }
}

/** An open decision asked of the reader, as `/decisions?state=open` lists it (backend decisions.ts listDecisions). */
const decision = (id: string, over: Record<string, unknown> = {}) => ({ id, batchId: `b-${id}`, projectId: 'web', projectName: 'web', conversationId: 'lead-web',
  conversationTitle: 'Lead', askerAgentId: 'a1', askerName: 'Dee', question: 'Ship it?', options: ['yes', 'no'], recommended: 0,
  createdAt: '2026-10-22T00:00:00.000Z', answeredAt: null, choice: null, note: null, ...over })
type Decision = ReturnType<typeof decision>
/** The digest the backend gives a list of open decision ids (any stable function of them will do for a fake). */
const decisionsDigestOf = (ids: string[]) => `d-${[...ids].sort().join(',')}`
function decisionSwarm(initial: Decision[] = []) {
  let open = initial
  const state = () => ({ ...chats({ conversations: [conv('lead-web', 'a1', { projectId: 'web' }), conv('lead-mobile', 'a2', { projectId: 'mobile' }), pm(), group()] }),
    decisionsDigest: decisionsDigestOf(open.map(d => d.id)) })
  const t = setup({ t1: { lastChangedAt: 1, state: state() } }, { decisions: path => { expect(path).toBe('/api/super-tabs/t1/decisions?state=open'); return open } })
  const asked = async (...rows: Decision[]) => { open = rows; t.tabs.t1.lastChangedAt++; t.tabs.t1.state = state(); await t.cards.tick() }
  return { ...t, asked, webLead: () => t.seen.at(-1)?.[0].leads.find(l => l.id === 'a1') }
}

describe('SwarmCards personal and decisions', () => {
  it('a card carries personal from its list row', async () => {
    const t = setup({ t1: { lastChangedAt: 1, state: swarm() }, t2: { lastChangedAt: 1, state: { ...swarm(), name: 'other' } } }, { personal: ['t1'] })
    await t.cards.tick()
    const cards = t.seen.at(-1)!
    expect(cards.find(c => c.id === 't1')?.personal).toBe(true)
    expect(cards.find(c => c.id === 't2')).not.toHaveProperty('personal')
  })

  it('an open decision asked of the reader becomes its project Lead\'s notice', async () => {
    const t = decisionSwarm([decision('dec1')])
    await t.cards.tick()
    expect(t.webLead()).not.toHaveProperty('notice')
    await t.asked(decision('dec1'), decision('dec2', { createdAt: '2026-10-22T00:05:00.000Z' }))
    expect(t.webLead()?.notice).toEqual({ chat: 'lead', chatId: 'lead-web', id: 'dec2', text: 'Dee asks you: Ship it?', at: saidAt + 300 })
  })

  it('closed decision drops its notice', async () => {
    const t = decisionSwarm()
    await t.cards.tick()
    await t.asked(decision('dec2'))
    expect(t.webLead()?.notice).toMatchObject({ id: 'dec2' })
    await t.asked()
    expect(t.webLead()).not.toHaveProperty('notice')
  })
})

describe('SwarmCards tag notices', () => {
  it('takes the tags waiting at the first read as the baseline, and reads nothing when none wait', async () => {
    const none = tagSwarm()
    await none.cards.tick()
    await none.cards.tick()
    expect(none.mentionReads()).toBe(0)
    const t = tagSwarm([tag('tag1', 'g-web')])
    await t.cards.tick()
    expect(t.mentionReads()).toBe(1)
    expect(t.webLead()).not.toHaveProperty('notice')
    // Nothing moved: no read again.
    await t.cards.tick()
    expect(t.mentionReads()).toBe(1)
  })

  it('a new tag in a task thread is its project Lead\'s notice, naming the chat and the thread', async () => {
    const t = tagSwarm([tag('tag1', 'g-web')])
    await t.cards.tick()
    await t.tagged(tag('tag2', 'g-web', { threadId: 'r1', createdAt: '2026-10-22T00:05:00.000Z' }), tag('tag1', 'g-web'))
    expect(t.webLead()?.notice).toEqual({ chat: 'group', chatId: 'g-web', id: 'tag2', text: 'Sam: @me look', at: saidAt + 300, thread: 'r1' })
    expect(t.mentionReads()).toBe(2)
    // The digest did not move: no read, the same notice.
    await t.cards.tick()
    expect(t.mentionReads()).toBe(2)
    expect(t.webLead()?.notice).toMatchObject({ id: 'tag2' })
    // tag2 read on the desktop: the digest moves, and no tag is new.
    await t.tagged(tag('tag1', 'g-web'))
    expect(t.mentionReads()).toBe(3)
    expect(t.webLead()).not.toHaveProperty('notice')
  })

  it('names a tag in the Lead conversation `lead`, in the reader\'s Buddy chat `pm`, and the newest of two for one project', async () => {
    const t = tagSwarm()
    await t.cards.tick()
    await t.tagged(tag('tag1', 'lead-web'))
    expect(t.webLead()?.notice).toMatchObject({ chat: 'lead', chatId: 'lead-web', id: 'tag1' })
    expect(t.webLead()?.notice).not.toHaveProperty('thread')
    await t.tagged(tag('tag1', 'lead-web'), tag('tag2', 'pm-web', { createdAt: '2026-10-22T00:01:00.000Z' }),
      tag('tag3', 'g-web', { createdAt: '2026-10-22T00:09:00.000Z' }), tag('tag4', 'lead-mobile', { projectId: 'mobile' }))
    expect(t.webLead()?.notice).toMatchObject({ chat: 'group', id: 'tag3' })
    expect(t.seen.at(-1)?.[0].leads.find(l => l.id === 'a2')?.notice).toMatchObject({ chat: 'lead', chatId: 'lead-mobile', id: 'tag4' })
    await t.tagged(tag('tag5', 'pm-web', { createdAt: '2026-10-22T00:10:00.000Z' }))
    expect(t.webLead()?.notice).toMatchObject({ chat: 'pm', chatId: 'pm-web', id: 'tag5' })
  })

  it('a tag seen once is never a notice again, and one waiting when the devices came back is not one', async () => {
    const t = tagSwarm()
    await t.cards.tick()
    await t.tagged(tag('tag1', 'g-web'))
    expect(t.webLead()?.notice).toMatchObject({ id: 'tag1' })
    // The devices went; a tag came meanwhile; they came back: both are the new baseline.
    t.cards.want(false)
    await t.tagged(tag('tag1', 'g-web'), tag('tag2', 'g-web'))
    expect(t.webLead()).not.toHaveProperty('notice')
    await t.tagged(tag('tag1', 'g-web'), tag('tag2', 'g-web'), tag('tag3', 'lead-mobile', { projectId: 'mobile' }))
    expect(t.webLead()).not.toHaveProperty('notice')
    expect(t.seen.at(-1)?.[0].leads.find(l => l.id === 'a2')?.notice).toMatchObject({ id: 'tag3' })
  })

  it('the PM\'s messages that tag nobody raise no notice and are not read for one', async () => {
    const projects = ['p0', 'p1', 'p2', 'p3', 'p4']
    const busy = (n: number) => swarm({ projects: projects.map(p => ({ id: p, name: p, leadConversationId: `lead-${p}` })),
      agents: projects.map(p => agent(`a-${p}`)), mentionsDigest: digestOf([]),
      conversations: projects.map(p => conv(`lead-${p}`, `a-${p}`, { projectId: p, lastMessageSequence: n })) })
    const t = setup({ t1: { lastChangedAt: 1, state: busy(0) } }, { messages: path => ({ messages: [said(9, `a-${/lead-(p\d)/.exec(path)?.[1]}`)], next: null }) })
    await t.cards.tick()
    // 20 messages: four from each project's PM.
    for (let n = 1; n <= 4; n++) { t.tabs.t1.lastChangedAt++; t.tabs.t1.state = busy(n); await t.cards.tick() }
    expect(t.seen.flat().flatMap(c => c.leads).filter(l => l.notice)).toEqual([])
    expect(t.calls.filter(c => c.includes('/messages') || c.includes('/mentions'))).toEqual([])
  })

  it('a failed read of the tags keeps the digest, is logged once and is read again at the next poll', async () => {
    const t = tagSwarm()
    await t.cards.tick()
    t.offline(true)
    await t.tagged(tag('tag1', 'g-web'))
    await t.cards.tick()
    expect(t.webLead()).not.toHaveProperty('notice')
    expect(t.log).toHaveBeenCalledOnce()
    t.offline(false)
    await t.cards.tick()
    expect(t.webLead()?.notice).toMatchObject({ id: 'tag1' })
  })

  it('makes no notice for a tag of a project with no Lead, and keeps going', async () => {
    const t = tagSwarm()
    await t.cards.tick()
    await t.tagged(tag('tag1', 'g-gone', { projectId: 'gone' }), tag('tag2', 'g-web', { createdAt: '2026-10-21T00:00:00.000Z' }))
    expect(Object.fromEntries(t.seen.at(-1)![0].leads.map(l => [l.id, l.notice?.id]))).toEqual({ a1: 'tag2', a2: undefined })
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
    expect(web(on()).buddy).toEqual({ chatId: 'pm-web', name: "diego's Buddy", engine: 'codex', cells: 25513, color: '#d6a79a', live: true, local: 'h-y1' })
    // The project with no Buddy chat has no block.
    expect(leadsOf(on(), 'm1', idle, 'me').leads.find(l => l.projectId === 'mobile')).not.toHaveProperty('buddy')
    // A Buddy that is down is still the Buddy; its display name is the one Desktop draws and shows.
    const down = on({ agents: [...chats().agents as object[], buddy({ downSince: '2026-10-29T00:00:00.000Z', displayName: "ken's Buddy" })] })
    expect(web(down).buddy).toEqual({ chatId: 'pm-web', name: "ken's Buddy", engine: 'codex', cells: 30735, color: '#d69abb', live: false, local: 'h-y1' })
  })

  it('names the Buddy\'s session only when it runs on this computer, so a tap on it can be told from any other', () => {
    // On another machine, or with no session the core holds here: no id, and a tap on the dial opens nothing new.
    const elsewhere = on({ agents: [...chats().agents as object[], buddy({ machineId: 'm2' })] })
    expect(web(elsewhere).buddy).not.toHaveProperty('local')
    expect(leadsOf(on(), 'm1', h => h === 'h-y1' ? null : { inTurn: false }, 'me').leads.find(l => l.projectId === 'web')!.buddy).not.toHaveProperty('local')
    const unnamed = on({ agents: [...chats().agents as object[], buddy({ harnessId: '' })] })
    expect(web(unnamed).buddy).not.toHaveProperty('local')
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

  // Spec 2026-10-30-buddy-thread-sessions: a thread session is a second Buddy agent in the chat, answering in its thread only.
  it('takes the main Buddy for the block, never a thread session listed first', () => {
    const session = agent('s1', { name: "diego's Buddy", displayName: 'Thread', buddyOf: { personId: 'me', generation: 'g1' }, configuration: { engine: 'claude' },
      buddySession: { thread: 'root-1', from: 3 } })
    const state = chats({ buddies: true, agents: [...chats().agents as object[], session, buddy()],
      conversations: [...swarm().conversations, pm({ agentIds: ['s1', 'y1'] }), group()] })
    expect(web(state).buddy).toMatchObject({ chatId: 'pm-web', name: "diego's Buddy", engine: 'codex', local: 'h-y1' })
    // A chat with only a thread session (its main Buddy removed) has no Buddy for the block.
    const alone = chats({ buddies: true, agents: [...chats().agents as object[], session], conversations: [...swarm().conversations, pm({ agentIds: ['s1'] }), group()] })
    expect(web(alone)).not.toHaveProperty('buddy')
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

// Diego's dial, 2026-11-03: a switch to the PM or Buddy side showed the resting pet 5-6 s before the recap, the dial's own
// read refused while the notices' and the pushes' two reads ran (the notices' read is the tags' since #2965).
describe('SwarmCards dial recap', () => {
  const buddySays = [said(1, 'a1', { text: 'from the PM' }), said(2, 'y1', { text: 'from the Buddy' })]

  it('answers the dial\'s recap while two background reads run', async () => {
    let digest = digestOf([])
    const state = () => ({ ...chats({ buddies: true, agents: [...chats().agents as object[], buddy()],
      conversations: [...swarm().conversations, pm({ agentIds: ['y1'] }), group()] }), mentionsDigest: digest })
    const pages: Record<string, unknown[]> = { 'pm-web': buddySays, 'lead-mobile': [said(1, 'a2', { text: 'mobile says' })] }
    const t = setup({ t1: { lastChangedAt: 1, state: state() } }, { delayMs: 50, mentions: () => [tag('tag1', 'g-web')],
      messages: path => ({ messages: pages[/conversations\/([^/]+)\//.exec(path)?.[1] ?? ''] ?? [], next: null }) })
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.cards.open('s1', 't1', 'a1', 'buddy')
    // Someone tagged the reader: the poll reads the tags.
    digest = digestOf(['tag1'])
    t.tabs.t1.lastChangedAt++
    t.tabs.t1.state = state()
    const polled = t.cards.tick()
    await vi.waitFor(() => expect(t.calls.filter(c => c.includes('/mentions'))).toHaveLength(1), { interval: 1 })
    // The dial swiped: the push of its new face reads the Buddy chat.
    t.cards.side('t1', 'buddy')
    await vi.waitFor(() => expect(t.calls.filter(c => c.includes('/conversations/pm-web/messages'))).toHaveLength(1), { interval: 1 })
    await expect(t.cards.recap('t1', 'a2', 'buddy')).resolves.toMatchObject({ text: 'mobile says', none: false, chatId: 'lead-mobile' })
    await polled
    t.cards.want(false)
  })

  it('answers a side switch from the held recap with no backend request', async () => {
    const t = chatSwarm({ 'lead-web': [said(1, 'a1', { text: 'lead says' })], 'pm-web': buddySays }, true)
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    expect(await t.cards.recap('t1', 'a1', 'buddy')).toMatchObject({ text: 'lead says', chatId: 'lead-web' })
    t.cards.side('t1', 'buddy')
    expect(await t.cards.recap('t1', 'a1', 'buddy')).toMatchObject({ text: 'from the Buddy', chatId: 'pm-web' })
    // A poll between the swipes keeps the recap of the side not shown.
    await t.cards.tick()
    t.calls.length = 0
    t.cards.side('t1', 'pm')
    expect(await t.cards.recap('t1', 'a1', 'buddy')).toMatchObject({ text: 'lead says', chatId: 'lead-web' })
    expect(t.calls.filter(c => c.includes('/messages'))).toEqual([])
    t.cards.want(false)
  })

  it('answers a held recap at once when its chat moved on, then pushes the newer one', async () => {
    let latest = 1
    const t = chatSwarm({ 'g-web': () => [said(latest, 'b1', { text: `group ${latest}` })] })
    const pushed: string[] = []
    t.cards.onRecap = r => pushed.push(r.text)
    t.cards.want(true, [], { tabId: 't1', conversationId: 'g-web' })
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    expect(await t.cards.recap('t1', 'a1', true)).toMatchObject({ text: 'group 1', chatId: 'g-web' })
    latest = 2
    await t.move(1, 1, 2)
    expect(await t.cards.recap('t1', 'a1', true)).toMatchObject({ text: 'group 1', chatId: 'g-web' })
    await vi.waitFor(() => expect(pushed).toEqual(['group 2']))
    // The newer one is held: asked again, it is answered with no read.
    const reads = t.reads('g-web')
    expect(await t.cards.recap('t1', 'a1', true)).toMatchObject({ text: 'group 2' })
    expect(t.reads('g-web')).toBe(reads)
    t.cards.want(false)
  })

  it('answers the face\'s recap from its chat, never from a tag notice of that chat', async () => {
    const t = tagSwarm()
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    await t.tagged(tag('tag1', 'lead-web', { text: '@me look here' }))
    expect(t.webLead()?.notice).toMatchObject({ chatId: 'lead-web', text: 'Sam: @me look here' })
    expect(await t.cards.recap('t1', 'a1', true)).toMatchObject({ text: 'PM chatter', chatId: 'lead-web', none: false })
    t.cards.want(false)
  })

  it('reads the dial\'s recaps one at a time, every one answered', async () => {
    const t = chatSwarm({ 'lead-web': [said(1, 'a1', { text: 'web says' })], 'lead-mobile': [said(1, 'a2', { text: 'mobile says' })] }, false, 50)
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    const answers = await Promise.all([t.cards.recap('t1', 'a1', true), t.cards.recap('t1', 'a2', true), t.cards.recap('t1', 'a1')])
    expect(answers.map(a => a.text)).toEqual(['web says', 'mobile says', 'web says'])
    expect(t.mostReading()).toBe(1)
    t.cards.want(false)
  })
})

describe('SwarmCards chat recap and threads', () => {
  it('recaps the chat with the agent\'s latest top-level message, not a thread reply', async () => {
    const t = chatSwarm({ 'lead-web': [said(1, 'a1', { text: 'top', thread: 'x1' }), said(2, 'a1', { text: 'in the thread', thread: 'x1' })] })
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    expect(await t.cards.recap('t1', 'a1', true)).toMatchObject({ text: 'top', chatId: 'lead-web' })
    expect(await t.cards.recap('t1', 'a1')).toMatchObject({ text: 'top' })
    t.cards.want(false)
  })

  const threadPages = {
    'lead-web': [said(1, 'a1', { text: 'top', thread: 'x1' }), said(2, 'a1', { text: 'other top' }), said(5, 'b1', { text: 'worker reply', thread: 'x1' })],
    'lead-web#x1': [said(1, 'a1', { text: 'top', thread: 'x1' }), said(5, 'b1', { text: 'worker reply', thread: 'x1' }),
      said(6, 'me', { author: { kind: 'person', id: 'me' }, text: 'mine', thread: 'x1' })],
  }
  const onThread = { tabId: 't1', conversationId: 'lead-web', threadRoot: 'x1' }

  it('shows a thread on the face by its newest agent reply, and closing it pushes the chat recap', async () => {
    const t = chatSwarm(threadPages)
    const pushed: string[] = []
    t.cards.onRecap = r => pushed.push(r.text)
    t.cards.want(true, [], onThread)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.cards.open('s1', 't1', 'a1', true)
    expect(await t.cards.recap('t1', 'a1', true)).toMatchObject({ text: 'worker reply', chatId: 'lead-web', none: false })
    expect(t.calls.filter(c => c.includes('/messages'))).toEqual(['GET /api/super-tabs/t1/conversations/lead-web/messages?thread=x1'])
    t.cards.want(true, [], { tabId: 't1', conversationId: 'lead-web' })
    await vi.waitFor(() => expect(pushed).toEqual(['other top']))
    // Opened again, the thread's recap is its own, not the chat's.
    t.cards.want(true, [], onThread)
    await vi.waitFor(() => expect(pushed).toEqual(['other top', 'worker reply']))
    t.cards.want(false)
  })

  it('says words spoken with a thread on the face in that thread, and in the chat once it closed', async () => {
    const t = chatSwarm(threadPages)
    t.cards.want(true, [], onThread)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    expect(await t.cards.say('h-a1', 'in the thread', true)).toEqual({ said: true })
    expect(await t.cards.say('h-a1', 'pinned to the chat', true, 'lead-web')).toEqual({ said: true })
    t.cards.want(true, [], { tabId: 't1', conversationId: 'lead-web' })
    expect(await t.cards.say('h-a1', 'in the chat', true, 'lead-web')).toEqual({ said: true })
    const posts = t.call.mock.calls.filter(c => c[0] === 'POST').map(c => (c[2] as { command: { conversationId: string; text: string; replyTo: string | null } }).command)
    expect(posts.map(p => [p.conversationId, p.text, p.replyTo])).toEqual([['lead-web', 'in the thread', 'x1'], ['lead-web', 'pinned to the chat', 'x1'], ['lead-web', 'in the chat', null]])
    t.cards.want(false)
  })

  it('leaves out a thread whose conversation is not the one on the face', async () => {
    const t = chatSwarm({ ...threadPages, 'pm-web': [said(2, 'y1', { text: 'from the Buddy' })] }, true)
    t.cards.want(true, [], onThread)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.cards.side('t1', 'buddy')
    expect(await t.cards.recap('t1', 'a1', 'buddy')).toMatchObject({ text: 'from the Buddy', chatId: 'pm-web' })
    expect(await t.cards.say('h-a1', 'to the Buddy', 'buddy')).toEqual({ said: true })
    const [post] = t.call.mock.calls.filter(c => c[0] === 'POST').map(c => (c[2] as { command: { conversationId: string; replyTo: string | null } }).command)
    expect([post.conversationId, post.replyTo]).toEqual(['pm-web', null])
    // The Pro's Lead recap never follows the face.
    expect(await t.cards.recap('t1', 'a1')).toMatchObject({ text: 'other top' })
    expect(t.calls.filter(c => c.includes('?thread='))).toEqual([])
    t.cards.want(false)
  })

  it('never answers the chat recap from a thread reply', async () => {
    const t = chatSwarm({ 'lead-web': [said(1, 'a1', { text: 'top', thread: 'x1' }), said(2, 'a1', { text: 'in the thread', thread: 'x1' })] })
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    await t.move(2)
    expect(await t.cards.recap('t1', 'a1', true)).toMatchObject({ text: 'top', chatId: 'lead-web' })
    t.cards.want(false)
  })
})

describe('the face thread', () => {
  const posted = () => ({ status: 200, body: { success: true, data: { result: { messageId: 'm9' } } } })
  const root = (id: string, text: string) => said(3, 'me', { id, text, author: { kind: 'person', id: 'me' }, thread: id })
  const pages = {
    'lead-web#m9': [root('m9', 'build it\nplease'), said(5, 'a1', { text: 'on it', thread: 'm9' })],
    'lead-web#x1': Object.assign([root('x1', 'fix login\nmore'), said(5, 'a1', { text: 'done', thread: 'x1' })], { threads: [{ id: 'x1', replies: 2 }] }),
  }
  const onThread = { tabId: 't1', conversationId: 'lead-web', threadRoot: 'x1' }
  const started = async (withBuddy = false) => {
    const t = chatSwarm(pages, withBuddy, 0, posted)
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    return t
  }
  const posts = (t: { call: { mock: { calls: unknown[][] } } }) =>
    t.call.mock.calls.filter(c => c[0] === 'POST').map(c => (c[2] as { command: { conversationId: string; replyTo: string | null } }).command)

  it('words said at top level start the dial\'s thread', async () => {
    const t = await started()
    expect(t.webLead()?.chat).not.toHaveProperty('thread')
    expect(await t.cards.say('h-a1', 'build it\nplease', true, undefined, false, { threaded: true })).toEqual({ said: true, thread: { tabId: 't1', conversationId: 'lead-web', root: 'm9' } })
    expect(t.webLead()?.chat?.thread).toEqual({ root: 'm9', title: 'build it' })
    expect(await t.cards.recap('t1', 'a1', true)).toMatchObject({ text: 'on it', chatId: 'lead-web', thread: 'm9' })
    t.cards.want(false)
  })

  it('cuts the dial\'s thread title to 80 bytes on a character', async () => {
    const t = await started()
    await t.cards.say('h-a1', 'é'.repeat(60), true, undefined, false, { threaded: true })
    expect(t.webLead()?.chat?.thread?.title).toBe('é'.repeat(40))
    t.cards.want(false)
  })

  it('words said by a dial without swarmThread start no thread', async () => {
    const t = await started()
    expect(await t.cards.say('h-a1', 'build it', true)).toEqual({ said: true })
    expect(t.webLead()?.chat).not.toHaveProperty('thread')
    expect(await t.cards.recap('t1', 'a1', true)).not.toHaveProperty('thread')
    t.cards.want(false)
  })

  it('swiping to the Buddy side forgets the PM\'s thread', async () => {
    const t = await started(true)
    await t.cards.say('h-a1', 'build it', 'buddy', undefined, false, { threaded: true })
    expect(t.webLead()?.sideChat?.thread?.root).toBe('m9')
    t.cards.side('t1', 'buddy')
    t.cards.side('t1', 'pm')
    expect(t.webLead()?.sideChat).not.toHaveProperty('thread')
    expect(t.webLead()?.chat).not.toHaveProperty('thread')
    t.cards.want(false)
  })

  it('starts no thread when the answer has no message id', async () => {
    const t = chatSwarm(pages, false, 0, () => ({ status: 200, body: { success: true, data: {} } }))
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    expect(await t.cards.say('h-a1', 'hello', true, undefined, false, { threaded: true })).toEqual({ said: true })
    expect(t.webLead()?.chat).not.toHaveProperty('thread')
    t.cards.want(false)
  })

  it('words said in a thread reply in it and start nothing', async () => {
    const t = await started()
    t.cards.want(true, [], onThread)
    expect(await t.cards.say('h-a1', 'more', true, undefined, false, { threaded: true })).toEqual({ said: true })
    expect(posts(t).map(p => [p.conversationId, p.replyTo])).toEqual([['lead-web', 'x1']])
    t.cards.want(false)
  })

  it('the app\'s thread is the face\'s, titled from its root and counted from the read', async () => {
    const t = await started()
    t.cards.want(true, [], onThread)
    expect(t.webLead()?.chat?.thread).toMatchObject({ root: 'x1' })
    expect(await t.cards.recap('t1', 'a1', true)).toMatchObject({ text: 'done', thread: 'x1' })
    await vi.waitFor(() => expect(t.webLead()?.chat?.thread).toEqual({ root: 'x1', title: 'fix login', replies: 2 }))
    t.cards.want(false)
  })

  it('a focus move clears the dial\'s thread', async () => {
    const t = await started()
    await t.cards.say('h-a1', 'build it', true, undefined, false, { threaded: true })
    // The move the dial's own thread caused keeps it.
    t.cards.want(true, [], { tabId: 't1', conversationId: 'lead-web', threadRoot: 'm9', fromDevice: true })
    expect(t.webLead()?.chat?.thread?.root).toBe('m9')
    t.cards.want(true, [], { tabId: 't1', conversationId: 'lead-web' })
    expect(t.webLead()?.chat).not.toHaveProperty('thread')
    expect(await t.cards.recap('t1', 'a1', true)).not.toHaveProperty('thread')
    t.cards.want(false)
  })

  it('threadLeave clears the dial\'s thread and names the conversation', async () => {
    const t = await started()
    await t.cards.say('h-a1', 'build it', true, undefined, false, { threaded: true })
    expect(t.cards.threadLeave('t1', 'a1')).toEqual({ tabId: 't1', conversationId: 'lead-web' })
    expect(t.webLead()?.chat).not.toHaveProperty('thread')
    expect(t.cards.threadLeave('t1', 'a1')).toBeNull()
    // The app's thread too: the dial is off it until the app moves again.
    t.cards.want(true, [], onThread)
    expect(t.cards.threadLeave('t1', 'a1')).toEqual({ tabId: 't1', conversationId: 'lead-web' })
    expect(t.webLead()?.chat).not.toHaveProperty('thread')
    expect(t.cards.threadLeave('t1', 'zz')).toBeNull()
    t.cards.want(false)
  })

  it('a thread lives only while its conversation is on the face', async () => {
    const t = await started(true)
    expect(await t.cards.say('h-a1', 'build it', 'buddy', undefined, false, { threaded: true })).toMatchObject({ said: true, thread: { root: 'm9' } })
    expect(t.webLead()?.sideChat?.thread?.root).toBe('m9')
    t.cards.side('t1', 'buddy')
    expect(t.webLead()?.sideChat).toMatchObject({ kind: 'buddy' })
    expect(t.webLead()?.sideChat).not.toHaveProperty('thread')
    expect(await t.cards.recap('t1', 'a1', 'buddy')).not.toHaveProperty('thread')
    t.cards.want(false)
  })
  const asMe = { threaded: true, thread: null as string | null }
  const hidden = (t: Awaited<ReturnType<typeof started>>, over: Record<string, unknown> = {}) => t.cards.want(true, [], { tabId: 't1', conversationId: 'lead-web', ...over })

  it('a hidden pane keeps the dial\'s thread: the same root announced again clears nothing, the app closing it does', async () => {
    const t = await started()
    await t.cards.say('h-a1', 'build it', true, undefined, false, asMe)
    // The window announces the very thread it was asked to open, and keeps announcing it while the pane is hidden.
    for (let i = 0; i < 3; i++) {
      hidden(t, { threadRoot: 'm9' })
      expect(t.webLead()?.chat?.thread).toEqual({ root: 'm9', title: 'build it' })
    }
    hidden(t, { threadRoot: 'x1' })
    expect(t.webLead()?.chat?.thread?.root).toBe('x1')
    t.cards.want(false)
    const u = await started()
    await u.cards.say('h-a1', 'build it', true, undefined, false, asMe)
    hidden(u, { threadRoot: 'm9' })
    hidden(u)
    expect(u.webLead()?.chat).not.toHaveProperty('thread')
    u.cards.want(false)
  })

  it('the window\'s selecting the thread\'s chat keeps the dial\'s thread until it opens it', async () => {
    const t = await started()
    await t.cards.say('h-a1', 'build it', true, undefined, false, asMe)
    hidden(t)
    expect(t.webLead()?.chat?.thread?.root).toBe('m9')
    hidden(t, { threadRoot: 'm9' })
    expect(t.webLead()?.chat?.thread?.root).toBe('m9')
    hidden(t)
    expect(t.webLead()?.chat).not.toHaveProperty('thread')
    t.cards.want(false)
  })

  it('an unconfirmed dial thread ends 15 s later without the window naming it', async () => {
    const t = await started()
    await t.cards.say('h-a1', 'build it', true, undefined, false, asMe)
    t.advance(14_999)
    hidden(t)
    expect(t.webLead()?.chat?.thread?.root).toBe('m9')
    t.cards.want(true, [], null)
    t.advance(1)
    hidden(t)
    expect(t.webLead()?.chat).not.toHaveProperty('thread')
    t.cards.want(false)
  })

  it('another root named before confirmation ends the dial\'s thread', async () => {
    const t = await started()
    await t.cards.say('h-a1', 'build it', true, undefined, false, asMe)
    hidden(t, { threadRoot: 'x1' })
    expect(t.webLead()?.chat?.thread?.root).toBe('x1')
    hidden(t)
    expect(t.webLead()?.chat).not.toHaveProperty('thread')
    t.cards.want(false)
  })

  it('a group face\'s thread is kept like a chat\'s', async () => {
    const t = await started()
    t.cards.want(true, [], { tabId: 't1', conversationId: 'g-web' })
    expect(await t.cards.say('h-a1', 'status?', true, undefined, false, asMe)).toEqual({ said: true, thread: { tabId: 't1', conversationId: 'g-web', root: 'm9' } })
    expect(t.webLead()?.chat).toMatchObject({ kind: 'group', thread: { root: 'm9' } })
    t.cards.want(false)
  })

  it('words spoken on a thread face post there even if the face left it (reviewed), and are refused CHAT_MOVED when not reviewed', async () => {
    const t = await started()
    hidden(t, { threadRoot: 'x1' })
    expect(t.webLead()?.chat?.thread?.root).toBe('x1')
    t.cards.threadLeave('t1', 'a1')
    const refused = await t.cards.say('h-a1', 'more', true, 'lead-web', false, { thread: 'x1' })
    expect(refused).toEqual({ said: false, refused: { code: 'CHAT_MOVED', message: 'That chat is no longer on the dial. Say it again.' } })
    expect(posts(t)).toEqual([])
    expect(await t.cards.say('h-a1', 'more', true, 'lead-web', true, { thread: 'x1', threaded: true })).toEqual({ said: true })
    expect(posts(t).map(p => [p.conversationId, p.replyTo])).toEqual([['lead-web', 'x1']])
    expect(t.webLead()?.chat).not.toHaveProperty('thread')
    t.cards.want(false)
  })

  it('words spoken on the main chat never land in a thread the app opened meanwhile', async () => {
    const t = await started()
    hidden(t, { threadRoot: 'x1' })
    expect(await t.cards.say('h-a1', 'main', true, 'lead-web', false, asMe)).toMatchObject({ said: false, refused: { code: 'CHAT_MOVED' } })
    expect(posts(t)).toEqual([])
    expect(await t.cards.say('h-a1', 'main', true, 'lead-web', true, asMe)).toEqual({ said: true })
    expect(posts(t).map(p => p.replyTo)).toEqual([null])
    // Posted at top level, but the face is in the app's thread now: no thread of the dial's.
    expect(t.webLead()?.chat?.thread?.root).toBe('x1')
    t.cards.want(false)
  })

  it('a post whose face or focus moved meanwhile starts no thread', async () => {
    let during: (() => void) | undefined
    const t = chatSwarm(pages, true, 0, () => { during?.(); return posted() })
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    during = () => { during = undefined; t.cards.want(true, [], { tabId: 't1', conversationId: 'lead-web', fromDevice: true }) }
    expect(await t.cards.say('h-a1', 'one', true, undefined, false, asMe)).toEqual({ said: true })
    expect(t.webLead()?.chat).not.toHaveProperty('thread')
    during = () => { during = undefined; t.cards.side('t1', 'buddy') }
    expect(await t.cards.say('h-a1', 'two', 'buddy', undefined, false, asMe)).toEqual({ said: true })
    t.cards.side('t1', 'pm')
    expect(t.webLead()?.sideChat).not.toHaveProperty('thread')
    during = () => { during = undefined; t.core.account.identity = vi.fn(async () => ({ accountId: 'sam', email: 'sam@x.io' })) as never; t.tabs.t1.lastChangedAt++; void t.cards.tick() }
    await t.cards.say('h-a1', 'three', true, undefined, false, asMe)
    await vi.waitFor(() => expect(t.cards.threadLeave('t1', 'a1')).toBeNull())
    t.cards.want(false)
  })

  it('an old Desktop\'s re-announce after a leave does not pull the dial back, until the app names another thread', async () => {
    const t = await started()
    hidden(t, { threadRoot: 'x1' })
    expect(t.cards.threadLeave('t1', 'a1')).toEqual({ tabId: 't1', conversationId: 'lead-web' })
    hidden(t, { threadRoot: 'x1' })
    hidden(t, { threadRoot: 'x1' })
    expect(t.webLead()?.chat).not.toHaveProperty('thread')
    hidden(t, { threadRoot: 'x2' })
    expect(t.webLead()?.chat?.thread?.root).toBe('x2')
    hidden(t, { threadRoot: 'x1' })
    expect(t.webLead()?.chat?.thread?.root).toBe('x1')
    // Closed in the app, then opened again: it is the app's.
    t.cards.threadLeave('t1', 'a1')
    hidden(t)
    hidden(t, { threadRoot: 'x1' })
    expect(t.webLead()?.chat?.thread?.root).toBe('x1')
    t.cards.want(false)
  })

  it('a leave resolves the face by the dial\'s own chat flag and strips the focus thread only of that conversation', async () => {
    const t = await started(true)
    t.cards.side('t1', 'buddy')
    await t.cards.say('h-a1', 'hello buddy', 'buddy', undefined, false, asMe)
    const buddyId = t.webLead()?.sideChat?.id
    expect(t.webLead()?.sideChat?.thread?.root).toBe('m9')
    // The window is in another conversation's thread, set by the dial's own pick so the dial's thread stays.
    t.cards.want(true, [], { tabId: 't1', conversationId: 'lead-web', threadRoot: 'x1', fromDevice: true })
    expect(t.cards.threadLeave('t1', 'a1', 'buddy')).toEqual({ tabId: 't1', conversationId: buddyId })
    expect(t.webLead()?.chat?.thread?.root).toBe('x1')
    expect(t.webLead()?.sideChat).not.toHaveProperty('thread')
    expect(t.cards.threadLeave('t1', 'a1', false)).toBeNull()
    t.cards.want(false)
  })

  it('an app thread whose root is not on the page is titled by reading its root once, and keeps the last title', async () => {
    const t = chatSwarm({ ...pages, 'lead-web#x2': Object.assign([said(5, 'a1', { text: 'reply', thread: 'x2' })], { threads: [{ id: 'x2', replies: 1 }] }),
      'lead-web@x2': [root('x2', 'old root\nmore')] }, false, 0, posted)
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    hidden(t, { threadRoot: 'x2' })
    await t.cards.recap('t1', 'a1', true)
    await vi.waitFor(() => expect(t.webLead()?.chat?.thread).toEqual({ root: 'x2', title: 'old root', replies: 1 }))
    await t.move(2)
    await t.cards.recap('t1', 'a1', true)
    expect(t.webLead()?.chat?.thread?.title).toBe('old root')
    expect(t.calls.filter(c => c.includes('messageId=x2'))).toHaveLength(1)
    t.cards.want(false)
  })

  // Review of #2756 (ENGINEERING.md §6): a failed read of the root was dropped silently and never tried again, so the face kept a
  // blank title. It is logged, by its code and nothing of the thread, and read again after a wait.
  it('a failed read of an app thread\'s root is logged and read again after a wait', async () => {
    let fails = true
    const t = chatSwarm({ ...pages, 'lead-web#x2': Object.assign([said(5, 'a1', { text: 'reply', thread: 'x2' })], { threads: [{ id: 'x2', replies: 1 }] }),
      'lead-web@x2': () => { if (fails) throw Object.assign(new Error('busy'), { code: 'SERVICE_UNAVAILABLE' }); return [root('x2', 'old root')] } }, false, 0, posted)
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    hidden(t, { threadRoot: 'x2' })
    await t.cards.recap('t1', 'a1', true)
    await vi.waitFor(() => expect(t.calls.filter(c => c.includes('messageId=x2'))).toHaveLength(1))
    const lines = t.log.mock.calls.map(c => String(c[0])).filter(l => l.includes('thread'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('x2')
    // Within the wait it is not read again; after it, it is, and the face takes the title.
    await t.move(2)
    await t.cards.recap('t1', 'a1', true)
    expect(t.calls.filter(c => c.includes('messageId=x2'))).toHaveLength(1)
    fails = false
    t.advance(60_000)
    await t.move(3)
    await t.cards.recap('t1', 'a1', true)
    await vi.waitFor(() => expect(t.webLead()?.chat?.thread?.title).toBe('old root'))
    expect(t.calls.filter(c => c.includes('messageId=x2'))).toHaveLength(2)
    t.cards.want(false)
  })

  it('a thread of a reader that was not signed in when the read ended is not learned', async () => {
    const t = await started()
    hidden(t, { threadRoot: 'x1' })
    const pending = t.cards.recap('t1', 'a1', true)
    vi.mocked(t.core.account.identity).mockResolvedValue({ accountId: 'sam', email: 'sam@x.io' } as never)
    t.tabs.t1.lastChangedAt++
    await t.cards.tick()
    await pending
    expect(t.webLead()?.chat?.thread).not.toHaveProperty('title', 'fix login')
    t.cards.want(false)
  })

  it('forgets the dial\'s thread when the device is gone, another person signs in, or the Swarm is lost', async () => {
    const t = await started()
    await t.cards.say('h-a1', 'build it', true, undefined, false, asMe)
    t.cards.want(false)
    const shown = t.seen.length
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen.length).toBeGreaterThan(shown))
    expect(t.webLead()?.chat).not.toHaveProperty('thread')
    t.cards.want(false)

    const u = await started()
    await u.cards.say('h-a1', 'build it', true, undefined, false, asMe)
    vi.mocked(u.core.account.identity).mockResolvedValue({ accountId: 'sam', email: 'sam@x.io' } as never)
    u.tabs.t1.lastChangedAt++
    await u.cards.tick()
    expect(u.webLead()?.chat).not.toHaveProperty('thread')
    u.cards.want(false)

    const v = await started()
    await v.cards.say('h-a1', 'build it', true, undefined, false, asMe)
    const kept = v.tabs.t1
    delete v.tabs.t1
    await v.cards.tick()
    v.tabs.t1 = kept
    v.tabs.t1.lastChangedAt++
    await v.cards.tick()
    expect(v.webLead()?.chat).not.toHaveProperty('thread')
    v.cards.want(false)
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

  it('keeps the side through a desktop focus the dial itself caused, and clears it on the desktop\'s own next one', async () => {
    const t = chatSwarm({}, true)
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.cards.side('t1', 'buddy')
    // The dial swiped to the next project: its select moved the desktop there, and that announce says so.
    t.cards.want(true, [], { tabId: 't1', conversationId: 'lead-web', fromDevice: true })
    expect(t.webLead()?.sideChat).toMatchObject({ kind: 'buddy' })
    // The person then opens another conversation on the desktop: newest wins, the side goes and the face follows it.
    t.cards.want(true, [], { tabId: 't1', conversationId: 'g-web' })
    expect(t.webLead()?.sideChat).toMatchObject({ kind: 'group', id: 'g-web' })
    t.cards.want(false)
  })

  it('says the Swarm\'s side on its card, so a dial follows the daemon\'s side even where no face changes', async () => {
    // No Buddy chat in the Swarm: a side changes no face, and the card alone tells the dial (review of #2218).
    const t = chatSwarm({})
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    expect(t.seen.at(-1)?.[0].side).toBeUndefined()
    t.cards.side('t1', 'buddy')
    expect(t.seen.at(-1)?.[0].side).toBe('buddy')
    // The desktop opens a group: the side goes, and the card says so.
    t.cards.want(true, [], { tabId: 't1', conversationId: 'g-web' })
    expect(t.seen.at(-1)?.[0].side).toBeUndefined()
    t.cards.want(false)
  })

  it('says the Buddy side when the desktop opens the Buddy chat, so the side and the face agree', async () => {
    // Re-check of #2216: the face followed the desktop to the Buddy chat while the card said the PM side, and the dial
    // (#2218) showed the PM screen without the Buddy's recap.
    const t = chatSwarm({ 'pm-web': [said(2, 'y1', { text: 'from the Buddy' })] }, true)
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.cards.want(true, [], { tabId: 't1', conversationId: 'pm-web' })
    expect(t.seen.at(-1)?.[0].side).toBe('buddy')
    expect(t.webLead()?.sideChat).toMatchObject({ kind: 'buddy', id: 'pm-web' })
    expect(await t.cards.recap('t1', 'a1', 'buddy')).toMatchObject({ chatId: 'pm-web', text: 'from the Buddy' })
    // A swipe down wins over that focus: both say the PM side.
    t.cards.side('t1', 'pm')
    expect(t.seen.at(-1)?.[0].side).toBeUndefined()
    expect(t.webLead()?.sideChat).toMatchObject({ kind: 'lead' })
    expect(await t.cards.recap('t1', 'a1', 'buddy')).toMatchObject({ chatId: 'lead-web' })
    // The desktop moving to a group clears both.
    t.cards.want(true, [], { tabId: 't1', conversationId: 'g-web' })
    expect(t.seen.at(-1)?.[0].side).toBeUndefined()
    expect(t.webLead()?.sideChat).toMatchObject({ kind: 'group' })
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

  it('reviewed words go to the chat they were reviewed for after the face moved, and never to a chat outside the Lead\'s project', async () => {
    const t = chatSwarm({}, true)
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.cards.side('t1', 'buddy')
    // The person reviewed the words for their Buddy chat; the window opened the Lead before they pressed Send.
    t.cards.want(true, [], { tabId: 't1', conversationId: 'lead-web' })
    expect(await t.cards.say('h-a1', 'reviewed for my Buddy', 'buddy', 'pm-web', true)).toEqual({ said: true })
    // Another project's chat, or one this reader cannot see, is not where this Lead's words go.
    for (const chatId of ['lead-mobile', 'gone']) {
      expect(await t.cards.say('h-a1', 'not here', 'buddy', chatId, true)).toEqual({ said: false,
        refused: { code: 'CHAT_MOVED', message: 'That chat is no longer on the dial. Say it again.' } })
    }
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

  it('takes the Buddy\'s word after the PM\'s private line as its quiet notice, and the PM\'s line as none', async () => {
    const t = chatSwarm({ 'pm-web': [said(2, 'a1', { text: 'from the PM' }), said(3, 'y1', { text: 'from the Buddy' })] }, true)
    await t.cards.tick()
    await t.move(1, 3)
    expect(t.webLead()).toMatchObject({ buddyNotice: { chat: 'buddy', id: 'x3' } })
    expect(t.webLead()).not.toHaveProperty('notice')
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

// Diego, 11-02: "the round dial no longer shows the Buddy screen when I pull down". Since One Buddy per Swarm (#2447) the
// reader's Buddy chat belongs to the Swarm (kind swarm-buddy, no project), and the cards looked for one in each project.
describe('one Buddy per Swarm', () => {
  /** The reader's one chat for the Swarm, as the backend sends it (buddies.ts openSwarmBuddyChat, read/views.ts groupView). */
  const sb = (over: Record<string, unknown> = {}) => conv('sb', null, { projectId: undefined, kind: 'swarm-buddy', buddyOwnerId: 'me', agentIds: ['y1'], ...over })
  const one = (over: Record<string, unknown> = {}) => chats({ buddies: true, agents: [...chats().agents as object[], buddy({ buddyScope: 'swarm' })],
    conversations: [...swarm().conversations, sb(), group()], ...over })
  const lead = (state: Record<string, unknown>, project = 'web', focus?: string, side?: 'pm' | 'buddy') =>
    leadsOf(state, 'm1', idle, 'me', focus, side).leads.find(l => l.projectId === project)!
  const inLead = { kind: 'lead', id: 'lead-web', name: 'Lead', working: false }

  it('gives every project\'s card the reader\'s one Buddy, and the Buddy side shows its chat', () => {
    const block = { chatId: 'sb', name: "diego's Buddy", engine: 'codex', cells: 25513, color: '#d6a79a', live: true, local: 'h-y1' }
    for (const project of ['web', 'mobile']) {
      expect(lead(one(), project).buddy).toEqual(block)
      expect(lead(one(), project, undefined, 'buddy').sideChat).toEqual({ kind: 'buddy', id: 'sb', name: "diego's Buddy", working: false })
    }
    // The PM side and an older dial's face are the project's Lead, as before: the Swarm chat is no project's PM line.
    expect(lead(one()).sideChat).toEqual(inLead)
    expect(lead(one(), 'web', undefined, 'buddy').chat).toEqual(inLead)
  })

  it('prefers the Swarm chat over an older Buddy chat of the project, and falls back to it when the Swarm chat is gone', () => {
    const both = one({ conversations: [...swarm().conversations, pm({ agentIds: ['y1'] }), sb(), group()] })
    expect(lead(both).buddy).toMatchObject({ chatId: 'sb' })
    expect(lead(both, 'web', undefined, 'buddy').sideChat).toMatchObject({ kind: 'buddy', id: 'sb' })
    // Archived: the older chat of the project is what an older Swarm keeps, and the other project has none.
    const archived = one({ conversations: [...swarm().conversations, pm({ agentIds: ['y1'] }), sb({ archived: true }), group()] })
    expect(lead(archived).buddy).toMatchObject({ chatId: 'pm-web' })
    expect(lead(archived, 'mobile')).not.toHaveProperty('buddy')
  })

  it('leaves an older Swarm as it was: the Buddy chat of each project, none for a project without one', () => {
    const older = chats({ buddies: true, agents: [...chats().agents as object[], buddy()], conversations: [...swarm().conversations, pm({ agentIds: ['y1'] }), group()] })
    expect(lead(older).buddy).toMatchObject({ chatId: 'pm-web' })
    expect(lead(older, 'mobile')).not.toHaveProperty('buddy')
  })

  it('marks no Buddy while Buddies are off, with nobody signed in, or for a chat whose id the dial cannot hold', () => {
    expect(lead(one({ buddies: undefined }))).not.toHaveProperty('buddy')
    expect(leadsOf(one(), 'm1', idle, undefined).leads[0]).not.toHaveProperty('buddy')
    const long = one({ conversations: [...swarm().conversations, sb({ id: 's'.repeat(48) }), group()] })
    expect(lead(long)).not.toHaveProperty('buddy')
  })

  // Privacy: the backend sends a Buddy chat to its owner alone, and the dial checks again.
  it('never takes another person\'s Swarm chat or Buddy, whatever a read holds or the window has open', () => {
    const sams = one({ agents: [...chats().agents as object[], buddy({ buddyOf: { personId: 'sam', generation: 'g2' }, buddyScope: 'swarm' })],
      conversations: [...swarm().conversations, sb({ buddyOwnerId: 'sam' }), group()] })
    for (const side of [undefined, 'pm', 'buddy'] as const) {
      const l = lead(sams, 'web', 'sb', side)
      expect([l.chat, l.sideChat]).toEqual([inLead, inLead])
      expect(l).not.toHaveProperty('buddy')
    }
    // Sam's Buddy listed in the reader's own chat (an agent id reused or misfiled) is not the reader's, and the block never
    // carries its name or avatar.
    const misfiled = one({ agents: [...chats().agents as object[], buddy({ buddyOf: { personId: 'sam', generation: 'g2' }, displayName: 'Sam secret' })] })
    expect(lead(misfiled)).not.toHaveProperty('buddy')
    expect(lead(misfiled, 'web', undefined, 'buddy').sideChat).toEqual({ kind: 'buddy', id: 'sb', name: 'Buddy', working: false })
    expect(JSON.stringify(leadsOf(misfiled, 'm1', idle, 'me', undefined, 'buddy'))).not.toContain('Sam secret')
    // A thread session of the reader's Buddy is not "the Buddy", and an agent id reused in a project chat is not either.
    const session = agent('y1', { buddyOf: { personId: 'me', generation: 'g1' }, buddySession: { thread: 'r', from: 1 }, name: 'Thread' })
    expect(lead(one({ agents: [...chats().agents as object[], session] }))).not.toHaveProperty('buddy')
  })

  it('does not take the Swarm chat for a project chat of the dial\'s older face', () => {
    // The Swarm chat has no project: an older dial's face (the window open on it) stays the project's Lead, never `pm`.
    expect(lead(one(), 'web', 'sb').chat).toEqual(inLead)
    expect(lead(one(), 'mobile', 'sb').chat).toMatchObject({ kind: 'lead', id: 'lead-mobile' })
  })
})

describe('SwarmCards with one Buddy per Swarm', () => {
  const sb = (seq = 1) => conv('sb', null, { projectId: undefined, kind: 'swarm-buddy', buddyOwnerId: 'me', agentIds: ['y1'], lastMessageSequence: seq })
  const state = (seq = 1, over: Record<string, unknown> = {}) => chats({ buddies: true, agents: [...chats().agents as object[], buddy({ buddyScope: 'swarm' })],
    conversations: [...swarm().conversations, sb(seq), group()], ...over })
  const hears = [said(1, 'a1', { text: 'from the PM' }), said(2, 'y1', { text: 'from the Buddy' }), said(3, 'me', { author: { kind: 'person', id: 'me' }, text: 'mine' })]
  const build = (pages: Record<string, unknown[]> = { sb: hears }, post?: () => { status: number; body: Record<string, unknown> }) => {
    const t = setup({ t1: { lastChangedAt: 1, state: state() } }, { messages: path => ({ messages: pages[/conversations\/([^/]+)\/messages/.exec(path)?.[1] ?? ''] ?? [], next: null }), post })
    const lead = (id: string, cards = t.seen.at(-1)) => cards?.[0].leads.find(l => l.id === id)
    const reads = () => t.calls.filter(c => c.includes('/conversations/sb/messages')).length
    const move = async (seq: number, over: Record<string, unknown> = {}) => { t.tabs.t1.lastChangedAt++; t.tabs.t1.state = state(seq, over); await t.cards.tick() }
    return { ...t, lead, reads, move }
  }

  it('recaps the Buddy side from the Swarm chat\'s Buddy voice, and speaks to the Swarm chat, from any project', async () => {
    const t = build()
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.cards.side('t1', 'buddy')
    for (const lead of ['a1', 'a2']) {
      expect(t.lead(lead)?.sideChat).toMatchObject({ kind: 'buddy', id: 'sb' })
      expect(await t.cards.recap('t1', lead, 'buddy')).toEqual({ tabId: 't1', leadId: lead, text: 'from the Buddy', at: saidAt, none: false, chatId: 'sb', buddy: true })
    }
    expect(await t.cards.say('h-a2', 'hello Buddy', 'buddy')).toEqual({ said: true })
    expect((t.call.mock.calls.find(c => c[0] === 'POST')![2] as { command: { conversationId: string } }).command.conversationId).toBe('sb')
    t.cards.want(false)
  })

  it('shows the Buddy side when the window opens the Swarm chat, and the PM side after a swipe back', async () => {
    const t = build()
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.cards.want(true, [], { tabId: 't1', conversationId: 'sb' })
    expect(t.seen.at(-1)?.[0].side).toBe('buddy')
    expect(t.lead('a1')?.sideChat).toMatchObject({ kind: 'buddy', id: 'sb' })
    expect(t.lead('a1')?.chat).toMatchObject({ kind: 'lead' })
    t.cards.side('t1', 'pm')
    expect(t.lead('a1')?.sideChat).toMatchObject({ kind: 'lead' })
    t.cards.want(false)
  })

  it('notices the Buddy\'s new word on every project\'s card from one read, and keeps the baseline when that read fails', async () => {
    const t = build()
    await t.cards.tick()
    await t.cards.tick()
    expect(t.reads()).toBe(0)
    expect(t.lead('a1')).not.toHaveProperty('buddyNotice')
    await t.move(3)
    for (const lead of ['a1', 'a2']) expect(t.lead(lead)?.buddyNotice).toEqual({ chat: 'buddy', chatId: 'sb', id: 'x2', text: 'from the Buddy', at: saidAt })
    expect(t.reads()).toBe(1)
    // The Swarm chat is no Lead's private line: the Lead's own notice is not raised from it.
    expect(t.lead('a1')).not.toHaveProperty('notice')
  })

  it('a failed read of the Swarm chat keeps the baseline, is logged once and is tried again at the next poll', async () => {
    const t = build({ sb: [...hears, said(5, 'y1', { text: 'later' })] })
    await t.cards.tick()
    const served = t.call.getMockImplementation()!
    t.call.mockImplementation(async (method, path, body) => {
      if (path.includes('/conversations/sb/messages')) throw new Error('offline')
      return served(method, path, body)
    })
    await t.move(5)
    await t.move(5)
    expect(t.log).toHaveBeenCalledTimes(1)
    expect(t.lead('a1')).not.toHaveProperty('buddyNotice')
    t.call.mockImplementation(served)
    await t.move(5)
    expect(t.lead('a1')?.buddyNotice).toMatchObject({ chatId: 'sb', text: 'later' })
  })

  it('drops the notice with the chat when access to the Swarm chat goes, and never reads another person\'s', async () => {
    const t = build()
    await t.cards.tick()
    await t.move(3)
    expect(t.lead('a1')?.buddyNotice).toBeDefined()
    // The chat leaves the reader's rows (the membership ended): nothing of it is kept.
    await t.move(3, { conversations: [...swarm().conversations, group()] })
    expect(t.lead('a1')).not.toHaveProperty('buddyNotice')
    expect(t.lead('a1')).not.toHaveProperty('buddy')
    // Another person's Swarm chat moving is never read.
    const readsBefore = t.reads()
    await t.move(9, { conversations: [...swarm().conversations, { ...sb(9), buddyOwnerId: 'sam' }, group()] })
    await t.move(10, { conversations: [...swarm().conversations, { ...sb(10), buddyOwnerId: 'sam' }, group()] })
    expect(t.reads()).toBe(readsBefore)
    expect(t.lead('a1')).not.toHaveProperty('buddyNotice')
  })

  // Task #2525: the Swarm chat is every project's Buddy face, so a thread matched by conversation landed on every Lead, and
  // with 12 projects the round dial's frame passed the firmware's 512-token guard. The thread is on the face Lead's alone.
  it('puts a dial thread in the Swarm chat on the Lead it was started from only', async () => {
    const t = build({ sb: hears }, () => ({ status: 200, body: { success: true, data: { result: { messageId: 'm9' } } } }))
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.cards.side('t1', 'buddy')
    expect(await t.cards.say('h-a1', 'help me\nplease', 'buddy', undefined, false, { threaded: true }))
      .toEqual({ said: true, thread: { tabId: 't1', conversationId: 'sb', root: 'm9' } })
    expect(t.lead('a1')?.sideChat).toMatchObject({ kind: 'buddy', id: 'sb', thread: { root: 'm9', title: 'help me' } })
    // The other project's Buddy face is the same chat, read as its main stream.
    expect(t.lead('a2')?.sideChat).toMatchObject({ kind: 'buddy', id: 'sb' })
    expect(t.lead('a2')?.sideChat).not.toHaveProperty('thread')
    expect(await t.cards.recap('t1', 'a2', 'buddy')).not.toHaveProperty('thread')
    t.cards.want(false)
  })

  it('puts the window\'s thread in the Swarm chat on the Lead the dial has open only', async () => {
    const t = build()
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.cards.open('s1', 't1', 'a2', 'buddy')
    t.cards.want(true, [], { tabId: 't1', conversationId: 'sb', threadRoot: 'r1' })
    expect(t.lead('a2')?.sideChat?.thread?.root).toBe('r1')
    expect(t.lead('a1')?.sideChat).not.toHaveProperty('thread')
    t.cards.want(false)
  })

  it('refuses a recap or a word for the Swarm chat once it stops being the reader\'s while the read is out, and for a stale or foreign chat id', async () => {
    const t = build()
    t.cards.want(true, [], null)
    await vi.waitFor(() => expect(t.seen).toHaveLength(1))
    t.cards.side('t1', 'buddy')
    // The read is out when the chat is replaced by Sam's: the answer is neither given nor kept.
    t.call.mockImplementationOnce(async () => {
      t.tabs.t1.state = state(1, { conversations: [...swarm().conversations, { ...sb(), buddyOwnerId: 'sam' }, group()] })
      t.cards.side('t1', 'pm')
      return { status: 200, body: { success: true, data: { messages: hears, next: null } } }
    })
    expect(await t.cards.recap('t1', 'a1', 'buddy')).toMatchObject({ none: true, text: '' })
    // Words reviewed for a chat id that is not on this project's face are refused alike for Sam's chat, a private chat and a stranger.
    t.tabs.t1.lastChangedAt++
    t.tabs.t1.state = state(1, { conversations: [...swarm().conversations, { ...sb(), buddyOwnerId: 'sam' }, conv('priv-1', null, { projectId: 'mobile', audience: { people: [{ id: 'sam' }] } }), group()] })
    await t.cards.tick()
    for (const chatId of ['sb', 'priv-1', 'nope']) {
      expect(await t.cards.say('h-a1', 'secret', 'buddy', chatId, true)).toEqual({ said: false, refused: { code: 'CHAT_MOVED', message: expect.any(String) } })
    }
    expect(t.call.mock.calls.filter(c => c[0] === 'POST')).toHaveLength(0)
    t.cards.want(false)
  })
})
