/** Whether an engine on a contributed machine can take new work: what its reading says (signed out, out of quota) and the
 *  server's own count of its failed starts there. Work kept landing on engines that could not run, Codex with no tokens on
 *  Diego's Mac among them, until a person told the Product Manager (Ken, 2026-10-28). Unknown is never unusable: a
 *  machine from before these readings keeps today's behaviour. */
import type { ContributedMachine } from './machines.js'
import type { AgentStart, SuperTabState } from './model.js'
import { ABANDONED, MACHINE_REMOVED } from './startFailure.js'

/** Failed starts in a row that suspend an engine on a machine. */
export const SUSPEND_AFTER = 2
/** How long a suspension stands at most. */
export const SUSPENSION_MS = 6 * 3_600_000
const NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' }
const named = (engine: string) => NAME[engine] ?? engine
/** Failures that say nothing of the engine: the machine was removed, the start was dropped, or it lacked memory. */
const NOT_THE_ENGINE = [MACHINE_REMOVED, ABANDONED, 'Removed by its owner before it started.']
const MEMORY_SHORT = /^Not enough free memory: /

function pool(state: SuperTabState, machineId: string) { return state.machines?.find(m => m.machineId === machineId) }
/** Only a routed worker's start: a Product Manager's start has its own retries (leadStart.ts), and a Buddy is its owner's own. */
const counts = (start: AgentStart) => !!start.error && !start.request.gridModel && !start.request.leadFor && !start.request.buddyOf && !NOT_THE_ENGINE.includes(start.error) && !MEMORY_SHORT.test(start.error)

/** Signed in, with every usage window below its limit (or metered, with none), in the machine's latest reading. */
function readsFine(machine: ContributedMachine, engine: string): boolean {
  const reading = machine.observation
  const quota = reading?.quotas.find(q => q.engine === engine)
  return reading?.readiness?.engines?.find(e => e.engine === engine)?.signedIn === true
    && quota?.known === true && quota.windows.every(w => w.usedPercent < 100)
}
function active(machine: ContributedMachine, engine: string, now: number) {
  const suspension = machine.engineSuspensions?.[engine]
  return suspension && now - suspension.at < SUSPENSION_MS ? suspension : null
}
function suspensionReason(engine: string, fine: boolean): string {
  return `${named(engine)} is suspended on this machine for new work: its last ${SUSPEND_AFTER} starts there failed. `
    + (fine ? 'It is offered again within 6 hours, or once its owner resumes it.'
      : 'It is offered again once a reading shows it signed in with quota left, within 6 hours, or once its owner resumes it.')
}

/** Counts a failed start against its engine on its machine. Returns the suspension's sentence when this failure suspends
 *  the engine, and null otherwise, so its notice is posted once per suspension, never on a later failure. */
export function noteStartFailed(state: SuperTabState, start: AgentStart, now: number): string | null {
  const machine = pool(state, start.request.machineId), engine = start.request.engine
  if (!machine || !counts(start) || active(machine, engine, now)) return null
  const failures = (machine.engineFailures?.[engine] ?? 0) + 1
  if (failures < SUSPEND_AFTER) { machine.engineFailures = { ...machine.engineFailures, [engine]: failures }; return null }
  const { [engine]: _done, ...others } = machine.engineFailures ?? {}
  machine.engineFailures = others
  const fine = readsFine(machine, engine)
  machine.engineSuspensions = { ...machine.engineSuspensions, [engine]: { at: now, fine } }
  return suspensionReason(engine, fine)
}

/** A start that ran: its engine's failures there are no longer in a row. */
export function noteStartSucceeded(state: SuperTabState, start: AgentStart): void {
  const machine = pool(state, start.request.machineId)
  if (!machine?.engineFailures?.[start.request.engine]) return
  const { [start.request.engine]: _reset, ...others } = machine.engineFailures
  machine.engineFailures = others
}

/** After a reading is stored: a suspension ends once the engine reads fine, unless it already read fine as it was suspended
 *  (its starts failed for another reason, and every report would end it at once). Ended and expired ones are dropped. */
export function readingClearsSuspensions(machine: ContributedMachine, now: number): void {
  if (!machine.engineSuspensions) return
  const kept = Object.entries(machine.engineSuspensions).filter(([engine, s]) => now - s.at < SUSPENSION_MS && (s.fine || !readsFine(machine, engine)))
  machine.engineSuspensions = Object.fromEntries(kept)
}

/** The machine owner's resume: true when there was a suspension to end. */
export function resumeEngine(machine: ContributedMachine, engine: string): boolean {
  const had = !!machine.engineSuspensions?.[engine]
  if (machine.engineSuspensions) { const { [engine]: _ended, ...others } = machine.engineSuspensions; machine.engineSuspensions = others }
  if (machine.engineFailures) { const { [engine]: _reset, ...others } = machine.engineFailures; machine.engineFailures = others }
  return had
}

/** Each engine suspended on the machine now, with why: what the route leaves out and Desktop strikes through. */
export function suspendedEngines(machine: ContributedMachine, now: number): Record<string, string> {
  return Object.fromEntries(Object.entries(machine.engineSuspensions ?? {}).filter(([engine]) => active(machine, engine, now))
    .map(([engine, s]) => [engine, suspensionReason(engine, s.fine)]))
}

/** Why a new start of [engine] on the machine is refused, or null: signed out or out of quota in its reading, or suspended.
 *  What the reading does not say stays usable. */
export function engineUnusable(machine: ContributedMachine, engine: string, now: number): string | null {
  const reading = machine.observation
  if (reading?.readiness?.engines?.find(e => e.engine === engine)?.signedIn === false) return `${named(engine)} is not signed in to a subscription on this machine.`
  const quota = reading?.quotas.find(q => q.engine === engine)
  if (quota?.known && quota.windows.some(w => w.usedPercent >= 100)) return `${named(engine)} has no subscription quota left on this machine until its usage window resets.`
  const suspension = active(machine, engine, now)
  return suspension ? suspensionReason(engine, suspension.fine) : null
}
