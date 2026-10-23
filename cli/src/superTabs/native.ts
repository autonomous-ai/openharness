import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, type BigIntStats } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CoreApi } from '../core/api.js'
import { nativeTurnCursorIn, type NativeTurnCursor, type NativeTurnObservation } from '../lib/nativeTurnObservations.js'
import { REPLACED_PROGRAM } from '../engines/kit/identityScan.js'
import { backend, SuperTabHostError } from './host.js'
import { identifier, object } from './wire.js'

interface Context {
  tabId: string; baseline: NativeTurnCursor; until: number; head: string | null; blocked?: string
  recoveryClockOffset?: number; lastGapId?: string
}
const GAP_REASONS = ['recording_restarted', 'history_lost', 'unattributed_input', 'context_expired', 'agent_stopped', 'prompt_missing'] as const
interface Gap { incidentId: string; reason: typeof GAP_REASONS[number]; detectedAt: number }
interface Event {
  contextId: string; turnId: string; kind: 'prompt' | 'answer' | 'gap'; previousEventId: string | null
  text: string; truncated: boolean; interrupted: boolean
  gap?: Gap
}
interface RecordedAgent {
  cursor: NativeTurnCursor; contexts: Record<string, Context>; turns: Record<string, string>; outbox: Event[]
}
interface Journal { version: 1; machineId: string; agents: Record<string, RecordedAgent> }
const MAX_BYTES = 8 * 1024 * 1024, MAX_EVENTS = 1024, CONTEXT_LEASE = 90_000
// An unlinked file's inode can be reused immediately on Linux. Include change
// metadata so replacement or an in-place edit cannot revive stale journal state.
const journalIdentity = (stat: BigIntStats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
const eventId = (event: Event) => createHash('sha256').update(JSON.stringify(['native-event', event.contextId, event.turnId, event.kind])).digest('hex').slice(0, 24)
export const nativeJournalFile = (dataDir: string, machineId: string) => join(dataDir, 'super-tabs', `native-${machineId}.json`)
const validIdOrNull = (value: unknown) => value === null || identifier(value)
const copyEvent = (event: NativeTurnObservation): Omit<Event, 'contextId' | 'previousEventId'> => ({
  turnId: event.turnId, kind: event.kind, text: event.text, truncated: event.truncated, interrupted: event.interrupted,
})

/** The core reads no turns for an agent whose conversation it has not identified. Say why, so the person
 *  restarts the agent instead of updating a Harness that is already current. */
function unidentified(hold: string | undefined): string {
  if (hold?.includes(REPLACED_PROGRAM)) return 'This agent’s program was updated while it was running. Restart the agent, then retry.'
  return 'Harness hasn’t identified this terminal’s conversation yet. Retry in a moment, or restart the agent.'
}

/** Durable conversation recording stays outside the core. Capturing a bounded
 * page never waits for the backend; flushing the outbox never writes into an agent. */
export class NativeRecorder {
  private journal: Journal
  private readonly file: string
  private stopped = false
  private capturing: Promise<void> = Promise.resolve()
  private flushing: Promise<void> | null = null
  private captureRunning: Promise<void> | null = null
  private identity: string | null = null
  private readonly now: () => number
  private readonly write: (file: string, value: string) => void
  constructor(private readonly core: CoreApi, private readonly machineId: string, options: {
    now?: () => number; write?: (file: string, value: string) => void
  } = {}) {
    if (!identifier(machineId)) throw new Error('This machine is unavailable.')
    this.now = options.now ?? Date.now
    this.file = nativeJournalFile(core.dataDir, machineId)
    this.write = options.write ?? ((file, value) => {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${randomUUID()}.next`
      writeFileSync(temporary, value, { mode: 0o600, flush: true, flag: 'wx' })
      renameSync(temporary, file)
      writeFileSync(`${file}.ready`, '1', { mode: 0o600, flush: true })
    })
    this.journal = { version: 1, machineId, agents: {} }
    if (existsSync(`${this.file}.ready`) && !existsSync(this.file)) throw new Error('The terminal recording journal is missing. Restore it before reconnecting.')
    if (existsSync(this.file)) {
      const stat = lstatSync(this.file, { bigint: true })
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('The terminal recording journal is unavailable.')
      this.identity = journalIdentity(stat)
      const saved = object(JSON.parse(readFileSync(this.file, 'utf8')))
      if (saved.version !== 1 || saved.machineId !== machineId || !saved.agents || typeof saved.agents !== 'object' || Array.isArray(saved.agents)) throw new Error('Invalid terminal recording journal.')
      for (const [harnessId, value] of Object.entries(object(saved.agents))) {
        const row = object(value), cursor = nativeTurnCursorIn(row.cursor)
        if (!identifier(harnessId) || !cursor || !Array.isArray(row.outbox) || row.outbox.length > MAX_EVENTS) throw new Error('Invalid terminal recording cursor.')
        if (!row.contexts || typeof row.contexts !== 'object' || Array.isArray(row.contexts)
          || !row.turns || typeof row.turns !== 'object' || Array.isArray(row.turns)) throw new Error('Invalid terminal recording contexts.')
        const contexts = object(row.contexts), turns = object(row.turns)
        if (Object.keys(contexts).length > 256 || Object.keys(turns).length > 256) throw new Error('Too many terminal recording contexts.')
        for (const [id, entry] of Object.entries(contexts)) {
          const c = object(entry)
          if (!identifier(id) || !identifier(c.tabId) || !nativeTurnCursorIn(c.baseline) || !Number.isFinite(c.until)
            || !validIdOrNull(c.head) || (c.blocked !== undefined && typeof c.blocked !== 'string')
            || (c.recoveryClockOffset !== undefined && !Number.isFinite(c.recoveryClockOffset))
            || (c.lastGapId !== undefined && !identifier(c.lastGapId))) throw new Error('Invalid terminal context.')
        }
        for (const [id, contextId] of Object.entries(turns)) if (!identifier(id) || !identifier(contextId) || !contexts[contextId]) throw new Error('Invalid terminal turn.')
        for (const value of row.outbox) {
          const e = object(value)
          if (!identifier(e.contextId) || !contexts[e.contextId] || !identifier(e.turnId) || !['prompt', 'answer', 'gap'].includes(String(e.kind))
            || !validIdOrNull(e.previousEventId) || typeof e.text !== 'string' || e.text.length > 16_000
            || typeof e.truncated !== 'boolean' || typeof e.interrupted !== 'boolean') throw new Error('Invalid terminal observation.')
          if (e.gap !== undefined) {
            const gap = object(e.gap)
            if (e.kind !== 'gap' || !identifier(gap.incidentId) || !GAP_REASONS.includes(gap.reason as Gap['reason'])
              || !Number.isSafeInteger(gap.detectedAt) || (gap.detectedAt as number) < 0) throw new Error('Invalid terminal recording gap.')
          }
        }
      }
      if (Object.keys(object(saved.agents)).length > 128) throw new Error('Too many recorded terminals.')
      this.journal = saved as unknown as Journal
    }
  }

  private available(): void {
    if (this.stopped || this.core.daemon.machineId() !== this.machineId) throw new Error('This recording host disconnected.')
    if (existsSync(`${this.file}.ready`) && !existsSync(this.file)) throw new Error('The terminal recording journal is missing.')
    if (this.identity) {
      const stat = lstatSync(this.file, { bigint: true })
      if (!stat.isFile() || journalIdentity(stat) !== this.identity) throw new Error('The terminal recording journal was replaced or changed.')
    }
  }
  private commit(change: (next: Journal) => void): void {
    this.available()
    const next = structuredClone(this.journal)
    change(next)
    const raw = JSON.stringify(next)
    if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('Terminal recording is full. Reconnect after pending observations have synced.')
    this.write(this.file, raw)
    const stat = lstatSync(this.file, { bigint: true })
    this.identity = journalIdentity(stat)
    this.journal = next
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.capturing.catch(() => {}).then(action)
    this.capturing = next.then(() => {}, () => {})
    return next
  }
  stop(): void { this.stopped = true }
  get hasWork(): boolean { return Object.keys(this.journal.agents).length > 0 }

  prepare(tabId: unknown, contextId: unknown, renew = false, closed?: AbortSignal): Promise<{ ok: true; inputContext: string }> {
    return this.serial(async () => {
      this.available()
      if (!identifier(tabId) || !identifier(contextId) || closed?.aborted) throw new Error('This terminal request is no longer available.')
      const verified = object(await backend(this.core, 'GET', `/api/super-tabs/${tabId}/native/${contextId}`))
      const recovery = object(verified.recovery)
      const recoveryClockOffset = recovery.version === 1 && Number.isSafeInteger(recovery.serverTime)
        ? (recovery.serverTime as number) - this.now() : undefined
      this.available()
      const harnessId = verified.harnessId
      if (closed?.aborted || verified.contextId !== contextId || verified.tabId !== tabId || verified.machineId !== this.machineId
        || !identifier(harnessId) || !this.core.agents.byAgent(harnessId) || !validIdOrNull(verified.lastEventId)) {
        throw new Error('The exact contributed terminal is unavailable on this machine.')
      }
      const existing = this.journal.agents[harnessId]?.contexts[contextId]
      if (existing?.blocked) throw new Error(existing.blocked)
      if (renew && (!existing || existing.until <= this.now())) throw new Error('Terminal recording expired. Reopen the terminal from this conversation.')
      const read = this.core.transcripts.nativeTurns
      if (!read) throw new Error('Update this machine’s Harness to record native terminal conversations.')
      const page = await read(harnessId)
      this.available()
      if (closed?.aborted) throw new Error('This terminal request is no longer available.')
      if (!page) throw new Error(unidentified(this.core.agents.byAgent(harnessId)?.identityHold))
      if (!existing && !this.journal.agents[harnessId] && Object.keys(this.journal.agents).length >= 128) throw new Error('Too many recorded terminals are active.')
      if (!existing && Object.keys(this.journal.agents[harnessId]?.contexts ?? {}).length >= 256) throw new Error('Too many terminal contexts are active.')
      this.commit(next => {
        const row = next.agents[harnessId] ??= { cursor: page.cursor, contexts: {}, turns: {}, outbox: [] }
        if (existing) {
          row.contexts[contextId]!.until = this.now() + CONTEXT_LEASE
          row.contexts[contextId]!.recoveryClockOffset = recoveryClockOffset
        }
        else {
          row.contexts[contextId] = { tabId, baseline: page.cursor, until: this.now() + CONTEXT_LEASE,
            head: verified.lastEventId as string | null, recoveryClockOffset }
          if (verified.lastEventId) this.gap(row, contextId, harnessId, page.cursor.epoch, 'recording_restarted')
        }
      })
      return { ok: true, inputContext: contextId }
    })
  }

  private enqueue(row: RecordedAgent, contextId: string, event: Omit<Event, 'contextId' | 'previousEventId'>): void {
    if (row.outbox.length >= MAX_EVENTS) throw new Error('The terminal recording outbox is full.')
    const context = row.contexts[contextId]!
    const last = row.outbox.findLast(e => e.contextId === contextId)
    row.outbox.push({ ...event, contextId, previousEventId: last ? eventId(last) : context.head })
  }

  private gap(row: RecordedAgent, contextId: string, harnessId: string, boundary: string, reason: Gap['reason'], interrupted = false): void {
    const context = row.contexts[contextId]!
    // Preparation and capture can both see the same restarted core. The epoch
    // identifies that incident across views and durable outbox retries.
    const incidentId = createHash('sha256').update(JSON.stringify(['native-gap', this.machineId, harnessId, reason, boundary])).digest('hex').slice(0, 24)
    if (context.lastGapId === incidentId) return
    // An expired view can be prepared again in the same core epoch. It reports
    // the same incident but appends at a new head, so it needs its own observation.
    const last = row.outbox.findLast(event => event.contextId === contextId)
    const turnId = createHash('sha256').update(JSON.stringify([incidentId, last ? eventId(last) : context.head])).digest('hex').slice(0, 24)
    this.enqueue(row, contextId, { turnId, kind: 'gap', text: '', truncated: false, interrupted,
      ...(context.recoveryClockOffset === undefined ? {} : { gap: { incidentId, reason, detectedAt: this.now() + context.recoveryClockOffset } }) })
    context.lastGapId = incidentId
  }

  private expired(row: RecordedAgent): string[] {
    const retained = new Set([...Object.values(row.turns), ...row.outbox.map(e => e.contextId)])
    return Object.keys(row.contexts).filter(id => row.contexts[id]!.until <= this.now() && !retained.has(id))
  }
  private prune(next: Journal, harnessId: string): void {
    const row = next.agents[harnessId]!
    for (const id of this.expired(row)) delete row.contexts[id]
    if (!Object.keys(row.contexts).length) delete next.agents[harnessId]
  }

  capture(): Promise<void> {
    return this.captureRunning ??= this.serial(async () => {
      this.available()
      for (const harnessId of Object.keys(this.journal.agents)) {
        const before = this.journal.agents[harnessId]!
        // Reserve enough space for a complete bounded core page and one gap per
        // context. Never acknowledge a partially retained page.
        if (before.outbox.length + 512 + Object.keys(before.contexts).length > MAX_EVENTS) continue
        // Read the final boundary before retiring an expired view. A delayed
        // host must report lost activity instead of silently dropping its cursor.
        const page = await this.core.transcripts.nativeTurns?.(harnessId, before.cursor)
        this.available()
        if (!page) {
          if (await this.core.agents.stopped?.(harnessId)) {
            this.commit(next => {
              const row = next.agents[harnessId]!
              for (const id of new Set(Object.values(row.turns))) this.gap(row, id, harnessId, row.cursor.epoch, 'agent_stopped', true)
              row.turns = {}
              for (const c of Object.values(row.contexts)) c.until = 0
              this.prune(next, harnessId)
            })
          }
          continue
        }
        if (!page.gap && page.cursor.epoch === before.cursor.epoch && page.cursor.sequence === before.cursor.sequence) {
          if (this.expired(before).length) this.commit(next => this.prune(next, harnessId))
          continue
        }
        // Store observations and the cursor in the same durable write. A crash
        // cannot advance the cursor without retaining its unsent records.
        this.commit(next => {
          const row = next.agents[harnessId]!
          const gaps = new Set<string>()
          const gap = (id: string, reason: Gap['reason']) => {
            if (gaps.has(id)) return
            gaps.add(id)
            this.gap(row, id, harnessId, reason === 'recording_restarted' ? page.cursor.epoch
              : `${page.cursor.epoch}:${page.cursor.sequence}`, reason)
          }
          if (page.gap || page.observations.some(event => event.kind === 'prompt' && event.unattributedInput)) {
            for (const [id, c] of Object.entries(row.contexts)) {
              if (!c.blocked) gap(id, page.gap ? (page.cursor.epoch !== before.cursor.epoch ? 'recording_restarted' : 'history_lost') : 'unattributed_input')
            }
            if (page.gap) row.turns = {}
          }
          for (const observation of page.observations) {
            const contextId = observation.inputContext, context = contextId ? row.contexts[contextId] : undefined
            // Never export a prompt with unknown provenance, or content from a
            // different conversation that happens to share the same harness.
            if (!contextId || !context || context.blocked) continue
            if (context.baseline.epoch === page.cursor.epoch && observation.sequence <= context.baseline.sequence) continue
            if (observation.kind === 'prompt') {
              if (context.until <= this.now()) { gap(contextId, 'context_expired'); continue }
              row.turns[observation.turnId] = contextId
              this.enqueue(row, contextId, copyEvent(observation))
            } else if (row.turns[observation.turnId] === contextId) {
              this.enqueue(row, contextId, copyEvent(observation))
              delete row.turns[observation.turnId]
            } else if (context.until > this.now()) {
              this.gap(row, contextId, harnessId, observation.turnId, 'prompt_missing', true)
            }
          }
          row.cursor = page.cursor
          this.prune(next, harnessId)
        })
      }
    }).finally(() => { this.captureRunning = null })
  }

  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return this.flushing ??= this.send().finally(() => { this.flushing = null })
  }
  private async send(): Promise<void> {
    let failure: unknown
    for (const harnessId of Object.keys(this.journal.agents)) {
      for (let sent = 0; sent < 32; sent++) {
        this.available()
        const row = this.journal.agents[harnessId], event = row?.outbox[0]
        if (!event) break
        const context = row.contexts[event.contextId]!
        if (context.blocked) break
        const { contextId, ...body } = event
        try {
          const result = object(await backend(this.core, 'POST', `/api/super-tabs/${context.tabId}/native/${contextId}`, body))
          this.available()
          if (result.eventId !== eventId(event)) throw new Error('The backend did not confirm this exact native observation.')
          this.commit(next => {
            const current = next.agents[harnessId]!
            current.contexts[contextId]!.head = result.eventId as string
            current.outbox.shift()
          })
        } catch (error) {
          if (error instanceof SuperTabHostError && [400, 403, 404, 409].includes(error.status)) {
            this.commit(next => {
              const current = next.agents[harnessId]!
              current.contexts[contextId]!.blocked = 'Terminal recording stopped because access or its recording history changed. Reopen it from the conversation.'
              current.outbox = current.outbox.filter(e => e.contextId !== contextId)
              for (const [turnId, id] of Object.entries(current.turns)) if (id === contextId) delete current.turns[turnId]
            })
          }
          failure ??= error
          break
        }
      }
    }
    if (failure) throw failure
  }
}
