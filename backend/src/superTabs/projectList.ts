/**
 * The projects a person may pick a main project from, in Cmd-N and when joining (task #4540; spec
 * 2026-11-07-members-and-leads, section 1): each readable project with what it is, its Lead and how many tasks wait, and the
 * row that starts picked. Worked out from the projects and the pulse stored on each project's chat (pulse.ts), so the read
 * loads nothing beyond the Swarm's first load and its project chats.
 */
import { githubRepository } from '../github/repository.js'
import type { Actor, SuperTabState } from './model.js'
import { canReadProject, projectsOf } from './projects.js'
import { pmOf, storedPulse } from './pulse.js'

export interface ProjectRow {
  id: string
  name: string
  /** Its own one line (project.about), or null: the form then shows `repositoryName`, sent only then. */
  about: string | null
  repositoryName: string | null
  lead: { agentId: string; name: string } | null
  /** Tasks in Next up: approved, and nobody on them yet. */
  waiting: number
}
export interface ProjectList { projects: ProjectRow[]; pick: string | null }

/** [actor]'s readable projects, the one to pick first at the top: [invitedTo] when they read it, else the one that needs help
 *  most (the most waiting tasks for each Member working there, then the most waiting, then A to Z). */
export function projectList(state: SuperTabState, actor: Actor, invitedTo?: string): ProjectList {
  const rows = projectsOf(state).filter(project => canReadProject(state, actor, project)).map(project => {
    const pulse = storedPulse(state, project)
    const leadId = pmOf(state, project)
    const lead = leadId ? state.agents.find(a => a.id === leadId) : undefined
    const row: ProjectRow = { id: project.id, name: project.name, about: project.about ?? null,
      repositoryName: project.about ? null : githubRepository(project.repository?.repositoryUrl)?.name ?? null,
      lead: lead ? { agentId: lead.id, name: lead.name } : null, waiting: pulse?.nextUp.count ?? 0 }
    return { row, perMember: perMember(row.waiting, pulse?.working.crew ?? 0) }
  })
  rows.sort((a, b) => b.perMember - a.perMember || b.row.waiting - a.row.waiting || a.row.name.localeCompare(b.row.name))
  const invited = rows.findIndex(r => r.row.id === invitedTo)
  if (invited > 0) rows.unshift(...rows.splice(invited, 1))
  const projects = rows.map(r => r.row)
  return { projects, pick: projects[0]?.id ?? null }
}

/** Waiting tasks for each Member working there; a project where tasks wait and nobody works needs help before any other. */
const perMember = (waiting: number, members: number): number => members ? waiting / members : waiting ? Infinity : 0
