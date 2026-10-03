import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelDirectory } from './channels.js'
import { channelTeamId, TeamService } from './service.js'
import { Team, type Actor, type Address, type Receipt } from './model.js'
import { TeamMailbox } from './mailbox.js'
import { teamDeliveryRequest, teamRequest } from './wire.js'
import { parseChannelArgs } from './channelCommand.js'
import { SwarmPromptScopes } from './promptScope.js'

const owner: Actor = { kind: 'owner' }
const mobile = { machineId: 'host', agentId: 'mobile' }
const firmware = { machineId: 'remote', agentId: 'firmware' }
const backend = { machineId: 'host', agentId: 'backend' }
const questionId = 'a'.repeat(32), consultationId = 'b'.repeat(32)
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function fixture(initiallyEnabled = true, taskScope?: (address: Address) => Promise<string | null>) {
  const root = mkdtempSync(join(tmpdir(), 'harness-channels-'))
  const sent: { agentId: string; id: string; text: string }[] = []
  let desk = { revision: 1, tabs: [
    { id: 'devices', name: 'Device', channelHost: 'host', panes: [mobile, firmware] },
    { id: 'api', name: 'Backend', channelHost: 'host', panes: [backend] },
  ] }
  const boxes = new Map<string, TeamMailbox>()
  let enabled = initiallyEnabled, settingsRevision = 1, deliveriesEnabled = false
  const runtime = (a: Address) => ({ name: a.agentId, engine: a.agentId === 'shell' ? 'terminal' : 'codex', available: true, cwd: `/work/${a.agentId}` })
  const service = new TeamService({
    stateDir: join(root, 'ledgers'), machineId: 'host', command: () => 'harness team',
    taskScope,
    runtime: async a => runtime(a),
    delivery: async (a, action, delivery) => {
      let box = boxes.get(a.machineId)
      if (!box) {
        box = new TeamMailbox({ stateDir: join(root, a.machineId), runtime: agentId => runtime({ ...a, agentId }),
          channelsEnabled: () => deliveriesEnabled,
          send: (agentId, text, id) => { sent.push({ agentId, text, id }); box!.observe({ sessionId: agentId, deliveryId: id, state: 'started' }) }, cancel: () => false })
        boxes.set(a.machineId, box)
      }
      const result = teamDeliveryRequest(box, { action, delivery })
      if (result.error) throw new Error(String(result.detail))
      return result.receipt as Receipt | null
    },
  })
  const readDesk = vi.fn(async () => ({ ...structuredClone(desk), enabled, settingsRevision }))
  const writeSettings = vi.fn(async (value: boolean) => { enabled = value; return { enabled, revision: ++settingsRevision } })
  const forward = vi.fn(async (_host: string, _payload: Record<string, unknown>) => ({ forwarded: true }))
  const directory = new ChannelDirectory({ machineId: 'host', service, readDesk, forward, writeSettings,
    enabledChanged: value => { deliveriesEnabled = value } })
  const read = (tabId = 'devices') => Team.parse(JSON.parse(readFileSync(join(root, 'ledgers', `${channelTeamId(tabId)}.json`), 'utf8')))
  const member = (agentId: string, tabId = 'devices') => read(tabId).members.findLast(m => m.agentId === agentId)!
  const actor = (agentId: string, tabId = 'devices'): Actor => ({ kind: 'member', key: member(agentId, tabId).key })
  const tick = async () => { await service.pump(); for (const box of boxes.values()) box.pump(); await service.pump() }
  cleanups.push(() => { directory.stop(); service.stop(); for (const box of boxes.values()) box.stop(); rmSync(root, { recursive: true, force: true }) })
  return { service, directory, read, actor, member, tick, sent, readDesk, forward, writeSettings,
    ledger: (id: string) => Team.parse(JSON.parse(readFileSync(join(root, 'ledgers', `${id}.json`), 'utf8'))),
    setDesk: (next: typeof desk) => { desk = next }, get desk() { return desk } }
}

describe('tab channels', () => {
  it('isolates accepted prompts in two swarms containing the exact same session', async () => {
    const scopes = new SwarmPromptScopes()
    const f = fixture(true, async address => scopes.current(address.agentId))
    f.setDesk({ revision: 2, tabs: [f.desk.tabs[0], { ...f.desk.tabs[1], panes: [mobile, backend] }] })
    await f.directory.refresh()
    const request = (tabId: string, action: string, extra = {}) => teamRequest(f.service, {
      action, teamId: channelTeamId(tabId), memberKey: f.member('mobile', tabId).key, ...extra,
    })
    scopes.raw('mobile', Buffer.from('frontend task\r'), 'devices')
    scopes.started('mobile', 'frontend task', 'hook')
    expect(await request('devices', 'members')).toHaveProperty('members')
    expect(await request('api', 'members')).toMatchObject({ error: 'CHANNEL_SCOPE' })
    expect(await request('api', 'ask', { id: questionId, to: f.member('backend', 'api').name, text: 'wrong scope' }))
      .toMatchObject({ error: 'CHANNEL_SCOPE' })
    expect(f.read('api').exchanges).toHaveLength(0)
    expect(await f.directory.taskContext('mobile', scopes.current('mobile')))
      .toMatchObject({ tabId: 'devices', command: expect.stringContaining(`--team ${channelTeamId('devices')}`) })

    // Merely queuing another task from B leaves A's consultation scope intact.
    scopes.prepare('mobile', 'backend task', 'api')
    expect(await request('devices', 'ask', { id: questionId, to: f.member('firmware').name, text: 'right scope' }))
      .toHaveProperty('exchange')
    scopes.started('mobile', 'backend task', 'hook')
    expect(await request('devices', 'members')).toMatchObject({ error: 'CHANNEL_SCOPE' })
    expect(await request('api', 'members')).toHaveProperty('members')
    scopes.started('mobile', 'frontend task')
    expect(await request('devices', 'members')).toMatchObject({ error: 'CHANNEL_SCOPE' })

    scopes.started('mobile', 'unattributed external prompt', 'hook')
    expect(await request('api', 'ask', { id: questionId, to: f.member('backend', 'api').name, text: 'unknown scope' }))
      .toMatchObject({ error: 'CHANNEL_SCOPE' })
    await expect(f.directory.taskContext('mobile', scopes.current('mobile'))).rejects.toThrow('no verified swarm origin')
    // Inspecting the owner's log is still read-only and independent of an agent task.
    expect(await teamRequest(f.service, { action: 'get', teamId: channelTeamId('api') })).toHaveProperty('team')
  })
  it('missing opt-in metadata and a failed directory read keep automated input off', async () => {
    const f = fixture()
    f.readDesk.mockResolvedValueOnce({ ...f.desk } as Awaited<ReturnType<typeof f.readDesk>>)
    await f.directory.refresh()
    await f.tick()
    expect(f.service.list(owner).teams).toEqual([])
    await f.directory.refresh(true)
    f.readDesk.mockRejectedValueOnce(new Error('offline'))
    await expect(f.directory.refresh(true)).rejects.toThrow('offline')
    await f.tick()
    expect(f.sent).toEqual([])
    await f.directory.refresh(true)
    await f.tick()
    expect(f.sent).toHaveLength(2)
    await expect(f.directory.request({ action: 'channel_configure', enabled: false, memberKey: f.member('mobile').key })).rejects.toThrow('own channel')
    expect(f.writeSettings).not.toHaveBeenCalled()
  })
  it('a read already in flight cannot reactivate delivery while OFF is being saved', async () => {
    const f = fixture()
    await f.directory.refresh()
    let finishRead!: (value: Awaited<ReturnType<typeof f.readDesk>>) => void
    let finishWrite!: () => void
    f.readDesk.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
    const originalWrite = f.writeSettings.getMockImplementation()!
    f.writeSettings.mockImplementationOnce(async value => {
      await new Promise<void>(resolve => { finishWrite = resolve })
      return originalWrite(value)
    })
    const reading = f.directory.refresh(true)
    const disabling = f.directory.request({ action: 'channel_configure', enabled: false })
    await expect(f.directory.request({ action: 'channel_configure', enabled: true })).rejects.toMatchObject({ code: 'CHANNEL_SETTINGS_BUSY' })
    finishRead({ ...f.desk, enabled: true, settingsRevision: 1 })
    await reading
    await f.tick()
    expect(f.sent).toEqual([])
    finishWrite()
    expect(await disabling).toMatchObject({ enabled: false })
  })
  it('stays dormant by default, starts automatically after opt-in, and holds pending work when off', async () => {
    const f = fixture(false)
    expect(await f.directory.request({ action: 'channel_settings' })).toMatchObject({ enabled: false })
    await f.tick()
    expect(f.service.list(owner).teams).toEqual([])
    expect(f.sent).toEqual([])
    expect(f.writeSettings).not.toHaveBeenCalled()
    await expect(f.directory.request({ action: 'channel_consult', tabId: 'devices', id: consultationId, from: mobile })).rejects.toThrow('Experimental')
    await f.directory.request({ action: 'channel_configure', enabled: true })
    await f.tick()
    expect(f.sent.map(s => s.agentId).sort()).toEqual(['firmware', 'mobile'])
    expect(f.sent.every(s => !s.text.includes('Explicit instruction from the user'))).toBe(true)
    f.sent.length = 0
    f.service.ask(channelTeamId('devices'), { id: questionId, from: f.member('mobile').id, to: f.member('firmware').id, text: 'Help?' }, f.actor('mobile'))
    await f.service.pump()
    await f.directory.request({ action: 'channel_configure', enabled: false })
    await f.tick()
    expect(f.sent).toEqual([])
    expect(f.read().exchanges).toHaveLength(1)
    expect(() => f.service.ask(channelTeamId('devices'), { id: 'd'.repeat(32), from: f.member('mobile').id, to: f.member('firmware').id, text: 'More?' }, f.actor('mobile'))).toThrow('Experimental')
    await f.directory.request({ action: 'channel_configure', enabled: true })
    await f.tick()
    expect(f.sent.filter(s => s.id.endsWith(':question'))).toHaveLength(1)
  })
  it('refuses cross-swarm requests without creating an exchange or instruction', async () => {
    const f = fixture()
    await f.directory.refresh()
    await f.tick()
    f.sent.length = 0
    for (const action of ['channel_cross_consult', 'channel_cross_ask']) {
      await expect(f.directory.request({ action, tabId: 'devices', targetTabId: 'api',
        from: mobile, to: f.member('backend', 'api').id, text: 'API?', id: questionId,
        crossChannel: true })).rejects.toThrow()
    }
    await f.tick()
    expect(f.sent).toHaveLength(0)
    expect(f.read().exchanges).toHaveLength(0)
    expect(f.read().consultations).toHaveLength(0)
    expect(f.read('api').members).toHaveLength(1)
  })
  it('automatically discovers peers and shared history only in its saved tab', async () => {
    const f = fixture()
    await f.directory.refresh()
    await f.tick()
    expect(f.sent.map(s => s.agentId).sort()).toEqual(['firmware', 'mobile'])
    expect(f.sent[0].text).toContain('membership notice')
    expect(f.sent[0].text).toContain('context --agent')
    expect(f.sent[0].text).toContain('history')
    const teamId = channelTeamId('devices')
    const discovery = await teamRequest(f.service, { action: 'members', teamId, memberKey: f.member('mobile').key })
    expect((discovery.members as { agentId: string }[]).map(m => m.agentId)).toEqual(['mobile', 'firmware'])
    expect(JSON.stringify(discovery)).not.toContain('"key"')
    expect(() => f.service.ask(teamId, { id: questionId, from: f.member('mobile').id, to: f.member('backend', 'api').id, text: 'API?' }, f.actor('mobile'))).toThrow('No teammate')
    const ask = f.service.ask(teamId, { id: questionId, from: f.member('mobile').id, to: f.member('firmware').name, text: 'Which protocol?' }, f.actor('mobile'))
    await f.tick()
    f.service.reply(teamId, ask.id, 'Pairing v2; worktree /work/firmware, branch main.', ['protocol.ts:12'], f.actor('firmware'))
    await f.tick()
    const shared = await f.service.snapshot(teamId, f.actor('mobile'))
    expect((shared.exchanges as unknown[])).toHaveLength(1)
    expect(f.sent.at(-1)?.agentId).toBe('mobile')
    expect(f.sent.filter(s => s.agentId === 'backend')).toHaveLength(0)
  })

  it('consult is direct, deduplicated, and pinned to the explicit source tab', async () => {
    const f = fixture()
    await f.directory.refresh()
    const payload = { action: 'channel_consult', tabId: 'devices', id: consultationId, from: mobile }
    const first = await f.directory.request(payload)
    expect(await f.directory.request(payload)).toEqual(first)
    await f.tick()
    const instructions = f.sent.filter(s => s.id.endsWith(':consult'))
    expect(instructions).toHaveLength(1)
    expect(instructions[0].agentId).toBe('mobile')
    expect(instructions[0].text).toContain('Explicit instruction from the user')
    expect(f.sent.filter(s => s.agentId === 'mobile' && s.id.endsWith(':intro'))).toHaveLength(0)
    expect(f.read().exchanges).toHaveLength(0)
    await expect(f.directory.request({ ...payload, tabId: 'api' })).rejects.toThrow('no longer in this swarm')
    await expect(f.directory.request({ ...payload, tabId: 'api', from: backend })).rejects.toThrow('Add another harness')
    await expect(f.directory.request({ ...payload, id: 'c'.repeat(32), memberKey: f.member('mobile').key })).rejects.toThrow('own channel')
  })

  it('leaving revokes new discovery and asks while a pending reply can finish', async () => {
    const f = fixture()
    await f.directory.refresh()
    const teamId = channelTeamId('devices'), source = f.member('mobile'), actor = f.actor('mobile')
    f.service.ask(teamId, { id: questionId, from: source.id, to: f.member('firmware').id, text: 'Protocol?' }, actor)
    f.setDesk({ revision: 2, tabs: [{ ...f.desk.tabs[0], panes: [firmware] }, { ...f.desk.tabs[1], panes: [backend, mobile] }] })
    await f.directory.refresh(true)
    await expect(f.service.snapshot(teamId, actor)).rejects.toThrow('removed')
    expect(() => f.service.ask(teamId, { id: 'c'.repeat(32), from: source.id, to: f.member('firmware').id, text: 'Another?' }, actor)).toThrow('removed')
    f.service.reply(teamId, questionId, 'v2', [], f.actor('firmware'))
    expect(await f.service.readStatus(teamId, questionId, actor)).toMatchObject({ state: 'answered' })
    await f.tick()
    expect(f.sent.filter(s => s.agentId === 'mobile' && s.id.endsWith(':answer'))).toHaveLength(0) // retrieved answers suppress their notice
    await f.service.syncChannel({ tabId: 'devices', name: 'Old', revision: 1, members: [mobile, firmware] })
    expect(f.read().members.find(m => m.id === source.id)?.enabled).toBe(false)
    expect(f.read('api').members.some(m => m.agentId === 'mobile' && m.enabled)).toBe(true)
  })

  it('closed tabs stop new collaboration; rejoining has fresh membership and history survives', async () => {
    const f = fixture()
    await f.directory.refresh()
    const oldKey = f.member('mobile').key
    const initial = structuredClone(f.desk)
    f.setDesk({ revision: 2, tabs: [] })
    await f.directory.refresh(true)
    expect(f.read().channel?.closed).toBe(true)
    await expect(f.directory.request({ action: 'channel_get', tabId: 'devices' })).rejects.toThrow('no longer')
    f.setDesk({ ...initial, revision: 3 })
    await f.directory.refresh(true)
    expect(f.member('mobile').key).not.toBe(oldKey)
    expect(f.read().members).toHaveLength(4)
    expect(() => f.service.updateMember(channelTeamId('devices'), { id: f.member('mobile').id, name: 'mobile', enabled: true }, owner)).toThrow('swarm')
  })

  it('routes to the sticky host, preserves state on desk failure, and fails honestly on older backends', async () => {
    const f = fixture()
    await f.directory.refresh()
    f.setDesk({ revision: 2, tabs: [{ ...f.desk.tabs[0], id: 'remote-tab', channelHost: 'remote' }] })
    await f.directory.refresh(true)
    expect(await f.directory.request({ action: 'channel_get', tabId: 'remote-tab' })).toEqual({ forwarded: true })
    expect(f.forward).toHaveBeenCalledWith('remote', expect.objectContaining({ channelForwarded: true }))
    f.readDesk.mockRejectedValueOnce(new Error('offline'))
    await expect(f.directory.refresh(true)).rejects.toThrow('offline')
    expect(f.read().exchanges).toEqual([])
    f.setDesk({ revision: 3, tabs: [{ id: 'old', name: 'Old', panes: [mobile], channelHost: undefined as unknown as string }] })
    await f.directory.refresh(true)
    await expect(f.directory.request({ action: 'channel_get', tabId: 'old' })).rejects.toThrow('Update')
    f.setDesk({ revision: 4, tabs: [{ id: 'empty', name: 'Empty', panes: [], channelHost: undefined as unknown as string }] })
    await f.directory.refresh(true)
    await expect(f.directory.request({ action: 'channel_get', tabId: 'empty' })).rejects.toMatchObject({ code: 'CHANNEL_EMPTY' })
  })

  it('does not turn plain terminals into members and keeps member keys channel-bound', async () => {
    const f = fixture()
    f.setDesk({ revision: 2, tabs: [{ ...f.desk.tabs[0], panes: [mobile, { machineId: 'host', agentId: 'shell' }] }, f.desk.tabs[1]] })
    await f.directory.refresh()
    expect(f.read().members).toHaveLength(1)
    await f.tick()
    expect(f.sent).toEqual([])
    await expect(f.service.snapshot(channelTeamId('api'), f.actor('mobile'))).rejects.toThrow('membership')
  })
})

it('channel CLI requires an explicit tab and source; does not accept member keys for global discovery', () => {
  const defaults = { port: 18473, machineId: 'host' }
  const args = parseChannelArgs(['--tab', 'devices', 'consult', '--from-machine', 'host', '--from-agent', 'mobile', '--id', consultationId], defaults)
  expect(args.payload).toEqual({ action: 'channel_consult', tabId: 'devices', from: mobile, id: consultationId })
  expect(() => parseChannelArgs(['consult'], defaults)).toThrow('tab')
  expect(() => parseChannelArgs(['--member-key', 'secret', 'list'], defaults)).toThrow('Harness channel')
})
