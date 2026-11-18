import { randomUUID } from 'node:crypto'
import { CABLE_MAX_PAYLOAD } from './cableFrame.js'
import { noticeSummary } from './dialText.js'

export interface ReviewQuestion {
  key: string
  q: string
  options: string[]
  multi: boolean
  canText?: boolean
}
export interface ReviewedAnswer {
  agentId: string
  requestId: string
  questions: ReviewQuestion[]
  answers: Record<string, string>
  selections: Record<string, string[]>
  freeTextKeys?: string[]
}
export type AnswerReceipt = { ok: true; pending?: boolean } | { ok: false; error: string }
export type QuestionSpeech = { agentId: string; token: string; index: number }
type Draft = { id: string; text: string }
type Entry = {
  agentId: string; id: string; token: string; signature: string; questions: ReviewQuestion[]
  drafts: Map<number, Draft>
  submitted?: Promise<AnswerReceipt>
  /** The dial holds this question now, as a row. */
  asked?: boolean
  /** The dial has had this question since it last lost everything, by a ring or as a drawer row: a person who could
   *  see the row was told, so ringing it again because the drawer changed would be a beep for nothing new. */
  told?: boolean
  /** Read when its row is opened, never asked: it rang before the devices process restarted (cable/notices.ts), so it
   *  is created told. */
  held?: true
}

/** Questions as JSON, while one frame's payload could carry them. A larger one did not reach the dial (only many half
 *  emojis, each one byte there, shrink one under the cap), so no answer is in its words: kept, 64 agents' questions of
 *  any size were held for nothing. */
function frameJson(raw: unknown): string | undefined {
  try {
    const json = JSON.stringify(raw)
    return json !== undefined && Buffer.byteLength(json, 'utf8') <= CABLE_MAX_PAYLOAD ? json : undefined
  } catch { return undefined }
}

/** A refused question as the dial can file it: its first question's words, cut as a drawer row's are, so the row and
 *  the question it opens read the same. Only a string `q` is read: `raw` may hold anything, a BigInt included. */
function summaryOnly(raw: unknown): ReviewQuestion[] {
  const first: unknown = Array.isArray(raw) ? raw[0] : undefined
  const text = first && typeof first === 'object' && 'q' in first && typeof first.q === 'string' ? noticeSummary(first.q) : ''
  return [{ key: '', q: text || 'Needs your answer', options: [], multi: false }]
}

/** The host owns the pending catalog; the dial holds only the question it is reading.
 * Tokens name immutable contents, not merely the engine's sometimes-reused id.
 * An entry may be one the dial cannot answer (too many questions or options, none, a repeated key, past 6500 bytes): it
 * is kept as its summary alone, so it stays a row on the dial's drawer until the agent closes it, instead of ringing
 * once and vanishing. It is read like any other; `submit`, `canSpeak` and `draft` refuse it by its shape: no mask is
 * valid for an empty option list, and it has no `canText`. */
export class QuestionInbox {
  private readonly entries = new Map<string, Entry>()
  /** The questions each agent asked last, as they came (JSON), reviewable or not: the dial's answer is read against them. */
  private readonly latest = new Map<string, { id: string; json?: string }>()

  /** True when the inbox holds the question as it came; false when it kept only its summary, or nothing. */
  set(agentId: string, id: string, raw: unknown, held = false): boolean {
    // Nobody can close a question with no agent or id: it must not evict, nor replace, one that can be.
    if (!agentId || !id) return false
    if (this.latest.size >= 64 && !this.latest.has(agentId)) {
      const oldest = this.latest.keys().next().value!
      this.latest.delete(oldest); this.entries.delete(oldest)
    }
    this.latest.set(agentId, { id, json: frameJson(raw) })
    const valid = Array.isArray(raw) && raw.length > 0 && raw.length <= 4 &&
      raw.every(q => q && typeof q.key === 'string' && q.key && typeof q.q === 'string' && q.q &&
        Array.isArray(q.options) && q.options.length > 0 && q.options.length <= 6 &&
        q.options.every((o: unknown) => typeof o === 'string' && o.length > 0)) &&
      new Set(raw.map(q => q.key)).size === raw.length
    const reviewable: ReviewQuestion[] | undefined = valid ? raw.map(q => ({ key: q.key, q: q.q,
      options: [...q.options], multi: q.multi === true, ...(q.canText === true ? { canText: true } : {}) })) : undefined
    const whole = !!reviewable && Buffer.byteLength(JSON.stringify([id, reviewable]), 'utf8') <= 6500
    const questions = whole ? reviewable! : summaryOnly(raw)
    const signature = JSON.stringify([id, questions])
    // A summary is small, but its id is not bounded by it: an id of kilobytes, or of control characters six bytes each
    // as JSON, made every frame of it too big, sent and dropped at each drawer. Its own signature is held to the 6500
    // bytes an answerable one is, which keeps its frame under the cap; past them it replaces the agent's last question
    // with nothing, as a refused one did before it was kept.
    if (Buffer.byteLength(signature, 'utf8') > 6500) { this.entries.delete(agentId); return false }
    if (this.entries.get(agentId)?.signature === signature) return whole
    if (this.entries.size >= 64 && !this.entries.has(agentId)) this.entries.delete(this.entries.keys().next().value!)
    for (const question of questions) { Object.freeze(question.options); Object.freeze(question) }
    Object.freeze(questions)
    this.entries.set(agentId, { agentId, id, token: randomUUID(), signature, questions, drafts: new Map(),
      ...(held ? { held: true as const, told: true } : {}) })
    return whole
  }

  /** Every question still open, for a resync. */
  open(): Array<{ agentId: string; id: string; questions: ReviewQuestion[]; held?: true }> {
    return [...this.entries.values()].map(({ agentId, id, questions, held }) =>
      ({ agentId, id, questions, ...(held ? { held } : {}) }))
  }

  /** Whether the dial is to be asked that agent's open question, marking it asked and told: the dial beeps at each ask,
   *  so it is asked once until it loses its questions. False when it was, or that question is no longer the open one. */
  ask(agentId: string, id: string): boolean {
    const entry = this.entries.get(agentId)
    if (!entry || entry.id !== id || entry.asked || entry.held) return false
    entry.asked = entry.told = true
    return true
  }

  /** Whether the dial was told that agent's open question since it last lost everything. */
  told(agentId: string, id: string): boolean {
    const entry = this.entries.get(agentId)
    return !!entry && entry.id === id && !!entry.told
  }

  /** Whether that agent's open question, told but no longer on the dial, is to be given back to it as a row with no
   *  ring, marking it asked. False when it was never told (it is rung instead), the dial has it, or it is no longer the
   *  open one. */
  refile(agentId: string, id: string): boolean {
    const entry = this.entries.get(agentId)
    if (!entry || entry.id !== id || !entry.told || entry.asked) return false
    entry.asked = true
    return true
  }

  /** With `kept`, a drawer replaced whole: the dial holds, and so was told, the questions of the agents it names as
   *  rows, and holds no other; it was still told those. Without, a greeting: its RAM is gone, so each open question it
   *  is not given as a row is to be rung again. */
  forget(kept?: ReadonlySet<string>): void {
    for (const entry of this.entries.values()) {
      entry.asked = !!kept?.has(entry.agentId)
      entry.told = entry.asked || (!!kept && !!entry.told)
    }
  }

  close(agentId: string, id: string): boolean {
    const current = this.latest.get(agentId)?.id
    if (current !== undefined && current !== id) return false
    this.latest.delete(agentId); this.entries.delete(agentId)
    return true
  }

  /** The questions that agent asked under `id`, as they came, while it is the open one. */
  asked(agentId: string, id: string): unknown {
    const latest = this.latest.get(agentId)
    return latest?.id === id && latest.json !== undefined ? JSON.parse(latest.json) : undefined
  }

  read(agentId: string): { ok: true; id: string; token: string; questions: ReviewQuestion[]; submitted: boolean }
    | { ok: false; error: string } {
    const entry = this.entries.get(agentId)
    return entry ? { ok: true, id: entry.id, token: entry.token, questions: entry.questions,
      submitted: !!entry.submitted } : { ok: false, error: 'No readable question. Check the terminal.' }
  }

  canSpeak(pin: QuestionSpeech): boolean {
    const entry = this.entries.get(pin.agentId)
    return !!entry && entry.token === pin.token && !entry.submitted &&
      Number.isInteger(pin.index) && pin.index >= 0 &&
      entry.questions[pin.index]?.canText === true && !entry.questions[pin.index].multi
  }

  draft(pin: QuestionSpeech, text: string): { ok: true; draftId: string; text: string } | { ok: false; error: string } {
    if (!this.canSpeak(pin)) return { ok: false, error: 'This question changed. Open it again.' }
    // Keep the complete answer reviewable on the device; never truncate a submission.
    if (!text.trim() || Buffer.byteLength(text, 'utf8') > 1200 || /[\x00-\x09\x0b-\x1f\x7f]/.test(text))
      return { ok: false, error: 'Say a shorter answer, or use the terminal.' }
    const draft = { id: randomUUID(), text }
    this.entries.get(pin.agentId)!.drafts.set(pin.index, draft)
    return { ok: true, draftId: draft.id, text: draft.text }
  }

  submit(agentId: string, token: string, masks: unknown,
    send: (answer: ReviewedAnswer) => Promise<AnswerReceipt>, drafts?: unknown): Promise<AnswerReceipt> {
    const entry = this.entries.get(agentId)
    const fail = (error: string) => Promise.resolve({ ok: false as const, error })
    if (!entry || entry.token !== token) return fail('This question changed. Open it again.')
    // A receipt, including uncertainty after keys may have been sent, never retries input.
    if (entry.submitted) return entry.submitted
    if (!Array.isArray(masks) || masks.length !== entry.questions.length) return fail('Review every answer first.')
    if (drafts !== undefined && (!Array.isArray(drafts) || drafts.length !== masks.length ||
        drafts.some(id => typeof id !== 'string'))) return fail('Review every answer first.')
    const freeTextKeys: string[] = []
    const answers: Record<string, string> = Object.create(null)
    const selections: Record<string, string[]> = Object.create(null)
    for (let i = 0; i < masks.length; i++) {
      const mask = masks[i], q = entry.questions[i]
      const draftId = Array.isArray(drafts) ? drafts[i] : ''
      if (draftId) {
        const draft = entry.drafts.get(i)
        if (mask !== 0 || !q.canText || q.multi || !draft || draft.id !== draftId)
          return fail('Review the spoken answer again.')
        answers[q.key] = draft.text; selections[q.key] = []; freeTextKeys.push(q.key)
        continue
      }
      if (!Number.isInteger(mask) || mask < 1 || mask >= (1 << q.options.length) ||
          (!q.multi && (mask & (mask - 1)))) return fail('Choose an answer from this question.')
      selections[q.key] = q.options.filter((_, j) => mask & (1 << j))
      answers[q.key] = selections[q.key].join(', ')
    }
    // Install the receipt before invoking any asynchronous terminal work.
    entry.submitted = Promise.resolve().then(() => this.entries.get(agentId) === entry
      ? send({ agentId, requestId: entry.id, questions: entry.questions, answers, selections, ...(freeTextKeys.length ? { freeTextKeys } : {}) })
      : { ok: false as const, error: 'This question changed. Open it again.' })
      .catch(() => ({ ok: false as const, error: 'Could not confirm the answer. Check the terminal.' }))
    return entry.submitted
  }
}
