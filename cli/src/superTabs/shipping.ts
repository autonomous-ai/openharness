/**
 * The daemon's half of the Swarm leaderboard (docs/plans/2026-11-09-swarm-v4-leaderboard.md): it asks the backend what this
 * computer's agents of each Swarm should be read for, reads GitHub with this person's own `gh` (shippingRead.ts), and reports counts
 * of what shipped, per agent and week, as the account signed in here. Nothing is sent but counts, and an agent that is not this
 * person's on this computer is never in it (the backend's word, checked again by it on the report).
 *
 * A look every 15 minutes, and only while signed in; a failure is named in the log, reported to the backend (the board shows it to this
 * person alone), and the numbers already there stay. A failed pass is tried again sooner, with growing waits, never more often than
 * the minute.
 */
import type { CoreApi } from '../core/api.js'
import { ghRun, type Run } from '../lib/github.js'
import { labelFor, readShipped, ShippingReadError, type ReadAgent, type ReadFailure, type WeekShipped } from './shippingRead.js'
import { backend, identifier, object, SuperTabHostError } from './wire.js'

export const SHIPPING_EVERY_MS = 15 * 60_000
/** The first look comes this long after the daemon connects, and up to as long again, so a computer that starts with others does not
 *  ask together. */
export const SHIPPING_FIRST_MS = 10_000
export const SHIPPING_RETRY_MS = 60_000
/** The most Swarms one pass reads: the backend names a hundred at most. */
const MAX_SWARMS = 100

interface Target { tabId: string; repositories: string[]; agents: ReadAgent[] }
type Json = Record<string, unknown>
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : []

/** What the backend says to read, as far as it is well-formed: a Swarm or an agent it got wrong is left out. */
function targetsOf(answer: unknown): Target[] {
  return list(object(answer).swarms).flatMap(swarm => {
    const agents = list(swarm.agents).flatMap(agent => {
      const label = typeof agent.name === 'string' ? labelFor(agent.name) : null
      return identifier(agent.id) && label && Number.isSafeInteger(agent.from) ? [{ id: agent.id, name: agent.name as string, label, from: agent.from as number }] : []
    })
    const repositories = Array.isArray(swarm.repositories) ? swarm.repositories.filter((name): name is string => typeof name === 'string' && /^[\w.-]+\/[\w.-]+$/.test(name)) : []
    return identifier(swarm.tabId) && agents.length && repositories.length ? [{ tabId: swarm.tabId, repositories, agents }] : []
  }).slice(0, MAX_SWARMS)
}

/** A week as the report names it: its Monday and the counts above zero. */
const weekOf = ({ week, ...shipped }: WeekShipped): Json => ({ week, ...Object.fromEntries(Object.entries(shipped).filter(([, count]) => count > 0)) })

export class ShippingReporter {
  private timer: NodeJS.Timeout | null = null
  private failures = 0
  private told = ''
  /** The repository names GitHub gave, kept between passes (shippingRead.ts nameOf). */
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
    this.schedule(SHIPPING_FIRST_MS * (1 + this.random()))
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.told = ''
    this.failures = 0
  }

  /** The next pass: a quarter hour on, or sooner after a failure, doubling from the minute. */
  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      void this.pass().finally(() => { if (this.timer) this.schedule(this.failures ? Math.min(this.everyMs, SHIPPING_RETRY_MS * 2 ** (this.failures - 1)) : this.everyMs) })
    }, ms)
    this.timer.unref?.()
  }

  /** One pass over this computer's Swarms. It never rejects: what failed is said once, and the schedule tries again. */
  async pass(): Promise<void> {
    if (!this.core.account.signedIn()) return
    const machineId = this.core.daemon.machineId()
    if (!identifier(machineId)) return
    const began = this.now(), path = `/api/super-tabs/hosts/${machineId}/shipping`
    let targets: Target[], issues = 0, failed = false
    try {
      targets = targetsOf(await backend(this.core, 'GET', path))
    } catch (error) {
      this.failures++
      return this.say(`could not ask what to read: ${error instanceof SuperTabHostError ? `${error.code} ${error.status}` : 'failed'}`)
    }
    for (const target of targets) {
      try {
        const read = await this.read(path, target)
        if (read === null) failed = true
        else issues += read
      } catch (error) {
        failed = true
        this.say(`could not report: ${error instanceof SuperTabHostError ? `${error.code} ${error.status}` : 'failed'}`)
      }
    }
    this.failures = failed ? this.failures + 1 : 0
    if (!failed && targets.length) this.say(`read swarms=${targets.length} issues=${issues} ms=${this.now() - began}`)
  }

  /** One Swarm: read what its agents here shipped and report it, or report why it could not be read (null). The issues counted. */
  private async read(path: string, target: Target): Promise<number | null> {
    let agents: Json[], issues: number | null = 0
    try {
      const read = await readShipped(this.run, target.repositories, target.agents, this.names)
      agents = target.agents.map(agent => ({ agentId: agent.id, name: agent.name, from: agent.from, weeks: read.get(agent.id)!.map(weekOf) }))
      issues = [...read.values()].flat().reduce((sum, week) => sum + week.P0 + week.P1 + week.P2 + week.P3 + week.none, 0)
    } catch (error) {
      const code: ReadFailure = error instanceof ShippingReadError ? error.code : 'GH_FAILED'
      this.say(`could not read GitHub: ${code}`)
      agents = target.agents.map(agent => ({ agentId: agent.id, failed: code }))
      issues = null
    }
    const answer = object(await backend(this.core, 'POST', path, { tabId: target.tabId, agents }))
    if (Number(answer.skipped) > 0 || Number(answer.capped) > 0) this.say(`the backend skipped ${Number(answer.skipped)} agents and cut ${Number(answer.capped)} weeks`)
    return issues
  }

  /** A line of the log, unless it is the one before: the same trouble every quarter hour is said once. */
  private say(line: string): void {
    if (line === this.told) return
    this.told = line
    console.warn(`[shipping] ${line}`)
  }
}
