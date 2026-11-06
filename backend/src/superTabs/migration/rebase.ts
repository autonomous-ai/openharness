/**
 * Every project's instructions onto the new base, once, by themselves after the release (task #3600; anh Dee 11-06: "update
 * them all and override all of their existing instructions. ALL OF THEM"; River: no preview, "ship it asap"). Each project's
 * document becomes instructionsRebase.ts's: a short intro and every person's rule word for word in People notes; all process
 * is the Swarm's built-in PM text. It runs in the singleton worker, a Swarm per transaction, guarded by the head's version as
 * migration/instructions.ts writes: a command in between wins, and the Swarm is tried again on the next pass.
 *
 * The one check that must be right: no person's rule is lost. The job reads that itself with the rule guard's reader
 * (instructionsDiff.ts droppedRules) on the document it would write, never trusting the builder; a project that would lose
 * one is held back, unwritten and unmarked, and logged as an error on every pass until someone acts.
 *
 * Its record is the project's Instructions history: the revision before (the old document) and the new one, written by the
 * Swarm, with every line that went (ruleGuard.ts droppedLines). The new revision and hash on the head are what every agent's
 * host compares, so each PM is told the instructions changed and reads them again, as for any save.
 *
 * Once: a project is marked (`instructionsBase`) when it is on the base, so a later save is never rewritten. A project made
 * after the release starts on the template and moves on the next pass.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { clock, guardedWrite, loadAll, reassemble } from '../parts/index.js'
import { swarmTransaction } from '../cache.js'
import type { SuperTabState } from '../model.js'
import { projectsOf } from '../projects.js'
import { instructionsHash, MAX_INSTRUCTIONS_BYTES } from '../instructions.js'
import { INSTRUCTIONS_TEMPLATE } from '../instructionsTemplate.js'
import { instructionsId, writeInstructions } from '../instructionsStore.js'
import { droppedRules } from '../instructionsDiff.js'
import { droppedLines } from '../ruleGuard.js'
import { rebasedDocument, type RebasedDocument } from '../instructionsRebase.js'
import { logger } from '../../utils/logger.js'
import { sleeper } from './dropLegacyJob.js'

type Transaction = Prisma.TransactionClient
const TRANSACTION = { maxWait: 5_000, timeout: 60_000 }
/** The base a project is on once this job moved it (SwarmProject.instructionsBase). */
export const BASE_VERSION = 1
export const REBASE_SUMMARY = 'Moved onto the new base: the process is built into Harness; every person\'s rule is kept word for word in People notes.'
/** Between two passes while any project is held back or any Swarm failed or waits for its split. */
export const RETRY_MS = 3_600_000
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
}

/** Whether nothing is left to move: every project of every Swarm on the base. */
export const rebaseDone = (report: RebaseReport): boolean => !report.held.length && !report.failed.length && !report.skipped.length

async function rebaseSwarm(tx: Transaction, tabId: string, now: number, build: (before: string) => RebasedDocument, report: RebaseReport): Promise<void> {
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
    if (Buffer.byteLength(text) > MAX_INSTRUCTIONS_BYTES) { held.push({ tabId, projectId: project.id, why: 'its people\'s rules alone pass 64 KB' }); continue }
    marked.add(project.id)
    if (text !== before) writes.push({ projectId: project.id, askedBy: project.ownerId || state.ownerId, revision, before, text, rules: carried.length })
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

/** One pass over every Swarm: each project not on the base yet is moved, or held back and said why. */
export async function rebaseAll(db: PrismaClient, { now = Date.now, build = before => rebasedDocument(before) }: RebaseOptions = {}): Promise<RebaseReport> {
  const report: RebaseReport = { swarms: 0, written: [], unchanged: 0, held: [], failed: [], skipped: [] }
  const rows = await db.superTab.findMany({ select: { id: true, format: true }, orderBy: { id: 'asc' } })
  for (const row of rows) {
    if (row.format !== 2) { report.skipped.push(row.id); continue }
    report.swarms++
    // A Swarm's own pass is all or nothing: a failure leaves its documents as they were, and its report rows out.
    const own: RebaseReport = { ...report, written: [], unchanged: 0, held: [] }
    try {
      await swarmTransaction(db, tx => rebaseSwarm(tx, row.id, now(), build, own), TRANSACTION)
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
    logger.error(`[instructions-rebase] project held back: ${held.why}. It keeps its old instructions until this is fixed; tried again every hour.`,
      { tabId: held.tabId, projectId: held.projectId, ...held.rules ? { rules: held.rules.length } : {} })
  }
  for (const failed of report.failed) logger.error('[instructions-rebase] Swarm not moved; tried again every hour.', failed)
  return report
}

/** Starts the move in the background after [delayMs], a pass every hour until nothing is left; the returned function stops it. */
export function startInstructionsRebase(db: PrismaClient, delayMs = START_DELAY_MS): () => void {
  const control = new AbortController()
  const wait = sleeper(control.signal)
  void (async () => {
    await wait(delayMs)
    while (!control.signal.aborted) {
      try {
        const report = await rebaseAll(db)
        logger.info('[instructions-rebase] pass', { swarms: report.swarms, written: report.written.length, unchanged: report.unchanged,
          held: report.held.length, failed: report.failed.length, skipped: report.skipped.length })
        if (rebaseDone(report)) return
      } catch (error) {
        logger.error('[instructions-rebase] pass failed; tried again every hour.', { error: error instanceof Error ? error.message : String(error) })
      }
      await wait(RETRY_MS)
    }
  })()
  return () => control.abort()
}
