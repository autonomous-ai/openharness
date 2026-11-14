import { minuteCounts } from './observedHook.js'

/**
 * A hook's approval and inbox calls, checked and bounded here and then handed to the devices process, which owns the
 * dial's card and the voice inbox. The core keeps only the open requests themselves, so a forged or flooding hook costs
 * it a small parse and a bounded map, never state that outlives the call.
 */
export type ApprovalDecision = 'allow' | 'deny' | 'none'

export interface ApprovalRequest {
  id: string
  sessionId: string
  tool: string
  summary: string
  cwd?: string
  /** The dial cannot show the command whole (deviceClaude/approve.ts): the devices hold no card for it. */
  terminalOnly?: boolean
}

export interface InboxPoll {
  pollId: string
  sessionId: string
}

/** `off`: the devices could not hold the poll. */
export type InboxAnswer = { text?: string; off?: true }

export interface DeviceHookPort {
  approval(request: ApprovalRequest): Promise<ApprovalDecision>
  approvalGone(id: string): void
  inboxPoll(poll: InboxPoll): Promise<InboxAnswer>
  inboxGone(pollId: string): void
}

const MAX_SESSION_ID = 128
const MAX_TOOL = 64
/** The card's one line under the tool's name; bytes, as the dial holds the prompt in a byte buffer. */
const MAX_SUMMARY_BYTES = 200
const MAX_PATH = 1024
const MAX_TEXT = 2000
/** Parallel tool calls of one session, and all sessions together; more are `none` at once and the terminal's prompt decides. */
const APPROVALS_PER_SESSION = 4
const MAX_APPROVALS = 16
/** One poll per session, so this bounds the sessions whose mod is held at once. */
const MAX_POLLS = 64

/** Same rule as observedHook's bounded: a bounded string with no control character (an id or path with one is forged). */
const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)

const filled = (value: unknown, max: number): value is string => bounded(value, max) && value !== ''

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function parseApproval(body: unknown): Omit<ApprovalRequest, 'id'> | null {
  if (!isRecord(body)) return null
  const { sessionId, tool, summary, cwd, terminalOnly } = body
  if (!filled(sessionId, MAX_SESSION_ID) || !filled(tool, MAX_TOOL)) return null
  if (!bounded(summary, MAX_SUMMARY_BYTES) || Buffer.byteLength(summary) > MAX_SUMMARY_BYTES) return null
  if (cwd !== undefined && !bounded(cwd, MAX_PATH)) return null
  if (terminalOnly !== undefined && typeof terminalOnly !== 'boolean') return null
  return {
    sessionId, tool, summary,
    ...(cwd === undefined ? {} : { cwd }),
    ...(terminalOnly === undefined ? {} : { terminalOnly }),
  }
}

export function parseInboxPoll(body: unknown): { sessionId: string } | null {
  if (!isRecord(body)) return null
  const { sessionId } = body
  return filled(sessionId, MAX_SESSION_ID) ? { sessionId } : null
}

/**
 * One forwarded call, open until the devices answer or it ends first (its client went, or a newer poll took its
 * place). Ending first tells the devices, so they close what they hold, and drops their late answer: a service call
 * cannot be cancelled from the core.
 */
function openCall<T>(answer: Promise<T>, gone: AbortSignal, ended: T, tell: () => void, closed: () => void) {
  let open = true
  let resolve!: (value: T) => void
  const result = new Promise<T>((r) => { resolve = r })
  const close = (value: T, early: boolean): void => {
    if (!open) return
    open = false
    gone.removeEventListener('abort', end)
    closed()
    if (early) tell()
    resolve(value)
  }
  const end = (): void => close(ended, true)
  gone.addEventListener('abort', end)
  void answer.then((value) => close(value, false))
  return { result, end }
}

export interface DeviceHookCallsDeps {
  /** A dial is watching: a call to a devices process that is not running would start it. */
  ready(): boolean
  devices(): DeviceHookPort | undefined
  newId(): string
  log?: (line: string) => void
}

export function createDeviceHookCalls(deps: DeviceHookCallsDeps) {
  /** Open approvals, id → session. */
  const approvals = new Map<string, string>()
  /** Open polls, session → ends it early. */
  const polls = new Map<string, () => void>()

  const port = (): DeviceHookPort | undefined => (deps.ready() ? deps.devices() : undefined)
  // No dial is not counted: it is every call while none is plugged in, and says nothing about a hook.
  const tally = minuteCounts(['refused', 'over'] as const,
    (lost) => `[devices] dial hook calls in the last minute: ${lost.refused} refused, ${lost.over} over the bound`, deps.log ?? console.warn)

  return {
    async onApproval(body: unknown, gone: AbortSignal): Promise<'invalid' | ApprovalDecision> {
      const request = parseApproval(body)
      if (!request) { tally('refused'); return 'invalid' }
      const devices = port()
      // A client gone before its call is forwarded would never abort again, and its card would wait for nobody.
      if (!devices || gone.aborted) return 'none'
      let mine = 0
      for (const sessionId of approvals.values()) if (sessionId === request.sessionId) mine += 1
      if (mine >= APPROVALS_PER_SESSION || approvals.size >= MAX_APPROVALS) { tally('over'); return 'none' }
      const id = deps.newId()
      approvals.set(id, request.sessionId)
      let asked: Promise<ApprovalDecision>
      // Called at once, not deferred to make a throw a rejection: the request must reach the devices before any
      // approval.gone for it. A throw would otherwise hold its place for good.
      try { asked = devices.approval({ id, ...request }) } catch { approvals.delete(id); return 'none' }
      const answer = asked.catch((): ApprovalDecision => 'none')
      return openCall(answer, gone, 'none', () => devices.approvalGone(id), () => approvals.delete(id)).result
    },

    async onInbox(body: unknown, gone: AbortSignal): Promise<'invalid' | 'off' | { text?: string }> {
      const poll = parseInboxPoll(body)
      if (!poll) { tally('refused'); return 'invalid' }
      const devices = port()
      if (!devices || gone.aborted) return 'off'
      const { sessionId } = poll
      // The mod keeps one poll open, so an older one for the session is a client that went quiet: it gives up its place.
      polls.get(sessionId)?.()
      if (polls.size >= MAX_POLLS) { tally('over'); return 'off' }
      const pollId = deps.newId()
      const answer = devices.inboxPoll({ pollId, sessionId }).then(
        ({ text, off }): 'off' | { text?: string } =>
          off ? 'off' : typeof text === 'string' && text !== '' && text.length <= MAX_TEXT ? { text } : {},
        (): 'off' => 'off',
      )
      const call = openCall(answer, gone, 'off', () => devices.inboxGone(pollId), () => polls.delete(sessionId))
      polls.set(sessionId, call.end)
      return call.result
    },

    open(): { approvals: number; polls: number } {
      return { approvals: approvals.size, polls: polls.size }
    },
  }
}
