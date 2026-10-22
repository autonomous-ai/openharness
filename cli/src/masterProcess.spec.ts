import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from './config/env.js'
import { PROBE_ANSWER } from './harnessd/reexec.js'
import { LEAN_ENTRY, leanFingerprint, type LeanBundle } from './harnessd/leanBundle.js'
import { DAEMON_LOG_FILE, PID_FILE } from './lib/daemonState.js'
import { launchDetached } from './lib/windows/launcher.js'
import { PTY_PROTOCOL } from './lib/ptyHost/protocol.js'
import type { WindowsMasterDeps } from './masterProcess.js'

const runMaster = vi.hoisted(() => vi.fn((_config: Record<string, unknown>) => 'supervisor'))
vi.mock('./harnessd/master.js', async (real) => ({ ...await real<object>(), runMaster }))
const leanBundle = vi.hoisted(() => ({ read: vi.fn((_bundle: Buffer): LeanBundle | null => null) }))
vi.mock('./harnessd/leanBundle.js', async (real) => ({ ...await real<object>(), readLeanBundle: (bundle: Buffer) => leanBundle.read(bundle) }))
const spawnLock = vi.hoisted(() => ({
  acquire: vi.fn(async (..._args: unknown[]): Promise<() => void> => () => {}),
  sync: vi.fn((..._args: unknown[]): (() => void) | null => () => {}),
}))
const socket = vi.hoisted(() => ({ none: false }))
vi.mock('./lib/localSocket.js', async (real) => {
  const actual = await real<typeof import('./lib/localSocket.js')>()
  return { ...actual, unixSocketPath: (...args: Parameters<typeof actual.unixSocketPath>) => socket.none ? null : actual.unixSocketPath(...args) }
})
vi.mock('./lib/daemonSpawnLock.js', async (real) => ({
  ...await real<object>(),
  acquireSpawnLock: (...args: unknown[]) => spawnLock.acquire(...args),
  tryAcquireSpawnLockSync: (...args: unknown[]) => spawnLock.sync(...args),
}))

const {
  BUNDLE_ENV, BUNDLE_SHA256_ENV, HANDOVER_LAUNCH_TIMEOUT_MS, HANDOVER_LOCK_WAIT_MS, LEAN_DIR, LEAN_FINGERPRINT_ENV, LEAN_OFF_FILE, handoverAlive, masterEnv, probeLean,
  probeThisMaster, processBundleDeps, processWindowsMasterDeps, readHandoverPid, startMaster, startMasterFromBundle, startMasterInForeground, windowsMaster, writeFatalTo,
} = await import('./masterProcess.js')
type Deps = Parameters<typeof startMasterFromBundle>[1] & object

const LEAN: LeanBundle = { files: new Map([[LEAN_ENTRY, Buffer.from('lean')]]), sha256: 'a'.repeat(64), bundleSha256: 'b'.repeat(64) }
const PRINT = leanFingerprint(LEAN)

function deps(over: Partial<Deps> = {}) {
  const calls = { starts: [] as unknown[], execs: [] as Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }>, logs: [] as string[], probes: [] as Array<{ path: string; env: NodeJS.ProcessEnv }> }
  const given: Deps = {
    env: { HOME: '/home/someone' },
    leanOff: () => false,
    exists: () => true,
    read: () => Buffer.from('cli.js'),
    write: () => '/data/lean/harnessd-aaaa.mjs',
    probe: (path, env) => { calls.probes.push({ path, env }); return { ok: true, detail: PROBE_ANSWER } },
    execve: (file, args, env) => { calls.execs.push({ file, args, env }) },
    start: (start) => { calls.starts.push(start) },
    log: (line) => { calls.logs.push(line) },
    ...over,
  }
  return { given, calls }
}

describe('a master started on cli.js', () => {
  beforeEach(() => { leanBundle.read.mockReset().mockReturnValue(LEAN) })

  it('re-executes, same pid, on the lean bundle cli.js carries, once that bundle answers its probe', () => {
    const { given, calls } = deps()
    startMasterFromBundle('/cli/cli.js', given)
    const handed = { HOME: '/home/someone', [BUNDLE_ENV]: '/cli/cli.js', [BUNDLE_SHA256_ENV]: 'b'.repeat(64), [LEAN_FINGERPRINT_ENV]: PRINT }
    expect(calls.probes).toEqual([{ path: '/data/lean/harnessd-aaaa.mjs', env: handed }])
    expect(calls.execs).toEqual([{ file: process.execPath, args: [process.execPath, ...process.execArgv, '/data/lean/harnessd-aaaa.mjs', '__harnessd'], env: handed }])
    expect(calls.starts).toEqual([])
    expect(calls.logs).toEqual([])
  })

  it('re-executes through the node it is given — the managed one, named harnessd — and checks it is there first', () => {
    const named = '/rt/node-v1/libexec/harnessd/harnessd'
    const { given, calls } = deps({ node: () => named })
    startMasterFromBundle('/cli/cli.js', given)
    expect(calls.execs.map(({ file, args }) => [file, args[0]])).toEqual([[named, named]])
    const gone = deps({ node: () => named, exists: (path) => path !== named })
    startMasterFromBundle('/cli/cli.js', gone.given)
    expect(gone.calls.execs).toEqual([])
    expect(gone.calls.logs).toEqual([expect.stringContaining(`${named} is not there to re-execute on`)])
  })

  it('runs from cli.js, with the services still from the lean bundle, where this Node cannot re-execute', () => {
    const { given, calls } = deps({ execve: null })
    startMasterFromBundle('/cli/cli.js', given)
    expect(calls.starts).toEqual([{ scriptPath: '/cli/cli.js', serviceScriptPath: '/data/lean/harnessd-aaaa.mjs', leanFingerprint: PRINT }])
    expect(calls.logs).toEqual(['[harnessd] this Node cannot re-execute the master: it runs from /cli/cli.js, the core and the services from /data/lean/harnessd-aaaa.mjs'])
    const failing = deps({ execve: () => { throw new Error('E2BIG') } })
    startMasterFromBundle('/cli/cli.js', failing.given)
    expect(failing.calls.starts).toEqual([{ scriptPath: '/cli/cli.js', serviceScriptPath: '/data/lean/harnessd-aaaa.mjs', leanFingerprint: PRINT }])
    expect(failing.calls.logs[0]).toContain('could not re-execute on /data/lean/harnessd-aaaa.mjs (E2BIG)')
    const thrown = deps({ execve: () => { throw 'refused' } })
    startMasterFromBundle('/cli/cli.js', thrown.given)
    expect(thrown.calls.logs[0]).toContain('(refused)')
  })

  it('never execs onto a node binary or a lean bundle that is not there: that exec could not be caught', () => {
    // On Node 22.23 an exec of a missing node binary aborts the master (exit 134) and one onto a missing
    // script ends it in the new image (MODULE_NOT_FOUND): neither reaches the catch.
    for (const gone of [process.execPath, '/data/lean/harnessd-aaaa.mjs']) {
      const { given, calls } = deps({ exists: (path) => path !== gone })
      startMasterFromBundle('/cli/cli.js', given)
      expect(calls.execs).toEqual([])
      expect(calls.starts).toEqual([{ scriptPath: '/cli/cli.js' }])
      expect(calls.logs).toEqual([`[harnessd] ${gone} is not there to re-execute on: the master, the core and the services run from /cli/cli.js`])
    }
  })

  it('runs everything from cli.js while the lean-off file is in the data folder: a switch a launchd or systemd master sees', () => {
    const { given, calls } = deps({ leanOff: () => true })
    startMasterFromBundle('/cli/cli.js', given)
    expect(calls.starts).toEqual([{ scriptPath: '/cli/cli.js' }])
    expect(calls.probes).toEqual([])
    expect(calls.logs).toEqual([`[harnessd] ${LEAN_OFF_FILE} is there: the master, the core and the services run from /cli/cli.js`])
  })

  it('runs everything from cli.js when the lean bundle is not there to use, and says why', () => {
    const cases: Array<[Partial<Deps>, string]> = [
      [{ probe: () => ({ ok: false, detail: 'SyntaxError' }) }, 'did not answer its probe (SyntaxError)'],
      [{ write: () => { throw new Error('ENOSPC') } }, 'could not be written out (ENOSPC)'],
      [{ read: () => { throw 'EACCES' } }, 'could not be written out (EACCES)'],
    ]
    for (const [over, said] of cases) {
      const { given, calls } = deps(over)
      startMasterFromBundle('/cli/cli.js', given)
      expect(calls.starts).toEqual([{ scriptPath: '/cli/cli.js' }])
      expect(calls.execs).toEqual([])
      expect(calls.logs[0]).toContain(said)
    }
    leanBundle.read.mockReturnValue(null)
    const none = deps()
    startMasterFromBundle('/cli/cli.js', none.given)
    expect(none.calls.starts).toEqual([{ scriptPath: '/cli/cli.js' }])
    expect(none.calls.logs).toEqual(['[harnessd] no lean bundle in /cli/cli.js: the master, the core and the services run from it'])
  })

  it('runs everything from cli.js, quietly, with HARNESSD_LEAN=off', () => {
    const { given, calls } = deps({ env: { HARNESSD_LEAN: 'off' } })
    startMasterFromBundle('/cli/cli.js', given)
    expect(calls.starts).toEqual([{ scriptPath: '/cli/cli.js' }])
    expect(calls.logs).toEqual([])
    expect(calls.probes).toEqual([])
  })

  it('acts on this process by default', () => {
    const real = processBundleDeps()
    expect(real.env).toBe(process.env)
    expect(real.leanOff()).toBe(false)
    expect(real.exists(process.execPath)).toBe(true)
    expect(real.start).toBe(startMaster)
    expect(real.platform).toBe(process.platform)
    expect(real.read(__filename).length).toBeGreaterThan(0)
    // The data folder is a test's own (vitest.setup.ts).
    const written = real.write(LEAN)
    expect(written.startsWith(LEAN_DIR)).toBe(true)
    expect(real.probe(written, process.env).ok).toBe(false)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    real.log('[harnessd] a line')
    expect(log.mock.calls[0][0]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \[harnessd\] a line$/)
    log.mockRestore()
  })
})

describe('the master on Windows', () => {
  beforeEach(() => { leanBundle.read.mockReset().mockReturnValue(LEAN) })

  it('runs from cli.js alone: the lean bundle relies on hard links, which Windows does not give it', () => {
    const { given, calls } = deps({ platform: 'win32' })
    startMasterFromBundle('C:\\h\\cli\\0.5.0\\cli.js', given)
    expect(calls.starts).toEqual([{ scriptPath: 'C:\\h\\cli\\0.5.0\\cli.js' }])
    expect(calls.probes).toEqual([])
    expect(calls.execs).toEqual([])
  })

  const windowsDeps = (over: Partial<WindowsMasterDeps> = {}) => {
    const seen = { launches: [] as unknown[][], redirected: [] as number[], fatal: [] as number[] }
    // Posix paths: the test runs on macOS, and the path module there splits on `/` (the Windows comparison
    // itself, `isInstalledCopy`, reads either separator).
    const given: WindowsMasterDeps = {
      cliDir: '/h/cli',
      currentCli: () => ({ cliJs: '/h/cli/0.5.1/cli.js' }),
      exists: () => true,
      openLog: () => 42,
      redirect: (fd) => { seen.redirected.push(fd) },
      isTTY: false,
      launch: async (...args) => { seen.launches.push(args); return { ok: false, detail: 'exit 3' } },
      lock: async () => () => {},
      readPid: () => null, alive: () => false,
      fatal: (fd) => { seen.fatal.push(fd) },
      ...over,
    }
    return { given, seen }
  }

  it('stops by message, starts its children from cli\\current, writes the daemon log itself and hands over through the launcher', async () => {
    const { given, seen } = windowsDeps()
    const config = windowsMaster('/h/cli/0.5.0/cli.js', given)
    expect(config.stopByMessage).toBe(true)
    expect(config.output).toBe(42)
    expect(seen.redirected).toEqual([42])
    // An error that ends the master is written there too: harness-launch.exe gave it no stderr to print it on.
    expect(seen.fatal).toEqual([42])
    expect(config.currentScript!()).toBe('/h/cli/0.5.1/cli.js')
    await expect(config.handOver!.launch({ A: '1' })).resolves.toBe('exit 3')
    // Bounded well inside the 45 s a `harness stop` waits on the spawn lock: a stop during a handover waits on it.
    expect(seen.launches).toEqual([[join('/h', 'bin', 'harness-launch.exe'), '/h', ['__harnessd'], { A: '1' }, undefined, HANDOVER_LAUNCH_TIMEOUT_MS]])
    expect(seen.launches[0]).toHaveLength(6)
    expect(HANDOVER_LAUNCH_TIMEOUT_MS).toBe(10_000)
    const ok = windowsDeps({ launch: async () => ({ ok: true }) })
    await expect(windowsMaster('/h/cli/0.5.0/cli.js', ok.given).handOver!.launch({})).resolves.toBeNull()
    expect(config.handOver!.token()).toMatch(/^[0-9a-f]{32}$/)
    // Fresh for every handover.
    expect(config.handOver!.token()).not.toBe(config.handOver!.token())
  })

  it('hands the handover its lock, its pid file reader, its liveness and its pause as given', async () => {
    const release = () => {}
    const { given } = windowsDeps({ lock: async () => release, readPid: () => 7, alive: (pid) => pid === 7 })
    const handOver = windowsMaster('/h/cli/0.5.0/cli.js', given).handOver!
    await expect(handOver.lock()).resolves.toBe(release)
    expect(handOver.readPid()).toBe(7)
    expect([handOver.alive(7), handOver.alive(8)]).toEqual([true, false])
    vi.useFakeTimers()
    try {
      let done = false
      void handOver.sleep(250).then(() => { done = true })
      await vi.advanceTimersByTimeAsync(249)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(done).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('keeps a checkout\'s build, has no launcher to hand over through, and writes nothing for a terminal', () => {
    const dev = windowsMaster('/work/oh/cli/dist/cli.js', windowsDeps().given)
    expect(dev.currentScript).toBeUndefined()
    expect(dev.handOver).toBeUndefined()
    expect(windowsMaster('/h/cli/0.5.0/cli.js', windowsDeps({ exists: () => false }).given).handOver).toBeUndefined()
    const terminal = windowsDeps({ isTTY: true })
    expect(windowsMaster('/h/cli/0.5.0/cli.js', terminal.given).output).toBeUndefined()
    expect(terminal.seen.redirected).toEqual([])
    expect(terminal.seen.fatal).toEqual([])
    expect(windowsMaster('/h/cli/0.5.0/cli.js', windowsDeps({ currentCli: () => null }).given).currentScript!()).toBeNull()
  })

  it('runs without a log when the log cannot be opened, rather than end with no trace', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const lost = windowsDeps({ openLog: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) } })
      const config = windowsMaster('/h/cli/0.5.0/cli.js', lost.given)
      expect(config.output).toBeUndefined()
      expect(config).not.toHaveProperty('output')
      expect(config.stopByMessage).toBe(true)
      expect(lost.seen.redirected).toEqual([])
      expect(lost.seen.fatal).toEqual([])
      expect(error).toHaveBeenCalledWith(expect.stringContaining('could not open the daemon log (EACCES: permission denied)'))
    } finally { error.mockRestore() }
  })

  it('is what startMaster runs on Windows, and nothing of it elsewhere', () => {
    runMaster.mockClear()
    startMaster({ scriptPath: '/cli/cli.js' }, () => {}, 'win32', () => ({ stopByMessage: true }))
    expect(runMaster.mock.calls[0]![0]).toMatchObject({ stopByMessage: true, scriptPath: '/cli/cli.js' })
    startMaster({ scriptPath: '/cli/cli.js' }, () => {}, 'darwin', () => { throw new Error('never on macOS') })
    expect(runMaster.mock.calls[1]![0]).not.toHaveProperty('stopByMessage')
    // mac and Linux: the config is the one it always was, with none of the Windows fields.
    for (const platform of ['darwin', 'linux'] as const) {
      runMaster.mockClear()
      startMaster({ scriptPath: '/cli/cli.js' }, () => {}, platform, () => { throw new Error('never here') })
      const keys = Object.keys(runMaster.mock.calls[0]![0])
      for (const windowsOnly of ['currentScript', 'handOver', 'stopByMessage', 'output']) expect(keys).not.toContain(windowsOnly)
    }
  })

  it('redirects the console before the master says anything: its first line, too, reaches the daemon log', () => {
    const order: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation(() => { order.push('log') })
    // No Unix socket, as on Windows every time: masterEnv says the services run in the core's process.
    socket.none = true
    try {
      runMaster.mockClear()
      startMaster({ scriptPath: '/cli/cli.js' }, () => {}, 'win32', () => { order.push('redirect'); return {} })
      expect(order).toEqual(['redirect', 'log'])
      // In the words for Windows: startMaster hands masterEnv its platform.
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/\[harnessd\] on Windows the services run in the core's process$/))
    } finally { log.mockRestore(); socket.none = false }
  })

  describe('as this process runs it', () => {
    let dir: string
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'windows-master-')) })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('writes every console line to the log it opened, and a failed write never throws', () => {
      const real = processWindowsMasterDeps()
      expect(real.cliDir).toBe(env.ADAPTER_CLI_DIR)
      expect(real.isTTY).toBe(!!process.stdout.isTTY)
      expect(real.launch).toBe(launchDetached)
      expect(real.exists(process.execPath)).toBe(true)
      expect(real.currentCli(dir)).toBeNull()
      mkdirSync(env.ADAPTER_DATA_DIR, { recursive: true })
      const opened = real.openLog()
      closeSync(opened)
      expect(existsSync(DAEMON_LOG_FILE)).toBe(true)
      const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error }
      try {
        const file = join(dir, 'harness.log')
        const fd = openSync(file, 'a')
        real.redirect(fd)
        console.log('one %s', 'line')
        console.info('two')
        console.warn('three', 3)
        console.error(new Error('four').message)
        closeSync(fd)
        expect(readFileSync(file, 'utf8')).toBe('one line\ntwo\nthree 3\nfour\n')
        // The fd is closed now: the line is lost, the master goes on.
        expect(() => console.log('lost')).not.toThrow()
        expect(() => console.error('lost')).not.toThrow()
      } finally { Object.assign(console, saved) }
    })

    it('writes an error that ends the master to the log, then exits 1 as Node would have', () => {
      const file = join(dir, 'harness.log')
      const fd = openSync(file, 'a')
      const listeners = new Map<string, (error: unknown) => void>()
      const exits: number[] = []
      writeFatalTo(fd, (event, listener) => { listeners.set(event, listener) }, (code) => { exits.push(code) })
      expect([...listeners.keys()]).toEqual(['uncaughtException', 'unhandledRejection'])
      listeners.get('uncaughtException')!(new Error('boom'))
      listeners.get('unhandledRejection')!('a reason that is no Error')
      closeSync(fd)
      const text = readFileSync(file, 'utf8')
      expect(text).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \[harnessd\] the master stopped on an uncaught error: Error: boom\n    at /)
      expect(text).toContain('[harnessd] the master stopped on an unhandled rejection: a reason that is no Error\n')
      expect(exits).toEqual([1, 1])
      // A log it can no longer write costs the line, never the exit.
      listeners.get('uncaughtException')!(new Error('again'))
      expect(exits).toEqual([1, 1, 1])
      // As this process runs it: on this process, through process.exit.
      const on = vi.spyOn(process, 'on').mockImplementation((() => process) as never)
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
      try {
        processWindowsMasterDeps().fatal(fd)
        expect(on.mock.calls.map(([event]) => event)).toEqual(['uncaughtException', 'unhandledRejection'])
        ;(on.mock.calls[0]![1] as (error: unknown) => void)(new Error('real'))
        expect(exit).toHaveBeenCalledWith(1)
      } finally { on.mockRestore(); exit.mockRestore() }
    })

    it('takes the spawn lock as a handoff, waiting 5 s at most, and reads busy for any failure', async () => {
      const real = processWindowsMasterDeps()
      const release = () => {}
      spawnLock.acquire.mockReset().mockResolvedValueOnce(release).mockRejectedValueOnce(new Error('busy'))
      await expect(real.lock()).resolves.toBe(release)
      expect(spawnLock.acquire).toHaveBeenCalledWith('handoff', { waitMs: HANDOVER_LOCK_WAIT_MS })
      expect(HANDOVER_LOCK_WAIT_MS).toBe(5_000)
      await expect(real.lock()).resolves.toBeNull()
      // The pid file and liveness as a handover reads them (below), on this process's files.
      mkdirSync(env.ADAPTER_DATA_DIR, { recursive: true })
      writeFileSync(PID_FILE, `${process.pid}\n`)
      try { expect(real.readPid()).toBe(process.pid) } finally { rmSync(PID_FILE, { force: true }) }
      expect(real.readPid()).toBeNull()
      expect(real.alive(process.pid)).toBe(true)
    })

    it('reads the pid file for a handover: null when it names no pid, a throw when it cannot be read', () => {
      const file = join(dir, 'adapter.pid')
      expect(readHandoverPid(file)).toBeNull()
      writeFileSync(file, '1234\n')
      expect(readHandoverPid(file)).toBe(1234)
      for (const text of ['', 'pid', '0', '-5']) {
        writeFileSync(file, text)
        expect(readHandoverPid(file)).toBeNull()
      }
      // A folder where the file should be: not readable, which a handover must not take for "no master".
      rmSync(file)
      mkdirSync(file)
      expect(() => readHandoverPid(file)).toThrow()
      const fail = Object.assign(new Error('busy'), { code: 'EBUSY' })
      expect(() => readHandoverPid(file, () => { throw fail })).toThrow(fail)
    })

    it('reads a process as alive or ended only when it knows: anything else is a throw, never an end', () => {
      expect(handoverAlive(process.pid)).toBe(true)
      const fail = (code: string) => () => { throw Object.assign(new Error(code), { code }) }
      expect(handoverAlive(1234, fail('ESRCH'))).toBe(false)
      // Another account's: it runs.
      expect(handoverAlive(1234, fail('EPERM'))).toBe(true)
      expect(() => handoverAlive(1234, fail('EIO'))).toThrow('EIO')
      for (const pid of [0, -1, 1.5]) expect(handoverAlive(pid)).toBe(false)
    })
  })
})

describe('the probe of a lean bundle', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lean-probe-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const script = (body: string): string => {
    const path = join(dir, `${Math.random().toString(36).slice(2)}.mjs`)
    writeFileSync(path, body)
    return path
  }

  it('passes when it answers as a master would, and says why it did not otherwise', () => {
    expect(probeLean(script(`if (process.argv[2] === '__harnessd-probe' && process.env.HANDED === 'yes') console.log(${JSON.stringify(PROBE_ANSWER)})`), { ...process.env, HANDED: 'yes' }))
      .toEqual({ ok: true, detail: PROBE_ANSWER })
    expect(probeLean(script(`console.error('it broke'); process.exit(3)`), process.env)).toEqual({ ok: false, detail: 'it broke' })
    expect(probeLean(script(`console.log('something else')`), process.env)).toEqual({ ok: false, detail: 'something else' })
    expect(probeLean(script(''), process.env)).toEqual({ ok: false, detail: 'exit 0' })
    expect(probeLean(script(`process.kill(process.pid, 'SIGKILL')`), process.env)).toEqual({ ok: false, detail: 'signal SIGKILL' })
    expect(probeLean(script('setInterval(() => {}, 1000)'), process.env, 200).ok).toBe(false)
  })
})

describe('starting the master', () => {
  it('runs it on the paths it is given, with the daemon\'s files and update backups', () => {
    runMaster.mockClear()
    expect(startMaster({ scriptPath: '/cli/cli.js', serviceScriptPath: '/lean.mjs', bundleFingerprint: 'f' })).toBe('supervisor')
    const config = runMaster.mock.calls[0][0] as Record<string, unknown> & { restoreUpdate(): void; confirmUpdate(): void }
    expect(config).toMatchObject({ scriptPath: '/cli/cli.js', serviceScriptPath: '/lean.mjs', bundleFingerprint: 'f', nodePath: process.execPath })
    expect(String(config.reexecMarkerFile)).toMatch(/harnessd-reexec\.json$/)
    // Not the installed copy: no updater. The installed one runs it.
    expect(config.updater).toBe(false)
    runMaster.mockClear()
    startMaster({ scriptPath: join(env.ADAPTER_CLI_DIR, 'cli.js') })
    expect((runMaster.mock.calls[0][0] as { updater: boolean }).updater).toBe(true)
    expect(LEAN_DIR).toMatch(/[\\/]lean$/)
    expect(LEAN_OFF_FILE).toMatch(/[\\/]lean-off$/)
  })

  it('on Windows, judges a terminal host on probation with the build: unjudged at start, rolled back, kept', () => {
    // The suite's own home (config/testIsolation.ts): the install root the CLI folder sits in.
    const root = dirname(env.ADAPTER_CLI_DIR)
    const ptyRoot = join(root, 'runtime', 'pty')
    try {
      mkdirSync(join(ptyRoot, '0.10.0'), { recursive: true })
      writeFileSync(join(ptyRoot, '0.10.0', 'harness-pty.exe'), 'old')
      writeFileSync(join(ptyRoot, 'current-pty'), '0.11.0')
      writeFileSync(join(ptyRoot, 'pty-pending.json'), JSON.stringify({ version: '0.11.0', previous: '0.10.0' }))
      runMaster.mockClear()
      startMaster({ scriptPath: '/cli/cli.js' }, () => {}, 'win32', () => ({}))
      const config = runMaster.mock.calls[0][0] as { restoreUpdate(): void; confirmUpdate(): void; unjudgedUpdate(bundle: string | null): string | null }
      expect(config.unjudgedUpdate(null)).toBe('terminal host 0.11.0')
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      try { config.restoreUpdate() } finally { log.mockRestore() }
      expect(readFileSync(join(ptyRoot, 'current-pty'), 'utf8').trim()).toBe('0.10.0')
      expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(false)
      expect(JSON.parse(readFileSync(join(ptyRoot, 'pty-rejected.json'), 'utf8'))).toEqual(['0.11.0'])
      expect(config.unjudgedUpdate(null)).toBeNull()
      writeFileSync(join(ptyRoot, 'pty-pending.json'), JSON.stringify({ version: '0.12.0', previous: '0.10.0' }))
      config.confirmUpdate()
      expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(false)
      // A corrupt marker, which the poller waits on as on any: judged at the start, and the rollback clears it.
      writeFileSync(join(ptyRoot, 'pty-pending.json'), '{ not json')
      expect(config.unjudgedUpdate(null)).toBe('terminal host (unreadable marker)')
      const quiet = vi.spyOn(console, 'log').mockImplementation(() => {})
      try { config.restoreUpdate() } finally { quiet.mockRestore() }
      expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(false)
      expect(readFileSync(join(ptyRoot, 'current-pty'), 'utf8').trim()).toBe('0.10.0')
    } finally { rmSync(join(root, 'runtime', 'pty'), { recursive: true, force: true }) }
  })

  // The stand-in host is a shell script: what `harness-pty.exe version` prints, off Windows.
  it.skipIf(process.platform === 'win32')('on Windows, judges and keeps the terminal host under the spawn lock, and takes back at start a host it cannot speak', () => {
    const root = dirname(env.ADAPTER_CLI_DIR)
    const ptyRoot = join(root, 'runtime', 'pty')
    const events: string[] = []
    spawnLock.sync.mockImplementation((purpose: unknown) => { events.push(`lock ${String(purpose)}`); return () => { events.push('release') } })
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { events.push(String(line)) })
    try {
      mkdirSync(join(ptyRoot, '0.10.0'), { recursive: true })
      writeFileSync(join(ptyRoot, '0.10.0', 'harness-pty.exe'), 'old')
      // A paired host whose CLI build never went in: it says it speaks a protocol above this build's.
      mkdirSync(join(ptyRoot, '0.11.0'), { recursive: true })
      const host = join(ptyRoot, '0.11.0', 'harness-pty.exe')
      writeFileSync(host, `#!/bin/sh\necho '{"version":"0.11.0","protocol":${PTY_PROTOCOL + 1},"features":["seed"]}'\n`, { mode: 0o755 })
      writeFileSync(join(ptyRoot, 'current-pty'), '0.11.0')
      writeFileSync(join(ptyRoot, 'pty-pending.json'), JSON.stringify({ version: '0.11.0', previous: '0.10.0' }))
      runMaster.mockClear()
      startMaster({ scriptPath: '/cli/cli.js' }, () => {}, 'win32', () => ({}))
      const config = runMaster.mock.calls[0][0] as { restoreUpdate(): void; confirmUpdate(): void; unjudgedUpdate(bundle: string | null): string | null }
      expect(config.unjudgedUpdate(null)).toBeNull()
      expect(readFileSync(join(ptyRoot, 'current-pty'), 'utf8').trim()).toBe('0.10.0')
      expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(false)
      expect(events.filter((e) => e.startsWith('lock') || e === 'release')).toEqual(['lock update', 'release'])
      expect(events.some((e) => e.includes(`speaks protocol ${PTY_PROTOCOL + 1}, which this build does not — taking it back out rather than judging it`))).toBe(true)
      // A rollback and a keep: each under the lock.
      events.length = 0
      writeFileSync(join(ptyRoot, 'pty-pending.json'), JSON.stringify({ version: '0.12.0', previous: '0.10.0' }))
      config.restoreUpdate()
      writeFileSync(join(ptyRoot, 'pty-pending.json'), JSON.stringify({ version: '0.12.0', previous: '0.10.0' }))
      config.confirmUpdate()
      expect(events.filter((e) => e.startsWith('lock') || e === 'release')).toEqual(['lock update', 'release', 'lock update', 'release'])
    } finally {
      log.mockRestore()
      spawnLock.sync.mockReset()
      spawnLock.sync.mockImplementation(() => () => {})
      rmSync(join(root, 'runtime', 'pty'), { recursive: true, force: true })
    }
  })

  it('keeps the services in the core when the core will have no local socket for them to reach it by', () => {
    const given = { HOME: '/home/someone' }
    const logs: string[] = []
    // A socket: the master runs on its environment as it is, the services in their own processes.
    expect(masterEnv(given, '/data/daemon-18473.sock', (line) => logs.push(line))).toBe(given)
    // None (a data folder too deep for one): every service in the core's process, and the log says why.
    for (const platform of ['darwin', 'linux'] as const) {
      logs.length = 0
      expect(masterEnv(given, null, (line) => logs.push(line), platform)).toEqual({ HOME: '/home/someone', HARNESSD_SERVICES: 'none' })
      expect(given).toEqual({ HOME: '/home/someone' })
      expect(logs).toEqual([expect.stringMatching(/\[harnessd\] this data folder is too deep for the daemon's local socket — the services run in the core's process$/)])
    }
    // Windows has no socket for them at all: the same, said as it is there, with no word of a socket or a depth.
    logs.length = 0
    expect(masterEnv(given, null, (line) => logs.push(line), 'win32')).toEqual({ HOME: '/home/someone', HARNESSD_SERVICES: 'none' })
    expect(logs).toEqual([expect.stringMatching(/ \[harnessd\] on Windows the services run in the core's process$/)])
    expect(logs[0]).not.toMatch(/socket|deep/)
    // Already none: nothing to change or say.
    const none = { HARNESSD_SERVICES: 'none' }
    expect(masterEnv(none, null, (line) => logs.push(line))).toBe(none)
    expect(logs).toHaveLength(1)
    // Its own log line goes to the master's console, which is the daemon's log.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      masterEnv({}, null)
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/the services run in the core's process$/))
    } finally { log.mockRestore() }
    // startMaster hands runMaster an environment: this one's, or this one's with the services kept in.
    runMaster.mockClear()
    startMaster({ scriptPath: '/cli/cli.js' })
    expect((runMaster.mock.calls[0][0] as { env: NodeJS.ProcessEnv }).env).toMatchObject({ PATH: process.env.PATH })
  })

  it('gives up its claim on the lean bundle as it exits cleanly', () => {
    const folder = mkdtempSync(join(tmpdir(), 'lean-claim-'))
    try {
      const claim = join(folder, `.claim-${process.pid}`)
      writeFileSync(claim, '')
      const exits: number[] = []
      runMaster.mockClear()
      startMaster({ scriptPath: '/cli/cli.js', serviceScriptPath: join(folder, LEAN_ENTRY) }, (code) => exits.push(code))
      const config = runMaster.mock.calls[0][0] as { exit(code: number): void }
      config.exit(0)
      expect(exits).toEqual([0])
      expect(existsSync(claim)).toBe(false)
      // Without a lean bundle there is no claim to give up.
      runMaster.mockClear()
      startMaster({ scriptPath: '/cli/cli.js' }, (code) => exits.push(code))
      ;(runMaster.mock.calls[0][0] as { exit(code: number): void }).exit(3)
      expect(exits).toEqual([0, 3])
      const processExit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
      runMaster.mockClear()
      startMaster({ scriptPath: '/cli/cli.js' })
      ;(runMaster.mock.calls[0][0] as { exit(code: number): void }).exit(4)
      expect(processExit).toHaveBeenCalledWith(4)
      processExit.mockRestore()
    } finally { rmSync(folder, { recursive: true, force: true }) }
  })

  it('runs in the foreground as launchd runs it: a bundle as one, the sources as cli.ts runs them', () => {
    const calls: unknown[] = []
    const start = { fromBundle: (bundle: string) => { calls.push(['bundle', bundle]) }, fromSources: (given: unknown) => { calls.push(['sources', given]) } }
    startMasterInForeground('/cli/cli.js', start)
    startMasterInForeground('/checkout/cli/src/cli.ts', start)
    expect(calls).toEqual([['bundle', '/cli/cli.js'], ['sources', { scriptPath: '/checkout/cli/src/cli.ts' }]])
    // By default, the two ways a master starts: from the bundle (entry.ts's `__harnessd`), or as cli.ts runs it.
    runMaster.mockClear()
    startMasterInForeground('/checkout/cli/src/cli.ts')
    expect(runMaster.mock.calls[0][0]).toMatchObject({ scriptPath: '/checkout/cli/src/cli.ts' })
  })

  it('answers the probe a re-executing master asks', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(probeThisMaster()).toBe(0)
    expect(String(log.mock.calls[0][0])).toContain(PROBE_ANSWER)
    log.mockRestore()
  })
})
