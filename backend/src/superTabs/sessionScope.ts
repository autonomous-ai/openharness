import type { Prisma } from '@prisma/client'
import { fail, stableId, type Agent, type SuperTabState } from './model.js'
import { agentProjectId, projectOf } from './projects.js'

const scopeId = (state: SuperTabState, projectId: string) => stableId(state.id, projectId)

export async function bindSession(tx: Prisma.TransactionClient, state: SuperTabState, target: Agent) {
  const project = projectOf(state, agentProjectId(state, target))
  const scope = scopeId(state, project.id)
  const id = stableId('swarm-session', state.environment, target.machineOwnerId, target.id)
  const prior = await tx.superTabSessionScope.findUnique({ where: { id } })
  let scopes = prior?.scopeIds ?? []
  if (!prior) {
    // Sessions contributed before project privacy existed may already appear
    // in more than one tab. Inspect those registrations before binding one.
    const rows = await tx.superTab.findMany({ where: { autonomousEnv: state.environment, machineIds: { has: target.machineId } } })
    scopes = rows.flatMap(row => {
      const other = row.state as unknown as SuperTabState
      const contributed = other.agents.find(a => a.id === target.id && a.machineOwnerId === target.machineOwnerId)
      return contributed ? [scopeId(other, agentProjectId(other, contributed))] : []
    })
  }
  if (prior?.privateScope && prior.privateScope !== scope ||
    project.visibility === 'private' && scopes.some(id => id !== scope)) {
    fail('PROJECT_SESSION', 'This terminal has been shared with another project. Start a new agent for private work.')
  }
  const data = { scopeIds: [...new Set([...scopes, scope])],
    privateScope: prior?.privateScope ?? (project.visibility === 'private' ? scope : null) }
  if (prior) await tx.superTabSessionScope.update({ where: { id }, data })
  else await tx.superTabSessionScope.create({ data: { id, ...data } })
}

export async function makeProjectPrivate(tx: Prisma.TransactionClient, state: SuperTabState, projectId: string) {
  const scope = scopeId(state, projectId)
  for (const target of state.agents.filter(a => agentProjectId(state, a) === projectId)) await bindSession(tx, state, target)
  const bindings = await tx.superTabSessionScope.findMany({ where: { scopeIds: { has: scope } } })
  if (bindings.some(b => b.scopeIds.some(id => id !== scope))) {
    fail('PROJECT_SESSION', 'An agent terminal from this project was shared elsewhere. Create a new private project for private work.')
  }
  await tx.superTabSessionScope.updateMany({ where: { scopeIds: { has: scope } }, data: { privateScope: scope } })
}
