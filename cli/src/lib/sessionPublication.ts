/** Core owns the final non-yielding rename/admission fence; storage owns raw encoding and file writes. */
import { closeSync, constants, fstat, fstatSync, fsync, lstatSync, open, renameSync, type Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import { AtomicWriteUnconfirmed, RegistryPersistenceUnavailable, type RegistryWriteDeadline } from './registryPersistence.js'
import { directorySyncSupported } from './secureState.js'
import type { SessionImageSource, SessionStorage } from './sessionStorage.js'
import { sessionCredentialReference, sessionFileIdentity, sessionImageProof, storedGridLaunch,
  type SessionCredentialReference, type SessionDocument, type SessionImageProof, type SessionPreparedImage } from './sessionStorageWire.js'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const fields = (value: object, names: string[]) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))

/** Registry metadata belongs to the caller's captured graph; the child may replace only exact credentials. */
function publicationValue(document: SessionDocument, value: unknown, prepared: SessionPreparedImage): unknown {
  const invalid = (): never => { throw new RegistryPersistenceUnavailable('prepared session references changed') }
  if (!sessionImageProof(prepared.proof) || !fields(prepared.proof, ['document', 'identity', 'bytes', 'sha256'])
    || JSON.stringify(prepared.proof.document) !== JSON.stringify(document)) return invalid()
  if (document.kind !== 'registry') {
    if (prepared.projection !== 'value' || !fields(prepared, ['temporary', 'proof', 'projection', 'value'])) return invalid()
    return prepared.value
  }
  if (prepared.projection !== 'registry-credentials' || !fields(prepared, ['temporary', 'proof', 'projection', 'credentials'])
    || !Array.isArray(prepared.credentials) || !Array.isArray(value)) return invalid()
  const identity = (row: { agentId: string; registeredAt: number | null }) => JSON.stringify([row.agentId, row.registeredAt])
  const expected = new Map<string, ReturnType<typeof credential>>()
  function credential(row: Record<string, unknown>) {
    if (typeof row.agentId !== 'string' || !row.agentId || typeof row.registeredAt !== 'number' || !Number.isFinite(row.registeredAt)
      || !storedGridLaunch(row.gridLaunch)) return invalid()
    return { row: { agentId: row.agentId, registeredAt: row.registeredAt }, launch: row.gridLaunch }
  }
  for (const row of value) {
    if (!record(row)) return invalid()
    if (row.gridLaunch == null) continue
    const selected = credential(row), key = identity(selected.row)
    if (expected.has(key)) return invalid()
    expected.set(key, selected)
  }
  if (prepared.credentials.length !== expected.size) return invalid()
  const accepted = new Map<string, SessionCredentialReference>()
  for (const reference of prepared.credentials) {
    if (!sessionCredentialReference(reference) || !fields(reference, ['version', 'binding', 'row', 'source'])
      || !fields(reference.row, ['agentId', 'registeredAt']) || reference.source.kind !== 'image'
      || !fields(reference.source, ['kind', 'proof']) || !fields(reference.source.proof, ['document', 'identity', 'bytes', 'sha256'])
      || !fields(reference.source.proof.document, ['kind']) || reference.source.proof.document.kind !== 'registry'
      || reference.source.proof.identity !== prepared.proof.identity || reference.source.proof.bytes !== prepared.proof.bytes
      || reference.source.proof.sha256 !== prepared.proof.sha256) return invalid()
    const key = identity(reference.row), before = expected.get(key)
    if (!before || accepted.has(key)) return invalid()
    if (before.launch.credential.row.agentId === before.row.agentId && before.launch.credential.row.registeredAt === before.row.registeredAt
      && before.launch.credential.binding !== reference.binding) return invalid()
    accepted.set(key, reference)
  }
  return value.map(row => row.gridLaunch == null ? row : { ...row,
    gridLaunch: { ...row.gridLaunch, credential: accepted.get(identity(credential(row).row))! } })
}

function updateWitness(value: unknown, document: SessionDocument, proof: SessionImageProof): void {
  const rows = document.kind === 'registry' || document.kind === 'legacy-registry' ? Array.isArray(value) ? value : []
    : document.kind === 'names' ? [] : [value && typeof value === 'object' ? (value as { session?: unknown }).session : null]
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as { gridLaunch?: unknown }
    if (storedGridLaunch(row.gridLaunch)) row.gridLaunch.credential.source = { kind: 'image', proof }
  }
}

export async function prepareSessionPublication(storage: SessionStorage, document: SessionDocument,
  source: SessionImageSource | null, value: unknown, deadline: RegistryWriteDeadline, rawSource?: SessionImageProof) {
  deadline.check()
  const file = storage.path(document), directory = dirname(file)
  let directoryFd: number | undefined, directoryIdentity: Stats | undefined
  let prepared: SessionPreparedImage | undefined, renamed = false, settled = false
  let projected: unknown
  const privateDirectory = (stat: Stats) => stat.isDirectory()
    && (typeof process.getuid !== 'function' || stat.uid === process.getuid()) && (stat.mode & 0o777) === 0o700
  const checkDirectory = () => {
    if (directoryFd === undefined) return
    const descriptor = fstatSync(directoryFd), path = lstatSync(directory)
    if (!privateDirectory(descriptor) || !privateDirectory(path)
      || descriptor.dev !== directoryIdentity!.dev || descriptor.ino !== directoryIdentity!.ino
      || path.dev !== descriptor.dev || path.ino !== descriptor.ino) throw new RegistryPersistenceUnavailable('state directory identity changed')
  }
  const closeDirectory = () => {
    if (directoryFd === undefined) return
    const fd = directoryFd
    directoryFd = undefined
    try { closeSync(fd) } catch { deadline.failClosed() }
  }
  const sourceProof = source?.image.state === 'image' ? source.image.proof : null
  const checkSource = () => {
    source?.check()
    try {
      const stat = lstatSync(file, { bigint: true })
      if (!sourceProof || sessionFileIdentity(stat) !== sourceProof.identity) throw new RegistryPersistenceUnavailable('session source changed')
    } catch (error) {
      if (sourceProof || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  try {
    if (directorySyncSupported()) {
      directoryFd = await new Promise<number>((resolve, reject) => open(directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        (error, fd) => error ? reject(error) : resolve(fd)))
      directoryIdentity = await new Promise<Stats>((resolve, reject) => fstat(directoryFd!, (error, stat) => error ? reject(error) : resolve(stat)))
      if (!privateDirectory(directoryIdentity)) throw new RegistryPersistenceUnavailable('state directory is not private')
    }
    deadline.check()
    prepared = await storage.prepare(document, sourceProof, value, rawSource)
    projected = publicationValue(document, value, prepared)
    deadline.check()
    checkDirectory()
  } catch (error) {
    try { closeDirectory() } finally { if (prepared) await storage.discard(prepared) }
    throw error
  }
  const image = prepared
  const settle = async () => {
    if (settled) return
    await storage.discard(image)
    settled = true
  }
  return {
    get value() { return projected },
    get proof() { return image.proof },
    get published() { return renamed },
    publish(onRenamed: () => void): void {
      deadline.check()
      checkDirectory()
      checkSource()
      const temporary = join(storage.root, image.temporary)
      if (sessionFileIdentity(lstatSync(temporary, { bigint: true })) !== image.proof.identity) {
        throw new RegistryPersistenceUnavailable('prepared image changed')
      }
      renameSync(temporary, file)
      renamed = true
      onRenamed()
      deadline.markPublished()
      const stat = lstatSync(file, { bigint: true })
      const before = image.proof.identity.split(':')
      if (String(stat.dev) !== before[0] || String(stat.ino) !== before[1]) throw new AtomicWriteUnconfirmed(new Error('published image changed'), false)
      image.proof = { ...image.proof, identity: sessionFileIdentity(stat) }
      updateWitness(projected, document, image.proof)
    },
    sync(): Promise<void> | undefined {
      if (directoryFd === undefined) return
      return new Promise((resolve, reject) => fsync(directoryFd!, error => error ? reject(new AtomicWriteUnconfirmed(error)) : resolve()))
    },
    finish(): void {
      deadline.check()
      checkDirectory()
      try {
        if (renamed && sessionFileIdentity(lstatSync(file, { bigint: true })) !== image.proof.identity) throw new Error()
      } catch { throw new AtomicWriteUnconfirmed(new Error('published image changed'), false) }
      closeDirectory()
    },
    settle,
    async discard(): Promise<void> {
      try { closeDirectory() } finally { await settle() }
    },
  }
}
