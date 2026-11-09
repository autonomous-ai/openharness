import type { Prisma } from '@prisma/client'
import { fail, stableId, type Agent, type SuperTabState } from './model.js'
import { agentProjectId, projectOf } from './projects.js'
import { isSwarmBuddy } from './buddies.js'

const scopeId = (state: SuperTabState, projectId: string) => stableId(state.id, projectId)
/** The scope of a Swarm-wide Buddy's session: no project's id. */
const SWARM_BUDDY_SCOPE = 'swarm-buddy'
const REGULAR_SCOPE = 'regular-agent'

/** The record every Swarm registering one native session writes. */
export const sessionRecordId = (state: SuperTabState, target: Agent) => stableId('swarm-session', state.environment, target.machineOwnerId, target.id)

export async function bindSession(tx: Prisma.TransactionClient, state: SuperTabState, target: Agent, now = Date.now()) {
  // A Swarm-wide Buddy is in no project (Dee, 10-31): its session is bound to the Swarm's Buddy scope, which no project shares.
  // So is a Regular agent, whose task decides its project (task #4116): its session keeps one scope of its own whatever task it holds.
  const project = isSwarmBuddy(target) ? { id: SWARM_BUDDY_SCOPE, visibility: 'public' as const }
    : target.regular ? { id: REGULAR_SCOPE, visibility: 'public' as const } : projectOf(state, agentProjectId(state, target))
  const scope = scopeId(state, project.id)
  const id = sessionRecordId(state, target)
  const prior = await tx.superTabSessionScope.findUnique({ where: { id } })
  if (prior?.releasedTabIds.includes(state.id)) fail('SESSION_RELEASED', 'This session was withdrawn while stopping in this Swarm. Start a new Harness here or use it in another Swarm.')
  if (prior?.closeLeaseUntil && prior.closeLeaseUntil.getTime() > now) fail('CLOSE_PENDING', 'Another Swarm is stopping this session. Wait up to two minutes, then try again.')
  // A stop this Swarm no longer has (withdrawn, agentStops.ts) leaves its marks behind; they hold only while its agent is stopping
  // here and the session is no other Swarm's (Swarm v4 hotfix, 2026-11-09: people's agents refused every message).
  const stale = target.workDecision !== 'stop' && (prior?.scopeIds ?? []).every(other => other === scope)
  if (prior?.stopReleaseId && stale) {
    await tx.superTabSessionScope.update({ where: { id }, data: { stopReleaseId: null } })
    prior.stopReleaseId = null
  }
  if (prior?.stopReleaseId) fail('STOP_REQUESTED', 'This session is stopping. Wait for its host or withdraw it before contributing another session.')
  let running = await tx.superTabRun.findUnique({ where: { id: target.id } })
  if (running?.assignmentId.startsWith('release-') && running.tabId === state.id && target.workDecision !== 'stop') {
    await tx.superTabRun.delete({ where: { id: target.id } })
    running = null
  }
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
