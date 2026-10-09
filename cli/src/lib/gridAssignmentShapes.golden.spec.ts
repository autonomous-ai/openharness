/** Former-code record for L2. Inputs, file bytes and expected answers stay fixed across the move. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { ENGINES, type AgentEngine } from '../engines/types.js'

process.env.TZ = 'UTC'
const golden = fileURLToPath(new URL('./__fixtures__/grid-assignment-shapes.golden.json', import.meta.url))
const relay = 'https://grid.example/g/home/relay/v1'
const api = 'https://saved.example/inference/v1'
const vars: Partial<Record<AgentEngine, [string, string]>> = {
  claude: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'], hermes: ['OPENAI_BASE_URL', 'HERMES_INFERENCE_MODEL'],
  grok: ['GROK_MODELS_BASE_URL', 'IGNORED_MODEL'], copilot: ['COPILOT_PROVIDER_BASE_URL', 'COPILOT_MODEL'],
}

it('keeps every assignment and saved-API instruction shape on both platforms', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assignment-golden-'))
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const result: Record<string, unknown> = {}
  try {
    for (const os of ['darwin', 'linux']) {
      Object.defineProperty(process, 'platform', { value: os })
      vi.resetModules()
      const { gridAssignmentShapes } = await import('../testing/gridAssignmentShapes.js')
      const { buildGridEngineLaunch, gridCapableEngines } = await import('./gridLaunch.js')
      const dir = join(root, os)
      const storeDir = join(dir, 'api-connections')
      mkdirSync(storeDir, { recursive: true })
      const shapes = gridAssignmentShapes(dir)
      const out: Record<string, unknown> = {}
      const assignment = async (name: string, engine: AgentEngine, env: Record<string, string>, args = '') => {
        out[name] = await shapes.assignment(engine, { ...env, SECRET_API_KEY: 'never-forward-this-key' }, args)
      }
      for (const engine of ENGINES) {
        await assignment(`${engine}/plain`, engine, {})
        // The old classifier accepts a provider argument for any engine without its own URL variable.
        await assignment(`${engine}/provider-argument`, engine, {}, `engine -c model_providers.grid.base_url="${relay}" -m chosen`)
      }
      for (const [engine, [urlVar, modelVar]] of Object.entries(vars) as Array<[AgentEngine, [string, string]]>) {
        for (const url of ['', ' ', 'not-a-url', 'https://other.example/v1', 'https://grid.example/relayish/v1', relay, ` ${relay} `]) {
          for (const model of ['', 'chosen', 'Auto', 'aUtO']) {
            await assignment(`${engine}/env/${url}/${model}`, engine, { [urlVar]: url, [modelVar]: model }, `engine -m ${model || 'argv-model'}`)
          }
        }
      }
      for (const args of ['', `-c model_providers.other.base_url=${relay}`, `-c model_providers.other.base_url="${relay}" -m chosen`,
        `-c model_providers.other.base_url="${relay}" -m Auto`, '-c model_providers.grid.base_url="bad" -m chosen']) {
        await assignment(`codex/argv/${args}`, 'codex', { OPENAI_BASE_URL: relay }, args)
      }
      const piDir = join(dir, 'pi')
      mkdirSync(piDir)
      for (const [name, content] of Object.entries({ broken: '{', absent: '{}', wrong: '{"providers":{"other":{"baseUrl":"' + relay + '"}}}',
        direct: JSON.stringify({ providers: { grid: { baseUrl: 'https://other.example/v1' } } }),
        valid: JSON.stringify({ providers: { grid: { baseUrl: relay } } }) })) {
        writeFileSync(join(piDir, 'models.json'), content)
        for (const args of ['', '--model grid/chosen', '--model grid/Auto', '--model other/chosen']) {
          await assignment(`pi/${name}/${args}`, 'pi', { PI_CODING_AGENT_DIR: piDir }, args)
        }
      }
      await assignment('pi/missing-file', 'pi', { PI_CODING_AGENT_DIR: join(dir, 'missing') }, '--model grid/chosen')
      const config = join(dir, 'opencode.json')
      for (const [name, content] of Object.entries({ broken: '{', absent: '{}', many: JSON.stringify({ provider: { one: {}, two: {} } }),
        noModel: JSON.stringify({ provider: { grid: { options: { baseURL: relay } } } }),
        manyModels: JSON.stringify({ provider: { grid: { options: { baseURL: relay }, models: { one: {}, two: {} } } } }),
        direct: JSON.stringify({ provider: { grid: { options: { baseURL: 'https://other.example/v1' }, models: { chosen: {} } } } }),
        model: JSON.stringify({ provider: { grid: { options: { baseURL: relay }, models: { chosen: {} } } } }),
        router: JSON.stringify({ provider: { grid: { options: { baseURL: relay }, models: { aUtO: {} } } } }) })) {
        writeFileSync(config, content)
        await assignment(`opencode/${name}`, 'opencode', { OPENCODE_CONFIG: config }, '-m ignored/wrong')
      }
      await assignment('opencode/missing-file', 'opencode', { OPENCODE_CONFIG: join(dir, 'missing.json') })
      for (const engine of gridCapableEngines()) for (const model of [null, 'chosen']) {
        const built = buildGridEngineLaunch(engine, { networkId: 'home', networkName: 'Home', baseUrl: relay, apiKey: 'fake-grid-key', model },
          { hermesSystemManaged: false, opencodeMajor: 2 })
        if (!built.ok) { out[`${engine}/launch-roundtrip/${model}`] = built; continue }
        const env = { ...built.launch.env }
        if (built.launch.configDir) {
          const configs = built.launch.configDir
          const path = join(dir, `config-${engine}-${model}`)
          mkdirSync(path)
          for (const file of configs.files) writeFileSync(join(path, file.name), file.content)
          env[configs.envVar] = configs.pointAt ? join(path, configs.pointAt) : path
        }
        await assignment(`${engine}/launch-roundtrip/${model}`, engine, env, built.launch.args.join(' '))
      }
      const connection = { id: 'saved', provider: 'custom', name: 'Saved', baseUrl: api, keyEnv: 'SAVED_API_KEY', authHeader: 'Authorization', authPrefix: 'Bearer', apiKey: 'fake-saved-key' }
      await assignment('saved/before-save', 'claude', { ANTHROPIC_BASE_URL: api, ANTHROPIC_MODEL: 'chosen' })
      writeFileSync(join(storeDir, 'connections.json'), JSON.stringify({ version: 1, connections: [connection] }))
      shapes.remember()
      out['saved/list'] = shapes.list()
      await assignment('saved/anthropic', 'claude', { ANTHROPIC_BASE_URL: api.replace(/\/v1$/, ''), ANTHROPIC_MODEL: 'chosen' })
      await assignment('saved/openai', 'codex', {}, `-c model_providers.saved.base_url=${api} -m chosen`)
      for (const engine of [...ENGINES, 'gemini']) {
        const work = join(dir, `instructions-${engine}`)
        mkdirSync(work)
        writeFileSync(join(work, 'AGENTS.md'), '# Existing rules\n')
        shapes.instructions(work, engine)
        shapes.instructions(work, engine)
        out[`instructions/${engine}`] = Object.fromEntries(readdirSync(work).sort().map(name => [name, readFileSync(join(work, name), 'utf8')]))
      }
      writeFileSync(join(storeDir, 'connections.json'), JSON.stringify({ version: 1, connections: [] }))
      shapes.remember()
      await assignment('saved/after-removal', 'codex', {}, `-c model_providers.saved.base_url=${api} -m chosen`)
      const work = join(dir, 'instructions-empty')
      mkdirSync(work)
      shapes.instructions(work, 'claude')
      out['instructions/no-saved-api'] = readdirSync(work)
      writeFileSync(join(storeDir, 'connections.json'), '{')
      try { shapes.instructions(work, 'claude') } catch (error) { out['instructions/unreadable'] = (error as Error).message }
      shapes.remember() // Best effort recognition never erases remembered endpoints.
      await assignment('saved/unreadable', 'codex', {}, `-c model_providers.saved.base_url=${api} -m chosen`)
      result[os] = out
    }
    const text = JSON.stringify(result, null, 2) + '\n'
    expect(text).not.toContain(root)
    expect(text).not.toContain('fake-saved-key')
    expect(text).not.toContain('never-forward-this-key')
    if (process.env.RECORD_GRID_ASSIGNMENT_GOLDEN === '1') writeFileSync(golden, text)
    expect(result).toEqual(JSON.parse(readFileSync(golden, 'utf8')))
  } finally {
    Object.defineProperty(process, 'platform', platform)
    vi.resetModules()
    rmSync(root, { recursive: true, force: true })
  }
})
