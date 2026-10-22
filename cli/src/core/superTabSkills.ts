/** The same role lookup in a separate Super Tab process. Missing/older services grant no skill. */
import type { SwarmRole } from '../lib/swarmSkills.js'

export function swarmRoleThrough(call: (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  return async (harnessId: string): Promise<SwarmRole | null> => {
    const answer = await call('super_tabs', { action: 'swarmRole', harnessId })
    return answer.ok === true && (answer.role === 'lead' || answer.role === 'dev') ? answer.role : null
  }
}
