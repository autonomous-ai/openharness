/** Stopped work is durable history, separate from the registry of live terminal routes. */
import { closeSync, constants, fsyncSync, openSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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

  /** Correct one field of an archive in place — the folder a Claude row drifted out of (cwdRepair.ts).
   *  Not `save`: that recomputes the name and stamps `updatedAt`, and a repair must not reorder the
   *  catalog or rename anything. Nothing else on the row changes. */
  patch(agentId: string, patch: Partial<Pick<RegisteredSession, 'cwd'>>): boolean {
    const saved = this.get(agentId)
    if (!saved) return false
    secureStateDirectory(dirname(this.directory))
    secureStateDirectory(this.directory)
    atomicWriteJson(join(this.directory, `${agentId}.json`), { version: 1, session: { ...saved, ...patch } })
    return true
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

  /**
   * When the reservation for this agent was taken, or null if there is none.
   *
   * The reservation's whole job is to outlive a crash, so the caller needs to know how long it has
   * been held: one taken by an operation that cannot still be running is protecting nothing, and a
   * harness whose reservation is never released can never be resumed again.
   */
  resumeReservedAt(agentId: string): number | null {
    if (!SAFE_ID.test(agentId)) return null
    try { return statSync(join(this.directory, `${agentId}.resume`)).mtimeMs } catch { return null }
  }

  /**
   * Clear only a verified outcome. Unknown allocation/readiness keeps its reservation.
   *
   * `token` asks for the reservation to be cleared only if it is still the caller's own, which can
   * only be answered by parsing the marker. Without one the caller is clearing it unconditionally,
   * so the CONTENTS are not parsed — a reservation left behind by a crash can be half-written, and
   * refusing to clear THAT is refusing exactly the case a takeover exists for. The file is still
   * opened the same guarded way either way, so a symlink or anything else unsafe in its place
   * fails closed rather than being unlinked on trust.
   */
  finishResume(agentId: string, token?: string): void {
    if (!SAFE_ID.test(agentId)) return
    const file = join(this.directory, `${agentId}.resume`)
    try {
      secureStateDirectory(this.directory, false)
      const marker = readPrivateStateFile(file, 1024)
      if (token !== undefined && JSON.parse(marker).token !== token) return
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
