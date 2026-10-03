import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AgentStreams, STREAM_MAX_PER_DEVICE } from './stream.js'
import { AutonomousDeviceRelay } from './relay.js'
import { AutonomousDeviceService, type AutonomousDeviceFrame } from './service.js'
import type { LiveEvent } from '../normalize.js'

const ALL = new Set(['tool', 'text', 'final'] as const)
const text = (content: string): LiveEvent => ({ type: 'text_delta', payload: { content } })
const toolStart: LiveEvent = { type: 'tool_start', payload: { id: 't1', tool: 'Bash', input: { command: 'ls -la' } } }
const toolEnd: LiveEvent = { type: 'tool_end', payload: { id: 't1', tool: 'Bash', output: 'secret listing', isError: false, summary: '', durationSeconds: 2 } }

function hub() {
  const sent: Array<{ deviceId: string; frame: AutonomousDeviceFrame }> = []
  const streams = new AgentStreams({ machineId: 'machine', serverInstanceId: 'instance', send: (deviceId, frame) => sent.push({ deviceId, frame }) })
  const kinds = () => sent.map(s => s.frame.kind)
  return { streams, sent, kinds }
}

describe('AgentStreams', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('sends nothing for an agent nobody subscribed to', () => {
    const h = hub()
    h.streams.ingest('agent', [{ type: 'turn_started', payload: { userMessage: 'hi' } }, toolStart, text('a'), toolEnd, { type: 'turn_ended', payload: {} }])
    vi.advanceTimersByTime(1000)
    expect(h.sent).toEqual([])
  })

  it('streams tool calls without their output, coalesced text, then the whole final answer', () => {
    const h = hub()
    h.streams.ingest('agent', [{ type: 'turn_started', payload: { userMessage: 'hi' } }, text('Before subscribing. ')])
    const { subscriptionId } = h.streams.subscribe('dev', 'agent', 60, ALL)
    h.streams.ingest('agent', [toolStart, text('Hel'), text('lo')])
    expect(h.kinds()).toEqual(['stream.tool'])
    vi.advanceTimersByTime(250)
    h.streams.ingest('agent', [toolEnd, { type: 'turn_ended', payload: {} }])
    expect(h.sent.map(s => [s.frame.kind, s.frame.payload])).toEqual([
      ['stream.tool', { phase: 'start', toolUseId: 't1', tool: 'Bash', input: '{"command":"ls -la"}' }],
      ['stream.text', { text: 'Hello' }],
      ['stream.tool', { phase: 'end', toolUseId: 't1', tool: 'Bash', isError: false, durationSeconds: 2 }],
      // A mid-turn subscriber still gets the complete answer, including text written before it joined.
      ['stream.final', { text: 'Before subscribing. Hello' }],
    ])
    expect(JSON.stringify(h.sent)).not.toContain('secret listing')
    expect(h.sent.every(s => s.deviceId === 'dev' && s.frame.subscriptionId === subscriptionId)).toBe(true)
    expect(h.sent.map(s => s.frame.seq)).toEqual([1, 2, 3, 4])
  })

  it('flushes pending text before a tool card so the order on the device matches the turn', () => {
    const h = hub()
    h.streams.subscribe('dev', 'agent', 60, ALL)
    h.streams.ingest('agent', [text('Let me look.'), toolStart])
    expect(h.kinds()).toEqual(['stream.text', 'stream.tool'])
  })

  it('honours include', () => {
    const h = hub()
    h.streams.subscribe('dev', 'agent', 60, new Set(['final'] as const))
    h.streams.ingest('agent', [{ type: 'turn_started', payload: { userMessage: '' } }, toolStart, text('x'), { type: 'turn_ended', payload: { aborted: true } }])
    vi.advanceTimersByTime(1000)
    expect(h.sent.map(s => [s.frame.kind, s.frame.payload])).toEqual([['stream.final', { aborted: true }]])
  })

  it('expires on the daemon clock: pending text is delivered, then stream.end, then silence', () => {
    const h = hub()
    h.streams.subscribe('dev', 'agent', 5, ALL)
    vi.advanceTimersByTime(4900)
    h.streams.ingest('agent', [text('last words')])
    vi.advanceTimersByTime(100)
    expect(h.sent.map(s => [s.frame.kind, s.frame.payload])).toEqual([['stream.text', { text: 'last words' }], ['stream.end', { reason: 'expired' }]])
    h.streams.ingest('agent', [toolStart, text('late'), { type: 'turn_ended', payload: {} }])
    vi.advanceTimersByTime(1000)
    expect(h.sent).toHaveLength(2)
    expect(h.streams.count()).toBe(0)
  })

  it('replaces a subscription to the same agent and caps distinct agents per device', () => {
    const h = hub()
    const first = h.streams.subscribe('dev', 'a1', 60, ALL)
    const second = h.streams.subscribe('dev', 'a1', 60, ALL)
    expect(h.sent.map(s => [s.frame.subscriptionId, s.frame.kind, s.frame.payload])).toEqual([[first.subscriptionId, 'stream.end', { reason: 'replaced' }]])
    expect(second.subscriptionId).not.toBe(first.subscriptionId)
    for (let i = 1; i < STREAM_MAX_PER_DEVICE; i++) h.streams.subscribe('dev', `other-${i}`, 60, ALL)
    expect(() => h.streams.subscribe('dev', 'one-too-many', 60, ALL)).toThrow(expect.objectContaining({ code: 'SUBSCRIPTION_LIMIT' }))
    // The cap is per device.
    expect(() => h.streams.subscribe('dev2', 'one-too-many', 60, ALL)).not.toThrow()
  })

  it('only the owner can unsubscribe; dropping a device ends silently', () => {
    const h = hub()
    const { subscriptionId } = h.streams.subscribe('dev', 'agent', 60, ALL)
    expect(h.streams.unsubscribe('intruder', subscriptionId)).toBe(false)
    expect(h.streams.unsubscribe('dev', subscriptionId)).toBe(true)
    expect(h.streams.unsubscribe('dev', subscriptionId)).toBe(false)
    expect(h.kinds()).toEqual(['stream.end'])
    h.streams.subscribe('dev', 'agent', 60, ALL)
    h.streams.ingest('agent', [text('queued')])
    h.streams.dropDevice('dev')
    vi.advanceTimersByTime(1000)
    expect(h.kinds()).toEqual(['stream.end'])
  })

  it('bounds the final answer and tool input sizes', () => {
    const h = hub()
    h.streams.subscribe('dev', 'agent', 60, new Set(['tool', 'final'] as const))
    h.streams.ingest('agent', [{ type: 'tool_start', payload: { id: 't', tool: 'Write', input: { content: 'é'.repeat(5000) } } },
      { type: 'turn_started', payload: { userMessage: '' } }, text('é'.repeat(20000)), { type: 'turn_ended', payload: {} }])
    const [tool, final] = h.sent.map(s => s.frame.payload as Record<string, unknown>)
    expect(Buffer.byteLength(tool.input as string)).toBeLessThanOrEqual(1024)
    expect(Buffer.byteLength(final.text as string)).toBeLessThanOrEqual(16384)
    expect(final.text as string).not.toContain('�')
    expect(final.truncated).toBe(true)
  })
})

describe('agent.subscribe over the device RPC', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function fixture() {
    const identities: Record<string, string> = { a: 'device-a', b: 'device-b' }
    const send = vi.fn()
    const crypto = { sessionRole: () => 'device' as const, sessionIdentity: (c: string) => identities[c] ?? null,
      unwrapDown: (_c: string, frame: Record<string, unknown>) => ({ ...frame, payload: (frame.payload as { __e2e: unknown }).__e2e }),
      wrapTarget: (_c: string, type: string, payload: Record<string, unknown>) => ({ type, payload: { __e2e: payload } }) }
    let relay: AutonomousDeviceRelay | undefined
    const service = new AutonomousDeviceService({ machineId: 'machine', agents: () => [{ agentId: 'agent', name: 'Agent', engine: 'codex', state: 'idle' }],
      submit: vi.fn(), cancelDelivery: () => true, stop: async () => true, answer: async () => true, recent: () => [],
      emit: (frame, deviceId) => relay?.emit(frame, deviceId) })
    relay = new AutonomousDeviceRelay(crypto, send, service, 'machine')
    const request = async (conn: string, payload: Record<string, unknown>) => {
      const requestId = randomUUID()
      await relay!.handle(conn, { type: 'autonomous_device_request', payload: { __e2e: { requestId, ...payload } } })
      return send.mock.calls.map(([, f]) => (f as { payload: { __e2e: Record<string, unknown> } }).payload.__e2e).find(r => r.requestId === requestId)!
    }
    const streamFrames = (conn: string) => send.mock.calls.filter(([c, f]) => c === conn && typeof (f as { payload: { __e2e: { kind?: string } } }).payload.__e2e.kind === 'string'
      && (f as { payload: { __e2e: { kind: string } } }).payload.__e2e.kind.startsWith('stream.')).map(([, f]) => (f as { payload: { __e2e: AutonomousDeviceFrame } }).payload.__e2e)
    return { relay, service, request, streamFrames, send }
  }
  const target = { machineId: 'machine', agentId: 'agent' }

  it('advertises the capability and validates the request strictly', async () => {
    const f = fixture()
    const hello = await f.request('a', { type: 'hello', proto: 1 })
    expect(hello.capabilities).toEqual(expect.arrayContaining(['agent.subscribe', 'agent.unsubscribe']))
    expect((await f.request('a', { type: 'agent.subscribe', ...target, ttlSec: 301 })).error).toMatchObject({ code: 'INVALID_REQUEST' })
    expect((await f.request('a', { type: 'agent.subscribe', ...target, ttlSec: 1.5 })).error).toMatchObject({ code: 'INVALID_REQUEST' })
    expect((await f.request('a', { type: 'agent.subscribe', ...target, include: ['text', 'text'] })).error).toMatchObject({ code: 'INVALID_REQUEST' })
    expect((await f.request('a', { type: 'agent.subscribe', ...target, include: ['thinking'] })).error).toMatchObject({ code: 'INVALID_REQUEST' })
    expect((await f.request('a', { type: 'agent.subscribe', ...target, extra: 1 })).error).toMatchObject({ code: 'INVALID_REQUEST' })
    expect((await f.request('a', { type: 'agent.subscribe', machineId: 'elsewhere', agentId: 'agent' })).error).toMatchObject({ code: 'MACHINE_MISMATCH' })
    expect((await f.request('a', { type: 'agent.subscribe', machineId: 'machine', agentId: 'ghost' })).error).toMatchObject({ code: 'AGENT_NOT_FOUND' })
    const ok = await f.request('a', { type: 'agent.subscribe', ...target })
    expect(ok).toMatchObject({ type: 'agent.subscribe_result', agentId: 'agent', include: ['tool', 'text', 'final'], ttlMs: 60_000 })
  })

  it('streams to the subscribing device only, and keeps stream frames out of the replay log', async () => {
    const f = fixture()
    await f.request('a', { type: 'hello', proto: 1 }); await f.request('b', { type: 'hello', proto: 1 })
    const sub = await f.request('a', { type: 'agent.subscribe', ...target, ttlSec: 10 })
    f.service.stream('agent', [toolStart])
    expect(f.streamFrames('a')).toMatchObject([{ kind: 'stream.tool', subscriptionId: sub.subscriptionId }])
    expect(f.streamFrames('b')).toEqual([])
    const resumed = await f.request('a', { type: 'hello', proto: 1, resume: { serverInstanceId: f.service.serverInstanceId, cursor: 0 } })
    expect(resumed).toMatchObject({ resumed: true, cursor: 0 })
    expect(f.streamFrames('a')).toHaveLength(1)
  })

  it('ends when the time runs out, on unsubscribe, and when the last link closes', async () => {
    const f = fixture()
    await f.request('a', { type: 'hello', proto: 1 })
    const sub = await f.request('a', { type: 'agent.subscribe', ...target, ttlSec: 2 })
    vi.advanceTimersByTime(2000)
    f.service.stream('agent', [toolStart])
    expect(f.streamFrames('a').map(e => e.kind)).toEqual(['stream.end'])
    expect(await f.request('a', { type: 'agent.unsubscribe', subscriptionId: sub.subscriptionId })).toMatchObject({ unsubscribed: false })

    const again = await f.request('a', { type: 'agent.subscribe', ...target })
    expect(await f.request('a', { type: 'agent.unsubscribe', subscriptionId: again.subscriptionId })).toMatchObject({ unsubscribed: true })

    await f.request('a', { type: 'agent.subscribe', ...target })
    f.relay.drop('a')
    f.service.stream('agent', [toolStart])
    expect(f.streamFrames('a').map(e => e.kind)).toEqual(['stream.end', 'stream.end'])
  })

  it('ends a revoked device\'s subscriptions', async () => {
    const f = fixture()
    await f.request('a', { type: 'hello', proto: 1 })
    await f.request('a', { type: 'agent.subscribe', ...target })
    f.relay.revoke('device-a')
    f.service.stream('agent', [toolStart])
    expect(f.streamFrames('a')).toEqual([])
  })
})
