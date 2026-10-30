import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTING_POLICY as policy } from './routingPolicy.js'
import { buildRefusal, cheapKind, gridBuilds, GRID_BUILDS, startTarget } from './rules.js'

// Ken and Dee, 2026-10-30: Builders run on Opus high or Astra xhigh. A build needs a model rated 3, on the server as in the
// CLI's route; a grid model builds only low-risk docs, tests or fixtures; a model a person named builds whatever its rating.
// Review of #2314: an existing Sonnet agent still got builds, low-difficulty fixes went to Haiku, and saved tables keep Sonnet on.
describe('who may build', () => {
  const on = (engine: string, model: string, effort = 'high') => startTarget({ machineId: 'm', engine, model, effort })
  const grid = { ...on('claude', 'default', 'default'), gridModel: 'moonshotai/kimi-k3' }
  const work = (patch: Record<string, unknown> = {}) => ({ risk: 'low', kind: 'docs', ...patch })

  it('takes the top tier: Opus, Astra at xhigh, Sol and Codex on its own model', () => {
    for (const target of [on('claude', 'opus'), on('codex', 'gpt-6-astra', 'xhigh'), on('codex', 'gpt-6.1-sol'), on('codex', 'default', 'default')]) {
      expect(buildRefusal(policy, target, work({ kind: 'fix' }))).toBeNull()
    }
  })

  it('refuses Sonnet, Haiku and a model the policy does not name, Sonnet even with its row turned off', () => {
    expect(policy.models.find(m => m.model === 'sonnet')!.enabled).toBe(false)
    expect(buildRefusal(policy, on('claude', 'sonnet'), work({ kind: 'fix' })))
      .toBe('A build needs a model rated 3, and Claude sonnet is 2. Builders run at the top tier unless a person names the model.')
    expect(buildRefusal(policy, on('claude', 'claude-haiku-5-5'), work({ kind: 'fix' }))).toContain('Claude claude-haiku-5-5 is 1.')
    expect(buildRefusal(policy, on('codex', 'gpt-7-unknown'), undefined)).toContain('Codex gpt-7-unknown is 1.')
  })

  it('lets a model a person named build, whatever its rating', () => {
    expect(buildRefusal(policy, on('claude', 'sonnet'), work({ kind: 'fix', model: 'sonnet' }))).toBeNull()
  })

  it('lets a grid model build only low-risk docs, tests or fixtures, singular or plural, or what a person asked for', () => {
    for (const kind of ['docs', 'doc', 'tests', 'test', 'fixtures', 'fixture']) expect(buildRefusal(policy, grid, work({ kind }))).toBeNull()
    for (const kind of ['fix', 'copy', 'refactor', 'ui', undefined]) expect(buildRefusal(policy, grid, work({ kind }))).toBe(GRID_BUILDS)
    expect(buildRefusal(policy, grid, work({ risk: 'medium' }))).toBe(GRID_BUILDS)
    // With no route decision to read, a grid build is refused.
    expect(buildRefusal(policy, grid, undefined)).toBe(GRID_BUILDS)
    expect(buildRefusal(policy, grid, work({ kind: 'ui', local: true }))).toBeNull()
    expect(buildRefusal(policy, grid, work({ kind: 'ui', model: 'kimi k3' }))).toBeNull()
  })

  it('reads the kinds as the CLI does', () => {
    expect(['docs', 'doc', 'tests', 'test', 'fixtures', 'fixture'].every(cheapKind)).toBe(true)
    expect(['fix', 'copy', 'documentation', 'testing', '', undefined].some(cheapKind)).toBe(false)
    expect(gridBuilds(undefined)).toBe(false)
  })
})
