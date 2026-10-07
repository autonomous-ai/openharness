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
      rename: vi.fn((_id: string, name: string) => row({ ...agent, defaultName: name })),
      markOpened: vi.fn(() => row({ ...agent, lastOpenedAt: NOW })),
      terminalAvailable: vi.fn(() => true),
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
})

describe('a rename', () => {
  it('renames the agent and its pane, answers first, then tells every window and the device, and logs it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { heard, ask, deps } = setup()
    await ask({ agentId: 'a1', name: '  Release notes  ' })
    expect(deps.registry.rename).toHaveBeenCalledWith('a1', 'Release notes')
    expect(deps.onAgentRename).toHaveBeenCalledWith(expect.objectContaining({ defaultName: 'Release notes' }), 'Release notes')
    const renamed = { type: 'agent_renamed', payload: { agentId: 'a1', name: 'Release notes', engine: 'claude' } }
    expect(heard).toEqual([['reply', { agent: { id: 'a1', name: 'Release notes', lastOpenedAt: null } }], ['send', renamed], ['device', renamed]])
    expect(log).toHaveBeenCalledWith('[rename] a1 → "Release notes" · broadcast to web + device')
  })

  it('keeps the row it had when the registry renames nothing, and titles no pane when nothing does', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { heard, ask, deps } = setup({ onAgentRename: null })
    vi.mocked(deps.registry.rename).mockReturnValueOnce(null)
    await ask({ agentId: 'a1', name: 'Kept' })
    expect(heard[0]).toEqual(['reply', { agent: { id: 'a1', name: 'Agent', lastOpenedAt: null } }])
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
