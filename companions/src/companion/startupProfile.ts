import type { RegisteredSession } from '../../../cli/src/lib/registry.js'
import { RuntimeProfileManager } from '../../../cli/src/lib/runtimeProfile.js'

/** Pre-conversation evidence belongs to this companion, never the core's shared empty-session cache. */
export async function readStartupProfile(session: RegisteredSession, pane: string): Promise<string | null> {
  if (session.sessionId || !session.active || session.grid || session.gridLaunch || session.gateway) return null
  pane = pane.replace(/\u001b\[[0-9;:]*[A-Za-z]/g, '').trimEnd()
  if (/trust this (folder|directory)|trust the files|sign in|log in|select a login|choose.*theme/i.test(pane)) return null
  if (session.engine === 'claude') {
    if (!/\bClaude Code v\d+\.\d+/.test(pane) || !/^\s*❯\s*(?:Try\s+[^\n]*)?$/mu.test(pane)) return null
  } else if (session.engine === 'codex') {
    if (!/\bOpenAI Codex\b/.test(pane) || !/^\s*›(?!\s*\d+\.)[^\n]*$/mu.test(pane)) return null
  } else return null
  // Reuse the ordinary readers in a private cache and on a copy. Nothing is bound, written to the
  // registry, or allowed to replace the model evidence of a real conversation.
  const profiles = new RuntimeProfileManager(), probe = { ...session, sessionId: session.agentId }
  await profiles.ingestConfig(probe, true)
  profiles.ingestPane(probe, pane, true)
  if (session.engine === 'claude') {
    const change = [...pane.matchAll(/(?:^|\n)\s*(?:⎿\s*)?Set model to\s+([^\n]+)/gi)].at(-1)
    if (change) profiles.ingest(probe, JSON.stringify({ type: 'system', content: change[0] }), true)
  }
  return profiles.selectedModel(probe)
}

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
