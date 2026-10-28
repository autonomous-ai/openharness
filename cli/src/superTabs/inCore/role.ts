/** The same role lookup in a separate Super Tab process. Missing/older services grant no skill. */
import { isSwarmRole, isSwarmSkillMode, type SwarmSkillGrant } from '../../lib/swarmSkills.js'

export function swarmRoleThrough(call: (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  return async (harnessId: string): Promise<SwarmSkillGrant | null | undefined> => {
    const answer = await call('super_tabs', { action: 'swarmRole', harnessId })
    if (answer.ok !== true) return undefined
    if (answer.role === null) return null
    return isSwarmRole(answer.role) ? { role: answer.role, ...(isSwarmSkillMode(answer.mode) ? { mode: answer.mode } : {}) } : undefined
  }
}
