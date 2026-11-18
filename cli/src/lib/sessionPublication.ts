/** Core owns the final non-yielding rename/admission fence; storage owns raw encoding and file writes. */
import { closeSync, constants, fstat, fstatSync, fsync, lstatSync, open, renameSync, type Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import { AtomicWriteUnconfirmed, RegistryPersistenceUnavailable, type RegistryWriteDeadline } from './registryPersistence.js'
import { directorySyncSupported } from './secureState.js'
import type { SessionImageSource, SessionStorage } from './sessionStorage.js'
import { sessionFileIdentity, storedGridLaunch, type SessionDocument, type SessionImageProof, type SessionPreparedImage } from './sessionStorageWire.js'

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
    get value() { return image.value },
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
      updateWitness(image.value, document, image.proof)
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
