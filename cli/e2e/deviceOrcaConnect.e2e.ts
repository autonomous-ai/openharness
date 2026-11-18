/**
 * `harness device orca status` and `connect` from the built `cli.js` (docs/plans/2026-11-18-connect-orca-design.md),
 * run as the Harness app runs them, against a fake `orca` (testing/fakeOrcaCli.ts):
 * - the build's own plugin is written into the home's .harness, private, at the build's version, before Orca is asked;
 * - `status` follows what Orca lists: `offer`, `current`, `behind`, `off`, and `absent` for an Orca that is not running;
 * - `connect` prints the access Orca lists and passes no fingerprint; only `connect --approve` installs, and records it;
 * - a plugin `behind` is updated, and one the person removed is never installed again.
 *
 * It is the only test that reads the `__ORCA_PLUGIN__` a build inlined. No daemon is started: the harness gives each
 * test a throwaway home and data folder, and its launcher, first on PATH and the Orca app's own (HARNESS_ORCA_APP_BIN),
 * is the fake, so neither PATH nor /Applications reaches the real Orca every session here runs inside.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { fakeOrcaCli, type FakeOrcaCli } from '../src/testing/fakeOrcaCli.js'
import { CLI_ROOT, IsolatedDaemon } from './harness/daemon.js'

const { extensionVersion } = await import('../scripts/lib/vscodeExtensionBundle.mjs') as { extensionVersion: (version: string) => string }

const KEY = 'local.harness-device'
const FP = 'ap1-0123456789abcdef0123456789abcdef'
const EXECUTION = 'Runs its own code in a separate Node.js process on the Orca host, with your user account’s access to that machine.'
const WORKSPACE_READ = 'Read your projects and workspaces (names, branches, paths and agent status) and the terminals in them, and get notified when they change'
const PLUGIN_ROOT = join(CLI_ROOT, '..', 'plugins', 'harness-device-orca')

let bundleDir: string | null = null
let bundle = ''
beforeAll(() => {
  // The run's bundle when there is one (E2E_BUNDLE=1), else one built for this file, as it ships.
  if (process.env.E2E_BUNDLE_PATH) { bundle = process.env.E2E_BUNDLE_PATH; return }
  bundleDir = mkdtempSync(join(tmpdir(), 'harness-orca-e2e-'))
  execFileSync(process.execPath, ['build-bundle.mjs'], { cwd: CLI_ROOT, env: { ...process.env, BUNDLE_OUT_DIR: bundleDir }, stdio: 'pipe' })
  bundle = join(bundleDir, 'cli.js')
}, 180_000)
afterAll(() => { if (bundleDir) rmSync(bundleDir, { recursive: true, force: true }) })

/** Every file and folder under [folder], relative to it, with its permission bits. */
function modes(folder: string): Record<string, number> {
  const found: Record<string, number> = {}
  for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name)
    found[relative(folder, path)] = statSync(path).mode & 0o777
  }
  return found
}

describe('harness device orca, from the built CLI', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => {
    await daemon?.close()
    daemon = undefined
  })

  /** A throwaway machine, never started, whose `orca` is the fake: written through the harness's `bin/orca` link into
   *  its launcher, as harness/fakeOrca.ts writes its own. */
  async function machine(): Promise<{ d: IsolatedDaemon; orca: FakeOrcaCli; harness: (...words: string[]) => Promise<{ code: number | null; out: string; err: string }> }> {
    const d = await IsolatedDaemon.create()
    daemon = d
    const orca = fakeOrcaCli(join(d.root, 'orca-cli'), join(dirname(d.env.CLAUDE_PATH!), 'orca'))
    const harness = (...words: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [bundle, ...words], { cwd: d.root, env: d.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
      child.on('close', (code) => resolve({ code, out, err }))
    })
    return { d, orca, harness }
  }

  /** An Orca that is running, at a version the plugin takes, listing [plugins]. */
  const running = (orca: FakeOrcaCli, plugins: unknown[] = []) => {
    orca.answer('status', { id: 'req-1', ok: true, result: { app: { running: true }, runtime: { reachable: true, appVersion: '1.4.262' } } })
    orca.answer('plugin inspect', { id: 'req-2', ok: true, result: { plugin: { pluginKey: KEY } } })
    orca.answer('plugin list', { id: 'req-3', ok: true, result: { plugins } })
  }
  const listed = (version: string, reference: string) => ({
    pluginKey: KEY, name: 'Harness Device', version, status: 'running', needsReconsent: false, isDev: false,
    source: { kind: 'local-path', reference },
  })
  const record = (d: IsolatedDaemon): Record<string, unknown> => {
    const file = join(d.dataDir, 'dial-skill.json')
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : {}
  }

  it('offers the plugin, shows what Orca lists, installs it only with the fingerprint, then follows the list', async () => {
    const { d, orca, harness } = await machine()
    running(orca)
    const folder = join(d.env.HOME!, '.harness', 'orca-plugin')

    expect(await harness('device', 'orca', 'status', '--json')).toEqual({ code: 0, out: '{"orca":"offer"}\n', err: '' })
    expect(orca.calls()[0]).toBe('status --json')
    expect(orca.calls()).toContain(`plugin inspect ${folder} --json`)
    // The build's plugin: its manifest and every source that is not a test, private to the person.
    const sources = readdirSync(join(PLUGIN_ROOT, 'src')).filter((name) => !/\.test\.tsx?$/.test(name))
    expect(modes(folder)).toEqual(Object.fromEntries([
      ['orca-plugin.json', 0o600], ['src', 0o700], ...sources.map((name) => [join('src', name), 0o600]),
    ]))
    expect(statSync(folder).mode & 0o777).toBe(0o700)
    for (const name of sources) expect(readFileSync(join(folder, 'src', name), 'utf8'), name).toBe(readFileSync(join(PLUGIN_ROOT, 'src', name), 'utf8'))
    const built = (await harness('--version')).out.trim()
    const version = extensionVersion(built)
    expect(JSON.parse(readFileSync(join(folder, 'orca-plugin.json'), 'utf8'))).toMatchObject({ id: 'harness-device', version })

    orca.answer('plugin install', {
      id: 'req-4', ok: false,
      error: {
        code: 'approval_required', message: `${KEY} ${version} needs approval before it can run.\nFingerprint: ${FP}`,
        data: {
          pluginKey: KEY, name: 'Harness Device', version, approvalFingerprint: FP,
          grants: { executionDescription: EXECUTION, capabilities: [{ kind: 'workspace:read', description: WORKSPACE_READ }] },
        },
      },
    }, 3)
    const asked = await harness('device', 'orca', 'connect', '--json')
    expect({ code: asked.code, err: asked.err }).toEqual({ code: 0, err: '' })
    expect(JSON.parse(asked.out)).toStrictEqual({
      connect: 'approve', name: 'Harness Device', version, fingerprint: FP, grants: [EXECUTION, WORKSPACE_READ], update: false,
    })
    expect(orca.calls().at(-1)).toBe(`plugin install ${folder} --json`)
    expect(orca.calls().filter((call) => call.includes('--approve'))).toEqual([])
    expect(record(d)).not.toHaveProperty('orcaConnected')

    orca.answer('plugin install', { id: 'req-5', ok: true, result: { pluginKey: KEY, version } })
    expect(await harness('device', 'orca', 'connect', '--approve', FP, '--json')).toEqual({ code: 0, out: '{"connect":"done"}\n', err: '' })
    expect(orca.calls().at(-1)).toBe(`plugin install ${folder} --approve ${FP} --json`)
    expect(record(d)).toMatchObject({ orcaConnected: true })

    running(orca, [listed(version, folder)])
    expect(await harness('device', 'orca', 'status', '--json')).toEqual({ code: 0, out: '{"orca":"current"}\n', err: '' })

    // Older than any build: the sources' package.json is 0.0.1.
    running(orca, [listed('0.0.0', folder)])
    expect(await harness('device', 'orca', 'status', '--json')).toEqual({ code: 0, out: '{"orca":"behind"}\n', err: '' })
    orca.answer('plugin update', { id: 'req-6', ok: true, result: { pluginKey: KEY, version } })
    expect(await harness('device', 'orca', 'connect', '--json')).toEqual({ code: 0, out: '{"connect":"done"}\n', err: '' })
    expect(orca.calls().at(-1)).toBe(`plugin update ${KEY} --json`)

    // The person removed the plugin in Orca.
    running(orca)
    const before = orca.calls().length
    expect(await harness('device', 'orca', 'status', '--json')).toEqual({ code: 0, out: '{"orca":"off"}\n', err: '' })
    expect(await harness('device', 'orca', 'connect', '--json')).toEqual({ code: 1, out: '{"connect":"failed","error":"off"}\n', err: '' })
    expect(orca.calls().slice(before).filter((call) => call.startsWith('plugin install'))).toEqual([])
  })

  it('an Orca that is not running is absent, and nothing is written', async () => {
    const { d, orca, harness } = await machine()
    orca.answer('status', { id: 'req-1', ok: true, result: { app: { running: false }, runtime: { reachable: false } } })
    expect(await harness('device', 'orca', 'status', '--json')).toEqual({ code: 0, out: '{"orca":"absent"}\n', err: '' })
    expect(orca.calls()).toEqual(['status --json'])
    expect(existsSync(join(d.env.HOME!, '.harness', 'orca-plugin'))).toBe(false)
  })
})
