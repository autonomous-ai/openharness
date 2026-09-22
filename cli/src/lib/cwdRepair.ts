/**
 * Put Claude rows back in the folder their transcript belongs to.
 *
 * Until `register` stopped taking the hook's cwd on every prompt (registry.ts), a Claude row's `cwd`
 * followed the session's shell into whatever subfolder, sibling repo or temp dir the agent last
 * `cd`'d — and a resume, restore or restart then `cd`'d there too. The rows written in that time are
 * still on disk, in the live registry and in the stopped-agents archive, and a daemon that comes up on
 * the corrected code would still relaunch them in the wrong place. So it puts them right first, before
 * `restoreAgents` recreates a single pane.
 *
 * The proof is the transcript's own location (claudeProject.ts): a row whose cwd does not round-trip to
 * the project directory its transcript lives in is moved to the folder the transcript names. A row whose
 * transcript names no such folder (renamed since; a bridge file with no cwd line) is left alone and said
 * so, once per boot. Cheap and idempotent — only mismatching rows read a transcript, and a repaired row
 * matches next time — so it runs on every start rather than behind a version marker the daemon does not
 * keep.
 */
import type { RegisteredSession } from './registry.js'
import { claudeProjectMatches, claudeTranscriptCwd, isClaudeProjectTranscript } from './claudeProject.js'

export interface CwdRepairDeps {
  registry: {
    list(): RegisteredSession[]
    byAgent(agentId: string): RegisteredSession | undefined
    setCwd(agentId: string, cwd: string): boolean
    transaction<T>(apply: () => T | Promise<T>): Promise<T>
  }
  stoppedAgents: {
    list(): RegisteredSession[]
    patch(agentId: string, patch: { cwd: string }): boolean
  }
  log: (message: string) => void
}

export interface CwdRepairSummary { registry: number; archived: number }

/** The folder a row should be in, or null when the row is fine or nothing can prove otherwise. */
export function repairedCwd(row: RegisteredSession, log: (message: string) => void): string | null {
  if (row.engine !== 'claude' || !row.cwd || !row.transcriptPath || !isClaudeProjectTranscript(row.transcriptPath)) return null
  if (claudeProjectMatches(row.cwd, row.transcriptPath)) return null
  const folder = claudeTranscriptCwd(row.transcriptPath)
  if (!folder) {
    log(`[repair] ${row.agentId.slice(0, 8)} cwd ${row.cwd} is not its transcript's project folder, and the transcript names no matching folder — left as is`)
    return null
  }
  return folder === row.cwd ? null : folder
}

export async function repairClaudeCwd(deps: CwdRepairDeps): Promise<CwdRepairSummary> {
  const summary: CwdRepairSummary = { registry: 0, archived: 0 }
  // Folders proved so far, by agent: what a transcript-less fork (its history lives in the source's
  // file, not one of its own) inherits from the row it was forked from.
  const proved = new Map<string, string>()
  const forks: RegisteredSession[] = []
  const inherit = (row: RegisteredSession): string | null => {
    const source = row.forkedFrom?.agentId
    if (!source || row.transcriptPath || row.engine !== 'claude' || !row.cwd) return null
    const folder = proved.get(source)
    return folder && folder !== row.cwd ? folder : null
  }

  await deps.registry.transaction(() => {
    for (const row of deps.registry.list()) {
      const folder = repairedCwd(row, deps.log)
      if (!folder) { if (row.forkedFrom && !row.transcriptPath) forks.push(row); continue }
      const was = row.cwd   // `setCwd` mutates this very object
      if (deps.registry.setCwd(row.agentId, folder)) {
        summary.registry++
        proved.set(row.agentId, folder)
        deps.log(`[repair] ${row.agentId.slice(0, 8)} cwd ${was} → ${folder} (transcript project folder)`)
      }
    }
  })
  for (const row of deps.stoppedAgents.list()) {
    const folder = repairedCwd(row, deps.log)
    if (!folder) { if (row.forkedFrom && !row.transcriptPath) forks.push(row); continue }
    if (deps.stoppedAgents.patch(row.agentId, { cwd: folder })) {
      summary.archived++
      proved.set(row.agentId, folder)
      deps.log(`[repair] ${row.agentId.slice(0, 8)} (saved) cwd ${row.cwd} → ${folder} (transcript project folder)`)
    }
  }
  // Forks last, once every source that could be proved has been: a fork only moves with its source.
  for (const row of forks) {
    const folder = inherit(row)
    if (!folder) continue
    const live = deps.registry.byAgent(row.agentId)
    const was = row.cwd
    const done = live ? deps.registry.setCwd(row.agentId, folder) : deps.stoppedAgents.patch(row.agentId, { cwd: folder })
    if (!done) continue
    if (live) summary.registry++; else summary.archived++
    deps.log(`[repair] ${row.agentId.slice(0, 8)}${live ? '' : ' (saved)'} cwd ${was} → ${folder} (forked from ${row.forkedFrom!.agentId.slice(0, 8)})`)
  }
  return summary
}
