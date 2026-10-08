import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { psEnv } from './childLocale.js'

const mocks = vi.hoisted(() => ({ read: vi.fn(), exec: vi.fn() }))
vi.mock('fs', () => ({ readFileSync: mocks.read }))
vi.mock('node:child_process', () => ({ execFileSync: mocks.exec }))

import { lockOwnerAlive, lockStartMarker, processLockIdentity, processStartMarker } from './processLiveness.js'

const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs')
const hook = readFileSync(new URL('../../hook/notify.mjs', import.meta.url), 'utf8')
const hookFunctions = hook.slice(hook.indexOf('function processStartMarker('), hook.indexOf('async function withRegistryLock('))
const hookApi = runInNewContext(`${hookFunctions}; ({ processStartMarker, lockOwnerAlive: processAlive, processLockIdentity, lockStartMarker })`, {
  readFileSync: mocks.read, execFileSync: mocks.exec, process, psEnv,
}) as { processStartMarker: typeof processStartMarker; lockOwnerAlive: typeof lockOwnerAlive;
  processLockIdentity: typeof processLockIdentity; lockStartMarker: typeof lockStartMarker }

describe.each([
  ['daemon', { processStartMarker, lockOwnerAlive, processLockIdentity, lockStartMarker }],
  ['offline hook', hookApi],
] as const)('%s lock generations', (_, api) => {
  beforeEach(() => {
    mocks.read.mockReset().mockImplementation(() => { throw new Error('No /proc') })
    mocks.exec.mockReset().mockImplementation((_cmd, _args, options) =>
      options.env?.LC_TIME === 'C' && options.env?.LC_ALL === '' && options.env?.TZ === 'UTC'
        ? 'Sun Sep 27 20:00:00 2026\n'
        : 'Sun 27 Sep 20:00:00 2026\n')
  })

  it('writes the same versioned timestamp under different caller locales', () => {
    const original = process.env.LC_ALL
    try {
      for (const locale of ['en_GB.UTF-8', 'ja_JP.UTF-8', 'C']) {
        process.env.LC_ALL = locale
        expect(api.processStartMarker(process.pid)).toBe('ps-c:Sun Sep 27 20:00:00 2026')
      }
    } finally {
      if (original === undefined) delete process.env.LC_ALL
      else process.env.LC_ALL = original
    }
  })

  it('preserves a live legacy or unknown lock across an upgrade', () => {
    expect(api.lockOwnerAlive(process.pid, 'ps:Sun 27 Sep 20:00:00 2026')).toBe(true)
    expect(api.lockOwnerAlive(process.pid, 'future-format:123')).toBe(true)
  })

  it('writes locks that old readers cannot steal under either locale', () => {
    const owner = api.processLockIdentity(process.pid)
    for (const legacyMarker of ['ps:Sun Sep 27 20:00:00 2026', 'ps:Sun 27 Sep 20:00:00 2026']) {
      // The pre-migration reader's condition after its PID existence check.
      expect(!owner.startMarker || legacyMarker === owner.startMarker).toBe(true)
    }
    expect(api.lockOwnerAlive(process.pid, api.lockStartMarker(owner))).toBe(true)
    expect(api.lockOwnerAlive(process.pid, api.lockStartMarker({ ...owner,
      generationMarker: 'ps-c:Sun Sep 27 19:00:00 2026' }))).toBe(false)
    expect(api.lockStartMarker({ startMarker: 'ps:legacy' })).toBe('ps:legacy')
  })

  it('still detects process generation changes in comparable markers', () => {
    expect(api.lockOwnerAlive(process.pid, 'ps-c:Sun Sep 27 20:00:00 2026')).toBe(true)
    expect(api.lockOwnerAlive(process.pid, 'ps-c:Sun Sep 27 19:00:00 2026')).toBe(false)
  })

  it('uses Linux start ticks when proc is readable', () => {
    mocks.read.mockReturnValue(`123 (name with ) parens) ${Array(19).fill('0').join(' ')} 456 0`)
    expect(api.processStartMarker(process.pid)).toBe('linux:456')
    expect(api.lockOwnerAlive(process.pid, 'linux:456')).toBe(true)
    expect(api.lockOwnerAlive(process.pid, 'linux:455')).toBe(false)
    expect(mocks.exec).not.toHaveBeenCalled()
  })

  it('does not reclaim a live owner when its timestamp is unreadable', () => {
    mocks.exec.mockImplementation(() => { throw new Error('Process query failed') })
    expect(api.lockOwnerAlive(process.pid, 'ps-c:Sun Sep 27 20:00:00 2026')).toBe(true)
    expect(api.lockOwnerAlive(999_999_999, 'ps:legacy')).toBe(false)
    expect(api.processStartMarker(-1)).toBeNull()
  })
})
