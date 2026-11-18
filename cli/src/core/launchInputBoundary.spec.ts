import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { gridLaunchRequestIn } from '../services/modelsProcess.js'
import { createModelsLink } from './modelsLink.js'
import { createStoreLink } from './storeLink.js'
import { createSharedMachinesLink } from './sharedMachinesLink.js'
import { gridLaunchThrough } from './agents/launch.js'
import { dshThrough } from './agents/dshThrough.js'
import { fakeCore } from '../testing/fakeCore.js'
import { answerGridLaunch } from '../lib/gridLaunch.js'
import { guestPaneCommand } from '../lib/guestPaneCommand.js'
import { guestUserFor, guestWorkspaceFor } from '../lib/guestAccounts.js'
import type { GridLaunchRequest } from '../lib/gridLaunchWire.js'
import type { AgentEngine } from '../engines/types.js'
import { prepareHarnessLaunch } from '../dsh/runtime.js'
import type { InstalledDsh } from '../dsh/installed.js'
import { PROCESS_ENGINES } from '../engines/types.js'
import { createGuestCreate } from './agents/guestCreate.js'
import { GUEST_LAUNCH_UNAVAILABLE, type GuestLaunch, type GuestLaunchInput } from './api.js'

const override = { networkId: 'test-grid', networkName: 'Test', baseUrl: 'https://fixture.invalid/relay/v1', apiKey: 'synthetic-key', model: 'test-model' }
const request = (engine: AgentEngine = 'claude'): GridLaunchRequest & { override: typeof override } => ({ engine, override, machine: { hermesSystemManaged: false, grokHome: '/private/fixture/grok' } })
const built = (input: GridLaunchRequest) => {
  if (!('apiKey' in input.override)) throw Error('This wire fixture expects a freshly supplied override')
  return answerGridLaunch({ ...input, override: input.override }, value => ({ override: value }))
}
const modelsPort = (answer: unknown) => createModelsLink(fakeCore(), async () => answer as Record<string, unknown>, () => true).port
const models = (answer: unknown) => ({ gridLaunch: gridLaunchThrough(() => modelsPort(answer)) })
const storeRequest = { dsh: 'test/draw', workspace: '/private/fixture/work', engine: 'claude' as const, key: 'session', account: {} }
const storeReply = (env: Record<string, string> = {}, args: string[] = []) => ({ ok: true as const, launch: { env: { HARNESS_DSH: 'test/draw', ...env } as Record<string, string>, args } })
const store = (answer: unknown) => createStoreLink(fakeCore(), async () => answer as Record<string, unknown>).port
const storeLaunch = (answer: unknown) => dshThrough({ store: () => store(answer), nameOf: () => undefined, account: () => ({}) }).launch(storeRequest)
const guestRequest = { email: 'test@fixture.invalid', engine: 'claude', bypassPermission: false, permissionFlags: ['--permission-mode', 'auto'], prompt: '-literal prompt' }
const guestReply = (platform: NodeJS.Platform = process.platform) => {
  const workspace = guestWorkspaceFor(guestRequest.email, platform)
  const account = { user: guestUserFor(guestRequest.email), home: join(workspace, '..'), workspace }
  return { ok: true as const, workspace, ...guestPaneCommand({ ...guestRequest, engine: 'claude', account, platform }),
    ...(platform === 'win32' ? { guestHostUser: account.user } : {}) }
}

async function guestCreate(answer: unknown, input: GuestLaunchInput = guestRequest, mode: 'inline' | 'linked' = 'linked') {
  // A real caller reaches this backend only after admission. The fake fails before opening any pane.
  const open = vi.fn(async (_input: unknown) => ({ state: 'failed' as const, dispatch: 'not_started' as const, reason: 'fixture stopped before pane open' }))
  const backend = { create: open, kill: vi.fn() }
  const tmuxBackend = vi.fn(() => backend), guestBackend = vi.fn(() => backend as never)
  const ensureEngine = vi.fn(async () => ({ ok: true as const })), register = vi.fn()
  const launch = mode === 'inline' ? async () => answer
    : createSharedMachinesLink(async () => answer as Record<string, unknown>).guestLaunch
  const create = createGuestCreate({ launch, tmuxBackend, guestBackend, ensureEngine,
    resolveEngine: (_engine, argv) => [...argv],
    registry: { openPendingAgent: register }, announceSession: vi.fn(), watchNewPane: vi.fn() })
  const result = await create({ engine: input.engine, permissionMode: 'auto', prompt: input.prompt, cwd: input.cwd }, input.email)
  return { result, open, tmuxBackend, guestBackend, ensureEngine, register }
}

async function guestAdmitted(answer: Extract<GuestLaunch, { ok: true }>, input: GuestLaunchInput = guestRequest) {
  for (const mode of ['inline', 'linked'] as const) {
    const run = await guestCreate(answer, input, mode)
    expect(run.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: answer.argv, env: answer.env, cwd: answer.workspace }))
    if (answer.guestHostUser) expect(run.guestBackend).toHaveBeenCalledExactlyOnceWith(answer.guestHostUser)
    else expect(run.guestBackend).not.toHaveBeenCalled()
  }
}

async function guestRefused(answer: unknown, input: GuestLaunchInput = guestRequest) {
  for (const mode of ['inline', 'linked'] as const) {
    const run = await guestCreate(answer, input, mode)
    expect(run.result).toEqual(GUEST_LAUNCH_UNAVAILABLE)
    for (const effect of [run.open, run.tmuxBackend, run.guestBackend, run.ensureEngine, run.register]) expect(effect).not.toHaveBeenCalled()
  }
}

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('Models launch authority', () => {
  it.each(['claude', 'codex', 'opencode', 'pi', 'hermes', 'grok', 'copilot'] as const)('preserves the real %s producer across its supported shapes', async engine => {
    for (const web of [false, true]) for (const modern of [false, true]) {
      const input = { ...request(engine), override: { ...override, ...(web ? { mcpUrl: 'https://fixture.invalid/mcp/' } : {}), contextWindow: 131072 },
        machine: { ...request(engine).machine, opencodeMajor: modern ? 2 : 1, hermesSystemManaged: modern } }
      const answer = built(input)
      expect(await models(answer).gridLaunch(input)).toEqual(answer)
    }
  })

  it('preserves the captured Grok home across the actual Models request and reply wire', async () => {
    const input = request('grok')
    const port = createModelsLink(fakeCore(), async (_type, payload) => {
      const decoded = gridLaunchRequestIn(payload)
      if (!decoded) throw Error('fixture request failed')
      return { ...built(decoded) }
    }, () => true).port
    expect(await gridLaunchThrough(() => port)(input)).toEqual(built(input))
  })

  it.each([null, 7, 'x\0y', 'x'.repeat(65537)])('refuses a malformed native home in the service request parser', grokHome => {
    expect(gridLaunchRequestIn({ ...request('grok'), machine: { hermesSystemManaged: false, grokHome } })).toBeNull()
  })

  it('bounds the borrowed target itself at and just past the text limit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const atLimit = { ...request('grok'), machine: { hermesSystemManaged: false, grokHome: '/' + 'x'.repeat(65526) } }
    expect(await models(built(atLimit)).gridLaunch(atLimit)).toEqual(built(atLimit))
    const tooLong = { ...atLimit, machine: { ...atLimit.machine, grokHome: atLimit.machine.grokHome + 'x' } }
    await expect(models(built(tooLong)).gridLaunch(tooLong)).resolves.toMatchObject({ ok: false, error: 'GRID_UNAVAILABLE', unavailable: 'models' })
  })

  it.each([
    ['undeclared environment', (launch: any) => { launch.env.NODE_OPTIONS = '--require=outside.js' }],
    ['another engine environment', (launch: any) => { launch.env.OPENCODE_CONFIG = '/outside' }],
    ['undeclared flag', (launch: any) => { launch.args = ['--inspect', 'value'] }],
    ['missing flag operand', (launch: any) => { launch.args = ['--mcp-config'] }],
    ['config pointer for another engine', (launch: any) => { launch.configDir = { envVar: 'NODE_OPTIONS', files: [{ name: 'x', content: 'x' }] } }],
    ['NUL environment', (launch: any) => { launch.env.ANTHROPIC_MODEL = 'before\0after' }],
    ['oversized argv', (launch: any) => { launch.args = Array(1025).fill('x') }],
  ] as const)('refuses %s in both service and inline paths', async (_name, change) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answer = built(request())
    if (!answer.ok) throw Error('fixture launch failed')
    change(answer.launch)
    await expect(models(answer).gridLaunch(request())).resolves.toMatchObject({ ok: false, error: 'GRID_UNAVAILABLE', unavailable: 'models' })
    const held = await gridLaunchThrough(() => ({ gridLaunch: async () => answer }))(request())
    expect(held).toMatchObject({ ok: false, error: 'GRID_UNAVAILABLE', unavailable: 'models' })
  })

  it.each(['../outside', '..\\outside', '/outside', 'C:\\outside', 'config.toml/child'])('refuses a generated filename outside its declaration: %s', async name => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const input = request('grok'), answer = built(input)
    if (!answer.ok) throw Error('fixture launch failed')
    answer.launch.configDir!.files[0]!.name = name
    await expect(models(answer).gridLaunch(input)).resolves.toMatchObject({ ok: false, error: 'GRID_UNAVAILABLE', unavailable: 'models' })
  })

  it('refuses a borrowed directory outside the native home captured in the request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const input = request('grok'), answer = built(input)
    if (!answer.ok) throw Error('fixture launch failed')
    answer.launch.configDir!.links![0]!.target = '/outside/sessions'
    await expect(models(answer).gridLaunch(input)).resolves.toMatchObject({ ok: false, error: 'GRID_UNAVAILABLE', unavailable: 'models' })
  })

  it('refuses a Codex configuration key the contribution does not own', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const input = request('codex'), answer = built(input)
    if (!answer.ok) throw Error('fixture launch failed')
    answer.launch.args.push('-c', 'notify=["outside"]')
    await expect(models(answer).gridLaunch(input)).resolves.toMatchObject({ ok: false, error: 'GRID_UNAVAILABLE', unavailable: 'models' })
  })

  it('retains request identity while allowing the saved API producer to refresh its endpoint and key', async () => {
    const input = { ...request('codex'), override: { ...override, networkId: 'api:saved' }, refresh: true }
    const refreshed = answerGridLaunch(input, value => ({ override: { ...value, networkName: 'Changed name', baseUrl: 'https://updated.invalid/v1', apiKey: 'synthetic-new' }, apiBase: 'https://updated.invalid/v1' }))
    expect(await models(refreshed).gridLaunch(input)).toEqual(refreshed)
    if (!refreshed.ok) throw Error('fixture launch failed')
    refreshed.override.networkId = 'api:another'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(models(refreshed).gridLaunch(input)).resolves.toMatchObject({ ok: false, error: 'API_UNAVAILABLE', unavailable: 'models' })
  })

  it('keeps the pre-await native directory when an inline producer changes the request object', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const input = request('grok')
    const answer = await gridLaunchThrough(() => ({ gridLaunch: async original => {
      original.machine.grokHome = '/outside'
      return built(original)
    } }))(input)
    expect(answer).toMatchObject({ ok: false, error: 'GRID_UNAVAILABLE' })
  })

  it('bounds generated contents, total reply text, and request-specific config pointers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const input = request('opencode'), answer = built(input)
    if (!answer.ok) throw Error('fixture launch failed')
    for (const change of [
      (copy: typeof answer) => { copy.launch.configDir!.envVar = 'NODE_OPTIONS' },
      (copy: typeof answer) => { copy.launch.configDir!.links = [] },
      (copy: typeof answer) => { copy.apiBase = 'x'.repeat(65537) },
      (copy: typeof answer) => { copy.launch.args = Array.from({ length: 15 }, () => ['-m', 'x'.repeat(65536)]).flat(); copy.launch.configDir!.files[0]!.content = 'x'.repeat(65536) },
    ]) {
      const copy = structuredClone(answer); change(copy)
      await expect(models(copy).gridLaunch(input)).resolves.toMatchObject({ ok: false, error: 'GRID_UNAVAILABLE', unavailable: 'models' })
    }
    const largeInput = { ...request(), override: { ...override, apiKey: 'x'.repeat(65536) } }
    const large = built(largeInput)
    if (!large.ok) throw Error('fixture launch failed')
    large.launch.env = {}
    large.launch.args = [...Array.from({ length: 15 }, () => ['--append-system-prompt', 'x'.repeat(65536)]).flat(), '--append-system-prompt', 'x'.repeat(50000)]
    await expect(models(large).gridLaunch(largeInput)).resolves.toMatchObject({ ok: false, error: 'GRID_UNAVAILABLE', unavailable: 'models' })
    const empty = await gridLaunchThrough(() => ({ gridLaunch: async () => null as never }))(request())
    expect(empty).toMatchObject({ ok: false, error: 'GRID_UNAVAILABLE' })
    const defaultHome = { ...request('grok'), machine: { hermesSystemManaged: false } }
    const defaultAnswer = built(defaultHome)
    expect(await models(defaultAnswer).gridLaunch(defaultHome)).toEqual(defaultAnswer)
  })

  it('detaches admitted environment, args and generated files from a later inline mutation', async () => {
    const input = request('opencode'), answer = built(input)
    if (!answer.ok) throw Error('fixture launch failed')
    const expected = structuredClone(answer)
    const admitted = await gridLaunchThrough(() => ({ gridLaunch: async () => answer }))(input)
    answer.launch.env.GRID_API_KEY = 'changed'; answer.launch.args.push('--changed'); answer.launch.configDir!.files[0]!.content = 'changed'
    expect(admitted).toEqual(expected)
  })
})

describe('Store contribution bounds preserve the installed package contract', () => {
  it('keeps manifest-defined variables and arguments, including the catalog’s Codex hook and Python path use', async () => {
    const answer = storeReply({ PYTHONPATH: '/package/toolchain', PACKAGE_CUSTOM: 'value' }, ['-c', 'hooks.Stop=[{hooks=[{type="command",command="tool"}]}]'])
    expect(await storeLaunch(answer)).toEqual(answer)
  })

  it('keeps every real Store adapter, canonical workspace and former package snapshot identity', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'launch-boundary-'))); roots.push(root)
    const workspace = join(root, 'work'), alias = join(root, 'alias'), directory = join(root, 'package'), updated = join(root, 'updated-package')
    mkdirSync(workspace); mkdirSync(directory); mkdirSync(updated); symlinkSync(workspace, alias, 'junction')
    const pkg: InstalledDsh = { id: 'test/old', dir: directory, realDir: directory, source: directory, ref: null, commit: null, linked: true, installedAt: 1,
      manifest: { spec: 1, id: 'test/old', name: 'Drawing', engine: 'codex', agent: { env: { PYTHONPATH: '${dsh}/python', PACKAGE_CUSTOM: 'x' },
        args: ['-c', 'approval_policy=never', '-c', 'sandbox_mode=danger-full-access', '-c', 'hooks.Stop=[{hooks=[{type="command",command="tool"}]}]'] } } }
    for (const engine of PROCESS_ENGINES) {
      const input = { ...storeRequest, dsh: pkg.id, workspace: alias, engine, key: engine, account: { privateGrid: 'synthetic-private-grid' } }
      const answer = { ok: true as const, launch: prepareHarnessLaunch(pkg, alias, engine, input.key, input.account) }
      const through = dshThrough({ store: () => store(answer), nameOf: () => 'Drawing', account: () => ({}) })
      expect(await through.launch(input, { ids: [pkg.id], workspace })).toEqual(answer)
      if (engine === 'claude') {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        for (const field of ['HARNESS_DSH', 'HARNESS_WORKSPACE', 'HARNESS_CONTEXT_FILE', 'HARNESS_SKILLS_DIR', 'HARNESS_PRIVATE_GRID']) {
          const forged = structuredClone(answer); forged.launch.env[field] = 'another-session'
          const guarded = dshThrough({ store: () => store(forged), nameOf: () => 'Drawing', account: () => input.account })
          expect(await guarded.launch(input, { ids: [pkg.id], workspace }), field).toMatchObject({ ok: false, error: 'DSH_UNAVAILABLE' })
        }
      }
      const renamed = { ...pkg, id: 'test/new', dir: updated, realDir: updated, manifest: { ...pkg.manifest, id: 'test/new', formerly: [pkg.id] } }
      const resumed = { ok: true as const, launch: prepareHarnessLaunch(renamed, alias, engine, input.key, input.account) }
      expect(resumed.launch.env.HARNESS_DSH).toBe(pkg.id)
      expect(resumed.launch.env.HARNESS_DSH_DIR).toBe(directory)
      const resumedThrough = dshThrough({ store: () => store(resumed), nameOf: () => 'Drawing', account: () => input.account })
      expect(await resumedThrough.launch({ ...input, dsh: renamed.id }, { ids: [renamed.id, pkg.id], workspace })).toEqual(resumed)
      expect(await resumedThrough.relaunch(renamed.id, alias, engine, input.key)).toEqual(resumed)
      const forkKey = `fork-${engine}`
      const forked = { ok: true as const, launch: prepareHarnessLaunch(renamed, alias, engine, forkKey, input.account, input.key) }
      const forkThrough = dshThrough({ store: () => store(forked), nameOf: () => 'Drawing', account: () => input.account })
      expect(await forkThrough.launch({ ...input, key: forkKey, dsh: pkg.id, forkOf: { agentId: 'source', dshRuntime: input.key } }, { workspace })).toEqual(forked)
      expect(forked.launch.env.HARNESS_DSH_DIR).toBe(directory)
    }
  })

  it.each([
    ['environment count', () => storeReply(Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`PACKAGE_${i}`, 'x'])))],
    ['argument count', () => storeReply({}, Array(1025).fill('x'))],
    ['string bytes', () => storeReply({ PACKAGE_VALUE: 'x'.repeat(65537) })],
    ['aggregate bytes', () => storeReply({}, Array(17).fill('x'.repeat(65536)))],
    ['environment bytes', () => storeReply(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`PACKAGE_${i}`, 'x'.repeat(65536)])))],
    ['inherited environment', () => { const answer = storeReply(); Object.setPrototypeOf(answer.launch.env, { INHERITED: 'x' }); return answer }],
    ['NUL', () => storeReply({ PACKAGE_VALUE: 'x\0y' })],
    ['undeclared Harness identity', () => storeReply({ HARNESS_AGENT_ID: 'some-other-session' })],
  ] as const)('refuses %s through service and inline callers', async (_name, make) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answer = make()
    await expect(storeLaunch(answer)).resolves.toMatchObject({ ok: false, error: 'DSH_UNAVAILABLE' })
    const through = dshThrough({ store: () => ({ stop: () => {}, dshContext: async () => ({ ok: true, account: {} }), dshDescribe: async () => ({ ok: false, error: 'unused', detail: '' }), dshLaunch: async () => answer, dshMaterialize: async () => ({ ok: true, created: [], kept: [], warnings: [] }) }), nameOf: () => 'Drawing', account: () => ({}) })
    expect(await through.launch(storeRequest)).toMatchObject({ ok: false, error: 'DSH_UNAVAILABLE' })
  })

  it('accepts exactly 1 MiB of contribution text and refuses one byte more', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const remaining = 1024 * 1024 - Buffer.byteLength('HARNESS_DSHtest/draw')
    const answer = storeReply({}, [...Array(15).fill('x'.repeat(65536)), 'x'.repeat(remaining - 15 * 65536)])
    expect(await storeLaunch(answer)).toEqual(answer)
    answer.launch.args[15] += 'x'
    await expect(storeLaunch(answer)).resolves.toMatchObject({ ok: false, error: 'DSH_UNAVAILABLE' })
  })

  it('accepts the count and individual string boundaries, then detaches the reply', async () => {
    const env = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`PACKAGE_${i}`, 'x']))
    const answer = storeReply(env, Array(1024).fill('x'))
    answer.launch.env.PACKAGE_0 = 'x'.repeat(65536)
    const expected = structuredClone(answer)
    const admitted = await storeLaunch(answer)
    answer.launch.env.PACKAGE_0 = 'changed'; answer.launch.args[0] = 'changed'
    expect(admitted).toEqual(expected)
  })
})

describe('Guest launch contribution authority', () => {
  it('keeps the exact requested guest, permission and literal prompt on the real producer', async () => {
    const answer = guestReply()
    await guestAdmitted(answer)
  })

  it('keeps the Windows guest host and the default when a requested folder is not shared', async () => {
    const answer = guestReply('win32')
    await guestAdmitted(answer)
    const fallback = guestReply()
    await guestAdmitted(fallback, { ...guestRequest, cwd: '/not-shared' })
  })

  it('accepts only the Windows request folder on the derived guest host, with no inherited environment', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const input = { ...guestRequest, cwd: 'C:\\shared\\project' }
    const answer = { ...guestReply('win32'), workspace: input.cwd }
    await guestAdmitted(answer, input)
    await guestRefused({ ...answer, env: { NODE_OPTIONS: 'outside' } }, input)
    await guestRefused(null, input)
    const posix = guestReply('darwin')
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await guestRefused(posix, input)
  })

  it('refuses an inline substituted command before selecting a backend or installing an engine', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answer = { ...guestReply(), argv: ['/bin/sh', '-c', 'outside'] }
    const tmuxBackend = vi.fn(), guestBackend = vi.fn(), ensureEngine = vi.fn(), register = vi.fn()
    const create = createGuestCreate({ launch: async () => answer, tmuxBackend, guestBackend, ensureEngine,
      registry: { openPendingAgent: register }, announceSession: vi.fn(), watchNewPane: vi.fn() })
    expect(await create({ engine: 'claude' }, guestRequest.email)).toMatchObject({ ok: false, error: 'GUEST_UNAVAILABLE' })
    for (const effect of [tmuxBackend, guestBackend, ensureEngine, register]) expect(effect).not.toHaveBeenCalled()
  })

  it.each([
    ['shell', (answer: any) => { answer.argv = ['/bin/sh', '-c', 'unrelated command'] }],
    ['owner environment', (answer: any) => { answer.env.NODE_OPTIONS = '--require=outside.js' }],
    ['prompt', (answer: any) => { answer.argv[answer.argv.length - 1] = 'a different prompt' }],
    ['guest identity', (answer: any) => { answer.argv = answer.argv.map((arg: string) => arg === guestUserFor(guestRequest.email) ? 'hg_ffffffffffff' : arg); answer.guestHostUser = 'hg_ffffffffffff' }],
    ['unrequested directory', (answer: any) => { answer.workspace = '/owner/private' }],
    ['oversized environment', (answer: any) => { answer.env.LANG = 'x'.repeat(65537) }],
  ] as const)('refuses a changed %s before returning a launch', async (_name, change) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answer = guestReply(); change(answer)
    await guestRefused(answer)
  })
})
