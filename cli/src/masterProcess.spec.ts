import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROBE_ANSWER } from './harnessd/reexec.js'
import type { LeanBundle } from './lib/leanBundle.js'

const runMaster = vi.hoisted(() => vi.fn((_config: Record<string, unknown>) => 'supervisor'))
vi.mock('./harnessd/master.js', async (real) => ({ ...await real<object>(), runMaster }))
const leanBundle = vi.hoisted(() => ({ read: vi.fn((_bundle: Buffer): LeanBundle | null => null) }))
vi.mock('./lib/leanBundle.js', async (real) => ({ ...await real<object>(), readLeanBundle: (bundle: Buffer) => leanBundle.read(bundle) }))

const { BUNDLE_ENV, BUNDLE_SHA256_ENV, LEAN_DIR, probeLean, probeThisMaster, processBundleDeps, startMaster, startMasterFromBundle } = await import('./masterProcess.js')
type Deps = Parameters<typeof startMasterFromBundle>[1] & object

const LEAN: LeanBundle = { code: Buffer.from('lean'), sha256: 'a'.repeat(64), bundleSha256: 'b'.repeat(64) }

function deps(over: Partial<Deps> = {}) {
  const calls = { starts: [] as unknown[], execs: [] as Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }>, logs: [] as string[], probes: [] as Array<{ path: string; env: NodeJS.ProcessEnv }> }
  const given: Deps = {
    env: { HOME: '/home/someone' },
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
    const handed = { HOME: '/home/someone', [BUNDLE_ENV]: '/cli/cli.js', [BUNDLE_SHA256_ENV]: 'b'.repeat(64) }
    expect(calls.probes).toEqual([{ path: '/data/lean/harnessd-aaaa.mjs', env: handed }])
    expect(calls.execs).toEqual([{ file: process.execPath, args: [process.execPath, ...process.execArgv, '/data/lean/harnessd-aaaa.mjs', '__harnessd'], env: handed }])
    expect(calls.starts).toEqual([])
    expect(calls.logs).toEqual([])
  })

  it('runs from cli.js, with the services still from the lean bundle, where this Node cannot re-execute', () => {
    const { given, calls } = deps({ execve: null })
    startMasterFromBundle('/cli/cli.js', given)
    expect(calls.starts).toEqual([{ scriptPath: '/cli/cli.js', serviceScriptPath: '/data/lean/harnessd-aaaa.mjs' }])
    expect(calls.logs).toEqual(['[harnessd] this Node cannot re-execute the master: it runs from /cli/cli.js, the services from /data/lean/harnessd-aaaa.mjs'])
    const failing = deps({ execve: () => { throw new Error('E2BIG') } })
    startMasterFromBundle('/cli/cli.js', failing.given)
    expect(failing.calls.starts).toEqual([{ scriptPath: '/cli/cli.js', serviceScriptPath: '/data/lean/harnessd-aaaa.mjs' }])
    expect(failing.calls.logs[0]).toContain('could not re-execute on /data/lean/harnessd-aaaa.mjs (E2BIG)')
    const thrown = deps({ execve: () => { throw 'refused' } })
    startMasterFromBundle('/cli/cli.js', thrown.given)
    expect(thrown.calls.logs[0]).toContain('(refused)')
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
    expect(none.calls.logs).toEqual(['[harnessd] no lean bundle in /cli/cli.js: the master and the services run from it'])
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
    expect(real.start).toBe(startMaster)
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
    expect(LEAN_DIR).toMatch(/[\\/]lean$/)
  })

  it('answers the probe a re-executing master asks', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(probeThisMaster()).toBe(0)
    expect(String(log.mock.calls[0][0])).toContain(PROBE_ANSWER)
    log.mockRestore()
  })
})
