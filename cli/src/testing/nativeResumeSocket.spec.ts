import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BackendSocket } from '../backendSocket.js'
import type { AgentFrame } from '../lib/agentFrame.js'
import { registry, type RegisteredSession } from '../lib/registry.js'
import { stoppedAgents } from '../lib/stoppedAgents.js'
import { bindNativeResumeRequests, type NativeResumeRequests } from './nativeResumeSocket.js'

let socket: BackendSocket
let requests: NativeResumeRequests
let frames: Array<{ type: string; payload: Record<string, any> }>
beforeEach(() => {
  socket = new BackendSocket('fixture-only')
  frames = []
  socket.registerLocalClient('local:native-wiring', {
    sendFrame: frame => { frames.push(frame as typeof frames[number]); return true },
    sendBinary: () => true,
  })
  requests = { resume: vi.fn(async () => ({ ok: false as const, error: 'FIXTURE_REFUSED' })), stop: vi.fn(async () => {}) }
  bindNativeResumeRequests(socket, requests)
})
afterEach(async () => { await socket.stop(); vi.restoreAllMocks() })
async function rpc(type: string, payload: Record<string, unknown> = {}) {
  const requestId = randomUUID()
  socket.handleLocalFrame('local:native-wiring', { type, payload: { ...payload, requestId } })
  await vi.waitFor(() => expect(frames.some(frame => frame.payload?.requestId === requestId)).toBe(true))
  return frames.find(frame => frame.payload?.requestId === requestId)!.payload
}

it('lists the stopped conversation before the native engine is launched', async () => {
  vi.spyOn(registry, 'advertised').mockReturnValue([])
  vi.spyOn(stoppedAgents, 'available').mockReturnValue([{ agentId: 'saved' } as RegisteredSession])
  vi.spyOn(socket, 'toStoppedProject').mockResolvedValue({ id: 'saved', status: 'stopped' } as AgentFrame)
  expect(await rpc('agents_list', { includeStopped: true })).toMatchObject({ agents: [{ id: 'saved', status: 'stopped' }] })
})

it('dispatches resume and preserves the creation receipt across fixture handler changes', async () => {
  const creationId = randomUUID()
  expect(await rpc('agent_resume', { agentId: 'saved', creationId })).toMatchObject({ state: 'failed', failure: { code: 'FIXTURE_REFUSED' } })
  const next = vi.fn(async () => ({ ok: false as const, error: 'SECOND_FIXTURE_REFUSAL' }))
  requests.resume = next
  expect(await rpc('agent_create_status', { creationId })).toMatchObject({ state: 'failed', failure: { code: 'FIXTURE_REFUSED' } })
  expect(await rpc('agent_resume', { agentId: 'saved', permissionMode: 'auto' })).toMatchObject({ error: 'SECOND_FIXTURE_REFUSAL' })
  expect(next).toHaveBeenCalledExactlyOnceWith('saved', 'auto')
})

it('stops through the current fixture handler', async () => {
  const stopped: string[] = []
  requests.stop = async id => { stopped.push(id) }
  expect(await rpc('agent_delete', { agentId: 'saved' })).toMatchObject({ deleted: true })
  expect(stopped).toEqual(['saved'])
})

it('closes through the service installed after the socket was bound', async () => {
  const request = vi.fn(async () => ({ closed: true }))
  socket.closeAgentService = { request, dispose() {} } as unknown as NonNullable<BackendSocket['closeAgentService']>
  const payload = { agentId: 'saved', sessionId: 'history', createdAt: '2026-01-01T00:00:00.000Z', mode: 'now' }
  expect(await rpc('agent_close', payload)).toMatchObject({ closed: true })
  expect(request).toHaveBeenCalledExactlyOnceWith(payload)
})
