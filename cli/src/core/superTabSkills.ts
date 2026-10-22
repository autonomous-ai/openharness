/** The same role lookup in a separate Super Tab process. Missing/older services grant no skill. */
import { isSwarmRole, type SwarmRole } from '../lib/swarmSkills.js'

export function swarmRoleThrough(call: (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  return async (harnessId: string): Promise<SwarmRole | null | undefined> => {
    const answer = await call('super_tabs', { action: 'swarmRole', harnessId })
    if (answer.ok !== true) return undefined
    if (answer.role === null) return null
    return isSwarmRole(answer.role) ? answer.role : undefined
  }
}
