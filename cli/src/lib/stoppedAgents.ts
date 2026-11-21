/** Stopped work is durable history, separate from the registry of live terminal routes. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { env } from '../config/env.js'
import { isTerminalEngine } from '../engines/types.js'
import { projectDisplayName, strictPersistedRow, withHermesHome, type RegisteredSession } from './registry.js'
import { closeStateFileDescriptor, directorySyncSupported, readPrivateStateFile, secureStateDirectory, stateFileCustodyHealthy, syncStateDirectory } from './secureState.js'
import { sameProcessIdentity } from './terminalRuntime.js'
import { conversationKey } from './conversationIdentity.js'
import { SessionStorage, sessionStorage } from './sessionStorage.js'
import { SessionStorageUnavailable, sessionFileIdentity, sessionImageProof, type SessionImage, type SessionImageProof, type StoppedArchiveQuery } from './sessionStorageWire.js'
import { RegistryPersistenceUnavailable, RegistryWriteQueue } from './registryPersistence.js'
import { AtomicWriteUnconfirmed } from './secureState.js'
import { prepareSessionPublication } from './sessionPublication.js'

const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/
export class StoppedAgentStore {
  private readonly writer = new RegistryWriteQueue()
  private readonly proofs = new WeakMap<RegisteredSession, SessionImageProof>()
  private readonly storage: SessionStorage

  constructor(private readonly directory = join(env.ADAPTER_DATA_DIR, 'stopped-agents')) {
    this.storage = directory === join(env.ADAPTER_DATA_DIR, 'stopped-agents') ? sessionStorage
      : new SessionStorage(dirname(directory), undefined, basename(directory))
  }

  private decode(agentId: string, image: SessionImage, selected = true): RegisteredSession | null {
    if (image.state === 'missing') return null
    if (!image.json || !image.value || typeof image.value !== 'object') throw new SessionStorageUnavailable('invalid')
    const raw = image.value as { version?: unknown; session?: unknown }
    if (raw.version !== 1) return null
    const session = strictPersistedRow(raw.session)
    if (!session || session.agentId !== agentId) return null
    if (selected) this.proofs.set(session, image.proof)
    return session
  }

  query(query: StoppedArchiveQuery) { return this.storage.stoppedQuery(query) }

  /** A keep action takes its absence witness after establishing the archive container it will write. */
  prepareSave(): void {
    secureStateDirectory(dirname(this.directory))
    secureStateDirectory(this.directory)
  }

  async selectConversations(keys: readonly string[]): Promise<RegisteredSession[]> {
    const wanted = [...new Set(keys)], rows: RegisteredSession[] = []
    for (let offset = 0; offset < wanted.length; offset += 258) {
      const answer = await this.query({ kind: 'owners', keys: wanted.slice(offset, offset + 258), defaultCodexHome: env.CODEX_HOME })
      for (const image of answer.selected!) {
        if (image.state !== 'image' || !sessionImageProof(image.proof) || image.proof.document.kind !== 'stopped') throw new SessionStorageUnavailable('invalid')
        const row = this.decode(image.proof.document.agentId, image)
        if (!row || !wanted.includes(conversationKey(row)!)) throw new SessionStorageUnavailable('invalid')
        rows.push(row)
      }
    }
    return rows
  }

  async get(agentId: string): Promise<RegisteredSession | null> {
    if (!SAFE_ID.test(agentId)) return null
    return this.decode(agentId, await this.storage.read({ kind: 'stopped', agentId }))
  }

  /** A fresh read grants only this exact image. Recheck synchronously at the caller's final effect. */
  current(session: RegisteredSession): boolean {
    const proof = this.proofs.get(session)
    if (!proof) return false
    try {
      secureStateDirectory(this.directory, false)
      return sessionFileIdentity(lstatSync(join(this.directory, `${session.agentId}.json`), { bigint: true })) === proof.identity
    } catch { return false }
  }

  /** Custom fixture stores own their child; the production child is closed by the core. */
  async close(): Promise<void> {
    await this.writer.finish(async () => {})
    if (this.storage !== sessionStorage) await this.storage.close()
  }

  /** The id of every saved record, readable or not (`list()` skips an unreadable one). No folder yet → none; any other error throws. */
  ids(): string[] {
    try {
      return readdirSync(this.directory).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  list(): Promise<RegisteredSession[]> { return this.listRows(false) }

  private async listRows(catalog: boolean): Promise<RegisteredSession[]> {
    try { secureStateDirectory(this.directory, false) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const rows: RegisteredSession[] = []
    const read = catalog ? this.storage.stoppedCatalog.bind(this.storage) : this.storage.stoppedList.bind(this.storage)
    await read(image => {
      try {
        const saved = this.decode(image.state === 'image' && image.proof.document.kind === 'stopped' ? image.proof.document.agentId : '', image, !catalog)
        if (saved) rows.push(saved)
      } catch (error) {
        // A bad archive cannot hide its peers. A missing worker is a failed listing, never an empty catalog.
        if (!(error instanceof SessionStorageUnavailable) || !['unsafe', 'invalid', 'missing', 'changed'].includes(error.code)) throw error
      }
    })
    return rows
  }

  private write<T>(agentId: string, current: () => boolean,
    apply: (previous: RegisteredSession | null) => { session: RegisteredSession; result: T } | null,
    sourceCurrent: () => boolean = () => true): Promise<T | null> {
    return this.writer.run(async deadline => this.storage.withWrite(deadline.expires, async () => {
      secureStateDirectory(dirname(this.directory))
      secureStateDirectory(this.directory)
      const document = { kind: 'stopped' as const, agentId }
      const source = await this.storage.retain(document)
      let prepared: Awaited<ReturnType<typeof prepareSessionPublication>> | undefined
      const verify = () => { deadline.check(); if (!current()) throw new RegistryPersistenceUnavailable('stopped owner changed') }
      const verifySource = () => { if (!sourceCurrent()) throw new RegistryPersistenceUnavailable('stopped source changed') }
      try {
        verify()
        verifySource()
        const change = apply(this.decode(agentId, source.image))
        if (!change) return null
        prepared = await prepareSessionPublication(this.storage, document, source, { version: 1, session: change.session }, deadline)
        verify()
        verifySource()
        prepared.publish(() => {})
        await prepared.sync()
        await prepared.settle()
        verify()
        prepared.finish()
        deadline.markAdmitted()
        return change.result
      } catch (error) {
        if (prepared?.published && !(error instanceof AtomicWriteUnconfirmed)) throw new AtomicWriteUnconfirmed(error, false)
        throw error
      } finally {
        try { await prepared?.discard() } finally { await source.release() }
      }
    }))
  }

  async save(session: RegisteredSession, current: () => boolean = () => true, sourceCurrent?: () => boolean): Promise<void> {
    if (!SAFE_ID.test(session.agentId)) throw new Error('Invalid stopped harness identity.')
    await this.write(session.agentId, current, previous => {
    // An exited engine leaves its pane as a shell. Stopping that shell must keep
    // the conversation saved before confirmEngineExit cleared its binding/profile.
    if (isTerminalEngine(session.engine) && previous) return null
    // A temporarily unbound observation of the SAME process cannot erase a known conversation.
    // A replacement process must earn its own binding; never carry history across PID reuse.
    if (!session.sessionId && previous?.sessionId && previous.engine === session.engine
      && session.registeredAt === previous.registeredAt
      && (session.codexHome ?? null) === (previous.codexHome ?? null)
      && (!session.hermesHome || session.hermesHome === previous.hermesHome)
      && sameProcessIdentity(session.processIdentity, previous.processIdentity)
      && session.processIdentity!.executable === previous.processIdentity!.executable) {
      session = withHermesHome({ ...session, sessionId: previous.sessionId, transcriptPath: previous.transcriptPath,
        boundAt: previous.boundAt, source: previous.source }, previous)
    }
    // With optional readers absent, Stop can capture a path the live row has not learned.
    // Hooks during its checkpoint and the final forget both save that pathless row. They
    // must not erase the captured path, or Close succeeds but Resume loses the conversation.
    if (session.sessionId && !session.transcriptPath && previous?.transcriptPath
      && session.sessionId === previous.sessionId && session.engine === previous.engine
      && session.registeredAt === previous.registeredAt
      && (session.codexHome ?? null) === (previous.codexHome ?? null)
      && (session.hermesHome ?? null) === (previous.hermesHome ?? null)
      && sameProcessIdentity(session.processIdentity, previous.processIdentity)
      && session.processIdentity!.executable === previous.processIdentity!.executable) {
      session = { ...session, transcriptPath: previous.transcriptPath }
    }
    secureStateDirectory(dirname(this.directory))
    secureStateDirectory(this.directory)
    const snapshot = {
      ...session,
      active: false,
      // A failed launch started nothing, and its reason is what the person reads of it once it is stopped; any other
      // launch is over, and a resume starts a new one. An unconfirmed resume is not a failure: its engine may have run.
      launch: session.launch?.state === 'failed' && session.launch.error !== 'RESUME_UNCONFIRMED' ? session.launch : { state: 'ready' },
      defaultName: projectDisplayName(session),
      touchedAt: Date.now(),
    }
    // A later Resume is an explicit new visit, never an instruction to close it again.
    delete snapshot.closePlan
    // A hold describes this daemon's current observation, never durable conversation evidence.
    delete snapshot.admissionHold
    delete snapshot.identityHold
    delete snapshot.interpretationHold
    delete snapshot.evidenceRevision
    // The agent that ended in a shell's pane belongs to that pane; a stopped shell opened again is a new pane.
    delete snapshot.previousAgentId
    // A snapshot without a tmux pane omits the legacy alias just like registry persistence.
    if (!snapshot.tmuxPane) delete (snapshot as Partial<RegisteredSession>).tmuxPane
    return { session: snapshot as RegisteredSession, result: undefined }
    }, sourceCurrent)
  }

  /** Correct one field of an archive in place — the folder a Claude row drifted out of (cwdRepair.ts).
   *  Not `save`: that recomputes the name and stamps `touchedAt`, and a patch must not reorder the
   *  catalog or rename anything. Nothing else on the row changes. */
  async patch(agentId: string, patch: Partial<Pick<RegisteredSession, 'cwd'>>, current: () => boolean = () => true,
    sourceCurrent?: () => boolean): Promise<boolean> {
    if (!SAFE_ID.test(agentId)) return false
    return await this.write(agentId, current, saved => saved ? { session: { ...saved, ...patch }, result: true } : null, sourceCurrent) ?? false
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
    // not a state file: an O_EXCL reservation, filled and flushed; the plan's follow-up moves it to the helper
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
      this.changeDirectory(() => {
        secureStateDirectory(this.directory, false)
        const marker = readPrivateStateFile(file, 1024)
        return token === undefined || JSON.parse(marker).token === token
      }, [() => unlinkSync(file)])
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }

  private syncDirectory(): void {
    syncStateDirectory(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  }

  private changeDirectory(current: () => boolean, changes: readonly (() => void)[], destination?: string): void {
    stateFileCustodyHealthy()
    const handles: { path: string; fd: number }[] = []
    let mutated = false
    try {
      // Confirm the new name before the removed one. Both handles must exist before any archive or marker mutation.
      if (directorySyncSupported()) for (const path of destination ? [destination, this.directory] : [this.directory]) {
        handles.push({ path, fd: openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) })
      }
      if (!current()) return
      for (const { path, fd } of handles) {
        secureStateDirectory(path, false)
        const held = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true })
        if (held.dev !== named.dev || held.ino !== named.ino) throw new RegistryPersistenceUnavailable('stopped directory changed')
      }
      for (const change of changes) { change(); mutated = true }
      if (handles.length) for (const { fd } of handles) fsyncSync(fd)
      else this.syncDirectory()
    } catch (error) {
      if (mutated) throw new AtomicWriteUnconfirmed(error, false)
      throw error
    } finally {
      let failed: unknown
      for (const { fd } of handles) {
        try { closeStateFileDescriptor(fd) } catch (error) { failed ??= error }
      }
      if (failed) throw failed
    }
  }

  /** Permanent deletion is separate from Stop, which always retains this record. */
  async remove(agentId: string, current: () => boolean = () => true): Promise<void> {
    if (!SAFE_ID.test(agentId)) throw new Error('Invalid stopped harness identity.')
    await this.writer.run(async deadline => this.storage.withWrite(deadline.expires, async () => {
      const saved = await this.get(agentId)
      if (!saved) return
      deadline.check()
      this.changeDirectory(() => {
        deadline.check()
        if (!current() || !this.current(saved)) throw new RegistryPersistenceUnavailable('stopped owner changed')
        return true
      }, [() => unlinkSync(join(this.directory, `${agentId}.json`))])
    }))
  }

  /**
   * Sets a record aside because another harness owns its conversation now (core/agents/conversationOwners.ts).
   * Moved into `superseded/`, never deleted, so a wrong owner can be put back by hand; a reservation it left
   * goes with it, since nothing can resume a record that is not listed. Null when there is no such record.
   */
  async supersede(agentId: string, current: () => boolean = () => true): Promise<RegisteredSession | null> {
    return this.writer.run(async deadline => this.storage.withWrite(deadline.expires, async () => {
    if (!SAFE_ID.test(agentId)) return null
    const saved = await this.get(agentId)
    if (!saved) return null
    const aside = join(this.directory, 'superseded')
    secureStateDirectory(aside)
    const marker = join(this.directory, `${agentId}.resume`)
    let reserved = false
    this.changeDirectory(() => {
      // A marker read failure must not be discovered after moving its archive out of the listed set.
      try { readPrivateStateFile(marker, 1024); reserved = true }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      deadline.check()
      if (!current() || !this.current(saved)) throw new RegistryPersistenceUnavailable('stopped owner changed')
      return true
    }, [
      () => renameSync(join(this.directory, `${agentId}.json`), join(aside, `${agentId}.json`)),
      () => {
        if (reserved) try { unlinkSync(marker) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      },
    ], aside)
    return saved
    }))
  }

  /** Suppress archives whose identity or conversation is already running. */
  async available(live: readonly RegisteredSession[]): Promise<RegisteredSession[]> {
    const ids = new Set(live.map(session => session.agentId))
    const conversations = new Set(live.map(conversationKey))
    return (await this.listRows(true)).filter(session => {
      const key = conversationKey(session)
      return !ids.has(session.agentId) && (key === null || !conversations.has(key))
    })
  }
}

export const stoppedAgents = new StoppedAgentStore()
