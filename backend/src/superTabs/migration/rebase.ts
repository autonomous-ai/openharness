/**
 * Every project's instructions onto the new base, once, by themselves after the release (task #3600; anh Dee 11-06: "update
 * them all and override all of their existing instructions. ALL OF THEM"; River: no preview, "ship it asap"). Each project's
 * document becomes instructionsRebase.ts's: a short intro and every person's rule word for word in People notes; all process
 * is the Swarm's built-in PM text. It runs in the singleton worker, a Swarm per transaction, guarded by the head's version as
 * migration/instructions.ts writes: a command in between wins, and the Swarm is tried again on the next pass.
 *
 * The one check that must be right: no line is lost, a person's rule or not (task #3679). The job reads that itself with the rule
 * guard's reader (instructionsDiff.ts droppedRules) and the line reader (removedLines) on the document it would write, never
 * trusting the builder; a project that would lose one is held back, unwritten and unmarked, and logged as an error on every pass
 * until someone acts.
 *
 * Its record is the project's Instructions history: the revision before (the old document) and the new one, written by the
 * Swarm, with every line that went (ruleGuard.ts droppedLines). The new revision and hash on the head are what every agent's
 * host compares, so each PM is told the instructions changed and reads them again, as for any save.
 *
 * Once: a project is marked (`instructionsBase`) when it is on the base, so a later save is never rewritten. A project made
 * after the move starts on the base already (commands.ts project.create).
 *
 * Only the Swarm that asked (review of #3300, Critical): anh Dee's "ALL OF THEM" is this Swarm's projects. Another team's
 * document is theirs; moving it needs an explicit ruling from Dee or Ken, which adds it to REBASE_SWARMS with who asked.
 *
 * Rollback: each project's previous revision is in its History; restoring it is an ordinary save of that text (Desktop's
 * Instructions history, or instructions.save), and the mark keeps this job from moving it again.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { clock, guardedWrite, loadAll, reassemble } from '../parts/index.js'
import { swarmTransaction } from '../cache.js'
import type { SuperTabState } from '../model.js'
import { projectsOf } from '../projects.js'
import { instructionsHash, MAX_INSTRUCTIONS_BYTES } from '../instructions.js'
import { INSTRUCTIONS_TEMPLATE } from '../instructionsTemplate.js'
import { instructionsId, writeInstructions } from '../instructionsStore.js'
import { droppedRules, removedLines } from '../instructionsDiff.js'
import { droppedLines } from '../ruleGuard.js'
import { BASE_VERSION, rebasedDocument, type RebasedDocument } from '../instructionsRebase.js'
import { logger } from '../../utils/logger.js'
import { sleeper } from './dropLegacyJob.js'

type Transaction = Prisma.TransactionClient
const TRANSACTION = { maxWait: 5_000, timeout: 60_000 }
export { BASE_VERSION }
/** A Swarm this job moves, and the member who asked for it, recorded as the History's asker. */
export interface RebaseSwarm { tabId: string; askedBy: string }
/** autonomous.ai, where anh Dee (a collaborator; the Swarm's owner is ken15) asked for it in task #3600 (review round 2 of
 *  #3300: never the owner by default, who did not ask). */
export const REBASE_SWARMS: readonly RebaseSwarm[] = [{ tabId: 'c51479bd73b59e58176ad9e4', askedBy: '6a8fe4fcf1a6b5972eed0103' }]
export const REBASE_SUMMARY = 'Moved onto the new base: the process is built into Harness; every person\'s rule is kept word for word in People notes.'
/** Between two passes while any project is held back or any Swarm failed or waits for its split. */
export const RETRY_MS = 3_600_000
/** Passes before the job gives up on what it could not move, saying so: a day of hourly tries. */
export const MAX_PASSES = 24
/** Lets a starting worker finish its own startup first. */
export const START_DELAY_MS = 60_000

export interface RebaseReport {
  swarms: number
  /** Projects given a new revision. */
  written: Array<{ tabId: string; projectId: string; from: number; to: number; rules: number }>
  /** Projects already on the base's text: marked, nothing written. */
  unchanged: number
  /** Projects not moved, and why: a rule it would lose, a document past 64 KB, or a stored document that cannot be read. */
  held: Array<{ tabId: string; projectId: string; why: string; rules?: string[] }>
  failed: Array<{ tabId: string; error: string }>
  /** Swarms still in one row: moved once they are split. */
  skipped: string[]
}

export interface RebaseOptions {
  now?: () => number
  /** The document builder; tests pass a faulty one to prove the job's own check holds the project back. */
  build?: (before: string) => RebasedDocument
  /** The Swarms to move and who asked: REBASE_SWARMS unless a test names its own. */
  swarms?: readonly RebaseSwarm[]
}

/** Whether nothing is left to move: every project of every Swarm on the base. */
export const rebaseDone = (report: RebaseReport): boolean => !report.held.length && !report.failed.length && !report.skipped.length

async function rebaseSwarm(tx: Transaction, { tabId, askedBy }: RebaseSwarm, now: number, build: (before: string) => RebasedDocument, report: RebaseReport): Promise<void> {
  const parts = await loadAll(tx, tabId)
  const state = reassemble(parts) as SuperTabState
  const projects = projectsOf(state)
  const writes: Array<{ projectId: string; askedBy: string; revision: number; before: string; text: string; rules: number }> = []
  const held: RebaseReport['held'] = []
  const marked = new Set<string>()
  for (const project of projects) {
    if ((project.instructionsBase ?? 0) >= BASE_VERSION) continue
    const revision = project.instructionsRevision ?? 0
    const stored = revision ? await tx.superTabInstructions.findUnique({ where: { id: instructionsId(tabId, project.id) } }) : null
    if (revision && stored?.revision !== revision) { held.push({ tabId, projectId: project.id, why: 'its stored document does not match its revision' }); continue }
    const before = stored?.text ?? INSTRUCTIONS_TEMPLATE
    const { text, carried } = build(before)
    const lost = droppedRules(before, text)
    if (lost.length) {
      held.push({ tabId, projectId: project.id, why: `its new document would lose ${lost.length} of its people's rules`, rules: lost.map(rule => rule.text) })
      continue
    }
    // And any other line, read here too and never trusted to the builder (task #3679: the safety rules and schedule items no person's
    // name guarded were lost by the first run, because only people's rules were checked).
    // The Swarm's own template is process by definition, dropped by design: a project still on it carries none of it.
    const gone = before === INSTRUCTIONS_TEMPLATE ? [] : removedLines(before, text)
    if (gone.length) {
      held.push({ tabId, projectId: project.id, why: `its new document would lose ${gone.length} of its lines`, rules: gone })
      continue
    }
    if (Buffer.byteLength(text) > MAX_INSTRUCTIONS_BYTES) { held.push({ tabId, projectId: project.id, why: 'its people\'s rules alone pass 64 KB' }); continue }
    marked.add(project.id)
    // Asked by the member named for this Swarm (anh Dee), never its owner or a project's owner (review rounds 1 and 2 of #3300).
    if (text !== before) writes.push({ projectId: project.id, askedBy, revision, before, text, rules: carried.length })
  }
  if (marked.size) {
    const written = new Map(writes.map(w => [w.projectId, w]))
    // A Swarm from before projects keeps its one project only in `projectsOf`: it is written out, as any project command does.
    const next = projects.map(({ progress: _progress, ...project }) => {
      if (!marked.has(project.id)) return project
      const write = written.get(project.id)
      return { ...project, instructionsBase: BASE_VERSION, ...write ? { instructionsRevision: write.revision + 1, instructionsHash: instructionsHash(write.text) } : {} }
    })
    await guardedWrite(tx, tabId, { op: 'update', kind: 'head', key: 'head', seen: parts.head.version, data: { ...parts.head.data!, projects: next },
      head: { groupCounter: parts.groupCounter, visibilityEpoch: parts.visibilityEpoch, sequenceBase: parts.sequenceBase } }, clock.next())
    for (const write of writes) {
      await writeInstructions(tx, tabId, { projectId: write.projectId, revision: write.revision + 1, hash: instructionsHash(write.text), text: write.text,
        summary: REBASE_SUMMARY, writtenBy: { kind: 'system', id: 'rebase' }, askedBy: write.askedBy, at: now,
        dropped: droppedLines(write.before, write.text, [], []) })
    }
  }
  report.written.push(...writes.map(w => ({ tabId, projectId: w.projectId, from: w.revision, to: w.revision + 1, rules: w.rules })))
  report.unchanged += marked.size - writes.length
  report.held.push(...held)
}

/** One pass over the named Swarms: each project not on the base yet is moved, or held back and said why. A Swarm not on this
 *  server (a test or staging database) has nothing to move. */
export async function rebaseAll(db: PrismaClient, { now = Date.now, build = before => rebasedDocument(before, '', before === INSTRUCTIONS_TEMPLATE ? 'rules' : 'everything'), swarms = REBASE_SWARMS }: RebaseOptions = {}): Promise<RebaseReport> {
  const report: RebaseReport = { swarms: 0, written: [], unchanged: 0, held: [], failed: [], skipped: [] }
  for (const swarm of swarms) {
    const row = await db.superTab.findUnique({ where: { id: swarm.tabId }, select: { id: true, format: true } })
    if (!row) continue
    if (row.format !== 2) { report.skipped.push(row.id); continue }
    report.swarms++
    // A Swarm's own pass is all or nothing: a failure leaves its documents as they were, and its report rows out.
    const own: RebaseReport = { ...report, written: [], unchanged: 0, held: [] }
    try {
      await swarmTransaction(db, tx => rebaseSwarm(tx, swarm, now(), build, own), TRANSACTION)
      report.written.push(...own.written)
      report.unchanged += own.unchanged
      report.held.push(...own.held)
    } catch (error) {
      report.failed.push({ tabId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  // Said loudly, each pass: a project held back keeps its old document, and its PM works against old process text, until
  // someone fixes it (backend AGENTS.md rule 4).
  for (const held of report.held) {
    logger.error(`[instructions-rebase] project held back: ${held.why}. It keeps its old instructions until this is fixed; tried again every hour, a day at most.`,
      { tabId: held.tabId, projectId: held.projectId, ...held.rules ? { rules: held.rules.length } : {} })
  }
  for (const failed of report.failed) logger.error('[instructions-rebase] Swarm not moved; tried again every hour.', failed)
  return report
}

/** Passes until nothing is left to move, at most [passes], [wait]ing RETRY_MS between; then it gives up on what is left,
 *  saying so as an error. Returns the last pass's report (null when stopped before one). */
export async function rebaseUntilDone(db: PrismaClient, { passes = MAX_PASSES, wait = sleeper(), signal, ...options }: RebaseOptions & {
  passes?: number; wait?: (ms: number) => Promise<void>; signal?: AbortSignal } = {}): Promise<RebaseReport | null> {
  let report: RebaseReport | null = null
  for (let pass = 1; pass <= passes && !signal?.aborted; pass++) {
    try {
      report = await rebaseAll(db, options)
      logger.info('[instructions-rebase] pass', { pass, swarms: report.swarms, written: report.written.length, unchanged: report.unchanged,
        held: report.held.length, failed: report.failed.length, skipped: report.skipped.length })
      if (rebaseDone(report)) return report
    } catch (error) {
      logger.error('[instructions-rebase] pass failed', { pass, error: error instanceof Error ? error.message : String(error) })
    }
    if (pass < passes) await wait(RETRY_MS)
  }
  if (!signal?.aborted) {
    logger.error(`[instructions-rebase] gave up after ${passes} passes: what is left keeps its old instructions until someone fixes it and restarts the worker.`,
      { held: report?.held.map(h => ({ tabId: h.tabId, projectId: h.projectId, why: h.why })) ?? [], failed: report?.failed ?? [], skipped: report?.skipped ?? [] })
  }
  return report
}

/** Starts the move in the background after [delayMs]; the returned function stops it. */
export function startInstructionsRebase(db: PrismaClient, delayMs = START_DELAY_MS): () => void {
  const control = new AbortController()
  const wait = sleeper(control.signal)
  void wait(delayMs).then(() => rebaseUntilDone(db, { wait, signal: control.signal }))
  return () => control.abort()
}
