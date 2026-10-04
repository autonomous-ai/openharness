import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canary, confirm, downloadVerified, fetchManifest, isLocalDevBuild, msUntilSlot, rejectedVersions, restore, semverGt, shouldAutoUpdate, stage, startSelfUpdater } from './selfUpdate.js'
import { SpawnLockBusyError } from './daemonSpawnLock.js'

let dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'machine-adapter-self-update-'))
  dirs.push(dir)
  return dir
}

describe('selfUpdate packaging', () => {
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs = []
  })

  it('canary runs installed cli.js as ESM', () => {
    const dir = tempDir()
    const cli = Buffer.from('#!/usr/bin/env node\nimport { createRequire } from "module";\nconsole.log(createRequire(import.meta.url) ? "1.2.3" : "nope")\n')

    expect(canary(cli, dir)).toBe(true)
  })

  it('stages the module package metadata next to cli.js', () => {
    const dir = tempDir()

    stage(dir, Buffer.from('console.log("cli")\n'), Buffer.from('console.log("notify")\n'))

    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toEqual({ type: 'module' })
  })
})

describe('shouldAutoUpdate', () => {
  it('recognises the labels install-cli.sh and version.ts produce', () => {
    expect(isLocalDevBuild('0.1.56-dev.a1b2c3d')).toBe(true)
    expect(isLocalDevBuild('0.1.56-dev.a1b2c3d.dirty')).toBe(true)
    expect(isLocalDevBuild('0.0.0-dev')).toBe(true)
    expect(isLocalDevBuild('0.1.56')).toBe(false)
    expect(isLocalDevBuild('0.1.56-rc.1')).toBe(false)
    expect(isLocalDevBuild('')).toBe(false)
  })

  it('never overwrites a local build, however far ahead the release is', () => {
    // The regression this exists for: a build labelled with the core it was made level with, then
    // silently replaced mid-session by the very next release.
    expect(semverGt('0.1.57', '0.1.56-dev.a1b2c3d')).toBe(true)
    expect(shouldAutoUpdate('0.1.57', '0.1.56-dev.a1b2c3d')).toBe(false)
    expect(shouldAutoUpdate('9.9.9', '0.1.56-dev.a1b2c3d.dirty')).toBe(false)
  })

  it('leaves a released install on the release train', () => {
    expect(shouldAutoUpdate('0.1.57', '0.1.56')).toBe(true)
    expect(shouldAutoUpdate('0.1.56', '0.1.56')).toBe(false)
    expect(shouldAutoUpdate('0.1.55', '0.1.56')).toBe(false)
  })
})

describe('msUntilSlot', () => {
  const MIN = 60_000
  const at = (second: number, ms = 0) => second * 1000 + ms // some minute boundary + offset

  it('lands on the slot second of the current minute when it is still ahead', () => {
    expect(msUntilSlot(at(10), 45, MIN)).toBe(35_000)
    expect(msUntilSlot(at(44, 999), 45, MIN)).toBe(1)
  })

  it('waits for the next minute once the slot has passed — including exactly on it', () => {
    expect(msUntilSlot(at(45), 45, MIN)).toBe(MIN)
    expect(msUntilSlot(at(50), 45, MIN)).toBe(55_000)
  })

  it('folds the slot into a shorter interval that still divides a minute', () => {
    // 30s interval: slot :45 is 15s past each boundary.
    expect(msUntilSlot(at(0), 45, 30_000)).toBe(15_000)
    expect(msUntilSlot(at(20), 45, 30_000)).toBe(25_000)
  })

  it('is the plain interval without a slot, or with one that cannot align to the clock', () => {
    expect(msUntilSlot(at(10), undefined, MIN)).toBe(MIN)
    expect(msUntilSlot(at(10), -1, MIN)).toBe(MIN)
    expect(msUntilSlot(at(10), 45, 7_000)).toBe(7_000) // 7s does not divide a minute
  })
})

describe('startSelfUpdater', () => {
  const cliSource = Buffer.from('#!/usr/bin/env node\nimport { createRequire } from "module";\nconsole.log(createRequire(import.meta.url) ? "9.9.9" : "nope")\n')
  const notifySource = Buffer.from('export {}\n')
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs = []
  })

  function serveUpdate(): void {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === 'https://updates.test/metadata.json') {
        return new Response(JSON.stringify({
          adapter: {
            version: '9.9.9',
            cli: { url: 'https://updates.test/cli.js', sha256: sha(cliSource) },
            notify: { url: 'https://updates.test/notify.mjs', sha256: sha(notifySource) },
          },
        }))
      }
      if (url === 'https://updates.test/cli.js') return new Response(cliSource)
      if (url === 'https://updates.test/notify.mjs') return new Response(notifySource)
      return new Response('', { status: 404 })
    })
  }

  it('swaps the bytes and awaits onStaged inside ONE withLock section', async () => {
    serveUpdate()
    const dir = tempDir()
    const events: string[] = []
    let stagedResolve: () => void = () => {}
    const stagedDone = new Promise<void>((r) => { stagedResolve = r })
    const poller = startSelfUpdater({
      currentVersion: '1.0.0',
      url: 'https://updates.test/metadata.json',
      key: 'adapter',
      dir,
      intervalMs: 20, // no tick on start any more — the first one is a short interval away
      withLock: async (fn) => {
        events.push('lock')
        try { return await fn() } finally { events.push('unlock') }
      },
      onStaged: async (v) => {
        events.push(`staged:${v}`)
        expect(readFileSync(join(dir, 'cli.js'))).toEqual(cliSource) // swapped BEFORE the handoff runs
        await new Promise((r) => setTimeout(r, 30)) // the handoff takes time…
        events.push('handoff-done')
        stagedResolve()
      },
    })
    await stagedDone
    await new Promise((r) => setTimeout(r, 10))
    poller.stop()
    expect(events).toEqual(['lock', 'staged:9.9.9', 'handoff-done', 'unlock'])
  })

  it('is already stopped when onStaged runs — a handler that defers loses the updater for good', async () => {
    // `done = true` and `stop()` happen BEFORE `onStaged`, so a handler that returns without handing
    // the machine over leaves no timer and no way back. This is why the daemon's boot-time handler
    // always takes over and exits rather than waiting for start-up to finish (`runBootHandoff`).
    serveUpdate()
    const dir = tempDir()
    let staged = 0
    let checks = 0
    const counted = globalThis.fetch as typeof fetch
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).endsWith('metadata.json')) checks++
      return counted(...args)
    })
    const poller = startSelfUpdater({
      currentVersion: '1.0.0',
      url: 'https://updates.test/metadata.json',
      key: 'adapter',
      dir,
      intervalMs: 20,
      onStaged: () => { staged++ },   // deliberately does NOT exit or restart
    })
    await vi.waitFor(() => expect(staged).toBe(1))
    const after = checks
    await new Promise((r) => setTimeout(r, 120)) // six intervals' worth
    poller.stop()
    expect(staged).toBe(1)
    expect(checks, 'the poller never ticks again once a staged build has been handed over').toBe(after)
  })

  it('does not check on start; the first check lands on the slot, the next on the following one', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-15T10:00:10.000Z'))
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ adapter: { version: '1.0.0' } })))
      vi.stubGlobal('fetch', fetchMock)
      const poller = startSelfUpdater({
        currentVersion: '1.0.0',
        url: 'https://updates.test/metadata.json',
        key: 'adapter',
        dir: tempDir(),
        intervalMs: 60_000,
        slotSecond: 45,
        onStaged: () => {},
      })
      await vi.advanceTimersByTimeAsync(34_000)
      expect(fetchMock).not.toHaveBeenCalled() // :44 — not yet
      await vi.advanceTimersByTimeAsync(1_000)
      expect(fetchMock).toHaveBeenCalledTimes(1) // :45
      await vi.advanceTimersByTimeAsync(59_000)
      expect(fetchMock).toHaveBeenCalledTimes(1) // :44 of the next minute
      await vi.advanceTimersByTimeAsync(1_000)
      expect(fetchMock).toHaveBeenCalledTimes(2) // :45 again
      poller.stop()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the schedule alive when a check is still running as the next slot arrives', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-15T10:00:44.000Z'))
      // The first manifest fetch hangs for two minutes (a stalled link); later ones answer at once.
      let release: () => void = () => {}
      const stalled = new Promise<Response>((resolve) => { release = () => resolve(new Response(JSON.stringify({ adapter: { version: '1.0.0' } }))) })
      const fetchMock = vi.fn()
        .mockImplementationOnce(() => stalled)
        .mockImplementation(async () => new Response(JSON.stringify({ adapter: { version: '1.0.0' } })))
      vi.stubGlobal('fetch', fetchMock)
      const poller = startSelfUpdater({
        currentVersion: '1.0.0', url: 'https://updates.test/metadata.json', key: 'adapter', dir: tempDir(),
        intervalMs: 60_000, slotSecond: 45, onStaged: () => {},
      })
      await vi.advanceTimersByTimeAsync(1_000) // :45 — the stalled check starts
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60_000) // next :45 — skipped, still checking
      expect(fetchMock).toHaveBeenCalledTimes(1)
      release()
      await vi.advanceTimersByTimeAsync(60_000) // the :45 after that — the chain is still booked
      expect(fetchMock).toHaveBeenCalledTimes(2)
      poller.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases the lock when onStaged throws', async () => {
    serveUpdate()
    const dir = tempDir()
    const events: string[] = []
    let sawThrow: () => void = () => {}
    const thrown = new Promise<void>((r) => { sawThrow = r })
    const poller = startSelfUpdater({
      currentVersion: '1.0.0',
      url: 'https://updates.test/metadata.json',
      key: 'adapter',
      dir,
      intervalMs: 20, // no tick on start any more — the first one is a short interval away
      withLock: async (fn) => {
        events.push('lock')
        try { return await fn() } finally { events.push('unlock'); sawThrow() }
      },
      onStaged: async () => { throw new Error('teardown I/O fault') },
    })
    await thrown
    poller.stop()
    expect(events).toEqual(['lock', 'unlock'])
  })
})

describe('a rolled-back version', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs = []
  })

  it('is remembered when the update is rolled back, and forgotten when one is kept', () => {
    const dir = tempDir()
    stage(dir, Buffer.from('v1'), Buffer.from('n1'))
    stage(dir, Buffer.from('v2'), Buffer.from('n2'), '2.0.0')
    expect(JSON.parse(readFileSync(join(dir, 'update-pending.json'), 'utf8'))).toMatchObject({ version: '2.0.0' })
    restore(dir)
    expect(readFileSync(join(dir, 'cli.js'), 'utf8')).toBe('v1')
    expect(rejectedVersions(dir)).toEqual(['2.0.0'])
    expect(existsSync(join(dir, 'update-pending.json'))).toBe(false)
    // Nothing pending: a rollback with nothing staged remembers nothing new.
    restore(dir)
    expect(rejectedVersions(dir)).toEqual(['2.0.0'])
    // Installed on purpose and kept: no longer rejected.
    stage(dir, Buffer.from('v2'), Buffer.from('n2'), '2.0.0')
    confirm(dir)
    expect(rejectedVersions(dir)).toEqual([])
    expect(existsSync(join(dir, 'update-pending.json'))).toBe(false)
    stage(dir, Buffer.from('v3'), Buffer.from('n3'), '3.0.0')
    confirm(dir)
    expect(rejectedVersions(dir)).toEqual([])
  })

  it('keeps the last ten, each once, and reads anything else as none', () => {
    const dir = tempDir()
    for (const version of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '3']) {
      stage(dir, Buffer.from('x'), Buffer.from('y'), version)
      restore(dir)
    }
    expect(rejectedVersions(dir)).toEqual(['2', '4', '5', '6', '7', '8', '9', '10', '11', '3'])
    writeFileSync(join(dir, 'update-rejected.json'), '{"not":"a list"}')
    expect(rejectedVersions(dir)).toEqual([])
    writeFileSync(join(dir, 'update-rejected.json'), '["1.0.0", 7, null]')
    expect(rejectedVersions(dir)).toEqual(['1.0.0'])
  })

  it('is never staged again by the background updater, which says so once and waits for a newer build', async () => {
    const cli = Buffer.from('#!/usr/bin/env node\nconsole.log("x")\n')
    const notify = Buffer.from('export {}\n')
    const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
    let offered = '9.9.9'
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/metadata.json')) {
        return new Response(JSON.stringify({ adapter: {
          version: offered,
          cli: { url: 'https://updates.test/cli.js', sha256: sha(cli) },
          notify: { url: 'https://updates.test/notify.mjs', sha256: sha(notify) },
        } }))
      }
      return new Response(url.endsWith('cli.js') ? cli : notify)
    })
    const dir = tempDir()
    writeFileSync(join(dir, 'update-rejected.json'), '["9.9.9"]')
    const logs: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { logs.push(String(line)) })
    const staged: string[] = []
    try {
      const poller = startSelfUpdater({
        currentVersion: '1.0.0', url: 'https://updates.test/metadata.json', key: 'adapter', dir, intervalMs: 10,
        onStaged: (version) => { staged.push(version) },
      })
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(staged).toEqual([])
      expect(logs.filter((line) => line.includes('9.9.9 was rolled back on this machine'))).toHaveLength(1)
      offered = '9.9.10'
      for (let i = 0; i < 100 && !staged.length; i++) await new Promise((resolve) => setTimeout(resolve, 10))
      poller.stop()
      expect(staged).toEqual(['9.9.10'])
      expect(JSON.parse(readFileSync(join(dir, 'update-pending.json'), 'utf8'))).toMatchObject({ version: '9.9.10' })
    } finally { log.mockRestore() }
  })
})

describe('the updater when things go wrong', () => {
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
  const notify = Buffer.from('export {}\n')
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs = []
  })

  function serve(cli: Buffer, onDownload: () => void = () => {}): void {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/metadata.json')) {
        return new Response(JSON.stringify({ adapter: {
          version: '9.9.9',
          cli: { url: 'https://updates.test/cli.js', sha256: sha(cli) },
          notify: { url: 'https://updates.test/notify.mjs', sha256: sha(notify) },
        } }))
      }
      onDownload()
      return new Response(url.endsWith('cli.js') ? cli : notify)
    })
  }

  it('never calls an unreadable version newer', () => {
    expect(semverGt('soon', '1.0.0')).toBe(false)
    expect(semverGt('1.0.0', 'v-next')).toBe(false)
  })

  it('reads an unreachable manifest as none, and refuses a download that fails or does not match', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/metadata.json')) return new Response('', { status: 503 })
      if (url.endsWith('/gone.js')) return new Response('', { status: 404 })
      return new Response('the wrong bytes')
    })
    expect(await fetchManifest('https://updates.test/metadata.json', 'adapter')).toBeNull()
    await expect(downloadVerified({ url: 'https://updates.test/gone.js', sha256: 'x' })).rejects.toThrow('HTTP 404')
    await expect(downloadVerified({ url: 'https://updates.test/cli.js', sha256: sha(Buffer.from('the right bytes')) }))
      .rejects.toThrow('sha256 mismatch')
  })

  it('fails the canary of a build that will not run, or that it cannot even write down', () => {
    const broken = Buffer.from('#!/usr/bin/env node\nprocess.exit(3)\n')
    const dir = tempDir()
    expect(canary(broken, dir)).toBe(false)
    expect(readdirSync(dir), 'the canary cleans up after itself').toEqual([])
    const file = join(dir, 'not-a-folder')
    writeFileSync(file, '')
    expect(canary(Buffer.from('console.log(1)\n'), file)).toBe(false)
  })

  it('skips a build that fails its canary, says why, and stages nothing', async () => {
    serve(Buffer.from('#!/usr/bin/env node\nprocess.exit(3)\n'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = tempDir()
    const errors: string[] = []
    let poller: { stop(): void } | undefined
    // Stopped from the log line itself, so no later check is left running when the test ends.
    vi.spyOn(console, 'error').mockImplementation((line: string) => { errors.push(String(line)); poller?.stop() })
    const staged: string[] = []
    poller = startSelfUpdater({
      currentVersion: '1.0.0', url: 'https://updates.test/metadata.json', key: 'adapter', dir, intervalMs: 10,
      onStaged: (version) => { staged.push(version) },
    })
    await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 5_000 })
    expect(errors[0]).toContain('canary failed for the new build')
    expect(staged).toEqual([])
    expect(readdirSync(dir)).toEqual([])
  })

  it('waits out a busy spawn lock with the build it already verified, and reports any other failure', async () => {
    let downloads = 0
    serve(Buffer.from('#!/usr/bin/env node\nconsole.log("x")\n'), () => { downloads++ })
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => { logs.push(String(line)) })
    vi.spyOn(console, 'error').mockImplementation((line: string) => { logs.push(String(line)) })
    let attempts = 0
    const staged: string[] = []
    startSelfUpdater({
      currentVersion: '1.0.0', url: 'https://updates.test/metadata.json', key: 'adapter', dir: tempDir(), intervalMs: 10,
      withLock: async (fn) => {
        attempts++
        if (attempts === 1) throw new SpawnLockBusyError(null)
        if (attempts === 2) throw new Error('disk full')
        if (attempts === 3) throw 'lock folder vanished' // not an Error: still logged, still retried
        return fn()
      },
      onStaged: (version) => { staged.push(version) },
    })
    // Staging stops the updater for good, so nothing is left running.
    await vi.waitFor(() => expect(staged).toEqual(['9.9.9']), { timeout: 5_000 })
    expect(downloads, 'downloaded once: later checks reuse the bytes already verified').toBe(2)
    expect(logs).toContain('[update] 9.9.9 is ready but the daemon spawn lock is held by an unknown process — trying again next check')
    expect(logs.filter((line) => line === '[update] check failed (will retry):')).toHaveLength(2)
  })
})
