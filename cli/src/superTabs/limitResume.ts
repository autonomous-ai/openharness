/**
 * Night shift (v2 B): a worker that hits a usage limit loses its task at once (backend superTabs/liveness.ts), and nothing
 * took it back: lampOS lost about four times its throughput overnight to agents waiting out limits. When the limit screen
 * said when it resets, the roster row says when the task resumes, until the Lead hands it on. Then this host types a short
 * continue into that same session. It asks the backend first and types only once the backend has given the task back, so
 * a task handed on before the reset never resumes in the old session.
 */
import type { CoreApi } from '../core/api.js'
import { backend } from './host.js'
import { WAITING } from './terminal.js'
import { identifier, object, SuperTabHostError } from './wire.js'

/** The agent was told its task moved when it was lost (liveness.ts), so the line says the task is its own again. */
export const CONTINUE = 'continue: your usage limit has reset and this task is yours again'
/** A resume that could not happen yet (a prompt open, the backend out of reach or its clock behind) waits this long. */
const RETRY_MS = 15_000
/** How long a settled loss, or a retry time gone by, is kept (Diego's issue, 2026-10-27: both grew for the life of the
 *  daemon, one per lost task). A roster read that still lists a settled loss is seconds old, so the continue is never typed
 *  twice. */
const SETTLED_MS = 10 * 60_000

/** A loss due to resume: its agent here, and which loss of which task. */
interface Due { tabId: string; agentId: string; harnessId: string; conversationId: string; assignmentId: string; lostAt: number; key: string }
/** Whether this machine's assignment rows list the task as running in this session now (host.ts reads its feed). */
type Owns = (tabId: string, assignmentId: string, harnessId: string) => Promise<boolean>

export class LimitResume {
  /** Losses resumed or refused here, by assignment and loss (one task can be lost, resumed and lost again): neither is
   *  asked about again, though a roster read from before still lists it. Each with when it was settled. */
  private readonly settled = new Map<string, number>()
  private readonly retryAt = new Map<string, number>()
  /** Losses the backend gave back whose continue is not typed yet: the row stops listing them once the task is resumed. */
  private readonly typing = new Map<string, Due>()
  private running: Promise<void> | null = null
  private readonly now: () => number
  private readonly log: (message: string) => void
  private readonly owns: Owns

  constructor(private readonly core: CoreApi, private readonly machineId: string, options: { owns: Owns; now?: () => number; log?: (message: string) => void }) {
    this.owns = options.owns
    this.now = options.now ?? Date.now
    this.log = options.log ?? (message => console.warn(`[super-tabs] ${message}`))
  }

  /** Each host roster read; one pass at a time. */
  tick(rows: unknown[]): Promise<void> {
    return this.running ??= this.resumeDue(rows).catch(error => this.log(error instanceof Error ? error.message : String(error)))
      .finally(() => { this.running = null })
  }

  private async resumeDue(rows: unknown[]): Promise<void> {
    const now = this.now()
    for (const [key, at] of this.settled) if (at <= now - SETTLED_MS) this.settled.delete(key)
    for (const [key, at] of this.retryAt) if (at <= now - SETTLED_MS) this.retryAt.delete(key)
    for (const row of rows.map(object)) {
      const agent = object(row.agent), resume = object(row.resume)
      if (!identifier(row.tabId) || !identifier(agent.id) || !identifier(agent.harnessId) || agent.machineId !== this.machineId) continue
      if (!identifier(resume.conversationId) || !identifier(resume.assignmentId) || !Number.isSafeInteger(resume.lostAt) || !(Date.parse(String(resume.at)) <= now)) continue
      const key = `${resume.assignmentId}-${resume.lostAt}`
      if (row.stopRequested === true || !this.core.agents.byAgent(agent.harnessId) || this.settled.has(key) || (this.retryAt.get(key) ?? 0) > now) continue
      await this.resume({ tabId: row.tabId, agentId: agent.id, harnessId: agent.harnessId, conversationId: resume.conversationId,
        assignmentId: resume.assignmentId, lostAt: resume.lostAt as number, key }, now)
    }
    for (const due of [...this.typing.values()]) if ((this.retryAt.get(due.key) ?? 0) <= now) await this.type(due, now)
  }

  /** Asks the backend for the task back; once it says yes, the continue is owed (`typing`). */
  private async resume(due: Due, now: number): Promise<void> {
    try {
      // The same operation each time: an answer lost on the way is replayed, not applied twice.
      await backend(this.core, 'POST', `/api/super-tabs/${due.tabId}/commands`, { operationId: `limit-resume-${due.key}`, asAgentId: due.agentId,
        command: { type: 'work.resume', conversationId: due.conversationId, assignmentId: due.assignmentId, lostAt: due.lostAt } })
    } catch (error) {
      const refused = error instanceof SuperTabHostError && error.status >= 400 && error.status < 500 && error.code !== 'LIMIT_NOT_RESET'
      this.log(`limit resume of ${due.assignmentId}: ${error instanceof Error ? error.message : String(error)}`)
      if (refused) this.settled.set(due.key, now)
      else this.retryAt.set(due.key, now + RETRY_MS)
      return
    }
    this.settled.set(due.key, now)
    this.retryAt.delete(due.key)
    this.typing.set(due.key, due)
  }

  /** Types the owed continue, checking each time first that the task is still this session's and nothing on screen would
   *  take the Enter. The screen is read here, after the backend answered, not before asking (#1757 review, 3): a prompt
   *  that opened meanwhile would have taken it. The read and the typing are still two steps; the terminal module checks
   *  holds at input once it lives outside the core (the follow-up to Avery's move). */
  private async type(due: Due, now: number): Promise<void> {
    // A replayed yes is the first answer, not who holds the task now: after a lost reply and a takeover it still says yes
    // (#1757 review, 2). The assignment rows read now say whether this session runs it.
    if (!await this.owns(due.tabId, due.assignmentId, due.harnessId)) {
      this.typing.delete(due.key)
      return this.log(`limit resume of ${due.assignmentId}: the task is no longer this session's`)
    }
    // Enter on a permission prompt, a question or a menu would answer it. An unreadable screen says nothing either way.
    const read = await this.core.superTabs!.screen(due.harnessId, 0).catch(() => null)
    if (!read?.ok || (read.hold !== null && WAITING.has(read.hold))) return void this.retryAt.set(due.key, now + RETRY_MS)
    this.typing.delete(due.key)
    this.retryAt.delete(due.key)
    // The task is the agent's again either way; one it never continues is lost again when its lease runs out.
    const typed = await this.core.superTabs!.input(due.harnessId, CONTINUE, ['Enter'])
    if (!typed.ok) this.log(`limit resume of ${due.assignmentId}: ${typed.error}`)
  }
}
