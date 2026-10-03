import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CodingMemoryStore } from './store.js'
import { builtinSqlite } from '../lib/sqliteRead.js'
import type { Database } from './database.js'
import type { MemoryRecord, MemoryDraft, SourceEvent } from './types.js'
import type { ActivityReceiver } from './receipts.js'

let directory: string, store: CodingMemoryStore, now: number, memory: MemoryRecord
const receiver: ActivityReceiver = { agentId: 'working-agent', engine: 'codex', sessionId: 'private_receiver_lemur' }
const source: SourceEvent = { id: 'source', profileId: 'owner', projectId: null, engine: 'claude',
  sessionId: 'source-session', nativeEventId: 'source', role: 'user', eligibility: 'coding', observedAt: 900,
  rootIds: ['source'], text: 'For regression fixes, start with a small failing test.' }
const draft: MemoryDraft = { kind: 'working_preference', facet: 'testing', assertionType: 'stated_preference',
  scope: { profileId: 'owner' }, claim: source.text, rationale: null, futureAction: 'Start with a small failing test.',
  applicability: { task: 'bug_fix' }, exceptions: [], retrievalCues: ['regression'], evidenceClass: 'user_stated',
  evidence: [{ sourceEventId: 'source', quote: source.text, paths: ['/claim', '/futureAction', '/applicability'] }],
  conflictKey: 'test-first', validity: { validFrom: null, validUntil: null, recheckWhen: [] } }
const access = { profileId: 'owner', projectIds: ['project'], includeProfile: true }
const activity = (selected = receiver.agentId, receivers = [receiver]) => store.libraryActivity('owner', receivers, { agentId: selected })
function recall(query = 'regression', recipient = receiver, route: 'mcp' | 'prompt_hook' = 'prompt_hook') {
  ++now
  return store.prepareRecall({ query, conditions: { task: 'bug_fix' } },
    { engine: recipient.engine, sessionId: recipient.sessionId, projectId: 'project', route }, access)
}
function sql(run: (db: Database) => void) {
  const DB = builtinSqlite() as unknown as new(path: string) => Database
  const db = new DB(join(directory, 'memory.sqlite'))
  try { run(db) } finally { db.close() }
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memory-activity-')); now = 1_000
  const opened = CodingMemoryStore.open({ directory, profileId: 'owner', now: () => now })
  if (!opened.ok) throw new Error(opened.reason)
  store = opened.store; store.registerProject('project'); store.setControls({ learn: true, recall: true })
  store.ingest(source); memory = store.propose(draft, access).record
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('shows the exact current selection and conditions without claiming model delivery', () => {
  const prepared = recall('regression private_prompt_capuchin')
  expect(activity()).toMatchObject({ selectedAgentId: receiver.agentId,
    sessions: [{ preparedAt: now, selectedCount: 1, delivery: 'unverified', emittedAt: null }],
    items: [{ record: { id: memory.id, revision: 1, applicability: { task: 'bug_fix' } },
      recall: { receiptId: prepared.receipt!.id, canFeedback: true, delivery: 'unverified' } }] })
  expect(store.recallEmitted(prepared.receipt!.id, { engine: receiver.engine, sessionId: receiver.sessionId,
    projectId: 'project', route: 'prompt_hook' }, access)).toBe(true)
  expect(activity().sessions[0]).toMatchObject({ emittedAt: now, delivery: 'unverified' })
})

it('replaces a positive selection with the latest empty recall without inventing a new history receipt', () => {
  const earlier = recall()
  const empty = recall('orchids', receiver, 'mcp')
  expect(empty.receipt).toBeNull()
  expect(activity()).toMatchObject({ sessions: [{ status: 'ok', selectedCount: 0, receiptId: null, preparedAt: now }], items: [] })
  expect(store.libraryDetail('owner', memory.id)!.recalls[0].receiptId).toBe(earlier.receipt!.id)
  const bytes = readFileSync(join(directory, 'memory.sqlite'))
  expect(bytes.includes(Buffer.from(receiver.sessionId))).toBe(false)
  expect(bytes.includes(Buffer.from('orchids'))).toBe(false)
})

it('separates receiving sessions and engines and does not silently switch a selected session', () => {
  recall()
  const other = { ...receiver, agentId: 'other', engine: 'claude' as const }
  recall('orchids', other)
  expect(activity(receiver.agentId, [receiver, other]).items).toHaveLength(1)
  expect(activity('other', [receiver, other]).items).toEqual([])
  expect(activity('missing', [receiver, other])).toMatchObject({ selectedAgentId: 'missing', items: [] })
  expect(activity(receiver.agentId, [{ ...receiver, sessionId: 'resumed-conversation' }]).sessions).toEqual([])
  expect(() => store.libraryActivity('another-owner', [receiver])).toThrow('scope_denied')
  expect(() => store.libraryActivity('owner', Array(129).fill(receiver))).toThrow('invalid_input')
})

it.each(['source', 'receiver', 'project'] as const)('withholds %s privacy changes and does not resurrect receiver activity', which => {
  recall()
  if (which === 'source') store.setSessionIncluded('claude', source.sessionId, false)
  if (which === 'receiver') store.setSessionIncluded(receiver.engine, receiver.sessionId, false)
  if (which === 'project') store.setProjectIncluded('project', false)
  expect(activity().items).toEqual([])
  if (which !== 'source') {
    expect(activity().sessions).toEqual([])
    if (which === 'receiver') store.setSessionIncluded(receiver.engine, receiver.sessionId, true)
    else store.setProjectIncluded('project', true)
    expect(activity().sessions).toEqual([])
  }
})

it('honors privacy set by an earlier writer and clears the old activity when reincluded', () => {
  recall()
  sql(db => db.prepare('UPDATE projects SET included=0 WHERE id=?').run('project'))
  expect(activity().sessions).toEqual([])
  store.setProjectIncluded('project', true)
  expect(activity().sessions).toEqual([])
})

it('never displays a corrected revision as if it were the version recalled earlier', () => {
  recall()
  const preview = store.libraryPreview('owner', { kind: 'narrow', id: memory.id, revision: 1, projectId: 'project' })
  store.libraryApply('owner', preview.command, preview.version, false)
  expect(activity()).toMatchObject({ sessions: [{ selectedCount: 1 }], items: [] })
  recall()
  expect(activity().items[0].record.revision).toBe(2)
  store.libraryForget('owner', memory.id, 2)
  expect(activity().items).toEqual([])
})

it('keeps feedback available for an exact selection outside the per-memory ten-session history', () => {
  const prepared = recall()
  for (let i = 0; i < 15; i++) recall('regression', { ...receiver, agentId: `agent-${i}`, sessionId: `session-${i}` })
  expect(store.libraryDetail('owner', memory.id)!.recalls.some(r => r.receiptId === prepared.receipt!.id)).toBe(false)
  expect(activity().items[0].recall.receiptId).toBe(prepared.receipt!.id)
  const preview = store.libraryPreview('owner', { kind: 'feedback', id: memory.id, revision: 1,
    receiptId: prepared.receipt!.id, value: 'helpful', expected: 0 })
  store.libraryApply('owner', preview.command, preview.version, false)
  expect(activity().items[0].recall.feedback.value).toBe('helpful')
})

it('does not infer current activity from legacy positive-only history or expired attempts', () => {
  recall()
  sql(db => db.prepare('DELETE FROM memory_recall_latest').run())
  expect(store.libraryDetail('owner', memory.id)!.recalls).toHaveLength(1)
  expect(activity().sessions).toEqual([])
  recall(); now += 30 * 86_400_000
  expect(activity().sessions).toEqual([])
})
