import { chmodSync, mkdirSync, mkdtempSync, opendirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installedDsh } from '../../dsh/installed.js'
import { dshPinnedPermissionMode } from '../../dsh/manifest.js'
import { incompatibleHarnessEngine } from '../../dsh/compatibility.js'
import { createAndRegisterPane } from '../../lib/createAgentPane.js'
import { enginePathOverride } from '../../lib/engineBin.js'
import { windowsAfterExit } from '../../lib/windows/engineStart.js'
import { buildEngineLaunchArgv, engineLaunchEnv, namedAgentArgs, permissionModeFlags, refusePermissionFlagIfUnsupported, supportsFirstPrompt } from '../../lib/engineLaunch.js'
import { setUpWithin } from '../../lib/setUpWithin.js'
import { writeGridConfigDir } from '../../lib/gridConfigDir.js'
import { describeGridLaunch, type GridLaunchAnswer, type GridLaunchRequest } from '../../lib/gridLaunchWire.js'
import { engineHookInstallations as engineHooks } from '../../engines/nativeHookSetup.js'
import { ENUMERATION_ATTEMPTS } from '../../engines/kit/nativeFiles.js'
import { loadEngine } from '../../engines/inProcess.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { SessionOwner } from '../../lib/sessionSearch/external.js'
import { createAgentCreator, type CreateAgentDeps } from './create.js'
import { opencodeMajorVersion } from '../../engines/opencode/version.js'
import { installOpencodePlugin as installNativeOpencodePlugin } from '../../engines/nativeHooks.js'
import { missingHookScript } from '../../engines/kit/hookScript.js'
import type { NativeLaunch } from '../../engines/nativeLaunch.js'
import { projectsRoot } from '../../lib/projectFolder.js'
import { NativeFiles } from '../../engines/kit/nativeFiles.js'
import { agentLaunchArgs } from '../../lib/agentAttribution.js'
import { WindowsBatchLaunchRefused } from '../../lib/windows/launch.js'
import { ApiConnections } from '../../lib/apiConnections.js'
import { refreshApiFor } from '../../lib/apiModels.js'
import { answerGridLaunch } from '../../lib/gridLaunch.js'
import { gridLaunchThrough } from './launch.js'
import { AgentCreationReceipts } from '../../lib/agentCreationReceipt.js'
import { createLaunchRequests } from './launches.js'
import { WORKSPACES_OFF } from '../api.js'

// Real native preparation asks the fixture engine for its help: answered in this process (testing/engineHelpInProcess.ts).
vi.mock('node:child_process', async (real) => (await import('../../testing/engineHelpInProcess.js')).withEngineHelp(await real<typeof import('node:child_process')>()))
vi.mock('../../lib/projectFolder.js', async real => {
  const actual = await real<typeof import('../../lib/projectFolder.js')>()
  return { ...actual, projectsRoot: vi.fn(actual.projectsRoot) }
})

const workspaceRead = vi.hoisted(() => ({ afterStat: undefined as ((path: unknown) => void) | undefined }))

vi.mock('node:fs', async real => {
  const actual = await real<typeof import('node:fs')>()
  return { ...actual, opendirSync: vi.fn(actual.opendirSync),
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      const result = actual.statSync(...args)
      workspaceRead.afterStat?.(args[0])
      return result
    },
  }
})
vi.mock('node:fs/promises', async real => {
  const actual = await real<typeof import('node:fs/promises')>()
  return { ...actual, readdir: vi.fn(actual.readdir) }
})

vi.mock('../../dsh/installed.js', () => ({ installedDsh: vi.fn(() => undefined) }))
vi.mock('../../dsh/manifest.js', async (real) => ({ ...await real<object>(), dshPinnedPermissionMode: vi.fn(() => null) }))
vi.mock('../../dsh/compatibility.js', () => ({ incompatibleHarnessEngine: vi.fn(() => null) }))
const materializeWorkspace = vi.fn(async () => ({ warnings: [], created: [], kept: [] }))

vi.mock('../../dsh/sessionEnv.js', async (real) => ({ ...await real<object>(), harnessEnvToClear: vi.fn(() => ['HARNESS_OLD']) }))
// OpenCode's version probe is its own code, loaded for an OpenCode launch alone; a test may say it could not be.
vi.mock('../../engines/inProcess.js', async (real) => {
  const actual = await real<typeof import('../../engines/inProcess.js')>()
  return { ...actual, loadEngine: vi.fn(actual.loadEngine) }
})
vi.mock('../../engines/kit/hookScript.js', async (real) => ({ ...await real<object>(), missingHookScript: vi.fn(() => null) }))
vi.mock('../../engines/opencode/version.js', () => ({ opencodeMajorVersion: vi.fn(async () => 2) }))
vi.mock('../../engines/kit/nativePlugin.js', () => ({
  prepareNativePlugin: vi.fn(() => ({ verify: () => {}, commit: async () => ({ verify: () => {} }) })),
  prepareNativePluginRemoval: vi.fn(() => ({ verify: () => {}, commit: async () => ({ verify: () => {} }) })),
}))
vi.mock('../../engines/kit/nativeHookFiles.js', () => ({
  runHookPreparation: async (_files: string[], work: () => Promise<unknown>) => work(),
  hookPreparationRoutes: () => ({ verify: () => {}, keys: [] }),
}))
// The optional trust preparation port, one spy per engine: never the person's own config.
const trust = vi.hoisted(() => ({
  claudeTrusts: vi.fn((_path: string) => false), codexTrusts: vi.fn((_path: string, _profile?: string | null) => false),
  preTrustClaudeProject: vi.fn((_path: string): unknown => undefined), preTrustCodexProject: vi.fn((_path: string, _profile?: string | null): unknown => undefined),
}))
const { preTrustClaudeProject, preTrustCodexProject } = trust
vi.mock('../../lib/createAgentPane.js', () => ({ createAndRegisterPane: vi.fn() }))
// The pull request line (lib/agentAttribution.ts) reads the person's engine settings: never this machine's here.
vi.mock('../../lib/agentAttribution.js', () => ({
  agentLaunchArgs: vi.fn((_engine: string, startedBy: string | null | undefined) => startedBy === 'agent' ? ['--settings', '{"attribution":{}}'] : []),
  joinedInstructions: vi.fn((_engine: string, args: string[]) => args),
}))
vi.mock('../../lib/engineBin.js', async (real) => ({ ...await real<object>(), enginePathOverride: vi.fn(() => null) }))
vi.mock('../../lib/engineInstall.js', async (real) => ({ ...await real<object>(), engineInstallRecipe: vi.fn(() => ({ install: 'recipe' })) }))
vi.mock('../../lib/engineLaunch.js', async (real) => ({
  ...await real<object>(),
  buildEngineCommandArgv: vi.fn(() => ['claude']),
  buildEngineLaunchArgv: vi.fn(() => ['zsh', '-lc', 'claude']),
  engineLaunchEnv: vi.fn(() => undefined),
  namedAgentArgs: vi.fn((_engine: string, agent: string) => ['--agent', agent]),
  permissionModeApproves: vi.fn(() => true),
  permissionModeFlags: vi.fn(() => ['--permission-mode']),
  refusePermissionFlagIfUnsupported: vi.fn(async () => null),
  supportsFirstPrompt: vi.fn(() => true),
}))
vi.mock('../../lib/setUpWithin.js', async (real) => ({ ...await real<object>(), setUpWithin: vi.fn(async (run: () => Promise<unknown>) => { await run(); return 'done' }) }))
vi.mock('../../lib/gridConfigDir.js', () => ({ writeGridConfigDir: vi.fn(async () => '/config/harness-claude') }))
vi.mock('../../lib/gridLaunchWire.js', async (real) => ({
  ...await real<object>(),
  describeGridLaunch: vi.fn(() => '[grid] claude on Home'),
  gridConflictingEnvToClear: vi.fn(() => ['ANTHROPIC_API_KEY']),
}))
// The models service's grid launch (`CreateAgentDeps.buildGridLaunch`), as it answers a launch it can build.
const buildGridLaunch = vi.fn(async (request: GridLaunchRequest): Promise<GridLaunchAnswer> => ({
  ok: true, launch: { env: { GRID_KEY: 'k' }, args: ['--grid'], webSearch: 'unsupported' }, override: request.override,
}))
vi.mock('../../engines/nativeHookSetup.js', async (real) => {
  const actual = await real<typeof import('../../engines/nativeHookSetup.js')>()
  return { ...actual, engineHookInstallations: { ...actual.engineHookInstallations, codex: { ...actual.engineHookInstallations.codex, installIn: vi.fn(async () => true) } } }
})
// What the backend new panes are made on can do; every test's backend can give a session its own environment.
const capabilities = vi.fn(async () => ({ sessionEnv: true }))

const describeDsh = async (dsh: string, engine: any): Promise<any> => {
  const installed = installedDsh(dsh)
  if (!installed) return { ok: false, error: 'INVALID_DSH', detail: `${dsh} is not installed on this machine` }
  return { ok: true, id: installed.id, name: installed.manifest.name, permissionMode: dshPinnedPermissionMode(installed.manifest),
    refusal: installed.manifest.kind === 'viewer' ? `${dsh} is a viewer package, not an agent` : incompatibleHarnessEngine(dsh, installed.manifest, engine) }
}

const launchDsh = vi.fn<CreateAgentDeps['dshLaunch']['launch']>(async () => ({ ok: true, launch: { env: { HARNESS_DSH: 'blender' }, args: ['--dsh'] } }))

const root = mkdtempSync(join(tmpdir(), 'core-create-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let folders = 0
const folder = (files: string[] = []) => {
  const dir = join(root, `f${folders++}`)
  mkdirSync(dir)
  for (const file of files) writeFileSync(join(dir, file), '')
  return dir
}

const request = (over: Record<string, unknown> = {}) => ({
  engine: 'claude', cwd: folder(), bypassPermission: false, permissionMode: null, grid: null, codexHome: null, dsh: null,
  prompt: null, name: null, agent: null, resumeSessionId: null, takeOver: null, ...over,
}) as unknown as Parameters<ReturnType<typeof createAgentCreator>>[0]

const pending = { agentId: 'a1', sessionId: '', engine: 'claude' } as RegisteredSession
const owner = { pid: 7, engine: 'claude' } as SessionOwner

// Hook installation consumes the same setup port as the supervised core; the fixture owns its version replies.
const installOpencodePlugin = (port: number) => installNativeOpencodePlugin(port, undefined, {
  setup: { opencodeMajor: opencodeMajorVersion, hermesKeepsRecord: async () => null },
})

function setup(over: Partial<CreateAgentDeps> = {}) {
  const deps: CreateAgentDeps = { opencodeMajor: opencodeMajorVersion,
    createBackend: { releaseHold: vi.fn(async () => {}), capabilities } as unknown as CreateAgentDeps['createBackend'],
    registry: { setLaunch: vi.fn(() => ({ ...pending, launch: { state: 'ready' } })) } as unknown as CreateAgentDeps['registry'],
    externalResume: vi.fn<CreateAgentDeps['externalResume']>(async () => ({ ok: true, session: pending })),
    watchNewPane: vi.fn(async () => {}),
    announceSession: vi.fn(),
    attach: vi.fn(),
    prepareInstructions: vi.fn(async () => {}),
    prepareFolderTrust: async ({ engine, cwd, profile }, current) => {
      if (!current()) return false
      if (engine === 'claude') preTrustClaudeProject(cwd)
      if (engine === 'codex') preTrustCodexProject(cwd, profile)
      return true
    },
    hookPort: 4242,
    hooksDisabled: false,
    installOpencodePlugin: vi.fn(async () => true),
    gridLaunchMachine: vi.fn(() => ({}) as never),
    buildGridLaunch,
    terminalHintMachineName: () => 'this-mac',
    blocksFolder: vi.fn(() => false),
    gridSetup: vi.fn(() => vi.fn(async () => ({}))) as never,
    privateGridName: vi.fn(async () => 'grid-me'),
    dshLaunch: { describe: describeDsh, launch: launchDsh, materialize: async () => ({ ok: true, ...await materializeWorkspace() }) },
    syncProfileHome: vi.fn(async () => []),
    ...over,
  }
  return { deps, create: createAgentCreator(deps) }
}

const installed = (over: Record<string, unknown> = {}) => ({ id: 'autonomous/blender', manifest: { name: 'Blender', kind: 'agent' }, ...over })

describe('creating an agent', () => {
  it('holds a native create with no preparation owner even when no permission flag was requested', async () => {
    const run = setup({ native: undefined })
    expect(await run.create(request())).toMatchObject({ ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native' })
    expect(createAndRegisterPane).not.toHaveBeenCalled()
    expect(run.deps.prepareInstructions).not.toHaveBeenCalled()
  })
  beforeEach(() => {
    vi.mocked(projectsRoot).mockReset()
    vi.mocked(opendirSync).mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(createAndRegisterPane).mockReset().mockResolvedValue({ ok: true, spawned: { runtime: { paneId: '%1' } }, pending } as never)
  })
  // A launch or an installed harness one test queued and never used answers no other test.
  afterEach(() => { workspaceRead.afterStat = undefined; vi.restoreAllMocks(); vi.clearAllMocks(); launchDsh.mockReset(); vi.mocked(installedDsh).mockReset() })

  describe('Saved API freshness', () => {
    function savedApi(over: Partial<CreateAgentDeps> = {}) {
      const store = new ApiConnections(folder())
      const connection = store.save({ provider: 'custom', name: 'Fixture API', baseUrl: 'https://old.example.test/v1', apiKey: 'FAKE-old-key' })
      const grid = { networkId: `api:${connection.id}`, networkName: connection.name, baseUrl: connection.baseUrl, apiKey: 'FAKE-old-key', model: 'fixture-model' }
      const models = vi.fn(async (input: GridLaunchRequest) => answerGridLaunch(input, refreshApiFor(store)))
      const run = setup({ buildGridLaunch: gridLaunchThrough(() => ({ gridLaunch: models })), ...over })
      const rotate = () => store.save({ ...connection, name: 'Current API', baseUrl: 'https://current.example.test/v1', apiKey: 'FAKE-current-key' })
      return { ...run, store, connection, grid, models, rotate }
    }

    it('creates with the current credential and records the accepted endpoint and override', async () => {
      const run = savedApi()
      const input = request({ grid: run.grid })
      const original = structuredClone(input)
      const current = run.rotate()
      expect(await run.create(input)).toMatchObject({ ok: true })
      const pane = vi.mocked(createAndRegisterPane).mock.calls[0]![0]
      expect(pane.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'FAKE-current-key' })
      expect(pane.grid).toEqual({ baseUrl: current.baseUrl, model: run.grid.model })
      expect(pane.gridLaunchRecord).toMatchObject({ override: { ...run.grid, networkName: current.name, baseUrl: current.baseUrl, apiKey: 'FAKE-current-key' } })
      expect(describeGridLaunch).toHaveBeenCalledWith('claude', pane.gridLaunchRecord!.override, pane.gridLaunchRecord!.webSearch)
      expect(input).toEqual(original)
    })

    it('refuses a deleted source before workspace, trust, native hooks or pane effects', async () => {
      const prepareHooks = vi.fn(async () => true)
      const native = { current: () => true, environment: { HOME: root }, prepareHooks } as unknown as NativeLaunch
      const run = savedApi({ native: async () => ({ ok: true, launch: native }) })
      vi.mocked(installedDsh).mockReturnValue(installed() as never)
      run.store.remove(run.connection.id)
      expect(await run.create(request({ grid: run.grid, dsh: 'blender' }))).toMatchObject({ ok: false, error: 'API_UNAVAILABLE' })
      expect(materializeWorkspace).not.toHaveBeenCalled()
      expect(preTrustClaudeProject).not.toHaveBeenCalled()
      expect(run.deps.prepareInstructions).not.toHaveBeenCalled()
      expect(run.deps.watchNewPane).not.toHaveBeenCalled()
      expect(prepareHooks).not.toHaveBeenCalled()
      expect(createAndRegisterPane).not.toHaveBeenCalled()
    })

    it('keeps an ordinary Grid launch unchanged when Models refreshes it', async () => {
      const run = savedApi()
      const grid = { ...run.grid, networkId: 'grid-fixture' }
      run.rotate()
      const read = vi.spyOn(run.store, 'modelAccess')
      expect(await run.create(request({ grid }))).toMatchObject({ ok: true })
      const pane = vi.mocked(createAndRegisterPane).mock.calls[0]![0]
      expect(pane.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: grid.apiKey })
      expect(pane.grid).toEqual({ baseUrl: grid.baseUrl, model: grid.model })
      expect(pane.gridLaunchRecord).toMatchObject({ override: grid })
      expect(read).not.toHaveBeenCalled()
    })

    it.each(['replay', 'cancel'] as const)('preserves original durable request authority across credential refresh: %s', async mode => {
      const run = savedApi()
      const receiptDirectory = folder()
      const receipts = new AgentCreationReceipts(receiptDirectory)
      let enter!: () => void, release!: () => void
      const entered = new Promise<void>(resolve => { enter = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      const answer = run.models.getMockImplementation()!
      run.models.mockImplementationOnce(async input => { enter(); await gate; return answer(input) })
      const requests = createLaunchRequests({
        receipts, createAgent: () => run.create, prepareCreate: run.create.prepare,
        forkAgent: () => null, resumeAgent: () => null, restartAgent: () => null,
        byAgent: id => id === pending.agentId ? pending : undefined, stoppedAgent: () => undefined,
        toProject: async row => ({ id: row.agentId }) as never,
        modelTarget: async () => null, workspaces: () => WORKSPACES_OFF,
      })
      const payload = { creationId: 'saved-api-freshness-fixture', engine: 'claude', cwd: folder(), grid: run.grid }
      const ask = async (value = payload) => {
        let reply!: (value: Record<string, unknown>) => void
        const result = new Promise<Record<string, unknown>>(resolve => { reply = resolve })
        await requests.create(value, { local: true }, reply)
        return result
      }
      try {
        const first = ask()
        await entered
        const original = receipts.pendingIntent(payload.creationId)!
        const originalBytes = readFileSync(join(receiptDirectory, `${payload.creationId}.json`), 'utf8')
        expect(original.request).toMatchObject({ kind: 'native-create-v1', input: { grid: run.grid } })
        run.rotate()
        if (mode === 'cancel') receipts.cancelIntent(payload.creationId)
        else expect(receipts.pendingIntent(payload.creationId)).toEqual(original)
        release()
        const result = await first
        expect(result).toMatchObject({ state: mode === 'cancel' ? 'cancelled' : 'created' })
        run.store.remove(run.connection.id)
        expect(await ask()).toEqual(result)
        expect(createAndRegisterPane).toHaveBeenCalledTimes(mode === 'cancel' ? 0 : 1)
        if (mode === 'replay') {
          expect(vi.mocked(createAndRegisterPane).mock.calls[0]![0].gridLaunchRecord).toMatchObject({ override: { apiKey: 'FAKE-current-key' } })
          expect(await ask({ ...payload, grid: { ...run.grid, apiKey: 'FAKE-changed-request' } })).toEqual({ error: 'CREATION_CONFLICT' })
        }
        expect(run.models).toHaveBeenCalledOnce()
        expect(readFileSync(join(receiptDirectory, `${payload.creationId}.json`), 'utf8')).toBe(originalBytes)
      } finally { release(); requests.stop() }
    })
  })

  it('waits for deferred workspace instructions and refuses a launch revoked during them', async () => {
    let release!: () => void, entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let current = true
    const run = setup({ prepareInstructions: async () => { entered(); await gate } })
    const result = run.create.prepare(request(), { id: 'instructions', label: 'harness-claude-instructions', current: () => current, hold: vi.fn() })
    await ready
    current = false
    release()
    expect(await result).toMatchObject({ ok: false, error: 'LAUNCH_AUTHORITY_CHANGED' })
    expect(createAndRegisterPane).not.toHaveBeenCalled()
  })

  it.each([false, true])('awaits optional folder-trust preparation and rechecks launch authority: revoked=%s', async revoked => {
    const cwd = folder()
    vi.mocked(projectsRoot).mockReturnValue(root)
    let current = true
    const prepareFolderTrust = vi.fn(async () => {
      // Yield inside the optional owner: launch authority may change while it prepares bytes.
      await Promise.resolve()
      if (revoked) current = false
      return true
    })
    const prepareHooks = vi.fn(async () => {
      expect(prepareFolderTrust).toHaveBeenCalledOnce()
      expect(preTrustCodexProject).not.toHaveBeenCalled()
      return true
    })
    const launch = { current: () => current, environment: { HOME: '/fixture/home', CODEX_HOME: '/fixture/selected' },
      permission: async () => 'supported', prepareHooks,
    } as unknown as NativeLaunch
    const run = setup({ prepareFolderTrust, native: async () => ({ ok: true, launch }) } as Partial<CreateAgentDeps>)
    const result = await run.create.prepare(request({ cwd, engine: 'codex' }),
      { id: 'fixture', label: 'harness-codex-fixture', current: () => current, hold: () => {} }, { local: true })
    expect(prepareFolderTrust).toHaveBeenCalledOnce()
    expect(preTrustCodexProject).not.toHaveBeenCalled()
    if (revoked) {
      expect(result).toMatchObject({ ok: false, unavailable: 'launch' })
      expect(prepareHooks).not.toHaveBeenCalled()
    } else expect(result.ok).toBe(true)
    expect(createAndRegisterPane).not.toHaveBeenCalled()
  })

  it('refuses native hook preparation when authority changes during the final trusted-workspace read', async () => {
    const cwd = folder()
    vi.mocked(projectsRoot).mockReturnValue(root)
    let current = true, trusted = false
    workspaceRead.afterStat = path => { if (trusted && path === cwd) current = false }
    const prepareHooks = vi.fn(async () => true)
    const launch = { current: () => current, environment: { HOME: root }, prepareHooks } as unknown as NativeLaunch
    const run = setup({ native: async () => ({ ok: true, launch }), prepareFolderTrust: async () => { trusted = true; return true } })
    const result = await run.create.prepare(request({ cwd }),
      { id: 'fixture', label: 'harness-claude-fixture', current: () => current, hold: () => {} }, { local: true })
    expect(result).toMatchObject({ ok: false, error: 'LAUNCH_AUTHORITY_CHANGED' })
    expect(prepareHooks).not.toHaveBeenCalled()
    expect(createAndRegisterPane).not.toHaveBeenCalled()
  })

  it.each(['replaced', 'removed'] as const)('holds a workspace %s while optional trust is awaiting its owner', async change => {
    const cwd = folder()
    vi.mocked(projectsRoot).mockReturnValue(root)
    const prepareFolderTrust = vi.fn<NonNullable<CreateAgentDeps['prepareFolderTrust']>>(async (_input, current) => {
      await Promise.resolve()
      renameSync(cwd, cwd + '-original')
      if (change === 'replaced') mkdirSync(cwd)
      expect(current()).toBe(false)
      return false
    })
    const prepareHooks = vi.fn(async () => true)
    const launch = { current: () => true, environment: { HOME: '/fixture/home', CODEX_HOME: '/fixture/selected' },
      permission: async () => 'supported', prepareHooks,
    } as unknown as NativeLaunch
    const run = setup({ prepareFolderTrust, native: async () => ({ ok: true, launch }) })
    expect(await run.create.prepare(request({ cwd, engine: 'codex' }),
      { id: 'fixture', label: 'harness-codex-fixture', current: () => true, hold: () => {} }, { local: true }))
      .toMatchObject({ ok: false, unavailable: 'launch' })
    expect(prepareHooks).not.toHaveBeenCalled()
    expect(createAndRegisterPane).not.toHaveBeenCalled()
  })

  // No owner subscription relay (task #4137): Claude Code and Codex, a profile's own Codex home among them, launch on their
  // own settings, with nothing of a relay in the pane's environment or on the engine's command line.
  it('launches every engine on its own settings: no relay variables or provider', async () => {
    for (const over of [{ engine: 'claude' }, { engine: 'codex' }, { engine: 'codex', codexHome: '/fixture/pm-home/codex' }]) {
      expect(await setup().create(request({ cwd: folder(), ...over }))).toMatchObject({ ok: true })
      const env = vi.mocked(createAndRegisterPane).mock.calls.at(-1)![0].env ?? {}
      for (const name of ['HARNESS_RELAY_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']) expect(env).not.toHaveProperty(name)
      expect((vi.mocked(buildEngineLaunchArgv).mock.calls.at(-1)![1]?.extraArgs ?? []).join(' ')).not.toMatch(/harness_owner/)
    }
  })

  it.each(['local', 'remote', 'nonempty', 'unreadable', 'unreadable before trust', 'revoked', 'revoked before trust', 'changed contents', 'replaced workspace', 'changed after enumeration', 'redirected during enumeration', 'error', 'thrown text', 'no trust contract', 'legacy'] as const)(
    'decides local trust before workspace preparation and writes it before final proof: %s', async mode => {
      const parent = mode === 'redirected during enumeration' ? folder() : root
      vi.mocked(projectsRoot).mockReturnValueOnce(parent)
      const cwd = parent === root ? folder(mode === 'nonempty' ? ['user-file'] : []) : join(parent, 'workspace')
      mkdirSync(cwd, { recursive: true })
      let current = true
      if (mode === 'unreadable') vi.mocked(readdir).mockRejectedValueOnce(Error('fixture denied'))
      if (mode === 'unreadable before trust') vi.spyOn(NativeFiles.prototype, 'entries').mockImplementationOnce(() => { throw Error('fixture denied') })
      if (mode === 'revoked') vi.mocked(readdir).mockImplementationOnce(async () => { current = false; return [] })
      if (mode === 'revoked before trust') vi.spyOn(NativeFiles.prototype, 'entries').mockImplementationOnce(() => { current = false; return [] })
      if (mode === 'changed after enumeration') {
        const entries = NativeFiles.prototype.entries
        vi.spyOn(NativeFiles.prototype, 'entries').mockImplementationOnce(function (this: NativeFiles, path, missing) {
          const result = entries.call(this, path, missing)
          writeFileSync(join(cwd, 'user-file'), 'arrived after the empty read')
          return result
        })
      }
      if (mode === 'redirected during enumeration') {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
        // Redirected during every look (`ENUMERATION_ATTEMPTS`): one redirect alone is looked at again.
        let redirects = 0
        vi.mocked(opendirSync).mockImplementation((path, options) => {
          if (++redirects > ENUMERATION_ATTEMPTS) return actual.opendirSync(path, options)
          renameSync(parent, parent + '-original'); mkdirSync(cwd, { recursive: true })
          try { return actual.opendirSync(path, options) }
          finally { renameSync(parent, `${parent}-redirected-${redirects}`); renameSync(parent + '-original', parent) }
        })
      }
      if (mode === 'error' || mode === 'thrown text') preTrustCodexProject.mockImplementationOnce(() => { throw mode === 'error' ? Error('fixture denied') : 'fixture denied' })
      const expected = !['remote', 'nonempty', 'unreadable', 'unreadable before trust', 'revoked', 'revoked before trust', 'changed contents', 'replaced workspace', 'changed after enumeration', 'redirected during enumeration', 'no trust contract'].includes(mode)
      const launch = { current: () => current, environment: { HOME: '/fixture/home', CODEX_HOME: '/fixture/selected' },
        permission: async () => 'supported', prepareHooks: vi.fn(async () => {
          expect(preTrustCodexProject, JSON.stringify(vi.mocked(console.warn).mock.calls)).toHaveBeenCalledTimes(expected ? 1 : 0)
          return true
        }),
      } as unknown as NativeLaunch
      const run = setup(mode === 'legacy' ? {} : { native: async () => {
        if (mode === 'changed contents') writeFileSync(join(cwd, 'user-file'), 'user content')
        if (mode === 'replaced workspace') { renameSync(cwd, cwd + '-original'); mkdirSync(cwd) }
        return { ok: true, launch }
      } })
      const result = await run.create.prepare(request({ cwd, engine: mode === 'no trust contract' ? 'opencode' : 'codex' }),
        { id: 'fixture', label: 'harness-codex-fixture', current: () => current, hold: () => {} }, { local: mode !== 'remote' })
      if (mode === 'revoked' || mode === 'revoked before trust' || mode === 'replaced workspace') expect(result).toMatchObject({ ok: false, unavailable: 'launch' })
      else expect(result.ok).toBe(true)
      expect(preTrustCodexProject, JSON.stringify(vi.mocked(console.warn).mock.calls)).toHaveBeenCalledTimes(expected ? 1 : 0)
      if (expected) expect(preTrustCodexProject).toHaveBeenCalledWith(cwd, mode === 'legacy' ? null : '/fixture/selected')
    })

  // A Claude Code agent in an empty project here is trusted as a Codex one is, in the profile it reads.
  it('trusts a Claude Code agent\'s empty local project before its launch', async () => {
    vi.mocked(projectsRoot).mockReturnValueOnce(root)
    const cwd = folder([])
    const launch = { current: () => true, environment: { HOME: '/fixture/home' }, permission: async () => 'supported',
      prepareHooks: vi.fn(async () => true) } as unknown as NativeLaunch
    const run = setup({ native: async () => ({ ok: true, launch }) })
    const result = await run.create.prepare(request({ cwd, engine: 'claude' }),
      { id: 'fixture', label: 'harness-claude-fixture', current: () => true, hold: () => {} }, { local: true })
    expect(result.ok).toBe(true)
    expect(preTrustClaudeProject).toHaveBeenCalledExactlyOnceWith(cwd)
  })

  it.each(['workspace materialization', 'tmux capabilities', 'config publication'] as const)('holds a create revoked during %s before launch side effects', async stage => {
    let current = true
    vi.mocked(installedDsh).mockReturnValue(installed() as never)
    const run = setup()
    if (stage === 'workspace materialization') materializeWorkspace.mockImplementationOnce(async () => { current = false; return { warnings: [], created: [], kept: [] } })
    if (stage === 'tmux capabilities') capabilities.mockImplementationOnce(async () => { current = false; return { sessionEnv: true } })
    if (stage === 'config publication') vi.mocked(writeGridConfigDir).mockImplementationOnce(async () => { current = false; return '/fixture/config' })
    buildGridLaunch.mockResolvedValueOnce({ ok: true, override: { networkId: 'fixture', networkName: 'Fixture', baseUrl: 'http://fixture.invalid', apiKey: 'fixture' }, launch: {
      env: {}, args: [], webSearch: 'unsupported', configDir: { envVar: 'PI_CONFIG', files: [] },
    } })
    try {
      expect(await run.create.prepare(request(stage === 'workspace materialization' ? { dsh: 'blender' } : { grid: { networkName: 'Fixture' } }),
        { id: 'fixture', label: 'harness-claude-fixture', current: () => current, hold: vi.fn() }))
        .toMatchObject({ error: 'LAUNCH_AUTHORITY_CHANGED' })
      expect(createAndRegisterPane).not.toHaveBeenCalled()
      expect(run.deps.prepareInstructions).not.toHaveBeenCalled()
    } finally {
      vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
      buildGridLaunch.mockReset().mockImplementation(async request => ({ ok: true, override: request.override,
        launch: { env: { GRID_KEY: 'k' }, args: ['--grid'], webSearch: 'unsupported' } }))
    }
  })

  it('uses the confirmed native version for a named launch and forwards preparation holds', async () => {
    const launch = { current: () => true, environment: { HOME: root }, prepareHooks: async () => true, opencodeMajor: 1 } as unknown as NativeLaunch
    const run = setup({ native: async (_engine, _source, authority) => {
      authority.hold({ service: 'native', detail: 'Checking fixture executable' })
      return { ok: true, launch }
    } })
    expect(await run.create(request({ engine: 'opencode', agent: 'named' }))).toMatchObject({ ok: true })
    expect(namedAgentArgs).toHaveBeenCalledWith('opencode', 'named', 1)
    expect(opencodeMajorVersion).not.toHaveBeenCalled()
  })

  it.each(['initial', 'description', 'inspect', 'permission', 'models', 'account', 'materialize', 'harness', 'instructions', 'dispatch'] as const)(
    'revokes preparation at %s before any native pane dispatch', async stage => {
      let current = stage !== 'initial'
      const revoke = (at: string) => { if (stage === at) current = false }
      const launch = { current: () => true, environment: { HOME: root }, prepareHooks: async () => true, opencodeMajor: 1 } as unknown as NativeLaunch
      vi.mocked(installedDsh).mockReturnValue(installed() as never)
      vi.mocked(refusePermissionFlagIfUnsupported).mockImplementationOnce(async () => { revoke('permission'); return null })
      const run = setup({ native: async () => { revoke('inspect'); return { ok: true, launch } },
        buildGridLaunch: async request => { revoke('models'); return { ok: true, override: request.override, launch: { env: {}, args: [], webSearch: 'unsupported' } } },
        privateGridName: async () => { revoke('account'); return null },
        dshLaunch: { describe: async (dsh, engine) => { const answer = await describeDsh(dsh, engine); revoke('description'); return answer },
          materialize: async () => { revoke('materialize'); return { ok: true, warnings: [], created: [], kept: [] } },
          launch: async () => { revoke('harness'); return { ok: true, launch: { env: {}, args: [] } } },
        },
        prepareInstructions: async () => revoke('instructions'),
      })
      try {
        const prepared = await run.create.prepare(request({ dsh: 'blender', grid: { networkName: 'fixture' } }),
          { id: 'fixture', label: 'harness-claude-fixture', current: () => current, hold: vi.fn() })
        revoke('dispatch')
        const result = prepared.ok ? await prepared.dispatch() : prepared
        expect(result).toMatchObject({ ok: false, error: 'LAUNCH_AUTHORITY_CHANGED' })
        expect(createAndRegisterPane).not.toHaveBeenCalled()
      } finally {
        vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
        vi.mocked(refusePermissionFlagIfUnsupported).mockReset().mockResolvedValue(null)
      }
    },
  )

  it('holds an unavailable native snapshot, unsupported named engine and incomplete hook preparation', async () => {
    const held = { ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail: 'Waiting for executable' } as const
    expect(await setup({ native: async () => held }).create(request())).toEqual(held)
    const launch = { current: () => true, environment: { HOME: root }, prepareHooks: async () => false, opencodeMajor: 2 } as unknown as NativeLaunch
    const run = setup({ native: async () => ({ ok: true, launch }) })
    expect(await run.create(request({ engine: 'opencode', agent: 'named' }))).toMatchObject({ error: 'AGENT_UNSUPPORTED' })
    expect(await run.create(request())).toMatchObject({ unavailable: 'native', detail: expect.stringContaining('hooks') })
    expect(createAndRegisterPane).not.toHaveBeenCalled()
  })

  describe('a --local OpenClaw run', () => {
    const authority = { id: 'local', label: 'harness-openclaw-local', current: () => true, hold: () => {} }
    const prepared = (openclawLocal?: string) => ({ ok: true as const, launch: { current: () => true, environment: { HOME: root },
      prepareHooks: async () => true, opencodeMajor: null, ...(openclawLocal ? { openclawLocal } : {}) } as unknown as NativeLaunch })

    it('a local create hands its folder to the native launch and to the row', async () => {
      const local = folder()
      const native = vi.fn<NonNullable<CreateAgentDeps['native']>>(async (_engine, source) => prepared(source.openclawLocal ?? undefined))
      expect(await setup({ native }).create(request({ engine: 'openclaw', openclawLocal: local }))).toMatchObject({ ok: true })
      expect(native.mock.calls[0][1]).toMatchObject({ openclawLocal: local })
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({ engine: 'openclaw', openclawLocal: local })
      await setup({ native }).create(request({ engine: 'openclaw' }))
      expect(vi.mocked(createAndRegisterPane).mock.calls[1][0]).not.toHaveProperty('openclawLocal')
    })

    it('a folder gone by the time a saved launch runs is refused, and nothing is launched', async () => {
      const local = folder()
      rmSync(local, { recursive: true })
      const native = vi.fn<NonNullable<CreateAgentDeps['native']>>(async (_engine, source) => prepared(source.openclawLocal ?? undefined))
      expect(await setup({ native }).create.prepare(request({ engine: 'openclaw', openclawLocal: local }), authority))
        .toEqual({ ok: false, error: 'OPENCLAW_FOLDER_GONE', detail: "This run's OpenClaw folder is gone." })
      expect(native).not.toHaveBeenCalled()
      expect(createAndRegisterPane).not.toHaveBeenCalled()
    })

    it('a local create never starts on a launch that was not prepared for its folder', async () => {
      const local = folder()
      const unprepared = { ok: false, error: 'OPENCLAW_LOCAL_UNPREPARED', detail: 'This Harness could not prepare the --local folder. Nothing was started.' }
      for (const native of [async () => prepared(), async () => prepared(folder()), undefined]) {
        expect(await setup({ native }).create.prepare(request({ engine: 'openclaw', openclawLocal: local }), authority)).toEqual(unprepared)
      }
      expect(createAndRegisterPane).not.toHaveBeenCalled()
    })
  })

  // #3954: every install refuses while notify.mjs is missing, and the create said only "Waiting to confirm the engine's
  // native hooks", which waiting never changes.
  it('names a missing notify.mjs, and what to do, where a held create says why', async () => {
    vi.mocked(missingHookScript).mockReturnValue('/opt/harness/hook/notify.mjs')
    try {
      const launch = { current: () => true, environment: { HOME: root }, prepareHooks: async () => false } as unknown as NativeLaunch
      expect(await setup({ native: async () => ({ ok: true, launch }) }).create(request())).toEqual({ ok: false, error: 'NATIVE_LAUNCH_HELD',
        unavailable: 'native', detail: 'Harness’s hook script is missing (/opt/harness/hook/notify.mjs). Reinstall Harness, then start the agent again.' })
      expect(missingHookScript).toHaveBeenLastCalledWith('claude')
      expect(createAndRegisterPane).not.toHaveBeenCalled()
    } finally { vi.mocked(missingHookScript).mockReturnValue(null) }
  })

  it('refuses, with the engine\'s own reason, an engine that ran and failed instead of holding the creation', async () => {
    const detail = 'Codex is installed but cannot run: /usr/bin/env: ‘node’: No such file or directory'
    const broken = { ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail, refusal: 'ENGINE_CANNOT_RUN' } as const
    expect(await setup({ native: async () => broken }).create(request())).toEqual({ ok: false, error: 'ENGINE_CANNOT_RUN', detail })
    expect(createAndRegisterPane).not.toHaveBeenCalled()
  })

  it.each(['published', 'legacy', 'no retain', 'revoked proof', 'write failed'] as const)('keeps generated native configuration authoritative: %s', async mode => {
    const proof = { files: [], current: () => true }
    const launch = { current: () => true, environment: { HOME: root }, prepareHooks: async () => true, opencodeMajor: null,
      ...(mode === 'no retain' ? {} : { retain: vi.fn(() => mode !== 'revoked proof') }),
    } as unknown as NativeLaunch
    const publishConfig = vi.fn<NonNullable<CreateAgentDeps['publishConfig']>>(async (_key, _files, _links, current) => {
      expect(current?.()).toBe(true)
      if (mode === 'write failed') throw Error('fixture publication unavailable')
      return { directory: '/fixture/published', proof }
    })
    const run = setup({ native: async () => ({ ok: true, launch }), ...(mode === 'legacy' ? {} : { publishConfig }),
      buildGridLaunch: async request => ({ ok: true, override: request.override, launch: { env: {}, args: [], webSearch: 'unsupported',
        configDir: { envVar: 'PI_CONFIG', files: [], links: [] } } }),
    })
    const result = await run.create(request({ engine: 'pi', grid: { networkName: 'fixture' } }))
    if (mode === 'published' || mode === 'legacy') expect(result).toMatchObject({ ok: true })
    else {
      expect(result).toMatchObject({ ok: false, unavailable: mode === 'write failed' ? 'native' : 'launch' })
      expect(createAndRegisterPane).not.toHaveBeenCalled()
    }
  })

  it('records the final harness-selected Codex home used by real native preparation', async () => {
    const executable = await import('../../engines/kit/launchExecutable.js')
    // An engine that runs (the child_process mock above): a launch that names no mode still asks for its help.
    vi.spyOn(executable, 'captureLaunchExecutable').mockResolvedValue({ state: 'ready',
      executable: { command: '/fixture/engine', identity: 'fixture', current: () => true },
      environment: { HOME: root, PATH: '/fixture/bin' },
    })
    const { inspectNativeLaunch } = await import('../../testing/nativeSetupInProcess.js')
    vi.mocked(installedDsh).mockReturnValue(installed() as never)
    const finalHome = join(root, 'harness-codex')
    launchDsh.mockResolvedValueOnce({ ok: true, launch: { env: { CODEX_HOME: finalHome }, args: [] } })
    const { create } = setup({ native: (engine, source) => inspectNativeLaunch(engine, source), hooksDisabled: true })
    const result = await create(request({ engine: 'codex', codexHome: join(root, 'selected-codex'), dsh: 'blender' }))
    vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
    expect(createAndRegisterPane).toHaveBeenCalledWith(expect.objectContaining({ codexHome: finalHome, env: expect.objectContaining({ CODEX_HOME: finalHome }) }))
    expect(vi.mocked(createAndRegisterPane).mock.calls[0]![0].current?.()).toBe(true)
  })

  it('does not open a Codex pane before its profile hooks are durably confirmed', async () => {
    let finish!: (installed: boolean) => void
    vi.mocked(engineHooks.codex.installIn).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const { create } = setup()
    const input = request({ engine: 'codex', codexHome: '/profiles/work' })
    const first = create(input)
    await vi.waitFor(() => expect(engineHooks.codex.installIn).toHaveBeenCalled())
    expect(createAndRegisterPane).not.toHaveBeenCalled()
    finish(false)
    expect(await first).toMatchObject({ ok: false, error: 'NATIVE_LAUNCH_HELD' })
    expect(createAndRegisterPane).not.toHaveBeenCalled()
    expect(await create(input)).toMatchObject({ ok: true })
    expect(createAndRegisterPane).toHaveBeenCalledTimes(1)
  })

  it('asks connected services for the connections of an agent on a Claude or Codex profile home, and none for the default home', async () => {
    const syncProfileHome = vi.fn<CreateAgentDeps['syncProfileHome']>(async () => [])
    const { create } = setup({ syncProfileHome })
    expect(await create(request({ engine: 'claude', claudeHome: '/profiles/claude-work' }))).toMatchObject({ ok: true })
    expect(await create(request({ engine: 'codex', codexHome: '/profiles/codex-work' }))).toMatchObject({ ok: true })
    expect(syncProfileHome.mock.calls).toEqual([['claude', '/profiles/claude-work'], ['codex', '/profiles/codex-work']])
    syncProfileHome.mockClear()
    expect(await create(request({ engine: 'claude' }))).toMatchObject({ ok: true })
    expect(await create(request({ engine: 'codex' }))).toMatchObject({ ok: true })
    expect(await create(request({ engine: 'opencode', claudeHome: '/profiles/claude-work' }))).toMatchObject({ ok: true })
    expect(syncProfileHome).not.toHaveBeenCalled()
  })

  it('starts an agent on a profile home once its connections are there, which the engine reads as it starts', async () => {
    let written!: (names: string[]) => void
    const syncProfileHome = vi.fn<CreateAgentDeps['syncProfileHome']>(() => new Promise((resolve) => { written = resolve }))
    const launch = setup({ syncProfileHome }).create(request({ engine: 'claude', claudeHome: '/profiles/claude-work' }))
    await vi.waitFor(() => expect(syncProfileHome).toHaveBeenCalledTimes(1))
    expect(createAndRegisterPane).not.toHaveBeenCalled()
    written(['gmail'])
    expect(await launch).toMatchObject({ ok: true })
    expect(createAndRegisterPane).toHaveBeenCalledTimes(1)
  })

  it('reaches the existing first-install pane route when OpenCode is absent', async () => {
    vi.mocked(opencodeMajorVersion).mockResolvedValueOnce(null)
    const { create } = setup({ installOpencodePlugin })
    expect(await create(request({ engine: 'opencode' }))).toMatchObject({ ok: true })
    expect(buildEngineLaunchArgv).toHaveBeenCalledWith('opencode', expect.objectContaining({ installIfMissing: { install: 'recipe' } }))
    expect(createAndRegisterPane).toHaveBeenCalledTimes(1)
  })

  it('hands external resume to its durable controller before folder, instructions or engine preparation', async () => {
    const externalResume = vi.fn<CreateAgentDeps['externalResume']>(async () => ({ ok: true, session: pending }))
    const test = setup({ externalResume })
    const input = request({ resumeSessionId: 'conversation' })
    expect(await test.create(input)).toEqual({ ok: true, session: pending })
    expect(externalResume).toHaveBeenCalledWith(input)
    expect(createAndRegisterPane).not.toHaveBeenCalled()
    expect(test.deps.prepareInstructions).not.toHaveBeenCalled()
  })

  describe('refusals before any pane opens', () => {
    it('recovers a backend missing at boot, and rechecks launch authority after recovery', async () => {
      const ready = setup().deps.createBackend!
      const recoverBackend = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(ready)
      const run = setup({ createBackend: null, recoverBackend })
      expect(await run.create(request())).toEqual({ ok: false, error: 'TMUX_UNAVAILABLE' })
      expect(await run.create(request())).toEqual({ ok: true, session: pending })
      expect(createAndRegisterPane).toHaveBeenCalledWith(expect.objectContaining({ tmuxBackend: ready }))
      vi.mocked(createAndRegisterPane).mockClear()
      let current = true
      const stale = setup({ createBackend: null, recoverBackend: async () => { current = false; return ready } })
      expect(await stale.create.prepare(request(), { id: 'recovery', label: 'recovery', current: () => current, hold: () => {} }))
        .toMatchObject({ ok: false, error: 'LAUNCH_AUTHORITY_CHANGED' })
      expect(createAndRegisterPane).not.toHaveBeenCalled()
    })

    it('does not ask for backend recovery on a healthy launch', async () => {
      const recoverBackend = vi.fn()
      expect(await setup({ recoverBackend }).create(request())).toEqual({ ok: true, session: pending })
      expect(recoverBackend).not.toHaveBeenCalled()
    })

    it('a batch-file engine on Windows whose first message cmd.exe would read, by name; other errors are not refusals', async () => {
      vi.mocked(buildEngineLaunchArgv).mockImplementationOnce(() => { throw new WindowsBatchLaunchRefused('claude', 'C:\\tools\\claude.cmd') })
      expect(await setup().create(request({ prompt: 'fix&calc' }))).toEqual({
        ok: false, error: 'ENGINE_LAUNCH_REFUSED', detail: expect.stringMatching(/^Harness cannot start claude on Windows .*claude\.cmd is a batch file/),
      })
      expect(createAndRegisterPane).not.toHaveBeenCalled()
      vi.mocked(buildEngineLaunchArgv).mockImplementationOnce(() => { throw new Error('fixture') })
      await expect(setup().create(request())).rejects.toThrow('fixture')
    })

    it('without tmux, in a folder being purged, or in a folder that is not one', async () => {
      expect(await setup({ createBackend: null }).create(request())).toEqual({ ok: false, error: 'TMUX_UNAVAILABLE' })
      // Where the pty host is the configured backend (Windows), its own code: there is no tmux to install.
      expect(await setup({ createBackend: null, noBackendCode: 'PTY_HOST_UNAVAILABLE' }).create(request())).toEqual({ ok: false, error: 'PTY_HOST_UNAVAILABLE' })
      expect(await setup({ blocksFolder: () => true }).create(request())).toEqual({ ok: false, error: 'WORKTREE_BUSY' })
      const { create } = setup()
      const file = join(folder(['x']), 'x')
      expect(await create(request({ cwd: file }))).toEqual({ ok: false, error: 'CWD_NOT_FOUND' })
      expect(await create(request({ cwd: join(root, 'missing') }))).toEqual({ ok: false, error: 'CWD_NOT_FOUND' })
      expect(createAndRegisterPane).not.toHaveBeenCalled()
    })

    it('for a permission flag the engine does not take', async () => {
      vi.mocked(refusePermissionFlagIfUnsupported).mockResolvedValueOnce({ error: 'PERMISSION_MODE_UNSUPPORTED', detail: 'opencode has no --auto' } as never)
      expect(await setup().create(request({ engine: 'opencode', permissionMode: 'auto' }))).toEqual({ ok: false, error: 'PERMISSION_MODE_UNSUPPORTED', detail: 'opencode has no --auto' })
    })

    it('for a DSH that is missing, a viewer, the wrong engine, or on a tmux too old to pass it on', async () => {
      const { create } = setup()
      expect(await create(request({ dsh: 'blender' }))).toMatchObject({ error: 'INVALID_DSH', detail: 'blender is not installed on this machine' })
      vi.mocked(installedDsh).mockReturnValue(installed({ manifest: { name: 'Viewer', kind: 'viewer' } }) as never)
      expect(await create(request({ dsh: 'viewer' }))).toMatchObject({ error: 'INVALID_DSH', detail: 'viewer is a viewer package, not an agent' })
      vi.mocked(installedDsh).mockReturnValue(installed() as never)
      vi.mocked(incompatibleHarnessEngine).mockReturnValueOnce('Blender runs on codex')
      expect(await create(request({ dsh: 'blender' }))).toMatchObject({ error: 'INVALID_DSH', detail: 'Blender runs on codex' })
      capabilities.mockResolvedValueOnce({ sessionEnv: false })
      expect(await create(request({ dsh: 'blender' }))).toMatchObject({ error: 'TMUX_TOO_OLD_FOR_DSH' })
      vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
    })

    it('for a DSH whose workspace cannot be prepared, or whose launch refuses', async () => {
      vi.mocked(installedDsh).mockReturnValue(installed() as never)
      const { create } = setup()
      vi.mocked(materializeWorkspace).mockRejectedValueOnce(new Error('disk full')).mockRejectedValueOnce('worse')
      expect(await create(request({ dsh: 'blender' }))).toMatchObject({ error: 'DSH_MATERIALIZE_FAILED', detail: 'could not prepare the workspace for blender · disk full' })
      expect(await create(request({ dsh: 'blender' }))).toMatchObject({ detail: 'could not prepare the workspace for blender · worse' })
      launchDsh.mockResolvedValueOnce({ ok: false, error: 'DSH_RUNTIME', detail: 'no runtime', thrown: 'Error: no runtime' })
      expect(await create(request({ dsh: 'blender' }))).toEqual({ ok: false, error: 'DSH_RUNTIME', detail: 'no runtime' })
      launchDsh.mockResolvedValueOnce({ ok: false, error: 'DSH_UNAVAILABLE', detail: 'Store unavailable', unavailable: 'store' })
      expect(await create(request({ dsh: 'blender' }))).toEqual({ ok: false, error: 'DSH_UNAVAILABLE', detail: 'Store unavailable', unavailable: 'store' })
      expect(createAndRegisterPane).not.toHaveBeenCalled()
      vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
    })

    it('for a harness on a grid models cannot build: asked first, so the folder is left as it was', async () => {
      vi.mocked(installedDsh).mockReturnValue(installed() as never)
      const grid = { networkId: 'g1', networkName: 'Home', baseUrl: 'http://g', model: 'm' }
      const { create, deps } = setup()
      buildGridLaunch.mockResolvedValueOnce({ ok: false, error: 'GRID_UNAVAILABLE', detail: 'models is down', unavailable: 'models' })
      expect(await create(request({ dsh: 'blender', grid }))).toEqual({ ok: false, error: 'GRID_UNAVAILABLE', detail: 'models is down', unavailable: 'models' })
      expect(materializeWorkspace).not.toHaveBeenCalled()
      expect(preTrustClaudeProject).not.toHaveBeenCalled()
      expect(deps.prepareInstructions).not.toHaveBeenCalled()
      vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
    })

    it('for a grid it cannot honour: refused by the launch, a tmux too old, or a config it cannot write', async () => {
      const grid = { networkId: 'g1', networkName: 'Home', baseUrl: 'http://g', model: null }
      const { create } = setup()
      buildGridLaunch.mockResolvedValueOnce({ ok: false, error: 'GRID_ENGINE_UNSUPPORTED', detail: 'no grid for amp' })
      expect(await create(request({ grid }))).toEqual({ ok: false, error: 'GRID_ENGINE_UNSUPPORTED', detail: 'no grid for amp' })
      capabilities.mockResolvedValueOnce({ sessionEnv: false })
      expect(await create(request({ grid }))).toMatchObject({ error: 'TMUX_TOO_OLD_FOR_GRID' })
      const configured = { ok: true, override: grid, launch: { env: {}, args: [], webSearch: 'off', configDir: { envVar: 'PI_CONFIG', files: {}, links: [] } } }
      buildGridLaunch.mockResolvedValueOnce(configured as never).mockResolvedValueOnce(configured as never)
      vi.mocked(writeGridConfigDir).mockRejectedValueOnce(new Error('read-only')).mockRejectedValueOnce('worse')
      expect(await create(request({ grid }))).toMatchObject({ error: 'GRID_CONFIG_FAILED', detail: "could not write claude's grid configuration · read-only" })
      expect(await create(request({ grid }))).toMatchObject({ detail: "could not write claude's grid configuration · worse" })
    })



    it('when the pane itself cannot be made', async () => {
      vi.mocked(createAndRegisterPane).mockResolvedValueOnce({ ok: false, error: 'SPAWN_FAILED', detail: 'tmux said no' } as never)
      expect(await setup().create(request())).toEqual({ ok: false, error: 'SPAWN_FAILED', detail: 'tmux said no' })
    })
  })

  describe('a pane that opens', () => {
    it('opens a plain session, announces it and watches it until its engine is up', async () => {
      const { deps, create } = setup()
      const result = await create(request())
      expect(result).toEqual({ ok: true, session: pending })
      expect(deps.prepareInstructions).toHaveBeenCalled()
      expect(deps.announceSession).toHaveBeenCalledWith(pending)
      // Every new agent is looked at for the services that follow agents, a harness or not (core/agentLife.ts).
      expect(deps.attach).toHaveBeenCalledWith(pending)
      expect(deps.watchNewPane).toHaveBeenCalledWith('claude', pending, { runtime: { paneId: '%1' } }, ['claude'], { install: 'recipe' }, undefined)
      const pane = vi.mocked(createAndRegisterPane).mock.calls[0][0]
      expect(pane).toMatchObject({ engine: 'claude', sessionLabel: expect.any(String), grid: null, gridLaunchRecord: null, dsh: null, dshRuntime: null, defaultName: null })
    })

    it('sends the launch\'s Windows variables (no /usr/bin/env there) with the pane env, after its own', async () => {
      vi.mocked(engineLaunchEnv).mockReturnValueOnce({ HARNESS_NATIVE_FIXTURE: 'token' })
      expect(await setup().create(request())).toMatchObject({ ok: true })
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0].env).toMatchObject({ HARNESS_NATIVE_FIXTURE: 'token' })
      expect(engineLaunchEnv).toHaveBeenCalledWith('claude', undefined)
    })

    it('starts a Windows engine in its workspace, its pane becoming the person\'s shell after it', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
      const input = request()
      try {
        Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
        expect(await setup().create(input)).toMatchObject({ ok: true })
      } finally { Object.defineProperty(process, 'platform', platform) }
      // The launch's cleared names too, which the host must keep from its own environment (a grid launch's keys).
      const cleared = (vi.mocked(buildEngineLaunchArgv).mock.calls.at(-1)![1] as { clearEnv?: string[] }).clearEnv ?? []
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0].paneLaunch).toMatchObject({ cwd: input.cwd, afterExit: windowsAfterExit('claude'),
        ...(cleared.length ? { clearInherited: cleared } : {}), env: { GRID_NO_UPDATE_CHECK: '1' } })
      expect(await setup().create(request())).toMatchObject({ ok: true })
      expect(vi.mocked(createAndRegisterPane).mock.calls[1][0].paneLaunch).toEqual({})
    })

    it('starts an approving session in the default harness permission when no mode was named', async () => {
      expect(await setup().create(request({ bypassPermission: true }))).toMatchObject({ ok: true })
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({ bypassPermission: true, permissionMode: null })
    })

    // The argv the pane really gets, so the task's absence from it is the launch's, not this spec's mock's (without
    // the install step, whose recipe this spec stubs).
    const launchedFor = async (over: Record<string, unknown>) => {
      const real = await vi.importActual<typeof import('../../lib/engineLaunch.js')>('../../lib/engineLaunch.js')
      vi.mocked(buildEngineLaunchArgv).mockImplementationOnce((engine, options) => real.buildEngineLaunchArgv(engine, { ...options, installIfMissing: undefined }))
      expect(await setup().create(request(over))).toMatchObject({ ok: true })
      return vi.mocked(createAndRegisterPane).mock.calls.at(-1)![0]
    }

    it('an OpenClaw first task is kept for typing, not launched with', async () => {
      const pane = await launchedFor({ engine: 'openclaw', prompt: 'Fix the parser' })
      expect(pane.firstTask).toBe('Fix the parser')
      expect(pane.argv.join(' ')).not.toContain('Fix the parser')
      expect(pane.argv.join(' ')).not.toContain('--message')
    })

    it('an engine that takes its first prompt in argv keeps none', async () => {
      const pane = await launchedFor({ engine: 'claude', prompt: 'Fix the parser' })
      expect(pane).not.toHaveProperty('firstTask')
      expect(pane.argv.join(' ')).toContain('Fix the parser')
    })

    it('opens a terminal ready at once, with nothing to watch', async () => {
      vi.mocked(createAndRegisterPane).mockResolvedValueOnce({ ok: true, spawned: { runtime: { paneId: '%2' } }, pending: { ...pending, engine: 'terminal' } } as never)
      const { deps, create } = setup()
      expect(await create(request({ engine: 'terminal' }))).toMatchObject({ ok: true, session: { launch: { state: 'ready' } } })
      expect(deps.createBackend!.releaseHold).toHaveBeenCalledWith({ paneId: '%2' })
      expect(deps.watchNewPane).not.toHaveBeenCalled()
      vi.mocked(createAndRegisterPane).mockResolvedValueOnce({ ok: true, spawned: { runtime: { paneId: '%3' } }, pending: { ...pending, engine: 'terminal' } } as never)
      vi.mocked(deps.registry.setLaunch).mockReturnValueOnce(null)
      expect(await create(request({ engine: 'terminal' }))).toMatchObject({ ok: true, session: { engine: 'terminal' } })
    })

    it('leaves a materialized template at the native prompt when foreign work arrives during materialization', async () => {
      const cwd = folder()
      vi.mocked(installedDsh).mockReturnValue(installed() as never)
      const prepareFolderTrust = vi.fn(async () => true)
      const launch = { current: () => true, environment: { HOME: '/fixture/home', CODEX_HOME: '/fixture/selected' },
        permission: async () => 'supported', prepareHooks: async () => true,
      } as unknown as NativeLaunch
      const run = setup({ prepareFolderTrust, native: async () => ({ ok: true, launch }),
        dshLaunch: {
          describe: describeDsh,
          materialize: async () => {
            await Promise.resolve()
            writeFileSync(join(cwd, 'user-repository'), 'arrived during init')
            return { ok: true, created: ['template → workspace'], kept: [], warnings: [] }
          },
          launch: async () => ({ ok: true, launch: { env: {}, args: [] } }),
        },
      })
      expect(await run.create.prepare(request({ cwd, engine: 'codex', dsh: 'blender' }),
        { id: 'fixture-template', label: 'harness-codex-fixture', current: () => true, hold: () => {} }, { local: true }))
        .toMatchObject({ ok: true })
      expect(prepareFolderTrust).not.toHaveBeenCalled()
      expect(preTrustCodexProject).not.toHaveBeenCalled()
      expect(console.warn).toHaveBeenCalledWith('[trust] TEMPLATE_TRUST_UNCONFIRMED')
    })

    it('does not trust, configure or launch a workspace when the Store cannot prepare it', async () => {
      vi.mocked(installedDsh).mockReturnValue(installed() as never)
      const refused = { ok: false as const, error: 'DSH_UNAVAILABLE', detail: 'Store unavailable', unavailable: 'store' as const }
      const materialize = vi.fn(async () => refused)
      const { create } = setup({ dshLaunch: { describe: describeDsh, materialize, launch: launchDsh } })
      expect(await create(request({ dsh: 'blender' }))).toEqual(refused)
      expect(launchDsh).not.toHaveBeenCalled()
      expect(createAndRegisterPane).not.toHaveBeenCalled()
      expect(preTrustClaudeProject).not.toHaveBeenCalled()
      materialize.mockResolvedValueOnce({ ok: false, error: 'DSH_MATERIALIZE_FAILED', detail: 'disk full' } as never)
      expect(await create(request({ dsh: 'blender' }))).toMatchObject({ error: 'DSH_MATERIALIZE_FAILED', detail: 'could not prepare the workspace for blender · disk full' })
      vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
    })

    it('with an older Desktop\'s browser: true, the row says so, which the agent browser takes in; without, it does not', async () => {
      vi.mocked(createAndRegisterPane).mockResolvedValue({ ok: true, spawned: { runtime: { paneId: '%1' } }, pending: { ...pending, browser: true } } as never)
      const { deps, create } = setup()
      await create(request({ browser: true }))
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({ browser: true })
      expect(deps.attach).toHaveBeenCalledWith({ ...pending, browser: true })
      vi.mocked(createAndRegisterPane).mockClear().mockResolvedValue({ ok: true, spawned: { runtime: { paneId: '%1' } }, pending } as never)
      await create(request())
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).not.toHaveProperty('browser')
      expect(deps.attach).toHaveBeenLastCalledWith(pending)
    })

    it('as a DSH: prepares its workspace and launch while leaving materialized-template trust to the engine', async () => {
      vi.mocked(installedDsh).mockReturnValue(installed() as never)
      vi.mocked(materializeWorkspace).mockResolvedValue({ warnings: ['kept AGENTS.md'], created: ['template/scene.blend'], kept: [] } as never)
      vi.mocked(createAndRegisterPane).mockResolvedValue({ ok: true, spawned: { runtime: { paneId: '%1' } }, pending: { ...pending, dsh: 'blender' } } as never)
      const { deps, create } = setup()
      await create(request({ dsh: 'blender' }))
      expect(preTrustClaudeProject).not.toHaveBeenCalled()
      expect(deps.attach).toHaveBeenCalledWith(expect.objectContaining({ dsh: 'blender' }))
      const pane = vi.mocked(createAndRegisterPane).mock.calls[0][0]
      expect(pane).toMatchObject({ dsh: 'blender', dshRuntime: expect.any(String), label: 'Blender', env: expect.objectContaining({ HARNESS_DSH: 'blender' }) })
      await create(request({ dsh: 'blender', engine: 'codex' }))
      expect(preTrustCodexProject).not.toHaveBeenCalled()
      // A profile launch keeps the same native trust question.
      await create(request({ dsh: 'blender', engine: 'codex', codexHome: '/profiles/work' }))
      expect(preTrustCodexProject).not.toHaveBeenCalled()
      // A folder that already held something, or could not be read: trust stays the person's call.
      await create(request({ dsh: 'blender', cwd: folder(['README.md']) }))
      await create(request({ dsh: 'blender', engine: 'pi' }))
      expect(preTrustClaudeProject).not.toHaveBeenCalled()
      vi.mocked(materializeWorkspace).mockResolvedValueOnce({ warnings: [], created: ['AGENTS.md'], kept: [] } as never)
      await create(request({ dsh: 'blender' }))
      expect(preTrustClaudeProject).not.toHaveBeenCalled()
      // A folder it cannot read is not an empty one.
      const unreadable = folder()
      chmodSync(unreadable, 0o000)
      try {
        await create(request({ dsh: 'blender', cwd: unreadable }))
      } finally { chmodSync(unreadable, 0o755) }
      expect(preTrustClaudeProject).not.toHaveBeenCalled()
      vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
      vi.mocked(materializeWorkspace).mockReset().mockResolvedValue({ warnings: [], created: [], kept: [] } as never)
    })

    it('as the Model Manager: grid is set up first, waiting a while for it', async () => {
      const log = vi.mocked(console.log)
      vi.mocked(installedDsh).mockReturnValue(installed({ id: 'autonomous/autonomous-grid' }) as never)
      const ensure = vi.fn(async () => ({}))
      const { create } = setup({ gridSetup: () => ensure as never })
      await create(request({ dsh: 'autonomous-grid' }))
      expect(setUpWithin).toHaveBeenCalled()
      expect(ensure).toHaveBeenCalledWith({ ownGrid: true })
      vi.mocked(setUpWithin).mockResolvedValueOnce('pending' as never)
      await create(request({ dsh: 'autonomous-grid' }))
      expect(log.mock.calls.map(([line]) => String(line)).some((line) => line.includes('grid is still being set up'))).toBe(true)
      // No grid set-up on this daemon: the harness starts anyway.
      expect(await setup({ gridSetup: () => undefined as never }).create(request({ dsh: 'autonomous-grid' }))).toMatchObject({ ok: true })
      vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
    })

    it('pins a DSH\'s permission mode when the engine takes it, and tells the harness about the account it can', async () => {
      vi.mocked(installedDsh).mockReturnValue(installed() as never)
      vi.mocked(dshPinnedPermissionMode).mockReturnValue('auto' as never)
      const { create } = setup({ privateGridName: vi.fn(async () => { throw new Error('signed out') }) })
      await create(request({ dsh: 'blender' }))
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({ permissionMode: 'auto', bypassPermission: true })
      vi.mocked(permissionModeFlags).mockReturnValueOnce(null as never)
      await create(request({ dsh: 'blender' }))
      expect(vi.mocked(createAndRegisterPane).mock.calls[1][0]).toMatchObject({ permissionMode: null, bypassPermission: false })
      vi.mocked(dshPinnedPermissionMode).mockReset().mockReturnValue(null)
      vi.mocked(installedDsh).mockReset().mockReturnValue(undefined)
    })

    it('on a grid: its environment, its argv and its config folder, and the vendor keys it must not see cleared', async () => {
      const grid = { networkId: 'g1', networkName: 'Home', baseUrl: 'http://g', model: 'm1' }
      const { create } = setup()
      await create(request({ grid }))
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({
        grid: { baseUrl: 'http://g', model: 'm1' }, gridLaunchRecord: { override: grid, webSearch: 'unsupported' }, env: expect.objectContaining({ GRID_KEY: 'k' }),
      })
      const withFile = (input: GridLaunchRequest, pointAt?: string) => ({ ok: true, override: input.override, launch: { env: {}, args: [], webSearch: 'off', configDir: { envVar: 'OPENCODE_CONFIG', files: {}, links: [], pointAt } } })
      buildGridLaunch.mockImplementationOnce(async input => withFile(input, 'opencode.json') as never).mockImplementationOnce(async input => withFile(input) as never)
      await create(request({ grid: { ...grid, model: undefined } }))
      await create(request({ grid }))
      expect(vi.mocked(createAndRegisterPane).mock.calls[1][0]).toMatchObject({ grid: { model: null }, env: { OPENCODE_CONFIG: '/config/harness-claude/opencode.json' } })
      expect(vi.mocked(createAndRegisterPane).mock.calls[2][0]).toMatchObject({ env: { OPENCODE_CONFIG: '/config/harness-claude' } })
      expect(vi.mocked(buildEngineLaunchArgv).mock.calls[0][1]).toMatchObject({ clearEnv: ['ANTHROPIC_API_KEY', 'HARNESS_OLD'], extraArgs: ['--grid'] })
    })

    // Windows has no launch script to unset them: the pty host keeps them from what its panes inherit (security: a
    // grid launch saw the person's ANTHROPIC_API_KEY and sent it to the grid's base URL).
    it('on a grid on Windows, names the vendor keys to the pane so the host keeps them from its own environment', async () => {
      const grid = { networkId: 'g1', networkName: 'Home', baseUrl: 'http://g', model: 'm1' }
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
      try {
        Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
        await setup().create(request({ grid }))
      } finally { Object.defineProperty(process, 'platform', platform) }
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0].paneLaunch).toMatchObject({ clearInherited: ['ANTHROPIC_API_KEY', 'HARNESS_OLD'] })
    })

    it('installs the hooks a Codex profile and a new OpenCode need, unless hooks are off', async () => {
      const on = setup()
      await on.create(request({ engine: 'codex', codexHome: '/codex-work' }))
      await on.create(request({ engine: 'opencode' }))
      expect(engineHooks.codex.installIn).toHaveBeenCalledWith(4242, '/codex-work')
      expect(on.deps.installOpencodePlugin).toHaveBeenCalledWith(4242)
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({ env: { CODEX_HOME: '/codex-work' }, codexHome: '/codex-work' })
      const off = setup({ hooksDisabled: true })
      await off.create(request({ engine: 'codex', codexHome: '/codex-work' }))
      await off.create(request({ engine: 'opencode' }))
      expect(engineHooks.codex.installIn).toHaveBeenCalledTimes(1)
      expect(off.deps.installOpencodePlugin).not.toHaveBeenCalled()
    })

    it('refuses an OpenCode create whose plugin installer could not be loaded, before any pane opens', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const t = setup({ installOpencodePlugin: vi.fn(async () => false) })
      expect(await t.create(request({ engine: 'opencode' }))).toEqual({ ok: false, error: 'ENGINE_UNAVAILABLE', detail: 'OpenCode\'s plugin installer could not be loaded' })
      expect(warn).toHaveBeenCalledWith('[agent] create opencode refused · OpenCode\'s plugin installer could not be loaded')
      expect(createAndRegisterPane).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    it('lets concurrent healthy OpenCode creates share the current native hook installation', async () => {
      const completions: Array<(major: number) => void> = []
      let entered!: () => void
      const bothEntered = new Promise<void>(done => { entered = done })
      const probe = () => new Promise<number>(done => {
        completions.push(done)
        if (completions.length === 2) entered()
      })
      vi.mocked(opencodeMajorVersion).mockImplementationOnce(probe).mockImplementationOnce(probe)
      const test = setup({ installOpencodePlugin })
      const first = test.create(request({ engine: 'opencode' }))
      const second = test.create(request({ engine: 'opencode' }))
      await bothEntered
      completions[0]!(2); completions[1]!(2)
      expect((await Promise.all([first, second])).map(result => result.ok)).toEqual([true, true])
      expect(createAndRegisterPane).toHaveBeenCalledTimes(2)
    })

    it('keeps the existing unknown-version launch behavior while setup is unavailable', async () => {
      const t = setup({ opencodeMajor: async () => null })
      expect(await t.create(request({ engine: 'opencode', agent: 'reviewer' }))).toMatchObject({ ok: true })
      expect(namedAgentArgs).toHaveBeenLastCalledWith('opencode', 'reviewer', null)
    })

    it('creates OpenCode from eager facts when optional code cannot load', async () => {
      vi.mocked(loadEngine).mockImplementation(() => new Promise(() => {}))
      const t = setup()
      await t.create(request({ engine: 'opencode', agent: 'reviewer' }))
      expect(namedAgentArgs).toHaveBeenLastCalledWith('opencode', 'reviewer', 2)
      expect(createAndRegisterPane).toHaveBeenCalledOnce()
      expect(t.deps.installOpencodePlugin).toHaveBeenCalledWith(4242)
      expect(loadEngine).not.toHaveBeenCalled()
      buildGridLaunch.mockResolvedValueOnce({ ok: false, error: 'GRID_UNSUPPORTED', detail: 'no' })
      await t.create(request({ engine: 'claude', agent: 'reviewer', grid: { networkName: 'g' } }))
      expect(t.deps.gridLaunchMachine).toHaveBeenCalledWith('claude', undefined)
    })

    // Task #3395: kept on the registry row too, so every relaunch passes the same flags again (lib/launchOverrides.ts);
    // the person's own settings are still never written.
    it('launches with the model and effort it was given, and keeps them on the row for its relaunches', async () => {
      const { create } = setup()
      await create(request({ launchModel: { model: 'opus', effort: 'high' } }))
      const options = vi.mocked(buildEngineLaunchArgv).mock.calls[0][1] as Record<string, unknown>
      expect(options).toMatchObject({ launchModel: { model: 'opus', effort: 'high' } })
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({ launchModel: { model: 'opus', effort: 'high' } })
      await create(request())
      expect(vi.mocked(buildEngineLaunchArgv).mock.calls[1][1]).not.toHaveProperty('launchModel')
      expect(vi.mocked(createAndRegisterPane).mock.calls[1][0]).not.toHaveProperty('launchModel')
    })

    it('opens as a named agent, with a first prompt, and does not install an engine with a path override', async () => {
      vi.mocked(enginePathOverride).mockReturnValueOnce('/opt/claude' as never)
      const { deps, create } = setup()
      await create(request({ agent: 'reviewer', prompt: 'review the diff', name: 'Reviewer' }))
      const options = vi.mocked(buildEngineLaunchArgv).mock.calls[0][1] as Record<string, unknown>
      expect(options).toMatchObject({ extraArgs: ['--agent', 'reviewer'], firstPrompt: 'review the diff', installIfMissing: undefined, cwd: expect.any(String) })
      expect(options.terminalHint).toEqual({ machineName: 'this-mac' })
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({ agent: 'reviewer', defaultName: 'Reviewer' })
      expect(deps.watchNewPane).toHaveBeenCalledWith('claude', pending, expect.anything(), ['claude'], undefined, undefined)
    })

    it('carries the person\'s machine MCP servers before what Harness tells the agent (#1872)', async () => {
      const { writeMachineMcp } = await import('../../lib/machineMcp.js')
      const { rmSync } = await import('node:fs')
      const { env } = await import('../../config/env.js')
      writeMachineMcp({ lamp: { command: 'lamp-mcp', args: [], engines: ['claude'], projects: [] } })
      try {
        const { create } = setup()
        await create(request({ agent: 'reviewer', startedBy: 'agent' }))
        expect((vi.mocked(buildEngineLaunchArgv).mock.calls[0][1] as Record<string, unknown>).extraArgs).toEqual([
          '--agent', 'reviewer', `--mcp-config=${JSON.stringify({ mcpServers: { lamp: { type: 'stdio', command: 'lamp-mcp', args: [] } } })}`, '--settings', '{"attribution":{}}'])
      } finally { rmSync(join(env.ADAPTER_DATA_DIR, 'mcp-servers.json'), { force: true }) }
    })

    it('no launch carries a browser argument: Claude Code, Codex and OpenCode, with browser:true and without', async () => {
      const { create } = setup()
      for (const engine of ['claude', 'codex', 'opencode'] as const) {
        for (const browser of [true, undefined]) {
          vi.mocked(buildEngineLaunchArgv).mockClear()
          await create(request({ engine, ...(browser ? { browser } : {}) }))
          const argv = ((vi.mocked(buildEngineLaunchArgv).mock.calls[0][1] as { extraArgs?: string[] }).extraArgs ?? []).join(' ')
          for (const word of ['browser-mcp', 'mcp_servers.browser', '"browser"']) expect(argv).not.toContain(word)
        }
      }
    })

    it('gives an agent the machine MCP servers, as its owner\'s own session has them', async () => {
      const { writeMachineMcp } = await import('../../lib/machineMcp.js')
      const { rmSync } = await import('node:fs')
      const { env } = await import('../../config/env.js')
      writeMachineMcp({ lamp: { command: 'lamp-mcp', args: [], engines: ['claude'], projects: [] } })
      try {
        const { create } = setup()
        vi.mocked(buildEngineLaunchArgv).mockClear()
        expect(await create(request({ cwd: folder() }))).toMatchObject({ ok: true })
        expect(JSON.stringify(vi.mocked(buildEngineLaunchArgv).mock.calls.at(-1)![1])).toContain('lamp-mcp')
      } finally { rmSync(join(env.ADAPTER_DATA_DIR, 'mcp-servers.json'), { force: true }) }
    })

    it('started by another agent: its pull request line after every other argument, and who started it on the row', async () => {
      const { create } = setup()
      const cwd = folder()
      await create(request({ cwd, agent: 'reviewer', startedBy: 'agent', parentAgentId: 'lead-1' }))
      expect(vi.mocked(agentLaunchArgs)).toHaveBeenCalledWith('claude', 'agent', { cwd, profile: null, environment: undefined })
      expect((vi.mocked(buildEngineLaunchArgv).mock.calls[0][1] as Record<string, unknown>).extraArgs).toEqual(['--agent', 'reviewer', '--settings', '{"attribution":{}}'])
      expect(vi.mocked(createAndRegisterPane).mock.calls[0][0]).toMatchObject({ startedBy: 'agent', parentAgentId: 'lead-1' })
      // The person's: no line, and nothing recorded.
      await create(request())
      expect((vi.mocked(buildEngineLaunchArgv).mock.calls[1][1] as Record<string, unknown>).extraArgs).toBeUndefined()
      expect(vi.mocked(createAndRegisterPane).mock.calls[1][0]).toMatchObject({ startedBy: null, parentAgentId: null })
    })




  })
})
