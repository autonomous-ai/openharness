/** Synthetic, local-only storage/recall benchmark. Never opens the user's actual memory database. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, platform, arch } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { CodingMemoryStore } from '../src/memory/store.js'
import { MemoryClient } from '../src/memory/client.js'
import type { SourceEvent, MemoryDraft } from '../src/memory/types.js'
import type { RecallPacket, RecallRequest } from '../src/memory/types.js'

const receiptMode = process.argv.includes('--receipts')
const notebookMode = process.argv.includes('--notebooks')
const feedbackMode = process.argv.includes('--feedback')
const activityMode = process.argv.includes('--activity')
if ([receiptMode, notebookMode, feedbackMode, activityMode].filter(Boolean).length > 1) throw new Error('Choose one benchmark mode')
const directory = await mkdtemp(join(tmpdir(), 'harness-memory-benchmark-'))
const binding = { engine: 'codex' as const, sessionId: 'synthetic_session', projectId: 'project_1', route: 'prompt_hook' as const }
const access = { profileId: 'benchmark', projectIds: ['project_1'], includeProfile: receiptMode || feedbackMode || activityMode }
const query = { query: 'fixture_5321', conditions: { taskType: 'debugging' } }
let client: MemoryClient | undefined
const activitySamples: number[] = []
let largestActivityBytes = 0
const receivers = [{ agentId: 'active', engine: binding.engine, sessionId: binding.sessionId },
  ...Array.from({ length: 127 }, (_, i) => ({ agentId: `open_${i}`, engine: binding.engine, sessionId: `receiver_${4_000 + i}` }))]
async function activity(): Promise<void> {
  if (!activityMode) return
  const started = performance.now()
  const result = await client!.request('libraryActivity', ['benchmark', receivers, { agentId: 'active' }])
  activitySamples.push(performance.now() - started)
  if (result.sessions.length !== 128 || result.selectedAgentId !== 'active' || !result.items.length
    || result.items.some(item => item.record.scope.projectId !== 'project_1')) throw new Error('activity_mismatch')
  largestActivityBytes = Math.max(largestActivityBytes, Buffer.byteLength(JSON.stringify(result)))
}
async function recall(request: RecallRequest): Promise<RecallPacket> {
  if (!receiptMode && !activityMode) return client!.recall(request, access)
  try { return (await client!.request('prepareRecall', [request, binding, access], 200)).packet }
  catch (error) { if ((error as { code?: string }).code !== 'memory_deadline') throw error
    return { status: 'timeout', items: [], text: '', estimatedTokens: 0 } }
}
try {
  const opened = CodingMemoryStore.open({ directory, profileId: 'benchmark' })
  if (!opened.ok) throw new Error(opened.reason)
  const store = opened.store
  const count = 10_000
  const seededAt = performance.now()
  try {
    store.setControls({ learn: true, recall: true })
    for (let project = 0; project < 10; project++) store.registerProject(`project_${project}`)
    for (let i = 0; i < count; i++) {
      const projectId = `project_${i % 10}`
      const event: SourceEvent = { id: `source_${i}`, profileId: 'benchmark', projectId, engine: i % 2 ? 'codex' : 'claude',
        sessionId: `session_${i}`, nativeEventId: `event_${i}`, role: 'user', eligibility: 'coding', observedAt: Date.now(), rootIds: [`source_${i}`],
        text: `For fixture_${i} debugging, start with a failing test because reviewing small repairs is easier.` }
      store.ingest(event)
      const draft: MemoryDraft = { kind: 'working_preference', facet: notebookMode ? `debugging_${Math.floor(i / 10) % 10}` : 'debugging', assertionType: 'stated_preference',
        scope: { profileId: 'benchmark', projectId }, claim: event.text, rationale: 'Reviewing small repairs is easier.',
        futureAction: 'Start with a failing test.', applicability: { taskType: 'debugging' }, exceptions: [], retrievalCues: [`fixture_${i}`, 'debugging'],
        evidenceClass: 'user_stated', evidence: [{ sourceEventId: event.id, quote: event.text,
          paths: ['/claim', '/rationale', '/futureAction', '/applicability'] }], conflictKey: `fixture_${i}`,
        validity: { validFrom: null, validUntil: null, recheckWhen: [] } }
      store.propose(draft, { profileId: 'benchmark', projectIds: [projectId], includeProfile: false })
    }
    if (receiptMode || activityMode) {
      const first = store.prepareRecall(query, binding, access).receipt!
      for (let i = 0; i < 5_000; i++) store.prepareRecall(query,
        activityMode ? { ...binding, sessionId: `receiver_${i}` } : binding, access)
      if (store.recallEmitted(first.id, binding, access)) throw new Error('receipt_cap_not_applied')
    }
    if (feedbackMode) {
      for (let index = 0; index < 5_000; index++) {
        const received = store.prepareRecall(query, { ...binding, sessionId: `rated_${index}` }, access)
        const record = received.packet.items.find(item => item.claim.includes('fixture_5321'))
        if (!received.receipt || !record) throw new Error('feedback_recall_missing')
        const command = { kind: 'feedback' as const, id: record.id, revision: record.revision,
          receiptId: received.receipt.id, value: index % 3 ? 'helpful' as const : 'unhelpful' as const, expected: 0 }
        const preview = store.libraryPreview('benchmark', command)
        store.libraryApply('benchmark', command, preview.version, false)
      }
    }
  } finally { store.close() }
  const seedMs = performance.now() - seededAt
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/memory/worker.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent' })
  const workerSource = bundle.outputFiles[0].text
  if (notebookMode) {
    const samples = { coldIndex: [] as number[], coldDetail: [] as number[], warmIndex: [] as number[], warmDetail: [] as number[] }
    let timeouts = 0, requests = 0, largestPageBytes = 0
    const measure = async <T>(values: number[], read: () => Promise<T>): Promise<T | null> => {
      const started = performance.now()
      ++requests
      try { return await read() }
      catch (error) {
        if ((error as { code?: string }).code !== 'memory_deadline') throw error
        ++timeouts
        return null
      } finally { values.push(performance.now() - started) }
    }
    let cursor: string | undefined
    const browse = async (cold: boolean) => {
      const index = await measure(cold ? samples.coldIndex : samples.warmIndex,
        () => client!.request('libraryNotebooks', ['benchmark', { limit: 12, cursor }]))
      if (!index) return
      if (!index.items.length || index.items.length > 12) throw new Error('notebook_index_mismatch')
      cursor = index.nextCursor ?? undefined
      const detail = await measure(cold ? samples.coldDetail : samples.warmDetail, async () => {
        const value = await client!.request('libraryNotebook', ['benchmark', index.items[0].id])
        if (!value) throw new Error('missing_notebook_detail')
        return value
      })
      if (!detail) return
      if (detail.summary.id !== index.items[0].id || detail.summary.activeRecords !== 100
        || detail.memories.items.length !== 20 || !detail.memories.nextCursor || detail.explanation !== null) {
        throw new Error('notebook_detail_mismatch')
      }
      largestPageBytes = Math.max(largestPageBytes, Buffer.byteLength(JSON.stringify(detail)))
    }
    for (let index = 0; index < 10; index++) {
      client = new MemoryClient({ directory, profileId: 'benchmark', source: workerSource })
      await browse(true)
      await client.close(); client = undefined
    }
    client = new MemoryClient({ directory, profileId: 'benchmark', source: workerSource })
    await client.request('controls', [])
    const lag = monitorEventLoopDelay({ resolution: 1 }); lag.enable()
    try { for (let index = 0; index < 100; index++) await browse(false) }
    finally { lag.disable() }
    const summarize = (values: number[]) => {
      values.sort((a, b) => a - b)
      return { p50Ms: values[Math.ceil(values.length * .5) - 1], p95Ms: values[Math.ceil(values.length * .95) - 1], maxMs: values.at(-1) }
    }
    console.log(JSON.stringify({ kind: 'synthetic-memory-performance', mode: 'owner-notebooks',
      records: count, projects: 10, notebooks: 100, node: process.version, platform: platform(), arch: arch(), seedMs,
      samples: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, summarize(values)])),
      requests, timeouts, largestPageBytes, parentEventLoopP95Ms: lag.percentile(95) / 1e6,
      limitations: ['Synthetic queued notebooks; generated-prose detail cost is not measured.',
        'Cold means a new worker for the index, not an emptied OS disk cache; its detail follows in the same worker.',
        'One local machine; no native model calls, semantic quality or comparative task benefit measured.'] }, null, 2))
  } else {
  const cold: number[] = []
  let timeouts = 0
  for (let i = 0; i < 10; i++) {
    client = new MemoryClient({ directory, profileId: 'benchmark', source: workerSource })
    const start = performance.now()
    const packet = await recall(query)
    cold.push(performance.now() - start)
    if (packet.status === 'timeout') timeouts++
    else if (packet.status !== 'ok' || !packet.items.some(item => item.claim.includes('fixture_5321'))) throw new Error('cold_recall_mismatch')
    if (packet.status === 'ok') await activity()
    await client.close(); client = undefined
  }
  client = new MemoryClient({ directory, profileId: 'benchmark', source: workerSource })
  await client.request('controls', [])
  const lag = monitorEventLoopDelay({ resolution: 1 }); lag.enable()
  const warm: number[] = []
  let largestPacket = 0
  try {
    for (let i = 0; i < 300; i++) {
      const start = performance.now()
      const packet = await recall(i % 2 ? query : { query: 'debugging', conditions: { taskType: 'debugging' } })
      warm.push(performance.now() - start)
      if (packet.status === 'timeout') timeouts++
      else if (packet.status !== 'ok' || !packet.items.length || packet.items.some(item => item.scope.projectId !== 'project_1')) throw new Error('warm_recall_mismatch')
      largestPacket = Math.max(largestPacket, Buffer.byteLength(packet.text))
      if (packet.status === 'ok') await activity()
    }
  } finally { lag.disable() }
  const summary = (values: number[]) => {
    values.sort((a, b) => a - b)
    return { p50Ms: values[Math.ceil(values.length * .5) - 1], p95Ms: values[Math.ceil(values.length * .95) - 1], maxMs: values.at(-1) }
  }
  console.log(JSON.stringify({ kind: 'synthetic-memory-performance', mode: activityMode ? 'prepare-and-owner-activity' : feedbackMode ? 'recall-with-contextual-feedback' : receiptMode ? 'prepare-with-full-receipt-history' : 'recall',
    retainedReceipts: receiptMode || feedbackMode || activityMode ? 5_000 : 0, ratedContexts: feedbackMode ? 5_000 : 0, records: count, projects: 10, node: process.version,
    platform: platform(), arch: arch(), seedMs, cold: summary(cold), warm: summary(warm), requests: cold.length + warm.length,
    timeouts, largestPacketBytes: largestPacket, parentEventLoopP95Ms: lag.percentile(95) / 1e6,
    ...(activityMode ? { latestAttempts: 5_000, openSessions: receivers.length,
      activityAfterRecall: summary(activitySamples), activityRequests: activitySamples.length, largestActivityBytes } : {}),
    limitations: ['Synthetic lexical matches, not a retrieval-quality benchmark.', 'Cold means a new worker, not an emptied OS disk cache.',
      'One local machine; provider extraction and native hook delivery are not measured.'] }, null, 2))
  }
} finally { await client?.close(); await rm(directory, { recursive: true, force: true }) }
