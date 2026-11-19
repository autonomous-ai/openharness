/** Repository observations belong to workspaces; a frame never waits for them. */
import type { AgentView, CoreApi } from '../core/api.js'
import { agentProject } from '../lib/agentProject.js'
import { errorKind } from '../lib/log.js'
import { sessionGitContext, SessionGitContextReader } from '../lib/sessionGitContext.js'
import { sessionGitHistory } from '../lib/sessionGitHistory.js'
import { describeScmProject } from '../scm/scmProjects.js'

const CAPACITY = 512, CONCURRENCY = 4, REFRESH_MS = 15_000
const STALE = Symbol('stale workspace observation')
const identity = (session: AgentView): string => JSON.stringify([
  session.frameEpoch, session.cwd, session.agentId, session.sessionId, session.engine,
  session.codexHome, session.transcriptPath, session.forkedFrom, session.registeredAt,
])
type Entry = { source: AgentView; identity: string; at: number; queued: boolean; running: boolean }

export function startWorkspaceFrames(core: CoreApi) {
  const entries = new Map<string, Entry>(), contexts = new SessionGitContextReader()
  let stopped = false, running = 0, limited = false
  const current = (entry: Entry): boolean => {
    if (stopped || entries.get(entry.source.agentId) !== entry) return false
    const session = core.agents.byAgent(entry.source.agentId)
    return !!session && identity({ ...session, frameEpoch: session.frameEpoch ?? entry.source.frameEpoch }) === entry.identity
  }
  const requireCurrent = (entry: Entry): void => { if (!current(entry)) throw STALE }
  const inspect = async (entry: Entry): Promise<void> => {
    requireCurrent(entry)
    const source = entry.source
    const [home, project, usage, history] = await Promise.all([
      agentProject(source.cwd), describeScmProject(source.cwd), core.usage?.(source), sessionGitHistory.get(source),
    ])
    requireCurrent(entry)
    const gitContext = await contexts.read(entry.identity, async () => {
      const value = await sessionGitContext(home, usage?.work, undefined, history)
      requireCurrent(entry)
      value.history = await sessionGitHistory.observe(source, value)
      return value
    })
    requireCurrent(entry)
    core.agents.publishFrame?.(source, { project, gitContext })
  }
  const drain = (): void => {
    if (stopped) return
    for (const entry of entries.values()) {
      if (running >= CONCURRENCY) break
      if (!entry.queued || entry.running) continue
      entry.queued = false; entry.running = true; running++
      void inspect(entry).catch(error => {
        if (error !== STALE && current(entry)) console.warn(`[workspaces] WORKSPACE_FACTS_UNAVAILABLE · ${errorKind(error)}`)
      }).finally(() => {
        entry.running = false; entry.at = Date.now(); running--
        drain()
      })
    }
  }
  const schedule = (session: AgentView, force = false): void => {
    // Older cores compute these fields themselves. A publication lease advertises the shared path.
    if (stopped || !session.frameEpoch) return
    const key = identity(session), previous = entries.get(session.agentId)
    if (previous?.identity === key) {
      if (previous.running || previous.queued) { if (force) previous.queued = true; return }
      if (!force && Date.now() - previous.at < REFRESH_MS) return
      previous.queued = true
    } else {
      if (!previous && entries.size >= CAPACITY) {
        const settled = [...entries].find(([, entry]) => !entry.running && !entry.queued)
        if (!settled) {
          if (!limited) console.warn('[workspaces] WORKSPACE_FACTS_LIMIT')
          limited = true
          return
        }
        entries.delete(settled[0])
      }
      // Followed views may be reused by a caller; capture authority and observation identity now.
      const source = { ...session, ...(session.forkedFrom ? { forkedFrom: { ...session.forkedFrom } } : {}) }
      entries.set(source.agentId, { source, identity: key, at: 0, queued: true, running: false })
      // The old directory/conversation is no longer a fact about this view. Restore the launch
      // placeholder while the next inspection runs, including when that inspection later fails.
      if (previous) core.agents.publishFrame?.(source, {})
    }
    limited = false
    drain()
  }
  const unfollow = core.agents.follow?.(event => {
    if (event.kind === 'running') schedule(event.session)
    else if (event.kind === 'ended' || event.kind === 'purged') entries.delete(event.agentId)
  }, { each: true, frames: true })
  return {
    refresh(session: AgentView): void {
      const entry = entries.get(session.agentId)
      if (entry && identity({ ...session, frameEpoch: entry.source.frameEpoch }) === entry.identity) schedule(entry.source, true)
    },
    stop(): void { stopped = true; unfollow?.(); entries.clear() },
  }
}
