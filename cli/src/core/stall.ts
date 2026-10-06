/**
 * A test-only fault: the core's event loop held still for seconds at a time, the way a synchronous read
 * of a huge file, a heap paged out under memory pressure or a debugger pause holds it. Nothing runs while
 * it is held: no timer, no socket, no child's exit. When it lets go, Node runs every timer that came due
 * before it reads the answers that arrived meanwhile, so a probe whose deadline passed during the hold
 * times out with its answer sitting unread. That is "could not tell", and it must never be taken for
 * "gone" (e2e/stall.e2e.ts).
 *
 * `HARNESSD_TEST_FAULTS` names it `core.stall:<ms>[-<maxMs>][@<periodMs>][/spawn]`. Each hold lasts
 * `ms`, or a random length from `ms` to `maxMs`. Holds come at random intervals averaging `periodMs` when
 * one is given, and whenever the core receives SIGUSR2, so a test can hold the loop at the moment it
 * chooses. With `/spawn`, each hold waits for the next child process the core starts and begins as soon
 * as that child is running: a `ps` or `tmux` probe is then always in flight, which a hold that lands
 * anywhere hits only by luck. Under a master, keep every hold well inside its heartbeat limit (40 s by
 * default), or the master rightly takes the core for hung.
 *
 * Every hold runs in the check phase (setImmediate), the one just before the timers. A hold there, like
 * one in an I/O callback, wakes to every deadline that passed during it before the loop reads the
 * answers that arrived. A hold in a timer's own callback would not: Node reads I/O before it runs the
 * timers that came due meanwhile, and the probes in flight would answer as if nothing had happened.
 */
import { subscribe, unsubscribe } from 'node:diagnostics_channel'

export interface StallDeps {
  /** Block the event loop for `ms`. */
  hold: (ms: number) => void
  random: () => number
  /** Call `listener` on every SIGUSR2; returns the unsubscribe. */
  onSignal: (listener: () => void) => () => void
  /** Call `listener` whenever this process starts a child process; returns the unsubscribe. */
  onSpawn: (listener: () => void) => () => void
  log: (line: string) => void
}

export interface Stalls {
  /** Hold the loop now, for a length picked from the range; returns it. */
  stall: () => number
  stop: () => void
}

export const processStallDeps: StallDeps = {
  // Atomics.wait sleeps the thread without spinning, and Node allows it on the main thread.
  hold: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) },
  random: Math.random,
  onSignal: (listener) => {
    process.on('SIGUSR2', listener)
    return () => { process.off('SIGUSR2', listener) }
  },
  onSpawn: (listener) => {
    const each = (): void => { listener() }
    subscribe('child_process', each)
    return () => { unsubscribe('child_process', each) }
  },
  log: (line) => console.log(line),
}

const FORM = /^core\.stall:(\d+)(?:-(\d+))?(?:@(\d+))?(\/spawn)?$/

/** Arm the fault when `faults` names it (`testFaults` in ./serviceHost.ts); null when it does not. */
export function startStalls(faults: ReadonlySet<string>, deps: StallDeps = processStallDeps): Stalls | null {
  const entry = [...faults].find((name) => name.startsWith('core.stall'))
  if (!entry) return null
  const match = FORM.exec(entry)
  const minMs = Number(match?.[1])
  const maxMs = match?.[2] === undefined ? minMs : Number(match[2])
  const periodMs = match?.[3] === undefined ? null : Number(match[3])
  // Said out loud: a test that misspells its fault must not pass because nothing was ever held.
  if (!match || maxMs < minMs || periodMs === 0) {
    deps.log(`[stall] ignored ${entry}: the form is core.stall:<ms>[-<maxMs>][@<periodMs>][/spawn]`)
    return null
  }
  const atSpawn = match[4] !== undefined
  const stall = (): number => {
    const ms = Math.round(minMs + deps.random() * (maxMs - minMs))
    deps.log(`[stall] holding the event loop for ${ms} ms`)
    deps.hold(ms)
    return ms
  }
  const holdSoon = (): void => { setImmediate(() => { stall() }) }
  // A hold waiting for the next child; several asked for meanwhile are one.
  let pending = false
  const hold = (): void => {
    if (atSpawn) pending = true
    else holdSoon()
  }
  const stopSpawns = atSpawn
    ? deps.onSpawn(() => {
      if (!pending) return
      pending = false
      // Later in this turn of the loop, once the code that started the child has armed its timeout: the
      // child runs, answers and exits while the loop is held, and its deadline passes unread.
      holdSoon()
    })
    : () => {}
  let timer: NodeJS.Timeout | null = null
  // Random intervals rather than a fixed beat: a beat would land on the same moment of every periodic
  // task, every time, and miss the races between them.
  const schedule = (period: number): void => {
    timer = setTimeout(() => { hold(); schedule(period) }, Math.round(period * (0.5 + deps.random())))
    timer.unref()
  }
  if (periodMs !== null) schedule(periodMs)
  const stopSignals = deps.onSignal(hold)
  const range = minMs === maxMs ? `${minMs}` : `${minMs}-${maxMs}`
  deps.log(`[stall] armed: holds of ${range} ms${periodMs === null ? '' : ` about every ${periodMs} ms`}, and on SIGUSR2`
    + `${atSpawn ? ', each as the core starts a child process' : ''}`)
  return {
    stall,
    stop: () => {
      if (timer) clearTimeout(timer)
      timer = null
      stopSignals()
      stopSpawns()
    },
  }
}
