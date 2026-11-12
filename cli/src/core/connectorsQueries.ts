/**
 * What the connectors service in its own process may ask of the core (`service_query`, core/serviceLinks.ts):
 * `connector_vault`, the account's connected services kept the same on every computer
 * (lib/connectors/vaultSync.ts), answered here by lib/connectors/vaultOps.ts. Its `op` is one of:
 * - `read`: the account's envelope and revision (`GET /api/connector-vault`), signed in by the core;
 * - `write`: an envelope over a revision (`PUT /api/connector-vault`), answered as the backend answers;
 * - `seal`: this computer's connections sealed for the account's machines by the gateway, which holds the
 *   identity (lib/e2ee/connectorVault.ts);
 * - `open`: an envelope opened by the gateway (`plaintext`, and whether it was sealed for every account
 *   machine, `complete`), or nothing when no account machine signed it for this one.
 * Only the connectors service is answered; it reaches no other path of the backend this way.
 */
import type { CoreApi } from './api.js'
import { answerVaultOp } from '../lib/connectors/vaultOps.js'

type Payload = Record<string, unknown>

/** The answer to the connectors service's query, or null when it is not one. */
export async function answerConnectorsQuery(core: Pick<CoreApi, 'account'>, service: string, query: string, payload: Payload): Promise<Payload | null> {
  if (query !== 'connector_vault' || service !== 'connectors') return null
  return answerVaultOp(core.account, payload)
}
