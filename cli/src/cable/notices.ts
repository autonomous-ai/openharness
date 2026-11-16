// The notice desk: an agent's one line to the dial, as a card the dial pins until the agent's next turn. The devices
// process holds it; the core knows nothing of notices.

import { NoticeLimits, type NoticeAsk, type NoticeResult } from '../lib/dialNotice.js'
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
  /** A question to every dial, in its agent's order. */
  ask(agentId: string, id: string, questions: unknown): void
  close(agentId: string, id: string): void
  uuid(): string
  now(): number                    // monotonic ms
  log(line: string): void
}

export const NOTICES_PENDING_MAX = 20

interface Pending { id: string; questions: unknown; who?: NoticeCaller['who'] }

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
    const questions = [{ key: 'notice', q: roundDrawable(ask.text), options: [`In ${hostDisplayName(caller.host)}`] }]
    this.pending.set(caller.agentId, { id, questions, who: caller.who })
    this.deps.ask(caller.agentId, id, questions)
    return answer('shown')
  }

  /** Its agent's next turn started, the person opened it, or its agent left: its card goes. Nothing for an agent with none. */
  ended(agentId: string): void {
    const card = this.pending.get(agentId)
    if (!card) return
    this.pending.delete(agentId)
    this.deps.close(agentId, card.id)
  }

  /** A dial attached: each pending card is asked again, under its id. */
  attached(): void {
    for (const [agentId, card] of this.pending) this.deps.ask(agentId, card.id, card.questions)
  }

  /** Who a pending notice's caller is, when no list holds it. */
  from(agentId: string): { name: string; engine: string; machine: string } | undefined {
    return this.pending.get(agentId)?.who
  }
}
