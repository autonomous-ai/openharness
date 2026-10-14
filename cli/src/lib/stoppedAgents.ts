/** Stopped work is durable history, separate from the registry of live terminal routes. */
import { closeSync, constants, fsyncSync, lstatSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { env } from '../config/env.js'
import { isTerminalEngine } from '../engines/types.js'
import { AtomicWriteUnconfirmed, atomicWriteJson, projectDisplayName, strictPersistedRow, withRegistryFileLock, type RegisteredSession } from './registry.js'
import { readPrivateStateFile, secureStateDirectory } from './secureState.js'
import { sameProcessIdentity } from './terminalRuntime.js'
import { inspectNativeControlFile } from './nativeControlFile.js'
import { nativeRearmRequest, nativeTurnTarget, nativeTurnTransition, parseNativeTurnIntent, type NativeTurnIntent } from './nativeTurnIntent.js'
import { parseNativeArchiveEnvelope, parseNativeArchiveTransfer, parseNativeArchiveReturn, parseNativeArchiveRetirement,
  parseNativeArchiveLink, type NativeArchiveLink, type NativeArchiveTransfer, type NativeArchiveReturn, type NativeArchiveRetirement } from './nativeArchive.js'
import { creationFingerprint, type NativeResumeCleanupProof } from './agentCreationReceipt.js'
import { NativeResumeMarkers } from './nativeResumeMarker.js'

const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/
const CATALOG_CACHE_RECORDS = 2048
const CATALOG_CACHE_BYTES = 4 * 1024 * 1024
const CATALOG_CACHE_MS = 30_000

/** Durable receipt/Registry evidence can read disk. The final current check
 * must only check the retained local owner, revocation and deadline. */
export interface SavedNativeControlFence { verify(): void; current(): void }

/** Used only by Registry's synchronous handoff while it owns the outer lock.
 * The archive itself reads and publishes authority; a caller cannot supply it. */
export interface NativeArchiveTransaction {
  readonly transfer: NativeArchiveTransfer | undefined
  verify(): void
  transferToLive(value: NativeArchiveTransfer, authority: {
    verifyBefore(): void; verifyAfter(): void; current(): void
  }): void
}

interface SavedArchiveRecord { session: RegisteredSession; transfer?: NativeArchiveTransfer; returnRole?: NativeArchiveReturn }
interface ArchivePublicationFence { verifyBefore(): void; verifyAfter(): void; current(): void }
export interface NativeArchiveReturnTransaction {
  readonly role: NativeArchiveReturn | undefined
  readonly session: RegisteredSession
  verify(): void
  confirm(current: () => void): void
  checkpoint(authority: ArchivePublicationFence): NativeArchiveReturn
  complete(retirement: NativeArchiveRetirement, authority: ArchivePublicationFence): RegisteredSession
}

function catalogFingerprint(stat: BigIntStats): string {
  // ctime catches in-place edits even if a writer restores mtime. Inode/device
  // distinguish atomic replacements; mode/owner/type changes must miss too.
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs,
    stat.mode, stat.uid, stat.gid, stat.nlink].join(':')
}

export class StoppedAgentStore {
  private readonly catalogCache = new Map<string, { fingerprint: string; bytes: number; at: number; session: RegisteredSession }>()
  private catalogCacheBytes = 0
  private readonly uncertain = new Map<string, { before: string; bytes: string; candidate: RegisteredSession;
    returnRole?: NativeArchiveReturn; verifyDirectory(): void }>()
  private readonly uncertainTransfers = new Map<string, { bytes: string; verifyPublished(): void; verifyDirectory(): void }>()
  private readonly nativeMarkers: NativeResumeMarkers

  constructor(private readonly directory = join(env.ADAPTER_DATA_DIR, 'stopped-agents')) {
    this.nativeMarkers = new NativeResumeMarkers(directory)
  }

  get(agentId: string): RegisteredSession | null {
    return this.readRecord(agentId)?.session ?? null
  }

  private readRecord(agentId: string): SavedArchiveRecord | null {
    if (!SAFE_ID.test(agentId)) return null
    try {
      secureStateDirectory(this.directory, false)
      const raw = JSON.parse(readPrivateStateFile(join(this.directory, `${agentId}.json`), 1024 * 1024))
      return this.decodeRecord(raw, agentId)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('Could not read the saved stopped harness.')
    }
  }

  private decodeRecord(raw: Record<string, unknown>, agentId: string): SavedArchiveRecord {
    const envelope = parseNativeArchiveEnvelope(raw)
    if (!envelope) throw Error('Unknown saved state')
    const transfer = envelope.version === 2 ? envelope.nativeTransfer : undefined
    const returnRole = envelope.version === 3 ? envelope.nativeReturn : undefined
    const session = strictPersistedRow(envelope.session)
    if (!session || session.agentId !== agentId || session.nativeArchive || session.nativeRetirement || session.nativeCreation) throw Error('Invalid saved state')
    if (transfer) {
      const reserved = session.nativeControl?.rearm, link = transfer.link
      if (!reserved || reserved.source !== 'saved' || reserved.revoked || reserved.replacement || session.nativeArchive
        || session.active || link.agentId !== session.agentId || link.target !== nativeTurnTarget(session)
        || reserved.target !== link.target || reserved.requestId !== link.requestId || reserved.launchToken !== link.launchToken) {
        throw Error('Invalid saved transfer')
      }
    }
    if (returnRole && (session.active || session.engine !== 'cursor' || !session.sessionId || !session.nativeControl
      || returnRole.link.agentId !== agentId || returnRole.phase === 'returning' && (
        returnRole.savedTarget !== nativeTurnTarget(session) || returnRole.checkpoint !== creationFingerprint(session)
        || returnRole.controlFingerprint !== creationFingerprint(session.nativeControl)
        || ![false, true].some(active => nativeTurnTarget({ ...session, active, nativeArchive: returnRole.link }) === returnRole.sourceTarget)))) {
      throw Error('Invalid native return checkpoint')
    }
    return { session, ...(transfer ? { transfer } : {}), ...(returnRole ? { returnRole } : {}) }
  }

  /** Routing metadata only. A transferred archive never grants saved control,
   * including after the Registry disappears or another daemon starts. */
  nativeTransfer(agentId: string): NativeArchiveTransfer | null {
    return this.readRecord(agentId)?.transfer ?? null
  }

  nativeReturn(agentId: string): NativeArchiveReturn | null {
    return this.readRecord(agentId)?.returnRole ?? null
  }

  /** Read-only recovery of the original Resume. This is never saved Cancel or
   * new-launch authority, including when the live destination is missing. */
  readNativeResumeSource(input: RegisteredSession) {
    const original = structuredClone(input), retained = this.inspectResumeSource(original)
    retained.confirm(() => {})
    return { transfer: retained.transfer, verify: retained.verify, verifyDirectory: retained.verifyDirectory }
  }

  private inspectResumeSource(input: RegisteredSession) {
    const reserved = input.nativeControl?.rearm
    if (!SAFE_ID.test(input.agentId) || input.engine !== 'cursor' || !input.sessionId || input.active || input.nativeArchive
      || !reserved || reserved.source !== 'saved' || reserved.operation !== 'resume' || reserved.revoked || reserved.replacement
      || reserved.agentId !== input.agentId || reserved.target !== nativeTurnTarget(input) || this.uncertain.has(input.agentId)) {
      throw Error('The original saved Resume reservation is unavailable.')
    }
    const retained = inspectNativeControlFile(join(this.directory, `${input.agentId}.json`), this.directory)
    const record = this.decodeRecord(JSON.parse(retained.content!), input.agentId)
    if (record.returnRole?.phase === 'returning' || nativeTurnTarget(record.session) !== nativeTurnTarget(input)
      || JSON.stringify(record.session.nativeControl) !== JSON.stringify(input.nativeControl)) {
      throw Error('The original saved Resume owner changed.')
    }
    const pending = this.uncertainTransfers.get(input.agentId)
    const verify = () => {
      retained.verify()
      if (pending) {
        if (retained.content !== pending.bytes) throw Error('The original native transfer image changed.')
        pending.verifyDirectory(); pending.verifyPublished()
      }
    }
    verify()
    return { ...retained, transfer: record.transfer, session: record.session, verify,
      confirm: (current: () => void) => retained.confirm(() => { verify(); current() }),
    }
  }

  /** Registry always owns its lock before entering here. The callback is
   * synchronous: no native process probe, launch or service wait can hold it. */
  withNativeResume<T>(input: RegisteredSession, apply: (archive: NativeArchiveTransaction) => T): T {
    const original = structuredClone(input)
    return this.write(() => {
      let retained = this.inspectResumeSource(original)
      const archive: NativeArchiveTransaction = {
        get transfer() { return retained.transfer },
        verify: () => retained.verify(),
        transferToLive: (value, authority) => {
          const transfer = parseNativeArchiveTransfer(value), reserved = original.nativeControl!.rearm!
          if (!transfer || transfer.link.agentId !== original.agentId || transfer.link.target !== nativeTurnTarget(original)
            || transfer.link.requestId !== reserved.requestId || transfer.link.launchToken !== reserved.launchToken) {
            throw Error('The native archive transfer does not belong to its original reservation.')
          }
          if (retained.transfer) {
            if (JSON.stringify(retained.transfer) !== JSON.stringify(transfer)) throw Error('The original native archive destination changed.')
            authority.verifyBefore()
            retained.confirm(() => { authority.verifyAfter(); authority.current() })
          } else {
            if (this.uncertainTransfers.size >= 256) throw Error('Waiting for native archive transfer confirmation capacity.')
            const before = retained, file = join(this.directory, `${original.agentId}.json`)
            const image = { version: 2, session: before.session, nativeTransfer: transfer }, bytes = JSON.stringify(image, null, 2)
            let publication: (() => void) | undefined
            try {
              atomicWriteJson(file, image, false, () => {
                authority.verifyBefore(); before.verify(); authority.current()
              }, (verifyPublished, contents) => {
                const written = inspectNativeControlFile(file, this.directory)
                if (written.content !== contents) throw Error('The published native transfer bytes changed.')
                written.confirm(() => { verifyPublished(); before.verifyDirectory(); authority.verifyAfter(); authority.current() })
                publication = () => { verifyPublished(); before.verifyDirectory(); written.verify() }
              })
            } catch (error) {
              if (error instanceof AtomicWriteUnconfirmed) this.uncertainTransfers.set(original.agentId,
                { bytes, verifyPublished: error.verifyPublished ?? (() => { throw Error('The original native transfer publisher is unavailable.') }),
                  verifyDirectory: before.verifyDirectory })
              throw error
            }
            // The callback confirmed the actual writer. A fresh inspection may
            // not adopt equal bytes from a replacement inode or parent afterward.
            this.uncertainTransfers.set(original.agentId, { bytes, verifyPublished: publication!, verifyDirectory: before.verifyDirectory })
            retained = this.inspectResumeSource(original)
          }
          retained.verify(); authority.current()
          this.uncertainTransfers.delete(original.agentId)
          this.forgetCatalogRecord(original.agentId)
        },
      }
      return apply(archive)
    })
  }

  private inspectReturnSource(original: RegisteredSession) {
    const retained = inspectNativeControlFile(join(this.directory, `${original.agentId}.json`), this.directory)
    const record = this.decodeRecord(JSON.parse(retained.content!), original.agentId)
    const owner = record.transfer?.link ?? record.returnRole?.link, pending = this.uncertainTransfers.get(original.agentId)
    const retirement = original.nativeRetirement
    if (retirement?.pendingAbort) {
      const { pendingAbort, ...role } = retirement, current = creationFingerprint(record.returnRole ?? null)
      if (record.transfer || record.returnRole?.phase === 'returning'
        || current !== pendingAbort.priorRole && current !== creationFingerprint({ ...role, phase: 'saved' })) {
        throw Error('The original untransferred native archive role changed.')
      }
    } else if (creationFingerprint(owner ?? null) !== creationFingerprint(original.nativeArchive)) throw Error('The original native archive visit changed.')
    const verify = () => {
      retained.verify()
      if (pending) {
        if (retained.content !== pending.bytes) throw Error('The original native return image changed.')
        pending.verifyDirectory(); pending.verifyPublished()
      }
    }
    verify()
    return { ...retained, ...record, verify, confirm: (current: () => void) => retained.confirm(() => { verify(); current() }) }
  }

  /** Called only under the outer Registry lock. The existing archive role
   * remains live-owned until an exact durable retirement confirms its return. */
  withNativeReturn<T>(input: RegisteredSession, apply: (archive: NativeArchiveReturnTransaction) => T): T {
    const original = structuredClone(input), link = original.nativeArchive
    if (!link || original.engine !== 'cursor' || !original.nativeControl || !SAFE_ID.test(original.agentId)
      || original.nativeRetirement && !parseNativeArchiveRetirement(original.nativeRetirement)) {
      throw Error('The original native archive visit is unavailable.')
    }
    return this.write(() => {
      if (this.uncertain.has(original.agentId)) throw Error('Waiting for the original saved native control publication.')
      const file = join(this.directory, `${original.agentId}.json`)
      let retained = this.inspectReturnSource(original)
      const publish = (session: RegisteredSession, role: NativeArchiveReturn, authority: ArchivePublicationFence) => {
        const before = retained, image = { version: 3, session, nativeReturn: role }, bytes = JSON.stringify(image, null, 2)
        if (before.content === bytes) {
          authority.verifyBefore(); before.confirm(() => { authority.verifyAfter(); authority.current() })
        } else {
          if (!this.uncertainTransfers.has(original.agentId) && this.uncertainTransfers.size >= 256) throw Error('Waiting for native archive return confirmation capacity.')
          let publication: (() => void) | undefined
          try {
            atomicWriteJson(file, image, false, () => { authority.verifyBefore(); before.verify(); authority.current() }, (verifyPublished, contents) => {
              const written = inspectNativeControlFile(file, this.directory)
              if (written.content !== contents) throw Error('The published native return bytes changed.')
              written.confirm(() => { verifyPublished(); before.verifyDirectory(); authority.verifyAfter(); authority.current() })
              publication = () => { verifyPublished(); before.verifyDirectory(); written.verify() }
            })
          } catch (error) {
            if (error instanceof AtomicWriteUnconfirmed) this.uncertainTransfers.set(original.agentId, { bytes,
              verifyPublished: error.verifyPublished ?? (() => { throw Error('The original native return publisher is unavailable.') }),
              verifyDirectory: before.verifyDirectory })
            throw error
          }
          this.uncertainTransfers.set(original.agentId, { bytes, verifyPublished: publication!, verifyDirectory: before.verifyDirectory })
          retained = this.inspectReturnSource(original)
        }
        retained.verify(); authority.current()
        this.uncertainTransfers.delete(original.agentId); this.forgetCatalogRecord(original.agentId)
      }
      return apply({
        get role() { return retained.returnRole }, get session() { return structuredClone(retained.session) }, verify: () => retained.verify(),
        confirm: current => retained.confirm(current),
        checkpoint: authority => {
          if (original.nativeRetirement || retained.returnRole?.phase === 'saved') throw Error('This native visit already retired its live authority.')
          const snapshot = { ...original, active: false, launch: { state: 'ready' as const } }
          delete snapshot.nativeArchive; delete snapshot.closePlan
          delete snapshot.identityHold; delete snapshot.interpretationHold; delete snapshot.admissionHold; delete snapshot.evidenceRevision
          const session = strictPersistedRow(snapshot)!
          const role = parseNativeArchiveReturn({ version: 1, phase: 'returning', link, sourceTarget: nativeTurnTarget(original),
            controlFingerprint: creationFingerprint(original.nativeControl), checkpoint: creationFingerprint(session), savedTarget: nativeTurnTarget(session) })!
          publish(session, role, authority)
          return role
        },
        complete: (retirement, authority) => {
          const role = retained.returnRole
          if (!original.nativeRetirement
            || creationFingerprint(original.nativeRetirement) !== creationFingerprint(retirement)
            || !retirement.pendingAbort && (!role || creationFingerprint({ ...role, phase: 'returning' }) !== creationFingerprint(retirement))) {
            throw Error('The native return has no matching durable retirement.')
          }
          const { pendingAbort: _abort, ...closing } = retirement
          publish(retained.session, { ...closing, phase: 'saved' }, authority)
          return structuredClone(retained.session)
        },
      })
    })
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

  list(): RegisteredSession[] {
    try {
      secureStateDirectory(this.directory, false)
      const ids = readdirSync(this.directory).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5))
      const present = new Set(ids)
      for (const id of this.catalogCache.keys()) if (!present.has(id)) this.forgetCatalogRecord(id)
      return ids.flatMap(id => {
        try {
          const saved = this.catalogRecord(id)
          return saved ? [saved] : []
        } catch {
          this.forgetCatalogRecord(id)
          // One unreadable record must not hide the other saved harnesses.
          return []
        }
      })
    } catch (error) {
      this.catalogCache.clear()
      this.catalogCacheBytes = 0
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  /** Status snapshots repeatedly enumerate the same saved metadata. Recheck
   * every file's identity on every read, but only reopen/parse changed files.
   * Actions still use get(), which always performs a fresh guarded read. */
  private catalogRecord(agentId: string): RegisteredSession | null {
    if (!SAFE_ID.test(agentId)) return null
    const file = join(this.directory, `${agentId}.json`)
    const before = lstatSync(file, { bigint: true })
    const fingerprint = catalogFingerprint(before)
    const cached = this.catalogCache.get(agentId)
    const now = Date.now()
    // Some mounted filesystems have coarse timestamps. Bound reuse even when
    // their metadata cannot distinguish two writes; no background timer is needed.
    if (cached?.fingerprint === fingerprint && now >= cached.at && now - cached.at < CATALOG_CACHE_MS) {
      return structuredClone(cached.session)
    }
    this.forgetCatalogRecord(agentId)
    const session = this.get(agentId)
    const bytes = Number(before.size)
    if (session && this.catalogCache.size < CATALOG_CACHE_RECORDS
      && this.catalogCacheBytes + bytes <= CATALOG_CACHE_BYTES
      && catalogFingerprint(lstatSync(file, { bigint: true })) === fingerprint) {
      this.catalogCache.set(agentId, { fingerprint, bytes, at: now, session: structuredClone(session) })
      this.catalogCacheBytes += bytes
    }
    return session
  }

  private forgetCatalogRecord(agentId: string): void {
    const cached = this.catalogCache.get(agentId)
    if (!cached) return
    this.catalogCacheBytes -= cached.bytes
    this.catalogCache.delete(agentId)
  }

  private write<T>(apply: () => T): T {
    secureStateDirectory(dirname(this.directory))
    return withRegistryFileLock(apply, this.directory)
  }

  private requireSavedOwner(agentId: string): void {
    if (this.uncertainTransfers.has(agentId)) throw Error('Waiting for the original native transfer publication.')
  }

  private savedImage(session: RegisteredSession, returnRole?: NativeArchiveReturn) {
    return returnRole ? { version: 3, session, nativeReturn: returnRole } : { version: 1, session }
  }

  /** Ordinary snapshots cannot erase or replace an archived control reservation.
   * Control changes require the original saved row's explicit strict transition. */
  save(session: RegisteredSession): void {
    this.write(() => this.saveUnlocked(session))
  }

  private saveUnlocked(session: RegisteredSession): void {
    if (session.nativeCreation) throw Error('The pending native creation must be accounted for before archiving.')
    this.requireSavedOwner(session.agentId)
    if (!SAFE_ID.test(session.agentId)) throw new Error('Invalid stopped harness identity.')
    if (this.uncertain.has(session.agentId)) throw Error('Waiting for the original saved native control publication.')
    // An exited engine leaves its pane as a shell. Stopping that shell must keep
    // the conversation saved before releaseEngine cleared its binding/profile.
    const record = this.readRecord(session.agentId), previous = record?.session
    if (record?.transfer || record?.returnRole?.phase === 'returning' || session.nativeArchive || session.nativeRetirement) {
      throw Error('Waiting for the exact native archive handoff before saving this visit.')
    }
    if (previous?.nativeControl && JSON.stringify(previous.nativeControl) !== JSON.stringify(session.nativeControl)) {
      throw Error('Waiting to preserve the original saved native cancellation.')
    }
    if (creationFingerprint(previous?.nativeAllocation ?? null) !== creationFingerprint(session.nativeAllocation ?? null)) {
      throw Error('Waiting for the proven native allocation handoff before saving this visit.')
    }
    if (isTerminalEngine(session.engine) && previous) return
    // A temporarily unbound observation of the SAME process cannot erase a known conversation.
    // A replacement process must earn its own binding; never carry history across PID reuse.
    if (!session.sessionId && previous?.sessionId && previous.engine === session.engine
      && session.registeredAt === previous.registeredAt
      && (session.codexHome ?? null) === (previous.codexHome ?? null)
      && (!session.hermesHome || session.hermesHome === previous.hermesHome)
      && sameProcessIdentity(session.processIdentity, previous.processIdentity)
      && session.processIdentity!.executable === previous.processIdentity!.executable) {
      session = { ...session, sessionId: previous.sessionId, transcriptPath: previous.transcriptPath,
        hermesHome: previous.hermesHome, boundAt: previous.boundAt, source: previous.source }
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
      launch: { state: 'ready' as const },
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
    // A snapshot without a tmux pane omits the legacy alias just like registry persistence.
    if (!snapshot.tmuxPane) delete (snapshot as Partial<RegisteredSession>).tmuxPane
    const retained = previous ? this.inspectControl(previous) : undefined
    atomicWriteJson(join(this.directory, `${session.agentId}.json`), this.savedImage(snapshot, record?.returnRole), false, () => {
      retained?.verify()
    })
    this.forgetCatalogRecord(session.agentId)
  }

  /** Correct one field of an archive in place — the folder a Claude row drifted out of (cwdRepair.ts).
   *  Not `save`: that recomputes the name and stamps `touchedAt`, and a repair must not reorder the
   *  catalog or rename anything. Nothing else on the row changes. */
  patch(agentId: string, patch: Partial<Pick<RegisteredSession, 'cwd'>>): boolean {
    return this.write(() => this.patchUnlocked(agentId, patch))
  }

  private patchUnlocked(agentId: string, patch: Partial<Pick<RegisteredSession, 'cwd'>>): boolean {
    this.requireSavedOwner(agentId)
    if (this.uncertain.has(agentId)) throw Error('Waiting for the original saved native control publication.')
    const saved = this.get(agentId)
    if (!saved) return false
    const retained = this.inspectControl(saved)
    secureStateDirectory(dirname(this.directory))
    secureStateDirectory(this.directory)
    atomicWriteJson(join(this.directory, `${agentId}.json`), this.savedImage({ ...saved, ...patch }, retained.returnRole), false, retained.verify)
    this.forgetCatalogRecord(agentId)
    return true
  }

  /** Preparation already owns the full creation intent, before any dispatch
   * claim or marker. A matching old marker is never another execution permit. */
  reserveNativeResume(input: RegisteredSession, authority: SavedNativeControlFence): { link: NativeArchiveLink; verify(): void } {
    const original = structuredClone(input), { verify: verifyAuthority, current } = authority
    return this.write(() => {
      const source = this.inspectResumeSource(original), rearm = original.nativeControl!.rearm!
      if (source.transfer) throw Error('The original native Resume already belongs to its live handoff.')
      const link = parseNativeArchiveLink({ version: 1, agentId: original.agentId, requestId: rearm.requestId,
        launchToken: rearm.launchToken, target: rearm.target })!
      const verifySource = () => { source.verify(); verifyAuthority(); source.verify(); current() }
      source.confirm(verifySource)
      const marker = this.nativeMarkers.reserve(link, { verify: verifySource, current })
      const verify = () => { marker.verify(); verifySource() }
      verify()
      return { link, verify }
    })
  }

  /** Only an exact created receipt plus its transferred visit, an accounted
   * closed visit, or an undispatched revoked request may clear its own marker.
   * The caller also retains the live association or confirmed Registry absence. */
  finishNativeResume(input: NativeArchiveLink, authority: SavedNativeControlFence, completion?: NativeResumeCleanupProof): void {
    const link = parseNativeArchiveLink(input), { verify: verifyAuthority, current } = authority
    if (!link) throw Error('The original native Resume identity is unavailable.')
    const receipt = completion && { kind: completion.kind, link: structuredClone(completion.link),
      request: structuredClone(completion.request), verify: completion.verify }
    if (receipt && creationFingerprint(receipt.link) !== creationFingerprint(link)) throw Error('The Resume receipt belongs to a different visit.')
    this.write(() => {
      if (this.uncertain.has(link.agentId)) throw Error('Waiting for the original saved native control publication.')
      const source = inspectNativeControlFile(join(this.directory, `${link.agentId}.json`), this.directory)
      const record = this.decodeRecord(JSON.parse(source.content!), link.agentId)
      const pending = this.uncertainTransfers.get(link.agentId)
      const closed = record.returnRole?.phase === 'saved' && creationFingerprint(record.returnRole.link) === creationFingerprint(link)
      const transferred = record.transfer && creationFingerprint(record.transfer.link) === creationFingerprint(link)
        && record.session.nativeControl && receipt
        && creationFingerprint(nativeRearmRequest(record.session.nativeControl)) === creationFingerprint(receipt.request)
      const reserved = record.session.nativeControl?.rearm
      const undispatched = receipt?.kind === 'not-dispatched' && !record.transfer && record.returnRole?.phase !== 'returning'
        && !record.session.active && !!reserved?.revoked && !reserved.replacement
        && reserved.source === 'saved' && reserved.operation === 'resume'
        && reserved.requestId === link.requestId && reserved.launchToken === link.launchToken && reserved.target === link.target
        && creationFingerprint(nativeRearmRequest(record.session.nativeControl!)) === creationFingerprint(receipt.request)
      if (!closed && !(transferred && receipt?.kind === 'created') && !undispatched) {
        throw Error('Waiting to account for the original native Resume before clearing its marker.')
      }
      const verify = () => {
        receipt?.verify(); verifyAuthority(); source.verify()
        if (pending) {
          if (source.content !== pending.bytes) throw Error('The original native archive completion changed.')
          pending.verifyDirectory(); pending.verifyPublished()
        }
        current()
      }
      source.confirm(verify)
      this.nativeMarkers.finish(link, { verify, current })
      verify()
    })
  }

  /** Reserve before tmux allocation. A crash between allocation and registry persistence
   * must not permit a second process under a new request/receipt ID. */
  beginResume(agentId: string): string | null {
    return this.write(() => this.beginResumeUnlocked(agentId))
  }

  private beginResumeUnlocked(agentId: string): string | null {
    this.requireSavedOwner(agentId)
    if (!SAFE_ID.test(agentId)) throw new Error('Invalid saved harness identity.')
    const record = this.readRecord(agentId)
    if (record?.transfer || record?.returnRole?.phase === 'returning') throw Error('The original native resume belongs to its live handoff.')
    if (record?.session.nativeAllocation) throw Error('The retained native allocation requires its original Resume reservation.')
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
   * only be answered by parsing the marker. A known legacy saved harness may clear a
   * half-written reservation without a token. Native markers require the original
   * receipt and visit, even after the saved row has transferred to the live owner.
   */
  finishResume(agentId: string, token?: string, authority?: SavedNativeControlFence): void {
    this.write(() => this.finishResumeUnlocked(agentId, token, authority))
  }

  private finishResumeUnlocked(agentId: string, token?: string, authority?: SavedNativeControlFence): void {
    this.requireSavedOwner(agentId)
    if (!SAFE_ID.test(agentId)) return
    const file = join(this.directory, `${agentId}.resume`)
    let marker: ReturnType<typeof inspectNativeControlFile>
    try {
      secureStateDirectory(this.directory, false)
      marker = inspectNativeControlFile(file, this.directory)
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    const saved = this.get(agentId)
    let value: unknown
    try { value = JSON.parse(marker.content!) }
    catch (error) { if (!saved || saved.nativeControl || saved.nativeAllocation || token !== undefined) throw error }
    if (value && typeof value === 'object' && Object.hasOwn(value, 'nativeArchive')) {
      throw Error('The native Resume marker requires its original receipt and archive link.')
    }
    if (token !== undefined && (value as { token?: unknown } | null)?.token !== token) return
    if (this.uncertain.has(agentId) || (saved?.nativeControl || saved?.nativeAllocation) && !authority) {
      throw Error('Waiting to confirm the exact native resume handoff before clearing its reservation.')
    }
    const retained = saved ? this.inspectControl(saved) : undefined
    authority?.verify()
    retained?.verify(); marker.verify()
    authority?.current()
    unlinkSync(file)
    this.syncDirectory()
  }

  private syncDirectory(): void {
    const fd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }

  /** Permanent deletion is separate from Stop, which always retains this record. */
  remove(agentId: string): void {
    this.write(() => this.removeUnlocked(agentId))
  }

  private removeUnlocked(agentId: string): void {
    this.requireSavedOwner(agentId)
    if (!SAFE_ID.test(agentId)) throw new Error('Invalid stopped harness identity.')
    const record = this.readRecord(agentId)
    if (!record) return
    if (record.transfer || record.returnRole || record.session.nativeArchive || record.session.nativeAllocation) throw Error('Waiting for the exact native archive handoff before removing this visit.')
    unlinkSync(join(this.directory, `${agentId}.json`))
    this.forgetCatalogRecord(agentId)
    this.syncDirectory()
  }

  /**
   * Sets a record aside because another harness owns its conversation now (core/agents/conversationOwners.ts).
   * Moved into `superseded/`, never deleted, so a wrong owner can be put back by hand; a reservation it left
   * goes with it, since nothing can resume a record that is not listed. Null when there is no such record.
   */
  supersede(agentId: string): RegisteredSession | null {
    return this.write(() => this.supersedeUnlocked(agentId))
  }

  private supersedeUnlocked(agentId: string): RegisteredSession | null {
    this.requireSavedOwner(agentId)
    if (!SAFE_ID.test(agentId)) return null
    const saved = this.get(agentId)
    if (!saved) return null
    if (saved.nativeControl || saved.nativeAllocation || this.uncertain.has(agentId)) throw Error('A native cancellation cannot be superseded automatically.')
    const aside = join(this.directory, 'superseded')
    secureStateDirectory(aside)
    renameSync(join(this.directory, `${agentId}.json`), join(aside, `${agentId}.json`))
    this.forgetCatalogRecord(agentId)
    this.finishResumeUnlocked(agentId)
    this.syncDirectory()
    return saved
  }

  /** Fresh saved-row authority. Catalog caches and age-based .resume takeover
   * never grant native rearm permission. Every recovered image is synced. */
  readNativeControl(input: RegisteredSession): { intent: NativeTurnIntent | undefined; verify(): void } {
    if (this.uncertain.has(input.agentId)) throw Error('Waiting for the original saved native control publication.')
    const proof = this.inspectControl(input)
    proof.confirm(() => {})
    return proof
  }

  private inspectControl(input: RegisteredSession) {
    this.requireSavedOwner(input.agentId)
    if (!SAFE_ID.test(input.agentId)) throw Error('Invalid stopped harness identity.')
    const original = structuredClone(input), file = join(this.directory, `${original.agentId}.json`)
    const retained = inspectNativeControlFile(file, this.directory)
    const record = this.decodeRecord(JSON.parse(retained.content!), original.agentId), saved = record.session
    if (record.transfer || record.returnRole?.phase === 'returning') throw Error('The original native resume belongs to its live handoff.')
    if (!saved || nativeTurnTarget(saved) !== nativeTurnTarget(original)
      || JSON.stringify(saved.nativeControl) !== JSON.stringify(original.nativeControl)) {
      throw Error('The original saved native control owner changed.')
    }
    retained.verify()
    return { ...retained, intent: saved.nativeControl, saved, returnRole: record.returnRole }
  }

  commitNativeControl(input: RegisteredSession, value: NativeTurnIntent, authority: SavedNativeControlFence): RegisteredSession {
    const original = structuredClone(input), next = parseNativeTurnIntent(value)
    if (!next || !nativeTurnTransition(original, next)) throw Error('Invalid saved native control transition.')
    if (next.rearm?.replacement && creationFingerprint(next.rearm.replacement)
      !== creationFingerprint(original.nativeControl?.rearm?.replacement ?? null)) {
      throw Error('Native replacement requires proven allocation admission.')
    }
    return this.write(() => {
      this.requireSavedOwner(original.agentId)
      const file = join(this.directory, `${original.agentId}.json`)
      if (!SAFE_ID.test(original.agentId)) throw Error('Invalid stopped harness identity.')
      let pending = this.uncertain.get(original.agentId)
      const retained = inspectNativeControlFile(file, this.directory)
      if (pending) {
        pending.verifyDirectory()
        if (nativeTurnTarget(pending.candidate) !== nativeTurnTarget(original)
          || JSON.stringify(pending.candidate.nativeControl) !== JSON.stringify(next)
          || retained.content !== pending.before && retained.content !== pending.bytes) {
          throw Error('Waiting for the exact original saved native control publication.')
        }
      } else {
        // A retry in a new core may see its prior publication. The exact request
        // still has to confirm that image before obtaining launch authority.
        const record = this.decodeRecord(JSON.parse(retained.content!), original.agentId), saved = record.session
        if (record.transfer || record.returnRole?.phase === 'returning') throw Error('The original native resume belongs to its live handoff.')
        if (!saved || nativeTurnTarget(saved) !== nativeTurnTarget(original)
          || JSON.stringify(saved.nativeControl) !== JSON.stringify(original.nativeControl)
            && JSON.stringify(saved.nativeControl) !== JSON.stringify(next)) throw Error('The original saved native control owner changed.')
        if (this.uncertain.size >= 256) throw Error('Waiting for saved native control confirmation capacity.')
        const candidate = { ...saved, schemaVersion: saved.nativeAllocation ? 4 as const : 3 as const, nativeControl: next }
        pending = { before: retained.content!, candidate, returnRole: record.returnRole,
          bytes: JSON.stringify(this.savedImage(candidate, record.returnRole), null, 2),
          verifyDirectory: retained.verifyDirectory }
        this.uncertain.set(original.agentId, pending)
      }
      const beforeCommit = () => { authority.verify(); pending.verifyDirectory(); retained.verify(); authority.current() }
      beforeCommit()
      if (retained.content !== pending.bytes) atomicWriteJson(file, this.savedImage(pending.candidate, pending.returnRole), false, beforeCommit)
      pending.verifyDirectory()
      const committed = this.inspectControl(pending.candidate)
      committed.confirm(() => { authority.verify(); pending.verifyDirectory(); authority.current() })
      committed.verify(); pending.verifyDirectory(); authority.current()
      this.uncertain.delete(original.agentId); this.forgetCatalogRecord(original.agentId)
      return structuredClone(committed.saved)
    })
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
