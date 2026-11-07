/**
 * What a Swarm agent is told about its project's instructions (task #4673): it reads them with the instructions command, and
 * when the roster names a new revision, template or role name, its host tells it once to read them again. Nothing else is
 * written for it. A session an older release launched kept skill files instead: it is told once that they are gone, and they
 * are removed. The record, per session in its Swarm folder, says what the agent was last confirmed told, so a retry, a restart
 * or a second daemon never tells it twice, and several changes before a notice make one notice.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { launchedAt, parseSwarmSkill, removeOlderSkills, replaceSkillFile, swarmFile, type SavedSwarmSkill } from '../lib/swarmSkills.js'

/** The instructions as the roster names them, and the newest revision's summary and save time (epoch ms) when the history
 *  answered (null otherwise). */
export interface InstructionsAt { tabId: string; projectId: string; revision: number; hash: string | null; roleName: string
  summary: string | null; savedAt: number | null }
/** `version` names what the roster said and `change` counts its changes: the notice's operation id is made of both. */
export interface InstructionsNotice { version: string; owed: boolean; change: number; notice: string }

interface Seen { version: string; revision: number; roleName: string }
/** `told`: what its agent was last confirmed told, or null for a session an older release launched, before it was told. */
interface NoticeRecord extends Seen { change: number; told: (Seen & { change: number }) | null }

const RECORD = 'instructions.json'

/** Say whether the session's agent owes a notice for [at]; recordInstructionsNotice clears that once the notice is sent. Null
 *  when the workspace is gone or the session is a Buddy, which reads its projects' instructions when it needs them. */
export function refreshInstructionsNotice(workspace: string, saved: SavedSwarmSkill, at: InstructionsAt): InstructionsNotice | null {
  const skill = parseSwarmSkill(saved)
  if (!skill) throw new Error('A Swarm skill needs a role and session key')
  // A removed worktree has nothing to refresh; the host would otherwise retry and log it every minute.
  if (skill.role === 'buddy' || !existsSync(workspace)) return null
  const file = swarmFile(workspace, skill, RECORD, true)!
  const now: Seen = { version: versionOf(at), revision: at.revision, roleName: at.roleName }
  const old = readRecord(file)
  let record: NoticeRecord
  if (!old) {
    const launch = launchedAt(workspace, skill)
    let told: NoticeRecord['told'] = null
    if (launch === null) removeOlderSkills(workspace, skill)
    else {
      // The launch line sent the agent to the instructions command: it read a revision saved by its launch (or the template,
      // revision 0). A save after it, or one whose time the history could not say, is the first change to tell.
      const read = at.revision === 0 || (at.savedAt !== null && at.savedAt <= launch)
      told = read ? { ...now, change: 0 } : { version: '', revision: 0, roleName: now.roleName, change: 0 }
    }
    record = { ...now, change: told?.version === now.version ? 0 : 1, told }
    replaceSkillFile(file, JSON.stringify(record))
  } else if (old.version !== now.version) {
    record = { ...now, change: old.change + 1, told: old.told }
    replaceSkillFile(file, JSON.stringify(record))
  } else record = old
  return { version: record.version, owed: record.told?.change !== record.change, change: record.change, notice: noticeOf(record, at) }
}

/** The notice for that refresh was sent. Only a record still holding what it described is marked told: a later change stays
 *  owed, and its notice names everything since the last confirmed one. */
export function recordInstructionsNotice(workspace: string, saved: SavedSwarmSkill, sent: Pick<InstructionsNotice, 'version' | 'change'>): void {
  if (!existsSync(workspace)) return
  const file = swarmFile(workspace, saved, RECORD, false)
  const record = file && readRecord(file)
  if (!file || !record || record.change !== sent.change || record.version !== sent.version) return
  const { told: _told, ...state } = record
  replaceSkillFile(file, JSON.stringify({ ...state, told: { version: state.version, revision: state.revision, roleName: state.roleName, change: state.change } }))
}

function noticeOf(record: NoticeRecord, at: InstructionsAt): string {
  const command = `harness super-tab --tab ${at.tabId} instructions`
  if (!record.told) {
    return 'Harness no longer gives you skill files: don\'t read your swarm-tools, swarm-instructions or role skill again. Before your next step, '
      + `read your project's instructions with ${command} and the manual with harness super-tab help tools, and work by them.`
  }
  const renamed = record.told.roleName !== record.roleName
  // Anything else that moved (a revision, the template's hash) is a change of the instructions.
  const changed = !renamed || record.told.revision !== record.revision
  if (!changed) return `You are now this project's ${record.roleName}. Before your next step, read the project's instructions again with ${command} and work by them.`
  const summary = record.told.revision !== record.revision ? at.summary?.trim().replace(/[.!?]$/, '') : ''
  return [`The project's instructions changed${summary ? `: ${summary}` : ''}.`, ...(renamed ? [`You are now this project's ${record.roleName}.`] : []),
    `Before your next step, read them again with ${command} and work by them.`].join(' ')
}

const versionOf = (at: InstructionsAt) => createHash('sha256').update(JSON.stringify([at.projectId, at.revision, at.hash, at.roleName])).digest('hex')
function readRecord(file: string): NoticeRecord | null {
  let stat
  try { stat = lstatSync(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Swarm skill is not a plain file: ${file}`)
  const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<NoticeRecord>, told = value.told
  const seen = (state: unknown): state is Seen & { change: number } => {
    const s = (state ?? {}) as Partial<NoticeRecord>
    return typeof s.version === 'string' && Number.isSafeInteger(s.revision) && typeof s.roleName === 'string' && Number.isSafeInteger(s.change)
  }
  if (!seen(value)) return null
  return { version: value.version, revision: value.revision, roleName: value.roleName, change: value.change, told: seen(told) ? told : null }
}
