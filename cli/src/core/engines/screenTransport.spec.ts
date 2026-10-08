import { afterEach, describe, expect, it, vi } from 'vitest'
import { screenFor } from '../../engines/screens.js'
import { engineScreenRequests } from '../../engines/worker/screenRequests.js'
import { SCREEN_CAPABILITIES, SCREEN_IN_FLIGHT, SCREEN_QUEUED, SCREEN_READ, SCREEN_REPLY_BYTES, SCREEN_WAIT_MS } from '../../engines/worker/screenProtocol.js'
import { createScreenTransport, type ScreenTransport } from './screenTransport.js'

const capture = '────────────\n❯\n────────────\n? for shortcuts'
const capability = { version: 1, screen: 1, engine: 'claude' }
const answer = { version: 1, answer: screenFor('claude').inspect(capture) }
function setup() {
  const call = vi.fn(async (_service: string, method: string, _payload: Record<string, unknown>, _wait: number): Promise<Record<string, unknown>> => method === SCREEN_CAPABILITIES ? capability : answer)
  const transport = createScreenTransport({ call }); transport.connected('engine-claude')
  return { transport, call, read: () => transport.read('claude', capture) }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
describe('screen transport', () => {
  it('negotiates each connection and decodes real worker evidence', async () => {
    const requests = engineScreenRequests('claude')
    let transport: ScreenTransport
    const call = vi.fn(async (service, method, payload) => {
      if (call.mock.calls.length === 1) transport.connected(service)
      return await requests[method]({ ...payload, requestId: `core-route-${call.mock.calls.length}` }, { owner: true, local: true })
    })
    transport = createScreenTransport({ call })
    expect(await transport.read('claude', capture)).toEqual(answer.answer)
    await transport.read('claude', capture)
    expect(call.mock.calls.map(c => c[1])).toEqual([SCREEN_CAPABILITIES, SCREEN_READ, SCREEN_READ])
    transport.disconnected('engine-claude'); transport.connected('engine-claude')
    await transport.read('claude', capture)
    expect(call.mock.calls.filter(c => c[1] === SCREEN_CAPABILITIES)).toHaveLength(2)
    transport.connected('other'); transport.disconnected('other')
    await expect(transport.read('other', capture)).rejects.toThrow('ENGINE_INVALID_REQUEST')
    await expect(transport.read('claude', 'x'.repeat(300_000))).rejects.toThrow('ENGINE_INVALID_REQUEST')
  })
  it('bounds requests, fences replaced connections, and releases slots', async () => {
    const t = setup(); await t.read()
    let finish!: (value: typeof answer) => void
    const pending = new Promise<typeof answer>(resolve => { finish = resolve })
    t.call.mockImplementation(() => pending)
    const tasks = Array.from({ length: SCREEN_IN_FLIGHT + SCREEN_QUEUED }, () => t.read())
    await expect(t.read()).rejects.toThrow('ENGINE_BUSY')
    t.transport.disconnected('engine-claude'); t.transport.connected('engine-claude')
    finish(answer)
    for (const task of tasks) await expect(task).rejects.toThrow('ENGINE_STALE_REPLY')
    t.call.mockImplementation(async (_s, method) => method === SCREEN_CAPABILITIES ? capability : answer)
    expect(await t.read()).toEqual(answer.answer)
  })

  it('serves a burst of pane polls fairly and expires queued work without sending it late', async () => {
    const t = setup(); await t.read()
    const burst = await Promise.all(Array.from({ length: 24 }, () => t.read()))
    expect(burst).toHaveLength(24)
    expect(burst.every(value => value.messageHold === null)).toBe(true)
    vi.useFakeTimers()
    t.call.mockClear().mockImplementation(() => new Promise(() => {}))
    const waiting = Array.from({ length: 24 }, () => t.read().catch(error => error.code))
    await vi.advanceTimersByTimeAsync(SCREEN_WAIT_MS + 1)
    expect(await Promise.all(waiting)).toEqual(Array(24).fill('ENGINE_UNAVAILABLE'))
    expect(t.call).toHaveBeenCalledTimes(SCREEN_IN_FLIGHT)
  })
  it('enforces one deadline across cold negotiation and a read, including a hung link', async () => {
    const t = setup(); let time = 10
    vi.spyOn(performance, 'now').mockImplementation(() => time)
    t.call.mockImplementation(async (_s, method, _p, wait) => {
      if (method === SCREEN_CAPABILITIES) { expect(wait).toBe(SCREEN_WAIT_MS); time += 800; return capability }
      expect(wait).toBe(200); return answer
    })
    await t.read()
    t.call.mockImplementation(async () => { time += SCREEN_WAIT_MS + 1; return answer })
    await expect(t.read()).rejects.toThrow('ENGINE_UNAVAILABLE')
    const noTime = setup(); let calls = 0
    vi.spyOn(performance, 'now').mockImplementation(() => ++calls === 1 ? 0 : SCREEN_WAIT_MS)
    await expect(noTime.read()).rejects.toThrow('ENGINE_UNAVAILABLE')
    expect(noTime.call).not.toHaveBeenCalled()
    vi.restoreAllMocks(); vi.useFakeTimers()
    const hung = setup(); hung.call.mockImplementation(() => new Promise(() => {}))
    const result = expect(hung.read()).rejects.toThrow('ENGINE_UNAVAILABLE')
    await vi.advanceTimersByTimeAsync(SCREEN_WAIT_MS)
    await result
  })
  it('rejects wrong capabilities, errors and malformed or oversized answers', async () => {
    for (const reply of [{ ...capability, screen: 2 }, { ...capability, engine: 'codex' }, { ...capability, version: 2 },
      { version: 1, error: 'unexpected' }, { version: 1, answer: {} }]) {
      const t = setup(); t.call.mockResolvedValue(reply)
      await expect(t.read()).rejects.toThrow('ENGINE_INVALID_REPLY')
    }
    for (const error of ['SERVICE_FAILED', 'SERVICE_UNAVAILABLE', 'ENGINE_BUSY']) {
      const t = setup(); t.call.mockResolvedValue({ version: 1, error })
      await expect(t.read()).rejects.toThrow(error === 'ENGINE_BUSY' ? error : 'ENGINE_UNAVAILABLE')
    }
    const t = setup(); await t.read()
    t.call.mockRejectedValueOnce(new Error('lost'))
    await expect(t.read()).rejects.toThrow('ENGINE_UNAVAILABLE')
    t.call.mockResolvedValueOnce({ version: 1, answer: {} })
    await expect(t.read()).rejects.toThrow('ENGINE_INVALID_REPLY')
    t.call.mockResolvedValueOnce({ ...answer, extra: 'x'.repeat(SCREEN_REPLY_BYTES) })
    await expect(t.read()).rejects.toThrow('ENGINE_INVALID_REPLY')
    expect(await t.read()).toEqual(answer.answer)
  })
})
