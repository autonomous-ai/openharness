/**
 * Words for a resting session of the Claude app or a resting thread of the ChatGPT app: they open it by its link, then
 * go to that very session, one wake at a time for the whole devices process and both apps.
 *
 * Claude app (docs/plans/2026-11-21-dial-claude-app-wake-send-design.md, § 3): the words go to that very Claude Code
 * session's mod once its process is listed and its mod polls, within 30 s.
 *
 * The link runs without the opener's fallback (open.ts): a fallback brings the app forward on whatever session it
 * shows, and would turn a failed link into a 30 s wait. Nothing but the session id binds: the observed copy whose id
 * and Claude Code session id are the row's, and a poll of that session id, never the dial's current row, the app's
 * front session or its last attach. The mod's inbox is keyed by that id, so the words can only reach the process that
 * runs that session. `Inbox.ready()` is not read: it stays true for 35 s after the last run's last poll, so only a poll
 * heard after the words arrived counts.
 *
 * ChatGPT app (docs/plans/2026-11-23-dial-chatgpt-voice-resting-design.md, § 3): once the thread's link opened, the
 * words go at once to Codex's durable queue of that very thread (`codex queue`), and wait for nothing. Codex runs no
 * hook as the app loads a thread, only at its next turn, so a wait for a listed copy would never end in 30 s; and the
 * app's own server takes a queued message it did not write once it has loaded the thread. The link alone, never the app
 * brought forward on whatever thread it shows, where words queued for a thread it never loads would wait unseen.
 * Nothing but the target's thread id chooses the thread.
 *
 * Pushed, never polled: it listens to the observed source and the inbox only while a Claude wake runs, with one timer.
 * A log line says fixed words and a count only.
 */
import type { CodexQueue } from './codexQueue.js'
import type { ObservedSource } from './observed.js'
import { MAX_TEXT } from './orca.js'
import type { HostAgent, PaneSwitch, SendResult } from './types.js'

/** The bound from the words' arrival to ready (Decision 1): fits the dial's 65 s reply wait with transcription. */
export const WAKE_MS = 30_000

/** The app a wake opens: the Claude app, or the ChatGPT app's Codex threads. */
export type WakeApp = 'claude' | 'codex'

/** The row's values as the words arrived. */
export type WakeTarget =
  | { app: 'claude'; localId: string; sessionId: string; agentId: string; name: string }
  | { app: 'codex'; threadId: string; agentId: string; name: string }

export interface AppWakeDeps {
  /** A Claude app session's tap link without its fallback; false when it definitely failed. */
  open(localId: string, agentId: string): Promise<boolean>
  observed: Pick<ObservedSource, 'list' | 'onChange' | 'send'>
  /** Called synchronously as the inbox holds a session's poll, with its Claude Code session id; its stop. */
  onPoll(listener: (sessionId: string) => void): () => void
  /** A timer; its cancel is returned. */
  after(ms: number, run: () => void): () => void
  /** A ChatGPT thread's link alone, never the app brought forward. */
  openThread(threadId: string, agentId: string): Promise<PaneSwitch>
  /** Codex's queue, where a ChatGPT thread's words go once its link opened. */
  queue: Pick<CodexQueue, 'send'>
  monotonic(): number
  log(line: string): void
  count(what: string): void
}

type Word =
  | 'too long' | 'open failed' | 'timeout' | 'ended' | 'busy' | 'stopped' | 'refused' | 'sent'
  | 'pending' | 'queue timeout' | 'queue failed'

export class AppWake {
  /** The wake under way, opening, waiting, delivering or queueing: its app, whose words, whether it still waits for a
   *  session, its stop. */
  private running: { app: WakeApp; name: string; waitsFor(sessionId: string): boolean; stop(): void } | undefined

  constructor(private readonly deps: AppWakeDeps) {}

  send(target: WakeTarget, text: string): Promise<SendResult> {
    if (text.length > MAX_TEXT) return Promise.resolve(this.refuse(target.app, 'too long', 'Too long. Say it shorter.'))
    // Refused, never queued (Decision 3), whichever app the wake under way opens.
    if (this.running) {
      return Promise.resolve(this.refuse(target.app, 'busy', `Still opening ${this.running.name}. Try again in a moment.`))
    }
    return target.app === 'claude' ? this.wakeClaude(target, text) : this.wakeCodex(target, text)
  }

  private wakeClaude(target: Extract<WakeTarget, { app: 'claude' }>, text: string): Promise<SendResult> {
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
        this.say('claude', word, line)
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
        app: 'claude',
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

  private wakeCodex(target: Extract<WakeTarget, { app: 'codex' }>, text: string): Promise<SendResult> {
    const { deps } = this
    return new Promise((resolve) => {
      const opened = deps.monotonic()
      let phase: 'linking' | 'queueing' | 'over' = 'linking'
      const end = (word: Word, result: SendResult, line: string = word): void => {
        phase = 'over'
        cancel()
        this.running = undefined
        this.say('codex', word, line)
        resolve(result)
      }
      const fail = (word: Word, reason: string) => end(word, { ok: false, reason })
      // Over the link only: once queueing, `codex queue`'s own timeout bounds it, and its answer stands (it may be
      // queued already).
      const cancel = deps.after(WAKE_MS, () => fail('timeout', `${target.name} did not open in ChatGPT. Try again.`))
      this.running = {
        app: 'codex',
        name: target.name,
        // Once queueing, `codex queue` itself refuses the thread's next words until these are queued.
        waitsFor: (sessionId) => phase === 'linking' && sessionId === target.threadId,
        stop: () => {
          if (phase === 'linking') fail('stopped', `${target.name} did not answer.`)
        },
      }
      // A late answer, after a stop or the bound, queues nothing.
      deps.openThread(target.threadId, target.agentId).catch((): PaneSwitch => 'failed').then((link) => {
        if (phase !== 'linking') return
        if (link === 'failed') return fail('open failed', `${target.name} did not open in ChatGPT.`)
        if (link === 'busy') return fail('busy', `Still opening ${target.name}. Try again in a moment.`)
        phase = 'queueing'
        cancel()
        deps.queue.send(target.threadId, text, true).then((result) => {
          switch (result.outcome) {
            case 'queued': return end('sent', { ok: true }, `sent · ${Math.round(deps.monotonic() - opened)} ms`)
            case 'busy': return fail('pending', `${target.name} has not taken your last words yet.`)
            // It may be queued: never retried.
            case 'timeout': return fail('queue timeout', `${target.name} did not answer.`)
            case 'failed':
              return result.reason === 'refused'
                ? fail('refused', `${target.name} did not answer.`)
                : fail('queue failed', 'Update ChatGPT, then try again.')
          }
        }, () => fail('refused', `${target.name} did not answer.`))
      })
    })
  }

  /**
   * Whether a wake still opens or waits for that session, its words not handed on: a Claude Code session id, or a
   * ChatGPT thread's id, which is its Codex session id. Its copy can be listed meanwhile, and the dial's next words then
   * take the copy's own path: a mod the inbox counts ready (a poll held while the link runs, or the last run's, 35 s)
   * would hand them the first poll, and the copy's own `codex queue` would queue them, ahead of these. They are refused
   * instead (Decision 3). A Claude wake's own words ask this as they go, once it no longer waits.
   */
  waitsFor(sessionId: string): boolean {
    return this.running?.waitsFor(sessionId) ?? false
  }

  /**
   * The dial detached from that app: its wake opening or waiting answers stopped; one delivering or queueing keeps its
   * send's answer. The other app's wake goes on: the ChatGPT app's source stops at every attach where that app is not
   * found.
   */
  stop(app: WakeApp): void {
    if (this.running?.app === app) this.running.stop()
  }

  private refuse(app: WakeApp, word: Word, reason: string): SendResult {
    this.say(app, word)
    return { ok: false, reason }
  }

  private say(app: WakeApp, word: Word, line: string = word): void {
    this.deps.log(`[${app}-app] wake · ${line}`)
    // The Claude app's counts keep the words they had before the ChatGPT app's.
    this.deps.count(`${app === 'claude' ? '' : 'codex-'}wake-${word.replace(' ', '-')}`)
  }
}
