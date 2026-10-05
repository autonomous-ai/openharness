import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { MemoryClient } from './client.js'
import type { MemoryAccess, MemoryDraft, SourceEvent } from './types.js'

let directory: string
let source: string
const clients: MemoryClient[] = []
const access: MemoryAccess = { profileId: 'owner', projectIds: ['project'], includeProfile: false }
beforeAll(async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('./worker.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent' })
  source = result.outputFiles[0].text
})
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'memory-worker-')) })
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); await rm(directory, { recursive: true, force: true }) })
function client(workerSource = source): MemoryClient {
  const instance = new MemoryClient({ directory, profileId: 'owner', source: workerSource })
  clients.push(instance)
  return instance
}

it('keeps a notebook wait reason through the worker boundary and restart, then withdraws it for private work', async () => {
  const first = client()
  await first.request('registerProject', ['project'])
  await first.request('setControls', [{ learn: true, recall: true }])
  const event: SourceEvent = { id: 'source', profileId: 'owner', projectId: 'project', engine: 'codex', sessionId: 'session',
    nativeEventId: 'source', role: 'user', eligibility: 'coding', observedAt: Date.now(), rootIds: ['source'],
    text: 'For debugging, start with a small failing test.' }
  const draft: MemoryDraft = { kind: 'working_preference', facet: 'debugging', assertionType: 'stated_preference',
    scope: { profileId: 'owner', projectId: 'project' }, claim: event.text, rationale: null, futureAction: event.text,
    applicability: { taskType: 'debugging' }, exceptions: [], retrievalCues: ['debugging', 'test'], evidenceClass: 'user_stated',
    evidence: [{ sourceEventId: event.id, quote: event.text, paths: ['/claim', '/futureAction', '/applicability', '/validity'] }],
    conflictKey: 'debugging_order', validity: { validFrom: null, validUntil: null, recheckWhen: [] } }
  await first.request('ingest', [event])
  const { record } = await first.request('propose', [draft, access])
  await first.request('notebookPending', [])
  const claimed = await first.request('notebookClaim', [{ state: 'ready', key: 'selected-connection' }])
  if (claimed.state !== 'claimed') throw new Error(claimed.state)
  await first.request('notebookDefer', [claimed.lease, 'waiting_for_model', 'companion_account_unavailable'])
  await first.close()
  const restarted = client()
  expect(await restarted.request('notebookPending', [])).toEqual({
    state: 'waiting_for_model', prefer: false, reason: 'companion_account_unavailable',
  })
  expect(await restarted.request('read', [record.id, access])).toEqual(record)
  expect((await restarted.request('status', [])).callsLastHour).toBe(1)
  await restarted.request('setSessionIncluded', ['codex', 'session', false])
  expect(await restarted.request('notebookPending', [])).toEqual({ state: 'idle', prefer: false })
})

it('captures, learns, recalls, and forgets through the bundled worker across restart', async () => {
  const first = client()
  await first.request('registerProject', ['project'])
  await first.request('setControls', [{ learn: true, recall: true }])
  const event: SourceEvent = { id: 'source', profileId: 'owner', projectId: 'project', engine: 'claude', sessionId: 'session',
    nativeEventId: 'source', role: 'user', eligibility: 'coding', observedAt: Date.now(), rootIds: ['source'],
    text: 'For debugging, start with a failing test because it makes the repair easier to review.' }
  await first.request('capture', [{ streamId: 'stream', engine: 'claude', sessionId: 'session', projectId: 'project', episodeId: 'episode',
    from: null, to: '1', boundary: 'complete', events: [event] }])
  await first.close()
  const reopened = client()
  expect(await reopened.request('cursor', ['stream'])).toBe('1')
  const target = { state: 'ready' as const, key: 'selected-profile-and-model' }
  const claimed = await reopened.request('claim', [target])
  if (claimed.state !== 'claimed') throw new Error(claimed.state)
  const learned = await reopened.request('finish', [claimed.lease, [{ kind: 'working_preference', facet: 'debugging',
    assertionType: 'stated_preference', scope: { profileId: 'owner', projectId: 'project' }, claim: event.text,
    rationale: 'It makes repair review easier.', futureAction: 'Start with a failing test.', applicability: { taskType: 'debugging' },
    exceptions: [], retrievalCues: ['test', 'bug'], evidenceClass: 'user_stated',
    evidence: [{ sourceEventId: event.id, quote: event.text, paths: ['/claim', '/rationale', '/futureAction', '/applicability', '/exceptions', '/validity'] }],
    conflictKey: 'debugging-order', validity: { validFrom: null, validUntil: null, recheckWhen: [] },
  }], target])
  expect(learned.state).toBe('learned')
  const packet = await reopened.recall({ query: 'bug', conditions: { taskType: 'debugging' } }, access)
  expect(packet.items).toHaveLength(1)
  expect((await reopened.recall({ query: 'bug' }, { ...access, profileId: 'someone_else' })).status).toBe('denied')
  const page = await reopened.request('libraryPage', ['owner'])
  expect(page.items[0].id).toBe(packet.items[0].id)
  const notebooks = await reopened.request('libraryNotebooks', ['owner', { limit: 12 }])
  expect(notebooks.items).toHaveLength(1)
  const notebookId = notebooks.items[0].id
  await expect(reopened.request('libraryNotebook', ['foreign', notebookId])).rejects.toThrow('scope_denied')
  await reopened.request('notebookPending', [])
  const notebook = await reopened.request('notebookClaim', [target])
  if (notebook.state !== 'claimed') throw new Error(notebook.state)
  await reopened.request('notebookFinish', [notebook.lease, { statements: [{ text: event.text,
    supports: [{ memoryId: packet.items[0].id, revision: packet.items[0].revision, paths: ['/claim'] }] }] }, target])
  expect((await reopened.request('libraryNotebook', ['owner', notebookId]))?.explanation?.statements[0].supports[0])
    .toMatchObject({ memoryId: packet.items[0].id, revision: 1 })
  await expect(reopened.request('libraryDetail', ['foreign', packet.items[0].id])).rejects.toThrow('scope_denied')
  const prepared = await reopened.request('prepareRecall', [{ query: 'bug', conditions: { taskType: 'debugging' } },
    { engine: 'codex', sessionId: 'receiving', projectId: 'project', route: 'prompt_hook' }, { ...access, includeProfile: true }])
  const rating = await reopened.request('libraryPreview', ['owner', { kind: 'feedback', id: packet.items[0].id,
    revision: 1, receiptId: prepared.receipt!.id, value: 'helpful', expected: 0 }])
  await reopened.request('libraryApply', ['owner', rating.command, rating.version, true])
  expect((await reopened.request('libraryDetail', ['owner', packet.items[0].id]))?.recalls[0].feedback.value).toBe('helpful')
  expect((await reopened.recall({ query: 'bug', conditions: { taskType: 'debugging' } }, access)).items[0]).not.toHaveProperty('feedback')
  const preview = await reopened.request('libraryPreview', ['owner', { kind: 'forget', id: packet.items[0].id, revision: packet.items[0].revision }])
  expect((await reopened.request('libraryDetail', ['owner', packet.items[0].id]))?.record.id).toBe(packet.items[0].id)
  await reopened.request('libraryApply', ['owner', preview.command, preview.version, true])
  expect((await reopened.recall({ query: 'bug', conditions: { taskType: 'debugging' } }, access)).items).toEqual([])
  expect(await reopened.request('libraryNotebook', ['owner', notebookId])).toBeNull()
  expect((await reopened.request('libraryNotebooks', ['owner'])).items).toEqual([])
})

it('enforces a recall deadline while a worker is blocked, leaving the parent event loop responsive', async () => {
  const slow = client(`const {parentPort} = require('node:worker_threads');
    parentPort.on('message', message => {
      if(message.operation === 'close') { parentPort.close(); return; }
      if(message.operation === 'recall') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      parentPort.postMessage({type:'result',id:message.id,ok:true,value:{status:'ok',items:[],text:'',estimatedTokens:0}});
    }); parentPort.postMessage({type:'ready',ok:true});`)
  await slow.request('controls', [])
  const started = performance.now()
  const packet = await slow.recall({ query: 'bug' }, access, 20)
  expect(packet.status).toBe('timeout')
  expect(packet.text).toBe('')
  expect(performance.now() - started).toBeLessThan(200)
})

it('reports a failed store without an unhandled rejection or blocking the current task', async () => {
  const unavailable = client(`const {parentPort} = require('node:worker_threads');
    parentPort.postMessage({type:'ready',ok:false,reason:'sqlite_unavailable'}); parentPort.close();`)
  expect((await unavailable.recall({ query: 'bug' }, access)).status).toBe('unavailable')
  await expect(unavailable.request('capture', [{ streamId: 'stream', engine: 'claude', sessionId: 'session', projectId: 'project',
    episodeId: 'episode', from: null, to: '1', boundary: 'complete', events: [] }])).rejects.toThrow('worker_closed')
})
