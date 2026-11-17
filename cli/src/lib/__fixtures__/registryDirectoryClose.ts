/** A separate process owns the deliberately unclosed descriptor until its actual exit. */
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs')
const [directory, mode] = process.argv.slice(2) as [string, 'published' | 'preparation' | 'status']
const file = join(directory, 'registry.json'), receipt = join(directory, 'close-receipt.json')
const original = { close: fs.closeSync, stat: fs.fstat, rename: fs.renameSync, open: fs.open }
let armed = mode === 'status', published = false, selected: number | undefined
let attempts = 0, afterFailureWrites = 0, cleanExit = false
let outcome: unknown, refused: unknown
fs.open = ((...args: Parameters<typeof fs.open>) => {
  const callback = args[args.length - 1] as (error: NodeJS.ErrnoException | null, fd: number) => void
  args[args.length - 1] = (error: NodeJS.ErrnoException | null, fd: number) => {
    if (!error && armed && String(args[0]) === directory) selected = fd
    callback(error, fd)
  }
  return original.open(...args)
}) as typeof fs.open
fs.fstat = ((...args: Parameters<typeof fs.fstat>) => {
  const callback = args[args.length - 1] as (error: NodeJS.ErrnoException | null, info: import('node:fs').Stats) => void
  if (armed && mode === 'preparation' && args[0] === selected) {
    queueMicrotask(() => callback(Object.assign(new Error('fixture descriptor validation failure'), { code: 'EIO' }), undefined as never))
    return
  }
  return original.stat(...args)
}) as typeof fs.fstat
fs.renameSync = (...args) => {
  original.rename(...args)
  if (String(args[1]) === file) {
    published = true
    if (attempts) afterFailureWrites++
  }
}
fs.closeSync = fd => {
  if (armed && (mode === 'preparation' ? fd === selected : published && fs.fstatSync(fd).isDirectory())) {
    attempts++
    throw Object.assign(new Error('fixture directory close result unknown'), { code: 'EIO' })
  }
  original.close(fd)
}
syncBuiltinESMExports()
process.once('exit', code => fs.writeFileSync(receipt, JSON.stringify({ attempts, afterFailureWrites, cleanExit,
  outcome, refused, code, lockRetained: fs.existsSync(file + '.lock'),
  uncertainDescriptorOpen: selected !== undefined && (() => { try { return fs.fstatSync(selected).isDirectory() } catch { return false } })(),
})))

if (mode === 'status') {
  process.argv = [process.execPath, fileURLToPath(new URL('../../cli.ts', import.meta.url)), 'status']
  await import('../../cli.js')
} else {
  const { registry } = await import('../registry.js')
  await registry.load()
  await registry.flush()
  const row = registry.list()[0]!
  const plan = { id: '12345678-1234-1234-1234-123456789012', identity: 'fixture-owner', requestedAt: 1790900000000, state: 'waiting' as const }
  armed = true; published = false
  const failure = (error: unknown) => error instanceof Error
    ? { name: error.constructor.name, retryable: (error as { retryable?: boolean }).retryable, message: error.message } : { unexpected: true }
  outcome = await registry.setClosePlan(row.agentId, plan).then(() => ({ unexpectedSuccess: true }), failure)
  refused = await registry.setClosePlan(row.agentId, null).then(() => ({ unexpectedSuccess: true }), failure)
  // No awaited promise can claim this writer ended. Node itself must exit with that fd still owned.
  void registry.flush({ exiting: true }).then(() => { cleanExit = true }, () => { cleanExit = true })
}
