/** Stopped work is durable history, separate from the registry of live terminal routes. */
import { closeSync, constants, fsyncSync, openSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
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
    const previous = this.get(session.agentId)
    if (isTerminalEngine(session.engine) && previous) return
    // A temporarily unbound observation of the SAME process cannot erase a known conversation.
    // A replacement process must earn its own binding; never carry history across PID reuse.
    if (!session.sessionId && previous?.sessionId && previous.engine === session.engine
      && session.processIdentity && previous.processIdentity
      && session.processIdentity.pid === previous.processIdentity.pid
      && session.processIdentity.startMarker === previous.processIdentity.startMarker
      && session.processIdentity.executable === previous.processIdentity.executable) {
      session = { ...session, sessionId: previous.sessionId, transcriptPath: previous.transcriptPath,
        boundAt: previous.boundAt, source: previous.source }
    }
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

  /** Reserve before tmux allocation. A crash between allocation and registry persistence
   * must not permit a second process under a new request/receipt ID. */
  beginResume(agentId: string): string | null {
    if (!SAFE_ID.test(agentId)) throw new Error('Invalid saved harness identity.')
    secureStateDirectory(dirname(this.directory))
    secureStateDirectory(this.directory)
    const file = join(this.directory, `${agentId}.resume`)
    let fd: number
    try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null; throw error }
    const token = randomUUID()
    try { writeFileSync(fd, JSON.stringify({ token })); fsyncSync(fd) } finally { closeSync(fd) }
    this.syncDirectory()
    return token
  }

  /** Clear only a verified outcome. Unknown allocation/readiness keeps its reservation. */
  finishResume(agentId: string, token?: string): void {
    if (!SAFE_ID.test(agentId)) return
    const file = join(this.directory, `${agentId}.resume`)
    try {
      secureStateDirectory(this.directory, false)
      const marker = JSON.parse(readPrivateStateFile(file, 1024))
      if (token !== undefined && marker.token !== token) return
      unlinkSync(file)
      this.syncDirectory()
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }

  private syncDirectory(): void {
    const fd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(fd) } finally { closeSync(fd) }
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
