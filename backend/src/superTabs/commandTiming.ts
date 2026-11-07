/**
 * A command's time by phase (task #4560): in prod some commands waited ~3.5 s with ~23 ms of DB time and ~140 ms of CPU, so
 * the time is a wait somewhere in the command path. Each phase adds its time here, on the command's own clock, and a slow
 * command's log line names them (store.ts execute). Phases carry names and milliseconds only, never content.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export type CommandPhases = Record<string, number>
interface Timing { clock: () => number; phases: CommandPhases }
const current = new AsyncLocalStorage<Timing>()

/** Runs one command with its phases recorded on [clock], and hands [report] its phases and total time, failed or not. */
export async function timeCommand<T>(clock: () => number, work: () => Promise<T>, report: (phases: CommandPhases, totalMs: number) => void): Promise<T> {
  const timing: Timing = { clock, phases: {} }, started = clock()
  try {
    return await current.run(timing, work)
  } finally {
    report(timing.phases, clock() - started)
  }
}

/** Adds [amount] (milliseconds, or a count such as attempts) to [phase] of the running command; outside one, nothing. */
export function addPhase(phase: string, amount: number): void {
  const timing = current.getStore()
  if (timing) timing.phases[phase] = (timing.phases[phase] ?? 0) + amount
}

/** The running command's phases so far, or undefined outside one. */
export const commandPhases = (): CommandPhases | undefined => current.getStore()?.phases

/** Times [work] as one [phase], failed or not. What it does inside (its own transaction) counts only as this phase. */
export async function timedPhase<T>(phase: string, work: () => Promise<T>): Promise<T> {
  const timing = current.getStore()
  if (!timing) return work()
  const started = timing.clock()
  try {
    return await current.run({ clock: timing.clock, phases: {} }, work)
  } finally {
    addPhase(phase, timing.clock() - started)
  }
}

/** The clock phases are timed on now, or undefined outside a command. */
export const phaseClock = (): (() => number) | undefined => current.getStore()?.clock
