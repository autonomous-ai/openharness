/** Only metadata crosses from connectors to account synchronization in the gateway. */
import type { CoreApi } from './api.js'
type Payload = Record<string, unknown>

export async function answerConnectorsQuery(core: Pick<CoreApi, 'account'>, service: string, query: string, payload: Payload): Promise<Payload | null> {
  if (query !== 'connector_vault' || service !== 'connectors') return null
  if (payload.op !== 'sync' || typeof payload.refresh !== 'boolean'
    || (payload.query !== undefined && payload.query !== query)
    || (payload.requestId !== undefined && (typeof payload.requestId !== 'string' || payload.requestId.length > 128))
    || Object.keys(payload).some(key => !['op', 'refresh', 'query', 'requestId'].includes(key))) return { error: 'UNKNOWN_OP' }
  try {
    const answer = await core.account.connectorSync(payload.refresh)
    return typeof answer.shared === 'boolean' ? { shared: answer.shared } : { error: 'CONNECTORS_SYNC_UNAVAILABLE' }
  } catch { return { error: 'CONNECTORS_SYNC_UNAVAILABLE' } }
}
