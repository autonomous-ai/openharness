/** The same role lookup in a separate Super Tab process. Missing/older services grant no skill. */
import { roleFromWire, type SwarmSkillGrant } from '../../lib/swarmSkills.js'

export function swarmRoleThrough(call: (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  return async (harnessId: string): Promise<SwarmSkillGrant | null | undefined> => {
    const answer = await call('super_tabs', { action: 'swarmRole', harnessId })
    if (answer.ok !== true) return undefined
    if (answer.role === null) return null
    // The process answers in the wire's values (lead, dev, review), which an older core reads too; a Reviewer's
    // answer keeps its kind. A newer one may answer in the kinds.
    return roleFromWire(answer.role) ?? undefined
  }
}
