import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendSocket } from '../backendSocket.js'
import { ApiConnections } from './apiConnections.js'
import { apiModelsRequest, chatModels, forgetApiModels, listApiModels, refreshApiLaunch, resolveApiTarget } from './apiModels.js'
import { classifyGridAssignment } from './gridAssignment.js'
import { buildGridEngineLaunch } from './gridLaunch.js'

const secret = 'fixture-openrouter-key'
const newSecret = 'fixture-rotated-key'
let directory: string, store: ApiConnections

const listing = {
  data: [
    { id: 'anthropic/claude-sonnet-4.6', name: 'Anthropic: Claude Sonnet 4.6', context_length: 1_000_000, supported_parameters: ['tools', 'temperature'], architecture: { output_modalities: ['text'] } },
    { id: 'z-ai/glm-5', context_length: 202_752, supported_parameters: ['tools'] },
    { id: 'small/no-room', context_length: 32_768, supported_parameters: ['tools'] },
    { id: 'plain/no-tools', context_length: 262_144, supported_parameters: ['temperature'] },
    { id: 'images/only', context_length: 262_144, supported_parameters: ['tools'], architecture: { output_modalities: ['image'] } },
  ],
}

function answering(body: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'harness-api-models-'))
  store = new ApiConnections(directory)
  forgetApiModels()
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

describe('an API as a model source', () => {
  it('keeps the models a coding agent can run on, and every row of an API that says nothing', () => {
    expect(chatModels(listing).map((model) => model.id)).toEqual(['anthropic/claude-sonnet-4.6', 'z-ai/glm-5'])
    expect(chatModels(listing)[0]).toEqual({ id: 'anthropic/claude-sonnet-4.6', name: 'Anthropic: Claude Sonnet 4.6', contextWindow: 1_000_000 })
    expect(chatModels({ data: [{ id: 'deepseek-chat', object: 'model' }, { id: 'deepseek-chat' }, { id: '' }, 'x'] }))
      .toEqual([{ id: 'deepseek-chat' }])
    // Replicate's `/models` is not an OpenAI list: it has no chat models to offer.
    expect(chatModels({ results: [{ name: 'flux' }] })).toEqual([])
    expect(chatModels(null)).toEqual([])
  })

  it('reads the list with the saved Bearer key, keeps it, and reads again when the key changes', async () => {
    const saved = store.save({ provider: 'openrouter', apiKey: secret })
    const fetch = answering(listing)
    expect((await listApiModels(store, saved.id, { fetch })).length).toBe(2)
    await listApiModels(store, saved.id, { fetch })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://openrouter.ai/api/v1/models')
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${secret}`)
    store.save({ id: saved.id, provider: 'openrouter', apiKey: newSecret })
    await listApiModels(store, saved.id, { fetch })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect((fetch.mock.calls[1]![1]?.headers as Record<string, string>).authorization).toBe(`Bearer ${newSecret}`)
  })

  it('says why a list failed, never with the key, and refuses an API agents cannot authenticate to', async () => {
    const saved = store.save({ provider: 'openrouter', apiKey: secret })
    const refused = await apiModelsRequest(store, { id: saved.id }, { fetch: answering({ error: 'no' }, 401) })
    expect(refused).toEqual({ error: 'API_MODELS_FAILED', detail: 'OpenRouter did not accept the saved key. Edit the connection and paste a new key.' })
    const fal = store.save({ provider: 'fal', apiKey: secret })
    const fetch = answering(listing)
    const answer = await apiModelsRequest(store, { id: fal.id }, { fetch })
    expect(answer).toEqual({ error: 'API_MODELS_FAILED', detail: 'fal.ai does not take a Bearer key, so coding agents cannot run on it.' })
    expect(fetch).not.toHaveBeenCalled()
    const listed = await apiModelsRequest(store, { id: saved.id }, { fetch })
    expect(listed).toMatchObject({ id: saved.id, models: [{ id: 'anthropic/claude-sonnet-4.6' }, { id: 'z-ai/glm-5' }] })
    expect(JSON.stringify([refused, answer, listed])).not.toContain(secret)
  })

  it('builds the launch every engine reaches OpenRouter through, and refuses a model it does not list', async () => {
    const saved = store.save({ provider: 'openrouter', apiKey: secret })
    const fetch = answering(listing)
    const target = await resolveApiTarget(store, saved.id, 'anthropic/claude-sonnet-4.6', { fetch })
    expect(target).toEqual({
      networkId: 'api:openrouter',
      networkName: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: secret,
      model: 'anthropic/claude-sonnet-4.6',
      contextWindow: 1_000_000,
    })
    await expect(resolveApiTarget(store, saved.id, 'plain/no-tools', { fetch }))
      .rejects.toThrow('OpenRouter does not list plain/no-tools for coding agents.')

    // OpenRouter's documented Claude Code setup: `ANTHROPIC_BASE_URL=https://openrouter.ai/api`.
    const claude = buildGridEngineLaunch('claude', target, { hermesSystemManaged: false })
    expect(claude.ok && claude.launch.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: secret,
      ANTHROPIC_MODEL: 'anthropic/claude-sonnet-4.6',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
    })
    const codex = buildGridEngineLaunch('codex', target, { hermesSystemManaged: false })
    expect(codex.ok && codex.launch.args).toEqual(expect.arrayContaining(['model_providers.grid.base_url="https://openrouter.ai/api/v1"', 'model_providers.grid.wire_api="responses"']))
    expect(JSON.stringify(codex.ok && codex.launch.args)).not.toContain(secret)
    // Its own provider id: OpenCode merges a block named `openrouter` into its built-in provider.
    const opencode = buildGridEngineLaunch('opencode', target, { hermesSystemManaged: false })
    expect(opencode.ok && opencode.launch.args).toEqual(['-m', 'api-openrouter/anthropic/claude-sonnet-4.6'])
    expect(opencode.ok && opencode.launch.configDir!.files[0]!.content).not.toContain(secret)
  })

  it('reports an agent moved onto a saved API as on its model, and a stranger endpoint as not', async () => {
    const env = { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_MODEL: 'z-ai/glm-5' }
    const saved = store.save({ provider: 'openrouter', apiKey: secret })
    expect(classifyGridAssignment('claude', { ...env, ANTHROPIC_BASE_URL: 'https://other.example.test/api' })).toBeNull()
    await resolveApiTarget(store, saved.id, 'z-ai/glm-5', { fetch: answering(listing) })
    expect(classifyGridAssignment('claude', env)).toEqual({ baseUrl: 'https://openrouter.ai/api', model: 'z-ai/glm-5' })
    expect(classifyGridAssignment('codex', {}, '-c model_providers.grid.base_url="https://openrouter.ai/api/v1" -m z-ai/glm-5'))
      .toEqual({ baseUrl: 'https://openrouter.ai/api/v1', model: 'z-ai/glm-5' })
  })

  it('relaunches with the key saved now, and refuses once the API is removed', async () => {
    const saved = store.save({ provider: 'openrouter', apiKey: secret })
    const launch = await resolveApiTarget(store, saved.id, 'z-ai/glm-5', { fetch: answering(listing) })
    store.save({ id: saved.id, provider: 'openrouter', apiKey: newSecret })
    expect(refreshApiLaunch(store, launch)).toEqual({ ...launch, apiKey: newSecret })
    const grid = { networkId: 'grid-1', networkName: 'home', baseUrl: 'https://grid.example.test/relay/v1', apiKey: 'grid-key' }
    expect(refreshApiLaunch(store, grid)).toBe(grid)
    store.remove(saved.id)
    expect(() => refreshApiLaunch(store, launch)).toThrow('This API is not saved. Add it in Models → APIs.')
  })
})

describe('agent_retarget onto an API model', () => {
  function retarget(socket: BackendSocket, payload: Record<string, unknown>, connId = 'local:apis') {
    return (socket as any).dispatchDown({ type: 'agent_retarget', payload: { requestId: 'r', agentId: 'agent-1', ...payload } }, connId, connId === 'remote' ? 'relay' : 'local')
  }

  it('resolves the endpoint and key on this computer and hands the engine launch that override', async () => {
    const socket = new BackendSocket('fixture')
    const reply = vi.spyOn(socket as any, 'emitReply').mockImplementation(() => {})
    const saved = store.save({ provider: 'openrouter', apiKey: secret })
    const access = vi.spyOn(ApiConnections.prototype, 'modelAccess').mockImplementation(() => ({
      connection: saved,
      apiKey: secret,
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(answering(listing))
    const moved = vi.fn(async () => ({ ok: true as const }))
    socket.onRetargetAgent = moved
    await retarget(socket, { apiConnection: 'openrouter', apiModel: 'z-ai/glm-5' })
    expect(access).toHaveBeenCalledWith('openrouter')
    expect(moved).toHaveBeenCalledWith({
      agentId: 'agent-1',
      grid: {
        networkId: 'api:openrouter',
        networkName: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: secret,
        model: 'z-ai/glm-5',
        contextWindow: 202_752,
      },
    })
    expect(reply).toHaveBeenCalledWith('local:apis', 'agent_retarget', 'r', { retargeted: true })
    await socket.stop()
  })

  it('refuses a session that is not the owner\'s, and a frame naming an API with anything else', async () => {
    const socket = new BackendSocket('fixture')
    const reply = vi.spyOn(socket as any, 'emitReply').mockImplementation(() => {})
    const moved = vi.fn(async () => ({ ok: true as const }))
    socket.onRetargetAgent = moved
    // Encrypted, but not the owner's paired session: refused, as managing these APIs would be.
    vi.spyOn((socket as any).e2ee, 'unwrapDown').mockReturnValueOnce({
      type: 'agent_retarget', payload: { requestId: 'r', agentId: 'agent-1', apiConnection: 'openrouter', apiModel: 'z-ai/glm-5' },
    })
    await (socket as any).dispatchDown({ type: 'agent_retarget', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }, 'remote')
    expect(reply).toHaveBeenLastCalledWith('remote', 'agent_retarget', 'r', { error: 'OWNER_REQUIRED' })
    await retarget(socket, { apiConnection: 'openrouter', apiModel: 'z-ai/glm-5', gridModel: 'Qwen' })
    expect(reply).toHaveBeenLastCalledWith('local:apis', 'agent_retarget', 'r', expect.objectContaining({ error: 'INVALID_GRID' }))
    await retarget(socket, { apiConnection: 'openrouter', clearGrid: true })
    expect(reply).toHaveBeenLastCalledWith('local:apis', 'agent_retarget', 'r', expect.objectContaining({ error: 'INVALID_GRID' }))
    expect(moved).not.toHaveBeenCalled()
    await socket.stop()
  })

  it('lets the owner\'s paired session use the API, as it may manage it', async () => {
    const socket = new BackendSocket('fixture')
    const reply = vi.spyOn(socket as any, 'emitReply').mockImplementation(() => {})
    const saved = store.save({ provider: 'openrouter', apiKey: secret })
    vi.spyOn(ApiConnections.prototype, 'modelAccess').mockImplementation(() => ({ connection: saved, apiKey: secret }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(answering(listing))
    vi.spyOn((socket as any).e2ee, 'sessionRole').mockReturnValue('web')
    vi.spyOn((socket as any).e2ee, 'unwrapDown').mockReturnValueOnce({
      type: 'agent_retarget', payload: { requestId: 'r', agentId: 'agent-1', apiConnection: 'openrouter', apiModel: 'z-ai/glm-5' },
    })
    const moved = vi.fn(async () => ({ ok: true as const }))
    socket.onRetargetAgent = moved
    await (socket as any).dispatchDown({ type: 'agent_retarget', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }, 'owner')
    expect(moved).toHaveBeenCalledWith(expect.objectContaining({ grid: expect.objectContaining({ networkId: 'api:openrouter', model: 'z-ai/glm-5' }) }))
    expect(reply).toHaveBeenLastCalledWith('owner', 'agent_retarget', 'r', { retargeted: true })
    await socket.stop()
  })

  it('answers why an API cannot be used, without touching the pane', async () => {
    const socket = new BackendSocket('fixture')
    const reply = vi.spyOn(socket as any, 'emitReply').mockImplementation(() => {})
    const moved = vi.fn(async () => ({ ok: true as const }))
    socket.onRetargetAgent = moved
    await retarget(socket, { apiConnection: 'never-saved', apiModel: 'z-ai/glm-5' })
    expect(reply).toHaveBeenLastCalledWith('local:apis', 'agent_retarget', 'r', expect.objectContaining({ error: 'API_UNAVAILABLE' }))
    expect(moved).not.toHaveBeenCalled()
    await socket.stop()
  })
})
