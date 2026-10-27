import { expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { configurationObservation } from './configuration.js'

const previous = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const row = { tabId: 'tab', agent: { id: 'agent', machineId: 'machine', harnessId: 'harness', configuration: previous, configurationVersion: 'version-1' } }
function fixture() {
  return fakeCore({ agents: {
    byAgent: () => ({ agentId: 'harness', engine: 'claude' }) as RegisteredSession,
    terminalAvailable: () => true, runtimeProfile: vi.fn(() => 'runtime-v1:harness:claude:sonnet@high'),
  } })
}

it('records only the observed engine/model/effort and does not carry a previous model\'s context window', () => {
  const core = fixture()
  const update = configurationObservation(core, 'machine', row)!
  expect(update.body).toMatchObject({ asAgentId: 'agent', command: { type: 'agent.configuration', previousVersion: 'version-1',
    configuration: { ...previous, model: 'sonnet', contextWindow: null } } })
  expect(configurationObservation(core, 'machine', row)).toEqual(update)
  expect(configurationObservation(core, 'machine', { ...row, agent: { ...row.agent, configurationVersion: 'version-2' } })!.body.operationId)
    .not.toBe(update.body.operationId)
  vi.mocked(core.agents.runtimeProfile).mockReturnValue('runtime-v1:harness:claude:opus@max')
  expect(configurationObservation(core, 'machine', row)!.body.command.configuration.contextWindow).toBe(200000)
  vi.mocked(core.agents.runtimeProfile).mockReturnValue('runtime-v1:harness:claude:opus@high')
  expect(configurationObservation(core, 'machine', row)).toBeNull()
})

it('refuses an unknown, mismatched, unavailable or unrelated native reading', () => {
  const core = fixture()
  for (const profile of [null, '', 'runtime-v1:other:claude:sonnet@high', 'runtime-v1:harness:codex:model@high']) {
    vi.mocked(core.agents.runtimeProfile).mockReturnValue(profile)
    expect(configurationObservation(core, 'machine', row)).toBeNull()
  }
  expect(configurationObservation(core, 'other', row)).toBeNull()
  expect(configurationObservation(core, 'machine', { ...row, tabId: '../tab' })).toBeNull()
  expect(configurationObservation(core, 'machine', { ...row, agent: { ...row.agent, configurationVersion: {} } })).toBeNull()
  core.agents.byAgent = () => undefined
  expect(configurationObservation(core, 'machine', row)).toBeNull()
  core.agents.byAgent = () => ({ agentId: 'harness', engine: 'claude' }) as RegisteredSession
  core.agents.terminalAvailable = () => false
  expect(configurationObservation(core, 'machine', row)).toBeNull()
})

// Builders started with opus and effort high read as effort 'auto' (Dee, 2026-10-27): Claude Code never reports an effort
// it was launched with (--effort), so its reading falls back to 'auto', and that overwrote the effort the start stored.
it('keeps a known effort when the same model reads as auto, and reports auto only with another model', () => {
  const core = fixture()
  vi.mocked(core.agents.runtimeProfile).mockReturnValue('runtime-v1:harness:claude:opus@auto')
  expect(configurationObservation(core, 'machine', row)).toBeNull()
  // A real change of effort is still reported.
  vi.mocked(core.agents.runtimeProfile).mockReturnValue('runtime-v1:harness:claude:opus@max')
  expect(configurationObservation(core, 'machine', row)!.body.command.configuration.effort).toBe('max')
  // Another model: the stored effort was that model's, so the reading stands as it is.
  vi.mocked(core.agents.runtimeProfile).mockReturnValue('runtime-v1:harness:claude:sonnet@auto')
  expect(configurationObservation(core, 'machine', row)!.body.command.configuration).toMatchObject({ model: 'sonnet', effort: 'auto' })
  // Nothing known yet: auto is all there is to say.
  const unknown = { ...row, agent: { ...row.agent, configuration: { ...previous, effort: 'auto' } } }
  vi.mocked(core.agents.runtimeProfile).mockReturnValue('runtime-v1:harness:claude:opus@auto')
  expect(configurationObservation(core, 'machine', unknown)).toBeNull()
})
