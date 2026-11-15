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

it('keeps every assignment and saved-API instruction shape on both platforms', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assignment-golden-'))
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const result: Record<string, unknown> = {}
  try {
    for (const os of ['darwin', 'linux']) {
      Object.defineProperty(process, 'platform', { value: os })
      vi.resetModules()
      const { gridAssignmentShapes } = await import('../testing/gridAssignmentShapes.js')
      const { buildGridEngineLaunch, gridCapableEngines, gridConfigHandOff } = await import('./gridLaunch.js')
      const dir = join(root, os)
      const storeDir = join(dir, 'api-connections')
      mkdirSync(storeDir, { recursive: true })
      const shapes = gridAssignmentShapes(dir)
      const out: Record<string, unknown> = {}
      const assignment = async (name: string, engine: AgentEngine, args = '') => {
        out[name] = await shapes.assignment(engine, args)
      }
      for (const engine of ENGINES) {
        await assignment(`${engine}/plain`, engine)
        // A provider argument counts for every engine whose grid may be in its command line.
        await assignment(`${engine}/provider-argument`, engine, `engine -c model_providers.grid.base_url="${relay}" -m chosen`)
      }
      for (const args of ['', `-c model_providers.other.base_url=${relay}`, `-c model_providers.other.base_url="${relay}" -m chosen`,
        `-c model_providers.other.base_url="${relay}" -m Auto`, '-c model_providers.grid.base_url="bad" -m chosen']) {
        await assignment(`codex/argv/${args}`, 'codex', args)
      }
      for (const engine of gridCapableEngines()) for (const model of [null, 'chosen']) {
        const built = buildGridEngineLaunch(engine, { networkId: 'home', networkName: 'Home', baseUrl: relay, apiKey: 'fake-grid-key', ...(model === null ? {} : { model }) },
          { hermesSystemManaged: false, opencodeMajor: 2 })
        if (!built.ok) { out[`${engine}/launch-roundtrip/${model}`] = built; continue }
        const args = [...built.launch.args]
        if (built.launch.configDir) {
          const configs = built.launch.configDir
          const path = join(dir, `config-${engine}-${model}`)
          mkdirSync(path)
          for (const file of configs.files) writeFileSync(join(path, file.name), file.content)
          args.push(...gridConfigHandOff(configs, path).args)
        }
        await assignment(`${engine}/launch-roundtrip/${model}`, engine, args.join(' '))
      }
      const connection = { id: 'saved', provider: 'custom', name: 'Saved', baseUrl: api, keyEnv: 'SAVED_API_KEY', authHeader: 'Authorization', authPrefix: 'Bearer', apiKey: 'fake-saved-key' }
      await assignment('saved/before-save', 'codex', `-c model_providers.saved.base_url=${api} -m chosen`)
      writeFileSync(join(storeDir, 'connections.json'), JSON.stringify({ version: 1, connections: [connection] }))
      shapes.remember()
      out['saved/list'] = shapes.list()
      await assignment('saved/anthropic', 'codex', `-c model_providers.saved.base_url=${api.replace(/\/v1$/, '')} -m chosen`)
      await assignment('saved/openai', 'codex', `-c model_providers.saved.base_url=${api} -m chosen`)
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
      await assignment('saved/after-removal', 'codex', `-c model_providers.saved.base_url=${api} -m chosen`)
      const work = join(dir, 'instructions-empty')
      mkdirSync(work)
      shapes.instructions(work, 'claude')
      out['instructions/no-saved-api'] = readdirSync(work)
      writeFileSync(join(storeDir, 'connections.json'), '{')
      try { shapes.instructions(work, 'claude') } catch (error) { out['instructions/unreadable'] = (error as Error).message }
      shapes.remember() // Best effort recognition never erases remembered endpoints.
      await assignment('saved/unreadable', 'codex', `-c model_providers.saved.base_url=${api} -m chosen`)
      result[os] = out
    }
    const text = JSON.stringify(result, null, 2) + '\n'
    expect(text).not.toContain(root)
    expect(text).not.toContain('fake-saved-key')
    if (process.env.RECORD_GRID_ASSIGNMENT_GOLDEN === '1') writeFileSync(golden, text)
    expect(result).toEqual(JSON.parse(readFileSync(golden, 'utf8')))
  } finally {
    Object.defineProperty(process, 'platform', platform)
    vi.resetModules()
    rmSync(root, { recursive: true, force: true })
  }
})
