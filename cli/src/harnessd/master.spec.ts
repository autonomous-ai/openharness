import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  coreExecArgv, coreHandle, describeMasterStatus, heapLimitInArgv, masterDefaults, onProcessSignal, processExit,
  readStatusFile, runMaster, supervisorOptions, trimLogEvery, writeStatusFile, type MasterStatusFile,
} from './master.js'
import { DEFAULT_SUPERVISOR_OPTIONS } from './supervisor.js'

describe('supervisorOptions', () => {
  it('reads valid overrides and keeps the defaults for anything unset or invalid', () => {
    expect(supervisorOptions({})).toEqual(DEFAULT_SUPERVISOR_OPTIONS)
    expect(supervisorOptions({
      HARNESSD_BIND_TIMEOUT_MS: '100', HARNESSD_READY_TIMEOUT_MS: '150', HARNESSD_HEARTBEAT_TIMEOUT_MS: '1000',
      HARNESSD_STOP_GRACE_MS: '300', HARNESSD_INITIAL_BACKOFF_MS: '0', HARNESSD_MAX_BACKOFF_MS: '50',
      HARNESSD_BACKOFF_RESET_MS: '0', HARNESSD_HEAP_LIMIT_MIB: '512', HARNESSD_HEAP_RESTART_PERCENT: '90',
      HARNESSD_RSS_LIMIT_MIB: '0', HARNESSD_UPDATE_PROBATION_MS: '10', HARNESSD_CRASH_LOOP_CRASHES: '5',
      HARNESSD_CRASH_LOOP_WINDOW_MS: '1000',
    })).toEqual({
      bindTimeoutMs: 100, readyTimeoutMs: 150, heartbeatTimeoutMs: 1000, stopGraceMs: 300, initialBackoffMs: 0,
      maxBackoffMs: 50, backoffResetMs: 0, heapLimitMiB: 512, heapRestartPercent: 90, rssLimitMiB: 0,
      updateProbationMs: 10, crashLoopCrashes: 5, crashLoopWindowMs: 1000,
    })
    expect(supervisorOptions({
      HARNESSD_BIND_TIMEOUT_MS: '0', HARNESSD_HEARTBEAT_TIMEOUT_MS: 'soon', HARNESSD_RSS_LIMIT_MIB: '-1',
      HARNESSD_HEAP_RESTART_PERCENT: '101', HARNESSD_CRASH_LOOP_CRASHES: '0',
    })).toEqual(DEFAULT_SUPERVISOR_OPTIONS)
  })

  it('allows no hang timeout under a second, where a GC pause would read as a hang', () => {
    expect(supervisorOptions({ HARNESSD_HEARTBEAT_TIMEOUT_MS: '999' }).heartbeatTimeoutMs).toBe(DEFAULT_SUPERVISOR_OPTIONS.heartbeatTimeoutMs)
    expect(supervisorOptions({ HARNESSD_HEARTBEAT_TIMEOUT_MS: '1000' }).heartbeatTimeoutMs).toBe(1000)
  })

  it('takes the heap limit from the flags the master was given, unless the environment names one', () => {
    expect(supervisorOptions({}, ['--import', 'tsx', '--max-old-space-size=256']).heapLimitMiB).toBe(256)
    expect(supervisorOptions({ HARNESSD_HEAP_LIMIT_MIB: '2048' }, ['--max-old-space-size=256']).heapLimitMiB).toBe(2048)
  })
})

describe('the core\'s flags', () => {
  it('finds the last heap limit given, in either spelling', () => {
    expect(heapLimitInArgv([])).toBeNull()
    expect(heapLimitInArgv(['--max-old-space-size=100', '--max_old_space_size=200', '--inspect'])).toBe(200)
    expect(heapLimitInArgv(['--max-old-space-size=lots'])).toBeNull()
  })

  it('gives the core exactly the heap limit its budget is a share of, or V8\'s own when that is 0', () => {
    expect(coreExecArgv(['--import', 'tsx', '--max-old-space-size=256'], 512)).toEqual(['--import', 'tsx', '--max-old-space-size=512'])
    expect(coreExecArgv(['--max_old_space_size=256'], 0)).toEqual([])
  })
})

describe('the status file', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harnessd-status-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const status = (over: Partial<MasterStatusFile> = {}): MasterStatusFile => ({
    state: 'running', corePid: 7, restarts: 0, lastExit: null, lastExitReason: null, safeMode: null,
    protocol: 2, since: 1, masterPid: 42, ...over,
  })

  it('is written whole and read back only for the master that wrote it', () => {
    const file = join(dir, 'harnessd-status.json')
    writeStatusFile(file, status())
    expect(readStatusFile(file, 42)).toEqual(status())
    expect(readStatusFile(file, 43)).toBeNull()
    expect(readStatusFile(join(dir, 'none.json'), 42)).toBeNull()
    writeFileSync(file, '{"masterPid": 42}')
    expect(readStatusFile(file, 42)).toBeNull()
    expect(existsSync(`${file}.42.tmp`)).toBe(false)
  })

  it('never stops the master over a disk it cannot write', () => {
    expect(() => writeStatusFile(join(dir, 'missing', 'harnessd-status.json'), status())).not.toThrow()
  })

  it('says what the master knows when the core cannot answer', () => {
    expect(describeMasterStatus(null)).toBeNull()
    expect(describeMasterStatus(status())).toBeNull()
    expect(describeMasterStatus(status({ state: 'restarting', restarts: 3, lastExit: 'signal SIGKILL', lastExitReason: 'hung' })))
      .toBe('◍ restarting its core · restart 3 · last core ended because it hung (signal SIGKILL)')
    expect(describeMasterStatus(status({ state: 'starting' }))).toBe('● starting')
    expect(describeMasterStatus(status({ state: 'listening', restarts: 1, lastExit: 'code 1', lastExitReason: 'crashed' })))
      .toBe('● starting · restart 1 · last core ended because it crashed (code 1)')
    expect(describeMasterStatus(status({ safeMode: 'crash-loop' })))
      .toBe('◍ safe mode · the core kept crashing — waiting for a fixed build')
    expect(describeMasterStatus(status({ safeMode: 'no tmux', lastExit: 'code 7', lastExitReason: 'mystery' as never })))
      .toBe('◍ safe mode · the core could not start (no tmux) — waiting for a fixed build · last core ended because mystery (code 7)')
  })
})

describe('the process defaults', () => {
  it('exit through process.exit and listen for signals on the process', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    let calls: unknown[][] = []
    try { processExit(3); calls = exit.mock.calls.map((call) => [...call]) } finally { exit.mockRestore() }
    expect(calls).toEqual([[3]])
    const listener = vi.fn()
    onProcessSignal('SIGHUP', listener)
    try { process.emit('SIGHUP') } finally { process.removeListener('SIGHUP', listener) }
    expect(listener).toHaveBeenCalledOnce()
  })
})

describe('trimLogEvery', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('trims the log on its interval until stopped, and does nothing without one', () => {
    const trimmed: string[] = []
    const stop = trimLogEvery('/logs/harness.log', 1_000, (file) => { trimmed.push(file); return false })
    vi.advanceTimersByTime(2_999)
    expect(trimmed).toEqual(['/logs/harness.log', '/logs/harness.log'])
    stop()
    vi.advanceTimersByTime(5_000)
    expect(trimmed).toHaveLength(2)
    expect(() => trimLogEvery(undefined)()).not.toThrow()
  })

  it('uses the daemon log trim by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harnessd-trim-'))
    try {
      const file = join(dir, 'harness.log')
      writeFileSync(file, 'x'.repeat(11 * 1024 * 1024))
      const stop = trimLogEvery(file, 1_000)
      vi.advanceTimersByTime(1_000)
      stop()
      expect(readFileSync(file).length).toBeLessThan(11 * 1024 * 1024)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('masterDefaults', () => {
  it('takes what the config gives, and this process for the rest', () => {
    const base = { nodePath: 'n', execArgv: [], scriptPath: 's', pidFile: 'p', restoreUpdate: () => {}, confirmUpdate: () => {} }
    expect(masterDefaults(base)).toEqual({ env: process.env, exit: processExit, onSignal: onProcessSignal })
    const exit = () => {}
    const onSignal = () => {}
    expect(masterDefaults({ ...base, env: { A: '1' }, exit, onSignal })).toEqual({ env: { A: '1' }, exit, onSignal })
  })
})

describe('coreHandle', () => {
  const fake = () => {
    const child = new EventEmitter() as EventEmitter & { pid: number; send: (m: unknown) => void; kill: (s: string) => void }
    child.pid = 4242
    child.send = vi.fn()
    child.kill = vi.fn()
    return child
  }

  it('reports one exit however the child ends, a failed spawn included', () => {
    for (const end of [(c: EventEmitter) => { c.emit('exit', 3, null); c.emit('error', new Error('late')) }, (c: EventEmitter) => { c.emit('error', new Error('ENOENT')); c.emit('exit', 1, null) }]) {
      const child = fake()
      const handle = coreHandle(child as unknown as ChildProcess)
      const exits: unknown[] = []
      handle.onExit((code, signal) => exits.push([code, signal]))
      end(child)
      expect(exits).toHaveLength(1)
    }
  })

  it('passes messages and signals through, and swallows them for a child that is gone', () => {
    const child = fake()
    const handle = coreHandle(child as unknown as ChildProcess)
    const messages: unknown[] = []
    handle.onMessage((message) => messages.push(message))
    child.emit('message', { type: 'x' })
    handle.send({ type: 'harnessd:status', status: { state: 'running', corePid: 1, restarts: 0, lastExit: null, lastExitReason: null, safeMode: null, protocol: 2, since: 0 } })
    handle.kill('SIGTERM')
    expect(handle.pid).toBe(4242)
    expect(messages).toEqual([{ type: 'x' }])
    expect(child.send).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.send = () => { throw new Error('closed') }
    child.kill = () => { throw new Error('ESRCH') }
    expect(() => { handle.send({ type: 'harnessd:status', status: {} as never }); handle.kill('SIGKILL') }).not.toThrow()
  })
})

// A real master over a real child: a few lines of JavaScript that behave like a core.
describe('runMaster', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harnessd-master-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const until = async (what: string, test: () => boolean, ms = 10_000) => {
    const deadline = Date.now() + ms
    while (!test()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  it('starts the core, claims the pid file when it binds, restarts it after a crash, and stops it on a signal', async () => {
    const pidFile = join(dir, 'adapter.pid')
    const runs = join(dir, 'runs')
    const core = join(dir, 'core.cjs')
    writeFileSync(core, `
      const { appendFileSync } = require('node:fs')
      appendFileSync(${JSON.stringify(runs)}, process.env.HARNESSD_RESTARTS + '\\n')
      if (process.argv[2] !== '__run') process.exit(9)
      process.send({ type: 'harnessd:bound', protocol: 1, port: 1 })
      setInterval(() => process.send({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1 }), 50)
      process.on('SIGTERM', () => process.exit(0))
      if (process.env.HARNESSD_RESTARTS === '0') setTimeout(() => process.exit(1), 100)
    `)
    const signals = new Map<string, () => void>()
    const exits: number[] = []
    const updates: string[] = []
    const supervisor = runMaster({
      nodePath: process.execPath,
      execArgv: [],
      scriptPath: core,
      pidFile,
      restoreUpdate: () => updates.push('restore'),
      confirmUpdate: () => updates.push('confirm'),
      env: { ...process.env, HARNESSD_INITIAL_BACKOFF_MS: '10' },
      exit: (code) => exits.push(code),
      onSignal: (signal, listener) => signals.set(signal, listener),
    })
    expect([...signals.keys()]).toEqual(['SIGTERM', 'SIGINT', 'SIGHUP'])
    await until('the pid file', () => existsSync(pidFile))
    expect(readFileSync(pidFile, 'utf8')).toBe(`${process.pid}\n`)
    await until('a restart', () => existsSync(runs) && readFileSync(runs, 'utf8') === '0\n1\n')
    await until('the restarted core to bind', () => supervisor.status().state === 'running')
    signals.get('SIGTERM')!()
    await until('the master to finish', () => exits.length > 0)
    expect(exits).toEqual([0])
    expect(existsSync(pidFile)).toBe(false)
    expect(updates).toEqual([])
  })

  it('records its status as it goes, and starts the core with the heap limit its budget is a share of', async () => {
    const pidFile = join(dir, 'adapter.pid')
    const statusFile = join(dir, 'harnessd-status.json')
    const flags = join(dir, 'flags')
    const core = join(dir, 'core.cjs')
    writeFileSync(core, `
      require('node:fs').writeFileSync(${JSON.stringify(flags)}, JSON.stringify(process.execArgv))
      process.send({ type: 'harnessd:bound', protocol: 2, port: 1 })
      process.send({ type: 'harnessd:ready' })
      setInterval(() => process.send({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1, loopDelayMs: 0 }), 50)
      process.on('SIGTERM', () => process.exit(0))
    `)
    const exits: number[] = []
    const signals = new Map<string, () => void>()
    runMaster({
      nodePath: process.execPath, execArgv: [], scriptPath: core, pidFile, statusFile, logFile: join(dir, 'harness.log'),
      restoreUpdate: () => {}, confirmUpdate: () => {},
      env: { ...process.env, HARNESSD_HEAP_LIMIT_MIB: '300' },
      exit: (code) => exits.push(code), onSignal: (signal, listener) => signals.set(signal, listener),
    })
    await until('the core to be ready', () => readStatusFile(statusFile, process.pid)?.state === 'running')
    expect(JSON.parse(readFileSync(flags, 'utf8'))).toEqual(['--max-old-space-size=300'])
    signals.get('SIGTERM')!()
    await until('the master to finish', () => exits.length > 0)
    expect(readStatusFile(statusFile, process.pid)).toMatchObject({ state: 'stopped', lastExitReason: 'stopped' })
  })

  it('runs the services it is told to beside the core, with one token for both, restarts them, and stops them with it', async () => {
    const pidFile = join(dir, 'adapter.pid')
    const seen = join(dir, 'seen')
    const script = join(dir, 'daemon.cjs')
    writeFileSync(script, `
      const { appendFileSync } = require('node:fs')
      const role = process.argv[2] === '__service' ? 'service:' + process.argv[3] : process.argv[2]
      appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ role, token: process.env.HARNESSD_SERVICE_TOKEN, name: process.env.HARNESSD_SERVICE, restarts: process.env.HARNESSD_RESTARTS, flags: process.execArgv }) + '\\n')
      if (role === '__run') { process.send({ type: 'harnessd:bound', protocol: 2, port: 1 }); process.send({ type: 'harnessd:ready' }) }
      setInterval(() => process.send({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1, loopDelayMs: 0 }), 50)
      process.on('SIGTERM', () => process.exit(0))
      if (role === 'service:search' && process.env.HARNESSD_RESTARTS === '0') setTimeout(() => process.exit(1), 100)
    `)
    const exits: number[] = []
    const signals = new Map<string, () => void>()
    runMaster({
      nodePath: process.execPath, execArgv: [], scriptPath: script, pidFile,
      restoreUpdate: () => {}, confirmUpdate: () => {},
      env: { ...process.env, HARNESSD_SERVICES: 'search,unknown', HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '10' },
      exit: (code) => exits.push(code), onSignal: (signal, listener) => signals.set(signal, listener),
    })
    const lines = (): Array<Record<string, any>> => existsSync(seen) ? readFileSync(seen, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
    await until('the crashed service to be restarted', () => lines().filter((line) => line.role === 'service:search').length === 2)
    const core = lines().find((line) => line.role === '__run')!
    const services = lines().filter((line) => line.role === 'service:search')
    expect(services.map((service) => service.restarts)).toEqual(['0', '1'])
    expect(services[0]).toMatchObject({ name: 'search', flags: ['--max-old-space-size=1024'] })
    expect(services[0].token).toMatch(/^[0-9a-f]{48}$/)
    expect(core.token).toBe(services[0].token)
    expect(lines().some((line) => line.role === 'service:unknown')).toBe(false)
    signals.get('SIGTERM')!()
    await until('the master to finish', () => exits.length > 0)
    expect(exits).toEqual([0])
  })

  it.each([
    ['is gone', (pidFile: string) => rmSync(pidFile, { force: true })],
    ['holds no number', (pidFile: string) => writeFileSync(pidFile, 'garbage\n')],
  ])('finishes cleanly when its pid file %s by the time it leaves', async (_, disturb) => {
    const pidFile = join(dir, 'adapter.pid')
    const core = join(dir, 'core.cjs')
    writeFileSync(core, `process.send({ type: 'harnessd:bound', protocol: 1, port: 1 }); setTimeout(() => process.exit(0), 100)`)
    const exits: number[] = []
    runMaster({
      nodePath: process.execPath, execArgv: [], scriptPath: core, pidFile,
      restoreUpdate: () => {}, confirmUpdate: () => {},
      exit: (code) => exits.push(code), onSignal: () => {},
    })
    await until('the pid file', () => existsSync(pidFile))
    disturb(pidFile)
    await until('the master to finish', () => exits.length > 0)
    expect(exits).toEqual([0])
  })

  it('leaves a pid file that is not its own alone', async () => {
    const pidFile = join(dir, 'adapter.pid')
    const core = join(dir, 'core.cjs')
    writeFileSync(core, `
      process.send({ type: 'harnessd:bound', protocol: 1, port: 1 })
      setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, '1\\n'); process.exit(0) }, 50)
    `)
    const exits: number[] = []
    runMaster({
      nodePath: process.execPath, execArgv: [], scriptPath: core, pidFile,
      restoreUpdate: () => {}, confirmUpdate: () => {},
      exit: (code) => exits.push(code), onSignal: () => {},
    })
    await until('the master to finish', () => exits.length > 0)
    expect(readFileSync(pidFile, 'utf8')).toBe('1\n')
  })

  // The defaults act on the process itself, so they are exercised in a real one: a master on its own,
  // whose core cannot even be spawned, that a SIGTERM must still stop cleanly.
  it('uses this process for exit and signals by default', async () => {
    const script = join(dir, 'master.mts')
    writeFileSync(script, `
      import { runMaster } from ${JSON.stringify(join(__dirname, 'master.ts'))}
      runMaster({
        nodePath: '/nonexistent/node', execArgv: [], scriptPath: '/nonexistent/core.js',
        pidFile: ${JSON.stringify(join(dir, 'adapter.pid'))}, restoreUpdate: () => {}, confirmUpdate: () => {},
        env: { ...process.env, HARNESSD_INITIAL_BACKOFF_MS: '20' },
      })
      console.log('READY')
    `)
    const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: join(__dirname, '../..'), stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    await until('the master to start', () => output.includes('READY') && output.includes('restarting'), 20_000)
    child.kill('SIGTERM')
    expect(await exited).toBe(0)
    expect(output).toContain('[harnessd] SIGTERM — stopping')
  })
})
