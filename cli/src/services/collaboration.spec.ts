import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, type BackendNotice, type TurnDelivery } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { ChannelDependencies } from '../teams/channels.js'
import type { MailboxDependencies } from '../teams/mailbox.js'
import { TeamError } from '../teams/model.js'
import type { TeamDependencies } from '../teams/service.js'
import { fakeCore } from '../testing/fakeCore.js'

/**
 * The teams' own classes are the teams' specs' to prove (src/teams); here, what the service gives them and
 * how it answers for them, each moved out of the socket as it was.
 */
const made = vi.hoisted(() => ({
  teams: [] as Array<{ deps: TeamDependencies; calls: string[]; channel: boolean; startThrows: boolean }>,
  mailboxes: [] as Array<{ deps: MailboxDependencies; calls: string[]; writable: Set<string> }>,
  channels: [] as Array<{ deps: ChannelDependencies; calls: string[] }>,
  answered: [] as string[],
  startThrows: false,
  refreshFails: false,
}))
vi.mock('../teams/service.js', async (original) => ({
  ...await original<typeof import('../teams/service.js')>(),
  TeamService: class {
    record: (typeof made.teams)[number]
    constructor(deps: TeamDependencies) { this.record = { deps, calls: [], channel: false, startThrows: made.startThrows }; made.teams.push(this.record) }
    start() { this.record.calls.push('start'); if (this.record.startThrows) throw new Error('unreadable') }
    stop() { this.record.calls.push('stop') }
    isChannel() { return this.record.channel }
  },
}))
vi.mock('../teams/mailbox.js', () => ({
  TeamMailbox: class {
    record: (typeof made.mailboxes)[number]
    constructor(deps: MailboxDependencies) { this.record = { deps, calls: [], writable: new Set() }; made.mailboxes.push(this.record) }
    start() { this.record.calls.push('start') }
    stop() { this.record.calls.push('stop') }
    pump() { this.record.calls.push('pump') }
    observe(event: TurnDelivery) { this.record.calls.push(`observe ${event.deliveryId}`) }
    canWrite(id: string) { return this.record.writable.has(id) }
    accept(delivery: { id: string }) { this.record.calls.push(`accept ${delivery.id}`); return { id: delivery.id, state: 'queued' } }
    status(id: string) { this.record.calls.push(`status ${id}`); return null }
    hold(id: string, held: boolean) { this.record.calls.push(`hold ${id} ${held}`); return null }
    cancel(id: string, received: boolean) { this.record.calls.push(`cancel ${id} ${received}`); return { id, state: 'cancelled' } }
  },
}))
vi.mock('../teams/channels.js', () => ({
  ChannelDirectory: class {
    record: (typeof made.channels)[number]
    constructor(deps: ChannelDependencies) { this.record = { deps, calls: [] }; made.channels.push(this.record) }
    start() { this.record.calls.push('start') }
    stop() { this.record.calls.push('stop') }
    refresh(force: boolean) { this.record.calls.push(`refresh ${force}`); return made.refreshFails ? Promise.reject(new Error('offline')) : Promise.resolve({}) }
    taskContext(agentId: string, teamId: string | null) { return Promise.resolve({ context: agentId, teamId }) }
    request(payload: { action: string }) { return Promise.resolve({ channel: payload.action }) }
  },
}))
vi.mock('../teams/wire.js', async (original) => ({
  ...await original<typeof import('../teams/wire.js')>(),
  teamRequest: async (_service: unknown, payload: { action: string }) => { made.answered.push(`team ${payload.action}`); return { team: payload.action } },
  teamDeliveryRequest: (_mailbox: unknown, payload: { action: string }) => { made.answered.push(`delivery ${payload.action}`); return { receipt: payload.action } },
}))
const { startCollaboration, startTeamsInCore, TEAMS_REQUESTS } = await import('./collaboration.js')

const OWNER = { local: true, owner: true }
const TEAM = 'a'.repeat(32), QUESTION = 'b'.repeat(32), RECEIPT = `team:${'c'.repeat(32)}:${'d'.repeat(32)}:question`
const agent = (agentId: string, active = true) => ({ agentId, sessionId: `s-${agentId}`, engine: 'codex', cwd: '/w', active }) as RegisteredSession

describe('Tab collaboration and teams, as a service', () => {
  let dataDir: string
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'collaboration-'))
    made.teams.length = 0; made.mailboxes.length = 0; made.channels.length = 0; made.answered.length = 0
    made.startThrows = false
    made.refreshFails = false
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  const setup = (over: { scope?: string | null; backend?: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }> } = {}, options: Record<string, unknown> = {}) => {
    const listeners: Array<(event: TurnDelivery) => void> = []
    const notices: Array<(notice: BackendNotice) => void> = []
    const stopHearing = vi.fn(), stopNotices = vi.fn()
    const deliver = vi.fn(), cancelDelivery = vi.fn(() => true), windows = vi.fn()
    const live = new Map([['a1', agent('a1')], ['a2', agent('a2', false)], ['a3', { ...agent('a3'), cwd: null } as unknown as RegisteredSession]])
    const core = fakeCore({
      dataDir,
      agents: { byAgent: (id) => live.get(id), displayName: (session) => `name ${session.agentId}`, terminalAvailable: (id) => id === 'a1' },
      turns: { deliver, cancelDelivery, onDelivery: (listener) => { listeners.push(listener); return stopHearing } },
      account: {
        backend: over.backend ?? (async () => ({ status: 200, body: { success: true, data: { tabs: [] } } })),
        onNotice: (listener) => { notices.push(listener); return stopNotices },
      },
      clients: { windows },
      daemon: { command: `'node' 'cli.js'`, port: 18473, machineId: () => 'm1' },
    })
    const replied = vi.fn()
    const rpc = vi.fn(async (_at: unknown, _type: string, payload: Record<string, unknown>) => ({ teamId: payload.action === 'prompt_scope' ? 'remote-team' : undefined, runtime: { name: 'far' }, receipt: payload.action === 'status' ? null : { id: RECEIPT, state: 'queued', updatedAt: 1 } }))
    const teams = startCollaboration(core, { scopes: { current: () => over.scope ?? null, replied }, rpc: rpc as never, ...options })
    return { core, teams, listeners, notices, stopHearing, stopNotices, deliver, cancelDelivery, windows, replied, rpc }
  }

  it('declares the teams\' two requests', () => {
    expect(TEAMS_REQUESTS).toEqual(['team', 'team_delivery'])
  })

  it('answers an owner alone, and says why a request it cannot read failed', async () => {
    const { teams } = setup()
    expect(await teams.requests.team({ action: 'list' }, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED', detail: 'Team communication requires an owner connection.' })
    expect(await teams.requests.team({ action: 'list' }, OWNER)).toEqual({ team: 'list' })
    expect(await teams.requests.team({ action: 'context', agentId: '../bad' }, OWNER)).toMatchObject({ error: 'INVALID_REQUEST' })
  })

  it('answers a task\'s context from the scope its prompt came from, and a channel\'s own requests from the channels', async () => {
    const { teams } = setup({ scope: TEAM })
    expect(await teams.requests.team({ action: 'context', agentId: 'a1' }, OWNER)).toEqual({ context: 'a1', teamId: TEAM })
    expect(await teams.requests.team({ action: 'channel_list' }, OWNER)).toEqual({ channel: 'channel_list' })
    // A channel's team is read fresh before its members are asked of, or a question asked in it.
    await teams.requests.team({ action: 'get', teamId: TEAM }, OWNER)
    made.teams[0].channel = true
    await teams.requests.team({ action: 'ask', teamId: TEAM }, OWNER)
    await teams.requests.team({ action: 'members', teamId: TEAM }, OWNER)
    await teams.requests.team({ action: 'archive', teamId: TEAM }, OWNER)
    expect(made.channels[0].calls).toEqual(['refresh true', 'refresh false'])
  })

  it('answers a delivery\'s own questions: an agent\'s runtime, its prompt\'s scope, a reply moving it back, and the mailbox', async () => {
    const { teams, replied } = setup({ scope: TEAM })
    expect(await teams.requests.team_delivery({ action: 'runtime', agentId: 'a1' }, OWNER)).toEqual({ runtime: { name: 'name a1', engine: 'codex', cwd: '/w', available: true } })
    expect(await teams.requests.team_delivery({ action: 'runtime', agentId: 'a2' }, OWNER)).toEqual({ runtime: { name: 'name a2', engine: 'codex', cwd: '/w', available: false, reason: 'Session is paused or offline.' } })
    expect(await teams.requests.team_delivery({ action: 'runtime', agentId: 'nobody' }, OWNER)).toEqual({ runtime: null })
    expect(await teams.requests.team_delivery({ action: 'runtime', agentId: 'a3' }, OWNER)).toEqual({ runtime: { name: 'name a3', engine: 'codex', cwd: undefined, available: false } })
    expect(await teams.requests.team_delivery({ action: 'prompt_scope', agentId: 'a1' }, OWNER)).toEqual({ teamId: TEAM })
    expect(await teams.requests.team_delivery({ action: 'prompt_replied', agentId: 'a1', teamId: TEAM, questionId: QUESTION }, OWNER)).toEqual({ ok: true })
    expect(replied).toHaveBeenCalledWith('a1', TEAM, QUESTION)
    expect(await teams.requests.team_delivery({ action: 'send', delivery: { id: 'd1' } }, OWNER)).toEqual({ receipt: 'send' })
    expect(await teams.requests.team_delivery({ action: 'cancel' }, OWNER)).toEqual({ receipt: 'cancel' })
  })

  it('in the teams\' own process, asks the core before the mailbox takes a delivery back, and says what may be written changed', async () => {
    const order: string[] = []
    const takingBack = vi.fn(async (id: string) => { order.push(`ask ${id}`); return () => order.push(`release ${id}`) })
    const changed = vi.fn(() => order.push('changed'))
    const { teams } = setup({}, { takingBack, changed })
    for (const action of ['cancel', 'consume', 'hold']) await teams.requests.team_delivery({ action, delivery: { id: `d-${action}` } }, OWNER)
    await teams.requests.team_delivery({ action: 'release', delivery: { id: 'd-release' } }, OWNER)
    await teams.requests.team_delivery({ action: 'cancel', delivery: {} }, OWNER)
    expect(takingBack.mock.calls.map(([id]) => id)).toEqual(['d-cancel', 'd-consume', 'd-hold'])
    expect(order.slice(0, 3)).toEqual(['ask d-cancel', 'release d-cancel', 'changed'])
    expect(changed).toHaveBeenCalledTimes(5)
  })

  it('gives the teams what the socket gave them, from the core\'s API', async () => {
    const { teams, deliver, cancelDelivery, windows, rpc, replied } = setup({ scope: TEAM })
    await teams.requests.team({ action: 'list' }, OWNER)
    const deps = made.teams[0].deps
    expect(deps.stateDir).toBe(join(dataDir, 'teams', 'ledgers'))
    expect(deps.machineId).toBe('m1')
    const here = { machineId: 'm1', agentId: 'a1' }, there = { machineId: 'm2', agentId: 'b1' }
    expect(deps.command(here)).toBe(`'node' 'cli.js' team --port 18473`)
    expect(deps.command(there)).toBe('harness team')
    expect(await deps.taskScope!(here)).toBe(TEAM)
    expect(await deps.taskScope!(there)).toBe('remote-team')
    rpc.mockResolvedValueOnce({} as never)
    expect(await deps.taskScope!(there)).toBeNull()
    await deps.questionReplied!(here, TEAM, QUESTION)
    expect(replied).toHaveBeenCalledWith('a1', TEAM, QUESTION)
    await deps.questionReplied!(there, TEAM, QUESTION)
    expect(rpc).toHaveBeenCalledWith({ port: 18473, machineId: 'm2', dataDir }, 'team_delivery', { action: 'prompt_replied', agentId: 'b1', teamId: TEAM, questionId: QUESTION })
    expect(await deps.runtime(here)).toMatchObject({ name: 'name a1', available: true })
    expect(await deps.runtime(there)).toEqual({ name: 'far' })
    // The mailbox here, for a member here.
    expect(await deps.delivery(here, 'send', { id: 'd1' } as never)).toEqual({ id: 'd1', state: 'queued' })
    await deps.delivery(here, 'status', { id: 'd1' })
    await deps.delivery(here, 'hold', { id: 'd1' })
    await deps.delivery(here, 'release', { id: 'd1' })
    await deps.delivery(here, 'cancel', { id: 'd1' })
    await deps.delivery(here, 'consume', { id: 'd1' })
    expect(made.mailboxes[0].calls).toEqual(['accept d1', 'status d1', 'hold d1 true', 'hold d1 false', 'cancel d1 false', 'cancel d1 true'])
    // Another machine's, through its own daemon.
    expect(await deps.delivery(there, 'send', { id: 'd2' } as never)).toEqual({ id: RECEIPT, state: 'queued', updatedAt: 1 })
    expect(await deps.delivery(there, 'status', { id: 'd2' })).toBeNull()
    deps.changed!('t1', 3)
    expect(windows).toHaveBeenCalledWith({ type: 'team_changed', payload: { id: 't1', revision: 3 } })
    // The mailbox writes and takes back through the core's delivered turns.
    const mailbox = made.mailboxes[0].deps
    expect(mailbox.stateDir).toBe(join(dataDir, 'teams', 'mailboxes'))
    mailbox.send('a1', 'a question', 'team:d1')
    expect(deliver).toHaveBeenCalledWith('a1', 'a question', 'team:d1')
    expect(mailbox.cancel('team:d1')).toBe(true)
    expect(cancelDelivery).toHaveBeenCalledWith('team:d1')
    expect(mailbox.runtime('a1')).toMatchObject({ available: true })
    expect(mailbox.channelsEnabled!()).toBe(false)
  })

  it('reads and sets the tab channels through the account, says why it could not, and reaches other machines through its daemon', async () => {
    const answers = [
      { status: 200, body: { success: true, data: { tabs: ['t'] } } },
      { status: 404, body: {} },
      { status: 500, body: {} },
      { status: 200, body: { success: true, data: { enabled: true } } },
      { status: 404, body: {} },
      { status: 200, body: { success: false } },
    ]
    const backend = vi.fn(async () => answers.shift()!)
    const changed = vi.fn()
    const { teams, rpc } = setup({ backend }, { changed })
    teams.refreshChannels()
    const deps = made.channels[0].deps
    expect(deps.machineId).toBe('m1')
    expect(await deps.readDesk()).toEqual({ tabs: ['t'] })
    await expect(deps.readDesk()).rejects.toMatchObject({ code: 'CHANNELS_UNSUPPORTED' })
    await expect(deps.readDesk()).rejects.toThrow('The saved channel directory is unavailable.')
    expect(await deps.writeSettings!(true)).toEqual({ enabled: true })
    expect(backend).toHaveBeenLastCalledWith('PATCH', '/api/tab-channels/settings', { enabled: true })
    await expect(deps.writeSettings!(false)).rejects.toMatchObject({ code: 'CHANNELS_UNSUPPORTED' })
    await expect(deps.writeSettings!(false)).rejects.toMatchObject({ code: 'CHANNEL_SETTINGS_FAILED' })
    // Switched on: the mailbox delivers what waited for it, and what may be written changed.
    deps.enabledChanged!(true)
    expect(changed).toHaveBeenCalledOnce()
    await teams.requests.team_delivery({ action: 'send', delivery: { id: 'd1' } }, OWNER)
    deps.enabledChanged!(true)
    expect(made.mailboxes[0].calls).toContain('pump')
    expect(made.mailboxes[0].deps.channelsEnabled!()).toBe(true)
    await deps.forward('m2', { action: 'channel_get' })
    expect(rpc).toHaveBeenLastCalledWith({ port: 18473, machineId: 'm2', dataDir }, 'team', { action: 'channel_get' })
    expect(made.channels[0].calls).toEqual(['refresh true'])
    expect(TeamError).toBeTypeOf('function')
  })

  it('hears what became of its deliveries once its mailbox is up, and the account\'s desk changing', async () => {
    const { teams, listeners, notices } = setup()
    const event: TurnDelivery = { deliveryId: 'team:d1', sessionId: 'a1', state: 'started' }
    listeners[0](event)
    expect(teams.canWrite('team:d1')).toBe(false)
    await teams.requests.team_delivery({ action: 'send', delivery: { id: 'team:d1' } }, OWNER)
    listeners[0](event)
    expect(made.mailboxes[0].calls).toContain('observe team:d1')
    made.mailboxes[0].writable.add('team:d1')
    expect(teams.canWrite('team:d1')).toBe(true)
    notices[0]({ type: 'zoo_changed', revision: 1 })
    expect(made.channels).toHaveLength(0)
    notices[0]({ type: 'desk_changed', revision: 2 })
    expect(made.channels[0].calls).toEqual(['refresh true'])
    // A desk that cannot be read now is read at the next poll: nothing is thrown.
    made.refreshFails = true
    notices[0]({ type: 'desk_changed', revision: 3 })
    teams.refreshChannels()
    await new Promise((settle) => setTimeout(settle, 0))
    expect(made.channels[0].calls).toEqual(['refresh true', 'refresh true', 'refresh true'])
  })

  it('starts the channels at once, and the teams and their mailbox when they keep state here', () => {
    const quiet = setup()
    quiet.teams.start()
    expect(made.channels[0].calls).toEqual(['start'])
    // The channels hold the teams; nothing of theirs is started without state here.
    expect(made.teams[0].calls).toEqual([])
    expect(made.mailboxes).toHaveLength(0)
    mkdirSync(join(dataDir, 'teams'))
    const kept = setup()
    kept.teams.start()
    expect(made.mailboxes[0].calls).toEqual(['start'])
    expect(made.teams[1].calls).toEqual(['start'])
    kept.teams.stop()
    expect(kept.stopHearing).toHaveBeenCalledOnce()
    expect(kept.stopNotices).toHaveBeenCalledOnce()
    expect(made.teams[1].calls.at(-1)).toBe('stop')
    expect(made.mailboxes[0].calls.at(-1)).toBe('stop')
    expect(made.channels[1].calls.at(-1)).toBe('stop')
    // Nothing built: nothing to stop but the hearing.
    quiet.teams.stop()
  })

  it('keeps unreadable team state for recovery and starts all the same', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      mkdirSync(join(dataDir, 'teams'))
      made.startThrows = true
      const { teams } = setup()
      teams.start()
      expect(warn).toHaveBeenCalledWith('[teams] preserved unreadable team state; inspect Team for recovery')
    } finally {
      warn.mockRestore()
    }
  })

  it('in the core\'s process, keeps its own prompt scopes, which the core records into, and starts at once', async () => {
    const ports = emptyPorts()
    const core = fakeCore({ dataDir, daemon: { command: 'harness', port: 1, machineId: () => 'm1' } })
    const requests = startTeamsInCore(core, ports, { stateDir: join(dataDir, 'teams') })
    expect(made.channels[0].calls).toEqual(['start'])
    const port = ports.teams!
    const undo = port.prepare('a1', 'hello team', 'tab-1')
    port.started('a1', 'hello team', 'hook')
    expect(await requests.team_delivery({ action: 'prompt_scope', agentId: 'a1' }, OWNER)).toEqual({ teamId: expect.stringMatching(/^[a-f0-9]{32}$/) })
    undo()
    port.raw('a1', new Uint8Array([104]))
    port.forget('a1')
    expect(port.canWrite('team:d1')).toBe(false)
    ;(port as unknown as { stop(): void }).stop()
    expect(made.channels[0].calls.at(-1)).toBe('stop')
  })
})
