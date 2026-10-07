import { EventEmitter } from 'node:events'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  coreExecArgv, coreHandle, describeMasterStatus, heapLimitInArgv, masterDefaults, onProcessSignal, probeMaster, processExecve, processExit,
  readStatusFile, runMaster, supervisorOptions, trimLogEvery, writeStatusFile, type MasterStatusFile,
} from './master.js'
import { ignoreLogWriteErrors } from '../lib/log.js'
import { LEAN_CORE_ENTRY, folderFingerprint } from './leanBundle.js'
import { PROBE_ANSWER, RESUME_ENV, decodeResume, encodeResume, fingerprint, readMarker, writeMarker } from './reexec.js'
import { HARNESSD_PROTOCOL, LEAN_CORE_SCRIPT_ENV } from './protocol.js'
import { DEFAULT_SUPERVISOR_OPTIONS, type ResumeState } from './supervisor.js'

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
    expect(coreExecArgv(['--import', 'tsx', '--max-old-space-size=256'], 512))
      .toEqual(['--import', 'tsx', '--max-semi-space-size=4', '--max-old-space-size=512'])
    expect(coreExecArgv(['--max_old_space_size=256'], 0)).toEqual(['--max-semi-space-size=4'])
  })

  it('keeps a young-generation size the master was given', () => {
    expect(coreExecArgv(['--max_semi_space_size=8'], 512)).toEqual(['--max_semi_space_size=8', '--max-old-space-size=512'])
  })
})

describe('the status file', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harnessd-status-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const status = (over: Partial<MasterStatusFile> = {}): MasterStatusFile => ({
    state: 'running', corePid: 7, restarts: 0, lastExit: null, lastExitReason: null, safeMode: null,
    protocol: 2, since: 1, masterVersion: null, reexecs: 0, masterPid: 42, ...over,
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
    expect(masterDefaults(base)).toEqual({ env: process.env, exit: processExit, onSignal: onProcessSignal, execve: expect.any(Function) })
    const exit = () => {}
    const onSignal = () => {}
    const execve = () => {}
    expect(masterDefaults({ ...base, env: { A: '1' }, exit, onSignal, execve })).toEqual({ env: { A: '1' }, exit, onSignal, execve })
    expect(masterDefaults({ ...base, execve: null }).execve).toBeNull()
  })

  it('replaces the process through process.execve where this Node has it, and has no way to where it has not', () => {
    expect(processExecve({})).toBeNull()
    const calls: unknown[][] = []
    const proc = { execve(this: unknown, ...args: unknown[]) { calls.push([this === proc, ...args]) } }
    processExecve(proc)!('/node', ['/node', 'cli.js'], { A: '1' })
    expect(calls).toEqual([[true, '/node', ['/node', 'cli.js'], { A: '1' }]])
    // The Node these tests run on has it (22.15 and 23.11 on).
    expect(processExecve()).toEqual(expect.any(Function))
  })
})

describe('the probe a re-executing master asks a bundle', () => {
  it('answers when the master builds, from the state it would be handed or from none', () => {
    const said: string[] = []
    expect(probeMaster({ env: {}, execArgv: [], version: '9.9.9' }, (line) => said.push(line))).toBe(0)
    const resume: ResumeState = { restarts: 1, lastExit: 'code 75', lastExitReason: 'update', update: 'pending', claimed: true, reexecs: 1, unproven: 1 }
    expect(probeMaster({ env: { [RESUME_ENV]: encodeResume(resume) }, execArgv: [], version: '9.9.9' }, (line) => said.push(line))).toBe(0)
    expect(said).toEqual([`${PROBE_ANSWER} · protocol ${HARNESSD_PROTOCOL} · v9.9.9`, `${PROBE_ANSWER} · protocol ${HARNESSD_PROTOCOL} · v9.9.9`])
  })

  it('refuses a state it cannot read, and says so on stdout by default', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(probeMaster({ env: { [RESUME_ENV]: '{"restarts":"many"}' }, execArgv: [], version: '9.9.9' })).toBe(1)
      expect(log).toHaveBeenCalledWith('harnessd-probe failed: the state it would be handed is not one this master can read')
    } finally { log.mockRestore() }
    // A failure that is not an Error is reported all the same: here, the answer itself could not be said.
    const said: string[] = []
    let first = true
    const say = (line: string) => { if (first) { first = false; throw 'stdout closed' } said.push(line) }
    expect(probeMaster({ env: { HARNESSD_SERVICES: 'search' }, execArgv: [], version: '' }, say)).toBe(1)
    expect(said).toEqual(['harnessd-probe failed: stdout closed'])
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

  it('keeps the real update exit when an IPC send fails as the core is leaving', async () => {
    // Found by QA after a quiet-machine run: CI rolled back a core exiting for an update when a
    // status send lost its IPC channel. Node reports that send error on the child without a callback.
    const child = fake()
    child.send = (_message: unknown, callback?: (error: Error | null) => void) => {
      queueMicrotask(() => {
        const error = Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' })
        if (callback) callback(error)
        else child.emit('error', error)
      })
    }
    const handle = coreHandle(child as unknown as ChildProcess)
    const exits: unknown[] = []
    handle.onExit((code, signal) => exits.push([code, signal]))
    handle.send({ type: 'harnessd:status', status: {} as never })
    await Promise.resolve()
    expect(exits).toEqual([])
    child.emit('exit', 75, null)
    expect(exits).toEqual([[75, null]])
  })

  it('passes messages and signals through, and swallows them for a child that is gone', () => {
    const child = fake()
    const handle = coreHandle(child as unknown as ChildProcess)
    const messages: unknown[] = []
    handle.onMessage((message) => messages.push(message))
    child.emit('message', { type: 'x' })
    handle.send({ type: 'harnessd:status', status: { state: 'running', corePid: 1, restarts: 0, lastExit: null, lastExitReason: null, safeMode: null, protocol: 2, since: 0, masterVersion: null, reexecs: 0 } })
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
describe('a log that cannot grow', () => {
  // The master's stdout is the daemon's log file, on the disk everything else is on. A size limit stands
  // in for a full disk: the write fails the same way (EFBIG for ENOSPC), and the process must live on.
  const script = (guard: boolean) => `
    ${guard ? `import { ignoreLogWriteErrors } from ${JSON.stringify(new URL('../lib/log.ts', import.meta.url).pathname)}\nignoreLogWriteErrors()` : ''}
    const line = 'x'.repeat(1500)
    let n = 0
    const timer = setInterval(() => { console.log(line); if (++n === 30) { clearInterval(timer); process.exit(0) } }, 5)
  `
  const run = (guard: boolean): Promise<number | null> => {
    const dir = mkdtempSync(join(tmpdir(), 'harnessd-full-log-'))
    const file = join(dir, 'master.mts')
    writeFileSync(file, script(guard))
    const cli = new URL('../..', import.meta.url).pathname
    const child = spawn('/bin/sh', ['-c', `ulimit -f 4; exec "$0" --import tsx "$1" > "$2" 2>&1`, process.execPath, file, join(dir, 'harness.log')], { cwd: cli, stdio: 'ignore' })
    return new Promise((resolve) => child.once('exit', (code) => { rmSync(dir, { recursive: true, force: true }); resolve(code) }))
  }

  it('has its failed writes dropped', () => {
    const stream = new EventEmitter()
    ignoreLogWriteErrors([stream])
    expect(() => stream.emit('error', Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }))).not.toThrow()
  })

  it('is not what stops the master: a write that fails is dropped', async () => {
    expect(await run(false)).toBe(1)
    expect(await run(true)).toBe(0)
  }, 30_000)
})

// Every test here starts real Node processes one after another (a core, services, probes) and waits on
// what they write or say. A Node starts in about 50 ms on a quiet machine and in seconds at a load of 50
// to 60, where vitest's 5 s for a whole test ran out before the conditions did.
describe('runMaster', { timeout: 60_000 }, () => {
  let dir: string
  // runMaster titles the process it runs in: here, the test worker.
  const title = process.title
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harnessd-master-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); process.title = title })

  /** Wait for [test] to hold. The deadline only names what never came, well before the test's own. */
  const until = async (what: string, test: () => boolean, ms = 30_000) => {
    const deadline = Date.now() + ms
    while (!test()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  it('starts the core through a link named after it, so Activity Monitor tells it from node', async () => {
    const runtime = join(dir, 'runtime')
    const bin = join(runtime, 'node-v1', 'bin')
    mkdirSync(bin, { recursive: true })
    const node = join(bin, 'node')
    linkSync(process.execPath, node)
    const ran = join(dir, 'ran')
    const core = join(dir, 'core.cjs')
    writeFileSync(core, `
      // The services run this script too (as \`__service <name>\`); each records its own.
      require('node:fs').writeFileSync(${JSON.stringify(ran)} + (process.argv[3] ?? ''), process.execPath)
      process.send({ type: 'harnessd:bound', protocol: ${HARNESSD_PROTOCOL}, port: 1 })
      process.send({ type: 'harnessd:ready' })
      // A device: the core asks for the devices' process, which runs only on demand.
      if (process.argv[2] === '__run') process.send({ type: 'harnessd:want', service: 'wifi' })
      setInterval(() => process.send({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1, loopDelayMs: 0 }), 50)
      process.on('SIGTERM', () => process.exit(0))
    `)
    const exits: number[] = []
    const signals = new Map<string, () => void>()
    const supervisor = runMaster({
      nodePath: node, runtimeDir: runtime, execArgv: [], scriptPath: core, pidFile: join(dir, 'adapter.pid'),
      restoreUpdate: () => {}, confirmUpdate: () => {},
      exit: (code) => exits.push(code), onSignal: (signal, listener) => signals.set(signal, listener),
    })
    await until('the core and a service to be running', () => supervisor.status().state === 'running' && existsSync(ran) && existsSync(`${ran}search`))
    await until('the devices\' process the core asked for', () => existsSync(`${ran}devices,wifi`))
    const libexec = join(realpathSync(runtime), 'node-v1', 'libexec', 'harnessd')
    expect(readFileSync(ran, 'utf8')).toBe(join(libexec, 'harnessd-core'))
    expect(readFileSync(`${ran}search`, 'utf8')).toBe(join(libexec, 'harnessd-search'))
    expect(readFileSync(`${ran}devices,wifi`, 'utf8')).toBe(join(libexec, 'harnessd-devices'))
    signals.get('SIGTERM')!()
    await until('the master to finish', () => exits.length > 0)
  })

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
      env: { ...process.env, HARNESSD_SERVICES: 'none', HARNESSD_INITIAL_BACKOFF_MS: '10' },
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

  it('carries on, without a pid file, when the disk will not take one', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const pidFile = join(dir, 'no-such-folder', 'adapter.pid')
    const core = join(dir, 'core.cjs')
    writeFileSync(core, `
      process.send({ type: 'harnessd:bound', protocol: 2, port: 1 })
      process.send({ type: 'harnessd:ready' })
      setInterval(() => process.send({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1, loopDelayMs: 0 }), 50)
      process.on('SIGTERM', () => process.exit(0))
    `)
    const exits: number[] = []
    const signals = new Map<string, () => void>()
    const supervisor = runMaster({
      nodePath: process.execPath, execArgv: [], scriptPath: core, pidFile,
      restoreUpdate: () => {}, confirmUpdate: () => {},
      exit: (code) => exits.push(code), onSignal: (signal, listener) => signals.set(signal, listener),
    })
    try {
      await until('the core to be running', () => supervisor.status().state === 'running')
      expect(log.mock.calls.map((call) => String(call[0]))).toContainEqual(expect.stringContaining('[harnessd] could not write the pid file: ENOENT'))
      signals.get('SIGTERM')!()
      await until('the master to finish', () => exits.length > 0)
      expect(exits).toEqual([0])
    } finally { log.mockRestore() }
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
      env: { ...process.env, HARNESSD_SERVICES: 'none', HARNESSD_HEAP_LIMIT_MIB: '300' },
      exit: (code) => exits.push(code), onSignal: (signal, listener) => signals.set(signal, listener),
    })
    await until('the core to be ready', () => readStatusFile(statusFile, process.pid)?.state === 'running')
    expect(JSON.parse(readFileSync(flags, 'utf8'))).toEqual(['--max-semi-space-size=4', '--max-old-space-size=300'])
    signals.get('SIGTERM')!()
    await until('the master to finish', () => exits.length > 0)
    expect(readStatusFile(statusFile, process.pid)).toMatchObject({ state: 'stopped', lastExitReason: 'stopped' })
  })

  it('says in its status file when launchd or systemd runs it, so `harness stop` asks the platform', async () => {
    const pidFile = join(dir, 'adapter.pid')
    const statusFile = join(dir, 'harnessd-status.json')
    const logged = join(dir, 'master.log')
    const core = join(dir, 'core.cjs')
    writeFileSync(core, `
      process.send({ type: 'harnessd:bound', protocol: 2, port: 1 })
      process.send({ type: 'harnessd:ready' })
      setInterval(() => process.send({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1, loopDelayMs: 0 }), 50)
      process.on('SIGTERM', () => process.exit(0))
    `)
    const exits: number[] = []
    const signals = new Map<string, () => void>()
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { writeFileSync(logged, `${line}\n`, { flag: 'a' }) })
    try {
      runMaster({
        nodePath: process.execPath, execArgv: [], scriptPath: core, pidFile, statusFile,
        restoreUpdate: () => {}, confirmUpdate: () => {},
        env: { ...process.env, HARNESSD_SERVICES: 'none', HARNESSD_PLATFORM: 'launchd' },
        exit: (code) => exits.push(code), onSignal: (signal, listener) => signals.set(signal, listener),
      })
      await until('the core to be ready', () => readStatusFile(statusFile, process.pid)?.state === 'running')
      expect(readStatusFile(statusFile, process.pid)).toMatchObject({ platform: 'launchd' })
      expect(readFileSync(logged, 'utf8')).toContain('[harnessd] run by launchd, which starts this master again if it dies')
      signals.get('SIGTERM')!()
      await until('the master to finish', () => exits.length > 0)
    } finally { log.mockRestore() }
    expect(exits).toEqual([0])
  })

  it('runs the services it is told to beside the core, with one token for both, restarts them, and stops them with it', async () => {
    const pidFile = join(dir, 'adapter.pid')
    const seen = join(dir, 'seen')
    const script = join(dir, 'daemon.cjs')
    writeFileSync(script, `
      const { appendFileSync } = require('node:fs')
      const role = process.argv[2] === '__service' ? 'service:' + process.argv[3] : process.argv[2]
      appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ role, token: process.env.HARNESSD_SERVICE_TOKEN, name: process.env.HARNESSD_SERVICE, restarts: process.env.HARNESSD_RESTARTS, flags: process.execArgv, processes: process.env.HARNESSD_SERVICE_PROCESSES, services: process.env.HARNESSD_SERVICES }) + '\\n')
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
      env: { ...process.env, HARNESSD_SERVICES: 'search,unknown,monitor,usage', HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '10' },
      exit: (code) => exits.push(code), onSignal: (signal, listener) => signals.set(signal, listener),
    })
    const lines = (): Array<Record<string, any>> => existsSync(seen) ? readFileSync(seen, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
    await until('the crashed service to be restarted', () => lines().filter((line) => line.role === 'service:search').length === 2)
    // The light services share one process, the edge host, which runs each of those named.
    await until('the edge host to start', () => lines().some((line) => line.role === 'service:usage,monitor'))
    expect(lines().find((line) => line.role === 'service:usage,monitor')).toMatchObject({ name: 'edge', flags: ['--max-semi-space-size=4', '--max-old-space-size=384'] })
    const core = lines().find((line) => line.role === '__run')!
    const services = lines().filter((line) => line.role === 'service:search')
    expect(services.map((service) => service.restarts)).toEqual(['0', '1'])
    expect(services[0]).toMatchObject({ name: 'search', flags: ['--max-semi-space-size=4', '--max-old-space-size=1024'] })
    expect(services[0].token).toMatch(/^[0-9a-f]{48}$/)
    expect(core.token).toBe(services[0].token)
    // The core is told exactly what runs out here, in a form a core from before the list reads too.
    expect(core).toMatchObject({ processes: 'search,usage,monitor', services: 'search,usage,monitor' })
    expect(lines().some((line) => line.role === 'service:unknown')).toBe(false)
    signals.get('SIGTERM')!()
    await until('the master to finish', () => exits.length > 0)
    expect(exits).toEqual([0])
  })

  it('runs the updater when told to, whatever HARNESSD_SERVICES names, and has the core hand over for what it stages', async () => {
    const pidFile = join(dir, 'adapter.pid')
    const seen = join(dir, 'seen')
    const script = join(dir, 'daemon.cjs')
    writeFileSync(script, `
      const { appendFileSync } = require('node:fs')
      const role = process.argv[2] === '__service' ? 'service:' + process.argv[3] : process.argv[2]
      const say = (what) => appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ role, what, restarts: process.env.HARNESSD_RESTARTS }) + '\\n')
      say('started')
      if (role === '__run') {
        process.send({ type: 'harnessd:bound', protocol: 3, port: 1 }); process.send({ type: 'harnessd:ready' })
        process.on('message', (message) => { if (message.type === 'harnessd:update') { say('asked for ' + message.version); process.exit(75) } })
      }
      if (role === 'service:updater' && process.env.HARNESSD_RESTARTS === '0') setTimeout(() => process.send({ type: 'harnessd:staged', version: '9.9.9' }), 100)
      setInterval(() => process.send({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1, loopDelayMs: 0 }), 50)
      process.on('SIGTERM', () => process.exit(0))
    `)
    const exits: number[] = []
    const signals = new Map<string, () => void>()
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line) })
    try {
      runMaster({
        nodePath: process.execPath, execArgv: [], scriptPath: script, pidFile, updater: true,
        restoreUpdate: () => {}, confirmUpdate: () => {},
        env: { ...process.env, HARNESSD_SERVICES: 'none', HARNESSD_UPDATE_PROBATION_MS: '50' },
        exit: (code) => exits.push(code), onSignal: (signal, listener) => signals.set(signal, listener),
      })
      const said = (): Array<Record<string, string>> => existsSync(seen) ? readFileSync(seen, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
      await until('the core to hand over and a new one to start', () => said().filter((line) => line.role === '__run' && line.what === 'started').length === 2)
      expect(said().filter((line) => line.role.startsWith('service:')).map((line) => line.role)).toEqual(['service:updater'])
      expect(said()).toContainEqual({ role: '__run', what: 'asked for 9.9.9', restarts: '0' })
      expect(lines.some((line) => line.endsWith('[harnessd] the updater staged 9.9.9 — asking the core to hand over'))).toBe(true)
      expect(lines.some((line) => line.endsWith('[harnessd] core exited (code 75) for an update — restarting'))).toBe(true)
      signals.get('SIGTERM')!()
      await until('the master to finish', () => exits.length > 0)
    } finally { log.mockRestore() }
  })

  it('hands over for a staged build only when the updater staged it, never another service', async () => {
    const pidFile = join(dir, 'adapter.pid')
    const seen = join(dir, 'seen')
    const script = join(dir, 'daemon.cjs')
    // Search says it staged a build, as only the updater may: the core must not be asked to hand over.
    writeFileSync(script, `
      const { appendFileSync } = require('node:fs')
      const role = process.argv[2] === '__service' ? 'service:' + process.argv[3] : process.argv[2]
      const say = (what) => appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ role, what }) + '\\n')
      say('started')
      if (role === '__run') {
        process.send({ type: 'harnessd:bound', protocol: 4, port: 1 }); process.send({ type: 'harnessd:ready' })
        process.on('message', (message) => { if (message.type === 'harnessd:update') { say('asked for ' + message.version); process.exit(75) } })
      }
      if (role === 'service:search') setTimeout(() => { process.send({ type: 'harnessd:staged', version: '6.6.6' }); say('staged') }, 100)
      setInterval(() => process.send({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1, loopDelayMs: 0 }), 50)
      process.on('SIGTERM', () => process.exit(0))
    `)
    const exits: number[] = []
    const signals = new Map<string, () => void>()
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line) })
    try {
      runMaster({
        nodePath: process.execPath, execArgv: [], scriptPath: script, pidFile, updater: true,
        restoreUpdate: () => {}, confirmUpdate: () => {},
        env: { ...process.env, HARNESSD_SERVICES: 'search' },
        exit: (code) => exits.push(code), onSignal: (signal, listener) => signals.set(signal, listener),
      })
      const said = (): Array<Record<string, string>> => existsSync(seen) ? readFileSync(seen, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
      await until('search to say it staged a build', () => said().some((line) => line.role === 'service:search' && line.what === 'staged'))
      // Long enough for a handover the master had asked for to reach the core.
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(said().filter((line) => line.role === '__run')).toEqual([{ role: '__run', what: 'started' }])
      expect(lines.some((line) => line.includes('asking the core to hand over'))).toBe(false)
      expect(lines.some((line) => line.endsWith('[harnessd] service search said it staged 6.6.6, which only the updater may — ignored'))).toBe(true)
      signals.get('SIGTERM')!()
      await until('the master to finish', () => exits.length > 0)
    } finally { log.mockRestore() }
  })

  it('starts the services and the core from the lean bundle when given one, telling the core which CLI it runs for', async () => {
    // The lean bundle cli.js carries (./leanBundle.ts): each service, and the core, parses its own code, not
    // the CLI's. A core started from it is told the cli.js it came from, its CLI to everything it hands on.
    const pidFile = join(dir, 'adapter.pid')
    const seen = join(dir, 'seen')
    const body = (who: string) => `
      const { appendFileSync } = require('node:fs')
      const role = process.argv[2] === '__service' ? 'service:' + process.argv[3] : process.argv[2]
      appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ role, from: ${JSON.stringify(who)}, cli: process.env.${LEAN_CORE_SCRIPT_ENV} ?? null }) + '\\n')
      if (role === '__run') { process.send({ type: 'harnessd:bound', protocol: 2, port: 1 }); process.send({ type: 'harnessd:ready' }) }
      setInterval(() => process.send({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1, loopDelayMs: 0 }), 50)
      process.on('SIGTERM', () => process.exit(0))
    `
    const cli = join(dir, 'cli.cjs')
    const lean = join(dir, 'lean.cjs')
    writeFileSync(cli, body('cli'))
    writeFileSync(lean, body('lean'))
    // The core's own entry, beside the services'.
    writeFileSync(join(dir, LEAN_CORE_ENTRY), body('lean core').replace("require('node:fs')", "await import('node:fs')"))
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line) })
    const exits: number[] = []
    const signals = new Map<string, () => void>()
    try {
      runMaster({
        nodePath: process.execPath, execArgv: [], scriptPath: cli, serviceScriptPath: lean, pidFile,
        restoreUpdate: () => {}, confirmUpdate: () => {},
        env: { ...process.env, HARNESSD_SERVICES: 'search' },
        exit: (code) => exits.push(code), onSignal: (signal, listener) => signals.set(signal, listener),
      })
      const roles = (): Array<Record<string, string>> => existsSync(seen) ? readFileSync(seen, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
      await until('the core and the service', () => roles().length >= 2)
      expect(roles().sort((a, b) => a.role.localeCompare(b.role))).toEqual([{ role: '__run', from: 'lean core', cli }, { role: 'service:search', from: 'lean', cli: null }])
      expect(lines.some((line) => line.endsWith(`[harnessd] services run from ${lean}`))).toBe(true)
      signals.get('SIGTERM')!()
      await until('the master to finish', () => exits.length > 0)
    } finally { log.mockRestore() }
  })

  it('starts the core from cli.js once it has died twice from the lean bundle before it beat, and judges it the same', async () => {
    // A lean core that cannot start costs two quick restarts, never the daemon (./leanServices.ts).
    const pidFile = join(dir, 'adapter.pid')
    const seen = join(dir, 'seen')
    const cli = join(dir, 'cli.cjs')
    const lean = join(dir, 'lean.cjs')
    writeFileSync(cli, `
      require('node:fs').appendFileSync(${JSON.stringify(seen)}, 'cli\\n')
      process.send({ type: 'harnessd:bound', protocol: 2, port: 1 }); process.send({ type: 'harnessd:ready' })
      setInterval(() => process.send({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1, loopDelayMs: 0 }), 50)
      process.on('SIGTERM', () => process.exit(0))
    `)
    // The services' entry is fine; the core's, beside it, dies as it starts.
    writeFileSync(lean, '')
    writeFileSync(join(dir, LEAN_CORE_ENTRY), `(await import('node:fs')).appendFileSync(${JSON.stringify(seen)}, 'lean\\n'); process.exit(1)`)
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line) })
    const exits: number[] = []
    const signals = new Map<string, () => void>()
    try {
      const supervisor = runMaster({
        nodePath: process.execPath, execArgv: [], scriptPath: cli, serviceScriptPath: lean, pidFile,
        restoreUpdate: () => {}, confirmUpdate: () => {},
        env: { ...process.env, HARNESSD_SERVICES: 'none', HARNESSD_INITIAL_BACKOFF_MS: '0' },
        exit: (code) => exits.push(code), onSignal: (signal, listener) => signals.set(signal, listener),
      })
      await until('a core from cli.js, running', () => supervisor.status().state === 'running')
      expect(readFileSync(seen, 'utf8').trim().split('\n')).toEqual(['lean', 'lean', 'cli'])
      expect(lines.some((line) => line.endsWith(`[harnessd] the core died 2 times from the lean bundle before it beat: it starts from ${cli} from now on`))).toBe(true)
      // Two crashes, as any two: not yet the three in a row that start it in safe mode.
      expect(supervisor.status().safeMode).toBeNull()
      signals.get('SIGTERM')!()
      await until('the master to finish', () => exits.length > 0)
    } finally { log.mockRestore() }
  })

  it('starts a service from cli.js once its lean bundle is gone, or cli.js is no longer the bundle it came from', async () => {
    // A master lives for weeks: a lean folder gone from under it failed every restart of every service
    // with MODULE_NOT_FOUND, and after an update it did not re-execute on, the services ran the old lean
    // code against the new core. The lean bundle is only an optimisation (./leanServices.ts).
    const pidFile = join(dir, 'adapter.pid')
    const seen = join(dir, 'seen')
    // The test ends each service process itself, once the world has changed, and the master starts it
    // again at once, from wherever it may. Ended by SIGTERM, as the master ends one, which is never the
    // lean bundle's fault: a service that ended itself on a timer could end before its master had read
    // its first beat, on a loaded machine, and two of those in a row sent it to cli.js for good.
    const body = (who: string) => `
      const { appendFileSync } = require('node:fs')
      const role = process.argv[2] === '__service' ? 'service:' + process.argv[3] : process.argv[2]
      appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ role, from: ${JSON.stringify(who)}, pid: process.pid }) + '\\n')
      if (role === '__run') { process.send({ type: 'harnessd:bound', protocol: 2, port: 1 }); process.send({ type: 'harnessd:ready' }) }
      process.send({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1, loopDelayMs: 0 })
      setInterval(() => process.send({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1, loopDelayMs: 0 }), 50)
      if (role === '__run') process.on('SIGTERM', () => process.exit(0))
    `
    const cli = join(dir, 'cli.cjs')
    const leanDir = join(dir, 'lean')
    const lean = join(leanDir, 'harnessd.mjs')
    writeFileSync(cli, body('cli'))
    mkdirSync(leanDir)
    writeFileSync(lean, body('lean').replace("require('node:fs')", "await import('node:fs')"))
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line) })
    const exits: number[] = []
    const signals = new Map<string, () => void>()
    const services = (): Array<{ from: string; pid: number }> => (existsSync(seen) ? readFileSync(seen, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [])
      .filter((line) => line.role === 'service:search')
    /** End the service running now, and wait for the master to start the next: where it started it from. */
    const restart = async (): Promise<string> => {
      const before = services()
      process.kill(before.at(-1)!.pid, 'SIGTERM')
      await until('search started again', () => services().length > before.length)
      return services().at(-1)!.from
    }
    try {
      runMaster({
        nodePath: process.execPath, execArgv: [], scriptPath: cli, serviceScriptPath: lean, leanFingerprint: folderFingerprint(leanDir)!, pidFile,
        restoreUpdate: () => {}, confirmUpdate: () => {},
        env: { ...process.env, HARNESSD_SERVICES: 'search', HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '0', HARNESSD_SERVICE_MAX_BACKOFF_MS: '0', HARNESSD_SERVICE_PARK_CRASHES: '1000' },
        exit: (code) => exits.push(code), onSignal: (signal, listener) => signals.set(signal, listener),
      })
      await until('a service', () => services().length > 0)
      expect(services()[0]!.from).toBe('lean')
      rmSync(leanDir, { recursive: true })
      expect(await restart()).toBe('cli')
      expect(lines.some((line) => line.endsWith(`[harnessd] the lean bundle ${lean} cannot be used (it is gone): the core and the services start from ${cli}`))).toBe(true)
      // Back as it was, and then cli.js replaced by an update this master runs no code of.
      mkdirSync(leanDir)
      writeFileSync(lean, body('lean').replace("require('node:fs')", "await import('node:fs')"))
      expect(await restart()).toBe('lean')
      writeFileSync(cli, `${body('cli')}\n// the next release\n`)
      expect(await restart()).toBe('cli')
      expect(lines.some((line) => line.endsWith(`[harnessd] the lean bundle ${lean} cannot be used (${cli} is no longer the bundle it came from): the core and the services start from ${cli}`))).toBe(true)
      signals.get('SIGTERM')!()
      await until('the master to finish', () => exits.length > 0)
    } finally { log.mockRestore() }
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
    const servicesFile = join(dir, 'services')
    const core = join(dir, 'core.cjs')
    writeFileSync(core, `
      if (process.argv[2] === '__run') require('node:fs').writeFileSync(${JSON.stringify(servicesFile)}, process.env.HARNESSD_SERVICE_PROCESSES)
      process.send({ type: 'harnessd:bound', protocol: 1, port: 1 })
      setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, '1\\n'); process.exit(0) }, 50)
    `)
    const exits: number[] = []
    runMaster({
      nodePath: process.execPath, execArgv: [], scriptPath: core, pidFile,
      // Found by QA on a quiet machine: each default service ran this same writer. A service stopped
      // between truncate and write left an empty pid file, so this cleanup check raced its fixture.
      env: { ...process.env, HARNESSD_SERVICES: 'none' },
      restoreUpdate: () => {}, confirmUpdate: () => {},
      exit: (code) => exits.push(code), onSignal: () => {},
    })
    await until('the master to finish', () => exits.length > 0)
    expect(readFileSync(pidFile, 'utf8')).toBe('1\n')
    expect(readFileSync(servicesFile, 'utf8')).toBe('')
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
        env: { ...process.env, HARNESSD_SERVICES: 'none', HARNESSD_INITIAL_BACKOFF_MS: '20' },
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

  describe('re-executing on the bundle on disk', () => {
    const DEAD_PID = 2_000_000_000
    /** One script plays the bundle: as a core it binds, is ready and beats; as a probe it answers, or not. */
    const bundle = (core: string, probe = `console.log(${JSON.stringify(PROBE_ANSWER)} + ' · test'); process.exit(0)`) => {
      const file = join(dir, 'bundle.cjs')
      writeFileSync(file, `
        const fs = require('node:fs')
        if (process.argv[2] === '__harnessd-probe') { ${probe} }
        else {
          process.send({ type: 'harnessd:bound', protocol: 2, port: 1 })
          process.send({ type: 'harnessd:ready' })
          setInterval(() => process.send({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1, loopDelayMs: 0 }), 50)
          process.on('SIGTERM', () => process.exit(0))
          ${core}
        }
      `)
      return file
    }
    const start = (scriptPath: string, over: Record<string, unknown> = {}) => {
      const execs: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = []
      const exits: number[] = []
      const calls: string[] = []
      const signals = new Map<string, () => void>()
      const supervisor = runMaster({
        nodePath: process.execPath, execArgv: [], scriptPath, pidFile: join(dir, 'adapter.pid'), statusFile: join(dir, 'harnessd-status.json'),
        restoreUpdate: () => calls.push('restore'), confirmUpdate: () => calls.push('confirm'),
        env: { ...process.env, HARNESSD_SERVICES: 'none', HARNESSD_INITIAL_BACKOFF_MS: '10', HARNESSD_UPDATE_PROBATION_MS: '100' },
        exit: (code) => exits.push(code), onSignal: (signal, listener) => signals.set(signal, listener),
        version: '1.0.0', reexecMarkerFile: join(dir, 'harnessd-reexec.json'),
        execve: (file: string, args: string[], env: NodeJS.ProcessEnv) => { execs.push({ file, args, env }) },
        ...over,
      })
      const stop = async () => { signals.get('SIGTERM')!(); await until('the master to finish', () => exits.length > 0) }
      return { supervisor, execs, exits, calls, stop }
    }
    const marker = () => join(dir, 'harnessd-reexec.json')

    it('replaces itself with the bundle its core staged before it exited for the update, leaving its marker and handing on its state', async () => {
      // A newer bundle written over this one, then the update exit: what the core's updater does.
      const script = bundle(`if (process.env.HARNESSD_RESTARTS === '0') setTimeout(() => { fs.appendFileSync(__filename, '\\n// a newer build\\n'); process.exit(75) }, 100)`)
      const own = fingerprint(script)
      const master = start(script)
      await until('the master to re-execute', () => master.execs.length > 0)
      expect(master.execs[0].file).toBe(process.execPath)
      expect(master.execs[0].args).toEqual([process.execPath, script, '__harnessd'])
      expect(decodeResume(master.execs[0].env[RESUME_ENV])).toEqual({ restarts: 1, lastExit: 'code 75', lastExitReason: 'update', update: 'pending', claimed: true, reexecs: 1, unproven: 1 })
      expect(readMarker(marker())).toEqual({ pid: process.pid, from: own, to: fingerprint(script), at: expect.any(Number) })
      expect(master.supervisor.status()).toMatchObject({ state: 'restarting', corePid: null, masterVersion: '1.0.0' })
      await master.stop()
      expect(master.exits).toEqual([0])
    })

    it('rolls an update back when the new bundle\'s master does not answer its probe, and keeps its own code', async () => {
      const script = bundle(`if (process.env.HARNESSD_RESTARTS === '0') setTimeout(() => { fs.appendFileSync(__filename, '\\n// a newer build\\n'); process.exit(75) }, 100)`,
        `console.error('Unknown command: ' + process.argv[2]); process.exit(1)`)
      const master = start(script)
      await until('the rollback', () => master.calls.includes('restore'))
      await until('a core on the bundle restored', () => master.supervisor.status().state === 'running')
      expect(master.execs).toEqual([])
      expect(readMarker(marker())).toBeNull()
      await master.stop()
    })

    it('carries on as itself, without its marker, when the exec fails', async () => {
      const script = bundle(`if (process.env.HARNESSD_RESTARTS === '0') setTimeout(() => { fs.appendFileSync(__filename, '\\n// a newer build\\n'); process.exit(75) }, 100)`)
      const master = start(script, { execve: () => { throw new Error('E2BIG') } })
      await until('a core on the new bundle, under this master', () => master.supervisor.status().state === 'running' && master.supervisor.status().restarts === 1)
      expect(readMarker(marker())).toBeNull()
      await master.stop()
    })

    it('abandons a probe still running when it is stopped, and replaces nothing', async () => {
      const script = bundle(`if (process.env.HARNESSD_RESTARTS === '0') setTimeout(() => { fs.appendFileSync(__filename, '\\n// a newer build\\n'); process.exit(75) }, 100)`,
        `fs.writeFileSync(${JSON.stringify(join(dir, 'probing'))}, String(process.pid)); setInterval(() => {}, 1000)`)
      const master = start(script)
      await until('the probe to be running', () => existsSync(join(dir, 'probing')))
      const probe = Number(readFileSync(join(dir, 'probing'), 'utf8'))
      await master.stop()
      await until('the probe to be gone', () => { try { process.kill(probe, 0); return false } catch { return true } })
      expect(master.execs).toEqual([])
    })

    it('carries on as the master it re-executed from, without handing that state to its children', async () => {
      const seen = join(dir, 'seen')
      const script = bundle(`fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ restarts: process.env.HARNESSD_RESTARTS, resume: process.env[${JSON.stringify(RESUME_ENV)}] ?? null }) + '\\n')`)
      const resume: ResumeState = { restarts: 3, lastExit: 'code 75', lastExitReason: 'update', update: 'pending', claimed: true, reexecs: 1, unproven: 1 }
      const lines: string[] = []
      const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line) })
      try {
        const master = start(script, { env: { ...process.env, HARNESSD_SERVICES: 'none', HARNESSD_UPDATE_PROBATION_MS: '100', [RESUME_ENV]: encodeResume(resume) } })
        await until('the update to be kept', () => master.calls.includes('confirm'))
        expect(JSON.parse(readFileSync(seen, 'utf8').trim().split('\n')[0])).toEqual({ restarts: '3', resume: null })
        expect(readStatusFile(join(dir, 'harnessd-status.json'), process.pid)).toMatchObject({ masterVersion: '1.0.0', reexecs: 1, restarts: 3 })
        expect(lines.some((line) => line.endsWith(`[harnessd] master re-executed (pid ${process.pid}) · now v1.0.0`))).toBe(true)
        await master.stop()
        // Without a version it says so without one.
        const plain = start(script, { version: undefined, env: { ...process.env, HARNESSD_SERVICES: 'none', [RESUME_ENV]: encodeResume(resume) } })
        await until('its core', () => plain.supervisor.status().state === 'running')
        expect(lines.some((line) => line.endsWith(`[harnessd] master re-executed (pid ${process.pid})`))).toBe(true)
        await plain.stop()
      } finally { log.mockRestore() }
    })

    it('judges the bundle on disk against the one its lean bundle was read from, when it runs on one', async () => {
      // A master re-executed on the lean bundle is handed the sha256 of the cli.js it was read from: the
      // code it runs is that bundle's, whatever is on disk by the time it starts.
      const script = bundle('')
      const lines: string[] = []
      const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line) })
      try {
        const same = start(script, { serviceScriptPath: join(dir, 'lean.mjs'), bundleFingerprint: fingerprint(script) })
        await until('its core', () => same.supervisor.status().state === 'running')
        expect(same.execs).toEqual([])
        expect(lines.some((line) => line.endsWith(`[harnessd] services run from ${join(dir, 'lean.mjs')}, as this master does`))).toBe(true)
        await same.stop()
        const older = start(script, { bundleFingerprint: 'the bundle before' })
        await until('the master to re-execute on the bundle on disk', () => older.execs.length > 0)
        expect(older.execs[0].args).toEqual([process.execPath, script, '__harnessd'])
        await older.stop()
      } finally { log.mockRestore() }
    })

    it('rolls back a re-execution that never brought a core up, then moves onto the bundle restored', async () => {
      const script = bundle('')
      writeMarker(marker(), { pid: DEAD_PID, from: 'the one before', to: fingerprint(script)!, at: 1 })
      const master = start(script, { restoreUpdate: () => { writeFileSync(script, readFileSync(script, 'utf8') + '\n// the build before\n') } })
      await until('the master to re-execute on the bundle restored', () => master.execs.length > 0)
      expect(readMarker(marker())).toMatchObject({ pid: process.pid, to: fingerprint(script) })
      await master.stop()
    })

    it('judges, when it starts fresh, an update on disk that no master kept or rolled back: kept once its core stays up, rolled back when it crashes', async () => {
      const lines: string[] = []
      const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line) })
      try {
        const good = bundle('')
        const asked: Array<string | null> = []
        const kept = start(good, { reexecMarkerFile: undefined, unjudgedUpdate: (fingerprintOnDisk: string | null) => { asked.push(fingerprintOnDisk); return '2.0.0' } })
        await until('the update to be kept', () => kept.calls.includes('confirm'))
        expect(asked).toEqual([fingerprint(good)])
        expect(lines.some((line) => line.endsWith('[harnessd] the bundle on disk is 2.0.0, an update no master kept or rolled back — its first core is on probation'))).toBe(true)
        await kept.stop()

        const crashing = start(bundle('process.exit(3)'), { reexecMarkerFile: undefined, unjudgedUpdate: () => '2.0.1' })
        await until('the update to be rolled back', () => crashing.calls.includes('restore'))
        expect(crashing.calls).toEqual(['restore'])
        await crashing.stop()

        // Nothing unjudged: a core like any other.
        const plain = start(bundle(''), { reexecMarkerFile: undefined, unjudgedUpdate: () => null })
        await until('its core', () => plain.supervisor.status().state === 'running')
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(plain.calls).toEqual([])
        await plain.stop()
      } finally { log.mockRestore() }
    })

    it('asks whether the bundle on disk after a recovery is unjudged, not the bundle it started from', async () => {
      // A re-execution that never came up is rolled back at start; with no room to remember the build,
      // its pending note stays and names the bundle this master started from. That is not the bundle its
      // first core runs: the build before, put back, is no update to judge.
      const lines: string[] = []
      const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line) })
      try {
        const script = bundle('')
        const startedFrom = fingerprint(script)!
        writeMarker(marker(), { pid: DEAD_PID, from: 'the one before', to: startedFrom, at: 1 })
        const asked: Array<string | null> = []
        const master = start(script, {
          restoreUpdate: () => { writeFileSync(script, readFileSync(script, 'utf8') + '\n// the build before\n') },
          unjudgedUpdate: (onDisk: string | null) => { asked.push(onDisk); return onDisk === startedFrom ? '2.0.0' : null },
        })
        await until('the master to re-execute on the bundle restored', () => master.execs.length > 0)
        expect(asked).toEqual([fingerprint(script)])
        expect(asked[0]).not.toBe(startedFrom)
        expect(lines.some((line) => line.includes('an update no master kept or rolled back'))).toBe(false)
        expect(decodeResume(master.execs[0].env[RESUME_ENV])?.update).toBeNull()
        await master.stop()
      } finally { log.mockRestore() }
    })

    it('judges the newer build a core on probation staged, instead of rolling it back as a failure', async () => {
      // Its first core stages a build and exits for the update; the next, on probation, stages another before it is kept.
      const script = bundle(`if (process.env.HARNESSD_RESTARTS !== '2') setTimeout(() => { fs.appendFileSync(__filename, '\\n// a newer build\\n'); process.exit(75) }, process.env.HARNESSD_RESTARTS === '0' ? 100 : 20)`)
      // Its staging 20 ms after it starts must come inside its probation. A loaded machine can leave a
      // process waiting for the CPU longer than the 100 ms the other tests give it, never 3 s.
      const master = start(script, { reexecMarkerFile: undefined, env: { ...process.env, HARNESSD_SERVICES: 'none', HARNESSD_INITIAL_BACKOFF_MS: '10', HARNESSD_UPDATE_PROBATION_MS: '3000' } })
      await until('the newest build to be kept', () => master.calls.includes('confirm'))
      expect(master.calls).toEqual(['confirm'])
      expect(master.supervisor.status()).toMatchObject({ state: 'running', restarts: 2 })
      await master.stop()
    })

    it('starts its services once it carries on, never while it replaces itself before its first core', async () => {
      // A rollback found at start moves this master onto the bundle restored before it starts anything.
      // Its services were started beside that move: they ran through the probe and were cut off by the
      // exec, children no one reaps, and a probe that refused the bundle started them a second time.
      const started = (lines: string[]) => lines.filter((line) => line.includes('[harnessd] service search started'))
      const lines: string[] = []
      const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line) })
      const env = { ...process.env, HARNESSD_INITIAL_BACKOFF_MS: '10', HARNESSD_SERVICES: 'search' }
      const restore = (file: string) => () => { writeFileSync(file, readFileSync(file, 'utf8') + '\n// the build before\n') }
      try {
        const script = bundle('')
        writeMarker(marker(), { pid: DEAD_PID, from: 'the one before', to: fingerprint(script)!, at: 1 })
        let atExec: string[] | null = null
        const moving = start(script, { env, restoreUpdate: restore(script), execve: () => { atExec = started(lines) } })
        await until('the master to re-execute on the bundle restored', () => atExec !== null)
        expect(atExec).toEqual([])
        await moving.stop()

        // The bundle restored refuses its probe: this master carries on as itself, with each service once.
        lines.length = 0
        const refusing = bundle('', `console.error('Unknown command: ' + process.argv[2]); process.exit(1)`)
        writeMarker(marker(), { pid: DEAD_PID, from: 'the one before', to: fingerprint(refusing)!, at: 1 })
        const staying = start(refusing, { env, restoreUpdate: restore(refusing) })
        await until('a core on the bundle restored', () => staying.supervisor.status().state === 'running')
        expect(started(lines)).toHaveLength(1)
        await staying.stop()
      } finally { log.mockRestore() }
    })

    it('takes its own marker with it when it is stopped before its first core is up, and leaves another\'s', async () => {
      // Stopped between its exec and its first core, a re-executed master left its marker, and the next
      // start took that for a re-execution that never came up: a good update rolled back, its version
      // rejected (recoverFailedReexec, selfUpdate.restore).
      const script = join(dir, 'unbound.cjs')
      writeFileSync(script, `setInterval(() => {}, 1000); process.on('SIGTERM', () => process.exit(0))`)
      const resume = encodeResume({ restarts: 1, lastExit: 'code 75', lastExitReason: 'update', update: 'pending', claimed: true, reexecs: 1, unproven: 1 })
      writeMarker(marker(), { pid: process.pid, from: 'the one before', to: fingerprint(script)!, at: 1 })
      const own = start(script, { env: { ...process.env, [RESUME_ENV]: resume } })
      await until('its core', () => own.supervisor.status().corePid !== null)
      await own.stop()
      expect(readMarker(marker())).toBeNull()
      expect(own.calls).toEqual([])

      const another = { pid: process.ppid, from: 'the one before', to: fingerprint(script)!, at: 1 }
      writeMarker(marker(), another)
      const beside = start(script)
      await until('its core', () => beside.supervisor.status().corePid !== null)
      await beside.stop()
      expect(readMarker(marker())).toEqual(another)
    })

    it('removes its marker once its core is up, and leaves alone what it does not judge', async () => {
      const script = bundle('')
      writeMarker(marker(), { pid: process.pid, from: 'the one before', to: fingerprint(script)!, at: 1 })
      const master = start(script)
      await until('its marker to go', () => !existsSync(marker()))
      expect(master.calls).toEqual([])
      await master.stop()
    })
  })
})
