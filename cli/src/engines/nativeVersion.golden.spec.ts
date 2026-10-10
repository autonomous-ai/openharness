/** Healthy native version and hook selection, recorded before the probe becomes asynchronous. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ major: 1, stamp: 1, calls: [] as unknown[] }))
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  const answer = (binary: string, args: readonly string[]) => {
    if (binary !== '/fixture/bin/opencode' || JSON.stringify(args) !== '["--version"]') throw Error('Host binaries are forbidden in this golden')
    native.calls.push([binary, args])
    return native.major === 1 ? '1.18.31\n' : 'opencode v2.0.18\n'
  }
  return { ...actual, execFileSync: answer,
    execFile: (binary: string, args: string[], _options: unknown, callback: (error: null, stdout: string, stderr: string) => void) => {
      queueMicrotask(() => callback(null, answer(binary, args), ''))
      return { kill: () => true }
    },
    exec: () => { throw Error('Host shells are forbidden in this golden') },
    execSync: () => { throw Error('Host shells are forbidden in this golden') },
    spawn: () => { throw Error('Host processes are forbidden in this golden') },
    spawnSync: () => { throw Error('Host processes are forbidden in this golden') },
  }
})
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, statSync: (file: string, ...args: unknown[]) => file === '/fixture/bin/opencode'
    ? { dev: 1, ino: native.stamp, size: 64, mtimeMs: native.stamp, ctimeMs: native.stamp, mode: 0o100755,
      isFile: () => true, isSymbolicLink: () => false }
    : (actual.statSync as (...args: unknown[]) => unknown)(file, ...args) }
})
vi.mock('../lib/loginShellEnv.js', () => ({ loginShellEnvironment: () => ({}) }))

const GOLDEN = fileURLToPath(new URL('./__fixtures__/native-version.golden.json', import.meta.url))
const record = process.env.RECORD_NATIVE_VERSION_GOLDEN === '1'
const observations: Record<string, unknown> = {}
const expected = record ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))

it.each(['linux', 'darwin'])('preserves versioned native hook selection on %s', async platform => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-version-golden-')))
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-10T15:00:00Z') })
    for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'OPENCODE_CONFIG_DIR', 'OPENCODE_DATA_DIR']) {
      const path = join(root, name); mkdirSync(path, { recursive: true }); vi.stubEnv(name, path)
    }
    vi.stubEnv('OPENCODE_PATH', '/fixture/bin/opencode'); vi.stubEnv('TZ', 'UTC')
    vi.resetModules()
    const { installOpencodePluginBeforeSpawn } = await import('../core/engines/hooks.js')
    const { opencodeMajorVersion } = await import('./launchControl.js')
    const { OPENCODE_LEGACY_PLUGIN, OPENCODE_TUI_PLUGIN } = await import('./opencode/contract.js')
    const { VERSION } = await import('../version.js')
    const files = () => [OPENCODE_LEGACY_PLUGIN.file, OPENCODE_TUI_PLUGIN.file].map(file => ({
      file, source: existsSync(file) ? readFileSync(file, 'utf8').split(VERSION).join('<version>') : null,
    }))
    for (const major of [1, 2]) {
      native.major = major; native.stamp = major; native.calls.length = 0
      const installed = await installOpencodePluginBeforeSpawn(4242)
      const first = await opencodeMajorVersion(), repeat = await opencodeMajorVersion()
      const key = `${platform}:v${major}`
      observations[key] = JSON.parse(JSON.stringify({ installed, first, repeat, calls: native.calls, files: files() }).split(root).join('<root>'))
      if (!record) expect({ key, value: observations[key] }).toEqual({ key, value: expected[key] })
    }
  } finally {
    log.mockRestore(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetModules()
    Object.defineProperty(process, 'platform', descriptor)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

afterAll(() => {
  if (record) writeFileSync(GOLDEN, JSON.stringify(observations, null, 2) + '\n')
  else expect(Object.keys(observations).sort()).toEqual(Object.keys(expected).sort())
})
