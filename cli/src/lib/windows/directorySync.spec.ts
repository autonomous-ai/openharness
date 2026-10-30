// The state writers that flush a directory after a rename, run as on Windows: there, flushing a directory handle Node
// opened is EPERM (measured on Windows 11 in Task 19: every registry save failed after its rename), so each must skip
// the directory flush (secureState.ts `syncStateDirectory`, `directorySyncSupported`). The fs below fails the way
// Windows does for a directory and only for one; files are still flushed.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const windows = vi.hoisted(() => ({ on: false, directoryFlushes: 0 }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  const directory = (fd: number) => actual.fstatSync(fd).isDirectory()
  const eperm = () => Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM' })
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      if (directory(fd)) { windows.directoryFlushes++; if (windows.on) throw eperm() }
      return actual.fsyncSync(fd)
    },
    fsync: (fd: number, done: (error: NodeJS.ErrnoException | null) => void) => {
      if (directory(fd)) { windows.directoryFlushes++; if (windows.on) { queueMicrotask(() => done(eperm())); return } }
      actual.fsync(fd, done)
    },
  }
})

const { dshPreparations } = await import('../../dsh/preparation.js')
const { AgentCreationReceipts, creationFingerprint } = await import('../agentCreationReceipt.js')
const { createHomeAdopter } = await import('../../engines/kit/homeAdoption.js')
const { DeviceResultJournal } = await import('../autonomous-device/resultJournal.js')

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
// On a real Windows (the VM) the flush is EPERM whatever the fixture does, and two of these writers still check POSIX
// modes and paths after it (see the cases below).
const REAL_WINDOWS = process.platform === 'win32'
let root = ''
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'windows-directory-sync-')))
  // On Windows, state must be in the profile or the configured data folder (secureState.ts `windowsStateRoots`).
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  windows.on = false
  windows.directoryFlushes = 0
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  windows.on = false
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

/** Runs [write] as Windows would: process.platform win32, and a directory flush is EPERM. */
async function asWindows<T>(write: () => T | Promise<T>): Promise<T> {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  windows.on = true
  try { return await write() } finally {
    windows.on = false
    Object.defineProperty(process, 'platform', platform)
  }
}

describe('directory flushes on Windows', () => {
  it('a Store workspace preparation records its receipt without one', async () => {
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const prepare = dshPreparations(join(root, 'receipts'))
    expect(await asWindows(() => prepare(workspace, { init: 'first' }, async () => 'done', true))).toBe('done')
    expect(windows.directoryFlushes).toBe(0)
    if (REAL_WINDOWS) return
    // Elsewhere the same writes flush their directory, as before.
    expect(await dshPreparations(join(root, 'receipts-unix'))(workspace, { init: 'first' }, async () => 'done', true)).toBe('done')
    expect(windows.directoryFlushes).toBeGreaterThan(0)
  })

  it('an agent creation receipt is reserved and completed without one', async () => {
    const receipts = new AgentCreationReceipts(join(root, 'creations'))
    const fingerprint = creationFingerprint({ engine: 'claude', cwd: '/work' })
    expect(await asWindows(() => receipts.run('creation-intent-0001', fingerprint, async () => ({ state: 'created', agentId: 'a1' }))))
      .toEqual({ state: 'created', agentId: 'a1' })
    expect(windows.directoryFlushes).toBe(0)
  })

  it('a device result journal is saved without one', async () => {
    const journal = new DeviceResultJournal(join(root, 'device', 'results.json'))
    await asWindows(() => journal.save({ results: [1] }))
    expect(windows.directoryFlushes).toBe(0)
    expect(await asWindows(() => journal.load())).toEqual({ results: [1] })
  })

  // On a real Windows the journal's POSIX owner and mode checks refuse it first (homeAdoption.ts `inspect`).
  it.skipIf(REAL_WINDOWS)('an engine home adoption is published without one', async () => {
    const adopter = createHomeAdopter(join(root, 'data', 'engine-homes.json'))
    expect(await asWindows(() => adopter.adopt({ claude: [], codex: ['/new'] }))).toEqual({ claude: [], codex: ['/new'] })
    expect(windows.directoryFlushes).toBe(0)
  })

  // On a real Windows its route walk looks for a `/` root first (nativeHookFiles.ts `directoryPath`).
  it.skipIf(REAL_WINDOWS)('a grid launch configuration is published (hook preparation\'s directory confirmations) without one', async () => {
    // The data folder is read as the module loads (config/env.ts).
    vi.stubEnv('HOME', root)
    vi.stubEnv('USERPROFILE', root)
    vi.resetModules()
    const { publishGridConfigDir } = await import('../publishedGridConfig.js')
    const published = await asWindows(() => publishGridConfigDir('fixture-agent', [{ name: 'models.json', content: '{}\n' }]))
    expect(published.directory.startsWith(join(root, 'grid-launch-config'))).toBe(true)
    expect(windows.directoryFlushes).toBe(0)
  })
})
