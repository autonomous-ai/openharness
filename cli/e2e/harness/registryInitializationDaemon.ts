/** A real core stops while its reload still owns a pending directory-sync callback. */
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { Server } from 'node:http'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs')
const directory = process.env.ADAPTER_DATA_DIR!, root = dirname(directory)
assert.equal(process.env.NODE_ENV, 'test')
assert.equal(process.env.HARNESS_NO_MASTER, '1')
assert.match(basename(root), /^htmux-/)
assert.equal(fs.realpathSync(root), root)
assert(process.env.HOME?.startsWith(root + sep))
const file = join(directory, 'registry.json'), lock = file + '.lock'
const socket = join(directory, `daemon-${process.env.PORT}.sock`)
const original = { open: fs.open, sync: fs.fsync, close: fs.closeSync, closeServer: Server.prototype.close, listen: Server.prototype.listen }
let ownershipServer: Server | undefined
let armed = false, selected: number | undefined, resume: (() => void) | undefined
let originalOwner: string | undefined, pending = false, released = false, loaded = false, flushed = false
let flushCalls = 0, localCloseCalls = 0, entered = 0, heldSyncs = 0, closedBeforeRelease = false
let stopAt: number | undefined

fs.open = ((...args: Parameters<typeof fs.open>) => {
  const callback = args[args.length - 1] as (error: NodeJS.ErrnoException | null, fd: number) => void
  args[args.length - 1] = (error: NodeJS.ErrnoException | null, fd: number) => {
    if (!error && armed && String(args[0]) === directory) selected = fd
    callback(error, fd)
  }
  return original.open(...args)
}) as typeof fs.open
fs.fsync = ((fd, callback) => original.sync(fd, error => {
  if (armed && fd === selected && heldSyncs === 0) {
    heldSyncs++; pending = true
    originalOwner = fs.readFileSync(join(lock, 'owner.json'), 'utf8')
    resume = () => { released = true; pending = false; callback(error) }
    stopAt = performance.now()
    process.kill(process.pid, 'SIGTERM')
    return
  }
  callback(error)
})) as typeof fs.fsync
fs.closeSync = fd => {
  if (fd === selected && pending) closedBeforeRelease = true
  original.close(fd)
}
Server.prototype.close = function (...args: Parameters<Server['close']>) {
  if (this === ownershipServer) localCloseCalls++
  return original.closeServer.apply(this, args)
}
Server.prototype.listen = function (this: Server, ...args: unknown[]) {
  // The public name is hard-linked from this staging socket; address() keeps the staging name.
  if (typeof args[0] === 'string' && dirname(args[0]) === directory && /^\.claim-[a-f0-9]{6}$/.test(basename(args[0]))) {
    assert.equal(ownershipServer, undefined)
    ownershipServer = this
  }
  return Reflect.apply(original.listen, this, args)
} as Server['listen']
syncBuiltinESMExports()
process.on('SIGUSR2', () => {
  assert(resume && pending && !released)
  assert.equal(fs.readFileSync(join(lock, 'owner.json'), 'utf8'), originalOwner)
  assert(selected !== undefined && fs.fstatSync(selected).isDirectory())
  assert.equal(localCloseCalls, 0)
  assert.equal(flushed, false)
  resume()
})
process.once('exit', code => fs.writeFileSync(join(directory, 'initialization-daemon-receipt.json'), JSON.stringify({
  code, heldSyncs, pending, released, loaded, flushed, flushCalls, localCloseCalls, entered, closedBeforeRelease,
  stopElapsedMs: stopAt === undefined ? null : performance.now() - stopAt,
  lockGone: !fs.existsSync(lock), socketGone: !fs.existsSync(socket),
})))

const { runCoreInForeground } = await import('../../src/core/main.js')
const { registry } = await import('../../src/lib/registry.js')
await runCoreInForeground(null, fileURLToPath(new URL('../../src/cli.ts', import.meta.url)))
assert(ownershipServer)
const row = await registry.openPendingAgent({ engine: 'claude', cwd: directory, runtimes: [{ backend: 'tmux', paneId: '%999999' }] })
assert(row)
await registry.flush()
const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
assert.equal(rows.length, 1)
delete rows[0].schemaVersion
fs.writeFileSync(file, JSON.stringify(rows), { mode: 0o600 })
registry.onEnter = () => { entered++ }
const flush = registry.flush.bind(registry)
registry.flush = options => {
  const result = flush(options)
  if (options?.exiting) {
    flushCalls++
    assert(pending && !released && !loaded)
    assert.equal(localCloseCalls, 0)
    assert.equal(fs.readFileSync(join(lock, 'owner.json'), 'utf8'), originalOwner)
    assert.throws(() => registry.markOpened(row.agentId))
    console.log('[registry-initialization-fixture] shutdown waits for reload')
    void result.then(() => { flushed = true })
  }
  return result
}
armed = true
await registry.load()
loaded = true
assert.equal(entered, 0)
assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].schemaVersion, 2)
