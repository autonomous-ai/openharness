/**
 * A project's instructions (design docs/plans/2026-10-30-project-instructions-design.md): one Markdown document that says how
 * the project works, with its last revisions, the coordinator's notes beside it, and the role names agents carry. The text
 * lives outside the Swarm state (store.ts, SuperTabInstructions), as custom role texts do: the state keeps only the
 * project's revision and hash, so reads stay light and agents know when to read it again. Nothing here parses the text.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { agentRole, fail, type Agent, type SuperTabState } from './model.js'
import { agentSetRole, agentProjectId, ledProject, projectsOf, skillSetOf, type SwarmProject } from './projects.js'
import { isBuddy } from './buddies.js'
import { INSTRUCTIONS_TEMPLATE } from './instructionsTemplate.js'

/** One role's text could already be 64 KB (commands.ts role); the whole document keeps that limit. Only saves check it: the
 *  migration never cuts what a team already wrote. */
export const MAX_INSTRUCTIONS_BYTES = 65_536
/** Revisions kept per project, the current one included; an older one goes on the next save. */
export const MAX_REVISIONS = 50
/** Live notes per project; an expired one does not count and goes on the next note write. */
export const MAX_NOTES = 100
/** What the coordinator is called until the project says otherwise (leadStart.ts LEAD_NAME). */
export const DEFAULT_COORDINATOR_NAME = 'Product Manager'

/** The short hash the state keeps beside the revision: agents compare it, never the text. */
export const instructionsHash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** A new project's state: revision 1, a copy of the template (design: a copy, so the team edits its own). */
export const FIRST_INSTRUCTIONS = { instructionsRevision: 1, instructionsHash: instructionsHash(INSTRUCTIONS_TEMPLATE) } as const
export const FIRST_SUMMARY = 'Started from the built-in instructions.'

/** What a save hands the store: the document's new revision and who wrote it. `writtenBy` is a person or the coordinator,
 *  `askedBy` the member whose words it carries (design Identity: never the machine owner's login). */
export interface InstructionsWrite {
  projectId: string
  revision: number
  hash: string
  text: string
  summary: string
  /** `system` only for the migration's revision 1 (migration/instructions.ts). */
  writtenBy: { kind: 'person' | 'agent' | 'system'; id: string }
  askedBy: string
  at: number
}

/** A note the coordinator keeps (design, PM notes). Times in epoch ms; `expiresAt` null when it lasts until removed. */
export interface PmNote { id: string; text: string; askedBy: string; at: number; expiresAt: number | null }
/** What a note command hands the store: the note kept, or the one removed. Expired ones go with either (store.ts). */
export interface NotesWrite { projectId: string; add?: PmNote; removeId?: string }
/** The notes still in force at [now]: an expired one is never read, and the next note write deletes it. */
export const liveNotes = <T extends Pick<PmNote, 'expiresAt'>>(notes: readonly T[], now: number): T[] =>
  notes.filter(n => n.expiresAt === null || n.expiresAt > now)

export const roleNameSchema = z.string().trim().min(1).max(40)
export const instructionsTextSchema = z.string().min(1)
  .refine(value => Buffer.byteLength(value) <= MAX_INSTRUCTIONS_BYTES, 'Project instructions are at most 64 KB.')
/** One line: it is posted in the project chat as it is. */
export const summarySchema = z.string().trim().min(1).max(200).regex(/^[^\r\n]*$/, 'Summarize the change in one line.')
export const noteTextSchema = z.string().trim().min(1).max(300)
/** The summary of an older client's routing line: `Routing: <its words>` on one line, cut to a summary's 200 characters. */
export function routingSummary(line: string): string {
  const summary = `Routing: ${line.trim().replace(/\s+/g, ' ')}`
  return summary.length <= 200 ? summary : `${summary.slice(0, 199).trimEnd()}…`
}

/** A second-level `## Routing` heading line. */
const ROUTING_HEADING = /^##[ \t]+Routing[ \t]*$/m

/** [text] with [line] as one more item at the end of its first `## Routing` section (before the next `## ` heading), or in a
 *  Routing section added at the end: where an older client's rule.set lands (project instructions, phase 4, decision 3).
 *  The rule's words stay one line, so they never open a paragraph or a section. Past MAX_INSTRUCTIONS_BYTES nothing is
 *  written: INSTRUCTIONS_FULL. */
export function appendRouting(text: string, line: string): string {
  const item = `- ${line.trim().replace(/\s*[\r\n]+\s*/g, ' ')}`
  const heading = ROUTING_HEADING.exec(text)
  let next: string
  if (!heading) next = `${text.replace(/\s+$/, '')}\n\n## Routing\n\n${item}\n`
  else {
    const bodyStart = heading.index + heading[0].length
    const at = text.slice(bodyStart).search(/\n##[ \t]/)
    const end = at < 0 ? text.length : bodyStart + at + 1
    const before = text.slice(0, end).replace(/\s+$/, ''), after = text.slice(end)
    // An empty section takes its first item after a blank line, as a section's body starts.
    const separator = before.length <= bodyStart ? '\n\n' : '\n'
    next = after ? `${before}${separator}${item}\n\n${after}` : `${before}${separator}${item}\n`
  }
  if (Buffer.byteLength(next) > MAX_INSTRUCTIONS_BYTES) {
    fail('INSTRUCTIONS_FULL', 'Project instructions are at most 64 KB, so this routing line was not added. Shorten them first.', 409)
  }
  return next
}

export const coordinatorNameOf = (project: Pick<SwarmProject, 'coordinatorName'>): string => project.coordinatorName ?? DEFAULT_COORDINATOR_NAME

/** The role name [target] goes by: the one it was started in, else what it is. A Buddy keeps its own role; the coordinator
 *  is the template's PM; an agent of a custom role set its role's name (the migration's rule, design Migration); any other
 *  is a Reviewer or an Engineer by its kind. Read only, so agents from before role names need no write. */
export function roleNameOf(state: SuperTabState, target: Agent): string {
  if (target.roleName) return target.roleName
  if (isBuddy(target)) return 'Buddy'
  const project = projectsOf(state).find(p => p.id === agentProjectId(state, target))
  const custom = project && skillSetOf(project) === 'custom' ? agentSetRole(state, project, target) : null
  if (custom) return custom.name
  if (ledProject(state, target.id)) return 'PM'
  return agentRole(target) === 'reviewer' ? 'Reviewer' : 'Engineer'
}

/** The role name an older client's start, addition or assignment means, which sends a kind or a custom role instead of one:
 *  that custom role's name, else "Reviewer" for a Reviewer's kind. Undefined for a Builder's kind or neither, which
 *  roleNameOf reads as it reads any agent without a name (project instructions, phase 4, decision 2). */
export function legacyRoleName(project: Pick<SwarmProject, 'roles'>, given: { role?: 'builder' | 'reviewer'; roleId?: string | null }): string | undefined {
  const custom = given.roleId ? project.roles?.find(r => r.id === given.roleId) : undefined
  return custom?.name ?? (given.role === 'reviewer' ? 'Reviewer' : undefined)
}
