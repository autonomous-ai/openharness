// A real writer is killed at a reported persistence boundary; no application acknowledgement is sent.
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
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
const { RegistryWriteQueue, registryFileLock, prepareRegistryImage } = await import('../registryPersistence.js')
await new RegistryWriteQueue().run(deadline => registryFileLock(directory, deadline, async checkOwner => {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
  rows[0].title = 'peer crash metadata'
  const prepared = await prepareRegistryImage(file, JSON.stringify(rows, null, 2), deadline)
  if (phase === 'prepared') halt(phase)
  checkOwner(); prepared.publish(() => {})
  const syncing = prepared.sync()
  if (syncing) await syncing
  prepared.finish(); deadline.markAdmitted()
  if (phase === 'confirmed') halt(phase)
  throw new Error('crash checkpoint was not reached')
}))
