import { describe, expect, it } from 'vitest'
import { APP_CONTEXT, appContext, cacheName, scanAppModels } from './appModels.js'

const GiB = 1024 ** 3
const grid = { kind: 'llama.cpp', path: '/home/me/.grid/bin/llama-server', version: 'version: 10369', note: "Grid's own engine" }
const gguf = (over: Record<string, unknown> = {}) => ({ format: 'gguf', bytes: 2 * GiB, quant: 'Q4_K_M',
  gguf: { contextLength: 131072, toolCalls: true, kvBytesPerToken: 114688 }, ...over })

/** `fleet models --json` and `lms ls --json` as the scan reads them; anything else fails. */
function fake(found: Record<string, unknown>, lms: unknown[] = []) {
  const seen: string[][] = []
  const run = async (file: string, args: string[]) => {
    seen.push([file, ...args])
    if (args.includes('models') && args.includes('--json')) return { ok: true, stdout: JSON.stringify(found), stderr: '' }
    if (args[0] === 'ls') return { ok: true, stdout: JSON.stringify(lms), stderr: '' }
    return { ok: false, stdout: '', stderr: 'unexpected' }
  }
  return { run, seen }
}

describe('models other apps downloaded', () => {
  it("lists Ollama's and llama.cpp's from the Model Manager's scan, each started by its own app", async () => {
    const { run, seen } = fake({
      machine: { canRun: ['llama.cpp', 'mlx-lm', 'ollama', 'lm-studio'], engines: [grid,
        { kind: 'ollama', path: '/usr/local/bin/ollama', version: '0.32.5' },
        { kind: 'llama.cpp', path: '/opt/homebrew/bin/llama-server', version: 'version: 9000' }] },
      models: [
        gguf({ name: 'llama3.2:3b', source: 'ollama', path: '/m/blobs/sha256-a', realPath: '/m/blobs/sha256-a', startWith: { engine: 'ollama', label: 'ollama', running: false } }),
        gguf({ name: 'ggml-org_gemma-4-E2B-it-GGUF_gemma-4-E2B-it-Q4_K_M', source: 'llama.cpp', path: '/c/ggml-org_gemma-4-E2B-it-GGUF_gemma-4-E2B-it-Q4_K_M.gguf',
          startWith: { engine: 'llama.cpp', label: 'your llama.cpp', path: '/opt/homebrew/bin/llama-server' } }),
        // Newer llama.cpp downloads into the Hugging Face cache: with llama.cpp here, that file is its.
        gguf({ name: 'unsloth/Qwen3-4B-Instruct-2507-GGUF', source: 'huggingface',
          path: '/h/models--unsloth--Qwen3-4B-Instruct-2507-GGUF/snapshots/a0/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
          startWith: { engine: 'llama.cpp', label: 'your llama.cpp', path: '/opt/homebrew/bin/llama-server' } }),
        // Grid's own folder is listed by the catalog path already; the Hugging Face cache and folders are not an app's.
        gguf({ name: 'Qwen3.6-35B', source: 'grid', path: '/g/Qwen.gguf', startWith: { engine: 'llama.cpp', label: "Grid's llama.cpp" } }),
        gguf({ name: 'Loose', source: 'folder', path: '/d/Loose.gguf', startWith: { engine: 'llama.cpp', label: "Grid's llama.cpp" } }),
      ],
    })
    const models = await scanAppModels({ node: '/node', packageDir: '/pkg', env: {}, run })
    expect(seen[0]).toEqual(['/node', '/pkg/toolchain/fleet.mjs', 'models', '--json'])
    expect(models).toEqual([
      { id: 'app:ollama:llama3.2:3b', name: 'llama3.2:3b', app: 'ollama', engine: 'ollama', ref: 'llama3.2:3b', binary: '/usr/local/bin/ollama',
        sizeBytes: 2 * GiB, quant: 'Q4_K_M', contextLength: 131072, kvBytesPerToken: 114688 },
      { id: 'app:llama.cpp:ggml-org_gemma-4-E2B-it-GGUF_gemma-4-E2B-it-Q4_K_M.gguf', name: 'gemma-4-E2B-it-Q4_K_M', app: 'llama.cpp', engine: 'llama.cpp',
        ref: '/c/ggml-org_gemma-4-E2B-it-GGUF_gemma-4-E2B-it-Q4_K_M.gguf', binary: '/opt/homebrew/bin/llama-server',
        sizeBytes: 2 * GiB, quant: 'Q4_K_M', contextLength: 131072, kvBytesPerToken: 114688 },
      { id: 'app:llama.cpp:Qwen3-4B-Instruct-2507-Q4_K_M.gguf', name: 'Qwen3-4B-Instruct-2507-Q4_K_M', app: 'llama.cpp', engine: 'llama.cpp',
        ref: '/h/models--unsloth--Qwen3-4B-Instruct-2507-GGUF/snapshots/a0/Qwen3-4B-Instruct-2507-Q4_K_M.gguf', binary: '/opt/homebrew/bin/llama-server',
        sizeBytes: 2 * GiB, quant: 'Q4_K_M', contextLength: 131072, kvBytesPerToken: 114688 },
    ])
  })

  it("falls back to Grid's llama.cpp only when the app is not installed, and only for what a coding agent can run", async () => {
    const { run } = fake({
      machine: { canRun: ['llama.cpp'], engines: [grid, { kind: 'lm-studio', path: '/Applications/LM Studio.app', version: null }] },
      models: [
        gguf({ name: 'qwen3:8b', source: 'ollama', path: '/m/blobs/sha256-b', startWith: { engine: 'llama.cpp', label: "Grid's llama.cpp" } }),
        gguf({ name: 'Studio-Q4_K_M', source: 'lm-studio', path: '/s/Studio-Q4_K_M.gguf', startWith: { engine: 'llama.cpp', label: "Grid's llama.cpp" } }),
        // Without llama.cpp, a Hugging Face cache GGUF is nobody's app download: not listed.
        gguf({ name: 'org/Cached-GGUF', source: 'huggingface', path: '/h/Cached-Q4_K_M.gguf', startWith: { engine: 'llama.cpp', label: "Grid's llama.cpp" } }),
        gguf({ name: 'short:1b', source: 'ollama', path: '/m/blobs/sha256-c', gguf: { contextLength: 32768, toolCalls: true }, startWith: { engine: 'llama.cpp' } }),
        gguf({ name: 'chat-only:1b', source: 'ollama', path: '/m/blobs/sha256-d', gguf: { contextLength: 131072, toolCalls: false }, startWith: { engine: 'llama.cpp' } }),
        gguf({ name: 'half:7b', source: 'ollama', path: '/m/blobs/sha256-e', missingFiles: 1, startWith: { engine: 'llama.cpp' } }),
        gguf({ name: 'new-arch:7b', source: 'ollama', path: '/m/blobs/sha256-f', gguf: { contextLength: 131072, unsupportedTensorTypes: [143] }, startWith: { engine: 'llama.cpp' } }),
      ],
    })
    const models = await scanAppModels({ node: '/node', packageDir: '/pkg', env: {}, run })
    expect(models.map(m => [m.name, m.app, m.engine, m.ref])).toEqual([
      ['qwen3:8b', 'ollama', 'grid', '/m/blobs/sha256-b'],
      // LM Studio's app is there but has no `lms` yet: its GGUF is still a file Grid's engine reads.
      ['Studio-Q4_K_M', 'lm-studio', 'grid', '/s/Studio-Q4_K_M.gguf'],
    ])
  })

  it("lists LM Studio's models from `lms ls`, the only place that names the key `lms load` takes", async () => {
    const lms = '/home/me/.lmstudio/bin/lms'
    const { run } = fake({
      machine: { canRun: ['llama.cpp', 'mlx-lm', 'ollama', 'lm-studio'], engines: [grid, { kind: 'lm-studio', path: lms, version: null }] },
      // The scan's view of the same files is not used: it knows paths, not keys.
      models: [gguf({ name: 'gemma-4-E2B-it-Q4_K_M', source: 'lm-studio', path: '/s/g.gguf', startWith: { engine: 'lm-studio', label: 'lm-studio' } })],
    }, [
      { type: 'llm', modelKey: 'google/gemma-4-e2b', format: 'gguf', sizeBytes: 4414806160, trainedForToolUse: true, maxContextLength: 131072 },
      { type: 'llm', modelKey: 'mlx-community/qwen3-4b', format: 'mlx', sizeBytes: 2e9, maxContextLength: 262144 },
      { type: 'embedding', modelKey: 'text-embedding-nomic', format: 'gguf', sizeBytes: 84106624, maxContextLength: 2048 },
      { type: 'llm', modelKey: 'old/short', format: 'gguf', sizeBytes: 1e9, maxContextLength: 8192 },
      { type: 'llm', modelKey: 'org/no-tools', format: 'gguf', sizeBytes: 1e9, maxContextLength: 131072, trainedForToolUse: false },
    ])
    const models = await scanAppModels({ node: '/node', packageDir: '/pkg', env: {}, run })
    expect(models).toEqual([
      { id: 'app:lm-studio:google/gemma-4-e2b', name: 'gemma-4-e2b', app: 'lm-studio', engine: 'lm-studio', ref: 'google/gemma-4-e2b', binary: lms,
        sizeBytes: 4414806160, contextLength: 131072 },
      { id: 'app:lm-studio:mlx-community/qwen3-4b', name: 'qwen3-4b', app: 'lm-studio', engine: 'lm-studio', ref: 'mlx-community/qwen3-4b', binary: lms,
        sizeBytes: 2e9, contextLength: 262144 },
    ])
  })

  it('is no models, never an error, without the Model Manager or with a scan that fails', async () => {
    expect(await scanAppModels({ node: '/node', packageDir: null, env: {} })).toEqual([])
    const failing = async () => ({ ok: false, stdout: '', stderr: 'boom' })
    expect(await scanAppModels({ node: '/node', packageDir: '/pkg', env: {}, run: failing })).toEqual([])
    const garbled = async () => ({ ok: true, stdout: 'not json', stderr: '' })
    expect(await scanAppModels({ node: '/node', packageDir: '/pkg', env: {}, run: garbled })).toEqual([])
  })

  it('gives 128K when it fits beside the weights, 64K when only that does, and nothing below', () => {
    const model = { sizeBytes: 2 * GiB, contextLength: 131072, kvBytesPerToken: 112 * 1024 }
    expect(appContext(model, 54 * GiB)).toBe(APP_CONTEXT)
    expect(appContext(model, 2.2 * GiB + 2 * GiB + 8 * GiB)).toBe(65536)
    expect(appContext(model, 4 * GiB)).toBeNull()
    expect(appContext({ ...model, contextLength: 65536 }, 54 * GiB)).toBe(65536)
    expect(appContext({ sizeBytes: 2 * GiB }, undefined)).toBe(APP_CONTEXT)
  })

  it("reads llama.cpp's download names as the file's own", () => {
    expect(cacheName('ggml-org_gemma-4-E2B-it-GGUF_gemma-4-E2B-it-Q4_K_M.gguf')).toBe('gemma-4-E2B-it-Q4_K_M')
    expect(cacheName('plain-model-Q4_K_M')).toBe('plain-model-Q4_K_M')
  })
})
