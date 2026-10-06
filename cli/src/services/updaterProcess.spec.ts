import { afterEach, describe, expect, it, vi } from 'vitest'
import { SERVICE_EXIT_RESTART, type UpdaterMessage } from '../harnessd/protocol.js'
import type { startSelfUpdater } from '../lib/selfUpdate.js'
import type { startTuiUpdater } from '../tui/update.js'
import { VERSION } from '../version.js'
import { processUpdaterDeps, runUpdaterService, type UpdaterServiceDeps } from './updaterProcess.js'

// A lock someone else holds a moment: what the updater says while it waits for it.
vi.mock('../lib/daemonSpawnLock.js', async (real) => ({
  ...await real<object>(),
  withSpawnLock: async (_purpose: string, fn: () => Promise<unknown>, opts: { onWaiting?: (owner: object) => void } = {}) => {
    opts.onWaiting?.({ pid: 4242, purpose: 'start', since: Date.now(), startMarker: 'x', token: 't' })
    return fn()
  },
}))

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
