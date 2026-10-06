import { randomUUID } from 'node:crypto'

export type DraftState = {
  ok: boolean; active: boolean; id: string; revision: number; agentId?: string; name?: string
  context?: string; text?: string; position?: number; total?: number; canUndo?: boolean
  locked?: boolean; canSend?: boolean; error?: string; sent?: boolean; carryId?: string
}
export type DraftPin = { id: string; revision: number; mode: 'replace' | 'append' }
/** Local cable ownership only; not authentication and never inferred from a model/name. */
export type DraftOwner = { mac: string; machineId: string }
type Span = { start: number; end: number }
type Receipt = { ok: true; outcome?: 'submitted' } | { ok: false; error: string; outcome?: 'rejected' | 'uncertain' }
type Delivery = { phase: 'not-requested' | 'pending' | 'rejected' | 'submitted' | 'accepted' | 'uncertain' }
type Content = {
  id: string; revision: number; agentId: string; name: string; context: string; text: string; index: number
  carryId?: string; intent?: string
}
type Submit = (text: string) => Promise<Receipt>
type Entry = Content & {
  owner?: DraftOwner; undo?: { text: string; index: number }; error?: string; delivery: Delivery
  sent?: boolean; settled?: boolean; receipt?: Promise<DraftState>; submit?: Submit; cancel?: () => void
}
/** No closures, audio, undo history or promise: this record has no input authority. */
type Archive = Content & { owner: DraftOwner; expiresAt: number; delivery: Delivery }
const MAX_BYTES = 16_000, PART_BYTES = 480
const ARCHIVE_TTL_MS = 30 * 60_000
const MAX_ARCHIVES = 4, MAX_ARCHIVE_METADATA_BYTES = 2048
const sameOwner = (a: DraftOwner | undefined, b: DraftOwner | undefined) =>
  !!a && !!b && a.mac === b.mac && a.machineId === b.machineId
const unavailable = (id: string, revision: number): DraftState =>
  ({ ok: false, active: false, id, revision, error: 'This draft is no longer available.' })

export function draftOwner(mac: string, machineId: string): DraftOwner | undefined {
  // Use complete values. The native recovery pin has 48 bytes including its terminator.
  return /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac) && /^[\x21-\x7e]{1,47}$/.test(machineId)
    ? { mac, machineId } : undefined
}

/** Bounded viewports over the exact transcript; joining the spans loses no whitespace. */
function spans(text: string): Span[] {
  const out: Span[] = []
  let start = 0
  while (start < text.length) {
    let end = start, bytes = 0, boundary = start
    for (const cp of text.slice(start)) {
      const n = Buffer.byteLength(cp, 'utf8')
      if (bytes + n > PART_BYTES) break
      end += cp.length; bytes += n
      if (/\s/.test(cp)) boundary = end
    }
    if (end < text.length && boundary > start + (end - start) / 2) end = boundary
    out.push({ start, end }); start = end
  }
  return out
}
function valid(text: string): boolean {
  return !!text.trim() && Buffer.byteLength(text, 'utf8') <= MAX_BYTES &&
    !/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(text)
}
/** Fleet lifetime, independent of disposable USB paths/sessions. No on-disk persistence. */
export class VoiceDraftArchives {
  private entries = new Map<string, Archive>()
  constructor(private readonly now: () => number = () => performance.now()) {}
  clear(): void { this.entries.clear() }
  expire(): void {
    for (const [key, a] of this.entries) if (this.now() >= a.expiresAt) this.entries.delete(key)
  }
  retain(content: Content, owner: DraftOwner, delivery: Delivery): void {
    this.expire()
    const key = JSON.stringify([owner.mac, owner.machineId])
    this.entries.delete(key)
    // Four owners × 16,000 text bytes; metadata is separately bounded. Reserve for
    // growing page/revision numbers and the tiny receipt cell, without retaining closures.
    const { text, ...metadata } = content
    if (!draftOwner(owner.mac, owner.machineId) || !valid(text) ||
        Buffer.byteLength(JSON.stringify({ ...metadata, owner })) + 128 > MAX_ARCHIVE_METADATA_BYTES) return
    while (this.entries.size >= MAX_ARCHIVES) this.entries.delete(this.entries.keys().next().value!)
    this.entries.set(key, { ...content, owner: { ...owner }, delivery, expiresAt: this.now() + ARCHIVE_TTL_MS })
  }
  get(id: string, owner?: DraftOwner): Archive | undefined {
    this.expire()
    const a = owner && this.entries.get(JSON.stringify([owner.mac, owner.machineId]))
    return a?.id === id ? a : undefined
  }
  discard(id: string, owner: DraftOwner): void {
    if (this.get(id, owner)) this.entries.delete(JSON.stringify([owner.mac, owner.machineId]))
  }
}
export class VoiceDraft {
  private entry?: Entry

  constructor(now: () => number = () => performance.now(), private readonly archives = new VoiceDraftArchives(now)) {}

  clear(): void {
    const e = this.entry
    this.entry = undefined
    if (e) { e.cancel?.(); e.cancel = undefined; e.submit = undefined }
  }
  forgetAll(): void { this.clear(); this.archives.clear() }
  expire(): void { this.archives.expire() }
  /** Involuntary loss of the owner revokes authority, even if no input was attempted. */
  detach(): void {
    this.expire()
    const e = this.entry
    if (!e) return
    // A copied data record may share only this tiny outcome cell with an in-flight receipt.
    // Eviction/discard removes the record; settling that cell can never recreate it.
    if (e.owner) this.archives.retain({
      id: e.id, revision: e.revision + 1, agentId: e.agentId, name: e.name,
      context: e.context, text: e.text, index: e.index, carryId: e.carryId, intent: e.intent,
    }, e.owner, e.delivery)
    this.clear()
  }
  cancelCreation(id: string): void {
    const e = this.entry
    if (e?.id === id && e.revision === 1 && !e.receipt) this.clear()
  }
  create(input: { agentId: string; name: string; text: string; context?: string; carryId?: string;
    owner?: DraftOwner; intent?: string; submit: Submit; cancel?: () => void }): DraftState {
    this.expire()
    if (this.entry && !this.entry.sent) return this.fail('Finish or discard your existing draft.')
    if (!input.agentId || !valid(input.text)) return this.fail('Record a shorter message to review.')
    this.entry = { ...input, owner: input.owner && { ...input.owner }, id: randomUUID(), revision: 1,
      index: 0, context: input.context ?? '', delivery: { phase: 'not-requested' } }
    return this.state()
  }
  pin(id: string, revision: number, mode: unknown): DraftPin | undefined {
    const e = this.entry
    return e && e.id === id && e.revision === revision && !e.receipt &&
      (mode === 'replace' || mode === 'append') ? { id, revision, mode } : undefined
  }
  current(pin: DraftPin): boolean { return !!this.pin(pin.id, pin.revision, pin.mode) }
  edit(pin: DraftPin, words: string): DraftState {
    if (!this.current(pin)) return this.fail('The draft changed. Open it again.')
    const e = this.entry!, part = spans(e.text)[e.index]
    const old = e.text.slice(part.start, part.end)
    const replacement = (old.match(/^\s*/)?.[0] ?? '') + words.trim() + (old.match(/\s*$/)?.[0] ?? '')
    const text = pin.mode === 'append' ? `${e.text}\n\n${words.trim()}`
      : e.text.slice(0, part.start) + replacement + e.text.slice(part.end)
    if (!words.trim() || !valid(text)) return this.fail('That edit is too long. Try a shorter part.')
    e.undo = { text: e.text, index: e.index }; e.text = text; e.revision++
    if (pin.mode === 'append') e.index = spans(text).length - 1
    else e.index = Math.min(e.index, spans(text).length - 1)
    e.error = undefined
    return this.state()
  }
  async command(id: string, revision: number, op: string, delta = 0, owner?: DraftOwner): Promise<DraftState> {
    this.expire()
    const e = this.entry
    if (!e || e.id !== id) return this.archivedCommand(id, revision, op, delta, owner)
    if (e.owner && !sameOwner(e.owner, owner)) return unavailable(id, revision)
    if (op === 'state') return this.state()
    if (op === 'send' && e.receipt) return e.receipt
    if (revision !== e.revision) return this.fail('The draft changed. Review it again.')
    if (op === 'discard') {
      if (e.receipt && !e.settled) return this.fail('Sending is still in progress. Check its status.')
      const state = e.sent ? this.state(e) : { ok: true, active: false, id, revision }
      this.clear(); return state
    }
    if (e.receipt) return this.fail('Check the terminal before trying again.')
    if (op === 'move' && Number.isInteger(delta) && (delta === -1 || delta === 1)) {
      e.index = Math.max(0, Math.min(spans(e.text).length - 1, e.index + delta)); e.revision++
    } else if (op === 'undo' && e.undo) {
      e.text = e.undo.text; e.index = e.undo.index; e.undo = undefined; e.revision++
    } else if (op === 'send') {
      if (!/^[\n\x20-\x7e\u00a0-\u00ff]*$/u.test(e.text))
        return this.fail('Some words cannot display. Edit them before sending.')
      // Claim before asynchronous input. An uncertain receipt is never retried automatically.
      e.delivery.phase = 'pending'
      e.receipt = Promise.resolve().then(async () => {
        if (this.entry !== e || !e.submit) {
          e.delivery.phase = 'rejected'
          return { ok: false, active: false, id, revision, error: 'Draft discarded.' }
        }
        try {
          const result = await e.submit(e.text)
          e.delivery.phase = result.outcome ?? (result.ok ? 'accepted' : 'uncertain')
          if (!result.ok) { e.error = result.error; return this.state(e) }
          e.sent = true
          return { ok: true, active: false, id, revision, sent: true, carryId: e.carryId }
        } catch {
          e.delivery.phase = 'uncertain'
          e.error = 'Could not confirm sending. Check the terminal before retrying.'
          return this.state(e)
        } finally {
          e.settled = true
        }
      })
      return e.receipt
    } else return this.fail('Choose an available draft action.')
    e.error = undefined
    return this.state()
  }
  private archivedCommand(id: string, revision: number, op: string, delta: number, owner?: DraftOwner): DraftState {
    const a = this.archives.get(id, owner)
    if (!a) return unavailable(id, revision)
    if (op === 'state') return this.archivedState(a)
    // A failed old-id request must never project the different active entry.
    const fail = (error: string) => ({ ...this.archivedState(a), ok: false, error })
    if (revision !== a.revision) return fail('The draft changed. Review it again.')
    if (op === 'discard') { this.archives.discard(id, a.owner); return { ok: true, active: false, id, revision } }
    if (op !== 'move' || (delta !== -1 && delta !== 1)) return fail('Recovered messages are read only.')
    a.index = Math.max(0, Math.min(spans(a.text).length - 1, a.index + delta)); a.revision++
    return this.archivedState(a)
  }
  private archivedState(a: Archive): DraftState {
    const parts = spans(a.text), part = parts[a.index], phase = a.delivery.phase
    const sent = phase === 'submitted' || phase === 'accepted'
    const error = phase === 'not-requested' || phase === 'rejected' ? 'Read only. This message was not sent.'
      : phase === 'submitted' ? 'Read only. Submitted to the original terminal.'
      : phase === 'accepted' ? 'Read only. Passed to Harness; check the terminal.'
      : 'Read only. Check the terminal before sending again.'
    return { ok: true, active: true, id: a.id, revision: a.revision, agentId: a.agentId, name: a.name,
      context: a.context, carryId: a.carryId, text: a.text.slice(part.start, part.end), position: a.index + 1,
      total: parts.length, locked: true, canSend: false, canUndo: false, ...(sent ? { sent: true } : {}), error }
  }
  private fail(error: string): DraftState { return { ...this.state(), ok: false, error } }
  private state(e = this.entry): DraftState {
    if (!e) return { ok: false, active: false, id: '', revision: 0 }
    if (e.sent) return { ok: true, active: false, id: e.id, revision: e.revision, sent: true, carryId: e.carryId }
    const parts = spans(e.text), part = parts[e.index]
    return { ok: !e.error, active: true, id: e.id, revision: e.revision, agentId: e.agentId, name: e.name,
      context: e.context, text: e.text.slice(part.start, part.end), position: e.index + 1, total: parts.length,
      canUndo: !!e.undo, canSend: /^[\n\x20-\x7e\u00a0-\u00ff]*$/u.test(e.text), locked: !!e.receipt, error: e.error }
  }
}
