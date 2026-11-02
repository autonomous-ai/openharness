/**
 * The light Swarm (parts/light.ts loadLight) built in memory from parts already held, instead of read from Mongo on every
 * bump: `light` and `host:state:{m}` were 440 MB of whole reloads per 20 minutes on prod (spec 2026-11-02 poll cost,
 * Part 1.2). `projectLightGroup` is `loadLight`'s projection applied to a whole conversation; `lightSelect` is its
 * selection over candidates that include every awake conversation. integration/superTabCacheDelta.test.ts holds both equal
 * to `loadLight` after every kind of write.
 */
import { activeWork, agentRole, type Agent, type AgentStart } from '../model.js'
import { GROUP_FIELDS, lightGroup } from './light.js'
import type { GroupData, HeadData, Part, SwarmParts } from './types.js'

/** What Mongo's `$project` of LIGHT_GROUP keeps of a conversation's data: the `always` fields, and the `whenRunning` ones
 *  while its work runs. An included path under a value that is not an object is left out, as Mongo leaves it; a computed
 *  `whenRunning` path always makes its parent documents, even when it removes the value (`task: {}`). */
function projectedData(data: GroupData): Record<string, unknown> {
  const running = activeWork(data)
  const out: Record<string, unknown> = {}
  for (const path of GROUP_FIELDS.whenRunning) {
    let to = out
    for (const step of path.split('.').slice(0, -1)) to = (to[step] ??= {}) as Record<string, unknown>
  }
  for (const path of [...GROUP_FIELDS.always, ...running ? GROUP_FIELDS.whenRunning : []]) {
    const steps = path.split('.')
    let from: unknown = data, to = out
    for (const [i, step] of steps.entries()) {
      if (!from || typeof from !== 'object' || Array.isArray(from)) break
      const value = (from as Record<string, unknown>)[step]
      if (value === undefined) break
      if (i === steps.length - 1) { to[step] = value; break }
      if (!value || typeof value !== 'object' || Array.isArray(value)) break
      to = (to[step] ??= {}) as Record<string, unknown>
      from = value
    }
  }
  return out
}

/** A whole conversation as `loadLight` returns it (light.ts lightGroup over Mongo's projection). */
export function projectLightGroup(group: Part<GroupData>): Part<GroupData> {
  return lightGroup({ key: group.key, version: group.version, changedAt: group.changedAt, ordinal: group.ordinal,
    ...group.dormant ? { dormant: true } : {}, data: projectedData(group.data!) })
}

/** What `lightSelect` chooses from. `groups`: light conversations (projected), every awake one, plus the dormant ones a
 *  selection names (by id, or as a named agent's). */
export interface LightCandidates {
  tabId: string; head: Part<HeadData>; members: Part[]; agents: Part<Agent>[]; starts: Part<AgentStart>[]; groups: Part<GroupData>[]
  sequenceBase: number; visibilityEpoch: number; groupCounter: number
}
export interface LightOptions { groups?: 'active' | 'working'; groupIds?: string[]; agentIds?: string[]; projectIds?: string[] }

/** The conversations a selection names by id: with 'working', the Lead conversations and those an unfinished start or an
 *  invitation names (light.ts loadLight), and `groupIds`. A dormant one among them is a candidate only when given. */
export function lightKeys(head: Part<HeadData>, starts: Part<AgentStart>[], opts: LightOptions): string[] {
  const { projects, invitations } = head.data!
  return [...new Set([...opts.groups === 'working' ? [...projects ? projects.map(p => p.leadConversationId) : ['lead'],
    ...starts.map(s => s.data!.request.conversationId), ...invitations.map(i => i.conversationId)] : [], ...opts.groupIds ?? []])]
}

/** `loadLight(opts)` without machines (they come from their own entry), chosen from `c`. */
export function lightSelect(c: LightCandidates, opts: LightOptions): Omit<SwarmParts, 'machines'> {
  const working = opts.groups === 'working'
  const keys = new Set(lightKeys(c.head, c.starts, opts))
  const agents = new Set(opts.agentIds ?? []), projectIds = new Set(opts.projectIds ?? [])
  // A conversation stored with no project is the first project's (model.ts groupProject), as loadLight's null match reads it.
  const inProject = (g: Part<GroupData>) => g.data!.projectId ? projectIds.has(g.data!.projectId) : projectIds.has('lead')
  const awake = (g: Part<GroupData>) => !g.dormant
  const selected = new Map<string, Part<GroupData>>()
  for (const g of c.groups) {
    if ((working ? activeWork(g.data!) : awake(g)) || keys.has(g.key) || g.data!.agentIds.some(id => agents.has(id)) || (awake(g) && inProject(g))) {
      selected.set(g.key, g)
    }
  }
  if (working) {
    // As light.ts undecidedWork: busy is the Lead of a selected conversation or the worker of its active work.
    const busy = new Set([...selected.values()].flatMap(g => [...g.data!.leadId ? [g.data!.leadId] : [],
      ...activeWork(g.data!) ? [g.data!.assignment!.agentId] : []]))
    const undecided = new Set(c.agents.filter(a => !a.data!.workDecision && agentRole(a.data!) !== 'reviewer' && !busy.has(a.key)).map(a => a.key))
    const legacy = new Set(c.agents.filter(a => !a.data!.projectId).map(a => a.key))
    for (const g of c.groups) {
      if (selected.has(g.key) || !awake(g)) continue
      const d = g.data!
      const ofUndecided = (d.assignment?.agentId && undecided.has(d.assignment.agentId)) || (d.leadId && undecided.has(d.leadId))
        || d.agentIds.some(id => undecided.has(id))
      if (ofUndecided || d.agentIds.some(id => legacy.has(id))) selected.set(g.key, g)
    }
  }
  return { tabId: c.tabId, head: c.head, members: c.members, agents: c.agents, groups: [...selected.values()], starts: c.starts, progress: [],
    sequenceBase: c.sequenceBase, visibilityEpoch: c.visibilityEpoch, groupCounter: c.groupCounter } as Omit<SwarmParts, 'machines'>
}
