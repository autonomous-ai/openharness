import { requestOnce, type RequestBudget } from './requestOnce.js'
import { connectSocket, type Connect, type Where } from './daemon.js'

export type CancelBudget = RequestBudget

/** One confirmed interrupt on an owner socket. A lost answer is never retried. */
export async function cancelTurn(where: Where, agentId: string, current: () => boolean, signal: AbortSignal,
  budget: CancelBudget, connect: Connect = connectSocket): Promise<boolean> {
  if (!agentId || agentId.length > 200) return false
  const result = await requestOnce(where, 'cancel', { agentId }, current, signal, budget, 15_000,
    code => console.warn(`[wifi] CANCEL_${code}`), connect)
  if (result && result.ok !== true) console.warn('[wifi] CANCEL_UNAVAILABLE')
  return result?.ok === true
}
