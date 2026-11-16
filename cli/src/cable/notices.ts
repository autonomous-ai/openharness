// The notice desk: an agent's one line to the dial, as a card the dial pins until the agent's next turn. The devices
// process holds it; the core knows nothing of notices.

import { NoticeLimits, type NoticeAsk, type NoticeResult } from '../lib/dialNotice.js'
import type { UnreadNotification } from '../lib/notificationRead.js'
import { SHOWN_ONLY_PREFIX } from './cableSession.js'
import { hostDisplayName } from './hosts/hostDetect.js'
import { roundDrawable } from './roundGlyphs.js'

export interface NoticeCaller {
  agentId: string
  /** The host its app is named by; '' when nothing says. */
  host: string
  /** Only for a caller no list holds: what its card carries. */
  who?: { name: string; engine: string; machine: string }
}

export interface NoticesDeps {
  connected(): boolean
  resolve(ask: NoticeAsk): NoticeCaller
  /** Whether another question of that agent is open on the dials. A dial, and its cable session, hold one question an
   *  agent: a notice asked over it would hide it and drop its close, so the notice waits until it closes. */
  held(agentId: string): boolean
  /** A question to every dial, in its agent's order. */
  ask(agentId: string, id: string, questions: unknown): void
  close(agentId: string, id: string): void
  uuid(): string
  now(): number                    // monotonic ms
  log(line: string): void
}

export const NOTICES_PENDING_MAX = 20

interface Pending { id: string; line: string; questions: unknown; host: string; who?: NoticeCaller['who'] }

export class Notices {
  // One card an agent, oldest first: a Map keeps insertion order, and a replaced card is put back at the end.
  private readonly pending = new Map<string, Pending>()
  private readonly limits: NoticeLimits

  constructor(private readonly deps: NoticesDeps) {
    this.limits = new NoticeLimits(deps.now)
  }

  notify(ask: NoticeAsk): NoticeResult {
    // The log names only the engine and the outcome: the text, session and folder are the person's own.
    const answer = (result: NoticeResult): NoticeResult => {
      this.deps.log(`[device] notify · ${ask.engine ?? 'agent'} · ${result}`)
      return result
    }
    // With no dial a notice is nobody's: it must not use up the agent's minute for when one attaches.
    if (!this.deps.connected()) return answer('no dial')
    const caller = this.deps.resolve(ask)
    if (!this.limits.take(caller.agentId, ask.text)) return answer('limited')
    this.ended(caller.agentId)
    if (this.pending.size >= NOTICES_PENDING_MAX) this.ended(this.pending.keys().next().value!)
    const id = SHOWN_ONLY_PREFIX + this.deps.uuid()
    const line = roundDrawable(ask.text)
    const questions = [{ key: 'notice', q: line, options: [`In ${hostDisplayName(caller.host)}`] }]
    this.pending.set(caller.agentId, { id, line, questions, host: caller.host, who: caller.who })
    this.reask(caller.agentId)
    return answer('shown')
  }

  /** Its agent's next turn started, the person opened it, or its agent left: its card goes. Nothing for an agent with none. */
  ended(agentId: string): void {
    const card = this.pending.get(agentId)
    if (!card) return
    this.pending.delete(agentId)
    this.deps.close(agentId, card.id)
  }

  /** Another question of that agent closed, which took the card's place on the dial or held it back: the card is asked,
   *  under its id, unless one is still open. Nothing for an agent with none. */
  reask(agentId: string): void {
    const card = this.pending.get(agentId)
    if (card && !this.deps.held(agentId)) this.deps.ask(agentId, card.id, card.questions)
  }

  /** A dial attached: each pending card is asked again, under its id. */
  attached(): void {
    for (const agentId of this.pending.keys()) this.reask(agentId)
  }

  /** The last dial went. A Harness agent's next turn is told to the devices only while a dial listens
   *  (services/recaps.ts), so its card cannot wait for it through the unplug: it goes now. Another agent's next turn is
   *  heard without a dial, so its card stays to be asked again. */
  detached(): void {
    for (const [agentId, card] of this.pending) if (card.host === 'harness') this.ended(agentId)
  }

  /** Each pending card the dial shows as a row of its drawer, newest first: a drawer replaced whole must keep them. */
  rows(machineId: string): UnreadNotification[] {
    return [...this.pending].reverse().filter(([agentId]) => !this.deps.held(agentId))
      .map(([agentId, card]) => ({ agentId, machineId, question: true, text: card.line }))
  }

  /** Who a pending notice's caller is, when no list holds it. */
  from(agentId: string): { name: string; engine: string; machine: string } | undefined {
    return this.pending.get(agentId)?.who
  }
}
