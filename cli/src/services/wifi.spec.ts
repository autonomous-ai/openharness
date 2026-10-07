import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, type CoreApi, type RemoteClient, type WifiPort } from '../core/api.js'
import { AutonomousDeviceService } from '../lib/autonomous-device/service.js'
import { createDeviceStore } from '../lib/autonomous-device/storeRuntime.js'
import type { LiveEvent } from '../lib/normalize.js'
import { fakeCore } from '../testing/fakeCore.js'
import { startWifi } from './wifi.js'

let dataDir: string
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'wifi-service-')) })
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); vi.useRealTimers() })

const client: RemoteClient = { role: 'device', label: 'Desk', identity: 'device-1', direct: true }
const agent = { agentId: 'agent', name: 'Agent', engine: 'claude', state: 'idle' }
/** A request as the gateway hands it on: sealed as it came, and as its session opened it. */
const sealed = (req: Record<string, unknown>) => [{ type: 'autonomous_device_request', payload: { __e2e: true } }, { payload: req }] as const
/** What the service sent the device, in order: the core seals each to its session. */
const sent = (core: CoreApi): Array<Record<string, any>> =>
  vi.mocked(core.wifi.send).mock.calls.map(([connId, identity, frame, payload]) => ({ connId, identity, frame, ...payload }))

function started(over: Parameters<typeof fakeCore>[0] = {}) {
  const core = fakeCore({
    dataDir,
    ...over,
    wifi: { view: vi.fn(async () => ({ agents: [agent], store: [], hasWindow: true })), ...over.wifi },
  })
  const ports = emptyPorts()
  startWifi(core, ports)
  const port = ports.wifi as WifiPort
  const ask = async (req: Record<string, unknown>, connId = 'c1') => {
    const [frame, opened] = sealed({ requestId: randomUUID(), ...req })
    await port.request(connId, frame, opened)
    // Answered once the service's own wait (a stop, an answer) is over.
    await vi.waitFor(() => expect(sent(core).some((m) => m.frame === 'autonomous_device_result' && m.requestId === opened.payload.requestId)).toBe(true))
    return sent(core).find((m) => m.requestId === opened.payload.requestId)!
  }
  const hello = async (connId = 'c1') => {
    port.session(connId, client)
    return ask({ type: 'hello', proto: 1 }, connId)
  }
  return { core, port, ask, hello }
}

describe('the Wi-Fi device, with the dials', () => {
  it('answers a device\'s hello through the core, which seals it to the session it came on, and counts it as watching', async () => {
    const { core, hello } = started()
    const answer = await hello()
    expect(answer).toMatchObject({ connId: 'c1', identity: 'device-1', frame: 'autonomous_device_result', type: 'hello_result', proto: 1, machineId: 'machine-1' })
    expect(core.wifi.hello).toHaveBeenCalledWith('c1', 'device-1')
    expect(core.wifi.joined).toHaveBeenCalled()
  })

  it('lists the agents as the core lists them now, each with its last recap', async () => {
    const { core, hello, ask } = started()
    vi.mocked(core.turns.recent).mockResolvedValue([{ recap: '  Fixed   the build ' }] as never)
    await hello()
    expect((await ask({ type: 'agents.list' })).agents).toEqual([{ ...agent, machineId: 'machine-1', recap: 'Fixed the build' }])
    expect(core.wifi.view).toHaveBeenCalled()
    expect((await ask({ type: 'recap', machineId: 'machine-1', agentId: 'agent', n: 2 })).turns).toEqual([{ recap: '  Fixed   the build ' }])
    expect(core.turns.recent).toHaveBeenLastCalledWith('agent', 2)
  })

  it('types a prompt through the core, follows its transcript, and says when it no longer needs it', async () => {
    const { core, port, hello, ask } = started()
    await hello()
    const reply = await ask({ type: 'turn.send', machineId: 'machine-1', agentId: 'agent', idempotencyKey: 'k1', text: 'hello' })
    expect(reply).toMatchObject({ status: 'accepted', receipt: { state: 'queued' } })
    const deliveryId = vi.mocked(core.wifi.submit).mock.calls[0][2]
    expect(core.wifi.submit).toHaveBeenCalledWith('agent', 'hello', deliveryId)
    // The core typed it: the service reads the agent's transcript until the turn is proven.
    port.dispatched('agent', deliveryId, 'hello', 's1')
    expect(core.wifi.transcripts).not.toHaveBeenCalled()
    port.transcript('agent', 's1', 'claude', '{"type":"user","message":{"content":"not ours"},"timestamp":"2026-10-06T00:00:00Z"}')
    // An agent it never sent anything to: done with it at once, as of the one prompt the core told of.
    port.dispatched('other', 'unknown-delivery', 'hi')
    expect(core.wifi.transcripts).toHaveBeenCalledWith('other', 1)
    port.transcript('other', 's2', 'claude', '{}')
    expect(core.wifi.transcripts).toHaveBeenLastCalledWith('other', 1)
    port.agentGone('agent')
    expect(core.wifi.transcripts).toHaveBeenLastCalledWith('agent', 1)
    port.agentGone('never-told')
    expect(core.wifi.transcripts).toHaveBeenLastCalledWith('never-told', 0)
  })

  it('tells the core which agents a device subscribed to before the subscription\'s answer leaves', async () => {
    const { core, hello, ask } = started()
    await hello()
    vi.mocked(core.wifi.streams).mockClear()
    const order: string[] = []
    vi.mocked(core.wifi.streams).mockImplementation((ids) => { order.push(`streams ${ids.join(',')}`) })
    vi.mocked(core.wifi.send).mockImplementation((_c, _i, _t, payload) => { order.push(String(payload.type)) })
    await ask({ type: 'agent.subscribe', machineId: 'machine-1', agentId: 'agent' }).catch(() => {})
    expect(order.slice(0, 2)).toEqual(['streams agent', 'agent.subscribe_result'])
    // Told once: the next answer finds the same subscriptions.
    await ask({ type: 'focus.get' })
    expect(core.wifi.streams).toHaveBeenCalledTimes(1)
  })

  it('reads the turn\'s whole answer off a summary card, and passes the agents\' turns and live events on', async () => {
    const { core, port, hello } = started()
    await hello()
    vi.mocked(core.wifi.send).mockClear()
    port.card({ type: 'commander_event', agentId: 'agent', payload: { kind: 'summary', text: 'short' } }, 'the whole answer')
    expect(sent(core).at(-1)).toMatchObject({ frame: 'autonomous_device_event', kind: 'turn.summary', payload: { text: 'short', fullText: 'the whole answer' } })
    port.card({ type: 'commander_event', agentId: 'agent', payload: { kind: 'tool', text: 'Read' } })
    expect(sent(core).at(-1)).toMatchObject({ kind: 'turn.tool' })
    port.turnStarted('agent')
    expect(sent(core).at(-1)).toMatchObject({ kind: 'turn.started' })
    port.turnEnded('agent', true)
    expect(sent(core).at(-1)).toMatchObject({ kind: 'turn.error' })
    port.stream('agent', [{ type: 'turn_started', payload: {} } as unknown as LiveEvent])
    port.delivery({ deliveryId: 'nobody', sessionId: 'agent', state: 'delivered' })
    port.inputStatus({ deliveryId: 'nobody', sessionId: 'agent', mode: 'queued', phase: 'waiting' } as never)
    port.revealed('op', 'agent')
  })

  it('moves the window\'s focus in order, against the agents as they are, and tells the core the revision before anything carries it', async () => {
    const { core, port } = started()
    const order: string[] = []
    vi.mocked(core.wifi.focus).mockImplementation((revision) => { order.push(`focus ${revision}`) })
    await port.appFocus('machine-1', 'agent', 'w1')
    expect(core.wifi.view).toHaveBeenCalled()
    expect(order).toEqual([expect.stringMatching(/^focus .+:1$/)])
    await port.appFocus('machine-1', null, 'w1')
    expect(order.at(-1)).toMatch(/:2$/)
  })

  it('lets a focus move that fails cost that move alone, and the next one is applied', async () => {
    const { core, port } = started()
    vi.mocked(core.wifi.focus).mockImplementationOnce(() => { throw new Error('the core went away') })
    await expect(port.appFocus('machine-1', 'agent', 'w1')).rejects.toThrow('the core went away')
    await port.appFocus('machine-1', null, 'w1')
    expect(core.wifi.focus).toHaveBeenLastCalledWith(expect.stringMatching(/:2$/))
    // A move the core held for a restarted service fails the same way, and the service resumes.
    vi.mocked(core.wifi.focus).mockImplementation((revision) => { if (revision.endsWith(':3')) throw new Error('not now') })
    await port.resume({ sessions: [], helloed: [], focus: { machineId: 'machine-1', agentId: 'agent', connId: 'w2' } })
    expect(core.wifi.ready).toHaveBeenCalled()
  })

  it('says a device\'s request that fails, and answers the next', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { core, port, hello } = started()
    port.session('c1', client)
    vi.mocked(core.wifi.send).mockImplementationOnce(() => { throw new Error('sealing failed') })
    const [frame, opened] = sealed({ type: 'hello', proto: 1, requestId: randomUUID() })
    await port.request('c1', frame, opened)
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[wifi] a device\'s request failed · sealing failed'))
    vi.mocked(core.wifi.send).mockImplementationOnce(() => { throw 'no session' })
    const [again, openedAgain] = sealed({ type: 'hello', proto: 1, requestId: randomUUID() })
    await port.request('c1', again, openedAgain)
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[wifi] a device\'s request failed · no session'))
    expect(await hello()).toMatchObject({ type: 'hello_result' })
    warn.mockRestore()
  })

  it('serves the sessions a previous run served, told to resync, and lets go of those the core no longer holds', async () => {
    const { core, port, hello } = started()
    await hello('stale')
    vi.mocked(core.wifi.send).mockClear()
    vi.mocked(core.wifi.hello).mockClear()
    await port.resume({ sessions: [{ connId: 'c9', client }], helloed: [{ connId: 'c9', identity: 'device-1' }], focus: { machineId: 'machine-1', agentId: 'agent', connId: 'w' } })
    // The stale session is let go of; the one the core holds is served on, and told to resync.
    expect(core.wifi.hello).toHaveBeenCalledWith('stale', null)
    expect(core.wifi.hello).toHaveBeenCalledWith('c9', 'device-1')
    expect(sent(core)).toContainEqual(expect.objectContaining({ connId: 'c9', frame: 'autonomous_device_event', type: 'resync', reason: 'instance_changed' }))
    expect(core.wifi.joined).toHaveBeenCalled()
    expect(core.wifi.ready).toHaveBeenCalled()
    expect(core.wifi.watching).toHaveBeenCalledWith([])
    expect(core.wifi.streams).toHaveBeenCalledWith([])
    expect(core.wifi.focus).toHaveBeenCalled()
    // A session this run already serves is served on as it is: not dropped, not told to resync again.
    vi.mocked(core.wifi.send).mockClear()
    vi.mocked(core.wifi.hello).mockClear()
    await port.resume({ sessions: [{ connId: 'c9', client }], helloed: [{ connId: 'c9', identity: 'device-1' }], focus: null })
    expect(core.wifi.hello).not.toHaveBeenCalled()
    expect(sent(core).filter((m) => m.type === 'resync')).toEqual([])
    // Nothing held, nothing restored, nobody to join.
    vi.mocked(core.wifi.joined).mockClear()
    await port.resume({ sessions: [], helloed: [], focus: null })
    expect(core.wifi.joined).not.toHaveBeenCalled()
  })

  it('forgets a closed connection and an unpaired device, and answers a receipt', async () => {
    const { core, port, hello, ask } = started()
    await hello()
    await ask({ type: 'turn.send', machineId: 'machine-1', agentId: 'agent', idempotencyKey: 'k2', text: 'hi' })
    expect(await port.receipt('device-1', 'k2')).toMatchObject({ receipt: { idempotencyKey: 'k2', state: 'queued' } })
    expect(await port.receipt('device-1', 'nope')).toEqual({ receipt: null })
    port.revoked('device-1')
    expect(core.wifi.cancel).toHaveBeenCalled()
    expect(await port.receipt('device-1', 'k2')).toEqual({ receipt: null })
    await hello('c2')
    port.dropped('c2')
    expect(core.wifi.hello).toHaveBeenLastCalledWith('c2', null)
    // A session the gateway no longer holds is sent nothing.
    port.session('c3', client)
    port.session('c3', null)
    vi.mocked(core.wifi.send).mockClear()
    const [frame, opened] = sealed({ type: 'hello', proto: 1, requestId: randomUUID() })
    await port.request('c3', frame, opened)
    expect(core.wifi.send).not.toHaveBeenCalled()
    await port.stop()
  })

  it('answers a request with the agents it last had when the core cannot be asked', async () => {
    const view = vi.fn(async () => ({ agents: [agent], store: [], hasWindow: true }))
    const { hello, ask } = started({ wifi: { view } })
    await hello()
    view.mockRejectedValueOnce(new Error('the core went away'))
    expect((await ask({ type: 'agents.list' })).agents).toEqual([{ ...agent, machineId: 'machine-1' }])
  })

  it('reaches the core for a stop, an answer, a step along the desk, a stroke and the window\'s focus', async () => {
    const { core, hello, ask } = started()
    await hello()
    expect(await ask({ type: 'turn.stop', machineId: 'machine-1', agentId: 'agent', idempotencyKey: 's1' })).toMatchObject({ receipt: { state: 'completed' } })
    expect(core.wifi.stop).toHaveBeenCalledWith('agent')
    // No window took the ask: said at once.
    vi.mocked(core.wifi.focusApp).mockReturnValueOnce(false)
    expect(await ask({ type: 'focus.ensure' })).toMatchObject({ error: { code: 'FOCUS_UNAVAILABLE' } })
    expect(core.wifi.focusApp).toHaveBeenCalledWith('agent', expect.any(Number), expect.any(String))
    expect(await ask({ type: 'scroll', phase: 'down', dy: 1, velocity: 2 })).not.toHaveProperty('error')
    expect(core.wifi.scroll).toHaveBeenCalledWith('down', 1, 2)
    const focus = (await ask({ type: 'focus.get' })).focusRevision
    expect(await ask({ type: 'focus.step', direction: 'next', idempotencyKey: 'f1', focusRevision: focus })).toMatchObject({ error: { code: 'NO_AGENTS' } })
    expect(core.wifi.stepFocus).toHaveBeenCalledWith('next', undefined)
  })

  it('gives the Store the agents the core listed, and makes and shows its agents through the core', async () => {
    const core = fakeCore({ dataDir, wifi: { view: vi.fn(async () => ({ agents: [], store: [{ agentId: 'a' } as never], hasWindow: true })) } })
    let given: Parameters<typeof createDeviceStore>[0] | undefined
    const ports = emptyPorts()
    startWifi(core, ports, { store: (options) => { given = options; return createDeviceStore(options) } })
    expect(given!.agents()).toEqual([])
    await ports.wifi!.appFocus('machine-1', null, 'w')
    expect(given!.agents()).toEqual([{ agentId: 'a' }])
    await given!.create('autonomous/robot', 'claude', '/w')
    expect(core.wifi.create).toHaveBeenCalledWith('autonomous/robot', 'claude', '/w')
    given!.reveal!('op', 'a')
    expect(core.wifi.reveal).toHaveBeenCalledWith('op', 'a')
  })

  it('hands the core the device\'s answers to questions and the prompts its transcript proved started', async () => {
    const core = fakeCore({ dataDir })
    let given: ConstructorParameters<typeof AutonomousDeviceService>[0] | undefined
    startWifi(core, emptyPorts(), { service: (options) => { given = options; return new AutonomousDeviceService(options) } })
    given!.inputConsumed!('agent', 'hello')
    expect(core.wifi.started).toHaveBeenCalledWith('agent', 'hello')
    expect(await given!.answer('agent', 'r', { q: 'yes' })).toBe(true)
    expect(core.wifi.answer).toHaveBeenCalledWith('agent', 'r', { q: 'yes' })
  })

  it('gives up a pairing the device asked to give up, over its own session', async () => {
    const { core, hello, ask } = started()
    await hello()
    expect(await ask({ type: 'pair.revoke' })).toMatchObject({ revoked: true })
    expect(core.wifi.unpaired).toHaveBeenCalledWith('device-1')
  })

  it('leaves the Wi-Fi device off, and the devices on, when its journal cannot be read', () => {
    writeFileSync(join(dataDir, 'device-results.json'), '{"version": 1, "entries": [', { mode: 0o600 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ports = emptyPorts()
    expect(() => startWifi(fakeCore({ dataDir }), ports)).toThrow('the Wi-Fi device service could not be started')
    expect(ports.wifi).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the Wi-Fi device service could not be started'))
    warn.mockRestore()
  })

  it('says a focus change that carries no revision to nobody', () => {
    const emits: Array<(frame: Record<string, unknown>) => void> = []
    const core = fakeCore({ dataDir })
    const ports = emptyPorts()
    startWifi(core, ports, {
      service: (options) => {
        emits.push((frame) => options.emit?.(frame as never))
        return { focusSnapshot: () => ({ focus: null, focusRevision: 'x:0' }) } as unknown as AutonomousDeviceService
      },
    })
    emits[0]({ type: 'event', kind: 'focus.changed', payload: {} })
    emits[0]({ type: 'event', kind: 'focus.changed' })
    expect(core.wifi.focus).not.toHaveBeenCalled()
  })
})
