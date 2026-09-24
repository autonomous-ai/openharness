import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendSocket } from './backendSocket.js'
import { env } from './config/env.js'
import { resolveNewAgentModel } from './lib/newAgentModel.js'

vi.mock('./lib/newAgentModel.js', async (original) => ({ ...await original<typeof import('./lib/newAgentModel.js')>(), resolveNewAgentModel: vi.fn() }))
let socket: BackendSocket, root: string, previous: string
let frames: Array<{ type: string; payload: Record<string, unknown> }>
const target = { networkId: 'fixture-grid', networkName: 'my-grid', baseUrl: 'https://fixture.invalid/relay/v1', apiKey: 'fixture-secret', model: 'Qwen-35B' }
const payload = { engine: 'codex', cwd: '/tmp', gridModel: 'Qwen-35B', gridName: 'my-grid' }
beforeEach(() => {
  vi.resetAllMocks()
  root = mkdtempSync(join(tmpdir(), 'launch-models-'))
  previous = env.ADAPTER_DATA_DIR
  env.ADAPTER_DATA_DIR = root
  socket = new BackendSocket('token')
  frames = []
  socket.registerLocalClient('local:models', { sendFrame: frame => { frames.push(frame as typeof frames[number]); return true }, sendBinary: () => true })
  socket.onCreateAgent = vi.fn(async () => ({ ok: false as const, error: 'TEST_STOP' }))
  vi.mocked(resolveNewAgentModel).mockResolvedValue(target)
})
afterEach(async () => {
  await socket.unregisterLocalClient('local:models')
  await socket.stop()
  env.ADAPTER_DATA_DIR = previous
  rmSync(root, { recursive: true, force: true })
})
async function ask(extra: Record<string, unknown>) {
  const requestId = String(frames.length)
  socket.handleLocalFrame('local:models', { type: 'agent_create', payload: { ...payload, ...extra, requestId } })
  await vi.waitFor(() => expect(frames.some(f => f.type === 'agent_create_result' && f.payload.requestId === requestId)).toBe(true))
  return frames.find(f => f.type === 'agent_create_result' && f.payload.requestId === requestId)!.payload
}
it('resolves a cross-machine choice on the daemon, including clients without receipts', async () => {
  await ask({})
  expect(socket.onCreateAgent).toHaveBeenCalledWith(expect.objectContaining({ engine: 'codex', grid: target, cwd: '/tmp' }))
  expect(resolveNewAgentModel).toHaveBeenCalledWith({ model: 'Qwen-35B', grid: 'my-grid' })
  expect(JSON.stringify(frames)).not.toContain('fixture-secret')
})
it.each([null, new Error('private error')])('refuses resolution failure before a legacy create: %j', async value => {
  if (value instanceof Error) vi.mocked(resolveNewAgentModel).mockRejectedValue(value)
  else vi.mocked(resolveNewAgentModel).mockResolvedValue(value)
  expect(await ask({})).toMatchObject({ error: 'GRID_UNAVAILABLE' })
  expect(socket.onCreateAgent).not.toHaveBeenCalled()
})
it('refuses malformed model selections before creating a receipt', async () => {
  expect(await ask({ gridName: '' })).toMatchObject({ error: 'INVALID_GRID' })
  expect(socket.onCreateAgent).not.toHaveBeenCalled()
  expect(resolveNewAgentModel).not.toHaveBeenCalled()
})
it('receipts retain semantic model identity across retries, never credentials', async () => {
  const creationId = 'model-launch-00000001'
  expect(await ask({ creationId })).toMatchObject({ state: 'failed', failure: { code: 'TEST_STOP' } })
  vi.mocked(resolveNewAgentModel).mockResolvedValue({ ...target, apiKey: 'rotated-secret' })
  expect(await ask({ creationId })).toMatchObject({ state: 'failed', failure: { code: 'TEST_STOP' } })
  expect(socket.onCreateAgent).toHaveBeenCalledOnce()
  expect(resolveNewAgentModel).toHaveBeenCalledOnce()
  expect(await ask({ creationId, gridName: 'other-grid' })).toMatchObject({ error: 'CREATION_CONFLICT' })
  const receipts = readdirSync(join(root, 'agent-creations')).map(name => readFileSync(join(root, 'agent-creations', name), 'utf8')).join('')
  expect(receipts).not.toMatch(/fixture-secret|rotated-secret|apiKey/)
})
it.each([null, new Error('private error')])('records a safe model failure before folder creation: %j', async value => {
  if (value instanceof Error) vi.mocked(resolveNewAgentModel).mockRejectedValue(value)
  else vi.mocked(resolveNewAgentModel).mockResolvedValue(value)
  const answer = await ask({ creationId: 'model-launch-00000002', cwd: undefined, projectSource: 'new', projectName: 'unused' })
  expect(answer).toMatchObject({ state: 'failed', failure: { code: 'GRID_UNAVAILABLE' } })
  expect(socket.onCreateAgent).not.toHaveBeenCalled()
})
