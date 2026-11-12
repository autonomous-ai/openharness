/**
 * The core's side of the account's connected services (lib/connectors/vaultSync.ts): one `connector_vault` op answered
 * with the account the core holds. Apart from the sync itself, which writes agents' configs, so that the core loads none
 * of the connections' code (core/connectorsQueries.ts).
 */

type Payload = Record<string, unknown>

/** The account as the core holds it: the backend, signed in, and the gateway's sealing. */
export interface VaultAccount {
  backend(method: string, path: string, body?: unknown): Promise<{ status: number, body: Record<string, unknown> }>
  connectorVault: { seal(plaintext: string): Promise<Record<string, unknown>>, open(envelope: unknown): Promise<{ plaintext: string, complete: boolean } | { stranded: true } | null> }
}

/** One `connector_vault` op answered with the core's account (core/connectorsQueries.ts, and the
 *  connectors service in the core's process): `read`, `write`, `seal`, `open`. */
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
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
