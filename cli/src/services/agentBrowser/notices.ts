/**
 * The two lines typed into an agent about its browser (spec § Telling the agent): the ready line once per its person's
 * Start, and the stop line at its person's Stop. Nothing else of the browser's reaches the agent: a browser that
 * fails, restarts or is created again for new settings is not told, and its next command says the state.
 *
 * Once per start: the state file's `told` mark is set when the ready line was written (or may have been: a line is
 * never typed twice) and cleared by the person's Stop, so a daemon restart and a resume type nothing. A line the core
 * gives up on is tried again, three times in all; a ready line given up on leaves the browser owed, and its next
 * ready tries again.
 */
import { randomUUID } from 'node:crypto'
import type { StateFile } from './stateFile.js'

export const READY_LINE = 'Your browser is ready: run `harness browser --help`'
export const STOPPED_LINE = 'Your person stopped your browser.'
export const NOTICE_TRIES = 3
/** Times the try: the second waits 30 s, the third 60 s. */
export const NOTICE_RETRY_MS = 30_000

type Kind = 'ready' | 'stopped'

/** What became of a line handed to the core: the core's `TurnDelivery` (core/api.ts), typed here as a service's file
 *  reaches the core only through its top-level service file. */
export interface Delivery {
  deliveryId: string
  state: 'queued' | 'delivered' | 'started' | 'rejected' | 'unknown'
  reason?: string
}

/** The core's `turns` members the lines use, handed in by agentBrowser.ts. */
export interface Turns {
  deliver(agentId: string, text: string, deliveryId: string, options?: { quiet?: true }): void
  cancelDelivery(deliveryId: string): boolean
  onDelivery(listener: (event: Delivery) => void): () => void
}

interface Line {
  agentId: string
  kind: Kind
  tries: number
  /** The delivery the core holds, while it holds one. */
  deliveryId?: string
  /** The wait before the next try. */
  timer?: NodeJS.Timeout
  /** Taken back while the core may already be writing it: by the person's Stop or by the agent's end. */
  takenBack?: 'stopped' | 'ended'
  /** A ready line the Stop took back that turns out written is followed by the stop line. */
  stopAfter?: boolean
}

const TEXT: Record<Kind, string> = { ready: READY_LINE, stopped: STOPPED_LINE }

export class Notices {
  /** The line on its way to each agent, by `<agentId>:<kind>`: waiting in the core or for its next try. */
  private readonly lines = new Map<string, Line>()
  /** Every delivery the core has not settled, those taken back included. */
  private readonly byId = new Map<string, Line>()
  private readonly unhear: () => void

  constructor(private readonly deps: {
    state: StateFile
    turns: Turns
    measure: (name: string) => void
    log: (line: string) => void
  }) {
    this.unhear = deps.turns.onDelivery(event => this.heard(event))
  }

  /** The browser is ready: an agent with no mark, and no ready line already on its way, is typed the ready line. */
  ready(agentId: string): void {
    this.forgetStop(agentId)
    if (this.lines.has(`${agentId}:ready`)) return
    try {
      if (this.deps.state.read().told?.[agentId] === true) return
    } catch (error) {
      this.deps.log(`agent browser ${agentId}: the ready line is not typed: ${(error as Error).message}`)
      return
    }
    this.send({ agentId, kind: 'ready', tries: 0 })
  }

  /** The person's Stop. `saidByCommand`: one of the agent's commands already answered with the stop line. */
  stopped(agentId: string, saidByCommand: boolean): void {
    const told = this.clearMark(agentId)
    const waiting = this.lines.get(`${agentId}:ready`)
    if (waiting) {
      // The agent never knew; should the line be written after all, the stop line follows it.
      this.lines.delete(`${agentId}:ready`)
      this.takeBack(waiting, 'stopped', !saidByCommand)
      return
    }
    if (told && !saidByCommand) this.send({ agentId, kind: 'stopped', tries: 0 })
  }

  /** The agent stopped or was deleted: what waits for it is taken back and never tried again. The mark stays. */
  ended(agentId: string): void {
    for (const kind of ['ready', 'stopped'] as const) {
      const line = this.lines.get(`${agentId}:${kind}`)
      if (!line) continue
      this.lines.delete(`${agentId}:${kind}`)
      this.takeBack(line, 'ended', false)
    }
    this.forgetStop(agentId)
  }

  close(): void {
    this.unhear()
    for (const line of this.lines.values()) clearTimeout(line.timer)
    this.lines.clear()
    this.byId.clear()
  }

  private send(line: Line): void {
    this.lines.set(`${line.agentId}:${line.kind}`, line)
    this.deliver(line)
  }

  private deliver(line: Line): void {
    line.tries += 1
    line.deliveryId = `agent-browser:${line.agentId}:${line.kind}:${randomUUID()}`
    this.byId.set(line.deliveryId, line)
    // Quiet: nobody asked for the line, so the turn it starts ends with no recap and no notification (core/api.ts `DeliveryOptions`).
    this.deps.turns.deliver(line.agentId, TEXT[line.kind], line.deliveryId, { quiet: true })
  }

  private takeBack(line: Line, why: 'stopped' | 'ended', stopAfter: boolean): void {
    clearTimeout(line.timer)
    if (line.deliveryId === undefined) return
    if (this.deps.turns.cancelDelivery(line.deliveryId)) {
      this.byId.delete(line.deliveryId)
      return
    }
    line.takenBack = why
    line.stopAfter = stopAfter
  }

  /** A ready line the Stop took back owes no stop line once the person starts the browser again or the agent ends. */
  private forgetStop(agentId: string): void {
    for (const line of this.byId.values()) if (line.agentId === agentId) line.stopAfter = false
  }

  private heard(event: Delivery): void {
    const line = this.byId.get(event.deliveryId)
    if (!line || event.state === 'queued') return
    this.byId.delete(event.deliveryId)
    line.deliveryId = undefined
    const written = event.state !== 'rejected'
    if (line.takenBack === 'stopped') {
      if (line.stopAfter && (event.state === 'delivered' || event.state === 'started')) {
        this.send({ agentId: line.agentId, kind: 'stopped', tries: 0 })
      }
      return
    }
    if (line.takenBack === 'ended') {
      if (written && line.kind === 'ready') this.mark(line.agentId, event.state)
      return
    }
    if (written) {
      this.lines.delete(`${line.agentId}:${line.kind}`)
      if (line.kind === 'ready') this.mark(line.agentId, event.state)
      return
    }
    if (line.tries >= NOTICE_TRIES) {
      this.lines.delete(`${line.agentId}:${line.kind}`)
      this.deps.measure('agent_browser_notice_failed')
      this.deps.log(`agent browser ${line.agentId}: notice_failed: the ${line.kind} line was not typed after ${NOTICE_TRIES} tries (${event.reason ?? 'rejected'})`)
      return
    }
    line.timer = setTimeout(() => {
      line.timer = undefined
      this.deliver(line)
    }, NOTICE_RETRY_MS * line.tries)
  }

  private mark(agentId: string, state: Delivery['state']): void {
    if (state === 'unknown') this.deps.log(`agent browser ${agentId}: the ready line may have been typed; it is counted as typed`)
    try {
      this.deps.state.update(s => { (s.told ??= {})[agentId] = true })
    } catch (error) {
      this.deps.log(`agent browser ${agentId}: the ready line's mark was not saved: ${(error as Error).message}`)
    }
  }

  /** Clears the agent's mark: whether it was set, or null when the state file cannot be read. */
  private clearMark(agentId: string): boolean | null {
    try {
      if (this.deps.state.read().told?.[agentId] !== true) return false
      this.deps.state.update(s => { delete s.told?.[agentId] })
      return true
    } catch (error) {
      this.deps.log(`agent browser ${agentId}: the stop line is not typed: ${(error as Error).message}`)
      return null
    }
  }
}
