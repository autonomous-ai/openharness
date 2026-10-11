/** Healthy launch behavior from main, before native preparation is shared by all entry points. */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { shellSingleQuote } from '../lib/shellQuote.js'

const GOLDEN = fileURLToPath(new URL('./__fixtures__/native-launch-compatibility.golden.json', import.meta.url))
const RECORD = process.env.RECORD_NATIVE_LAUNCH_GOLDEN === '1'
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
let root: string

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-launch-golden-')))
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-11T00:00:00Z'))
  for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HERMES_HOME', 'OPENCODE_DATA_DIR', 'OPENCODE_CONFIG_DIR', 'ZDOTDIR']) {
    const directory = join(root, name.toLowerCase()); mkdirSync(directory); vi.stubEnv(name, directory)
  }
  for (const name of ['CLAUDE_PATH', 'CODEX_PATH', 'CURSOR_PATH', 'OPENCODE_PATH', 'PI_PATH', 'HERMES_PATH', 'COMMANDCODE_PATH', 'DEVIN_PATH', 'MUSE_PATH', 'AMP_PATH', 'KILO_PATH', 'GROK_PATH', 'AGY_PATH', 'COPILOT_PATH', 'HARNESS_GRID_BIN']) vi.stubEnv(name, '')
  vi.stubEnv('TZ', 'UTC'); vi.stubEnv('SHELL', '/bin/sh'); vi.stubEnv('PATH', '/usr/bin:/bin')
  vi.resetModules()
})
afterAll(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true })
})
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value).split(root).join('<root>')
  .split(process.execPath).join('<node>').split(dirname(process.execPath)).join('<node-dir>'))

it('preserves native arguments, first messages and healthy installer effects', async () => {
  const { ENGINES } = await import('./types.js')
  const { buildEngineCommandArgv, buildEngineLaunchArgv } = await import('../lib/engineLaunch.js')
  const { engineBin } = await import('../lib/engineBin.js')
  const { env } = await import('../config/env.js')
  const { inspectNativeLaunch } = await import('./nativeLaunch.js')
  const { createNativeInstallations, NATIVE_INSTALL_WORKER } = await import('./kit/nativeInstall.js')
  const { launchScriptOf } = await import('../testing/launchScript.js')
  const actual: Record<string, unknown> = {}
  const commands = join(root, 'commands'); mkdirSync(commands)
  vi.stubEnv('PATH', `${commands}:/usr/bin:/bin`)
  for (const engine of ENGINES.filter(engine => engine !== 'terminal')) {
    const command = engineBin(engine), executable = join(commands, command)
    writeFileSync(executable, '#!/bin/sh\ncase "$1" in --version) printf "1.0.0\\n";; --help) printf -- "--auto --permission-mode --approve-for-me\\n";; esac\n', { mode: 0o700 })
    const prepared = await inspectNativeLaunch(engine)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw Error(prepared.detail)
    expect(prepared.launch.executable?.command).toBe(executable)
    expect(await prepared.launch.prepareHooks(0, () => true)).toBe(true)
    for (const [name, options] of Object.entries({
      fresh: {}, resume: { resumeSessionId: 'fixture-conversation' }, fork: { forkSessionId: 'fixture-parent' },
      permission: { permissionMode: 'auto' as const, bypassPermission: true, extraArgs: ['--model', 'fixture/model'] },
      first: { firstPrompt: 'literal ; $(first message)' },
    })) {
      try {
        const argv = buildEngineCommandArgv(engine, { ...options, native: prepared.launch })
        expect(argv[0]).toBe(executable)
        actual[`${engine} ${name}`] = [command, ...argv.slice(1)]
      }
      catch (error) { actual[`${engine} ${name}`] = { refused: (error as Error).name, detail: (error as Error).message } }
    }
  }
  for (const kind of ['installed', 'vendor', 'fallback', 'npm'] as const) {
    const directory = join(root, kind); mkdirSync(directory)
    const trace = join(directory, 'trace'), binary = join(directory, 'engine'), source = join(directory, 'source')
    writeFileSync(source, `#!/bin/sh\ncase "$1" in --version) printf '1.0.0\\n'; exit 0;; esac\nprintf 'engine\\n' >>${shellSingleQuote(trace)}\nprintf '%s\\n' "$@" >>${shellSingleQuote(trace)}\n`, { mode: 0o700 })
    if (kind === 'installed') writeFileSync(binary, readFileSync(source), { mode: 0o700 })
    const install = `printf 'install:%s\\n' "\${npm_config_prefix:-vendor}" >>${shellSingleQuote(trace)}; cp ${shellSingleQuote(source)} ${shellSingleQuote(binary)}`
    const recipe = { source: 'private fixture',
      command: kind === 'fallback' ? `printf 'primary\\n' >>${shellSingleQuote(trace)}` : install,
      ...(kind === 'fallback' ? { fallback: install } : {}),
      executable: { names: ['harness-fixture-missing'], absolutePaths: [binary], ...(kind === 'npm' ? { npmGlobal: true } : {}) },
    }
    // The only npm is a private prerequisite fixture. No package manager or network command runs.
    const bin = join(directory, 'bin'); mkdirSync(bin)
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`)
    env.OPENCODE_PATH = binary
    const environment = { HOME: process.env.HOME!, PATH: `${bin}:/usr/bin:/bin`, SHELL: '/bin/sh' }
    let completed: Promise<void> | undefined
    const installation = createNativeInstallations({ directory: join(directory, 'claims'), node: () => process.execPath,
      dispatch: (node, file, hash) => {
        completed = new Promise((done, failed) => {
          execFile(node, ['-e', NATIVE_INSTALL_WORKER, file, hash], { env: { ...process.env, ...environment }, timeout: 10_000 },
            error => error ? failed(error) : done())
        })
      },
    })
    await installation.ensure('opencode', recipe, environment, kind, () => true)
    expect(completed).toBeDefined()
    await completed
    expect(await installation.ensure('opencode', recipe, environment, kind, () => true)).toEqual({ complete: true })
    expect(existsSync(trace) ? readFileSync(trace, 'utf8') : '').not.toContain('engine\n')
    const prepared = await inspectNativeLaunch('opencode')
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw Error(prepared.detail)
    expect(await prepared.launch.prepareHooks(0, () => true)).toBe(true)
    const argv = buildEngineLaunchArgv('opencode', { native: prepared.launch, firstPrompt: 'literal ; $(first message)' }, '/bin/sh', process.execPath, '/fixture/grid', null)
    const script = launchScriptOf(argv)
    const result = await new Promise<{ code: number | string; stderr: string }>(done => {
      execFile('/bin/sh', ['-c', script, ...argv.slice(argv.indexOf('harness-engine'))],
        { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }, timeout: 10_000 },
        (error, _stdout, stderr) => done({ code: error?.code ?? 0, stderr }))
    })
    expect(result).toEqual({ code: 0, stderr: '' })
    actual[`installation ${kind}`] = { code: result.code, trace: readFileSync(trace, 'utf8').split('\n').filter(Boolean), executable: existsSync(binary) }
  }
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(normalize(actual), null, 2) + '\n')
  else expect(normalize(actual)).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')))
}, 60_000)

it('contains no host paths or host executable', () => {
  const text = readFileSync(GOLDEN, 'utf8')
  expect(text).not.toContain(root)
  expect(text).not.toContain(process.execPath)
  expect(text).not.toMatch(/\/Users\/|\/home\/runner|native-launch-golden-/)
})
