import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inspectNativeLaunch } from './nativeLaunch.js'
import { captureLaunchExecutable } from './kit/launchExecutable.js'
import { engineHooks } from './hooks.js'
import * as hooks from './nativeHooks.js'

const fixture = vi.hoisted(() => ({ current: true, hooks: true, version: '2.0.0', help: '--auto --permission-mode --approve-for-me', calls: [] as string[], pending: [] as (() => void)[], stalled: false, failed: false, environments: [] as NodeJS.ProcessEnv[], exit: 0, stderr: '' }))
vi.mock('./kit/launchExecutable.js', async original => ({ ...await original<typeof import('./kit/launchExecutable.js')>(), captureLaunchExecutable: vi.fn(async () => ({ state: 'ready',
  executable: { command: '/fixture/engine', identity: 'fixture', current: () => fixture.current },
  environment: { HOME: '/fixture/home', PATH: '/fixture/bin', CODEX_HOME: '/fixture/codex', CLAUDE_CONFIG_DIR: '/fixture/claude', HERMES_HOME: '/fixture/hermes' },
})) }))
vi.mock('node:child_process', () => ({ execFile: (command: string, args: string[], _options: { env: NodeJS.ProcessEnv }, done: (error: Error | null, output: string, errors: string) => void) => {
  fixture.calls.push(command); fixture.environments.push(_options.env)
  const settle = () => done(fixture.failed ? Error('Private probe unavailable') : fixture.exit ? Object.assign(Error('Command failed'), { code: fixture.exit }) : null,
    args[0] === '--version' ? fixture.version : fixture.help, fixture.stderr)
  if (fixture.stalled) fixture.pending.push(settle); else queueMicrotask(settle)
  return { stdin: { end: vi.fn(), destroy: vi.fn() } }
} }))
vi.mock('./hooks.js', () => ({ engineHooks: { claude: { installIn: vi.fn(async () => fixture.hooks) }, codex: { installIn: vi.fn(async () => fixture.hooks) } } }))
vi.mock('./nativeHooks.js', () => Object.fromEntries(['installOpencodePlugin', 'installHermesHooks', 'installCursorHooks',
  'installCommandCodeHooks', 'installDevinHooks', 'installAmpPlugin', 'installKiloPlugin', 'installGrokHooks', 'installAgyHooks', 'installCopilotHooks', 'installPiExtension',
].map(name => [name, vi.fn(async () => fixture.hooks)])))
beforeEach(() => { fixture.current = true; fixture.hooks = true; fixture.version = '2.0.0'; fixture.help = '--auto --permission-mode --approve-for-me'; fixture.calls = []; fixture.pending = []; fixture.stalled = false; fixture.failed = false; fixture.environments = []; fixture.exit = 0; fixture.stderr = '' })
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs() })

it('needs no executable, hooks or probes for a terminal', async () => {
  const prepared = await inspectNativeLaunch('terminal')
  expect(prepared.ok).toBe(true)
  if (!prepared.ok) throw new Error('terminal was held')
  expect(prepared.launch.current()).toBe(true)
  expect(await prepared.launch.prepareHooks(19473, () => true)).toBe(true)
  expect(await prepared.launch.permission({ bypassPermission: true })).toBe('supported')
  expect(captureLaunchExecutable).not.toHaveBeenCalled()
})
it('keeps the reserved token through repeated native preparation', async () => {
  const options = { launchToken: 'fixture-original-rearm-token' }
  const first = inspectNativeLaunch('cursor', {}, options)
  options.launchToken = 'fixture-unrelated-rearm-token'
  expect(await first).toMatchObject({ ok: true, launch: { token: 'fixture-original-rearm-token' } })
  expect(await inspectNativeLaunch('cursor', {}, { launchToken: 'fixture-original-rearm-token' }))
    .toMatchObject({ ok: true, launch: { token: 'fixture-original-rearm-token' } })
  vi.mocked(captureLaunchExecutable).mockClear()
  expect(await inspectNativeLaunch('cursor', {}, { launchToken: 'bad token' })).toMatchObject({ ok: false, error: 'NATIVE_LAUNCH_HELD' })
  expect(captureLaunchExecutable).not.toHaveBeenCalled()
})
it('retains one executable for version, permission and OpenCode hooks', async () => {
  const prepared = await inspectNativeLaunch('opencode', { bypassPermission: true })
  expect(prepared.ok).toBe(true)
  if (!prepared.ok) throw new Error('fixture was held')
  expect(prepared.launch.opencodeMajor).toBe(2)
  expect(await prepared.launch.prepareHooks(19473, () => true)).toBe(true)
  expect(hooks.installOpencodePlugin).toHaveBeenCalledWith(19473, expect.objectContaining({ command: '/fixture/engine', major: 2 }), expect.any(Object))
  expect(fixture.calls).toEqual(['/fixture/engine', '/fixture/engine'])
  fixture.current = false
  expect(prepared.launch.current()).toBe(false)
  expect(await prepared.launch.prepareHooks(19473, () => true)).toBe(false)
  expect(await prepared.launch.permission({ bypassPermission: true })).toBe('unknown')
})
it('holds an unavailable version without caching a permanent unknown', async () => {
  fixture.version = 'unreadable'
  expect(await inspectNativeLaunch('opencode')).toMatchObject({ ok: false, unavailable: 'native' })
  fixture.version = '1.18.0'
  expect(await inspectNativeLaunch('opencode')).toMatchObject({ ok: true, launch: { opencodeMajor: 1 } })
})

it('says why an OpenCode that ran and failed cannot run, and waits for one that is changing', async () => {
  // A Node stack trace: the line naming the failure, not its first or last.
  fixture.exit = 1; fixture.version = ''
  fixture.stderr = 'node:internal/modules/cjs/loader:1228\n  throw err;\n\nError: Cannot find module \'opencode-linux-x64\'\n\nNode.js v22.20.0\n'
  expect(await inspectNativeLaunch('opencode')).toMatchObject({ ok: false, refusal: 'ENGINE_CANNOT_RUN',
    detail: 'OpenCode is installed but cannot run: Error: Cannot find module \'opencode-linux-x64\'' })
  fixture.stderr = 'Segmentation fault\n'
  expect(await inspectNativeLaunch('opencode')).toMatchObject({ detail: 'OpenCode is installed but cannot run: Segmentation fault' })
  fixture.stderr = ''
  expect(await inspectNativeLaunch('opencode')).toMatchObject({ detail: 'OpenCode is installed but cannot run: it exited with status 1' })
  fixture.current = false
  const changing = await inspectNativeLaunch('opencode')
  expect(changing).toMatchObject({ ok: false, unavailable: 'native' })
  expect(changing).not.toHaveProperty('refusal')
})
it('says Claude Code by its name when it cannot run', async () => {
  fixture.exit = 127; fixture.stderr = 'env: node: No such file or directory\n'
  expect(await inspectNativeLaunch('claude', { permissionMode: 'auto' })).toMatchObject({ refusal: 'ENGINE_CANNOT_RUN',
    detail: 'Claude Code is installed but cannot run: env: node: No such file or directory' })
})

it('revokes every hook write when a retained configuration loses authority', async () => {
  const result = await inspectNativeLaunch('codex')
  if (!result.ok) throw Error('fixture held')
  let configCurrent = true
  expect(result.launch.retain?.({ files: [], current: () => configCurrent })).toBe(true)
  configCurrent = false
  expect(await result.launch.prepareHooks(19473, () => true)).toBe(false)
  expect(engineHooks.codex.installIn).not.toHaveBeenCalled()
  configCurrent = true
  vi.mocked(engineHooks.codex.installIn).mockImplementationOnce(async (_port, _home, options) => {
    expect(options!.current!()).toBe(true)
    configCurrent = false
    expect(options!.current!()).toBe(false)
    return true
  })
  expect(await result.launch.prepareHooks(19473, () => true)).toBe(false)
  expect(result.launch.current()).toBe(false)
})
it('keeps installer-only work distinct from a confirmed executable', async () => {
  const recipe = { command: 'fixture install', source: 'https://example.test', executable: { names: ['fixture'] } }
  vi.mocked(captureLaunchExecutable).mockResolvedValueOnce({ state: 'install', recipe, environment: { HOME: '/fixture/home', PATH: '/fixture/bin' } })
  expect(await inspectNativeLaunch('opencode')).toMatchObject({ ok: false, unavailable: 'native', install: recipe })
  expect(hooks.installOpencodePlugin).not.toHaveBeenCalled()
})
it('holds incomplete capture and relative homes', async () => {
  vi.mocked(captureLaunchExecutable).mockResolvedValueOnce({ state: 'held', detail: 'fixture shell unavailable' })
  expect(await inspectNativeLaunch('codex')).toMatchObject({ ok: false, detail: 'fixture shell unavailable' })
  expect(await inspectNativeLaunch('codex', { codexHome: 'relative' })).toMatchObject({ ok: false, unavailable: 'native' })
})
it.each(['claude', 'codex', 'hermes'] as const)('prepares the captured %s profile and pins it after shell startup', async engine => {
  const prepared = await inspectNativeLaunch(engine)
  if (!prepared.ok) throw new Error('fixture was held')
  expect(Object.values(prepared.launch.environment)).toContain(`/fixture/${engine}`)
  expect(await prepared.launch.prepareHooks(19473, () => true)).toBe(true)
  if (engine === 'hermes') expect(hooks.installHermesHooks).toHaveBeenCalledWith(19473, '/fixture/hermes', expect.any(Object))
  else expect(engineHooks[engine].installIn).toHaveBeenCalledWith(19473, `/fixture/${engine}`, expect.any(Object))
  fixture.hooks = false
  expect(await prepared.launch.prepareHooks(19473, () => true)).toBe(false)
  expect(await prepared.launch.prepareHooks(19473, () => false)).toBe(false)
})
it('does not treat a longer flag as support for the selected permission mode', async () => {
  const prepared = await inspectNativeLaunch('opencode')
  if (!prepared.ok) throw new Error('fixture was held')
  fixture.help = '--auto-update'
  expect(await prepared.launch.permission({ bypassPermission: true })).toBe('unsupported')
})

it.each(['claude', 'codex'] as const)('confirms the final %s home before acknowledging hooks or readiness', async engine => {
  const confirmHome = vi.fn<() => void>(() => { throw Error('adoption storage unavailable') })
  const result = await inspectNativeLaunch(engine, {}, { confirmHome })
  if (!result.ok) throw Error('fixture held')
  const variable = engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'
  const selected = `/fixture/${engine}`
  expect(await result.launch.prepareHooks(19473, () => true)).toBe(false)
  expect(confirmHome).toHaveBeenCalledWith(engine, selected)
  expect(result.launch.ready?.()).toBe(false)
  confirmHome.mockImplementation(() => {})
  expect(await result.launch.prepareHooks(19473, () => true)).toBe(true)
  expect(result.launch.ready?.()).toBe(true)
  expect(result.launch.environment[variable]).toBe(selected)
})

it('does not adopt a home when hooks fail or the owner is revoked', async () => {
  const confirmHome = vi.fn()
  const result = await inspectNativeLaunch('codex', {}, { confirmHome })
  if (!result.ok) throw Error('fixture held')
  fixture.hooks = false
  expect(await result.launch.prepareHooks(19473, () => true)).toBe(false)
  expect(confirmHome).not.toHaveBeenCalled()
  fixture.hooks = true
  expect(await result.launch.prepareHooks(19473, () => false)).toBe(false)
  expect(confirmHome).not.toHaveBeenCalled()
  let owner = true
  confirmHome.mockImplementation(() => { owner = false })
  expect(await result.launch.prepareHooks(19473, () => owner)).toBe(false)
  expect(result.launch.ready?.()).toBe(false)
})

it('does not adopt Claude settings as a session store when the daemon names a separate transcript root', async () => {
  vi.mocked(captureLaunchExecutable).mockResolvedValueOnce({ state: 'ready',
    executable: { command: '/fixture/engine', identity: 'fixture', current: () => true },
    environment: { HOME: '/fixture/home', PATH: '/fixture/bin', CLAUDE_PROJECTS_DIR: '/fixture/archive' },
  })
  const confirmHome = vi.fn()
  const result = await inspectNativeLaunch('claude', {}, { confirmHome })
  if (!result.ok) throw Error(result.detail)
  expect(await result.launch.prepareHooks(19473, () => true)).toBe(true)
  expect(engineHooks.claude.installIn).toHaveBeenCalledWith(19473, '/fixture/home/.claude', expect.any(Object))
  expect(confirmHome).not.toHaveBeenCalled()
})

it('bounds actual probe concurrency and recovers after the children settle', async () => {
  fixture.stalled = true
  const running = Array.from({ length: 10 }, () => inspectNativeLaunch('opencode'))
  await vi.waitFor(() => expect(fixture.pending).toHaveLength(8))
  expect(fixture.calls).toHaveLength(8)
  fixture.stalled = false
  for (const settle of fixture.pending.splice(0)) settle()
  const answers = await Promise.all(running)
  expect(answers.filter(answer => answer.ok)).toHaveLength(8)
  expect(answers.filter(answer => !answer.ok)).toHaveLength(2)
  expect(await inspectNativeLaunch('opencode')).toMatchObject({ ok: true })
})

it('answers an expired probe while retaining its slot until the actual child settles', async () => {
  vi.useFakeTimers()
  fixture.stalled = true
  try {
    const running = Array.from({ length: 8 }, () => inspectNativeLaunch('opencode'))
    await vi.waitFor(() => expect(fixture.pending).toHaveLength(8))
    await vi.advanceTimersByTimeAsync(5_251)
    expect((await Promise.all(running)).every(answer => !answer.ok)).toBe(true)
    const overflow = inspectNativeLaunch('opencode')
    await vi.advanceTimersByTimeAsync(0)
    // Inspect admission before awaiting: incorrectly released capacity must fail
    // this assertion, rather than hanging on the unplanned ninth fake child.
    expect(fixture.calls).toHaveLength(8)
    expect(await overflow).toMatchObject({ ok: false, unavailable: 'native' })
    for (const settle of fixture.pending.splice(0)) settle()
    fixture.stalled = false
    expect(await inspectNativeLaunch('opencode')).toMatchObject({ ok: true })
    expect(fixture.calls).toHaveLength(9)
  } finally {
    for (const settle of fixture.pending.splice(0)) settle()
    fixture.stalled = false; vi.useRealTimers()
  }
})
it('retries unknown permission answers and matches only complete flag tokens', async () => {
  const prepared = await inspectNativeLaunch('opencode')
  if (!prepared.ok) throw Error(prepared.detail)
  fixture.failed = true
  expect(await prepared.launch.permission({ bypassPermission: true })).toBe('unknown')
  fixture.failed = false; fixture.help = '--prefix--auto --auto-update'
  expect(await prepared.launch.permission({ bypassPermission: true })).toBe('unsupported')
})

it('holds an empty help reply without caching an unsupported permission flag', async () => {
  const prepared = await inspectNativeLaunch('claude')
  if (!prepared.ok) throw Error(prepared.detail)
  fixture.help = ' \n'
  expect(await prepared.launch.permission({ permissionMode: 'auto' })).toBe('unknown')
  fixture.help = '--permission-mode'
  expect(await prepared.launch.permission({ permissionMode: 'auto' })).toBe('supported')
})

it('does not restore a daemon location that the captured shell unset', async () => {
  vi.stubEnv('OPENCODE_CONFIG_DIR', '/fixture/daemon-config')
  vi.stubEnv('FIXTURE_NATIVE_CREDENTIAL', 'private-value')
  const prepared = await inspectNativeLaunch('opencode', { bypassPermission: true })
  if (!prepared.ok) throw Error(prepared.detail)
  expect(fixture.environments).toHaveLength(2)
  for (const environment of fixture.environments) {
    expect(environment.OPENCODE_CONFIG_DIR).toBeUndefined()
    expect(environment.FIXTURE_NATIVE_CREDENTIAL).toBe('private-value')
    expect(environment.HOME).toBe('/fixture/home')
  }
})

it('publishes locations and proofs together and revokes authority while replacement hooks are pending or fail', async () => {
  const result = await inspectNativeLaunch('codex')
  if (!result.ok) throw Error(result.detail)
  expect(result.launch.ready?.()).toBe(false)
  expect(await result.launch.prepareHooks(19473, () => true)).toBe(true)
  expect(result.launch.ready?.()).toBe(true)
  let finish!: (value: boolean) => void
  vi.mocked(engineHooks.codex.installIn).mockImplementationOnce(() => new Promise(done => { finish = done }))
  const replacing = result.launch.prepareHooks(19473, () => true, { CODEX_HOME: '/fixture/home-b' })
  expect(result.launch.current()).toBe(false)
  expect(result.launch.ready?.()).toBe(false)
  expect(result.launch.environment.CODEX_HOME).toBe('/fixture/codex')
  finish(false)
  expect(await replacing).toBe(false)
  expect(result.launch.current()).toBe(false)
  expect(result.launch.environment.CODEX_HOME).toBe('/fixture/codex')
  expect(await result.launch.prepareHooks(19473, () => true, { CODEX_HOME: '/fixture/home-b' })).toBe(true)
  expect(result.launch.environment.CODEX_HOME).toBe('/fixture/home-b')
  expect(result.launch.ready?.()).toBe(true)
})
it('rejects a permission reply from a prior preparation revision', async () => {
  const result = await inspectNativeLaunch('opencode')
  if (!result.ok) throw Error(result.detail)
  fixture.stalled = true
  const answer = result.launch.permission({ bypassPermission: true })
  expect(fixture.pending).toHaveLength(1)
  expect(await result.launch.prepareHooks(19473, () => true, { OPENCODE_CONFIG_DIR: '/fixture/new-config' })).toBe(true)
  fixture.stalled = false
  fixture.pending.shift()!()
  expect(await answer).toBe('unknown')
  expect(await result.launch.permission({ bypassPermission: true })).toBe('supported')
})

it.each([
  ['claude', 'explicit'], ['claude', 'generated'], ['codex', 'explicit'], ['codex', 'generated'],
] as const)('keeps a %s %s profile scoped to its session across repeated preparations', async (engine, kind) => {
  const confirmHome = vi.fn()
  const home = '/fixture/session-profile', variable = engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'
  const source = kind === 'explicit' ? engine === 'claude' ? { claudeHome: home } : { codexHome: home } : {}
  const result = await inspectNativeLaunch(engine, source, { confirmHome })
  if (!result.ok) throw Error(result.detail)
  expect(await result.launch.prepareHooks(19473, () => true, kind === 'generated' ? { [variable]: home } : {})).toBe(true)
  expect(result.launch.environment[variable]).toBe(home)
  expect(await result.launch.prepareHooks(19473, () => true)).toBe(true)
  expect(confirmHome).not.toHaveBeenCalled()
})
