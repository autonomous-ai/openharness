/**
 * What the shared-machines service in its own process may ask of the core (`service_query`,
 * core/serviceLinks.ts): `shared_machines`, with an `op` of `policy` and `publish` (this machine's sharing,
 * as the backend holds it), `shared` (the machines shared with this account), `add` and `remove` (a domain
 * share), all signed in by the core, and `trust`, the gateway's trust stores (gateway/sharedTrust.ts).
 * Only the shared-machines service is answered; it reaches no other path of the backend this way
 * (lib/sharedMachinesPort.ts).
 */
import { answerSharedMachinesOp, type SharedMachinesAccount } from '../lib/sharedMachinesPort.js'

type Payload = Record<string, unknown>

/** The answer to the shared-machines service's query, or null when it is not one. */
export async function answerSharedMachinesQuery(account: SharedMachinesAccount, service: string, query: string, payload: Payload): Promise<Payload | null> {
  if (query !== 'shared_machines' || service !== 'sharedMachines') return null
  return answerSharedMachinesOp(account, payload)
}
