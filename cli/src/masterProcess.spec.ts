import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from './config/env.js'
import { PROBE_ANSWER } from './harnessd/reexec.js'
import { LEAN_ENTRY, leanFingerprint, type LeanBundle } from './harnessd/leanBundle.js'

const runMaster = vi.hoisted(() => vi.fn((_config: Record<string, unknown>) => 'supervisor'))
vi.mock('./harnessd/master.js', async (real) => ({ ...await real<object>(), runMaster }))
const leanBundle = vi.hoisted(() => ({ read: vi.fn((_bundle: Buffer): LeanBundle | null => null) }))
vi.mock('./harnessd/leanBundle.js', async (real) => ({ ...await real<object>(), readLeanBundle: (bundle: Buffer) => leanBundle.read(bundle) }))

const {
  BUNDLE_ENV, BUNDLE_SHA256_ENV, LEAN_DIR, LEAN_FINGERPRINT_ENV, LEAN_OFF_FILE, masterEnv, probeLean, probeThisMaster, processBundleDeps, startMaster, startMasterFromBundle, startMasterInForeground,
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
    // Not the installed copy: no updater. The installed one runs it.
    expect(config.updater).toBe(false)
    runMaster.mockClear()
    startMaster({ scriptPath: join(env.ADAPTER_CLI_DIR, 'cli.js') })
    expect((runMaster.mock.calls[0][0] as { updater: boolean }).updater).toBe(true)
    expect(LEAN_DIR).toMatch(/[\\/]lean$/)
    expect(LEAN_OFF_FILE).toMatch(/[\\/]lean-off$/)
  })

  it('keeps the services in the core when the core will have no local socket for them to reach it by', () => {
    const given = { HOME: '/home/someone' }
    const logs: string[] = []
    // A socket: the master runs on its environment as it is, the services in their own processes.
    expect(masterEnv(given, '/data/daemon-18473.sock', (line) => logs.push(line))).toBe(given)
    // None (a data folder too deep for one): every service in the core's process, and the log says why.
    expect(masterEnv(given, null, (line) => logs.push(line))).toEqual({ HOME: '/home/someone', HARNESSD_SERVICES: 'none' })
    expect(given).toEqual({ HOME: '/home/someone' })
    expect(logs).toEqual([expect.stringMatching(/\[harnessd\] this data folder is too deep for the daemon's local socket/)])
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
