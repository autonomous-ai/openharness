import { errorKind } from '../lib/log.js'
import { SERVICE_REQUESTS_MAX } from '../core/api.js'
import { requestOnce } from '../agentClient/requestOnce.js'
import { connectSocket, type Connect, type Where } from '../agentClient/daemon.js'
import { dshAccountIn } from '../dsh/launchWire.js'
import type { DshAccount } from '../dsh/launch.js'

// A timed-out socket still owns capacity, including across inline Store restarts.
let held = 0
const budget = { reserve: () => {
  if (held >= SERVICE_REQUESTS_MAX) return null
  held++
  let owned = true
  return () => { if (owned) { owned = false; held-- } }
} }

/** Models owns setup and account lookup; Store owns the decision to request setup. */
export async function storeLaunchContext(where: Where, setup: boolean, current: () => boolean,
  signal: AbortSignal, connect: Connect = connectSocket, backendName?: () => Promise<unknown>): Promise<DshAccount> {
  const check = () => { if (!current() || signal.aborted) throw new Error('Store context connection changed') }
  const backendAccount = async (): Promise<DshAccount> => {
    let name: unknown = null
    try { name = await backendName?.() ?? null }
    catch (caughtFailure) { console.warn(('[store] LAUNCH_ACCOUNT_UNAVAILABLE') + ' · ' + errorKind(caughtFailure)) }
    const account = dshAccountIn({ privateGrid: name })
    if (!account) console.warn('[store] LAUNCH_ACCOUNT_INVALID')
    return account ?? { privateGrid: null }
  }
  // Ordinary packages with a known account never needed Models to be running. A Model Manager
  // still asks for setup first; if Models is off, its already known backend name remains usable.
  if (!setup && backendName) {
    const known = await backendAccount()
    check()
    if (typeof known.privateGrid === 'string') return known
  }
  const answer = await requestOnce(where, 'grid_launch_context', { setup }, current, signal, budget, 130_000,
    code => console.warn(`[store] LAUNCH_CONTEXT_${code}`), connect)
  check()
  const account = answer?.ok === true ? dshAccountIn(answer.account) : null
  if (account) return account
  console.warn('[store] LAUNCH_CONTEXT_UNAVAILABLE')
  const known = await backendAccount()
  check()
  return known
}
