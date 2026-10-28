/**
 * Moves one Swarm from its single row to parts (design 6.1.2), in one transaction: normalize, split, insert, read the
 * parts back and verify them against the state, check messages and other rows are untouched, then fence the row. Any
 * difference aborts the transaction, so a Swarm is either fully in parts or left exactly as it was.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import type { SuperTabState } from '../model.js'
import * as parts from '../parts/index.js'
import { swarmTransaction } from '../cache.js'
import { fingerprint, fingerprintDifference, lastActivity } from './fingerprint.js'
import { restorePullRequestUrls } from './links.js'
import { normalize } from './normalize.js'
import { stateDifference } from './verify.js'

export interface MigrationReport {
  tabId: string
  ok: boolean
  skipped?: true
  error?: string
  /** Size of the old state. */
  bytes: number
  groups: number
  dormant: number
  parts: number
  messages: number
  ms: number
}

/** Only this job: a 1.16 MB Swarm reads, splits and verifies well past the commands' 15 s. */
const MIGRATION_TRANSACTION = { maxWait: 5_000, timeout: 60_000 }
/** The old state that every older backend refuses before it writes (store.ts stateOf), so a survivor of the gate cannot. */
export const FENCED_STATE = { version: 2 }

class MigrationFailed extends Error {}
const fail = (message: string): never => { throw new MigrationFailed(message) }

export async function migrateSwarm(db: PrismaClient, tabId: string, { now = Date.now }: { now?: () => number } = {}): Promise<MigrationReport> {
  const started = Date.now()
  const empty = { tabId, bytes: 0, groups: 0, dormant: 0, parts: 0, messages: 0 }
  try {
    return await swarmTransaction(db, tx => migrateIn(tx, tabId, now(), started), MIGRATION_TRANSACTION)
  } catch (error) {
    return { ...empty, ok: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started }
  }
}

async function migrateIn(tx: Prisma.TransactionClient, tabId: string, at: number, started: number): Promise<MigrationReport> {
  const row = await tx.superTab.findUnique({ where: { id: tabId } }) ?? fail(`Swarm ${tabId} does not exist`)
  if (row.format === 2) return { tabId, ok: true, skipped: true, bytes: 0, groups: 0, dormant: 0, parts: 0, messages: 0, ms: Date.now() - started }
  const original = row.state as unknown as SuperTabState
  if (original.version !== 1) fail(`its state has version ${String(original.version)}, not 1`)
  const before = await fingerprint(tx, tabId)
  const activity = await lastActivity(tx, tabId)
  const state = normalize(original, { now: at, lastActivity: activity })
  await restorePullRequestUrls(tx, tabId, state)
  await parts.insertParts(tx, parts.split(state, { tabId, version: row.revision, now: at, lastActivity: activity }))
  const stored = await parts.loadAll(tx, tabId)
  const differs = stateDifference(parts.toLegacyState(state), parts.toLegacyState(parts.reassemble(stored)))
  if (differs) fail(`its parts would not reassemble into its state: ${differs}`)
  const groups = new Set(stored.groups.map(g => g.key))
  // Deleted conversations may have left message history behind in the old store. Keep those messages untouched and
  // inaccessible, but do not allow the split to orphan a conversation that is still present after normalization.
  const activeGroups = new Set(state.conversations.map(group => group.id))
  const newlyOrphaned = [...before.conversationIds].filter(id => activeGroups.has(id) && !groups.has(id))
  if (newlyOrphaned.length) fail(`${newlyOrphaned.length} existing conversation${newlyOrphaned.length === 1 ? '' : 's'} lost its message group: ${newlyOrphaned.join(', ')}`)
  const touched = fingerprintDifference(before, await fingerprint(tx, tabId))
  if (touched) fail(touched)
  const fenced = await tx.superTab.updateMany({ where: { id: tabId, revision: row.revision, format: 1 },
    data: { format: 2, revision: row.revision + 1, migratedAt: new Date(at), legacyState: row.state as Prisma.InputJsonValue, state: FENCED_STATE } })
  if (!fenced.count) fail('it changed while it was being migrated')
  return { tabId, ok: true, bytes: Buffer.byteLength(JSON.stringify(original)), groups: stored.groups.length,
    dormant: stored.groups.filter(g => g.dormant).length, messages: before.messages, ms: Date.now() - started,
    parts: 1 + stored.members.length + stored.agents.length + stored.groups.length + stored.machines.length + stored.starts.length + stored.progress.length }
}
