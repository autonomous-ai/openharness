/** A single immutable component capture, one paced chunk, no retained encoded catalogue. */
import { randomUUID } from 'node:crypto'
import { CLOUD_AGENT_IDS, cloudPresentation, type CloudHarness } from '../lib/cloudAgents.js'
import { SESSION_FACTS_FORMAT } from '../lib/sessionPresentation.js'
import { SESSION_OWNER_CHUNK_BYTES, SESSION_OWNER_CHUNK_ROWS, type OwnerAppend, type OwnerCard, type OwnerResult,
  type SessionOwnerCore } from '../lib/sessionOwnerWire.js'

export const CLOUD_OWNER_FACTORY = CLOUD_AGENT_IDS[0]

export async function transferCloudPresentation(core: SessionOwnerCore, rows: readonly CloudHarness[], cards: readonly OwnerCard[],
  before: string, after: string, within: <T>(value: T | Promise<T>, waitMs?: number) => Promise<T>, current: () => boolean,
  timeoutMs: number): Promise<OwnerResult> {
  const transfer = randomUUID(), expires = performance.now() + timeoutMs
  const step = <T>(action: () => T | Promise<T>): Promise<T> => {
    const waitMs = expires - performance.now()
    if (waitMs <= 0 || !current()) return Promise.reject(new Error('CLOUD_PUBLICATION_UNAVAILABLE'))
    return within(action(), waitMs)
  }
  const began = await step(() => core.begin({ format: SESSION_FACTS_FORMAT, transfer, factory: CLOUD_OWNER_FACTORY, before, after, count: rows.length }))
  if (!began.ok || !current()) return began.ok ? { ok: false, error: 'SERVICE_UNAVAILABLE' } : began
  let committed = false
  try {
    let index = 0, cardIndex = 0
    while (index < rows.length) {
      const chunk: OwnerAppend = { transfer, index, rows: [] }
      let bytes = Buffer.byteLength(JSON.stringify(chunk))
      while (index + chunk.rows.length < rows.length && chunk.rows.length < SESSION_OWNER_CHUNK_ROWS) {
        const row = rows[index + chunk.rows.length], card = cards[cardIndex]?.agentId === row.agentId ? cards[cardIndex] : undefined
        const item: OwnerAppend['rows'][number] = { facts: cloudPresentation(row), ...(card ? { card } : {}) }
        // A transient second pure construction/encoding is charged to the component, not cached in either process.
        const size = Buffer.byteLength(JSON.stringify(item)) + Number(chunk.rows.length > 0)
        if (bytes + size > SESSION_OWNER_CHUNK_BYTES - 2048) {
          if (!chunk.rows.length) return { ok: false, error: 'SESSION_OWNER_LIMIT' }
          break
        }
        bytes += size; chunk.rows.push(item)
        if (card) cardIndex++
      }
      const admitted = await step(() => core.append(chunk))
      if (!admitted.ok || !current()) return admitted.ok ? { ok: false, error: 'SERVICE_UNAVAILABLE' } : admitted
      index += chunk.rows.length
    }
    if (cardIndex !== cards.length) return { ok: false, error: 'SESSION_OWNER_INVALID' }
    const result = await step(() => core.end(transfer))
    committed = result.ok
    return current() ? result : { ok: false, error: 'SERVICE_UNAVAILABLE' }
  } finally {
    // Cancellation releases only this stage. A lost end ACK is reconciled by exact checkpoint on reconnect.
    // No new query follows an unresolved timed-out one. Core's same absolute bound releases its stage then.
    if (!committed && current() && performance.now() < expires) {
      try { await step(() => core.cancel(transfer)) } catch { /* current-link expiry already holds publication */ }
    }
  }
}
