import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { MESSAGES_QUERIES, TAB_KEY_OFF, TAB_RELAY_OFF, type TabLink } from './api.js'
import { askForMessages, createMessagesLink } from './messagesLink.js'

const agent = (agentId: string) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: '/w' }) as RegisteredSession

describe('Agent Messages in its own process, as the core keeps it', () => {
  const link = (over: Parameters<typeof fakeCore>[0] = {}, now?: () => number) => {
    const notify = vi.fn(() => true)
    return { notify, link: createMessagesLink({ core: fakeCore(over), notify, now }) }
  }

  it('says a delivery may be written only while the process last said so, and not past when it said', () => {
    let clock = 1_000
    const { link: l } = link({}, () => clock)
    expect(l.port.canWrite('team:d1')).toBe(false)
    expect(l.answer('writable', { deliveries: { 'team:d1': 1_000 + 3_000, 'team:d2': 'soon' } })).toEqual({})
    expect(l.port.canWrite('team:d1')).toBe(true)
    expect(l.port.canWrite('team:d2')).toBe(false)
    clock += 3_000
    expect(l.port.canWrite('team:d1')).toBe(false)
    l.answer('writable', { deliveries: { 'team:d1': 99_999 } })
    expect(l.port.canWrite('team:d1')).toBe(true)
    // A report replaces the last whole.
    l.answer('writable', {})
    expect(l.port.canWrite('team:d1')).toBe(false)
  })

  it('reads the real clock by default', () => {
    const { link: l } = link()
    l.answer('writable', { deliveries: { 'team:d1': Date.now() + 60_000 } })
    expect(l.port.canWrite('team:d1')).toBe(true)
  })

  it('shows it the agents as the apps are shown them, and how this daemon is reached and whether it is signed in', async () => {
    let signedIn = true
    const { link: l } = link({
      agents: { live: () => [agent('a1')], displayName: (s) => `name of ${s.agentId}`, terminalAvailable: () => true, dsh: () => null },
      daemon: { command: `'node' 'cli.js'`, port: 18473, machineId: () => 'machine-7', autonomousEnv: 'prod' },
      account: { signedIn: () => signedIn },
    })
    expect(await l.answer('shown', {})).toEqual({ agents: [{ ...agent('a1'), displayName: 'name of a1', terminalAvailable: true, selectedModel: null, dshContext: null }] })
    expect(await l.answer('daemon', {})).toEqual({ command: `'node' 'cli.js'`, port: 18473, machineId: 'machine-7', autonomousEnv: 'prod', signedIn: true })
    signedIn = false
    expect(await l.answer('daemon', {})).toMatchObject({ signedIn: false })
  })

  it('calls the account\'s tab and shared tab routes for it, by method and whole path, and nothing else of the backend', async () => {
    const backend = vi.fn(async () => ({ status: 200, body: { success: true, data: { tabs: [] } } }))
    const { link: l } = link({ account: { backend } })
    expect(await l.answer('backend', { method: 'GET', path: '/api/agent-messages' })).toEqual({ status: 200, body: { success: true, data: { tabs: [] } } })
    const SID = 'a1b2c3d4e5f6a1b2c3d4e5f6', INV = '0b7e6c1a-3f2d-4c5b-9a8e-7d6c5b4a3f2e'
    const roster = { machineId: 'm1', version: 2, roster: { body: '{}', signature: 's' } }
    const allowed: Array<[string, string, unknown?]> = [
      ['GET', '/api/agent-messages/shares'],
      ['PUT', '/api/agent-messages/shares/tab-1_A/roster', roster],
      ['POST', `/api/agent-messages/shares/${SID}/invites`, { email: 'bob@y.io', days: 7 }],
      ['GET', '/api/agent-messages/invites'],
      ['DELETE', `/api/agent-messages/invites/${INV}`],
      ['POST', `/api/agent-messages/invites/${INV}/accept`],
      ['DELETE', `/api/agent-messages/shares/${SID}/members/u-bob_7`],
      ['DELETE', `/api/agent-messages/shares/${SID}`],
      ['POST', `/api/agent-messages/shares/${SID}/move`, { machineId: 'm2' }],
      // The tab's leader, which the person chooses for a shared tab from any computer of the account (`share_leader`).
      ['PATCH', '/api/agent-messages/tabs/tab-1_A', { leader: { machineId: 'm1', agentId: 'a1' } }],
    ]
    for (const [method, path, body] of allowed) {
      expect(await l.answer('backend', { method, path, ...(body === undefined ? {} : { body }) })).toMatchObject({ status: 200 })
    }
    // Each with its body, and none without one.
    expect(backend.mock.calls).toEqual([['GET', '/api/agent-messages'], ...allowed.map(([m, p, b]) => (b === undefined ? [m, p] : [m, p, b]))])
    backend.mockClear()
    // An experiment may write the account's settings or read anything under /api/; Agent Messages calls its own routes.
    const refused: unknown[] = [
      { method: 'PATCH', path: '/api/agent-messages' }, { method: 'GET', path: '/api/machines' }, { method: 'GET', path: '/api/auth/me' }, {},
      // Query strings, another method on an allowed path, and anything after or before the whole path.
      { method: 'GET', path: '/api/agent-messages?all=1' }, { method: 'GET', path: '/api/agent-messages/shares?x=1' },
      { method: 'GET', path: `/api/agent-messages/invites/${INV}/accept` }, { method: 'POST', path: '/api/agent-messages/shares' },
      { method: 'PUT', path: `/api/agent-messages/shares/${SID}` }, { method: 'DELETE', path: '/api/agent-messages/shares' },
      { method: 'get', path: '/api/agent-messages' }, { method: 'GET', path: '/api/agent-messages/' }, { method: 'GET', path: '/api/agent-messages\n' },
      { method: 'GET', path: 'https://evil.example/api/agent-messages' }, { method: 'GET', path: '//evil.example/api/agent-messages' },
      // A path that climbs out, or an id not of the backend's shape.
      { method: 'PUT', path: '/api/agent-messages/shares/../../auth/roster' }, { method: 'PUT', path: '/api/agent-messages/shares/%2e%2e/roster' },
      { method: 'DELETE', path: `/api/agent-messages/shares/${SID}/members/..` }, { method: 'DELETE', path: `/api/agent-messages/shares/${SID}/members/a%2Fb` },
      { method: 'DELETE', path: `/api/agent-messages/shares/${SID}/members/${'u'.repeat(129)}` },
      { method: 'PUT', path: `/api/agent-messages/shares/${'t'.repeat(65)}/roster` }, { method: 'POST', path: '/api/agent-messages/shares/A1B2C3D4E5F6A1B2C3D4E5F6/invites' },
      { method: 'POST', path: `/api/agent-messages/shares/${SID}0/invites` }, { method: 'DELETE', path: '/api/agent-messages/invites/../../machines' },
      { method: 'POST', path: '/api/agent-messages/invites/inv-1/accept' }, { method: 'DELETE', path: `/api/agent-messages/shares/${SID}/../../machines` },
      { method: 7, path: '/api/agent-messages' }, { method: 'GET', path: ['/api/agent-messages'] },
      // A tab's setting only by PATCH, of one desk tab's id, and nothing after it.
      { method: 'PUT', path: '/api/agent-messages/tabs/tab-1' }, { method: 'PATCH', path: '/api/agent-messages/tabs' },
      { method: 'PATCH', path: '/api/agent-messages/tabs/../machines' }, { method: 'PATCH', path: `/api/agent-messages/tabs/${'t'.repeat(65)}` },
      { method: 'PATCH', path: '/api/agent-messages/tabs/tab-1/roster' },
      // The move, only as a POST of a shared tab's own id, and nothing after it.
      { method: 'POST', path: `/api/agent-messages/shares/${SID}/move/x` }, { method: 'GET', path: `/api/agent-messages/shares/${SID}/move` },
      { method: 'POST', path: '/api/agent-messages/shares/tab-1/move' },
    ]
    for (const asked of refused) expect(await l.answer('backend', asked as Record<string, unknown>)).toEqual({ error: 'INVALID_REQUEST' })
    expect(backend).not.toHaveBeenCalled()
  })

  it('says which account is signed in here, as the core reads it, or that it cannot', async () => {
    const identity = vi.fn(async (): Promise<{ accountId: string; email: string } | null> => ({ accountId: 'u-alice', email: 'alice@x.io' }))
    const { link: l } = link({ account: { identity } })
    expect(await l.answer('account', {})).toEqual({ accountId: 'u-alice', email: 'alice@x.io' })
    identity.mockResolvedValueOnce(null)
    expect(await l.answer('account', {})).toEqual({ error: 'ACCOUNT_UNAVAILABLE' })
  })

  it('tells the windows its log or its shared tabs changed, and nothing else', async () => {
    const windows = vi.fn()
    const { link: l } = link({ clients: { windows } })
    for (const type of ['messages_changed', 'shared_tabs_changed', 'shared_activity']) {
      expect(await l.answer('windows', { frame: { type, payload: { tabId: 'app' }, extra: 1 } })).toEqual({})
    }
    expect(windows.mock.calls).toEqual([
      [{ type: 'messages_changed', payload: { tabId: 'app' } }],
      [{ type: 'shared_tabs_changed', payload: { tabId: 'app' } }],
      [{ type: 'shared_activity', payload: { tabId: 'app' } }],
    ])
    for (const frame of [undefined, { type: 'orchestrator_changed', payload: {} }, { type: 'agents_list', payload: {} }, { type: 'messages_changed' }, { type: 'shared_tabs_changed' }, { type: 'shared_tabs_changed', payload: 'x' }]) {
      expect(await l.answer('windows', { frame })).toEqual({ error: 'INVALID_FRAME' })
    }
    expect(windows).toHaveBeenCalledTimes(3)
  })

  it('answers what it uses alone: never what an experiment acts on the core through', async () => {
    const create = vi.fn()
    const stop = vi.fn()
    const { link: l } = link({ agents: { create }, turns: { stop } })
    for (const query of ['create', 'stop_turn', 'observer_key', 'observer_send', 'live', 'agents', 'connector_vault']) {
      expect(await l.answer(query, { engine: 'claude', cwd: '/w', prompt: 'p', name: 'n', agentId: 'a1' })).toEqual({ error: 'UNKNOWN_QUERY' })
    }
    expect(create).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect([...MESSAGES_QUERIES].sort()).toEqual(['account', 'activity', 'backend', 'daemon', 'observers', 'shown', 'tab_key', 'tab_relay', 'windows', 'writable'])
  })

  it('answers the working state of at most 64 agents', async () => {
    const activity = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, 'idle' as const])))
    const { link: l } = link({ agents: { activity } })
    const ids = Array.from({ length: 70 }, (_, i) => `a${i}`)
    const answer = await l.answer('activity', { agentIds: [...ids, 5] })
    expect(Object.keys((answer as { activity: object }).activity)).toHaveLength(64)
    expect(await l.answer('activity', { agentIds: 'x' })).toEqual({ activity: {} })
  })

  it('answers the one-line summaries too, only when asked, and for at most 64 agents', async () => {
    const summaries = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, `doing ${id}`])))
    const activity = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, 'idle' as const])))
    const { link: l } = link({ agents: { activity, summaries } })
    expect(await l.answer('activity', { agentIds: ['a1'] })).toEqual({ activity: { a1: 'idle' } })
    expect(summaries).not.toHaveBeenCalled()
    expect(await l.answer('activity', { agentIds: ['a1'], summaries: true })).toEqual({ activity: { a1: 'idle' }, summaries: { a1: 'doing a1' } })
    const ids = Array.from({ length: 70 }, (_, i) => `a${i}`)
    const answer = await l.answer('activity', { agentIds: ids, summaries: true }) as { summaries: object }
    expect(Object.keys(answer.summaries)).toHaveLength(64)
    // Only `true` asks: another value is not a request for them.
    expect(await l.answer('activity', { agentIds: ['a1'], summaries: 'yes' })).toEqual({ activity: { a1: 'idle' } })
  })

  it('hands a roster change to Share, which derives its observers again, and nothing it was sent with', async () => {
    const share = vi.fn(async () => ({ invited: 1, revoked: 0 }))
    const l = createMessagesLink({ core: fakeCore(), notify: vi.fn(() => true), share })
    expect(await l.answer('observers', { type: 'harness_share_invite', emails: ['eve@x.io'] })).toEqual({ invited: 1, revoked: 0 })
    expect(share.mock.calls).toEqual([['harness_share_rosters', {}]])
    // Share off or down (its call answers SERVICE_UNAVAILABLE) is an answer too; with no way to reach it, the same.
    share.mockResolvedValueOnce({ error: 'SERVICE_UNAVAILABLE', service: 'sharing' } as never)
    expect(await l.answer('observers', {})).toEqual({ error: 'SERVICE_UNAVAILABLE', service: 'sharing' })
    expect(await link().link.answer('observers', {})).toEqual({ error: 'SERVICE_UNAVAILABLE' })
  })

  it('answers tab_key for the nine methods and refuses others', async () => {
    const link1 = { sharedTabId: 'a1b2c3d4e5f6a1b2c3d4e5f6', machineId: 'bob-mini', peerPub: 'UEVFUg==' }
    const tabKey = { ...TAB_KEY_OFF, publicKey: vi.fn(async () => 'cHVi'), signRoster: vi.fn(async () => 'c2ln'),
      seal: vi.fn(async (_link: TabLink, frame: Record<string, unknown>) => ({ frame: { sealed: frame } })), drop: vi.fn() }
    const { link: l } = link({ account: { tabKey } })
    expect(await l.answer('tab_key', { method: 'publicKey', args: [] })).toEqual({ result: 'cHVi' })
    expect(await l.answer('tab_key', { method: 'signRoster', args: [link1.sharedTabId, 2, '{}'] })).toEqual({ result: 'c2ln' })
    expect(tabKey.signRoster).toHaveBeenCalledWith(link1.sharedTabId, 2, '{}')
    expect(await l.answer('tab_key', { method: 'seal', args: [link1, { type: 'ping' }] })).toEqual({ result: { frame: { sealed: { type: 'ping' } } } })
    expect(tabKey.seal).toHaveBeenCalledWith(link1, { type: 'ping' })
    expect(await l.answer('tab_key', { method: 'drop', args: [link1] })).toEqual({})
    expect(tabKey.drop).toHaveBeenCalledWith(link1)
    // TAB_KEY_OFF's own answers, as a core whose gateway holds no key gives them.
    expect(await l.answer('tab_key', { method: 'hello', args: [link1] })).toEqual({ error: 'no key: this process holds no E2EE identity' })
    expect(await l.answer('tab_key', { method: 'accept', args: [link1, {}] })).toEqual({ result: { refused: true } })
    for (const method of ['constructor', 'clear', '__proto__', 'toString', undefined]) {
      expect(await l.answer('tab_key', { method, args: [] })).toEqual({ error: 'UNKNOWN_METHOD' })
    }
  })

  it('answers tab_relay for the three methods and refuses others', async () => {
    const TAB = 'a1b2c3d4e5f6a1b2c3d4e5f6'
    const tabRelay = { open: vi.fn(async () => {}), send: vi.fn(async () => true), close: vi.fn() }
    const { link: l } = link({ account: { tabRelay } })
    expect(await l.answer('tab_relay', { method: 'open', args: [TAB] })).toEqual({})
    expect(tabRelay.open).toHaveBeenCalledWith(TAB)
    expect(await l.answer('tab_relay', { method: 'send', args: [TAB, 'alice-mac', { sealed: 1 }] })).toEqual({ result: true })
    expect(tabRelay.send).toHaveBeenCalledWith(TAB, 'alice-mac', { sealed: 1 })
    expect(await l.answer('tab_relay', { method: 'close', args: [TAB] })).toEqual({})
    expect(tabRelay.close).toHaveBeenCalledWith(TAB)
    for (const method of ['closeAll', 'constructor', '__proto__', undefined]) {
      expect(await l.answer('tab_relay', { method, args: [TAB] })).toEqual({ error: 'UNKNOWN_METHOD' })
    }
    // TAB_RELAY_OFF's own answers, as a core whose gateway holds no relay gives them.
    const { link: off } = link({ account: { tabRelay: TAB_RELAY_OFF } })
    expect(await off.answer('tab_relay', { method: 'send', args: [TAB, 'alice-mac', {}] })).toEqual({ result: false })
  })

  it('tells the process what a shared tab\'s relay said', () => {
    const { link: l, notify } = link()
    const event = { sharedTabId: 'a1b2c3d4e5f6a1b2c3d4e5f6', from: { machineId: 'alice-mac', userId: 'u' }, payload: { a: 1 } }
    l.tabFrame(event)
    expect(notify.mock.calls).toEqual([[{ type: 'service_event', payload: { kind: 'tab_frame', event } }]])
  })

  it('hands what a shared tab\'s relay said to Agent Messages in the core\'s process, to each listener until it stops', () => {
    const { link: l } = link()
    const event = { sharedTabId: 'a1b2c3d4e5f6a1b2c3d4e5f6', ready: true as const }
    const one = vi.fn(), two = vi.fn()
    const stopOne = l.onTabFrame(one)
    l.onTabFrame(two)
    l.tabFrame(event)
    stopOne()
    l.tabFrame({ sharedTabId: event.sharedTabId, undeliverable: 'bob-mac' })
    expect(one.mock.calls).toEqual([[event]])
    expect(two.mock.calls).toEqual([[event], [{ sharedTabId: event.sharedTabId, undeliverable: 'bob-mac' }]])
  })

  it('tells the process its switch changed here', () => {
    const { link: l, notify } = link()
    l.port.settingsChanged()
    expect(notify.mock.calls).toEqual([[{ type: 'service_event', payload: { kind: 'settings' } }]])
  })

  it('tells the process the desk or the machine list changed, and no other notice', () => {
    const { link: l, notify } = link()
    l.notice({ type: 'desk_changed', revision: 7 })
    l.notice({ type: 'machines_changed', reason: 'renamed' })
    l.notice({ type: 'connectors_changed', revision: 1 })
    l.notice({ type: 'zoo_changed', revision: 2 })
    expect(notify.mock.calls).toEqual([
      [{ type: 'service_event', payload: { kind: 'notice', notice: { type: 'desk_changed', revision: 7 } } }],
      [{ type: 'service_event', payload: { kind: 'notice', notice: { type: 'machines_changed', reason: 'renamed' } } }],
    ])
  })
})

describe('Agent Messages asked for as the core starts', () => {
  it('is asked for when it runs out of the core\'s process, which starts a process only under a master from before', () => {
    const want = vi.fn()
    expect(askForMessages(new Set(['search', 'messages']), want)).toBe(true)
    expect(want.mock.calls).toEqual([['messages']])
    expect(askForMessages(new Set(['search']), want)).toBe(false)
    expect(want).toHaveBeenCalledOnce()
  })
})
