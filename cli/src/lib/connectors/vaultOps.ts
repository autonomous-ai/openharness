/**
 * Gateway-local account vault operations. No core module imports this secret-bearing boundary.
 */

type Payload = Record<string, unknown>

/** The gateway's signed-in backend and local encryption authority. */
export interface VaultAccount {
  backend(method: string, path: string, body?: unknown): Promise<{ status: number, body: Record<string, unknown> }>
  connectorVault: { seal(plaintext: string): Promise<Record<string, unknown>>, open(envelope: unknown): Promise<{ plaintext: string, complete: boolean } | { stranded: true } | null> }
}

/** Local synchronization operations and the gateway-only old-core compatibility adapter. */
export async function answerVaultOp(account: VaultAccount, payload: Payload): Promise<Payload> {
  try {
    switch (payload.op) {
      case 'read': return { ...await account.backend('GET', '/api/connector-vault') }
      case 'write': return { ...await account.backend('PUT', '/api/connector-vault', { base: payload.base, envelope: payload.envelope }) }
      case 'seal': return { envelope: await account.connectorVault.seal(typeof payload.plaintext === 'string' ? payload.plaintext : '') }
      case 'open': {
        const opened = await account.connectorVault.open(payload.envelope)
        return opened === null ? {} : { ...opened }
      }
      default: return { error: 'UNKNOWN_OP' }
    }
  } catch {
    return { error: 'CONNECTORS_SYNC_UNAVAILABLE' }
  }
}
