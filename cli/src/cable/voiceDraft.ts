import { randomUUID } from 'node:crypto'

export type DraftState = {
  ok: boolean; active: boolean; id: string; revision: number; agentId?: string; name?: string
  context?: string; text?: string; position?: number; total?: number; canUndo?: boolean
  locked?: boolean; canSend?: boolean; error?: string; sent?: boolean; carryId?: string
}
export type DraftPin = { id: string; revision: number; mode: 'replace' | 'append' }
type Span = { start: number; end: number }
type Receipt = { ok: true } | { ok: false; error: string }
type Entry = {
  id: string; revision: number; agentId: string; name: string; context: string; text: string; index: number
  carryId?: string; undo?: { text: string; index: number }; error?: string
  sent?: boolean; settled?: boolean; receipt?: Promise<DraftState>; submit: (text: string) => Promise<Receipt>
}
const MAX_BYTES = 16_000, PART_BYTES = 480

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
export class VoiceDraft {
  private entry?: Entry

  clear(): void { this.entry = undefined }
  cancelCreation(id: string): void {
    const e = this.entry
    if (e?.id === id && e.revision === 1 && !e.receipt) this.clear()
  }
  create(input: { agentId: string; name: string; text: string; context?: string; carryId?: string;
    submit: Entry['submit'] }): DraftState {
    if (this.entry && !this.entry.sent) return this.fail('Finish or discard your existing draft.')
    if (!input.agentId || !valid(input.text)) return this.fail('Record a shorter message to review.')
    this.entry = { ...input, id: randomUUID(), revision: 1, index: 0, context: input.context ?? '' }
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
  async command(id: string, revision: number, op: string, delta = 0): Promise<DraftState> {
    const e = this.entry
    if (!e || e.id !== id) return { ok: false, active: false, id, revision, error: 'This draft is no longer available.' }
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
      e.receipt = Promise.resolve().then(async () => {
        if (this.entry !== e) return { ok: false, active: false, id, revision, error: 'Draft discarded.' }
        try {
          const result = await e.submit(e.text)
          if (!result.ok) { e.error = result.error; return this.state(e) }
          e.sent = true
          return { ok: true, active: false, id, revision, sent: true, carryId: e.carryId }
        } catch {
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
