/**
 * `harness device orca status|enable|disable` from the built `cli.js` (docs/plans/2026-11-19-device-orca-default-on-design.md),
 * run as a person runs them, against a fake `orca` (testing/fakeOrcaCli.ts) that holds the plugin's approvals:
 * - the build's own plugin is written into Harness's data root, private, at the build's version, before Orca is asked;
 * - `status` follows Orca and the records: `setup`, `on`, `off` once removed, and `absent` for an Orca that is not running;
 * - `enable` installs it, passing Orca's fingerprint only for the pinned access, and records it; more access is held;
 * - `disable` marks it removed and uninstalls it, and a later `enable` brings it back;
 * - `connect` is gone;
 * - the devices' process of a daemon on the same build sets it up at a dial's attach, with no command, and keeps a
 *   `disable`.
 *
 * It is the only test that reads the `__ORCA_PLUGIN__` a build inlined. The command's cases start no daemon; the
 * devices' case starts one on the same bundle, as a daemon from the sources carries no plugin. The harness gives each
 * test a throwaway home and data folder, and its launcher, first on PATH and the Orca app's own (HARNESS_ORCA_APP_BIN),
 * is the fake, so neither PATH nor /Applications reaches the real Orca every session here runs inside.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { harnessPath, thisComputer } from '../src/config/harnessHome.js'
import { readSetup } from '../src/devices/dialSkillFiles.js'
import { fakeOrcaCli, type FakeOrcaCli } from '../src/testing/fakeOrcaCli.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'

const { extensionVersion } = await import('../scripts/lib/vscodeExtensionBundle.mjs') as { extensionVersion: (version: string) => string }

const KEY = 'local.harness-device'
const FP = 'ap1-0123456789abcdef0123456789abcdef'
const EXECUTION = 'Runs its own code in a separate Node.js process on the Orca host, with your user account’s access to that machine.'
const WORKSPACE_READ = 'Read your projects and workspaces (names, branches, paths and agent status) and the terminals in them, and get notified when they change'
/** The access Orca 1.4.262 lists for the plugin as it ships, in its shape: what Harness approves. */
const PINNED = {
  execution: 'trusted-worker', executionDescription: EXECUTION,
  capabilities: [{ kind: 'workspace:read', description: WORKSPACE_READ }],
  contributions: [{ kind: 'panels', name: 'Harness Device' }, { kind: 'events', name: 'workspace.changed' }, { kind: 'statusBarItems', name: 'Dial' }],
}
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

  /** The plugin's version in this build: what Orca is asked to install. */
  const builtVersion = async (harness: Awaited<ReturnType<typeof machine>>['harness']): Promise<string> =>
    extensionVersion((await harness('--version')).out.trim())
  /** The plugin's folder where the paths rule puts it for the machine's home and settings, as the command finds it. */
  const pluginFolder = (d: IsolatedDaemon): string => harnessPath('orca-plugin', d.env.HOME!, process.platform, thisComputer(d.env))
  const record = (d: IsolatedDaemon): Record<string, unknown> => {
    const file = join(d.dataDir, 'dial-skill.json')
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : {}
  }

  it("status, enable, disable and enable again, against an Orca that holds the plugin's approvals", async () => {
    const { d, orca, harness } = await machine()
    const version = await builtVersion(harness)
    orca.holds({ key: KEY, version, fingerprint: FP, grants: PINNED })
    const folder = pluginFolder(d)

    expect(await harness('device', 'orca', 'status', '--json')).toEqual({ code: 0, out: '{"orca":"setup"}\n', err: '' })
    expect(orca.calls()[0]).toBe('status --json')
    expect(orca.calls()).toContain(`plugin inspect ${folder} --json`)
    // The build's plugin: its manifest and every source that is not a test, private to the person.
    const sources = readdirSync(join(PLUGIN_ROOT, 'src')).filter((name) => !/\.test\.tsx?$/.test(name))
    expect(modes(folder)).toEqual(Object.fromEntries([
      ['orca-plugin.json', 0o600], ['src', 0o700], ...sources.map((name) => [join('src', name), 0o600]),
    ]))
    expect(statSync(folder).mode & 0o777).toBe(0o700)
    for (const name of sources) expect(readFileSync(join(folder, 'src', name), 'utf8'), name).toBe(readFileSync(join(PLUGIN_ROOT, 'src', name), 'utf8'))
    expect(JSON.parse(readFileSync(join(folder, 'orca-plugin.json'), 'utf8'))).toMatchObject({ id: 'harness-device', version })

    expect(await harness('device', 'orca', 'enable')).toEqual({ code: 0, out: '{"orca":"on"}\n', err: '' })
    expect(orca.calls().slice(-2)).toEqual([`plugin install ${folder} --json`, `plugin install ${folder} --approve ${FP} --json`])
    expect(record(d)).toMatchObject({ orcaConnected: true })
    expect(record(d)).not.toHaveProperty('removed')
    expect(await harness('device', 'orca', 'status', '--json')).toEqual({ code: 0, out: '{"orca":"on"}\n', err: '' })

    expect(await harness('device', 'orca', 'disable')).toEqual({ code: 0, out: '{"orca":"off"}\n', err: '' })
    expect(orca.calls().at(-1)).toBe(`plugin uninstall ${KEY} --json`)
    expect(orca.entry()).toBeUndefined()
    expect(record(d).removed).toEqual({ orca: true })
    expect(await harness('device', 'orca', 'status', '--json')).toEqual({ code: 0, out: '{"orca":"off"}\n', err: '' })

    expect(await harness('device', 'orca', 'enable')).toEqual({ code: 0, out: '{"orca":"on"}\n', err: '' })
    expect(orca.entry()).toMatchObject({ status: 'running', version })
    expect(record(d)).not.toHaveProperty('removed')
  })

  it('more access than the pin: enable holds it and approves nothing', async () => {
    const { orca, harness } = await machine()
    const version = await builtVersion(harness)
    const capabilities = [...PINNED.capabilities, { kind: 'agent:read', description: 'Read your agents' }]
    orca.holds({ key: KEY, version, fingerprint: FP, grants: { ...PINNED, capabilities } })
    expect(await harness('device', 'orca', 'enable')).toEqual({ code: 1, out: '{"orca":"held"}\n', err: '' })
    expect(orca.calls().filter((call) => call.includes('--approve'))).toEqual([])
    expect(orca.entry()).toBeUndefined()
  })

  it('an Orca that is not running is absent, and nothing is written', async () => {
    const { d, orca, harness } = await machine()
    orca.answer('status', { id: 'req-1', ok: true, result: { app: { running: false }, runtime: { reachable: false } } })
    expect(await harness('device', 'orca', 'status', '--json')).toEqual({ code: 0, out: '{"orca":"absent"}\n', err: '' })
    expect(orca.calls()).toEqual(['status --json'])
    expect(existsSync(pluginFolder(d))).toBe(false)
  })

  it('connect is gone: the usage, exit 1, Orca asked nothing', async () => {
    const { orca, harness } = await machine()
    orca.holds({ key: KEY, version: '0.0.1', fingerprint: FP, grants: PINNED })
    for (const words of [['connect', '--json'], ['connect', '--approve', FP, '--json']]) {
      const { code, out, err } = await harness('device', 'orca', ...words)
      expect({ words, code, out }).toEqual({ words, code: 1, out: '' })
      expect(err).toContain('harness device orca enable')
    }
    expect(orca.calls()).toEqual([])
  })
})

describe('the devices process sets the plugin up', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  afterEach(async () => {
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })

  it("a dial's attach installs and approves the plugin with no command; after a disable a replug asks Orca nothing; enable brings it back", async () => {
    // A daemon on the file's bundle, its dials on a desk, as devicesProcess.e2e.ts starts one.
    const d = await IsolatedDaemon.create({ scriptPath: bundle, env: {
      CABLE_DISABLE: 'false',
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200',
      HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
    } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    // The fake written through the daemon's `bin/orca` link into its launcher, which the devices find as Orca's own.
    const orca = fakeOrcaCli(join(d.root, 'orca-cli'), join(dirname(d.env.CLAUDE_PATH!), 'orca'))
    const harness = (...words: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [bundle, ...words], { cwd: d.root, env: d.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
      child.on('close', (code) => resolve({ code, out, err }))
    })
    const version = extensionVersion((await harness('--version')).out.trim())
    orca.holds({ key: KEY, version, fingerprint: FP, grants: PINNED })
    const folder = harnessPath('orca-plugin', d.env.HOME!, process.platform, thisComputer(d.env))
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()

    await theDesk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await until('the plugin set up', () => readSetup(d.dataDir).orca === version || null, 60_000, 200)
    const calls = orca.calls()
    const install = calls.indexOf(`plugin install ${folder} --json`)
    expect(install).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf(`plugin install ${folder} --approve ${FP} --json`)).toBeGreaterThan(install)
    expect(orca.entry()).toMatchObject({ status: 'running', version, source: { kind: 'local-path', reference: realpathSync(folder) } })
    await until('the set up counted', () => d.log().includes('[device] orca plugin · orca · set up') || null, 15_000, 100)
    expect(d.log().split('\n').filter((line) => [FP, folder, KEY, WORKSPACE_READ].some((secret) => line.includes(secret)))).toEqual([])

    expect(await harness('device', 'orca', 'disable')).toEqual({ code: 0, out: '{"orca":"off"}\n', err: '' })
    const before = orca.calls().length
    await theDesk.unplug('E2E-A')
    const dial = await theDesk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    const since = dial.messages.length
    dial.send({ t: 'agents.list' })
    await dial.next((m) => m.t === 'agents.end', 45_000, 'agents.end', since)
    // A removed pass returns in the attach's own moment, before the list is answered.
    expect(orca.calls().slice(before).filter((call) => call === 'status --json' || /^plugin (install|update|enable) /.test(call))).toEqual([])

    expect(await harness('device', 'orca', 'enable')).toEqual({ code: 0, out: '{"orca":"on"}\n', err: '' })
    expect(orca.entry()).toMatchObject({ status: 'running', version })
  })
})
