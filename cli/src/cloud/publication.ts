/** The Cloud component's bounded output owner. Core retains no receipts or notification history. */
import { createHash } from 'node:crypto'
import type { CloudCore } from '../core/api.js'
import { cloudHarnessIn, type CloudHarness } from '../lib/cloudAgents.js'
import { emptyPresentation, prepareCloudCards, type CloudPresentation } from './cards.js'

export interface CloudJournal { version: 1; accepted: CloudPresentation; pending: CloudPresentation | null; checksum: string }
type Question = { agentId: string; requestId: string; question: { text: string; choices: string[] } }
type Action = { kind: 'publish'; changed: CloudHarness[]; removed: string[] }
  | { kind: 'ask'; value: Question } | { kind: 'unask'; agentId: string; requestId: string }
interface Queued { action: Action; bytes: number }
export interface CloudReservation { actions: number; bytes: number; released: boolean }
export const CLOUD_OUTPUT_ACTIONS = 64
export const CLOUD_OUTPUT_BYTES = 6 * 1024 * 1024
// A normalized row has at most eight links, 4,000 answer characters and two 2,000-character card parts.
// JSON escapes may cost six bytes per character. An operation emits at most two rows and three questions.
const ROW_BYTES = 192 * 1024
const RESERVATION_BYTES = 448 * 1024
const RESERVATION_ACTIONS = 6
const WAIT_MS = 10_000
const checksum = ({ version, accepted, pending }: Omit<CloudJournal, 'checksum'>): string =>
  createHash('sha256').update(JSON.stringify({ version, accepted, pending })).digest('hex')
const fingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function presentation(value: unknown): value is CloudPresentation {
  if (!value || typeof value !== 'object') return false
  const state = value as CloudPresentation
  if (!fingerprint(state.fingerprint) || !Array.isArray(state.owners)) return false
  const seen = new Set<string>()
  return state.owners.every(owner => {
    if (!owner || typeof owner.agentId !== 'string' || !owner.agentId.startsWith('cloud_') || owner.agentId.length > 80
      || seen.has(owner.agentId) || !fingerprint(owner.fingerprint) || typeof owner.busy !== 'boolean'
      || typeof owner.told !== 'string' || owner.told.length > 4000) return false
    seen.add(owner.agentId)
    return true
  })
}
function journalIn(value: unknown): CloudJournal | null {
  if (!value || typeof value !== 'object') return null
  const journal = value as CloudJournal
  return journal.version === 1 && presentation(journal.accepted) && (journal.pending === null || presentation(journal.pending))
    && Buffer.byteLength(JSON.stringify(journal)) <= 2 * CLOUD_OUTPUT_BYTES && journal.checksum === checksum(journal) ? journal : null
}

export function createCloudPublication(options: {
  core: CloudCore
  saved: unknown
  /** Atomically writes this metadata alongside the last durable provider snapshot, never optimistic state. */
  persist(journal: CloudJournal): void
  snapshot(): CloudHarness[]
  questions(): Question[]
  log(line: string): void
}) {
  let journal = journalIn(options.saved)
  let accepted = journal?.accepted ?? emptyPresentation()
  let pending: CloudPresentation | null = journal?.pending ?? null
  let epoch = 0, running = false, connected = false, initialized = false, stopped = false, recovering = false
  let hold: string | null = null, unavailable = false
  let bytes = 0, reservedBytes = 0, reservedActions = 0, reservedImageBytes = 0
  let imageBytes = Buffer.byteLength(JSON.stringify(options.snapshot()))
  let queue: Queued[] = []
  let wire = new Map<string, CloudHarness>(), projected = new Map<string, CloudHarness>()
  const cancellations = new Set<() => void>()
  const state = (): CloudJournal => {
    const body = { version: 1 as const, accepted, pending }
    return { ...body, checksum: checksum(body) }
  }
  const fail = (reason: string, permanent = false): void => {
    if (permanent) hold = reason
    if (!unavailable || permanent) options.log(`[cloud] ${reason}`)
    unavailable = true
  }
  const within = <T>(work: T | Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const cancel = () => finish(() => reject(new Error('CLOUD_PUBLICATION_UNAVAILABLE')))
    const timer = setTimeout(cancel, WAIT_MS).unref()
    const finish = (done: () => void) => { clearTimeout(timer); cancellations.delete(cancel); done() }
    cancellations.add(cancel)
    Promise.resolve(work).then(value => finish(() => resolve(value)), () => finish(() => reject(new Error('CLOUD_PUBLICATION_UNAVAILABLE'))))
  })
  const cancel = (): void => { for (const stop of cancellations) stop() }
  const persist = (): void => { options.persist(state()); journal = state() }
  const pump = (): void => {
    if (running || !connected || stopped || recovering || hold || unavailable || !queue.length) return
    running = true
    const generation = epoch
    void (async () => {
      try {
        while (queue.length && generation === epoch && connected) {
          const item = queue[0]
          if (item.action.kind === 'publish') {
            for (const id of item.action.removed) wire.delete(id)
            for (const row of item.action.changed) wire.set(row.agentId, row)
            const rows = [...wire.values()]
            const prepared = prepareCloudCards(rows, accepted)
            if (Buffer.byteLength(JSON.stringify({ harnesses: rows, cards: prepared.cards })) > CLOUD_OUTPUT_BYTES) {
              fail('CLOUD_PUBLICATION_LIMIT', true); return
            }
            pending = prepared.next
            persist()
            const result = await within(options.core.publish(rows, prepared.cards))
            if (generation !== epoch) return
            if (!result.ok) { fail('CLOUD_PUBLICATION_INVALID', true); return }
            accepted = pending
            pending = null
          } else if (item.action.kind === 'ask') {
            const { agentId, requestId, question } = item.action.value
            await within(options.core.ask(agentId, requestId, question))
          } else await within(options.core.unask(item.action.agentId, item.action.requestId))
          if (generation !== epoch) return
          queue.shift(); bytes -= item.bytes
        }
      } catch { if (generation === epoch) fail('CLOUD_PUBLICATION_UNAVAILABLE') }
      finally { if (generation === epoch) running = false }
    })()
  }
  const append = (action: Action, reservation?: CloudReservation): void => {
    if (stopped) return
    const size = Buffer.byteLength(JSON.stringify(action))
    if (reservation) {
      if (reservation.released || reservation.actions < 1 || reservation.bytes < size) {
        fail('CLOUD_PUBLICATION_LIMIT', true); throw new Error('CLOUD_PUBLICATION_LIMIT')
      }
      reservation.actions--; reservation.bytes -= size
      reservedActions--; reservedBytes -= size
    }
    if (queue.length + reservedActions >= CLOUD_OUTPUT_ACTIONS || bytes + reservedBytes + size > CLOUD_OUTPUT_BYTES) {
      fail('CLOUD_PUBLICATION_LIMIT', true); throw new Error('CLOUD_PUBLICATION_LIMIT')
    }
    queue.push({ action, bytes: size }); bytes += size
    pump()
  }
  const publish = (list: CloudHarness[], reservation?: CloudReservation, force = false): void => {
    if (recovering || stopped || hold) return
    const rows = new Map<string, CloudHarness>()
    for (const raw of list) {
      const row = cloudHarnessIn(raw)
      if (row) {
        if (Buffer.byteLength(JSON.stringify(row)) > ROW_BYTES) { fail('CLOUD_PUBLICATION_LIMIT', true); throw new Error('CLOUD_PUBLICATION_LIMIT') }
        if (raw.card && JSON.stringify(raw.card) === JSON.stringify(row.card)) row.card = raw.card
        rows.set(row.agentId, row)
      }
    }
    imageBytes = Buffer.byteLength(JSON.stringify([...rows.values()]))
    if (imageBytes > CLOUD_OUTPUT_BYTES - 4096) {
      fail('CLOUD_PUBLICATION_LIMIT', true); throw new Error('CLOUD_PUBLICATION_LIMIT')
    }
    if (force) { wire = rows; projected = rows }
    const changed = [...rows.values()].filter(row => JSON.stringify(projected.get(row.agentId)) !== JSON.stringify(row))
    const removed = [...projected.keys()].filter(id => !rows.has(id))
    if (!force && !changed.length && !removed.length) return
    append({ kind: 'publish', changed, removed }, reservation)
    projected = rows
  }
  return {
    state,
    blocked: () => !!hold || stopped,
    status: () => hold ?? (unavailable ? 'CLOUD_PUBLICATION_UNAVAILABLE' : null),
    reserve(): CloudReservation | null {
      if (!initialized || hold || stopped || queue.length + reservedActions + RESERVATION_ACTIONS > CLOUD_OUTPUT_ACTIONS
        || bytes + reservedBytes + RESERVATION_BYTES > CLOUD_OUTPUT_BYTES
        || imageBytes + reservedImageBytes + 2 * ROW_BYTES > CLOUD_OUTPUT_BYTES - 4096) return null
      reservedActions += RESERVATION_ACTIONS; reservedBytes += RESERVATION_BYTES; reservedImageBytes += 2 * ROW_BYTES
      return { actions: RESERVATION_ACTIONS, bytes: RESERVATION_BYTES, released: false }
    },
    release(reservation: CloudReservation): void {
      if (reservation.released) return
      reservedActions -= reservation.actions; reservedBytes -= reservation.bytes; reservedImageBytes -= 2 * ROW_BYTES
      reservation.released = true
    },
    publish,
    ask(value: Question, reservation?: CloudReservation): void { if (!recovering && !hold) append({ kind: 'ask', value }, reservation) },
    unask(agentId: string, requestId: string, reservation?: CloudReservation): void { if (!recovering && !hold) append({ kind: 'unask', agentId, requestId }, reservation) },
    async connect(): Promise<void> {
      if (stopped) return
      const generation = ++epoch
      cancel(); initialized = true; connected = true; recovering = true; running = false
      queue = []; bytes = 0; wire = new Map(); projected = new Map()
      try {
        const image = await within(options.core.checkpoint())
        if (generation !== epoch) return
        // Empty authority is a fresh core, including an explicit operator restart after a journal hold.
        if (image === emptyPresentation().fingerprint) accepted = emptyPresentation()
        else if (journal && image === journal.accepted.fingerprint) accepted = journal.accepted
        else if (journal?.pending && image === journal.pending.fingerprint) accepted = journal.pending
        else { fail('CLOUD_PUBLICATION_RECOVERY_REQUIRED', true); return }
        pending = null; hold = null; unavailable = false; recovering = false
        // Unsent history follows the previous reconnect contract: the provider's current state and questions.
        publish(options.snapshot(), undefined, true)
        for (const value of options.questions()) append({ kind: 'ask', value })
      } catch { if (generation === epoch) fail('CLOUD_PUBLICATION_UNAVAILABLE') }
      finally { if (generation === epoch) recovering = false }
    },
    disconnect(): void { ++epoch; connected = false; recovering = false; running = false; cancel() },
    stop(): void { stopped = true; ++epoch; connected = false; cancel(); queue = []; bytes = 0 },
  }
}
