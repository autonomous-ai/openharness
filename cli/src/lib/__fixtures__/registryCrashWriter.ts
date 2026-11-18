// A real writer is killed at a reported persistence boundary; no application acknowledgement is sent.
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs')
const io = require('node:fs/promises') as typeof import('node:fs/promises')
const [directory, phase] = process.argv.slice(2) as [string, string]
const lock = join(directory, 'registry.json.lock'), file = join(directory, 'registry.json')
const halt = (at: string): never => {
  process.send?.(at)
  // This isolated crash fixture must stop inside a synchronous fsync boundary until its parent kills it.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000)
  throw new Error('crash fixture was not killed before its fail-safe')
}
const mkdir = io.mkdir
io.mkdir = (async (...args: Parameters<typeof io.mkdir>) => {
  const result = await mkdir(...args)
  if (phase === 'ownerless' && String(args[0]) === lock) halt(phase)
  return result
}) as typeof io.mkdir
const sync = fs.fsyncSync
fs.fsyncSync = fd => { if (phase === 'published' && fs.fstatSync(fd).isDirectory()) halt(phase); sync(fd) }
const asyncSync = fs.fsync
fs.fsync = ((fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
  if (phase === 'published' && fs.fstatSync(fd).isDirectory()) halt(phase)
  asyncSync(fd, callback)
}) as typeof fs.fsync
syncBuiltinESMExports()
const { RegistryWriteQueue, registryFileLock } = await import('../registryPersistence.js')
const { prepareSessionPublication } = await import('../sessionPublication.js')
const { SessionStorage } = await import('../sessionStorage.js')
const { fingerprint } = await import('../../harnessd/bundleFingerprint.js')
const entry = fileURLToPath(new URL('../../storage/entry.ts', import.meta.url))
const storage = new SessionStorage(directory, () => ({ file: entry, sha256: fingerprint(entry)!, execArgv: ['--import', import.meta.resolve('tsx')] }))
await new RegistryWriteQueue().run(deadline => registryFileLock(directory, deadline, async checkOwner => {
  const source = await storage.retain({ kind: 'registry' })
  if (source.image.state !== 'image' || !source.image.json) throw new Error('fixture image unavailable')
  const rows = source.image.value as Array<{ title: string }>
  rows[0]!.title = 'peer crash metadata'
  const prepared = await prepareSessionPublication(storage, { kind: 'registry' }, source, rows, deadline)
  if (phase === 'prepared') halt(phase)
  checkOwner(); prepared.publish(() => {})
  const syncing = prepared.sync()
  if (syncing) await syncing
  prepared.finish(); deadline.markAdmitted()
  await prepared.settle(); await source.release(); await storage.close()
  if (phase === 'confirmed') halt(phase)
  throw new Error('crash checkpoint was not reached')
}))
