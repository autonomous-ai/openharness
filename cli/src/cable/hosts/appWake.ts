/**
 * Words for a resting Claude app session (docs/plans/2026-11-21-dial-claude-app-wake-send-design.md, § 3): they open
 * that session by its link, then go to that very Claude Code session's mod once its process is listed and its mod
 * polls, within 30 s, one wake at a time for the whole devices process.
 *
 * The link runs without the opener's fallback (open.ts): a fallback brings the app forward on whatever session it
 * shows, and would turn a failed link into a 30 s wait. Nothing but the session id binds: the observed copy whose id
 * and Claude Code session id are the row's, and a poll of that session id, never the dial's current row, the app's
 * front session or its last attach. The mod's inbox is keyed by that id, so the words can only reach the process that
 * runs that session. `Inbox.ready()` is not read: it stays true for 35 s after the last run's last poll, so only a poll
 * heard after the words arrived counts.
 *
 * Pushed, never polled: it listens to the observed source and the inbox only while it runs, with one timer. A log line
 * says fixed words and a count only.
 */
import type { ObservedSource } from './observed.js'
import { MAX_TEXT } from './orca.js'
import type { HostAgent, SendResult } from './types.js'

/** The bound from the words' arrival to ready (Decision 1): fits the dial's 65 s reply wait with transcription. */
export const WAKE_MS = 30_000

/** The store row's values as the words arrived. */
export interface WakeTarget {
  localId: string
  sessionId: string
  agentId: string
  name: string
}

export interface AppWakeDeps {
  /** The tap's link without its fallback; false when it definitely failed. */
  open(localId: string, agentId: string): Promise<boolean>
  observed: Pick<ObservedSource, 'list' | 'onChange' | 'send'>
  /** Called synchronously as the inbox holds a session's poll, with its Claude Code session id; its stop. */
  onPoll(listener: (sessionId: string) => void): () => void
  /** A timer; its cancel is returned. */
  after(ms: number, run: () => void): () => void
  monotonic(): number
  log(line: string): void
  count(what: string): void
}

type Word = 'too long' | 'open failed' | 'timeout' | 'ended' | 'busy' | 'stopped' | 'refused' | 'sent'

export class AppWake {
  /** The wake under way, opening, waiting or delivering: whose words, whether it still waits for a session, its stop. */
  private running: { name: string; waitsFor(sessionId: string): boolean; stop(): void } | undefined

  constructor(private readonly deps: AppWakeDeps) {}

  send(target: WakeTarget, text: string): Promise<SendResult> {
    if (text.length > MAX_TEXT) return Promise.resolve(this.refuse('too long', 'Too long. Say it shorter.'))
    // Refused, never queued (Decision 3).
    if (this.running) return Promise.resolve(this.refuse('busy', `Still opening ${this.running.name}. Try again in a moment.`))
    const { deps } = this
    return new Promise((resolve) => {
      const opened = deps.monotonic()
      let phase: 'waiting' | 'delivering' | 'over' = 'waiting'
      let linked = false
      let live = false
      let polled = false
      const stops: Array<() => void> = []
      const release = (): void => {
        for (const stop of stops.splice(0)) stop()
      }
      const end = (word: Word, result: SendResult, line: string = word): void => {
        if (phase === 'over') return
        phase = 'over'
        release()
        this.running = undefined
        this.say(word, line)
        resolve(result)
      }
      const fail = (word: Word, reason: string) => end(word, { ok: false, reason })
      const deliver = (copy: HostAgent): void => {
        phase = 'delivering'
        release()
        // No await before it: called from the poll's listener, that very poll takes the words.
        deps.observed.send(copy, text).then(
          (result) =>
            result.ok ? end('sent', result, `sent · ${Math.round(deps.monotonic() - opened)} ms`) : end('refused', result),
          () => fail('refused', `${target.name} did not answer.`),
        )
      }
      const check = (): void => {
        // The observed source calls the listeners it had when its change began, a released one too.
        if (phase !== 'waiting') return
        const copy = deps.observed.list().find((a) => a.id === target.agentId && a.sessionId === target.sessionId)
        if (copy && !copy.ended) live = true
        // A copy already ended as the words came is the last run's, kept until the observed source drops it.
        else if (live) return fail('ended', `${target.name} closed before it took your words.`)
        if (copy && !copy.ended && linked && polled) deliver(copy)
      }
      this.running = {
        name: target.name,
        waitsFor: (sessionId) => phase === 'waiting' && sessionId === target.sessionId,
        stop: () => {
          if (phase === 'waiting') fail('stopped', `${target.name} did not answer.`)
        },
      }
      // Heard before the link runs: the app can start the session and its mod can poll before `open` answers.
      stops.push(
        deps.observed.onChange(check),
        deps.onPoll((sessionId) => {
          if (sessionId !== target.sessionId) return
          polled = true
          check()
        }),
        deps.after(WAKE_MS, () => fail('timeout', `${target.name} did not open in Claude. Try again.`)),
      )
      check()
      // A late answer, after the wake ended, does nothing: `end` and `check` take none.
      deps.open(target.localId, target.agentId).catch(() => false).then((ok) => {
        if (!ok) return fail('open failed', `${target.name} did not open in Claude.`)
        linked = true
        check()
      })
    })
  }

  /**
   * Whether a wake still opens or waits for that Claude Code session, its words not handed on. Its copy can be listed
   * meanwhile, and the dial's next words then take the copy's own path: a mod the inbox counts ready (a poll held while
   * the link runs, or the last run's, 35 s) would hand them the first poll, ahead of these. They are refused instead
   * (Decision 3). Its own words ask this as they go, once it no longer waits.
   */
  waitsFor(sessionId: string): boolean {
    return this.running?.waitsFor(sessionId) ?? false
  }

  /** The dial detached: a wake opening or waiting answers stopped; one delivering keeps its send's answer. */
  stop(): void {
    this.running?.stop()
  }

  private refuse(word: Word, reason: string): SendResult {
    this.say(word)
    return { ok: false, reason }
  }

  private say(word: Word, line: string = word): void {
    this.deps.log(`[claude-app] wake · ${line}`)
    this.deps.count(`wake-${word.replace(' ', '-')}`)
  }
}
