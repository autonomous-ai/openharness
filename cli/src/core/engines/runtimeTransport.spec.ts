import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeContext } from '../../engines/facets/runtime.js'
import { blankRuntimeState } from '../../engines/kit/runtime.js'
import { engineRuntimeRequests } from '../../engines/worker/runtimeRequests.js'
import { RUNTIME_CAPABILITIES, RUNTIME_IN_FLIGHT, RUNTIME_READ, RUNTIME_REPLY_BYTES, RUNTIME_WAIT_MS } from '../../engines/worker/runtimeProtocol.js'
import { createRuntimeTransport, type RuntimeTransport } from './runtimeTransport.js'

const context = (): RuntimeContext => ({ session: { agentId: 'agent', sessionId: 'session', engine: 'claude', model: null,
  cliVersion: '2.1.209', cwd: null, transcriptPath: null }, state: blankRuntimeState() })
const operation = { kind: 'describe' } as const
const capability = { version: 1, runtime: 1, engine: 'claude' }
const answer = { version: 1, answer: { state: blankRuntimeState(), cliVersion: '2.1.209', control: null, selectedModel: null, supportsControl: true } }
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function setup() {
  const call = vi.fn(async (_service: string, method: string, _payload: Record<string, unknown>, _waitMs: number): Promise<Record<string, unknown>> => method === RUNTIME_CAPABILITIES ? capability : answer)
  const transport = createRuntimeTransport({ call })
  transport.connected('engine-claude')
  return { call, transport, read: () => transport.read('claude', context(), operation) }
}
afterEach(() => vi.restoreAllMocks())

describe('core runtime transport', () => {
  it('negotiates once per connection and evaluates profiles in a real worker handler', async () => {
    const handlers = engineRuntimeRequests('claude')
    let transport: RuntimeTransport
    const call = vi.fn(async (service: string, method: string, payload: Record<string, unknown>) => {
      if (call.mock.calls.length === 1) transport.connected(service)
      return await handlers[method](payload, { owner: true, local: true }) as Record<string, unknown>
    })
    transport = createRuntimeTransport({ call })
    const read = () => transport.read('claude', context(), { kind: 'pane', text: 'Opus 5 with high effort' })
    expect((await read()).state).toMatchObject({ model: 'claude-opus-5', effort: 'high' })
    await read()
    expect(call.mock.calls.map(c => c[1])).toEqual([RUNTIME_CAPABILITIES, RUNTIME_READ, RUNTIME_READ])
    transport.disconnected('engine-claude'); transport.connected('engine-claude')
    await read()
    expect(call.mock.calls.filter(c => c[1] === RUNTIME_CAPABILITIES)).toHaveLength(2)
    transport.connected('unrelated'); transport.disconnected('unrelated')
    await expect(transport.read('unknown', context(), operation)).rejects.toThrow('ENGINE_INVALID_REQUEST')
    await expect(transport.read('codex', context(), operation)).rejects.toThrow('ENGINE_INVALID_REQUEST')
  })

  it('bounds in-flight calls and rejects results from a replaced connection', async () => {
    const t = setup(), work = deferred<typeof answer>()
    await t.read()
    t.call.mockImplementation(() => work.promise)
    const tasks = Array.from({ length: RUNTIME_IN_FLIGHT }, () => t.read())
    await expect(t.read()).rejects.toThrow('ENGINE_BUSY')
    t.transport.disconnected('engine-claude'); t.transport.connected('engine-claude')
    work.resolve(answer)
    for (const task of tasks) await expect(task).rejects.toThrow('ENGINE_STALE_REPLY')
    t.call.mockImplementation(async (_service, method) => method === RUNTIME_CAPABILITIES ? capability : answer)
    expect(await t.read()).toEqual(answer.answer)
  })

  it('shares a single deadline across negotiation and the read', async () => {
    const t = setup()
    let time = 10
    vi.spyOn(performance, 'now').mockImplementation(() => time)
    t.call.mockImplementation(async (_service, method, _payload, waitMs) => {
      if (method === RUNTIME_CAPABILITIES) { expect(waitMs).toBe(RUNTIME_WAIT_MS); time += 4_000; return capability }
      expect(waitMs).toBe(1_000)
      return answer
    })
    await t.read()
    t.call.mockImplementation(async () => { time += RUNTIME_WAIT_MS + 1; return answer })
    await expect(t.read()).rejects.toThrow('ENGINE_UNAVAILABLE')
    const noTime = setup()
    let calls = 0
    vi.spyOn(performance, 'now').mockImplementation(() => ++calls === 1 ? 0 : RUNTIME_WAIT_MS)
    await expect(noTime.read()).rejects.toThrow('ENGINE_UNAVAILABLE')
    expect(noTime.call).not.toHaveBeenCalled()
  })

  it('rejects bad capabilities, service errors, malformed and oversized results without fallback', async () => {
    for (const reply of [{ ...capability, runtime: 2 }, { ...capability, engine: 'codex' }, { ...capability, version: 2 },
      { version: 1, error: 'unexpected' }, { version: 1, answer: {} }]) {
      const t = setup(); t.call.mockResolvedValue(reply as typeof capability)
      await expect(t.read()).rejects.toThrow('ENGINE_INVALID_REPLY')
    }
    for (const error of ['SERVICE_FAILED', 'SERVICE_UNAVAILABLE', 'ENGINE_BUSY']) {
      const t = setup(); t.call.mockResolvedValue({ version: 1, error } as unknown as typeof capability)
      await expect(t.read()).rejects.toThrow(error === 'ENGINE_BUSY' ? error : 'ENGINE_UNAVAILABLE')
    }
    const t = setup(); await t.read()
    t.call.mockRejectedValueOnce(new Error('link lost'))
    await expect(t.read()).rejects.toThrow('ENGINE_UNAVAILABLE')
    t.call.mockResolvedValueOnce({ version: 1, answer: {} } as typeof answer)
    await expect(t.read()).rejects.toThrow('ENGINE_INVALID_REPLY')
    t.call.mockResolvedValueOnce({ ...answer, extra: 'x'.repeat(RUNTIME_REPLY_BYTES) })
    await expect(t.read()).rejects.toThrow('ENGINE_INVALID_REPLY')
    expect(await t.read()).toEqual(answer.answer)
  })
})
