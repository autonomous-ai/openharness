/** What agents are called by the role they play: the PM of each project, and the name any other agent was started with. */
import { z } from 'zod'
import { agentRole, type Agent, type SuperTabState } from './model.js'
import { ledProject } from './projects.js'

/** What every project calls the agent that leads it. */
export const COORDINATOR_NAME = 'Product Manager'

export const roleNameSchema = z.string().trim().min(1).max(40)

/** The role name [target] goes by: the one it was started with, else what it is. Read only, so agents started without a name
 *  need no write. */
export function roleNameOf(state: SuperTabState, target: Agent): string {
  if (target.roleName) return target.roleName
  if (ledProject(state, target.id)) return 'PM'
  return agentRole(target) === 'reviewer' ? 'Reviewer' : 'Engineer'
}
