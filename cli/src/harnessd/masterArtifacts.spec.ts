import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fingerprint } from './bundleFingerprint.js'
import { runMaster, type MasterConfig } from './master.js'
import { WORKER_CONTRACT, WORKER_PLAN } from './workerContract.js'
import { folderFingerprint } from './leanBundle.js'

type Record = { role: string; pid: number; script: string; cli: string | null; services: string | null; updates: string | null; install: string }
const modern = `harnessd-probe ok · protocol 7 · vfixture · takes a handover · worker-cohort ${WORKER_CONTRACT} ${WORKER_PLAN}`
const legacy = 'harnessd-probe ok · protocol 6 · vfixture · takes a handover'

describe('owned packaged child execution', { timeout: 15_000 }, () => {
  let directory: string, selected: string, seen: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'harnessd-artifacts-'))
    selected = join(directory, 'cli.mjs'); seen = join(directory, 'seen')
    for (const name of ['home', 'data', 'runtime', 'tmp']) mkdirSync(join(directory, name))
  })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks() })
  const records = (): Record[] => existsSync(seen) ? readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record) : []
  const body = (answer = modern) => `
    import { appendFileSync, readFileSync } from 'node:fs'
    import { createHash } from 'node:crypto'
    const role = process.argv[2] === '__service' ? process.argv[3] : process.argv[2]
    if (role === '__harnessd-probe') { console.log(${JSON.stringify(answer)}); process.exit(0) }
    if (${JSON.stringify(answer)} === ${JSON.stringify(modern)}) {
      const expected = process.env.HARNESSD_WORKER_COHORT?.split(':')
      const actual = createHash('sha256').update(readFileSync(process.argv[1])).digest('hex')
      if (expected?.[0] !== String(process.ppid) || expected[3] !== actual) process.exit(2)
    }
    appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ role, pid: process.pid, script: process.argv[1],
      cli: process.env.HARNESSD_CORE_SCRIPT ?? null, services: process.env.HARNESSD_SERVICES ?? null,
      updates: process.env.HARNESSD_UPDATES ?? null, install: process.env.ADAPTER_CLI_DIR }) + '\\n')
    if (role === '__run') { process.send({ type: 'harnessd:bound', protocol: 7, port: 1 }); process.send({ type: 'harnessd:ready' }) }
    setInterval(() => process.send?.({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1, loopDelayMs: 0 }), 50)
    process.on('message', message => { if (message.type === 'harnessd:shutdown') process.exit(0) })
    process.on('SIGTERM', () => process.exit(0))
  `
  const owner = (leanCore?: string, leanScript?: string) => {
    let active = false
    const releases: number[] = []
    const prepare = vi.fn((originalScript: string, expected: string) => {
      expect(active).toBe(false)
      expect(fingerprint(originalScript)).toBe(expected)
      active = true
      const fullScript = join(directory, `cohort-${expected}.mjs`)
      copyFileSync(originalScript, fullScript)
      return {
        selected: expected, originalScript, fullScript, probeScript: fullScript, fullFingerprint: expected,
        ...(leanCore ? { leanCoreScript: leanCore, leanCoreFingerprint: fingerprint(leanCore)! } : {}),
        ...(leanScript ? { leanScript, leanFingerprint: folderFingerprint(dirname(leanScript))!, leanEntryFingerprint: fingerprint(leanScript)! } : {}),
        release: () => {
          // The claim cannot disappear while any child that used it still exists.
          for (const record of records()) expect(() => process.kill(record.pid, 0)).toThrow()
          active = false; releases.push(prepare.mock.calls.length)
        },
      }
    })
    return { prepare, releases }
  }
  const start = (executionArtifacts: ReturnType<typeof owner>, more: Partial<MasterConfig> = {}) => {
    const exits: number[] = [], lines: string[] = []
    const signals = new Map<string, () => void>()
    vi.spyOn(console, 'log').mockImplementation(line => { lines.push(String(line)) })
    const supervisor = runMaster({
      nodePath: process.execPath, execArgv: [], scriptPath: selected, pidFile: join(directory, 'pid'),
      env: {
        ...Object.fromEntries(['SystemRoot', 'WINDIR'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : [])),
        HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home'), TEMP: join(directory, 'tmp'), TMP: join(directory, 'tmp'),
        ADAPTER_DATA_DIR: join(directory, 'data'), ADAPTER_RUNTIME_DIR: join(directory, 'runtime'), ADAPTER_CLI_DIR: directory,
        HARNESSD_SERVICES: 'search', HARNESSD_SERVICE_RESTART_MS: '1',
      },
      restoreUpdate: () => {}, confirmUpdate: () => {}, execve: null,
      onSignal: (signal, listener) => signals.set(signal, listener), exit: code => { exits.push(code) },
      executionArtifacts, ...more,
    } as MasterConfig)
    const stop = async () => {
      signals.get('SIGTERM')!()
      await vi.waitFor(() => expect(exits).toEqual([0]), { timeout: 5_000 })
    }
    return { supervisor, lines, exits, stop }
  }

  it('probes and starts its own cohort from one immutable payload and releases only after actual exits', async () => {
    writeFileSync(selected, body())
    const artifacts = owner(), master = start(artifacts)
    try {
      await vi.waitFor(() => expect(records()).toHaveLength(2))
      expect(artifacts.prepare).toHaveBeenCalledTimes(1)
      for (const record of records()) {
        expect(record.script).not.toBe(selected)
        expect(record.cli).toBe(selected)
      }
      expect(artifacts.releases).toEqual([])
      expect(master.supervisor.status().state).toBe('running')
    } finally { await master.stop() }
    expect(artifacts.releases).toEqual([1])
  })

  it.each(['harnessd-probe ok', modern.replace(WORKER_PLAN, 'a'.repeat(64))])('starts no child for an unadmitted packaged probe: %s', async answer => {
    writeFileSync(selected, body(answer))
    const artifacts = owner(), master = start(artifacts)
    try {
      await vi.waitFor(() => expect(master.supervisor.status().lastExit).toBe('bundle admission refused'))
      expect(records()).toEqual([])
      expect(master.supervisor.status().corePid).toBeNull()
    } finally { await master.stop() }
    expect(artifacts.releases).toEqual([1])
  })

  it.each([false, true])('admits legacy inline core only with its verified lean entry (present=%s)', async hasLean => {
    writeFileSync(selected, body(legacy))
    const leanCore = join(directory, 'harnessd-core.mjs')
    if (hasLean) writeFileSync(leanCore, body(legacy))
    const artifacts = owner(hasLean ? leanCore : undefined), master = start(artifacts, { updater: true })
    try {
      if (!hasLean) {
        await vi.waitFor(() => expect(master.supervisor.status().lastExit).toBe('bundle admission refused'))
        expect(records()).toEqual([])
      } else {
        await vi.waitFor(() => expect(records()).toHaveLength(2))
        const core = records().find(record => record.role === '__run')!
        expect(core).toMatchObject({ script: leanCore, cli: selected, services: 'none', updates: 'master' })
        const updater = records().find(record => record.role === 'updater')!
        expect(updater.script).not.toBe(selected)
        expect(updater.install).toBe(directory)
        expect(records().map(record => record.role).sort()).toEqual(['__run', 'updater'])
      }
    } finally { await master.stop() }
  })

  it('restarts a worker from its running cohort while the canonical CLI points at staged legacy code', async () => {
    writeFileSync(selected, body())
    const artifacts = owner(), master = start(artifacts)
    try {
      await vi.waitFor(() => expect(records()).toHaveLength(2))
      const worker = records().find(record => record.role === 'search')!
      writeFileSync(selected, 'throw new Error("unadmitted staged code ran")')
      process.kill(worker.pid, 'SIGKILL')
      await vi.waitFor(() => expect(records().filter(record => record.role === 'search')).toHaveLength(2), { timeout: 5_000 })
      expect(records().filter(record => record.role === 'search').map(record => record.script)).toEqual([worker.script, worker.script])
      expect(artifacts.prepare).toHaveBeenCalledTimes(1)
      expect(master.supervisor.status().state).toBe('running')
    } finally { await master.stop() }
  })

  it('never spawns a probe or child when artifact preparation fails', async () => {
    writeFileSync(selected, body())
    const artifacts = owner()
    artifacts.prepare.mockImplementation(() => { throw new Error('worker_artifact_source_changed') })
    const master = start(artifacts)
    try {
      await vi.waitFor(() => expect(master.supervisor.status().lastExit).toBe('bundle admission refused'))
      expect(records()).toEqual([])
      expect(master.lines.some(line => line.includes('worker_artifact_source_changed'))).toBe(true)
    } finally { await master.stop() }
    expect(artifacts.releases).toEqual([])
  })

  it.each(['worker_artifact_source_close_unsettled', 'worker_artifact_cleanup_unsettled'])('names %s and the required supervisor restart without losing its refusal state', async code => {
    writeFileSync(selected, body())
    const artifacts = owner()
    artifacts.prepare.mockImplementation(() => { throw new Error(code) })
    const master = start(artifacts)
    try {
      await vi.waitFor(() => expect(master.supervisor.status().lastExit).toBe('bundle admission refused'))
      expect(master.lines.some(line => line.includes(code) && line.includes('restart the supervisor'))).toBe(true)
      expect(records()).toEqual([])
    } finally { await master.stop() }
  })

  it.each([new Error('private preparation details'), 'private preparation details'])('sanitizes an unexpected helper failure (%#)', async failure => {
    writeFileSync(selected, body())
    const artifacts = owner()
    artifacts.prepare.mockImplementation(() => { throw failure })
    const master = start(artifacts)
    try {
      await vi.waitFor(() => expect(master.supervisor.status().lastExit).toBe('bundle admission refused'))
      expect(master.lines.some(line => line.includes('worker_artifact_prepare_failed'))).toBe(true)
      expect(master.lines.join('\n')).not.toContain('private preparation details')
      expect(records()).toEqual([])
    } finally { await master.stop() }
  })

  it('keeps synchronous core and service spawn failures inside their no-PID backoff owners', async () => {
    writeFileSync(selected, body())
    const artifacts = owner()
    const master = start(artifacts, { executionArtifacts: undefined, execArgv: ['\0'] })
    try {
      expect(master.supervisor.status()).toMatchObject({ corePid: null, lastExit: 'bundle admission refused' })
      expect(master.supervisor.status().services).toEqual([expect.objectContaining({ name: 'search', pid: null })])
      expect(records()).toEqual([])
    } finally { await master.stop() }
  })

  it.each([false, true])('keeps modern lean selection and its full fallback inside one owned payload (lean off=%s)', async off => {
    writeFileSync(selected, body())
    const leanFolder = join(directory, 'lean'); mkdirSync(leanFolder)
    const leanScript = join(leanFolder, 'harnessd.mjs'), leanCore = join(leanFolder, 'harnessd-core.mjs')
    writeFileSync(leanScript, body()); writeFileSync(leanCore, body())
    const artifacts = owner(leanCore, leanScript), master = start(artifacts, { leanArtifacts: !off })
    try {
      await vi.waitFor(() => expect(records()).toHaveLength(2))
      const worker = records().find(record => record.role === 'search')!
      const core = records().find(record => record.role === '__run')!
      if (off) {
        expect(core.script).toBe(worker.script)
        expect(core.script).not.toBe(selected)
      } else {
        expect(core.script).toBe(leanCore); expect(worker.script).toBe(leanScript)
        rmSync(leanScript)
        process.kill(worker.pid, 'SIGKILL')
        await vi.waitFor(() => expect(records().filter(record => record.role === 'search')).toHaveLength(2), { timeout: 5_000 })
        const restarted = records().at(-1)!
        expect(restarted.script).not.toBe(selected)
        expect(restarted.script).not.toBe(leanScript)
        expect(restarted.cli).toBe(selected)
      }
    } finally { await master.stop() }
  })

  it('retains failed release ownership and refuses another cohort after actual children exit', async () => {
    writeFileSync(selected, body())
    const artifacts = owner(), prepare = artifacts.prepare.getMockImplementation()!
    artifacts.prepare.mockImplementation((original, expected) => {
      const artifact = prepare(original, expected)
      return { ...artifact, release: () => {
        for (const record of records()) expect(() => process.kill(record.pid, 0)).toThrow()
        throw new Error('worker_artifact_release_failed')
      } }
    })
    const master = start(artifacts)
    try {
      await vi.waitFor(() => expect(records()).toHaveLength(2))
      writeFileSync(selected, `${body()}\n// next cohort`)
      process.kill(records().find(record => record.role === '__run')!.pid, 'SIGKILL')
      await vi.waitFor(() => expect(master.supervisor.status().lastExit).toBe('bundle admission refused'), { timeout: 5_000 })
      expect(artifacts.prepare).toHaveBeenCalledTimes(1)
      expect(records()).toHaveLength(2)
      expect(master.lines.some(line => line.includes('worker_artifact_release_failed'))).toBe(true)
    } finally { await master.stop() }
  })

  it('reacquires the exact payload after a POSIX exec refusal before restarting children', async () => {
    writeFileSync(selected, body())
    const artifacts = owner(), execve = vi.fn(() => { throw new Error('exec arguments rejected') })
    const master = start(artifacts, { bundleFingerprint: 'prior', reexecMarkerFile: join(directory, 'marker'), execve })
    try {
      await vi.waitFor(() => expect(records()).toHaveLength(2))
      expect(execve).toHaveBeenCalledTimes(1)
      expect(artifacts.prepare).toHaveBeenCalledTimes(2)
      expect(artifacts.prepare.mock.calls[0]).toEqual(artifacts.prepare.mock.calls[1])
      expect(artifacts.releases).toEqual([1])
    } finally { await master.stop() }
    expect(artifacts.releases).toEqual([1, 2])
  })

  it('refuses selection that changes while the failed-exec payload is being reacquired', async () => {
    writeFileSync(selected, body())
    const artifacts = owner(), prepare = artifacts.prepare.getMockImplementation()!
    artifacts.prepare.mockImplementation((original, expected) => {
      const artifact = prepare(original, expected)
      if (artifacts.prepare.mock.calls.length === 2) writeFileSync(selected, `${body()}\n// published during reacquisition`)
      return artifact
    })
    const execve = vi.fn(() => { throw new Error('exec arguments rejected') })
    const master = start(artifacts, { bundleFingerprint: 'prior', reexecMarkerFile: join(directory, 'marker'), execve })
    try {
      await vi.waitFor(() => expect(master.supervisor.status().lastExit).toBe('bundle admission refused'))
      expect(execve).toHaveBeenCalledTimes(1)
      expect(artifacts.prepare).toHaveBeenCalledTimes(2)
      expect(records()).toEqual([])
      expect(master.supervisor.status().corePid).toBeNull()
    } finally { await master.stop() }
    expect(artifacts.releases).toEqual([1, 2])
  })

  it.each([['search', true], ['__run', true], ['search', false]] as const)('refuses a changed entry before a replacement %s PID exists (packaged=%s)', async (role, packaged) => {
    writeFileSync(selected, body())
    const artifacts = owner(), master = start(artifacts, packaged ? {} : { executionArtifacts: undefined })
    try {
      await vi.waitFor(() => expect(records()).toHaveLength(2))
      const child = records().find(record => record.role === role)!
      if (packaged) writeFileSync(child.script, 'throw new Error("corrupt claimed entry executed")')
      else rmSync(child.script)
      process.kill(child.pid, 'SIGKILL')
      await vi.waitFor(() => expect(master.lines.some(line => line.includes('worker_artifact_changed'))).toBe(true), { timeout: 5_000 })
      expect(records()).toHaveLength(2)
      if (role === '__run') expect(master.supervisor.status()).toMatchObject({ corePid: null, lastExit: 'bundle admission refused' })
      else expect(master.supervisor.status().services).toEqual([expect.objectContaining({ name: 'search', pid: null })])
    } finally { await master.stop() }
  })

  it('refuses a legacy core restart when another file in its verified lean payload changes', async () => {
    writeFileSync(selected, body(legacy))
    const leanFolder = join(directory, 'lean'); mkdirSync(leanFolder)
    const leanScript = join(leanFolder, 'harnessd.mjs'), leanCore = join(leanFolder, 'harnessd-core.mjs')
    writeFileSync(leanScript, body(legacy)); writeFileSync(leanCore, body(legacy))
    const artifacts = owner(leanCore, leanScript), master = start(artifacts)
    try {
      await vi.waitFor(() => expect(records()).toHaveLength(1))
      writeFileSync(leanScript, '// changed imported code')
      process.kill(records()[0].pid, 'SIGKILL')
      await vi.waitFor(() => expect(master.supervisor.status().lastExit).toBe('bundle admission refused'), { timeout: 5_000 })
      expect(records()).toHaveLength(1)
      expect(master.lines.some(line => line.includes('worker_artifact_changed'))).toBe(true)
    } finally { await master.stop() }
  })

  it('refuses POSIX replacement when the probe claim cannot be released', async () => {
    writeFileSync(selected, body())
    const artifacts = owner(), prepare = artifacts.prepare.getMockImplementation()!
    artifacts.prepare.mockImplementation((original, expected) => ({ ...prepare(original, expected),
      release: () => { throw new Error('worker_artifact_release_failed') } }))
    const execve = vi.fn()
    const master = start(artifacts, { bundleFingerprint: 'prior', reexecMarkerFile: join(directory, 'marker'), execve })
    try {
      await vi.waitFor(() => expect(master.supervisor.status().lastExit).toBe('bundle admission refused'))
      expect(execve).not.toHaveBeenCalled()
      expect(artifacts.prepare).toHaveBeenCalledTimes(1)
      expect(records()).toEqual([])
    } finally { await master.stop() }
  })
})
