import { randomUUID } from 'node:crypto'

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
}
export interface QuestionNotice {
  agentId: string; id: string; questions: unknown; revision: number
}

/** The host owns the pending catalog; the dial holds only the question it is reading.
 * Tokens name immutable contents, not merely the engine's sometimes-reused id. */
export class QuestionInbox {
  private readonly entries = new Map<string, Entry>()
  private readonly latestIds = new Map<string, string>()
  private readonly notices = new Map<string, QuestionNotice>()
  private revision = 0
  private owner?: string

  bindOwner(owner: string): void {
    if (this.owner === owner) return
    this.clear(); this.owner = owner
  }

  /** Pending work outlives a USB connection and its unread notification. */
  notifications(): QuestionNotice[] {
    return [...this.notices.values()].map(notice => structuredClone(notice))
  }

  notificationCurrent(notice: QuestionNotice): boolean {
    return this.notices.get(notice.agentId)?.revision === notice.revision
  }

  clear(): void {
    this.entries.clear(); this.latestIds.clear(); this.notices.clear()
  }

  set(agentId: string, id: string, raw: unknown): void {
    // Runtime events normally use UUIDs. Bound the catalog's identity storage
    // too; an unusable identity cannot become an actionable restored question.
    if (!agentId || agentId.length > 128) return
    if (!id || id.length > 128) {
      this.latestIds.delete(agentId); this.entries.delete(agentId); this.notices.delete(agentId)
      return
    }
    if (this.latestIds.size >= 64 && !this.latestIds.has(agentId)) {
      const oldest = this.latestIds.keys().next().value!
      this.latestIds.delete(oldest); this.entries.delete(oldest); this.notices.delete(oldest)
    }
    this.latestIds.set(agentId, id)
    // Keep unsupported dialogs discoverable too, without fabricating choices
    // or making them answerable. Oversized/malformed input gets only its title;
    // read() remains authoritative about whether review is available.
    let notification: unknown
    try {
      const encoded = JSON.stringify(raw)
      if (encoded && Buffer.byteLength(encoded, 'utf8') <= 6500) notification = JSON.parse(encoded)
    } catch { /* retain a bounded attention title below */ }
    if (notification === undefined) {
      const title = Array.isArray(raw) && typeof raw[0]?.q === 'string' ? raw[0].q : 'Needs your answer'
      notification = [{ q: Array.from(title).slice(0, 192).join('') }]
    }
    this.notices.set(agentId, { agentId, id, questions: notification, revision: ++this.revision })
    const valid = agentId && id && Array.isArray(raw) && raw.length > 0 && raw.length <= 4 &&
      raw.every(q => q && typeof q.key === 'string' && q.key && typeof q.q === 'string' && q.q &&
        Array.isArray(q.options) && q.options.length > 0 && q.options.length <= 6 &&
        q.options.every((o: unknown) => typeof o === 'string' && o.length > 0)) &&
      new Set(raw.map(q => q.key)).size === raw.length
    if (!valid) { this.entries.delete(agentId); return }
    const questions: ReviewQuestion[] = raw.map(q => ({ key: q.key, q: q.q,
      options: [...q.options], multi: q.multi === true, ...(q.canText === true ? { canText: true } : {}) }))
    const signature = JSON.stringify([id, questions])
    if (Buffer.byteLength(signature, 'utf8') > 6500) { this.entries.delete(agentId); return }
    if (this.entries.get(agentId)?.signature === signature) return
    if (this.entries.size >= 64 && !this.entries.has(agentId)) this.entries.delete(this.entries.keys().next().value!)
    for (const question of questions) { Object.freeze(question.options); Object.freeze(question) }
    Object.freeze(questions)
    this.entries.set(agentId, { agentId, id, token: randomUUID(), signature, questions, drafts: new Map() })
  }

  close(agentId: string, id: string): boolean {
    const current = this.latestIds.get(agentId)
    if (current !== undefined && current !== id) return false
    this.latestIds.delete(agentId); this.entries.delete(agentId); this.notices.delete(agentId)
    return true
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
