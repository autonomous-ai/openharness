/** Whether an engine on a contributed machine can take new work: what its reading says (signed out; quota is shown, not
 *  refused) and the server's own count of its failed starts there. Work kept landing on engines that could not run, Codex with no tokens on
 *  Diego's Mac among them, until a person told the Product Manager (Ken, 2026-10-28). Unknown is never unusable: a
 *  machine from before these readings keeps today's behaviour. */
import type { ContributedMachine } from './machines.js'
import type { AgentStart, SuperTabState } from './model.js'
import { TIMED_OUT, TIMED_OUT_SUFFIX } from './startFailure.js'

/** Failed starts in a row that suspend an engine on a machine. */
export const SUSPEND_AFTER = 2
const LEGACY_SUSPENSION_MS = 6 * 3_600_000
const duration = (level: number) => Math.min(30 * 60_000 * 2 ** (level - 1), 12 * 3_600_000)
const durationText = (ms: number) => ms < 3_600_000 ? `${ms / 60_000} minutes` : `${ms / 3_600_000} ${ms === 3_600_000 ? 'hour' : 'hours'}`
type EngineSuspension = NonNullable<ContributedMachine['engineSuspensions']>[string]
const NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' }
const named = (engine: string) => NAME[engine] ?? engine
/** Match the host's engine summaries, never arbitrary preparation errors. On 11-05, clone/token/tool/request failures
 *  took six machines' Claude subscriptions out of routing. An unfamiliar failure still fails the start, but cannot prove
 *  its engine is broken. Keep these aligned with CLI startScreen.ts, start.ts and native launch summaries. */
function engineFailure(error: string): 'sign-in' | 'engine' | null {
  const reason = error.replace(/^This machine held the agent's launch for \d+ minutes and stopped it: /, '')
  if (/^(?:Codex|Claude(?: Code)?|(?:Its|The) engine) (?:sign-in failed\.|could not sign in\.|is not signed in\b)/i.test(reason)
    || reason === 'Its engine stopped on a sign-in screen that nobody here can answer.') return 'sign-in'
  if (/^(?:Codex|Claude(?: Code)?|(?:Its|The) engine) (?:could not launch\.|failed to launch\.|exited\b|is installed but cannot run: )/i.test(reason)
    || /^Its engine stopped on .+ that nobody here can answer\.$/.test(reason)
    || reason === 'The agent was created and has since stopped. Create a new start request to continue.') return 'engine'
  return null
}

function pool(state: SuperTabState, machineId: string) { return state.machines?.find(m => m.machineId === machineId) }
/** Only a routed worker's start: a Product Manager's start has its own retries (leadStart.ts), and a Buddy is its owner's own. */
const worker = (start: AgentStart) => !!start.error && !start.request.leadFor && !start.request.buddyOf

/** Signed in, with every usage window below its limit (or metered, with none), in the machine's latest reading. */
function readsFine(machine: ContributedMachine, engine: string): boolean {
  const reading = machine.observation
  const quota = reading?.quotas?.find(q => q.engine === engine)
  return reading?.readiness?.engines?.find(e => e.engine === engine)?.signedIn === true
    && quota?.known === true && quota.windows.every(w => w.usedPercent < 100)
}
function active(machine: ContributedMachine, engine: string, now: number) {
  const suspension = machine.engineSuspensions?.[engine]
  return suspension && now - suspension.at < (suspension.durationMs ?? LEGACY_SUSPENSION_MS) ? suspension : null
}
function suspensionReason(engine: string, suspension: EngineSuspension): string {
  const after = durationText(suspension.durationMs ?? LEGACY_SUSPENSION_MS)
  const reading = suspension.cause === 'sign-in' ? 'once a reading shows it signed in, '
    : !suspension.cause && !suspension.fine ? 'once a reading shows it signed in with quota left, ' : ''
  return `${named(engine)} is suspended on this machine for new work: its last ${SUSPEND_AFTER} starts there failed. `
    + `It is offered again ${reading}after ${after}, or once its owner resumes it.`
}

/** A pickup timeout says nothing about any one engine. Keep its cooldown apart, and expose it to old clients through
 *  suspendedEngines too; admission still enforces it for clients that do not yet know machineSuspended. */
export function machineSuspensionReason(machine: ContributedMachine, now: number): string | null {
  const s = machine.machineSuspension
  return s && now - s.at < s.durationMs
    ? `This machine is suspended for new work: its last ${SUSPEND_AFTER} starts timed out. It is offered again after ${durationText(s.durationMs)}.` : null
}

/** Count the first failure receipt only (the caller owns deduplication). Return a notice once per cooldown. */
export function noteStartFailed(state: SuperTabState, start: AgentStart, now: number): string | null {
  const machine = pool(state, start.request.machineId), engine = start.request.engine
  if (!machine || !worker(start)) return null
  if (start.error === TIMED_OUT || start.error!.endsWith(TIMED_OUT_SUFFIX)) {
    if (machineSuspensionReason(machine, now)) return null
    machine.machineFailures = (machine.machineFailures ?? 0) + 1
    if (machine.machineFailures < SUSPEND_AFTER) return null
    delete machine.machineFailures
    machine.machineBackoff = Math.min((machine.machineBackoff ?? 0) + 1, 6)
    machine.machineSuspension = { at: now, durationMs: duration(machine.machineBackoff) }
    return machineSuspensionReason(machine, now)
  }
  if (start.request.gridModel || !engineFailure(start.error!) || active(machine, engine, now)) return null
  const failures = (machine.engineFailures?.[engine] ?? 0) + 1
  const previous = machine.engineBackoff?.[engine]
  const cause = engineFailure(start.error!) === 'engine' || (failures > 1 && previous?.cause !== 'sign-in') ? 'engine' : 'sign-in'
  if (failures < SUSPEND_AFTER) {
    machine.engineFailures = { ...machine.engineFailures, [engine]: failures }
    machine.engineBackoff = { ...machine.engineBackoff, [engine]: { level: previous?.level ?? 0, cause } }
    return null
  }
  const { [engine]: _done, ...others } = machine.engineFailures ?? {}
  machine.engineFailures = others
  const level = Math.min((previous?.level ?? 0) + 1, 6)
  machine.engineBackoff = { ...machine.engineBackoff, [engine]: { level, cause } }
  const suspension = { at: now, fine: cause === 'engine', durationMs: duration(level), cause } as const
  machine.engineSuspensions = { ...machine.engineSuspensions, [engine]: suspension }
  return suspensionReason(engine, suspension)
}

/** A start that ran: its engine's failures there are no longer in a row. */
export function noteStartSucceeded(state: SuperTabState, start: AgentStart): void {
  const machine = pool(state, start.request.machineId)
  if (!machine) return
  delete machine.machineFailures
  delete machine.machineBackoff
  delete machine.machineSuspension
  if (!start.request.gridModel) resumeEngine(machine, start.request.engine)
}

/** Readings clear sign-in failures only; a quota reading cannot prove a launch works. Legacy causes remain unknown.
 *  Expiry drops active cooldowns, keeping the bounded repeat level until a start succeeds. */
export function readingClearsSuspensions(machine: ContributedMachine, now: number): void {
  if (machine.machineSuspension && !machineSuspensionReason(machine, now)) delete machine.machineSuspension
  if (!machine.engineSuspensions) return
  const kept = Object.entries(machine.engineSuspensions).filter(([engine, s]) => {
    if (!active(machine, engine, now)) return false
    if (s.cause === 'sign-in') return machine.observation?.readiness?.engines?.find(e => e.engine === engine)?.signedIn !== true
    return !!s.cause || s.fine || !readsFine(machine, engine)
  })
  machine.engineSuspensions = Object.fromEntries(kept)
}

/** The machine owner's resume: true when there was a suspension to end. */
export function resumeEngine(machine: ContributedMachine, engine: string): boolean {
  const had = !!machine.engineSuspensions?.[engine]
  if (machine.engineSuspensions) { const { [engine]: _ended, ...others } = machine.engineSuspensions; machine.engineSuspensions = others }
  if (machine.engineFailures) { const { [engine]: _reset, ...others } = machine.engineFailures; machine.engineFailures = others }
  if (machine.engineBackoff) { const { [engine]: _reset, ...others } = machine.engineBackoff; machine.engineBackoff = others }
  return had
}

/** Each engine suspended on the machine now, with why: what the route leaves out and Desktop strikes through. */
export function suspendedEngines(machine: ContributedMachine, now: number): Record<string, string> {
  const machineReason = machineSuspensionReason(machine, now)
  if (machineReason) return Object.fromEntries(machine.engines.map(engine => [engine, machineReason]))
  return Object.fromEntries(Object.entries(machine.engineSuspensions ?? {}).filter(([engine]) => active(machine, engine, now))
    .map(([engine, s]) => [engine, suspensionReason(engine, s)]))
}

/** Why a new start of [engine] on the machine is refused, or null: signed out in its reading, or suspended. Quota is
 *  information, not a gate (project instructions, phase 4): a used-up window refuses nothing. What the reading does not say
 *  stays usable. */
export function engineUnusable(machine: ContributedMachine, engine: string, now: number): string | null {
  const machineReason = machineSuspensionReason(machine, now)
  if (machineReason) return machineReason
  const reading = machine.observation
  if (reading?.readiness?.engines?.find(e => e.engine === engine)?.signedIn === false) return `${named(engine)} is not signed in to a subscription on this machine.`
  const suspension = active(machine, engine, now)
  return suspension ? suspensionReason(engine, suspension) : null
}
