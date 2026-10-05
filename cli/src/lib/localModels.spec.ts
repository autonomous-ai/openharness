import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { baseModel, compatibleModels, contextLadder, LocalModels, modelBudget, modelFamily, rankForCoding, readRunRecords, type GridInventory } from './localModels.js'
import { GridFleetRpc, type GridFleetResult } from './gridFleetRpc.js'
import type { AppEngineOps, AppEngineRecord, AppModel } from './appModels.js'
import { encryptDownFrame, encryptRpcResult } from './e2ee/applicationFrames.js'

const card = (id = 'org/Small-GGUF') => ({ repo_id: id, runnable: true, task: 'text-generation', format: 'GGUF',
  fit: { version: 'Q4', ctx: 131072, size: 64 },
  versions: [{ version: 'Q4', size_bytes: 64, pull_spec: `${id}:Small-Q4.gguf`, urls: ['https://example.test/Small-Q4.gguf'] }] })
const ok = (value: unknown = {}) => ({ ok: true, code: 0, stdout: JSON.stringify(value), stderr: '', error: null })
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
let root: string, home: string, stateDir: string, records: string
let calls: string[][], serving: boolean, catalogCards: ReturnType<typeof card>[], service: LocalModels
let request: Mock<(url: string | URL, init?: RequestInit) => Promise<Response>>
let run: Mock<(args: string[], output?: (s: string) => void) => Promise<GridFleetResult>>
let downloadFails: boolean, catalogFails: boolean
/** What `grid info` says of the grid. Down (`stopped`/`asleep`) refuses `engines` and `join`, as
 *  the real grid does, until `grid start` brings it back. */
let gridState: 'running' | 'stopped' | 'asleep'
/** What `grid ctx FILE` reads from a file's header (null: the command fails), and the window the
 *  serving engine reports once started (undefined: Grid does not say). */
let trainedWindow: number | null, servedWindow: number | undefined
/** The relay's own test request — as opposed to the probe sent straight to the engine on this
 *  machine (`127.0.0.1`), which a start now makes first. */
const RELAY_CHAT = 'inference.example.test/v1/chat/completions'
const refused = (message: string) => ({ ok: false, code: 1, stdout: '', stderr: message, error: 'Grid command failed.' })
/** The grid's own answer when a test pins it (null: derived from [gridState], as production derives it). */
let answered: GridInventory['state'] | null
/** What `gridModels.gridInventory` would hand the Model Manager — read without a credential. */
let inventory: Mock<(grid: string, force: boolean) => Promise<GridInventory>>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'local-models-'))
  home = join(root, 'grid'); stateDir = join(root, 'receipts'); records = join(home, 'run', 'engines', 'grid-home')
  await mkdir(records, { recursive: true }); await mkdir(join(home, 'models'))
  await writeFile(join(home, 'credentials.toml'), 'session_token = "test-only-token"\napi_url = "https://catalog.example.test"\n')
  calls = []; serving = false; catalogCards = [card()]; downloadFails = false; catalogFails = false; gridState = 'running'
  trainedWindow = null; servedWindow = undefined
  run = vi.fn(async (args: string[], output?: (s: string) => void) => {
    calls.push(args)
    if (args[0] === 'device-info') return ok({ device_class: 'apple-silicon', backend: 'metal', usable_bytes: 54 * 1024 ** 3, memory: { total_gb: 64 } })
    if (args.includes('ls')) return ok([{ grid: 'home', id: 'grid-home' }])
    if (args.includes('info') && args.includes('--json')) return ok({ grid: 'home', status: gridState })
    if (args[1] === 'start') { gridState = 'running'; return ok() }
    const down = gridState !== 'running'
    if (down && (args.includes('engines') || args.includes('join'))) return refused("Grid home isn't up; run `grid start home` first.")
    if (args[0] === 'ctx') return trainedWindow === null ? refused('no header') : ok({ file: args[1], context_length: trainedWindow })
    if (args.includes('engines')) return ok(serving ? [{ node_id: 'local-node', online: true, models: ['Small-Q4.gguf'], throughput_tok_s: 17.6,
      ...(servedWindow === undefined ? {} : { model_capabilities: { 'small-q4': { context_length: servedWindow, vision: false } } }),
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
  // The inventory as production reads it (`gridModels.gridInventory`), over this fake's grid: the owner
  // status is `gridState`; a sleeping grid answers asleep, a stopped one answers nothing readable (the
  // proxy's grid_stopped), and a running one lists what the fake's `engines` lists.
  answered = null
  inventory = vi.fn(async (grid: string): Promise<GridInventory> => {
    const status = gridState
    if (answered) return { state: answered, nodes: [], status }
    if (status === 'asleep') return { state: 'asleep', nodes: [], status }
    if (status !== 'running') return { state: 'unknown', nodes: [], status }
    const answer = await run(['--remote', 'engines', grid, '--json'])
    if (!answer.ok) return { state: 'unknown', nodes: [], status }
    try { return { state: 'awake', nodes: JSON.parse(answer.stdout), status } } catch { return { state: 'unknown', nodes: [], status } }
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

  it('fetches only the first ranked page of popular models, like grid catalog', async () => {
    request.mockResolvedValue(response({ models: [card('org/Model1-GGUF'), card('org/Model2-GGUF')], pagination: { page: 1, total_pages: 7 } }))
    expect((await service.list('home')).models).toHaveLength(2)
    expect(request).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toMatchObject({ browse: true, page: 1, page_size: 50 })
  })

  it('returns the first page as-is without looping pages or a pagination notice', async () => {
    request.mockResolvedValue(response({ models: [card()], runnable_total: 100, pagination: { page: 1, total_pages: 7 } }))
    const snapshot = await service.list('home')
    expect(snapshot.models).toHaveLength(1)
    expect(snapshot.notice).toBeFalsy()
  })

  it('downloads, loads and verifies without another user step', async () => {
    const ack = await service.act('home', 'org/Small-GGUF', 'start')
    expect(ack.operation?.phase).toBe('running')
    await service.settled()
    const snapshot = await service.list('home')
    expect(snapshot.models[0]).toMatchObject({ state: 'running', canStop: true,
      tokensPerSecond: 17.6, requests: 4, windowSeconds: 3600, operation: { phase: 'done', stage: 'verifying' } })
    expect(snapshot.models[0]).not.toHaveProperty('memoryBytes')
    expect(calls.find(args => args.includes('join'))).toEqual(['--remote', 'join', 'home', '--serve', 'Small-Q4.gguf', '--max-concurrency', '1', '--ctx-size', '131072', '--endpoint-port', expect.stringMatching(/^\d+$/), '--reasoning-budget', '0'])
    expect(request.mock.calls.some(([url]) => String(url).includes(RELAY_CHAT))).toBe(true)
    expect(await readFile(join(stateDir, (await readdir(stateDir))[0]), 'utf8')).not.toContain('token')
  })

  // grid-reads-without-waking issue 03: the reply test is an inference THROUGH the grid, so on a sleeping
  // grid it starts it — and the platform then keeps it up for hours. A stray Start on a model that is
  // already serving has nothing to check.
  it('Start on a model already serving at the last read skips the reply test', async () => {
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect((await service.list('home', true)).models[0].state).toBe('running')
    request.mockClear(); calls.length = 0

    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()

    // Nothing that reads through the grid with its credential: no reply test, no `info --env` for its
    // key, no signed-in `engines` for the served window — and nothing started.
    expect(request.mock.calls.some(([url]) => String(url).includes(RELAY_CHAT))).toBe(false)
    expect(calls.filter(args => args.includes('--env') || args.includes('engines') || args.includes('join'))).toEqual([])
    expect((await service.list('home')).models[0]).toMatchObject({ state: 'running', operation: { phase: 'done' } })
  })

  it('Start on a model this computer holds but that was not serving at the last read runs the reply test, as before', async () => {
    await writeFile(join(home, 'models', 'Small-Q4.gguf'), Buffer.alloc(64))
    await writeFile(join(records, 'remote.json'), JSON.stringify({ node_id: 'local-node', engines: [{ endpoint_url: null, models: ['Small-Q4.gguf'] }], advertise_as: [] }))
    expect((await service.list('home', true)).models[0].state).not.toBe('running')

    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()

    expect(request.mock.calls.some(([url]) => String(url).includes(RELAY_CHAT))).toBe(true)
    expect(calls.some(args => args.includes('join'))).toBe(false)
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
    request.mockImplementation(async (url, init) => { if (String(url).includes(RELAY_CHAT)) await barrier; return original(url, init) })
    const first = await service.act('home', 'org/Small-GGUF', 'start')
    const second = await service.act('home', 'org/Small-GGUF', 'start')
    expect(second.operation?.id).toBe(first.operation?.id)
    expect((await service.act('home', 'other', 'start')).error).toContain('Wait')
    await vi.waitFor(() => expect(request.mock.calls.some(([url]) => String(url).includes(RELAY_CHAT))).toBe(true))
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
    expect(snapshot.notice).toContain('unavailable')
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
    // What receipts from before the 64K floor carried: a pinned 16K that must not be replayed.
    saved[0].context = 16384
    if (scenario === 'legacy') delete saved[0].aliases
    if (scenario === 'malformed') saved[0].aliases = [42, '', '--invalid', 'invalid\nname']
    await writeFile(path, JSON.stringify(saved))
    const fresh = new LocalModels({ stateDir, processEnv: { GRID_HOME: home }, run, request: request as typeof fetch , inventory })
    await fresh.act('home', id, 'start'); await fresh.settled()
    const expectedAlias = scenario === 'current' ? 'team/my-model' : scenario === 'legacy' ? 'my-model' : null
    const joined = calls.find(args => args.includes('join'))!
    expect(joined.slice(joined.indexOf('--reasoning-budget') + 2)).toEqual(expectedAlias ? ['--advertise-as', expectedAlias] : [])
    // Not sized by any catalog and its header unread here, so the start begins at 128K — and a
    // receipt's saved context, which older ones pinned at 16K, is never replayed.
    expect(joined[joined.indexOf('--ctx-size') + 1]).toBe('131072')
    const inference = request.mock.calls.find(([url]) => String(url).includes(RELAY_CHAT))!
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
    for (const type of ['grid_fleet_models_list', 'grid_fleet_model_download', 'grid_fleet_model_start', 'grid_fleet_model_stop']) {
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
    expect(await service.list(null)).toMatchObject({ models: [], busy: false, notice: expect.stringContaining('Sign in') })
    expect((await service.act(null, 'x', 'start')).error).toBeTruthy()
    expect((await service.act('home', {}, 'start')).error).toBeTruthy()
  })

  it.each([
    ['missing credentials', ''],
    ['no session token', 'api_url = "https://catalog.example.test"'],
    ['malformed token', 'session_token = "invalid\\q"'],
  ])('reports sign-in for %s without sending credentials', async (_name, credentials) => {
    await writeFile(join(home, 'credentials.toml'), credentials)
    expect((await service.list('home')).notice).toContain('Sign in')
    expect(request).not.toHaveBeenCalled()
  })

  it.each(['http://catalog.example.test', 'file:///tmp/catalog'])('refuses insecure catalog address %s', async base => {
    await writeFile(join(home, 'credentials.toml'), `session_token = 'private'\napi_url = '${base}'`)
    expect((await service.list('home')).notice).toContain('address')
    expect(request).not.toHaveBeenCalled()
  })

  it.each(['http://localhost:1234', 'http://127.0.0.1:1234', 'http://[::1]:1234'])('permits an explicitly configured local catalog at %s', async base => {
    await writeFile(join(home, 'credentials.toml'), `session_token = 'test-only-token'\napi_url = '${base}'`)
    expect((await service.list('home')).notice).toBeUndefined()
    expect(String(request.mock.calls[0][0])).toBe(`${base}/v1/grid/catalog`)
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'error' })
  })

  it.each([undefined, 'https://alternate.example.test'])('uses the configured or default catalog when the credential store omits it', async base => {
    await writeFile(join(home, 'credentials.toml'), 'session_token = "test-only-token"\n')
    service = new LocalModels({ stateDir, processEnv: { GRID_HOME: home, GRID_CONTROL_PLANE_URL: base }, run, request: request as typeof fetch , inventory })
    await service.list('home')
    expect(String(request.mock.calls[0][0])).toBe(`${base ?? 'https://api-grid.autonomous.ai'}/v1/grid/catalog`)
  })

  it.each(['http failure', 'missing rows'])('handles a catalog %s without inventing compatibility', async scenario => {
    request.mockImplementation(async () =>
      scenario === 'http failure' ? new Response('private detail', { status: 401 })
        : response({ error: 'private detail' }))
    const snapshot = await service.list('home')
    expect(snapshot.models).toEqual([])
    expect(snapshot.notice).toBeTruthy()
    expect(JSON.stringify(snapshot)).not.toContain('private detail')
  })

  it('supports an unpaginated catalog, offers a fast model before a big slow one, and skips unfitted versions', async () => {
    const large = card('org/Large-GGUF'), small = { ...card('org/Fast-GGUF'), fit: { ...card().fit, est_tok_s: 30 } }
    large.versions[0].size_bytes = 20 * 1024 ** 3
    small.versions[0].size_bytes = 2 * 1024 ** 3
    small.versions.push({ ...small.versions[0], version: 'Q8', size_bytes: 4 * 1024 ** 3 })
    small.versions.push({ ...small.versions[0], version: 'unknown', size_bytes: undefined as any })
    request.mockImplementation(async () => response({ models: [large, small] }))
    expect((await service.list('home')).models.map(m => [m.name, m.recommended])).toEqual([['Fast', true], ['Large', false]])
  })

  it('offers what a coding agent can work with first: a faithful quant, fast enough, then bigger, then the catalog order', async () => {
    // [id, estimated tok/s, billions of parameters, quant] in the catalog's own order.
    const rows: [string, number | undefined, number | undefined, string?][] = [
      ['org/Dense-70B-GGUF', 8, 70],                    // big, and slow on this machine
      ['org/Qwen-35B-A3B-GGUF', 21, 35],
      ['org/Qwen-35B-A3B-MTP-GGUF', 21, 35],            // a variant of the one above
      ['org/Tiny-4B-GGUF', 27, 4],
      ['org/Retrained-35B-A3B-GGUF', 22, 35],           // a fine-tune: the same MoE shape
      ['org/Renamed-35B-GGUF', 21, 35],                 // a fine-tune: the same size, speed and weights
      ['org/Coder-Next-GGUF', 25, undefined, 'MXFP4_MOE'], // no count: read off 48 GB of MXFP4 weights
      ['org/Unknown-9B-GGUF', undefined, 9],            // no estimate: not known to be fast
      ['org/gpt-oss-safeguard-20b-GGUF', 24, 20],       // a safety classifier, not a coding model
      ['org/Giant-122B-A10B-GGUF', 30, 122, 'Q2_K_XL'], // biggest and fast, at 2 bits a weight
    ]
    catalogCards = rows.map(([id, estimate, params, quant]) => {
      const row: Record<string, any> = card(id)
      row.versions[0].pull_spec = `${id}:${id.split('/')[1]}.gguf`
      if (estimate !== undefined) row.fit = { ...row.fit, est_tok_s: estimate }
      if (params !== undefined) row.params_b = params
      if (quant) {
        row.fit = { ...row.fit, version: quant }
        row.versions[0] = { ...row.versions[0], version: quant, ...(quant === 'MXFP4_MOE' ? { size_bytes: 48e9 } : {}) }
      }
      return row as ReturnType<typeof card>
    })
    const snapshot = await service.list('home')
    expect(snapshot.models.map(model => model.name)).toEqual([
      'Coder-Next', 'Qwen-35B-A3B', 'Tiny-4B',
      'Dense-70B', 'Unknown-9B',
      'Giant-122B-A10B',
      'Qwen-35B-A3B-MTP', 'Retrained-35B-A3B', 'Renamed-35B',
    ])
    expect(snapshot.models[0].recommended).toBe(true)
  })

  it('ranks without regard to where a model was in the catalog once speed or size tells them apart', () => {
    const at = (name: string, estTokS: number, paramsB: number, size = 1) =>
      ({ id: `org/${name}`, name, pull: `org/${name}:${name}.gguf`, file: `${name}.gguf`, files: [`${name}.gguf`], size, quant: 'Q4', estTokS, paramsB })
    expect(rankForCoding([at('Slow-Big', 5, 70), at('Fast-Small', 25, 4), at('Fast-Big', 25, 30)]).map(c => c.name))
      .toEqual(['Fast-Big', 'Fast-Small', 'Slow-Big'])
    // At exactly the floor a model counts as fast enough.
    expect(rankForCoding([at('Slow', 19.9, 30), at('Enough', 20, 4)]).map(c => c.name)).toEqual(['Enough', 'Slow'])
    // Two models of one size are two models when their weights or speed differ.
    expect(rankForCoding([at('Moe-35B', 78, 35, 20e9), at('Dense-35B', 30, 35, 20e9), at('Other-35B', 78, 35, 24e9)]).map(c => c.name))
      .toEqual(['Moe-35B', 'Dense-35B', 'Other-35B'])
  })

  it('fits the catalog to half the machine, and never to more than grid says is free', () => {
    const device = (usable: number, total?: number, backend = 'metal') =>
      ({ backend, usable_bytes: usable * 1024 ** 3, ...(total ? { memory: { total_gb: total } } : {}) })
    expect(modelBudget(device(54, 64))).toBe(32 * 1024 ** 3)
    expect(modelBudget(device(20, 64))).toBe(20 * 1024 ** 3)
    expect(modelBudget(device(54))).toBe(54 * 1024 ** 3)
    // No GPU: the model lives in system RAM, shared like unified memory.
    expect(modelBudget(device(28, 32, 'cpu'))).toBe(16 * 1024 ** 3)
    expect(modelBudget({})).toBeUndefined()
  })

  it("gives the catalog all of an NVIDIA card's free VRAM, whatever the system RAM", () => {
    // A 24 GB card in a 32 GB PC: VRAM is not system RAM, and nothing else is waiting for it.
    expect(modelBudget({ backend: 'cuda', usable_bytes: 23 * 1024 ** 3, memory: { total_gb: 32 } })).toBe(23 * 1024 ** 3)
    // Two 24 GB cards in a 64 GB PC.
    expect(modelBudget({ backend: 'cuda', usable_bytes: 46 * 1024 ** 3, memory: { total_gb: 64 } })).toBe(46 * 1024 ** 3)
  })

  it('names one base model across its variants, and a fine-tune under its own name apart', () => {
    for (const name of ['Qwen3.6-35B-A3B', 'Qwen3.6-35B-A3B-MTP', 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF', 'Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf']) {
      expect(baseModel(name)).toBe('qwen3.6-35b-a3b')
    }
    expect(baseModel('gemma-4-E4B-it-qat')).toBe(baseModel('gemma-4-E4B-it'))
    expect(baseModel('GLM-4.7-Flash-REAP-23B-A3B')).toBe(baseModel('GLM-4.7-Flash'))
    expect(baseModel('Qwen3-VL-30B-A3B-Thinking')).toBe(baseModel('Qwen3-VL-30B-A3B-Instruct'))
    expect(baseModel('Qwen-AgentWorld-35B-A3B')).not.toBe(baseModel('Qwen3.6-35B-A3B'))
    expect(baseModel('Qwen3.5-9B')).not.toBe(baseModel('Qwen3.5-4B'))
  })

  it.each(['failed command', 'invalid json'])('disables actions when inventory returns %s', async scenario => {
    await service.list('home')
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => args.includes('engines')
      ? { ...ok(), ok: scenario !== 'failed command', stdout: 'not json' } : original(args, output))
    const snapshot = await service.list('home', true)
    expect(snapshot.notice).toContain('Running models could not be checked')
    expect(snapshot.models.every(m => !m.canStart && !m.canStop)).toBe(true)
  })

  // ── a grid that is down ──────────────────────────────────────────────────────────────────────
  //
  // ⚠️ REGRESSION. Grid refuses `engines` on a grid that is not up, and that refusal was read as
  // "running models unknown": every Start in the list went dark, so the one state in which a person
  // most needs to start a model was the one in which none could be. And a Start that did get through
  // failed at `join`, which a down grid refuses too.

  it.each(['stopped', 'asleep'] as const)('a %s grid runs nothing: every model can start, and nothing is wrong', async state => {
    gridState = state
    const snapshot = await service.list('home')
    expect(snapshot.models).toMatchObject([{ name: 'Small', state: 'available', canStart: true, canStop: false }])
    expect(snapshot.notice).toBeUndefined()
    // Never `error`: on this protocol that field fails the request and the app keeps no list.
    expect(snapshot).not.toHaveProperty('error')
  })

  it('a refusal from a grid that IS running is still a gap, not an empty list', async () => {
    run.mockImplementation(async args => args.includes('engines') ? refused('private detail')
      : args.includes('info') ? ok({ status: 'running' }) : ok([{ grid: 'home', id: 'grid-home' }]))
    await service.list('home', true)
    const snapshot = await service.list('home', true)
    expect(snapshot.notice).toContain('Running models could not be checked')
    expect(JSON.stringify(snapshot)).not.toContain('private detail')
  })

  it.each(['stopped', 'asleep'] as const)('Start brings a %s grid up before joining it', async state => {
    gridState = state
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    const started = calls.findIndex(args => args[0] === '--remote' && args[1] === 'start')
    const joined = calls.findIndex(args => args.includes('join'))
    expect(calls[started]).toEqual(['--remote', 'start', 'home'])
    expect(started).toBeGreaterThanOrEqual(0)
    expect(started).toBeLessThan(joined)
    expect((await service.list('home', true)).models[0]).toMatchObject({ state: 'running', operation: { phase: 'done' } })
  })

  it('Start leaves a running grid alone', async () => {
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect(calls.some(args => args[0] === '--remote' && args[1] === 'start')).toBe(false)
    expect((await service.list('home', true)).models[0].state).toBe('running')
  })

  it('an unreadable grid status blocks nothing: the start goes on to the join', async () => {
    // A Grid too old to answer `info --json` joined fine before this read existed.
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => args.includes('info') && args.includes('--json') ? refused('usage') : original(args, output))
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect(calls.some(args => args[1] === 'start')).toBe(false)
    expect((await service.list('home', true)).models[0]).toMatchObject({ state: 'running', operation: { phase: 'done' } })
  })

  it('a grid that will not come up fails the Start in words, before any join', async () => {
    gridState = 'stopped'
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => args[1] === 'start' ? refused('private detail') : original(args, output))
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect(calls.some(args => args.includes('join'))).toBe(false)
    expect((await service.list('home')).models[0].operation).toMatchObject({ phase: 'failed', error: 'Your grid could not start. Try again.' })
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
    expect(request.mock.calls.filter(([url]) => String(url).includes(RELAY_CHAT))).toHaveLength(2)
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
    expect(request.mock.calls.some(([url]) => String(url).includes(RELAY_CHAT))).toBe(false)
  })

  it.each(['reasoning only', 'http error', 'network error'])('requires a real test reply and bounds retries for %s', async scenario => {
    const original = request.getMockImplementation()!
    let attempted!: () => void
    const first = new Promise<void>(resolve => { attempted = resolve })
    request.mockImplementation(async (url, init) => {
      // The catalog, and the engine on this machine, answer normally: this is about the RELAY check.
      if (String(url).includes('/catalog') || String(url).includes('127.0.0.1')) return original(url, init)
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

  it('tells, per model, the window and speed the catalog expects on this machine, and the free disk', async () => {
    catalogCards = [{ ...card(), params_b: 9, fit: { ...card().fit, est_tok_s: 21.3 } } as ReturnType<typeof card>, card('org/Bare-GGUF')]
    catalogCards[1].versions[0].pull_spec = 'org/Bare-GGUF:Bare-Q4.gguf'
    const snapshot = await service.list('home')
    expect(snapshot.models[0]).toMatchObject({ name: 'Small', contextWindow: 131072, estTokS: 21.3, paramsB: 9 })
    // A catalog row that does not say is shown without, never as zero.
    expect(snapshot.models[1]).not.toHaveProperty('estTokS')
    expect(snapshot.models[1]).not.toHaveProperty('paramsB')
    expect(snapshot.freeDiskBytes).toBeGreaterThan(0)
  })

  it("tells the catalog the machine's measured bandwidth and compute, which its speed estimates rest on", async () => {
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => args[0] === 'device-info'
      ? ok({ device_class: 'apple-silicon', backend: 'metal', usable_bytes: 54 * 1024 ** 3, memory: { total_gb: 64 },
        mem_bandwidth_gbps: 400, compute_gflops: 15600 })
      : original(args, output))
    await service.list('home')
    const sent = request.mock.calls.find(([url]) => String(url).includes('/catalog'))!
    // Half of its 64 GB, not the 54 GB grid reports free: the rest stays for everything else it runs.
    expect(JSON.parse(String(sent[1]?.body)).device).toEqual({ device_class: 'apple-silicon', usable_bytes: 32 * 1024 ** 3,
      backend: 'metal', mem_bandwidth_gbps: 400, compute_gflops: 15600 })
  })

  it('leaves out a measurement the machine did not report, so the catalog falls back to its own', async () => {
    await service.list('home')
    const sent = request.mock.calls.find(([url]) => String(url).includes('/catalog'))!
    const device = JSON.parse(String(sent[1]?.body)).device
    expect(device).not.toHaveProperty('mem_bandwidth_gbps')
    expect(device).not.toHaveProperty('compute_gflops')
  })

  it('names one model the same whatever its quantization', () => {
    for (const name of ['Qwen3.6-35B-A3B', 'unsloth/Qwen3.6-35B-A3B-GGUF', 'Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf', 'Qwen3.6-35B-A3B-Q4_K_M',
      'qwen3.6-35b-a3b-bf16', 'Qwen3.6-35B-A3B-IQ4_XS', 'Qwen3.6-35B-A3B-MXFP4_MOE']) {
      expect(modelFamily(name)).toBe('qwen3.6-35b-a3b')
    }
    // Another model of the family stays another model.
    expect(modelFamily('Qwen3.6-35B-A3B-MTP')).not.toBe(modelFamily('Qwen3.6-35B-A3B'))
  })

  it('does not offer to download another quantization of a model this machine already has', async () => {
    catalogCards = [card(), card('org/Other-GGUF')]
    catalogCards[1].versions[0].pull_spec = 'org/Other-GGUF:Other-Q4.gguf'
    // Small at Q8, imported from an existing setup and serving: the catalog's Q4 of it is a second copy.
    serving = true
    await writeFile(join(home, 'models', 'Small-Q8_0.gguf'), Buffer.alloc(96))
    await writeFile(join(records, 'remote.json'), JSON.stringify({ node_id: 'local-node',
      engines: [{ endpoint_url: null, models: ['Small-Q8_0.gguf'] }], advertise_as: [] }))
    await writeFile(join(records, 'remote.heartbeat'), '')
    run.mockImplementation(async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'device-info') return ok({ device_class: 'apple-silicon', backend: 'metal', usable_bytes: 54 * 1024 ** 3, memory: { total_gb: 64 } })
      if (args.includes('ls')) return ok([{ grid: 'home', id: 'grid-home' }])
      if (args.includes('info') && args.includes('--json')) return ok({ grid: 'home', status: 'running' })
      if (args.includes('engines')) return ok([{ node_id: 'local-node', online: true, models: ['Small-Q8_0.gguf'] }])
      return ok()
    })
    const snapshot = await service.list('home')
    expect(snapshot.models.map(model => [model.id, model.state])).toEqual([
      ['org/Other-GGUF', 'available'],
      ['local:Small-Q8_0.gguf', 'running'],
    ])
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

    expect(snapshot.notice).not.toBe('Running models could not be checked. Try again.')
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
    answered = 'unknown'
    expect((await service.list('home')).notice).toBe('Running models could not be checked. Try again.')
  })

  it('and so is one whose owner status could not be read either — nothing says it is down', async () => {
    inventory.mockResolvedValueOnce({ state: 'unknown', nodes: [], status: null })
    expect((await service.list('home')).notice).toBe('Running models could not be checked. Try again.')
  })

  it.each([['failed', { ...ok(), ok: false, code: 1 }], ['answered with something that is not JSON', { ...ok(), stdout: 'not json' }]])(
    'so is a grid list that %s', async (_how, answer) => {
      const original = run.getMockImplementation()!
      run.mockImplementation(async (args, output) => args.includes('ls') ? answer : original(args, output))
      expect((await service.list('home')).notice).toBe('Running models could not be checked. Try again.')
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
      { name: '', ids: [], pid: null, alive: false, advertised: false },
      { name: 'mac', ids: ['Qwen3-8B-Q4_K_M', 'plain'], pid: expect.any(Number), alive: false, advertised: false },
      // Its own aliases, as given: the one spelling that is the name served now.
      { name: 'mac', ids: ['Team/Model'], pid: process.pid, alive: true, advertised: true },
    ])
  })

  it.each(['', '../grid-home', 'missing'])('answers nothing for grid id %j', async (gridId) => {
    await writeFile(join(records, 'a.json'), JSON.stringify({ meta_name: 'mac', pid: process.pid, advertise_as: ['X'] }))
    expect(await readRunRecords(home, gridId)).toEqual([])
  })
})

describe('a context a coding agent can work in', () => {
  // ⚠️ REGRESSION. Every model was offered and started at 16K or less — a model that loads, passes
  // its one-word check, and then cannot hold a coding agent's first prompt. Codex, Claude Code and
  // OpenCode all need 64K at the least; the most this machine can give is what a start now asks for.

  it.each([
    [32768, false], [65535, false], [65536, true], [262144, true],
  ])("a catalog fit of %i on this machine is offered: %s", async (ctx, offered) => {
    catalogCards[0].fit.ctx = ctx
    expect((await service.list('home')).models.length).toBe(offered ? 1 : 0)
  })

  it('pins the whole fit, capped at the most the model was trained for', async () => {
    Object.assign(catalogCards[0].fit, { ctx: 262144, max_ctx: 196608 })
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    const joined = calls.find(args => args.includes('join'))!
    expect(joined[joined.indexOf('--ctx-size') + 1]).toBe('196608')
  })

  it('shrinks to what fits at start when memory has since tightened, but never under 64K', async () => {
    catalogCards[0].fit.ctx = 262144
    await service.list('home')
    catalogCards[0].fit.ctx = 98304
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    const joined = calls.find(args => args.includes('join'))!
    expect(joined[joined.indexOf('--ctx-size') + 1]).toBe('98304')
  })

  it('refuses to start at all when the fit at start is under 64K', async () => {
    await service.list('home')
    catalogCards[0].fit.ctx = 32768
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect(calls.some(args => args.includes('join'))).toBe(false)
    expect((await service.list('home')).models[0].operation).toMatchObject({ phase: 'failed', error: expect.stringContaining('make room') })
  })

  it('hides a model on disk whose file can never hold 64K, and keeps one it cannot read', async () => {
    catalogCards = []; serving = true
    await writeFile(join(home, 'models', 'Small-Q4.gguf'), Buffer.alloc(64))
    await writeFile(join(records, 'remote.json'), JSON.stringify({ node_id: 'local-node', engines: [{ models: ['Small-Q4.gguf'] }] }))
    await writeFile(join(records, 'remote.heartbeat'), '')
    const id = (await service.list('home')).models[0].id
    await service.act('home', id, 'stop'); await service.settled()
    // Unreadable header: unknown is not "too small".
    expect((await service.list('home', true)).models.map(m => m.id)).toEqual([id])
    trainedWindow = 32768
    const fresh = new LocalModels({ stateDir, processEnv: { GRID_HOME: home }, run, request: request as typeof fetch, inventory })
    expect((await fresh.list('home')).models).toEqual([])
  })

  it.each([
    [131072, 'done'], [undefined, 'done'], [32768, 'failed'],
  ] as const)('after a start that served %s tokens, the start is %s', async (window, phase) => {
    servedWindow = window
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    const operation = (await service.list('home', true)).models[0].operation
    expect(operation?.phase).toBe(phase)
    if (phase === 'failed') {
      // Served too small: taken back down rather than left answering prompts it cannot hold.
      expect(calls.find(args => args.includes('leave'))).toEqual(['--remote', 'leave', 'home', '--engine', 'Small-Q4.gguf'])
      expect(operation?.error).toBe('Small could only get a 32K context here. Coding agents need at least 64K. Close some apps, or choose a smaller model.')
    } else {
      expect(calls.some(args => args.includes('leave'))).toBe(false)
    }
  })
})

describe('stepping down to the context that actually runs', () => {
  // ⚠️ REGRESSION, measured on a 64 GB M1 Max. Left to the engine, a 35B model took its whole
  // trained 256K, loaded, and then failed its very first request — "Insufficient Memory
  // (kIOGPUCommandBufferCallbackErrorOutOfMemory)", then "Compute error." for every request after.
  // The relay check waited three minutes and said only "did not answer". The same file ran at 128K.

  const joinedAt = () => calls.filter(args => args.includes('join')).map(args => Number(args[args.indexOf('--ctx-size') + 1]))
  /** The engine on this machine runs out of memory at any context above [limit]. */
  const gpuHolds = (limit: number) => {
    const original = request.getMockImplementation()!
    request.mockImplementation(async (url, init) => {
      if (String(url).includes('127.0.0.1') && String(url).endsWith('/chat/completions') && joinedAt().at(-1)! > limit) {
        return new Response(JSON.stringify({ error: { code: 500, message: 'Compute error.', type: 'server_error' } }), { status: 500 })
      }
      return original(url, init)
    })
  }

  it('halves to the 64K floor and no further', () => {
    expect(contextLadder(262144)).toEqual([262144, 131072, 65536])
    expect(contextLadder(196608)).toEqual([196608, 98304, 65536])
    expect(contextLadder(100000)).toEqual([100000, 65536])
    expect(contextLadder(65536)).toEqual([65536])
    expect(contextLadder(50000)).toEqual([])
  })

  it('takes a size the GPU cannot run back down, and settles on the next that does', async () => {
    catalogCards[0].fit.ctx = 262144
    gpuHolds(131072)
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect(joinedAt()).toEqual([262144, 131072])
    // Down between the two, and Grid's registration restored before the second join.
    const between = calls.slice(calls.findIndex(a => a.includes('join')) + 1, calls.findLastIndex(a => a.includes('join')))
    expect(between).toContainEqual(['--remote', 'leave', 'home', '--engine', 'Small-Q4.gguf'])
    expect(between).toContainEqual(['--remote', 'sync'])
    expect((await service.list('home', true)).models[0]).toMatchObject({ state: 'running', operation: { phase: 'done' } })
  })

  it('says it is memory, in words, when not even 64K runs — without waiting on the relay', async () => {
    catalogCards[0].fit.ctx = 262144
    gpuHolds(0)
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect(joinedAt()).toEqual([262144, 131072, 65536])
    expect(request.mock.calls.some(([url]) => String(url).includes(RELAY_CHAT))).toBe(false)
    expect((await service.list('home', true)).models[0].operation).toMatchObject({ phase: 'failed',
      error: 'This computer does not have the memory to run Small with a 64K context. Close some apps, or choose a smaller model.' })
  })

  it('steps down from a size whose join fails, since a failed allocation at load looks like that', async () => {
    catalogCards[0].fit.ctx = 262144
    const original = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => args.includes('join') && args.includes('262144') ? refused('engine exited') : original(args, output))
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    const joins = run.mock.calls.map(([args]) => args).filter(args => args.includes('join'))
    expect(joins.map(a => a[a.indexOf('--ctx-size') + 1])).toEqual(['262144', '131072'])
    expect((await service.list('home', true)).models[0].operation?.phase).toBe('done')
  })

  it.each([
    ['nothing is listening on this machine', () => { throw new Error('ECONNREFUSED') }],
    ['the engine fails for another reason', () => new Response('{"error":{"message":"template error"}}', { status: 500 })],
    // Not a load in progress (503), so not waited on for ten minutes.
    ['its health check answers something unexpected', () => new Response('teapot', { status: 418 })],
  ])('leaves the judgement to the relay check when %s', async (_case, answer) => {
    const original = request.getMockImplementation()!
    request.mockImplementation(async (url, init) => String(url).includes('127.0.0.1') ? answer() : original(url, init))
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    expect(joinedAt()).toEqual([131072])
    expect(request.mock.calls.some(([url]) => String(url).includes(RELAY_CHAT))).toBe(true)
    expect((await service.list('home', true)).models[0].operation?.phase).toBe('done')
  })

  it('starts a file on disk at the most its header says it holds', async () => {
    catalogCards = []; serving = true
    await writeFile(join(home, 'models', 'Small-Q4.gguf'), Buffer.alloc(64))
    await writeFile(join(records, 'remote.json'), JSON.stringify({ node_id: 'local-node', engines: [{ models: ['Small-Q4.gguf'] }] }))
    await writeFile(join(records, 'remote.heartbeat'), '')
    const id = (await service.list('home')).models[0].id
    await service.act('home', id, 'stop'); await service.settled()
    trainedWindow = 262144
    const fresh = new LocalModels({ stateDir, processEnv: { GRID_HOME: home }, run, request: request as typeof fetch, inventory })
    await fresh.act('home', id, 'start'); await fresh.settled()
    expect(joinedAt()).toEqual([262144])
  })
})

describe("a model is labelled with the machine's name as Harness shows it", () => {
  // ⚠️ REGRESSION. Started from the Models modal, a model joined with no `--name`, so Grid labelled
  // it with the host name: `mac.lan` under "On your machines" while Machines called it `M2`.
  const joined = () => calls.find(args => args.includes('join'))!

  it('joins under the Harness name', async () => {
    const named = new LocalModels({ stateDir, processEnv: { GRID_HOME: home }, run, request: request as typeof fetch, machineName: () => ' M2 ', inventory })
    await named.act('home', 'org/Small-GGUF', 'start'); await named.settled()
    expect(joined().slice(joined().indexOf('--name'), joined().indexOf('--name') + 2)).toEqual(['--name', 'M2'])
  })

  it.each([
    ['is not known yet', () => null],
    ['would read as a flag', () => '--all'],
    ['carries a control character', () => 'M2\nevil'],
  ])('leaves --name off when the name %s, rather than pass it', async (_case, machineName) => {
    const named = new LocalModels({ stateDir, processEnv: { GRID_HOME: home }, run, request: request as typeof fetch, machineName, inventory })
    await named.act('home', 'org/Small-GGUF', 'start'); await named.settled()
    expect(joined()).not.toContain('--name')
    expect((await named.list('home', true)).models[0].operation?.phase).toBe('done')
  })
})


describe('download without starting', () => {
  it('stores the weights without waking a grid, installing an engine, or sending a prompt', async () => {
    gridState = 'asleep'
    const result = await service.act('home', 'org/Small-GGUF', 'download')
    await service.settled()
    expect(result.operation).toMatchObject({ action: 'download', phase: 'done' })
    expect(calls.filter(args => args[0] === 'pull')).toHaveLength(1)
    expect(calls.some(args => args.includes('sync') || args.includes('join') || args.includes('start') || args.includes('install'))).toBe(false)
    expect(request.mock.calls.some(([url]) => String(url).includes('chat/completions'))).toBe(false)
    expect(gridState).toBe('asleep')
    expect((await service.list('home')).models[0]).toMatchObject({ state: 'downloaded', canStart: true, canStop: false })
    expect((await service.list('home')).supportsDownload).toBe(true)
  })

  it('a download request for a running model never runs another reply test', async () => {
    await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
    calls.length = 0; request.mockClear()
    const result = await service.act('home', 'org/Small-GGUF', 'download'); await service.settled()
    expect(result.operation?.phase).toBe('done')
    expect(serving).toBe(true)
    expect(calls.some(args => args.includes('join') || args.includes('pull') || args.includes('sync'))).toBe(false)
    expect(request.mock.calls.some(([url]) => String(url).includes('chat/completions'))).toBe(false)
  })

  it('keeps failed downloads retryable and starts only after a separate Start', async () => {
    downloadFails = true
    const first = await service.act('home', 'org/Small-GGUF', 'download')
    await service.settled()
    expect(first.operation?.phase).toBe('failed')
    expect(serving).toBe(false)
    downloadFails = false
    await service.act('home', 'org/Small-GGUF', 'download')
    await service.settled()
    expect(serving).toBe(false)
    const pulls = calls.filter(args => args[0] === 'pull').length
    await service.act('home', 'org/Small-GGUF', 'start')
    await service.settled()
    expect(serving).toBe(true)
    expect(calls.filter(args => args[0] === 'pull')).toHaveLength(pulls)
  })
})

describe('models other apps downloaded, started in their own app', () => {
  const GiB = 1024 ** 3
  const ollama: AppModel = { id: 'app:ollama:llama3.2:3b', name: 'llama3.2:3b', app: 'ollama', engine: 'ollama', ref: 'llama3.2:3b',
    binary: '/usr/local/bin/ollama', sizeBytes: 2 * GiB, quant: 'Q4_K_M', contextLength: 131072, kvBytesPerToken: 112 * 1024 }
  const studio: AppModel = { id: 'app:lm-studio:google/gemma-4-e2b', name: 'gemma-4-e2b', app: 'lm-studio', engine: 'lm-studio',
    ref: 'google/gemma-4-e2b', binary: '/home/me/.lmstudio/bin/lms', sizeBytes: 4 * GiB, contextLength: 131072 }
  let apps: AppModel[], up: Set<string>, joinedAliases: Set<string>, window: number | undefined
  let ops: { [K in keyof AppEngineOps]: Mock<AppEngineOps[K]> }

  /** The grid fake, with a `join --at` that lists the alias rather than writing a `--serve` run record. */
  const appService = () => {
    const base = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => {
      if (args.includes('join') && args.includes('--at')) {
        calls.push(args)
        joinedAliases.add(args[args.indexOf('--advertise-as') + 1]!)
        return ok()
      }
      if (args.includes('leave') && args.includes('--engine') && joinedAliases.has(args[args.indexOf('--engine') + 1]!)) {
        calls.push(args)
        joinedAliases.delete(args[args.indexOf('--engine') + 1]!)
        return ok()
      }
      return base(args, output)
    })
    inventory.mockImplementation(async () => ({ state: 'awake', status: 'running',
      nodes: [...joinedAliases].map(alias => ({ node_id: 'local-node', online: true, models: [alias] })) }))
    return new LocalModels({ stateDir, processEnv: { GRID_HOME: home }, run, request: request as typeof fetch, inventory,
      appModels: async () => apps, appEngines: ops as unknown as AppEngineOps })
  }
  beforeEach(() => {
    apps = [ollama, studio]; up = new Set(); joinedAliases = new Set(); window = 131072
    ops = {
      start: vi.fn(async (model: AppModel) => {
        up.add(model.id)
        return { engine: model.engine as AppEngineRecord['engine'], served: model.ref, alias: model.name, port: 41000, binary: model.binary!, pid: 4242 }
      }),
      alive: vi.fn(async (record: AppEngineRecord) => up.has(record.modelId)),
      loadedContext: vi.fn(async () => window),
      stop: vi.fn(async (record: AppEngineRecord) => { up.delete(record.modelId) }),
    }
  })

  it('lists them under the app they came from, ready to start, beside Grid\'s own', async () => {
    // A catalog model not here yet runs in nothing; once Grid has downloaded it, it runs in Grid, named
    // like the apps beside it.
    const models = appService()
    expect((await models.list('home')).models.find(m => m.id === 'org/Small-GGUF')).toMatchObject({ state: 'available' })
    expect((await models.list('home')).models.find(m => m.id === 'org/Small-GGUF')).not.toHaveProperty('app')
    await writeFile(join(home, 'models', 'Small-Q4.gguf'), Buffer.alloc(64))
    const snapshot = await models.list('home', true)
    expect(snapshot.models.find(m => m.id === 'org/Small-GGUF')).toMatchObject({ state: 'downloaded', app: 'Grid' })
    expect(snapshot.models.filter(m => m.app && m.app !== 'Grid')).toEqual([
      expect.objectContaining({ id: ollama.id, name: 'llama3.2:3b', app: 'Ollama', state: 'downloaded', sizeBytes: 2 * GiB, canStart: true, canStop: false }),
      expect.objectContaining({ id: studio.id, name: 'gemma-4-e2b', app: 'LM Studio', state: 'downloaded', canStart: true, canStop: false }),
    ])
    expect(ops.start).not.toHaveBeenCalled()
  })

  it('starts one in its app, joins it at its own address, checks it through the grid, and stops what it started', async () => {
    const models = appService()
    await models.act('home', ollama.id, 'start'); await models.settled()
    expect(ops.start).toHaveBeenCalledWith(ollama, 131072, join(stateDir, 'logs'))
    expect(calls.find(args => args.includes('--at'))).toEqual(['--remote', 'join', 'home', '--at', 'http://127.0.0.1:41000/v1',
      '-m', 'llama3.2:3b', '--advertise-as', 'llama3.2:3b', '--max-concurrency', '1'])
    expect(request.mock.calls.some(([url]) => String(url).includes(RELAY_CHAT))).toBe(true)
    let row = (await models.list('home', true)).models.find(m => m.id === ollama.id)!
    expect(row).toMatchObject({ state: 'running', canStart: false, canStop: true, operation: { phase: 'done' } })
    // One engine of this picker's at a time.
    expect(await models.act('home', studio.id, 'start').then(() => models.settled()).then(() => models.list('home', true)))
      .toMatchObject({ models: expect.arrayContaining([expect.objectContaining({ id: studio.id, operation: expect.objectContaining({ phase: 'failed', error: 'Stop llama3.2:3b first to start another local model.' }) })]) })
    expect(ops.start).toHaveBeenCalledTimes(1)

    await models.act('home', ollama.id, 'stop'); await models.settled()
    expect(calls.some(args => args.join(' ') === '--remote leave home --engine llama3.2:3b')).toBe(true)
    expect(ops.stop).toHaveBeenCalledWith(expect.objectContaining({ modelId: ollama.id, pid: 4242 }))
    row = (await models.list('home', true)).models.find(m => m.id === ollama.id)!
    expect(row).toMatchObject({ state: 'downloaded', canStart: true, canStop: false })
    expect(JSON.parse(await readFile(join(stateDir, 'app-engines.json'), 'utf8'))).toEqual([])
  })

  it('keeps an engine it started stoppable when a later scan reads the model differently', async () => {
    const models = appService()
    await models.act('home', ollama.id, 'start'); await models.settled()
    // The next scan missed the app (a slow probe) and would serve the file with Grid's engine instead.
    apps = [{ ...ollama, engine: 'grid', ref: join(root, 'blob') }]
    const row = (await models.list('home', true)).models.filter(m => m.id === ollama.id)
    expect(row).toEqual([expect.objectContaining({ state: 'running', canStop: true, canStart: false })])
    await models.act('home', ollama.id, 'stop'); await models.settled()
    expect(ops.stop).toHaveBeenCalledWith(expect.objectContaining({ modelId: ollama.id }))
    expect(joinedAliases.size).toBe(0)
    expect(JSON.parse(await readFile(join(stateDir, 'app-engines.json'), 'utf8'))).toEqual([])
  })

  it('answers from the last scan while a slow one runs, and the list after it has the new one', async () => {
    let scans = 0, release!: () => void
    const models = new LocalModels({ stateDir, processEnv: { GRID_HOME: home }, run, request: request as typeof fetch, inventory,
      appEngines: ops as unknown as AppEngineOps,
      appModels: async () => {
        if (++scans === 1) return [ollama]
        await new Promise<void>(resolve => { release = resolve })
        return [ollama, studio]
      } })
    expect((await models.list('home')).models.filter(m => m.app && m.app !== 'Grid').map(m => m.id)).toEqual([ollama.id])
    // A forced read starts a scan that hangs (a busy llama-server answering --version late): the list
    // answers at once from the last scan rather than waiting on it.
    expect((await models.list('home', true)).models.filter(m => m.app && m.app !== 'Grid').map(m => m.id)).toEqual([ollama.id])
    expect(scans).toBe(2)
    release()
    await vi.waitFor(async () => expect((await models.list('home', true)).models.some(m => m.id === studio.id)).toBe(true))
  })

  it('answers from the scan it saved when it starts again, and a scan that never answers is given up', async () => {
    await appService().list('home')
    let scans = 0
    const appIds = (snapshot: Awaited<ReturnType<LocalModels['list']>>) => snapshot.models.filter(m => m.app && m.app !== 'Grid').map(m => m.id)
    // Started again, with every scan hanging: the saved one answers at once, nothing waits on a scan.
    const restarted = new LocalModels({ stateDir, processEnv: { GRID_HOME: home }, run, request: request as typeof fetch, inventory,
      appEngines: ops as unknown as AppEngineOps, appScanMs: 50,
      appModels: () => { scans++; return new Promise<AppModel[]>(() => {}) } })
    expect(appIds(await restarted.list('home'))).toEqual([ollama.id, studio.id])
    // That scan is given up at its deadline, the saved answer kept, and the next read starts another.
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(appIds(await restarted.list('home', true))).toEqual([ollama.id, studio.id])
    expect(scans).toBe(2)
  })

  it('starts another right after a stop, without a list read between to clear the one that ran', async () => {
    const models = appService()
    await models.act('home', ollama.id, 'start'); await models.settled()
    await models.list('home', true)
    // A switch: stop, then start at once — the list read above still says llama3.2:3b runs.
    await models.act('home', ollama.id, 'stop'); await models.settled()
    await models.act('home', studio.id, 'start'); await models.settled()
    expect(ops.start).toHaveBeenLastCalledWith(studio, 131072, join(stateDir, 'logs'))
    expect((await models.list('home', true)).models.find(m => m.id === studio.id)).toMatchObject({ state: 'running', operation: { phase: 'done' } })
  })

  it('takes it down again, and says so, when the app loaded it with less than 64K', async () => {
    window = 16384
    const models = appService()
    await models.act('home', ollama.id, 'start'); await models.settled()
    const row = (await models.list('home', true)).models.find(m => m.id === ollama.id)!
    expect(row.operation).toMatchObject({ phase: 'failed', error: expect.stringContaining('could only get a 16K context in Ollama') })
    expect(row).toMatchObject({ state: 'downloaded', canStart: true })
    expect(ops.stop).toHaveBeenCalledTimes(1)
    expect(joinedAliases.size).toBe(0)
  })

  it('starts nothing that cannot get 64K beside its weights', async () => {
    apps = [{ ...ollama, sizeBytes: 60 * GiB }]
    const models = appService()
    await models.act('home', ollama.id, 'start'); await models.settled()
    expect((await models.list('home', true)).models.find(m => m.id === ollama.id)?.operation)
      .toMatchObject({ phase: 'failed', error: expect.stringContaining('with a 64K context') })
    expect(ops.start).not.toHaveBeenCalled()
  })

  it("serves one with Grid's llama.cpp, through a link to the app's file, when the app is not installed", async () => {
    const file = join(root, 'ollama-blob')
    await writeFile(file, Buffer.alloc(64))
    apps = [{ id: 'app:ollama:qwen3:8b', name: 'qwen3:8b', app: 'ollama', engine: 'grid', ref: file, sizeBytes: 64 }]
    const models = appService()
    const listed = (await models.list('home')).models.find(m => m.id === 'app:ollama:qwen3:8b')!
    // Its app is not here, so it runs in Grid, and says so.
    expect(listed).toMatchObject({ app: 'Grid', state: 'downloaded', canStart: true })
    await models.act('home', 'app:ollama:qwen3:8b', 'start'); await models.settled()
    const { readlink } = await import('node:fs/promises')
    expect(await readlink(join(home, 'models', 'qwen3-8b.gguf'))).toBe(file)
    expect(calls.find(args => args.includes('--serve'))?.slice(0, 5)).toEqual(['--remote', 'join', 'home', '--serve', 'qwen3-8b.gguf'])
    expect(ops.start).not.toHaveBeenCalled()
  })
})

describe('Jev models: Get brings Grid\'s llama.cpp up to a build that serves them', () => {
  const GiB = 1024 ** 3
  const LAYA = 'jev:ggml-org/Laya-GGUF', LAYA_SIZE = 449_397_600
  const gemma: AppModel = { id: 'app:lm-studio:google/gemma-4-e2b', name: 'gemma-4-e2b', app: 'lm-studio', engine: 'lm-studio',
    ref: 'google/gemma-4-e2b', binary: '/home/me/.lmstudio/bin/lms', sizeBytes: 4 * GiB, contextLength: 131072 }
  let up: Set<string>, joined: Set<string>, installBuild: string, decisions: string[]
  let ops: { [K in keyof AppEngineOps]: Mock<AppEngineOps[K]> }
  const engine = async (build: string) => {
    await mkdir(join(home, 'bin'), { recursive: true })
    await writeFile(join(home, 'bin', 'llama-server'), `#!/bin/sh\necho "version: ${build}"\n`, { mode: 0o755 })
  }
  const jevService = (env: NodeJS.ProcessEnv = {}) => {
    const base = run.getMockImplementation()!
    run.mockImplementation(async (args, output) => {
      if (args[0] === 'pull' && args[1] === 'ggml-org/Laya-GGUF:Laya-Q8_0.gguf') {
        calls.push(args); output?.('100%')
        const file = join(home, 'models', 'Laya-Q8_0.gguf')
        await writeFile(file, ''); await (await import('node:fs/promises')).truncate(file, LAYA_SIZE)
        return ok()
      }
      if (args[0] === 'engine' && args[1] === 'install') { calls.push(args); await engine(installBuild); return ok() }
      if (args.includes('join') && args.includes('--at')) { calls.push(args); joined.add(args[args.indexOf('--advertise-as') + 1]!); return ok() }
      if (args.includes('leave') && joined.has(args[args.indexOf('--engine') + 1]!)) { calls.push(args); joined.delete(args[args.indexOf('--engine') + 1]!); return ok() }
      return base(args, output)
    })
    inventory.mockImplementation(async () => ({ state: 'awake', status: 'running',
      nodes: [...joined].map(alias => ({ node_id: 'local-node', online: true, models: [alias] })) }))
    request.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/systemone')) {
        decisions.push(JSON.parse(String(init?.body)).model)
        return response({ model: 'laya-english', answers: { refund: { type: 'noul', noul: 0.91 } }, usage: { input_tokens: 41, output_tokens: 0 } })
      }
      return response({ choices: [{ message: { content: 'ok' } }] })
    })
    return new LocalModels({ stateDir, processEnv: { GRID_HOME: home, ...env }, run, request: request as typeof fetch, inventory,
      appModels: async () => [gemma], appEngines: ops as unknown as AppEngineOps })
  }
  const laya = async (models: LocalModels) => (await models.list('home', true)).models.find(m => m.id === LAYA)!
  beforeEach(() => {
    up = new Set(); joined = new Set(); installBuild = '0.5.0-dev (build 11378, commit edd6e2bbd)'; decisions = []
    ops = {
      start: vi.fn(async (model: AppModel) => {
        up.add(model.id)
        return { engine: model.engine as AppEngineRecord['engine'], served: model.name, alias: model.name, port: 41001, binary: model.binary!, pid: 4343 }
      }),
      alive: vi.fn(async (record: AppEngineRecord) => up.has(record.modelId)),
      loadedContext: vi.fn(async () => 131072),
      stop: vi.fn(async (record: AppEngineRecord) => { up.delete(record.modelId) }),
    }
  })

  it('is listed as a decision model, to get, and a download alone touches no engine', async () => {
    const models = jevService()
    expect(await laya(models)).toMatchObject({ name: 'laya-english', kind: 'decision', state: 'available', sizeBytes: LAYA_SIZE, canStart: true, canStop: false })
    await models.act('home', LAYA, 'download'); await models.settled()
    expect(await laya(models)).toMatchObject({ state: 'downloaded', app: 'Grid', operation: { phase: 'done' } })
    expect(calls.some(args => args[0] === 'engine')).toBe(false)
    expect(ops.start).not.toHaveBeenCalled()
  })

  it('updates an engine too old for it, runs it beside a chat model, checks it with a decision, and stops it', async () => {
    await engine('10369 (6e62ba538)')
    const models = jevService()
    // A chat model already running in its own app does not stand in the way, as it would for another chat model.
    await models.act('home', gemma.id, 'start'); await models.settled()
    // Every stage the operation passes through, as the app is told of it.
    const stages: string[] = []
    const save = (models as any).save.bind(models)
    vi.spyOn(models as any, 'save').mockImplementation(async (grid: unknown, operation: any) => { stages.push(operation.stage); return save(grid, operation) })
    await models.act('home', LAYA, 'start'); await models.settled()
    const order = calls.map(args => args.join(' '))
    const pulled = order.indexOf('pull ggml-org/Laya-GGUF:Laya-Q8_0.gguf'), installed = order.indexOf('engine install llama.cpp')
    expect(pulled).toBeGreaterThanOrEqual(0)
    expect(installed).toBeGreaterThan(pulled)
    expect(stages).toContain('updating')
    expect(ops.start).toHaveBeenLastCalledWith(expect.objectContaining({ id: LAYA, engine: 'llama.cpp', binary: join(home, 'bin', 'llama-server'),
      ref: join(home, 'models', 'Laya-Q8_0.gguf') }), 8192, join(stateDir, 'logs'))
    expect(calls.find(args => args.includes('--at') && args.includes('laya-english'))).toEqual(['--remote', 'join', 'home', '--at',
      'http://127.0.0.1:41001/v1', '-m', 'laya-english', '--advertise-as', 'laya-english', '--max-concurrency', '1'])
    expect(decisions).toEqual(['laya-english'])
    expect(await laya(models)).toMatchObject({ kind: 'decision', state: 'running', canStop: true, operation: { phase: 'done' } })
    // And a running Jev model blocks no chat model either.
    const list = await models.list('home', true)
    expect(list.models.find(m => m.id === gemma.id)).toMatchObject({ state: 'running' })

    await models.act('home', LAYA, 'stop'); await models.settled()
    expect(calls.some(args => args.join(' ') === '--remote leave home --engine laya-english')).toBe(true)
    expect(ops.stop).toHaveBeenCalledWith(expect.objectContaining({ modelId: LAYA, pid: 4343 }))
    expect(await laya(models)).toMatchObject({ state: 'downloaded', canStart: true, canStop: false })
  })

  it('leaves an engine new enough alone', async () => {
    await engine('0.5.0-dev (build 11378, commit edd6e2bbd)')
    const models = jevService()
    await models.act('home', LAYA, 'start'); await models.settled()
    expect(calls.some(args => args[0] === 'engine')).toBe(false)
    expect(await laya(models)).toMatchObject({ state: 'running' })
  })

  it('says so when the update still leaves the engine too old, and starts nothing', async () => {
    await engine('10369 (6e62ba538)')
    installBuild = '10369 (6e62ba538)'
    const models = jevService()
    await models.act('home', LAYA, 'start'); await models.settled()
    expect((await laya(models)).operation).toMatchObject({ phase: 'failed', error: expect.stringContaining('still too old for Jev models (build 10369') })
    expect(ops.start).not.toHaveBeenCalled()
  })

  it('never replaces an engine named by LLAMA_SERVER: one too old is refused by name', async () => {
    const custom = join(root, 'custom-llama-server')
    await writeFile(custom, '#!/bin/sh\necho "version: 0.5.0 (build 11146, commit 7fe450e19)"\n', { mode: 0o755 })
    const models = jevService({ LLAMA_SERVER: custom })
    await models.act('home', LAYA, 'start'); await models.settled()
    expect((await laya(models)).operation).toMatchObject({ phase: 'failed', error: 'LLAMA_SERVER is llama.cpp build 11146; Jev models need build 11361 or newer.' })
    expect(calls.some(args => args[0] === 'engine')).toBe(false)
  })
})
