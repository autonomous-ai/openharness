/** The project's instructions as a skill every Swarm agent holds beside the Harness tools skill (spec 2026-10-30, How agents
 *  read it). The launch writes only the tools skill, since the core reads nothing from the backend; the host writes this one
 *  from the document it reads for each new revision or role, and tells the agent once per change, as refreshSwarmSkill
 *  (swarmSkills.ts) does for the role files. */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fallbackSkillName, parseSwarmSkill, type SavedSwarmSkill, type SwarmSkill } from './savedSkill.js'
import { replaceSkillFile, skillFile } from './swarmSkills.js'
import { SWARM_TOOLS_SKILL } from './swarmTools.js'

/** The document at one revision as the host read it, the newest revision's summary (null when it is not that revision, or
 *  for a Buddy) and the session's place in the project. `saved.role` tells a Buddy apart. `savedAt`: when that revision was
 *  saved, in epoch ms; null or absent when unknown (a Buddy, a failed read, the template at revision 0). */
export interface ProjectDoc {
  revision: number; text: string; summary: string | null; roleName: string; coordinatorName: string; coordinator: boolean
  savedAt?: number | null
}
/** `tools` and `instructions` are the two files' paths; `tools` is '' for a Buddy, which has no tools skill. `version` names
 *  what the files hold and `change` counts their rewrites: the notice's operation id is made of both. */
export interface ProjectSkillsRefresh { tools: string; instructions: string; version: string; owed: boolean; change: number; notice: string }

const DESCRIPTION = 'This project\'s instructions: its roles, workflow and routing, and your role in them. Read before any project work.'

/** The document verbatim, under one line naming the session's role. The description is quoted: it holds a colon. */
export function instructionsSkillText(doc: ProjectDoc): string {
  const role = doc.coordinator
    ? `You are this project's ${doc.roleName}, its coordinator: people talk to you when they address no one, and you receive the server's notices.`
    : `You are this project's ${doc.roleName}. ${doc.coordinatorName} is the project's coordinator.`
  return `---\nname: swarm-instructions\ndescription: ${JSON.stringify(DESCRIPTION)}\n---\n${role}\n\nInstructions revision ${doc.revision}:\n\n${doc.text}`
}

/** What the two files hold (each by its text's sha256; `tools` is '' for a Buddy), the revision and role they were written
 *  for, and how many times they were rewritten. */
interface Held { tools: string; doc: string; revision: number; roleName: string; change: number }
/** `told`: what its agent was last confirmed told, or null before anything was. */
interface ProjectRecord extends Held { told: Held | null }

/** Write the session's instructions file (and put its tools file on this release's text), and say whether its agent owes a
 *  notice for them; recordProjectSkillsNotice clears that once the notice is sent. The record moves only after the files
 *  are replaced, so an interrupted pass rewrites again and its notice stays owed. Several changes before a notice is
 *  recorded make one notice, naming all that changed since the last one told. Null when the workspace is gone. */
export function refreshProjectSkills(workspace: string, saved: SavedSwarmSkill, doc: ProjectDoc): ProjectSkillsRefresh | null {
  // A row from before role kinds names the wire's role values: read as this release keeps it.
  const skill = parseSwarmSkill(saved)
  if (!skill) throw new Error('A Swarm skill needs a role and session key')
  // A removed worktree has nothing to refresh; the host would otherwise retry and log it every minute.
  if (!existsSync(workspace)) return null
  const root = realpathSync(workspace)
  // Every folder and file is checked before anything is written: a redirected one refuses the whole pass.
  const instructions = skillFile(root, skill, 'swarm-instructions', true)!
  const tools = skill.role === 'buddy' ? null : skillFile(root, skill, 'swarm-tools', true)!
  const hasInstructions = held(instructions), hasTools = tools !== null && held(tools)
  const old = readRecord(dirname(instructions))
  // The launch's tools record says this release launched the session, whose launch line sent it to the instructions command.
  const launch = old || !tools ? null : readLaunch(dirname(tools))
  const text = instructionsSkillText(doc)
  const now = { tools: tools ? textVersion(SWARM_TOOLS_SKILL) : '', doc: textVersion(text), revision: doc.revision, roleName: doc.roleName }
  if (!old || old.doc !== now.doc || !hasInstructions) replaceSkillFile(instructions, text)
  // A tools file the agent edited is kept until the release changes its text, as role files are.
  if (tools && (!hasTools || (old ? old.tools : launch?.text) !== now.tools)) replaceSkillFile(tools, SWARM_TOOLS_SKILL)
  let record: ProjectRecord
  if (!old) {
    // The first install. After this release's launch the agent has read the tools skill, unless its text changed since, and
    // the instructions as the instructions command printed them at launch: only a revision saved by then (or the template,
    // revision 0) counts as read. A backend too old to answer the command at launch, or a save before this first install,
    // left it on its role file or an earlier revision (task 3 review): that is the first rewrite, told as a change. A
    // session launched before this release, or a Buddy, has been told nothing yet.
    const read = doc.revision === 0 || (launch !== null && typeof doc.savedAt === 'number' && doc.savedAt <= launch.at)
    const told = launch ? { ...now, tools: launch.notified, ...(read ? {} : { doc: '', revision: 0 }), change: 0 } : null
    record = { ...now, change: told?.tools === now.tools && told.doc === now.doc ? 0 : 1, told }
    writeRecord(dirname(instructions), record)
  } else if (old.tools !== now.tools || old.doc !== now.doc || old.revision !== now.revision || old.roleName !== now.roleName) {
    record = { ...now, change: old.change + 1, told: old.told }
    writeRecord(dirname(instructions), record)
  } else record = old
  return { tools: tools ?? '', instructions, version: versionOf(record), owed: record.told?.change !== record.change, change: record.change,
    notice: noticeOf(record, skill, doc, instructions, tools) }
}

/** The notice for that refresh was sent. Only a record still holding what it described is marked told: a later rewrite stays
 *  owed, and its notice names everything since the last confirmed one. */
export function recordProjectSkillsNotice(workspace: string, saved: SavedSwarmSkill, sent: Pick<ProjectSkillsRefresh, 'version' | 'change'>): void {
  if (!existsSync(workspace)) return
  const file = skillFile(realpathSync(workspace), saved, 'swarm-instructions', false)
  const record = file && readRecord(dirname(file))
  if (!file || !record || record.change !== sent.change || versionOf(record) !== sent.version) return
  const { told: _told, ...state } = record
  writeRecord(dirname(file), { ...state, told: state })
}

const q = (path: string) => JSON.stringify(path)
function noticeOf(record: ProjectRecord, skill: SwarmSkill, doc: ProjectDoc, instructions: string, tools: string | null): string {
  const told = record.told
  if (!told) {
    return tools ? `Harness now gives you two skills in place of your ${fallbackSkillName(skill)} skill: ${q(tools)}, Harness's Swarm commands, and ${q(instructions)}, this project's instructions and your role in them. Before your next step, read both and work by them.`
      : `Your project's instructions are at ${q(instructions)}: read them as your member's helper; they do not change your limits.`
  }
  const revised = told.revision !== record.revision, renamed = told.roleName !== record.roleName, updated = told.tools !== record.tools
  // Anything else in the file (the coordinator, a release's layout of it), or a change back to what was last confirmed told
  // (a notice sent but never recorded may have told the agent something else), is told as a change of the instructions.
  const changed = revised || (!renamed && (told.doc !== record.doc || !updated))
  const summary = revised ? doc.summary?.trim() : ''
  const parts = [
    ...(changed ? [summary ? `The project's instructions changed: ${/[.!?]$/.test(summary) ? summary : `${summary}.`}` : 'The project\'s instructions changed.'] : []),
    ...(renamed ? [`You are now this project's ${record.roleName}.`] : []),
    ...(updated ? ['Harness updated your swarm-tools skill.'] : []),
  ]
  const reread = [...(changed || renamed || told.doc !== record.doc ? [instructions] : []), ...(updated && tools ? [tools] : [])]
  return `${parts.join(' ')} Before your next step, read ${reread.map(q).join(' and ')} again and work by ${reread.length > 1 ? 'them' : 'it'}.`
}

const textVersion = (text: string) => createHash('sha256').update(text).digest('hex')
/** The notice's id names exactly what the files hold. */
const versionOf = (state: Held) => textVersion(JSON.stringify([state.tools, state.doc, state.revision, state.roleName]))
/** Whether the file exists; anything but a plain file (a link planted in its place) refuses the pass, as for the role file. */
function held(file: string): boolean {
  let stat
  try { stat = lstatSync(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Swarm skill is not a plain file: ${file}`)
  return true
}
const readJson = (file: string): unknown => held(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
const heldOf = (value: unknown): Held | null => {
  const state = (value ?? {}) as Partial<Held>
  return typeof state.tools === 'string' && typeof state.doc === 'string' && Number.isSafeInteger(state.revision)
    && typeof state.roleName === 'string' && Number.isSafeInteger(state.change)
    ? { tools: state.tools, doc: state.doc, revision: state.revision as number, roleName: state.roleName, change: state.change as number } : null
}
function readRecord(dir: string): ProjectRecord | null {
  const value = readJson(join(dir, 'version.json')), state = heldOf(value)
  return state && { ...state, told: heldOf((value as { told?: unknown }).told) }
}
/** The tools record prepareSwarmSkill writes when it creates the tools file at launch (swarmSkills.ts). Nothing rewrites it,
 *  so its mtime (`at`) is the launch's time. */
function readLaunch(dir: string): { text: string; notified: string; at: number } | null {
  const file = join(dir, 'version.json')
  const value = (readJson(file) ?? {}) as { text?: unknown; notified?: unknown }
  return typeof value.text === 'string' && typeof value.notified === 'string'
    ? { text: value.text, notified: value.notified, at: lstatSync(file).mtimeMs } : null
}
function writeRecord(dir: string, record: ProjectRecord): void {
  replaceSkillFile(join(dir, 'version.json'), JSON.stringify(record))
}
