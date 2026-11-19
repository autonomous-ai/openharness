// A real writer is killed at a reported persistence boundary; no application acknowledgement is sent.
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'
import { performance } from 'node:perf_hooks'
const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs')
const io = require('node:fs/promises') as typeof import('node:fs/promises')
const [directory, phase] = process.argv.slice(2) as [string, string]
const file = join(directory, 'registry.json')
const halt = (at: string): never => {
  process.send?.(at)
  // This isolated crash fixture must stop inside a synchronous fsync boundary until its parent kills it.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000)
  throw new Error('crash fixture was not killed before its fail-safe')
}
const open = io.open
io.open = (async (...args: Parameters<typeof io.open>) => {
  const handle = await open(...args)
  // The first owner.json this writer opens is its own, open and still empty, wherever the lock builds it.
  if (phase === 'taking' && basename(String(args[0])) === 'owner.json') halt(phase)
  return handle
}) as typeof io.open
const sync = fs.fsyncSync
fs.fsyncSync = fd => { if (phase === 'published' && fs.fstatSync(fd).isDirectory()) halt(phase); sync(fd) }
syncBuiltinESMExports()
const { registryFileLock, prepareRegistryImage } = await import('../registryPersistence.js')
const expires = performance.now() + 10_000
const deadline = { expires, check: () => { if (performance.now() >= expires) throw new Error('fixture expired') } }
await registryFileLock(directory, deadline, async checkOwner => {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
  rows[0].title = 'peer crash metadata'
  const prepared = await prepareRegistryImage(file, JSON.stringify(rows, null, 2), deadline)
  if (phase === 'prepared') halt(phase)
  checkOwner(); prepared.publish()
  throw new Error('crash checkpoint was not reached')
})
