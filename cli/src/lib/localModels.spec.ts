import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { compatibleModels, LocalModels, readRunRecords, type GridInventory } from './localModels.js'
import { GridFleetRpc, type GridFleetResult } from './gridFleetRpc.js'
import { encryptDownFrame, encryptRpcResult } from './e2ee/applicationFrames.js'

const card = (id = 'org/Small-GGUF') => ({ repo_id: id, runnable: true, task: 'text-generation', format: 'GGUF',
  fit: { version: 'Q4', ctx: 32768, size: 64 },
  versions: [{ version: 'Q4', size_bytes: 64, pull_spec: `${id}:Small-Q4.gguf`, urls: ['https://example.test/Small-Q4.gguf'] }] })
const ok = (value: unknown = {}) => ({ ok: true, code: 0, stdout: JSON.stringify(value), stderr: '', error: null })
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
let root: string, home: string, stateDir: string, records: string
let calls: string[][], serving: boolean, catalogCards: ReturnType<typeof card>[], service: LocalModels
let request: Mock<(url: string | URL, init?: RequestInit) => Promise<Response>>
let run: Mock<(args: string[], output?: (s: string) => void) => Promise<GridFleetResult>>
let downloadFails: boolean, catalogFails: boolean
// What the grid says it serves. Production reads it without a credential (`gridModels.gridInventory`);
// here it is the scenario the fake `grid` below answers for `engines`, so each test keeps its meaning,
// and `gridState` is what the grid's own answer said about it.
let gridState: GridInventory['state']
let inventory: Mock<(grid: string, force: boolean) => Promise<GridInventory>>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'local-models-'))
  home = join(root, 'grid'); stateDir = join(root, 'receipts'); records = join(home, 'run', 'engines', 'grid-home')
  await mkdir(records, { recursive: true }); await mkdir(join(home, 'models'))
  await writeFile(join(home, 'credentials.toml'), 'session_token = "test-only-token"\napi_url = "https://catalog.example.test"\n')
  calls = []; serving = false; catalogCards = [card()]; downloadFails = false; catalogFails = false
  run = vi.fn(async (args: string[], output?: (s: string) => void) => {
    calls.push(args)
    if (args[0] === 'device-info') return ok({ device_class: 'apple-silicon', backend: 'metal', usable_bytes: 54 * 1024 ** 3, memory: { total_gb: 64 } })
    if (args.includes('ls')) return ok([{ grid: 'home', id: 'grid-home' }])
    if (args.includes('engines')) return ok(serving ? [{ node_id: 'local-node', online: true, models: ['Small-Q4.gguf'], throughput_tok_s: 17.6,
      vram_used_mb: 99999, answered: { window_seconds: 3600, requests: 4, by_model: [{ model: 'Small-Q4.gguf', requests: 4 }] } }] : [])
    if (args[0] === 'pull') {
      output?.('42%')
      if (downloadFails) return { ...ok(), ok: false, code: 1 }
      await writeFile(join(home, 'models', 'Small-Q4.gguf'), Buffer.alloc(64))
    }
    if (args[0] === 'engine' && args[1] === 'install') {
      await mkdir(join(home, 'bin'), { recursive: true })
      await writeFile(join(home, 'bin', 'llama-server'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    }
    if (args.includes('join')) {
      serving = true
      await writeFile(join(records, 'remote.json'), JSON.stringify({ node_id: 'local-node', engines: [{ endpoint_url: null, models: ['Small-Q4.gguf'] }], advertise_as: [] }))
      await writeFile(join(records, 'remote.heartbeat'), '')
    }
    if (args.includes('leave')) { serving = false; await rm(join(records, 'remote.json'), { force: true }) }
    if (args.includes('info')) return { ...ok(), stdout: "export OPENAI_BASE_URL='https://inference.example.test/v1'\nexport OPENAI_API_KEY='test-inference-token'\n" }
    return ok()
  })
  request = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    if (String(url).includes('/catalog')) {
      if (catalogFails) throw new Error('private raw error must never escape')
      return response({ models: catalogCards, runnable_total: catalogCards.length, pagination: { page: 1, total_pages: 1 } })
    }
    return response({ choices: [{ message: { content: 'ok' } }] })
  })
  gridState = 'awake'
  inventory = vi.fn(async (grid: string) => {
    const answer = await run(['--remote', 'engines', grid, '--json'])
    if (!answer.ok) throw new Error('unreadable')
    return { state: gridState, nodes: gridState === 'awake' ? JSON.parse(answer.stdout) : [] }
  })
  service = new LocalModels({ stateDir, processEnv: { GRID_HOME: home }, run, request: request as typeof fetch, inventory })
})
afterEach(async () => { await service.settled(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }) })

describe('local model discovery and lifecycle', () => {
  it('inspects silently and offers only confirmed compatible chat models', async () => {
    expect(compatibleModels([card()])).toEqual([])
    expect(compatibleModels({ models: [card(), { ...card('no'), runnable: false }, { ...card('image'), task: 'image-generation' }] })).toHaveLength(1)
    const snapshot = await service.list('home')
    expect(snapshot.models).toMatchObject([{ name: 'Small', state: 'available', sizeBytes: 64, canStart: true, canStop: false }])
    expect(snapshot.memoryBytes).toBe(64 * 1024 ** 3)
    expect(calls.some(args => ['pull', 'join', 'leave', 'install'].some(a => args.includes(a)))).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain('test-only-token')
  })

  it('paginates all compatible models and does not fetch incompatible trailing pages', async () => {
    request.mockImplementation(async (_url, init) => {
      const page = JSON.parse(String(init?.body)).page
      return response({ models: [card(`org/Model${page}-GGUF`)], runnable_total: 2, pagination: { page, total_pages: 7 } })
    })
    expect((await service.list('home')).models).toHaveLength(2)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('rejects catalog pagination that repeats a page', async () => {
    request.mockResolvedValue(response({ models: [card()], runnable_total: 100, pagination: { page: 1, total_pages: 7 } }))
    // Fresh Response objects (bodies are single-consumption).
    request.mockImplementation(async () => response({ models: [card()], runnable_total: 100, pagination: { page: 1, total_pages: 7 } }))
    expect((await service.list('home')).error).toContain('incomplete')
  })

  it('downloads, loads and verifies without another user step', async () => {
    const ack = await service.act('home', 'org/Small-GGUF', 'start')
    expect(ack.operation?.phase).toBe('running')
    await service.settled()
    const snapshot = await service.list('home')
    expect(snapshot.models[0]).toMatchObject({ state: 'running', canStop: true,
      tokensPerSecond: 17.6, requests: 4, windowSeconds: 3600, operation: { phase: 'done', stage: 'verifying' } })
    expect(snapshot.models[0]).not.toHaveProperty('memoryBytes')
    expect(calls.find(args => args.includes('join'))).toEqual(['--remote', 'join', 'home', '--serve', 'Small-Q4.gguf', '--max-concurrency', '1', '--ctx-size', '16384', '--reasoning-budget', '0'])
    expect(request.mock.calls.some(([url]) => String(url).includes('chat/completions'))).toBe(true)
    expect(await readFile(join(stateDir, (await readdir(stateDir))[0]), 'utf8')).not.toContain('token')
  })

  it('uses an already downloaded complete file, and Stop retains it', async () => {
    await writeFile(join(home, 'models', 'Small-Q4.gguf'), Buffer.alloc(64))
    expect((await service.list('home')).models[0].state).toBe('downloaded')
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect(calls.some(args => args[0] === 'pull')).toBe(false)
    await service.act('home', 'org/Small-GGUF', 'stop'); await service.settled()
    expect(calls.find(args => args.includes('leave'))).toEqual(['--remote', 'leave', 'home', '--engine', 'Small-Q4.gguf'])
    expect((await stat(join(home, 'models', 'Small-Q4.gguf'))).size).toBe(64)
    expect((await service.list('home')).models[0]).toMatchObject({ state: 'downloaded', canStop: false, canStart: true })
  })

  it('reuses the installed engine on subsequent starts', async () => {
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    await service.act('home', 'org/Small-GGUF', 'stop'); await service.settled()
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect(calls.filter(args => args[0] === 'engine' && args[1] === 'install')).toHaveLength(1)
    expect(calls.filter(args => args[0] === 'pull')).toHaveLength(1)
  })

  it('does not count partial files as downloaded', async () => {
    await writeFile(join(home, 'models', 'Small-Q4.gguf'), Buffer.alloc(12))
    await writeFile(join(home, 'models', 'Small-Q4.gguf.part'), Buffer.alloc(64))
    expect((await service.list('home')).models[0].state).toBe('available')
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect(calls.some(args => args[0] === 'pull')).toBe(true)
  })

  it('joins repeated clicks, serializes other models, and keeps status independent of its caller', async () => {
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const original = request.getMockImplementation()!
    request.mockImplementation(async (url, init) => { if (String(url).includes('chat/completions')) await barrier; return original(url, init) })
    const first = await service.act('home', 'org/Small-GGUF', 'start')
    const second = await service.act('home', 'org/Small-GGUF', 'start')
    expect(second.operation?.id).toBe(first.operation?.id)
    expect((await service.act('home', 'other', 'start')).error).toContain('Wait')
    await vi.waitFor(() => expect(request.mock.calls.some(([url]) => String(url).includes('chat/completions'))).toBe(true))
    expect((await service.list('home')).models[0].operation).toMatchObject({ stage: 'verifying', phase: 'running' })
    release(); await service.settled()
    expect(calls.filter(args => args.includes('join'))).toHaveLength(1)
  })

  it('reports a failed download and retries it without starting an incomplete model', async () => {
    downloadFails = true
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect((await service.list('home')).models[0].operation).toMatchObject({ phase: 'failed', error: 'The download stopped. Start again to resume.' })
    expect(calls.some(args => args.includes('join'))).toBe(false)
    downloadFails = false
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect((await service.list('home')).models[0].operation?.phase).toBe('done')
  })

  it('keeps a failed Grid registration refresh retryable without starting or downloading', async () => {
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => args.includes('sync') ? { ...ok(), ok: false } : original(args, output))
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect((await service.list('home')).models[0].operation).toMatchObject({ phase: 'failed', stage: 'checking' })
    expect(calls.some(args => args.includes('join') || args.includes('pull'))).toBe(false)
    run.mockImplementation(original)
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect((await service.list('home')).models[0].state).toBe('running')
  })

  it('never offers Stop for an external endpoint or another machine', async () => {
    serving = true
    await writeFile(join(records, 'remote.json'), JSON.stringify({ node_id: 'local-node', engines: [{ endpoint_url: 'http://localhost:1234', models: ['Small-Q4.gguf'] }] }))
    await writeFile(join(records, 'remote.heartbeat'), '')
    const snapshot = await service.list('home')
    expect(snapshot.models[0].canStop).toBe(false)
    await service.act('home', 'org/Small-GGUF', 'stop'); await service.settled()
    expect(calls.some(args => args.includes('leave'))).toBe(false)
  })

  it('keeps existing local engines visible when the catalog cannot be reached', async () => {
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    catalogFails = true
    const fresh = new LocalModels({ stateDir, processEnv: { GRID_HOME: home }, run, request: request as typeof fetch , inventory })
    const snapshot = await fresh.list('home')
    expect(snapshot.models[0]).toMatchObject({ state: 'running', canStop: true })
    expect(snapshot.error).toContain('unavailable')
    expect(JSON.stringify(snapshot)).not.toContain('private raw')
  })

  it('does not silently evict an existing model to fit the next one', async () => {
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    const next = card('org/Next-GGUF'); next.versions[0].pull_spec = 'org/Next-GGUF:Next.gguf'; next.versions[0].urls = ['https://example.test/Next.gguf']
    catalogCards = [card(), next]
    await service.list('home', true)
    request.mockImplementation(async (_url, init) => response({ models: JSON.parse(String(init?.body)).device.usable_bytes < 54 * 1024 ** 3 ? [] : catalogCards, pagination: { total_pages: 1 } }))
    await service.act('home', 'org/Next-GGUF', 'start'); await service.settled()
    const snapshot = await service.list('home')
    expect(snapshot.models.find(m => m.id === 'org/Next-GGUF')?.operation?.error).toContain('Stop Small-Q4 first')
    expect(calls.some(args => args.includes('leave'))).toBe(false)
  })

  it('rejects arbitrary model ids without passing them to Grid', async () => {
    await service.act('home', '--serve /arbitrary', 'start'); await service.settled()
    expect(calls.some(args => args.includes('--serve /arbitrary'))).toBe(false)
    expect(calls.some(args => args[0] === 'pull')).toBe(false)
  })

  it('imports an existing local setup, keeps it after Stop, and can start it again', async () => {
    catalogCards = []
    serving = true
    await writeFile(join(home, 'models', 'Small-Q4.gguf'), Buffer.alloc(64))
    await writeFile(join(records, 'remote.json'), JSON.stringify({ node_id: 'local-node', meta_name: 'This computer', ctx_size: 8192,
      engines: [{ endpoint_url: null, models: ['Small-Q4.gguf'] }], advertise_as: ['Small-Q4.gguf'] }))
    await writeFile(join(records, 'remote.heartbeat'), '')
    const first = await service.list('home')
    expect(first.models[0]).toMatchObject({ id: 'local:Small-Q4.gguf', state: 'running', canStop: true })
    await service.act('home', first.models[0].id, 'stop'); await service.settled()
    const fresh = new LocalModels({ stateDir, processEnv: { GRID_HOME: home }, run, request: request as typeof fetch , inventory })
    expect((await fresh.list('home')).models[0]).toMatchObject({ state: 'downloaded', canStart: true })
    await fresh.act('home', first.models[0].id, 'start'); await fresh.settled()
    expect(calls.some(args => args[0] === 'pull')).toBe(false)
    expect((await fresh.list('home')).models[0].operation?.phase).toBe('done')
  })

  it.each(['current', 'legacy', 'malformed'])('preserves imported routing names across restart with %s receipts', async scenario => {
    catalogCards = []; serving = true
    await writeFile(join(home, 'models', 'Small-Q4.gguf'), Buffer.alloc(64))
    await writeFile(join(records, 'remote.json'), JSON.stringify({ node_id: 'local-node',
      engines: [{ models: ['Small-Q4.gguf'] }], advertise_as: ['team/my-model'] }))
    await writeFile(join(records, 'remote.heartbeat'), '')
    const id = (await service.list('home')).models[0].id
    await service.act('home', id, 'stop'); await service.settled()
    const path = join(stateDir, (await readdir(stateDir)).find(name => name.endsWith('.known.json'))!)
    const saved = JSON.parse(await readFile(path, 'utf8'))
    expect(saved[0].aliases).toEqual(['team/my-model'])
    if (scenario === 'legacy') delete saved[0].aliases
    if (scenario === 'malformed') saved[0].aliases = [42, '', '--invalid', 'invalid\nname']
    await writeFile(path, JSON.stringify(saved))
    const fresh = new LocalModels({ stateDir, processEnv: { GRID_HOME: home }, run, request: request as typeof fetch , inventory })
    await fresh.act('home', id, 'start'); await fresh.settled()
    const expectedAlias = scenario === 'current' ? 'team/my-model' : scenario === 'legacy' ? 'my-model' : null
    const joined = calls.find(args => args.includes('join'))!
    expect(joined.slice(11)).toEqual(expectedAlias ? ['--advertise-as', expectedAlias] : [])
    const inference = request.mock.calls.find(([url]) => String(url).includes('chat/completions'))!
    expect(JSON.parse(String(inference[1]?.body)).model).toBe(expectedAlias ?? 'Small-Q4.gguf')
    expect((await fresh.list('home')).models[0].operation?.phase).toBe('done')
  })

  it('reuses an already downloaded fitting quant of the same model', async () => {
    catalogCards[0].versions.push({ version: 'Q3', size_bytes: 48, pull_spec: 'org/Small-GGUF:Small-Q3.gguf', urls: ['https://example.test/Small-Q3.gguf'] })
    await writeFile(join(home, 'models', 'Small-Q3.gguf'), Buffer.alloc(48))
    const snapshot = await service.list('home')
    expect(snapshot.models[0]).toMatchObject({ state: 'downloaded', sizeBytes: 48, quant: 'Q3' })
  })

  it('matches the current CLI engine shape without attributing another model’s requests', async () => {
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    const record = JSON.parse(await readFile(join(records, 'remote.json'), 'utf8'))
    record.meta_name = 'My laptop'
    await writeFile(join(records, 'remote.json'), JSON.stringify(record))
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => args.includes('engines') ? ok([{
      name: 'My laptop', online: true, models: ['Small-Q4.gguf'], throughput_tok_s: 12,
      answered: { requests: 99, window_seconds: 86400, by_model: [{ model: 'prior-model', requests: 99 }] },
    }]) : original(args, output))
    const view = await service.list('home')
    expect(view.models[0]).toMatchObject({ state: 'running', tokensPerSecond: 12 })
    expect(view.models[0].requests).toBeUndefined()
  })

  it.each(['small-q4', { model: 'small-q4' }])('matches Grid’s canonical model names after start: %j', async alias => {
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    const record = JSON.parse(await readFile(join(records, 'remote.json'), 'utf8'))
    record.meta_name = 'My laptop'
    await writeFile(join(records, 'remote.json'), JSON.stringify(record))
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => args.includes('engines') ? ok([{
      name: 'My laptop', online: true, models: [alias], throughput_tok_s: 12,
      answered: { requests: 99, window_seconds: 86400, by_model: [
        { model: 'small-q8', requests: 95 }, { model: 'small-q4', requests: 4 },
      ] },
    }]) : original(args, output))
    expect((await service.list('home')).models[0]).toMatchObject({
      state: 'running', canStop: true, tokensPerSecond: 12, requests: 4, windowSeconds: 86400,
    })
  })

  it('assigns an engine only to the downloaded variant when catalog filenames collide', async () => {
    const other = card('org/Small-MTP-GGUF')
    other.versions[0].size_bytes = 80
    catalogCards = [other, card()]
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    const snapshot = await service.list('home')
    expect(snapshot.models.find(m => m.id === 'org/Small-GGUF')).toMatchObject({
      state: 'running', canStop: true, requests: 4,
    })
    expect(snapshot.models.find(m => m.id === other.repo_id)).toMatchObject({
      state: 'available', canStop: false, requests: undefined, tokensPerSecond: undefined,
    })
  })

  it('can still stop a running catalog model after its weights are removed', async () => {
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    await rm(join(home, 'models', 'Small-Q4.gguf'))
    expect((await service.list('home')).models[0]).toMatchObject({ state: 'running', canStop: true })
    await service.act('home', 'org/Small-GGUF', 'stop'); await service.settled()
    expect((await service.list('home')).models[0]).toMatchObject({ state: 'available', canStop: false })
  })

  it('encrypts inventory and lifecycle requests and responses', () => {
    for (const type of ['grid_fleet_models_list', 'grid_fleet_model_start', 'grid_fleet_model_stop']) {
      expect(encryptDownFrame(type)).toBe(true); expect(encryptRpcResult(`${type}_result`)).toBe(true)
    }
  })

  it('coalesces discovery, caches it briefly, and isolates different accounts', async () => {
    const [first, duplicate, other] = await Promise.all([service.list('home'), service.list('home'), service.list('other')])
    expect(duplicate).toEqual(first)
    expect(other.busy).toBe(false)
    expect(calls.filter(args => args[0] === 'device-info')).toHaveLength(1)
    const before = calls.length
    expect(await service.list('other')).toEqual(other)
    expect(calls).toHaveLength(before)
    await service.list('home', true)
    expect(calls.filter(args => args[0] === 'device-info')).toHaveLength(2)
    expect(await service.list(null)).toMatchObject({ models: [], busy: false, error: expect.stringContaining('Sign in') })
    expect((await service.act(null, 'x', 'start')).error).toBeTruthy()
    expect((await service.act('home', {}, 'start')).error).toBeTruthy()
  })

  it.each([
    ['missing credentials', ''],
    ['no session token', 'api_url = "https://catalog.example.test"'],
    ['malformed token', 'session_token = "invalid\\q"'],
  ])('reports sign-in for %s without sending credentials', async (_name, credentials) => {
    await writeFile(join(home, 'credentials.toml'), credentials)
    expect((await service.list('home')).error).toContain('Sign in')
    expect(request).not.toHaveBeenCalled()
  })

  it.each(['http://catalog.example.test', 'file:///tmp/catalog'])('refuses insecure catalog address %s', async base => {
    await writeFile(join(home, 'credentials.toml'), `session_token = 'private'\napi_url = '${base}'`)
    expect((await service.list('home')).error).toContain('address')
    expect(request).not.toHaveBeenCalled()
  })

  it.each(['http://localhost:1234', 'http://127.0.0.1:1234', 'http://[::1]:1234'])('permits an explicitly configured local catalog at %s', async base => {
    await writeFile(join(home, 'credentials.toml'), `session_token = 'test-only-token'\napi_url = '${base}'`)
    expect((await service.list('home')).error).toBeUndefined()
    expect(String(request.mock.calls[0][0])).toBe(`${base}/v1/grid/catalog`)
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'error' })
  })

  it.each([undefined, 'https://alternate.example.test'])('uses the configured or default catalog when the credential store omits it', async base => {
    await writeFile(join(home, 'credentials.toml'), 'session_token = "test-only-token"\n')
    service = new LocalModels({ stateDir, processEnv: { GRID_HOME: home, GRID_CONTROL_PLANE_URL: base }, run, request: request as typeof fetch , inventory })
    await service.list('home')
    expect(String(request.mock.calls[0][0])).toBe(`${base ?? 'https://api-grid.autonomous.ai'}/v1/grid/catalog`)
  })

  it.each(['http failure', 'missing rows', 'empty intermediate page', 'unbounded pages'])('handles a catalog %s without inventing compatibility', async scenario => {
    request.mockImplementation(async (_url, init) => {
      const page = JSON.parse(String(init?.body)).page
      return scenario === 'http failure' ? new Response('private detail', { status: 401 })
        : response(scenario === 'missing rows' ? { error: 'private detail' }
          : { models: scenario === 'empty intermediate page' ? [] : [card()], pagination: { page, total_pages: 101 } })
    })
    const snapshot = await service.list('home')
    expect(snapshot.models).toEqual([])
    expect(snapshot.error).toBeTruthy()
    expect(JSON.stringify(snapshot)).not.toContain('private detail')
    expect(request.mock.calls.length).toBeLessThanOrEqual(100)
  })

  it('supports an unpaginated catalog, prefers a useful small download, and skips unfitted versions', async () => {
    const large = card('org/Large-GGUF'), small = card('org/Fast-GGUF')
    large.versions[0].size_bytes = 20 * 1024 ** 3
    small.versions[0].size_bytes = 2 * 1024 ** 3
    small.versions.push({ ...small.versions[0], version: 'Q8', size_bytes: 4 * 1024 ** 3 })
    small.versions.push({ ...small.versions[0], version: 'unknown', size_bytes: undefined as any })
    request.mockImplementation(async () => response({ models: [large, small] }))
    expect((await service.list('home')).models.map(m => [m.name, m.recommended])).toEqual([['Fast', true], ['Large', false]])
  })

  it.each(['failed command', 'invalid json'])('disables actions when inventory returns %s', async scenario => {
    await service.list('home')
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => args.includes('engines')
      ? { ...ok(), ok: scenario !== 'failed command', stdout: 'not json' } : original(args, output))
    const snapshot = await service.list('home', true)
    expect(snapshot.error).toContain('Running models could not be checked')
    expect(snapshot.models.every(m => !m.canStart && !m.canStop)).toBe(true)
  })

  it.each(['missing grid', 'invalid grid id', 'missing record directory', 'corrupt record'])('ignores %s without exposing a Stop action', async scenario => {
    const original = run.getMockImplementation()!
    if (scenario === 'missing grid' || scenario === 'invalid grid id') {
      run.mockImplementation(async (args, output) => args.includes('ls') ? ok(scenario === 'missing grid' ? [] : [{ grid: 'home', id: '../escape' }]) : original(args, output))
    } else if (scenario === 'missing record directory') await rm(records, { recursive: true })
    else await writeFile(join(records, 'broken.json'), 'not-json')
    expect((await service.list('home')).models[0].canStop).toBe(false)
    expect((await service.list('-invalid', true)).models[0].canStop).toBe(false)
  })

  it.each([
    {}, { engines: [{ models: ['--bad.gguf'] }] }, { engines: [{ models: ['file.bin'] }] },
    { engines: [{ api_kind: 'openai', models: ['Small-Q4.gguf'] }] },
    { engines: [{ models: ['one.gguf', 'two.gguf'] }] },
  ])('does not treat an unowned or malformed run record as a controllable model: %j', async record => {
    await writeFile(join(records, 'remote.json'), JSON.stringify(record))
    expect((await service.list('home')).models[0].canStop).toBe(false)
  })

  it.each(['missing heartbeat', 'offline node', 'ambiguous node', 'missing models', 'missing file'])('does not claim running from %s alone', async scenario => {
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    if (scenario === 'missing heartbeat') await rm(join(records, 'remote.heartbeat'))
    if (scenario === 'missing file') { catalogCards = []; await rm(join(home, 'models', 'Small-Q4.gguf')); serving = false }
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => {
      const result = await original(args, output)
      if (!args.includes('engines') || scenario === 'missing heartbeat' || scenario === 'missing file') return result
      const node = JSON.parse(result.stdout)[0]
      return ok(scenario === 'ambiguous node' ? [node, node] : [{ ...node, ...(scenario === 'offline node' ? { online: false } : { models: null }) }])
    })
    const snapshot = await service.list('home', true)
    expect(snapshot.models[0]).toMatchObject({ canStop: true })
    expect(snapshot.models[0].state).not.toBe('running')
    expect(snapshot.models[0].tokensPerSecond).toBeUndefined()
  })

  it('keeps a missing-file engine stoppable and requires live inventory to call it running', async () => {
    catalogCards = []
    serving = true
    await writeFile(join(records, 'remote.json'), JSON.stringify({ node_id: 'local-node', engines: [{ models: ['Small-Q4.gguf'] }] }))
    await writeFile(join(records, 'remote.heartbeat'), '')
    expect((await service.list('home')).models[0]).toMatchObject({ state: 'running', canStart: false, canStop: true })
    await service.act('home', 'local:Small-Q4.gguf', 'stop'); await service.settled()
    expect(calls.some(args => args.includes('leave'))).toBe(true)
    expect((await service.list('home')).models).toEqual([])
  })

  it('matches object-shaped aliases and never substitutes engine-total request counts', async () => {
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => args.includes('engines') ? ok([{
      id: 'local-node', online: true, models: [{ model: 'SMALL-Q4.GGUF' }],
      answered: { requests: 200, window_seconds: 3600 },
    }]) : original(args, output))
    expect((await service.list('home')).models[0]).toMatchObject({ state: 'running', requests: undefined })
  })

  it('marks an unfinished receipt interrupted after restart without replaying a command', async () => {
    await mkdir(stateDir)
    const hash = createHash('sha256').update('home').digest('hex').slice(0, 24)
    await writeFile(join(stateDir, `${hash}.json`), JSON.stringify({ spec: 1, grid: 'home', operation: {
      id: 'interrupted', modelId: 'org/Small-GGUF', action: 'start', stage: 'downloading', phase: 'running', updatedAt: '2026-01-01T00:00:00Z',
    } }))
    expect((await service.list('home')).models[0].operation).toMatchObject({ phase: 'failed', error: expect.stringContaining('interrupted') })
    expect(calls.some(args => args[0] === 'pull' || args.includes('join'))).toBe(false)
  })

  it.each([{ spec: 9, grid: 'home' }, { spec: 1, grid: 'somebody-else' }])('discards an invalid or different-account receipt: %j', async receipt => {
    await mkdir(stateDir)
    const hash = createHash('sha256').update('home').digest('hex').slice(0, 24)
    await writeFile(join(stateDir, `${hash}.json`), JSON.stringify({ ...receipt, operation: { id: 'private', modelId: 'org/Small-GGUF' } }))
    expect((await service.list('home')).models[0].operation).toBeUndefined()
  })

  it('refuses to start if a durable receipt cannot be created', async () => {
    await writeFile(stateDir, 'not a directory')
    expect((await service.act('home', 'org/Small-GGUF', 'start')).error).toContain('saved')
    expect(calls).toEqual([])
    await rm(stateDir)
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect((await service.list('home')).models[0].operation?.phase).toBe('done')
  })

  it.each(['model no longer fits', 'smaller fit only', 'no machine budget'])('checks changed hardware before downloading: %s', async scenario => {
    await service.list('home')
    if (scenario === 'no machine budget') {
      const original = run.getMockImplementation()!
      run.mockImplementation(async (args, output) => args[0] === 'device-info' ? ok({}) : original(args, output))
    }
    request.mockImplementation(async () => response({ models: scenario === 'smaller fit only'
      ? [{ ...card(), versions: [{ ...card().versions[0], size_bytes: 32 }] }] : [] }))
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect((await service.list('home')).models[0].operation?.error).toContain('make room')
    expect(calls.some(args => args[0] === 'pull' || args.includes('join'))).toBe(false)
  })

  it('does not download when free disk space is insufficient', async () => {
    catalogCards[0].versions[0].size_bytes = Number.MAX_SAFE_INTEGER
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect((await service.list('home')).models[0].operation?.error).toContain('disk space')
    expect(calls.some(args => args[0] === 'pull')).toBe(false)
  })

  it('does not start an incomplete download even after the downloader exits successfully', async () => {
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => args[0] === 'pull' ? ok() : original(args, output))
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect((await service.list('home')).models[0].operation?.error).toContain('incomplete')
    expect(calls.some(args => args.includes('join'))).toBe(false)
  })

  it.each(['engine', 'join', 'info', 'leave'])('reports a failed %s without inventing success', async step => {
    if (step === 'leave') { await service.act('home', 'org/Small-GGUF', 'start'); await service.settled() }
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => args.includes(step) ? { ...ok(), ok: false, stderr: 'private-token' } : original(args, output))
    await service.act('home', 'org/Small-GGUF', step === 'leave' ? 'stop' : 'start'); await service.settled()
    const snapshot = await service.list('home')
    expect(snapshot.models[0].operation?.phase).toBe('failed')
    expect(JSON.stringify(snapshot)).not.toContain('private-token')
  })

  it('keeps Stop available while a successful leave has not removed its run record', async () => {
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => args.includes('leave') ? ok() : original(args, output))
    await service.act('home', 'org/Small-GGUF', 'stop'); await service.settled()
    expect((await service.list('home')).models[0]).toMatchObject({ canStop: true, operation: { phase: 'failed', error: expect.stringContaining('still stopping') } })
  })

  it('protects a shared runtime from simple Stop and Start', async () => {
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    const record = JSON.parse(await readFile(join(records, 'remote.json'), 'utf8'))
    record.media = { port: 1234 }
    await writeFile(join(records, 'remote.json'), JSON.stringify(record))
    await service.act('home', 'org/Small-GGUF', 'stop'); await service.settled()
    expect((await service.list('home')).models[0].operation?.error).toContain('share its engine')
    expect(calls.some(args => args.includes('leave'))).toBe(false)
  })

  it('reverifies an already owned instance without downloading or joining again', async () => {
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect(calls.filter(args => args.includes('join'))).toHaveLength(1)
    expect(request.mock.calls.filter(([url]) => String(url).includes('chat/completions'))).toHaveLength(2)
  })

  it.each([false, true])('handles an explicit engine override (available=%s)', async available => {
    const binary = join(root, 'custom-llama')
    if (available) await writeFile(binary, '#!/bin/sh\nexit 0', { mode: 0o700 })
    service = new LocalModels({ stateDir, processEnv: { GRID_HOME: home, LLAMA_SERVER: binary }, run, request: request as typeof fetch , inventory })
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    const operation = (await service.list('home')).models[0].operation
    expect(operation?.phase).toBe(available ? 'done' : 'failed')
    expect(calls.some(args => args[0] === 'engine')).toBe(false)
  })

  it('keeps a missing endpoint recoverable without sending a test to an unknown address', async () => {
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => args.includes('info') ? ok() : original(args, output))
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect((await service.list('home')).models[0].operation?.phase).toBe('failed')
    expect(request.mock.calls.some(([url]) => String(url).includes('chat/completions'))).toBe(false)
  })

  it.each(['reasoning only', 'http error', 'network error'])('requires a real test reply and bounds retries for %s', async scenario => {
    const original = request.getMockImplementation()!
    let attempted!: () => void
    const first = new Promise<void>(resolve => { attempted = resolve })
    request.mockImplementation(async (url, init) => {
      if (String(url).includes('/catalog')) return original(url, init)
      attempted()
      if (scenario === 'network error') throw new Error('private-token')
      return scenario === 'http error' ? new Response('private-token', { status: 503 })
        : response({ choices: [{ message: { reasoning_content: 'ok' } }] })
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    await service.act('home', 'org/Small-GGUF', 'start')
    await first
    await vi.advanceTimersByTimeAsync(182_000)
    await service.settled()
    expect((await service.list('home')).models[0].operation).toMatchObject({ phase: 'failed', error: expect.stringContaining('did not answer') })
    expect(JSON.stringify(await service.list('home'))).not.toContain('private-token')
    vi.useRealTimers()
  })

  it('rejects unsafe, incomplete and duplicate fit cards while supporting split downloads', () => {
    const invalid = [null, {}, { ...card(), runnable: false }, { ...card(), format: 'safetensors' },
      { ...card(), repo_id: '' }, { ...card(), fit: {} },
      ...['--flag:model.gguf', 'repo-only', 'org/repo:model.bin'].map(pull_spec => ({ ...card(), versions: [{ ...card().versions[0], pull_spec }] })),
      { ...card(), fit: { version: 'Q4', ctx: 0 } },
      { ...card(), versions: [{ ...card().versions[0], size_bytes: -1 }] }]
    expect(compatibleModels({ models: invalid })).toEqual([])
    expect(compatibleModels({ models: [card(), card()] })).toHaveLength(1)
    expect(compatibleModels({ models: [{ ...card(), versions: [{ ...card().versions[0], urls: ['bad-url'] }] }] })[0].files).toEqual(['Small-Q4.gguf'])
    expect(compatibleModels({ models: [{ ...card(), versions: [{ ...card().versions[0], urls: null }] }] })[0].files).toEqual(['Small-Q4.gguf'])
    expect(compatibleModels({ models: [{ ...card(), task: 'image-text-to-text', versions: [{ ...card().versions[0], urls: ['https://example.test/part-1.gguf', 'https://example.test/part-2.gguf'] }] }] })[0].files).toEqual(['part-1.gguf', 'part-2.gguf'])
  })

  it('routes production-default dependencies through the bounded Grid subprocess runner', async () => {
    vi.stubEnv('GRID_HOME', home)
    vi.stubGlobal('fetch', request)
    const rpc = vi.spyOn(GridFleetRpc.prototype, 'run').mockImplementation(async (_owner, _id, options, output) => run(options.args, output))
    service = new LocalModels({ stateDir, inventory })
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect((await service.list('home')).models[0].operation?.phase).toBe('done')
    expect(rpc).toHaveBeenCalledWith('local-models', expect.any(String), expect.objectContaining({ timeoutMs: 30_000, thinking: false }), undefined, 4 * 1024 * 1024)
    expect(rpc.mock.calls.find(call => call[2].args[0] === 'pull')?.[2].timeoutMs).toBe(30 * 60_000)
  })

  it.each(['memory changed', 'file removed'])('rechecks an imported deployment before restarting when %s', async scenario => {
    catalogCards = []
    await writeFile(join(home, 'models', 'Small-Q4.gguf'), Buffer.alloc(64))
    await run(['--remote', 'join', 'home'])
    await service.list('home')
    await service.act('home', 'local:Small-Q4.gguf', 'stop'); await service.settled()
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => {
      if (args[0] === 'device-info') {
        if (scenario === 'file removed') await rm(join(home, 'models', 'Small-Q4.gguf'))
        else return ok({ usable_bytes: 0 })
      }
      return original(args, output)
    })
    const ack = await service.act('home', 'local:Small-Q4.gguf', 'start'); await service.settled()
    expect(ack.operation).toMatchObject({ phase: 'failed', error: expect.stringContaining(scenario === 'memory changed' ? 'make room' : 'no longer available') })
    expect(calls.filter(args => args.includes('join'))).toHaveLength(1)
  })

  it('keeps imported downloads visible, merges catalog matches, and removes deleted files', async () => {
    catalogCards = []
    await writeFile(join(home, 'models', 'Small-Q4.gguf'), Buffer.alloc(64))
    await run(['--remote', 'join', 'home'])
    await service.list('home')
    await service.act('home', 'local:Small-Q4.gguf', 'stop'); await service.settled()
    expect((await service.list('home')).models[0].state).toBe('downloaded')
    catalogCards = [card()]
    expect((await service.list('home', true)).models).toHaveLength(1)
    catalogCards = []
    await rm(join(home, 'models', 'Small-Q4.gguf'))
    expect((await service.list('home', true)).models).toEqual([])
  })

  it('does not mistake a directory for downloaded weights or fabricate unavailable device memory', async () => {
    await mkdir(join(home, 'models', 'Small-Q4.gguf'))
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => args[0] === 'device-info' ? ok({}) : original(args, output))
    const view = await service.list('home')
    expect(view.models[0].state).toBe('available')
    expect(view.memoryBytes).toBeUndefined()
  })

  it('cannot start a stale catalog choice while compatibility is unavailable', async () => {
    await service.list('home')
    catalogFails = true
    await service.list('home', true)
    const ack = await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect(ack.operation).toMatchObject({ phase: 'failed', error: expect.stringContaining('could not be checked') })
    expect(calls.some(args => args[0] === 'pull')).toBe(false)
  })

  it('ignores non-progress output and boundedly saves valid download progress', async () => {
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => {
      if (args[0] === 'pull') { output?.('connecting…'); output?.('150%'); output?.('0%'); output?.('2%') }
      return original(args, output)
    })
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect((await service.list('home')).models[0].operation?.phase).toBe('done')
  })

  it('releases the operation after receipt storage fails during a download', async () => {
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => {
      if (args[0] === 'pull') {
        rmSync(stateDir, { recursive: true, force: true }); writeFileSync(stateDir, 'storage unavailable')
        output?.('42%')
        await new Promise(resolve => setImmediate(resolve))
        throw new Error('private filesystem detail')
      }
      return original(args, output)
    })
    const ack = await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect(ack.operation).toMatchObject({ phase: 'failed', error: 'The model could not finish. Start again to retry.' })
    expect((await service.list('home')).busy).toBe(false)
    await rm(stateDir)
    run.mockImplementation(original)
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect((await service.list('home')).models[0].operation?.phase).toBe('done')
  })

  it('recovers malformed aliases and preserves failure status for a model with missing weights', async () => {
    catalogCards = []
    serving = true
    await writeFile(join(records, 'remote.json'), JSON.stringify({ node_id: 'local-node', advertise_as: [42, ''], engines: [{ models: ['Small-Q4.gguf'] }] }))
    await writeFile(join(records, 'remote.heartbeat'), '')
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => args.includes('leave') ? { ...ok(), ok: false } : original(args, output))
    await service.act('home', 'local:Small-Q4.gguf', 'stop'); await service.settled()
    expect((await service.list('home')).models[0]).toMatchObject({ name: 'Small-Q4', state: 'running', operation: { phase: 'failed' } })
  })
})

/** A pid that existed a moment ago and no longer does. */
function deadPid(): number {
  return Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout)
}

describe('the Model Manager while its grid sleeps (grid-reads-without-waking issue 02)', () => {
  const parkedRecord = (pid: unknown) => JSON.stringify({ node_id: 'local-node', meta_name: 'This computer', pid,
    engines: [{ endpoint_url: null, models: ['Small-Q4.gguf'] }], advertise_as: [] })

  it('is not an inventory error: Start and Pause stay enabled, and a parked engine reads running', async () => {
    gridState = 'asleep'
    const next = card('org/Next-GGUF'); next.versions[0].pull_spec = 'org/Next-GGUF:Next.gguf'
    catalogCards = [card(), next]
    await writeFile(join(home, 'models', 'Small-Q4.gguf'), Buffer.alloc(64))
    await writeFile(join(records, 'remote.json'), parkedRecord(process.pid))

    const snapshot = await service.list('home')

    expect(snapshot.error).not.toBe('Running models could not be checked. Try again.')
    expect(snapshot.models[0]).toMatchObject({ id: 'org/Small-GGUF', state: 'running', gridAsleep: true, canStop: true })
    expect(snapshot.models[1]).toMatchObject({ id: 'org/Next-GGUF', canStart: true })
    expect(inventory).toHaveBeenCalledWith('home', false)
  })

  it('reads a parked engine running on a row the catalog does not know, too', async () => {
    gridState = 'asleep'; catalogCards = []
    await writeFile(join(records, 'remote.json'), parkedRecord(process.pid))
    expect((await service.list('home')).models).toEqual([expect.objectContaining({ id: 'local:Small-Q4.gguf', state: 'running', gridAsleep: true, canStop: true })])
  })

  it.each([['a process that is gone', () => deadPid()], ['a join mid-spawn (pid 0)', () => 0], ['no pid at all', () => 'x']])(
    'does not call %s parked', async (_name, pid) => {
      gridState = 'asleep'; catalogCards = []
      await writeFile(join(records, 'remote.json'), parkedRecord(pid()))
      const [row] = (await service.list('home')).models
      expect(row).toMatchObject({ id: 'local:Small-Q4.gguf', state: 'available', canStop: true })
      expect(row).not.toHaveProperty('gridAsleep')
    })

  it('an engine the awake grid lists is running with no asleep flag', async () => {
    serving = true
    await writeFile(join(home, 'models', 'Small-Q4.gguf'), Buffer.alloc(64))
    await writeFile(join(records, 'remote.json'), parkedRecord(process.pid))
    await writeFile(join(records, 'remote.heartbeat'), '')
    const [row] = (await service.list('home')).models
    expect(row).toMatchObject({ state: 'running' })
    expect(row).not.toHaveProperty('gridAsleep')
  })

  it('a grid that answered nothing readable is still an inventory error', async () => {
    gridState = 'unknown'
    expect((await service.list('home')).error).toBe('Running models could not be checked. Try again.')
  })

  it.each([['failed', { ...ok(), ok: false, code: 1 }], ['answered with something that is not JSON', { ...ok(), stdout: 'not json' }]])(
    'so is a grid list that %s', async (_how, answer) => {
      const original = run.getMockImplementation()!
      run.mockImplementation(async (args, output) => args.includes('ls') ? answer : original(args, output))
      expect((await service.list('home')).error).toBe('Running models could not be checked. Try again.')
    })

  it('tells its owner when a start or stop has finished, so the lists are read again', async () => {
    const onChanged = vi.fn()
    service = new LocalModels({ stateDir, processEnv: { GRID_HOME: home }, run, request: request as typeof fetch, inventory, onChanged })
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect(onChanged).toHaveBeenCalledOnce()
  })
})

describe('readRunRecords — what servedHere knows about this computer', () => {
  it('reads the name, the advertised ids (else the models under the display rule) and whether the pid lives', async () => {
    await writeFile(join(records, 'a.json'), JSON.stringify({ meta_name: 'mac', pid: process.pid, advertise_as: ['Team/Model', 7, ''], models: ['ignored.gguf'] }))
    await writeFile(join(records, 'b.json'), JSON.stringify({ meta_name: 'mac', pid: deadPid(), models: ['Qwen3-8B-Q4_K_M.GGUF', 'plain'] }))
    await writeFile(join(records, 'c.json'), JSON.stringify({ pid: 0, models: 'not a list' }))
    await writeFile(join(records, 'd.json'), '{ not json')
    await writeFile(join(records, 'e.heartbeat'), '')

    const found = (await readRunRecords(home, 'grid-home')).sort((x, y) => x.ids.join().localeCompare(y.ids.join()))

    expect(found).toEqual([
      { name: '', ids: [], pid: null, alive: false },
      { name: 'mac', ids: ['Qwen3-8B-Q4_K_M', 'plain'], pid: expect.any(Number), alive: false },
      { name: 'mac', ids: ['Team/Model'], pid: process.pid, alive: true },
    ])
  })

  it.each(['', '../grid-home', 'missing'])('answers nothing for grid id %j', async (gridId) => {
    await writeFile(join(records, 'a.json'), JSON.stringify({ meta_name: 'mac', pid: process.pid, advertise_as: ['X'] }))
    expect(await readRunRecords(home, gridId)).toEqual([])
  })
})
