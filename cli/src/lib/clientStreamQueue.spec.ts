import { describe, expect, it } from 'vitest'
import { createClientStreamQueue } from './clientStreamQueue.js'
import { CLIENT_STREAM_QUEUE_BYTES } from './clientStreamContract.js'

describe('client stream transport queue', () => {
  it('bounds tiny outstanding frames, returns a callback slot once, and preserves independent shares', () => {
    const queue = createClientStreamQueue(), first = queue.connection(), second = queue.connection()
    const tag = { service: 'agentBrowser', direction: 'client' } as const
    const callbacks = Array.from({ length: 4096 }, () => first.reserve(tag, 32)!)
    expect(callbacks.every(callback => typeof callback === 'function')).toBe(true)
    expect(second.reserve(tag, 32)).toBeNull()
    expect(second.reserve({ service: 'viewers', direction: 'client' }, 32)).toBeTypeOf('function')
    expect(second.reserve({ service: 'agentBrowser', direction: 'service' }, 32)).toBeTypeOf('function')
    callbacks[0]!(); callbacks[0]!()
    expect(second.reserve(tag, 32)).toBeTypeOf('function')
    expect(second.reserve(tag, 32)).toBeNull()
    first.close()
    for (let index = 0; index < 4095; index++) expect(second.reserve(tag, 32)).toBeTypeOf('function')
    for (const callback of callbacks) callback()
    expect(second.reserve(tag, 32)).toBeNull()
    second.close()
    expect(queue.connection().reserve(tag, 32)).toBeTypeOf('function')
  })

  it('bounds actual queued bytes independently for both services and directions', () => {
    const queue = createClientStreamQueue(), a = queue.connection(), b = queue.connection()
    const tag = { service: 'agentBrowser', direction: 'client' } as const
    const release = a.reserve(tag, CLIENT_STREAM_QUEUE_BYTES)!
    expect(release).toBeTypeOf('function')
    expect(b.reserve(tag, 1)).toBeNull()
    expect(b.reserve({ service: 'viewers', direction: 'client' }, CLIENT_STREAM_QUEUE_BYTES)).toBeTypeOf('function')
    expect(b.reserve({ service: 'agentBrowser', direction: 'service' }, CLIENT_STREAM_QUEUE_BYTES)).toBeTypeOf('function')
    release(); release()
    expect(b.reserve(tag, CLIENT_STREAM_QUEUE_BYTES)).toBeTypeOf('function')
    expect(b.reserve(tag, 1)).toBeNull()
  })

  it('releases closed connection charges once and fences its late callbacks', () => {
    const queue = createClientStreamQueue(), old = queue.connection()
    const tag = { service: 'viewers', direction: 'client' } as const
    const late = old.reserve(tag, CLIENT_STREAM_QUEUE_BYTES)!
    old.close(); old.close()
    const replacement = queue.connection()
    expect(replacement.reserve(tag, CLIENT_STREAM_QUEUE_BYTES)).toBeTypeOf('function')
    late()
    expect(replacement.reserve(tag, 1)).toBeNull()
    expect(old.reserve(tag, 1)).toBeNull()
    replacement.close()
    expect(queue.connection().reserve(tag, CLIENT_STREAM_QUEUE_BYTES)).toBeTypeOf('function')
  })

  it('rejects unknown service tags and invalid byte counts without allocating a share', () => {
    const conn = createClientStreamQueue().connection()
    for (const bytes of [-1, NaN, Infinity, 0.5]) expect(conn.reserve({ service: 'viewers', direction: 'client' }, bytes)).toBeNull()
    expect(conn.reserve({ service: 'unknown', direction: 'client' }, 1)).toBeNull()
    expect(conn.reserve({ service: 'viewers', direction: 'client' }, 0)).toBeTypeOf('function')
  })
})
