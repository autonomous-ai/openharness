import { describe, expect, it } from 'vitest'
import type { CoreApi } from '../core/api.js'
import { backend, REQUEST_BLOCKED, SuperTabHostError } from './wire.js'

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
