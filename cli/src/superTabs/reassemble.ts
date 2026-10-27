/**
 * The Swarm state in the shape the full read gave it (`SuperTabState` as `visibleState` made it), built from the parts the
 * client holds, so `status`, routing, the host and the Pro cards read what they always read (design
 * 2026-10-26-swarm-state-parts sections 5.1 and 6.2; the backend's `parts/shape.ts` is the reference). `derived` carries
 * what changes without a part changing (time and values across parts) and is laid over the parts here.
 */
import type { PartsStore } from './partsStore.js'
import { object } from './wire.js'

type Json = Record<string, unknown>
/** What a group part adds to a conversation for the server's own bookkeeping; the old state never had them (design 6.2). */
const GROUP_INTERNALS = ['messageSeq', 'dormant']

const dataOf = (store: PartsStore, kind: Parameters<PartsStore['parts']['get']>[0]): Json[] =>
  [...store.parts.get(kind)?.values() ?? []].map(part => structuredClone(object(part.data)))
const highest = (floor: unknown, marks: unknown) =>
  Math.max(typeof floor === 'number' ? floor : 0, ...Object.values(object(marks)).filter((v): v is number => typeof v === 'number'))

/** A project's progress in its old fields, for reading only: dirty up to its groups' newest message (a reader is not sent the
 *  server's per-group report mark, which leaves out hold and stop notices), summarized and requested up to the furthest
 *  mark the Lead's reports and the wake-ups reached. */
function progressOf(stored: Json, projectId: unknown, leadConversationId: unknown, groups: Json[]): Json {
  const reported = groups.filter(g => g.projectId === projectId && g.id !== leadConversationId && g.kind !== 'leads')
    .map(g => typeof g.lastMessageSequence === 'number' ? g.lastMessageSequence : 0)
  return { since: stored.since, dirtyRevision: Math.max(0, ...reported),
    summarizedRevision: highest(stored.summarizedFloor, stored.summarized), requestedRevision: highest(stored.requestedFloor, stored.requested),
    ...(typeof stored.requestedAt === 'number' ? { requestedAt: stored.requestedAt } : {}),
    ...(typeof stored.requestMessageId === 'string' ? { requestMessageId: stored.requestMessageId } : {}) }
}

/** `visibleState`'s per-agent rules: down since the computed time or not down; a limit while it lasts (a part never holds
 *  one, so one that ran out is simply absent); the stored decision unless one is derived (`awaiting`); on Custom skills the
 *  role it runs (null when its kind has none), else no role. */
function overlayAgent(agent: Json, derived: Json | undefined, projects: Json[]): Json {
  if (!derived) return agent
  if (typeof derived.downSince === 'string') agent.downSince = derived.downSince
  else delete agent.downSince
  if (typeof derived.limitedUntil === 'string') agent.limitedUntil = derived.limitedUntil
  if (typeof derived.workDecision === 'string') agent.workDecision = derived.workDecision
  if (projects.find(p => p.id === agent.projectId)?.skillSet === 'custom') agent.roleId = typeof derived.roleId === 'string' ? derived.roleId : null
  else delete agent.roleId
  return agent
}

export function reassemble(store: PartsStore): Json {
  const head = structuredClone(object(store.head?.data))
  const derived = store.derived
  const groups = dataOf(store, 'group')
  const progress = new Map([...store.parts.get('progress')?.entries() ?? []].map(([key, part]) => [key, object(part.data)]))
  const projects = Array.isArray(head.projects) ? head.projects.map(object) : null
  const state: Json = { ...head,
    people: dataOf(store, 'member'),
    agents: dataOf(store, 'agent').map(agent => overlayAgent(agent, object(derived.agents)[String(agent.id)] as Json | undefined, projects ?? [])),
    conversations: groups.map(group => Object.fromEntries(Object.entries(group).filter(([key]) => !GROUP_INTERNALS.includes(key)))),
    machines: dataOf(store, 'machine').map(machine => ({ ...machine, ...object(object(derived.machines)[String(machine.machineId)]) })),
    starts: dataOf(store, 'start') }
  if (projects) {
    state.projects = projects.map(project => {
      const stored = progress.get(String(project.id))
      return stored ? { ...project, progress: progressOf(stored, project.id, project.leadConversationId, groups) } : project
    })
  }
  if (derived.otherProjectsWork !== undefined) state.otherProjectsWork = derived.otherProjectsWork
  if (derived.mentionsWaiting !== undefined) state.mentionsWaiting = derived.mentionsWaiting
  if (derived.decisionsWaiting !== undefined) state.decisionsWaiting = derived.decisionsWaiting
  return state
}
