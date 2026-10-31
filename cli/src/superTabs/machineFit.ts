/** Scholes's goals, piece 5: place work by what its machine has. A task can say it runs a heavy build or end-to-end tests on
 * its machine (`needs.heavy`), or starts heavy CI workflows itself (`needs.ci`: OS images, end-to-end, macOS jobs). The
 * route's plug-in (route.ts RoutePlugin) then
 * - leaves out a machine with less than half of what the work needs free, which cannot run it;
 * - ranks one with less than the need after every equally strong candidate that has it, never above a weaker model;
 * - says when a reading is unknown, and ranks a busy CPU later among equals;
 * - counts heavy work started there in the last minutes, which its reading may not show yet (pieces 3 to 6 all started on
 *   one Mac within ten minutes, and every route saw the same free memory, 2026-10-31);
 * - holds work that would start CI past the account's running-jobs limit, with a time to route it again.
 * Everything it needs is read before the route ([placedHeavyWork], the CI reading); the plug-in itself is pure. */
import type { Adjustment, HeavyWork, Needs, Probe, RoutePlugin } from './route.js'
import type { PluginMaker } from './routePlugins.js'
import { object } from './wire.js'

type Json = Record<string, unknown>
const GB = 1e9
/** What a machine needs free for each kind of heavy work: a Desktop, Flutter or OS image build, or the end-to-end suites. */
export const HEAVY_NEEDS: Record<HeavyWork, { memoryBytes: number; diskBytes: number; words: string }> = {
  build: { memoryBytes: 8 * GB, diskBytes: 30 * GB, words: 'a heavy build' },
  e2e: { memoryBytes: 6 * GB, diskBytes: 10 * GB, words: 'end-to-end tests' },
}
/** Below this share of the need the machine cannot run the work: it is left out. */
export const FLOOR_SHARE = 0.5
/** How far a short or unread machine ranks down, in catalog strength: less than one step, so a stronger model is never
 *  passed over for a machine, while an equally strong one that fits always ranks first. */
export const SHORT_STRENGTH = -0.5, UNKNOWN_STRENGTH = -0.25
/** A CPU this busy ranks a machine later among equals; one reading is only a moment, so it never leaves one out. */
export const BUSY_CPU_PERCENT = 85, BUSY_CPU_COST = 1
/** A heavy start this recent may not show in its machine's reading yet. */
export const PLACED_RECENT_MS = 15 * 60_000
/** The account's running-jobs limit on GitHub Actions (docs/validation-and-release.md). */
export const CI_LIMIT = { jobs: 20, macos: 5 }
/** How long a held task waits before the route is asked again: a CI job takes minutes, not hours. */
export const CI_RETRY_MINUTES = 10

export interface Need { memoryBytes: number; diskBytes: number; words: string }
/** What the task's heavy work needs free, the largest of its kinds; null when it declares none. */
export function heavyNeed(needs: Pick<Needs, 'heavy'>): Need | null {
  const kinds = (needs.heavy ?? []).filter(k => Object.hasOwn(HEAVY_NEEDS, k))
  if (!kinds.length) return null
  return { memoryBytes: Math.max(...kinds.map(k => HEAVY_NEEDS[k].memoryBytes)), diskBytes: Math.max(...kinds.map(k => HEAVY_NEEDS[k].diskBytes)),
    words: kinds.map(k => HEAVY_NEEDS[k].words).join(' and ') }
}
/** The least a machine must have free to run [need] at all: below it the route leaves the machine out. */
export const floorOf = (need: Pick<Need, 'memoryBytes' | 'diskBytes'>) => ({ memoryBytes: need.memoryBytes * FLOOR_SHARE, diskBytes: need.diskBytes * FLOOR_SHARE })

/** Heavy work already placed on each machine: what it is expected to use, and how many agents. */
export interface Placed { memoryBytes: number; diskBytes: number; agents: number }
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
/** The heavy work a start declared in its own field (backend superTabs/model.ts AgentStartRequest.heavy), or none. Never read
 *  from the memory it asked: an ordinary Builder's start may ask as much as a heavy one (review of #2426). */
function heavyOfStart(start: Json): Need | null {
  const heavy = object(start.request).heavy
  return Array.isArray(heavy) ? heavyNeed({ heavy: heavy.filter((k): k is HeavyWork => typeof k === 'string' && Object.hasOwn(HEAVY_NEEDS, k)) }) : null
}
/** A start stamped this far ahead of this machine's clock still counts: clocks differ a little (as the window pull allows). */
export const CLOCK_SKEW_MS = 60_000
/** Heavy work placed per machine and not yet in its reading: a heavy start that did not fail, made in the last
 *  [PLACED_RECENT_MS]. An agent running longer already shows in its machine's free memory, so it is never subtracted again:
 *  Builders waiting hours on review would otherwise push every heavy task off the machine (Lead, 10-31). [hostOf] names the
 *  machine whose memory a machine shares (a Harness Team account is its Mac). */
export function placedHeavyWork(starts: Json[], now: number, hostOf: (machineId: string) => string = id => id): Map<string, Placed> {
  const placed = new Map<string, Placed>()
  for (const start of starts) {
    const need = heavyOfStart(start), machineId = object(start.request).machineId
    const at = finite(start.requestedAt) ? start.requestedAt : finite(start.dispatchedAt) ? start.dispatchedAt : null
    if (!need || start.error || typeof machineId !== 'string' || at === null || now - at >= PLACED_RECENT_MS || at > now + CLOCK_SKEW_MS) continue
    const host = hostOf(machineId), sum = placed.get(host) ?? { memoryBytes: 0, diskBytes: 0, agents: 0 }
    placed.set(host, { memoryBytes: sum.memoryBytes + need.memoryBytes, diskBytes: sum.diskBytes + need.diskBytes, agents: sum.agents + 1 })
  }
  return placed
}

/** Jobs running and queued on GitHub Actions, in all and on macOS runners (the server's read of the project's repository). */
export interface CiLoad { running: number; queued: number; macosRunning: number; macosQueued: number }
/** Why work that starts [needs.ci] must wait for CI, or null when it fits under the limit, or declares no CI, or the load is
 *  unknown (the route then says the limit was not checked). Queued jobs count: they already wait for the limit. */
export function ciHold(needs: Pick<Needs, 'ci'>, load: CiLoad | null): string | null {
  if (!needs.ci || !load) return null
  const busy = load.running + load.queued, mac = load.macosRunning + load.macosQueued
  const over = busy + needs.ci.jobs > CI_LIMIT.jobs || mac + needs.ci.macos > CI_LIMIT.macos
  if (!over) return null
  const starts = `${needs.ci.jobs} more${needs.ci.macos ? ` (${needs.ci.macos} on macOS)` : ''}`
  return `CI is at the account's limit: ${busy} of ${CI_LIMIT.jobs} jobs running or queued, ${mac} of ${CI_LIMIT.macos} on macOS, and this task `
    + `starts ${starts}. Route it again in ${CI_RETRY_MINUTES} minutes.`
}
/** Said when a task starts CI and the load could not be read. */
export const CI_UNCHECKED = `The running CI jobs could not be read, so the account's limit of ${CI_LIMIT.jobs} jobs (${CI_LIMIT.macos} on macOS) was not checked.`

/** A need in whole gigabytes, as the needs are set. */
const gb = (n: number) => `${Math.round(n / GB)} GB`
/** The machine-fit plug-in. [placed]: [placedHeavyWork]; [hostOf]: as there; [ci]: the CI load, null when unread. */
export function machineFit(input: { placed?: ReadonlyMap<string, Placed>; hostOf?: (machineId: string) => string; ci?: CiLoad | null } = {}): RoutePlugin {
  const hostOf = input.hostOf ?? (id => id)
  return {
    name: 'Machine fit',
    adjust(candidate, context) {
      const needs = context.assessment.needs
      const hold = ciHold(needs, input.ci ?? null)
      if (hold) return { refuse: true, reason: hold }
      const fit = fitOf(candidate, needs, input.placed?.get(hostOf(candidate.machineId)))
      if (!needs.ci || input.ci) return fit
      return fit ? { ...fit, reason: `${fit.reason} ${CI_UNCHECKED}` } : { reason: CI_UNCHECKED }
    },
  }
}

/** How [candidate]'s machine fits the task's heavy work, with [held] already placed there; null when the task has none, or
 *  the machine has all it needs and an idle CPU. Its reason names only which resource is short and what the work needs, never
 *  the machine's measured memory, disk or CPU: every reader of the route log reads it, also of a machine the route shows
 *  nothing else of (paused, folded, or reached only for its member; review of #2426). */
function fitOf(candidate: Pick<Probe, 'load'>, needs: Needs, held: Placed | undefined): Adjustment | null {
  const need = heavyNeed(needs)
  if (!need) return null
  const floor = floorOf(need), load = candidate.load
  const left = (free: number | null | undefined, use: number) => finite(free) ? free - use : null
  const memory = left(load?.freeMemoryBytes, held?.memoryBytes ?? 0), disk = left(load?.freeDiskBytes, held?.diskBytes ?? 0)
  const which = (memoryShort: boolean, diskShort: boolean) => [memoryShort ? 'memory' : null, diskShort ? 'disk' : null].filter(Boolean).join(' and ')
  const counting = held?.agents ? `, counting heavy work started there in the last ${PLACED_RECENT_MS / 60_000} minutes` : ''
  const wants = `it needs ${gb(need.memoryBytes)} memory and ${gb(need.diskBytes)} disk free`
  const busy = finite(load?.cpuPercent) && load.cpuPercent >= BUSY_CPU_PERCENT
  const cpu = busy ? { cost: BUSY_CPU_COST } : {}, cpuWords = busy ? ' Its CPU is busy.' : ''
  const out = which(memory !== null && memory < floor.memoryBytes, disk !== null && disk < floor.diskBytes)
  if (out) return { refuse: true, reason: `Too little free ${out} for ${need.words}${counting}: ${wants}, and at least half to run at all.` }
  const short = which(memory !== null && memory < need.memoryBytes, disk !== null && disk < need.diskBytes)
  if (short) return { strength: SHORT_STRENGTH, ...cpu, reason: `Short of free ${short} for ${need.words}${counting}: ${wants}, so equally strong candidates that have it rank first.${cpuWords}` }
  const unknown = which(memory === null, disk === null)
  if (unknown) return { strength: UNKNOWN_STRENGTH, ...cpu, reason: `Free ${unknown} unknown here; ${need.words}: ${wants}.${cpuWords}` }
  return busy ? { cost: BUSY_CPU_COST, reason: `Its CPU is busy; it has what ${need.words} needs.` } : null
}

/** Piece 5's maker (routePlugins.ts): the heavy work placed on each machine, read off the route's own Super Tab read. Nothing
 *  to say for a task with no heavy work and no CI. The CI load is not read yet: a task that starts CI is told so. */
export const MACHINE_FIT_MAKER: PluginMaker = {
  name: 'Machine fit',
  async make({ read, assessment }) {
    if (!heavyNeed(assessment.needs) && !assessment.needs.ci) return null
    const state = object(object(read.tab).state)
    const machines = Array.isArray(state.machines) ? state.machines.map(object) : []
    const macOf = new Map(machines.filter(m => typeof m.hostMachineId === 'string').map(m => [String(m.machineId), String(m.hostMachineId)]))
    const hostOf = (id: string) => macOf.get(id) ?? id
    const starts = Array.isArray(state.starts) ? state.starts.map(object) : []
    return machineFit({ placed: placedHeavyWork(starts, Date.now(), hostOf), hostOf, ci: null })
  },
}
