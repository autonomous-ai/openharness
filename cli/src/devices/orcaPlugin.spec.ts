/**
 * What Harness Device's plugin is in Orca, from a fake `orca` the test writes (testing/fakeOrcaCli.ts) that answers in
 * Orca 1.4.262's shapes, run through the real `run`, in throwaway data folders. The real `orca` is never run: every
 * session here runs inside it.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { fakeOrcaCli, type FakeOrcaCli } from '../testing/fakeOrcaCli.js'
import { DIAL_SKILL_FILE, writeOrcaConnected } from './dialSkillFiles.js'
import { type OrcaPluginDeps, type OrcaPluginFiles, orcaPluginRun, type OrcaPluginState, orcaStatus } from './orcaPlugin.js'

const KEY = 'local.harness-device'
/** The plugin as a build carries it: a manifest at 1.2.3 and one source. */
const FILES: OrcaPluginFiles = {
  'orca-plugin.json': `${JSON.stringify({ manifestVersion: 2, id: 'harness-device', name: 'Harness Device', version: '1.2.3', engines: { orca: '>=1.4.248' }, main: 'src/worker.ts' }, null, 2)}\n`,
  'src/worker.ts': 'export const worker = true\n',
}
const REAL = orcaPluginRun()

// One fake for the file: macOS scans a new executable at its first run, about half a second each, so a fake a case
// would make the table of rules ten times as long. Each case sets every answer it reads, and its calls are those made
// after its setup.
let orcaDir: string
let orca: FakeOrcaCli
beforeAll(() => {
  orcaDir = mkdtempSync(join(tmpdir(), 'orca-cli-'))
  orca = fakeOrcaCli(orcaDir)
})
afterAll(() => rmSync(orcaDir, { recursive: true, force: true }))

const roots: string[] = []
const locked: string[] = []
afterEach(() => {
  for (const path of locked.splice(0)) chmodSync(path, 0o700)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A throwaway data folder, by its real path, and the fake `orca`'s calls from now on. */
function setup(over: Partial<OrcaPluginDeps> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-plugin-')))
  roots.push(root)
  const dataDir = join(root, 'data')
  mkdirSync(dataDir)
  const before = orca.calls().length
  const deps: OrcaPluginDeps = {
    platform: 'darwin',
    orca: () => orca.bin,
    run: REAL.run,
    files: () => FILES,
    dataDir,
    folder: join(dataDir, 'orca-plugin'),
    ...over,
  }
  return { root, deps, folder: deps.folder, calls: () => orca.calls().slice(before) }
}

/** `orca status --json`, as Orca 1.4.262 answers it. */
const status = (appVersion: string | null = '1.4.262', reachable = true) => ({
  id: 'req-1', ok: true,
  result: { app: { running: reachable, pid: 4242 }, runtime: { state: reachable ? 'ready' : 'not_running', reachable, runtimeId: reachable ? 'rt-1' : null, appVersion } },
})
/** `orca plugin inspect <folder> --json`. */
const inspect = (pluginKey: unknown = KEY) => ({
  id: 'req-2', ok: true,
  result: { plugin: { pluginKey, id: 'harness-device', name: 'Harness Device', version: '1.2.3', capabilities: [{ kind: 'workspace:read' }] } },
})
/** One entry of `orca plugin list --json`, installed from [reference] and running at 1.2.3 unless told. */
const entry = (reference: string, over: Record<string, unknown> = {}) => ({
  pluginKey: KEY, consentFingerprint: 'ap1-0123456789abcdef0123456789abcdef', name: 'Harness Device', version: '1.2.3',
  publisher: '', status: 'running', needsReconsent: false, isDev: false, source: { kind: 'local-path', reference },
  official: false, bundled: false, capabilities: [{ kind: 'workspace:read', description: 'Read your projects and workspaces' }],
  ...over,
})
const list = (plugins: unknown[], more: Record<string, unknown> = {}) => ({ id: 'req-3', ok: true, result: { plugins, ...more } })

/** An Orca that is running, at a version the plugin takes, and lists [plugins]. */
function up(plugins: unknown[]): void {
  orca.answer('status', status())
  orca.answer('plugin inspect', inspect())
  orca.answer('plugin list', list(plugins))
}

describe('orcaStatus', () => {
  it('on Windows, and from the sources, nothing is run and no folder is written', async () => {
    for (const over of [{ platform: 'win32' as const }, { files: () => null }]) {
      const { deps, folder, calls } = setup(over)
      up([])
      expect(await orcaStatus(deps)).toEqual({ orca: 'absent' })
      expect(calls()).toEqual([])
      expect(existsSync(folder)).toBe(false)
    }
  })

  it('no orca is absent', async () => {
    const { deps, folder } = setup({ orca: () => null })
    expect(await orcaStatus(deps)).toEqual({ orca: 'absent' })
    expect(existsSync(folder)).toBe(false)
  })

  it('an Orca that is not reachable is asked status alone', async () => {
    const { deps, folder, calls } = setup()
    up([])
    orca.answer('status', status(null, false))
    expect(await orcaStatus(deps)).toEqual({ orca: 'absent' })
    expect(calls()).toEqual(['status --json'])
    expect(existsSync(folder)).toBe(false)
  })

  it("an Orca below the plugin's engines is absent", async () => {
    for (const version of ['1.4.247', '1.4.248-rc.1']) {
      const { deps, folder, calls } = setup()
      up([])
      orca.answer('status', status(version))
      expect(await orcaStatus(deps)).toEqual({ orca: 'absent' })
      expect(calls()).toEqual(['status --json'])
      expect(existsSync(folder)).toBe(false)
    }
    for (const version of ['1.4.248', '1.5.0']) {
      const { deps } = setup()
      up([])
      orca.answer('status', status(version))
      expect(await orcaStatus(deps)).toEqual({ orca: 'offer' })
    }
  })

  it('an answer that cannot be read is absent', async () => {
    const unread: [string, (folder: string) => void][] = [
      ['status exits 1', () => orca.answer('status', status(), 1)],
      ['status is not JSON', () => orca.answer('status', 'Orca is starting\n')],
      ['status is not ok', () => orca.answer('status', { id: 'req-1', ok: false, error: { code: 'runtime_unavailable', message: 'no', data: {} } })],
      ['status names no version', () => orca.answer('status', status(null))],
      ['inspect exits 2', () => orca.answer('plugin inspect', { id: 'req-2', ok: false, error: { code: 'plugin_invalid', message: 'no', data: {} } }, 2)],
      ['inspect names no plugin key', () => orca.answer('plugin inspect', inspect('../x'))],
      ['list is not JSON', () => orca.answer('plugin list', '{"ok": tr')],
      ['an entry with no version', (folder) => orca.answer('plugin list', list([entry(folder, { version: undefined })]))],
      ['an entry with no status', (folder) => orca.answer('plugin list', list([entry(folder, { status: 7 })]))],
    ]
    for (const [name, answer] of unread) {
      const { deps, folder } = setup()
      up([entry(folder)])
      answer(folder)
      expect({ name, ...await orcaStatus(deps) }).toEqual({ name, orca: 'absent' })
    }
  })

  it('a deadline passed is absent, at each of the three', async () => {
    for (const late of [0, 1, 2]) {
      const given: { timeoutMs: number; maxBytes: number }[] = []
      let folder = ''
      const { deps } = setup({
        run: async (_file, _args, opts) => {
          const n = given.push(opts) - 1
          const answers = [status(), inspect(), list([entry(folder)])]
          return n === late ? { code: null, stdout: '', timedOut: true } : { code: 0, stdout: JSON.stringify(answers[n]), timedOut: false }
        },
      })
      folder = deps.folder
      expect(await orcaStatus(deps)).toEqual({ orca: 'absent' })
      expect(given).toEqual([
        { timeoutMs: 5_000, maxBytes: 262_144 },
        { timeoutMs: 10_000, maxBytes: 262_144 },
        { timeoutMs: 10_000, maxBytes: 262_144 },
      ].slice(0, late + 1))
    }
  })

  it('an answer past 256 KiB is absent', async () => {
    const { deps, folder } = setup()
    up([])
    orca.answer('plugin list', list([entry(folder)], { pad: 'x'.repeat(200 * 1024) }))
    expect(await orcaStatus(deps)).toEqual({ orca: 'current' })
    orca.answer('plugin list', list([entry(folder)], { pad: 'x'.repeat(256 * 1024) }))
    expect(await orcaStatus(deps)).toEqual({ orca: 'absent' })
  })

  it('each rule, in order', async () => {
    const elsewhere = '/checkout/plugins/harness-device-orca'
    const rules: [string, (folder: string) => unknown[], OrcaPluginState, { connected?: true }?][] = [
      ['a development folder', (f) => [entry(f, { isDev: true })], 'absent'],
      ['a development folder that is disabled', (f) => [entry(f, { isDev: true, status: 'disabled' })], 'absent'],
      ['no entry', () => [], 'offer'],
      ['no entry, once connected', () => [], 'off', { connected: true }],
      ['disabled', (f) => [entry(f, { status: 'disabled' })], 'off'],
      ['disabled at another version', (f) => [entry(f, { status: 'disabled', version: '1.2.2' })], 'off'],
      ['pending', (f) => [entry(f, { status: 'pending' })], 'approve'],
      ['needing consent again', (f) => [entry(f, { needsReconsent: true })], 'approve'],
      ['pending at another version', (f) => [entry(f, { status: 'pending', version: '1.2.2' })], 'approve'],
      ['another version', (f) => [entry(f, { version: '1.2.2' })], 'behind'],
      ['another folder', () => [entry(elsewhere)], 'behind'],
      ['a source that is no folder', (f) => [entry(f, { source: { kind: 'catalog', reference: f } })], 'behind'],
      ['errored', (f) => [entry(f, { status: 'errored' })], 'absent'],
      ['invalid', (f) => [entry(f, { status: 'invalid' })], 'absent'],
      ['errored at another version', (f) => [entry(f, { status: 'errored', version: '1.2.2' })], 'behind'],
      ['running', (f) => [entry(f, { status: 'running' })], 'current'],
      ['idle', (f) => [entry(f, { status: 'idle' })], 'current'],
      ['an entry of another key', (f) => [entry(f, { pluginKey: 'local.other', status: 'disabled' })], 'offer'],
    ]
    for (const [name, plugins, want, record] of rules) {
      const { deps, folder } = setup()
      up(plugins(folder))
      if (record?.connected) expect(writeOrcaConnected(deps.dataDir)).toBeUndefined()
      expect({ name, ...await orcaStatus(deps) }).toEqual({ name, orca: want })
    }
  })

  it('Orca is asked about the folder itself', async () => {
    const { deps, folder, calls } = setup()
    up([entry(folder)])
    await orcaStatus(deps)
    expect(calls()).toEqual(['status --json', `plugin inspect ${folder} --json`, 'plugin list --json'])
  })

  it('the folder is written before Orca is asked about it, and only when it differs', async () => {
    const { deps, folder } = setup()
    up([entry(folder)])
    mkdirSync(folder)
    writeFileSync(join(folder, 'orca-plugin.json'), '{"version":"1.2.2"}\n')
    let shown: string[] | undefined
    const watched: OrcaPluginDeps = {
      ...deps,
      run: (file, args, opts) => {
        if (args[1] === 'inspect') shown = Object.keys(FILES).map((path) => readFileSync(join(folder, path), 'utf8'))
        return deps.run(file, args, opts)
      },
    }
    expect(await orcaStatus(watched)).toEqual({ orca: 'current' })
    expect(shown).toEqual(Object.values(FILES))
    const inode = statSync(folder).ino
    const files = Object.keys(FILES).map((path) => statSync(join(folder, path)).ino)
    expect(await orcaStatus(deps)).toEqual({ orca: 'current' })
    expect(statSync(folder).ino).toBe(inode)
    expect(Object.keys(FILES).map((path) => statSync(join(folder, path)).ino)).toEqual(files)
  })

  it('the entry names the folder through a link', async () => {
    const { root, deps, folder } = setup()
    const link = join(root, 'link')
    symlinkSync(deps.dataDir, link)
    up([entry(join(link, 'orca-plugin'))])
    expect(await orcaStatus(deps)).toEqual({ orca: 'current' })
    // And the other way: the folder handed through the link, Orca recording its real path.
    up([entry(folder)])
    expect(await orcaStatus({ ...deps, folder: join(link, 'orca-plugin') })).toEqual({ orca: 'current' })
  })

  it.skipIf(process.getuid?.() === 0)('a record that cannot be read', async () => {
    const { deps, folder } = setup()
    up([])
    const record = join(deps.dataDir, DIAL_SKILL_FILE)
    writeFileSync(record, '{}\n')
    chmodSync(record, 0o000)
    locked.push(record)
    expect(await orcaStatus(deps)).toEqual({ orca: 'absent' })
    // The record is read only when Orca lists no plugin.
    up([entry(folder)])
    expect(await orcaStatus(deps)).toEqual({ orca: 'current' })
  })

  it.skipIf(process.getuid?.() === 0)('a folder that cannot be written is absent', async () => {
    const { deps, folder, calls } = setup()
    up([entry(folder)])
    chmodSync(deps.dataDir, 0o500)
    locked.push(deps.dataDir)
    expect(await orcaStatus(deps)).toEqual({ orca: 'absent' })
    expect(calls()).toEqual(['status --json'])
    expect(existsSync(folder)).toBe(false)
  })

  it('from the sources, the real files() is null', () => {
    expect(REAL.files()).toBeNull()
  })
})
