import { bounded, isRecord, minuteCounts } from './observedHook.js'

/**
 * The mod's inbox call, checked and bounded here and then handed to the devices process, which owns the voice inbox. The
 * core keeps only the open polls themselves, so a forged or flooding hook costs it a small parse and a bounded map, never
 * state that outlives the call. Nothing here answers a prompt: the dial only shows one.
 */
export interface InboxPoll {
  pollId: string
  sessionId: string
}

/** `off`: the devices could not hold the poll. */
export type InboxAnswer = { text?: string; off?: true }

export interface DeviceHookPort {
  inboxPoll(poll: InboxPoll): Promise<InboxAnswer>
  inboxGone(pollId: string): void
}

const MAX_SESSION_ID = 128
/**
 * The same number as cable/hosts/orca.ts's MAX_TEXT, the longest dial text every host path takes. The core imports
 * nothing from cable/, so it keeps its own; over it the poll is answered {} while the devices' inbox counts the words
 * taken, so the two must not differ.
 */
const MAX_TEXT = 20_000
/** One poll per session, so this bounds the sessions whose mod is held at once. */
const MAX_POLLS = 64

const filled = (value: unknown, max: number): value is string => bounded(value, max) && value !== ''

export function parseInboxPoll(body: unknown): { sessionId: string } | null {
  if (!isRecord(body)) return null
  const { sessionId } = body
  return filled(sessionId, MAX_SESSION_ID) ? { sessionId } : null
}

/**
 * One forwarded poll, open until the devices answer or it ends first (its client went, or a newer poll took its
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
  /** Open polls, session → ends it early. */
  const polls = new Map<string, () => void>()

  const port = (): DeviceHookPort | undefined => (deps.ready() ? deps.devices() : undefined)
  // No dial is not counted: it is every call while none is plugged in, and says nothing about a hook.
  const tally = minuteCounts(['refused', 'over'] as const,
    (lost) => `[devices] dial hook calls in the last minute: ${lost.refused} refused, ${lost.over} over the bound`, deps.log ?? console.warn)

  return {
    async onInbox(body: unknown, gone: AbortSignal): Promise<'invalid' | 'off' | { text?: string }> {
      const poll = parseInboxPoll(body)
      if (!poll) { tally('refused'); return 'invalid' }
      const devices = port()
      // A client gone before its poll is forwarded would never abort again, and its poll would wait for nobody.
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

    open(): { polls: number } {
      return { polls: polls.size }
    },
  }
}
