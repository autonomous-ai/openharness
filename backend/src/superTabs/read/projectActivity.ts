/** The Projects list's activity (task #4662): each readable project's tasks shipped per day for four weeks, drawn as a
 *  sparkline, and when it last moved ("Updated 2 minutes ago"). Read by read/service.ts projectActivity. */
import type { Actor, Conversation, SuperTabState } from '../model.js'
import { canReadGroup, canReadProject, projectsOf, type SwarmProject } from '../projects.js'
import { shippedAt } from '../ship.js'
import { isStep } from '../steps.js'
import { DAY_MS } from '../leaderboard/week.js'

/** The days a project's sparkline spans, today the last. */
export const ACTIVITY_DAYS = 28

export interface ProjectActivity {
  projectId: string
  /** Tasks shipped on each UTC day, oldest first, the last being `through`. */
  shipped: number[]
  /** When its newest readable conversation was last active (ms), null with none. */
  updatedAt: number | null
}

export interface ProjectActivities { through: string; projects: ProjectActivity[] }

/** The projects [actor] reads, in the Swarm's order. */
export const readableProjects = (state: SuperTabState, actor: Actor): SwarmProject[] =>
  projectsOf(state).filter(p => canReadProject(state, actor, p))

/** Each project [actor] reads, from [groups]: the Swarm's live conversations and its dormant ones of the window, each with its
 *  `lastActivityAt`. A task counts on the day of its first Done (ship.ts shippedAt); a step, a project's chat, and a Buddy,
 *  agent or Leads chat never do. A conversation the reader cannot read counts for nothing. */
export function projectActivity(state: SuperTabState, actor: Actor, groups: readonly Conversation[], now: number): ProjectActivities {
  const today = Math.floor(now / DAY_MS), first = today - (ACTIVITY_DAYS - 1)
  const projects = readableProjects(state, actor)
  const rows = new Map(projects.map(p => [p.id, { projectId: p.id, shipped: new Array<number>(ACTIVITY_DAYS).fill(0), updatedAt: null as number | null }]))
  const chats = new Set(projects.map(p => p.leadConversationId))
  for (const group of groups) {
    // A conversation of a kind (Buddy, agent or Leads chat) is a person's or the Swarm's, not a project's work.
    const row = !group.kind ? rows.get(group.projectId ?? 'lead') : undefined
    if (!row || !canReadGroup(state, actor, group)) continue
    const active = group.lastActivityAt ? Date.parse(group.lastActivityAt) : NaN
    if (active > (row.updatedAt ?? Number.NEGATIVE_INFINITY)) row.updatedAt = active
    const shipped = shippedAt(group)
    if (shipped == null || isStep(group) || chats.has(group.id)) continue
    const day = Math.floor(shipped / DAY_MS) - first
    if (day >= 0 && day < ACTIVITY_DAYS) row.shipped[day]!++
  }
  return { through: new Date(today * DAY_MS).toISOString().slice(0, 10), projects: [...rows.values()] }
}
