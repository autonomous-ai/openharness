/** The required storage child owns legacy image bytes. This module never loads session control. */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, readSync, type Dir } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseGridLaunchOverride, type GridLaunchOverride } from '../lib/gridLaunchWire.js'
import { privateRegistryDirectory } from '../lib/registryPersistence.js'
import { sessionStorageFailureCode, SessionStorageUnavailable, sessionDocument, sessionImageProof, storedGridLaunch, sessionFileIdentity,
  type CredentialRow, type SessionCredentialReference, type SessionDocument, type SessionImage,
  type SessionImageProof, type SessionImageReservation, type SessionPreparedImage, type StoredGridLaunch } from '../lib/sessionStorageWire.js'
import { readPrivateImage } from './privateImage.js'
import { stoppedArchiveWitness, STOPPED_AUTHORITY_ENTRIES } from '../lib/stoppedAuthorityMetadata.js'
import { externalReservations, parseExternalResume } from '../lib/externalResume.js'
import type { StoppedArchiveAnswer, StoppedArchiveQuery } from '../lib/sessionStorageWire.js'
import { conversationKeyAtHome } from '../lib/conversationIdentity.js'
import type { RegisteredSession } from '../lib/registry.js'

const ONE_MIB = 1024 * 1024
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

export const sessionImageIdentity = sessionFileIdentity

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (!object(entry)) return entry
    const result: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(entry).sort()) result[key] = entry[key]
    return result
  })
}

function rowIdentity(row: Record<string, unknown>): CredentialRow {
  return { agentId: typeof row.agentId === 'string' ? row.agentId : typeof row.launcherId === 'string' ? row.launcherId : '',
    registeredAt: typeof row.registeredAt === 'number' && Number.isFinite(row.registeredAt) ? row.registeredAt : null }
}

function binding(row: CredentialRow, override: GridLaunchOverride): string {
  return digest(canonical({ row, override }))
}

function project(override: GridLaunchOverride, row: CredentialRow, source: SessionCredentialReference['source']): StoredGridLaunch {
  const { apiKey: _key, ...metadata } = override
  return { ...metadata, credential: { version: 1, row, binding: binding(row, override), source } }
}

function rows(document: SessionDocument, value: unknown): unknown[] {
  if (document.kind === 'registry' || document.kind === 'legacy-registry') return Array.isArray(value) ? value : []
  if (document.kind === 'names') return []
  return object(value) ? [value.session] : []
}

function projectValue(document: SessionDocument, value: unknown, proof: SessionImageProof): unknown {
  const row = (value: unknown): unknown => {
    // Malformed rows are rejected by core; they cannot smuggle raw credential fields through an error path.
    if (!object(value)) return null
    if (!Object.hasOwn(value, 'gridLaunch')) return value
    const parsed = parseGridLaunchOverride(value.gridLaunch)
    return { ...value, gridLaunch: parsed.state === 'ok'
      ? project(parsed.override, rowIdentity(value), { kind: 'image', proof }) : null }
  }
  if (document.kind === 'registry' || document.kind === 'legacy-registry') return Array.isArray(value) ? value.map(row) : null
  if (document.kind === 'names') return value
  return object(value) ? { version: value.version, session: row(value.session) } : null
}

export interface RetainedSessionImage { fd: number; proof: SessionImageProof; lease: string }

export function createSessionImageCodec(root: string, retained: readonly RetainedSessionImage[] = [], stoppedLeaf = 'stopped-agents') {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(stoppedLeaf)) throw new SessionStorageUnavailable('invalid')
  const inherited = new Map(retained.map(source => [source.lease, source]))
  const imports = new Map<string, { row: CredentialRow; override: GridLaunchOverride }>()
  const images = new Map<string, { contents: string; proof: SessionImageProof }>()
  const prepared = new Map<string, string>()
  // An ambiguous close stays owned until this child exits; never retry a possibly reused descriptor.
  const uncertainHandles = new Set<fs.FileHandle | Dir>()
  const file = (document: SessionDocument): string => {
    if (!sessionDocument(document)) throw new SessionStorageUnavailable('invalid')
    return document.kind === 'registry' ? join(root, 'registry.json')
      : document.kind === 'legacy-registry' ? join(root, 'registry.pre-v2.json')
      : document.kind === 'names' ? join(root, 'agent-names.json')
        : join(root, stoppedLeaf, ...(document.kind === 'superseded' ? ['superseded'] : []), `${document.agentId}.json`)
  }

  async function privateImage(document: SessionDocument): Promise<{ contents: string; proof: SessionImageProof } | null> {
    const path = file(document)
    try {
      const read = await readPrivateImage(path, document.kind === 'registry' || document.kind === 'legacy-registry' ? Number.MAX_SAFE_INTEGER : ONE_MIB)
      if (!read) return null
      return { contents: read.bytes.toString('utf8'), proof: { document, identity: sessionImageIdentity(read.stat), bytes: read.bytes.length, sha256: digest(read.bytes) } }
    } catch (error) {
      if (absent(error)) return null
      throw new SessionStorageUnavailable(sessionStorageFailureCode(error))
    }
  }

  function inheritedImage(proof: SessionImageProof): string | null {
    const source = [...inherited.values()].find(image => image.proof.sha256 === proof.sha256
      && image.proof.identity === proof.identity && canonical(image.proof.document) === canonical(proof.document))
    if (!source) return null
    // Inherited descriptors share an open-file offset. Recovery must never depend on where a lost child stopped.
    const before = fstatSync(source.fd, { bigint: true })
    if (!before.isFile() || before.size !== BigInt(proof.bytes)) throw new SessionStorageUnavailable('changed')
    const bytes = Buffer.alloc(proof.bytes)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(source.fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new SessionStorageUnavailable('changed')
      offset += count
    }
    const contents = bytes.toString('utf8')
    if (sessionImageIdentity(fstatSync(source.fd, { bigint: true })) !== sessionImageIdentity(before)
      || digest(bytes) !== proof.sha256) throw new SessionStorageUnavailable('changed')
    return contents
  }

  async function sourceContents(proof: SessionImageProof): Promise<string> {
    if (!sessionImageProof(proof)) throw new SessionStorageUnavailable('invalid')
    const held = [...images.values()].find(image => image.proof.sha256 === proof.sha256 && image.proof.identity === proof.identity)
    if (held) return held.contents
    // A retained original may no longer have a pathname after publication. It remains exact-byte checked.
    const inherited = inheritedImage(proof)
    if (inherited !== null) return inherited
    const image = await privateImage(proof.document)
    if (!image || image.proof.identity !== proof.identity || image.proof.sha256 !== proof.sha256) {
      throw new SessionStorageUnavailable('changed')
    }
    return image.contents
  }

  async function resolve(reference: StoredGridLaunch, current?: { contents: string; proof: SessionImageProof } | null,
    cache?: Map<string, Map<string, GridLaunchOverride | null>>): Promise<GridLaunchOverride> {
    if (!storedGridLaunch(reference)) throw new SessionStorageUnavailable('invalid')
    const ref = reference.credential
    let override: GridLaunchOverride | undefined
    const indexImage = (contents: string, proof: SessionImageProof): Map<string, GridLaunchOverride | null> => {
      const cacheKey = `${proof.identity}:${proof.sha256}`
      const existing = cache?.get(cacheKey)
      if (existing) return existing
      let value: unknown
      try { value = JSON.parse(contents) } catch { throw new SessionStorageUnavailable('invalid') }
      const index = new Map<string, GridLaunchOverride | null>()
      for (const row of rows(proof.document, value)) if (object(row)) {
        const id = canonical(rowIdentity(row)), parsed = parseGridLaunchOverride(row.gridLaunch)
        index.set(id, index.has(id) || parsed.state !== 'ok' ? null : parsed.override)
      }
      if (cache) {
        if (cache.size >= 2) cache.delete(cache.keys().next().value!)
        cache.set(cacheKey, index)
      }
      return index
    }
    if (current) {
      const latest = indexImage(current.contents, current.proof).get(canonical(ref.row))
      // Preparation has already checked the locked source image. Equal row-bound overrides may be
      // reconstructed there after unrelated metadata writes; selected models launches never use this path.
      if (latest && binding(ref.row, latest) === ref.binding) override = latest
    }
    if (!override && ref.source.kind === 'import') {
      const held = imports.get(ref.source.lease)
      if (held && canonical(held.row) === canonical(ref.row)) override = held.override
    } else if (!override && ref.source.kind === 'image') {
      const proof = ref.source.proof, cacheKey = `${proof.identity}:${proof.sha256}`
      let index = cache?.get(cacheKey)
      if (!index) {
        let contents: string
        try { contents = current?.proof.sha256 === proof.sha256 && current.proof.identity === proof.identity
          ? current.contents : await sourceContents(proof) }
        catch (error) { if (error instanceof SessionStorageUnavailable) throw error; throw new SessionStorageUnavailable('invalid') }
        index = indexImage(contents, proof)
      }
      override = index.get(canonical(ref.row)) ?? undefined
    }
    if (!override || binding(ref.row, override) !== ref.binding) throw new SessionStorageUnavailable('changed')
    const { apiKey: _key, ...metadata } = override
    const { credential: _reference, ...requested } = reference
    if (canonical(metadata) !== canonical(requested)) throw new SessionStorageUnavailable('changed')
    return override
  }

  async function read(document: SessionDocument, retain?: string): Promise<SessionImage> {
    if (retain && (images.size >= 2 || !/^[a-f0-9-]{36}$/.test(retain))) throw new SessionStorageUnavailable('busy')
    const image = await privateImage(document)
    if (!image) return { state: 'missing' }
    if (retain) images.set(retain, image)
    let value: unknown
    try { value = JSON.parse(image.contents) }
    catch { return { state: 'image', proof: image.proof, json: false } }
    return { state: 'image', proof: image.proof, json: true, value: projectValue(document, value, image.proof) }
  }

  async function equal(proof: SessionImageProof): Promise<SessionImageProof | null> {
    const current = await privateImage(proof.document)
    return current?.proof.sha256 === proof.sha256 ? current.proof : null
  }

  async function prepare(document: SessionDocument, source: SessionImageProof | null, value: unknown,
    reservation: SessionImageReservation, rawSource?: SessionImageProof): Promise<SessionPreparedImage> {
    if (prepared.size || uncertainHandles.size) throw new SessionStorageUnavailable('busy')
    const current = await privateImage(document)
    if (source ? !current || source.identity !== current.proof.identity || source.sha256 !== current.proof.sha256
      : current !== null) throw new SessionStorageUnavailable('changed')
    const resolved = new Map<string, Map<string, GridLaunchOverride | null>>()
    const restore = async (row: unknown): Promise<unknown> => {
      if (!object(row)) return row
      if (row.gridLaunch === null || row.gridLaunch === undefined) return row
      return { ...row, gridLaunch: await resolve(row.gridLaunch as StoredGridLaunch, current, resolved) }
    }
    let raw: unknown
    if (rawSource) {
      if (document.kind !== 'legacy-registry' || rawSource.document.kind !== 'registry') throw new SessionStorageUnavailable('invalid')
      raw = JSON.parse(await sourceContents(rawSource))
    } else if (document.kind === 'registry' || document.kind === 'legacy-registry') {
      if (!Array.isArray(value)) throw new SessionStorageUnavailable('invalid')
      const restored: unknown[] = []
      // Resolve sequentially: a large image must not fan out into one filesystem read per row at once.
      for (const row of value) restored.push(await restore(row))
      raw = restored
    } else if (document.kind === 'names') raw = value
    else {
      if (!object(value)) throw new SessionStorageUnavailable('invalid')
      raw = { ...value, session: await restore(value.session) }
    }
    const path = file(document), contents = JSON.stringify(raw, null, 2)
    if (document.kind !== 'registry' && document.kind !== 'legacy-registry' && Buffer.byteLength(contents) > ONE_MIB) throw new SessionStorageUnavailable('invalid')
    await privateRegistryDirectory(dirname(path))
    const temporary = join(root, reservation.temporary), relative = reservation.temporary
    const prefix = `${path}.`
    if (!temporary.startsWith(prefix) || !/^[0-9]+\.[a-f0-9-]{36}\.tmp$/.test(temporary.slice(prefix.length))) {
      throw new SessionStorageUnavailable('invalid')
    }
    let handle: fs.FileHandle | undefined
    try {
      handle = await fs.open(temporary, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0))
      if (sessionImageIdentity(await handle.stat({ bigint: true })) !== reservation.identity) throw new SessionStorageUnavailable('changed')
      await handle.writeFile(contents)
      await handle.chmod(0o600)
      await handle.sync()
      const stat = await handle.stat({ bigint: true })
      const closing = handle
      handle = undefined
      try { await closing.close() }
      catch { uncertainHandles.add(closing); throw new SessionStorageUnavailable('cleanup-unconfirmed') }
      const proof = { document, identity: sessionImageIdentity(stat), bytes: Buffer.byteLength(contents), sha256: digest(contents) }
      prepared.set(relative, proof.identity)
      if (document.kind === 'registry') {
        const credentials: SessionCredentialReference[] = []
        for (const row of raw as unknown[]) if (object(row) && row.gridLaunch != null) {
          credentials.push(project(row.gridLaunch as GridLaunchOverride, rowIdentity(row), { kind: 'image', proof }).credential)
        }
        return { temporary: relative, proof, projection: 'registry-credentials', credentials }
      }
      return { temporary: relative, proof, projection: 'value', value: projectValue(document, raw, proof) }
    } catch (error) {
      if (handle) {
        const closing = handle
        handle = undefined
        try { await closing.close() }
        catch { uncertainHandles.add(closing); throw new SessionStorageUnavailable('cleanup-unconfirmed') }
      }
      throw new SessionStorageUnavailable(sessionStorageFailureCode(error))
    }
  }

  async function discard(temporary: string, identity: string): Promise<void> {
    if (prepared.get(temporary) !== identity) throw new SessionStorageUnavailable('invalid')
    const path = join(root, temporary)
    try {
      const current = await fs.lstat(path, { bigint: true })
      // Parent owns publication and cleanup. A still-present temporary is not settled.
      if (current) throw new SessionStorageUnavailable('cleanup-unconfirmed')
    } catch (error) {
      if (!absent(error)) throw new SessionStorageUnavailable('cleanup-unconfirmed')
    }
    prepared.delete(temporary)
  }

  async function queryStopped(query: StoppedArchiveQuery, expires: number): Promise<StoppedArchiveAnswer> {
    if (!query || !['conversations', 'folder', 'owners'].includes(query.kind)
      || query.exceptAgentId !== undefined && typeof query.exceptAgentId !== 'string'
      || query.kind === 'conversations' && (!Array.isArray(query.ids) || query.ids.length > 258
        || !query.ids.every(id => typeof id === 'string' && id.length > 0) || typeof query.reservations !== 'boolean'
        || query.scope !== undefined && (!object(query.scope) || typeof query.scope.engine !== 'string' || !(query.scope.codexHome === null || typeof query.scope.codexHome === 'string'))
        || query.exceptAgentIds !== undefined && (!Array.isArray(query.exceptAgentIds) || query.exceptAgentIds.length !== query.ids.length || !query.exceptAgentIds.every(id => typeof id === 'string')))
      || query.kind === 'folder' && (typeof query.root !== 'string' || !isAbsolute(query.root))
      || query.kind === 'owners' && (!Array.isArray(query.keys) || query.keys.length > 258
        || !query.keys.every(key => typeof key === 'string' && key.length > 0)
        || typeof query.defaultCodexHome !== 'string' || !isAbsolute(query.defaultCodexHome))) throw new SessionStorageUnavailable('invalid')
    const directory = join(root, stoppedLeaf), before = stoppedArchiveWitness(directory)
    const matches = query.kind === 'conversations' ? query.ids.map(() => false) : query.kind === 'owners' ? query.keys.map(() => false) : [false]
    const selected: SessionImage[] = []
    if (before === 'missing') return { witness: before, matches, ...(query.kind === 'owners' ? { selected } : {}) }
    const directoryHandle = await fs.opendir(directory, { bufferSize: 32 })
    let count = 0
    try { for (;;) {
      const entry = await directoryHandle.read()
      if (!entry) break
      if (++count > STOPPED_AUTHORITY_ENTRIES || performance.now() >= expires) throw new SessionStorageUnavailable('expired')
      if (!entry.name.endsWith('.json')) continue
      const agentId = entry.name.slice(0, -5)
      if (agentId === query.exceptAgentId) continue
      const image = await privateImage({ kind: 'stopped', agentId })
      if (!image) throw new SessionStorageUnavailable('changed')
      let value: unknown
      try { value = JSON.parse(image.contents) } catch { throw new SessionStorageUnavailable('invalid') }
      if (!object(value) || value.version !== 1 || !object(value.session) || value.session.agentId !== agentId
        || value.session.schemaVersion !== 2 || typeof value.session.sessionId !== 'string') throw new SessionStorageUnavailable('invalid')
      const row = value.session
      if (query.kind === 'owners') {
        if (typeof row.engine !== 'string' || row.codexHome != null && typeof row.codexHome !== 'string'
          || row.hermesHome != null && typeof row.hermesHome !== 'string') throw new SessionStorageUnavailable('invalid')
        const key = conversationKeyAtHome(row as unknown as RegisteredSession, query.defaultCodexHome)
        const index = key === null ? -1 : query.keys.indexOf(key)
        if (index !== -1) {
          matches[index] = true
          selected.push({ state: 'image', json: true, proof: image.proof, value: projectValue(image.proof.document, value, image.proof) })
        }
      } else if (query.kind === 'conversations') {
        if (query.scope && (row.engine !== query.scope.engine || (row.codexHome ?? null) !== query.scope.codexHome)) continue
        const external = row.externalResume === undefined ? undefined : parseExternalResume(row.externalResume)
        if (external === null) throw new SessionStorageUnavailable('invalid')
        const ids = query.reservations ? externalReservations({ sessionId: row.sessionId as string, ...(external ? { externalResume: external } : {}) }) : [row.sessionId]
        for (let index = 0; index < query.ids.length; index++) if (agentId !== query.exceptAgentIds?.[index] && ids.includes(query.ids[index])) matches[index] = true
      } else if (row.cwd) {
        if (typeof row.cwd !== 'string') throw new SessionStorageUnavailable('invalid')
        const cwd = await fs.realpath(row.cwd).catch(() => resolvePath(row.cwd as string))
        if (cwd === query.root || cwd.startsWith(query.root + sep) || query.root.startsWith(cwd + sep)) matches[0] = true
      }
    }
    } finally {
      try { await directoryHandle.close() }
      catch { uncertainHandles.add(directoryHandle); throw new SessionStorageUnavailable('cleanup-unconfirmed') }
    }
    if (stoppedArchiveWitness(directory) !== before) throw new SessionStorageUnavailable('changed')
    return { witness: before, matches, ...(query.kind === 'owners' ? { selected } : {}) }
  }

  return { read, equal, prepare, discard, resolve, queryStopped,
    import(lease: string, row: CredentialRow, override: GridLaunchOverride): StoredGridLaunch {
      if (!/^[a-f0-9-]{36}$/.test(lease) || imports.has(lease) || imports.size >= 64) throw new SessionStorageUnavailable('busy')
      const parsed = parseGridLaunchOverride(override)
      if (parsed.state !== 'ok') throw new SessionStorageUnavailable('invalid')
      if (!row || typeof row.agentId !== 'string' || !row.agentId || !(row.registeredAt === null || Number.isFinite(row.registeredAt))) throw new SessionStorageUnavailable('invalid')
      const identity = { agentId: row.agentId, registeredAt: row.registeredAt }
      imports.set(lease, { row: identity, override: parsed.override })
      return project(parsed.override, identity, { kind: 'import', lease })
    },
    release(lease: string): void {
      const source = inherited.get(lease)
      if (source) {
        try { closeSync(source.fd) }
        catch { throw new SessionStorageUnavailable('cleanup-unconfirmed') }
        inherited.delete(lease)
      }
      imports.delete(lease)
      images.delete(lease)
    },
  }
}
