import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentFrame } from '../../lib/agentFrame.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { RuntimeProfileControlError } from '../../lib/runtimeProfileController.js'
import { AGENT_OPENED_THROTTLE_MS, createAgentUpdate, type AgentUpdateDeps } from './update.js'

/**
 * `agent_update`, answered by the core: a rename, a model and effort, or an app opening the agent. The
 * reply is the frame as it stands after, and it goes out before any window hears of the change.
 */
const NOW = Date.UTC(2026, 9, 5, 9, 0)
const row = (over: Partial<RegisteredSession> = {}) => ({ agentId: 'a1', sessionId: 's1', engine: 'claude', ...over }) as RegisteredSession

function setup(over: Partial<AgentUpdateDeps> = {}, agent: RegisteredSession | null = row()) {
  const heard: Array<[string, unknown]> = []
  const deps: AgentUpdateDeps = {
    registry: {
      resolve: vi.fn(() => agent ?? undefined),
      rename: vi.fn(async (_id: string, name: string) => { agent = row({ ...agent, defaultName: name }); return structuredClone(agent) }),
      displayName: vi.fn(s => s.defaultName ?? 'Agent'),
      markOpened: vi.fn(() => row({ ...agent, lastOpenedAt: NOW })),
      terminalAvailable: vi.fn(() => true),
      setLaunchModel: vi.fn(async (_id, launchModel) => { if (!agent) return null; if (launchModel) agent.launchModel = launchModel; else delete agent.launchModel; return structuredClone(agent) }),
    },
    onRuntimeProfileUpdate: vi.fn(async () => {}),
    onAgentRename: vi.fn(),
    closeAgentService: () => ({ cancel: vi.fn() }),
    toProject: vi.fn(async (s: RegisteredSession) => ({ id: s.agentId, name: s.defaultName ?? 'Agent', lastOpenedAt: s.lastOpenedAt ?? null }) as unknown as AgentFrame),
    clients: { send: vi.fn((frame) => { heard.push(['send', frame]) }), sendCommander: vi.fn((frame) => { heard.push(['device', frame]) }) },
    ...over,
  }
  const ask = (payload: Record<string, unknown>) => createAgentUpdate(deps).agentUpdate(payload, (result) => { heard.push(['reply', result]) })
  return { deps, heard, ask }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('what an update must say', () => {
  it('which agent, and at least one of a name, a model or an open; a name that is not blank; an agent that exists', async () => {
    const { heard, ask, deps } = setup()
    await ask({ name: 'x' })
    await ask({ agentId: 'a1' })
    await ask({ agentId: 'a1', opened: 'yes' })
    await ask({ agentId: 'a1', name: '   ' })
    await ask({ agentId: 'a1', name: 7 })
    expect(heard).toEqual([
      ['reply', { error: 'MISSING_AGENT_ID' }], ['reply', { error: 'MISSING_UPDATE' }], ['reply', { error: 'MISSING_UPDATE' }],
      ['reply', { error: 'MISSING_NAME' }], ['reply', { error: 'MISSING_NAME' }],
    ])
    expect(deps.registry.resolve).not.toHaveBeenCalled()
    const missing = setup({}, null)
    await missing.ask({ agentId: 'nobody', opened: true })
    expect(missing.heard).toEqual([['reply', { error: 'AGENT_NOT_FOUND' }]])
  })
})

describe('a model and effort', () => {
  it('moves the agent and answers with its frame', async () => {
    const { heard, ask, deps } = setup()
    await ask({ agentId: 'a1', selectedModel: 'runtime-v1:s1:claude:opus@high' })
    expect(deps.onRuntimeProfileUpdate).toHaveBeenCalledWith('a1', 'runtime-v1:s1:claude:opus@high')
    expect(heard).toEqual([['reply', { agent: { id: 'a1', name: 'Agent', lastOpenedAt: null } }]])
    expect(Object.keys(heard[0][1] as object)).toEqual(['agent'])
  })

  // Task #3395: a person's pick is what the session relaunches with (lib/launchOverrides.ts), not the model it was first
  // launched with, which a reopen would otherwise put back.
  it('records the pick as the model its session relaunches with, its effort only where the engine takes it', async () => {
    const { ask, deps } = setup()
    await ask({ agentId: 'a1', selectedModel: 'runtime-v1:s1:claude:sonnet@high' })
    expect(deps.registry.setLaunchModel).toHaveBeenCalledWith('a1', { model: 'sonnet', effort: 'high' }, expect.any(Object))
    await ask({ agentId: 'a1', selectedModel: 'runtime-v1:s1:claude:opus@ultracode' })
    expect(deps.registry.setLaunchModel).toHaveBeenLastCalledWith('a1', { model: 'opus', effort: null }, expect.any(Object))
    const codex = setup({}, row({ engine: 'codex' }))
    await codex.ask({ agentId: 'a1', selectedModel: 'runtime-v1:s1:codex:gpt-6@high' })
    expect(codex.deps.registry.setLaunchModel).toHaveBeenCalledWith('a1', null, expect.any(Object))
    // A pick the wire cannot read was the controller's to judge; nothing is recorded for it.
    const unread = setup()
    await unread.ask({ agentId: 'a1', selectedModel: 'runtime-v1:x' })
    expect(unread.deps.registry.setLaunchModel).not.toHaveBeenCalled()
    const failed = setup({ onRuntimeProfileUpdate: async () => { throw new RuntimeProfileControlError('BUSY') } })
    await failed.ask({ agentId: 'a1', selectedModel: 'runtime-v1:s1:claude:sonnet@high' })
    expect(failed.deps.registry.setLaunchModel).not.toHaveBeenCalled()
  })

  it('refuses a profile that is not one, or with nothing to apply it, and says why a move failed', async () => {
    const refused = async (over: Partial<AgentUpdateDeps>, selectedModel: unknown) => {
      const { heard, ask } = setup(over)
      await ask({ agentId: 'a1', selectedModel })
      return heard
    }
    expect(await refused({}, 7)).toEqual([['reply', { error: 'INVALID_RUNTIME_PROFILE' }]])
    expect(await refused({ onRuntimeProfileUpdate: null }, 'runtime-v1:x')).toEqual([['reply', { error: 'INVALID_RUNTIME_PROFILE' }]])
    expect(await refused({ onRuntimeProfileUpdate: async () => { throw new RuntimeProfileControlError('BUSY') } }, 'runtime-v1:x')).toEqual([['reply', { error: 'BUSY' }]])
    expect(await refused({ onRuntimeProfileUpdate: async () => { throw new Error('pane gone') } }, 'runtime-v1:x')).toEqual([['reply', { error: 'INTERNAL' }]])
  })

  it('logs the name and message of an unexpected profile failure without request contents', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { heard, ask } = setup({ onRuntimeProfileUpdate: async () => { throw new TypeError('engine state disappeared') } })
    await ask({ agentId: 'a1', selectedModel: 'runtime-v1:s1:claude:private-model@high' })
    expect(heard).toEqual([['reply', { error: 'INTERNAL' }]])
    expect(error).toHaveBeenCalledExactlyOnceWith('[agent_update] model update failed: TypeError: engine state disappeared')
  })

  it('gives a non-Error exception a safe description', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { heard, ask } = setup({ onRuntimeProfileUpdate: async () => { throw null } })
    await ask({ agentId: 'a1', selectedModel: 'runtime-v1:s1:claude:private-model@high' })
    expect(heard).toEqual([['reply', { error: 'INTERNAL' }]])
    expect(error).toHaveBeenCalledExactlyOnceWith('[agent_update] model update failed: UnknownError: non-Error exception')
  })
})

describe('a rename', () => {
  it('renames the agent and its pane, answers first, then tells every window and the device, and logs it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { heard, ask, deps } = setup()
    await ask({ agentId: 'a1', name: '  Release notes  ' })
    expect(deps.registry.rename).toHaveBeenCalledWith('a1', 'Release notes', expect.any(Object))
    expect(deps.onAgentRename).toHaveBeenCalledWith(expect.objectContaining({ defaultName: 'Release notes' }), 'Release notes')
    const renamed = { type: 'agent_renamed', payload: { agentId: 'a1', name: 'Release notes', engine: 'claude' } }
    expect(heard).toEqual([['reply', { agent: { id: 'a1', name: 'Release notes', lastOpenedAt: null } }], ['send', renamed], ['device', renamed]])
    expect(log).toHaveBeenCalledWith('[rename] a1 → name 13 chars · broadcast to web + device')
  })

  it('logs the size of the new name, never the name', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { ask } = setup()
    await ask({ agentId: 'a1', name: 'SECRET-NAME-MARKER' })
    const line = log.mock.calls.map(([said]) => String(said)).find((said) => said.startsWith('[rename]'))
    expect(line).toContain('[rename] a1 ')
    expect(line).not.toContain('SECRET')
  })

  it('reports a refused rename without claiming success or titling a pane', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { heard, ask, deps } = setup({ onAgentRename: null })
    vi.mocked(deps.registry.rename).mockResolvedValueOnce(null)
    await ask({ agentId: 'a1', name: 'Kept' })
    expect(heard).toEqual([['reply', { error: 'AGENT_CHANGED' }]])
  })
})

describe('authority across durable update waits', () => {
  it.each(['model', 'name'] as const)('reports a failed %s publication without a success frame', async kind => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { deps, heard, ask } = setup()
    if (kind === 'model') vi.mocked(deps.registry.setLaunchModel).mockRejectedValueOnce(new Error('storage unavailable'))
    else vi.mocked(deps.registry.rename).mockRejectedValueOnce(new Error('storage unavailable'))
    await ask({ agentId: 'a1', ...(kind === 'model' ? { selectedModel: 'runtime-v1:s1:claude:opus@high' } : { name: 'Kept' }) })
    expect(heard).toEqual([['reply', { error: 'PERSISTENCE_UNCONFIRMED' }]])
    expect(deps.onAgentRename).not.toHaveBeenCalled()
  })

  it.each(['control', 'model owner', 'rename', 'open', 'frame', 'name frame'] as const)('refuses a replacement during %s', async phase => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { deps, heard, ask } = setup()
    const replace = () => vi.mocked(deps.registry.resolve).mockReturnValue(row({ sessionId: 'replacement' }))
    let payload: Record<string, unknown> = { agentId: 'a1', opened: true }
    if (phase === 'control' || phase === 'model owner') {
      payload = { agentId: 'a1', selectedModel: 'runtime-v1:s1:claude:opus@high' }
      if (phase === 'control') vi.mocked(deps.onRuntimeProfileUpdate!).mockImplementationOnce(async () => { replace() })
      else vi.mocked(deps.registry.setLaunchModel).mockResolvedValueOnce(null)
    } else if (phase === 'rename') {
      payload = { agentId: 'a1', name: 'Kept' }
      const rename = vi.mocked(deps.registry.rename).getMockImplementation()!
      vi.mocked(deps.registry.rename).mockImplementationOnce(async (...args) => { const saved = await rename(...args); replace(); return saved })
    } else if (phase === 'open') deps.closeAgentService = () => ({ cancel: vi.fn(async () => { replace() }) })
    else {
      if (phase === 'name frame') payload = { agentId: 'a1', name: 'Kept' }
      vi.mocked(deps.toProject).mockImplementationOnce(async () => {
        if (phase === 'frame') replace()
        else vi.mocked(deps.registry.displayName).mockReturnValue('Another name')
        return { id: 'a1' } as AgentFrame
      })
    }
    await ask(payload)
    expect(heard).toEqual([['reply', { error: 'AGENT_CHANGED' }]])
    expect(deps.clients.send).not.toHaveBeenCalled()
    expect(deps.clients.sendCommander).not.toHaveBeenCalled()
  })
})

describe('an app opening the agent', () => {
  it('stamps it on this machine\'s clock, keeps it from being closed unseen, answers, then tells every window but not the device', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const cancel = vi.fn()
    const { heard, ask, deps } = setup({ closeAgentService: () => ({ cancel }) })
    await ask({ agentId: 'a1', opened: true })
    expect(cancel).toHaveBeenCalledWith('a1')
    expect(deps.registry.markOpened).toHaveBeenCalledWith('a1')
    const agent = { id: 'a1', name: 'Agent', lastOpenedAt: NOW }
    expect(heard).toEqual([['reply', { agent }], ['send', { type: 'agent_synced', payload: { agent } }]])
  })

  it('answers a repeat inside the throttle with the frame as it is, stamping and telling no one; a stamp from the future never throttles', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const stamped = (lastOpenedAt: number) => setup({ closeAgentService: () => null }, row({ lastOpenedAt }))
    const repeat = stamped(NOW - AGENT_OPENED_THROTTLE_MS + 1)
    await repeat.ask({ agentId: 'a1', opened: true })
    expect(repeat.deps.registry.markOpened).not.toHaveBeenCalled()
    expect(repeat.heard).toEqual([['reply', { agent: { id: 'a1', name: 'Agent', lastOpenedAt: NOW - AGENT_OPENED_THROTTLE_MS + 1 } }]])
    for (const lastOpenedAt of [NOW - AGENT_OPENED_THROTTLE_MS, NOW + 60_000]) {
      const later = stamped(lastOpenedAt)
      await later.ask({ agentId: 'a1', opened: true })
      expect(later.deps.registry.markOpened).toHaveBeenCalledOnce()
    }
  })

  it('stamps but tells no window of an agent whose terminal this machine cannot see, and keeps its row if the registry stamps nothing', async () => {
    const { heard, ask, deps } = setup()
    vi.mocked(deps.registry.terminalAvailable).mockReturnValue(false)
    vi.mocked(deps.registry.markOpened).mockReturnValueOnce(null)
    await ask({ agentId: 'a1', opened: true })
    expect(heard).toEqual([['reply', { agent: { id: 'a1', name: 'Agent', lastOpenedAt: null } }]])
  })
})
