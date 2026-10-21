import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GuestLaunch } from '../api.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { TmuxRuntimeRef } from '../../lib/terminalTypes.js'
import { createGuestCreate, type GuestCreateDeps } from './guestCreate.js'

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
    expect(deps.launch).not.toHaveBeenCalled()
    // Empty is absent.
    said()
    expect((await create({ engine: 'claude', dsh: null, agent: '' }, 'kim@acme.io')).ok).toBe(true)
  })

  it('starts on the guest\'s first message, bounded as the owner\'s are', async () => {
    said()
    const { create, deps } = setup()
    await create({ engine: 'claude', prompt: '  Fix the tests  ' }, 'kim@acme.io')
    await create({ engine: 'claude', prompt: '   ' }, 'kim@acme.io')
    await create({ engine: 'claude', prompt: null }, 'kim@acme.io')
    expect(vi.mocked(deps.launch).mock.calls.map(([input]) => input.prompt)).toEqual(['Fix the tests', undefined, undefined])
    // A folder to start in goes to shared machines, which starts there only when the owner shares it.
    await create({ engine: 'claude', cwd: '/Users/dee/docs' }, 'kim@acme.io')
    await create({ engine: 'claude', cwd: 'docs' }, 'kim@acme.io')
    expect(vi.mocked(deps.launch).mock.calls.slice(3).map(([input]) => input.cwd)).toEqual(['/Users/dee/docs', undefined])
    expect(await create({ engine: 'claude', prompt: 7 }, 'kim@acme.io')).toEqual({ ok: false, error: 'INVALID_PROMPT', detail: 'prompt must be a string' })
    expect(await create({ engine: 'claude', prompt: 'x'.repeat(2001) }, 'kim@acme.io')).toEqual({ ok: false, error: 'PROMPT_TOO_LONG', detail: expect.stringMatching(/2000/) })
    expect(deps.launch).toHaveBeenCalledTimes(5)
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
