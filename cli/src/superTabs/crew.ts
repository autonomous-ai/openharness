/**
 * A project's crew on this machine (task #3397, anh Dee's Swarm redesign, 11-05): named agents the Swarm keeps alive. The
 * backend marks one (`agent.crew`, backend superTabs/crew.ts); its roster row carries the mark. This host then keeps it as it
 * keeps the PM (host.ts keepAlive: a gone session is reopened in place), restarts one whose screen froze, and types one
 * continue into a reopened session that still holds its task. The retention names crew (retention.ts), so the idle cleanup
 * (services/agentCleanup.ts) never closes one, and the core lets this host reopen it (inCore/agents.ts keepLeadAlive).
 *
 * The numbers here stay in this one place until the project rules record lands (sibling task of #3397).
 */
import { createHash } from 'node:crypto'
import type { CoreApi } from '../core/api.js'
import { WAITING } from './terminal.js'
import { identifier, object } from './wire.js'

/** A crew session the engine says is working whose whole screen did not change this long is frozen: it is restarted. */
export const CREW_FROZEN_MS = 30 * 60_000
/** How often a crew member's screen is looked at for a freeze. */
export const CREW_LOOK_MS = 60_000
/** Typed once into a reopened crew session that still holds its task: nothing old is replayed, the task goes on. */
export const CREW_CONTINUE = 'continue: your session was reopened after it stopped, and this task is still yours'

/** Whether a host roster row marks its agent as crew this host keeps alive: crew (`agent.crew` with a role), not asleep (closed
 *  on purpose by crew sleep, task #3398) and not moved to another machine (`movedTo`, task #3398), which is gone here. */
export function isCrewRow(row: unknown): boolean {
  const agent = object(object(row).agent), role = object(agent.crew).role
  return typeof role === 'string' && role.length > 0 && !agent.asleep && !agent.movedTo
}

/** Whether this machine's assignment rows name a task running in session [harnessId] (host.ts reads its feed). */
type Owns = (harnessId: string) => Promise<boolean>

/** What the keeper knows of one crew session here: its whole screen's digest and since when the engine has worked with it
 *  unchanged, and when it was last looked at. */
interface Watch { digest: string | null; stillSince: number; lookedAt: number; said?: string }

/** A crew session's whole screen, its status line too: a working engine redraws its timer every second, so a screen that
 *  stays the same while the engine says it works is frozen, not a long command that prints nothing (liveness.ts). */
const digestOf = (text: string) => createHash('sha256').update(text).digest('base64url')

/**
 * Restarts a frozen crew session and continues a reopened one. The keep-alive itself is the host's (host.ts keepAlive),
 * shared with the PM: a gone session is reopened in place on its own conversation. A frozen one is closed here (the core's
 * closeMember, which keeps its conversation) so that keep-alive reopens it. Never a confidential one: in a Team account a
 * close deletes its session's data (inCore/agents.ts ended), which would lose the task it was meant to keep.
 */
export class CrewKeeper {
  private readonly watches = new Map<string, Watch>()
  /** Sessions reopened by the keep-alive that still owe their continue, with when it may be tried next. */
  private readonly owed = new Map<string, number>()
  private running: Promise<void> | null = null
  private readonly now: () => number
  private readonly log: (message: string) => void
  private readonly owns: Owns

  constructor(private readonly core: CoreApi, private readonly machineId: string, options: { owns: Owns; now?: () => number; log?: (message: string) => void }) {
    this.owns = options.owns
    this.now = options.now ?? Date.now
    this.log = options.log ?? (message => console.warn(`[super-tabs] ${message}`))
  }

  /** The keep-alive reopened crew session [harnessId]: it is told to continue once its screen takes input. */
  reopened(harnessId: string): void {
    this.owed.set(harnessId, 0)
    this.watches.delete(harnessId)
  }

  /** Each host roster read; one pass at a time. */
  tick(rows: unknown[]): Promise<void> {
    return this.running ??= this.pass(rows).catch(error => this.log(error instanceof Error ? error.message : String(error)))
      .finally(() => { this.running = null })
  }

  private async pass(rows: unknown[]): Promise<void> {
    const here = new Map<string, Record<string, unknown>>()
    for (const row of rows.map(object)) {
      const agent = object(row.agent)
      if (!identifier(agent.harnessId) || agent.machineId !== this.machineId || row.closeSession === true || row.stopRequested === true || !isCrewRow(row)) continue
      here.set(agent.harnessId, row)
    }
    for (const id of this.watches.keys()) if (!here.has(id)) this.watches.delete(id)
    for (const id of this.owed.keys()) if (!here.has(id)) this.owed.delete(id)
    for (const [harnessId, row] of here) {
      if (!this.core.agents.byAgent(harnessId) || !this.core.agents.terminalAvailable(harnessId)) continue
      if (this.owed.has(harnessId)) await this.continueTask(harnessId)
      else await this.look(harnessId, row.confidential === true)
    }
  }

  private async continueTask(harnessId: string): Promise<void> {
    const now = this.now()
    if (this.owed.get(harnessId)! > now) return
    if (!await this.owns(harnessId)) return void this.owed.delete(harnessId)
    // Enter on a permission prompt, a question or a menu would answer it. An unreadable screen says nothing either way.
    const read = await this.core.superTabs?.screen(harnessId, 0).catch(() => null)
    if (!read?.ok || (read.hold !== null && WAITING.has(read.hold))) return void this.owed.set(harnessId, now + CREW_LOOK_MS)
    this.owed.delete(harnessId)
    const typed = await this.core.superTabs!.input(harnessId, CREW_CONTINUE, ['Enter'])
    if (!typed.ok) this.log(`Could not tell the reopened crew member ${harnessId.slice(0, 8)} to continue: ${typed.error}`)
  }

  private async look(harnessId: string, confidential: boolean): Promise<void> {
    const now = this.now()
    const watch = this.watches.get(harnessId)
    if (watch && now - watch.lookedAt < CREW_LOOK_MS) return
    const working = (await this.core.agents.activity([harnessId]).catch(() => ({} as Record<string, string>)))[harnessId] === 'working'
    const read = await this.core.superTabs?.screen(harnessId, 0).catch(() => null)
    const digest = read?.ok ? digestOf(read.text) : null
    // Idle at its prompt, unreadable, or a screen that moved: its still time starts again now.
    if (!watch || !working || digest === null || digest !== watch.digest) {
      this.watches.set(harnessId, { digest, stillSince: now, lookedAt: now, ...watch?.said ? { said: watch.said } : {} })
      return
    }
    watch.lookedAt = now
    if (now - watch.stillSince < CREW_FROZEN_MS) return
    if (confidential) {
      if (watch.said !== 'confidential') this.log(`The crew member ${harnessId.slice(0, 8)} looks frozen, but its session is confidential: closing it would delete its data, so it is left as it is.`)
      watch.said = 'confidential'
      return
    }
    this.log(`The crew member ${harnessId.slice(0, 8)} froze: working with an unchanged screen for ${Math.round((now - watch.stillSince) / 60_000)} minutes. Closing it to reopen it in place.`)
    this.watches.delete(harnessId)
    const closed = await this.core.agents.closeMember?.(harnessId)
    if (!closed || !('closed' in closed) || !closed.closed) this.log(`Could not close the frozen crew member ${harnessId.slice(0, 8)}: ${closed?.error ?? 'unsupported'}.`)
  }
}
