import { describe, expect, it } from 'vitest'
import { codexGridModelCatalog } from './codexGridModel.js'
import { buildGridEngineLaunch } from './gridLaunch.js'

const grid = { networkId: 'net-home', networkName: 'Home', baseUrl: 'https://grid.example/g/home/relay/v1', apiKey: 'grid-key-1' }

describe('the card Codex is given for a grid model', () => {
  it('is Codex’s fallback card for the model with tool search on', () => {
    const { models } = JSON.parse(codexGridModelCatalog('Qwen/Qwen3.8-27B', 262_144))
    expect(models).toHaveLength(1)
    const [card] = models
    expect(card).toMatchObject({
      slug: 'Qwen/Qwen3.8-27B', display_name: 'Qwen/Qwen3.8-27B', shell_type: 'unified_exec', visibility: 'none',
      apply_patch_tool_type: null, truncation_policy: { mode: 'bytes', limit: 10_000 },
      context_window: 262_144, max_context_window: 262_144, supports_search_tool: true,
    })
    // A catalog model reads its instructions from the card alone: never an empty prompt.
    expect(card.model_messages.instructions_template).toMatch(/^You are a coding agent running in the Codex CLI/)
    // …and never the planning section Codex leaves out for a fallback model without `update_plan`.
    expect(card.model_messages.instructions_template).not.toContain('## Planning')
  })

  it('keeps the fallback window when the grid reports none', () => {
    const [card] = JSON.parse(codexGridModelCatalog('m')).models
    expect(card.context_window).toBe(272_000)
  })

  it('is written for a grid model, not for a grid without a model or a saved API', () => {
    const withModel = buildGridEngineLaunch('codex', { ...grid, model: 'qwen3-coder' }, { hermesSystemManaged: false })
    const withoutModel = buildGridEngineLaunch('codex', grid, { hermesSystemManaged: false })
    const api = buildGridEngineLaunch('codex', { ...grid, networkId: 'api:router', model: 'vendor/model-a' }, { hermesSystemManaged: false })
    expect(withModel.ok && withModel.launch.configDir).toMatchObject({
      cliConfigKey: 'model_catalog_json', pointAt: 'model-catalog.json',
      files: [{ name: 'model-catalog.json' }],
    })
    expect(withoutModel.ok && withoutModel.launch.configDir).toBeUndefined()
    expect(api.ok && api.launch.configDir).toBeUndefined()
  })
})
