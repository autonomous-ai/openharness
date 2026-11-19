/**
 * What Harness Device's plugin is in Orca, from a fake `orca` the test writes (testing/fakeOrcaCli.ts) that answers in
 * Orca 1.4.262's shapes, run through the real `run`, in throwaway data folders. The real `orca` is never run: every
 * session here runs inside it.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { fakeOrcaCli, type FakeOrcaCli, type FakeOrcaPlugin } from '../testing/fakeOrcaCli.js'
import { DIAL_SETUP_FILE, DIAL_SKILL_FILE, writeOrcaConnected, writeRemoved, writeSetup } from './dialSkillFiles.js'
import {
  carriedVersion, type OrcaPluginDeps, type OrcaPluginFiles, orcaPluginRun, type OrcaPluginState, orcaRemove, orcaSetUp,
  type OrcaSetUp, orcaStatus, withinApproved,
} from './orcaPlugin.js'

// @ts-expect-error — plain ESM with no declaration file
const { readOrcaPluginBundle } = await import('../../scripts/lib/orcaPluginBundle.mjs') as {
  readOrcaPluginBundle: (version: string) => string
}

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

/** A throwaway data folder, by its real path, the fake `orca`'s calls from now on, and the lines said on stderr. The
 *  fake starts with no answers and no plugin. */
function setup(over: Partial<OrcaPluginDeps> = {}) {
  orca.reset()
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-plugin-')))
  roots.push(root)
  const dataDir = join(root, 'data')
  mkdirSync(dataDir)
  const before = orca.calls().length
  const said: string[] = []
  const deps: OrcaPluginDeps = {
    platform: 'darwin',
    orca: () => orca.bin,
    run: REAL.run,
    files: () => FILES,
    dataDir,
    folder: join(dataDir, 'orca-plugin'),
    err: (line) => { said.push(line) },
    ...over,
  }
  return { root, deps, folder: deps.folder, calls: () => orca.calls().slice(before), said }
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
      expect(await orcaStatus(deps)).toEqual({ orca: 'setup' })
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
    expect(await orcaStatus(deps)).toEqual({ orca: 'on' })
    orca.answer('plugin list', list([entry(folder)], { pad: 'x'.repeat(256 * 1024) }))
    expect(await orcaStatus(deps)).toEqual({ orca: 'absent' })
  })

  it("each rule, in order: off for the removal, absent, off for Orca's, on, held, setup", async () => {
    const elsewhere = '/checkout/plugins/harness-device-orca'
    /** What a rule starts from beside Orca's list: `disable`'s removal, an `enable`'s connect, the devices' record. */
    type Records = { removed?: true; connected?: true; orca?: string; held?: string }
    const rules: [string, (folder: string) => unknown[], OrcaPluginState, Records?][] = [
      ['removed, Orca listing it running', (f) => [entry(f)], 'off', { removed: true }],
      ['removed, Orca listing none', () => [], 'off', { removed: true }],
      ['a development folder', (f) => [entry(f, { isDev: true })], 'absent'],
      ['a development folder that is disabled', (f) => [entry(f, { isDev: true, status: 'disabled' })], 'absent'],
      ['a development folder, held at this version', (f) => [entry(f, { isDev: true })], 'absent', { held: '1.2.3' }],
      ['no entry', () => [], 'setup'],
      ['no entry, once connected', () => [], 'off', { connected: true }],
      ['no entry, once set up by the devices', () => [], 'off', { orca: '1.2.2' }],
      ['no entry, held at this version', () => [], 'held', { held: '1.2.3' }],
      ['no entry, held at another version', () => [], 'setup', { held: '1.2.2' }],
      ['disabled', (f) => [entry(f, { status: 'disabled' })], 'off'],
      ['disabled, held at this version', (f) => [entry(f, { status: 'disabled' })], 'off', { held: '1.2.3' }],
      ['disabled at another version', (f) => [entry(f, { status: 'disabled', version: '1.2.2' })], 'off'],
      ['pending', (f) => [entry(f, { status: 'pending' })], 'setup'],
      ['pending, held at this version', (f) => [entry(f, { status: 'pending' })], 'held', { held: '1.2.3' }],
      ['needing consent again', (f) => [entry(f, { needsReconsent: true })], 'setup'],
      ['pending at another version', (f) => [entry(f, { status: 'pending', version: '1.2.2' })], 'setup'],
      ['another version', (f) => [entry(f, { version: '1.2.2' })], 'setup'],
      ['another version, held at this one', (f) => [entry(f, { version: '1.2.2' })], 'held', { held: '1.2.3' }],
      ['another folder', () => [entry(elsewhere)], 'setup'],
      ['a source that is no folder', (f) => [entry(f, { source: { kind: 'catalog', reference: f } })], 'setup'],
      ['errored', (f) => [entry(f, { status: 'errored' })], 'absent'],
      ['invalid', (f) => [entry(f, { status: 'invalid' })], 'absent'],
      ['errored at another version', (f) => [entry(f, { status: 'errored', version: '1.2.2' })], 'setup'],
      ['running', (f) => [entry(f, { status: 'running' })], 'on'],
      ['running, held at this version', (f) => [entry(f, { status: 'running' })], 'on', { held: '1.2.3' }],
      ['idle', (f) => [entry(f, { status: 'idle' })], 'on'],
      ['an entry of another key', (f) => [entry(f, { pluginKey: 'local.other', status: 'disabled' })], 'setup'],
    ]
    for (const [name, plugins, want, record = {}] of rules) {
      const { deps, folder } = setup()
      up(plugins(folder))
      if (record.removed) expect(writeRemoved(deps.dataDir, 'orca', true)).toBeUndefined()
      if (record.connected) expect(writeOrcaConnected(deps.dataDir)).toBeUndefined()
      if (record.orca !== undefined || record.held !== undefined) {
        const homes = { claude: [], codex: [] }
        expect(writeSetup(deps.dataDir, { dial: true, orca: record.orca, orcaHeld: record.held, homes, pluginHomes: [] })).toBeUndefined()
      }
      expect({ name, ...await orcaStatus(deps) }).toEqual({ name, orca: want })
    }
  })

  it('removed by harness device orca disable: off, and Orca is asked nothing, running or not', async () => {
    for (const reachable of [true, false]) {
      const { deps, folder, calls } = setup()
      up([entry(folder)])
      orca.answer('status', status(reachable ? '1.4.262' : null, reachable))
      expect(writeRemoved(deps.dataDir, 'orca', true)).toBeUndefined()
      expect({ reachable, ...await orcaStatus(deps) }).toEqual({ reachable, orca: 'off' })
      expect(calls()).toEqual([])
    }
  })

  it('held with Orca not running is absent', async () => {
    const { deps, calls } = setup()
    up([])
    orca.answer('status', status(null, false))
    expect(writeSetup(deps.dataDir, { dial: true, orcaHeld: '1.2.3', homes: { claude: [], codex: [] }, pluginHomes: [] })).toBeUndefined()
    expect(await orcaStatus(deps)).toEqual({ orca: 'absent' })
    expect(calls()).toEqual(['status --json'])
  })

  it('Orca is asked about the folder itself', async () => {
    const { deps, folder, calls } = setup()
    up([entry(folder)])
    await orcaStatus(deps)
    expect(calls()).toEqual(['status --json', `plugin inspect ${folder} --json`, 'plugin list --json'])
  })

  it('the folder is written before Orca is asked about it, and only when it differs', async () => {
    const { deps, folder, said } = setup()
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
    expect(await orcaStatus(watched)).toEqual({ orca: 'on' })
    expect(shown).toEqual(Object.values(FILES))
    const inode = statSync(folder).ino
    const files = Object.keys(FILES).map((path) => statSync(join(folder, path)).ino)
    expect(await orcaStatus(deps)).toEqual({ orca: 'on' })
    expect(statSync(folder).ino).toBe(inode)
    expect(Object.keys(FILES).map((path) => statSync(join(folder, path)).ino)).toEqual(files)
    expect(said).toEqual([])
  })

  it('the folder handed through a link is on: Orca records the real path it was handed', async () => {
    const { root, deps, folder } = setup()
    const link = join(root, 'link')
    symlinkSync(deps.dataDir, link)
    up([entry(folder)])
    expect(await orcaStatus({ ...deps, folder: join(link, 'orca-plugin') })).toEqual({ orca: 'on' })
  })

  it('an entry that names the folder through a link is not set up: Orca updates from the path it recorded', async () => {
    // A Linux computer whose files moved: Orca recorded ~/.harness/orca-plugin, now the bridge's link to the folder.
    const { root, deps, folder } = setup()
    const old = join(root, 'orca-plugin')
    symlinkSync(folder, old)
    up([entry(old)])
    expect(await orcaStatus(deps)).toEqual({ orca: 'setup' })
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
    expect(await orcaStatus(deps)).toEqual({ orca: 'on' })
  })

  it.skipIf(process.getuid?.() === 0)('a folder that cannot be written is absent, and its code is said, never its path', async () => {
    const { deps, folder, calls, said } = setup()
    up([entry(folder)])
    chmodSync(deps.dataDir, 0o500)
    locked.push(deps.dataDir)
    expect(await orcaStatus(deps)).toEqual({ orca: 'absent' })
    expect(said).toEqual(['orca plugin folder: EACCES'])
    expect(calls()).toEqual(['status --json'])
    expect(existsSync(folder)).toBe(false)
  })

  it('from the sources, the real files() is null', () => {
    expect(REAL.files()).toBeNull()
  })
})

const FINGERPRINT = 'ap1-0123456789abcdef0123456789abcdef'
/** Orca 1.4.262's words for a plugin that runs code, and for `workspace:read`. */
const EXECUTION = 'Runs its own code in a separate Node.js process on the Orca host, with your user account’s access to that machine.'
const WORKSPACE_READ = 'Read your projects and workspaces (names, branches, paths and agent status) and the terminals in them, and get notified when they change'

/** Orca's refusal to install, update or enable without the fingerprint (exit 3), in Orca 1.4.262's whole shape. */
function approval(code: 'approval_required' | 'approval_stale', over: { fingerprint?: string; grants?: Record<string, unknown>; data?: Record<string, unknown> } = {}) {
  const fingerprint = over.fingerprint ?? FINGERPRINT
  return {
    id: 'req-4', ok: false,
    error: {
      code,
      message: `${KEY} 1.2.3 needs approval before it can run.\nApproving Harness Device (${KEY} 1.2.3) grants:\n- ${EXECUTION}\n- ${WORKSPACE_READ}\nFingerprint: ${fingerprint}`,
      data: {
        pluginKey: KEY, name: 'Harness Device', version: '1.2.3', action: 'install', approvalFingerprint: fingerprint,
        contentIdentity: 'c0ffee0123456789', isDev: false,
        grants: {
          execution: 'trusted-worker', executionDescription: EXECUTION,
          capabilities: [{ kind: 'workspace:read', description: WORKSPACE_READ }],
          contributions: [{ kind: 'panels', name: 'Harness Device' }, { kind: 'events', name: 'workspace.changed' }, { kind: 'statusBarItems', name: 'Dial' }],
          ...over.grants,
        },
        why: 'It can run code or act in Orca, so Orca does not enable it without an explicit approval bound to exactly these files and this access.',
        approveFlag: `--approve ${fingerprint}`,
        nextSteps: [
          'Approving grants the access listed above. Confirm with your user first unless they already asked for exactly this plugin and access.',
          `To approve, run the same command again with --approve ${fingerprint}`,
          'A different plugin, version, set of files, or more access gets a new fingerprint and needs a new approval.',
        ],
        ...over.data,
      },
    },
  }
}
/** Orca's answer to an install, update or enable that went through. */
const installed = (folder: string) => ({
  id: 'req-5', ok: true,
  result: { pluginKey: KEY, version: '1.2.3', previousVersion: null, contentHash: 'c0ffee0123456789', approval: 'approve-flag', source: { kind: 'local-path', reference: folder } },
})

/** The name Orca 1.4.262 lists a contribution of each kind by (pluginContributionSummary); it lists no `settings`. */
const NAMED: Record<string, (item: any) => string> = {
  panels: (item) => item.title, commands: (item) => item.title, events: (item) => item.on, hooks: (item) => item.event,
  languagePacks: (item) => item.locale, keybindings: (item) => item.key, vmRecipes: (item) => item.path,
  themes: (item) => item.title, terminalThemes: (item) => item.title, iconThemes: (item) => item.title,
  fonts: (item) => item.family, syntaxes: (item) => item.title, customEditors: (item) => item.title,
  newFiles: (item) => item.title, statusBarItems: (item) => item.text || item.id,
}
/** The grants Orca lists for [manifest], by its rules (pluginApprovalGrants, Orca 1.4.262). A capability keeps every
 *  field the manifest gives it: Orca counts one by its whole object, so a scope added to the manifest is more access. */
const grantsOf = (manifest: any) => {
  const contributes: Record<string, any[]> = manifest.contributes ?? {}
  const replacements = (contributes.commands ?? []).filter((command) => command.replaces)
    .map((command) => ({ command: command.title, action: command.replaces }))
  return {
    execution: manifest.execution,
    capabilities: manifest.capabilities.map((capability: object) => ({ ...capability, description: 'Orca words it' })),
    contributions: Object.entries(NAMED).flatMap(([kind, name]) => (contributes[kind] ?? []).map((item) => ({ kind, name: name(item) }))),
    ...(replacements.length > 0 ? { replacements } : {}),
  }
}

describe('withinApproved', () => {
  const PANEL = { kind: 'panels', name: 'Harness Device' }
  const EVENT = { kind: 'events', name: 'workspace.changed' }
  /** The `data` of Orca's refusal, changed by [over]. */
  const data = (over: Parameters<typeof approval>[1]) => approval('approval_required', over).error.data

  it('the grants Orca would list for the shipped orca-plugin.json are within it: a manifest that adds access fails here', () => {
    const manifest = JSON.parse(JSON.parse(readOrcaPluginBundle('1.2.3'))['orca-plugin.json'])
    expect(withinApproved({ pluginKey: KEY, version: '1.2.3', approvalFingerprint: FINGERPRINT, grants: grantsOf(manifest) }, KEY, '1.2.3')).toBe(true)
  })

  it("Orca 1.4.262's whole refusal is within it", () => {
    expect(withinApproved(approval('approval_required').error.data, KEY, '1.2.3')).toBe(true)
  })

  it.each<[string, Parameters<typeof approval>[1]]>([
    ['execution trusted-host', { grants: { execution: 'trusted-host' } }],
    ['a second capability', { grants: { capabilities: [{ kind: 'workspace:read', description: WORKSPACE_READ }, { kind: 'agent:read', description: 'x' }] } }],
    ['a scoped capability', { grants: { capabilities: [{ kind: 'workspace:read', description: 'x', scope: { workspaces: '*' } }] } }],
    ['a command', { grants: { contributions: [PANEL, EVENT, { kind: 'statusBarItems', name: 'Dial' }, { kind: 'commands', name: 'Harness' }] } }],
    ['the panel retitled', { grants: { contributions: [{ kind: 'panels', name: 'Dial' }, EVENT, { kind: 'statusBarItems', name: 'Dial' }] } }],
    ['a replacement', { grants: { replacements: [{ command: 'x', action: 'open' }] } }],
    ['a grant of another kind', { grants: { network: ['*'] } }],
    ['a contribution with another field', { grants: { contributions: [PANEL, EVENT, { kind: 'statusBarItems', name: 'Dial', scope: '*' }] } }],
  ])('more access is not: %s', (_, over) => {
    expect(withinApproved(data(over), KEY, '1.2.3')).toBe(false)
  })

  it('no replacements: absent or empty', () => {
    expect(withinApproved(data({ grants: { replacements: [] } }), KEY, '1.2.3')).toBe(true)
  })

  it("a contribution's detail is within it", () => {
    const contributions = [PANEL, EVENT, { kind: 'statusBarItems', name: 'Dial', detail: 'right' }]
    expect(withinApproved(data({ grants: { contributions } }), KEY, '1.2.3')).toBe(true)
  })

  it.each<[string, unknown]>([
    ['data null', null],
    ['grants a string', data({ data: { grants: 'trusted-worker' } })],
    ['capabilities an object', data({ grants: { capabilities: { kind: 'workspace:read', description: WORKSPACE_READ } } })],
    ['a capability a string', data({ grants: { capabilities: ['workspace:read'] } })],
    ['contributions an object', data({ grants: { contributions: {} } })],
    ['a contribution with no name', data({ grants: { contributions: [PANEL, EVENT, { kind: 'statusBarItems' }] } })],
    ['a contribution named by a list', data({ grants: { contributions: [PANEL, EVENT, { kind: 'statusBarItems', name: ['Dial'] }] } })],
    ['execution a number', data({ grants: { execution: 1 } })],
    ['replacements an object', data({ grants: { replacements: {} } })],
  ])('a field of another shape is not: %s', (_, value) => {
    expect(withinApproved(value, KEY, '1.2.3')).toBe(false)
  })

  it('another key or version is not', () => {
    expect(withinApproved(data({ data: { pluginKey: 'local.other' } }), KEY, '1.2.3')).toBe(false)
    expect(withinApproved(data({ data: { version: '1.2.4' } }), KEY, '1.2.3')).toBe(false)
  })
})

/** [deps] whose run [at] (an install, update or enable unless told) passes its deadline while Orca goes on and then
 *  lists [after]; the deadlines of what runs after it. */
function late(deps: OrcaPluginDeps, after: unknown[] | string, at = (args: string[]) => ['install', 'update', 'enable'].includes(args[1]!)) {
  let past = false
  const given: number[] = []
  const run: OrcaPluginDeps['run'] = async (file, args, opts) => {
    if (past) given.push(opts.timeoutMs)
    if (!at(args)) return deps.run(file, args, opts)
    past = true
    orca.answer('plugin list', typeof after === 'string' ? after : list(after))
    return { code: null, stdout: '', timedOut: true }
  }
  return { deps: { ...deps, run }, given }
}

/** The access Orca 1.4.262 lists for the plugin as it ships: what Harness approves. */
const PINNED = approval('approval_required').error.data.grants
/** An Orca that runs and holds the plugin's approvals at 1.2.3 for the pinned access, changed by [over]. An entry
 *  `plugin list` was answered with before is the one it holds. */
const holds = (over: Partial<FakeOrcaPlugin> = {}) => orca.holds({ key: KEY, version: '1.2.3', fingerprint: FINGERPRINT, grants: PINNED, ...over })
/** A person's own checkout of the plugin, where Orca may hold an install Harness did not make. */
const CHECKOUT = '/checkout/plugins/harness-device-orca'
const SET_UP: OrcaSetUp = { orca: 'on', did: 'set up' }
const UPDATED: OrcaSetUp = { orca: 'on', did: 'updated' }
const SETUP_FAILED: OrcaSetUp = { orca: 'failed', error: 'failed' }
/** The three reads every change starts with. */
const reads = (folder: string) => ['status --json', `plugin inspect ${folder} --json`, 'plugin list --json']
const approving = (call: string) => call.includes('--approve')

describe('orcaSetUp', () => {
  it("not installed: installed from the folder, refused, then approved with Orca's fingerprint", async () => {
    const { deps, folder, calls } = setup()
    holds()
    expect(await orcaSetUp(deps, { force: false })).toStrictEqual(SET_UP)
    expect(calls()).toEqual([...reads(folder), `plugin install ${folder} --json`, `plugin install ${folder} --approve ${FINGERPRINT} --json`])
    expect(orca.entry()).toMatchObject({ status: 'running', version: '1.2.3', source: { kind: 'local-path', reference: folder } })
  })

  it('installed from the folder at another version: updated, refused, approved', async () => {
    const { deps, folder, calls } = setup()
    orca.answer('plugin list', list([entry(folder, { version: '1.2.2' })]))
    holds()
    expect(await orcaSetUp(deps, { force: false })).toStrictEqual(UPDATED)
    expect(calls().slice(3)).toEqual([`plugin update ${KEY} --json`, `plugin update ${KEY} --approve ${FINGERPRINT} --json`])
    expect(orca.entry()).toMatchObject({ status: 'running', version: '1.2.3', source: { kind: 'local-path', reference: folder } })
  })

  it('an update that asks for nothing new goes through with no --approve', async () => {
    const { deps, folder, calls } = setup()
    orca.answer('plugin list', list([entry(folder, { version: '1.2.2' })]))
    holds()
    orca.answer('plugin update', installed(folder))
    expect(await orcaSetUp(deps, { force: false })).toStrictEqual(UPDATED)
    expect(calls().slice(3)).toEqual([`plugin update ${KEY} --json`])
  })

  it('from the folder at another version and not on, whatever its status: updated, then listed, never the old copy enabled', async () => {
    const older: [string, Record<string, unknown>, boolean][] = [
      ['disabled, with force', { status: 'disabled' }, true],
      ['pending', { status: 'pending' }, false],
      ['needing consent again', { needsReconsent: true }, false],
    ]
    for (const [name, over, force] of older) {
      const { deps, folder, calls } = setup()
      orca.answer('plugin list', list([entry(folder, { version: '1.2.2', ...over })]))
      holds()
      expect({ name, ...await orcaSetUp(deps, { force }) }).toStrictEqual({ name, ...UPDATED })
      expect(calls().slice(3)).toEqual([`plugin update ${KEY} --json`, `plugin update ${KEY} --approve ${FINGERPRINT} --json`, 'plugin list --json'])
      expect(orca.entry()).toMatchObject({ status: 'running', version: '1.2.3', source: { kind: 'local-path', reference: folder } })
    }
  })

  it('with force, an update Orca leaves disabled: enabled after it, then approved', async () => {
    const { deps, folder, calls } = setup()
    orca.answer('plugin list', list([entry(folder, { version: '1.2.2', status: 'disabled' })]))
    holds()
    // An Orca that brings the folder's files in and leaves the person's switch off.
    const run: OrcaPluginDeps['run'] = async (file, args, opts) => {
      const ran = await deps.run(file, args, opts)
      if (args[1] === 'update' && ran.code === 0) orca.disable()
      return ran
    }
    expect(await orcaSetUp({ ...deps, run }, { force: true })).toStrictEqual(UPDATED)
    expect(calls().slice(3)).toEqual([
      `plugin update ${KEY} --json`, `plugin update ${KEY} --approve ${FINGERPRINT} --json`, 'plugin list --json',
      `plugin enable ${KEY} --json`, `plugin enable ${KEY} --approve ${FINGERPRINT} --json`,
    ])
    expect(orca.entry()).toMatchObject({ status: 'running', version: '1.2.3', source: { kind: 'local-path', reference: folder } })
  })

  it('pending from the folder: enabled, then approved', async () => {
    const { deps, folder, calls } = setup()
    orca.answer('plugin list', list([entry(folder, { status: 'pending' })]))
    holds()
    expect(await orcaSetUp(deps, { force: false })).toStrictEqual(UPDATED)
    expect(calls().slice(3)).toEqual([`plugin enable ${KEY} --json`, `plugin enable ${KEY} --approve ${FINGERPRINT} --json`])
    expect(orca.entry()).toMatchObject({ status: 'running', source: { kind: 'local-path', reference: folder } })
  })

  it("pending from another folder (a person's checkout): installed from the folder, never enabled", async () => {
    for (const pending of [{ status: 'pending' }, { needsReconsent: true }]) {
      const { deps, folder, calls } = setup()
      orca.answer('plugin list', list([entry(CHECKOUT, pending)]))
      holds()
      expect(await orcaSetUp(deps, { force: false })).toStrictEqual(UPDATED)
      expect(calls().slice(3)).toEqual([`plugin install ${folder} --json`, `plugin install ${folder} --approve ${FINGERPRINT} --json`])
      expect(calls().filter((call) => call.startsWith('plugin enable'))).toEqual([])
      expect(orca.entry()).toMatchObject({ status: 'running', source: { kind: 'local-path', reference: folder } })
    }
  })

  it("running from a person's checkout, at this version or another, or recorded through a link to the folder: installed from the folder, never updated", async () => {
    const sources: [string, (root: string, folder: string) => Record<string, unknown>][] = [
      ['a checkout at this version', () => entry(CHECKOUT)],
      ['a checkout at another version', () => entry(CHECKOUT, { version: '1.2.2' })],
      // A Linux computer whose files moved: Orca recorded ~/.harness/orca-plugin, now the bridge's link to the folder,
      // and updates from the path it recorded.
      ['a link to the folder', (root, folder) => {
        const old = join(root, 'orca-plugin')
        symlinkSync(folder, old)
        return entry(old, { version: '1.2.2' })
      }],
    ]
    for (const [name, listed] of sources) {
      const { root, deps, folder, calls } = setup()
      orca.answer('plugin list', list([listed(root, folder)]))
      holds()
      expect({ name, ...await orcaSetUp(deps, { force: false }) }).toStrictEqual({ name, ...UPDATED })
      expect(calls().slice(3)).toEqual([`plugin install ${folder} --json`, `plugin install ${folder} --approve ${FINGERPRINT} --json`])
      expect(orca.entry()).toMatchObject({ status: 'running', version: '1.2.3', source: { kind: 'local-path', reference: folder } })
    }
  })

  it('more access: held, and nothing approved', async () => {
    const more = { ...PINNED, capabilities: [...PINNED.capabilities, { kind: 'agent:read', description: 'Read your agents' }] }
    const present = setup()
    orca.answer('plugin list', list([entry(present.folder, { version: '1.2.2' })]))
    holds({ grants: more })
    expect(await orcaSetUp(present.deps, { force: false })).toStrictEqual({ orca: 'held' })
    expect(present.calls().filter(approving)).toEqual([])
    // Orca leaves the running version in place when an update is refused.
    expect(orca.entry()).toMatchObject({ status: 'running', version: '1.2.2' })
    const missing = setup()
    holds({ grants: more })
    expect(await orcaSetUp(missing.deps, { force: true })).toStrictEqual({ orca: 'held' })
    expect(missing.calls().filter(approving)).toEqual([])
    expect(orca.entry()).toBeUndefined()
  })

  it('a refusal for another key or version: held', async () => {
    for (const data of [{ pluginKey: 'local.other' }, { version: '1.2.4' }]) {
      const { deps, calls } = setup()
      holds()
      orca.answer('plugin install', approval('approval_required', { data }), 3)
      expect({ data, ...await orcaSetUp(deps, { force: false }) }).toStrictEqual({ data, orca: 'held' })
      expect(calls().filter(approving)).toEqual([])
    }
  })

  it('a second refusal is failed, never a third run', async () => {
    const { deps, folder, calls } = setup()
    holds()
    orca.answer('plugin install', approval('approval_stale'), 3)
    expect(await orcaSetUp(deps, { force: false })).toStrictEqual(SETUP_FAILED)
    expect(calls().slice(3)).toEqual([`plugin install ${folder} --json`, `plugin install ${folder} --approve ${FINGERPRINT} --json`])
  })

  it('a fingerprint off its pattern: failed, nothing approved', async () => {
    const { deps, calls } = setup()
    for (const fingerprint of ['AP1-0123456789abcdef0123456789abcdef', 'ap1-0123456789abcdef0123456789abcde', `${FINGERPRINT} `, `${FINGERPRINT} --force`]) {
      holds({ fingerprint })
      expect({ fingerprint, ...await orcaSetUp(deps, { force: false }) }).toStrictEqual({ fingerprint, ...SETUP_FAILED })
    }
    expect(calls().filter(approving)).toEqual([])
  })

  it("Orca's other errors are failed, and its message is never read", async () => {
    const { deps, said } = setup()
    holds()
    const marker = '/SECRET-PATH-MARKER'
    const errors: [string, unknown, number][] = [
      ['install failed', { id: 'req-4', ok: false, error: { code: 'plugin_install_failed', message: `Could not copy ${marker}: EACCES`, data: { pluginKey: KEY } } }, 1],
      ['not JSON', `Error: could not reach ${marker}\n`, 1],
      ['no code', { id: 'req-4', ok: false, error: { message: `Something failed in ${marker}` } }, 1],
      ["another code with an approval's data", { ...approval('approval_required'), error: { ...approval('approval_required').error, code: 'plugin_blocked', message: marker } }, 1],
      ['ok with an exit that is not 0', installed(marker), 1],
    ]
    for (const [label, answer, code] of errors) {
      orca.answer('plugin install', answer, code)
      const result = await orcaSetUp(deps, { force: false })
      expect({ case: label, ...result }).toStrictEqual({ case: label, ...SETUP_FAILED })
      expect(JSON.stringify(result)).not.toContain('SECRET-PATH-MARKER')
    }
    expect(said).toEqual([])
  })

  it('past the deadline: on when Orca lists it as asked, else timeout', async () => {
    const asked: [string, (folder: string) => unknown[], OrcaSetUp, ((args: string[]) => boolean)?][] = [
      ['an install', () => [], SET_UP],
      ['an install with the fingerprint', () => [], SET_UP, (args) => args.includes('--approve')],
      ['an update', (f) => [entry(f, { version: '1.2.2' })], UPDATED],
      ['an enable', (f) => [entry(f, { status: 'pending' })], UPDATED],
    ]
    for (const [name, before, want, at] of asked) {
      const { deps, folder } = setup()
      orca.answer('plugin list', list(before(folder)))
      holds()
      const { deps: slow, given } = late(deps, [entry(folder, { status: 'idle' })], at)
      expect({ name, ...await orcaSetUp(slow, { force: false }) }).toStrictEqual({ name, ...want })
      expect(given).toEqual([10_000])
    }
    const others: [string, (folder: string) => unknown[] | string][] = [
      ['no entry', () => []],
      ['pending', (f) => [entry(f, { status: 'pending' })]],
      ['the version before', (f) => [entry(f, { version: '1.2.2' })]],
      ['another folder', () => [entry(CHECKOUT)]],
      ['disabled', (f) => [entry(f, { status: 'disabled' })]],
      ['errored', (f) => [entry(f, { status: 'errored' })]],
      ['invalid', (f) => [entry(f, { status: 'invalid' })]],
      ['a development install', (f) => [entry(f, { isDev: true })]],
      ['a list that cannot be read', () => '{"ok": tr'],
    ]
    for (const [name, after] of others) {
      const { deps, folder } = setup()
      holds()
      const { deps: slow } = late(deps, after(folder))
      expect({ name, ...await orcaSetUp(slow, { force: false }) }).toStrictEqual({ name, orca: 'failed', error: 'timeout' })
    }
  })

  it('a change has 60 s, and the list after it its own 10 s', async () => {
    const given: { timeoutMs: number; maxBytes: number }[] = []
    const { deps } = setup({
      run: async (_file, _args, opts) => {
        const answers = [status(), inspect(), list([])]
        const n = given.push(opts) - 1
        return n < answers.length ? { code: 0, stdout: JSON.stringify(answers[n]), timedOut: false } : { code: null, stdout: '', timedOut: true }
      },
    })
    expect(await orcaSetUp(deps, { force: false })).toStrictEqual({ orca: 'failed', error: 'timeout' })
    expect(given.slice(3)).toEqual([{ timeoutMs: 60_000, maxBytes: 262_144 }, { timeoutMs: 10_000, maxBytes: 262_144 }])
  })

  it('removed: off with nothing run after the list', async () => {
    const homes = { claude: [], codex: [] }
    const removals: [string, (dataDir: string, folder: string) => unknown[]][] = [
      ['no entry, set up by the devices', (dataDir) => {
        expect(writeSetup(dataDir, { dial: true, orca: '1.2.2', homes, pluginHomes: [] })).toBeUndefined()
        return []
      }],
      ['no entry, set up by an enable', (dataDir) => {
        expect(writeOrcaConnected(dataDir)).toBeUndefined()
        return []
      }],
      ['disabled in Orca', (_, folder) => [entry(folder, { status: 'disabled' })]],
    ]
    for (const [name, removal] of removals) {
      const { deps, folder, calls } = setup()
      orca.answer('plugin list', list(removal(deps.dataDir, folder)))
      holds()
      expect({ name, ...await orcaSetUp(deps, { force: false }) }).toStrictEqual({ name, orca: 'off' })
      expect(calls()).toEqual(reads(folder))
    }
  })

  it('orcaHeld alone is not set up before: installed', async () => {
    const { deps } = setup()
    expect(writeSetup(deps.dataDir, { dial: true, orcaHeld: '1.2.3', homes: { claude: [], codex: [] }, pluginHomes: [] })).toBeUndefined()
    holds()
    expect(await orcaSetUp(deps, { force: false })).toStrictEqual(SET_UP)
  })

  it('with force: a disabled entry from the folder is enabled, one from another folder installed, a missing one installed', async () => {
    const ours = setup()
    holds()
    expect(await orcaSetUp(ours.deps, { force: false })).toStrictEqual(SET_UP)
    orca.disable()
    expect(await orcaSetUp(ours.deps, { force: false })).toStrictEqual({ orca: 'off' })
    const before = ours.calls().length
    expect(await orcaSetUp(ours.deps, { force: true })).toStrictEqual(UPDATED)
    expect(ours.calls().slice(before + 3)).toEqual([`plugin enable ${KEY} --json`, `plugin enable ${KEY} --approve ${FINGERPRINT} --json`])
    expect(orca.entry()).toMatchObject({ status: 'running', source: { kind: 'local-path', reference: ours.folder } })

    const elsewhere = setup()
    orca.answer('plugin list', list([entry(CHECKOUT, { status: 'disabled' })]))
    holds()
    expect(await orcaSetUp(elsewhere.deps, { force: true })).toStrictEqual(UPDATED)
    expect(elsewhere.calls().slice(3)).toEqual([`plugin install ${elsewhere.folder} --json`, `plugin install ${elsewhere.folder} --approve ${FINGERPRINT} --json`])
    expect(orca.entry()).toMatchObject({ status: 'running', source: { kind: 'local-path', reference: elsewhere.folder } })

    const missing = setup()
    expect(writeOrcaConnected(missing.deps.dataDir)).toBeUndefined()
    expect(writeSetup(missing.deps.dataDir, { dial: true, orca: '1.2.3', homes: { claude: [], codex: [] }, pluginHomes: [] })).toBeUndefined()
    holds()
    expect(await orcaSetUp(missing.deps, { force: true })).toStrictEqual(SET_UP)
    expect(missing.calls().slice(3)).toEqual([`plugin install ${missing.folder} --json`, `plugin install ${missing.folder} --approve ${FINGERPRINT} --json`])
  })

  it('no Orca to ask', async () => {
    for (const over of [{ platform: 'win32' as const }, { files: () => null }, { orca: () => null }]) {
      const { deps, folder, calls } = setup(over)
      holds()
      expect(await orcaSetUp(deps, { force: true })).toStrictEqual({ orca: 'absent', error: 'not-running' })
      expect(calls()).toEqual([])
      expect(existsSync(folder)).toBe(false)
    }
    const unreachable = setup()
    holds()
    orca.answer('status', status(null, false))
    expect(await orcaSetUp(unreachable.deps, { force: true })).toStrictEqual({ orca: 'absent', error: 'not-running' })
    expect(unreachable.calls()).toEqual(['status --json'])
    const old = setup()
    holds()
    orca.answer('status', status('1.4.247'))
    expect(await orcaSetUp(old.deps, { force: true })).toStrictEqual({ orca: 'absent', error: 'old' })
    expect(old.calls()).toEqual(['status --json'])
    // Q1: a development install, or one Orca could not load, is the person's to mend; Harness leaves it as it is.
    for (const over of [{ isDev: true }, { status: 'errored' }, { status: 'invalid' }]) {
      const { deps, folder, calls } = setup()
      orca.answer('plugin list', list([entry(folder, over)]))
      holds()
      expect({ over, ...await orcaSetUp(deps, { force: true }) }).toStrictEqual({ over, orca: 'absent', error: 'other' })
      expect(calls()).toEqual(reads(folder))
    }
  })

  it.skipIf(process.getuid?.() === 0)('a folder that cannot be written: failed · folder, its code said through err alone', async () => {
    const { deps, folder, calls, said } = setup()
    holds()
    chmodSync(deps.dataDir, 0o500)
    locked.push(deps.dataDir)
    expect(await orcaSetUp(deps, { force: true })).toStrictEqual({ orca: 'failed', error: 'folder' })
    expect(said).toEqual(['orca plugin folder: EACCES'])
    expect(calls()).toEqual(['status --json'])
    expect(existsSync(folder)).toBe(false)
  })

  it('Orca reachable, and an answer after its status that cannot be read: failed, nothing changed', async () => {
    const unread: [string, (folder: string) => void][] = [
      ['inspect exits 2', () => orca.answer('plugin inspect', { id: 'req-2', ok: false, error: { code: 'plugin_invalid', message: 'no', data: {} } }, 2)],
      ['inspect names no plugin key', () => orca.answer('plugin inspect', inspect('../x'))],
      ['list is not JSON', () => orca.answer('plugin list', '{"ok": tr')],
      ['an entry with no version', (folder) => orca.answer('plugin list', list([entry(folder, { version: undefined })]))],
      ['an entry with no status', (folder) => orca.answer('plugin list', list([entry(folder, { status: 7 })]))],
    ]
    for (const [name, answer] of unread) {
      const { deps, folder, calls } = setup()
      up([entry(folder, { version: '1.2.2' })])
      answer(folder)
      expect({ name, ...await orcaSetUp(deps, { force: true }) }).toStrictEqual({ name, ...SETUP_FAILED })
      expect(calls().filter((call) => /^plugin (install|update|enable) /.test(call))).toEqual([])
    }
  })

  it.skipIf(process.getuid?.() === 0)('a record that cannot be read, without force: failed, nothing installed', async () => {
    for (const file of [DIAL_SKILL_FILE, DIAL_SETUP_FILE]) {
      const { deps, folder, calls } = setup()
      holds()
      const record = join(deps.dataDir, file)
      writeFileSync(record, '{}\n')
      chmodSync(record, 0o000)
      locked.push(record)
      expect({ file, ...await orcaSetUp(deps, { force: false }) }).toStrictEqual({ file, ...SETUP_FAILED })
      expect(calls()).toEqual(reads(folder))
      // An enable reads neither record.
      expect({ file, ...await orcaSetUp(deps, { force: true }) }).toStrictEqual({ file, ...SET_UP })
    }
  })

  it('current: on, nothing run after the list', async () => {
    for (const force of [false, true]) {
      const { deps, folder, calls } = setup()
      orca.answer('plugin list', list([entry(folder)]))
      holds()
      expect(await orcaSetUp(deps, { force })).toStrictEqual({ orca: 'on' })
      expect(calls()).toEqual(reads(folder))
    }
  })
})

describe('orcaRemove', () => {
  it("uninstalls the entry with the plugin's key", async () => {
    for (const listed of [(f: string) => entry(f), (f: string) => entry(f, { status: 'disabled' }), () => entry(CHECKOUT)]) {
      const { deps, folder, calls } = setup()
      orca.answer('plugin list', list([listed(folder)]))
      holds()
      expect(await orcaRemove(deps)).toStrictEqual({ orca: 'off' })
      expect(calls()).toEqual([...reads(folder), `plugin uninstall ${KEY} --json`])
      expect(orca.entry()).toBeUndefined()
    }
  })

  it('no entry: off, no uninstall', async () => {
    const { deps, folder, calls } = setup()
    orca.answer('plugin list', list([entry(folder, { pluginKey: 'local.other' })]))
    holds()
    expect(await orcaRemove(deps)).toStrictEqual({ orca: 'off' })
    expect(calls()).toEqual(reads(folder))
  })

  it('not reachable: off · not-running', async () => {
    const unreachable = setup()
    holds()
    orca.answer('status', status(null, false))
    expect(await orcaRemove(unreachable.deps)).toStrictEqual({ orca: 'off', error: 'not-running' })
    expect(unreachable.calls()).toEqual(['status --json'])
    const unread = setup()
    holds()
    orca.answer('plugin list', '{"ok": tr')
    expect(await orcaRemove(unread.deps)).toStrictEqual({ orca: 'off', error: 'not-running' })
    expect(unread.calls()).toEqual(reads(unread.folder))
  })

  it('no Orca to ask: off, nothing but status', async () => {
    for (const over of [{ platform: 'win32' as const }, { files: () => null }, { orca: () => null }]) {
      const { deps, calls } = setup(over)
      holds()
      expect(await orcaRemove(deps)).toStrictEqual({ orca: 'off' })
      expect(calls()).toEqual([])
    }
    const { deps, calls } = setup()
    holds()
    orca.answer('status', status('1.4.247'))
    expect(await orcaRemove(deps)).toStrictEqual({ orca: 'off' })
    expect(calls()).toEqual(['status --json'])
  })

  it('past its deadline: off · timeout', async () => {
    const given: { timeoutMs: number; maxBytes: number }[] = []
    let folder = ''
    const { deps } = setup({
      run: async (_file, _args, opts) => {
        const answers = [status(), inspect(), list([entry(folder)])]
        const n = given.push(opts) - 1
        return n < answers.length ? { code: 0, stdout: JSON.stringify(answers[n]), timedOut: false } : { code: null, stdout: '', timedOut: true }
      },
    })
    folder = deps.folder
    expect(await orcaRemove(deps)).toStrictEqual({ orca: 'off', error: 'timeout' })
    expect(given.slice(3)).toEqual([{ timeoutMs: 60_000, maxBytes: 262_144 }])
  })

  it("Orca's error: off · failed", async () => {
    const marker = '/SECRET-PATH-MARKER'
    for (const [answer, code] of [
      [{ id: 'req-6', ok: false, error: { code: 'plugin_uninstall_failed', message: `Could not remove ${marker}` } }, 1],
      [`Error: ${marker}\n`, 1],
      [{ id: 'req-6', ok: true, result: { pluginKey: KEY } }, 1],
    ] as [unknown, number][]) {
      const { deps, folder } = setup()
      orca.answer('plugin list', list([entry(folder)]))
      holds()
      orca.answer('plugin uninstall', answer, code)
      const result = await orcaRemove(deps)
      expect(result).toStrictEqual({ orca: 'off', error: 'failed' })
      expect(JSON.stringify(result)).not.toContain('SECRET-PATH-MARKER')
    }
  })

  it.skipIf(process.getuid?.() === 0)('a folder that cannot be written: off · failed, its code said', async () => {
    const { deps, calls, said } = setup()
    holds()
    chmodSync(deps.dataDir, 0o500)
    locked.push(deps.dataDir)
    expect(await orcaRemove(deps)).toStrictEqual({ orca: 'off', error: 'failed' })
    expect(said).toEqual(['orca plugin folder: EACCES'])
    expect(calls()).toEqual(['status --json'])
  })
})

it("carriedVersion: the manifest's version, null from the sources", () => {
  expect(carriedVersion({ files: () => FILES })).toBe('1.2.3')
  expect(carriedVersion(REAL)).toBeNull()
})
