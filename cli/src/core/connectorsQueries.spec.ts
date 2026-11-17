import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { answerConnectorsQuery } from './connectorsQueries.js'

describe('the connectors service\'s query to the core', () => {
  it('secret boundary: refuses secret-bearing vault operations before calling account authority', async () => {
    const core = fakeCore()
    for (const payload of [
      { op: 'read' }, { op: 'write', base: 1, envelope: { ct: 'synthetic' } },
      { op: 'seal', plaintext: 'synthetic-custody-canary' }, { op: 'open', envelope: { ct: 'synthetic' } },
      { op: 'sync', refresh: true, plaintext: 'synthetic-custody-canary' },
    ]) expect(await answerConnectorsQuery(core, 'connectors', 'connector_vault', payload)).toEqual({ error: 'UNKNOWN_OP' })
    expect(core.account.backend).not.toHaveBeenCalled()
  })

  it('answers only the connectors service, and only `connector_vault`', async () => {
    const core = fakeCore()
    expect(await answerConnectorsQuery(core, 'messages', 'connector_vault', { op: 'read' })).toBeNull()
    expect(await answerConnectorsQuery(core, 'connectors', 'backend', { method: 'GET', path: '/api/desk' })).toBeNull()
    expect(core.account.backend).not.toHaveBeenCalled()
  })

  it('requests only sync metadata and projects the gateway reply', async () => {
    const connectorSync = vi.fn(async () => ({ shared: true, plaintext: 'synthetic-untrusted-extra' }))
    const core = fakeCore({ account: { connectorSync } } as never)
    expect(await answerConnectorsQuery(core, 'connectors', 'connector_vault', { op: 'sync', refresh: true })).toEqual({ shared: true })
    expect(connectorSync).toHaveBeenCalledWith(true)
    expect(await answerConnectorsQuery(core, 'connectors', 'connector_vault', { op: 'sync', refresh: false })).toEqual({ shared: true })
    for (const payload of [{ op: 'sync' }, { op: 'sync', refresh: 'yes' }, { op: 'unknown' }]) {
      expect(await answerConnectorsQuery(core, 'connectors', 'connector_vault', payload)).toEqual({ error: 'UNKNOWN_OP' })
    }
    connectorSync.mockResolvedValueOnce({ shared: 'invalid' } as never)
    expect(await answerConnectorsQuery(core, 'connectors', 'connector_vault', { op: 'sync', refresh: true })).toEqual({ error: 'CONNECTORS_SYNC_UNAVAILABLE' })
    connectorSync.mockRejectedValueOnce(new Error('synthetic-private-error'))
    expect(await answerConnectorsQuery(core, 'connectors', 'connector_vault', { op: 'sync', refresh: true })).toEqual({ error: 'CONNECTORS_SYNC_UNAVAILABLE' })
  })

  it('accepts the existing service-query framing without forwarding it into account authority', async () => {
    const connectorSync = vi.fn(async () => ({ shared: true }))
    const core = fakeCore({ account: { connectorSync } } as never)
    expect(await answerConnectorsQuery(core, 'connectors', 'connector_vault', {
      op: 'sync', refresh: true, query: 'connector_vault', requestId: 'wire-request',
    })).toEqual({ shared: true })
    expect(connectorSync).toHaveBeenCalledExactlyOnceWith(true)
    for (const extra of [{ query: 'different' }, { requestId: {} }, { requestId: 'x'.repeat(129) }]) {
      expect(await answerConnectorsQuery(core, 'connectors', 'connector_vault', { op: 'sync', refresh: true, ...extra })).toEqual({ error: 'UNKNOWN_OP' })
    }
  })
})
