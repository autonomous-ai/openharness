import { describe, expect, it } from 'vitest'
import { freeze } from './cache.js'
import { agentForBuddy, agentWithoutMachine, author, awaitingWorkers, groupWithoutMachines, isLeads, machineHiddenFrom, numberConversations,
  otherProjectsWork, seenMachineIds, syncLeads, visibleState, withSeenRequirement, type Actor, type Agent, type Person, type SuperTabState } from './model.js'
import { assignAgentDisplayNames } from './agentNames.js'
import { withAvatarView } from './profile.js'
import { swarmUsernames } from './usernames.js'
import { downSince, expireRemovals, startPreparing } from './machines.js'
import { publicReason, readsRawReason } from './startFailure.js'
import { agentProjectId, agentSetRole, canReadAgent, canReadGroup, canReadProject, ledProject, placeRules, projectsOf, skillSetOf } from './projects.js'
import { fullSwarm, NOW, outsider, owner, peer } from './read/fixture.test-support.js'

// visibleState before DB roadmap 2.6: the reference for the reader test below. Delete once that PR has merged.
function visibleStateBefore(state: SuperTabState, actor: Actor, now = Date.now()): SuperTabState {
  author(state, actor)
  const visible = structuredClone(state)
  // A Buddy-only machine is no machine of the Swarm to anyone, its own person included (machines.ts buddyOnly): their Buddy
  // shows as a Buddy, and their machine stays theirs. Machines, status and the leaderboard's lent hours all read this.
  if (visible.machines) visible.machines = visible.machines.filter(m => !m.buddyOnly)
  // Nor its id, which a Buddy's row carries (machineHiddenFrom).
  visible.agents = visible.agents.map(a => machineHiddenFrom(state, actor, a) ? agentWithoutMachine(a) : a)
  // A dormant conversation is read on demand, never in a whole-Swarm read (spec, Archive); a command may still load one.
  visible.conversations = visible.conversations.filter(c => !c.dormant)
  syncLeads(visible)
  // People and Leads read the Leads conversation; it is not there for any other agent.
  if (actor.kind === 'agent' && !ledProject(visible, actor.agentId)) {
    visible.conversations = visible.conversations.filter(c => !isLeads(c))
    delete visible.leadsConversationId
  }
  assignAgentDisplayNames(visible.agents)
  const led = actor.kind === 'agent' ? ledProject(visible, actor.agentId) : undefined
  if (led) visible.otherProjectsWork = otherProjectsWork(visible, led)
  for (const target of visible.agents) {
    const since = downSince(state, target, now)
    if (since) target.downSince = since
    delete target.downNamed
    if (target.limitedUntil && Date.parse(target.limitedUntil) <= now) target.limitedUntil = null
  }
  visible.buddies = true
  delete visible.sharing
  delete visible.harnessReservations
  delete visible.releasedHarnesses
  delete visible.overlapAlerts
  // Only that machine's host roster lists them (read/hostRows.ts); a removed private agent's session is not every member's.
  delete visible.closingSessions
  // A failing privacy check's detail is its contributor's: an error from the check can name paths on their Mac. Everyone
  // else reads which item failed (machines.ts teamWorkRefusal).
  for (const pool of visible.machines ?? []) {
    const privacy = pool.observation?.privacy
    if (privacy && 'detail' in privacy && !(actor.kind === 'person' && actor.userId === pool.contributorId)) delete (privacy as { detail?: string }).detail
  }
  expireRemovals(visible, now)
  // A read never hands out the cleanup records it just applied (read/hostRows.ts delivers them to the machine's host).
  delete visible.machineCleanups
  delete visible.parkedConversations
  numberConversations(visible)
  delete visible.retiredConversationNumber
  delete visible.groupCounter
  delete visible.sequenceBase
  placeRules(visible)
  if (visible.rules) visible.rules = visible.rules.filter(r => projectsOf(state).some(p => p.id === r.projectId && canReadProject(state, actor, p)))
  if (visible.projects) {
    visible.projects = visible.projects.filter(p => canReadProject(state, actor, p))
    visible.conversations = visible.conversations.filter(c => isLeads(c) || canReadGroup(state, actor, c))
    visible.agents = visible.agents.filter(a => canReadAgent(state, actor, a))
    for (const group of visible.conversations.filter(isLeads)) group.agentIds = group.agentIds.filter(id => visible.agents.some(a => a.id === id))
    visible.starts = visible.starts?.filter(s => visible.conversations.some(c => c.id === s.request.conversationId))
    if (!visible.projects.some(p => p.id === 'lead')) {
      delete visible.project
      visible.machines = visible.machines?.filter(m => m.scope === 'swarm')
    }
    const harnesses = new Set([...visible.agents.map(a => a.harnessId), ...(visible.starts ?? []).flatMap(s => s.harnessId ? [s.harnessId] : [])])
    for (const pool of visible.machines ?? []) {
      if (!pool.observation) continue
      pool.observation.runningHarnessIds = pool.observation.runningHarnessIds.filter(id => harnesses.has(id))
      pool.observation.stoppedHarnessIds = pool.observation.stoppedHarnessIds.filter(id => harnesses.has(id))
      if (pool.observation.harnessProgress) pool.observation.harnessProgress = Object.fromEntries(Object.entries(pool.observation.harnessProgress).filter(([id]) => harnesses.has(id)))
      // Each attempt's tokens are read through the cost summary (costs/read.ts), never from the machine's raw counts.
      delete pool.observation.harnessTokens
      if (pool.observation.stoppedReservations) pool.observation.stoppedReservations = pool.observation.stoppedReservations.filter(r => harnesses.has(r.harnessId))
      if (pool.observation.preparingStartIds) pool.observation.preparingStartIds = pool.observation.preparingStartIds.filter(id => visible.starts?.some(s => s.id === id))
    }
    for (const start of visible.starts ?? []) if (startPreparing(state, start, now)) start.preparing = true
    visible.invitations = visible.invitations.filter(i => visible.conversations.some(c => c.id === i.conversationId))
  }
  for (const project of projectsOf(visible)) for (const target of awaitingWorkers(visible, project.id)) target.workDecision = 'awaiting'
  for (const project of visible.projects ?? []) project.skillSet = skillSetOf(project)
  // An uploaded avatar's stored key stays on the server; readers get a link with each parts read (avatarLinks.ts).
  // Each person as the Swarm names them (usernames.ts), their default included.
  const names = swarmUsernames(state)
  visible.people = visible.people.map(p => ({ ...withAvatarView(p), username: names.get(p.id) })) as Person[]
  visible.agents = visible.agents.map(withAvatarView) as Agent[]
  // On Custom every agent shows the role it runs, null when its kind has none; elsewhere a role id means nothing yet.
  for (const target of visible.agents) {
    const home = projectsOf(state).find(p => p.id === agentProjectId(state, target))
    if (home && skillSetOf(home) === 'custom') target.roleId = agentSetRole(state, home, target)?.id ?? null
    else delete target.roleId
  }
  if (actor.kind !== 'person' || actor.userId !== state.ownerId) visible.invitations = []
  for (const start of visible.starts ?? []) {
    if (start.error && !readsRawReason(actor, start, state.conversations.find(c => c.id === start.request.conversationId))) start.error = publicReason(start.error)
  }
  // A Buddy brainstorms; where agents run and how work is routed are none of its business (buddies.ts). A start names the
  // machine and the folder on it, so it reads none, though it reads their workgroups.
  if (actor.kind === 'agent' && state.agents.some(a => a.id === actor.agentId && a.buddyOf)) {
    visible.machines = []
    visible.starts = []
    visible.agents = visible.agents.map(a => agentForBuddy(a, actor.agentId))
    visible.conversations = visible.conversations.map(groupWithoutMachines)
    // A project's repository names the machine and folder it was made from; the address is all a Buddy needs (security
    // review 2 of #2115).
    for (const project of visible.projects ?? []) if (project.repository) project.repository = { repositoryUrl: project.repository.repositoryUrl } as typeof project.repository
    // Where its Product Manager runs names the machine and its start: a Buddy reads how it stands, and why it failed, which
    // names no machine (leadStart.ts leadStartFailed; Diego, 10-30).
    for (const project of visible.projects ?? []) {
      const lead = project.lead
      if (lead) project.lead = { status: lead.status, ...(lead.reason !== undefined ? { reason: lead.reason } : {}) } as typeof lead
    }
    if (visible.project) visible.project = { repositoryUrl: visible.project.repositoryUrl } as typeof visible.project
    delete visible.rules
    delete visible.routingPolicy
  }
  const seen = seenMachineIds(visible)
  visible.conversations = visible.conversations.map(c => withSeenRequirement(c, seen))
  return visible
}

const stranger: Actor = { kind: 'person', userId: '100000000000000000000009', email: 'stranger@example.com' }
const agentActor = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: `${owner.userId}-machine` })
const s = fullSwarm()
const readers: Array<[string, Actor]> = [['the owner', owner], ['a member of the private project', peer], ['a member outside it', outsider],
  ['a Buddy', agentActor(s.buddy)], ['a worker', agentActor(s.worker)], ['a Lead', agentActor(s.lead)]]

describe('visibleState', () => {
  it('exercises what it compares', () => {
    const state = s.state
    for (const field of ['sharing', 'harnessReservations', 'releasedHarnesses', 'overlapAlerts', 'closingSessions'] as const) expect(state[field], field).toBeDefined()
    expect(state.conversations.some(c => c.dormant)).toBe(true)
    expect(visibleStateBefore(state, owner, NOW).projects!.some(p => p.progress)).toBe(true)
    expect(visibleStateBefore(state, peer, NOW).projects!.map(p => p.id)).toContain(s.secret)
    expect(visibleStateBefore(state, outsider, NOW).projects!.map(p => p.id)).not.toContain(s.secret)
    expect(visibleStateBefore(state, agentActor(s.buddy), NOW).machines).toEqual([])
  })

  it.each(readers)('reads the same as before for %s', (_name, actor) => {
    const now = visibleState(s.state, actor, NOW), before = visibleStateBefore(s.state, actor, NOW)
    expect(now).toStrictEqual(before)
    expect(JSON.stringify(now)).toBe(JSON.stringify(before))
  })

  it('refuses someone outside the Swarm as before', () => {
    const code = (read: () => unknown) => { try { read(); return null } catch (error) { return (error as { code?: string }).code } }
    expect(code(() => visibleState(s.state, stranger, NOW))).toBe(code(() => visibleStateBefore(s.state, stranger, NOW)))
    expect(code(() => visibleState(s.state, stranger, NOW))).toBeTruthy()
  })

  it('reads a frozen, shared state as before and leaves it untouched', () => {
    const frozen = structuredClone(s.state)
    freeze(frozen)
    for (const actor of [owner, agentActor(s.worker)]) expect(visibleState(frozen, actor, NOW)).toStrictEqual(visibleStateBefore(structuredClone(s.state), actor, NOW))
  })

  it('fails loudly on a value it cannot copy', () => {
    expect(() => visibleState({ ...s.state, stray: new Map() } as never, owner, NOW)).toThrow(/cannot copy a Map at stray/)
  })
})
