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

export class LimitResume {
  /** Assignments resumed or refused here: neither is asked about again, though a roster read from before still lists it. */
  private readonly settled = new Set<string>()
  private readonly retryAt = new Map<string, number>()
  private running: Promise<void> | null = null
  private readonly now: () => number
  private readonly log: (message: string) => void

  constructor(private readonly core: CoreApi, private readonly machineId: string, options: { now?: () => number; log?: (message: string) => void } = {}) {
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
    for (const row of rows.map(object)) {
      const agent = object(row.agent), resume = object(row.resume)
      if (!identifier(row.tabId) || !identifier(agent.id) || !identifier(agent.harnessId) || agent.machineId !== this.machineId) continue
      if (!identifier(resume.conversationId) || !identifier(resume.assignmentId) || !(Date.parse(String(resume.at)) <= now)) continue
      if (row.stopRequested === true || !this.core.agents.byAgent(agent.harnessId) || this.settled.has(resume.assignmentId)) continue
      if ((this.retryAt.get(resume.assignmentId) ?? 0) > now) continue
      await this.resume(row.tabId, agent.id, agent.harnessId, resume.conversationId, resume.assignmentId, now)
    }
  }

  private async resume(tabId: string, agentId: string, harnessId: string, conversationId: string, assignmentId: string, now: number): Promise<void> {
    const later = () => { this.retryAt.set(assignmentId, now + RETRY_MS) }
    // Enter on a permission prompt, a question or a menu would answer it. An unreadable screen says nothing either way.
    const read = await this.core.superTabs!.screen(harnessId, 0).catch(() => null)
    if (!read?.ok || (read.hold !== null && WAITING.has(read.hold))) return later()
    try {
      // The same operation each time: an answer lost on the way is replayed, not applied twice.
      await backend(this.core, 'POST', `/api/super-tabs/${tabId}/commands`, { operationId: `limit-resume-${assignmentId}`, asAgentId: agentId,
        command: { type: 'work.resume', conversationId, assignmentId } })
    } catch (error) {
      const refused = error instanceof SuperTabHostError && error.status >= 400 && error.status < 500 && error.code !== 'LIMIT_NOT_RESET'
      this.log(`limit resume of ${assignmentId}: ${error instanceof Error ? error.message : String(error)}`)
      if (refused) this.settled.add(assignmentId)
      else later()
      return
    }
    this.settled.add(assignmentId)
    this.retryAt.delete(assignmentId)
    // The task is the agent's again either way; one it never continues is lost again when its lease runs out.
    const typed = await this.core.superTabs!.input(harnessId, CONTINUE, ['Enter'])
    if (!typed.ok) this.log(`limit resume of ${assignmentId}: ${typed.error}`)
  }
}
