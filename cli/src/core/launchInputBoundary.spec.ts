import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
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
import { GUEST_LAUNCH_UNAVAILABLE } from './api.js'

const override = { networkId: 'test-grid', networkName: 'Test', baseUrl: 'https://fixture.invalid/relay/v1', apiKey: 'synthetic-key', model: 'test-model' }
const request = (engine: AgentEngine = 'claude'): GridLaunchRequest => ({ engine, override, machine: { hermesSystemManaged: false, grokHome: '/private/fixture/grok' } })
const built = (input: GridLaunchRequest) => answerGridLaunch(input, value => ({ override: value }))
const models = (answer: unknown) => createModelsLink(fakeCore(), async () => answer as Record<string, unknown>, () => true).port
const storeRequest = { dsh: 'test/draw', workspace: '/private/fixture/work', engine: 'claude' as const, key: 'session', account: {} }
const storeReply = (env: Record<string, string> = {}, args: string[] = []) => ({ ok: true as const, launch: { env: { HARNESS_DSH: 'test/draw', ...env }, args } })
const store = (answer: unknown) => createStoreLink(fakeCore(), () => {}, async () => answer as Record<string, unknown>).port
const guestRequest = { email: 'test@fixture.invalid', engine: 'claude', bypassPermission: false, permissionFlags: ['--permission-mode', 'auto'], prompt: '-literal prompt' }
const guestReply = (platform: NodeJS.Platform = process.platform) => {
  const workspace = guestWorkspaceFor(guestRequest.email, platform)
  const account = { user: guestUserFor(guestRequest.email), home: join(workspace, '..'), workspace }
  return { ok: true as const, workspace, ...guestPaneCommand({ ...guestRequest, engine: 'claude', account, platform }),
    ...(platform === 'win32' ? { guestHostUser: account.user } : {}) }
}

afterEach(() => vi.restoreAllMocks())

describe('Models launch authority', () => {
  it.each(['claude', 'codex', 'opencode', 'pi', 'hermes', 'grok', 'copilot'] as const)('preserves the real %s producer across its supported shapes', async engine => {
    for (const web of [false, true]) for (const modern of [false, true]) {
      const input = { ...request(engine), override: { ...override, ...(web ? { mcpUrl: 'https://fixture.invalid/mcp/' } : {}), contextWindow: 131072 },
        machine: { ...request(engine).machine, opencodeMajor: modern ? 2 : 1, hermesSystemManaged: modern } }
      const answer = built(input)
      expect(await models(answer).gridLaunch(input)).toEqual(answer)
      expect(await gridLaunchThrough(() => models(answer))(input)).toEqual(answer)
    }
  })

  it.each([
    ['undeclared environment', (launch: any) => { launch.env.NODE_OPTIONS = '--require=outside.js' }],
    ['another engine environment', (launch: any) => { launch.env.OPENCODE_CONFIG = '/outside' }],
    ['undeclared flag', (launch: any) => { launch.args = ['--inspect'] }],
    ['missing flag operand', (launch: any) => { launch.args = ['--mcp-config'] }],
    ['config pointer for another engine', (launch: any) => { launch.configDir = { envVar: 'NODE_OPTIONS', files: [{ name: 'x', content: 'x' }] } }],
    ['NUL environment', (launch: any) => { launch.env.ANTHROPIC_MODEL = 'before\0after' }],
    ['oversized argv', (launch: any) => { launch.args = Array(1025).fill('x') }],
  ] as const)('refuses %s in both service and inline paths', async (_name, change) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answer = built(request())
    if (!answer.ok) throw Error('fixture launch failed')
    change(answer.launch)
    await expect(models(answer).gridLaunch(request())).rejects.toThrow('the models service is unavailable')
    const held = await gridLaunchThrough(() => ({ gridLaunch: async () => answer }))(request())
    expect(held).toMatchObject({ ok: false, error: 'GRID_UNAVAILABLE', unavailable: 'models' })
  })

  it.each(['../outside', '..\\outside', '/outside', 'C:\\outside', 'config.toml/child'])('refuses a generated filename outside its declaration: %s', async name => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const input = request('grok'), answer = built(input)
    if (!answer.ok) throw Error('fixture launch failed')
    answer.launch.configDir!.files[0]!.name = name
    await expect(models(answer).gridLaunch(input)).rejects.toThrow('the models service is unavailable')
  })

  it('refuses a borrowed directory outside the native home captured in the request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const input = request('grok'), answer = built(input)
    if (!answer.ok) throw Error('fixture launch failed')
    answer.launch.configDir!.links![0]!.target = '/outside/sessions'
    await expect(models(answer).gridLaunch(input)).rejects.toThrow('the models service is unavailable')
  })

  it('refuses a Codex configuration key the contribution does not own', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const input = request('codex'), answer = built(input)
    if (!answer.ok) throw Error('fixture launch failed')
    answer.launch.args.push('-c', 'notify=["outside"]')
    await expect(models(answer).gridLaunch(input)).rejects.toThrow('the models service is unavailable')
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
    expect(await store(answer).dshLaunch(storeRequest)).toEqual(answer)
  })

  it.each([
    ['environment count', () => storeReply(Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`PACKAGE_${i}`, 'x'])))],
    ['argument count', () => storeReply({}, Array(1025).fill('x'))],
    ['string bytes', () => storeReply({ PACKAGE_VALUE: 'x'.repeat(65537) })],
    ['aggregate bytes', () => storeReply({}, Array(17).fill('x'.repeat(65536)))],
    ['NUL', () => storeReply({ PACKAGE_VALUE: 'x\0y' })],
    ['undeclared Harness identity', () => storeReply({ HARNESS_AGENT_ID: 'some-other-session' })],
  ] as const)('refuses %s through service and inline callers', async (_name, make) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answer = make()
    await expect(store(answer).dshLaunch(storeRequest)).rejects.toThrow('the store service is unavailable')
    const through = dshThrough({ store: () => ({ dshLaunch: async () => answer, dshMaterialize: async () => ({ ok: true, created: [], kept: [], warnings: [] }) }), nameOf: () => 'Drawing', account: () => ({}) })
    expect(await through.launch(storeRequest)).toMatchObject({ ok: false, error: 'DSH_UNAVAILABLE' })
  })

  it('accepts the count and individual string boundaries, then detaches the reply', async () => {
    const env = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`PACKAGE_${i}`, 'x']))
    const answer = storeReply(env, Array(1024).fill('x'))
    answer.launch.env.PACKAGE_0 = 'x'.repeat(65536)
    const expected = structuredClone(answer)
    const admitted = await store(answer).dshLaunch(storeRequest)
    answer.launch.env.PACKAGE_0 = 'changed'; answer.launch.args[0] = 'changed'
    expect(admitted).toEqual(expected)
  })
})

describe('Guest launch contribution authority', () => {
  it('keeps the exact requested guest, permission and literal prompt on the real producer', async () => {
    const answer = guestReply()
    expect(await createSharedMachinesLink(async () => answer).guestLaunch(guestRequest)).toEqual(answer)
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
    expect(await createSharedMachinesLink(async () => answer).guestLaunch(guestRequest)).toEqual(GUEST_LAUNCH_UNAVAILABLE)
  })
})
