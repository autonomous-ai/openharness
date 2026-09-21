import { describe, expect, it } from 'vitest'
import { subscriptionModelLaunch, subscriptionModelEngines } from './subscriptionModel.js'

/**
 * The point of this module is that coming back from a grid returns a person to the model they were
 * on — so what is pinned here is the MECHANISM per engine, and the refusal to invent one.
 */
describe('subscriptionModelLaunch', () => {
  it('gives Claude Code the variable it prefers over a resumed session’s model', () => {
    // The stale session model is exactly what produced "could not be restored — using opus instead".
    expect(subscriptionModelLaunch('claude', 'opus')).toEqual({ env: { ANTHROPIC_MODEL: 'opus' }, args: [] })
  })

  it('gives Codex and Hermes argv, because their interactive CLIs resolve the model there', () => {
    expect(subscriptionModelLaunch('codex', 'gpt-5-codex')).toEqual({ env: {}, args: ['-m', 'gpt-5-codex'] })
    // Hermes reads `-m` then config.yaml with NO environment tier for this surface, so setting
    // HERMES_INFERENCE_MODEL here would be ignored by the pane it is meant to steer.
    expect(subscriptionModelLaunch('hermes', 'GLM-4.7-Flash')).toEqual({ env: {}, args: ['-m', 'GLM-4.7-Flash'] })
  })

  it('passes an OpenCode model only when it carries its provider', () => {
    expect(subscriptionModelLaunch('opencode', 'anthropic/claude-sonnet-4')).toEqual({
      env: {}, args: ['-m', 'anthropic/claude-sonnet-4'],
    })
    // A bare name has no provider this module could supply, and OpenCode would look for a model
    // that does not exist. Saying nothing leaves the engine to decide, which is the safe direction.
    expect(subscriptionModelLaunch('opencode', 'claude-sonnet-4')).toBeNull()
  })

  it('says nothing for an engine with no cited mechanism', () => {
    // A guessed flag does not fail loudly: the engine starts and runs on a model nobody chose.
    expect(subscriptionModelLaunch('amp', 'some-model')).toBeNull()
    expect(subscriptionModelLaunch('devin', 'some-model')).toBeNull()
  })

  it('treats an absent or blank model as nothing to restore', () => {
    expect(subscriptionModelLaunch('claude', null)).toBeNull()
    expect(subscriptionModelLaunch('claude', '   ')).toBeNull()
    expect(subscriptionModelLaunch('claude', undefined)).toBeNull()
  })

  it('round-trips the model name a runtime profile decodes to', () => {
    // ⚠️ The daemon reads this from `selectedModel`, which answers an ENCODED profile
    // (`runtime-v1:<agent>:claude:opus@xhigh`) and NOT a model name. The first version of this
    // feature passed the encoded string straight through, which would have pointed the engine at a
    // model that does not exist — so what is pinned is that the decoded half is usable as-is.
    expect(subscriptionModelLaunch('claude', 'opus')?.env.ANTHROPIC_MODEL).toBe('opus')
    expect(subscriptionModelLaunch('claude', 'runtime-v1:a:claude:opus@xhigh')?.env.ANTHROPIC_MODEL)
      .not.toBe('opus') // a reminder: the caller must decode, this module cannot
  })

  it('only claims engines it can actually steer', () => {
    expect(subscriptionModelEngines().sort()).toEqual(['claude', 'codex', 'hermes', 'opencode'])
  })
})
