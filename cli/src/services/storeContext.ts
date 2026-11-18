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
  signal: AbortSignal, connect: Connect = connectSocket): Promise<DshAccount> {
  const answer = await requestOnce(where, 'grid_launch_context', { setup }, current, signal, budget, 130_000,
    code => console.warn(`[store] LAUNCH_CONTEXT_${code}`), connect)
  if (!current() || signal.aborted) throw new Error('Store context connection changed')
  const account = answer?.ok === true ? dshAccountIn(answer.account) : null
  if (!account) console.warn('[store] LAUNCH_CONTEXT_UNAVAILABLE')
  return account ?? { privateGrid: null }
}
