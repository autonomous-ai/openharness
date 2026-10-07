import { describe, expect, it } from 'vitest'
import { APP_CONTEXT, appContext, appEngineOps, cacheName, llamaServerArgs, lmsKey, scanAppModels } from './appModels.js'

const GiB = 1024 ** 3
const grid = { kind: 'llama.cpp', path: '/home/me/.grid/bin/llama-server', version: 'version: 10369', note: "Grid's own engine" }
const gguf = (over: Record<string, unknown> = {}) => ({ format: 'gguf', bytes: 2 * GiB, quant: 'Q4_K_M',
  gguf: { contextLength: 131072, toolCalls: true, kvBytesPerToken: 114688 }, ...over })

/** `fleet models --json` as the scan reads it; anything else fails. */
function fake(found: Record<string, unknown>) {
  const seen: string[][] = []
  const run = async (file: string, args: string[]) => {
    seen.push([file, ...args])
    if (args.includes('models') && args.includes('--json')) return { ok: true, stdout: JSON.stringify(found), stderr: '' }
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

  it("lists LM Studio's models from its folders on disk and never runs `lms`, which would start LM Studio", async () => {
    const lms = '/home/me/.lmstudio/bin/lms', root = '/home/me/.lmstudio/models'
    const { run, seen } = fake({
      machine: { canRun: ['llama.cpp', 'mlx-lm', 'ollama', 'lm-studio'], engines: [grid,
        { kind: 'ollama', path: '/usr/local/bin/ollama', version: '0.32.5' }, { kind: 'lm-studio', path: lms, version: null }] },
      models: [
        gguf({ name: 'gemma-4-E2B-it-Q4_K_M', source: 'lm-studio', path: `${root}/google/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_K_M.gguf`,
          startWith: { engine: 'lm-studio', label: 'lm-studio' } }),
        { name: 'mlx-community/Qwen3-4B-4bit', format: 'mlx', source: 'lm-studio', bytes: 2e9, path: `${root}/mlx-community/Qwen3-4B-4bit`,
          startWith: { engine: 'lm-studio', label: 'lm-studio' } },
        // A file Ollama shares with LM Studio: the scan's Ollama model, with LM Studio's copy beside it.
        gguf({ name: 'qwen3:8b', source: 'ollama', path: '/m/blobs/sha256-a', startWith: { engine: 'ollama', label: 'ollama' },
          alsoAt: [{ source: 'lm-studio', path: `${root}/ollama-reuse/qwen3-8b/qwen3-8b.gguf`, name: null }] }),
        gguf({ name: 'short', source: 'lm-studio', path: `${root}/old/short.gguf`, gguf: { contextLength: 8192, toolCalls: true } }),
        gguf({ name: 'no-tools', source: 'lm-studio', path: `${root}/org/no-tools.gguf`, gguf: { contextLength: 131072, toolCalls: false } }),
      ],
    })
    const models = await scanAppModels({ node: '/node', packageDir: '/pkg', env: {}, run })
    expect(seen).toEqual([['/node', '/pkg/toolchain/fleet.mjs', 'models', '--json']])
    expect(models.filter(m => m.app === 'lm-studio')).toEqual([
      { id: 'app:lm-studio:gemma-4-E2B-it-Q4_K_M.gguf', name: 'gemma-4-E2B-it-Q4_K_M', app: 'lm-studio', engine: 'lm-studio',
        ref: `${root}/google/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_K_M.gguf`, binary: lms,
        sizeBytes: 2 * GiB, quant: 'Q4_K_M', contextLength: 131072, kvBytesPerToken: 114688 },
      { id: 'app:lm-studio:Qwen3-4B-4bit', name: 'Qwen3-4B-4bit', app: 'lm-studio', engine: 'lm-studio', ref: `${root}/mlx-community/Qwen3-4B-4bit`,
        binary: lms, sizeBytes: 2e9 },
      { id: 'app:lm-studio:qwen3-8b.gguf', name: 'qwen3-8b', app: 'lm-studio', engine: 'lm-studio', ref: `${root}/ollama-reuse/qwen3-8b/qwen3-8b.gguf`,
        binary: lms, sizeBytes: 2 * GiB, quant: 'Q4_K_M', contextLength: 131072, kvBytesPerToken: 114688 },
    ])
  })

  it("finds LM Studio's key for a file from `lms ls`, wherever its models folder is", () => {
    const listed = [
      { modelKey: 'qwen2.5-0.5b-instruct', path: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q8_0.gguf' },
      { modelKey: 'other', path: 'Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q8_0.gguf' },
      { modelKey: 'qwen3-4b', path: 'mlx-community\\Qwen3-4B-4bit' },
    ]
    expect(lmsKey(listed, '/Volumes/AI/lms/Qwen/Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q8_0.gguf')).toBe('qwen2.5-0.5b-instruct')
    expect(lmsKey(listed, 'C:\\Users\\me\\.lmstudio\\models\\mlx-community\\Qwen3-4B-4bit')).toBe('qwen3-4b')
    expect(lmsKey(listed, '/home/me/.lmstudio/models/x/Qwen3-4B-4bit')).toBe('')
  })

  it('starts an LM Studio model by the key `lms ls` gives its file, and says so when LM Studio does not list it', async () => {
    const lms = '/home/me/.lmstudio/bin/lms', file = '/home/me/.lmstudio/models/google/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_K_M.gguf'
    const model = { id: 'app:lm-studio:gemma-4-E2B-it-Q4_K_M.gguf', name: 'gemma-4-E2B-it-Q4_K_M', app: 'lm-studio' as const, engine: 'lm-studio' as const,
      ref: file, binary: lms, sizeBytes: 2 * GiB }
    const seen: string[][] = []
    const run = async (_file: string, args: string[]) => {
      seen.push(args)
      if (args[0] === 'ls') return { ok: true, stdout: JSON.stringify([{ modelKey: 'google/gemma-4-e2b', path: 'google/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_K_M.gguf' }]), stderr: '' }
      if (args[0] === 'server') return { ok: true, stdout: JSON.stringify({ running: true, port: 1234 }), stderr: '' }
      return { ok: true, stdout: '', stderr: '' }
    }
    const ops = appEngineOps({}, fetch, run)
    expect(await ops.start(model, 65536, '/tmp/logs')).toMatchObject({ engine: 'lm-studio', served: model.name, port: 1234 })
    expect(seen.find(args => args[0] === 'load')?.slice(0, 2)).toEqual(['load', 'google/gemma-4-e2b'])
    await expect(ops.start({ ...model, ref: '/elsewhere/gone.gguf' }, 65536, '/tmp/logs')).rejects.toThrow('LM Studio does not list this model')
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

describe('llama-server for a model', () => {
  const model = { ref: '/m/Laya-Q8_0.gguf', name: 'laya-english' }

  it("gives a harness's model one slot and its whole window", () => {
    const args = llamaServerArgs(model, 131072, 41001)
    expect(args).toEqual(['-m', '/m/Laya-Q8_0.gguf', '--alias', 'laya-english', '--ctx-size', '131072', '--parallel', '1',
      '-ngl', '999', '--host', '127.0.0.1', '--port', '41001'])
  })

  it('shares one window between several slots, so any one request can still use all of it', () => {
    const args = llamaServerArgs(model, 8192, 41001, 4)
    expect(args.slice(args.indexOf('--ctx-size'), args.indexOf('-ngl'))).toEqual(['--ctx-size', '8192', '--parallel', '4', '--kv-unified'])
  })
})
