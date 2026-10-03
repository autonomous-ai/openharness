import { expect, it } from 'vitest'
import { freshHarnessEnvironment, DEFAULT_HARNESS_MODEL, DEFAULT_HARNESS_EFFORT } from './harnessDefaults.js'

it('selects Muse for fresh OpenCode harnesses while retaining package tools', () => {
  const mcp = { harnessd: { type: 'local', command: ['harness', 'pair', 'mcp'] } }
  const env = freshHarnessEnvironment('opencode', { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp }), TOKEN_FILE: '/token' })
  expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
    mcp, permission: 'allow', model: DEFAULT_HARNESS_MODEL, small_model: DEFAULT_HARNESS_MODEL,
    provider: { opencode: { models: { 'muse-spark-1.3-contributor-free': { options: { reasoningEffort: DEFAULT_HARNESS_EFFORT } } } } },
    agent: { build: { model: DEFAULT_HARNESS_MODEL, variant: 'xhigh' }, plan: { model: DEFAULT_HARNESS_MODEL, variant: 'xhigh' } },
  })
  expect(env.TOKEN_FILE).toBe('/token')
})

it('retains explicit tool denials and custom provider and agent settings', () => {
  const config = {
    permission: { bash: { 'rm *': 'deny' } },
    provider: { opencode: { options: { timeout: 5000 }, models: { 'muse-spark-1.3-contributor-free': { options: { temperature: 0.4 } } } } },
    agent: { build: { prompt: 'Project instructions' } },
  }
  const result = JSON.parse(freshHarnessEnvironment('opencode', { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }).OPENCODE_CONFIG_CONTENT!)
  expect(result.permission).toEqual({ '*': 'allow', bash: { 'rm *': 'deny' } })
  expect(result.provider.opencode).toMatchObject({ options: { timeout: 5000 }, models: { 'muse-spark-1.3-contributor-free': { options: { temperature: 0.4, reasoningEffort: 'xhigh' } } } })
  expect(result.agent.build.prompt).toBe('Project instructions')
})

it('honours an explicit Ask choice instead of enabling automatic approvals', () => {
  const result = JSON.parse(freshHarnessEnvironment('opencode', {}, false, 'ask').OPENCODE_CONFIG_CONTENT!)
  expect(result.permission).toBe('ask')
  expect(result.model).toBe(DEFAULT_HARNESS_MODEL)
})

it('does not replace an explicit route, a restored conversation, or another agent', () => {
  const env = { OPENCODE_CONFIG_CONTENT: '{"model":"custom/chosen"}' }
  expect(freshHarnessEnvironment('opencode', env, true)).toBe(env)
  expect(freshHarnessEnvironment('codex', env)).toBe(env)
})
