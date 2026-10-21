import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SERVICE_EXIT_RESTART, type UpdaterMessage } from '../harnessd/protocol.js'
import type { startSelfUpdater } from '../lib/selfUpdate.js'
import type { startTuiUpdater } from '../tui/update.js'
import { VERSION } from '../version.js'
import { processUpdaterDeps, runUpdaterService, type UpdaterServiceDeps } from './updaterProcess.js'

// A lock someone else holds a moment: what the updater says while it waits for it.
const locked = vi.hoisted(() => [] as string[])
vi.mock('../lib/daemonSpawnLock.js', async (real) => ({
  ...await real<object>(),
  withSpawnLock: async (purpose: string, fn: () => Promise<unknown>, opts: { onWaiting?: (owner: object) => void } = {}) => {
    locked.push(purpose)
    opts.onWaiting?.({ pid: 4242, purpose: 'start', since: Date.now(), startMarker: 'x', token: 't' })
    return fn()
  },
}))

// No process runs from any build: the retirement's table, the same on every host.
vi.mock('../lib/windows/processTable.js', () => ({ windowsProcessRows: async () => [] }))

type CliOptions = Parameters<typeof startSelfUpdater>[0]
type HnOptions = Parameters<typeof startTuiUpdater>[0]

describe('the updater in its own process', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const make = () => {
    const calls: string[] = []
    const told: UpdaterMessage[] = []
    let cli: CliOptions | null = null
    let hn: HnOptions | null = null
    let sent: (() => void) | null = null
    const deps: UpdaterServiceDeps = {
      tell: (message, done) => { told.push(message); sent = done },
      exit: (code) => { calls.push(`exit ${code}`) },
      startCli: (options) => { cli = options; return { stop: () => calls.push('stop cli') } },
      startHn: (options) => { hn = options; return { stop: () => calls.push('stop hn') } },
      log: (line) => calls.push(line),
    }
    return { deps, calls, told, cli: () => cli!, hn: () => hn!, sent: () => sent! }
  }

  it('checks for this build\'s successor, and hn\'s, on the installed copy, and stops both', () => {
    const m = make()
    const service = runUpdaterService(undefined, m.deps)
    expect(m.cli()).toMatchObject({ currentVersion: VERSION, stageWhileJudged: true })
    expect(m.hn()).toMatchObject({ currentVersion: VERSION, isInstalledCopy: true })
    expect(m.calls[0]).toMatch(new RegExp(`^\\[update\\] self-update on · v${VERSION.replace(/\./g, '\\.')} · every \\d+s`))
    service.stop()
    expect(m.calls.slice(-2)).toEqual(['stop cli', 'stop hn'])
  })

  // G5 / final review R1b-4: a -dev install logged "self-update on" and polled, but never takes an update; after a
  // rollback it named the build it had rolled back. It says which build is installed, and that a development one stays.
  it('says that a development build never takes an update, and names the installed build', () => {
    const dev = make()
    runUpdaterService(undefined, { ...dev.deps, installedVersion: () => '0.4.18-dev.win1' }).stop()
    expect(dev.calls[0]).toBe('[update] self-update off · v0.4.18-dev.win1 is a development build, which never takes an update')
    const pointed = make()
    runUpdaterService(undefined, { ...pointed.deps, installedVersion: () => '9.9.8' }).stop()
    expect(pointed.calls[0]).toMatch(/^\[update\] self-update on · v9\.9\.8 · every \d+s$/)
  })

  it('beside a core, stages over a build on probation only under a master that judges that itself', () => {
    const saved = { beside: process.env.HARNESSD_UPDATER_BESIDE_CORE, judges: process.env.HARNESSD_JUDGES_SUPERSEDED }
    try {
      process.env.HARNESSD_UPDATER_BESIDE_CORE = '1'
      delete process.env.HARNESSD_JUDGES_SUPERSEDED
      const older = make()
      runUpdaterService(undefined, older.deps)
      expect(older.cli().stageWhileJudged).toBe(false)
      process.env.HARNESSD_JUDGES_SUPERSEDED = '1'
      const newer = make()
      runUpdaterService(undefined, newer.deps)
      expect(newer.cli().stageWhileJudged).toBe(true)
    } finally {
      for (const [name, value] of [['HARNESSD_UPDATER_BESIDE_CORE', saved.beside], ['HARNESSD_JUDGES_SUPERSEDED', saved.judges]] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('tells the master what it staged, and only once that has left asks to be started again as the new build', async () => {
    const m = make()
    runUpdaterService(undefined, m.deps)
    const staged = m.cli().onStaged('9.9.9') as Promise<void>
    expect(m.told).toEqual([{ type: 'harnessd:staged', version: '9.9.9' }])
    expect(m.calls).not.toContain(`exit ${SERVICE_EXIT_RESTART}`)
    m.sent()()
    await staged
    expect(m.calls).toContain(`exit ${SERVICE_EXIT_RESTART}`)
  })

  it('stages under the spawn lock, saying who holds it while it waits', async () => {
    const m = make()
    runUpdaterService(undefined, m.deps)
    expect(await m.cli().withLock!(async () => 'staged')).toBe('staged')
    expect(m.calls.at(-1)).toMatch(/^\[update\] waiting — the daemon is .*4242/)
  })

  it('on Windows, retires the older CLI builds as it starts, says when that fails, and does nothing of the kind elsewhere', async () => {
    const retire = vi.fn(async () => [])
    const m = make()
    runUpdaterService(undefined, { ...m.deps, retire })
    expect(retire).toHaveBeenCalledOnce()
    for (const thrown of [new Error('boom'), 'plain']) {
      const failing = make()
      runUpdaterService(undefined, { ...failing.deps, retire: async () => { throw thrown } })
      await new Promise((done) => setImmediate(done))
      expect(failing.calls).toContain(`[update] retiring older CLI builds failed: ${thrown instanceof Error ? thrown.message : thrown}`)
    }
    expect(processUpdaterDeps('linux').retire).toBeUndefined()
    // In a CLI folder of the test's own, never this user's %USERPROFILE%\.harness\cli (on Windows the suite's
    // home is not that folder's: vitest.setup.ts moves HOME, and Windows takes the home from USERPROFILE).
    const root = mkdtempSync(join(tmpdir(), 'updater-retire-'))
    try {
      const cli = join(root, 'cli')
      // No cli\current: nothing proves which build is in use, so nothing is removed.
      mkdirSync(join(cli, '0.4.0'), { recursive: true })
      locked.length = 0
      await expect(processUpdaterDeps('win32', cli).retire!()).resolves.toEqual([])
      // No pointer: the installed build is this process's.
      expect(processUpdaterDeps('win32', cli).installedVersion!()).toBe(VERSION)
      expect(processUpdaterDeps('linux').installedVersion).toBeUndefined()
      // Under the lock a stage takes, so no `harness update` moves the pointer to a folder it removes.
      expect(locked).toEqual(['update'])
      for (const version of ['0.5.0', '0.4.0', '0.3.0']) {
        mkdirSync(join(cli, version), { recursive: true })
        for (const file of ['cli.js', 'notify.mjs']) writeFileSync(join(cli, version, file), version)
      }
      writeFileSync(join(cli, 'current'), '0.5.0\n')
      await expect(processUpdaterDeps('win32', cli).retire!()).resolves.toEqual(['0.3.0'])
      expect(readdirSync(cli).sort()).toEqual(['0.4.0', '0.5.0', 'current'])
      // The build cli\current points to is the installed one, whichever this process runs from.
      expect(processUpdaterDeps('win32', cli).installedVersion!()).toBe('0.5.0')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('reaches the master over the spawn channel, or tells no one when started by hand', () => {
    const deps = processUpdaterDeps()
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    deps.exit(SERVICE_EXIT_RESTART)
    expect(exit).toHaveBeenCalledWith(SERVICE_EXIT_RESTART)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    deps.log('a line')
    expect(log).toHaveBeenCalledWith('a line')
    const original = process.send
    try {
      const sent = vi.fn()
      process.send = undefined
      deps.tell({ type: 'harnessd:staged', version: '9.9.9' }, sent)
      expect(sent).toHaveBeenCalledOnce()
      const send = vi.fn((_message: unknown, callback: () => void) => { callback(); return true })
      process.send = send as unknown as typeof process.send
      const left = vi.fn()
      deps.tell({ type: 'harnessd:staged', version: '9.9.9' }, left)
      expect(send.mock.calls[0][0]).toEqual({ type: 'harnessd:staged', version: '9.9.9' })
      expect(left).toHaveBeenCalledOnce()
    } finally { process.send = original }
    expect(deps.startCli).toBeTypeOf('function')
    expect(deps.startHn).toBeTypeOf('function')
  })
})
