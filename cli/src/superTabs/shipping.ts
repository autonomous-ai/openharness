/**
 * The daemon's half of the Swarm leaderboard (docs/plans/2026-11-09-swarm-v4-leaderboard.md): it asks the backend what this
 * computer's agents of each Swarm should be read for, reads GitHub with this person's own `gh` (shippingRead.ts), and reports counts
 * of what shipped, per agent and week, as the account signed in here. Nothing is sent but counts, and an agent that is not this
 * person's on this computer is never in it (the backend's word, checked again by it on the report).
 *
 * A look every 15 minutes, and only while signed in. A failure is named in the log, reported to the backend (the board shows it to this
 * person alone), and the numbers already there stay. A failure that a minute may mend (GitHub or the backend gave out for a moment) is
 * tried again then, once and only for what failed; every other failure waits for the quarter hour, as it would be the same sooner.
 */
import type { CoreApi } from '../core/api.js'
import { ghRun, type Run } from '../lib/github.js'
import { labelFor, readShipped, WEEK_MS, type ReadAgent, type ReadFailure, type WeekShipped } from './shippingRead.js'
import { backend, identifier, object, SuperTabHostError } from './wire.js'

export const SHIPPING_EVERY_MS = 15 * 60_000
/** The first look comes this long after the daemon connects, and up to as long again, so a computer that starts with others does not
 *  ask together. */
export const SHIPPING_FIRST_MS = 10_000
export const SHIPPING_RETRY_MS = 60_000
/** What one pass reads at most, as the backend bounds it: a hundred Swarms, twenty repositories in each, and fifty agents in a report. */
const MAX_SWARMS = 100
const MAX_REPOSITORIES = 20
const MAX_AGENTS = 50
/** How far back a reading may start: the backend's eight weeks and the one its Monday adds. It bounds the weeks a busy search is cut into. */
const MAX_BACK_MS = 10 * WEEK_MS
/** What a minute may mend. A missing gh, a sign-in, a limit or a search too big is the same a minute on. */
const MENDABLE: readonly ReadFailure[] = ['TIMEOUT', 'GH_FAILED']

interface Target { tabId: string; repositories: string[]; agents: ReadAgent[] }
/** What to look at again soon: these Swarms, or every one when asking the backend is what failed. */
type Again = 'all' | string[]
type Json = Record<string, unknown>
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : []

/** What the backend says to read, as far as it is well-formed and within bounds: a Swarm or an agent it got wrong is left out. */
function targetsOf(answer: unknown, now: number): Target[] {
  return list(object(answer).swarms).flatMap(swarm => {
    const agents = list(swarm.agents).flatMap(agent => {
      const label = typeof agent.name === 'string' ? labelFor(agent.name) : null
      return identifier(agent.id) && label && Number.isSafeInteger(agent.from) && (agent.from as number) >= now - MAX_BACK_MS
        ? [{ id: agent.id, name: agent.name as string, label, from: agent.from as number }] : []
    }).slice(0, MAX_AGENTS)
    const repositories = (Array.isArray(swarm.repositories) ? swarm.repositories : []).filter((name): name is string => typeof name === 'string' && /^[\w.-]+\/[\w.-]+$/.test(name)).slice(0, MAX_REPOSITORIES)
    return identifier(swarm.tabId) && agents.length && repositories.length ? [{ tabId: swarm.tabId, repositories, agents }] : []
  }).slice(0, MAX_SWARMS)
}

/** A week as the report names it: its Monday and the counts above zero. */
const weekOf = ({ week, ...shipped }: WeekShipped): Json => ({ week, ...Object.fromEntries(Object.entries(shipped).filter(([, count]) => count > 0)) })

export class ShippingReporter {
  private timer: NodeJS.Timeout | null = null
  /** Counts the stops: a pass that began before one ends there, reports nothing more and does not schedule the next. */
  private epoch = 0
  private told = ''
  /** The repository names GitHub gave, kept between passes for the repositories the backend still names (shippingRead.ts nameOf). */
  private readonly names = new Map<string, string>()
  private readonly run: Run
  private readonly everyMs: number
  private readonly random: () => number
  private readonly now: () => number

  constructor(private readonly core: CoreApi, options: { run?: Run; everyMs?: number; random?: () => number; now?: () => number } = {}) {
    this.run = options.run ?? ghRun
    this.everyMs = options.everyMs ?? SHIPPING_EVERY_MS
    this.random = options.random ?? Math.random
    this.now = options.now ?? Date.now
  }

  start(): void {
    if (this.timer) return
    this.schedule(SHIPPING_FIRST_MS * (1 + this.random()), this.epoch)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.told = ''
    this.epoch++
  }

  /** The next pass, `again` being what the last left to look at soon: a minute on, once, and then the quarter hour. */
  private schedule(ms: number, epoch: number, again?: Again): void {
    this.timer = setTimeout(() => {
      void this.pass(again).then(left => {
        if (epoch !== this.epoch) return
        const soon = again === undefined ? left : null
        this.schedule(soon ? SHIPPING_RETRY_MS : this.everyMs, epoch, soon ?? undefined)
      })
    }, ms)
    this.timer.unref?.()
  }

  /** One pass over this computer's Swarms (only `again` of them, in a second look): what a minute may mend is returned. It never
   *  rejects: what failed is said once, and the schedule tries again. */
  async pass(again?: Again): Promise<Again | null> {
    // Asked of the core: a service process's own `signedIn()` is always false (processCoreApi.ts), as it holds no account. A core
    // that cannot say is no account.
    if (!await this.core.account.identity().catch(() => null)) return null
    const machineId = this.core.daemon.machineId()
    if (!identifier(machineId)) return null
    const epoch = this.epoch, began = this.now(), path = `/api/super-tabs/hosts/${machineId}/shipping`
    let targets: Target[]
    try {
      targets = targetsOf(await backend(this.core, 'GET', path), began)
    } catch (error) {
      return this.mendable('ask what to read', error) ? 'all' : null
    }
    const named = new Set(targets.flatMap(target => target.repositories))
    for (const repository of this.names.keys()) if (!named.has(repository)) this.names.delete(repository)
    const wanted = targets.filter(({ tabId }) => !Array.isArray(again) || again.includes(tabId)), soon: string[] = []
    let issues = 0, clean = true
    for (const target of wanted) {
      const read = await this.read(path, target, epoch)
      if (!read) return null
      issues += read.issues
      clean &&= read.clean
      if (read.mend) soon.push(target.tabId)
    }
    if (clean && wanted.length) this.say(`read swarms=${wanted.length} issues=${issues} ms=${this.now() - began}`, 'log')
    return soon.length ? soon : null
  }

  /** One Swarm: read what its agents here shipped and report it, or report why an agent could not be read. Null when the reporter was
   *  stopped meanwhile: what was read is not sent, as the account signed in may no longer be the one it was read for. */
  private async read(path: string, target: Target, epoch: number): Promise<{ issues: number; clean: boolean; mend: boolean } | null> {
    if (epoch !== this.epoch) return null
    const readings = await readShipped(this.run, target.repositories, target.agents, this.names, this.now())
    if (epoch !== this.epoch) return null
    const failures = new Set(readings.flatMap(reading => 'failed' in reading ? [reading.failed] : []))
    for (const code of failures) this.say(`could not read GitHub: ${code}`)
    const agents = readings.map(reading => 'failed' in reading ? { agentId: reading.agent.id, failed: reading.failed }
      : { agentId: reading.agent.id, name: reading.agent.name, from: reading.agent.from, weeks: reading.weeks.map(weekOf) })
    const issues = readings.flatMap(reading => 'weeks' in reading ? reading.weeks : []).reduce((sum, week) => sum + week.P0 + week.P1 + week.P2 + week.P3 + week.none, 0)
    let clean = failures.size === 0, mend = [...failures].some(code => MENDABLE.includes(code))
    try {
      const answer = object(await backend(this.core, 'POST', path, { tabId: target.tabId, agents }))
      if (Number(answer.skipped) > 0 || Number(answer.capped) > 0) this.say(`the backend skipped ${Number(answer.skipped)} agents and cut ${Number(answer.capped)} weeks`)
    } catch (error) {
      const mendable = this.mendable('report', error)
      clean = false
      mend = mend || mendable
    }
    return { issues, clean, mend }
  }

  /** Says what went wrong with the backend, and whether a minute may mend it: it was busy or out of reach, it did not refuse. A 404 is
   *  a backend that does not serve the leaderboard yet, as one older than this daemon: it is asked again in a quarter hour. */
  private mendable(what: string, error: unknown): boolean {
    if (!(error instanceof SuperTabHostError)) {
      this.say(`could not ${what}: failed`)
      return true
    }
    this.say(error.status === 404 ? 'the backend does not serve the leaderboard yet' : `could not ${what}: ${error.code} ${error.status}`)
    return error.status >= 500
  }

  /** A line of the log, unless it is the one before: the same trouble every quarter hour is said once. A pass that went well says what
   *  it read as `log`, the measure the daemon keeps of this (counts and time, no name or path). */
  private say(line: string, level: 'warn' | 'log' = 'warn'): void {
    if (line === this.told) return
    this.told = line
    console[level](`[shipping] ${line}`)
  }
}
