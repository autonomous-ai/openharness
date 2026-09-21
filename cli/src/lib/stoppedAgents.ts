/** Stopped work is durable history, separate from the registry of live terminal routes. */
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { env } from '../config/env.js'
import { isTerminalEngine } from '../engines/types.js'
import { atomicWriteJson, projectDisplayName, strictPersistedRow, type RegisteredSession } from './registry.js'
import { readPrivateStateFile, secureStateDirectory } from './secureState.js'

const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/
export class StoppedAgentStore {
  constructor(private readonly directory = join(env.ADAPTER_DATA_DIR, 'stopped-agents')) {}

  get(agentId: string): RegisteredSession | null {
    if (!SAFE_ID.test(agentId)) return null
    try {
      secureStateDirectory(this.directory, false)
      const raw = JSON.parse(readPrivateStateFile(join(this.directory, `${agentId}.json`), 1024 * 1024))
      if (raw.version !== 1) return null
      const session = strictPersistedRow(raw.session)
      return session?.agentId === agentId ? session : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('Could not read the saved stopped harness.')
    }
  }

  list(): RegisteredSession[] {
    try {
      secureStateDirectory(this.directory, false)
      return readdirSync(this.directory).filter(name => name.endsWith('.json')).flatMap(name => {
        try {
          const saved = this.get(name.slice(0, -5))
          return saved ? [saved] : []
        } catch {
          // One unreadable record must not hide the other saved harnesses.
          return []
        }
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  save(session: RegisteredSession): void {
    if (!SAFE_ID.test(session.agentId)) throw new Error('Invalid stopped harness identity.')
    // An exited engine leaves its pane as a shell. Stopping that shell must keep
    // the conversation saved before releaseEngine cleared its binding/profile.
    if (isTerminalEngine(session.engine) && this.get(session.agentId)) return
    secureStateDirectory(dirname(this.directory))
    secureStateDirectory(this.directory)
    const snapshot = {
      ...session,
      active: false,
      launch: { state: 'ready' },
      defaultName: projectDisplayName(session),
      updatedAt: Date.now(),
    }
    // Herdr-only snapshots omit the legacy alias just like registry persistence.
    if (!snapshot.tmuxPane) delete (snapshot as Partial<RegisteredSession>).tmuxPane
    atomicWriteJson(join(this.directory, `${session.agentId}.json`), { version: 1, session: snapshot })
  }

  /** Suppress archives whose identity or conversation is already running. */
  available(live: readonly RegisteredSession[]): RegisteredSession[] {
    const ids = new Set(live.map(session => session.agentId))
    const conversations = new Set(live.filter(session => session.sessionId).map(session =>
      `${session.engine}\0${session.codexHome ?? ''}\0${session.sessionId}`))
    return this.list().filter(session => !ids.has(session.agentId)
      && (!session.sessionId || !conversations.has(`${session.engine}\0${session.codexHome ?? ''}\0${session.sessionId}`)))
  }
}

export const stoppedAgents = new StoppedAgentStore()
