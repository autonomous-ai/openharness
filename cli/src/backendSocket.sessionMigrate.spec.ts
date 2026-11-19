// agent_session_migrate: the phone's Change agent moves a conversation to the other engine. It reads the person's
// transcripts and answers where the new session is, so it travels sealed both ways, and a relayed request that is
// not sealed never reaches the service.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackendSocket } from './backendSocket.js'
import { dispatchDown, gatewayOf, relaySocket, upstreamOf } from './testing/relaySocket.js'
import { encryptDownFrame, encryptDownFrameFor, encryptRpcResult } from './lib/e2ee/applicationFrames.js'

const good = { requestId: 'r-1', agentId: 'a1', targetEngine: 'codex' }
const sealed = { type: 'agent_session_migrate', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }

describe('agent_session_migrate through the relay', () => {
  let socket: BackendSocket
  let service: ReturnType<typeof vi.fn<(payload: unknown, asker: unknown) => void>>
  beforeEach(() => {
    socket = relaySocket('token')
    service = vi.fn()
    socket.serviceRouter = (type, payload, asker, reply) => {
      if (type !== 'agent_session_migrate') return false
      service(payload, asker)
      reply(asker.owner ? { engine: 'codex', sessionId: 'new', cwd: '/w' } : { error: 'OWNER_REQUIRED' })
      return true
    }
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({ type: 'agent_session_migrate', payload: good })
  })
  afterEach(async () => {
    await socket.stop()
    vi.restoreAllMocks()
  })

  it('is sealed both ways', () => {
    expect(encryptDownFrame('agent_session_migrate')).toBe(true)
    expect(encryptRpcResult('agent_session_migrate_result')).toBe(true)
    expect(encryptDownFrameFor('agent_session_migrate', { strictDown: false })).toBe(true)
    expect(encryptDownFrameFor('agent_session_migrate', { strictDown: true })).toBe(true)
  })

  it('reaches the service from the owner\'s sealed session and seals the answer to that connection', async () => {
    vi.spyOn(gatewayOf(socket).e2ee, 'sessionRole').mockReturnValue('web')
    const wrap = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({ type: 'agent_session_migrate_result', payload: { __e2e: 'sealed' } })
    await dispatchDown(socket, sealed, 'web-1', 'relay')
    await vi.waitFor(() => expect(wrap).toHaveBeenCalled())
    expect(service).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1', targetEngine: 'codex' }), expect.objectContaining({ owner: true }))
    expect(wrap).toHaveBeenCalledWith('web-1', 'agent_session_migrate_result', 'r-1', { engine: 'codex', sessionId: 'new', cwd: '/w' })
  })

  it('refuses a request the relay carried in the clear, without asking the service', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const enqueue = vi.spyOn(upstreamOf(socket) as any, 'enqueue').mockImplementation(() => {})
    await dispatchDown(socket, { type: 'agent_session_migrate', payload: good }, 'web-1', 'relay')
    expect(service).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    expect(JSON.stringify(enqueue.mock.calls)).toContain('E2EE_REQUIRED')
  })
})
