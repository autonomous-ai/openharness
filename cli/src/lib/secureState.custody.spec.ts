import * as fs from 'node:fs'
import * as promises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      if (String(args[0]) === owner && (phase === 'owner-write' || phase === 'existing-owner-read'
        || phase === 'cleanup-read' && applied)) {
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
    expect(fs.existsSync(lock)).toBe(true)
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
