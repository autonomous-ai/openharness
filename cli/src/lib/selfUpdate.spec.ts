import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canary, isLocalDevBuild, msUntilSlot, semverGt, shouldAutoUpdate, stage, startSelfUpdater } from './selfUpdate.js'

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
