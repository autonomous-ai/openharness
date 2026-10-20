/**
 * Boot restore for herdr panes this daemon registered.
 * A pane still in the live snapshot is left alone. A missing id gets a new
 * workspace. A failed survey creates nothing, and so does a survey in which ANY
 * check (the snapshot, or one pane's process-info) failed or timed out: a pane that
 * only failed to answer is not a missing pane, and a second omp in a fresh
 * workspace is far worse than one that waits for the next start.
 */
import type { AgentEngine } from '../engines/types.js'
import type { TerminalRuntimeRef } from './terminalTypes.js'

export interface HerdrRestoreRow {
  agentId: string
  engine: AgentEngine
  cwd: string | null
  runtimes: readonly TerminalRuntimeRef[]
}

export interface HerdrRestoreDeps {
  rows: readonly HerdrRestoreRow[]
  /** Null means the survey failed. Create nothing. */
  livePaneIds: ReadonlySet<string> | null
  /** Checks in the survey that failed or timed out. Any at all: create nothing. */
  failedChecks?: number
  /**
   * Whether this daemon created the pane. Only those are rebuilt: a pane someone else opened in herdr
   * and then closed was closed on purpose, and a fresh agent in its place is a duplicate, not a
   * restore. Absent: every pane counts as owned.
   */
  owned?: (paneId: string) => boolean
  create: (row: HerdrRestoreRow) => Promise<{ ok: true; paneId: string } | { ok: false; reason: string }>
  adopt: (agentId: string, paneId: string, kept: readonly TerminalRuntimeRef[]) => void
  log: (line: string) => void
}

export async function restoreMissingHerdrPanes(deps: HerdrRestoreDeps): Promise<{ restored: string[]; skipped: string[]; failed: string[] }> {
  const restored: string[] = []
  const skipped: string[] = []
  const failed: string[] = []
  if (!deps.livePaneIds) {
    deps.log('[restore] herdr survey failed · no pane created')
    return { restored, skipped: deps.rows.map(row => row.agentId), failed }
  }
  const failedChecks = deps.failedChecks ?? 0
  if (failedChecks > 0) {
    deps.log(`[restore] skipped: ${failedChecks} checks failed`)
    return { restored, skipped: deps.rows.map(row => row.agentId), failed }
  }
  let notOwned = 0
  for (const row of deps.rows) {
    const herdr = row.runtimes.find(runtime => runtime.backend === 'herdr')
    if (!herdr) continue
    if (deps.livePaneIds.has(herdr.paneId)) {
      skipped.push(row.agentId)
      continue
    }
    if (deps.owned && !deps.owned(herdr.paneId)) {
      skipped.push(row.agentId)
      notOwned++
      continue
    }
    const created = await deps.create(row)
    if (!created.ok) {
      failed.push(row.agentId)
      deps.log(`[restore] herdr · ${row.agentId} · ${created.reason}`)
      continue
    }
    const kept = row.runtimes.filter(runtime => runtime.backend !== 'herdr')
    deps.adopt(row.agentId, created.paneId, kept)
    restored.push(row.agentId)
    deps.log(`[restore] herdr · ${row.agentId} · new pane ${created.paneId}`)
  }
  if (notOwned) deps.log(`[restore] herdr · ${notOwned} missing panes not created by this daemon · left closed`)
  return { restored, skipped, failed }
}
