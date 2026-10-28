/**
 * The daemon's half of the Harness GitHub App (docs/swarm-github-app.md): it asks the backend for the token of a local
 * Swarm agent's task, as that agent, and keeps the agent's gh login (lib/swarmGitHub.ts) holding a live token while the
 * task lasts and none after it.
 *
 * The token goes to git through `harness git-credential` (superTabs/gitCredential.ts), which asks here over the local
 * socket, and to gh through the session's own `hosts.yml`. Nothing here logs a token.
 */
import { readdirSync, readFileSync, rmSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import type { CoreApi } from '../core/api.js'
import { swarmGitHubRoot, swarmGitHubSessionDir, writeSessionGitHub } from '../lib/swarmGitHub.js'
import { backend, identifier, object, SuperTabHostError } from './wire.js'
import type { SwarmSources } from './host.js'

type Json = Record<string, unknown>
type Session = NonNullable<ReturnType<CoreApi['agents']['byAgent']>>
const list = (value: unknown) => Array.isArray(value) ? value.map(object) : []
/** How old a host form a token request may take: git asks for one on every fetch and push, and the server checks the task on
 *  each request anyway. */
const ROSTER_FRESH_MS = 5_000

/** The session's own folder when it was started to use the app, else null. */
function githubDir(core: CoreApi, session: Session | undefined): string | null {
  const skill = session?.swarmSkill
  return skill?.github ? swarmGitHubSessionDir(core.dataDir, skill.key) : null
}

/** Refusals that mean the session must not keep a token: anything the backend decided, and no app on the server. A
 *  backend that could not be reached decides nothing, and an unexpired token stays. */
const decided = (error: SuperTabHostError) => (error.status >= 400 && error.status < 500) || error.code === 'GITHUB_APP_NOT_CONFIGURED'

/**
 * The token of [harnessId]'s task: asked as each Swarm membership this machine's roster lists for that harness (one,
 * nearly always), the first that has a task answering. For a session started to use the app, its gh login and commit
 * trailers are written from the answer, and its login emptied on a refusal.
 */
export async function githubToken(core: CoreApi, harnessId: string, sources: SwarmSources): Promise<Json> {
  const machineId = core.daemon.machineId()
  if (!identifier(machineId) || !identifier(harnessId)) return { error: 'INVALID_REQUEST' }
  const session = core.agents.byAgent(harnessId)
  if (!session) return { error: 'AGENT_UNAVAILABLE', detail: 'This harness is not running on this machine.' }
  const dir = githubDir(core, session)
  let refusal: Json | null = null
  try {
    const rows = list((await sources.feed.current(ROSTER_FRESH_MS)).roster).filter(row => {
      const agent = object(row.agent)
      return identifier(row.tabId) && identifier(agent.id) && agent.machineId === machineId && agent.harnessId === harnessId
        && row.closeSession !== true && row.stopRequested !== true
    })
    for (const row of rows) {
      const tabId = String(row.tabId), agentId = String(object(row.agent).id)
      try {
        const value = object(await backend(core, 'POST', `/api/super-tabs/${tabId}/github-token?asAgentId=${agentId}`, { machineId }))
        if (typeof value.token !== 'string' || typeof value.repository !== 'string') {
          throw new SuperTabHostError('GITHUB_UNAVAILABLE', 'The Harness server answered without a token.', 502)
        }
        if (dir) writeSessionGitHub(dir, value.token, Array.isArray(value.trailers) ? value.trailers.filter(t => typeof t === 'string') : [], value.commitAs ?? null)
        return { ok: true, value: { ...value, tabId, agentId } }
      } catch (error) {
        if (!(error instanceof SuperTabHostError)) throw error
        // A task in another Swarm this harness also belongs to is still worth asking for; any other refusal says more.
        if (!refusal || refusal.error === 'NO_ASSIGNMENT') refusal = { error: error.code, detail: error.message, status: error.status, decided: decided(error) }
      }
    }
  } catch (error) {
    if (!(error instanceof SuperTabHostError)) throw error
    refusal = { error: error.code, detail: error.message, status: error.status, decided: decided(error) }
  }
  refusal ??= { error: 'NOT_A_SWARM_AGENT', detail: 'This harness is not an agent in a Swarm on this machine.', decided: true }
  const { decided: final, ...answer } = refusal
  if (dir && final) writeSessionGitHub(dir, null)
  return answer
}

/** How often the daemon looks at its sessions' tasks. A token is renewed once it has this much left or less. */
export const REFRESH_INTERVAL_MS = 60_000
export const RENEW_BELOW_MS = 10 * 60_000

/**
 * Keeps each local session started to use the app holding a token for its task while the task lasts: renewed before it
 * runs out (the backend hands out a new one ten minutes before expiry), and taken away when the task ends, so gh, which
 * reads its login each time it runs, never holds a stale or finished task's token for long. One backend read a minute,
 * and only while such a session is running.
 */
export class GitHubTokenRefresher {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private readonly primed = new Map<string, { assignmentId: string; expiresAt: number }>()
  private readonly now: () => number
  private readonly intervalMs: number

  constructor(private readonly core: CoreApi, private readonly sources: () => SwarmSources, options: { now?: () => number; intervalMs?: number } = {}) {
    this.now = options.now ?? Date.now
    this.intervalMs = options.intervalMs ?? REFRESH_INTERVAL_MS
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.primed.clear()
  }

  /** One look; a look still running is not started twice. */
  tick(): Promise<void> {
    this.running ??= this.look().catch(error => {
      console.warn(`[super-tab] GitHub tokens not refreshed · ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => { this.running = null })
    return this.running
  }

  /**
   * A session that stopped takes its token with it: its folder's gh login is emptied. A task ended as its agent stopped left
   * the last token there, since only running sessions are looked at (local Team account run, 2026-10-28); so did a session
   * that stopped while no daemon ran. Looked at on every pass, not once: a token fetch still in flight as its session stopped
   * writes the token after the folder was emptied (security review of #1978). One small read per stopped session's folder a
   * minute, while the refresher runs. Anything that is not a session's folder is skipped, and one that cannot be read or
   * written is logged and passed over, so no folder stops the renewals below. A folder whose session is gone from this
   * machine is removed, so passes do not grow with every session ever run (security review of #1978); one whose session
   * stopped but may run again ([known]) keeps its commit identity and trailers for then.
   */
  private emptyStopped(running: ReadonlySet<string>, known: ReadonlySet<string>): void {
    const sessions = join(swarmGitHubRoot(this.core.dataDir), 'sessions')
    let entries: Dirent[]
    try { entries = readdirSync(sessions, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = swarmGitHubSessionDir(this.core.dataDir, entry.name)
      if (!dir || running.has(dir)) continue
      try {
        if (!known.has(dir)) { rmSync(dir, { recursive: true, force: true }); continue }
        let hosts: string
        try { hosts = readFileSync(join(dir, 'gh', 'hosts.yml'), 'utf8') } catch { continue }
        if (hosts !== '{}\n') writeSessionGitHub(dir, null)
      } catch (error) {
        console.warn(`[super-tab] could not empty a stopped session's gh login · ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private async look(): Promise<void> {
    const sessions = this.core.agents.live().flatMap(session => {
      const dir = githubDir(this.core, session)
      return dir ? [{ session, dir }] : []
    })
    for (const id of this.primed.keys()) if (!sessions.some(s => s.session.agentId === id)) this.primed.delete(id)
    this.emptyStopped(new Set(sessions.map(s => s.dir)),
      new Set(this.core.agents.all().flatMap(session => githubDir(this.core, session) ?? [])))
    if (!sessions.length) return
    const machineId = this.core.daemon.machineId()
    if (!identifier(machineId)) return
    let work: Json[]
    // A fresh read each minute: a task that ended takes its token away within that minute.
    try { work = list((await this.sources().feed.refresh()).assignments) } catch (error) {
      if (error instanceof SuperTabHostError) return
      throw error
    }
    for (const { session, dir } of sessions) {
      const id = session.agentId
      const task = work.find(row => row.harnessId === id && identifier(row.assignmentId))
      if (!task) {
        // No task in its hands: no token in its gh login.
        writeSessionGitHub(dir, null)
        this.primed.delete(id)
        continue
      }
      const known = this.primed.get(id)
      if (known && known.assignmentId === task.assignmentId && known.expiresAt - this.now() > RENEW_BELOW_MS) continue
      const answer = await githubToken(this.core, id, this.sources())
      const expiresAt = Date.parse(String(object(answer.value).expiresAt))
      if (answer.ok === true && Number.isFinite(expiresAt)) this.primed.set(id, { assignmentId: String(task.assignmentId), expiresAt })
      else this.primed.delete(id)
    }
  }
}
