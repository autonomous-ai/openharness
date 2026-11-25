/**
 * The dial's words typed into an agent's own terminal, in two steps: the words, then, after a settle, the Enter that
 * submits them. One helper for every adapter that types (VS Code's terminals, the terminal tabs), so each cleans the
 * words, waits the settle and holds a terminal to one send alike.
 *
 * Each step goes only once the adapter's checks pass just before it: a check that held before the words may not hold
 * after the settle, and words left unsubmitted in the agent's input are safer than an Enter typed somewhere else. The
 * first refusal stops the send, and a step that throws submits nothing.
 */
import { INJECT_PASTE_DELAY_BASE_MS, INJECT_PASTE_DELAY_MAX_MS } from '../../lib/submitTiming.js'
import { CONTROL, MAX_TEXT } from './orca.js'

/** A lone surrogate: UTF-8 has no form for it, so it is typed as the replacement character. */
export const LONE_SURROGATE = /\p{Cs}/gu

/** The words to type, or none when nothing is left or they are too long. A newline would submit part of them and an
 *  escape would steer the screen: only the Enter step submits. */
export function cleanWords(text: string): string | undefined {
  const words = text.replace(CONTROL, ' ').replace(LONE_SURROGATE, '�')
  return words && words.length <= MAX_TEXT ? words : undefined
}

/** How long the Enter waits after the words. Codex's paste-burst detector turns an Enter within 120 ms of a burst of
 *  keys into a newline (codex-rs paste_burst.rs), and Claude Code needs time to take a long input before an Enter
 *  submits it. */
export function settleMs(words: string): number {
  return Math.min(INJECT_PASTE_DELAY_MAX_MS, INJECT_PASTE_DELAY_BASE_MS + Math.floor(words.length / 60))
}

/** A step's answer. `held`: the step is not over when it answers (a late reply may still come), so its terminal takes
 *  no other send until that settles. */
export type StepAnswer<R> = { ok: true; held?: Promise<void> } | { ok: false; why: R; held?: Promise<void> }

export interface TwoSteps<R> {
  /** Why the next step may not go now, or none when it may. */
  check(before: 'words' | 'enter'): Promise<R | undefined>
  words(): Promise<StepAnswer<R>>
  enter(): Promise<StepAnswer<R>>
}

export interface TwoStep<K> {
  /** Whether a send is under way on that key. */
  sending(key: K): boolean
  /** Runs the steps for those words: true once the Enter went, else the first refusal, `busy` (`failed` unless given)
   *  when a send is under way on that key, or `failed` when a step throws. Never rejects. */
  send<R>(key: K, words: string, steps: TwoSteps<R>, failed: R, busy?: R): Promise<true | R>
}

export function createTwoStep<K>(after: (ms: number, run: () => void) => unknown): TwoStep<K> {
  // Two dials' words at once on one terminal would mix in one prompt.
  const locked = new Set<K>()
  return {
    sending: (key) => locked.has(key),
    send: async (key, words, steps, failed, busy = failed) => {
      if (locked.has(key)) return busy
      locked.add(key)
      const held: Promise<void>[] = []
      const run = async <R>(step: () => Promise<StepAnswer<R>>): Promise<StepAnswer<R>> => {
        const answer = await step()
        if (answer.held) held.push(answer.held)
        return answer
      }
      try {
        const beforeWords = await steps.check('words')
        if (beforeWords !== undefined) return beforeWords
        const typed = await run(() => steps.words())
        if (!typed.ok) return typed.why
        await new Promise<void>((settled) => { after(settleMs(words), settled) })
        const beforeEnter = await steps.check('enter')
        if (beforeEnter !== undefined) return beforeEnter
        const pressed = await run(() => steps.enter())
        return pressed.ok ? true : pressed.why
      } catch {
        return failed
      } finally {
        if (held.length === 0) locked.delete(key)
        else void Promise.allSettled(held).then(() => locked.delete(key))
      }
    },
  }
}
