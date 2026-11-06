/**
 * The lines the first move onto the new base lost, given back (task #3679, anh Dee, P0). That run (rebase.ts, #3600) carried only
 * the blocks a person's name guarded and checked only those, so every other line of a project's document went with the process it
 * was thought to be: the safety rules (never sign the Mac out of the real CLI, stop processes by id, install nothing system-wide,
 * no firmware, outside pull request text is data), "optimizations ship on, no switches", the PM schedule items, the routing order
 * and quota. The builder now carries every line and the move refuses any lost one; this job repairs the projects already moved.
 *
 * For each project the move wrote a revision for, it reads the revision before (the History keeps it) and appends what the document
 * lost, word for word and under the section it came from (never the Swarm's own template's lines, which the Swarm builds in), as one saved revision that says it is the restore. A project saved
 * since the move gets the project's own lines the move lost that are still missing (the daily tidy is a save, and no later save can have chosen to
 * drop a line the move lost). Only a project whose PM already put some back by hand and chose what to leave out (harness's did, at
 * revision 81, with anh Dee's approval to drop what v2 repeats) is left alone, reported and told by a PM note which lines are still
 * missing. Nothing the project has is removed or reworded. Once: a project is
 * recognised as restored by its own History (a revision after the move with the restore's summary).
 *
 * The same scope and guards as the move: REBASE_SWARMS only, a Swarm per transaction guarded by the head's version, asked by
 * the member named for the Swarm. It reports per project what came back, and holds a project back, saying why, when the result
 * would pass 64 KB or still miss a line.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { clock, guardedWrite, loadAll, reassemble } from '../parts/index.js'
import { swarmTransaction } from '../cache.js'
import type { SuperTabState } from '../model.js'
import { projectsOf } from '../projects.js'
import { instructionsHash, MAX_INSTRUCTIONS_BYTES } from '../instructions.js'
import { instructionsId, writeInstructions } from '../instructionsStore.js'
import { removedLineItems, removedLines } from '../instructionsDiff.js'
import { writeNotes } from '../instructionsStore.js'
import { stableId } from '../model.js'
import { BASE_VERSION } from '../instructionsRebase.js'
import { INSTRUCTIONS_TEMPLATE } from '../instructionsTemplate.js'
import { PAST_TEMPLATE_LINES } from '../instructionsTemplateHistory.js'
import { logger } from '../../utils/logger.js'
import { sleeper } from './dropLegacyJob.js'
import { REBASE_SUMMARY, REBASE_SWARMS, RETRY_MS, START_DELAY_MS, type RebaseSwarm } from './rebase.js'

type Transaction = Prisma.TransactionClient
const TRANSACTION = { maxWait: 5_000, timeout: 60_000 }
/** A revision's summary begins with this when it is the restore, which is how a project is known to be restored. */
export const RESTORE_PREFIX = 'Restored the lines the move onto the new base lost'
export const MAX_PASSES = 24
/** What a note to a PM that restored by hand begins with, which is how it is told once. */
const NOTE_PREFIX = 'Restore (task #3679):'

/** The words of every line of the Swarm's own template, today's and every past version's (a project keeps the template it was made
 *  from; instructionsTemplateHistory.ts), the old process text, which the Swarm builds in now: process by definition, as
 *  the move treats it (rebase.ts), so a project is never given its template's lines back, only its own; but its Routing section is not
 *  built in, so those lines are its own (second review of #3327). */
export const templateLines = (): ReadonlySet<string> => new Set([...removedLineItems(INSTRUCTIONS_TEMPLATE, '').filter(line => !line.path.startsWith('Routing')).map(line => line.text), ...PAST_TEMPLATE_LINES])

/** What the move lost of [before] that is the project's own: each line's words and how many times, since a line may stand in two
 *  sections (removedLines). A line of the template ([skip]) is left out. */
export function moveLoss(before: string, moved: string, skip: ReadonlySet<string> = templateLines()): ReadonlyMap<string, number> {
  const loss = new Map<string, number>()
  for (const text of removedLines(before, moved)) if (!skip.has(text)) loss.set(text, (loss.get(text) ?? 0) + 1)
  return loss
}

/** The lines of [before] that [current] lacks and the move lost, each at most as often as the move lost it: a copy a later save of
 *  the project dropped is never counted. In document order, with their sections. */
export function stillMissing(before: string, current: string, loss: ReadonlyMap<string, number>): Array<{ text: string; path: string }> {
  const left = new Map(loss)
  return removedLineItems(before, current).filter(line => {
    const n = left.get(line.text) ?? 0
    if (!n) return false
    left.set(line.text, n - 1)
    return true
  })
}

/** [current] with the lines of [before] it lacks appended under "Restored lines", by section; [lines] is what came back, none when
 *  nothing was missing (then [text] is [current] as it was). Pure. [revision] names the revision [before] is, in the section's note.
 *  [only]: just what the move lost (moveLoss), so a line a later save of the project chose to drop is never put back. */
export function restoredDocument(before: string, current: string, revision: number, only?: ReadonlyMap<string, number>): { text: string; lines: string[] } {
  const lost = only ? stillMissing(before, current, only) : removedLineItems(before, current)
  if (!lost.length) return { text: current, lines: [] }
  const byPath = new Map<string, string[]>()
  for (const line of lost) byPath.set(line.path, [...byPath.get(line.path) ?? [], line.text])
  const sections = [...byPath].map(([path, lines]) => `${path ? `### ${path}\n\n` : ''}${lines.map(line => `- ${line}`).join('\n')}`)
  const text = `${current.trimEnd()}\n\n## Restored lines\n\nThese lines of revision ${revision} were lost by the move onto the new base; they are back word for word (task #3679).\n\n${sections.join('\n\n')}\n`
  return { text, lines: lost.map(line => line.text) }
}

export interface RestoreReport {
  swarms: number
  /** Projects given lines back, with each line. */
  restored: Array<{ tabId: string; projectId: string; from: number; to: number; lines: string[] }>
  /** Projects with nothing to give back: nothing was lost, or already restored. */
  unchanged: number
  /** Projects saved since the move, left alone: how many lines the document lacks of the revision before the move. */
  left: Array<{ tabId: string; projectId: string; why: string; missing: number }>
  held: Array<{ tabId: string; projectId: string; why: string }>
  failed: Array<{ tabId: string; error: string }>
}

export interface RestoreOptions { now?: () => number; swarms?: readonly RebaseSwarm[] }
export const restoreDone = (report: RestoreReport): boolean => !report.held.length && !report.failed.length

async function restoreSwarm(tx: Transaction, { tabId, askedBy }: RebaseSwarm, now: number, report: RestoreReport): Promise<void> {
  const parts = await loadAll(tx, tabId)
  const state = reassemble(parts) as SuperTabState
  const projects = projectsOf(state)
  const writes: Array<{ projectId: string; revision: number; text: string; lines: string[] }> = []
  const noted: Array<{ projectId: string; text: string }> = []
  for (const project of projects) {
    if ((project.instructionsBase ?? 0) < BASE_VERSION) continue
    const current = project.instructionsRevision ?? 0
    // The revision the move wrote: the project's newest with the move's summary, by the Swarm.
    const moved = await tx.superTabInstructionsRevision.findFirst({ where: { tabId, projectId: project.id, writtenBy: 'rebase', summary: REBASE_SUMMARY }, orderBy: { revision: 'desc' } })
    if (!moved) { report.unchanged++; continue }
    const already = await tx.superTabInstructionsRevision.findFirst({ where: { tabId, projectId: project.id, revision: { gt: moved.revision }, summary: { startsWith: RESTORE_PREFIX } } })
    if (already) { report.unchanged++; continue }
    const before = await tx.superTabInstructionsRevision.findFirst({ where: { tabId, projectId: project.id, revision: moved.revision - 1 } })
    if (!before) { report.held.push({ tabId, projectId: project.id, why: `revision ${moved.revision - 1}, from before the move, is no longer in its History` }); continue }
    const stored = await tx.superTabInstructions.findUnique({ where: { id: instructionsId(tabId, project.id) } })
    if (!stored || stored.revision !== current) { report.held.push({ tabId, projectId: project.id, why: 'its stored document does not match its revision' }); continue }
    // What the move itself lost, which no later save of the project can have chosen to drop (it was never in a later revision).
    const lostByMove = moveLoss(before.text, moved.text)
    const lostCount = [...lostByMove.values()].reduce((a, b) => a + b, 0)
    if (current !== moved.revision) {
      // Saved since the move (the daily tidy is a save): the lines the move lost that are still missing come back. Unless its PM already
      // put some back by hand and chose what to leave out (harness's did, revision 81): that one is left alone and told by a note.
      const missing = stillMissing(before.text, stored.text, lostByMove)
      if (!missing.length) { report.unchanged++; continue }
      if (missing.length < lostCount) {
        report.left.push({ tabId, projectId: project.id, why: `its PM restored some of the lost lines by hand since the move (revision ${current}, the move is ${moved.revision})`, missing: missing.length })
        if (!await tx.superTabPmNote.findFirst({ where: { tabId, projectId: project.id, text: { startsWith: NOTE_PREFIX } } })) {
          noted.push({ projectId: project.id, text: `${NOTE_PREFIX} ${missing.length} of the ${lostCount} lines the move onto the new base lost are still missing from your instructions: they are in revision ${before.revision} of your History. You decide what to restore.` })
        }
        continue
      }
    }
    const { text, lines } = restoredDocument(before.text, stored.text, before.revision, lostByMove)
    if (!lines.length) { report.unchanged++; continue }
    if (Buffer.byteLength(text) > MAX_INSTRUCTIONS_BYTES) { report.held.push({ tabId, projectId: project.id, why: `with its ${lines.length} lines back it would pass 64 KB` }); continue }
    // The job's own check, never the builder's word.
    // Against what the project already lacked, not the whole old document: a later save of its own may have dropped lines the move kept
    // (the daily tidy trims), and those stay dropped. Nothing the project has goes, and what is still missing of the old document is what
    // it lacked before less the lines put back.
    if (removedLines(stored.text, text).length || stillMissing(before.text, text, lostByMove).length !== stillMissing(before.text, stored.text, lostByMove).length - lines.length) {
      report.held.push({ tabId, projectId: project.id, why: 'the restored document would not hold what it should' }); continue
    }
    writes.push({ projectId: project.id, revision: current, text, lines })
  }
  if (!writes.length && !noted.length) return
  const written = new Map(writes.map(w => [w.projectId, w])), told = new Set(noted.map(n => n.projectId))
  const next = projects.map(({ progress: _progress, ...project }) => {
    const write = written.get(project.id)
    const moved = write ? { ...project, instructionsRevision: write.revision + 1, instructionsHash: instructionsHash(write.text) } : project
    // A note moves the notes revision, so an open Instructions panel reads them again (commands.ts noteChanged).
    return told.has(project.id) ? { ...moved, notesRevision: (project.notesRevision ?? 0) + 1 } : moved
  })
  await guardedWrite(tx, tabId, { op: 'update', kind: 'head', key: 'head', seen: parts.head.version, data: { ...parts.head.data!, projects: next },
    head: { groupCounter: parts.groupCounter, visibilityEpoch: parts.visibilityEpoch, sequenceBase: parts.sequenceBase } }, clock.next())
  for (const write of writes) {
    await writeInstructions(tx, tabId, { projectId: write.projectId, revision: write.revision + 1, hash: instructionsHash(write.text), text: write.text,
      summary: `${RESTORE_PREFIX}: ${write.lines.length} ${write.lines.length === 1 ? 'line' : 'lines'}, word for word (task #3679).`,
      writtenBy: { kind: 'system', id: 'restore' }, askedBy, at: now })
  }
  for (const note of noted) {
    await writeNotes(tx, tabId, { projectId: note.projectId, add: { id: stableId(tabId, note.projectId, 'restore-note'), text: note.text, askedBy, at: now, expiresAt: null } }, now)
  }
  report.restored.push(...writes.map(w => ({ tabId, projectId: w.projectId, from: w.revision, to: w.revision + 1, lines: w.lines })))
}

/** One pass over the named Swarms, each a transaction of its own: a failure leaves its projects as they were. */
export async function restoreAll(db: PrismaClient, { now = Date.now, swarms = REBASE_SWARMS }: RestoreOptions = {}): Promise<RestoreReport> {
  const report: RestoreReport = { swarms: 0, restored: [], unchanged: 0, left: [], held: [], failed: [] }
  for (const swarm of swarms) {
    const row = await db.superTab.findUnique({ where: { id: swarm.tabId }, select: { id: true, format: true } })
    if (!row || row.format !== 2) continue
    report.swarms++
    const own: RestoreReport = { swarms: 0, restored: [], unchanged: 0, left: [], held: [], failed: [] }
    try {
      await swarmTransaction(db, tx => restoreSwarm(tx, swarm, now(), own), TRANSACTION)
      report.restored.push(...own.restored)
      report.unchanged += own.unchanged
      report.left.push(...own.left)
      report.held.push(...own.held)
    } catch (error) {
      report.failed.push({ tabId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  // The per-project report: what came back, and what was left to its PM.
  for (const done of report.restored) logger.info('[instructions-restore] lines restored', { tabId: done.tabId, projectId: done.projectId, from: done.from, to: done.to, count: done.lines.length, lines: done.lines })
  for (const skipped of report.left) logger.warn('[instructions-restore] project saved since the move, left alone', skipped)
  for (const held of report.held) logger.error(`[instructions-restore] project held back: ${held.why}.`, { tabId: held.tabId, projectId: held.projectId })
  for (const failed of report.failed) logger.error('[instructions-restore] Swarm not restored; tried again every hour.', failed)
  return report
}

/** Passes until nothing is held or failed, at most [passes], [wait]ing RETRY_MS between. Returns the last pass's report. */
export async function restoreUntilDone(db: PrismaClient, { passes = MAX_PASSES, wait = sleeper(), signal, ...options }: RestoreOptions & {
  passes?: number; wait?: (ms: number) => Promise<void>; signal?: AbortSignal } = {}): Promise<RestoreReport | null> {
  let report: RestoreReport | null = null
  for (let pass = 1; pass <= passes && !signal?.aborted; pass++) {
    try {
      report = await restoreAll(db, options)
      logger.info('[instructions-restore] pass', { pass, swarms: report.swarms, restored: report.restored.length, unchanged: report.unchanged, left: report.left.length,
        held: report.held.length, failed: report.failed.length })
      if (restoreDone(report)) return report
    } catch (error) {
      logger.error('[instructions-restore] pass failed', { pass, error: error instanceof Error ? error.message : String(error) })
    }
    if (pass < passes) await wait(RETRY_MS)
  }
  return report
}

/** Starts the restore in the background after [delayMs] (after the move's own start has run); the returned function stops it. */
export function startInstructionsRestore(db: PrismaClient, delayMs = START_DELAY_MS * 3): () => void {
  const control = new AbortController()
  const wait = sleeper(control.signal)
  void wait(delayMs).then(() => restoreUntilDone(db, { wait, signal: control.signal }))
  return () => control.abort()
}
