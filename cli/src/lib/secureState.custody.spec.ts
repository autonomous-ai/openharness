import * as fs from 'node:fs'
import * as promises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('node:fs', async original => ({ ...await original<object>() }))
vi.mock('node:fs/promises', async original => ({ ...await original<object>() }))
vi.mock('node:child_process', async original => ({ ...await original<object>(),
  execFile: (_file: string, _args: string[], _options: object, done: (error: null, output: string) => void) => {
    done(null, 'fixture-process-generation')
  },
}))
let root: string
const cleanup: Array<() => void | Promise<void>> = []
beforeEach(() => {
  vi.resetModules()
  root = fs.mkdtempSync(join(tmpdir(), 'state-helper-custody-'))
  fs.writeFileSync(join(root, 'state.json'), '{}', { mode: 0o600 })
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0)) await close()
  fs.rmSync(root, { recursive: true, force: true })
})

it.each(['directory', 'read', 'harden', 'sync'] as const)('retains a failed synchronous %s helper close and refuses another open', async kind => {
  const state = await import('./secureState.js'), close = fs.closeSync
  // A directory already at 0700 needs no descriptor; exercise the tightening path's close.
  if (kind === 'directory') fs.chmodSync(root, 0o750)
  const opened = vi.spyOn(fs, 'openSync')
  vi.spyOn(fs, 'closeSync').mockImplementationOnce(fd => {
    cleanup.push(() => close(fd))
    throw Object.assign(new Error('fixture close failure'), { code: 'EIO' })
  })
  const act = () => kind === 'directory' ? state.secureStateDirectory(root, false)
    : kind === 'read' ? state.readPrivateStateFile(join(root, 'state.json'))
    : kind === 'harden' ? state.hardenPrivateStateFileIfPresent(join(root, 'state.json'))
    : state.syncStateDirectory(root)
  expect(act).toThrow(expect.objectContaining({ code: 'STATE_FILE_CLEANUP_UNCONFIRMED' }))
  const count = opened.mock.calls.length
  expect(() => state.readPrivateStateFile(join(root, 'state.json'))).toThrow(expect.objectContaining({ code: 'STATE_FILE_CLEANUP_UNCONFIRMED' }))
  expect(opened).toHaveBeenCalledTimes(count)
})

it.each(['directory', 'owner'] as const)('retains a failed asynchronous %s helper close and refuses another open', async kind => {
  const persistence = await import('./registryPersistence.js'), open = promises.open
  const opened = vi.spyOn(promises, 'open').mockImplementationOnce(async (...args) => {
    const handle = await open(...args), close = handle.close.bind(handle)
    handle.close = async () => { cleanup.push(close); throw Object.assign(new Error('fixture close failure'), { code: 'EIO' }) }
    return handle
  })
  const act = () => kind === 'directory' ? persistence.privateRegistryDirectory(root)
    : persistence.readPrivateRegistryOwner(join(root, 'state.json'))
  await expect(act()).rejects.toMatchObject({ code: 'STATE_FILE_CLEANUP_UNCONFIRMED' })
  const count = opened.mock.calls.length
  await expect(persistence.privateRegistryDirectory(root)).rejects.toMatchObject({ code: 'STATE_FILE_CLEANUP_UNCONFIRMED' })
  expect(opened).toHaveBeenCalledTimes(count)
})

it.each(['owner-write', 'existing-owner-read', 'final-fence', 'cleanup-read', 'cleanup-directory'] as const)(
  'preserves cleanup identity through registry lock %s', async phase => {
    const persistence = await import('./registryPersistence.js'), originalOpen = promises.open
    const originalClose = fs.closeSync, originalDirectory = fs.opendirSync
    const lock = join(root, 'registry.json.lock'), owner = join(lock, 'owner.json')
    if (phase === 'existing-owner-read') {
      fs.mkdirSync(lock, { mode: 0o700 })
      fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, token: 'fixture-owner' }), { mode: 0o600 })
    }
    let applied = false
    vi.spyOn(promises, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      if (phase === 'owner-write' && basename(String(args[0])) === 'owner.json'
        || String(args[0]) === owner && (phase === 'existing-owner-read' || phase === 'cleanup-read' && applied)) {
        const close = handle.close.bind(handle)
        handle.close = async () => { cleanup.push(close); throw new Error('fixture close failure') }
      }
      return handle
    })
    if (phase === 'final-fence') vi.spyOn(fs, 'closeSync').mockImplementationOnce(fd => {
      cleanup.push(() => originalClose(fd)); throw new Error('fixture close failure')
    })
    if (phase === 'cleanup-directory') vi.spyOn(fs, 'opendirSync').mockImplementation((...args) => {
      const directory = originalDirectory(...args), close = directory.closeSync.bind(directory)
      directory.closeSync = () => { cleanup.push(close); throw new Error('fixture close failure') }
      return directory
    })
    const run = () => persistence.registryFileLock(root, { expires: performance.now() + 5_000, check() {} }, async () => { applied = true })
    await expect(run()).rejects.toMatchObject({ code: 'STATE_FILE_CLEANUP_UNCONFIRMED' })
    expect(fs.existsSync(lock)).toBe(phase !== 'owner-write')
    if (phase === 'owner-write') expect(fs.readdirSync(root).filter(name => name.startsWith('registry.json.lock.'))).toHaveLength(1)
    const opens = vi.mocked(promises.open).mock.calls.length
    await expect(run()).rejects.toMatchObject({ code: 'STATE_FILE_CLEANUP_UNCONFIRMED' })
    expect(promises.open).toHaveBeenCalledTimes(opens)
  },
)

it('still closes other owned handles after one close becomes uncertain', async () => {
  const state = await import('./secureState.js'), close = fs.closeSync
  const first = fs.openSync(join(root, 'state.json'), 'r'), second = fs.openSync(join(root, 'state.json'), 'r')
  vi.spyOn(fs, 'closeSync').mockImplementationOnce(fd => { cleanup.push(() => close(fd)); throw new Error('fixture close failure') })
  expect(() => state.closeStateFileDescriptor(first)).toThrow(expect.objectContaining({ code: 'STATE_FILE_CLEANUP_UNCONFIRMED' }))
  state.closeStateFileDescriptor(second)
  expect(() => fs.fstatSync(second)).toThrow(expect.objectContaining({ code: 'EBADF' }))
})

// A failed close cannot be retried: its descriptor may already belong to another file.
it.each(['sync', 'async'] as const)('refuses another atomic write after a failed %s temporary close', async kind => {
  const state = await import('./secureState.js'), file = join(root, 'state.json')
  const open = promises.open, close = fs.closeSync
  const syncOpens = vi.spyOn(fs, 'openSync')
  const asyncOpens = vi.spyOn(promises, 'open')
  if (kind === 'sync') vi.spyOn(fs, 'closeSync').mockImplementationOnce(fd => {
    cleanup.push(() => close(fd)); throw new Error('fixture close failure')
  })
  else asyncOpens.mockImplementationOnce(async (...args) => {
    const handle = await open(...args), realClose = handle.close.bind(handle)
    handle.close = async () => { cleanup.push(realClose); throw new Error('fixture close failure') }
    return handle
  })
  const act = () => kind === 'sync' ? state.atomicWriteFile(file, '{"next":true}', 'cache')
    : state.atomicWriteFileAsync(file, '{"next":true}', 'cache')
  const rejected = () => Promise.resolve().then(act)
  await expect(rejected()).rejects.toMatchObject({ code: 'STATE_FILE_CLEANUP_UNCONFIRMED' })
  expect(fs.readFileSync(file, 'utf8')).toBe('{}')
  const syncCount = syncOpens.mock.calls.length, asyncCount = asyncOpens.mock.calls.length
  await expect(rejected()).rejects.toMatchObject({ code: 'STATE_FILE_CLEANUP_UNCONFIRMED' })
  expect(() => state.readPrivateStateFile(file)).toThrow(expect.objectContaining({ code: 'STATE_FILE_CLEANUP_UNCONFIRMED' }))
  expect(syncOpens).toHaveBeenCalledTimes(syncCount)
  expect(asyncOpens).toHaveBeenCalledTimes(asyncCount)
})


it.each(['prepare', 'published', 'admitted'] as const)('retains queue and shutdown ownership after an escaping %s helper close', async phase => {
  const state = await import('./secureState.js'), { RegistryWriteQueue } = await import('./registryPersistence.js')
  const queue = new RegistryWriteQueue(), close = fs.closeSync
  let release!: () => void
  const entered = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(fs, 'closeSync').mockImplementationOnce(fd => { cleanup.push(() => close(fd)); throw new Error('fixture close failure') })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const result = queue.run(async deadline => {
      if (phase !== 'prepare') deadline.markPublished()
      if (phase === 'admitted') deadline.markAdmitted()
      await entered
      try { state.readPrivateStateFile(join(root, 'state.json')) }
      catch (error) {
        // Registry callers may preserve uncertainty in a named publication wrapper.
        if (phase === 'published') throw new state.AtomicWriteUnconfirmed(error, false)
        throw error
      }
    }).catch(error => error)
    const next = vi.fn(async () => {}), following = queue.run(next).catch(error => error)
    const finalWrite = vi.fn(async () => {}), settled = vi.fn()
    void queue.finish(finalWrite).then(settled, settled)
    release()
    const error = await result
    expect(error).toBeInstanceOf(phase === 'published' ? state.AtomicWriteUnconfirmed : phase === 'prepare' ? state.StateFileCleanupUnconfirmed : Error)
    await vi.advanceTimersByTimeAsync(5_001)
    expect(next).not.toHaveBeenCalled()
    expect(finalWrite).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()
    expect(await following).toBeInstanceOf(Error)
    expect(fs.closeSync).toHaveBeenCalledTimes(1)
  } finally { vi.useRealTimers() }
})
