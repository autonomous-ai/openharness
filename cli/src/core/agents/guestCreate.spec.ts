import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GuestLaunch } from '../api.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { TmuxRuntimeRef } from '../../lib/terminalTypes.js'
import { createGuestCreate, type GuestCreateDeps } from './guestCreate.js'
import { WindowsBatchLaunchRefused } from '../../lib/windows/launch.js'

// A guest's New Harness: the launch shared machines builds, opened as a pane and recorded as the guest's
// (docs/plans/2026-10-19-guest-machine-sharing-plan.md). The pane is a fake tmux's; nothing runs.
const runtime = { backend: 'tmux', paneId: '%7' } satisfies TmuxRuntimeRef
const launched: GuestLaunch = { ok: true, workspace: '/Users/Shared/HarnessGuests/hg_0123456789ab/work', argv: ['/bin/sh', '-c', 'boot'], env: { TERM: 'xterm-256color' } }

function setup(over: Partial<GuestCreateDeps> & { answer?: GuestLaunch; spawn?: 'ok' | 'fail'; register?: boolean } = {}) {
  const session = { agentId: 'agent-1', sessionId: '', engine: 'claude', guest: 'kim@acme.io' } as RegisteredSession
  const tmux = {
    create: vi.fn(async () => over.spawn === 'fail' ? { state: 'failed' as const, reason: 'no server' } : { state: 'succeeded' as const, runtime }),
    kill: vi.fn(async () => {}),
  }
  const deps: GuestCreateDeps = {
    launch: vi.fn(async () => over.answer ?? launched),
    tmuxBackend: () => tmux as never,
    ensureEngine: vi.fn(async () => ({ ok: true as const })),
    resolveEngine: vi.fn((_engine: string, argv: readonly string[]) => [...argv]),
    registry: { openPendingAgent: vi.fn(() => over.register === false ? null : session) },
    announceSession: vi.fn(),
    watchNewPane: vi.fn(async () => {}) as never,
    ...over,
  }
  return { create: createGuestCreate(deps), deps, tmux, session }
}

describe('a guest\'s New Harness', () => {
  afterEach(() => vi.restoreAllMocks())
  const said = () => vi.spyOn(console, 'log').mockImplementation(() => {})
  const warned = () => vi.spyOn(console, 'warn').mockImplementation(() => {})

  it('opens the launch shared machines built, in the guest\'s workspace, and records it as the guest\'s', async () => {
    const log = said()
    const { create, deps, tmux, session } = setup()
    expect(await create({ engine: 'claude', name: '  Notes  ', cwd: '/Users/owner/secret' }, 'kim@acme.io')).toEqual({ ok: true, session })
    // The folder asked for goes to shared machines, which starts it there only when the owner shares it: here, not.
    // Auto-approve, a harness's default: the engine's own auto mode, never Skip all checks.
    expect(deps.launch).toHaveBeenCalledWith({ email: 'kim@acme.io', engine: 'claude', bypassPermission: true,
      permissionFlags: ['--permission-mode', 'auto'], cwd: '/Users/owner/secret' })
    expect(tmux.create).toHaveBeenCalledWith(expect.objectContaining({ cwd: launched.ok && launched.workspace, command: ['/bin/sh', '-c', 'boot'], env: { TERM: 'xterm-256color' } }))
    expect(deps.registry.openPendingAgent).toHaveBeenCalledWith(expect.objectContaining({ engine: 'claude', cwd: launched.ok && launched.workspace,
      guest: 'kim@acme.io', defaultName: 'Notes', bypassPermission: true, permissionMode: 'auto' }))
    expect(deps.announceSession).toHaveBeenCalledWith(session)
    // Watched as any pane, with no install: the pane installs a missing engine for the guest itself.
    expect(deps.watchNewPane).toHaveBeenCalledWith('claude', session, expect.objectContaining({ runtime }), ['/bin/sh', '-c', 'boot'], undefined)
    expect(log).toHaveBeenCalledWith('[agent] create guest pane open · claude · agent agent-1')
  })

  it('asks before each command when the guest says so, by mode or by the older flag', async () => {
    said()
    const { create, deps } = setup()
    await create({ engine: 'codex', permissionMode: 'ask' }, 'kim@acme.io')
    await create({ engine: 'codex', permissionMode: 'full' }, 'kim@acme.io')
    await create({ engine: 'codex', bypassPermission: false, name: '   ' }, 'kim@acme.io')
    expect(vi.mocked(deps.launch).mock.calls.map(([input]) => [input.bypassPermission, input.permissionFlags])).toEqual([
      [false, []], [true, ['--dangerously-bypass-approvals-and-sandbox']], [false, []]])
    // A mode the engine does not have is refused, never approximated.
    expect(await create({ engine: 'codex', permissionMode: 'plan' }, 'kim@acme.io'))
      .toEqual({ ok: false, error: 'INVALID_PERMISSION_MODE', detail: 'codex has no permission mode "plan"' })
    expect(deps.registry.openPendingAgent).toHaveBeenLastCalledWith(expect.objectContaining({ defaultName: null }))
  })

  it('refuses what would run the owner\'s way, before anything starts, saying why', async () => {
    const { create, deps } = setup()
    for (const [key, value] of [['dsh', 'acme/blender'], ['resumeSessionId', 'abc-123'], ['agent', 'reviewer']] as const) {
      expect(await create({ engine: 'claude', [key]: value }, 'kim@acme.io'), key).toEqual({ ok: false, error: 'GUEST_UNSUPPORTED', detail: expect.any(String) })
    }
    // An OpenClaw `--local` folder is the owner's to give: dropped, the run would go on the shared Gateway unsaid.
    expect(await create({ engine: 'openclaw', openclawLocal: '/run/skill-1' }, 'kim@acme.io'))
      .toEqual({ ok: false, error: 'GUEST_UNSUPPORTED', detail: 'On a computer shared with you, --local is not available.' })
    expect(deps.launch).not.toHaveBeenCalled()
    // Empty is absent.
    said()
    expect((await create({ engine: 'claude', dsh: null, agent: '' }, 'kim@acme.io')).ok).toBe(true)
  })

  it('makes a launch that names the guest\'s own host there, never the owner\'s pane', async () => {
    said()
    // Windows: the guest's panes come from its own host, whose processes already run as that account.
    const windows: GuestLaunch = { ok: true, workspace: 'C:\\Users\\hg_0123456789ab\\work', argv: ['claude'], env: {},
      guestHostUser: 'hg_0123456789ab' }
    const runtime = { backend: 'ptyhost', instance: 'p3', paneId: '%1' } as const
    const host = { create: vi.fn(async () => ({ state: 'succeeded' as const, runtime })), kill: vi.fn(async () => {}) }
    const guestBackend = vi.fn(() => host as never)
    const run = setup({ answer: windows, guestBackend })
    expect(await run.create({ engine: 'claude' }, 'kim@acme.io')).toEqual({ ok: true, session: run.session })
    expect(guestBackend).toHaveBeenCalledWith('hg_0123456789ab')
    expect(run.tmux.create).not.toHaveBeenCalled()
    // The pane is made on the guest's host, starts in its workspace, and becomes the guest's shell when the engine goes.
    expect(host.create).toHaveBeenCalledWith(expect.objectContaining({ cwd: windows.workspace, command: ['claude'], afterExit: expect.any(Object) }))
    expect(run.deps.registry.openPendingAgent).toHaveBeenCalledWith(expect.objectContaining({ runtimes: [runtime], guest: 'kim@acme.io' }))
    // A host that is gone is said as such: the owner's pane is never a fallback (it would run as the owner).
    const missing = setup({ answer: windows, guestBackend: () => null })
    expect(await missing.create({ engine: 'claude' }, 'kim@acme.io')).toEqual({ ok: false, error: 'GUEST_HOST_UNAVAILABLE', detail: expect.any(String) })
    expect(missing.tmux.create).not.toHaveBeenCalled()
  })

  it('installs the guest\'s engine before its pane, once even for two launches at once, and reports a failed install', async () => {
    said()
    const windows: GuestLaunch = { ok: true, workspace: 'C:\\Users\\hg_0123456789ab\\work', argv: ['claude'], env: {},
      guestHostUser: 'hg_0123456789ab' }
    const host = { create: vi.fn(async () => ({ state: 'succeeded' as const, runtime })), kill: vi.fn(async () => {}) }
    let open: () => void = () => {}
    const ensureEngine = vi.fn(async () => { await new Promise<void>((resolve) => { open = resolve }); return { ok: true as const } })
    const run = setup({ answer: windows, guestBackend: vi.fn(() => host as never), ensureEngine })
    const first = run.create({ engine: 'claude' }, 'kim@acme.io')
    const second = run.create({ engine: 'claude' }, 'kim@acme.io')
    await vi.waitFor(() => expect(ensureEngine).toHaveBeenCalledTimes(1))
    open()
    await Promise.all([first, second])
    // One install for both: the second pane waits for the first rather than running npm beside it.
    expect(ensureEngine).toHaveBeenCalledWith(host, { user: 'hg_0123456789ab', engine: 'claude', cwd: windows.workspace, prefix: 'C:\\ProgramData\\HarnessGuests\\hosts\\hg_0123456789ab\\engines' })
    expect(host.create).toHaveBeenCalledTimes(2)
    // A failed install is the person's answer: no pane, no registration, and npm's own words.
    const refused = setup({ answer: windows, guestBackend: () => host as never,
      ensureEngine: vi.fn(async () => ({ ok: false as const, error: 'GUEST_ENGINE_INSTALL_FAILED' as const, detail: 'npm said no' })) })
    expect(await refused.create({ engine: 'claude' }, 'kim@acme.io'))
      .toEqual({ ok: false, error: 'GUEST_ENGINE_INSTALL_FAILED', detail: 'npm said no' })
    expect(refused.deps.registry.openPendingAgent).not.toHaveBeenCalled()
    expect(refused.tmux.create).not.toHaveBeenCalled()
    // A launch Windows refuses (a batch engine whose arguments cmd.exe would read) is the person's answer.
    const unsafe = setup({ answer: windows, guestBackend: () => host as never,
      resolveEngine: () => { throw new WindowsBatchLaunchRefused('claude', 'C:\\tools\\claude.cmd') } })
    expect(await unsafe.create({ engine: 'claude' }, 'kim@acme.io')).toEqual({ ok: false, error: 'ENGINE_LAUNCH_REFUSED',
      detail: expect.stringContaining('claude.cmd is a batch file') })
    expect(unsafe.deps.registry.openPendingAgent).not.toHaveBeenCalled()
  })

  it('starts on the guest\'s first message, bounded as the owner\'s are', async () => {
    said()
    const { create, deps } = setup()
    await create({ engine: 'claude', prompt: '  Fix the tests  ' }, 'kim@acme.io')
    await create({ engine: 'claude', prompt: '   ' }, 'kim@acme.io')
    await create({ engine: 'claude', prompt: null }, 'kim@acme.io')
    expect(vi.mocked(deps.launch).mock.calls.map(([input]) => input.prompt)).toEqual(['Fix the tests', undefined, undefined])
    // A folder to start in goes to shared machines, which starts there only when the owner shares it: this side passes
    // what it was given, because only shared machines knows this machine's own absolute form (`/…`, `C:\…`).
    await create({ engine: 'claude', cwd: '/Users/dee/docs' }, 'kim@acme.io')
    await create({ engine: 'claude', cwd: 'docs' }, 'kim@acme.io')
    expect(vi.mocked(deps.launch).mock.calls.slice(3).map(([input]) => input.cwd)).toEqual(['/Users/dee/docs', 'docs'])
    expect(await create({ engine: 'claude', prompt: 7 }, 'kim@acme.io')).toEqual({ ok: false, error: 'INVALID_PROMPT', detail: 'prompt must be a string' })
    expect(await create({ engine: 'claude', prompt: 'x'.repeat(2001) }, 'kim@acme.io')).toEqual({ ok: false, error: 'PROMPT_TOO_LONG', detail: expect.stringMatching(/2000/) })
    expect(deps.launch).toHaveBeenCalledTimes(5)
  })

  it('installs through the guest host when no one hands in an installer', async () => {
    said()
    const windows: GuestLaunch = { ok: true, workspace: 'C:\\Users\\hg_0123456789ab\\work', argv: ['claude'], env: {},
      guestHostUser: 'hg_0123456789ab' }
    let checked = false
    const host = {
      create: vi.fn(async (_request: { command?: string[]; label?: string }) => ({ state: 'succeeded' as const, dispatch: 'executed' as const, runtime: { backend: 'ptyhost', instance: 'p3-0.5.55-gu0123456789ab', paneId: '%1' } })),
      kill: vi.fn(async () => ({ state: 'succeeded' as const, dispatch: 'executed' as const })),
      // Missing first, then the install succeeds.
      paneState: vi.fn(async () => { const status = checked ? 0 : 1; checked = true; return { dead: true, exitStatus: status, command: 'cmd.exe', engineExit: null } }),
      capture: vi.fn(async () => ({ state: 'succeeded' as const, value: 'installed' })),
    }
    const run = setup({ answer: windows, guestBackend: vi.fn(() => host as never), ensureEngine: undefined, resolveEngine: undefined })
    expect(await run.create({ engine: 'claude' }, 'kim@acme.io')).toEqual({ ok: true, session: run.session })
    // The check, the install, then the harness's own pane; npm ran from the staged Node, as the guest.
    expect(host.create).toHaveBeenCalledTimes(3)
    expect(host.create.mock.calls[0]![0]).toMatchObject({ command: ['cmd.exe', '/d', '/s', '/c', 'where claude'] })
    expect(host.create.mock.calls[1]![0]).toMatchObject({ label: 'guest-engine-install-claude',
      command: expect.arrayContaining([expect.stringContaining('\\bin\\node-'), expect.stringMatching(/engines$/)]) })
    expect(run.deps.registry.openPendingAgent).toHaveBeenCalledTimes(1)
  })

  it('says what stopped it: no tmux, a launch refused, a pane that would not open or register', async () => {
    expect(await setup({ tmuxBackend: () => null }).create({ engine: 'claude' }, 'kim@acme.io')).toEqual({ ok: false, error: 'TMUX_UNAVAILABLE' })
    expect(await setup({ answer: { ok: false, error: 'GUEST_HELPER_REQUIRED', detail: 'Turn it on.' } }).create({ engine: 'claude' }, 'kim@acme.io'))
      .toEqual({ ok: false, error: 'GUEST_HELPER_REQUIRED', detail: 'Turn it on.' })
    expect(await setup({ answer: { ok: false, error: 'GUEST_UNAVAILABLE' } }).create({ engine: 'claude' }, 'kim@acme.io')).toEqual({ ok: false, error: 'GUEST_UNAVAILABLE' })
    // No engine named: no mode of its to start in.
    expect(await setup().create({}, 'kim@acme.io')).toMatchObject({ ok: false, error: 'INVALID_PERMISSION_MODE' })
    warned()
    expect(await setup({ spawn: 'fail' }).create({ engine: 'claude' }, 'kim@acme.io')).toEqual({ ok: false, error: 'SPAWN_FAILED', detail: 'no server' })
    const unregistered = setup({ register: false })
    expect(await unregistered.create({ engine: 'claude' }, 'kim@acme.io')).toEqual({ ok: false, error: 'REGISTRATION_FAILED', detail: expect.any(String) })
    expect(unregistered.deps.announceSession).not.toHaveBeenCalled()
  })
})
