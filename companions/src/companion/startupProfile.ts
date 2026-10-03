import type { RegisteredSession } from '../../../cli/src/lib/registry.js'
import type { readStartupProfile } from '../../../cli/src/lib/runtimeProfile.js'

export interface StartupProfile { processKey: string; profile: string }

interface StartupDeps {
  current: () => RegisteredSession | null
  capture: (agentId: string) => Promise<string | null>
  read: typeof readStartupProfile
  now?: () => number
}

/** Only the current companion's live, pre-conversation process can supply this short-lived evidence. */
export class CompanionStartupProfile {
  private observed: (StartupProfile & { expires: number }) | null = null
  private refreshing = false
  constructor(private readonly deps: StartupDeps) {}

  private key(session: RegisteredSession | null): string | null {
    if (!session || session.sessionId || !session.active || !session.processIdentity?.startMarker ||
      session.launch?.state === 'starting' || session.launch?.state === 'failed' ||
      !['claude', 'codex'].includes(session.engine) || session.grid || session.gridLaunch || session.gateway) return null
    return JSON.stringify([session.agentId, [session.engine, session.processIdentity.pid, session.processIdentity.startMarker],
      session.primaryRuntimeKey, session.cwd, session.codexHome ?? null])
  }

  selected(session: RegisteredSession): StartupProfile | null {
    const key = this.key(session)
    if (!key || key !== this.key(this.deps.current()) || key !== this.observed?.processKey ||
      this.observed.expires <= (this.deps.now?.() ?? Date.now())) return null
    return { processKey: key, profile: this.observed.profile }
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return
    const session = this.deps.current(), key = this.key(session)
    if (!session || !key) { this.observed = null; return }
    this.refreshing = true
    try {
      const pane = await this.deps.capture(session.agentId)
      const profile = pane ? await this.deps.read(session, pane) : null
      // Capturing a pane and reading configuration are async. Never attach their result to a new agent.
      this.observed = key === this.key(this.deps.current()) && profile
        ? { processKey: key, profile, expires: (this.deps.now?.() ?? Date.now()) + 45_000 } : null
    } catch {
      this.observed = null
    } finally {
      this.refreshing = false
    }
  }
}
