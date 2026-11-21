import { describe, expect, it, vi } from 'vitest'
import { devicePeerFrameBytes, encodeDevicePeerFrame, DEVICE_PEER_JSON_DEPTH } from './peerJson.js'
import { DEVICE_PEER_MESSAGE_BYTES } from './peerProtocol.js'

describe('bounded device JSON encoding', () => {
  it('counts actual UTF-8, escapes, holes and ordinary optional fields exactly', () => {
    const values = [null, true, false, 0, -0, 1e100, 'é🌍\u0000\n\\"\ud800', [], {}, [1, undefined, , 'x'],
      { present: { nested: ['a', 2, false] }, absent: undefined }, Object.assign(Object.create(null), { field: 'value' })]
    for (const value of values) {
      const bytes = Buffer.byteLength(JSON.stringify(value))
      expect(devicePeerFrameBytes(value)).toBe(bytes)
      expect(devicePeerFrameBytes(value, bytes)).toBe(bytes)
      expect(devicePeerFrameBytes(value, bytes - 1)).toBeNull()
    }
  })

  it('preserves a valid deeply nested add-on value and wide responses', () => {
    let nested: unknown = 0
    for (let depth = 0; depth < 2040; depth++) nested = [nested]
    const value = { nested }
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(4096)
    const frame = { type: 'request', epoch: 'epoch', opened: { payload: {
      type: 'addon.publish', values: [{ topic: 'room/state', value }],
    } } }
    expect(encodeDevicePeerFrame(frame)).toBe(JSON.stringify(frame))
    const wide = { agents: Array.from({ length: 8192 }, (_, n) => ({ id: n, name: 'Agent', engine: 'codex' })) }
    expect(devicePeerFrameBytes(wide)).toBe(Buffer.byteLength(JSON.stringify(wide)))
  })

  it('refuses excessive nesting before serialization and detects record and array cycles', () => {
    let nested: unknown = null
    for (let n = 0; n <= DEVICE_PEER_JSON_DEPTH; n++) nested = [nested]
    const record: Record<string, unknown> = {}; record.self = record
    const array: unknown[] = []; array.push(array)
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      for (const value of [nested, record, array]) expect(encodeDevicePeerFrame(value)).toBeNull()
      expect(stringify).not.toHaveBeenCalled()
    } finally { stringify.mockRestore() }
  })

  it('refuses an oversized formerly unbounded inline reply before making its JSON copy', () => {
    const frame = { type: 'send', frameType: 'autonomous_device_result', payload: {
      type: 'agents.list_result', agents: [{ name: 'x'.repeat(DEVICE_PEER_MESSAGE_BYTES) }],
    } }
    const stringify = vi.spyOn(JSON, 'stringify')
    try { expect(encodeDevicePeerFrame(frame)).toBeNull(); expect(stringify).not.toHaveBeenCalled() }
    finally { stringify.mockRestore() }
  })

  it('never invokes accessors, proxy traps or toJSON while admitting content', () => {
    const read = vi.fn(() => 'content'), convert = vi.fn(() => ({})), trap = vi.fn(() => Object.prototype)
    const getter = Object.defineProperty({}, 'content', { enumerable: true, get: read })
    const proxy = new Proxy({}, { getPrototypeOf: trap })
    const array = Object.defineProperty([0], '0', { get: read })
    for (const value of [getter, proxy, array, { toJSON: convert }, { value: Infinity }, { value: NaN }, { value: 1n }]) {
      expect(encodeDevicePeerFrame(value)).toBeNull()
    }
    expect(read).not.toHaveBeenCalled(); expect(convert).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled()
  })

  it('bounds omitted fields and counts repeated acyclic values on each occurrence', () => {
    const omitted = Object.fromEntries(Array.from({ length: 100 }, (_, n) => [`field${n}`, undefined]))
    expect(JSON.stringify(omitted)).toBe('{}')
    expect(devicePeerFrameBytes(omitted, 32)).toBeNull()
    const shared = { name: 'same' }, value = { first: shared, second: shared }
    expect(devicePeerFrameBytes(value)).toBe(Buffer.byteLength(JSON.stringify(value)))
  })
})
