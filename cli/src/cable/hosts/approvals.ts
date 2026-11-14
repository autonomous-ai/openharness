import type { ApprovalDecision, ApprovalRequest } from '../../core/deviceHookCalls.js'
import { truncateUtf8 } from '../../lib/deviceRecentTrim.js'
import { APPROVAL_REQUEST_PREFIX, type AnswerReceipt, type ReviewQuestion } from '../questionInbox.js'
import { roundDrawable } from '../roundGlyphs.js'

/** The core waits 305 s and the hook longer, so a card that runs out is counted as an expiry, not as the terminal's answer. */
const EXPIRES_MS = 300_000
/** As many as the core lets through; more are `none` at once and the terminal's prompt decides. */
const MAX_HELD = 16
/** The firmware's `prompt[256]`, less its terminating zero. */
const MAX_Q_BYTES = 255

/** The dial's card. What it cannot draw becomes `?` before the cut, so the command's line always keeps its place. */
export function approvalQuestion(tool: string, summary: string): ReviewQuestion {
  return {
    key: 'approval',
    q: truncateUtf8(roundDrawable(`Allow ${tool}?\n${summary}`), MAX_Q_BYTES),
    options: ['Allow', 'Deny'],
    multi: false,
  }
}

export type ApprovalOutcome = 'shown' | 'allowed' | 'denied' | 'expired' | 'terminal' | 'closed' | 'terminal-only'

export interface ApprovalsDeps {
  now(): number
  /** Runs `run` after `ms`; the result cancels it. */
  after(ms: number, run: () => void): () => void
  /** A dial is attached and shows this computer's agents, not a window's tab. */
  canShow(): boolean
  /** A Harness agent holds this session: its pane answers the prompt. */
  owned(sessionId: string): Promise<boolean>
  /** The observed agent for the session; `open` and `terminal` create it, `undefined` when there is no room. */
  mark(sessionId: string, cwd: string | undefined, state: 'open' | 'terminal' | 'answered' | 'left'): { id: string } | undefined
  show(agentId: string, requestId: string, questions: ReviewQuestion[]): void
  close(agentId: string, requestId: string): void
  /** `ms` since the request arrived. */
  count(outcome: ApprovalOutcome, ms: number): void
}

type Held = {
  request: ApprovalRequest
  agentId: string
  arrived: number
  shown: boolean
  expire: () => void
  resolve: (decision: ApprovalDecision) => void
}

/**
 * The open approvals, one card per agent on the dial (it holds one question per agent); the rest of an agent's wait in
 * order. Each ends once: the dial's answer, the terminal's (`gone`), its expiry or `closeAll`, whichever comes first.
 */
export class Approvals {
  /** By request id, in the order they arrived. */
  private readonly held = new Map<string, Held>()
  /** Requests still checking their session: `gone` or `closeAll` takes one out, and it then shows no card. */
  private readonly checking = new Set<string>()

  constructor(private readonly deps: ApprovalsDeps) {}

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const arrived = this.deps.now()
    if (!this.deps.canShow()) return 'none'
    this.checking.add(request.id)
    // A check that fails cannot rule out the pane's own answer: the terminal's prompt decides.
    const owned = await this.deps.owned(request.sessionId).catch(() => true)
    // The terminal may have answered, the dial gone or everything closed while the session was checked.
    if (!this.checking.delete(request.id) || owned || !this.deps.canShow()) return 'none'
    // A command the dial cannot show whole: Allow there would approve what it never showed. The agent waits on its
    // terminal, and nothing is held.
    if (request.terminalOnly) {
      if (this.deps.mark(request.sessionId, request.cwd, 'terminal')) this.deps.count('terminal-only', this.deps.now() - arrived)
      return 'none'
    }
    // A request id seen twice is one prompt: the second would orphan the first's answer.
    if (this.held.size >= MAX_HELD || this.held.has(request.id)) return 'none'
    const agent = this.deps.mark(request.sessionId, request.cwd, 'open')
    if (!agent) return 'none'
    return new Promise<ApprovalDecision>((resolve) => {
      const held: Held = {
        request, agentId: agent.id, arrived, shown: false, resolve,
        // The core's wait began on arrival, not after the session's check: the card must still close first.
        expire: this.deps.after(EXPIRES_MS - (this.deps.now() - arrived), () => this.end(held, 'none', 'expired')),
      }
      this.held.set(request.id, held)
      if (!this.shownFor(agent.id)) this.show(held)
    })
  }

  /** The terminal answered first: Claude Code killed the hook. */
  gone(id: string): void {
    this.checking.delete(id)
    const held = this.held.get(id)
    if (held) this.end(held, 'none', 'terminal')
  }

  answer(agentId: string, requestId: string, choice: string | undefined): AnswerReceipt {
    const held = this.shownFor(agentId)
    // Only the agent's card on the dial: a late answer for one that closed must never land on the next.
    if (!held || requestId !== APPROVAL_REQUEST_PREFIX + held.request.id) return { ok: false, error: 'This request is closed.' }
    if (choice !== 'Allow' && choice !== 'Deny') return { ok: false, error: 'Tap Allow or Deny.' }
    if (choice === 'Allow') this.end(held, 'allow', 'allowed')
    else this.end(held, 'deny', 'denied')
    return { ok: true }
  }

  /** The dial went, a window opened, or the core that holds the calls changed. */
  closeAll(): void {
    this.checking.clear()
    for (const held of [...this.held.values()]) this.end(held, 'none', 'closed')
  }

  private shownFor(agentId: string): Held | undefined {
    for (const held of this.held.values()) if (held.agentId === agentId && held.shown) return held
    return undefined
  }

  private show(held: Held): void {
    held.shown = true
    const { id, tool, summary } = held.request
    this.deps.show(held.agentId, APPROVAL_REQUEST_PREFIX + id, [approvalQuestion(tool, summary)])
    this.deps.count('shown', this.deps.now() - held.arrived)
  }

  private end(held: Held, decision: ApprovalDecision, outcome: ApprovalOutcome): void {
    if (this.held.get(held.request.id) !== held) return
    this.held.delete(held.request.id)
    held.expire()
    if (held.shown) this.deps.close(held.agentId, APPROVAL_REQUEST_PREFIX + held.request.id)
    this.deps.count(outcome, this.deps.now() - held.arrived)
    held.resolve(decision)
    const next = [...this.held.values()].find((other) => other.agentId === held.agentId)
    if (!next) {
      // An answer moves the agent on; otherwise its terminal's prompt still waits.
      const answered = outcome === 'allowed' || outcome === 'denied' || outcome === 'terminal'
      this.deps.mark(held.request.sessionId, held.request.cwd, answered ? 'answered' : 'left')
    } else if (held.shown && outcome !== 'closed') {
      this.show(next)
    }
  }
}
