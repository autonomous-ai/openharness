import { bounded, isRecord, minuteCounts } from './observedHook.js'

/**
 * The mod's inbox call, checked and bounded here and then handed to the devices process, which owns the voice inbox; with
 * no dial watching, held here until one does, so the mod's next poll reaches the devices at once. The
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
/**
 * With no dial watching, the core holds the poll itself, as long as the devices would (cable/hosts/inbox.ts HOLD_MS):
 * answered at once, the mod would ask again only a minute later, and a dial plugged in meanwhile would find no poll.
 */
const HOLD_MS = 25_000
/** The mod takes {} sooner than 1 s for no hold and asks again a minute later (harness-device's HELD_MS): a dial that
 *  starts watching ends a younger hold only once it is this old, with room for the mod's own clock. */
const MIN_HOLD_MS = 1_500

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
  /** The polls held here while no dial watches, session → ends it soon. */
  const held = new Map<string, () => void>()

  const port = (): DeviceHookPort | undefined => (deps.ready() ? deps.devices() : undefined)
  const tally = minuteCounts(['refused', 'over'] as const, {
    now: (kind) => `[devices] a dial hook call was ${kind === 'refused' ? 'refused' : 'over the bound'}; more are counted once a minute`,
    minute: (lost) => `[devices] dial hook calls in the last minute: ${lost.refused} refused, ${lost.over} over the bound`,
  }, deps.log ?? console.warn)

  /** A poll the devices hold, its text checked here. */
  function forward(devices: DeviceHookPort, sessionId: string, gone: AbortSignal, closed: () => void) {
    const pollId = deps.newId()
    const answer = devices.inboxPoll({ pollId, sessionId }).then(
      ({ text, off }): 'off' | { text?: string } =>
        off ? 'off' : typeof text === 'string' && text !== '' && text.length <= MAX_TEXT ? { text } : {},
      (): 'off' => 'off',
    )
    return openCall(answer, gone, 'off', () => devices.inboxGone(pollId), closed)
  }

  /** A poll held here: {} after HOLD_MS, or soon once a dial starts watching. One timer, cleared if it ends first. */
  function hold(sessionId: string, gone: AbortSignal, closed: () => void) {
    const since = performance.now()
    let answer!: (value: { text?: string }) => void
    const answered = new Promise<'off' | { text?: string }>((resolve) => { answer = resolve })
    let timer = setTimeout(() => answer({}), HOLD_MS)
    held.set(sessionId, () => {
      clearTimeout(timer)
      timer = setTimeout(() => answer({}), Math.max(0, since + MIN_HOLD_MS - performance.now()))
    })
    return openCall(answered, gone, 'off', () => clearTimeout(timer), closed)
  }

  return {
    async onInbox(body: unknown, gone: AbortSignal): Promise<'invalid' | 'off' | { text?: string }> {
      const poll = parseInboxPoll(body)
      if (!poll) { tally('refused'); return 'invalid' }
      // A client gone before its poll is held would never abort again, and its poll would wait for nobody.
      if (gone.aborted) return 'off'
      const { sessionId } = poll
      // The mod keeps one poll open, so an older one for the session is a client that went quiet: it gives up its place.
      polls.get(sessionId)?.()
      if (polls.size >= MAX_POLLS) { tally('over'); return 'off' }
      const closed = (): void => { polls.delete(sessionId); held.delete(sessionId) }
      const devices = port()
      const call = devices ? forward(devices, sessionId, gone, closed) : hold(sessionId, gone, closed)
      polls.set(sessionId, call.end)
      return call.result
    },

    /** A dial started watching: each poll held here ends with {}, so its mod asks again at once and reaches the devices. */
    watching(): void {
      for (const end of held.values()) end()
    },

    open(): { polls: number } {
      return { polls: polls.size }
    },
  }
}
