/** The real core owns a deliberately uncertain directory descriptor until its stop deadline exits. */
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { Server } from 'node:net'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprint } from '../../src/harnessd/bundleFingerprint.js'
import { rememberExecutedEntry } from '../../src/harnessd/executedEntry.js'

const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs')
const directory = process.env.ADAPTER_DATA_DIR!
const root = dirname(directory)
assert.equal(process.env.NODE_ENV, 'test')
assert.equal(process.env.HARNESS_NO_MASTER, '1')
assert.match(basename(root), /^htmux-/)
assert.equal(fs.realpathSync(root), root)
assert(process.env.HOME?.startsWith(root + sep))
const file = join(directory, 'registry.json'), socketPath = join(directory, `daemon-${process.env.PORT}.sock`)
const original = { open: fs.open, close: fs.closeSync, rename: fs.renameSync, closeServer: Server.prototype.close }
let armed = false, published = false, selected: number | undefined
let attempts = 0, afterFailureWrites = 0, localSocketCloseCalls = 0, flushCalls = 0, cleanFlush = false
let outcome: unknown, refused: unknown, signalledAt: number | undefined
let failedOwner: string | undefined

fs.open = ((...args: Parameters<typeof fs.open>) => {
  const callback = args[args.length - 1] as (error: NodeJS.ErrnoException | null, fd: number) => void
  args[args.length - 1] = (error: NodeJS.ErrnoException | null, fd: number) => {
    if (!error && armed && String(args[0]) === directory) selected = fd
    callback(error, fd)
  }
  return original.open(...args)
}) as typeof fs.open
fs.renameSync = (...args) => {
  original.rename(...args)
  if (String(args[1]) === file && armed) {
    published = true
    if (attempts) afterFailureWrites++
  }
}
fs.closeSync = fd => {
  if (armed && published && fd === selected) {
    attempts++
    failedOwner ??= fs.readFileSync(join(file + '.lock', 'owner.json'), 'utf8')
    throw Object.assign(new Error('fixture directory close result unknown'), { code: 'EIO' })
  }
  original.close(fd)
}
Server.prototype.close = function (...args: Parameters<Server['close']>) {
  if (this.address() === socketPath) localSocketCloseCalls++
  return original.closeServer.apply(this, args)
}
syncBuiltinESMExports()

process.once('exit', code => fs.writeFileSync(join(directory, 'close-daemon-receipt.json'), JSON.stringify({
  code, attempts, afterFailureWrites, localSocketCloseCalls, flushCalls, cleanFlush, outcome, refused,
  signalled: signalledAt !== undefined, stopElapsedMs: signalledAt === undefined ? null : performance.now() - signalledAt,
  lockRetained: fs.existsSync(file + '.lock'),
  originalLockOwnerRetained: failedOwner !== undefined && (() => {
    try { return fs.readFileSync(join(file + '.lock', 'owner.json'), 'utf8') === failedOwner } catch { return false }
  })(),
  uncertainDescriptorOpen: selected !== undefined && (() => { try { return fs.fstatSync(selected).isDirectory() } catch { return false } })(),
})))

// This wrapper bypasses the CLI entry, so record the source it actually executes before composing the core.
const entry = fileURLToPath(import.meta.url), sha256 = fingerprint(entry)
assert(sha256)
rememberExecutedEntry({ file: entry, sha256, admitted: false })
const { runCoreInForeground } = await import('../../src/core/main.js')
const { registry } = await import('../../src/lib/registry.js')
await runCoreInForeground(null, fileURLToPath(new URL('../../src/cli.ts', import.meta.url)))
// No native engine is needed: the pending row lets the real writer publish a strict operation.
const row = await registry.openPendingAgent({ engine: 'claude', cwd: directory, runtimes: [{ backend: 'tmux', paneId: '%999999' }] })
assert(row)
await registry.flush()
const flush = registry.flush.bind(registry)
registry.flush = options => {
  const pending = flush(options)
  if (options?.exiting) {
    flushCalls++
    console.log('[registry-close-fixture] shutdown is waiting for the registry')
    void pending.then(() => { cleanFlush = true }, () => { cleanFlush = true })
  }
  return pending
}
const failure = (error: unknown) => error instanceof Error
  ? { name: error.constructor.name, retryable: (error as { retryable?: boolean }).retryable } : { unexpected: true }
armed = true
outcome = await registry.setClosePlan(row.agentId, {
  id: '12345678-1234-1234-1234-123456789012', identity: 'fixture-owner', requestedAt: 1790900000000, state: 'waiting',
}).then(() => ({ unexpectedSuccess: true }), failure)
refused = await registry.setClosePlan(row.agentId, null).then(() => ({ unexpectedSuccess: true }), failure)
signalledAt = performance.now()
process.kill(process.pid, 'SIGTERM')
