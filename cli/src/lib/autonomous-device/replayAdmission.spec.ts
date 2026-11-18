import { describe, expect, it, vi } from 'vitest'
import { AutonomousDeviceService } from './service.js'
import { AutonomousDeviceRelay } from './relay.js'

function retainedResults(count = 512) {
  const now = 1_000_000
  const service = new AutonomousDeviceService({ machineId: 'machine', serverInstanceId: 'instance', now: () => now,
    agents: () => [], submit: () => {}, cancelDelivery: () => true, stop: async () => true,
    answer: async () => true, recent: () => [], resultJournal: {
      load: () => ({ version: 1, machineId: 'machine', entries: [], results: Array.from({ length: count }, (_, n) => ({
        deviceId: 'owner', evidenceId: `evidence-${n}`, agentId: 'agent', at: now,
        payload: { serverInstanceId: 'old-instance', resultId: `result-${n}`, outcome: 'completed',
          fullText: `Result ${n}`, correlation: { scope: 'input', inputs: [{ deliveryId: `delivery-${n}`, idempotencyKey: `key-${n}` }] } },
      })) }), save: () => {},
    },
  })
  return service
}

describe('replay admission precedes source mutation', () => {
  it('does not allocate IDs or evict the event ring when a complete resync cannot be admitted', () => {
    const service = retainedResults()
    const before = service.resume()
    const refuse = vi.fn(() => null)
    service.replay(undefined, refuse)
    expect(service.resume()).toEqual(before)
    expect(refuse).toHaveBeenCalledOnce()
  })

  it('keeps the first admitted 512-result replay unchanged when a second resync evicts its ring range', () => {
    const service = retainedResults()
    const admitted: Array<readonly Readonly<Record<string, unknown>>[]> = []
    for (let n = 0; n < 2; n++) expect(service.replay(undefined, frames => {
      admitted.push(frames)
      return () => {}
    })).toBe(true)
    expect(admitted.map(frames => frames.length)).toEqual([513, 513])
    expect(admitted[0]!.slice(1).map(frame => frame.eventId)).toEqual(Array.from({ length: 512 }, (_, n) => n + 513))
    expect(admitted[1]!.slice(1).map(frame => frame.eventId)).toEqual(Array.from({ length: 512 }, (_, n) => n + 1025))
    expect(service.resume().cursor).toBe(1536)
    expect(admitted[0]![1]!.payload).toBe(admitted[1]![1]!.payload)
  })

  it('does not announce hello success or mutate the source when its replay admission fails', async () => {
    const service = retainedResults(), before = service.resume(), send = vi.fn(), joined = vi.fn(), client = vi.fn()
    const proof = { identity: 'owner', incarnation: 'session', peerEpoch: 'peer' }
    const relay = new AutonomousDeviceRelay(() => proof, send, service, 'machine', () => null, joined, undefined, client)
    await relay.handle('connection', proof, { type: 'hello', proto: 1, requestId: 'hello' })
    expect(service.resume()).toEqual(before)
    expect(joined).not.toHaveBeenCalled()
    expect(client).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledExactlyOnceWith('connection', { type: 'autonomous_device_result',
      payload: { type: 'hello_result', requestId: 'hello', error: { code: 'BACKPRESSURE', message: 'Replay is unavailable' } } }, proof)
    expect(relay.helloed()).toEqual([])
  })
})
