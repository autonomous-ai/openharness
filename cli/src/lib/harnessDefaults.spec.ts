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
  const env = { OPENCODE_CONFIG_CONTENT: '{"mcp":{}}', OPENCODE_CONFIG: '/grid.json' }
  expect(freshHarnessEnvironment('opencode', env, true)).toBe(env)
  expect(freshHarnessEnvironment('opencode', {}, true)).toEqual({})
  const pinned = { OPENCODE_CONFIG_CONTENT: '{"model":"custom/chosen"}' }
  expect(freshHarnessEnvironment('codex', pinned)).toBe(pinned)
})

it("a grid's model is not outranked by a package's: the package's inline model goes, its tools stay", () => {
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'opencode/space-bunny-free', small_model: 'opencode/space-bunny-free', mcp: { x: {} } }), OPENCODE_CONFIG: '/grid.json' }
  const result = freshHarnessEnvironment('opencode', env, true)
  expect(JSON.parse(result.OPENCODE_CONFIG_CONTENT!)).toEqual({ mcp: { x: {} } })
  expect(result.OPENCODE_CONFIG).toBe('/grid.json')
  expect(JSON.parse(freshHarnessEnvironment('opencode', { OPENCODE_CONFIG_CONTENT: '{"small_model":"a/b"}' }, true).OPENCODE_CONFIG_CONTENT!)).toEqual({})
})

it("keeps the model a package pins, with the launch's approvals, and adds no effort of its own", () => {
  const pinned = { model: 'opencode/space-bunny-free', small_model: 'opencode/space-bunny-free' }
  const result = JSON.parse(freshHarnessEnvironment('opencode', { OPENCODE_CONFIG_CONTENT: JSON.stringify(pinned) }).OPENCODE_CONFIG_CONTENT!)
  expect(result).toEqual({ ...pinned, permission: 'allow' })
  const asked = JSON.parse(freshHarnessEnvironment('opencode', { OPENCODE_CONFIG_CONTENT: JSON.stringify(pinned) }, false, 'ask').OPENCODE_CONFIG_CONTENT!)
  expect(asked).toEqual({ ...pinned, permission: 'ask' })
  // An empty name is no choice: the default applies.
  expect(JSON.parse(freshHarnessEnvironment('opencode', { OPENCODE_CONFIG_CONTENT: '{"model":""}' }).OPENCODE_CONFIG_CONTENT!).model).toBe(DEFAULT_HARNESS_MODEL)
})
