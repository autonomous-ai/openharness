import { describe, expect, it } from 'vitest'
import type { CoreApi } from '../core/api.js'
import { backend, readable, REQUEST_BLOCKED, SuperTabHostError } from './wire.js'

const core = (status: number, body: Record<string, unknown>) => ({ account: { backend: async () => ({ status, body }) } }) as unknown as CoreApi

describe('a backend request that fails', () => {
  // A real Buddy on Windows: a message naming C:\Windows\win.ini got a bare 403 from the firewall, and read "backend unavailable".
  it('says the firewall refused it when a 403 is none of the server\'s answers', async () => {
    const refused = await backend(core(403, {}), 'POST', '/x', {}).catch((error: unknown) => error) as SuperTabHostError
    expect(refused).toBeInstanceOf(SuperTabHostError)
    expect(refused.code).toBe(REQUEST_BLOCKED)
    expect(refused.message).toContain('win.ini')
  })

  it('keeps the server\'s own 403 and any other failure as they were', async () => {
    const own = await backend(core(403, { error: { code: 'NOT_A_MEMBER', message: 'No.' } }), 'GET', '/x').catch((error: unknown) => error) as SuperTabHostError
    expect([own.code, own.message]).toEqual(['NOT_A_MEMBER', 'No.'])
    const down = await backend(core(502, {}), 'GET', '/x').catch((error: unknown) => error) as SuperTabHostError
    expect(down.code).toBe('BACKEND_UNAVAILABLE')
  })
})


describe('read compatibility', () => {
  it.each([undefined, null, false, '2', '3', 0, 1, 2.5, NaN, Infinity, [], {}])('treats malformed or older format %j as a retryable read failure', format => {
    expect(() => readable({ format })).toThrow(expect.objectContaining({ code: 'BACKEND_UNAVAILABLE', status: 503 }))
  })

  it.each([undefined, null, 'garbled', [], {}])('does not require an update for a partial reply %j', reply => {
    expect(() => readable(reply)).toThrow(expect.objectContaining({ code: 'BACKEND_UNAVAILABLE', status: 503 }))
  })

  it('accepts format 2 and requires an update only for a higher integer format', () => {
    const reply = { format: 2 }
    expect(readable(reply)).toBe(reply)
    expect(() => readable({ format: 3 })).toThrow(expect.objectContaining({ code: 'UPDATE_REQUIRED', status: 426 }))
  })

  it('preserves a real HTTP 426 even without an error body', async () => {
    await expect(backend(core(426, {}), 'GET', '/x')).rejects.toMatchObject({ code: 'UPDATE_REQUIRED', status: 426 })
  })
})
