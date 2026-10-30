import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi } from '../core/api.js'
import { createMessagesLink } from '../core/messagesLink.js'
import { TabSessions } from '../gateway/tabKey.js'
import { b64e, newIdentity } from '../lib/e2ee/core.js'
import type { RegisteredSession } from '../lib/registry.js'
import { parseRoster, type SignedRoster } from '../messages/roster.js'
import type { AgentMessages, MessagesOptions } from '../messages/service.js'
import { setAgentSettingsForTest, signedOutForTest, TEST_ACCOUNT } from '../testing/agentSettings.js'
import { fakeCore } from '../testing/fakeCore.js'
import { AGENTS_FRESH_MS, CORE_TOO_OLD_TEXT, runMessagesService, WATCHED, WRITABLE_EVERY_MS, WRITABLE_FOR_MS } from './messagesProcess.js'
import type { CoreConnection, ServiceProcessOptions } from './process.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

const OWNER = { local: true, owner: true }
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((settle) => setTimeout(settle, 0)) }
const agent = (agentId: string) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: '/w', displayName: agentId, terminalAvailable: true }) as unknown as RegisteredSession

describe('Agent Messages in its own process', () => {
  afterEach(() => vi.clearAllMocks())

  const setup = () => {
    let options: ServiceProcessOptions | null = null
    let api: CoreApi | null = null
    let given: MessagesOptions | undefined
    let clock = 10_000
    const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = []
    const writable = new Set<string>()
    const calls: string[] = []
    const stop = vi.fn()
    const service = runMessagesService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (o) => { options = o; return { stop } },
      now: () => clock,
      setTimer: (run, ms) => { const timer = { run, ms, cleared: false }; timers.push(timer); return timer },
      clearTimer: (timer) => { (timer as { cleared: boolean }).cleared = true },
      start: (core, opts) => {
        api = core
        given = opts
        return {
          requests: {
            agent_messages: async (payload) => ({ action: payload.action, agents: core.agents.live().map((a) => a.agentId), command: core.daemon.command }),
          },
          canWrite: (id) => writable.has(id),
          settingsChanged: () => calls.push('settings'),
          start: () => calls.push('start'),
          stop: () => calls.push('stop'),
        } satisfies AgentMessages
      },
    })
    return { options: options!, api: () => api!, given: () => given!, writable, timers, calls, service, stop, tick: (ms: number) => { clock += ms }, now: () => clock }
  }
  const core = (answers: Record<string, unknown> = {}) => {
    const asked: Array<[string, Record<string, unknown> | undefined]> = []
    const query = vi.fn(async (name: string, payload?: Record<string, unknown>) => {
      asked.push([name, payload])
      const answer = answers[name]
      if (answer instanceof Error) throw answer
      return (answer ?? {}) as Record<string, unknown>
    })
    return { connection: { query } satisfies CoreConnection, asked, query }
  }

  it('starts once it knows the agents and the daemon, and answers on the agents as each request starts', async () => {
    const { options, calls } = setup()
    expect(options).toMatchObject({ name: 'messages', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    const link = core({ shown: { agents: [agent('a1')] }, daemon: { command: `'node' 'cli.js'`, port: 18473, machineId: 'm' } })
    options.onConnected!(link.connection)
    await flush()
    expect(calls).toEqual(['start'])
    expect(await options.requests.agent_messages!({ action: 'history' }, OWNER)).toEqual({ action: 'history', agents: ['a1'], command: `'node' 'cli.js'` })
    // Connected again (a new core, the same machine): asked how the daemon runs again, not started twice.
    const again = core({ shown: { agents: [agent('a1')] }, daemon: { command: `'node' 'cli.js'`, port: 18473, machineId: 'm' } })
    options.onConnected!(again.connection)
    await flush()
    expect(calls).toEqual(['start'])
    expect(link.asked.filter(([name]) => name === 'daemon')).toHaveLength(1)
    expect(again.asked.filter(([name]) => name === 'daemon')).toHaveLength(1)
    // A core under another machine (signed in since): the service under the old one goes, a new one starts.
    options.onConnected!(core({ shown: { agents: [] }, daemon: { command: 'x', port: 1, machineId: 'account-machine' } }).connection)
    await flush()
    expect(calls).toEqual(['start', 'stop', 'start'])
  })

  it('keeps the daemon it knew when a new core cannot say', async () => {
    const { options, calls } = setup()
    options.onConnected!(core({ daemon: { command: 'x', port: 1, machineId: 'm' } }).connection)
    await flush()
    options.onConnected!(core({ daemon: new Error('gone') }).connection)
    await flush()
    expect(await options.requests.agent_messages!({ action: 'history' }, OWNER)).toMatchObject({ command: 'x' })
    expect(calls).toEqual(['start'])
  })

  it('starts nothing while it does not know which machine it serves', async () => {
    const { options, calls } = setup()
    options.onConnected!(core({ daemon: { error: 'NOT_AN_EXPERIMENT' } }).connection)
    await flush()
    expect(calls).toEqual([])
    expect(await options.requests.agent_messages!({ action: 'history' }, OWNER)).toMatchObject({ action: 'history' })
    expect(calls).toEqual([])
  })

  it('says whether this daemon is signed in as each core says it; a core from before says nothing, and the last word stands', async () => {
    // Signed out, the service runs nothing (messages/service.ts); a core from before 2026-10-12 never said, and the
    // service ran then as it does signed in.
    const { options, api } = setup()
    expect(api().account.signedIn()).toBe(true)
    options.onConnected!(core({ daemon: { command: 'x', port: 1, machineId: 'm', signedIn: false } }).connection)
    await flush()
    expect(api().account.signedIn()).toBe(false)
    options.onConnected!(core({ daemon: { command: 'x', port: 1, machineId: 'm', signedIn: true } }).connection)
    await flush()
    expect(api().account.signedIn()).toBe(true)
    options.onConnected!(core({ daemon: { command: 'x', port: 1, machineId: 'm' } }).connection)
    await flush()
    expect(api().account.signedIn()).toBe(true)
  })

  it('asks the core for tab_key, and holds no key while it is not connected', async () => {
    const link1 = { sharedTabId: 'a1b2c3d4e5f6a1b2c3d4e5f6', machineId: 'bob-mini', peerPub: 'UEVFUg==' }
    const { options, api } = setup()
    const key = api().account.tabKey
    // Not connected: no key, no session, nothing sealed.
    await expect(key.publicKey()).rejects.toThrow('not connected to the core')
    expect(await key.seal(link1, { type: 'ping' })).toEqual({ lost: true })
    key.drop(link1)
    const link = core({ tab_key: { result: 'cHVi' } })
    options.onConnected!(link.connection)
    await flush()
    expect(await key.publicKey()).toBe('cHVi')
    expect(await key.signRoster(link1.sharedTabId, 3, '{}')).toBe('cHVi')
    expect(link.asked).toContainEqual(['tab_key', { method: 'publicKey', args: [] }])
    expect(link.asked).toContainEqual(['tab_key', { method: 'signRoster', args: [link1.sharedTabId, 3, '{}'] }])
    key.drop(link1)
    expect(link.asked).toContainEqual(['tab_key', { method: 'drop', args: [link1] }])
  })

  it('asks the core which account is signed in here; not connected, or a core that cannot say, none', async () => {
    const { options, api } = setup()
    const identity = api().account.identity
    expect(await identity()).toBeNull()
    const link = core({ account: { accountId: 'u-alice', email: 'alice@x.io', extra: 1 } })
    options.onConnected!(link.connection)
    await flush()
    expect(await identity()).toEqual({ accountId: 'u-alice', email: 'alice@x.io' })
    expect(link.asked).toContainEqual(['account', {}])
    for (const account of [{ error: 'ACCOUNT_UNAVAILABLE' }, { accountId: '', email: 'a@x.io' }, { accountId: 'u', email: '' }, { accountId: 'u', email: 7 }]) {
      options.onConnected!(core({ account }).connection)
      expect(await identity()).toBeNull()
    }
  })

  it('shares a tab through the real link to the core: the core says the account and checks each backend call', async () => {
    // The real process and service, asking the real core/messagesLink.ts, as the edge host and the core do: the seam a
    // share action crosses, which the one GET the link allowed before refused, and `/api/auth/me` with it.
    const root = mkdtempSync(join(tmpdir(), 'messages-process-share-'))
    try {
      setAgentSettingsForTest(root, { agentMessages: true })
      // The id the backend derives from the account and the desk tab, which the owner checks (messages/sharedTabs.ts `share`).
      const SID = createHash('sha256').update(JSON.stringify(['amsg-share', 'u-alice', 'app'])).digest('hex').slice(0, 24), identity = newIdentity()
      const held = new Map<string, { version: number; roster: SignedRoster }>()
      const ok = (data: unknown) => ({ status: 200, body: { success: true, data } as Record<string, unknown> })
      const backend = vi.fn(async (method: string, path: string, body?: unknown) => {
        if (method === 'GET' && path === '/api/agent-messages') {
          return ok({ revision: 1, machines: [{ machineId: TEST_ACCOUNT.machineId, name: 'studio' }],
            tabs: [{ id: 'app', name: 'app', panes: [{ machineId: TEST_ACCOUNT.machineId, agentId: 'lead' }] }] })
        }
        if (method === 'PUT' && path === '/api/agent-messages/shares/app/roster') {
          const b = body as { version: number; roster: SignedRoster }
          held.set(SID, b)
          return ok({ sharedTabId: SID, version: b.version })
        }
        if (method === 'GET' && path === '/api/agent-messages/shares') {
          return ok({ shares: [...held].map(([sharedTabId, h]) => ({ sharedTabId, owner: true, ownerEmail: 'alice@x.io', ownerMachineId: TEST_ACCOUNT.machineId,
            version: h.version, roster: h.roster, tabId: 'app', members: [], invites: [] })) })
        }
        return { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'no' } } as Record<string, unknown> }
      })
      const relay = { open: vi.fn(async () => {}), send: vi.fn(async () => true), close: vi.fn() }
      const theCore = fakeCore({
        dataDir: root,
        daemon: { command: 'harness', port: 1, machineId: () => TEST_ACCOUNT.machineId, autonomousEnv: 'prod' },
        agents: { live: () => [{ ...agent('lead'), tmuxPane: '%1', runtimes: [{ backend: 'tmux' as const, paneId: '%1' }], active: true }], displayName: () => 'lead', terminalAvailable: () => true, dsh: () => null },
        account: { backend, identity: async () => ({ accountId: 'u-alice', email: 'alice@x.io' }), signedIn: () => true,
          tabKey: new TabSessions(() => identity, () => TEST_ACCOUNT.machineId), tabRelay: relay },
      })
      const link = createMessagesLink({ core: theCore, notify: () => true })
      const { runServiceProcess } = await import('./process.js')
      const process = runMessagesService({ dataDir: root, socketPath: '/s', machineId: 'm', token: 't' })
      const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
      options.onConnected!({ query: async (query, payload) => link.answer(query, payload ?? {}) })
      await flush()
      expect(await options.requests.agent_messages!({ action: 'share_tab', tabId: 'app', name: 'app' }, OWNER)).toEqual({ sharedTabId: SID })
      const roster = parseRoster(held.get(SID)!.roster.body)!
      expect(roster).toMatchObject({ sharedTabId: SID, version: 2, owner: { accountId: 'u-alice', email: 'alice@x.io', machineId: TEST_ACCOUNT.machineId,
        machinePublicKey: b64e(identity.pub) } })
      expect(roster.harnesses.map((h) => `${h.machineId}/${h.agentId}`)).toEqual([`${TEST_ACCOUNT.machineId}/lead`])
      expect(relay.open).toHaveBeenCalledWith(SID)
      // Every call the share made went through the core's check, and none asked who is signed in.
      expect(backend.mock.calls.map(([method, path]) => `${method} ${path}`)).toEqual(expect.arrayContaining([
        'GET /api/agent-messages', 'GET /api/agent-messages/shares', 'PUT /api/agent-messages/shares/app/roster']))
      expect(backend.mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(2)
      expect(backend.mock.calls.some(([, path]) => path === '/api/auth/me')).toBe(false)
      process.stop()
    } finally {
      signedOutForTest()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads the account\'s tabs again when the core hears the machine list changed, through the real link', async () => {
    // Its timer reads only every 5 minutes (messages/directory.ts): a machine added, renamed or deleted reaches the edge host
    // as the core's notice, which the link forwards, as it forwards the desk's.
    const root = mkdtempSync(join(tmpdir(), 'messages-process-machines-'))
    try {
      setAgentSettingsForTest(root, { agentMessages: true })
      const backend = vi.fn(async (method: string, path: string) => (method === 'GET' && path === '/api/agent-messages'
        ? { status: 200, body: { success: true, data: { revision: 1, machines: [{ machineId: TEST_ACCOUNT.machineId, name: 'studio' }],
          tabs: [{ id: 'app', name: 'app', panes: [{ machineId: TEST_ACCOUNT.machineId, agentId: 'lead' }] }] } } as Record<string, unknown> }
        : { status: 404, body: {} as Record<string, unknown> }))
      const theCore = fakeCore({
        dataDir: root,
        daemon: { command: 'harness', port: 1, machineId: () => TEST_ACCOUNT.machineId, autonomousEnv: 'prod' },
        agents: { live: () => [{ ...agent('lead'), tmuxPane: '%1', runtimes: [{ backend: 'tmux' as const, paneId: '%1' }], active: true }], displayName: () => 'lead', terminalAvailable: () => true, dsh: () => null },
        account: { backend, signedIn: () => true },
      })
      const { runServiceProcess } = await import('./process.js')
      const process = runMessagesService({ dataDir: root, socketPath: '/s', machineId: 'm', token: 't' })
      const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
      const link = createMessagesLink({ core: theCore, notify: (frame) => { options.onEvent!(frame.payload); return true } })
      options.onConnected!({ query: async (query, payload) => link.answer(query, payload ?? {}) })
      await flush()
      const reads = () => backend.mock.calls.filter(([method, path]) => method === 'GET' && path === '/api/agent-messages').length
      const first = reads()
      expect(first).toBeGreaterThan(0)
      link.notice({ type: 'machines_changed', reason: 'renamed' })
      await flush()
      expect(reads()).toBe(first + 1)
      link.notice({ type: 'connectors_changed', revision: 1 })
      await flush()
      expect(reads()).toBe(first + 1)
      process.stop()
    } finally {
      signedOutForTest()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('under a core from before shared tabs, every share action says to restart on the new version, and send in its own tab still works', async () => {
    // Version skew (plan Task D3, case 1): the edge host is this build's, the core is not, which a master that cannot
    // re-execute leaves running (e2e/messagesSkew.e2e.ts). That core answers as core/messagesLink.ts did before shared
    // tabs: `account`, `tab_key`, `tab_relay` and `observers` are UNKNOWN_QUERY, and `backend` allows only the tab listing.
    const root = mkdtempSync(join(tmpdir(), 'messages-process-old-core-'))
    try {
      setAgentSettingsForTest(root, { agentMessages: true })
      const ok = (data: unknown) => ({ status: 200, body: { success: true, data } as Record<string, unknown> })
      const backend = vi.fn(async (method: string, path: string) => (method === 'GET' && path === '/api/agent-messages'
        ? ok({ revision: 1, machines: [{ machineId: TEST_ACCOUNT.machineId, name: 'studio' }],
          tabs: [{ id: 'app', name: 'app', panes: ['lead', 'api'].map((agentId) => ({ machineId: TEST_ACCOUNT.machineId, agentId })) }] })
        : { status: 404, body: {} as Record<string, unknown> }))
      const live = [{ ...agent('lead'), tmuxPane: '%1', runtimes: [{ backend: 'tmux' as const, paneId: '%1' }], active: true }, { ...agent('api'), tmuxPane: '%2', runtimes: [{ backend: 'tmux' as const, paneId: '%2' }], active: true }]
      const theCore = fakeCore({
        dataDir: root,
        daemon: { command: 'harness', port: 1, machineId: () => TEST_ACCOUNT.machineId, autonomousEnv: 'prod' },
        agents: { live: () => live, displayName: (s) => s.agentId, terminalAvailable: () => true, dsh: () => null },
        account: { backend, signedIn: () => true },
      })
      const link = createMessagesLink({ core: theCore, notify: () => true })
      const asked: string[] = []
      const old = (query: string, payload: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>> => {
        asked.push(query)
        if (['account', 'tab_key', 'tab_relay', 'observers'].includes(query)) return { error: 'UNKNOWN_QUERY' }
        if (query === 'backend' && (payload.method !== 'GET' || payload.path !== '/api/agent-messages')) return { error: 'INVALID_REQUEST' }
        // The core's own deliveries (core/deliveries.ts) took a typed message then as now.
        if (query === 'deliver') return {}
        return link.answer(query, payload)
      }
      const { runServiceProcess } = await import('./process.js')
      const process = runMessagesService({ dataDir: root, socketPath: '/s', machineId: 'm', token: 't' })
      const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
      options.onConnected!({ query: async (query, payload) => old(query, payload ?? {}) })
      await flush()
      const ACTIONS = ['shares', 'share_tab', 'share_invite', 'share_revoke', 'share_accept', 'share_add', 'share_remove', 'share_leader',
        'share_remove_member', 'share_leave', 'share_stop', 'share_retrust_check', 'share_retrust', 'share_move', 'share_tasks']
      for (const action of ACTIONS) {
        expect(await options.requests.agent_messages!({ action, tabId: 'app', sharedTabId: 'a1b2c3d4e5f6a1b2c3d4e5f6' }, OWNER), action)
          .toEqual({ error: 'DAEMON_TOO_OLD', detail: CORE_TOO_OLD_TEXT })
      }
      expect(CORE_TOO_OLD_TEXT).toContain('restart')
      expect(CORE_TOO_OLD_TEXT).not.toMatch(/`/)
      // The identity was asked of the core (it said UNKNOWN_QUERY), not assumed: without the ask the answer is not this.
      expect(asked).toContain('account')
      // Nothing was shared: no share route was asked of that core, which would have refused it anyway.
      expect(backend.mock.calls.map(([, path]) => path)).not.toContain('/api/agent-messages/shares')
      // Agent Messages within the account's own tab work as they did.
      const sent = await options.requests.agent_messages!({ action: 'send', pane: '%1', to: ['api'], text: 'Which port?' }, OWNER)
      expect(sent).toMatchObject({ tab: 'app', recipients: [{ name: 'api' }] })
      expect(sent).not.toHaveProperty('error')
      expect(asked).toContain('deliver')
      process.stop()
    } finally {
      signedOutForTest()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('says a core from before shared tabs needs a restart when their key or the account is asked of it', async () => {
    const { options, api } = setup()
    options.onConnected!(core({ account: { error: 'UNKNOWN_QUERY' }, tab_key: { error: 'UNKNOWN_QUERY' } }).connection)
    await flush()
    await expect(api().account.identity()).rejects.toMatchObject({ code: 'DAEMON_TOO_OLD', message: CORE_TOO_OLD_TEXT })
    // The key's refusal names the core, as a key's own refusal names why: a signature, a hello, this machine's key.
    await expect(api().account.tabKey.publicKey()).rejects.toThrow(CORE_TOO_OLD_TEXT)
    const link = { sharedTabId: 'a1b2c3d4e5f6a1b2c3d4e5f6', machineId: 'bob-mini', peerPub: 'UEVFUg==' }
    await expect(api().account.tabKey.hello(link)).rejects.toThrow(CORE_TOO_OLD_TEXT)
    expect(await api().account.tabKey.seal(link, { a: 1 })).toEqual({ lost: true })
  })

  it('asks the core for tab_relay, and sends nothing while it is not connected', async () => {
    const TAB = 'a1b2c3d4e5f6a1b2c3d4e5f6'
    const { options, api } = setup()
    const relay = api().account.tabRelay
    await expect(relay.open(TAB)).resolves.toBeUndefined()
    expect(await relay.send(TAB, 'alice-mac', {})).toBe(false)
    relay.close(TAB)
    const link = core({ tab_relay: { result: true } })
    options.onConnected!(link.connection)
    await flush()
    await relay.open(TAB)
    expect(await relay.send(TAB, 'alice-mac', { sealed: 1 })).toBe(true)
    relay.close(TAB)
    expect(link.asked).toContainEqual(['tab_relay', { method: 'open', args: [TAB] }])
    expect(link.asked).toContainEqual(['tab_relay', { method: 'send', args: [TAB, 'alice-mac', { sealed: 1 }] }])
    expect(link.asked).toContainEqual(['tab_relay', { method: 'close', args: [TAB] }])
  })

  it('hands its service what a shared tab\'s relay said once it runs, as the shape it must be', async () => {
    const TAB = 'a1b2c3d4e5f6a1b2c3d4e5f6'
    const { options, given } = setup()
    const heard = vi.fn()
    // Not running yet: there is nobody to hand it to.
    options.onEvent!({ kind: 'tab_frame', event: { sharedTabId: TAB, ready: true } })
    options.onConnected!(core({ daemon: { command: 'x', port: 1, machineId: 'm' } }).connection)
    await flush()
    const stop = given().onTabFrame!(heard)
    options.onEvent!({ kind: 'tab_frame', event: { sharedTabId: TAB, from: { machineId: 'alice-mac', userId: 'u' }, payload: { a: 1 }, extra: 1 } })
    options.onEvent!({ kind: 'tab_frame', event: { from: { machineId: 'alice-mac', userId: 'u' } } })
    options.onEvent!({ kind: 'tab_frame' })
    stop()
    options.onEvent!({ kind: 'tab_frame', event: { sharedTabId: TAB, undeliverable: 'carol-pc' } })
    expect(heard.mock.calls).toEqual([[{ sharedTabId: TAB, from: { machineId: 'alice-mac', userId: 'u' }, payload: { a: 1 } }]])
  })

  it('passes on a change to its switch once its service runs, and before then has nothing to tell', async () => {
    const { options, calls } = setup()
    options.onEvent!({ kind: 'settings' })
    expect(calls).toEqual([])
    options.onConnected!(core({ daemon: { command: 'x', port: 1, machineId: 'm' } }).connection)
    await flush()
    options.onEvent!({ kind: 'settings' })
    expect(calls).toEqual(['start', 'settings'])
  })

  it('gives the service its data folder, and hears from it when what may be written changed', async () => {
    const { options, given, writable } = setup()
    const link = core()
    options.onConnected!(link.connection)
    expect(given().dataDir).toBe('/data')
    writable.add('team:d9')
    given().changed!()
    expect(link.asked.at(-1)?.[0]).toBe('writable')
  })

  it('tells the core a shared tab\'s roster changed here, for Share to derive its observers again, never waiting on it', async () => {
    const { options, given } = setup()
    const link = core({ observers: new Error('Share is down') })
    options.onConnected!(link.connection)
    given().observers!()
    await flush()
    expect(link.asked).toContainEqual(['observers', {}])
    // Not connected to a core, there is nobody to tell.
    options.onDisconnected?.()
    given().observers!()
    await flush()
  })

  it('tells the core a delivery may be written before handing it over, and keeps telling while any may', async () => {
    const { options, api, writable, timers, tick } = setup()
    const link = core()
    options.onConnected!(link.connection)
    await flush()
    link.asked.length = 0
    writable.add('team:d1')
    api().turns.deliver('a1', 'a question', 'team:d1')
    expect(link.asked.map(([name]) => name)).toEqual(['writable', 'deliver'])
    expect(link.asked[0][1]).toEqual({ deliveries: { 'team:d1': 10_000 + WRITABLE_FOR_MS } })
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(WRITABLE_EVERY_MS)
    tick(WRITABLE_EVERY_MS)
    timers[0].run()
    expect(link.asked.at(-1)).toEqual(['writable', { deliveries: { 'team:d1': 11_000 + WRITABLE_FOR_MS } }])
    // Taken back: told once that none may, and the telling stops.
    writable.delete('team:d1')
    timers[0].run()
    expect(link.asked.at(-1)).toEqual(['writable', { deliveries: {} }])
    expect(timers[0].cleared).toBe(true)
    const count = link.asked.length
    // Nothing changed and none may: nothing more to say.
    options.onEvent!({ kind: 'delivery', event: { deliveryId: 'team:d1', sessionId: 'a1', state: 'started' } })
    expect(link.asked).toHaveLength(count)
  })

  it('watches the last deliveries only, and one handed over again as the newest', async () => {
    const { options, api, writable } = setup()
    const link = core()
    options.onConnected!(link.connection)
    for (let i = 0; i <= WATCHED; i++) api().turns.deliver('a1', 'q', `team:d${i}`)
    api().turns.deliver('a1', 'q', 'team:d5')
    writable.add('team:d0')
    writable.add('team:d5')
    api().turns.deliver('a1', 'q', 'team:dX')
    expect(link.asked.filter(([name]) => name === 'writable').at(-1)![1]).toEqual({ deliveries: { 'team:d5': expect.any(Number) } })
  })

  it('takes nothing back in line: a delivery its mailbox no longer wants is one it says may not be written', async () => {
    const { options, api } = setup()
    options.onConnected!(core().connection)
    expect(api().turns.cancelDelivery('team:d1')).toBe(false)
  })

  it('hears the account\'s notices once it runs, and its deliveries\' progress; anything else is not its', async () => {
    const { options, api } = setup()
    const heard = vi.fn(), noticed = vi.fn()
    api().turns.onDelivery(heard)
    const stop = api().account.onNotice(noticed)
    // Not running yet: a notice is the next service's to read when it starts.
    options.onEvent!({ kind: 'notice', notice: { type: 'desk_changed', revision: 1 } })
    options.onConnected!(core({ daemon: { command: 'x', port: 1, machineId: 'm' } }).connection)
    await flush()
    options.onEvent!({ kind: 'delivery', event: { deliveryId: 'team:d1', sessionId: 'a1', state: 'queued' } })
    options.onEvent!({ kind: 'notice', notice: { type: 'desk_changed', revision: 2 } })
    options.onEvent!({ kind: 'notice' })
    options.onEvent!({ kind: 'other' })
    stop()
    options.onEvent!({ kind: 'notice', notice: { type: 'desk_changed', revision: 3 } })
    expect(heard).toHaveBeenCalledOnce()
    expect(noticed.mock.calls).toEqual([[{ type: 'desk_changed', revision: 2 }]])
  })

  it('reads the agents again, for its mailbox\'s next look, once they are a second old; once at a time', async () => {
    const { options, api, tick } = setup()
    const link = core({ shown: { agents: [agent('a1')] } })
    options.onConnected!(link.connection)
    await flush()
    const reads = () => link.asked.filter(([name]) => name === 'shown').length
    const before = reads()
    expect(api().agents.live().map((a) => a.agentId)).toEqual(['a1'])
    expect(reads()).toBe(before)
    tick(AGENTS_FRESH_MS + 1)
    api().agents.live()
    api().agents.live()
    expect(reads()).toBe(before + 1)
    // A core that cannot say keeps the agents it said.
    link.query.mockRejectedValueOnce(new Error('gone'))
    tick(AGENTS_FRESH_MS + 1)
    await flush()
    api().agents.live()
    await flush()
    expect(api().agents.live().map((a) => a.agentId)).toEqual(['a1'])
  })

  it('acts on nothing before it connects, or after the core is gone, and stops what it runs with the process', async () => {
    const { options, api, service, stop, calls, writable, timers } = setup()
    api().turns.deliver('a1', 'q', 'team:d1')
    await flush()
    expect(await options.requests.agent_messages!({ action: 'history' }, OWNER)).toMatchObject({ agents: [], command: 'harness' })
    options.onConnected!(core().connection)
    writable.add('team:d2')
    api().turns.deliver('a1', 'q', 'team:d2')
    options.onDisconnected!()
    await service.stop()
    expect(timers[0].cleared).toBe(true)
    expect(calls).toContain('stop')
    expect(stop).toHaveBeenCalledOnce()
    // Stopped with nothing being told: nothing to clear.
    const quiet = setup()
    await quiet.service.stop()
  })

  it('runs the real process, on the real clock and timers, when given none', async () => {
    vi.useFakeTimers()
    try {
      const { runServiceProcess } = await import('./process.js')
      const writable = new Set(['team:d1'])
      let api: CoreApi | null = null
      const process = runMessagesService({
        dataDir: '/data', socketPath: '/s', machineId: 'm', token: 't',
        start: (given) => {
          api = given
          return { requests: { agent_messages: async () => ({}) }, canWrite: (id) => writable.has(id), settingsChanged: () => {}, start: () => {}, stop: () => {} }
        },
      })
      const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
      const link = core()
      options.onConnected!(link.connection)
      api!.turns.deliver('a1', 'q', 'team:d1')
      await vi.advanceTimersByTimeAsync(WRITABLE_EVERY_MS)
      expect(link.asked.filter(([name]) => name === 'writable').length).toBeGreaterThanOrEqual(2)
      process.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts the real service when given none', async () => {
    const { runServiceProcess } = await import('./process.js')
    runMessagesService({ dataDir: '/data-that-is-not-there', socketPath: '/s', machineId: 'm', token: 't' }).stop()
    expect(vi.mocked(runServiceProcess).mock.calls.at(-1)![0].requests.agent_messages).toBeTypeOf('function')
  })
})
