import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coreHandle, masterDefaults, onProcessSignal, processExit, runMaster, supervisorOptions } from './master.js'
import { DEFAULT_SUPERVISOR_OPTIONS } from './supervisor.js'

describe('supervisorOptions', () => {
  it('reads valid overrides and keeps the defaults for anything unset or invalid', () => {
    expect(supervisorOptions({})).toEqual(DEFAULT_SUPERVISOR_OPTIONS)
    expect(supervisorOptions({
      HARNESSD_BIND_TIMEOUT_MS: '100', HARNESSD_HEARTBEAT_TIMEOUT_MS: '200', HARNESSD_STOP_GRACE_MS: '300',
      HARNESSD_INITIAL_BACKOFF_MS: '0', HARNESSD_MAX_BACKOFF_MS: '50', HARNESSD_BACKOFF_RESET_MS: '0',
      HARNESSD_RSS_LIMIT_MIB: '0', HARNESSD_UPDATE_PROBATION_MS: '10',
    })).toEqual({
      bindTimeoutMs: 100, heartbeatTimeoutMs: 200, stopGraceMs: 300, initialBackoffMs: 0, maxBackoffMs: 50,
      backoffResetMs: 0, rssLimitMiB: 0, updateProbationMs: 10,
    })
    expect(supervisorOptions({ HARNESSD_BIND_TIMEOUT_MS: '0', HARNESSD_HEARTBEAT_TIMEOUT_MS: 'soon', HARNESSD_RSS_LIMIT_MIB: '-1' }))
      .toEqual(DEFAULT_SUPERVISOR_OPTIONS)
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
    handle.send({ type: 'harnessd:status', status: { state: 'running', corePid: 1, restarts: 0, lastExit: null, protocol: 1 } })
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
