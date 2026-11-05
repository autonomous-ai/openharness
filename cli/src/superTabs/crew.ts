/**
 * A project's crew on this machine (task #3397, anh Dee's Swarm redesign, 11-05): named agents the Swarm keeps alive. The
 * backend marks one (`agent.crew`, backend superTabs/crew.ts); its roster row carries the mark. This host then keeps it as it
 * keeps the PM (host.ts keepAlive: a gone session is reopened in place), restarts one whose screen froze, and types one
 * continue into a reopened session that still holds its task. The retention names crew (retention.ts), so the idle cleanup
 * (services/agentCleanup.ts) never closes one, and the core lets this host reopen it (inCore/agents.ts keepLeadAlive).
 *
 * The numbers here stay in this one place until the project rules record lands (sibling task of #3397).
 */
import type { CoreApi } from '../core/api.js'
import { WAITING } from './terminal.js'
import { identifier, object } from './wire.js'

/** A crew session the engine says is working whose whole screen did not change this long is frozen: it is restarted. */
export const CREW_FROZEN_MS = 30 * 60_000
/** How often a crew member's screen is looked at for a freeze. */
export const CREW_LOOK_MS = 60_000
/** Typed once into a reopened crew session that still holds its task: nothing old is replayed, the task goes on. */
export const CREW_CONTINUE = 'continue: your session was reopened after it stopped, and this task is still yours'
/** How many times a continue that failed (the pane busy, a prompt in the way) is tried, a look apart, before it is given up. */
export const CREW_CONTINUE_TRIES = 5

/** Whether a host roster row marks its agent as crew this host keeps alive: crew (`agent.crew` with a role), not asleep (closed
 *  on purpose by crew sleep, task #3398) and not moved to another machine (`movedTo`, task #3398), which is gone here. */
export function isCrewRow(row: unknown): boolean {
  const agent = object(object(row).agent), role = object(agent.crew).role
  return typeof role === 'string' && role.length > 0 && !agent.asleep && !agent.movedTo
}

/** Whether this machine's assignment rows name a task running in session [harnessId] (host.ts reads its feed). */
type Owns = (harnessId: string) => Promise<boolean>

/** What the keeper knows of one crew session here: since when its engine has been seen working without a break. */
interface Watch { workingSince: number; said?: string }
/** A continue still owed to a reopened session: when it may be tried next, how many tries it has left, and whether this
 *  reopen typed its text already (only then is Enter owed; review 2 of #3222: after a second crash the restored history
 *  shows the first continue, over an empty composer). */
interface Owed { at: number; tries: number; typed: boolean }

/** How many of a screen's last lines hold its composer, wrapped text and the footer under it. */
const COMPOSER_LINES = 8

/** Its text, its whitespace left out: a narrow pane wraps the typed line. */
const squeezed = (text: string) => text.replace(/\s+/g, '')

/** Whether [screen]'s composer, its last lines, holds the continue. */
const inComposer = (screen: string) =>
  squeezed(screen.split('\n').filter(line => line.trim()).slice(-COMPOSER_LINES).join('\n')).includes(squeezed(CREW_CONTINUE))

/**
 * Restarts a frozen crew session and continues a reopened one. The keep-alive itself is the host's (host.ts keepAlive),
 * shared with the PM: a gone session is reopened in place on its own conversation. A frozen one is closed here (the core's
 * closeMember, which keeps its conversation) so that keep-alive reopens it.
 *
 * It reads no screen of its own for a freeze: the terminal watch records when each whole screen last changed
 * (terminal.ts stillSince), and this asks the engines' activity once a minute for all its crew in one call (review of #3222,
 * ENGINEERING.md 4: the daemon's idle work).
 *
 * Never a close where it deletes what the reopen needs: a confidential session's data, and on a Team daemon any session's
 * (inCore/teamPurge.ts deletes a Team-written Codex session's own engine home, security review 1 of #3222).
 */
export class CrewKeeper {
  private readonly watches = new Map<string, Watch>()
  private readonly owed = new Map<string, Owed>()
  private lookedAt = -Infinity
  private running: Promise<void> | null = null
  private readonly now: () => number
  private readonly log: (message: string) => void
  private readonly owns: Owns
  private readonly stillSince: (harnessId: string) => number | undefined
  private readonly team: () => boolean

  constructor(private readonly core: CoreApi, private readonly machineId: string,
    options: { owns: Owns; stillSince: (harnessId: string) => number | undefined; team: () => boolean; now?: () => number; log?: (message: string) => void }) {
    this.owns = options.owns
    this.stillSince = options.stillSince
    this.team = options.team
    this.now = options.now ?? Date.now
    this.log = options.log ?? (message => console.warn(`[super-tabs] ${message}`))
  }

  /** The keep-alive reopened crew session [harnessId]: it is told to continue once its screen takes input. */
  reopened(harnessId: string): void {
    this.owed.set(harnessId, { at: 0, tries: CREW_CONTINUE_TRIES, typed: false })
    this.watches.delete(harnessId)
  }

  /** Each host roster read; one pass at a time. */
  tick(rows: unknown[]): Promise<void> {
    return this.running ??= this.pass(rows).catch(error => this.log(error instanceof Error ? error.message : String(error)))
      .finally(() => { this.running = null })
  }

  private async pass(rows: unknown[]): Promise<void> {
    /** The crew the roster names here; what is owed them is kept while it does, their terminal away for a moment or not
     *  (review 2 of #3222). */
    const named = new Set<string>()
    const here = new Map<string, Record<string, unknown>>()
    for (const row of rows.map(object)) {
      const agent = object(row.agent)
      if (!identifier(agent.harnessId) || agent.machineId !== this.machineId || row.closeSession === true || row.stopRequested === true || !isCrewRow(row)) continue
      named.add(agent.harnessId)
      if (!this.core.agents.byAgent(agent.harnessId) || !this.core.agents.terminalAvailable(agent.harnessId)) continue
      here.set(agent.harnessId, row)
    }
    for (const id of this.watches.keys()) if (!here.has(id)) this.watches.delete(id)
    for (const id of this.owed.keys()) if (!named.has(id)) this.owed.delete(id)
    for (const harnessId of here.keys()) if (this.owed.has(harnessId)) await this.continueTask(harnessId)
    const now = this.now()
    if (now - this.lookedAt < CREW_LOOK_MS) return
    this.lookedAt = now
    const looked = [...here.keys()].filter(id => !this.owed.has(id))
    if (!looked.length) return
    const activity = await this.core.agents.activity(looked).catch(() => ({} as Record<string, string>))
    for (const harnessId of looked) await this.look(harnessId, activity[harnessId] === 'working', here.get(harnessId)!.confidential === true, now)
  }

  /** Types the owed continue: its text, then Enter only on the screen read after it (inputIfScreen, under the pane's write
   *  lock), so a prompt that opened meanwhile never takes the Enter (reviews of #3222). A try that failed is tried again a
   *  look later, CREW_CONTINUE_TRIES times at most. */
  private async continueTask(harnessId: string): Promise<void> {
    const owed = this.owed.get(harnessId)!, now = this.now()
    if (owed.at > now) return
    if (!await this.owns(harnessId)) return void this.owed.delete(harnessId)
    const again = (why: string) => {
      if (--owed.tries > 0) return void (owed.at = now + CREW_LOOK_MS)
      this.owed.delete(harnessId)
      this.log(`Gave up telling the reopened crew member ${harnessId.slice(0, 8)} to continue: ${why}.`)
    }
    const ready = async () => {
      const read = await this.core.superTabs?.screen(harnessId, 0).catch(() => null)
      return read?.ok && (read.hold === null || !WAITING.has(read.hold)) ? read.text : null
    }
    // A prompt or an unreadable screen waits, a look later, and costs no try.
    let screen = await ready()
    if (screen === null) return void (owed.at = now + CREW_LOOK_MS)
    if (!owed.typed) {
      const typed = await this.core.superTabs!.input(harnessId, CREW_CONTINUE, [])
      if (!typed.ok) return again(typed.error)
      owed.typed = true
      screen = await ready()
      if (screen === null) return void (owed.at = now + CREW_LOOK_MS)
    }
    // Its composer no longer holds it (cleared meanwhile): typed again on the next try, never an Enter on an empty prompt.
    if (!inComposer(screen)) {
      owed.typed = false
      return again('its composer did not keep the text')
    }
    const entered = await this.core.superTabs!.inputIfScreen(harnessId, ['Enter'], screen)
    if (!entered.ok) return again(entered.error)
    this.owed.delete(harnessId)
  }

  private async look(harnessId: string, working: boolean, confidential: boolean, now: number): Promise<void> {
    const watch = this.watches.get(harnessId)
    // Idle at its prompt: its frozen time starts again from its next work.
    if (!working || !watch) return void this.watches.set(harnessId, { workingSince: now, ...watch?.said ? { said: watch.said } : {} })
    const still = this.stillSince(harnessId)
    if (still === undefined) return
    const frozenFor = now - Math.max(still, watch.workingSince)
    if (frozenFor < CREW_FROZEN_MS) return
    const spared = confidential ? 'its session is confidential: closing it would delete its data'
      : this.team() ? 'it runs in a Team account, where closing it deletes what reopening it needs' : null
    if (spared) {
      if (watch.said !== spared) this.log(`The crew member ${harnessId.slice(0, 8)} looks frozen, but ${spared}, so it is left as it is.`)
      watch.said = spared
      return
    }
    this.log(`The crew member ${harnessId.slice(0, 8)} froze: working with an unchanged screen for ${Math.round(frozenFor / 60_000)} minutes. Closing it to reopen it in place.`)
    this.watches.delete(harnessId)
    const closed = await this.core.agents.closeMember?.(harnessId)
    if (!closed || !('closed' in closed) || !closed.closed) this.log(`Could not close the frozen crew member ${harnessId.slice(0, 8)}: ${closed?.error ?? 'unsupported'}.`)
  }
}
