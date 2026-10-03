import type { IncomingMessage } from 'http'
import { describe, expect, it } from 'vitest'
import { isLoopbackRequest, loopbackHosts } from './loopbackRequest.js'

const hosts = loopbackHosts(18473)
const req = (headers: Record<string, string>) => ({ headers } as unknown as IncomingMessage)

describe('isLoopbackRequest', () => {
  it('serves the names every native caller and the dashboard use, on the bound port only', () => {
    for (const host of ['127.0.0.1:18473', 'localhost:18473', '[::1]:18473', 'LOCALHOST:18473']) {
      expect(isLoopbackRequest(req({ host }), hosts)).toBe(true)
    }
    for (const host of ['127.0.0.1:18474', '127.0.0.1', 'evil.example:18473', 'evil.example', '']) {
      expect(isLoopbackRequest(req({ host }), hosts)).toBe(false)
    }
    expect(isLoopbackRequest(req({}), hosts)).toBe(false)
  })

  it('takes a browser request only from its own loopback origin', () => {
    expect(isLoopbackRequest(req({ host: '127.0.0.1:18473', origin: 'http://127.0.0.1:18473' }), hosts)).toBe(true)
    expect(isLoopbackRequest(req({ host: 'localhost:18473', origin: 'http://localhost:18473' }), hosts)).toBe(true)
    expect(isLoopbackRequest(req({ host: '127.0.0.1:18473', origin: 'http://evil.example' }), hosts)).toBe(false)
    expect(isLoopbackRequest(req({ host: '127.0.0.1:18473', origin: 'http://localhost:18473' }), hosts)).toBe(false)
    expect(isLoopbackRequest(req({ host: '127.0.0.1:18473', origin: 'null' }), hosts)).toBe(false)
    expect(isLoopbackRequest(req({ host: '127.0.0.1:18473', 'sec-fetch-site': 'cross-site' }), hosts)).toBe(false)
    expect(isLoopbackRequest(req({ host: '127.0.0.1:18473', 'sec-fetch-site': 'same-origin' }), hosts)).toBe(true)
  })
})
