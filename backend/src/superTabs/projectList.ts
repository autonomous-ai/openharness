/**
 * The projects a person may pick a main project from, in Cmd-N and when joining (task #4540; spec
 * 2026-11-07-members-and-leads, section 1): each readable project with what it is and its Lead, and the row that starts
 * picked. Worked out from the projects and their chats, so the read loads nothing beyond the Swarm's first load.
 */
import type { Actor, SuperTabState } from './model.js'
import { canReadProject, projectGitHub, projectsOf } from './projects.js'

export interface ProjectRow {
  id: string
  name: string
  /** Its own one line (project.about), or null: the form then shows `repositoryName`, sent only then. */
  about: string | null
  repositoryName: string | null
  lead: { agentId: string; name: string } | null
  /** Tasks in Next up, which an older app still reads: always 0, since a task is the project's GitHub issue (Swarm v4,
   *  2026-11-10). Goes on or after 2026-12-10. */
  waiting: 0
}
export interface ProjectList { projects: ProjectRow[]; pick: string | null }

/** [actor]'s readable projects A to Z, with [invitedTo] at the top when they read it; the top one is picked. */
export function projectList(state: SuperTabState, actor: Actor, invitedTo?: string): ProjectList {
  const projects = projectsOf(state).filter(project => canReadProject(state, actor, project)).map((project): ProjectRow => {
    const leadId = state.conversations.find(c => c.id === project.leadConversationId)?.leadId
    const lead = leadId ? state.agents.find(a => a.id === leadId) : undefined
    return { id: project.id, name: project.name, about: project.about ?? null,
      repositoryName: project.about ? null : projectGitHub(project)?.name ?? null,
      lead: lead ? { agentId: lead.id, name: lead.displayName ?? lead.name } : null, waiting: 0 }
  })
  projects.sort((a, b) => a.name.localeCompare(b.name))
  const invited = projects.findIndex(row => row.id === invitedTo)
  if (invited > 0) projects.unshift(...projects.splice(invited, 1))
  return { projects, pick: projects[0]?.id ?? null }
}
