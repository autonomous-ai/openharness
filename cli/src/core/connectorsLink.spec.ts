import { describe, expect, it, vi } from 'vitest'
import { CONNECTORS_FALLBACKS, CONNECTORS_OFF } from './api.js'
import { createConnectorsLink, SYNC_WAIT_MS } from './connectorsLink.js'
import { createServiceLinks } from './serviceLinks.js'
import { readFallback } from './serviceHost.js'

describe('connected services in their own process, as the core reaches them', () => {
  it('asks them to write a profile home\'s connections, waiting no longer than a launch may', async () => {
    const call = vi.fn(async () => ({ names: ['linear', 7, 'notion'] }))
    expect(await createConnectorsLink(call).syncProfileHome('codex', '/profiles/codex-work')).toEqual(['linear', 'notion'])
    expect(call).toHaveBeenCalledWith('syncProfileHome', { engine: 'codex', folder: '/profiles/codex-work' }, SYNC_WAIT_MS)
  })

  it('reads services that are down, slow or failing as nothing written, as the fallback and the services off do', async () => {
    for (const answer of [{ error: 'SERVICE_UNAVAILABLE', service: 'connectors', retryable: false }, { error: 'SERVICE_FAILED', service: 'connectors' }, { names: 'not a list' }]) {
      expect(await createConnectorsLink(async () => answer, () => {}).syncProfileHome('claude', '/profiles/claude-work')).toEqual([])
    }
    expect(readFallback(CONNECTORS_FALLBACKS.syncProfileHome)).toEqual({ deferred: true, value: [] })
    expect(await CONNECTORS_OFF.syncProfileHome('claude', '/profiles/claude-work')).toEqual([])
  })

  // An agent that starts without its connections says why, by the engine and a fixed code: never the profile's folder.
  it('logs a sync the services did not do, and nothing for one they did', async () => {
    const log = vi.fn()
    await createConnectorsLink(async () => ({ error: 'SERVICE_UNAVAILABLE', service: 'connectors', retryable: true }), log).syncProfileHome('codex', '/profiles/codex-work')
    expect(log.mock.calls).toEqual([['[connections] profile home not updated (codex): SERVICE_UNAVAILABLE; launching with its current config']])
    await createConnectorsLink(async () => ({ names: ['linear'] }), log).syncProfileHome('claude', '/profiles/claude-work')
    expect(log).toHaveBeenCalledOnce()
    expect(String(log.mock.calls[0][0])).not.toContain('/profiles/')
  })

  it('logs to the core\'s own log by default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await createConnectorsLink(async () => ({ error: 'SERVICE_FAILED', service: 'connectors' })).syncProfileHome('claude', '/profiles/claude-work')
      expect(warn).toHaveBeenCalledWith('[connections] profile home not updated (claude): SERVICE_FAILED; launching with its current config')
    } finally { warn.mockRestore() }
  })

  it('goes on without an edge host that never answers once the wait is up', async () => {
    vi.useFakeTimers()
    try {
      // The edge host connected, then hung: it takes the request and says nothing.
      const links = createServiceLinks({ owned: { connectors: ['connectors'] }, token: 't', answer: () => ({}), timeoutMs: 30_000, log: () => {} })
      const sent: unknown[] = []
      links.accept('connectors', 't', { sendFrame: (frame) => { sent.push(frame); return true } }, () => {})
      const log = vi.fn()
      const link = createConnectorsLink((type, payload, waitMs) => links.call('connectors', type, payload, waitMs), log)
      let names: string[] | null = null
      void link.syncProfileHome('claude', '/profiles/claude-work').then((answer) => { names = answer })
      await vi.advanceTimersByTimeAsync(SYNC_WAIT_MS - 1)
      expect(sent).toHaveLength(1)
      expect(names).toBeNull()
      await vi.advanceTimersByTimeAsync(1)
      expect(names).toEqual([])
      expect(log).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
})
