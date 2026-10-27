import type { Prisma } from '@prisma/client'
import { fail, stableId, type Agent, type SuperTabState } from './model.js'
import { agentProjectId, projectOf } from './projects.js'

const scopeId = (state: SuperTabState, projectId: string) => stableId(state.id, projectId)

/** The record every Swarm registering one native session writes. */
export const sessionRecordId = (state: SuperTabState, target: Agent) => stableId('swarm-session', state.environment, target.machineOwnerId, target.id)

export async function bindSession(tx: Prisma.TransactionClient, state: SuperTabState, target: Agent, now = Date.now()) {
  const project = projectOf(state, agentProjectId(state, target))
  const scope = scopeId(state, project.id)
  const id = sessionRecordId(state, target)
  const prior = await tx.superTabSessionScope.findUnique({ where: { id } })
  if (prior?.releasedTabIds.includes(state.id)) fail('SESSION_RELEASED', 'This session was withdrawn while stopping in this Swarm. Start a new Harness here or use it in another Swarm.')
  if (prior?.closeLeaseUntil && prior.closeLeaseUntil.getTime() > now) fail('CLOSE_PENDING', 'Another Swarm is stopping this session. Wait up to two minutes, then try again.')
  if (prior?.stopReleaseId) fail('STOP_REQUESTED', 'This session is stopping. Wait for its host or withdraw it before contributing another session.')
  const running = await tx.superTabRun.findUnique({ where: { id: target.id } })
  if (running?.assignmentId.startsWith('release-')) fail('STOP_REQUESTED', 'This session is stopping. Wait for its host or force-withdraw it before contributing another session.')
  let scopes = prior?.scopeIds ?? []
  if (!prior) {
    // Sessions contributed before project privacy existed may already appear
    // in more than one tab. Inspect those registrations before binding one.
    const rows = await tx.swarmAgent.findMany({ where: { key: target.id, machineOwnerId: target.machineOwnerId, deleted: false } })
    scopes = rows.map(row => stableId(row.tabId, (row.data as unknown as Agent).projectId ?? 'lead'))
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
  for (const target of state.agents.filter(a => agentProjectId(state, a) === projectId && a.workDecision !== 'stop')) await bindSession(tx, state, target)
  const bindings = await tx.superTabSessionScope.findMany({ where: { scopeIds: { has: scope } } })
  if (bindings.some(b => b.scopeIds.some(id => id !== scope))) {
    fail('PROJECT_SESSION', 'An agent terminal from this project was shared elsewhere. Create a new private project for private work.')
  }
  await tx.superTabSessionScope.updateMany({ where: { scopeIds: { has: scope } }, data: { privateScope: scope } })
}
