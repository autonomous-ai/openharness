/**
 * When Hachi is woken, and with what (docs/design/2026-11-12-hachi.md, "How it learns about other harnesses"). Each wake
 * is a turn of the person's own CLI, so it costs their tokens: only three changes of a harness Hachi started wake it
 * (it needs the person, it is done, it stopped), changes are coalesced for 20 s into one line, and it is woken at most
 * once a minute and 30 times an hour. What comes within the minute waits for it; what passes the hour is dropped, and
 * counted. A harness Hachi closed itself wakes nothing: it closed it after reading it, which is counted as such.
 *
 * Told only names and states (`heard`), and what it hands on is the same (lib/hachiWake.ts builds the line from them).
 */
import type { HachiDaemonMetric } from '../lib/hachiMetrics.js'
import type { WakeItem, WakeState } from '../lib/hachiWake.js'

export const WAKE_COALESCE_MS = 20_000
export const WAKE_GAP_MS = 60_000
export const WAKES_PER_HOUR = 30
const HOUR_MS = 60 * 60_000

/** What a harness is doing, as this machine's push (core/toolWatches.ts) or another's (gateway/harnessWatch.ts) says. */
export type HeardState = 'working' | 'idle' | 'needs_person' | 'stopped' | 'gone' | 'unknown'

/** A harness Hachi started: a key that tells it apart, its name and its machine's. */
export interface WakeChild { key: string; name: string; machine: string }

export interface HachiWakesDeps {
  now(): number
  /** Runs [run] in [ms]; returns how to cancel it. */
  later(ms: number, run: () => void): () => void
  /** Hands the line's items to Hachi's mailbox (messages/service.ts `wake`): true once it took them. */
  send(items: WakeItem[]): Promise<boolean>
  /** Whether Hachi closed [child] itself (`harness close`, the ledger's `Closed` line). */
  closedByHachi(child: WakeChild): boolean
  count(metric: HachiDaemonMetric): void
  log(line: string): void
}

const ENDED: ReadonlySet<HeardState> = new Set(['stopped', 'gone'])

export function createHachiWakes(deps: HachiWakesDeps) {
  /** What each harness was last heard doing, and since when one waits on the person. */
  const last = new Map<string, HeardState>()
  const askedAt = new Map<string, number>()
  /** The changes waiting for the next line, the last of each harness. */
  const pending = new Map<string, { child: WakeChild; state: WakeState }>()
  const sentAt: number[] = []
  let cancel: (() => void) | null = null

  const schedule = (ms: number): void => {
    if (cancel) return
    cancel = deps.later(ms, () => { cancel = null; void flush() })
  }

  const answered = (key: string): void => {
    const since = askedAt.get(key)
    askedAt.delete(key)
    if (since === undefined) return
    const waited = deps.now() - since
    deps.count(waited < 60_000 ? 'hachi_needs_person_answer_under_1m' : waited < 15 * 60_000 ? 'hachi_needs_person_answer_1m_to_15m' : 'hachi_needs_person_answer_over_15m')
  }

  const flush = async (): Promise<void> => {
    const items: WakeItem[] = []
    for (const [key, { child, state }] of pending) {
      if (state !== 'stopped' || !deps.closedByHachi(child)) { items.push({ name: child.name, machine: child.machine, state }); continue }
      pending.delete(key)
      deps.count('hachi_closed_started')
    }
    if (!items.length) return
    const now = deps.now()
    while (sentAt.length && now - sentAt[0] >= HOUR_MS) sentAt.shift()
    if (sentAt.length >= WAKES_PER_HOUR) {
      pending.clear()
      for (let i = 0; i < items.length; i++) deps.count('hachi_wake_dropped_limit')
      return
    }
    const since = now - (sentAt.at(-1) ?? -Infinity)
    if (since < WAKE_GAP_MS) { schedule(WAKE_GAP_MS - since); return }
    pending.clear()
    sentAt.push(now)
    let taken = false
    try { taken = await deps.send(items) } catch (error) {
      deps.log(`[hachi] the wake was not delivered: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!taken) { deps.count('hachi_mailbox_failed'); return }
    for (const item of items) deps.count(`hachi_wake_${item.state}`)
  }

  return {
    /** [child] was heard [state]: a change that wakes Hachi is kept for the next line. The first state heard of a
     *  harness is no change. */
    heard(child: WakeChild, state: HeardState): void {
      const before = last.get(child.key)
      last.set(child.key, state)
      if (before === undefined || before === state || state === 'unknown') return
      if (before === 'needs_person' && !ENDED.has(state)) answered(child.key)
      let wake: WakeState | null = null
      if (state === 'needs_person') { askedAt.set(child.key, deps.now()); wake = 'needs_person' }
      else if (state === 'idle' && (before === 'working' || before === 'needs_person')) wake = 'done'
      else if (ENDED.has(state) && !ENDED.has(before)) { askedAt.delete(child.key); wake = 'stopped' }
      if (!wake) return
      pending.set(child.key, { child, state: wake })
      schedule(WAKE_COALESCE_MS)
    },
    /** Hachi is off: nothing waiting is sent, each counted as dropped, and every harness is forgotten. */
    drop(): void {
      for (let i = 0; i < pending.size; i++) deps.count('hachi_wake_dropped_off')
      this.stop()
    },
    /** The service stops: nothing waiting is sent, and every harness is forgotten. */
    stop(): void {
      pending.clear()
      last.clear()
      askedAt.clear()
      cancel?.()
      cancel = null
    },
  }
}
