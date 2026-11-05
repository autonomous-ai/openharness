/**
 * A Buddy's machine carrying out the model switch its owner asked the Swarm for (task #2354,
 * docs/plans/2026-11-03-buddy-model-switch-design.md; backend superTabs/buddyModel.ts). It moves the Buddy, and then each of its
 * thread sessions, through this machine's own daemon's `agent_retarget`, the move a pane's model picker makes: the pane relaunches
 * Claude Code in place and reopens the same conversation. A conversation too long for the model's window starts fresh there
 * instead; the daemon keeps the one it left, which the way home reopens.
 *
 * Each request is carried out once: its outcome is written before it is reported, so a restart reports it rather than moving the
 * Buddy again.
 */
import { createHash } from 'node:crypto'
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Daemon } from '../agentClient/daemon.js'
import { readPrivateStateFile, secureStateDirectory } from '../lib/secureState.js'
import { BUDDY_NOT_HERE, BUDDY_START_AGAIN } from '../lib/swarmSkills.js'
import { identifier, object } from './wire.js'

/** A conversation this share of the model's window or more starts fresh: the rest is the room its next turns need. */
export const FRESH_SHARE = 0.8
/** How long a move may take: the daemon stops the engine, relaunches it and waits for it to come up. */
const MOVE_TIMEOUT_MS = 120_000
/** How soon a request that waits (a Buddy sent home mid-turn) or a report that failed is tried again. */
const RETRY_MS = 15_000

interface ModelRequest { id: string; gridModel: string | null; gridName?: string; name?: string; servedBy?: string[]; contextWindow?: number; reason?: string }
/** A Buddy agent's row as this machine's host reads it (backend read/hostRows.ts). */
export interface BuddyModelRow {
  tabId: string
  agent: { id: string; harnessId: string; buddyOf?: unknown; buddySession?: unknown; modelRequest?: unknown }
}
interface Outcome { ok: boolean; fresh?: true; error?: string }
export interface BuddyModelDeps {
  dataDir: string
  now: () => number
  log: (message: string) => void
  open: () => Promise<Pick<Daemon, 'request' | 'close'>>
  post: (tabId: string, agentId: string, operationId: string, command: Record<string, unknown>) => Promise<unknown>
  /** The Claude Code transcript of this machine's session [harnessId], when it has one. */
  transcript: (harnessId: string) => string | null | undefined
  /** How long that conversation is now, in tokens (lib/conversationSize.ts). */
  tokens: (transcriptPath: string) => Promise<number | null>
}

function requestOf(value: unknown): ModelRequest | null {
  const r = object(value)
  if (!identifier(r.id) || !(r.gridModel === null || typeof r.gridModel === 'string')) return null
  return { id: r.id, gridModel: r.gridModel, ...(typeof r.gridName === 'string' ? { gridName: r.gridName } : {}),
    ...(typeof r.name === 'string' ? { name: r.name } : {}),
    ...(Array.isArray(r.servedBy) ? { servedBy: r.servedBy.filter((s): s is string => typeof s === 'string') } : {}),
    ...(typeof r.contextWindow === 'number' && r.contextWindow > 0 ? { contextWindow: r.contextWindow } : {}),
    ...(typeof r.reason === 'string' ? { reason: r.reason } : {}) }
}

/** Why a move was refused, in words its owner can act on: never the daemon's detail, which can name paths on this machine.
 *  The detail is only read for the Buddy guard's two holds (lib/swarmSkills.ts prepareBuddyFolder), which every relaunch runs
 *  and the launch reports as SWARM_SKILL_FAILED with the guard's own sentence (lib/launchOverrides.ts). Task #3256: Scholes's
 *  switch to his saved API, on a Buddy started before its owner was recorded, said only the code. */
function refusal(code: string, request: ModelRequest, detail?: string): string {
  if (code === 'AGENT_BUSY') return 'Your Buddy is answering. Try again when it has finished'
  if (code === 'SWARM_SKILL_FAILED' && detail?.includes(BUDDY_START_AGAIN)) return 'Start your Buddy again to switch its model'
  if (code === 'SWARM_SKILL_FAILED' && detail?.includes(BUDDY_NOT_HERE)) return 'Your Buddy runs only on your own computer, signed in as you'
  if ((code === 'GRID_UNAVAILABLE' || code === 'API_UNAVAILABLE') && request.gridModel) {
    const name = request.name ?? request.gridModel
    return request.servedBy?.length ? `${request.servedBy.join(', ')} isn't serving ${name} now` : `Nobody serves ${name} now`
  }
  return `its computer could not switch it (${code.replace(/[^A-Z0-9_]/g, '').slice(0, 60) || 'FAILED'})`
}

export class BuddyModelRequests {
  /** Requests reported, or settled elsewhere: never carried out again by this process. */
  private readonly done = new Set<string>()
  private readonly waiting = new Map<string, { busy: boolean; retryAt: number }>()
  constructor(private readonly deps: BuddyModelDeps) {}

  /** One poll of a main Buddy row of this machine, with its thread sessions' rows. */
  async serve(row: BuddyModelRow, sessions: readonly BuddyModelRow[]): Promise<void> {
    const request = requestOf(row.agent.modelRequest)
    if (!request || this.done.has(request.id)) return
    const now = this.deps.now(), held = this.waiting.get(request.id)
    if (held && (held.busy || now < held.retryAt)) return
    this.waiting.set(request.id, { busy: true, retryAt: 0 })
    try {
      const recorded = this.recorded(row.agent.id)
      let outcome = recorded?.requestId === request.id ? recorded.outcome : undefined
      if (!outcome) {
        const carried = await this.carryOut(row, sessions, request)
        if (carried === 'wait') { this.waiting.set(request.id, { busy: false, retryAt: now + RETRY_MS }); return }
        outcome = carried
        this.record(row.agent.id, { requestId: request.id, outcome })
      }
      try {
        await this.deps.post(row.tabId, row.agent.id, `buddy-model-${request.id}`.slice(0, 160),
          { type: 'buddy.modelResult', agentId: row.agent.id, requestId: request.id, ...outcome })
      } catch (failure) {
        // A request the Swarm already settled (its lease ran out) is done; any other failure is reported again later.
        if (object(failure).code !== 'STALE_SWITCH') { this.waiting.set(request.id, { busy: false, retryAt: now + RETRY_MS }); return }
      }
      this.done.add(request.id)
      this.waiting.delete(request.id)
    } catch (error) {
      this.deps.log(`Buddy model: ${error instanceof Error ? error.name : typeof error}`)
      this.waiting.set(request.id, { busy: false, retryAt: now + RETRY_MS })
    }
  }

  private async carryOut(row: BuddyModelRow, sessions: readonly BuddyModelRow[], request: ModelRequest): Promise<Outcome | 'wait'> {
    const daemon = await this.deps.open()
    try {
      const move = async (harnessId: string): Promise<{ error?: string; detail?: string; fresh: boolean }> => {
        const fresh = await this.tooLong(harnessId, request)
        const frame = request.gridModel === null ? { agentId: harnessId, clearGrid: true }
          : { agentId: harnessId, gridModel: request.gridModel, gridName: request.gridName, ...(fresh ? { fresh: true } : {}) }
        const reply = await daemon.request('agent_retarget', frame, MOVE_TIMEOUT_MS).catch((): Record<string, unknown> => ({ error: 'TIMEOUT' }))
        return { ...(typeof reply.error === 'string' ? { error: reply.error } : {}),
          ...(typeof reply.detail === 'string' ? { detail: reply.detail } : {}), fresh }
      }
      const moved = await move(row.agent.harnessId)
      if (moved.error) {
        // Sent home by the Swarm (a limit, a model gone) while it answers: moved once the turn ends, within the request's lease.
        if (moved.error === 'AGENT_BUSY' && request.reason) return 'wait'
        return { ok: false, error: refusal(moved.error, request, moved.detail) }
      }
      const stayed: string[] = []
      for (const session of sessions) {
        const result = await move(session.agent.harnessId)
        if (result.error) stayed.push(result.error === 'AGENT_BUSY' ? 'it was answering' : refusal(result.error, request, result.detail))
      }
      return { ok: true, ...(moved.fresh ? { fresh: true as const } : {}),
        ...(stayed.length === 1 ? { error: `A thread session stayed where it was: ${stayed[0]}` }
          : stayed.length ? { error: `${stayed.length} thread sessions stayed where they were: ${stayed[0]}` } : {}) }
    } finally { daemon.close() }
  }

  /** Whether [harnessId]'s conversation is too long for the model it moves onto. Unknown counts as fitting: it resumes, as a
   *  pane's switch does. */
  private async tooLong(harnessId: string, request: ModelRequest): Promise<boolean> {
    if (request.gridModel === null || !request.contextWindow) return false
    const path = this.deps.transcript(harnessId)
    const tokens = path ? await this.deps.tokens(path).catch(() => null) : null
    return tokens !== null && tokens >= FRESH_SHARE * request.contextWindow
  }

  private file(agentId: string): string {
    return join(this.deps.dataDir, 'super-tabs', 'buddy-model', `${createHash('sha256').update(agentId).digest('hex')}.json`)
  }
  /** The last request carried out for this Buddy (one per Buddy, replaced by the next). */
  private recorded(agentId: string): { requestId: string; outcome: Outcome } | null {
    const file = this.file(agentId)
    if (!existsSync(file)) return null
    try {
      const row = object(JSON.parse(readPrivateStateFile(file, 4_096))), outcome = object(row.outcome)
      if (!identifier(row.requestId) || typeof outcome.ok !== 'boolean') return null
      return { requestId: row.requestId, outcome: { ok: outcome.ok, ...(outcome.fresh === true ? { fresh: true } : {}),
        ...(typeof outcome.error === 'string' ? { error: outcome.error.slice(0, 300) } : {}) } }
    } catch { return null }
  }
  private record(agentId: string, value: { requestId: string; outcome: Outcome }): void {
    const file = this.file(agentId)
    secureStateDirectory(join(this.deps.dataDir, 'super-tabs', 'buddy-model'))
    writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
}
