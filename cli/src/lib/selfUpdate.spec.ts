import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REFUSED_RETRY_MAX_MS, canary, confirm, downloadVerified, fetchManifest, isLocalDevBuild, msUntilSlot, rejectedVersions, restore, runCanary, semverGt,
  settleRolledBack, shouldAutoUpdate, stage, startSelfUpdater, unjudgedUpdate,
} from './selfUpdate.js'
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
    // A release says the version it is published as (scripts/upload-cli.sh checks it; so does the canary).
    const cli = Buffer.from('#!/usr/bin/env node\nconsole.log("9.9.10")\n')
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
    expect(errors[0]).toBe('[update] 9.9.9 failed its canary (exit 3) — not trying it again for 20 ms')
    expect(staged).toEqual([])
    expect(readdirSync(dir)).toEqual([])
  })

  it('waits out a busy spawn lock with the build it already verified, and reports any other failure', async () => {
    let downloads = 0
    serve(Buffer.from('#!/usr/bin/env node\nconsole.log("9.9.9")\n'), () => { downloads++ })
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

describe('staging, all or nothing (e2e/updateHostile.e2e.ts)', () => {
  const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs = []
  })

  /** An install holding v1, as the last build kept. */
  const installed = (): string => {
    const dir = tempDir()
    writeFileSync(join(dir, 'cli.js'), 'v1')
    writeFileSync(join(dir, 'notify.mjs'), 'n1')
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n')
    return dir
  }
  const files = (dir: string) => Object.fromEntries(readdirSync(dir).sort().map((name) => {
    const path = join(dir, name)
    return [name, statSync(path).isDirectory() ? '<dir>' : readFileSync(path, 'utf8')]
  }))

  it('backs up with hard links, and notes the update with the sha256 of the cli.js it put in place', () => {
    const dir = installed()
    const before = statSync(join(dir, 'cli.js')).ino
    stage(dir, Buffer.from('v2'), Buffer.from('n2'), '2.0.0')
    expect(statSync(join(dir, 'cli.js.prev')).ino).toBe(before)
    expect(files(dir)).toEqual({
      'cli.js': 'v2', 'cli.js.prev': 'v1', 'notify.mjs': 'n2', 'notify.mjs.prev': 'n1', 'package.json': '{"type":"module"}\n',
      'update-pending.json': expect.stringContaining(`"sha256":"${sha('v2')}"`),
    })
  })

  it('leaves the install exactly as it was when a write fails, at any step', () => {
    for (const blocked of ['cli.js.tmp', 'notify.mjs.tmp', 'update-pending.json.tmp']) {
      const dir = installed()
      // A folder where the file would go: the write fails there, as on a full disk.
      mkdirSync(join(dir, blocked))
      writeFileSync(join(dir, blocked, 'x'), '')
      expect(() => stage(dir, Buffer.from('v2'), Buffer.from('n2'), '2.0.0'), blocked).toThrow()
      expect(files(dir), blocked).toEqual({ 'cli.js': 'v1', 'notify.mjs': 'n1', 'package.json': '{"type":"module"}\n', [blocked]: '<dir>' })
    }
  })

  it('mends a package.json emptied by an earlier write, and leaves a sound one untouched', () => {
    const dir = installed()
    const sound = statSync(join(dir, 'package.json')).ino
    stage(dir, Buffer.from('v2'), Buffer.from('n2'), '2.0.0')
    expect(statSync(join(dir, 'package.json')).ino).toBe(sound)
    writeFileSync(join(dir, 'package.json'), '')
    confirm(dir)
    stage(dir, Buffer.from('v3'), Buffer.from('n3'), '3.0.0')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe('{"type":"module"}\n')
  })

  it('copies the backup whole where the disk has no hard links', async () => {
    vi.resetModules()
    vi.doMock('fs', async (importOriginal) => ({ ...await importOriginal<typeof import('fs')>(), linkSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) } }))
    try {
      const { stage: stageCopying } = await import('./selfUpdate.js')
      const dir = installed()
      const before = statSync(join(dir, 'cli.js')).ino
      stageCopying(dir, Buffer.from('v2'), Buffer.from('n2'), '2.0.0')
      expect(readFileSync(join(dir, 'cli.js.prev'), 'utf8')).toBe('v1')
      expect(statSync(join(dir, 'cli.js.prev')).ino).not.toBe(before)
      expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    } finally {
      vi.doUnmock('fs')
      vi.resetModules()
    }
  })

  it('keeps the last build kept as the backup while the bundle is an update still being judged, so a rollback goes back to it', () => {
    const dir = installed()
    stage(dir, Buffer.from('v2'), Buffer.from('n2'), '2.0.0')
    // v2, on probation, stages v3 before it is kept.
    stage(dir, Buffer.from('v3'), Buffer.from('n3'), '3.0.0')
    expect(readFileSync(join(dir, 'cli.js.prev'), 'utf8')).toBe('v1')
    expect(readFileSync(join(dir, 'notify.mjs.prev'), 'utf8')).toBe('n1')
    restore(dir)
    expect(files(dir)).toEqual({ 'cli.js': 'v1', 'notify.mjs': 'n1', 'package.json': '{"type":"module"}\n', 'update-rejected.json': '["3.0.0"]\n' })
  })

  it('backs up the bundle on disk when it was kept, or when a pending note does not describe it', () => {
    const dir = installed()
    stage(dir, Buffer.from('v2'), Buffer.from('n2'), '2.0.0')
    confirm(dir)
    stage(dir, Buffer.from('v3'), Buffer.from('n3'), '3.0.0')
    expect(readFileSync(join(dir, 'cli.js.prev'), 'utf8')).toBe('v2')
    // A note from a stage before this one recorded what it put in place: it names no bundle.
    writeFileSync(join(dir, 'update-pending.json'), '{"version":"3.0.0","at":1}\n')
    stage(dir, Buffer.from('v4'), Buffer.from('n4'), '4.0.0')
    expect(readFileSync(join(dir, 'cli.js.prev'), 'utf8')).toBe('v3')
    // Nor does one whose backups are gone.
    rmSync(join(dir, 'notify.mjs.prev'))
    stage(dir, Buffer.from('v5'), Buffer.from('n5'), '5.0.0')
    expect(readFileSync(join(dir, 'cli.js.prev'), 'utf8')).toBe('v4')
  })

  it('tells which update the bundle on disk is, while no master has kept or rolled it back', () => {
    const dir = installed()
    expect(unjudgedUpdate(dir, sha('v1'))).toBeNull()
    stage(dir, Buffer.from('v2'), Buffer.from('n2'), '2.0.0')
    expect(unjudgedUpdate(dir, sha('v2'))).toBe('2.0.0')
    expect(unjudgedUpdate(dir, sha('v1'))).toBeNull()
    expect(unjudgedUpdate(dir, null)).toBeNull()
    confirm(dir)
    expect(unjudgedUpdate(dir, sha('v2'))).toBeNull()
    writeFileSync(join(dir, 'update-pending.json'), '{"version":"2.0.0","at":1}\n')
    expect(unjudgedUpdate(dir, sha('v2'))).toBeNull()
  })
})

describe('the canary\'s verdicts', () => {
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs = []
  })

  it('tells a build that failed or names another version from a canary that could not be written', () => {
    const dir = tempDir()
    expect(runCanary(Buffer.from('console.log("9.9.9")\n'), dir, '9.9.9')).toEqual({ ok: true })
    expect(runCanary(Buffer.from('console.log("loading…"); console.log("9.9.9")\n'), dir, '9.9.9')).toEqual({ ok: true })
    expect(runCanary(Buffer.from('console.log("9.9.8")\n'), dir, '9.9.9')).toEqual({ ok: false, problem: 'wrong-version', detail: 'it says it is 9.9.8' })
    expect(runCanary(Buffer.from(''), dir, '9.9.9')).toEqual({ ok: false, problem: 'wrong-version', detail: 'it says it is nothing' })
    expect(runCanary(Buffer.from('process.exit(3)\n'), dir, '9.9.9')).toEqual({ ok: false, problem: 'failed', detail: 'exit 3' })
    expect(runCanary(Buffer.from('process.kill(process.pid, "SIGKILL")\n'), dir)).toEqual({ ok: false, problem: 'failed', detail: 'signal SIGKILL' })
    expect(canary(Buffer.from('console.log("anything")\n'), dir)).toBe(true)
    expect(canary(Buffer.from('console.log("9.9.8")\n'), dir, '9.9.9')).toBe(false)
    const file = join(dir, 'not-a-folder')
    writeFileSync(file, '')
    expect(runCanary(Buffer.from('console.log(1)\n'), file, '1')).toMatchObject({ ok: false, problem: 'unwritable' })
    expect(readdirSync(dir)).toEqual(['not-a-folder'])
  })

  it('says why a canary that never ran failed', async () => {
    vi.resetModules()
    vi.doMock('./nodeRuntime.js', () => ({ managedNodePath: () => '/nonexistent/node' }))
    try {
      const { runCanary: runWithoutNode } = await import('./selfUpdate.js')
      expect(runWithoutNode(Buffer.from('console.log(1)\n'), tempDir(), '1')).toMatchObject({ ok: false, problem: 'failed', detail: expect.stringContaining('ENOENT') })
    } finally {
      vi.doUnmock('./nodeRuntime.js')
      vi.resetModules()
    }
  })
})

describe('a build that fails on its own merits (e2e/updateHostile.e2e.ts)', () => {
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
  const notify = Buffer.from('export {}\n')
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs = []
  })

  /** A manifest naming `cli` (or, with `named`, another sha256 than the bytes served), counting downloads. */
  function serve(state: { cli: Buffer; named?: string; downloads: number }): void {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/metadata.json')) {
        return new Response(JSON.stringify({ adapter: {
          version: '9.9.9',
          cli: { url: 'https://updates.test/cli.js', sha256: state.named ?? sha(state.cli) },
          notify: { url: 'https://updates.test/notify.mjs', sha256: sha(notify) },
        } }))
      }
      if (url.endsWith('cli.js')) { state.downloads++; return new Response(state.cli) }
      return new Response(notify)
    })
  }
  const ticks = (n: number) => new Promise((resolve) => setTimeout(resolve, n * 10 + 5))

  it.each([
    ['whose bytes do not match its manifest', (state: { cli: Buffer; named?: string }) => { state.named = sha(Buffer.from('other bytes')) }, 'does not match its manifest (sha256 mismatch'],
    ['that fails its canary', (state: { cli: Buffer; named?: string }) => { state.cli = Buffer.from('process.exit(3)\n') }, 'failed its canary (exit 3)'],
    ['that says it is another version', (state: { cli: Buffer; named?: string }) => { state.cli = Buffer.from('console.log("9.9.8")\n') }, 'failed its canary (it says it is 9.9.8)'],
  ])('is not downloaded again at every check: a build %s waits two intervals, then four, eight, …', async (_, breakIt, why) => {
    const state = { cli: Buffer.from('console.log("9.9.9")\n'), named: undefined as string | undefined, downloads: 0 }
    breakIt(state)
    serve(state)
    const errors: string[] = []
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation((line: string) => { errors.push(String(line)) })
    let clock = 0
    const staged: string[] = []
    const poller = startSelfUpdater({
      currentVersion: '1.0.0', url: 'https://updates.test/metadata.json', key: 'adapter', dir: tempDir(), intervalMs: 10, now: () => clock,
      onStaged: (version) => { staged.push(version) },
    })
    try {
      await vi.waitFor(() => expect(state.downloads).toBe(1), { timeout: 5_000 })
      await ticks(5)
      expect(state.downloads).toBe(1)
      expect(errors).toEqual([expect.stringContaining(`[update] 9.9.9 ${why}`)])
      expect(errors[0]).toMatch(/— not trying it again for 20 ms$/)
      clock = 20
      await vi.waitFor(() => expect(state.downloads).toBe(2), { timeout: 5_000 })
      await vi.waitFor(() => expect(errors[1]).toMatch(/— not trying it again for 40 ms$/), { timeout: 5_000 })
      clock = 59
      await ticks(5)
      expect(state.downloads).toBe(2)
      // Published again, fixed: a new entry in the manifest is tried at once.
      state.cli = Buffer.from('console.log("9.9.9")\n')
      state.named = undefined
      await vi.waitFor(() => expect(staged).toEqual(['9.9.9']), { timeout: 5_000 })
      expect(state.downloads).toBe(3)
    } finally { poller.stop() }
  })

  it('downloads again at the next check, without waiting, when the network dropped the last download', async () => {
    const cli = Buffer.from('console.log("9.9.9")\n')
    let attempts = 0
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/metadata.json')) {
        return new Response(JSON.stringify({ adapter: {
          version: '9.9.9',
          cli: { url: 'https://updates.test/cli.js', sha256: sha(cli) },
          notify: { url: 'https://updates.test/notify.mjs', sha256: sha(notify) },
        } }))
      }
      if (url.endsWith('cli.js') && ++attempts <= 2) throw new TypeError('terminated')
      return new Response(url.endsWith('cli.js') ? cli : notify)
    })
    const errors: string[] = []
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')) })
    const staged: string[] = []
    const poller = startSelfUpdater({
      currentVersion: '1.0.0', url: 'https://updates.test/metadata.json', key: 'adapter', dir: tempDir(), intervalMs: 10, now: () => 0,
      onStaged: (version) => { staged.push(version) },
    })
    try {
      await vi.waitFor(() => expect(staged).toEqual(['9.9.9']), { timeout: 5_000 })
      expect(attempts).toBe(3)
      expect(errors).toEqual(['[update] check failed (will retry): terminated', '[update] check failed (will retry): terminated'])
    } finally { poller.stop() }
  })

  it('waits at most an hour, however long the build stays broken', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const state = { cli: Buffer.from('process.exit(3)\n'), downloads: 0 }
      serve(state)
      const errors: string[] = []
      vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation((line: string) => { errors.push(String(line)) })
      // The real interval: ten minutes.
      const poller = startSelfUpdater({
        currentVersion: '1.0.0', url: 'https://updates.test/metadata.json', key: 'adapter', dir: tempDir(), intervalMs: 600_000,
        onStaged: () => {},
      })
      for (const [tries, wait] of [[1, '1200 s'], [2, '2400 s'], [3, '3600 s'], [4, '3600 s']] as const) {
        while (errors.length < tries) await vi.advanceTimersByTimeAsync(600_000)
        expect(errors[tries - 1]).toMatch(new RegExp(`not trying it again for ${wait}$`))
      }
      expect(state.downloads).toBe(4)
      expect(REFUSED_RETRY_MAX_MS).toBe(3_600_000)
      poller.stop()
    } finally { vi.useRealTimers() }
  })

  it('writes the canary again at the next check when it could not, without downloading the build again', async () => {
    const state = { cli: Buffer.from('console.log("9.9.9")\n'), downloads: 0 }
    serve(state)
    const errors: string[] = []
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation((line: string) => { errors.push(String(line)) })
    const dir = tempDir()
    // The install folder is not a folder: the canary cannot be written there, as on a full disk.
    const install = join(dir, 'install')
    writeFileSync(install, '')
    const staged: string[] = []
    const poller = startSelfUpdater({
      currentVersion: '1.0.0', url: 'https://updates.test/metadata.json', key: 'adapter', dir: install, intervalMs: 10,
      onStaged: (version) => { staged.push(version) },
    })
    try {
      await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(2), { timeout: 5_000 })
      expect(errors[0]).toMatch(/^\[update\] could not write the canary for 9\.9\.9 \(.+\) — trying again next check$/)
      rmSync(install)
      await vi.waitFor(() => expect(staged).toEqual(['9.9.9']), { timeout: 5_000 })
      expect(state.downloads).toBe(1)
    } finally { poller.stop() }
  })
})

describe('a rollback a full disk kept from being remembered (e2e/updateHostile.e2e.ts)', () => {
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs = []
  })

  /** v2 staged over v1 and rolled back while the rejected list could not be written. */
  const rolledBackUnremembered = (): string => {
    const dir = tempDir()
    writeFileSync(join(dir, 'cli.js'), 'v1')
    writeFileSync(join(dir, 'notify.mjs'), 'n1')
    stage(dir, Buffer.from('v2'), Buffer.from('n2'), '2.0.0')
    // Where the list's temporary file would go, a folder: its write fails, as on a full disk.
    mkdirSync(join(dir, 'update-rejected.json.tmp'))
    restore(dir)
    return dir
  }

  it('keeps the note of the build that failed, and puts it on the list once it can', () => {
    const dir = rolledBackUnremembered()
    expect(readFileSync(join(dir, 'cli.js'), 'utf8')).toBe('v1')
    expect(rejectedVersions(dir)).toEqual([])
    // Still no room: named all the same.
    expect(settleRolledBack(dir)).toBe('2.0.0')
    expect(existsSync(join(dir, 'update-pending.json'))).toBe(true)
    rmSync(join(dir, 'update-rejected.json.tmp'), { recursive: true })
    expect(settleRolledBack(dir)).toBe('2.0.0')
    expect(rejectedVersions(dir)).toEqual(['2.0.0'])
    expect(existsSync(join(dir, 'update-pending.json'))).toBe(false)
    expect(settleRolledBack(dir)).toBeNull()
    // Already on the list: the note only goes.
    writeFileSync(join(dir, 'update-pending.json'), JSON.stringify({ version: '2.0.0', sha256: sha(Buffer.from('v2')), at: 1 }))
    expect(settleRolledBack(dir)).toBe('2.0.0')
    expect(rejectedVersions(dir)).toEqual(['2.0.0'])
    // The note of an update still being judged names the bundle on disk; one from before notes named none.
    stage(dir, Buffer.from('v3'), Buffer.from('n3'), '3.0.0')
    expect(settleRolledBack(dir)).toBeNull()
    writeFileSync(join(dir, 'update-pending.json'), '{"version":"3.0.0","at":1}\n')
    expect(settleRolledBack(dir)).toBeNull()
  })

  it('is never staged by the background updater meanwhile', async () => {
    const dir = rolledBackUnremembered()
    const cli = Buffer.from('console.log("2.0.0")\n')
    const notify = Buffer.from('export {}\n')
    let downloads = 0
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/metadata.json')) {
        return new Response(JSON.stringify({ adapter: {
          version: '2.0.0',
          cli: { url: 'https://updates.test/cli.js', sha256: sha(cli) },
          notify: { url: 'https://updates.test/notify.mjs', sha256: sha(notify) },
        } }))
      }
      downloads++
      return new Response(url.endsWith('cli.js') ? cli : notify)
    })
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => { logs.push(String(line)) })
    const staged: string[] = []
    const poller = startSelfUpdater({
      currentVersion: '1.0.0', url: 'https://updates.test/metadata.json', key: 'adapter', dir, intervalMs: 10,
      onStaged: (version) => { staged.push(version) },
    })
    try {
      await vi.waitFor(() => expect(logs).toContain('[update] 2.0.0 was rolled back on this machine — waiting for a newer build (`harness update` installs it anyway)'), { timeout: 5_000 })
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(staged).toEqual([])
      expect(downloads).toBe(0)
    } finally { poller.stop() }
  })
})
