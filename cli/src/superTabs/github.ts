/**
 * The daemon's half of the Harness GitHub App (docs/swarm-github-app.md): it asks the backend for the token of a local
 * Swarm agent's task, as that agent, and keeps the agent's gh login (lib/swarmGitHub.ts) holding a live token while the
 * task lasts and none after it.
 *
 * The token goes to git through `harness git-credential` (superTabs/gitCredential.ts), which asks here over the local
 * socket, and to gh through the session's own `hosts.yml`. Nothing here logs a token.
 */
import { readdirSync, readFileSync, rmSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import type { CoreApi } from '../core/api.js'
import { swarmGitHubRoot, swarmGitHubSessionDir, writeSessionGitHub } from '../lib/swarmGitHub.js'
import { backend, identifier, object, SuperTabHostError } from './wire.js'
import type { SwarmSources } from './host.js'
import type { HostRead } from './hostFeed.js'

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
export const decided = (error: SuperTabHostError) => (error.status >= 400 && error.status < 500) || error.code === 'GITHUB_APP_NOT_CONFIGURED'

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
/** How long a session's folder with no session registered for it stays: longer than any start waits to launch, since a
 *  start writes the folder before its session is registered (core/agents/create.ts; review of #1998). */
export const UNREGISTERED_FOLDER_MS = 15 * 60_000

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
  /** The assignment each session was last looked at for as soon as it arrived ([assigned]): one look per task, however
   *  often the host reads, even while its token cannot be had. */
  private readonly asked = new Map<string, string>()
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
    this.asked.clear()
  }

  /**
   * The host read its Swarms' rows: a session started to use the app that has a task it holds no token for is looked at
   * now, not at the next minute's pass. Its gh login was empty for up to a minute after the task arrived, so a Builder's
   * first `gh auth status` said "You are not logged into any GitHub hosts" and it stopped (Mac Auto, 2026-10-29). Once per
   * task: a token that cannot be had is asked for again at the minute's pass, as before. Only while the refresher runs.
   */
  assigned(read: HostRead): void {
    if (!this.timer) return
    let due = false
    for (const session of this.core.agents.live()) {
      const id = session.agentId
      const task = read.assignments.find(row => row.harnessId === id && identifier(row.assignmentId))
      if (!task || this.primed.get(id)?.assignmentId === task.assignmentId || this.asked.get(id) === task.assignmentId) continue
      if (!githubDir(this.core, session)) continue
      this.asked.set(id, String(task.assignmentId))
      due = true
    }
    if (due) void this.tick()
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
   * stopped but may run again ([known]) keeps its commit identity and trailers for then. Removed only once untouched for
   * UNREGISTERED_FOLDER_MS: a session still starting has its folder before its record, and a record may not be read just
   * now (review of #1998).
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
        if (!known.has(dir) && this.now() - this.touched(dir) >= UNREGISTERED_FOLDER_MS) { rmSync(dir, { recursive: true, force: true }); continue }
        let hosts: string
        try { hosts = readFileSync(join(dir, 'gh', 'hosts.yml'), 'utf8') } catch { continue }
        if (hosts !== '{}\n') writeSessionGitHub(dir, null)
      } catch (error) {
        console.warn(`[super-tab] could not empty a stopped session's gh login · ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** When anything in a session's folder last changed. */
  private touched(dir: string): number {
    let newest = 0
    for (const path of [dir, join(dir, 'gh'), join(dir, 'gh', 'hosts.yml'), join(dir, 'gh', 'config.yml'), join(dir, 'gitconfig'), join(dir, 'trailers')]) {
      try { newest = Math.max(newest, statSync(path).mtimeMs) } catch { /* not there */ }
    }
    return newest
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
