import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeAppEngine, type FakeAppEngine, type FakeEngineStart } from './__fixtures__/fakeAppEngine.js'
import { APP_CONTEXT, appContext, appEngineOps, AppStartError, cacheName, llamaServerArgs, lmsKey, scanAppModels,
  type AppEngineOps, type AppEngineRecord, type AppModel } from './appModels.js'
import { processExists } from './processLiveness.js'

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
        // An MLX folder's window and tool calls are in `config` (the scan reads its config.json), not `gguf`.
        { name: 'mlx-community/Qwen3-4B-4bit', format: 'mlx', source: 'lm-studio', bytes: 2e9, path: `${root}/mlx-community/Qwen3-4B-4bit`,
          config: { contextLength: 131072, toolCalls: true, kvBytesPerToken: 73728 }, startWith: { engine: 'lm-studio', label: 'lm-studio' } },
        { name: 'mlx-community/Short-4bit', format: 'mlx', source: 'lm-studio', bytes: 1e9, path: `${root}/mlx-community/Short-4bit`,
          config: { contextLength: 32768, toolCalls: true }, startWith: { engine: 'lm-studio', label: 'lm-studio' } },
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
        binary: lms, sizeBytes: 2e9, contextLength: 131072, kvBytesPerToken: 73728 },
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

  it('leaves a quit LM Studio closed on Stop, and still unloads from one that is only slow', async () => {
    const record = { spec: 1 as const, modelId: 'app:lm-studio:m.gguf', grid: 'g', engine: 'lm-studio' as const, name: 'm',
      served: 'm', alias: 'm', port: 1234, binary: '/home/me/.lmstudio/bin/lms', startedServer: true }
    const seen: string[][] = []
    const run = async (_file: string, args: string[]) => { seen.push(args); return { ok: true, stdout: '', stderr: '' } }
    const fails = (error: unknown) => (async () => { throw error }) as unknown as typeof fetch
    // Nothing listens: LM Studio was quit (undici's shape, and a bare socket error's).
    await appEngineOps({}, fails(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), run).stop(record)
    await appEngineOps({}, fails(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })), run).stop(record)
    expect(seen).toEqual([])
    // Up and answering, or busy past the timeout: the model is still loaded there.
    const open = (async () => new Response(JSON.stringify({ data: [{ id: 'm', state: 'loaded' }] }))) as unknown as typeof fetch
    await appEngineOps({}, open, run).stop(record)
    await appEngineOps({}, fails(new DOMException('timed out', 'TimeoutError')), run).stop(record)
    expect(seen).toEqual([['unload', 'm'], ['server', 'stop'], ['unload', 'm'], ['server', 'stop']])
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
  it("gives a harness's model one slot and its whole window", () => {
    const args = llamaServerArgs({ ref: '/m/gemma-4-E2B-it-Q4_K_M.gguf', name: 'gemma-4-E2B-it-Q4_K_M' }, 131072, 41001)
    expect(args).toEqual(['-m', '/m/gemma-4-E2B-it-Q4_K_M.gguf', '--alias', 'gemma-4-E2B-it-Q4_K_M', '--ctx-size', '131072', '--parallel', '1',
      '-ngl', '999', '--host', '127.0.0.1', '--port', '41001'])
  })
})

// A port picked here and freed for the engine could be taken by any process before the engine bound it. The engine
// picks its own (port 0) and says which in its log; these run a fake that does what Ollama 0.32.6 and llama.cpp 9550 do.
describe.skipIf(process.platform === 'win32')('an engine started on a port it picks itself', () => {
  const ops = appEngineOps({ PATH: process.env.PATH })
  const ollama = (binary: string): AppModel =>
    ({ id: 'app:ollama:qwen3:8b', name: 'qwen3:8b', app: 'ollama', engine: 'ollama', ref: 'qwen3:8b', binary, sizeBytes: GiB })
  const llama = (binary: string): AppModel =>
    ({ id: 'app:llama.cpp:tiny Q4.gguf', name: 'tiny Q4', app: 'llama.cpp', engine: 'llama.cpp', ref: '/m/tiny Q4.gguf', binary, sizeBytes: GiB })
  const record = (model: AppModel, started: Awaited<ReturnType<AppEngineOps['start']>>): AppEngineRecord =>
    ({ spec: 1, modelId: model.id, grid: 'g', name: model.name, ...started })
  const fakes: FakeAppEngine[] = []
  const fake = (...args: Parameters<typeof fakeAppEngine>) => { const made = fakeAppEngine(...args); fakes.push(made); return made }
  let logs: string
  beforeEach(() => { logs = mkdtempSync(join(tmpdir(), 'app-logs-')) })
  afterEach(() => { for (const made of fakes.splice(0)) made.dispose(); rmSync(logs, { recursive: true, force: true }) })

  it.each([
    ['ollama', ollama, 'ollama-qwen3%3A8b.log', (start: FakeEngineStart) => start.host, '127.0.0.1:0'],
    ['llama.cpp', llama, 'llama-tiny%20Q4.log', (start: FakeEngineStart) => start.argv.slice(-2).join(' '), '--port 0'],
  ] as const)('starts %s on port 0 and records the port the engine says it bound', async (kind, model, log, asked, zero) => {
    const engine = fake(kind), mine = model(engine.binary)
    const started = await ops.start(mine, 65536, logs)
    const [seen] = engine.starts()
    expect(asked(seen)).toBe(zero)
    expect(seen.port).toBeGreaterThan(0)
    expect(started).toMatchObject({ engine: kind, port: seen.port, pid: seen.pid })
    expect(readdirSync(logs)).toEqual([log])
    expect(await ops.alive(record(mine, started))).toBe(true)
    await ops.stop(record(mine, started))
    expect(processExists(seen.pid)).toBe(false)
  })

  it("empties a model's log at each start, so the port read is this run's", async () => {
    const engine = fake('ollama'), mine = ollama(engine.binary)
    await ops.stop(record(mine, await ops.start(mine, 65536, logs)))
    const again = await ops.start(mine, 65536, logs)
    expect(again.port).toBe(engine.starts()[1].port)
    expect(readFileSync(join(logs, 'ollama-qwen3%3A8b.log'), 'utf8').match(/Listening on/g)).toHaveLength(1)
    await ops.stop(record(mine, again))
  })

  // An engine from an earlier start can still run (the model on another grid, an Ollama whose start failed). Given the
  // same file emptied, it wrote on at its own offset, into the lines a later start reads its port from.
  it('starts each run on a log of its own, which an engine still running from an earlier start never writes into', async () => {
    const engine = fake('ollama'), mine = ollama(engine.binary)
    const earlier = await ops.start(mine, 65536, logs)
    const again = await ops.start(mine, 65536, logs)
    expect(again.port).toBe(engine.starts()[1].port)
    expect((await fetch(`http://127.0.0.1:${earlier.port}/from-the-earlier-engine`)).status).toBe(200)
    expect(readFileSync(join(logs, 'ollama-qwen3%3A8b.log'), 'utf8')).not.toContain('from-the-earlier-engine')
    await ops.stop(record(mine, earlier))
    await ops.stop(record(mine, again))
  })

  it.each([
    ['ollama', ollama, 'Ollama could not start. Try again.'],
    ['llama.cpp', llama, 'llama.cpp could not load the model. Try again.'],
  ] as const)('says %s could not start, at once, when it exits before naming a port', async (kind, model, message) => {
    const began = Date.now()
    const error = await ops.start(model(fake(kind, 'exits').binary), 65536, logs).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(AppStartError)
    expect((error as Error).message).toBe(message)
    expect(Date.now() - began).toBeLessThan(10_000)
  })

  it('stops a llama.cpp too old to say its port, and says to update it', async () => {
    const engine = fake('llama.cpp', 'port-zero')
    const error = await ops.start(llama(engine.binary), 65536, logs).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(AppStartError)
    expect((error as Error).message).toBe('Update llama.cpp to build 4240 or newer, then try again.')
    await vi.waitFor(() => expect(processExists(engine.starts()[0].pid)).toBe(false))
  })

  it('reads the whole port from a line that arrives in two writes', async () => {
    const engine = fake('ollama', 'split-line'), mine = ollama(engine.binary)
    const started = await ops.start(mine, 65536, logs)
    expect(started.port).toBe(engine.starts()[0].port)
    await ops.stop(record(mine, started))
  })

  it('does not take the line llama.cpp printed before loading for its port', async () => {
    const engine = fake('llama.cpp', 'early-line'), mine = llama(engine.binary)
    const started = await ops.start(mine, 65536, logs)
    expect(started.port).toBe(engine.starts()[0].port)
    await ops.stop(record(mine, started))
  })
})
