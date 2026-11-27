import { describe, expect, it } from 'vitest'
import { argvNamesOpenRouterProvider, gatewayFromArgv } from './gatewayRuntime.js'

// `ori codex` configures its provider through argv, not env — the pane process carries these verbatim.
const ORI_CODEX_ARGS = '/opt/homebrew/bin/codex -c model_provider=openrouter -c '
  + 'model_providers.openrouter.base_url="https://openrouter.ai/api/v1"'

describe('argvNamesOpenRouterProvider', () => {
  it('recognizes the provider block ori codex injects', () => {
    expect(argvNamesOpenRouterProvider(ORI_CODEX_ARGS)).toBe(true)
  })

  it('does not fire on a plain codex, or on prompt text that mentions openrouter', () => {
    expect(argvNamesOpenRouterProvider('/opt/homebrew/bin/codex --full-auto')).toBe(false)
    expect(argvNamesOpenRouterProvider('claude -p "compare openrouter and anthropic pricing"')).toBe(false)
  })
})

describe('gatewayFromArgv', () => {
  it('says ori for a Codex whose argv names the provider, null for one whose argv does not, nothing for an engine whose hook says it, and null for any other', () => {
    expect(gatewayFromArgv('codex', 'codex -c model_provider=openrouter -c model_providers.openrouter.base_url="https://openrouter.ai/api/v1"')).toBe('ori')
    expect(gatewayFromArgv('codex', 'codex -m gpt-5')).toBeNull()
    for (const engine of ['claude', 'opencode', 'hermes'] as const) expect(gatewayFromArgv(engine, `${engine} -c model_provider=openrouter`)).toBeUndefined()
    for (const engine of ['pi', 'grok', 'kilo', 'cursor'] as const) expect(gatewayFromArgv(engine, `${engine} -c model_provider=openrouter`)).toBeNull()
  })
})
