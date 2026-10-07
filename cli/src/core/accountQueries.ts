/**
 * What a service in its own process may ask of the core's account (`service_query`, core/serviceLinks.ts),
 * so that it holds no credential of its own (step 10, R3):
 * - `access_token`: a token, refreshed once when the asker says the last one was refused with a 401;
 * - `lane`: one step of the fleet's lane's sealing (`LaneSeal`), which the gateway does with this
 *   machine's E2EE identity (gateway/lane.ts).
 * The core answers them only for the services it names (core/main.ts): the gateway asks for tokens, and the
 * process that runs the fleet asks for both. The process's side is services/accountLink.ts.
 */
import type { CoreApi } from './api.js'

type Payload = Record<string, unknown>
type Account = Pick<CoreApi['account'], 'accessToken' | 'lane'>

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const record = (value: unknown): Payload => (value && typeof value === 'object' && !Array.isArray(value) ? value as Payload : {})

/** The answer to an account query, or null for a query that is not the account's. A refused token comes back
 *  as the session's own error, so the asker can tell a session that is over from one that could not be
 *  refreshed just now. */
export async function answerAccountQuery(account: Account, query: string, payload: Payload): Promise<Payload | null> {
  if (query === 'access_token') {
    try {
      return { token: await account.accessToken({ force: payload.force === true, ...(typeof payload.failedToken === 'string' ? { failedToken: payload.failedToken } : {}) }) }
    } catch (error) {
      return { code: text((error as { code?: unknown }).code) || 'UNAVAILABLE', message: error instanceof Error ? error.message : String(error) }
    }
  }
  if (query !== 'lane') return null
  const machineId = text(payload.machineId)
  switch (payload.op) {
    case 'hello':
      try { return { frame: await account.lane.hello(machineId, text(payload.peerPub)) } } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    case 'welcome': return { ok: await account.lane.welcome(machineId, record(payload.payload)) }
    case 'rekey': await account.lane.rekey(machineId, record(payload.payload)); return {}
    case 'seal': return { ...await account.lane.seal(machineId, record(payload.frame)) }
    case 'open': return { ...await account.lane.open(machineId, record(payload.frame)) }
    case 'drop': account.lane.drop(machineId); return {}
    default: return { error: 'UNKNOWN_OP' }
  }
}
