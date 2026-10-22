import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SERVICE_EXIT_RESTART, type UpdaterMessage } from '../harnessd/protocol.js'
import type { startSelfUpdater } from '../lib/selfUpdate.js'
import type { startPtyUpdater } from '../lib/windows/ptyUpdate.js'
import type { startTuiUpdater } from '../tui/update.js'
import { VERSION } from '../version.js'
import { processUpdaterDeps, runUpdaterService, type UpdaterServiceDeps } from './updaterProcess.js'

// A lock someone else holds a moment: what the updater says while it waits for it.
const locked = vi.hoisted(() => [] as string[])
/** What the next lock sections throw instead of running (each once). */
const lockFails = vi.hoisted(() => [] as unknown[])
/** Replacements for the terminal host payload's functions, left to the real ones when unset. */
const payload = vi.hoisted(() => ({} as {
  manifestUrl?: (url: string) => string
  platformKey?: () => string | null
  prepare?: (...args: unknown[]) => Promise<unknown>
}))
const downloaded = vi.hoisted(() => ({ ref: undefined as unknown, limits: undefined as unknown }))
vi.mock('../lib/daemonSpawnLock.js', async (real) => ({
  ...await real<object>(),
  withSpawnLock: async (purpose: string, fn: () => Promise<unknown>, opts: { onWaiting?: (owner: object) => void } = {}) => {
    locked.push(purpose)
    if (lockFails.length) throw lockFails.shift()
    opts.onWaiting?.({ pid: 4242, purpose: 'start', since: Date.now(), startMarker: 'x', token: 't' })
    return fn()
  },
}))

vi.mock('../lib/windows/ptyPayload.js', async (real) => {
  const actual = await real<typeof import('../lib/windows/ptyPayload.js')>()
  return {
    ...actual,
    ptyManifestUrl: (url: string) => (payload.manifestUrl ?? actual.ptyManifestUrl)(url),
    ptyPlatformKey: () => (payload.platformKey ? payload.platformKey() : actual.ptyPlatformKey()),
    preparePtyPayload: (...args: Parameters<typeof actual.preparePtyPayload>) => (payload.prepare ?? actual.preparePtyPayload)(...args),
  }
})
vi.mock('../lib/selfUpdate.js', async (real) => {
  const actual = await real<typeof import('../lib/selfUpdate.js')>()
  return {
    ...actual,
    downloadVerified: async (ref: unknown, limits: unknown) => { downloaded.ref = ref; downloaded.limits = limits; return Buffer.from('zip') },
  }
})

// No process runs from any build: the retirement's table, the same on every host.
vi.mock('../lib/windows/processTable.js', () => ({ windowsProcessRows: async () => [] }))

type CliOptions = Parameters<typeof startSelfUpdater>[0]
type HnOptions = Parameters<typeof startTuiUpdater>[0]
type PtyOptions = Parameters<typeof startPtyUpdater>[0]

/** Run [fn] under a master that judges a terminal host it staged (harnessd/master.ts). */
async function judgingPty(fn: () => Promise<void> | void): Promise<void> {
  const saved = process.env.HARNESSD_JUDGES_PTY
  process.env.HARNESSD_JUDGES_PTY = '1'
  try { await fn() } finally {
    if (saved === undefined) delete process.env.HARNESSD_JUDGES_PTY
    else process.env.HARNESSD_JUDGES_PTY = saved
  }
}

describe('the updater in its own process', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    lockFails.length = 0
    for (const k of Object.keys(payload)) delete (payload as Record<string, unknown>)[k]
  })

  const make = () => {
    const calls: string[] = []
    const told: UpdaterMessage[] = []
    let cli: CliOptions | null = null
    let hn: HnOptions | null = null
    let pty: PtyOptions | null = null
    let sent: (() => void) | null = null
    const ready = { pty: null as string | null, paired: false }
    const deps: UpdaterServiceDeps = {
      tell: (message, done) => { told.push(message); sent = done },
      exit: (code) => { calls.push(`exit ${code}`) },
      startCli: (options) => { cli = options; return { stop: () => calls.push('stop cli') } },
      startHn: (options) => { hn = options; return { stop: () => calls.push('stop hn') } },
      log: (line) => calls.push(line),
    }
    // Windows: the terminal host's poller beside them, in the install root the CLI folder sits in.
    const windows: Partial<UpdaterServiceDeps> = {
      ptyRootDir: join(tmpdir(), 'updater-pty-root'),
      startPty: (options) => {
        pty = options
        return {
          stop: () => calls.push('stop pty'),
          readyToStage: async (forPtyProtocol?: number) => {
            calls.push(`ready for ${forPtyProtocol}`)
            const version = ready.pty
            ready.pty = null
            return version === null ? null : { version, protocol: ready.paired ? 3 : 2, paired: ready.paired }
          },
          readyProtocol: () => (ready.pty ? (ready.paired ? 3 : 2) : null),
          takenBack: () => { calls.push('pty taken back') },
        }
      },
    }
    return { deps, windows, calls, told, ready, cli: () => cli!, hn: () => hn!, pty: () => pty, sent: () => sent! }
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
    const staged = m.cli().onStaged('9.9.9', null) as Promise<void>
    expect(m.told).toEqual([{ type: 'harnessd:staged', version: '9.9.9' }])
    expect(m.calls).not.toContain(`exit ${SERVICE_EXIT_RESTART}`)
    m.sent()()
    await staged
    expect(m.calls).toContain(`exit ${SERVICE_EXIT_RESTART}`)
  })

  it('a PTY-only staging tells the master ptyVersion alone, and the next run checks the CLI', () => judgingPty(async () => {
    const m = make()
    const service = runUpdaterService(undefined, { ...m.deps, ...m.windows })
    expect(m.pty()).toMatchObject({ rootDir: m.windows.ptyRootDir, url: expect.stringMatching(/\/pty\/metadata\.json$/) })
    expect(m.pty()!.key).toMatch(/^win32-(x64|arm64)$/)
    const staged = m.pty()!.onStaged('0.11.0') as Promise<void>
    expect(m.told).toEqual([{ type: 'harnessd:staged', ptyVersion: '0.11.0' }])
    expect(m.calls).not.toContain(`exit ${SERVICE_EXIT_RESTART}`)
    m.sent()()
    await staged
    expect(m.calls).toContain(`exit ${SERVICE_EXIT_RESTART}`)
    service.stop()
    expect(m.calls.slice(-3)).toEqual(['stop cli', 'stop hn', 'stop pty'])
    // The master starts it again at once: that run checks the CLI, and the host, again.
    const next = make()
    runUpdaterService(undefined, { ...next.deps, ...next.windows }).stop()
    expect(next.cli()).toMatchObject({ currentVersion: VERSION })
    expect(next.pty()).not.toBeNull()
  }))

  it('CLI and PTY in one check send one message with both', () => judgingPty(async () => {
    const m = make()
    runUpdaterService(undefined, { ...m.deps, ...m.windows })
    m.ready.pty = '0.11.0'
    // The CLI poller's handover (lib/selfUpdate.ts): under its lock, the host first, then the CLI.
    await m.cli().withLock!(async () => {
      const host = await m.cli().beforeStage!(2)
      const staged = m.cli().onStaged('9.9.9', host?.version ?? null) as Promise<void>
      m.sent()()
      await staged
    })
    expect(m.told).toEqual([{ type: 'harnessd:staged', version: '9.9.9', ptyVersion: '0.11.0' }])
    expect(m.calls.filter((line) => line === `exit ${SERVICE_EXIT_RESTART}`)).toHaveLength(1)
  }))

  it('a host taken into a CLI handover that then fails is still handed over, alone', () => judgingPty(async () => {
    const m = make()
    runUpdaterService(undefined, { ...m.deps, ...m.windows })
    m.ready.pty = '0.11.0'
    const handover = m.cli().withLock!(async () => {
      await m.cli().beforeStage!(2)
      throw new Error('ENOSPC')
    })
    await vi.waitFor(() => expect(m.told).toEqual([{ type: 'harnessd:staged', ptyVersion: '0.11.0' }]))
    m.sent()()
    await expect(handover).rejects.toThrow('ENOSPC')
    expect(m.calls).toContain(`exit ${SERVICE_EXIT_RESTART}`)
  }))

  it('on Windows, sweeps what installs leave under the lock as it starts, with no terminal host poller too', async () => {
    const root = mkdtempSync(join(tmpdir(), 'updater-sweep-'))
    try {
      mkdirSync(join(root, 'bin'))
      mkdirSync(join(root, 'runtime', 'pty', '.staging-1-1'), { recursive: true })
      for (const name of ['harness.exe', 'harness-launch.exe', 'harness.exe.old-1-1']) writeFileSync(join(root, 'bin', name), name)
      // No HARNESSD_JUDGES_PTY: no poller, the sweep all the same.
      const m = make()
      locked.length = 0
      runUpdaterService(undefined, { ...m.deps, ...m.windows, ptyRootDir: root }).stop()
      expect(m.pty()).toBeNull()
      await vi.waitFor(() => expect(readdirSync(join(root, 'bin')).sort()).toEqual(['harness-launch.exe', 'harness.exe']))
      expect(readdirSync(join(root, 'runtime', 'pty'))).toEqual([])
      expect(locked).toContain('handoff')
      // A bin file missing whose aside file cannot be told from a stale one is put back, never swept.
      rmSync(join(root, 'bin', 'harness.exe'))
      writeFileSync(join(root, 'bin', 'harness.exe.old-2-2'), 'last bytes')
      const again = make()
      runUpdaterService(undefined, { ...again.deps, ...again.windows, ptyRootDir: root }).stop()
      await vi.waitFor(() => expect(readFileSync(join(root, 'bin', 'harness.exe'), 'utf8')).toBe('last bytes'))
      expect(again.calls).toContain('[update] put bin\\harness.exe back from harness.exe.old-2-2')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('says when the sweep of the terminal host\'s leftovers cannot run, whatever was thrown', async () => {
    for (const thrown of [new Error('locked'), 'plain']) {
      lockFails.push(thrown)
      const m = make()
      runUpdaterService(undefined, { ...m.deps, ...m.windows }).stop()
      await vi.waitFor(() => expect(m.calls).toContain(`[update] could not sweep the terminal host's leftovers (${thrown instanceof Error ? thrown.message : thrown}) — the next start tries again`))
    }
  })

  it('runs no terminal host poller when the manifest url or the platform has none, and says why for the url', () => judgingPty(() => {
    for (const thrown of [new Error('not a CLI manifest url: x'), 'odd']) {
      payload.manifestUrl = () => { throw thrown }
      const m = make()
      runUpdaterService(undefined, { ...m.deps, ...m.windows }).stop()
      expect(m.pty()).toBeNull()
      expect(m.calls).toContain(`[update] no terminal host updates: ${thrown instanceof Error ? thrown.message : thrown}`)
    }
    delete payload.manifestUrl
    payload.platformKey = () => null
    const other = make()
    runUpdaterService(undefined, { ...other.deps, ...other.windows }).stop()
    expect(other.pty()).toBeNull()
  }))

  it('names the installed build to the host poller, and downloads a host payload with this process\'s limits', () => judgingPty(async () => {
    const plain = make()
    runUpdaterService(undefined, { ...plain.deps, ...plain.windows }).stop()
    expect(plain.pty()!.installedCli()).toBe(VERSION)
    const named = make()
    runUpdaterService(undefined, { ...named.deps, ...named.windows, installedVersion: () => '7.7.7' }).stop()
    expect(named.pty()!.installedCli()).toBe('7.7.7')
    const calls: unknown[][] = []
    payload.prepare = async (...args) => { calls.push(args); await (args[2] as { download(ref: unknown): Promise<unknown> }).download({ url: 'u' }); return 'prepared' }
    const entry = { url: 'https://x/pty.zip', sha256: 'a'.repeat(64), size: 1 } as never
    await expect(named.pty()!.deps!.prepare!(entry, 'runtime-dir', Buffer.from('v'))).resolves.toBe('prepared')
    expect(calls[0]!.slice(0, 2)).toEqual([entry, 'runtime-dir'])
    expect(calls[0]![3]).toEqual(Buffer.from('v'))
    expect(downloaded.ref).toEqual({ url: 'u' })
    expect(downloaded.limits).toMatchObject({ floorBytesPerSecond: expect.any(Number) })
  }))

  it('runs no terminal host poller off Windows, or under a master that would not judge it', async () => {
    const plain = make()
    runUpdaterService(undefined, { ...plain.deps, ...plain.windows }).stop()
    expect(plain.pty()).toBeNull()
    expect(plain.cli().beforeStage).toBeUndefined()
    await judgingPty(() => {
      const linux = make()
      runUpdaterService(undefined, linux.deps).stop()
      expect(linux.cli().beforeStage).toBeUndefined()
    })
    expect(processUpdaterDeps('linux').startPty).toBeUndefined()
    expect(processUpdaterDeps('win32', join(tmpdir(), 'x', 'cli')).ptyRootDir).toBe(join(tmpdir(), 'x'))
  })

  it('a paired host whose build then fails to stage is taken back out, and nothing is handed over', () => judgingPty(async () => {
    // Handed over alone, a CLI-2 master would judge host 3 with a CLI-2 core, likely keep it, and no pane could open.
    const root = mkdtempSync(join(tmpdir(), 'updater-paired-'))
    try {
      const ptyRoot = join(root, 'runtime', 'pty')
      // As readyToStage(3) leaves it: 0.11.0 (protocol 3) in use and on probation, 0.10.0 to go back to.
      for (const version of ['0.10.0', '0.11.0']) {
        mkdirSync(join(ptyRoot, version), { recursive: true })
        for (const name of ['harness-pty.exe', 'harness.exe', 'harness-launch.exe']) writeFileSync(join(ptyRoot, version, name), `${version} ${name}`)
      }
      writeFileSync(join(ptyRoot, 'current-pty'), '0.11.0')
      writeFileSync(join(ptyRoot, 'pty-pending.json'), JSON.stringify({ version: '0.11.0', previous: '0.10.0' }))
      mkdirSync(join(root, 'bin'))
      for (const name of ['harness.exe', 'harness-launch.exe']) writeFileSync(join(root, 'bin', name), `0.11.0 ${name}`)
      const m = make()
      runUpdaterService(undefined, { ...m.deps, ...m.windows, ptyRootDir: root })
      m.ready.pty = '0.11.0'
      m.ready.paired = true
      await expect(m.cli().withLock!(async () => {
        await m.cli().beforeStage!(3)
        throw new Error('ENOSPC')
      })).rejects.toThrow('ENOSPC')
      expect(m.told).toEqual([])
      expect(m.calls).not.toContain(`exit ${SERVICE_EXIT_RESTART}`)
      expect(readFileSync(join(ptyRoot, 'current-pty'), 'utf8').trim()).toBe('0.10.0')
      expect(readFileSync(join(root, 'bin', 'harness.exe'), 'utf8')).toBe('0.10.0 harness.exe')
      expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(false)
      // Nothing was wrong with the host: it pairs with the next build.
      expect(existsSync(join(ptyRoot, 'pty-rejected.json')) ? JSON.parse(readFileSync(join(ptyRoot, 'pty-rejected.json'), 'utf8')) : []).toEqual([])
      expect(m.calls).toContain('[update] terminal host 0.11.0 taken back out with the build it came with — back to 0.10.0')
      // And its poller, finished by that install, checks again (backed off) rather than wait for the next updater start.
      expect(m.calls.indexOf('pty taken back')).toBeGreaterThan(m.calls.indexOf('[update] terminal host 0.11.0 taken back out with the build it came with — back to 0.10.0'))
    } finally { rmSync(root, { recursive: true, force: true }) }
  }))

  it('tells the host poller the protocol the build needs, and the CLI\'s rule what is ready to go in first', () => judgingPty(async () => {
    const m = make()
    runUpdaterService(undefined, { ...m.deps, ...m.windows })
    expect(m.cli().readyPtyProtocol?.()).toBeNull()
    m.ready.pty = '0.11.0'
    m.ready.paired = true
    expect(m.cli().readyPtyProtocol?.()).toBe(3)
    expect(await m.cli().beforeStage?.(3)).toEqual({ version: '0.11.0', protocol: 3 })
    expect(m.calls).toContain('ready for 3')
  }))

  it('holds a CLI build back by the installed host\'s protocol on Windows, whatever the master, and nowhere else', () => {
    // Not gated on HARNESSD_JUDGES_PTY: a build with no host to open a pane on is no fix under any master.
    const win = make()
    runUpdaterService(undefined, { ...win.deps, installedPtyProtocol: () => 2 }).stop()
    expect(win.cli().installedPtyProtocol?.()).toBe(2)
    const linux = make()
    runUpdaterService(undefined, linux.deps).stop()
    expect(linux.cli().installedPtyProtocol).toBeUndefined()
    expect(processUpdaterDeps('linux').installedPtyProtocol).toBeUndefined()
    // No current-pty in this root: nothing to read. The CLI's updater (lib/selfUpdate.ts) counts that as this CLI's own
    // PTY_PROTOCOL on Windows, so a build that needs more is still held back.
    expect(processUpdaterDeps('win32', join(tmpdir(), 'no-such-install', 'cli')).installedPtyProtocol!()).toBeNull()
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
