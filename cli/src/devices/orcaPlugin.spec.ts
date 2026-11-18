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
import { orcaConnect, type OrcaPluginDeps, type OrcaPluginFiles, orcaPluginRun, type OrcaPluginState, orcaStatus } from './orcaPlugin.js'

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
const FAILED = { connect: 'failed', error: 'failed' }

describe('connect', () => {
  it('with no fingerprint it asks Orca and passes --approve to nobody', async () => {
    const { deps, folder, calls } = setup()
    up([])
    orca.answer('plugin install', approval('approval_required'), 3)
    expect(await orcaConnect(deps)).toStrictEqual({
      connect: 'approve', name: 'Harness Device', version: '1.2.3', fingerprint: FINGERPRINT, grants: [EXECUTION, WORKSPACE_READ], update: false,
    })
    expect(calls()).toEqual(['status --json', `plugin inspect ${folder} --json`, 'plugin list --json', `plugin install ${folder} --json`])
  })

  it('with the fingerprint Orca installs', async () => {
    const { deps, folder, calls } = setup()
    up([])
    orca.answer('plugin install', installed(folder))
    expect(await orcaConnect(deps, FINGERPRINT)).toStrictEqual({ connect: 'done' })
    expect(calls().slice(3)).toEqual([`plugin install ${folder} --approve ${FINGERPRINT} --json`])
  })

  it('a fingerprint that no longer matches shows the fresh grants', async () => {
    const { deps } = setup()
    up([])
    const fresh = 'ap1-fedcba9876543210fedcba9876543210'
    const capabilities = [{ kind: 'workspace:read', description: WORKSPACE_READ }, { kind: 'agent:read', description: 'Read your agents' }]
    orca.answer('plugin install', approval('approval_stale', { fingerprint: fresh, grants: { capabilities } }), 3)
    expect(await orcaConnect(deps, FINGERPRINT)).toStrictEqual({
      connect: 'approve', name: 'Harness Device', version: '1.2.3', fingerprint: fresh, grants: [EXECUTION, WORKSPACE_READ, 'Read your agents'], update: false,
    })
  })

  it('a replacement is worded as Orca words it, after the capabilities', async () => {
    const { deps } = setup()
    up([])
    orca.answer('plugin install', approval('approval_required', { grants: { replacements: [{ command: 'Open file', action: 'file opener' }] } }), 3)
    expect(await orcaConnect(deps)).toMatchObject({
      connect: 'approve', grants: [EXECUTION, WORKSPACE_READ, 'Runs "Open file" instead of Orca\'s own file opener'],
    })
  })

  it("Orca's errors are failed, and never its message", async () => {
    const { deps, folder } = setup()
    up([])
    const errors: [string, unknown, number][] = [
      ['install failed', { id: 'req-4', ok: false, error: { code: 'plugin_install_failed', message: `Could not copy ${folder}: EACCES`, data: { pluginKey: KEY } } }, 1],
      ['invalid', { id: 'req-4', ok: false, error: { code: 'plugin_invalid', message: `${folder}/orca-plugin.json: bad`, data: { pluginKey: KEY } } }, 2],
      ['not JSON', `Error: could not reach ${folder}\n`, 1],
      ['no code', { id: 'req-4', ok: false, error: { message: `Something failed in ${folder}` } }, 1],
      ["another code with an approval's data", { ...approval('approval_required'), error: { ...approval('approval_required').error, code: 'plugin_blocked' } }, 1],
      ['ok with an exit that is not 0', installed(folder), 1],
    ]
    for (const [label, answer, code] of errors) {
      orca.answer('plugin install', answer, code)
      expect({ case: label, ...await orcaConnect(deps) }).toStrictEqual({ case: label, ...FAILED })
    }
  })

  it('past its deadline it is timeout', async () => {
    const given: { timeoutMs: number; maxBytes: number }[] = []
    const { deps } = setup({
      run: async (_file, _args, opts) => {
        const answers = [status(), inspect(), list([])]
        const n = given.push(opts) - 1
        return n < answers.length ? { code: 0, stdout: JSON.stringify(answers[n]), timedOut: false } : { code: null, stdout: '', timedOut: true }
      },
    })
    expect(await orcaConnect(deps)).toStrictEqual({ connect: 'failed', error: 'timeout' })
    expect(given.slice(3)).toEqual([{ timeoutMs: 60_000, maxBytes: 262_144 }])
  })

  it('a fingerprint off the pattern, from Orca or from the caller, is failed', async () => {
    const { deps, calls } = setup()
    up([])
    const bad = ['AP1-0123456789abcdef0123456789abcdef', 'ap1-0123456789abcdef0123456789abcde', `${FINGERPRINT} `]
    for (const fingerprint of bad) {
      orca.answer('plugin install', approval('approval_required', { fingerprint }), 3)
      expect({ fingerprint, ...await orcaConnect(deps) }).toStrictEqual({ fingerprint, ...FAILED })
    }
    const before = calls().length
    for (const fingerprint of bad) {
      expect({ fingerprint, ...await orcaConnect(deps, fingerprint) }).toStrictEqual({ fingerprint, ...FAILED })
    }
    expect(calls().slice(before)).toEqual([])
  })

  it('off installs nothing', async () => {
    const disabled = setup()
    up([entry(disabled.folder, { status: 'disabled' })])
    expect(await orcaConnect(disabled.deps, FINGERPRINT)).toStrictEqual({ connect: 'failed', error: 'off' })
    expect(disabled.calls()).toEqual(['status --json', `plugin inspect ${disabled.folder} --json`, 'plugin list --json'])
    const removed = setup()
    up([])
    expect(writeOrcaConnected(removed.deps.dataDir)).toBeUndefined()
    expect(await orcaConnect(removed.deps)).toStrictEqual({ connect: 'failed', error: 'off' })
    expect(removed.calls()).toEqual(['status --json', `plugin inspect ${removed.folder} --json`, 'plugin list --json'])
  })

  it('Orca not running is not-running', async () => {
    const { deps, calls } = setup()
    up([])
    orca.answer('status', status(null, false))
    expect(await orcaConnect(deps)).toStrictEqual({ connect: 'failed', error: 'not-running' })
    expect(calls()).toEqual(['status --json'])
    for (const over of [{ orca: () => null }, { platform: 'win32' as const }]) {
      expect(await orcaConnect(setup(over).deps)).toStrictEqual({ connect: 'failed', error: 'not-running' })
    }
  })

  it('from the sources it is no-plugin', async () => {
    const { deps, calls } = setup({ files: () => null })
    up([])
    expect(await orcaConnect(deps)).toStrictEqual({ connect: 'failed', error: 'no-plugin' })
    expect(calls()).toEqual([])
  })

  it('an update that asks for nothing new goes through; one that asks for more is approve', async () => {
    const { deps, folder, calls } = setup()
    up([entry(folder, { version: '1.2.2' })])
    orca.answer('plugin update', installed(folder))
    expect(await orcaConnect(deps)).toStrictEqual({ connect: 'done' })
    expect(calls().slice(3)).toEqual([`plugin update ${KEY} --json`])
    const update = { fromVersion: '1.2.2', growth: { capabilities: ['agent:read'], contributions: [] } }
    orca.answer('plugin update', approval('approval_required', { data: { action: 'update', update } }), 3)
    expect(await orcaConnect(deps)).toStrictEqual({
      connect: 'approve', name: 'Harness Device', version: '1.2.3', fingerprint: FINGERPRINT, grants: [EXECUTION, WORKSPACE_READ], update: true,
    })
    expect(calls().slice(7)).toEqual([`plugin update ${KEY} --json`])
  })

  it('a hand install from another folder is installed from ours', async () => {
    const { deps, folder, calls } = setup()
    up([entry('/checkout/plugins/harness-device-orca')])
    orca.answer('plugin install', approval('approval_required'), 3)
    expect(await orcaConnect(deps)).toMatchObject({ connect: 'approve', update: true })
    expect(calls().slice(3)).toEqual([`plugin install ${folder} --json`])
  })

  it('a pending plugin is enabled', async () => {
    const { deps, folder, calls } = setup()
    up([entry(folder, { status: 'pending' })])
    orca.answer('plugin enable', approval('approval_required', { data: { action: 'enable' } }), 3)
    expect(await orcaConnect(deps)).toMatchObject({ connect: 'approve', fingerprint: FINGERPRINT, update: true })
    orca.answer('plugin enable', installed(folder))
    expect(await orcaConnect(deps, FINGERPRINT)).toStrictEqual({ connect: 'done' })
    expect(calls().filter((call) => call.startsWith('plugin enable'))).toEqual([`plugin enable ${KEY} --json`, `plugin enable ${KEY} --approve ${FINGERPRINT} --json`])
  })

  it('a current plugin is done with nothing run after the list', async () => {
    const { deps, folder, calls } = setup()
    up([entry(folder)])
    expect(await orcaConnect(deps, FINGERPRINT)).toStrictEqual({ connect: 'done' })
    expect(calls()).toEqual(['status --json', `plugin inspect ${folder} --json`, 'plugin list --json'])
  })

  it("the grants' bounds", async () => {
    const { deps } = setup()
    up([])
    const ask = async (over: Parameters<typeof approval>[1]) => {
      orca.answer('plugin install', approval('approval_required', over), 3)
      return orcaConnect(deps)
    }
    const capabilities = (descriptions: unknown[]) => descriptions.map((description) => ({ kind: 'workspace:read', description }))
    const ten = Array.from({ length: 10 }, (_, i) => String(i).repeat(300))
    expect(await ask({ grants: { executionDescription: ten[0], capabilities: capabilities(ten.slice(1)) } })).toMatchObject({ grants: ten })
    // Each line is trimmed, then its characters are counted as the app counts them: a clef is one.
    const clefs = '𝄞'.repeat(300)
    expect(await ask({ grants: { executionDescription: `  ${'a'.repeat(300)}  `, capabilities: capabilities([clefs]) } })).toMatchObject({ grants: ['a'.repeat(300), clefs] })
    // An empty or blank string is dropped, and is not one of the ten.
    expect(await ask({ grants: { executionDescription: ten[0], capabilities: capabilities([...ten.slice(1), '', '   ']) } })).toMatchObject({ grants: ten })
    const past: [string, Parameters<typeof approval>[1]][] = [
      ['11 lines', { grants: { capabilities: capabilities(Array.from({ length: 10 }, (_, i) => `Capability ${i}`)) } }],
      ['301 characters', { grants: { capabilities: capabilities(['x'.repeat(301)]) } }],
      ['a line break', { grants: { capabilities: capabilities(['Read your\nprojects']) } }],
      ['a tab', { grants: { capabilities: capabilities(['Read your\tprojects']) } }],
      ['a bell', { grants: { executionDescription: 'Runs its own\u0007code' } }],
      ['a line break at the end', { grants: { executionDescription: `${EXECUTION}\n` } }],
      ['a replacement whose command holds a line break', { grants: { replacements: [{ command: 'Open\nfile', action: 'file opener' }] } }],
      ['a replacement past 300 characters once worded', { grants: { replacements: [{ command: 'x'.repeat(270), action: 'file opener' }] } }],
      ['a replacement with no action', { grants: { replacements: [{ command: 'Open file' }] } }],
      ['a capability with no description', { grants: { capabilities: [{ kind: 'workspace:read' }] } }],
      ['capabilities that are no list', { grants: { capabilities: { kind: 'workspace:read', description: WORKSPACE_READ } } }],
      ['a name that is no string', { data: { name: 7 } }],
      ['a version that is no string', { data: { version: null } }],
      ['a name with a line break', { data: { name: 'Harness\nDevice' } }],
      ['a name past 300 characters', { data: { name: 'x'.repeat(301) } }],
    ]
    for (const [label, over] of past) {
      expect({ case: label, ...await ask(over) }).toStrictEqual({ case: label, ...FAILED })
    }
  })

  it('an approval with no grant left is failed', async () => {
    const { deps } = setup()
    up([])
    const empty: [string, Record<string, unknown>][] = [
      ['no grants', { grants: undefined }],
      ['no execution sentence and no capability', { grants: { execution: 'trusted-worker', capabilities: [], contributions: [] } }],
      ['only empty and blank strings', { grants: { execution: 'trusted-worker', executionDescription: '', capabilities: [{ kind: 'workspace:read', description: '  ' }], contributions: [] } }],
    ]
    for (const [label, data] of empty) {
      orca.answer('plugin install', approval('approval_required', { data }), 3)
      expect({ case: label, ...await orcaConnect(deps) }).toStrictEqual({ case: label, ...FAILED })
    }
  })

  it('a folder behind what cli.js carries is written before Orca is asked to install it', async () => {
    const { deps, folder } = setup()
    up([])
    orca.answer('plugin install', approval('approval_required'), 3)
    mkdirSync(folder)
    writeFileSync(join(folder, 'orca-plugin.json'), '{"version":"1.2.2"}\n')
    let shown: string[] | undefined
    const watched: OrcaPluginDeps = {
      ...deps,
      run: (file, args, opts) => {
        if (args[1] === 'install') shown = Object.keys(FILES).map((path) => readFileSync(join(folder, path), 'utf8'))
        return deps.run(file, args, opts)
      },
    }
    expect(await orcaConnect(watched)).toMatchObject({ connect: 'approve' })
    expect(shown).toEqual(Object.values(FILES))
  })
})
